"""Recomputes every published figure from the committed data and compares it with the documented value.

    python check_figures.py

Needs: nothing (no network, standard library only). Exits 1 when any figure differs.

Each line says where the number comes from:
    recomputed   derived here from row-level data (liquidations, closures, gap rows, timing samples)
    recorded     read from a stored result that cannot be rederived without the network
                 (transaction receipts for the Venus check)

Row-level data: data/liquidations_moolah_bstock_ctx.json, data/liquidations_moolah_other.json,
../data/closure-windows.json, data/weekend_timing_points.json, data/gap_windows.csv.
Stored summaries that are checked against the recomputation: data/liq_headline.json,
data/liq_organic.json, data/weekend_stats.json, data/weekend_timing.json, data/gap_quantiles.json,
and the gap buffers in ../config/bsc-mainnet.json.
"""
import collections
import csv
import datetime as dt
import json
import math
import statistics
import sys
from pathlib import Path

from session import follows_a_closed_day, minutes_since_open, session

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
ROOT = HERE.parent

TOP20 = {"NVDAB", "SPYB", "QQQB", "TSLAB", "SPCXB", "CRCLB", "AAPLB", "MSTRB", "GOOGLB", "METAB",
         "DRAMB", "MUB", "SNDKB", "MSFTB", "AMZNB", "COINB", "AMDB", "PLTRB", "SKHYB", "INTCB"}
CLOSED = {"pre", "post", "overnight", "weekend", "holiday"}
GAP_CLASSES = {"on": "weekday_overnight", "we": "weekend", "hol": "holiday_or_long_weekend", "earn": "earnings"}
LEVERAGED = {"SOXL", "TQQQ"}

results = []


def check(name, documented, got, source="recomputed"):
    results.append((name, documented, got, source))


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def quantile(values, p):
    a = sorted(values)
    k = (len(a) - 1) * p
    lo = math.floor(k)
    hi = min(lo + 1, len(a) - 1)
    return a[lo] + (a[hi] - a[lo]) * (k - lo)


def corr(x, y):
    mx, my = statistics.mean(x), statistics.mean(y)
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy)


def r2(forecast, actual):
    mean = statistics.mean(actual)
    return 1 - sum((f - a) ** 2 for f, a in zip(forecast, actual)) / sum((a - mean) ** 2 for a in actual)


def pct(x, digits=1):
    return round(100 * x, digits)


# ------------------------------------------------------------- liquidations

