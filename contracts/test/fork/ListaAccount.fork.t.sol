// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ForkBase} from "./ForkBase.sol";
import {SessionOracle} from "../../src/SessionOracle.sol";
import {BallastAccountBase} from "../../src/accounts/BallastAccountBase.sol";
import {ListaAccount} from "../../src/accounts/ListaAccount.sol";
import {BallastFactory} from "../../src/accounts/BallastFactory.sol";
import {MarketParams, IMoolah, IPcsV3SwapRouter, IComptroller, IVenusOracle} from "../../src/interfaces/External.sol";

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
            sOracle, moolah, IPcsV3SwapRouter(router),
            IComptroller(cfg.readAddress(".venus.comptroller")), IVenusOracle(cfg.readAddress(".venus.oracle"))
        );
        mp = _mp("NVDAB_USD1");
        vm.prank(user);
        acct = ListaAccount(factory.createListaAccount(mp, "NVDA", keeper, BallastAccountBase.Mandate(6000, 5000, 150, true)));
        _fund(nvdab, user, 10e18);
        _fund(usd1, user, 1000e18);
        vm.startPrank(user);
        IERC20(nvdab).approve(address(acct), type(uint256).max);
        IERC20(usd1).approve(address(acct), type(uint256).max);
        acct.depositCollateral(10e18);
        acct.borrow(1000e18, user); // LTV ~0.44
        acct.depositCushion(400e18);
        acct.setDeleveragePath(_path());
        vm.stopPrank();
    }

    function _path() internal view returns (bytes memory) {
        return abi.encodePacked(nvdab, uint24(2500), usdt, uint24(100), usd1);
    }

    function _freeze() internal {
        address[] memory t = new address[](2);
        t[0] = nvdab;
        t[1] = usd1;
        _freezePrices(t);
    }

    /// @dev A keeper deleverage spends the cushion first; tests of the sale itself start with none.
    function _drainCushion() internal {
        vm.startPrank(user);
        acct.withdrawCushion(acct.cushion(), user);
        vm.stopPrank();
    }

    /// @dev Freeze prices, move to one hour before the next close, empty the cushion, and set the shield LTV so
    ///      that selling 1 of 10 collateral into a 200 repay lands within 1% of it. Returns the LTV before.
    function _armWindow(bool exact) internal returns (uint256 l0) {
        _freeze();
        vm.warp(_hourBeforeNextClose());
        _drainCushion();
        l0 = acct.ltvBps();
        uint256 shield = exact ? l0 * 8 / 9 + 50 : l0 / 2;
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(6000, uint16(shield), 150, true));
    }

    // ------------------------------------------------------------ factory

    function test_factoryRegistersAccount() public view {
        assertTrue(factory.isAccount(address(acct)));
        assertEq(factory.accountsOf(user)[0], address(acct));
        assertEq(factory.allAccounts(0), address(acct));
        assertEq(factory.accountCount(), 1);
        assertEq(acct.owner(), user);
        assertEq(acct.trackedCollateral(), 10e18);
    }

    function test_badMarketRejected() public {
        MarketParams memory bad = mp;
        bad.lltv = 0.5e18;
        vm.prank(user);
        vm.expectRevert(BallastAccountBase.BadMarket.selector);
        factory.createListaAccount(bad, "NVDA", keeper, BallastAccountBase.Mandate(4000, 3000, 150, true));
        vm.prank(user);
        vm.expectRevert(BallastAccountBase.BadMarket.selector); // the ticker's bStock is not this market's collateral
        factory.createListaAccount(mp, "TSLA", keeper, BallastAccountBase.Mandate(6000, 5000, 150, true));
    }

    function test_mandateValidation() public {
        vm.startPrank(user);
        vm.expectRevert(BallastAccountBase.BadMandate.selector); // shield >= max
        acct.setMandate(BallastAccountBase.Mandate(6000, 6000, 150, true));
        vm.expectRevert(BallastAccountBase.BadMandate.selector); // max >= market LLTV (75%)
        acct.setMandate(BallastAccountBase.Mandate(7500, 5000, 150, true));
        vm.expectRevert(BallastAccountBase.BadMandate.selector); // slippage cap
        acct.setMandate(BallastAccountBase.Mandate(6000, 5000, 501, true));
        vm.stopPrank();
    }

    // -------------------------------------------------------- shieldRepay

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

    function test_shieldRepay_fullRepayGoesByShares() public {
        vm.prank(user);
        acct.depositCushion(700e18); // cushion 1100 > debt ~1000
        vm.prank(keeper);
        acct.shieldRepay(1100e18);
        (uint256 c, uint256 d) = acct.position();
        assertEq(d, 0);
        assertEq(c, 10e18);
        assertGt(acct.cushion(), 90e18); // only the real debt was pulled
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
        acct.setMandate(BallastAccountBase.Mandate(9000, 5000, 500, true));
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.setKeeper(keeper);
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.rescue(usd1, keeper, 1);
        vm.expectRevert(BallastAccountBase.NotOwner.selector);
        acct.setDeleveragePath(_path());
        vm.stopPrank();
    }

    function testFuzz_shieldRepayNeverRaisesLtv(uint256 amt) public {
        amt = bound(amt, 1e18, 400e18);
        uint256 l0 = acct.ltvBps();
        vm.prank(keeper);
        acct.shieldRepay(amt);
        assertLe(acct.ltvBps(), l0);
    }

    // ----------------------------------------------------------- deleverage

    function test_flashDeleverage_reducesLtvAndKeepsProceedsInside() public {
        uint256 l0 = _armWindow(true);
        uint256 userUsd1 = IERC20(usd1).balanceOf(user);
        uint256 cushion0 = acct.cushion();
        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
        assertLt(acct.ltvBps(), l0);
        assertEq(acct.trackedCollateral(), 9e18);
        assertEq(IERC20(usd1).balanceOf(user), userUsd1);
        assertGt(acct.cushion(), cushion0); // swap proceeds beat the 200 flash loan and stay in the account
        assertFalse(acct.liquidated());
    }

    function test_deleverage_disabledUntilOwnerSetsPath() public {
        _armWindow(true);
        vm.prank(user);
        acct.setDeleveragePath("");
        assertEq(acct.deleveragePathHash(), bytes32(0));
        vm.prank(keeper);
        vm.expectRevert(ListaAccount.DeleverageDisabled.selector);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
    }

    function test_deleverage_rejectsDifferentPath() public {
        _armWindow(true);
        vm.prank(keeper);
        vm.expectRevert(BallastAccountBase.BadPath.selector);
        acct.shieldDeleverage(200e18, 1e18, abi.encodePacked(nvdab, uint24(500), usdt, uint24(100), usd1), 0);
    }

    function test_setDeleveragePath_rejectsPathNotEndingInLoanToken() public {
        vm.prank(user);
        vm.expectRevert(BallastAccountBase.BadPath.selector);
        acct.setDeleveragePath(abi.encodePacked(nvdab, uint24(2500), usdt));
    }

    function test_deleverage_refusedOutsideWindow() public {
        _freeze();
        vm.warp(_nextRestoreMoment()); // more than the horizon before the close
        _drainCushion();
        uint256 l0 = acct.ltvBps();
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(6000, uint16(l0 * 8 / 9 + 50), 150, true));
        vm.prank(keeper);
        vm.expectRevert(ListaAccount.NotInShieldWindow.selector);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
    }

    function test_deleverage_notAvailableAfterRestoreToMaxLtv() public {
        _freeze();
        vm.warp(_nextRestoreMoment());
        _mockCanAddRisk("NVDA", true, SessionOracle.Reason.OK);
        uint256 l0 = acct.ltvBps();
        uint256 cap = l0 + 200;
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(uint16(cap), uint16(l0 / 2), 150, true));
        (, uint256 d) = acct.position();
        uint256 x = d * (cap - l0) / l0 * 99 / 100; // restore as close under the cap as the sizing allows
        vm.prank(keeper);
        acct.restore(x);
        assertLe(acct.ltvBps(), cap);
        vm.prank(keeper);
        vm.expectRevert(ListaAccount.NotInShieldWindow.selector); // a restore can never open the out-of-window escape
        acct.shieldDeleverage(30e18, 0.15e18, _path(), 0);
    }

    function test_deleverage_escapeOnMarketPush_trimsBackUnderCap() public {
        uint256 l0 = _pushAboveCap();
        vm.prank(keeper);
        acct.shieldDeleverage(30e18, 0.15e18, _path(), 0); // lands about 1.5 points lower, still within cap - 1%
        assertLt(acct.ltvBps(), l0);
    }

    function test_deleverage_escapeCannotOvershootBelowCap() public {
        _pushAboveCap();
        vm.prank(keeper);
        vm.expectPartialRevert(ListaAccount.OverDeleverage.selector); // would land ~5 points down, below cap - 1%
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
    }

    /// @dev Outside the window, set the cap just above the current LTV, then push the market 5% against the loan.
    function _pushAboveCap() internal returns (uint256 l) {
        _freeze();
        vm.warp(_nextRestoreMoment());
        _drainCushion();
        uint256 l0 = acct.ltvBps();
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(uint16(l0 + 100), uint16(l0 / 2), 150, true));
        _setPrice(nvdab, IPriceSourceLike(stockOracle).peek(nvdab) * 95 / 100);
        l = acct.ltvBps();
        assertGt(l, l0 + 100);
    }

    function test_deleverage_refusedBelowShieldLtv() public {
        _freeze();
        vm.warp(_hourBeforeNextClose()); // in window, but the default shield LTV (50%) is above the ~44% LTV
        _drainCushion(); // with no cushion to spend there is nothing to do
        vm.prank(keeper);
        vm.expectPartialRevert(ListaAccount.BelowShieldLtv.selector);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
    }

    function test_deleverage_refusedWhenItOvershootsShield() public {
        _freeze();
        vm.warp(_hourBeforeNextClose());
        _drainCushion();
        uint256 l0 = acct.ltvBps();
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(6000, uint16(l0 - 100), 150, true)); // the sale drops ~5 points
        vm.prank(keeper);
        vm.expectPartialRevert(ListaAccount.OverDeleverage.selector);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
    }

    function test_flashDeleverage_enforcesOracleFloor() public {
        _armWindow(false);
        uint256 p = moolah.getPrice(mp);
        // The oracle says the collateral is worth 10% more than the pool pays, so the floor cannot be met.
        vm.mockCall(address(moolah), abi.encodeCall(IMoolah.getPrice, (mp)), abi.encode(p * 11 / 10));
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
    }

    function test_flashDeleverage_enforcesKeeperMinOut() public {
        _armWindow(false);
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        acct.shieldDeleverage(200e18, 1e18, _path(), 1_000_000e18);
    }

    function test_directFlashLoanCallbackUnauthorized() public {
        vm.expectRevert(BallastAccountBase.Unauthorized.selector);
        acct.onMoolahFlashLoan(1e18, abi.encode(uint256(1), bytes(""), uint256(0)));
        vm.prank(address(moolah));
        vm.expectRevert(BallastAccountBase.Unauthorized.selector); // right caller, but no flash in progress
        acct.onMoolahFlashLoan(1e18, abi.encode(uint256(1), bytes(""), uint256(0)));
    }

    // ---------------------------------- keeper spends the cushion inside the shield

    /// @dev A regular-session keeper restore of `x` into the cushion, then one hour before that day's close.
    function _restoreThenWindow(uint256 x) internal {
        _freeze();
        vm.warp(_nextRestoreMoment());
        _mockCanAddRisk("NVDA", true, SessionOracle.Reason.OK);
        vm.prank(keeper);
        acct.restore(x);
        vm.warp(_hourBeforeNextClose());
        moolah.accrueInterest(mp);
    }

    /// @dev Shield LTV half a point under where a 200 repay against a 1-collateral sale lands once the whole
    ///      cushion has gone on the debt.
    function _shieldAfterCushion() internal view returns (uint16) {
        (uint256 c, uint256 d) = acct.position();
        uint256 rest = d - acct.cushion();
        return uint16(acct.ltvBps() * (rest - 200e18) * c / (d * (c - 1e18)) + 50);
    }

    function _mandate(uint16 shield, bool autoRestore) internal pure returns (BallastAccountBase.Mandate memory) {
        return BallastAccountBase.Mandate(6000, shield, 150, autoRestore);
    }

    function _autoRestore() internal view returns (bool on) {
        (,,, on) = acct.mandate();
    }

    function test_keeperDeleverage_cushionEnough_repaysWithoutSale() public {
        _restoreThenWindow(100e18); // cushion 500, LTV ~49%
        uint16 shield = uint16(acct.ltvBps() * 8 / 10); // above the shield before, below it once the cushion is spent
        vm.prank(user);
        acct.setMandate(_mandate(shield, true));
        (, uint256 d0) = acct.position();
        uint256 cu = acct.cushion();

        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
        (uint256 c1, uint256 d1) = acct.position();
        assertApproxEqAbs(d1, d0 - cu, 1);
        assertEq(acct.cushion(), 0);
        assertEq(c1, 10e18); // nothing sold
        assertEq(acct.trackedCollateral(), 10e18);
        assertLe(acct.ltvBps(), shield);
        assertTrue(_autoRestore());
    }

    function test_keeperDeleverage_cushionShort_sellsAndHandsBackRestore() public {
        _restoreThenWindow(100e18); // cushion 500
        uint16 shield = _shieldAfterCushion(); // still above the shield after the cushion: a sale is needed
        vm.prank(user);
        acct.setMandate(_mandate(shield, true));
        (, uint256 d0) = acct.position();
        uint256 l0 = acct.ltvBps();

        vm.expectEmit(address(acct));
        emit BallastAccountBase.MandateSet(6000, shield, 150, false);
        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
        (, uint256 d1) = acct.position();
        assertApproxEqAbs(d1, d0 - 500e18 - 200e18, 1);
        assertEq(acct.trackedCollateral(), 9e18);
        assertLt(acct.ltvBps(), l0);
        assertFalse(_autoRestore());

        // Next session the keeper cannot borrow back until the owner turns auto-restore on again.
        vm.warp(_nextRestoreMoment());
        vm.prank(keeper);
        vm.expectRevert(BallastAccountBase.KeeperRestoreDisabled.selector);
        acct.restore(10e18);
        vm.prank(user);
        acct.setMandate(_mandate(shield, true));
        vm.prank(keeper);
        acct.restore(10e18);
    }

    /// @dev Anyone can send loan token to the account. It is just more cushion: the keeper spends it in the same
    ///      call and the shield goes ahead.
    function test_keeperDeleverage_donationIsSpentNotBlocking() public {
        _freeze();
        vm.warp(_hourBeforeNextClose());
        moolah.accrueInterest(mp);
        address griefer = address(0x6A1EF);
        _fund(usd1, griefer, 50e18);
        vm.prank(griefer);
        IERC20(usd1).transfer(address(acct), 50e18);
        assertEq(acct.cushion(), 450e18);
        uint16 shield = _shieldAfterCushion();
        vm.prank(user);
        acct.setMandate(_mandate(shield, true));
        (, uint256 d0) = acct.position();

        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
        (, uint256 d1) = acct.position();
        assertApproxEqAbs(d1, d0 - 450e18 - 200e18, 1);
        assertEq(acct.trackedCollateral(), 9e18);
        assertGe(acct.ltvBps() + 100, shield);
    }

    /// @dev The reported loop: every session the keeper restores up to the cap and shields before the close. With
    ///      the position under the owner's shield LTV once the cushion is back on the debt, every shield is a
    ///      pure repay: collateral never leaves the account and auto-restore stays on.
    function test_crossSessionRestoreLoop_onlyRepaysNeverSells() public {
        _freeze();
        _mockCanAddRisk("NVDA", true, SessionOracle.Reason.OK);
        (uint256 vc0,) = acct.position(); // default mandate: cap 60%, shield 50%, LTV ~44%
        for (uint256 i; i < 3; ++i) {
            vm.warp(_nextRestoreMoment());
            (, uint256 d) = acct.position();
            uint256 l = acct.ltvBps();
            uint256 x = d * (5900 - l) / l; // up to about 59% against a 60% cap
            vm.prank(keeper);
            acct.restore(x);
            assertGt(acct.ltvBps(), 5000);

            vm.warp(_hourBeforeNextClose());
            vm.prank(keeper);
            acct.shieldDeleverage(200e18, 1e18, _path(), 0);
            (uint256 vc,) = acct.position();
            assertEq(vc, vc0);
            assertEq(acct.trackedCollateral(), vc0);
            assertEq(acct.cushion(), 0);
            assertLe(acct.ltvBps(), 5000);
            assertTrue(_autoRestore());
        }
    }

    /// @dev Cushion = debt - 5 would leave 5 (< the ~15 minimum loan): repay down to one wei above the minimum
    ///      and keep the rest as cushion.
    function test_keeperDeleverage_minLoanEdge_repaysDownToMinimum() public {
        _freeze();
        vm.warp(_hourBeforeNextClose());
        moolah.accrueInterest(mp);
        (, uint256 d) = acct.position();
        uint256 ml = moolah.minLoan(mp);
        uint256 top = d - 5e18 - acct.cushion();
        vm.prank(user);
        acct.depositCushion(top);
        uint256 cu = acct.cushion();
        assertEq(cu, d - 5e18);
        uint16 shield = uint16(acct.ltvBps() * 9 / 10);
        vm.prank(user);
        acct.setMandate(_mandate(shield, true));

        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
        (uint256 c1, uint256 d1) = acct.position();
        assertGe(d1, ml + 1);
        assertLe(d1, ml + 2);
        assertEq(acct.cushion(), cu - (d - ml - 1));
        assertEq(c1, 10e18);
        assertTrue(_autoRestore());
    }

    function test_keeperDeleverage_cushionCoversDebt_closesByShares() public {
        _freeze();
        vm.warp(_hourBeforeNextClose());
        vm.prank(user);
        acct.depositCushion(700e18); // cushion 1100 > debt ~1000
        uint16 shield = uint16(acct.ltvBps() * 9 / 10);
        vm.prank(user);
        acct.setMandate(_mandate(shield, true));

        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
        (uint256 c1, uint256 d1) = acct.position();
        assertEq(d1, 0);
        assertEq(c1, 10e18);
        assertGt(acct.cushion(), 90e18); // only the real debt was pulled
        assertTrue(_autoRestore());
    }

    /// @dev A flash that covers the whole debt closes it by shares. Repaying by assets above the debt would revert.
    function test_flashFullClose_repaysByShares() public {
        _freeze();
        vm.warp(_hourBeforeNextClose());
        vm.startPrank(user);
        acct.depositCushion(450e18);
        acct.repay(850e18); // debt ~150, cushion 0
        acct.setMandate(_mandate(50, true)); // a 0.5% shield LTV lets a full close pass the landing bound
        vm.stopPrank();
        moolah.accrueInterest(mp);
        (, uint256 d0) = acct.position();
        assertEq(acct.cushion(), 0);
        assertGt(d0, 140e18);
        assertLt(d0, 200e18);

        vm.prank(keeper);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0); // flash 200 > debt
        (uint256 c1, uint256 d1) = acct.position();
        assertEq(d1, 0);
        assertEq(c1, 9e18);
        assertEq(acct.trackedCollateral(), 9e18);
        assertGt(acct.cushion(), 0); // the flash surplus and swap proceeds stay as cushion
        assertFalse(_autoRestore());
    }

    function test_ownerDeleverage_keepsCushionAndAutoRestore() public {
        _freeze();
        vm.warp(_hourBeforeNextClose());
        uint256 l0 = acct.ltvBps();
        vm.prank(user);
        acct.setMandate(_mandate(uint16(l0 * 8 / 9 + 50), true));
        uint256 cushion0 = acct.cushion();
        assertEq(cushion0, 400e18);

        vm.recordLogs();
        vm.prank(user);
        acct.shieldDeleverage(200e18, 1e18, _path(), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(acct)) assertTrue(logs[i].topics[0] != BallastAccountBase.MandateSet.selector);
        }
        assertLt(acct.ltvBps(), l0);
        assertGt(acct.cushion(), cushion0); // the owner's call does not spend the cushion
        assertTrue(_autoRestore());
    }

    // -------------------------------------------------------------- restore

    function test_restore_refusedOnWeekend_andMovesNothing() public {
        _freeze();
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
        vm.expectPartialRevert(BallastAccountBase.ExceedsMandate.selector); // pushes LTV above 60%
        acct.restore(600e18);
    }

    function test_restore_keeperNeedsAutoRestore() public {
        vm.prank(user);
        acct.setMandate(BallastAccountBase.Mandate(6000, 5000, 150, false));
        _mockCanAddRisk("NVDA", true, SessionOracle.Reason.OK);
        vm.prank(keeper);
        vm.expectRevert(BallastAccountBase.KeeperRestoreDisabled.selector);
        acct.restore(100e18);
    }

    // ------------------------------------------------------- owner and rescue

    function test_ownerCanAlwaysExit() public {
        vm.startPrank(user);
        acct.depositCushion(700e18); // 1100 in cushion
        acct.repayAll();
        (uint256 c, uint256 d) = acct.position();
        assertEq(d, 0);
        acct.withdrawCollateral(c, user);
        assertEq(acct.trackedCollateral(), 0);
        uint256 left = acct.cushion();
        assertGt(left, 90e18);
        acct.withdrawCushion(left, user);
        vm.stopPrank();
        assertEq(IERC20(nvdab).balanceOf(user), 10e18);
        assertEq(acct.cushion(), 0);
    }

    function test_donatedCollateralDoesNotBreakExit() public {
        address donor = address(0xD0);
        _fund(nvdab, donor, 1e18);
        vm.startPrank(donor);
        IERC20(nvdab).approve(address(moolah), 1e18);
        moolah.supplyCollateral(mp, 1e18, address(acct), "");
        vm.stopPrank();
        assertFalse(acct.liquidated()); // more at the venue than tracked is not a liquidation
        vm.startPrank(user);
        acct.depositCushion(700e18);
        acct.repayAll();
        acct.withdrawCollateral(11e18, user); // tracked 10 minus 11 clamps at zero
        vm.stopPrank();
        assertEq(acct.trackedCollateral(), 0);
    }

    function test_rescue_ownerOnly_sendsStrayTokens() public {
        _fund(spyb, address(acct), 1e18);
        vm.prank(user);
        acct.rescue(spyb, user, 1e18);
        assertEq(IERC20(spyb).balanceOf(user), 1e18);
    }

    // --------------------------------------------------------- liquidation

    function test_liquidationIsDetected() public {
        address[] memory t = new address[](1);
        t[0] = usd1;
        _freezePrices(t);
        uint256 p = IPriceSourceLike(stockOracle).peek(nvdab);
        uint256 l0 = acct.ltvBps();
        uint256 target = mp.lltv / 1e14 + 500; // 5 points above the liquidation threshold
        _setPrice(nvdab, p * l0 / target);
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

        // Masking attempt: anyone records it, then a donor tops venue collateral back up to the tracked amount.
        vm.prank(address(0xCAFE));
        acct.recordLiquidation();
        assertTrue(acct.liquidationRecorded());
        (uint256 c,) = acct.position();
        uint256 gap = acct.trackedCollateral() - c;
        address donor = address(0xD0);
        _fund(nvdab, donor, gap);
        vm.startPrank(donor);
        IERC20(nvdab).approve(address(moolah), gap);
        moolah.supplyCollateral(mp, gap, address(acct), "");
        vm.stopPrank();
        (c,) = acct.position();
        assertGe(c, acct.trackedCollateral());
        assertTrue(acct.liquidated()); // still true: the flag is sticky
    }

    /// @dev Mid-flash the venue briefly holds less collateral than tracked; recording that as a seizure from inside
    ///      the swap must be refused. A pass-through router makes the reentrant call during a real deleverage.
    function test_recordLiquidation_refusedDuringFlash() public {
        ReentrantRouter rr = new ReentrantRouter(IPcsV3SwapRouter(router));
        BallastFactory f2 = new BallastFactory(
            sOracle, moolah, IPcsV3SwapRouter(address(rr)),
            IComptroller(cfg.readAddress(".venus.comptroller")), IVenusOracle(cfg.readAddress(".venus.oracle"))
        );
        _fund(nvdab, user, 10e18);
        vm.startPrank(user);
        ListaAccount a = ListaAccount(f2.createListaAccount(mp, "NVDA", keeper, _mandate(5000, true)));
        IERC20(nvdab).approve(address(a), type(uint256).max);
        a.depositCollateral(10e18);
        a.borrow(1000e18, user);
        a.setDeleveragePath(_path());
        vm.stopPrank();
        _freeze();
        vm.warp(_hourBeforeNextClose());
        uint16 shield = uint16(a.ltvBps() * 8 / 9 + 50);
        vm.prank(user);
        a.setMandate(_mandate(shield, true));

        vm.prank(keeper);
        a.shieldDeleverage(200e18, 1e18, _path(), 0);
        assertTrue(rr.called());
        assertEq(rr.reentryError(), abi.encodeWithSelector(BallastAccountBase.Locked.selector));
        assertFalse(a.liquidationRecorded());
        assertFalse(a.liquidated());
        assertEq(a.trackedCollateral(), 9e18);
    }

    function test_recordLiquidation_revertsWhenHealthy() public {
        vm.expectRevert(BallastAccountBase.NotLiquidated.selector);
        acct.recordLiquidation();
        assertFalse(acct.liquidated());
    }
}

interface IPriceSourceLike {
    function peek(address) external view returns (uint256);
}

/// @dev Forwards a swap to the real router, but first tries to latch a liquidation on the calling account.
contract ReentrantRouter {
    IPcsV3SwapRouter public immutable real;
    bool public called;
    bytes public reentryError;

    constructor(IPcsV3SwapRouter real_) {
        real = real_;
    }

    function exactInput(IPcsV3SwapRouter.ExactInputParams calldata p) external payable returns (uint256) {
        called = true;
        try BallastAccountBase(msg.sender).recordLiquidation() {
            reentryError = "";
        } catch (bytes memory err) {
            reentryError = err;
        }
        IERC20 tokenIn = IERC20(address(bytes20(p.path[0:20])));
        tokenIn.transferFrom(msg.sender, address(this), p.amountIn);
        tokenIn.approve(address(real), p.amountIn);
        return real.exactInput(p);
    }
}
