// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SessionCalendar} from "../src/SessionCalendar.sol";

contract SessionCalendarTest is Test {
    SessionCalendar cal;

    function setUp() public {
        cal = new SessionCalendar();
    }

    function _s(uint256 ts) internal view returns (SessionCalendar.Session) {
        return cal.session(ts);
    }

    function test_sessions_ordinaryFriday() public view {
        assertEq(uint8(_s(1790341200)), uint8(SessionCalendar.Session.PRE)); // Fri 2026-09-25 09:00 EDT
        assertEq(uint8(_s(1790344800)), uint8(SessionCalendar.Session.REGULAR)); // 10:00 EDT
        assertEq(uint8(_s(1790368200)), uint8(SessionCalendar.Session.POST)); // 16:30 EDT
        assertEq(uint8(_s(1790382600)), uint8(SessionCalendar.Session.CLOSED_WEEKEND)); // Fri 20:30 EDT
    }

    function test_sessions_weekendAndSundayOvernight() public view {
        assertEq(uint8(_s(1790434800)), uint8(SessionCalendar.Session.CLOSED_WEEKEND)); // Sat 11:00 EDT
        assertEq(uint8(_s(1790551800)), uint8(SessionCalendar.Session.CLOSED_WEEKEND)); // Sun 19:30 EDT
        assertEq(uint8(_s(1790555400)), uint8(SessionCalendar.Session.OVERNIGHT)); // Sun 20:30 EDT
        assertEq(uint8(_s(1790578800)), uint8(SessionCalendar.Session.OVERNIGHT)); // Mon 03:00 EDT
    }

    function test_sessions_holidayMonday() public view {
        assertEq(uint8(_s(1788793200)), uint8(SessionCalendar.Session.CLOSED_HOLIDAY)); // Labor Day 11:00 EDT
        assertEq(uint8(_s(1788741000)), uint8(SessionCalendar.Session.CLOSED_WEEKEND)); // Sun 20:30 EDT before holiday
        assertEq(uint8(_s(1788827400)), uint8(SessionCalendar.Session.OVERNIGHT)); // holiday 20:30 EDT, Tue trades
        assertEq(uint8(_s(1795708800)), uint8(SessionCalendar.Session.CLOSED_HOLIDAY)); // Thanksgiving 11:00 EST
    }

    function test_sessions_earlyClose() public view {
        assertEq(uint8(_s(1795800600)), uint8(SessionCalendar.Session.REGULAR)); // Fri 2026-11-27 12:30 EST
        assertEq(uint8(_s(1795804200)), uint8(SessionCalendar.Session.POST)); // 13:30 EST
    }

    function test_sessions_dstChange() public view {
        assertEq(uint8(_s(1793367900)), uint8(SessionCalendar.Session.REGULAR)); // Fri 2026-10-30 09:45 EDT
        assertEq(uint8(_s(1793630700)), uint8(SessionCalendar.Session.REGULAR)); // Mon 2026-11-02 09:45 EST
        assertEq(uint8(_s(1793628900)), uint8(SessionCalendar.Session.PRE)); // Mon 2026-11-02 09:15 EST
    }

    function test_sessions_outsideTable() public view {
        assertEq(uint8(_s(1767182400)), uint8(SessionCalendar.Session.UNKNOWN)); // 2025-12-31
        assertEq(uint8(_s(1830524400)), uint8(SessionCalendar.Session.UNKNOWN)); // 2028-01-03
        assertEq(cal.nextOpen(1830524400), 0);
        assertEq(cal.prevClose(1767182400), 0);
    }

    function test_boundaries() public view {
        assertEq(cal.nextClose(1790344800), 1790366400); // Fri 16:00 EDT
        assertEq(cal.nextOpen(1790434800), 1790602200); // Mon 09:30 EDT
        assertEq(cal.nextClose(1795791600), 1795802400); // early close 13:00 EST
        assertEq(cal.nextOpen(1795806000), 1796049000); // Mon 2026-11-30 09:30 EST
        assertEq(cal.prevClose(1790434800), 1790366400); // Sat -> Fri close
        assertEq(cal.prevClose(1788868800), 1788552000); // Tue 08:00 EDT after Labor Day -> Fri Sep 4 close
    }

    function test_windowAfter() public view {
        assertEq(uint8(cal.windowAfter(20721)), uint8(SessionCalendar.WindowType.WEEKEND)); // Fri 09-25
        assertEq(uint8(cal.windowAfter(20720)), uint8(SessionCalendar.WindowType.OVERNIGHT)); // Thu 09-24
        assertEq(uint8(cal.windowAfter(20700)), uint8(SessionCalendar.WindowType.HOLIDAY)); // Fri before Labor Day
        assertEq(uint8(cal.windowAfter(20782)), uint8(SessionCalendar.WindowType.HOLIDAY)); // Wed before Thanksgiving
        assertEq(uint8(cal.windowAfter(20545)), uint8(SessionCalendar.WindowType.HOLIDAY)); // Thu before Good Friday
        assertEq(uint8(cal.windowAfter(20784)), uint8(SessionCalendar.WindowType.WEEKEND)); // early-close Fri
        assertEq(uint8(cal.windowAfter(20454)), uint8(SessionCalendar.WindowType.NONE)); // holiday itself
    }

    function test_nextAndCurrentWindow() public view {
        (SessionCalendar.WindowType w, uint256 s, uint256 e) = cal.nextWindow(1790344800);
        assertEq(uint8(w), uint8(SessionCalendar.WindowType.WEEKEND));
        assertEq(s, 1790366400);
        assertEq(e, 1790602200);
        (w, s, e) = cal.currentWindow(1790434800);
        assertEq(uint8(w), uint8(SessionCalendar.WindowType.WEEKEND));
        assertEq(s, 1790366400);
        assertEq(e, 1790602200);
        (w,,) = cal.currentWindow(1790344800); // during REGULAR
        assertEq(uint8(w), uint8(SessionCalendar.WindowType.NONE));
    }

    function testFuzz_sessionNeverRevertsAndRegularOnlyOnTradingDays(uint256 ts) public view {
        ts = bound(ts, 1767243600, 1830315599);
        SessionCalendar.Session s = cal.session(ts);
        (uint256 day,) = cal.localDay(ts);
        if (s == SessionCalendar.Session.REGULAR) {
            assertTrue(cal.isTradingDay(day));
            assertLe(cal.regularOpenAt(day), ts);
            assertLt(ts, cal.regularCloseAt(day));
        }
    }

    function test_dayIndexedFunctions_rangeGuarded() public view {
        assertEq(uint8(cal.dayType(21186)), uint8(SessionCalendar.DayType.UNKNOWN)); // Mon 2028-01-03
        assertFalse(cal.isTradingDay(21186));
        assertFalse(cal.isTradingDay(21200)); // MLK 2028 must not read as a trading day
        assertFalse(cal.isTradingDay(20453)); // Wed 2025-12-31
        assertTrue(cal.isTradingDay(21183)); // Fri 2027-12-31 stays inside the table
    }

    function test_localDay_doesNotUnderflow() public view {
        (uint256 d, uint256 s) = cal.localDay(3 hours);
        assertEq(d, 0);
        assertEq(s, 0);
        (d, s) = cal.localDay(0);
        assertEq(d, 0);
    }

    function testFuzz_closedMomentsSitBetweenCloseAndOpen(uint256 ts) public view {
        ts = bound(ts, cal.VALID_FROM() + 10 days, cal.VALID_THROUGH() - 10 days);
        SessionCalendar.Session s = cal.session(ts);
        if (s == SessionCalendar.Session.REGULAR) return;
        assertTrue(s != SessionCalendar.Session.UNKNOWN);
        assertLe(cal.prevClose(ts), ts);
        assertLt(ts, cal.nextOpen(ts));
        (SessionCalendar.WindowType w,,) = cal.currentWindow(ts);
        assertTrue(w != SessionCalendar.WindowType.NONE);
    }
}
