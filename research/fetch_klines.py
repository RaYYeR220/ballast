"""Step 2. Downloads Binance spot 1h klines for every bStock/USDT pair.

    python fetch_klines.py

Needs: `requests`. No key: https://api.binance.com/api/v3/klines is public.
Reads: data/bstocks.json. Writes: cache/kl/<SYMBOL>.csv (t,o,h,l,c,v,qv,n; t is the open time in ms).

The klines stand in for the lending oracle in this study: the feed the lenders read tracked the
Binance price within about 12 bps on the weekend we compared them. Binance quotes one share, the
same unit as the underlying stock.
"""
import time

import requests

from common import CACHE, DATA, load

START_MS = 1780272000000  # 2026-06-01 00:00 UTC, before the first bStock listing
END_MS = 1790380800000    # 2026-09-26 00:00 UTC, just past the sample
HOUR_MS = 3_600_000


def main():
    symbols = sorted(v["symbol"] for v in load(DATA / "bstocks.json").values())
    out_dir = CACHE / "kl"
    out_dir.mkdir(parents=True, exist_ok=True)
    http = requests.Session()
    errors = []
    for symbol in symbols:
        path = out_dir / f"{symbol}.csv"
        if path.exists():
            continue
        rows = []
        start = START_MS
        failures = 0
        while start < END_MS:
            url = f"https://api.binance.com/api/v3/klines?symbol={symbol}USDT&interval=1h&startTime={start}&endTime={END_MS - 1}&limit=1000"
            try:
                page = http.get(url, timeout=30).json()
            except Exception as err:
                failures += 1
                if failures > 5:
                    errors.append((symbol, str(err)[:100]))
                    break
                time.sleep(2)
                continue
            if not isinstance(page, list):  # an error object, e.g. an unknown symbol
                errors.append((symbol, str(page)[:200]))
                break
            if not page:
                break
            # open time, open, high, low, close, base volume, quote volume, trades
            rows += [(k[0], k[1], k[2], k[3], k[4], k[5], k[7], k[8]) for k in page]
            if len(page) < 1000:
                break
            start = page[-1][0] + HOUR_MS
            time.sleep(0.1)
        if rows:
            with open(path, "w", encoding="ascii", newline="\n") as f:
                f.write("t,o,h,l,c,v,qv,n\n")
                for row in rows:
                    f.write(",".join(str(v) for v in row) + "\n")
        print(symbol, len(rows), flush=True)
    print("errors:", errors)


if __name__ == "__main__":
    main()
