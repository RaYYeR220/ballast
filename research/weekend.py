"""Step 8. Builds one row per bStock and market closure: what the token did while the stock was shut.

    python weekend.py

Needs: nothing but the cache (no network).
Reads: cache/kl/ (fetch_klines.py), cache/yd/ (fetch_yahoo.py), data/bstocks.json.
Writes: ../data/closure-windows.json (the same file the backtest replays).

A closure runs from a regular close of the underlying (16:00 New York time) to its next regular
open (09:30). The whole sample is in daylight time, so those are 20:00 and 13:30 UTC. The bStock
path is every 1h candle that opens from the close up to 12:00 UTC on the reopening day. A closure
is skipped when the token listed less than a day before it or when more than a fifth of its
candles are missing.

Fields: see data/README.md at the repository root.
"""
import csv
import datetime as dt
import json

from common import CACHE, CLOSURE_WINDOWS, DATA, load

UTC = dt.timezone.utc
SAMPLE_END = "2026-09-25"  # daily bars from this date on are ignored


def load_klines(symbol):
    with open(CACHE / "kl" / f"{symbol}.csv", encoding="ascii") as f:
        # open time (s), open, high, low, close, quote volume
        return [(int(r["t"]) // 1000, float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"]), float(r["qv"])) for r in csv.DictReader(f)]


def load_daily(ticker):
    with open(CACHE / "yd" / f"{ticker}.csv", encoding="ascii") as f:
        # date, open, high, low, close, dividend going ex that day
        return [(r["date"], float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"]), float(r["div"])) for r in csv.DictReader(f) if r["date"] < SAMPLE_END]


def utc_ts(date, hour, minute=0):
    year, month, day = map(int, date.split("-"))
    return int(dt.datetime(year, month, day, hour, minute, tzinfo=UTC).timestamp())


def closure_type(d0, d1):
    days = (dt.date.fromisoformat(d1) - dt.date.fromisoformat(d0)).days
    if days == 1:
        return "overnight"
    if days == 2:
        return "midweek_holiday"
    if days == 3 and dt.date.fromisoformat(d0).weekday() == 4 and dt.date.fromisoformat(d1).weekday() == 0:
        return "weekend"
    return "long_weekend_holiday"


def main():
    rows = []
    for token in load(DATA / "bstocks.json").values():
        symbol, ticker = token["symbol"], token["underlying"]
        try:
            klines = load_klines(symbol)
            daily = load_daily(ticker)
        except FileNotFoundError:
            continue
        if len(klines) < 48 or len(daily) < 3:
            continue
        by_open = {k[0]: k for k in klines}
        listed = klines[0][0]
        for before, after in zip(daily, daily[1:]):
            d0, d1 = before[0], after[0]
            closed_at = utc_ts(d0, 20)
            opens_at = utc_ts(d1, 13, 30)
            if closed_at < listed + 24 * 3600:
                continue
            candles = [by_open[t] for t in range(closed_at, opens_at - 1800, 3600) if t in by_open]
            if len(candles) < max(1, int((opens_at - 1800 - closed_at) / 3600 * 0.8)):
                continue
            kind = closure_type(d0, d1)
            close = before[4]
            reopen = after[1] + after[5]  # add the dividend back so the gap is economic
            high = max(c[2] for c in candles)
            low = min(c[3] for c in candles)
            # the token at Monday 00:00 UTC (Sunday 20:00 New York time, when the overnight venues reopen)
            sunday = None
            if kind != "overnight":
                for c in candles:
                    if dt.datetime.fromtimestamp(c[0], UTC).hour == 0:
                        sunday = c[1]
            wick_down = max(((max(c[1], c[4]) - c[3]) / max(c[1], c[4]), c[0]) for c in candles)
            wick_up = max(((c[2] - min(c[1], c[4])) / min(c[1], c[4]), c[0]) for c in candles)
            rows.append({
                "sym": symbol,
                "und": ticker,
                "type": kind,
                "d0": d0,
                "d1": d1,
                "hours": round((opens_at - closed_at) / 3600, 1),
                "fri_close": close,
                "mon_open": reopen,
                "gap": reopen / close - 1,
                "b_start_prem": candles[0][1] / close - 1,
                "max_up": high / close - 1,
                "max_dn": low / close - 1,
                "b_end": candles[-1][4] / close - 1,
                "b_sun": (sunday / close - 1) if sunday else None,
                "wick_dn": wick_down[0],
                "wick_dn_t": wick_down[1],
                "wick_up": wick_up[0],
                "qv_usd": sum(c[5] for c in candles),
                "n": len(candles),
                "lo_vs_open": low / reopen - 1,
                "hi_vs_open": high / reopen - 1,
            })
    with open(CLOSURE_WINDOWS, "w", encoding="ascii", newline="\n") as f:
        json.dump(rows, f)
    print(len(rows), "closures")


if __name__ == "__main__":
    main()
