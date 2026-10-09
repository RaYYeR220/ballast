# Ballast Risk Desk

The desk is the always-on agent behind Ballast. One key and one process keep bStock-backed loans
gap-survivable: it publishes the Session Oracle overlay, shields Ballast accounts before each close
and earnings window, restores them after the open, settles guardian jobs on the Ballast evaluator,
pays for its own market data over x402 and serves a read API for the web app. Every decision is
deterministic code bounded by the Ballast contracts; the LLM only writes desk notes afterwards.

## Layout

| Path | What it is |
|---|---|
| `app/agent/` | BNB Agent Studio project (`bag init`): A2A and MCP faces, `studio.toml`, Studio signing code |
| `src/desk/config.ts` | Validated environment; secrets are wrapped and never printed |
| `src/desk/account.ts` | Signer from a raw key or a Studio keystore (Web3 Secret Storage v3) |
| `src/desk/register.ts` | ERC-8004 identity: builds the registration file and mints or updates it |
| `src/desk/feed.ts` | Audit feed: every attempt as one JSON line under `DATA_DIR`, plus an in-memory ring for the API |
| `src/desk/tx.ts` | Simulation and the sender: one transaction in flight, bounded replacement, halting, the low-BNB alert |
| `src/desk/publisher.ts` | Session Oracle overlay publisher (RWA status, Ondo multiplier, references, earnings) |
| `src/desk/keeper.ts` | Shields accounts and covers before closures, restores accounts after the open |
| `src/desk/client.ts` | The desk's viem client (uncached head block) |
| `src/desk/guardian.ts` | Guardian jobs: scans the kernel from a persisted cursor, submits the evidence hash after each window, settles |
| `src/desk/ledger.ts` | Income, gas once per nonce (the mined transaction, cancels labelled) and x402 spend under the daily cap (`DATA_DIR/ledger.json`) |
| `src/desk/x402.ts` | x402 buyer: exact scheme, EIP-3009 on pinned stablecoins, per-call and daily caps checked before signing |
| `src/desk/earnings.ts` | Buys the next earnings dates once per trading day; `config/earnings.json` is the fallback |
| `src/desk/notes.ts` | Two-sentence desk notes from the Studio LLM after shields, restores and refusals (never a decision input) |
| `src/desk/api.ts` | Read API: health (503 while the sender is halted), feed, accounts, oracle, ledger, evidence, Binance API health |
| `src/desk/main.ts` | The process: API first, sender recovery, then the loops with jitter and back-off; graceful SIGTERM |
| `test/` | Unit tests (`pnpm test` at the repo root) |

## Environment

