// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {SessionOracle} from "../../src/SessionOracle.sol";
import {BallastAccountBase} from "../../src/accounts/BallastAccountBase.sol";
import {ListaAccount} from "../../src/accounts/ListaAccount.sol";
import {BallastFactory} from "../../src/accounts/BallastFactory.sol";
import {MarketParams, IPcsV3SwapRouter, IComptroller, IVenusOracle} from "../../src/interfaces/External.sol";

contract ListaAccountForkTest is ForkBase {
    using stdJson for string;
    BallastFactory factory;
    ListaAccount acct;
    MarketParams mp;
    address user = address(0xA11CE);
    address keeper = address(0xBEEF);

    function setUp() public override {
        super.setUp();
        factory = new BallastFactory(
            address(this), sOracle, moolah, IPcsV3SwapRouter(router),
            IComptroller(cfg.readAddress(".venus.comptroller")), IVenusOracle(cfg.readAddress(".venus.oracle"))
        );
        mp = _mp("NVDAB_USD1");
        vm.prank(user);
        acct = ListaAccount(factory.createListaAccount(mp, "NVDA", keeper, BallastAccountBase.Mandate(6000, 150, true)));
        _fund(nvdab, user, 10e18);
        _fund(usd1, user, 1000e18);
        vm.startPrank(user);
        IERC20(nvdab).approve(address(acct), type(uint256).max);
        IERC20(usd1).approve(address(acct), type(uint256).max);
        acct.depositCollateral(10e18);
        acct.borrow(1000e18, user); // LTV ~0.44
        acct.depositCushion(400e18);
        vm.stopPrank();
    }

    function _path() internal view returns (bytes memory) {
        return abi.encodePacked(nvdab, uint24(2500), usdt, uint24(100), usd1);
    }

    function test_factoryRegistersAccount() public view {
        assertTrue(factory.isAccount(address(acct)));
        assertEq(factory.accountsOf(user)[0], address(acct));
        assertEq(acct.owner(), user);
        assertEq(acct.trackedCollateral(), 10e18);
    }

    function test_keeperShieldRepay_reducesDebtOnly() public {
        (uint256 c0, uint256 d0) = acct.position();
        vm.prank(keeper);
        acct.shieldRepay(300e18);
        (uint256 c1, uint256 d1) = acct.position();
        assertEq(c1, c0);
        assertLt(d1, d0);
        assertEq(acct.cushion(), 100e18);
    }

    function test_shieldRepay_worksWhileListaSwitchClosed() public {
        // A closed stock makes Lista's StockOracle revert for the collateral; reproduce exactly that.
        vm.mockCallRevert(stockOracle, abi.encodeWithSignature("peek(address)", nvdab), abi.encodeWithSignature("StockMarketClosed()"));
        vm.prank(keeper);
        acct.shieldRepay(300e18);
        (, uint256 d1) = acct.position();
        assertLt(d1, 1000e18);
    }

    function test_shieldRepay_respectsMinLoan() public {
        vm.prank(user);
        acct.depositCushion(600e18); // cushion now 1000, so only the minimum-loan rule can stop this
        vm.prank(keeper);
        vm.expectPartialRevert(BallastAccountBase.BelowMinLoan.selector); // would leave ~$5 (< $15 minimum)
        acct.shieldRepay(1000e18 - 5e18);
    }

    function test_shieldRepay_cannotExceedCushion() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BallastAccountBase.InsufficientCushion.selector, uint256(400e18), uint256(500e18)));
        acct.shieldRepay(500e18);
    }

    function test_keeperCannotTouchOwnerFunctions() public {
        vm.startPrank(keeper);
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.borrow(1e18, keeper);
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.withdrawCollateral(1e18, keeper);
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.withdrawCushion(1e18, keeper);
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.setMandate(BallastAccountBase.Mandate(9000, 500, true));
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.setKeeper(keeper);
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.rescue(usd1, keeper, 1);
        vm.stopPrank();
    }

    function test_flashDeleverage_reducesLtvAndKeepsProceedsInside() public {
        uint256 l0 = acct.ltvBps();
        uint256 userUsd1 = IERC20(usd1).balanceOf(user);
        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path());
        assertLt(acct.ltvBps(), l0);
        assertEq(acct.trackedCollateral(), 9e18);
        assertEq(IERC20(usd1).balanceOf(user), userUsd1);
        assertFalse(acct.liquidated());
    }

    function test_flashDeleverage_rejectsPathNotEndingInLoanToken() public {
        vm.prank(keeper);
        vm.expectRevert(BallastAccountBase.BadPath.selector);
        acct.shieldDeleverage(200e18, 1e18, abi.encodePacked(nvdab, uint24(2500), usdt));
    }

    function test_flashDeleverage_enforcesOracleMinOut() public {
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(6000, 1, true)); // 1 bp slippage cannot be met
        vm.prank(keeper);
        vm.expectRevert();
        acct.shieldDeleverage(200e18, 1e18, _path());
    }

    function test_restore_refusedOnWeekend_andMovesNothing() public {
        address[] memory t = new address[](2);
        t[0] = nvdab;
        t[1] = usd1;
        _freezePrices(t);
        vm.warp(_nextSaturdayNoon());
        (, uint256 d0) = acct.position();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BallastAccountBase.RestoreRefused.selector, SessionOracle.Reason.NOT_REGULAR));
        acct.restore(100e18);
        (, uint256 d1) = acct.position();
        assertEq(d1, d0);
    }

    function test_restore_borrowsIntoCushionWhenAllowed() public {
        _mockCanAddRisk("NVDA", true, SessionOracle.Reason.OK);
        uint256 cushion0 = acct.cushion();
        vm.prank(keeper);
        acct.restore(100e18);
        assertEq(acct.cushion(), cushion0 + 100e18);
    }

    function test_restore_respectsMandate() public {
        _mockCanAddRisk("NVDA", true, SessionOracle.Reason.OK);
        vm.prank(keeper);
        vm.expectRevert(); // ExceedsMandate: pushes LTV above 60%
        acct.restore(600e18);
    }

    function test_restore_keeperNeedsAutoRestore() public {
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(6000, 150, false));
        _mockCanAddRisk("NVDA", true, SessionOracle.Reason.OK);
        vm.prank(keeper);
        vm.expectRevert(BallastAccountBase.KeeperRestoreDisabled.selector);
        acct.restore(100e18);
    }

    function test_liquidationIsDetected() public {
        address[] memory t = new address[](1);
        t[0] = usd1;
        _freezePrices(t);
        uint256 p = IPriceSourceLike(stockOracle).peek(nvdab);
        _setPrice(nvdab, p * 55 / 100); // -45%: LTV above LLTV
        (bool known, bool healthy) = acct.healthStatus();
        assertTrue(known);
        assertFalse(healthy);
        address liq = cfg.readAddress(".lista.liquidatorEoa");
        _fund(usd1, liq, 10_000e18);
        vm.startPrank(liq);
        IERC20(usd1).approve(address(moolah), type(uint256).max);
        moolah.liquidate(mp, address(acct), 2e18, 0, "");
        vm.stopPrank();
        assertTrue(acct.liquidated());
    }

    function testFuzz_shieldRepayNeverRaisesLtv(uint256 amt) public {
        amt = bound(amt, 1e18, 400e18);
        uint256 l0 = acct.ltvBps();
        vm.prank(keeper);
        try acct.shieldRepay(amt) {
            assertLe(acct.ltvBps(), l0);
        } catch {}
    }
}

interface IPriceSourceLike {
    function peek(address) external view returns (uint256);
}
