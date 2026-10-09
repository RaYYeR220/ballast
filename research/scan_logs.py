"""Step 1. Downloads the raw event logs of the study from a BSC archive node.

    python scan_logs.py liq      Liquidate events of Lista Lending (Moolah), every market
    python scan_logs.py venus    Transfer events of the four Venus vTokens backed by a bStock

    optional: python scan_logs.py <mode> <from_block> <to_block>

Needs: ARCHIVE_RPC_URL (eth_getLogs over history, ranges of up to 50,000 blocks) and `requests`.
Writes: cache/logs_<mode>.jsonl, one log per line. It resumes from cache/scan_<mode>_state.json,
so a throttled or interrupted run can simply be started again.

One address and one topic per request is what a public archive endpoint answers quickly. On a
timeout the block range is halved and grows back afterwards.
"""
import json
import sys
import time

import requests

from common import CACHE, FROM_BLOCK, MOOLAH, TO_BLOCK, TOPIC_LIQUIDATE, TOPIC_TRANSFER, VENUS_BSTOCK_VTOKENS, archive_rpc_url, load

MAX_RANGE = 49_999
MIN_RANGE = 2_000

FILTERS = {
    "liq": {"address": MOOLAH, "topics": [TOPIC_LIQUIDATE]},
    "venus": {"address": sorted(VENUS_BSTOCK_VTOKENS), "topics": [TOPIC_TRANSFER]},
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in FILTERS:
        sys.exit(__doc__)
    mode = sys.argv[1]
    start = int(sys.argv[2]) if len(sys.argv) > 2 else FROM_BLOCK
    stop = int(sys.argv[3]) if len(sys.argv) > 3 else TO_BLOCK
    url = archive_rpc_url()

    CACHE.mkdir(exist_ok=True)
    state_file = CACHE / f"scan_{mode}_state.json"
    block = load(state_file)["next"] if state_file.exists() else start
    http = requests.Session()
    step = MAX_RANGE
    chunks = 0
    with open(CACHE / f"logs_{mode}.jsonl", "a", encoding="ascii", newline="\n") as out:
        while block <= stop:
            end = min(block + step, stop)
            log_filter = dict(FILTERS[mode], fromBlock=hex(block), toBlock=hex(end))
            try:
                answer = http.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [log_filter]}, timeout=30).json()
            except Exception as err:
                answer = {"error": {"message": f"client {str(err)[:80]}"}}
            if "result" not in answer:
                message = json.dumps(answer.get("error"))
                print(f"  {block}-{end}: {message[:160]}", flush=True)
                if "timeout" in message.lower() or "client" in message.lower():
                    step = max(MIN_RANGE, step // 2)
                time.sleep(8 if "maximum" in message else 2)  # "maximum API usage" is the public rate limit
                continue
            for log in answer["result"]:
                row = {
                    "b": int(log["blockNumber"], 16),
                    "tx": log["transactionHash"],
                    "li": int(log["logIndex"], 16),
                    "a": log["address"].lower(),
                    "t": log["topics"],
                    "d": log["data"],
                }
                out.write(json.dumps(row) + "\n")
            out.flush()
            block = end + 1
            chunks += 1
            state_file.with_suffix(".tmp").write_text(json.dumps({"next": block, "stop": stop}), encoding="ascii")
            state_file.with_suffix(".tmp").replace(state_file)  # atomic: an interrupted run never leaves half a state file
            step = min(MAX_RANGE, step * 2)
            if chunks % 20 == 0:
                print(time.strftime("%H:%M:%S"), block, stop, flush=True)
            time.sleep(0.4)
    print("done", mode, start, stop)


if __name__ == "__main__":
    main()
