# Ballast MCP tools

Every tool is read or plan only. Results are JSON text; large integers are decimal strings; prices are USD decimal strings or numbers as noted. A failed call returns `isError: true` with `{ "error": "..." }` (contract reverts are decoded to a sentence).

## session_state

Arguments: none.

Returns `session`, `nextClose`, `nextOpen` (unix seconds and ISO), `window` (the next closure: kind, start, end) and `current` (the closure in progress).

## oracle_price

Arguments: `symbol` (ticker, for example `TSLA`).

Returns `rawPriceUsd`, `perSharePriceUsd`, `referenceUsd`, `converged`, `deviationBps`, `canAddRisk`, `reason` and `reasonText`, `windowAhead` and `currentWindow` (each with `gapBps`), and the `overlay` posted by the publisher (`flagNames`, `validUntilIso`, `nextEarningsIso`).

## position_risk

Arguments: `account` (address), `targetHf` (optional, default 1.05).

Returns collateral, debt and cushion in token units, `mandate`, `pricing`, the oracle state, the `gap` used, `healthFactor.now` and `healthFactor.afterGap`, and the `plan`.

## plan_shield

Arguments: `account` (address), `targetHf` (optional).

Returns `kind` (`noop`, `repay`, `repay+deleverage`, `insufficient`), `reason`, `hfAfterGap`, `steps` (ordered account calls: `shieldRepay`, `shieldDeleverage`, `restore`), `amounts` in token units, and `warnings`. Nothing is sent.

## list_accounts

Arguments: `owner` (optional address).

Returns `count` and up to 200 account addresses.

## guardian_jobs

Arguments: `account` (optional), `lookback` (optional, recent kernel job ids to scan, default 5000).

Returns jobs evaluated by the Ballast guardian with status, budget, and the bound terms (account, start, end, settled).

## tokenized_stock_status

Arguments: `address` (token contract).

Returns `open`, `marketStatus`, `reasonCode` and `reason` (closed session, corporate action, earnings halt) and the next open and close from the public Binance status endpoint. No API key needed.

## api_health

Arguments: none.

Returns a summary of the Binance public API calls this server has made: counts, failures, average latency and last status per endpoint.
