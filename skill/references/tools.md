# Ballast MCP tools

The tools are the same whether the server runs locally (stdio or `http://127.0.0.1:8787/mcp`) or you use the hosted endpoint (the public MCP endpoint listed in the repository README, kept in `BALLAST_MCP_URL`). The hosted endpoint reads BSC mainnet, needs no key and answers HTTP 429 with `Retry-After` when a client address sends too many requests.

Every tool is read or plan only. Results are JSON text; large integers are decimal strings; prices are USD decimal strings or numbers as noted. A failed call returns `isError: true` with `{ "error": "..." }` (contract reverts are decoded to a sentence).

## session_state

Arguments: none.

Returns `session`, `nextClose`, `nextOpen` (unix seconds and ISO), `window` (the next closure: kind, start, end) and `current` (the closure in progress).

## oracle_price

Arguments: `symbol` (ticker, for example `TSLA`; letters, digits, dot, dash, underscore, up to 31 characters; upper-cased before the lookup).

Returns `rawPriceUsd`, `perSharePriceUsd`, `referenceUsd`, `converged`, `deviationBps`, `canAddRisk`, `reason` and `reasonText`, `windowAhead` and `currentWindow` (each with `gapBps`), and the `overlay` posted by the publisher (`flagNames`, `validUntilIso`, `nextEarningsIso`).

## position_risk

Arguments: `account` (address of a Ballast account made by the factory), `targetHf` (optional, default 1.05).

Returns collateral, debt and cushion in token units, `mandate`, `pricing`, the oracle state, the `gap` used, `healthFactor.now` and `healthFactor.afterGap`, and the `plan`.

## plan_shield

Arguments: `account` (address), `targetHf` (optional).

Returns `kind` (`noop`, `repay`, `repay+deleverage`, `insufficient`), `reason` (also set on `noop`), `hfAfterGap`, `steps` (ordered account calls: `shieldRepay`, `shieldDeleverage`), `amounts` in token units, and `warnings`. Nothing is sent.

## list_accounts

Arguments: `owner` (optional address), `offset` (default 0), `limit` (default 50, max 200).

Returns `total`, `hasMore` and one page of account addresses.

## guardian_jobs

Arguments: `account` (optional), `lookback` (optional, recent kernel job ids to scan, default 5000).

Returns jobs evaluated by the Ballast guardian with status, budget, and the bound terms (account, start, end, settled). The scan starts at the guardian's deployment job id when the deployment file records it (`guardianStartJobId`), otherwise at the lookback bound. `truncated` is true when the scan began above the earliest possible guardian job, so older jobs may be missing.

## tokenized_stock_status

Arguments: `address` (token contract).

On a fork this still reads mainnet status data (set `RWA_CHAIN_ID` to override the chain id).

Returns `open`, `marketStatus`, `reasonCode` and `reason` (closed session, corporate action, earnings halt) and the next open and close from the public Binance status endpoint. No API key needed.

## api_health

Arguments: none.

Returns a summary of the Binance public API calls this server has made: counts, failures, average latency and last status per endpoint.
