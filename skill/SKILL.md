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

## Run the MCP server

From the repository root:

```bash
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org npx tsx packages/mcp/bin/ballast-mcp.ts
```

That speaks MCP over stdio. To use it from an MCP client, register the command:

```json
{ "mcpServers": { "ballast": { "command": "npx", "args": ["tsx", "packages/mcp/bin/ballast-mcp.ts"], "env": { "BSC_RPC_URL": "https://bsc-dataseed.bnbchain.org" } } } }
```

For a remote client, serve Streamable HTTP (loopback by default) and point the client at `http://127.0.0.1:8787/mcp`:

```bash
npx tsx packages/mcp/bin/ballast-mcp.ts --http --port 8787
```

Environment: `BSC_RPC_URL` (RPC), `CHAIN_ID` (56 by default, 31337 for a local fork), `DEPLOYMENT_FILE` (path to a deployment JSON, default `contracts/deployments/<chainId>.json`).

## Tools

All tools are read or plan only.

| Tool | Use it to | Example call |
| --- | --- | --- |
| `session_state` | See the market session, next close and open, and the next closure window | `session_state {}` |
| `oracle_price` | Get a symbol's price, `canAddRisk` and why, and the gap buffer for the window ahead | `oracle_price { "symbol": "TSLA" }` |
| `position_risk` | See an account's health now and after the coming gap, with the plan | `position_risk { "account": "0x..." }` |
| `plan_shield` | Get the ordered calls that keep an account above a target health after the gap | `plan_shield { "account": "0x...", "targetHf": 1.1 }` |
| `list_accounts` | Find Ballast accounts, all or by owner | `list_accounts { "owner": "0x..." }` |
| `guardian_jobs` | See guardian jobs and their settlement status | `guardian_jobs { "account": "0x..." }` |
| `tokenized_stock_status` | Ask the keyless Binance status whether a token is open, and why not | `tokenized_stock_status { "address": "0x..." }` |
| `api_health` | Check recent Binance API probe results | `api_health {}` |

More detail and result fields are in `references/tools.md`.

## Rules

1. **Never add risk while `canAddRisk` is false.** That means no new borrow, no restore, no raising leverage. `oracle_price` returns the reason (`NOT_REGULAR`, `TOO_SOON_AFTER_OPEN`, `WINDOW_AHEAD`, `OVERLAY_STALE`, `FLAGGED`, and so on). Wait for it to turn true; do not work around it.
2. **Shields are always allowed.** Repaying debt or deleveraging before a closure is never blocked by `canAddRisk`. If `plan_shield` returns steps, they are safe to recommend at any time.
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
