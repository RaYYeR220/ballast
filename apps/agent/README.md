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
| `src/desk/tx.ts` | Simulation, signing, nonces, broadcast, receipt follow-up and the low-BNB alert |
| `src/desk/publisher.ts` | Session Oracle overlay publisher (RWA status, Ondo multiplier, references, earnings) |
| `src/desk/keeper.ts` | Shields accounts and covers before closures, restores accounts after the open |
| `src/desk/client.ts` | The desk's viem client (uncached head block) |
| `test/` | Unit tests (`pnpm test` at the repo root) |

## Environment

| Variable | Default | Notes |
|---|---|---|
| `CHAIN_ID` | required | `56` BSC, `97` BSC testnet, `31337` local fork |
| `BSC_RPC_URL` | required | http(s); treated as a secret because providers put keys in the path |
| `AGENT_PRIVATE_KEY` | | or the two keystore variables below, not both |
| `AGENT_KEYSTORE_PATH`, `AGENT_KEYSTORE_PASSWORD` | | Studio keystore; `WALLET_PASSWORD` is accepted as the password |
| `BINANCE_WEB3_API_KEY`, `BINANCE_WEB3_API_SECRET` | unset | both or neither; unset means keyless public endpoints |
| `DEPLOYMENT_FILE` | `contracts/deployments/<CHAIN_ID>.json` | |
| `AGENT_BIND_HOST`, `AGENT_PORT` | `127.0.0.1`, `9000` | Studio A2A/MCP listener; must be loopback on chain 56 |
| `HTTP_HOST`, `HTTP_PORT` | `127.0.0.1`, `8787` | desk read API, fronted by a reverse proxy |
| `X402_DAILY_CAP_USD` | `0.5` | daily ceiling for paid data |
| `MIN_BNB_BALANCE` | `0.003` | alert when the desk key holds less BNB than this |
| `DATA_DIR` | `apps/agent/var/` | feed and other desk state; outside git |
| `EARNINGS_FILE` | `config/earnings.json` | earnings schedule the publisher reads every run |
| `DRY_RUN` | `true` | simulate every write, broadcast nothing |
| `AGENT_PUBLIC_URL`, `APP_URL` | | register only: stand-ins for `--agent-url` and `--web-url` |

## Run

```bash
pnpm install                     # from the repo root
cd apps/agent
bag dev                          # Studio faces on 127.0.0.1:9000 (needs a Studio wallet and LLM key)

# ERC-8004 identity: simulation by default
pnpm run register --agent-url https://desk.example.org --web-url https://ballast.example.org
# write it (mainnet also needs the explicit flag)
DRY_RUN=false pnpm run register --agent-url ... --web-url ... --confirm-mainnet
```

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
- A liquidated account is no longer managed. The desk records the seizure on-chain with
  `recordLiquidation()` once and then leaves the account alone; the owner takes it from there.
- A transaction that is not mined in time is recorded as `pending`, and the account is left alone until
  it settles. A stuck shield is sped up at its own nonce (re-planned, re-simulated, re-signed for more
  gas) before anything else is sent; other stuck sends are replaced or cancelled. Shield amounts for the
  restore cycle come from the receipt's `Shielded` logs.

## Security posture

- Keys come only from the environment or a keystore outside the repo (`.studio/` and `*.keystore` are ignored).
- The Studio faces have no inbound auth when self-hosted, so they listen on loopback. On chain 56
  the config refuses any other bind address. The read API also binds to loopback behind the proxy.
- The ERC-8183 seller rail is off in `app/agent/studio.toml`: the faces advertise no
  `negotiate`/`notify_funded` skills and refuse them, so nobody can make the desk spend gas on free
  jobs. Guardian jobs settle through the Ballast evaluator from the desk's own code.
- Signing is fixed code, never an LLM tool. Writes are simulated before they are sent and
  `DRY_RUN` defaults to true. `describe()` on the config redacts keys, passwords and RPC paths.
