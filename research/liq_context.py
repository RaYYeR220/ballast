"""Step 6. Adds market context to each bStock-collateral liquidation: was the price confirmed?

    python liq_context.py

Needs: nothing but the cache (no network).
Reads: cache/liquidations_moolah_bstock.json (liq_analysis.py), cache/kl/ (fetch_klines.py),
       cache/yd/ (fetch_yahoo.py), data/bstocks.json.
Writes: data/liquidations_moolah_bstock_ctx.json.

Every bStock-collateral row gets `liq_px`, the Binance 1h close of the collateral in the hour of the
liquidation. A row outside the regular session also gets the next regular open and that day's low
of the underlying, both relative to `liq_px`, and `liq_px` relative to the previous regular close.
A liquidation at a price well below the next open is one the stock market never confirmed.
"""
import csv
import datetime as dt

from common import CACHE, DATA, dump, load

UTC = dt.timezone.utc


def main():
    rows = load(CACHE / "liquidations_moolah_bstock.json")
    underlying = {v["symbol"]: v["underlying"] for v in load(DATA / "bstocks.json").values()}

    daily = {}

    def days(ticker):
        if ticker not in daily:
            daily[ticker] = []
            try:
                with open(CACHE / "yd" / f"{ticker}.csv", encoding="ascii") as f:
                    for r in csv.DictReader(f):
                        daily[ticker].append((r["date"], float(r["o"]), float(r["l"]), float(r["c"])))
            except FileNotFoundError:
                pass
        return daily[ticker]

    def at(date, hour, minute):
        year, month, day = map(int, date.split("-"))
        return dt.datetime(year, month, day, hour, minute, tzinfo=UTC).timestamp()

    def next_open(ticker, ts):
        """First regular session opening at or after `ts`: (date, open, low). The sample is all EDT: 09:30 is 13:30 UTC."""
        for date, o, l, _c in days(ticker):
            if at(date, 13, 30) >= ts:
                return date, o, l
        return None

    def previous_close(ticker, ts):
        """Last regular session closed at or before `ts`: (date, close). 16:00 EDT is 20:00 UTC."""
        best = None
        for date, _o, _l, c in days(ticker):
            if at(date, 20, 0) <= ts:
                best = (date, c)
        return best

    klines = {}

    def candle(symbol, ts):
        if symbol not in klines:
            with open(CACHE / "kl" / f"{symbol}.csv", encoding="ascii") as f:
                klines[symbol] = {int(r["t"]) // 1000: (float(r["l"]), float(r["c"])) for r in csv.DictReader(f)}
        return klines[symbol].get(ts - ts % 3600)

    for r in rows:
        if r["kind"] != "stock-collateral":
            continue
        ticker = underlying[r["collateral"]]
        k = candle(r["collateral"], r["ts"])
        r["liq_px"] = k[1] if k else None
        if r["session"] == "regular":
            continue
        opening = next_open(ticker, r["ts"])
        closing = previous_close(ticker, r["ts"])
        if opening and k:
            r["next_open_date"], r["next_open"], r["next_low"] = opening
            r["next_open_vs_liq"] = opening[1] / k[1] - 1
            r["next_day_low_vs_liq"] = opening[2] / k[1] - 1
        if closing and k:
            r["liq_vs_prev_close"] = k[1] / closing[1] - 1
    dump(DATA / "liquidations_moolah_bstock_ctx.json", rows)
    print("wrote", len(rows), "rows")


if __name__ == "__main__":
    main()