| Variable | Default | Notes |
|---|---|---|
| `CHAIN_ID` | required | `56` BSC, `97` BSC testnet, `31337` local fork |
| `BSC_RPC_URL` | required | treated as a secret because providers put keys in the path; https on chain 56 (http only for a loopback node) |
| `AGENT_PRIVATE_KEY` | | or the two keystore variables below, not both |
| `AGENT_KEYSTORE_PATH`, `AGENT_KEYSTORE_PASSWORD` | | Studio keystore; `WALLET_PASSWORD` is accepted as the password |
| `BINANCE_WEB3_API_KEY`, `BINANCE_WEB3_API_SECRET` | unset | both or neither. Required on chain 56 for collateral sales: without them a sale is never signed (the cushion still shields) and the desk warns at startup |
| `DEPLOYMENT_FILE` | `contracts/deployments/<CHAIN_ID>.json` | |
| `AGENT_BIND_HOST`, `AGENT_PORT` | `127.0.0.1`, `9000` | Studio A2A/MCP listener; must be loopback on chain 56 |
| `HTTP_HOST`, `HTTP_PORT` | `127.0.0.1`, `8787` | desk read API, fronted by a reverse proxy; must be loopback on chain 56 |
| `X402_DAILY_CAP_USD` | `0.5` | daily ceiling for paid data; at most 0.5 |
| `X402_EARNINGS_URL` | unset (off) | x402 earnings-calendar endpoint; `{symbol}`, `{from}`, `{to}` are filled in |
| `X402_MAX_PRICE_USD` | `0.05` | most one call may cost (at most 0.05) |
| `X402_NETWORKS` | `eip155:56,eip155:8453` | networks the desk pays on, preferred first |
| `WEB_ORIGIN` | unset | the one origin the read API answers CORS for |
| `API_RATE_PER_MIN` | `120` | requests per minute per client IP |
| `DESK_NOTES` | `auto` | `off` never calls the LLM; `auto` uses the Studio `[llm]` provider when its key is set |
| `NOTES_DAILY_MAX` | `200` | most LLM calls for notes per UTC day |
| `STUDIO_TOML` | `app/agent/studio.toml` | where the notes read `[llm]` |
| `FORK_TICK_SEC` | unset | fork only (`CHAIN_ID=31337`): every loop runs at this interval |
| `MIN_BNB_BALANCE` | `0.003` | alert when the desk key holds less BNB than this |
| `TARGET_HF_AFTER_GAP` | `1.05` | desk policy: the health the desk keeps after the coming gap (1.01 to 2.0) |
| `MAX_GAS_PRICE_GWEI` | `1` | the sender never signs above this gas price (BSC gas is a small fraction of a gwei) |
| `RECEIPT_TIMEOUT_SEC` | `20` | wait for a receipt this long before replacing a transaction (BSC blocks are sub-second) |
| `RECEIPT_LAG_SEC` | `45` | how long a receipt may trail a used nonce (load-balanced RPCs) before the nonce is read as gone to someone else |
| `MAX_BUMPS` | `4` | replacement rounds per nonce before the sender halts |
| `MAX_FEE_BNB_PER_HOUR` | `0.003` | fee budget (gas limit x gas price of everything signed) per rolling hour |
| `DATA_DIR` | `apps/agent/var/` | feed, ledger, guardian cursor, evidence; outside git. Test-written at startup: the desk exits non-zero if it cannot write there |
| `EARNINGS_FILE` | `config/earnings.json` | earnings schedule the publisher reads every run |
| `DRY_RUN` | `true` | simulate every write, broadcast nothing |
| `AGENT_PUBLIC_URL`, `APP_URL` | | register only: stand-ins for `--agent-url` and `--web-url` |

## Run

```bash
pnpm install                     # from the repo root
pnpm desk                        # the desk: read API on 127.0.0.1:8787, then the loops (DRY_RUN=true by default)
cd apps/agent
bag dev                          # Studio faces on 127.0.0.1:9000 (needs a Studio wallet and LLM key)

# ERC-8004 identity: simulation by default
pnpm run register --agent-url https://desk.example.org --web-url https://ballast.example.org
# write it (mainnet also needs the explicit flag)
DRY_RUN=false pnpm run register --agent-url ... --web-url ... --confirm-mainnet
```

On a VPS the desk runs as a systemd service behind Caddy: see `deploy/README.md`.

The signer must be a plain EOA. The registry mints with ERC-721 `safeMint`, so an account carrying
an EIP-7702 delegation that does not accept ERC-721 tokens makes `register()` revert.

### Recovering or updating an identity

A new identity takes two transactions: `register()` with the registration file, then `setAgentURI()`
with `registrations` filled in once the agentId is known. If the second one fails, the identity
already exists. Re-run with `--agent-id <id>` (printed after the first transaction, also in its
`Registered` event) to rewrite only the URI; the script checks that the signer owns that id first.
The same flag updates endpoints later. Running without `--agent-id` always mints a new identity.

## What the keeper manages

- Ballast accounts whose `keeper` is the desk key, and CushionVault covers that name the desk key.
- Shields run in the hour before a regular close (the whole session before an earnings window);
  restores run in the regular session, only when the owner allows them, only up to what the desk
  itself repaid in that shield cycle and never above the pre-shield LTV. If the owner repays or
  closes the loan after a shield, the cycle ends and the desk borrows nothing back.
- `TARGET_HF_AFTER_GAP` is the desk's policy for every loan it keeps: the health the desk keeps after
  the coming gap. Before a close the keeper repays until `liquidation threshold x (1 - gap) / LTV` is
  back at this value; a loan already above it is left alone ("survives the gap"). Shield and restore
  plans use the same value, and `/health` and the startup line show it. The default, 1.05, shields only
  loans close to their limit; a higher value shields earlier and repays more.
