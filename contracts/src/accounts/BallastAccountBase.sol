// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SessionOracle} from "../SessionOracle.sol";

/// @title BallastAccountBase
/// @notice Per-user account holding one collateralised loan. The owner can do anything. The keeper can only
///         make the loan safer (repay from the cushion, sell collateral into debt) and, when the owner allows
///         it, borrow back into the cushion, but only when the SessionOracle says risk may be added and
///         within the owner's LTV cap. Nothing the keeper does can move assets out of the account.
abstract contract BallastAccountBase is Initializable {
    using SafeERC20 for IERC20;

    struct Mandate {
        uint16 maxLtvBps; // ceiling for restore, and the LTV at which deleverage no longer needs a window
        uint16 shieldLtvBps; // deleverage only above this LTV and never lands more than 1% below it
        uint16 maxSlippageBps;
        bool autoRestore;
    }

    address public owner;
    address public keeper;
    bytes32 public symbol;
    SessionOracle public sessionOracle;
    Mandate public mandate;
    uint256 public trackedCollateral; // venue-native units
    uint256 private _locked;
    /// @notice Sticky: once a seizure is seen it stays recorded even if someone later donates collateral back.
    bool public liquidationRecorded;

    event KeeperSet(address indexed keeper);
    event MandateSet(uint16 maxLtvBps, uint16 shieldLtvBps, uint16 maxSlippageBps, bool autoRestore);
    event LiquidationRecorded(uint256 venueCollateral, uint256 trackedCollateral);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event CollateralDeposited(uint256 amount);
    event CollateralWithdrawn(uint256 amount, address indexed to);
    event Borrowed(uint256 assets, address indexed to);
    event Repaid(uint256 assets);
    event CushionDeposited(uint256 assets);
    event CushionWithdrawn(uint256 assets, address indexed to);
    event Shielded(uint8 kind, uint256 debtBefore, uint256 debtAfter, uint256 collateralSold);
    event Restored(uint256 assets, uint256 ltvBps);

    error NotOwner();
    error NotKeeper();
    error KeeperRestoreDisabled();
    error RestoreRefused(SessionOracle.Reason reason);
    error ExceedsMandate(uint256 ltvBps, uint256 maxLtvBps);
    error RiskNotReduced();
    error InsufficientCushion(uint256 have, uint256 need);
    error BelowMinLoan(uint256 remaining, uint256 minLoan);
    error BadMandate();
    error BadMarket();
    error BadPath();
    error Unsupported();
    error Locked();
    error NotLiquidated();
    error Unauthorized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeperOrOwner() {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
        _;
    }

    modifier lock() {
        if (_locked == 1) revert Locked();
        _locked = 1;
        _;
        _locked = 0;
    }

    function __BallastAccount_init(address owner_, address keeper_, bytes32 sym, SessionOracle oracle_, Mandate memory m)
        internal
        onlyInitializing
    {
        owner = owner_;
        keeper = keeper_;
        symbol = sym;
        sessionOracle = oracle_;
        _setMandate(m);
    }

    // ------------------------------------------------------------------ owner

    function setKeeper(address k) external onlyOwner {
        keeper = k;
        emit KeeperSet(k);
    }

    function setMandate(Mandate calldata m) external onlyOwner {
        _setMandate(m);
    }

    function depositCollateral(uint256 amount) external onlyOwner lock {
        IERC20(collateralToken()).safeTransferFrom(msg.sender, address(this), amount);
        trackedCollateral += _supplyCollateral(amount);
        emit CollateralDeposited(amount);
    }

    function withdrawCollateral(uint256 amount, address to) external onlyOwner lock {
        _reduceTracked(_withdrawCollateral(amount, to));
        emit CollateralWithdrawn(amount, to);
    }

    function borrow(uint256 assets, address to) external onlyOwner lock {
        _borrow(assets, to);
        emit Borrowed(assets, to);
    }

    function repay(uint256 assets) external onlyOwner lock {
        IERC20 loan = IERC20(loanToken());
        uint256 b0 = loan.balanceOf(address(this));
        _repay(assets);
        emit Repaid(b0 - loan.balanceOf(address(this))); // the amount actually paid, which can be below `assets`
    }

    function repayAll() external onlyOwner lock {
        uint256 paid = _repayAll();
        emit Repaid(paid);
    }

    function depositCushion(uint256 assets) external onlyOwner lock {
        IERC20(loanToken()).safeTransferFrom(msg.sender, address(this), assets);
        emit CushionDeposited(assets);
    }

    function withdrawCushion(uint256 assets, address to) external onlyOwner lock {
        IERC20(loanToken()).safeTransfer(to, assets);
        emit CushionWithdrawn(assets, to);
    }

    function rescue(address token, address to, uint256 amount) external onlyOwner lock {
        _beforeRescue(token);
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ----------------------------------------------------------------- keeper

    /// @notice Repay debt from the cushion. Works while the venue cannot price the collateral.
    function shieldRepay(uint256 assets) external onlyKeeperOrOwner lock {
        uint256 have = IERC20(loanToken()).balanceOf(address(this));
        if (assets > have) revert InsufficientCushion(have, assets);
        _accrue();
        uint256 d0 = _debt();
        uint256 c0 = _venueCollateral();
        _checkMinLoan(d0, assets);
        _repay(assets);
        uint256 d1 = _debt();
        if (d1 >= d0 || _venueCollateral() != c0) revert RiskNotReduced();
        emit Shielded(0, d0, d1, 0);
    }

    /// @notice Borrow back into the cushion, only when risk may be added and within the owner's cap.
    function restore(uint256 assets) external onlyKeeperOrOwner lock {
        if (msg.sender == keeper && msg.sender != owner && !mandate.autoRestore) revert KeeperRestoreDisabled();
        (bool ok, SessionOracle.Reason r) = sessionOracle.canAddRisk(symbol);
        if (!ok) revert RestoreRefused(r);
        _borrow(assets, address(this));
        uint256 l = _ltvBps();
        if (l > mandate.maxLtvBps) revert ExceedsMandate(l, mandate.maxLtvBps);
        emit Restored(assets, l);
    }

    // ------------------------------------------------------------------ views

    function cushion() external view returns (uint256) {
        return IERC20(loanToken()).balanceOf(address(this));
    }

    function liquidated() external view returns (bool) {
        return liquidationRecorded || _venueCollateral() < trackedCollateral;
    }

    /// @notice Anyone can latch a seizure before donated collateral hides it.
    function recordLiquidation() external {
        uint256 v = _venueCollateral();
        if (v >= trackedCollateral) revert NotLiquidated();
        liquidationRecorded = true;
        emit LiquidationRecorded(v, trackedCollateral);
    }

    function ltvBps() external view returns (uint256) {
        return _ltvBps();
    }

    function position() external view virtual returns (uint256 collateral, uint256 debt);

    function healthStatus() external view virtual returns (bool known, bool healthy);

    function loanToken() public view virtual returns (address);

    function collateralToken() public view virtual returns (address);

    // --------------------------------------------------------- venue hooks

    function _supplyCollateral(uint256 amount) internal virtual returns (uint256 venueUnits);

    function _withdrawCollateral(uint256 amount, address to) internal virtual returns (uint256 venueUnits);

    function _borrow(uint256 assets, address to) internal virtual;

    function _repay(uint256 assets) internal virtual;

    function _repayAll() internal virtual returns (uint256 paid);

    function _accrue() internal virtual;

    function _debt() internal view virtual returns (uint256);

    function _venueCollateral() internal view virtual returns (uint256);

    function _ltvBps() internal view virtual returns (uint256);

    function _checkMinLoan(uint256 debt, uint256 repayAssets) internal view virtual;

    /// @dev Venues that track collateral by a token balance block rescuing that token here.
    function _beforeRescue(address token) internal view virtual {}

    function _validateMandate(Mandate memory m) internal view virtual {
        if (m.maxLtvBps == 0 || m.maxLtvBps > 9000 || m.maxSlippageBps > 500) revert BadMandate();
        if (m.shieldLtvBps == 0 || m.shieldLtvBps >= m.maxLtvBps) revert BadMandate();
    }

    /// @dev Donations can push the venue balance above what the account tracked, so never underflow.
    function _reduceTracked(uint256 units) internal {
        trackedCollateral = units >= trackedCollateral ? 0 : trackedCollateral - units;
    }

    function _setMandate(Mandate memory m) internal {
        _validateMandate(m);
        mandate = m;
        emit MandateSet(m.maxLtvBps, m.shieldLtvBps, m.maxSlippageBps, m.autoRestore);
    }
}
