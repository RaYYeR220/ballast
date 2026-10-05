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
}
