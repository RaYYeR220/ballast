"""Paths, JSON helpers and a small JSON-RPC client shared by the research scripts.

Network scripts need `requests` (see requirements.txt). The archive node is taken from the
ARCHIVE_RPC_URL environment variable; nothing in this directory carries an endpoint or a key.
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"    # committed inputs and results
CACHE = HERE / "cache"  # raw downloads and intermediate files, not committed
CLOSURE_WINDOWS = HERE.parent / "data" / "closure-windows.json"  # shared with the backtest

MOOLAH = "0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c"

# keccak256 of the event signatures
TOPIC_LIQUIDATE = "0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41"  # Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)
TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"  # Transfer(address,address,uint256)
TOPIC_LIQUIDATE_BORROW = "0x298637f684da70674f26509b10f07ec2fbc77a335ab1e7d6215a4b2484d8bb52"  # LiquidateBorrow(address,address,uint256,address,uint256)
SELECTOR_ID_TO_MARKET_PARAMS = "0x2c3c9157"  # idToMarketParams(bytes32)

# Venus vTokens whose underlying is a bStock
VENUS_BSTOCK_VTOKENS = {
    "0x97421799419eb782628e73e7220d8e0a207469a3": "TSLAB",
    "0xeb8ca841cbe1bc4832a10b15c7dab1081edad371": "NVDAB",
    "0xc36dfacc7a125859c106f29b9f2d874ccf29a55a": "SPCXB",
    "0x3e281461efb3d53ec20db207674373ed8ef3bba9": "SKHYB",
}

STABLECOINS = {
    "0x55d398326f99059ff775485246999027b3197955": "USDT",
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
    "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": "USD1",
    "0xce24439f2d9c6a2289f741120fe202248b666666": "U",
}

# The sample: every block from before the first bStock listing to the day the study was run.
FROM_BLOCK = 101_500_000  # 2026-05-31
TO_BLOCK = 123_963_563    # 2026-09-25


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(path, obj, indent=1):
    """Writes JSON with LF line endings on every platform."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="ascii", newline="\n") as f:
        json.dump(obj, f, indent=indent)


def archive_rpc_url():
    url = os.environ.get("ARCHIVE_RPC_URL")
    if not url:
        sys.exit("set ARCHIVE_RPC_URL to a BSC archive node (historical eth_getLogs over 50,000-block ranges)")
    return url


def rpc(session, method, params, tries=12):
    """One JSON-RPC call, patient with a rate-limited endpoint. Returns the result, or None when every attempt failed."""
    url = archive_rpc_url()
    for attempt in range(tries):
        try:
            answer = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30).json()
            if "result" in answer:
                return answer["result"]
        except Exception:
            pass
        time.sleep(min(30, 3 * (attempt + 1)))
    return None
