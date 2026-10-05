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
///         before a closure (or during one), and at most `capPerDay`. Repay-on-behalf needs no authorization
///         on Lista or Venus and works while the venue cannot price the collateral.
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

    constructor(SessionOracle oracle_, IMoolah moolah_, uint32 shieldHorizon_) {
        sessionOracle = oracle_;
        calendar = oracle_.calendar();
        moolah = moolah_;
        shieldHorizon = shieldHorizon_;
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

    /// @notice True during a closure or within `shieldHorizon` of the next one.
    function canShieldNow(bytes32 sym) public view returns (bool) {
        SessionCalendar.Session s = calendar.session(block.timestamp);
        if (s == SessionCalendar.Session.UNKNOWN) return false;
        if (s != SessionCalendar.Session.REGULAR) return true;
        (, uint64 startsAt,,) = sessionOracle.windowAhead(sym);
        return startsAt != 0 && startsAt <= block.timestamp + shieldHorizon;
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
        if (c.venue == VENUE_LISTA) {
            IERC20(c.token).forceApprove(address(moolah), amount);
            moolah.repay(c.mp, amount, 0, user, "");
        } else {
            IERC20(c.token).forceApprove(c.vDebt, amount);
            uint256 code = IVToken(c.vDebt).repayBorrowBehalf(user, amount);
            if (code != 0) revert VenusError(code);
        }
        emit ShieldedFor(user, key, amount);
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
