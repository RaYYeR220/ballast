# Review in five minutes

| Name | Value | Status |
|---|---|---|
| `APP_URL` | https://ballast-desk.vercel.app | live |
| `REPLAY_URL` | https://ballast-desk.vercel.app/judge | live |
| `DESK_API_URL` | https://34-185-146-173.sslip.io | live |
| `MCP_URL` | https://34-185-146-173.sslip.io/mcp | live |
| `REPO_URL` | https://github.com/RaYYeR220/ballast | public |
| `VIDEO_URL` | https://youtu.be/tlmdsj-TjeM | live, 3.5 minutes |

Mainnet addresses and transactions are not in this table. They are in [PROOF.md](PROOF.md), which is rendered from the deployment file and the transaction list and cannot show what is not in them.

The first three minutes need a browser and `curl`. Nothing has to be installed until minute 4.

## Minute 1: the site and the replay

Open https://ballast-desk.vercel.app, then https://ballast-desk.vercel.app/judge.

`/judge` plays one full cycle step by step: contracts, overlay, account, guard job, the shield before the close, a restore refused while New York is closed, the restore after the open, the settlement. Each step shows its transaction, the decoded result or revert, and the account after it.

It is a recording made on a fork of BNB Chain against the deployed contracts, with the clock moved and prices frozen; the page lists what the fork changed, and so does [MOCKS.md](MOCKS.md). Where a step has happened on mainnet, the page links that transaction too.

## Minute 2: what happened on mainnet

Open [PROOF.md](PROOF.md). Section 1 lists the eight contracts with BscScan and Sourcify links. Section 2 lists every transaction in time order. The ones to open:

| When (UTC; Fri is 2026-10-09, Sat is 2026-10-10) | Sender | What to look for |
|---|---|---|
| Fri 13:37:55 | owner | The collateral buy: 5.60 USDT to TSLAB through the Binance Trading API. |
| Fri 13:37:58 | owner | `createVenusAccount` on the factory: account `0x64b08268efb8B266c43A1751dDbB91702CA925e3`, keeper = the desk. |
| Fri 15:08:42 | owner | `restore(0.05 USDT)` in the regular session. It succeeds: the Session Oracle said yes. |
| Fri 15:09:25 | owner | Guard job 56956 funded on the ERC-8183 kernel, 0.01 USD1. |
| Fri 16:16:05 and 16:16:09 | desk | The desk submits its evidence hash and settles the job; `BallastGuardian` pays it. The evidence file: https://34-185-146-173.sslip.io/evidence/56956 |
| Fri 19:03:48 | desk | `shieldRepay(0.18017 USDT)`, sent by the desk on its own 56 minutes before the weekend close. LTV 53.95% to 50.60%. |
| Sat 15:43:33 | owner | The same `restore(0.05 USDT)` while New York is closed. A failed transaction, on purpose: the contract answered `RestoreRefused(NOT_REGULAR)` and nothing moved. |

The desk's address is `0xccD7f069275549793b2A8804A5691fCa6665D152` (ERC-8004 agent 368122), the owner's is `0xE507125d7F8aE8f482B9F55a1b07Abe58b2564Bf`. BscScan shows the sender of each transaction.

The Saturday transaction is the one to look at twice. BscScan shows it as failed, and that is the product working: its input is byte for byte the input of Friday's allowed restore, and what differs is the market session. A receipt does not carry the revert data, so to see the reason, replay the call at its block on an endpoint that still serves it:

```bash
cast call 0x64b08268efb8B266c43A1751dDbB91702CA925e3 "restore(uint256)" 50000000000000000 \
  --from 0xE507125d7F8aE8f482B9F55a1b07Abe58b2564Bf --block 126853796 --rpc-url https://bsc.drpc.org
```

It fails with `0x399ce621` followed by `3`: the selector of `RestoreRefused(uint8)` and the reason code `NOT_REGULAR`.

Not on mainnet, said plainly:

- **The desk's own restore.** The contract allows it from Monday 12 October, 15:00 UTC, at the earliest. That is after the submission deadline, so it is not part of this submission.

You can ask the oracle the question behind every restore at any time:

```bash
cast call 0x8Fc983D9cC9880e0FbBcd7F48304A175b4055388 "canAddRisk(bytes32)(bool,uint8)" \
  $(cast format-bytes32-string TSLA) --rpc-url https://bsc-dataseed.bnbchain.org
```

| Code | Reason | Code | Reason |
|---|---|---|---|
| 0 | `OK` | 6 | `FLAGGED` |
| 1 | `UNKNOWN_TICKER` | 7 | `PRICE_UNAVAILABLE` |
| 2 | `CALENDAR_UNKNOWN` | 8 | `REFERENCE_STALE` |
| 3 | `NOT_REGULAR` | 9 | `NOT_CONVERGED` |
| 4 | `TOO_SOON_AFTER_OPEN` | 10 | `WINDOW_AHEAD` |
| 5 | `OVERLAY_STALE` | | |

Outside 11:00 to 13:00 New York time on a trading day the answer is `false`. That is the product working.