def liquidations():
    rows = load(DATA / "liquidations_moolah_bstock_ctx.json")
    stock = [r for r in rows if r["kind"] == "stock-collateral"]
    sessions = [session(r["ts"]) for r in stock]
    usd = sum(r["repaid_usd"] for r in stock)

    check("bStock-collateral liquidations on Lista", 120, len(stock))
    check("of them on a weekend (Fri 20:00 to Sun 20:00 New York)", 0, sessions.count("weekend"))
    check("rows whose stored session differs from the one recomputed from the timestamp", 0, sum(session(r["ts"]) != r["session"] for r in rows))
    check("first and last liquidation (UTC date)", "2026-06-18 / 2026-09-22", f"{min(r['time_utc'] for r in rows)[:10]} / {max(r['time_utc'] for r in rows)[:10]}")
    check("debt repaid, $ thousand", 31.6, round(usd / 1000, 1))
    check("bad debt, $", 0, round(sum(r["bad_debt_usd"] for r in stock)))
    check("liquidations where a bStock is the loan, not the collateral", 1, len(rows) - len(stock))

    by_borrower = collections.defaultdict(list)
    for r in stock:
        by_borrower[r["borrower"]].append(r["repaid_usd"])
    seeds = {b for b, v in by_borrower.items() if len(v) >= 20 and statistics.median(v) < 50}
    seed_rows = [r for r in stock if r["borrower"] in seeds]
    organic = [r for r in stock if r["borrower"] not in seeds]
    organic_usd = sum(r["repaid_usd"] for r in organic)
    check("seed accounts (20 or more liquidations, median under $50)", 1, len(seeds))
    check("seed liquidations", 87, len(seed_rows))
    check("seed markets", 52, len({r["market"] for r in seed_rows}))
    check("seed debt repaid, $ thousand", 1.0, round(sum(r["repaid_usd"] for r in seed_rows) / 1000, 1))
    check("organic liquidations", 33, len(organic))
    check("organic borrowers", 15, len({r["borrower"] for r in organic}))
    check("organic debt repaid, $ thousand", 30.6, round(organic_usd / 1000, 1))

    first = [r for r in organic if session(r["ts"]) == "regular" and minutes_since_open(r["ts"]) < 90]
    after_closed_day = [r for r in first if follows_a_closed_day(r["ts"])]
    first_usd = sum(r["repaid_usd"] for r in first)
    after_usd = sum(r["repaid_usd"] for r in after_closed_day)
    check("organic dollars in the first 90 minutes after the regular open, %", 81, round(100 * first_usd / organic_usd))
    check("the same, $ thousand", 24.8, round(first_usd / 1000, 1))
    check("organic dollars in the first 90 minutes after a weekend or holiday, %", 59, round(100 * after_usd / organic_usd))
    check("the same, $ thousand", 17.9, round(after_usd / 1000, 1))

    closed = [r for r, s in zip(stock, sessions) if s in CLOSED]
    check("liquidations while the market was closed", 87, len(closed))
    check("share of liquidations while closed, by count, %", 72.5, pct(len(closed) / len(stock)))
    check("share of liquidations while closed, by dollars, %", 14.5, pct(sum(r["repaid_usd"] for r in closed) / usd))
    grid = collections.Counter(session(t) for t in range(rows[0]["ts"] - rows[0]["ts"] % 600, max(r["ts"] for r in rows), 600))
    total = sum(grid.values())
    check("share of the sample period the market was closed, %", 81.6, pct(1 - grid["regular"] / total))
    check("regular session, hours of the 168-hour week", 32.5, 5 * 6.5)
    check("share of an ordinary week the market is closed, % (rounded)", 81, round(100 * (1 - 32.5 / 168)))
    check("liquidations in the overnight session", 49, sessions.count("overnight"))
    check("overnight share of liquidations, %", 40.8, pct(sessions.count("overnight") / len(stock)))
    check("overnight share of time, %", 22.7, pct(grid["overnight"] / total))
    check("overnight over-representation, times", 1.8, round(sessions.count("overnight") / len(stock) / (grid["overnight"] / total), 1))
    check("weekend share of time, %", 29.0, pct(grid["weekend"] / total))

    confirmed = [r for r in closed if "next_open_vs_liq" in r]
    below = [r for r in confirmed if r["next_open_vs_liq"] > 0.03]
    check("closed-session liquidations priced more than 3% under the next regular open", "17 of 87", f"{len(below)} of {len(confirmed)}")
    check("debt repaid in those, $", 379, round(sum(r["repaid_usd"] for r in below)))

    headline = load(DATA / "liq_headline.json")
    check("liq_headline.json agrees (n, dollars, closed count)", True,
          headline["n"] == len(stock) and abs(headline["usd"] - usd) < 1e-6 and headline["closed_n"] == len(closed) and "weekend" not in headline["by_session"])
    stored = load(DATA / "liq_organic.json")
    check("liq_organic.json agrees (seed count, organic transactions)", True,
          stored["seed"]["n"] == len(seed_rows) and [r["tx"] for r in stored["organic"]] == [r["tx"] for r in organic])

    other = load(DATA / "liquidations_moolah_other.json")
    other_weekend = sum(session(r["ts"]) == "weekend" for r in other)
    check("control: Moolah liquidations in markets without a bStock", 152, len(other))
    check("control: of them on a weekend", 18, other_weekend)
    check("control: weekend share, %", 12, round(100 * other_weekend / len(other)))


# ----------------------------------------------------------------- closures

