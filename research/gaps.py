"""Step 11. Close-to-open gap quantiles of the underlying stocks, by kind of closure.

    python gaps.py

Needs: nothing but the cache (no network).
Reads: cache/yd/ (fetch_yahoo.py), cache/earn/earn_rows.jsonl (fetch_earnings.py), data/tickers.json.
Writes: data/gap_windows.csv (one row per ticker and closure: reopening day, calendar days since the
        previous session, the gap, its class) and data/gap_quantiles.json (per ticker and pooled,
        in basis points).

gap = (regular open + cash dividend going ex that day) / previous regular close - 1

Classes, with the short code used in gap_windows.csv:
    weekday_overnight         on    consecutive calendar days
    weekend                   we    Friday close to Monday open
    holiday_or_long_weekend   hol   any other closure longer than a day
    earnings                  earn  for each earnings date D, whichever of (D-1 to D) and (D to D+1)
                                    has the larger absolute gap. The calendar does not say whether a
                                    company reported before the open or after the close, so the
                                    other of the two is dropped from every class:
    earnings_adjacent_other   adj

`abs_*` are quantiles of |gap|. `down_*` are quantiles of max(0, -gap), the tail that hurts a
collateral position. The pooled rows use the tickers with at least 5 years of history, without the
3x leveraged ETFs.
"""
import collections
import csv
import datetime as dt
import json
import math

from common import CACHE, DATA, dump, load

FIRST_DAY = "2020-06-01"  # where the earnings calendar starts; also leaves out the March 2020 crash
LAST_DAY = "2026-09-24"
CLASSES = ["weekday_overnight", "weekend", "holiday_or_long_weekend", "earnings"]
CODES = {"weekday_overnight": "on", "weekend": "we", "holiday_or_long_weekend": "hol", "earnings": "earn", "earnings_adjacent_other": "adj"}
LEVERAGED = {"SOXL", "TQQQ"}
POOL_MIN_YEARS = 5
GAP_DECIMALS = 7  # gaps are rounded to 0.001 bp before anything else, so the CSV carries exactly what was summarised


def quantile(values, p):
    """Linear-interpolation quantile."""
    if not values:
        return None
    a = sorted(values)
    k = (len(a) - 1) * p
    lo = math.floor(k)
    hi = min(lo + 1, len(a) - 1)
    return a[lo] + (a[hi] - a[lo]) * (k - lo)


def load_daily(ticker):
    rows = []
    with open(CACHE / "yd" / f"{ticker}.csv", encoding="ascii") as f:
        for r in csv.DictReader(f):
            if not FIRST_DAY <= r["date"] <= LAST_DAY:
                continue
            o, c = float(r["o"]), float(r["c"])
            if o > 0 and c > 0:
                rows.append((r["date"], o, c, float(r["div"])))
    return rows


def classify(daily, earnings_dates):
    """One [d0, d1, gap, class, days] per pair of consecutive sessions."""
    windows = []
    for (d0, _o0, c0, _div0), (d1, o1, _c1, div1) in zip(daily, daily[1:]):
        days = (dt.date.fromisoformat(d1) - dt.date.fromisoformat(d0)).days
        if days == 1:
            kind = "weekday_overnight"
        elif days == 3 and dt.date.fromisoformat(d0).weekday() == 4:
            kind = "weekend"
        else:
            kind = "holiday_or_long_weekend"
        windows.append([d0, d1, round((o1 + div1) / c0 - 1, GAP_DECIMALS), kind, days])
    ends_on = {w[1]: i for i, w in enumerate(windows)}
    starts_on = {w[0]: i for i, w in enumerate(windows)}
    for date in earnings_dates:
        candidates = [i for i in (ends_on.get(date), starts_on.get(date)) if i is not None]
        if not candidates:
            continue
        largest = max(candidates, key=lambda i: abs(windows[i][2]))
        for i in candidates:
            windows[i][3] = "earnings" if i == largest else "earnings_adjacent_other"
    return windows


