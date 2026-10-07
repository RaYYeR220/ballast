# Data

`closure-windows.json` - every US-market closure (weekday overnight, weekend, long weekend / holiday) since each bStock listed on Binance (2026-06-12 to 2026-09-24 in this snapshot), one row per bStock and window: 3378 rows across 77 bStocks. Types: `overnight` (2688), `weekend` (597), `long_weekend_holiday` (93).

Fields: `sym` (bStock), `und` (underlying), `type`, `d0`/`d1` (last session day before / first session day after), `hours` (closure length), `fri_close`/`mon_open` (underlying regular close before and open after, USD), `gap` (open/close - 1), `b_start_prem` (bStock premium to the underlying at the close), `max_up`/`max_dn` (extremes of the bStock hourly path during the closure, relative to the close), `b_end` (bStock move at the end of the closure), `b_sun` (bStock move on Sunday evening, null when not applicable), `wick_dn`/`wick_up` (largest single-hour wick) and `wick_dn_t` (unix time of the down wick), `qv_usd` (bStock quote volume during the closure), `n` (hourly candles), `lo_vs_open`/`hi_vs_open` (closure low/high relative to the next open).

Sources: Binance public klines (`/api/v3/klines`, bStock/USDT pairs) and underlying prices from Yahoo Finance (v8 chart endpoint, daily bars, split-adjusted).

## Backtest model

`pnpm backtest` replays the windows through `packages/risk/src/backtest.ts` and writes `backtest-lltv75.json`. For each window a position is opened at `startLtv` on an LLTV-0.75 market. Worst move = `min(gap, max_dn, 0)`. Unprotected: liquidated if `startLtv / (1 + worst) > lltv`. Protected: before the close the planner repays down to HF 1.05 against the ticker's p99 gap for that window type (`config/bsc-mainnet.json`), then the same liquidation test runs on the reduced debt.

Assumptions (read these before quoting the numbers):
- The cushion is assumed large enough to fund every shield (cushion = the whole debt), and collateral is never sold.
- No venue minimum loan is applied (minLoan = 0).
- The data has no earnings flag, so earnings gaps appear as ordinary overnight/weekend rows and are tested against the (smaller) non-earnings buffer. The earnings window is not used.
- The bStock premium to the underlying and oracle lag are ignored; the worst move is taken straight from `gap`/`max_dn`.
- `long_weekend_holiday` is treated as a holiday window. Only the 12 underlyings with a configured gap buffer are replayed (697 of 3378 rows); the rest are skipped. One ~3 month sample (2026-06-12 to 2026-09-24).

Result and trigger rate (`backtest-lltv75.json`): at startLtv 0.70 the shield fires in 652 of 697 windows (average repay 2.6% of debt) and liquidations drop from 5 to 2; at 0.72 it fires in all 697 (average repay 5.1%) and liquidations drop from 27 to 2. At 0.65 it fires in 24 windows with no liquidations either way. The buffer is a p99, so the shield is often active at high starting LTVs; the two remaining protected liquidations are moves beyond the buffer, both earnings nights: META (closure 2026-07-29 to 2026-07-30, gap -10.2%) and AAPL (2026-07-30 to 2026-07-31, gap -8.6%).

## Liquidations on the week

`liquidations-week.json` - every `Liquidate` event on Lista Moolah (`0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c`, BNB Chain) in a market that involves a bStock, from 2026-06-18 to 2026-09-22: 121 rows. Read with `eth_getLogs` over blocks 101,500,000 to 123,963,563 (topic `0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41`, the Morpho-style `Liquidate(id, caller, borrower, repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares)`), then placed on the New York trading week. Venus seized no bStock collateral in the same window. This is the data behind the planisphere on the landing page; every figure quoted there is computed from this file.

Fields: `h` (hour of the week in New York time, Monday 00:00 = 0), `usd` (repaid amount in USD), `s` (session at the time: regular, pre, post, overnight, holiday), `g` (group, below), `c` (bStock symbol), `tx` (transaction hash, linked to BscScan from each star), `et` (New York timestamp), `t` (timing class for organic rows, e.g. `regular: first 90 min`).

Groups:
- `organic` (33 rows, $30.6k repaid): real borrowers. $24.8k of it (81%) was repaid in the first 90 minutes after a regular open.
- `seed` (87 rows, $4 to $26 each): one test address, `0x05e3a7a66945ca9af73f66660f22ffb36332fa54`, that opened tiny positions across many markets. They mark when prices crossed the line but are not losses, so the page draws them as hollow, dimmed rings and says so.
- `loan` (1 row): the one market where a bStock was the loan asset rather than the collateral. The "0 of 120" weekend figure counts the 120 bStock-collateral rows.

No row falls between Friday 20:00 and Sunday 20:00 New York time.
