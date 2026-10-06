// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BallastAccountBase} from "./BallastAccountBase.sol";
import {SessionOracle} from "../SessionOracle.sol";
import {MarketParams, IMoolah, IMoolahFlashLoanCallback, IPcsV3SwapRouter} from "../interfaces/External.sol";

/// @title ListaAccount
/// @notice Ballast account on one Lista Lending (Moolah) market. Adds flash-loan deleverage: borrow the loan
///         token from Moolah, repay, withdraw collateral, sell it on PancakeSwap v3 with an oracle-bound
///         minimum, and return the flash loan, the only shape that works close to the liquidation LTV.
contract ListaAccount is BallastAccountBase, IMoolahFlashLoanCallback {
    using SafeERC20 for IERC20;

    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint256 internal constant ORACLE_SCALE = 1e36;

    IMoolah public moolah;
    IPcsV3SwapRouter public router;
    bytes32 public marketId;
    MarketParams internal _mp;
    bool private _inFlash;
    bytes32 public deleveragePathHash;

    event DeleveragePathSet(bytes32 indexed pathHash);

    error DeleverageDisabled();
    error NotInShieldWindow();
    error BelowShieldLtv(uint256 ltvBps, uint256 shieldLtvBps);
    error OverDeleverage(uint256 ltvAfterBps, uint256 shieldLtvBps);

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address keeper_,
        bytes32 sym,
        SessionOracle oracle_,
        Mandate calldata m,
        IMoolah moolah_,
        MarketParams calldata mp,
        IPcsV3SwapRouter router_
    ) external initializer {
        moolah = moolah_;
        router = router_;
        _mp = mp;
        _verifyMarket(moolah_, oracle_, sym, mp);
        __BallastAccount_init(owner_, keeper_, sym, oracle_, m);
    }

    function _verifyMarket(IMoolah moolah_, SessionOracle oracle_, bytes32 sym, MarketParams calldata mp) internal {
        bytes32 id = keccak256(abi.encode(mp));
        marketId = id;
        (address loan, address coll, address mOracle, address mIrm, uint256 lltv) = moolah_.idToMarketParams(id);
        if (loan != mp.loanToken || coll != mp.collateralToken || mOracle != mp.oracle || mIrm != mp.irm || lltv != mp.lltv) {
            revert BadMarket();
        }
        if (oracle_.ticker(sym).bStock != mp.collateralToken) revert BadMarket();
    }

    /// @notice Owner fixes the one swap route the keeper may use for deleverage (empty path disables it).
    function setDeleveragePath(bytes calldata path) external onlyOwner {
        if (path.length == 0) {
            deleveragePathHash = bytes32(0);
        } else {
            _checkPath(path);
            deleveragePathHash = keccak256(path);
        }
        emit DeleveragePathSet(deleveragePathHash);
    }

    function marketParams() external view returns (MarketParams memory) {
        return _mp;
    }

    function loanToken() public view override returns (address) {
        return _mp.loanToken;
    }

    function collateralToken() public view override returns (address) {
        return _mp.collateralToken;
    }

    function position() external view override returns (uint256 collateral, uint256 debt) {
        return (_venueCollateral(), _debt());
    }

    function healthStatus() external view override returns (bool known, bool healthy) {
        try moolah.isHealthy(_mp, marketId, address(this)) returns (bool h) {
            return (true, h);
        } catch {
            return (false, false);
        }
    }

    /// @notice Sell `collateralToSell` into debt through a Moolah flash loan of `repayAssets`.
    /// @dev Bounded: owner-fixed route, only inside the pre-closure window (or at/above the owner's max LTV),
    ///      only while LTV is above the owner's shield LTV, never lands more than 1% below it, and the swap
    ///      must beat both the oracle floor and the caller's `minOut`.
    function shieldDeleverage(uint256 repayAssets, uint256 collateralToSell, bytes calldata path, uint256 minOut)
        external
        onlyKeeperOrOwner
        lock
    {
        bytes32 h = deleveragePathHash;
        if (h == bytes32(0)) revert DeleverageDisabled();
        if (keccak256(path) != h) revert BadPath();
        _accrue();
        uint256 l0 = _ltvBps();
        Mandate memory m = mandate;
        if (l0 <= m.shieldLtvBps) revert BelowShieldLtv(l0, m.shieldLtvBps);
        // In the window the landing floor is the shield LTV. Outside it, the only escape is a loan strictly above
        // the owner's cap (restore can never produce that), and then it may only be trimmed back under the cap.
        uint256 floorLtv = m.shieldLtvBps;
        if (!_windowNear()) {
            if (l0 <= m.maxLtvBps) revert NotInShieldWindow();
            floorLtv = m.maxLtvBps;
        }
        uint256 d0 = _debt();
        _checkMinLoan(d0, repayAssets);
        _inFlash = true;
        moolah.flashLoan(_mp.loanToken, repayAssets, abi.encode(collateralToSell, path, minOut));
        _inFlash = false;
        _reduceTracked(collateralToSell);
        uint256 l1 = _ltvBps();
        if (l1 >= l0) revert RiskNotReduced();
        if (l1 + 100 < floorLtv) revert OverDeleverage(l1, floorLtv);
        emit Shielded(1, d0, _debt(), collateralToSell);
    }

    function onMoolahFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(moolah) || !_inFlash) revert Unauthorized();
        (uint256 coll, bytes memory path, uint256 userMinOut) = abi.decode(data, (uint256, bytes, uint256));
        IERC20 loan = IERC20(_mp.loanToken);
        loan.forceApprove(address(moolah), assets);
        moolah.repay(_mp, assets, 0, address(this), "");
        moolah.withdrawCollateral(_mp, coll, address(this), address(this));
        uint256 floor = coll * moolah.getPrice(_mp) / ORACLE_SCALE * (10_000 - mandate.maxSlippageBps) / 10_000;
        uint256 minOut = userMinOut > floor ? userMinOut : floor;
        IERC20 collToken = IERC20(_mp.collateralToken);
        collToken.forceApprove(address(router), coll);
        router.exactInput(
            IPcsV3SwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: coll,
                amountOutMinimum: minOut
            })
        );
        collToken.forceApprove(address(router), 0);
        loan.forceApprove(address(moolah), assets); // Moolah pulls the flash loan back
    }

    function _windowNear() internal view returns (bool) {
        (, uint64 startsAt,,) = sessionOracle.windowAhead(symbol);
        (, uint32 horizon,,,,,) = sessionOracle.params();
        return startsAt != 0 && startsAt <= block.timestamp + horizon;
    }

    // --------------------------------------------------------- venue hooks

    function _supplyCollateral(uint256 amount) internal override returns (uint256) {
        IERC20(_mp.collateralToken).forceApprove(address(moolah), amount);
        moolah.supplyCollateral(_mp, amount, address(this), "");
        return amount;
    }

    function _withdrawCollateral(uint256 amount, address to) internal override returns (uint256) {
        moolah.withdrawCollateral(_mp, amount, address(this), to);
        return amount;
    }

    function _borrow(uint256 assets, address to) internal override {
        moolah.borrow(_mp, assets, 0, address(this), to);
    }

    function _repay(uint256 assets) internal override {
        IERC20(_mp.loanToken).forceApprove(address(moolah), assets);
        _accrue();
        if (assets >= _debt()) {
            // Full repay goes by shares so no dust is left and the amount never exceeds `assets`.
            (, uint128 shares,) = moolah.position(marketId, address(this));
            if (shares != 0) moolah.repay(_mp, 0, shares, address(this), "");
        } else {
            moolah.repay(_mp, assets, 0, address(this), "");
        }
        IERC20(_mp.loanToken).forceApprove(address(moolah), 0);
    }

    function _validateMandate(Mandate memory m) internal view override {
        super._validateMandate(m);
        if (uint256(m.maxLtvBps) * 1e14 >= _mp.lltv) revert BadMandate();
    }

    function _repayAll() internal override returns (uint256 paid) {
        (, uint128 shares,) = moolah.position(marketId, address(this));
        if (shares == 0) return 0;
        IERC20(_mp.loanToken).forceApprove(address(moolah), type(uint256).max);
        (paid,) = moolah.repay(_mp, 0, shares, address(this), "");
        IERC20(_mp.loanToken).forceApprove(address(moolah), 0);
    }

    function _accrue() internal override {
        moolah.accrueInterest(_mp);
    }

    function _debt() internal view override returns (uint256) {
        (, uint128 shares,) = moolah.position(marketId, address(this));
        if (shares == 0) return 0;
        (,, uint128 tba, uint128 tbs,,) = moolah.market(marketId);
        uint256 num = uint256(shares) * (uint256(tba) + VIRTUAL_ASSETS);
        uint256 den = uint256(tbs) + VIRTUAL_SHARES;
        return (num + den - 1) / den;
    }

    function _venueCollateral() internal view override returns (uint256) {
        (,, uint128 c) = moolah.position(marketId, address(this));
        return c;
    }

    function _ltvBps() internal view override returns (uint256) {
        uint256 d = _debt();
        if (d == 0) return 0;
        uint256 value = _venueCollateral() * moolah.getPrice(_mp) / ORACLE_SCALE;
        if (value == 0) return type(uint256).max;
        return d * 10_000 / value;
    }

    function _checkMinLoan(uint256 debt, uint256 repayAssets) internal view override {
        if (repayAssets >= debt) return;
        uint256 remaining = debt - repayAssets;
        uint256 minLoan = moolah.minLoan(_mp);
        if (remaining < minLoan) revert BelowMinLoan(remaining, minLoan);
    }

    function _checkPath(bytes calldata path) internal view {
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadPath();
        if (address(bytes20(path[0:20])) != _mp.collateralToken) revert BadPath();
        if (address(bytes20(path[path.length - 20:])) != _mp.loanToken) revert BadPath();
    }
}
