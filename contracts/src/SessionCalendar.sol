// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SessionCalendar
/// @notice NYSE session calendar for 2026-2027 computed from constants: US/Eastern with DST, full-day
///         holidays and 13:00 early closes. No admin and no oracle. Outside the table every query answers
///         UNKNOWN (or 0 for timestamps) so callers fail closed.
/// @dev Sessions follow the 24/5 venue convention: PRE 04:00-09:30, REGULAR 09:30-16:00 (13:00 on early
///      closes), POST until 20:00, OVERNIGHT 20:00-04:00 when the next day trades.
contract SessionCalendar {
    enum Session {
        UNKNOWN,
        CLOSED_WEEKEND,
        CLOSED_HOLIDAY,
        OVERNIGHT,
        PRE,
        REGULAR,
        POST
    }

    enum WindowType {
        NONE,
        OVERNIGHT,
        WEEKEND,
        HOLIDAY
    }

    enum DayType {
        TRADING,
        EARLY_CLOSE,
        HOLIDAY,
        WEEKEND,
        UNKNOWN
    }

    uint256 public constant VALID_FROM = 1767243600; // 2026-01-01 00:00 ET
    uint256 public constant VALID_THROUGH = 1830315600; // 2028-01-01 00:00 ET

    uint256 internal constant FIRST_DAY = 20454; // local day of VALID_FROM (2026-01-01)
    uint256 internal constant END_DAY = 21184; // local day of VALID_THROUGH (2028-01-01), exclusive

    uint256 internal constant DST_START_2026 = 1772953200; // 2026-03-08 07:00 UTC
    uint256 internal constant DST_END_2026 = 1793512800; // 2026-11-01 06:00 UTC
    uint256 internal constant DST_START_2027 = 1805007600; // 2027-03-14 07:00 UTC
    uint256 internal constant DST_END_2027 = 1825567200; // 2027-11-07 06:00 UTC

    uint256 internal constant PRE_OPEN = 4 hours;
    uint256 internal constant REGULAR_OPEN = 9 hours + 30 minutes;
    uint256 internal constant REGULAR_CLOSE = 16 hours;
    uint256 internal constant EARLY_CLOSE = 13 hours;
    uint256 internal constant POST_CLOSE = 20 hours;
    uint256 internal constant SEARCH_DAYS = 10;

    function isDst(uint256 ts) public pure returns (bool) {
        return (ts >= DST_START_2026 && ts < DST_END_2026) || (ts >= DST_START_2027 && ts < DST_END_2027);
    }

    function utcOffset(uint256 ts) public pure returns (uint256) {
        return isDst(ts) ? 4 hours : 5 hours;
    }

    /// @return day Days since 1970-01-01 in New York local time (0 for timestamps before the epoch offset).
    /// @return secondOfDay Seconds since local midnight.
    function localDay(uint256 ts) public pure returns (uint256 day, uint256 secondOfDay) {
        if (ts < 5 hours) return (0, 0);
        uint256 local = ts - utcOffset(ts);
        return (local / 1 days, local % 1 days);
    }

    /// @return 0 = Sunday ... 6 = Saturday.
    function weekday(uint256 day) public pure returns (uint256) {
        return (day + 4) % 7;
    }

    /// @notice Type of local day `day`. Days outside the table [2026-01-01, 2028-01-01) are UNKNOWN and
    ///         never count as trading days.
    function dayType(uint256 day) public pure returns (DayType) {
        if (day < FIRST_DAY || day >= END_DAY) return DayType.UNKNOWN;
        uint256 wd = weekday(day);
        if (wd == 0 || wd == 6) return DayType.WEEKEND;
        if (_isHoliday(day)) return DayType.HOLIDAY;
        if (day == 20784 || day == 20811 || day == 21148) return DayType.EARLY_CLOSE;
        return DayType.TRADING;
    }

    function isTradingDay(uint256 day) public pure returns (bool) {
        DayType t = dayType(day);
        return t == DayType.TRADING || t == DayType.EARLY_CLOSE;
    }

    function session(uint256 ts) public pure returns (Session) {
        if (ts < VALID_FROM || ts >= VALID_THROUGH) return Session.UNKNOWN;
        (uint256 day, uint256 s) = localDay(ts);
        DayType t = dayType(day);
        if (t == DayType.TRADING || t == DayType.EARLY_CLOSE) {
            if (s < PRE_OPEN) return Session.OVERNIGHT;
            if (s < REGULAR_OPEN) return Session.PRE;
            if (s < (t == DayType.EARLY_CLOSE ? EARLY_CLOSE : REGULAR_CLOSE)) return Session.REGULAR;
            if (s < POST_CLOSE) return Session.POST;
            return _evening(day);
        }
        if (s >= POST_CLOSE && isTradingDay(day + 1)) return Session.OVERNIGHT;
        return t == DayType.WEEKEND ? Session.CLOSED_WEEKEND : Session.CLOSED_HOLIDAY;
    }

    function regularOpenAt(uint256 day) public pure returns (uint256) {
        return _toUtc(day, REGULAR_OPEN);
    }

    function regularCloseAt(uint256 day) public pure returns (uint256) {
        return _toUtc(day, dayType(day) == DayType.EARLY_CLOSE ? EARLY_CLOSE : REGULAR_CLOSE);
    }

    function nextOpen(uint256 ts) public pure returns (uint256) {
        if (ts < VALID_FROM || ts >= VALID_THROUGH) return 0;
        (uint256 day,) = localDay(ts);
        for (uint256 i; i < SEARCH_DAYS; ++i) {
            uint256 d = day + i;
            if (!isTradingDay(d)) continue;
            uint256 o = regularOpenAt(d);
            if (o > ts) return o < VALID_THROUGH ? o : 0;
        }
        return 0;
    }

    function nextClose(uint256 ts) public pure returns (uint256) {
        if (ts < VALID_FROM || ts >= VALID_THROUGH) return 0;
        (uint256 day,) = localDay(ts);
        for (uint256 i; i < SEARCH_DAYS; ++i) {
            uint256 d = day + i;
            if (!isTradingDay(d)) continue;
            uint256 c = regularCloseAt(d);
            if (c > ts) return c < VALID_THROUGH ? c : 0;
        }
        return 0;
    }

    function prevClose(uint256 ts) public pure returns (uint256) {
        if (ts < VALID_FROM || ts >= VALID_THROUGH) return 0;
        (uint256 day,) = localDay(ts);
        for (uint256 i; i < SEARCH_DAYS && i <= day; ++i) {
            uint256 d = day - i;
            if (!isTradingDay(d)) continue;
            uint256 c = regularCloseAt(d);
            if (c <= ts) return c >= VALID_FROM ? c : 0;
        }
        return 0;
    }

    /// @notice Type of the closure that follows the regular close of trading day `day`.
    function windowAfter(uint256 day) public pure returns (WindowType) {
        if (!isTradingDay(day)) return WindowType.NONE;
        bool holiday;
        uint256 n = day + 1;
        for (uint256 i; i < SEARCH_DAYS && !isTradingDay(n); ++i) {
            if (dayType(n) == DayType.HOLIDAY) holiday = true;
            ++n;
        }
        if (n == day + 1) return WindowType.OVERNIGHT;
        return holiday ? WindowType.HOLIDAY : WindowType.WEEKEND;
    }

    /// @notice The next closure: starts at the next regular close, ends at the following regular open.
    function nextWindow(uint256 ts) public pure returns (WindowType w, uint256 startsAt, uint256 endsAt) {
        startsAt = nextClose(ts);
        if (startsAt == 0) return (WindowType.NONE, 0, 0);
        endsAt = nextOpen(startsAt);
        if (endsAt == 0) return (WindowType.NONE, 0, 0);
        (uint256 day,) = localDay(startsAt);
        w = windowAfter(day);
    }

    /// @notice The closure in progress at `ts` (NONE during the regular session).
    function currentWindow(uint256 ts) public pure returns (WindowType w, uint256 closedAt, uint256 opensAt) {
        Session s = session(ts);
        if (s == Session.UNKNOWN || s == Session.REGULAR) return (WindowType.NONE, 0, 0);
        closedAt = prevClose(ts);
        opensAt = nextOpen(ts);
        if (closedAt == 0 || opensAt == 0) return (WindowType.NONE, 0, 0);
        (uint256 day,) = localDay(closedAt);
        w = windowAfter(day);
    }

    function _evening(uint256 day) internal pure returns (Session) {
        if (isTradingDay(day + 1)) return Session.OVERNIGHT;
        if (dayType(day + 1) == DayType.UNKNOWN) return Session.UNKNOWN;
        return dayType(day + 1) == DayType.WEEKEND ? Session.CLOSED_WEEKEND : Session.CLOSED_HOLIDAY;
    }

    function _toUtc(uint256 day, uint256 localSecond) internal pure returns (uint256) {
        uint256 guess = day * 1 days + localSecond + 5 hours;
        return day * 1 days + localSecond + utcOffset(guess);
    }

    function _isHoliday(uint256 d) internal pure returns (bool) {
        return d == 20454 || d == 20472 || d == 20500 || d == 20546 || d == 20598 || d == 20623 || d == 20637
            || d == 20703 || d == 20783 || d == 20812 || d == 20819 || d == 20836 || d == 20864 || d == 20903
            || d == 20969 || d == 20987 || d == 21004 || d == 21067 || d == 21147 || d == 21176;
    }
}
