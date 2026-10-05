// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SessionCalendar} from "./SessionCalendar.sol";
import {IPriceSource, IAggregatorV3, IEIP8056, IBackedToken, IOndoSharesOracle} from "./interfaces/External.sol";

/// @title SessionOracle
/// @notice Per-share prices for tokenized US stocks across bStocks, Ondo and xStocks, the NYSE session, the
///         age of the underlying reference, and the gap each coming closure can open. Answers one question
///         for risk-adding actions: may risk be added right now? Anything unknown answers no.
/// @dev On-chain inputs: SessionCalendar, the bStock raw price source (Lista resilient oracle), EIP-8056
///      multipliers, Chainlink underlying feeds, Ondo's on-chain sValue, xStocks multipliers. The publisher
///      posts a bounded, expiring overlay (halts, corporate actions, earnings, Ondo live multiplier, a
///      reference for tickers without Chainlink).
contract SessionOracle is Ownable2Step {
    enum Reason {
        OK,
        UNKNOWN_TICKER,
        CALENDAR_UNKNOWN,
        NOT_REGULAR,
        TOO_SOON_AFTER_OPEN,
        OVERLAY_STALE,
        FLAGGED,
        PRICE_UNAVAILABLE,
        REFERENCE_STALE,
        NOT_CONVERGED,
        WINDOW_AHEAD
    }

    enum RiskWindow {
        NONE,
        OVERNIGHT,
        WEEKEND,
        HOLIDAY,
        EARNINGS
    }

    enum Issuer {
        BSTOCK,
        ONDO,
        XSTOCK
    }

    uint8 public constant FLAG_HALTED = 1;
    uint8 public constant FLAG_CORPORATE_ACTION = 2;
    uint8 public constant FLAG_EARNINGS_WINDOW = 4;
    uint8 public constant FLAG_ASSET_LIMITED = 8;

    struct Ticker {
        address bStock;
        address ondo;
        address xStock;
        address chainlink;
        uint16 gapOvernightBps;
        uint16 gapWeekendBps;
        uint16 gapHolidayBps;
        uint16 gapEarningsBps;
        bool listed;
    }

    struct Overlay {
        uint64 validUntil;
        uint64 nextEarnings; // regular-open timestamp at which the next earnings gap is realised (0 = none known)
        uint8 flags;
        uint128 ondoMultiplier; // shares per Ondo token, 1e18 (0 = not posted)
        uint128 referencePrice; // per-share USD, 1e8, only for tickers without Chainlink (0 = not posted)
        uint64 postedAt;
    }

    struct Params {
        uint32 restoreDelay;
        uint32 horizon;
        uint16 convergenceBps;
        uint32 maxRefAge;
        uint32 maxOverlayTtl;
        uint16 maxOndoDriftBps;
        uint16 maxRefDeviationBps;
    }

    SessionCalendar public immutable calendar;
    IOndoSharesOracle public immutable ondoShares;
    IPriceSource public priceSource;
    address public publisher;
    uint256 public publisherAgentId;
    Params public params;
    bytes32[] public symbols;

    mapping(bytes32 => Ticker) internal _tickers;
    mapping(bytes32 => Overlay) internal _overlays;

    event TickerListed(bytes32 indexed symbol, address bStock, address ondo, address xStock, address chainlink);
    event OverlayPosted(bytes32 indexed symbol, uint64 validUntil, uint64 nextEarnings, uint8 flags, uint128 ondoMultiplier, uint128 referencePrice);
    event PublisherSet(address indexed publisher, uint256 agentId);
    event ParamsSet(Params params);
    event PriceSourceSet(address indexed source);

    error NotPublisher();
    error UnknownTicker(bytes32 symbol);
    error BadTicker();
    error BadValidity();
    error BadParams();
    error LengthMismatch();
    error OndoMultiplierOutOfBounds(uint256 posted, uint256 onchain);
    error ReferenceNotAllowed();
    error ReferenceOutOfBounds(uint256 posted, uint256 perShare);

    constructor(address owner_, SessionCalendar calendar_, IPriceSource source_, IOndoSharesOracle ondoShares_, Params memory p)
        Ownable(owner_)
    {
        calendar = calendar_;
        ondoShares = ondoShares_;
        priceSource = source_;
        _setParams(p);
    }

    // ------------------------------------------------------------------ owner

    function listTicker(bytes32 sym, Ticker calldata t) external onlyOwner {
        if (sym == bytes32(0) || t.bStock == address(0)) revert BadTicker();
        if (t.chainlink != address(0) && IAggregatorV3(t.chainlink).decimals() != 8) revert BadTicker();
        if (!_tickers[sym].listed) symbols.push(sym);
        _tickers[sym] = t;
        _tickers[sym].listed = true;
        emit TickerListed(sym, t.bStock, t.ondo, t.xStock, t.chainlink);
    }

    function setParams(Params calldata p) external onlyOwner {
        _setParams(p);
    }

    function setPublisher(address publisher_, uint256 agentId) external onlyOwner {
        publisher = publisher_;
        publisherAgentId = agentId;
        emit PublisherSet(publisher_, agentId);
    }

    function setPriceSource(IPriceSource source_) external onlyOwner {
        priceSource = source_;
        emit PriceSourceSet(address(source_));
    }

    // -------------------------------------------------------------- publisher

    function postOverlays(bytes32[] calldata syms, Overlay[] calldata data) external {
        if (msg.sender != publisher) revert NotPublisher();
        if (syms.length != data.length) revert LengthMismatch();
        for (uint256 i; i < syms.length; ++i) {
            _post(syms[i], data[i]);
        }
    }

    // ------------------------------------------------------------------ views

    function symbolCount() external view returns (uint256) {
        return symbols.length;
    }

    function ticker(bytes32 sym) external view returns (Ticker memory) {
        return _tickers[sym];
    }

    function overlay(bytes32 sym) external view returns (Overlay memory) {
        return _overlays[sym];
    }

    function rawPrice(bytes32 sym) public view returns (uint256, bool) {
        Ticker storage t = _tickers[sym];
        if (!t.listed) return (0, false);
        return _raw(t);
    }

    function perSharePrice(bytes32 sym) public view returns (uint256, bool) {
        Ticker storage t = _tickers[sym];
        if (!t.listed) return (0, false);
        return _perShare(t);
    }

    function sharesPerToken(bytes32 sym, Issuer issuer) external view returns (uint256 multiplier, bool stale) {
        Ticker storage t = _tickers[sym];
        if (issuer == Issuer.BSTOCK) return (IEIP8056(t.bStock).uiMultiplier(), false);
        if (issuer == Issuer.XSTOCK) {
            if (t.xStock == address(0)) return (0, true);
            return (IBackedToken(t.xStock).multiplier(), false);
        }
        if (t.ondo == address(0)) return (0, true);
        Overlay storage o = _overlays[sym];
        if (o.ondoMultiplier != 0 && o.validUntil >= block.timestamp) return (o.ondoMultiplier, false);
        (uint128 sv,) = ondoShares.getSValue(t.ondo);
        return (sv, true);
    }

    /// @return price per-share USD (1e8); updatedAt timestamp of the reference; ok false if unavailable
    function referenceFor(bytes32 sym) public view returns (uint256 price, uint256 updatedAt, bool ok) {
        Ticker storage t = _tickers[sym];
        if (!t.listed) return (0, 0, false);
        if (t.chainlink != address(0)) {
            try IAggregatorV3(t.chainlink).latestRoundData() returns (uint80, int256 answer, uint256, uint256 upd, uint80) {
                if (answer <= 0) return (0, 0, false);
                return (uint256(answer), upd, true);
            } catch {
                return (0, 0, false);
            }
        }
        Overlay storage o = _overlays[sym];
        if (o.referencePrice == 0 || o.validUntil < block.timestamp) return (0, 0, false);
        return (o.referencePrice, o.postedAt, true);
    }

    function converged(bytes32 sym) public view returns (bool ok, uint256 devBps, Reason reason) {
        (uint256 ps, bool okP) = perSharePrice(sym);
        if (!okP) return (false, 0, Reason.PRICE_UNAVAILABLE);
        (uint256 ref, uint256 upd, bool okR) = referenceFor(sym);
        if (!okR || upd > block.timestamp || block.timestamp - upd > params.maxRefAge) return (false, 0, Reason.REFERENCE_STALE);
        devBps = _devBps(ps, ref);
        if (devBps > params.convergenceBps) return (false, devBps, Reason.NOT_CONVERGED);
        return (true, devBps, Reason.OK);
    }

    function gapFor(bytes32 sym, RiskWindow w) public view returns (uint16) {
        Ticker storage t = _tickers[sym];
        if (w == RiskWindow.OVERNIGHT) return t.gapOvernightBps;
        if (w == RiskWindow.WEEKEND) return t.gapWeekendBps;
        if (w == RiskWindow.HOLIDAY) return t.gapHolidayBps;
        if (w == RiskWindow.EARNINGS) return t.gapEarningsBps;
        return 0;
    }

    /// @notice The next closure for `sym`, upgraded to EARNINGS when the posted earnings gap lands at its open.
    function windowAhead(bytes32 sym) public view returns (RiskWindow w, uint64 startsAt, uint64 endsAt, uint16 gapBps) {
        (SessionCalendar.WindowType cw, uint256 s, uint256 e) = calendar.nextWindow(block.timestamp);
        if (cw == SessionCalendar.WindowType.NONE) return (RiskWindow.NONE, 0, 0, 0);
        w = RiskWindow(uint8(cw));
        gapBps = gapFor(sym, w);
        if (_earningsAt(sym, s, e)) {
            uint16 eg = gapFor(sym, RiskWindow.EARNINGS);
            w = RiskWindow.EARNINGS;
            if (eg > gapBps) gapBps = eg;
        }
        return (w, uint64(s), uint64(e), gapBps);
    }

    /// @notice The closure in progress for `sym` (NONE during the regular session).
    function currentWindow(bytes32 sym) public view returns (RiskWindow w, uint16 gapBps, uint256 closedAt) {
        (SessionCalendar.WindowType cw, uint256 c, uint256 o) = calendar.currentWindow(block.timestamp);
        if (cw == SessionCalendar.WindowType.NONE) return (RiskWindow.NONE, 0, 0);
        w = RiskWindow(uint8(cw));
        gapBps = gapFor(sym, w);
        if (_earningsAt(sym, c, o)) {
            uint16 eg = gapFor(sym, RiskWindow.EARNINGS);
            w = RiskWindow.EARNINGS;
            if (eg > gapBps) gapBps = eg;
        }
        closedAt = c;
    }

    /// @notice May risk be added to a position in `sym` right now?
    function canAddRisk(bytes32 sym) external view returns (bool, Reason) {
        if (!_tickers[sym].listed) return (false, Reason.UNKNOWN_TICKER);
        SessionCalendar.Session s = calendar.session(block.timestamp);
        if (s == SessionCalendar.Session.UNKNOWN) return (false, Reason.CALENDAR_UNKNOWN);
        if (s != SessionCalendar.Session.REGULAR) return (false, Reason.NOT_REGULAR);
        (uint256 day,) = calendar.localDay(block.timestamp);
        if (block.timestamp < calendar.regularOpenAt(day) + params.restoreDelay) return (false, Reason.TOO_SOON_AFTER_OPEN);
        Overlay storage o = _overlays[sym];
        if (o.validUntil < block.timestamp) return (false, Reason.OVERLAY_STALE);
        if (o.flags != 0) return (false, Reason.FLAGGED);
        (bool conv,, Reason r) = converged(sym);
        if (!conv) return (false, r);
        (, uint64 startsAt,,) = windowAhead(sym);
        if (startsAt != 0 && startsAt <= block.timestamp + params.horizon) return (false, Reason.WINDOW_AHEAD);
        return (true, Reason.OK);
    }

    // --------------------------------------------------------------- internal

    function _post(bytes32 sym, Overlay calldata o) internal {
        Ticker storage t = _tickers[sym];
        if (!t.listed) revert UnknownTicker(sym);
        if (o.validUntil <= block.timestamp || o.validUntil > block.timestamp + params.maxOverlayTtl) revert BadValidity();
        if (o.ondoMultiplier != 0) {
            uint256 onchain;
            if (t.ondo != address(0)) {
                (uint128 sv,) = ondoShares.getSValue(t.ondo);
                onchain = sv;
            }
            uint256 hi = onchain * (10_000 + params.maxOndoDriftBps) / 10_000;
            if (onchain == 0 || o.ondoMultiplier < onchain || o.ondoMultiplier > hi) {
                revert OndoMultiplierOutOfBounds(o.ondoMultiplier, onchain);
            }
        }
        if (o.referencePrice != 0) {
            if (t.chainlink != address(0)) revert ReferenceNotAllowed();
            (uint256 ps, bool ok) = _perShare(t);
            if (!ok || _devBps(o.referencePrice, ps) > params.maxRefDeviationBps) revert ReferenceOutOfBounds(o.referencePrice, ps);
        }
        _overlays[sym] = Overlay({
            validUntil: o.validUntil,
            nextEarnings: o.nextEarnings,
            flags: o.flags,
            ondoMultiplier: o.ondoMultiplier,
            referencePrice: o.referencePrice,
            postedAt: uint64(block.timestamp)
        });
        emit OverlayPosted(sym, o.validUntil, o.nextEarnings, o.flags, o.ondoMultiplier, o.referencePrice);
    }

    function _earningsAt(bytes32 sym, uint256 from, uint256 to) internal view returns (bool) {
        Overlay storage o = _overlays[sym];
        return o.validUntil >= block.timestamp && o.nextEarnings != 0 && o.nextEarnings > from && o.nextEarnings <= to;
    }

    function _raw(Ticker storage t) internal view returns (uint256, bool) {
        try priceSource.peek(t.bStock) returns (uint256 p) {
            return (p, p > 0);
        } catch {
            return (0, false);
        }
    }

    function _perShare(Ticker storage t) internal view returns (uint256, bool) {
        (uint256 raw, bool ok) = _raw(t);
        if (!ok) return (0, false);
        uint256 m = IEIP8056(t.bStock).uiMultiplier();
        if (m == 0) return (0, false);
        return (raw * 1e18 / m, true);
    }

    function _devBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return type(uint256).max;
        uint256 d = a > b ? a - b : b - a;
        return d * 10_000 / b;
    }

    function _setParams(Params memory p) internal {
        if (
            p.restoreDelay > 6 hours || p.horizon > 24 hours || p.convergenceBps == 0 || p.convergenceBps > 500
                || p.maxRefAge < 1 hours || p.maxRefAge > 7 days || p.maxOverlayTtl == 0 || p.maxOverlayTtl > 24 hours
                || p.maxOndoDriftBps > 500 || p.maxRefDeviationBps > 2000
        ) revert BadParams();
        params = p;
        emit ParamsSet(p);
    }
}
