// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";
import {SessionOracle} from "../src/SessionOracle.sol";
import {IPriceSource, IOndoSharesOracle} from "../src/interfaces/External.sol";
import {MockPriceSource, MockAggregator, MockBStock, MockOndoShares, MockBacked} from "./mocks/Mocks.sol";

contract SessionOracleTest is Test {
    uint256 constant WED_1545 = 1790783100; // Wed 2026-09-30 11:45 EDT (restore window)
    uint256 constant WED_1400 = 1790776800; // 10:00 EDT (too soon after open)
    uint256 constant WED_1730 = 1790789400; // 13:30 EDT (close within 3h)
    uint256 constant SAT_1500 = 1790434800; // Sat 2026-09-26 11:00 EDT
    uint256 constant THU_OPEN = 1790861400; // Thu 2026-10-01 09:30 EDT
    bytes32 constant NVDA = "NVDA";
    bytes32 constant CRCL = "CRCL";

    SessionCalendar cal;
    SessionOracle oracle;
    MockPriceSource src;
    MockAggregator cl;
    MockBStock bNvda;
    MockBStock bCrcl;
    MockOndoShares ondoShares;
    MockBacked xNvda;
    address ondoNvda = address(0x0D0);
    address publisher = address(0xB0B);

    function _params() internal pure returns (SessionOracle.Params memory) {
        return SessionOracle.Params({
            restoreDelay: 5400,
            horizon: 10800,
            convergenceBps: 60,
            maxRefAge: 93600,
            maxOverlayTtl: 21600,
            maxOndoDriftBps: 100,
            maxRefDeviationBps: 300
        });
    }

    function setUp() public {
        vm.warp(WED_1545);
        cal = new SessionCalendar();
        src = new MockPriceSource();
        cl = new MockAggregator();
        bNvda = new MockBStock();
        bCrcl = new MockBStock();
        ondoShares = new MockOndoShares();
        xNvda = new MockBacked();
        oracle = new SessionOracle(address(this), cal, IPriceSource(address(src)), IOndoSharesOracle(address(ondoShares)), _params());
        oracle.setPublisher(publisher, 7);

        bNvda.setUiMultiplier(1.000778e18);
        oracle.listTicker(NVDA, SessionOracle.Ticker({
            bStock: address(bNvda), ondo: ondoNvda, xStock: address(xNvda), chainlink: address(cl),
            gapOvernightBps: 417, gapWeekendBps: 737, gapHolidayBps: 450, gapEarningsBps: 502, listed: true
        }));
        oracle.listTicker(CRCL, SessionOracle.Ticker({
            bStock: address(bCrcl), ondo: address(0), xStock: address(0), chainlink: address(0),
            gapOvernightBps: 513, gapWeekendBps: 466, gapHolidayBps: 357, gapEarningsBps: 447, listed: true
        }));
        cl.set(225e8, block.timestamp - 600);
        src.set(address(bNvda), 225e8 * 1.000778e18 / 1e18); // raw token price
        src.set(address(bCrcl), 93e8);
        ondoShares.set(ondoNvda, 1.000932e18);
        _post(NVDA, 0, 0, 0, 0);
    }

    function _post(bytes32 sym, uint64 nextEarnings, uint8 flags, uint128 ondoMult, uint128 ref) internal {
        bytes32[] memory syms = new bytes32[](1);
        syms[0] = sym;
        SessionOracle.Overlay[] memory o = new SessionOracle.Overlay[](1);
        o[0] = SessionOracle.Overlay({
            validUntil: uint64(block.timestamp + 3600), nextEarnings: nextEarnings, flags: flags,
            ondoMultiplier: ondoMult, referencePrice: ref, postedAt: 0
        });
        vm.prank(publisher);
        oracle.postOverlays(syms, o);
    }

    function _reason() internal view returns (SessionOracle.Reason r) {
        (, r) = oracle.canAddRisk(NVDA);
    }

    function test_perSharePrice_normalisesUiMultiplier() public view {
        (uint256 ps, bool ok) = oracle.perSharePrice(NVDA);
        assertTrue(ok);
        assertApproxEqAbs(ps, 225e8, 1);
    }

    function test_canAddRisk_okInsideRestoreWindow() public view {
        (bool ok, SessionOracle.Reason r) = oracle.canAddRisk(NVDA);
        assertTrue(ok);
        assertEq(uint8(r), uint8(SessionOracle.Reason.OK));
    }

    function test_canAddRisk_refusedOnWeekend() public {
        vm.warp(SAT_1500);
        cl.set(225e8, block.timestamp - 600);
        _post(NVDA, 0, 0, 0, 0);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.NOT_REGULAR));
    }

    function test_canAddRisk_refusedTooSoonAfterOpen() public {
        vm.warp(WED_1400);
        cl.set(225e8, block.timestamp - 600);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.TOO_SOON_AFTER_OPEN));
    }

    function test_canAddRisk_refusedWhenCloseWithinHorizon() public {
        vm.warp(WED_1730);
        _post(NVDA, 0, 0, 0, 0);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.WINDOW_AHEAD));
    }

    function test_canAddRisk_refusedWhenOverlayStale() public {
        vm.warp(WED_1545 + 3601);
        cl.set(225e8, block.timestamp - 600);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.OVERLAY_STALE));
    }

    function test_canAddRisk_refusedWhenFlagged() public {
        _post(NVDA, 0, oracle.FLAG_HALTED(), 0, 0);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.FLAGGED));
    }

    function test_canAddRisk_refusedWhenNotConverged() public {
        src.set(address(bNvda), 227.25e8 * 1.000778e18 / 1e18); // +100 bps per share
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.NOT_CONVERGED));
    }

    function test_canAddRisk_refusedWhenReferenceStale() public {
        cl.set(225e8, block.timestamp - 27 hours);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.REFERENCE_STALE));
    }

    function test_canAddRisk_refusedWhenPriceUnavailable() public {
        src.breakAsset(address(bNvda));
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.PRICE_UNAVAILABLE));
    }

    function test_canAddRisk_refusedOutsideCalendar() public {
        vm.warp(1830524400);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.CALENDAR_UNKNOWN));
    }

    function test_canAddRisk_unknownTicker() public view {
        (bool ok, SessionOracle.Reason r) = oracle.canAddRisk("NOPE");
        assertFalse(ok);
        assertEq(uint8(r), uint8(SessionOracle.Reason.UNKNOWN_TICKER));
    }

    function test_windowAhead_earningsUsesLargerGap() public {
        _post(NVDA, uint64(THU_OPEN), 0, 0, 0);
        (SessionOracle.RiskWindow w, uint64 s, uint64 e, uint16 gap) = oracle.windowAhead(NVDA);
        assertEq(uint8(w), uint8(SessionOracle.RiskWindow.EARNINGS));
        assertEq(s, 1790798400); // Wed 16:00 EDT
        assertEq(e, THU_OPEN);
        assertEq(gap, 502);
    }

    function test_currentWindow_weekendGap() public {
        vm.warp(SAT_1500);
        cl.set(225e8, block.timestamp - 600);
        (SessionOracle.RiskWindow w, uint16 gap, uint256 closedAt) = oracle.currentWindow(NVDA);
        assertEq(uint8(w), uint8(SessionOracle.RiskWindow.WEEKEND));
        assertEq(gap, 737);
        assertEq(closedAt, 1790366400);
    }

    function test_post_rejectsNonPublisher() public {
        bytes32[] memory syms = new bytes32[](1);
        syms[0] = NVDA;
        SessionOracle.Overlay[] memory o = new SessionOracle.Overlay[](1);
        o[0].validUntil = uint64(block.timestamp + 60);
        vm.expectRevert(SessionOracle.NotPublisher.selector);
        oracle.postOverlays(syms, o);
    }

    function test_post_rejectsTooLongValidity() public {
        bytes32[] memory syms = new bytes32[](1);
        syms[0] = NVDA;
        SessionOracle.Overlay[] memory o = new SessionOracle.Overlay[](1);
        o[0].validUntil = uint64(block.timestamp + 21601);
        vm.prank(publisher);
        vm.expectRevert(SessionOracle.BadValidity.selector);
        oracle.postOverlays(syms, o);
    }

    function test_post_ondoMultiplierBounds() public {
        vm.expectRevert(abi.encodeWithSelector(SessionOracle.OndoMultiplierOutOfBounds.selector, uint256(1.0009e18), uint256(1.000932e18)));
        this.postExternal(NVDA, 0, 0, 1.0009e18, 0); // below on-chain sValue
        vm.expectRevert(abi.encodeWithSelector(SessionOracle.OndoMultiplierOutOfBounds.selector, uint256(1.0115e18), uint256(1.000932e18)));
        this.postExternal(NVDA, 0, 0, 1.0115e18, 0); // above +100 bps drift
        _post(NVDA, 0, 0, 1.001715e18, 0); // live multiplier inside the band
        (uint256 m, bool stale) = oracle.sharesPerToken(NVDA, SessionOracle.Issuer.ONDO);
        assertEq(m, 1.001715e18);
        assertFalse(stale);
    }

    function test_post_referenceOnlyForTickersWithoutChainlink() public {
        vm.expectRevert(SessionOracle.ReferenceNotAllowed.selector);
        this.postExternal(NVDA, 0, 0, 0, 225e8);
        vm.expectRevert(abi.encodeWithSelector(SessionOracle.ReferenceOutOfBounds.selector, uint256(100e8), uint256(93e8)));
        this.postExternal(CRCL, 0, 0, 0, 100e8); // +7.5% vs on-chain per-share
        _post(CRCL, 0, 0, 0, 93.2e8);
        (uint256 ref,, bool ok) = oracle.referenceFor(CRCL);
        assertTrue(ok);
        assertEq(ref, 93.2e8);
    }

    function test_sharesPerToken_fallsBackToStaleOnchainOndo() public view {
        (uint256 m, bool stale) = oracle.sharesPerToken(NVDA, SessionOracle.Issuer.ONDO);
        assertEq(m, 1.000932e18);
        assertTrue(stale);
        (m, stale) = oracle.sharesPerToken(NVDA, SessionOracle.Issuer.BSTOCK);
        assertEq(m, 1.000778e18);
        assertFalse(stale);
    }

    function test_canAddRisk_neverPostedOverlay_isStale() public view {
        (bool ok, SessionOracle.Reason r) = oracle.canAddRisk(CRCL);
        assertFalse(ok);
        assertEq(uint8(r), uint8(SessionOracle.Reason.OVERLAY_STALE));
    }

    function test_canAddRisk_futureChainlinkReference_isStale() public {
        cl.set(225e8, block.timestamp + 100);
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.REFERENCE_STALE));
    }

    function test_canAddRisk_failsClosedAtTableEnd() public {
        vm.warp(1830279600); // Fri 2027-12-31 14:00 EST, regular session, no closure inside the table
        cl.set(225e8, block.timestamp - 600);
        _post(NVDA, 0, 0, 0, 0);
        assertEq(uint8(cal.session(block.timestamp)), uint8(SessionCalendar.Session.REGULAR));
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.CALENDAR_UNKNOWN));
    }

    function test_canAddRisk_uiMultiplierRevert_isPriceUnavailable() public {
        vm.mockCallRevert(address(bNvda), abi.encodeWithSignature("uiMultiplier()"), "boom");
        assertEq(uint8(_reason()), uint8(SessionOracle.Reason.PRICE_UNAVAILABLE));
    }

    function test_reference_survivesOverlayExpiry() public {
        _post(CRCL, 0, 0, 0, 93.2e8);
        uint256 postedAt = block.timestamp;
        vm.warp(block.timestamp + 3601); // overlay expired
        (uint256 ref, uint256 upd, bool ok) = oracle.referenceFor(CRCL);
        assertTrue(ok);
        assertEq(ref, 93.2e8);
        assertEq(upd, postedAt);
    }

    function test_reference_zeroPostKeepsLast() public {
        _post(CRCL, 0, 0, 0, 93.2e8);
        _post(CRCL, 0, 0, 0, 0);
        (uint256 ref,, bool ok) = oracle.referenceFor(CRCL);
        assertTrue(ok);
        assertEq(ref, 93.2e8);
    }

    function test_reference_postRejectedOutsideRegularSession() public {
        vm.warp(SAT_1500);
        vm.expectRevert(SessionOracle.ReferenceNotAllowed.selector);
        this.postExternal(CRCL, 0, 0, 0, 93.2e8);
    }

    function test_earningsUpgrade_persistsAfterOverlayExpiry() public {
        _post(NVDA, uint64(THU_OPEN), 0, 0, 0);
        vm.warp(block.timestamp + 3601); // overlay expired
        cl.set(225e8, block.timestamp - 600);
        (SessionOracle.RiskWindow w,,, uint16 gap) = oracle.windowAhead(NVDA);
        assertEq(uint8(w), uint8(SessionOracle.RiskWindow.EARNINGS));
        assertEq(gap, 502);
    }

    function test_sharesPerToken_unlistedAndBrokenNeverRevert() public {
        (uint256 m, bool stale) = oracle.sharesPerToken("NOPE", SessionOracle.Issuer.BSTOCK);
        assertEq(m, 0);
        assertTrue(stale);
        vm.mockCallRevert(address(bNvda), abi.encodeWithSignature("uiMultiplier()"), "boom");
        (m, stale) = oracle.sharesPerToken(NVDA, SessionOracle.Issuer.BSTOCK);
        assertEq(m, 0);
        assertTrue(stale);
    }

    function test_sharesPerToken_ondoPausedIsStale() public {
        _post(NVDA, 0, 0, 1.001715e18, 0);
        vm.mockCall(
            address(ondoShares), abi.encodeCall(IOndoSharesOracle.getSValue, (ondoNvda)), abi.encode(uint128(1.000932e18), true)
        );
        (uint256 m, bool stale) = oracle.sharesPerToken(NVDA, SessionOracle.Issuer.ONDO);
        assertEq(m, 1.001715e18);
        assertTrue(stale);
    }

    function postExternal(bytes32 sym, uint64 e, uint8 f, uint128 om, uint128 ref) external {
        bytes32[] memory syms = new bytes32[](1);
        syms[0] = sym;
        SessionOracle.Overlay[] memory o = new SessionOracle.Overlay[](1);
        o[0] = SessionOracle.Overlay({validUntil: uint64(block.timestamp + 3600), nextEarnings: e, flags: f, ondoMultiplier: om, referencePrice: ref, postedAt: 0});
        vm.prank(publisher);
        oracle.postOverlays(syms, o);
    }
}
