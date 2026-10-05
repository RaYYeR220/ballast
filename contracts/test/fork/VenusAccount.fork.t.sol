// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {SessionOracle} from "../../src/SessionOracle.sol";
import {BallastAccountBase} from "../../src/accounts/BallastAccountBase.sol";
import {VenusAccount} from "../../src/accounts/VenusAccount.sol";
import {BallastFactory} from "../../src/accounts/BallastFactory.sol";
import {IPcsV3SwapRouter, IComptroller, IVenusOracle, IVToken} from "../../src/interfaces/External.sol";

contract VenusAccountForkTest is ForkBase {
    using stdJson for string;
    BallastFactory factory;
    VenusAccount acct;
    address user = address(0xA11CE);
    address keeper = address(0xBEEF);

    function setUp() public override {
        super.setUp();
        factory = new BallastFactory(
            sOracle, moolah, IPcsV3SwapRouter(router),
            IComptroller(cfg.readAddress(".venus.comptroller")), IVenusOracle(cfg.readAddress(".venus.oracle"))
        );
        vm.prank(user);
        acct = VenusAccount(factory.createVenusAccount(
            cfg.readAddress(".venus.vTSLAB"), cfg.readAddress(".venus.vUSDT"), "TSLA", keeper,
            BallastAccountBase.Mandate(5000, 4000, 150, true)
        ));
        _fund(tslab, user, 1e18);
        _fund(usdt, user, 200e18);
        vm.startPrank(user);
        IERC20(tslab).approve(address(acct), type(uint256).max);
        IERC20(usdt).approve(address(acct), type(uint256).max);
        acct.depositCollateral(1e18);
        acct.borrow(100e18, user);
        acct.depositCushion(50e18);
        vm.stopPrank();
    }

    function test_shieldRepay_venus() public {
        (, uint256 d0) = acct.position();
        vm.prank(keeper);
        acct.shieldRepay(40e18);
        (, uint256 d1) = acct.position();
        assertLt(d1, d0);
        assertFalse(acct.liquidated());
    }

    function test_restore_refusedOnWeekend_venus() public {
        vm.warp(_nextSaturdayNoon());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BallastAccountBase.RestoreRefused.selector, SessionOracle.Reason.NOT_REGULAR));
        acct.restore(10e18);
    }

    function test_restore_venusWhenAllowed() public {
        _mockCanAddRisk("TSLA", true, SessionOracle.Reason.OK);
        uint256 c0 = acct.cushion();
        vm.prank(keeper);
        acct.restore(10e18);
        assertEq(acct.cushion(), c0 + 10e18);
    }

    function test_tinyPosition_likeMainnetDemo() public {
        address small = address(0x5A11);
        vm.prank(small);
        VenusAccount a = VenusAccount(factory.createVenusAccount(
            cfg.readAddress(".venus.vTSLAB"), cfg.readAddress(".venus.vUSDT"), "TSLA", keeper,
            BallastAccountBase.Mandate(5000, 4000, 150, true)
        ));
        _fund(tslab, small, 0.013e18); // about $5
        vm.startPrank(small);
        IERC20(tslab).approve(address(a), type(uint256).max);
        IERC20(usdt).approve(address(a), type(uint256).max);
        a.depositCollateral(0.013e18);
        a.borrow(1.5e18, address(a)); // borrow straight into the cushion
        vm.stopPrank();
        vm.prank(keeper);
        a.shieldRepay(1e18);
        (, uint256 d) = a.position();
        assertApproxEqAbs(d, 0.5e18, 0.01e18);
    }

    // ---------------------------------------------------- owner exit, rescue

    function test_ownerCanAlwaysExit_venus() public {
        vm.startPrank(user);
        acct.depositCushion(50e18); // cushion 100 USDT, debt ~100.0x
        acct.repayAll();
        (uint256 c, uint256 d) = acct.position();
        assertEq(d, 0);
        acct.withdrawCollateral(c - 1, user); // exchange-rate rounding: leave a wei-level remainder
        uint256 left = acct.cushion();
        acct.withdrawCushion(left, user);
        vm.stopPrank();
        assertGt(IERC20(tslab).balanceOf(user), 0.999e18);
        assertEq(acct.cushion(), 0);
    }

    function test_shieldRepay_fullRepayDoesNotOvershoot_venus() public {
        vm.prank(user);
        acct.depositCushion(50e18); // cushion 100
        vm.prank(keeper);
        acct.shieldRepay(100e18); // at or above the debt: repays the exact balance
        (, uint256 d) = acct.position();
        assertEq(d, 0);
    }

    function test_rescue_blocksVCollateral_allowsStrayTokens() public {
        vm.startPrank(user);
        vm.expectRevert(BallastAccountBase.Unsupported.selector);
        acct.rescue(cfg.readAddress(".venus.vTSLAB"), user, 1);
        vm.stopPrank();
        _fund(usd1, address(acct), 1e18);
        vm.prank(user);
        acct.rescue(usd1, user, 1e18);
        assertEq(IERC20(usd1).balanceOf(user), 1e18);
    }

    function test_badMarketRejected_venus() public {
        address vT = cfg.readAddress(".venus.vTSLAB");
        vm.prank(user);
        vm.expectRevert(BallastAccountBase.BadMarket.selector); // same vToken on both sides
        factory.createVenusAccount(vT, vT, "TSLA", keeper, BallastAccountBase.Mandate(5000, 4000, 150, true));
        vm.prank(user);
        vm.expectRevert(BallastAccountBase.BadMarket.selector); // collateral is not the ticker's bStock
        factory.createVenusAccount(vT, cfg.readAddress(".venus.vUSDT"), "NVDA", keeper, BallastAccountBase.Mandate(5000, 4000, 150, true));
        vm.prank(user);
        vm.expectRevert(BallastAccountBase.BadMarket.selector); // not a Venus market
        factory.createVenusAccount(vT, address(0xdead), "TSLA", keeper, BallastAccountBase.Mandate(5000, 4000, 150, true));
    }

    // ------------------------------------------------------------ liquidation

    function test_liquidationIsDetected_venus() public {
        address vT = cfg.readAddress(".venus.vTSLAB");
        address vU = cfg.readAddress(".venus.vUSDT");
        IVenusOracle vo = IVenusOracle(cfg.readAddress(".venus.oracle"));
        uint256 pU = vo.getUnderlyingPrice(vU);
        (uint256 coll, uint256 debt) = acct.position();
        // Collateral priced so that debt equals its full value: far past any collateral factor.
        vm.mockCall(address(vo), abi.encodeCall(IVenusOracle.getUnderlyingPrice, (vT)), abi.encode(debt * pU / coll));
        (bool known, bool healthy) = acct.healthStatus();
        assertTrue(known);
        assertFalse(healthy);
        assertFalse(acct.liquidated());

        address liquidator = cfg.readAddress(".venus.liquidator");
        address liq = address(0x11);
        _fund(usdt, liq, 100e18);
        vm.startPrank(liq);
        IERC20(usdt).approve(liquidator, type(uint256).max);
        ILiquidator(liquidator).liquidateBorrow(vU, address(acct), 10e18, vT);
        vm.stopPrank();
        assertTrue(acct.liquidated());
    }
}

interface ILiquidator {
    function liquidateBorrow(address vToken, address borrower, uint256 repayAmount, address vTokenCollateral) external payable;
}
