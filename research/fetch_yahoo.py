"""Step 3. Downloads daily regular-session prices of the underlying stocks from Yahoo Finance.

    python fetch_yahoo.py

Needs: `requests`. No key: the v8 chart endpoint is public but wants a browser User-Agent.
Reads: data/bstocks.json (underlyings of the bStocks) and data/tickers.json (the gap study).
Writes: cache/yd/<TICKER>.csv (t,date,o,h,l,c,v,div) and cache/yd/<TICKER>.splits.json.

Open, high, low and close are split-adjusted and not dividend-adjusted. `div` is the cash dividend
that goes ex on that date, so a close-to-open gap can be measured net of it.
"""
import datetime as dt
import json
import time

import requests

from common import CACHE, DATA, load

PERIOD_START = 1451606400  # 2016-01-01
PERIOD_END = 1790400000    # 2026-09-26, just past the sample


def local_date(ts, gmt_offset):
    return dt.datetime.fromtimestamp(ts + gmt_offset, dt.timezone.utc).date().isoformat()


def main():
    tickers = sorted({v["underlying"] for v in load(DATA / "bstocks.json").values()} | set(load(DATA / "tickers.json")))
    out_dir = CACHE / "yd"
    out_dir.mkdir(parents=True, exist_ok=True)
    http = requests.Session()
    http.headers["User-Agent"] = "Mozilla/5.0"
    failed = []
    for ticker in tickers:
        path = out_dir / f"{ticker}.csv"
        if path.exists():
            continue
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&period1={PERIOD_START}&period2={PERIOD_END}&events=div,split"
        answer = None
        for _ in range(4):
            try:
                answer = http.get(url, timeout=30).json()
                break
            except Exception:
                time.sleep(3)
        try:
            result = answer["chart"]["result"][0]
        except Exception:
            failed.append(ticker)
            print(ticker, "no data:", json.dumps(answer)[:200] if answer else "no answer")
            continue
        stamps = result.get("timestamp") or []
        quote = result["indicators"]["quote"][0]
        offset = result["meta"].get("gmtoffset") or 0
        events = result.get("events", {})
        dividends = {local_date(int(k), offset): v["amount"] for k, v in (events.get("dividends") or {}).items()}
        with open(path, "w", encoding="ascii", newline="\n") as f:
            f.write("t,date,o,h,l,c,v,div\n")
            for i, ts in enumerate(stamps):
                o, h, l, c, v = (quote[k][i] for k in ("open", "high", "low", "close", "volume"))
                if o is None or c is None:  # Yahoo leaves holes
                    continue
                date = local_date(ts, offset)
                f.write(f"{ts},{date},{o},{h},{l},{c},{v},{dividends.get(date, 0.0)}\n")
        with open(out_dir / f"{ticker}.splits.json", "w", encoding="ascii", newline="\n") as f:
            json.dump(events.get("splits") or {}, f)
        print(ticker, len(stamps), flush=True)
        time.sleep(0.3)
    print("failed:", failed)


if __name__ == "__main__":
    main()
