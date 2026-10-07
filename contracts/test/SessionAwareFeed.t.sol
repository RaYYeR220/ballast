// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";
import {SessionOracle} from "../src/SessionOracle.sol";
import {SessionAwareFeed} from "../src/SessionAwareFeed.sol";
import {IPriceSource, IOndoSharesOracle} from "../src/interfaces/External.sol";
import {MockPriceSource, MockAggregator, MockBStock, MockOndoShares} from "./mocks/Mocks.sol";

contract SessionAwareFeedTest is Test {
    uint256 constant FRI_CLOSE = 1790366400; // 2026-09-25 16:00 EDT
    uint256 constant SAT_0800Z = 1790409600; // 12 h after the close
    uint256 constant MON_0800Z = 1790582400; // 60 h after the close (pre-market Monday 04:00 EDT)
    uint256 constant WED_1545 = 1790783100;
    bytes32 constant NVDA = "NVDA";

    SessionOracle oracle;
    SessionAwareFeed feed;
    MockPriceSource up;
    MockAggregator cl;
    MockBStock b;
    address stable = address(0x5AB1E);

    function setUp() public {
        vm.warp(FRI_CLOSE - 60);
        SessionCalendar cal = new SessionCalendar();
        up = new MockPriceSource();
        cl = new MockAggregator();
        b = new MockBStock();
        oracle = new SessionOracle(
            address(this), cal, IPriceSource(address(up)), IOndoSharesOracle(address(new MockOndoShares())),
            SessionOracle.Params(5400, 10800, 60, 93600, 21600, 100, 300)
        );
        oracle.listTicker(NVDA, SessionOracle.Ticker(address(b), address(0), address(0), address(cl), 417, 737, 450, 502, true));
        feed = new SessionAwareFeed(address(this), oracle, IPriceSource(address(up)));
        feed.mapAsset(address(b), NVDA);
        cl.set(225e8, FRI_CLOSE - 60); // Friday's last print
        up.set(address(b), 225e8);
        up.set(stable, 0.9998e8);
    }

    function test_regularSession_passesThrough() public {
        vm.warp(WED_1545);
        cl.set(225e8, block.timestamp - 60);
        up.set(address(b), 180e8);
        assertEq(feed.peek(address(b)), 180e8);
    }

    function test_weekend_moveInsideBand_passesThrough() public {
        vm.warp(SAT_0800Z);
        up.set(address(b), 213.75e8); // -5%
        assertEq(feed.peek(address(b)), 213.75e8);
    }

    function test_weekend_wickBeyondBand_isClamped() public {
        vm.warp(SAT_0800Z);
        up.set(address(b), 180e8); // -20%
        (uint256 lo,, uint256 bandBps, bool ok) = feed.band(NVDA);
        assertTrue(ok);
        assertEq(bandBps, uint256(737) + uint256(737) * 12 / 24);
        assertEq(feed.peek(address(b)), lo);
        assertEq(lo, 225e8 * (10_000 - bandBps) / 10_000);
        up.set(address(b), 260e8); // +15.5%
        (, uint256 hi,,) = feed.band(NVDA);
        assertEq(feed.peek(address(b)), hi);
    }

    function test_band_capsAtThreeTimesBase() public {
        vm.warp(MON_0800Z);
        (,, uint256 bandBps,) = feed.band(NVDA);
        assertEq(bandBps, 737 * 3);
    }

    function test_unmappedAsset_passesThrough() public {
        vm.warp(SAT_0800Z);
        assertEq(feed.peek(stable), 0.9998e8);
    }

    function test_staleReference_degradesToUpstream() public {
        vm.warp(SAT_0800Z);
        cl.set(225e8, FRI_CLOSE - 27 hours - 93600);
        up.set(address(b), 180e8);
        assertEq(feed.peek(address(b)), 180e8);
    }

    function test_upstreamRevert_propagates() public {
        vm.warp(SAT_0800Z);
        up.breakAsset(address(b));
        vm.expectRevert(bytes("stale"));
        feed.peek(address(b));
    }

    function test_anchorUsesUiMultiplier() public {
        vm.warp(SAT_0800Z);
        b.setUiMultiplier(1.01e18);
        (uint256 lo, uint256 hi, uint256 bandBps,) = feed.band(NVDA);
        uint256 anchor = 225e8 * 1.01e18 / 1e18;
        assertEq(lo, anchor * (10_000 - bandBps) / 10_000);
        assertEq(hi, anchor * (10_000 + bandBps) / 10_000);
    }

    bytes32 constant CRCL = "CRCL";

    function _listCrcl() internal returns (MockBStock bc) {
        bc = new MockBStock();
        oracle.listTicker(CRCL, SessionOracle.Ticker(address(bc), address(0), address(0), address(0), 513, 466, 357, 447, true));
        feed.mapAsset(address(bc), CRCL);
        oracle.setPublisher(address(this), 7);
        up.set(address(bc), 93e8);
        bytes32[] memory syms = new bytes32[](1);
        syms[0] = CRCL;
        SessionOracle.Overlay[] memory o = new SessionOracle.Overlay[](1);
        o[0] = SessionOracle.Overlay(uint64(block.timestamp + 3600), 0, 0, 0, 93.2e8, 0);
        oracle.postOverlays(syms, o); // regular session, the reference persists past the overlay
    }

    function test_noChainlinkTicker_holdsBandAcrossWeekend() public {
        MockBStock bc = _listCrcl();
        vm.warp(SAT_0800Z);
        up.set(address(bc), 70e8);
        (uint256 lo,, uint256 bandBps, bool ok) = feed.band(CRCL);
        assertTrue(ok);
        assertEq(bandBps, uint256(466) + uint256(466) * 12 / 24);
        assertEq(lo, 93.2e8 * (10_000 - bandBps) / 10_000);
        assertEq(feed.peek(address(bc)), lo);
    }

    function test_holidayClosure_usesHolidayGap() public {
        uint256 close = 1788552000; // Fri 2026-09-04 16:00 EDT, Labor Day weekend follows
        vm.warp(close + 12 hours);
        cl.set(225e8, close - 60);
        up.set(address(b), 180e8);
        (uint256 lo,, uint256 bandBps, bool ok) = feed.band(NVDA);
        assertTrue(ok);
        assertEq(bandBps, uint256(450) + uint256(450) * 12 / 24);
        assertEq(feed.peek(address(b)), lo);
    }

    function test_earlyCloseDay_bandStartsAtThe1pmClose() public {
        uint256 close = 1795802400; // Fri 2026-11-27 13:00 EST
        vm.warp(close + 1 hours);
        cl.set(225e8, close - 60);
        up.set(address(b), 150e8);
        (uint256 lo,, uint256 bandBps, bool ok) = feed.band(NVDA);
        assertTrue(ok);
        assertEq(bandBps, uint256(737) + uint256(737) * 1 hours / 1 days);
        assertEq(feed.peek(address(b)), lo);
    }

    function test_earningsOverlay_bandUsesEarningsGap() public {
        oracle.setPublisher(address(this), 7);
        vm.warp(WED_1545);
        cl.set(225e8, block.timestamp - 60);
        bytes32[] memory syms = new bytes32[](1);
        syms[0] = NVDA;
        SessionOracle.Overlay[] memory o = new SessionOracle.Overlay[](1);
        o[0] = SessionOracle.Overlay(uint64(block.timestamp + 3600), 1790861400, 0, 0, 0, 0); // Thu open
        oracle.postOverlays(syms, o);
        uint256 close = 1790798400; // Wed 16:00 EDT
        vm.warp(close + 2 hours);
        cl.set(225e8, close - 60);
        up.set(address(b), 150e8);
        (uint256 lo,, uint256 bandBps, bool ok) = feed.band(NVDA);
        assertTrue(ok);
        assertEq(bandBps, uint256(502) + uint256(502) * 2 hours / 1 days); // earnings 502 beats overnight 417
        assertEq(feed.peek(address(b)), lo);
    }

    function test_uiMultiplierRevert_degradesToUpstream() public {
        vm.warp(SAT_0800Z);
        up.set(address(b), 180e8);
        vm.mockCallRevert(address(b), abi.encodeWithSignature("uiMultiplier()"), "boom");
        (,,, bool ok) = feed.band(NVDA);
        assertFalse(ok);
        assertEq(feed.peek(address(b)), 180e8);
    }
}
