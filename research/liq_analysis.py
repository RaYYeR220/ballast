"""Step 5. Turns the raw Moolah logs into one row per liquidation that involves a bStock.

    python liq_analysis.py

Needs: ARCHIVE_RPC_URL and `requests` (block timestamps, and market parameters not yet in the cache).
Reads: cache/logs_liq.jsonl (scan_logs.py liq), cache/kl/ (fetch_klines.py), data/bstocks.json,
       data/market_params.json.
Writes: cache/liquidations_moolah_bstock.json, data/liquidations_moolah_other.json,
        data/market_params.json, cache/block_ts.json.

A liquidation goes to the bStock file when the market's collateral or its loan token is a bStock.
Amounts are 18-decimal tokens. Stablecoin loans count as $1; a bStock amount is valued at the
Binance 1h close of the hour of the liquidation (the hour before if that candle is missing).

Every other Moolah liquidation of the same scan goes to liquidations_moolah_other.json with its
time and session only. It is the control group: the same oracle stack and the same liquidators,
on collateral that has no closing bell.
"""
import collections
import csv
import datetime as dt
import json

import requests

from common import CACHE, DATA, MOOLAH, SELECTOR_ID_TO_MARKET_PARAMS, STABLECOINS, TOPIC_LIQUIDATE, dump, load, rpc
from session import et_str, session

WORD = 64  # hex digits in one ABI word


def words(hex_data):
    body = hex_data[2:]
    return [int(body[i:i + WORD], 16) for i in range(0, len(body), WORD)]


def topic_address(topic):
    return "0x" + topic[-40:]


def utc_str(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def main():
    bstocks = load(DATA / "bstocks.json")
    http = requests.Session()

    seen = set()
    liquidations = []
    with open(CACHE / "logs_liq.jsonl", encoding="ascii") as f:
        for line in f:
            log = json.loads(line)
            key = (log["tx"], log["li"])
            if key in seen or log["a"] != MOOLAH or log["t"][0] != TOPIC_LIQUIDATE:
                continue
            seen.add(key)
            liquidations.append(log)
    liquidations.sort(key=lambda log: (log["b"], log["li"]))
    print("Moolah liquidations, all markets:", len(liquidations))

    params_file = DATA / "market_params.json"
    market_params = load(params_file) if params_file.exists() else {}
    for market in sorted({log["t"][1] for log in liquidations}):
        if market in market_params:
            continue
        answer = rpc(http, "eth_call", [{"to": MOOLAH, "data": SELECTOR_ID_TO_MARKET_PARAMS + market[2:]}, "latest"])
        if answer and len(answer) >= 2 + 5 * WORD:
            loan, coll, oracle, irm, lltv = words(answer)[:5]
            market_params[market] = {
                "loan": "0x%040x" % loan,
                "coll": "0x%040x" % coll,
                "oracle": "0x%040x" % oracle,
                "irm": "0x%040x" % irm,
                "lltv": lltv / 1e18,
            }
    dump(params_file, market_params, indent=None)

    ts_file = CACHE / "block_ts.json"
    block_ts = {int(k): v for k, v in load(ts_file).items()} if ts_file.exists() else {}

    def timestamp(block):
        if block not in block_ts:
            header = rpc(http, "eth_getBlockByNumber", [hex(block), False])
            if header is None:
                dump(ts_file, {str(k): v for k, v in block_ts.items()}, indent=None)  # keep what was fetched
                raise SystemExit(f"no header for block {block}: check ARCHIVE_RPC_URL, then run again")
            block_ts[block] = int(header["timestamp"], 16)
        return block_ts[block]

    klines = {}

    def price(symbol, ts):
        """Binance 1h close of the hour containing `ts`, else of the hour before, else None."""
        if symbol not in klines:
            try:
                with open(CACHE / "kl" / f"{symbol}.csv", encoding="ascii") as f:
                    klines[symbol] = {int(r["t"]) // 1000: float(r["c"]) for r in csv.DictReader(f)}
            except FileNotFoundError:
                klines[symbol] = {}
        hour = ts - ts % 3600
        return klines[symbol].get(hour) or klines[symbol].get(hour - 3600)

    def name(address):
        return bstocks[address]["symbol"] if address in bstocks else address

    rows = []
    others = []
    for log in liquidations:
        market = log["t"][1]
        params = market_params.get(market, {})
        coll, loan = params.get("coll"), params.get("loan")
        stock_collateral, stock_loan = coll in bstocks, loan in bstocks
        ts = timestamp(log["b"])
        if not (stock_collateral or stock_loan):
            others.append({"time_utc": utc_str(ts), "session": session(ts), "ts": ts, "tx": log["tx"], "block": log["b"], "market": market})
            continue
        repaid_assets, _repaid_shares, seized_assets, bad_debt_assets, _bad_debt_shares = words(log["d"])
        collateral_name = name(coll)
        loan_name = STABLECOINS.get(loan, name(loan))
        collateral_price = price(collateral_name, ts) if stock_collateral else 1.0
        loan_price = price(loan_name, ts) if stock_loan else 1.0
        rows.append({
            "time_utc": utc_str(ts),
            "et": et_str(ts),
            "session": session(ts),
            "ts": ts,
            "tx": log["tx"],
            "block": log["b"],
            "market": market,
            "collateral": collateral_name,
            "loan": loan_name,
            "lltv": params.get("lltv"),
            "borrower": topic_address(log["t"][3]),
            "liquidator": topic_address(log["t"][2]),
            "repaid": repaid_assets / 1e18,
            "seized": seized_assets / 1e18,
            "bad_debt": bad_debt_assets / 1e18,
            "repaid_usd": repaid_assets / 1e18 * (loan_price or 0),
            "seized_usd": seized_assets / 1e18 * (collateral_price or 0),
            "bad_debt_usd": bad_debt_assets / 1e18 * (loan_price or 0),
            "kind": "stock-collateral" if stock_collateral else "stock-loan",
        })
    dump(ts_file, {str(k): v for k, v in block_ts.items()}, indent=None)
    dump(CACHE / "liquidations_moolah_bstock.json", rows)
    dump(DATA / "liquidations_moolah_other.json", others)
    print("liquidations with a bStock as collateral or loan:", len(rows))
    print(collections.Counter((r["kind"], r["session"]) for r in rows))
    print("other Moolah liquidations:", len(others), collections.Counter(r["session"] for r in others))


if __name__ == "__main__":
    main()
