// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SessionCalendar} from "./SessionCalendar.sol";
import {SessionOracle} from "./SessionOracle.sol";
import {IPriceSource, IEIP8056} from "./interfaces/External.sol";

/// @title SessionAwareFeed
/// @notice Lista-compatible price source (`peek`, 8 decimals, raw token units) for tokenized stocks.
///         During the regular session it passes the upstream price through. While the US market is closed
///         it holds the price inside a band around the last reference print: the band starts at the
///         ticker's p99 gap for the closure in progress and widens by one base band per 24 h closed, capped
///         at three. A thin-book wick outside the band cannot move collateral value; a real move is priced
///         at the band edge and in full from the first regular print.
/// @dev If the reference is missing or older than the oracle's maxRefAge before the close, the feed
///      degrades to the upstream price (never worse than the status quo). Upstream reverts propagate.
contract SessionAwareFeed is Ownable2Step, IPriceSource {
    uint256 public constant MAX_BAND_MULTIPLE = 3;
    uint256 internal constant MAX_BAND_BPS = 9000;

    SessionOracle public immutable oracle;
    SessionCalendar public immutable calendar;
    IPriceSource public immutable upstream;

    mapping(address => bytes32) public symbolOf;

    event AssetMapped(address indexed asset, bytes32 indexed symbol);

    constructor(address owner_, SessionOracle oracle_, IPriceSource upstream_) Ownable(owner_) {
        oracle = oracle_;
        calendar = oracle_.calendar();
        upstream = upstream_;
    }

    function mapAsset(address asset, bytes32 sym) external onlyOwner {
        symbolOf[asset] = sym;
        emit AssetMapped(asset, sym);
    }

    function peek(address asset) external view returns (uint256) {
        uint256 up = upstream.peek(asset);
        bytes32 sym = symbolOf[asset];
        if (sym == bytes32(0)) return up;
        SessionCalendar.Session s = calendar.session(block.timestamp);
        if (s == SessionCalendar.Session.REGULAR || s == SessionCalendar.Session.UNKNOWN) return up;
        (uint256 lo, uint256 hi,, bool ok) = band(sym);
        if (!ok) return up;
        if (up < lo) return lo;
        if (up > hi) return hi;
        return up;
    }

    /// @return lo lower bound (raw units, 1e8); hi upper bound; bandBps band width; ok false if no anchor
    function band(bytes32 sym) public view returns (uint256 lo, uint256 hi, uint256 bandBps, bool ok) {
        (SessionOracle.RiskWindow w, uint16 base, uint256 closedAt) = oracle.currentWindow(sym);
        if (w == SessionOracle.RiskWindow.NONE || base == 0) return (0, 0, 0, false);
        (uint256 ref, uint256 upd, bool okR) = oracle.referenceFor(sym);
        (,,, uint32 maxRefAge,,,) = oracle.params();
        if (!okR || upd + maxRefAge < closedAt) return (0, 0, 0, false);
        SessionOracle.Ticker memory t = oracle.ticker(sym);
        uint256 mult;
        try IEIP8056(t.bStock).uiMultiplier() returns (uint256 m) {
            mult = m;
        } catch {
            return (0, 0, 0, false);
        }
        if (mult == 0) return (0, 0, 0, false);
        uint256 anchor = ref * mult / 1e18;
        uint256 elapsed = block.timestamp - closedAt;
        bandBps = uint256(base) + uint256(base) * elapsed / 1 days;
        uint256 cap = uint256(base) * MAX_BAND_MULTIPLE;
        if (bandBps > cap) bandBps = cap;
        if (bandBps > MAX_BAND_BPS) bandBps = MAX_BAND_BPS;
        lo = anchor * (10_000 - bandBps) / 10_000;
        hi = anchor * (10_000 + bandBps) / 10_000;
        ok = true;
    }
}
