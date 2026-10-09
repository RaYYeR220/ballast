---
name: ballast
description: Use when working with tokenized-stock loans on BNB Chain (bStocks and Ondo tokens borrowed against on Lista or Venus), when asked whether a position survives a market closure, whether it is safe to borrow or add risk right now, or when a loan needs shielding before a close, weekend or earnings. Reads the Ballast session oracle, a position's health after the coming gap, and returns a shield plan.
metadata:
  version: "0.1.0"
license: MIT
---

# Ballast

Tokenized stocks trade around the clock on BNB Chain, but the stocks behind them do not. NYSE is closed for about 81% of the week. A loan against a stock token keeps being priced while the real market is shut, then the price jumps at the open. That jump (the gap) is what liquidates people.

Ballast closes that hole in two parts:

- **Session Oracle**: an on-chain view of the trading calendar, the next closure window and its gap buffer, and a per-symbol `canAddRisk` switch that says when new borrowing is allowed.
- **Ballast accounts**: loan accounts with a cushion and a keeper that repays or deleverages before a closure, so the position survives the gap.

This skill reads that state and plans shields. It never signs and holds no keys.

## Install

Node 22 or newer and pnpm are required.

```bash
git clone --recurse-submodules https://github.com/RaYYeR220/ballast
cd ballast
pnpm install
```

## Use the hosted endpoint

The Ballast desk serves this MCP server publicly over Streamable HTTP. The URL is the public MCP endpoint
listed in the repository README (it ends in `/mcp`); put it in `BALLAST_MCP_URL` or straight into the client
configuration:

```json
{ "mcpServers": { "ballast": { "type": "http", "url": "<the public MCP endpoint from the repository README>" } } }
```

Nothing to install. The hosted endpoint is unauthenticated, read and plan only (it holds no key and signs
nothing) and rate limited per client address; on HTTP 429 wait the number of seconds in `Retry-After`. It
reads BSC mainnet. For a fork, another RPC or no dependence on that host, run the server yourself:

## Run the MCP server

From the repository root:

```bash
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org npx tsx packages/mcp/bin/ballast-mcp.ts
```

That speaks MCP over stdio. To use it from an MCP client, register the command with the absolute path of your clone:

```json
{ "mcpServers": { "ballast": { "command": "npx", "args": ["tsx", "/absolute/path/to/ballast/packages/mcp/bin/ballast-mcp.ts"], "env": { "BSC_RPC_URL": "https://bsc-dataseed.bnbchain.org" } } } }
```

For a client that connects over HTTP, serve Streamable HTTP and point the client at `http://127.0.0.1:8787/mcp`:

```bash
npx tsx packages/mcp/bin/ballast-mcp.ts --http --port 8787
```

The HTTP endpoint binds to 127.0.0.1 and only answers requests addressed to that host. It has no authentication: a non-loopback `--host` is open to anyone who can reach it. To serve it publicly keep the loopback bind, put a TLS reverse proxy in front and name the public host with `--allowed-hosts` (or `MCP_ALLOWED_HOSTS`); `--rate-per-min` (`MCP_RATE_PER_MIN`, default 120) limits each client address. `deploy/README.md` has the unit and the proxy configuration.

Environment: `BSC_RPC_URL` (RPC), `CHAIN_ID` (56 by default, 31337 for a local fork), `DEPLOYMENT_FILE` (path to a deployment JSON, default `contracts/deployments/<chainId>.json`), `RWA_CHAIN_ID` (chain id for the Binance status lookup). The Binance RWA status is keyless mainnet data, so on a fork `tokenized_stock_status` still describes chain 56.

## Tools

All tools are read or plan only.

| Tool | Use it to | Example call |
| --- | --- | --- |
| `session_state` | See the market session, next close and open, and the next closure window | `session_state {}` |
| `oracle_price` | Get a symbol's price, `canAddRisk` and why, and the gap buffer for the window ahead | `oracle_price { "symbol": "TSLA" }` |
| `position_risk` | See an account's health now and after the coming gap, with the plan | `position_risk { "account": "0x..." }` |
| `plan_shield` | Get the ordered calls that keep an account above a target health after the gap | `plan_shield { "account": "0x...", "targetHf": 1.1 }` |
| `list_accounts` | Find Ballast accounts, all or by owner, paged with `offset` and `limit` | `list_accounts { "owner": "0x..." }` |
| `guardian_jobs` | See guardian jobs and their settlement status (`truncated` says if the scan missed older jobs) | `guardian_jobs { "account": "0x..." }` |
| `tokenized_stock_status` | Ask the keyless Binance status whether a token is open, and why not | `tokenized_stock_status { "address": "0x..." }` |
| `api_health` | Check recent Binance API probe results | `api_health {}` |

More detail and result fields are in `references/tools.md`.

## Rules

1. **Do not recommend new borrowing while `canAddRisk` is false.** `oracle_price` returns the reason (`NOT_REGULAR`, `TOO_SOON_AFTER_OPEN`, `WINDOW_AHEAD`, `OVERLAY_STALE`, `FLAGGED`, and so on). Wait for it to turn true; do not work around it. On-chain, only `restore()` is gated by it, and it is bounded by the owner's `maxLtvBps` and the `autoRestore` switch.
2. **Shields are always allowed, with one limit on sales.** Repaying from the cushion is always allowed. Collateral sales are allowed only on Lista with a deleverage path set, inside the pre-close window or when LTV is above the owner's cap. The plan's `canSellCollateral` and `warnings` say which applies.
3. **Read the plan kind.** `noop` means the account already survives the gap. `repay` uses the cushion only. `repay+deleverage` also sells collateral. `insufficient` means the cushion and allowed sale cannot reach the target: say so, do not present it as safe.
4. **Heed warnings** in the plan (unknown minimum loan, sale not allowed yet, over-deleverage). Report them with the plan.
5. **You plan, owners and keepers sign.** Never ask for a private key or seed phrase. Hand the user the steps and let their wallet or the account keeper send them.
6. Quote numbers from the tool result, with the block number it was read at.

## Why it matters

- NYSE is closed about 81% of the week.
- 81% of organic liquidated dollars land in the first 90 minutes after the open.
- 0 liquidations happened on weekends: the damage arrives at the open, not while the market is shut.
- p99 gaps by window: 4.4% overnight, 5.5% weekend, 4.3% holiday, 17.9% earnings.

See `references/windows.md` for how sessions, windows and gap buffers work.

## Links

- Tool reference: `references/tools.md`
- Sessions, windows and gap buffers: `references/windows.md`
- MCP server source: `packages/mcp`
- Hosted endpoint: the public MCP endpoint listed in the repository README; how to host your own: `deploy/README.md`
