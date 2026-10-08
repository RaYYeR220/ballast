# Review in five minutes

<!-- TODO-AT-DEPLOY: fill the five values in this table. Nothing else in this file needs editing. -->

| Name | Value |
|---|---|
| `APP_URL` | TODO-AT-DEPLOY |
| `REPLAY_URL` | TODO-AT-DEPLOY |
| `DESK_API_URL` | TODO-AT-DEPLOY |
| `VIDEO_URL` | TODO-AT-DEPLOY |
| `REPO_URL` | TODO-AT-DEPLOY |

The steps below use these names. A value that still reads TODO-AT-DEPLOY is not live yet: skip that step, the others do not depend on it. Mainnet addresses and transactions are not in this table. They are in [PROOF.md](PROOF.md), which is rendered from the deployment file and cannot list what is not there.

## Minute 1: what is on mainnet

Open [PROOF.md](PROOF.md).

- **Section 1** lists the eight contracts with BscScan links. If it says "Mainnet deployment pending", nothing is deployed yet: go to minute 3.
- **Section 2** lists the transactions in time order. The one to open first is the refused restore: a `restore` sent while the US market was closed. It is a failed transaction on purpose. Its revert data starts with `0x399ce621`, the selector of `RestoreRefused(uint8)`, and ends with the reason code. `3` is `NOT_REGULAR`.

You can ask the oracle the same question yourself at any time, with the `SessionOracle` address from section 1:

```bash
cast call <SessionOracle> "canAddRisk(bytes32)(bool,uint8)" \
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

## Minute 2: the product

- Open `APP_URL`.
- Open `REPLAY_URL` for a recorded run of the whole cycle. It needs no wallet and no funds.
- `VIDEO_URL` is the walkthrough.

## Minute 3: the desk

The desk's read API is GET only. Set the base URL once:

```bash
export DESK_API_URL=<the value from the table>
curl -s "$DESK_API_URL/health"                      # dryRun, the loops, their last run and last error
curl -s "$DESK_API_URL/feed?kind=refused&limit=5"   # what the desk tried and was refused, with the decoded reason
curl -s "$DESK_API_URL/feed?kind=shield&limit=5"    # shields, each with its simulation and transaction hash
curl -s "$DESK_API_URL/oracle"                      # session and Session Oracle state per ticker
curl -s "$DESK_API_URL/ledger"                      # gas spent, guard job income, x402 spend against its cap
curl -s "$DESK_API_URL/api-health"                  # every Binance call the desk made: count, errors, p50 and p95
```

Every transaction hash in the feed can be opened on BscScan. `dryRun: true` in `/health` means the desk is simulating and sending nothing.

## Minutes 4 and 5: run it

Node 22 or newer, pnpm 9, Foundry.

```bash
git clone --recurse-submodules <REPO_URL> ballast && cd ballast
pnpm install
pnpm test                                          # TypeScript suite
cd contracts
forge test --no-match-path "test/fork/*"           # unit tests, no network
forge test --match-path "test/fork/*"              # fork tests against BSC mainnet state, about 20 s after compiling
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
| Which Binance Web3 API calls are load-bearing, and which are only client code? | README, "Binance Web3 API usage" |
| How are Agent Studio, ERC-8004 and ERC-8183 used? | README, "Agent Studio, ERC-8004 and ERC-8183" |
| Can I use the Session Oracle without the rest? | [docs/session-oracle.md](docs/session-oracle.md) |
| Is this number measured, modeled or proven? | [CLAIMS.md](CLAIMS.md) |
| What did the tests mock? | [MOCKS.md](MOCKS.md) |
| What does it not do? | README, "Honest limits", and CLAIMS.md section E |