## Minute 3: the desk and the MCP endpoint

The desk's read API is GET only:

```bash
export DESK_API_URL=https://34-185-146-173.sslip.io
curl -s "$DESK_API_URL/health"                      # dryRun false, the target health in force, the sender, the loops
curl -s "$DESK_API_URL/feed?limit=20"               # what the desk did, newest first: overlay posts, the shield, the settlement
curl -s "$DESK_API_URL/feed?kind=shield&limit=5"    # the shield, with its plan, its simulation and its transaction hash
curl -s "$DESK_API_URL/accounts"                    # the account the desk keeps, as it stands now
curl -s "$DESK_API_URL/oracle"                      # session and Session Oracle state per ticker
curl -s "$DESK_API_URL/ledger"                      # gas spent, guard job income, x402 spend against its cap
curl -s "$DESK_API_URL/api-health"                  # every Binance call the desk made: count, errors, p50 and p95
```

Every transaction hash in the feed can be opened on BscScan. `/health` answers 503 while the sender is halted. `/feed?kind=refused` lists what the desk tried and was refused, with the decoded reason; it is empty when nothing was refused.

The MCP server is public, with no key. This lists its eight read and plan tools:

```bash
curl -s https://34-185-146-173.sslip.io/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

To use it from an MCP client, one line of configuration:

```json
{ "mcpServers": { "ballast": { "type": "http", "url": "https://34-185-146-173.sslip.io/mcp" } } }
```

The app, if there is time left:

- https://ballast-desk.vercel.app/app: connect a wallet to see its tokenized stocks and its Lista and Venus loans, open a credit line or a cover, preview every transaction before signing.
- https://ballast-desk.vercel.app/oracle: the Session Oracle per ticker, one share priced through each issuer's token, and the closed-market band on the hourly chart.
- https://ballast-desk.vercel.app/guardians and https://ballast-desk.vercel.app/evidence: guard jobs, and the measurement.

## Minutes 4 and 5: run it

Node 22 or newer, pnpm 9, Foundry, and Python 3.9 or newer for the measurement.

```bash
git clone --recurse-submodules https://github.com/RaYYeR220/ballast && cd ballast
pnpm install
pnpm test                                          # TypeScript suite
pnpm contracts:test                                # contract unit tests, no network
pnpm contracts:test:fork                           # fork tests against BSC mainnet state, about 20 s after compiling
python research/check_figures.py                   # every figure of the measurement, recomputed from the data
```

The fork tests need no key: they use a public RPC endpoint by default (`BSC_RPC_URL` overrides it). The counts you should see are in PROOF.md section 3.

One claim at a time, from `contracts/`:

| Claim | Command |
|---|---|
| A restore while the market is closed reverts and moves nothing | `forge test --match-test test_restore_refusedOnWeekend -vv` |
| The keeper cannot reach any owner function | `forge test --match-test test_keeperCannotTouchOwnerFunctions -vv` |
| A keeper sale is bounded and switches auto-restore off | `forge test --match-test test_keeperDeleverage_ -vv` |
| The feed holds a thin-book print and lets a real move through | `forge test --match-contract SessionAwareFeedForkTest -vv` |
| A guardian is paid only if the loan survived | `forge test --match-contract BallastGuardianForkTest -vv` |
| The vault spends only near a closure, under the cap, on the user's own debt | `forge test --match-contract CushionVaultForkTest -vv` |

From the repository root:

| Check | Command |
|---|---|
| PROOF.md is exactly what the data renders | `pnpm proof --check` |
| The deployment matches the chain, the config and a local build | `pnpm contracts:build`, then `BSC_RPC_URL=https://bsc-dataseed.bnbchain.org pnpm verify:onchain` |
| The desk's registration file lists only what is served | `cast call 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432 "tokenURI(uint256)(string)" 368122 --rpc-url https://bsc-dataseed.bnbchain.org`, then decode the base64 |
| The keyless Binance endpoint the publisher depends on answers | `curl -s "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=56&contractAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436"` |
| The backtest numbers | `pnpm backtest` |

## Where to look

| Question | Place |
|---|---|
| What has happened on mainnet, and what has not? | README, "Live on BNB Chain", and PROOF.md |
| What exactly can the keeper not do? | README, "How it is enforced" |
| Which Binance Web3 API calls does the product make, and what does it lose without each? | README, "Binance Web3 API usage" |
| How are Agent Studio, ERC-8004 and ERC-8183 used? | README, "Agent Studio, ERC-8004 and ERC-8183" |
| How do I call it from my own agent? | README, "Public MCP endpoint", and `skill/SKILL.md` |
| Can I use the Session Oracle without the rest? | [docs/session-oracle.md](docs/session-oracle.md) |
| Is this number measured, modeled or proven? | [CLAIMS.md](CLAIMS.md) |
| How was the measurement done, and can I redo it? | [research/README.md](research/README.md) |
| What did the tests, the demo and the replay mock? | [MOCKS.md](MOCKS.md) |
| What does it not do? | README, "Honest limits", and CLAIMS.md section E |
