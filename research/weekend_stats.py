"""Step 9. How far the bStock moves while the stock market is closed, and how well it predicts the reopen.

    python weekend_stats.py

Needs: nothing (no network, standard library only).
Reads: ../data/closure-windows.json.
Writes: data/weekend_stats.json, and prints the worst weekends.

Per group (the 20 most-held names, and all 77) and per closure type:
    excursion   the larger of the token's high and low against the last regular close
    phantom     how far the token traded below BOTH that close and the next open: a drawdown no stock
                market price ever confirmed. `phantom_up` is the mirror image.
    pred_*      the token's last price before the open as a forecast of the reopening gap
    sun_*       the same with the token's price on Sunday 20:00 New York time
"""
import math
import statistics

from common import CLOSURE_WINDOWS, DATA, dump, load

TOP20 = ["NVDAB", "SPYB", "QQQB", "TSLAB", "SPCXB", "CRCLB", "AAPLB", "MSTRB", "GOOGLB", "METAB",
         "DRAMB", "MUB", "SNDKB", "MSFTB", "AMZNB", "COINB", "AMDB", "PLTRB", "SKHYB", "INTCB"]
GROUPS = [("TOP20", lambda r: r["sym"] in TOP20), ("ALL", lambda r: True)]
TYPES = [("weekend", "long_weekend_holiday"), ("overnight",), ("midweek_holiday",)]


def quantile(values, p):
    """Linear-interpolation quantile."""
    a = sorted(values)
    if not a:
        return float("nan")
    k = (len(a) - 1) * p
    lo = math.floor(k)
    hi = min(lo + 1, len(a) - 1)
    return a[lo] + (a[hi] - a[lo]) * (k - lo)


def corr(x, y):
    mx, my = statistics.mean(x), statistics.mean(y)
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else float("nan")


def phantom_down(r):
    return max(0, 1 - (1 + r["max_dn"]) / min(1, 1 + r["gap"]))


def phantom_up(r):
    return max(0, (1 + r["max_up"]) / max(1, 1 + r["gap"]) - 1)


def share(flags, n):
    return sum(flags) / n


def describe(rows):
    n = len(rows)
    excursion = [max(abs(r["max_up"]), abs(r["max_dn"])) for r in rows]
    down = [phantom_down(r) for r in rows]
    up = [phantom_up(r) for r in rows]
    gaps = [r["gap"] for r in rows]
    forecast = [r["b_end"] for r in rows]
    errors = [p - g for p, g in zip(forecast, gaps)]
    mean_gap = statistics.mean(gaps)
    out = {
        "n": n,
        "syms": len({r["sym"] for r in rows}),
        "exc_gt3": share((e > 0.03 for e in excursion), n),
        "exc_gt5": share((e > 0.05 for e in excursion), n),
        "exc_gt10": share((e > 0.10 for e in excursion), n),
        "dn_gt3": share((r["max_dn"] < -0.03 for r in rows), n),
        "dn_gt5": share((r["max_dn"] < -0.05 for r in rows), n),
        "dn_gt10": share((r["max_dn"] < -0.10 for r in rows), n),
        "phantom_dn_gt1": share((p > 0.01 for p in down), n),
        "phantom_dn_gt3": share((p > 0.03 for p in down), n),
        "phantom_dn_gt5": share((p > 0.05 for p in down), n),
        "phantom_up_gt3": share((p > 0.03 for p in up), n),
        "exc_p50": quantile(excursion, 0.5),
        "exc_p90": quantile(excursion, 0.9),
        "exc_p99": quantile(excursion, 0.99),
        "exc_max": max(excursion),
        "gap_abs_p50": quantile([abs(g) for g in gaps], 0.5),
        "gap_abs_p90": quantile([abs(g) for g in gaps], 0.9),
        "gap_abs_max": max(abs(g) for g in gaps),
        "pred_corr": corr(forecast, gaps),
        "pred_mae": statistics.mean(abs(e) for e in errors),
        "naive_mae": statistics.mean(abs(g) for g in gaps),
        "pred_r2": 1 - sum(e * e for e in errors) / sum((g - mean_gap) ** 2 for g in gaps),
        "dir_hit": sum((p > 0) == (g > 0) for p, g in zip(forecast, gaps) if abs(g) > 0.005) / max(1, sum(abs(g) > 0.005 for g in gaps)),
        "miss_gt2": share((abs(e) > 0.02 for e in errors), n),
        "miss_gt5": share((abs(e) > 0.05 for e in errors), n),
        "start_prem_p50": quantile([abs(r["b_start_prem"]) for r in rows], 0.5),
        "start_prem_p90": quantile([abs(r["b_start_prem"]) for r in rows], 0.9),
        "wick_dn_p50": quantile([r["wick_dn"] for r in rows], 0.5),
        "wick_dn_p99": quantile([r["wick_dn"] for r in rows], 0.99),
        "wick_dn_max": max(r["wick_dn"] for r in rows),
    }
    sunday = [(r["b_sun"], r["gap"]) for r in rows if r["b_sun"] is not None]
    if sunday:
        out["sun_corr"] = corr([a for a, _ in sunday], [b for _, b in sunday])
        out["sun_mae"] = statistics.mean(abs(a - b) for a, b in sunday)
        out["sun_naive_mae"] = statistics.mean(abs(b) for _, b in sunday)
        out["sun_n"] = len(sunday)
    return out


def pct(x):
    return f"{x * 100:.2f}%"


def main():
    windows = load(CLOSURE_WINDOWS)
    out = {}
    for label, keep in GROUPS:
        for types in TYPES:
            rows = [r for r in windows if keep(r) and r["type"] in types]
            if rows:
                out[f"{label}|{'+'.join(types)}"] = describe(rows)
    dump(DATA / "weekend_stats.json", out)
    for key, stats in out.items():
        print("==", key)
        print({k: (round(v, 4) if isinstance(v, float) else v) for k, v in stats.items()})

    weekends = [r for r in windows if r["type"] in ("weekend", "long_weekend_holiday")]
    print("\nworst drawdowns no stock price confirmed (weekends):")
    for r in sorted(weekends, key=lambda r: -phantom_down(r))[:12]:
        print(r["sym"], r["d0"], r["d1"], "low", pct(r["max_dn"]), "gap", pct(r["gap"]), "phantom", pct(phantom_down(r)), "volume $", round(r["qv_usd"]))
    print("\nworst run-ups no stock price confirmed (weekends):")
    for r in sorted(weekends, key=lambda r: -phantom_up(r))[:8]:
        print(r["sym"], r["d0"], r["d1"], "high", pct(r["max_up"]), "gap", pct(r["gap"]), "phantom", pct(phantom_up(r)), "volume $", round(r["qv_usd"]))
    print("\nlargest reopening gaps and what the token said at 09:00 New York time:")
    for r in sorted(weekends, key=lambda r: -abs(r["gap"]))[:12]:
        print(r["sym"], r["d0"], r["d1"], "gap", pct(r["gap"]), "token", pct(r["b_end"]), "miss", pct(r["b_end"] - r["gap"]))


if __name__ == "__main__":
    main()