- A liquidated account is no longer managed. The desk records the seizure on-chain with
  `recordLiquidation()` once and then leaves the account alone; the owner takes it from there.
- Shield amounts for the restore cycle come from the receipt's `Shielded` logs. Repays are sized against
  the debt with a basis point of accrual, and a shortfall under max(0.05 loan units, 0.1% of the debt)
  is treated as dust: no transaction.
- `shieldBusy()` on the keeper is true while a shield is pending or planned in a lead window (not while
  it merely waits out a back-off with more than 30 min to the close). The publisher and the guardian
  hold their own sends back on it; the publisher still renews an overlay that is about to expire.

## How the desk sends

- One transaction of the desk key is in flight at a time. A send waits for its receipt
  (`RECEIPT_TIMEOUT_SEC`); if none comes, the same intent is rebuilt and replaced at the same nonce for
  12.5% more gas, or by a 0-value cancel when it is no longer valid, at most `MAX_BUMPS` times and
  never above `MAX_GAS_PRICE_GWEI`. A shield already sent is not cancelled because the lead window ended.
- When that is not enough, or the key cannot pay, the hourly fee budget is used up or a transaction the
  desk did not sign is pending for the key, the sender halts: nothing more is signed until the chain
  shows the way is clear. The feed shows it (`alert`, and `refused` with `SENDER_HALTED`, both with
  `data.sender = "halted"`). It resumes by itself once the nonce is mined, or once nothing of the key is
  pending and no node knows the stuck transaction any more. **If a halt alert does not clear, restart
  the desk**: at startup it takes over whatever is pending for the key and cancels it. For a `GAS_CAP`
  halt that does not clear, raise `MAX_GAS_PRICE_GWEI` first and then restart; for any other halt,
  restart the desk.
- Collateral sales are broadcast only through the Binance MEV-protected endpoint, never to the public
  mempool. A sale that is not mined gets one more private attempt; after that, or if the endpoint
  fails, its nonce is settled in public by the cushion repay (or a cancel) and the sale is reported as
  not sent (`refused`, `SaleNotSent`) and put on hold. Without a Binance key on mainnet sales are
  disabled (one `alert` says so) and shields repay from the cushion only.
- `/health` shows the sender: `sales` (`protected`, `public` off mainnet, or `disabled`), the halt reason,
  the nonce in flight with every hash signed for it, and the fees signed in the last hour. It answers 503
  while the sender is halted. The publisher and the guardian stand back while the keeper has a shield to
  send (`shieldBusy()`); the guardian also waits while the sender is halted or another transaction is in
  flight, and tries again 90 s later with no back-off.
- The ledger books gas once per nonce, from the transaction that was finally mined there at its effective
  gas price; a nonce spent on a cancel is booked as `cancelled`.
- The outstanding nonce and every hash signed for it are kept in `DATA_DIR/sender.json`, so a restart
  picks the nonce up and settles it before sending anything new.
- One sender per key. Nothing else may sign with the desk key while the desk runs: the Studio ERC-8183
  rail is off, so Studio sends nothing at runtime, and the ERC-8004 registration is done before the
  desk starts.

### Limits

- A private sale that wins its nonce after a halt was lifted is recorded as `dropped` in the feed: by then
  the desk no longer waits for it. This is the conservative reading: no shield is credited, so no restore
  cycle opens for it, and the next tick plans from the position as it is on-chain.
- The desk sends one transaction at a time, so a stuck nonce holds every loop back until it is mined,
  replaced or cancelled; `/health` turns 503 for as long as the sender is halted.

## Security posture

- Keys come only from the environment or a keystore outside the repo (`.studio/` and `*.keystore` are ignored).
- The Studio faces have no inbound auth when self-hosted, so they listen on loopback. On chain 56
  the config refuses any other bind address. The read API also binds to loopback behind the proxy.
- The ERC-8183 seller rail is off in `app/agent/studio.toml`: the faces advertise no
  `negotiate`/`notify_funded` skills and refuse them, so nobody can make the desk spend gas on free
  jobs. Guardian jobs settle through the Ballast evaluator from the desk's own code.
- Signing is fixed code, never an LLM tool. Writes are simulated before they are sent and
  `DRY_RUN` defaults to true. `describe()` on the config redacts keys, passwords and RPC paths.
