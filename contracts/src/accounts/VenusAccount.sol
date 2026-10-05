// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BallastAccountBase} from "./BallastAccountBase.sol";
import {SessionOracle} from "../SessionOracle.sol";
import {IVToken, IComptroller, IVenusOracle} from "../interfaces/External.sol";

/// @title VenusAccount
/// @notice Ballast account on the Venus core pool: bStock collateral vToken, stablecoin debt vToken.
///         Cushion repay and gated restore only — Venus has no flash loan, so near-threshold deleverage is
///         Lista-only. Collateral is tracked in vTokens so a liquidation seizure is detected exactly.
contract VenusAccount is BallastAccountBase {
    using SafeERC20 for IERC20;

    error VenusError(uint256 code);

    IComptroller public comptroller;
    IVToken public vCollateral;
    IVToken public vDebt;
    IVenusOracle public venusOracle;

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address keeper_,
        bytes32 sym,
        SessionOracle oracle_,
        Mandate calldata m,
        IComptroller comptroller_,
        IVToken vCollateral_,
        IVToken vDebt_,
        IVenusOracle venusOracle_
    ) external initializer {
        __BallastAccount_init(owner_, keeper_, sym, oracle_, m);
        comptroller = comptroller_;
        vCollateral = vCollateral_;
        vDebt = vDebt_;
        venusOracle = venusOracle_;
        if (oracle_.ticker(sym).bStock != vCollateral_.underlying()) revert BadMandate();
        address[] memory markets = new address[](1);
        markets[0] = address(vCollateral_);
        uint256[] memory errs = comptroller_.enterMarkets(markets);
        if (errs[0] != 0) revert VenusError(errs[0]);
    }

    function loanToken() public view override returns (address) {
        return vDebt.underlying();
    }

    function collateralToken() public view override returns (address) {
        return vCollateral.underlying();
    }

    function position() external view override returns (uint256 collateral, uint256 debt) {
        collateral = vCollateral.balanceOf(address(this)) * vCollateral.exchangeRateStored() / 1e18;
        debt = vDebt.borrowBalanceStored(address(this));
    }

    function healthStatus() external view override returns (bool known, bool healthy) {
        try comptroller.getAccountLiquidity(address(this)) returns (uint256 err, uint256, uint256 shortfall) {
            if (err != 0) return (false, false);
            return (true, shortfall == 0);
        } catch {
            return (false, false);
        }
    }

    function _supplyCollateral(uint256 amount) internal override returns (uint256 units) {
        uint256 b0 = vCollateral.balanceOf(address(this));
        IERC20(collateralToken()).forceApprove(address(vCollateral), amount);
        _ok(vCollateral.mint(amount));
        units = vCollateral.balanceOf(address(this)) - b0;
    }

    function _withdrawCollateral(uint256 amount, address to) internal override returns (uint256 units) {
        uint256 b0 = vCollateral.balanceOf(address(this));
        _ok(vCollateral.redeemUnderlying(amount));
        units = b0 - vCollateral.balanceOf(address(this));
        if (to != address(this)) IERC20(collateralToken()).safeTransfer(to, amount);
    }

    function _borrow(uint256 assets, address to) internal override {
        _ok(vDebt.borrow(assets));
        if (to != address(this)) IERC20(loanToken()).safeTransfer(to, assets);
    }

    function _repay(uint256 assets) internal override {
        IERC20(loanToken()).forceApprove(address(vDebt), assets);
        _ok(vDebt.repayBorrow(assets));
    }

    function _repayAll() internal override returns (uint256 paid) {
        paid = vDebt.borrowBalanceCurrent(address(this));
        if (paid == 0) return 0;
        IERC20(loanToken()).forceApprove(address(vDebt), paid);
        _ok(vDebt.repayBorrow(type(uint256).max));
    }

    function _accrue() internal override {
        vDebt.borrowBalanceCurrent(address(this));
    }

    function _debt() internal view override returns (uint256) {
        return vDebt.borrowBalanceStored(address(this));
    }

    function _venueCollateral() internal view override returns (uint256) {
        return vCollateral.balanceOf(address(this));
    }

    function _ltvBps() internal view override returns (uint256) {
        uint256 d = _debt();
        if (d == 0) return 0;
        uint256 coll = vCollateral.balanceOf(address(this)) * vCollateral.exchangeRateStored() / 1e18;
        uint256 collValue = coll * venusOracle.getUnderlyingPrice(address(vCollateral)) / 1e18;
        uint256 debtValue = d * venusOracle.getUnderlyingPrice(address(vDebt)) / 1e18;
        if (collValue == 0) return type(uint256).max;
        return debtValue * 10_000 / collValue;
    }

    function _checkMinLoan(uint256, uint256) internal pure override {}

    function _ok(uint256 code) internal pure {
        if (code != 0) revert VenusError(code);
    }
}
