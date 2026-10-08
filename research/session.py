"""US equity session of a unix timestamp, in New York time.

Needs nothing but the standard library: the UTC offset comes from the US daylight-saving rule
(second Sunday of March to first Sunday of November), not from a time zone database.

Sessions:
    regular    09:30-16:00 on a weekday
    pre        04:00-09:30
    post       16:00-20:00
    overnight  20:00-04:00 on weeknights, and Sunday from 20:00 (the overnight venues reopen)
    weekend    Friday 20:00 to Sunday 20:00
    holiday    the whole New York calendar day of an NYSE full-day holiday

Only the 2026 holidays are listed, which covers the sample. Early closes are not modelled.
"""
import datetime as dt

UTC = dt.timezone.utc

HOLIDAYS = {
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
}

REGULAR_OPEN = 9 * 60 + 30
REGULAR_CLOSE = 16 * 60
PRE_OPEN = 4 * 60
POST_CLOSE = 20 * 60


def _nth_sunday(year, month, n):
    first = dt.date(year, month, 1)
    first_sunday = first + dt.timedelta(days=(6 - first.weekday()) % 7)
    return first_sunday + dt.timedelta(weeks=n - 1)


def utc_offset_hours(ts):
    """Hours New York is behind UTC at `ts`: 4 in daylight time, 5 otherwise."""
    year = dt.datetime.fromtimestamp(ts, UTC).year
    start = dt.datetime.combine(_nth_sunday(year, 3, 2), dt.time(7), UTC).timestamp()
    end = dt.datetime.combine(_nth_sunday(year, 11, 1), dt.time(6), UTC).timestamp()
    return 4 if start <= ts < end else 5


def new_york(ts):
    """New York wall-clock time of `ts` as a naive datetime."""
    return dt.datetime.fromtimestamp(ts - utc_offset_hours(ts) * 3600, UTC).replace(tzinfo=None)


def is_trading_day(day):
    return day.weekday() < 5 and day.isoformat() not in HOLIDAYS


def session(ts):
    t = new_york(ts)
    weekday = t.weekday()  # Monday is 0
    minute = t.hour * 60 + t.minute
    if t.date().isoformat() in HOLIDAYS:
        return "holiday"
    if weekday == 5 or (weekday == 6 and minute < POST_CLOSE) or (weekday == 4 and minute >= POST_CLOSE):
        return "weekend"
    if weekday == 6:
        return "overnight"
    if REGULAR_OPEN <= minute < REGULAR_CLOSE:
        return "regular"
    if PRE_OPEN <= minute < REGULAR_OPEN:
        return "pre"
    if REGULAR_CLOSE <= minute < POST_CLOSE:
        return "post"
    return "overnight"


def minutes_since_open(ts):
    """Minutes since 09:30 New York time on the day of `ts` (negative before the open)."""
    t = new_york(ts)
    return t.hour * 60 + t.minute - REGULAR_OPEN


def follows_a_closed_day(ts):
    """True when the New York calendar day before `ts` was a weekend day or a holiday."""
    return not is_trading_day(new_york(ts).date() - dt.timedelta(days=1))


def et_str(ts):
    return new_york(ts).strftime("%a %Y-%m-%d %H:%M ET")
