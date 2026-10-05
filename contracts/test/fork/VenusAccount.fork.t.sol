// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {SessionOracle} from "../../src/SessionOracle.sol";
import {BallastAccountBase} from "../../src/accounts/BallastAccountBase.sol";
import {VenusAccount} from "../../src/accounts/VenusAccount.sol";
import {BallastFactory} from "../../src/accounts/BallastFactory.sol";
import {IPcsV3SwapRouter, IComptroller, IVenusOracle} from "../../src/interfaces/External.sol";

contract VenusAccountForkTest is ForkBase {
    using stdJson for string;
    BallastFactory factory;
    VenusAccount acct;
    address user = address(0xA11CE);
    address keeper = address(0xBEEF);

    function setUp() public override {
        super.setUp();
        factory = new BallastFactory(
            address(this), sOracle, moolah, IPcsV3SwapRouter(router),
            IComptroller(cfg.readAddress(".venus.comptroller")), IVenusOracle(cfg.readAddress(".venus.oracle"))
        );
        vm.prank(user);
        acct = VenusAccount(factory.createVenusAccount(
            cfg.readAddress(".venus.vTSLAB"), cfg.readAddress(".venus.vUSDT"), "TSLA", keeper,
            BallastAccountBase.Mandate(5000, 150, true)
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
            BallastAccountBase.Mandate(5000, 150, true)
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
}
