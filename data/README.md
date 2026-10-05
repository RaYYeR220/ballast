# Data

`closure-windows.json` - every US-market closure (weekday overnight, weekend, long weekend / holiday) since each bStock listed on Binance (2026-06-12 to 2026-09-24 in this snapshot), one row per bStock and window: 3378 rows across 79 bStocks. Types: `overnight` (2688), `weekend` (597), `long_weekend_holiday` (93).

Fields: `sym` (bStock), `und` (underlying), `type`, `d0`/`d1` (last session day before / first session day after), `hours` (closure length), `fri_close`/`mon_open` (underlying regular close before and open after, USD), `gap` (open/close - 1), `b_start_prem` (bStock premium to the underlying at the close), `max_up`/`max_dn` (extremes of the bStock hourly path during the closure, relative to the close), `b_end` (bStock move at the end of the closure), `b_sun` (bStock move on Sunday evening, null when not applicable), `wick_dn`/`wick_up` (largest single-hour wick) and `wick_dn_t` (unix time of the down wick), `qv_usd` (bStock quote volume during the closure), `n` (hourly candles), `lo_vs_open`/`hi_vs_open` (closure low/high relative to the next open).

Sources: Binance public klines (`/api/v3/klines`, bStock/USDT pairs) and daily underlying prices.

## Backtest model

`pnpm backtest` replays the windows through `packages/risk/src/backtest.ts` and writes `backtest-lltv75.json`. For each window a position opens it at `startLtv` on an LLTV-0.75 market. Worst move = `min(gap, max_dn, 0)`. Unprotected: liquidated if `startLtv / (1 + worst) > lltv`. Protected: before the close the planner repays down to HF 1.05 against the ticker's p99 gap for that window type (`config/bsc-mainnet.json`), then the same liquidation test runs on the reduced debt. Only underlyings that have a configured gap buffer (the 12 tickers in `config/bsc-mainnet.json`) are replayed; other rows are skipped. `long_weekend_holiday` is treated as a holiday window.
