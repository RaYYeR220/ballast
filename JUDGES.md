# Review in five minutes

| Name | Value | Status |
|---|---|---|
| `APP_URL` | https://ballast-desk.vercel.app | live |
| `REPLAY_URL` | https://ballast-desk.vercel.app/judge | live |
| `DESK_API_URL` | https://34-185-146-173.sslip.io | live |
| `REPO_URL` | https://github.com/RaYYeR220/ballast | |
| `VIDEO_URL` | | TODO-AT-DEPLOY |

Mainnet addresses and transactions are not in this table. They are in [PROOF.md](PROOF.md), which is rendered from the deployment file and the transaction list and cannot show what is not in them.

## Minute 1: no setup

Open https://ballast-desk.vercel.app/judge. It plays one full cycle step by step: contracts, overlay, account, guard job, the shield before the close, a restore refused while New York is closed, the restore after the open, the settlement. Each step shows its transaction, the decoded result or revert, and the account after it.

It is a recording made on a fork of BNB Chain against the deployed contracts, with the clock moved and prices frozen; the page lists what the fork changed, and so does [MOCKS.md](MOCKS.md). Where a step has happened on mainnet, the page links that transaction too.

## Minute 2: what is on mainnet

Open [PROOF.md](PROOF.md).

- **Section 1** lists the eight contracts with BscScan and Sourcify links.
- **Section 2** lists the transactions in time order, starting with the desk's ERC-8004 registration, the deployment and the first overlay the desk posted. The one to look for is the refused restore: a `restore` sent while the US market was closed. It is a failed transaction on purpose. Its revert data starts with `0x399ce621`, the selector of `RestoreRefused(uint8)`, and ends with the reason code. `3` is `NOT_REGULAR`.

You can ask the oracle the same question yourself at any time:

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

## Minute 3: the app and the desk

- https://ballast-desk.vercel.app/app: connect a wallet to see its tokenized stocks and its Lista and Venus loans, open a credit line or a cover, preview every transaction before signing.
- https://ballast-desk.vercel.app/oracle: the Session Oracle per ticker, one share priced through each issuer's token, and the closed-market band on the hourly chart.
- https://ballast-desk.vercel.app/guardians and https://ballast-desk.vercel.app/evidence: guard jobs, and the measurement.

The desk's read API is GET only:

```bash
export DESK_API_URL=https://34-185-146-173.sslip.io
curl -s "$DESK_API_URL/health"                      # dryRun, the target health in force, the sender, the loops
curl -s "$DESK_API_URL/feed?kind=refused&limit=5"   # what the desk tried and was refused, with the decoded reason
curl -s "$DESK_API_URL/feed?kind=shield&limit=5"    # shields, each with its simulation and transaction hash
curl -s "$DESK_API_URL/oracle"                      # session and Session Oracle state per ticker
curl -s "$DESK_API_URL/accounts"                    # accounts and covers the desk keeps
curl -s "$DESK_API_URL/ledger"                      # gas spent, guard job income, x402 spend against its cap
curl -s "$DESK_API_URL/api-health"                  # every Binance call the desk made: count, errors, p50 and p95
```

Every transaction hash in the feed can be opened on BscScan. `/health` answers 503 while the sender is halted.

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
| The keyless Binance endpoint the publisher depends on answers | `curl -s "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=56&contractAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436"` |
| The backtest numbers | `pnpm backtest` |

## Where to look

| Question | Place |
|---|---|
| What exactly can the keeper not do? | README, "How it is enforced" |
| Which Binance Web3 API calls does the product make, and what does it lose without each? | README, "Binance Web3 API usage" |
| How are Agent Studio, ERC-8004 and ERC-8183 used? | README, "Agent Studio, ERC-8004 and ERC-8183" |
| Can I use the Session Oracle without the rest? | [docs/session-oracle.md](docs/session-oracle.md) |
| Is this number measured, modeled or proven? | [CLAIMS.md](CLAIMS.md) |
| How was the measurement done, and can I redo it? | [research/README.md](research/README.md) |
| What did the tests, the demo and the replay mock? | [MOCKS.md](MOCKS.md) |
| What does it not do? | README, "Honest limits", and CLAIMS.md section E |
