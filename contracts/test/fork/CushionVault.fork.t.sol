// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {CushionVault} from "../../src/CushionVault.sol";
import {SessionCalendar} from "../../src/SessionCalendar.sol";
import {MarketParams, IVToken, IComptroller} from "../../src/interfaces/External.sol";

contract CushionVaultForkTest is ForkBase {
    using stdJson for string;

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

    function test_userWithdrawsRemainderAfterShield() public {
        vm.warp(_hourBeforeNextClose());
        vm.prank(keeper);
        vault.shieldFor(user, key, 200e18);
        uint256 b0 = IERC20(usd1).balanceOf(user);
        vm.prank(user);
        vault.withdraw(key, 200e18, user);
        assertEq(IERC20(usd1).balanceOf(user), b0 + 200e18);
        assertEq(vault.cover(user, key).balance, 0);
    }

    function test_crossUserIsolation() public {
        vm.warp(_hourBeforeNextClose());
        vm.prank(keeper);
        vm.expectRevert(CushionVault.NoCover.selector); // key exists for `user` only
        vault.shieldFor(address(0xB0B), key, 100e18);
        vm.prank(address(0xB0B));
        vm.expectRevert(abi.encodeWithSelector(CushionVault.InsufficientCover.selector, uint256(0), uint256(1)));
        vault.withdraw(key, 1, address(0xB0B)); // someone else's key holds nothing for them
    }

    function test_listaMinLoanGivesClearError() public {
        vm.startPrank(user);
        vault.openListaCover(mp, "NVDA", keeper, 2000e18, 0);
        vault.topUp(key, 900e18); // balance now 1300
        vm.stopPrank();
        vm.warp(_hourBeforeNextClose());
        vm.prank(keeper);
        vm.expectPartialRevert(CushionVault.BelowMinLoan.selector); // would leave ~$5 of debt
        vault.shieldFor(user, key, 995e18);
    }

    function test_listaFullCloseRepaysByShares() public {
        vm.startPrank(user);
        vault.openListaCover(mp, "NVDA", keeper, 2000e18, 0);
        vault.topUp(key, 900e18); // balance 1300 > debt ~1000
        vm.stopPrank();
        vm.warp(_hourBeforeNextClose());
        vm.prank(keeper);
        vault.shieldFor(user, key, 1300e18);
        assertEq(_debtOf(user), 0);
        uint256 left = vault.cover(user, key).balance;
        assertGt(left, 250e18); // only the real debt was pulled
        assertEq(IERC20(usd1).balanceOf(address(vault)), left);
    }

    function test_horizonBounded() public {
        vm.expectRevert(CushionVault.HorizonTooLong.selector);
        new CushionVault(sOracle, moolah, 1 days + 1);
    }

    function test_enumeration() public {
        assertEq(vault.coverCount(), 1);
        (address u, bytes32 k) = vault.coverAt(0);
        assertEq(u, user);
        assertEq(k, key);
        vm.prank(user);
        vault.openListaCover(mp, "NVDA", keeper, 100e18, 0); // reopening the same cover does not duplicate
        assertEq(vault.coverCount(), 1);
    }

    /// @dev `userV` supplies 1 TSLAB on Venus, borrows `borrowAmt` USDT, and opens a USDT cover of `amount`.
    function _venusUser(address userV, uint256 borrowAmt, uint128 cap, uint128 amount) internal returns (address vU, bytes32 k) {
        address vT = cfg.readAddress(".venus.vTSLAB");
        vU = cfg.readAddress(".venus.vUSDT");
        _fund(tslab, userV, 1e18);
        _fund(usdt, userV, amount);
        vm.startPrank(userV);
        IERC20(tslab).approve(vT, type(uint256).max);
        assertEq(IVToken(vT).mint(1e18), 0);
        address[] memory ms = new address[](1);
        ms[0] = vT;
        IComptroller(cfg.readAddress(".venus.comptroller")).enterMarkets(ms);
        if (borrowAmt != 0) assertEq(IVToken(vU).borrow(borrowAmt), 0);
        IERC20(usdt).approve(address(vault), type(uint256).max);
        k = vault.openVenusCover(vU, "TSLA", keeper, cap, amount);
        vm.stopPrank();
    }

    function test_venusCover_repaysOnBehalf() public {
        address userV = address(0xB0B);
        (address vU, bytes32 k) = _venusUser(userV, 100e18, 80e18, 60e18);
        vm.warp(_hourBeforeNextClose());
        uint256 d0 = IVToken(vU).borrowBalanceStored(userV);
        vm.prank(keeper);
        vault.shieldFor(userV, k, 50e18);
        assertLt(IVToken(vU).borrowBalanceStored(userV), d0);
        assertEq(vault.cover(userV, k).balance, 10e18);
        assertEq(vault.coverCount(), 2);
    }

    function test_venusFullClose_repaysExactBalance_refundsRest() public {
        address userV = address(0xB0B);
        (address vU, bytes32 k) = _venusUser(userV, 100e18, 200e18, 150e18);
        vm.warp(_hourBeforeNextClose());
        vm.roll(block.number + 1000); // Venus accrues per block: let some interest build
        uint256 d = IVToken(vU).borrowBalanceCurrent(userV);
        assertGt(d, 100e18);
        vm.expectEmit(address(vault));
        emit CushionVault.ShieldedFor(userV, k, uint128(d)); // the amount actually pulled, not the 150 asked for
        vm.prank(keeper);
        vault.shieldFor(userV, k, 150e18);
        assertEq(IVToken(vU).borrowBalanceStored(userV), 0);
        CushionVault.Cover memory c = vault.cover(userV, k);
        assertEq(c.balance, 150e18 - d);
        assertEq(c.usedToday, d);
        assertEq(IERC20(usdt).balanceOf(address(vault)), c.balance);
        assertEq(IERC20(usdt).allowance(address(vault), vU), 0);
    }

    function test_noDebt_venus() public {
        address userV = address(0xB0B);
        (, bytes32 k) = _venusUser(userV, 0, 100e18, 50e18);
        vm.warp(_hourBeforeNextClose());
        vm.prank(keeper);
        vm.expectRevert(CushionVault.NoDebt.selector);
        vault.shieldFor(userV, k, 10e18);
    }

    function test_noDebt_lista() public {
        address userN = address(0xC0FFEE); // a cover with no Lista loan behind it
        _fund(usd1, userN, 50e18);
        vm.startPrank(userN);
        IERC20(usd1).approve(address(vault), type(uint256).max);
        bytes32 k = vault.openListaCover(mp, "NVDA", keeper, 100e18, 50e18);
        vm.stopPrank();
        vm.warp(_hourBeforeNextClose());
        vm.prank(keeper);
        vm.expectRevert(CushionVault.NoDebt.selector);
        vault.shieldFor(userN, k, 10e18);
        assertEq(vault.cover(userN, k).balance, 50e18);
    }

    // Spec section 7: shields stay allowed when the calendar cannot tell; a shield only spends the user's own
    // cushion on the user's own debt.

    function test_shieldAllowedWhenCalendarUnknown() public {
        vm.warp(cal.VALID_THROUGH() + 2 days); // past the calendar table
        assertEq(uint8(cal.session(block.timestamp)), uint8(SessionCalendar.Session.UNKNOWN));
        assertTrue(vault.canShieldNow("NVDA"));
        uint128 s0 = _debtOf(user);
        vm.prank(keeper);
        vault.shieldFor(user, key, 100e18);
        assertLt(_debtOf(user), s0);
    }

    function test_shieldAllowedInRegularWhenNextClosureUnknown() public {
        vm.warp(1830279600); // Fri 2027-12-31 14:00 EST: regular session, the next open is past the table
        assertEq(uint8(cal.session(block.timestamp)), uint8(SessionCalendar.Session.REGULAR));
        (, uint64 startsAt,,) = sOracle.windowAhead("NVDA");
        assertEq(startsAt, 0);
        assertTrue(vault.canShieldNow("NVDA"));
        uint128 s0 = _debtOf(user);
        vm.prank(keeper);
        vault.shieldFor(user, key, 100e18);
        assertLt(_debtOf(user), s0);
    }
}
