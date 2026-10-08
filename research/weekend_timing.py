"""Step 10. When does a bStock's weekend price start to say something about Monday's open?

    python weekend_timing.py

Needs: nothing but the cache (no network).
Reads: ../data/closure-windows.json (weekend.py), cache/kl/ (fetch_klines.py).
Writes: data/weekend_timing.json (the summary) and data/weekend_timing_points.json (the samples
        behind it, so the summary can be recomputed without the klines).

For every ordinary weekend (Friday close to Monday open) the token's price is read at six moments,
as a return against Friday's regular close of the stock, and compared with the stock's Monday gap:

    Sat 00:00 UTC   Friday 20:00 New York time, the post-market has just ended
    Sat 12:00 UTC
    Sun 12:00 UTC
    Mon 00:00 UTC   Sunday 20:00 New York time, the US overnight venues reopen
    Mon 08:00 UTC   04:00 New York time, the pre-market opens
    Mon 13:00 UTC   09:00 New York time, half an hour before the open

r2 is 1 - sum((token - gap)^2) / sum((gap - mean gap)^2): how much better the token is than
assuming the average gap. It goes negative when the token is worse than that.

The "dark window" is Saturday 00:00 to Monday 00:00 UTC, when no US venue trades the stock.
"""
import csv
import datetime as dt
import math
import statistics

from common import CACHE, CLOSURE_WINDOWS, DATA, dump, load

UTC = dt.timezone.utc
TOP20 = ["NVDAB", "SPYB", "QQQB", "TSLAB", "SPCXB", "CRCLB", "AAPLB", "MSTRB", "GOOGLB", "METAB",
         "DRAMB", "MUB", "SNDKB", "MSFTB", "AMZNB", "COINB", "AMDB", "PLTRB", "SKHYB", "INTCB"]
GROUPS = [("TOP20", lambda r: r["sym"] in TOP20), ("ALL", lambda r: True)]

# label, short key, anchor day ("d0" is the Friday, "d1" the Monday), days after the anchor, hour UTC
POINTS = [
    ("Sat00Z (Fri 20:00 ET, post-mkt end)", "sat00", "d0", 1, 0),
    ("Sat12Z", "sat12", "d0", 1, 12),
    ("Sun12Z", "sun12", "d0", 2, 12),
    ("Mon00Z (Sun 20:00 ET, overnight ATS opens)", "mon00", "d1", 0, 0),
    ("Mon08Z (04:00 ET pre-mkt)", "mon08", "d1", 0, 8),
    ("Mon13Z (09:00 ET)", "mon13", "d1", 0, 13),
]

_klines = {}


def klines(symbol):
    if symbol not in _klines:
        with open(CACHE / "kl" / f"{symbol}.csv", encoding="ascii") as f:
            _klines[symbol] = {int(r["t"]) // 1000: (float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"])) for r in csv.DictReader(f)}
    return _klines[symbol]


def utc_ts(day, hour):
    return int(dt.datetime(day.year, day.month, day.day, hour, tzinfo=UTC).timestamp())


def corr(x, y):
    mx, my = statistics.mean(x), statistics.mean(y)
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy)


def fit(xs, ys):
    """Scores `xs` as a forecast of `ys`."""
    errors = [a - b for a, b in zip(xs, ys)]
    mean = statistics.mean(ys)
    return {
        "n": len(xs),
        "corr": round(corr(xs, ys), 3),
        "r2": round(1 - sum(e * e for e in errors) / sum((y - mean) ** 2 for y in ys), 3),
        "mae_bps": round(statistics.mean(abs(e) for e in errors) * 1e4),
        "naive_mae_bps": round(statistics.mean(abs(y) for y in ys) * 1e4),
    }


def sample(window):
    """The token's return against Friday's close at each of the six moments (None where a candle is missing)."""
    out = {}
    for _label, key, anchor, days_after, hour in POINTS:
        day = dt.date.fromisoformat(window[anchor]) + dt.timedelta(days=days_after)
        candle = klines(window["sym"]).get(utc_ts(day, hour))
        out[key] = candle[0] / window["fri_close"] - 1 if candle else None
    return out


def dark_window(window):
    """Token extremes between Saturday 00:00 and Monday 00:00 UTC, or None with fewer than 40 candles."""
    k = klines(window["sym"])
    start = utc_ts(dt.date.fromisoformat(window["d0"]) + dt.timedelta(days=1), 0)
    end = utc_ts(dt.date.fromisoformat(window["d1"]), 0)
    candles = [k[t] for t in range(start, end, 3600) if t in k]
    if len(candles) < 40:
        return None
    first = candles[0][0]
    low = min(c[2] for c in candles)
    high = max(c[1] for c in candles)
    return {
        "dn": low / first - 1,
        "up": high / first - 1,
        "lo_vs_monopen": low / window["mon_open"] - 1,
        "end": candles[-1][3] / first - 1,
        "gap_from_sat": window["mon_open"] / first - 1,
    }


def share(flags, n):
    return round(sum(flags) / n, 3)


def main():
    weekends = [r for r in load(CLOSURE_WINDOWS) if r["type"] == "weekend"]
    points = [{"sym": r["sym"], "d0": r["d0"], "gap": r["gap"], **sample(r), "dark": dark_window(r)} for r in weekends]
    dump(DATA / "weekend_timing_points.json", points, indent=None)

    out = {}
    for group, keep in GROUPS:
        rows = [p for p in points if keep(p)]
        result = {}
        for label, key, *_ in POINTS:
            pairs = [(p[key], p["gap"]) for p in rows if p[key] is not None]
            result[label] = fit([a for a, _ in pairs], [b for _, b in pairs])
        dark = [p["dark"] for p in rows if p["dark"]]
        excursion = sorted(max(-d["dn"], d["up"]) for d in dark)
        n = len(dark)
        result["dark_window"] = {
            "n": n,
            "exc_gt2": share((e > 0.02 for e in excursion), n),
            "exc_gt3": share((e > 0.03 for e in excursion), n),
            "exc_gt5": share((e > 0.05 for e in excursion), n),
            "exc_gt10": share((e > 0.10 for e in excursion), n),
            "dn_gt3": share((d["dn"] < -0.03 for d in dark), n),
            "dn_gt5": share((d["dn"] < -0.05 for d in dark), n),
            "lo_below_monopen_gt3": share((d["lo_vs_monopen"] < -0.03 for d in dark), n),
            "lo_below_monopen_gt5": share((d["lo_vs_monopen"] < -0.05 for d in dark), n),
            "dark_end_vs_gap_corr": round(corr([d["end"] for d in dark], [d["gap_from_sat"] for d in dark]), 3),
            "exc_p50_bps": round(excursion[n // 2] * 1e4),
            "exc_p90_bps": round(excursion[int(n * 0.9)] * 1e4),
            "exc_max_bps": round(max(excursion) * 1e4),
        }
        out[group] = result
        print("==", group)
        for key, value in result.items():
            print(" ", key, value)
    dump(DATA / "weekend_timing.json", out)


if __name__ == "__main__":
    main()
