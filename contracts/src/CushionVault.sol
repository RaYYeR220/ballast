// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SessionCalendar} from "./SessionCalendar.sol";
import {SessionOracle} from "./SessionOracle.sol";
import {MarketParams, IMoolah, IVToken} from "./interfaces/External.sol";

/// @title CushionVault
/// @notice Protection for a loan that stays on the user's own address. The user parks stablecoins here;
///         the user's chosen keeper may only spend them to repay that same user's debt, only in the hours
///         before a closure (or during one, or when the calendar cannot tell), and at most `capPerDay`.
///         Repay-on-behalf needs no authorization on Lista or Venus and works while the venue cannot price
///         the collateral.
contract CushionVault {
    using SafeERC20 for IERC20;

    uint8 public constant VENUE_LISTA = 1;
    uint8 public constant VENUE_VENUS = 2;

    struct Cover {
        uint8 venue;
        MarketParams mp;
        address vDebt;
        address token;
        bytes32 symbol;
        address keeper;
        uint128 capPerDay;
        uint128 balance;
        uint64 dayStart;
        uint128 usedToday;
    }

    SessionOracle public immutable sessionOracle;
    SessionCalendar public immutable calendar;
    IMoolah public immutable moolah;
    uint32 public immutable shieldHorizon;

    mapping(address => mapping(bytes32 => Cover)) internal _covers;

    struct CoverRef {
        address user;
        bytes32 key;
    }

    CoverRef[] internal _coverRefs;

    event CoverOpened(address indexed user, bytes32 indexed key, uint8 venue, bytes32 symbol, address keeper, uint128 capPerDay);
    event CoverFunded(address indexed user, bytes32 indexed key, uint128 amount);
    event CoverWithdrawn(address indexed user, bytes32 indexed key, uint128 amount, address to);
    event ShieldedFor(address indexed user, bytes32 indexed key, uint128 amount);

    error NotCoverKeeper();
    error NoCover();
    error OutsideShieldWindow();
    error OverDailyCap(uint256 used, uint256 cap);
    error InsufficientCover(uint256 have, uint256 need);
    error VenusError(uint256 code);
    error HorizonTooLong();
    error BelowMinLoan(uint256 remaining, uint256 minLoan);
    error NoDebt();

    constructor(SessionOracle oracle_, IMoolah moolah_, uint32 shieldHorizon_) {
        if (shieldHorizon_ > 1 days) revert HorizonTooLong();
        sessionOracle = oracle_;
        calendar = oracle_.calendar();
        moolah = moolah_;
        shieldHorizon = shieldHorizon_;
    }

    function coverCount() external view returns (uint256) {
        return _coverRefs.length;
    }

    function coverAt(uint256 i) external view returns (address user, bytes32 key) {
        CoverRef memory r = _coverRefs[i];
        return (r.user, r.key);
    }

    function cover(address user, bytes32 key) external view returns (Cover memory) {
        return _covers[user][key];
    }

    function openListaCover(MarketParams calldata mp, bytes32 sym, address keeper, uint128 capPerDay, uint128 amount)
        external
        returns (bytes32 key)
    {
        key = keccak256(abi.encode(VENUE_LISTA, mp));
        Cover storage c = _covers[msg.sender][key];
        if (c.venue == 0) _coverRefs.push(CoverRef(msg.sender, key));
        c.venue = VENUE_LISTA;
        c.mp = mp;
        c.token = mp.loanToken;
        _open(c, key, sym, keeper, capPerDay, amount);
    }

    function openVenusCover(address vDebt, bytes32 sym, address keeper, uint128 capPerDay, uint128 amount)
        external
        returns (bytes32 key)
    {
        key = keccak256(abi.encode(VENUE_VENUS, vDebt));
        Cover storage c = _covers[msg.sender][key];
        if (c.venue == 0) _coverRefs.push(CoverRef(msg.sender, key));
        c.venue = VENUE_VENUS;
        c.vDebt = vDebt;
        c.token = IVToken(vDebt).underlying();
        _open(c, key, sym, keeper, capPerDay, amount);
    }

    function topUp(bytes32 key, uint128 amount) external {
        Cover storage c = _covers[msg.sender][key];
        if (c.venue == 0) revert NoCover();
        IERC20(c.token).safeTransferFrom(msg.sender, address(this), amount);
        c.balance += amount;
        emit CoverFunded(msg.sender, key, amount);
    }

    function withdraw(bytes32 key, uint128 amount, address to) external {
        Cover storage c = _covers[msg.sender][key];
        if (amount > c.balance) revert InsufficientCover(c.balance, amount);
        c.balance -= amount;
        IERC20(c.token).safeTransfer(to, amount);
        emit CoverWithdrawn(msg.sender, key, amount, to);
    }

    /// @notice False only in the regular session while the next closure is known to be more than
    ///         `shieldHorizon` away. During a closure, when the calendar cannot tell (outside its table) or when
    ///         the next closure is unknown, shields stay allowed: a shield only spends the user's own cushion on
    ///         the user's own debt, so failing open here never adds risk.
    function canShieldNow(bytes32 sym) public view returns (bool) {
        if (calendar.session(block.timestamp) != SessionCalendar.Session.REGULAR) return true;
        (, uint64 startsAt,,) = sessionOracle.windowAhead(sym);
        return startsAt == 0 || startsAt <= block.timestamp + shieldHorizon;
    }

    function shieldFor(address user, bytes32 key, uint128 amount) external {
        Cover storage c = _covers[user][key];
        if (c.venue == 0) revert NoCover();
        if (msg.sender != c.keeper) revert NotCoverKeeper();
        if (!canShieldNow(c.symbol)) revert OutsideShieldWindow();
        if (block.timestamp >= uint256(c.dayStart) + 1 days) {
            c.dayStart = uint64(block.timestamp);
            c.usedToday = 0;
        }
        if (uint256(c.usedToday) + amount > c.capPerDay) revert OverDailyCap(c.usedToday, c.capPerDay);
        if (amount > c.balance) revert InsufficientCover(c.balance, amount);
        c.usedToday += amount;
        c.balance -= amount;
        IERC20 t = IERC20(c.token);
        uint256 b0 = t.balanceOf(address(this));
        if (c.venue == VENUE_LISTA) {
            (uint256 debt, uint128 shares) = _listaDebt(c.mp, user);
            if (shares == 0) revert NoDebt();
            if (amount >= debt) {
                // Full close: repay by shares and approve exactly what Moolah will pull.
                t.forceApprove(address(moolah), debt);
                moolah.repay(c.mp, 0, shares, user, "");
            } else {
                _checkListaMinLoan(c.mp, debt, amount);
                t.forceApprove(address(moolah), amount);
                moolah.repay(c.mp, amount, 0, user, "");
            }
            t.forceApprove(address(moolah), 0);
        } else {
            uint256 debt = IVToken(c.vDebt).borrowBalanceCurrent(user);
            if (debt == 0) revert NoDebt();
            // Full close: the max sentinel repays the exact balance, so an overshoot never reverts.
            t.forceApprove(c.vDebt, amount);
            uint256 code = IVToken(c.vDebt).repayBorrowBehalf(user, amount >= debt ? type(uint256).max : amount);
            if (code != 0) revert VenusError(code);
            t.forceApprove(c.vDebt, 0);
        }
        // A full close pulls less than `amount`; the rest goes back to the cover and to today's allowance.
        uint256 pulled = b0 - t.balanceOf(address(this));
        uint256 refund = amount - pulled;
        if (refund != 0) {
            c.balance += uint128(refund);
            c.usedToday -= uint128(refund);
        }
        emit ShieldedFor(user, key, uint128(pulled));
    }

    /// @dev Moolah rejects a repay that leaves a dust loan; surface that as a clear error up front.
    function _listaDebt(MarketParams memory mp, address user) internal returns (uint256 debt, uint128 shares) {
        moolah.accrueInterest(mp);
        bytes32 id = keccak256(abi.encode(mp));
        (, shares,) = moolah.position(id, user);
        (,, uint128 tba, uint128 tbs,,) = moolah.market(id);
        debt = (uint256(shares) * (uint256(tba) + 1) + uint256(tbs) + 1e6 - 1) / (uint256(tbs) + 1e6);
    }

    function _checkListaMinLoan(MarketParams memory mp, uint256 debt, uint256 amount) internal view {
        uint256 remaining = debt - amount;
        uint256 minLoan = moolah.minLoan(mp);
        if (remaining < minLoan) revert BelowMinLoan(remaining, minLoan);
    }

    function _open(Cover storage c, bytes32 key, bytes32 sym, address keeper, uint128 capPerDay, uint128 amount) internal {
        c.symbol = sym;
        c.keeper = keeper;
        c.capPerDay = capPerDay;
        emit CoverOpened(msg.sender, key, c.venue, sym, keeper, capPerDay);
        if (amount > 0) {
            IERC20(c.token).safeTransferFrom(msg.sender, address(this), amount);
            c.balance += amount;
            emit CoverFunded(msg.sender, key, amount);
        }
    }
}
