"""Step 4. Downloads earnings dates for the gap-study tickers from the Nasdaq earnings calendar.

    python fetch_earnings.py

Needs: `requests`. No key: https://api.nasdaq.com/api/calendar/earnings is public but wants a
browser User-Agent. One request per weekday from 2020-06-01 to 2026-10-31, about 1,650 in all.
Reads: data/tickers.json. Writes: cache/earn/earn_rows.jsonl and cache/earn/done.txt (the days
already fetched, so a run can be resumed).

The calendar does not say whether a company reported before the open or after the close for past
dates. gaps.py deals with that.
"""
import datetime as dt
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from common import CACHE, DATA, load

FIRST_DAY = dt.date(2020, 6, 1)
LAST_DAY = dt.date(2026, 10, 31)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "application/json",
}


def main():
    tickers = set(load(DATA / "tickers.json"))
    out_dir = CACHE / "earn"
    out_dir.mkdir(parents=True, exist_ok=True)
    done_file = out_dir / "done.txt"
    done = set(done_file.read_text().split()) if done_file.exists() else set()

    days = []
    day = FIRST_DAY
    while day <= LAST_DAY:
        if day.weekday() < 5 and day.isoformat() not in done:
            days.append(day.isoformat())
        day += dt.timedelta(days=1)

    lock = threading.Lock()
    failed = []
    with open(out_dir / "earn_rows.jsonl", "a", encoding="ascii", newline="\n") as rows_out, open(done_file, "a", encoding="ascii", newline="\n") as done_out:

        def fetch(date):
            http = requests.Session()
            http.headers.update(HEADERS)
            for attempt in range(4):
                try:
                    answer = http.get(f"https://api.nasdaq.com/api/calendar/earnings?date={date}", timeout=30).json()
                    rows = (answer.get("data") or {}).get("rows") or []
                    with lock:
                        for row in rows:
                            if row.get("symbol") in tickers:
                                rows_out.write(json.dumps({"date": date, "symbol": row["symbol"], "time": row.get("time")}) + "\n")
                        rows_out.flush()
                        done_out.write(date + "\n")
                        done_out.flush()
                    return
                except Exception:
                    time.sleep(3 * (attempt + 1))
            failed.append(date)

        with ThreadPoolExecutor(5) as pool:
            list(pool.map(fetch, days))
    print("fetched", len(days) - len(failed), "days; failed:", failed[:10])


if __name__ == "__main__":
    main()
