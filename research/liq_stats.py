"""Step 7. Session shares of the bStock-collateral liquidations, and the organic subset.

    python liq_stats.py

Needs: nothing (no network, standard library only).
Reads: data/liquidations_moolah_bstock_ctx.json.
Writes: data/liq_headline.json and data/liq_organic.json, and prints the tables.

Seed account: one borrower was liquidated dozens of times for a few dollars each, in positions
opened at the liquidation threshold across many markets. Those liquidations show when the oracle
crossed a threshold; they are not anybody's loss. An account counts as a seed account when it has
at least 20 liquidations with a median repaid amount under $50. Everything else is organic.

Timing of an organic liquidation in the regular session:
    first 90 min                         less than 90 minutes after 09:30 New York time
    first 90 min after weekend/holiday   the same, when the calendar day before was not a trading day
    later                                the rest of the regular session
"""
import collections
import statistics

from common import DATA, dump, load
from session import follows_a_closed_day, minutes_since_open, session

CLOSED = {"pre", "post", "overnight", "weekend", "holiday"}
ORDER = ["regular", "pre", "post", "overnight", "weekend", "holiday"]
SEED_MIN_LIQUIDATIONS = 20
SEED_MAX_MEDIAN_USD = 50
FIRST_MINUTES = 90


def seed_accounts(rows):
    by_borrower = collections.defaultdict(list)
    for r in rows:
        by_borrower[r["borrower"]].append(r["repaid_usd"])
    return {b for b, usd in by_borrower.items() if len(usd) >= SEED_MIN_LIQUIDATIONS and statistics.median(usd) < SEED_MAX_MEDIAN_USD}


def timing(row):
    if row["session"] != "regular":
        return row["session"]
    if minutes_since_open(row["ts"]) >= FIRST_MINUTES:
        return "regular: later"
    if follows_a_closed_day(row["ts"]):
        return "regular: first 90 min after weekend/holiday"
    return "regular: first 90 min"


def time_shares(first_ts, last_ts):
    """Share of wall-clock time in each session between two timestamps, on a 10-minute grid."""
    count = collections.Counter(session(t) for t in range(first_ts - first_ts % 600, last_ts, 600))
    total = sum(count.values())
    return {k: v / total for k, v in count.items()}


def main():
    rows = load(DATA / "liquidations_moolah_bstock_ctx.json")
    stock = [r for r in rows if r["kind"] == "stock-collateral"]

    base = time_shares(min(r["ts"] for r in rows), max(r["ts"] for r in rows))
    by_session = collections.defaultdict(lambda: [0, 0.0, 0.0])  # count, repaid USD, seized USD
    for r in stock:
        s = by_session[r["session"]]
        s[0] += 1
        s[1] += r["repaid_usd"]
        s[2] += r["seized_usd"]
    n = len(stock)
    usd = sum(r["repaid_usd"] for r in stock)
    closed_n = sum(v[0] for k, v in by_session.items() if k in CLOSED)
    closed_usd = sum(v[1] for k, v in by_session.items() if k in CLOSED)
    dump(DATA / "liq_headline.json", {"base": base, "by_session": dict(by_session), "n": n, "usd": usd, "closed_n": closed_n, "closed_usd": closed_usd})

    print(f"bStock-collateral liquidations: {n}, repaid ${usd:,.0f}, seized ${sum(r['seized_usd'] for r in stock):,.0f}, bad debt ${sum(r['bad_debt_usd'] for r in stock):,.0f}")
    print(f"market closed: {closed_n} ({closed_n / n:.1%}) by count, ${closed_usd:,.0f} ({closed_usd / usd:.1%}) by dollars; the market is closed {1 - base.get('regular', 0):.1%} of the time")
    for k in ORDER:
        count, repaid, _seized = by_session.get(k, [0, 0.0, 0.0])
        print(f"  {k:10s} n={count:4d} ({count / n:5.1%})  repaid=${repaid:>9,.0f} ({repaid / usd:5.1%})  share of time={base.get(k, 0):5.1%}")

    closed = [r for r in stock if r["session"] in CLOSED and "next_open_vs_liq" in r]
    above3 = [r for r in closed if r["next_open_vs_liq"] > 0.03]
    above5 = [r for r in closed if r["next_open_vs_liq"] > 0.05]
    low_above = [r for r in closed if r["next_day_low_vs_liq"] > 0.0]
    print(f"closed-session liquidations with the next regular open more than 3% above the liquidation price: {len(above3)} of {len(closed)} (${sum(r['repaid_usd'] for r in above3):,.0f}); more than 5%: {len(above5)} (${sum(r['repaid_usd'] for r in above5):,.0f})")
    print(f"closed-session liquidations where the whole next regular session stayed above the liquidation price: {len(low_above)} of {len(closed)} (${sum(r['repaid_usd'] for r in low_above):,.0f})")

    seeds = seed_accounts(stock)
    seed_rows = [r for r in stock if r["borrower"] in seeds]
    organic = [r for r in stock if r["borrower"] not in seeds]
    tagged = []
    for r in organic:
        tagged.append({
            "time_utc": r["time_utc"],
            "et": r["et"],
            "session": r["session"],
            "tag": timing(r),
            "collateral": r["collateral"],
            "loan": r["loan"],
            "lltv": r["lltv"],
            "repaid_usd": round(r["repaid_usd"], 2),
            "seized_usd": round(r["seized_usd"], 2),
            "bad_debt_usd": round(r["bad_debt_usd"], 2),
            "tx": r["tx"],
            "borrower": r["borrower"],
            "liquidator": r["liquidator"],
            "next_open_vs_liq": r.get("next_open_vs_liq"),
        })
    dump(DATA / "liq_organic.json", {"seed": {"n": len(seed_rows), "usd": sum(r["repaid_usd"] for r in seed_rows)}, "organic": tagged})

    organic_usd = sum(r["repaid_usd"] for r in organic)
    print(f"seed accounts: {len(seeds)}, {len(seed_rows)} liquidations in {len({r['market'] for r in seed_rows})} markets, ${sum(r['repaid_usd'] for r in seed_rows):,.0f} repaid, ${min(r['repaid_usd'] for r in seed_rows):.0f} to ${max(r['repaid_usd'] for r in seed_rows):.0f} each")
    print(f"organic: {len(organic)} liquidations of {len({r['borrower'] for r in organic})} borrowers, ${organic_usd:,.0f} repaid")
    by_tag = collections.defaultdict(lambda: [0, 0.0])
    for r in organic:
        t = by_tag[timing(r)]
        t[0] += 1
        t[1] += r["repaid_usd"]
    for tag, (count, repaid) in sorted(by_tag.items(), key=lambda kv: -kv[1][1]):
        print(f"  {tag:45s} n={count:2d}  ${repaid:>9,.0f} ({repaid / organic_usd:5.1%})")
    first = sum(v[1] for k, v in by_tag.items() if k.startswith("regular: first 90 min"))
    print(f"organic dollars in the first {FIRST_MINUTES} minutes after a regular open: ${first:,.0f} ({first / organic_usd:.1%})")


if __name__ == "__main__":
    main()