def summary(gaps):
    absolute = [abs(g) * 1e4 for g in gaps]
    down = [max(0, -g) * 1e4 for g in gaps]
    return {
        "n": len(gaps),
        "abs_p95": quantile(absolute, 0.95),
        "abs_p99": quantile(absolute, 0.99),
        "abs_p999": quantile(absolute, 0.999),
        "down_p95": quantile(down, 0.95),
        "down_p99": quantile(down, 0.99),
        "down_p999": quantile(down, 0.999),
        "max_down": max(down) if down else None,
        "max_up": max(g * 1e4 for g in gaps) if gaps else None,
    }


def bps(x):
    return None if x is None else round(x)


def table_row(ticker, kind, s, years, history_from):
    return {
        "ticker": ticker,
        "bstock": ticker + "B" if years is not None else "",
        "window": kind,
        "n": s["n"],
        "years": None if years is None else round(years, 1),
        "history_from": history_from,
        "abs_p95_bps": bps(s["abs_p95"]),
        "abs_p99_bps": bps(s["abs_p99"]),
        "abs_p999_bps": bps(s["abs_p999"]),
        "down_p95_bps": bps(s["down_p95"]),
        "down_p99_bps": bps(s["down_p99"]),
        "down_p999_bps": bps(s["down_p999"]),
        "max_down_bps": bps(s["max_down"]) if years is not None else None,
        "max_up_bps": bps(s["max_up"]) if years is not None else None,
        "p999_reliable": s["n"] >= 1000,
        "short_history": years is not None and round(years, 1) < POOL_MIN_YEARS,
    }


def main():
    earnings = collections.defaultdict(set)
    with open(CACHE / "earn" / "earn_rows.jsonl", encoding="ascii") as f:
        for line in f:
            row = json.loads(line)
            earnings[row["symbol"]].add(row["date"])

    rows = []
    pooled = collections.defaultdict(list)
    pooled_tickers = []
    with open(DATA / "gap_windows.csv", "w", encoding="ascii", newline="\n") as out:
        out.write("ticker,d1,days,gap,class\n")
        for ticker in load(DATA / "tickers.json"):
            try:
                daily = load_daily(ticker)
            except FileNotFoundError:
                continue
            if len(daily) < 60:
                continue
            windows = classify(daily, sorted(earnings.get(ticker, set())))
            years = (dt.date.fromisoformat(daily[-1][0]) - dt.date.fromisoformat(daily[0][0])).days / 365.25
            in_pool = years >= POOL_MIN_YEARS and ticker not in LEVERAGED
            if in_pool:
                pooled_tickers.append(ticker)
            by_class = collections.defaultdict(list)
            for _d0, d1, gap, kind, days in windows:
                by_class[kind].append(gap)
                out.write(f"{ticker},{d1},{days},{gap:.{GAP_DECIMALS}f},{CODES[kind]}\n")
            for kind in CLASSES:
                gaps = by_class.get(kind, [])
                if in_pool:
                    pooled[kind] += gaps
                if gaps:
                    rows.append(table_row(ticker, kind, summary(gaps), years, daily[0][0]))
    for kind in CLASSES:
        s = summary(pooled[kind])
        rows.append(table_row("POOLED_5Y+", kind, s, None, ""))
        print(f"pooled {kind:24s} n={s['n']:6d}  down p95 {s['down_p95']:7.1f}  p99 {s['down_p99']:7.1f}  p99.9 {s['down_p999']:7.1f}  abs p99 {s['abs_p99']:7.1f} bps")
    meta = {
        "definition": "gap = (regular open + cash dividend going ex that day) / previous regular close - 1; quantiles of |gap| (abs_*) and of max(0, -gap) (down_*), in basis points",
        "sample": f"{FIRST_DAY} to {LAST_DAY}",
        "pooled": f"{len(pooled_tickers)} tickers with at least {POOL_MIN_YEARS} years of history, 3x leveraged ETFs excluded",
        "pooled_tickers": pooled_tickers,
        "caveats": [
            "p99.9 means something only where p999_reliable is true (n >= 1000); for one ticker's weekends it is close to the single worst observation",
            "short_history tickers have less than 5 years of data: use the pooled rows or a peer for them",
            "a gap to the regular open ignores the path through extended hours",
        ],
    }
    dump(DATA / "gap_quantiles.json", {"meta": meta, "rows": rows})
    print(len(rows), "rows;", len(pooled_tickers), "tickers pooled")


if __name__ == "__main__":
    main()
