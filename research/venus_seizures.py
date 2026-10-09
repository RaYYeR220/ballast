"""Step 12. Did Venus ever seize bStock collateral in a liquidation?

    python venus_seizures.py

Needs: ARCHIVE_RPC_URL and `requests` (one transaction receipt per candidate).
Reads: cache/logs_venus.jsonl (scan_logs.py venus).
Writes: data/venus_seizures.json.

A Venus liquidation moves the seized vTokens from the borrower to the liquidator, so it shows up as
a Transfer of the collateral vToken that is neither a mint nor a redeem (those go from or to the
vToken contract itself). Every such transfer of the four bStock vTokens is a candidate. The
LiquidateBorrow event is emitted by the vToken of the repaid debt, a different contract, so each
candidate transaction's receipt is searched for it.
"""
import json

import requests

from common import CACHE, DATA, FROM_BLOCK, TOPIC_LIQUIDATE_BORROW, TOPIC_TRANSFER, VENUS_BSTOCK_VTOKENS, dump, load, rpc

ZERO = "0x" + "0" * 40


def main():
    state = load(CACHE / "scan_venus_state.json")
    if state["next"] <= state["stop"]:
        raise SystemExit("the venus scan has not finished: run `python scan_logs.py venus` again")

    seen = set()
    transfers = []
    with open(CACHE / "logs_venus.jsonl", encoding="ascii") as f:
        for line in f:
            log = json.loads(line)
            key = (log["tx"], log["li"])
            if key in seen or log["a"] not in VENUS_BSTOCK_VTOKENS or log["t"][0] != TOPIC_TRANSFER:
                continue
            seen.add(key)
            transfers.append(log)

    candidates = []
    for log in transfers:
        sender = "0x" + log["t"][1][-40:]
        receiver = "0x" + log["t"][2][-40:]
        if log["a"] in (sender, receiver) or ZERO in (sender, receiver):
            continue  # mint or redeem
        candidates.append(log)
    txs = sorted({log["tx"] for log in candidates})

    http = requests.Session()
    with_liquidation = []
    for tx in txs:
        receipt = rpc(http, "eth_getTransactionReceipt", [tx])
        if receipt is None:
            raise SystemExit(f"no receipt for {tx}: check ARCHIVE_RPC_URL")
        if any(log["topics"] and log["topics"][0] == TOPIC_LIQUIDATE_BORROW for log in receipt["logs"]):
            with_liquidation.append(tx)

    result = {
        "from_block": FROM_BLOCK,
        "to_block": state["stop"],
        "vtokens": sorted(VENUS_BSTOCK_VTOKENS.values()),
        "transfer_logs": len(transfers),
        "candidate_transfers": len(candidates),
        "candidate_transactions": len(txs),
        "transactions_with_liquidate_borrow": with_liquidation,
    }
    dump(DATA / "venus_seizures.json", result)
    print(result)


if __name__ == "__main__":
    main()