def closures():
    windows = load(ROOT / "data" / "closure-windows.json")
    kinds = collections.Counter(r["type"] for r in windows)
    check("closures in the dataset", 3378, len(windows))
    check("bStocks in the dataset", 77, len({r["sym"] for r in windows}))
    check("overnight / weekend / long weekend or holiday", "2688 / 597 / 93", f"{kinds['overnight']} / {kinds['weekend']} / {kinds['long_weekend_holiday']}")

    top = [r for r in windows if r["sym"] in TOP20 and r["type"] in ("weekend", "long_weekend_holiday")]
    excursion = [max(abs(r["max_up"]), abs(r["max_dn"])) for r in top]
    phantom = [max(0, 1 - (1 + r["max_dn"]) / min(1, 1 + r["gap"])) for r in top]
    check("weekends of the 20 most-held names, long weekends included", 246, len(top))
    check("of them with the token more than 3% from Friday's close, %", 37.4, pct(sum(e > 0.03 for e in excursion) / len(top)))
    check("more than 5%, %", 17.5, pct(sum(e > 0.05 for e in excursion) / len(top)))
    check("with the token more than 3% under both Friday's close and Monday's open, %", 2.4, pct(sum(p > 0.03 for p in phantom) / len(top)))
    stats = load(DATA / "weekend_stats.json")["TOP20|weekend+long_weekend_holiday"]
    check("weekend_stats.json agrees", True, stats["n"] == len(top) and abs(stats["exc_gt3"] - sum(e > 0.03 for e in excursion) / len(top)) < 1e-12)

    points = load(DATA / "weekend_timing_points.json")
    summary = load(DATA / "weekend_timing.json")
    labels = {"sat00": "Sat00Z (Fri 20:00 ET, post-mkt end)", "sat12": "Sat12Z", "sun12": "Sun12Z",
              "mon00": "Mon00Z (Sun 20:00 ET, overnight ATS opens)", "mon08": "Mon08Z (04:00 ET pre-mkt)", "mon13": "Mon13Z (09:00 ET)"}
    fits = {}
    agrees = True
    for group, keep in (("ALL", lambda p: True), ("TOP20", lambda p: p["sym"] in TOP20)):
        for key, label in labels.items():
            pairs = [(p[key], p["gap"]) for p in points if keep(p) and p[key] is not None]
            xs, ys = [a for a, _ in pairs], [b for _, b in pairs]
            fit = {"n": len(xs), "corr": round(corr(xs, ys), 3), "r2": round(r2(xs, ys), 3),
                   "mae_bps": round(statistics.mean(abs(a - b) for a, b in pairs) * 1e4), "naive_mae_bps": round(statistics.mean(abs(b) for b in ys) * 1e4)}
            fits[group, key] = fit
            agrees = agrees and fit == summary[group][label]
    check("ordinary weekends, all bStocks / the 20 most-held", "597 / 207", f"{fits['ALL', 'mon13']['n']} / {fits['TOP20', 'mon13']['n']}")
    check("R2 of the token against Monday's gap: Sat 00:00, Sat 12:00, Sun 12:00 UTC", "0.049, -0.021, 0.185",
          ", ".join(str(fits["ALL", k]["r2"]) for k in ("sat00", "sat12", "sun12")))
    check("largest R2 before the overnight venues reopen is at most 0.2", True, max(fits["ALL", k]["r2"] for k in ("sat00", "sat12", "sun12")) <= 0.2)
    check("R2 when they reopen (Mon 00:00 UTC), all / top 20", "0.203 / 0.144", f"{fits['ALL', 'mon00']['r2']} / {fits['TOP20', 'mon00']['r2']}")
    check("R2 at 04:00 New York time (Mon 08:00 UTC)", 0.637, fits["ALL", "mon08"]["r2"])
    check("R2 at 09:00 New York time (Mon 13:00 UTC), all / top 20", "0.94 / 0.95", f"{round(fits['ALL', 'mon13']['r2'], 2)} / {round(fits['TOP20', 'mon13']['r2'], 2)}")
    check("correlation at 09:00 New York time, all bStocks", 0.97, round(fits["ALL", "mon13"]["corr"], 2))
    check("mean absolute error at 09:00 against assuming no move, bps", "62 vs 255", f"{fits['ALL', 'mon13']['mae_bps']} vs {fits['ALL', 'mon13']['naive_mae_bps']}")
    check("weekend_timing.json agrees at all six moments, both groups", True, agrees)


# --------------------------------------------------------------------- gaps

