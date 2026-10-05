// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {CushionVault} from "../../src/CushionVault.sol";
import {MarketParams} from "../../src/interfaces/External.sol";

contract CushionVaultForkTest is ForkBase {
    CushionVault vault;
    MarketParams mp;
    address user = address(0xA11CE);
    address keeper = address(0xBEEF);
    bytes32 key;

    function setUp() public override {
        super.setUp();
        vault = new CushionVault(sOracle, moolah, 3 hours);
        mp = _mp("NVDAB_USD1");
        _fund(nvdab, user, 10e18);
        _fund(usd1, user, 1000e18);
        vm.startPrank(user);
        IERC20(nvdab).approve(address(moolah), type(uint256).max);
        moolah.supplyCollateral(mp, 10e18, user, "");
        moolah.borrow(mp, 1000e18, 0, user, user); // EOA position, no Ballast account
        IERC20(usd1).approve(address(vault), type(uint256).max);
        key = vault.openListaCover(mp, "NVDA", keeper, 300e18, 400e18);
        vm.stopPrank();
        address[] memory t = new address[](2);
        t[0] = nvdab;
        t[1] = usd1;
        _freezePrices(t);
    }

    function _debtOf(address who) internal view returns (uint128 shares) {
        (, shares,) = moolah.position(keccak256(abi.encode(mp)), who);
    }

    function test_keeperRepaysUserDebtBeforeClose_withoutAuthorization() public {
        vm.warp(_hourBeforeNextClose());
        uint128 s0 = _debtOf(user);
        vm.prank(keeper);
        vault.shieldFor(user, key, 200e18);
        assertLt(_debtOf(user), s0);
        assertEq(vault.cover(user, key).balance, 200e18);
    }

    function test_refusedFarFromClose() public {
        vm.warp(_nextRestoreMoment());
        vm.prank(keeper);
        vm.expectRevert(CushionVault.OutsideShieldWindow.selector);
        vault.shieldFor(user, key, 100e18);
    }

    function test_dailyCap() public {
        vm.warp(_hourBeforeNextClose());
        vm.startPrank(keeper);
        vault.shieldFor(user, key, 200e18);
        vm.expectRevert(abi.encodeWithSelector(CushionVault.OverDailyCap.selector, uint256(200e18), uint256(300e18)));
        vault.shieldFor(user, key, 150e18);
        vm.stopPrank();
    }

    function test_onlyCoverKeeper() public {
        vm.warp(_hourBeforeNextClose());
        vm.expectRevert(CushionVault.NotCoverKeeper.selector);
        vault.shieldFor(user, key, 100e18);
    }

    function test_userCanAlwaysWithdraw() public {
        uint256 b0 = IERC20(usd1).balanceOf(user);
        vm.prank(user);
        vault.withdraw(key, 400e18, user);
        assertEq(IERC20(usd1).balanceOf(user), b0 + 400e18);
    }
}