def gaps():
    by_ticker = collections.defaultdict(list)
    with open(DATA / "gap_windows.csv", encoding="ascii") as f:
        for r in csv.DictReader(f):
            by_ticker[r["ticker"]].append((r["d1"], int(r["days"]), float(r["gap"]), r["class"]))

    pooled = collections.defaultdict(list)
    pooled_tickers = []
    per_ticker = {}
    for ticker, rows in by_ticker.items():
        first = dt.date.fromisoformat(rows[0][0]) - dt.timedelta(days=rows[0][1])
        years = (dt.date.fromisoformat(rows[-1][0]) - first).days / 365.25
        classes = collections.defaultdict(list)
        for _d1, _days, gap, code in rows:
            if code in GAP_CLASSES:
                classes[GAP_CLASSES[code]].append(gap)
        per_ticker[ticker] = {k: round(quantile([max(0, -g) * 1e4 for g in v], 0.99)) for k, v in classes.items()}
        if years >= 5 and ticker not in LEVERAGED:
            pooled_tickers.append(ticker)
            for k, v in classes.items():
                pooled[k] += v

    order = ["weekday_overnight", "weekend", "holiday_or_long_weekend", "earnings"]
    p99 = {k: quantile([max(0, -g) * 1e4 for g in pooled[k]], 0.99) for k in order}
    check("tickers pooled (5 years or more of history, no 3x ETFs)", 36, len(pooled_tickers))
    check("pooled closures: overnight / weekend / holiday / earnings", "42678 / 9997 / 2160 / 788", " / ".join(str(len(pooled[k])) for k in order))
    check("pooled p99 down-gap, bps", "442 / 547 / 427 / 1795", " / ".join(str(round(p99[k])) for k in order))
    check("pooled p99 down-gap, %", "4.4 / 5.5 / 4.3 / 17.9", " / ".join(str(round(p99[k] / 100, 1)) for k in order))

    table = load(DATA / "gap_quantiles.json")
    stored_pool = {r["window"]: r["down_p99_bps"] for r in table["rows"] if r["ticker"] == "POOLED_5Y+"}
    stored_ticker = collections.defaultdict(dict)
    for r in table["rows"]:
        if r["ticker"] != "POOLED_5Y+":
            stored_ticker[r["ticker"]][r["window"]] = r["down_p99_bps"]
    check("gap_quantiles.json agrees (pooled rows, every ticker, the pooled ticker list)", True,
          stored_pool == {k: round(p99[k]) for k in order} and dict(stored_ticker) == per_ticker and table["meta"]["pooled_tickers"] == pooled_tickers)

    config = load(ROOT / "config" / "bsc-mainnet.json")
    names = {"overnight": "weekday_overnight", "weekend": "weekend", "holiday": "holiday_or_long_weekend", "earnings": "earnings"}
    differing = []
    for t in config["tickers"]:
        for key, kind in names.items():
            if t["gapBps"][key] != per_ticker.get(t["symbol"], {}).get(kind, 0):
                differing.append(f"{t['symbol']} {key}: config {t['gapBps'][key]}, study {per_ticker.get(t['symbol'], {}).get(kind, 0)}")
    check("gap buffers in config/bsc-mainnet.json that differ from the per-ticker p99 of the study", "none", "; ".join(differing) or "none")


# -------------------------------------------------------------------- venus

def venus():
    v = load(DATA / "venus_seizures.json")
    check("Venus: Transfer logs of the four bStock vTokens", 1114, v["transfer_logs"], "recorded")
    check("Venus: transfers that are neither mint nor redeem / their transactions", "47 / 28", f"{v['candidate_transfers']} / {v['candidate_transactions']}", "recorded")
    check("Venus: of those transactions, with a LiquidateBorrow event", 0, len(v["transactions_with_liquidate_borrow"]), "recorded")


def main():
    for part in (liquidations, closures, gaps, venus):
        part()
    width = max(len(name) for name, *_ in results)
    failed = 0
    for name, documented, got, source in results:
        ok = documented == got
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'}  {name:{width}s}  documented {documented!s:>26}  {source} {got!s}")
    print(f"\n{len(results) - failed} of {len(results)} figures match" + ("" if not failed else f", {failed} differ"))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
