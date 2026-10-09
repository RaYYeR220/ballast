# Data

`closure-windows.json` - every US-market closure (weekday overnight, weekend, long weekend / holiday) since each bStock listed on Binance (2026-06-12 to 2026-09-24 in this snapshot), one row per bStock and window: 3378 rows across 77 bStocks. Types: `overnight` (2688), `weekend` (597), `long_weekend_holiday` (93).

Fields: `sym` (bStock), `und` (underlying), `type`, `d0`/`d1` (last session day before / first session day after), `hours` (closure length), `fri_close`/`mon_open` (underlying regular close before and open after, USD), `gap` (open/close - 1), `b_start_prem` (bStock premium to the underlying at the close), `max_up`/`max_dn` (extremes of the bStock hourly path during the closure, relative to the close), `b_end` (bStock move at the end of the closure), `b_sun` (bStock move on Sunday evening, null when not applicable), `wick_dn`/`wick_up` (largest single-hour wick) and `wick_dn_t` (unix time of the down wick), `qv_usd` (bStock quote volume during the closure), `n` (hourly candles), `lo_vs_open`/`hi_vs_open` (closure low/high relative to the next open).

Sources: Binance public klines (`/api/v3/klines`, bStock/USDT pairs) and underlying prices from Yahoo Finance (v8 chart endpoint, daily bars, split-adjusted).

Built by `research/fetch_klines.py`, `research/fetch_yahoo.py` and `research/weekend.py`. The rest of the study (the liquidation scan, the weekend timing, the gap quantiles) and its data are in `research/`, and `python research/check_figures.py` recomputes every published figure, including the ones taken from this file. Any liquidation dataset that appears in this directory in another shape, for a chart for instance, is derived from `research/data/liquidations_moolah_bstock_ctx.json`.

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

`liquidations-week.json` - every `Liquidate` event on Lista Moolah (`0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c`, BNB Chain) in a market that involves a bStock, from 2026-06-18 to 2026-09-22: 121 rows. Read with `eth_getLogs` over blocks 101,500,000 to 123,963,563 (topic `0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41`, the Morpho-style `Liquidate(id, caller, borrower, repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares)`), then placed on the New York trading week. USD values use the Binance 1h close of the collateral at the liquidation hour; the loans are USD stablecoins. This is the data behind the planisphere on the landing page: every liquidation figure there (counts, dollars, shares, the dollars row of the clock-vs-money chart) is computed from this file. The clock row of that chart and the 81% / 29% figures are read from the NYSE calendar in `config/nyse-calendar.json` via `@ballast/risk`.

Fields: `h` (hour of the week in New York time, Monday 00:00 = 0), `usd` (repaid amount in USD), `s` (session at the time: regular, pre, post, overnight, holiday), `g` (group, below), `c` (bStock symbol), `tx` (transaction hash, linked to BscScan from each star), `et` (New York timestamp), `t` (timing class for organic rows, e.g. `regular: first 90 min`).

Groups:
- `organic` (33 rows, $30.6k repaid): real borrowers. $24.8k of it (81%) was repaid in the first 90 minutes after a regular open.
- `seed` (87 rows, $4 to $26 each): one test address, `0x05e3a7a66945ca9af73f66660f22ffb36332fa54`, that opened tiny positions across many markets. They mark when prices crossed the line but are not losses, so the page draws them as hollow, dimmed rings and says so.
- `loan` (1 row): the one market where a bStock was the loan asset rather than the collateral. The "0 of 120" weekend figure counts the 120 bStock-collateral rows.

No row falls between Friday 20:00 and Sunday 20:00 New York time.

## Figures from the gap study

The landing page also quotes figures from Ballast's gap study, first run on 2026-09-25. The scripts and their outputs are in `research/` (see `research/README.md`); `python research/check_figures.py` recomputes every headline figure from the committed data without network access.

- **p99 down-gaps 4.4% overnight, 5.5% weekend, 4.3% holiday, 17.9% earnings; "36 names, 6.3 years".** Yahoo Finance daily regular-session OHLC (split-adjusted), 2020-06-01 to 2026-09-24. Gap = (open + ex-dividend cash) / previous close - 1; the down tail is max(0, -gap). Windows: consecutive weekdays (overnight), Friday to Monday (weekend), any other closure longer than a day (holiday or long weekend), and for each earnings date the larger of the two adjacent overnight gaps (earnings, removed from the other classes). Pooled over the 36 tickers with at least 5 years of history, leveraged ETFs excluded: n = 42,678 / 9,997 / 2,160 / 788. The per-ticker p99s in `config/bsc-mainnet.json` (`gapBps`) come from the same run; the oracle band on the page is drawn from those values with the rule in `contracts/src/SessionAwareFeed.sol`.
- **Correlation 0.97 / 246 weekends.** The Monday open gap regressed on the bStock price (Binance 1h klines) at 09:00 New York on Monday, relative to the Friday close: correlation 0.97 over the 597 normal weekends of all 77 bStocks since listing (R2 0.94; for the 20 most-held names R2 0.95). 246 is the number of weekends, long weekends included, for those 20 names in the same sample. On Saturday and Sunday the bStock price says much less about Monday (R2 at most 0.2 before the US overnight venues reopen on Sunday evening).
- **12% of non-stock positions liquidated on weekends.** The same Moolah liquidator addresses liquidated 18 of 152 non-stock positions on a weekend over 2026-05-31 to 2026-09-25, from the same `Liquidate` scan as `liquidations-week.json`.
- **Venus seized no bStock collateral.** Two routes over the same period: every `Transfer` of the four Venus bStock vTokens (vTSLAB, vNVDAB, vSPCXB, vSKHYB; 1,114 logs, no `LiquidateBorrow` in the receipts of the 47 that were neither mint nor redeem), and the Venus liquidations API (3,759 core-pool liquidations since 2026-06-01, none with a bStock collateral market).

## Inputs of PROOF.md

`pnpm proof` renders `PROOF.md` from these two files and from `contracts/deployments/56.json`. Both are kept by hand.

`proof-txs.json` - mainnet transactions worth showing, as a list of `{ "label", "txHash", "at", "note", "step", "chainId" }`: what the transaction is, its hash (0x and 64 hex digits), when it was mined as a UTC time such as `2026-10-09T19:02:11Z`, and an optional note (say so here when a transaction reverted on purpose). Add an entry only for a transaction that exists; the command stops on a malformed hash or date.

`test-counts.json` - one entry per test suite: the command, the passed, failed and skipped counts, and the date of the last full run. Update it after running a suite in full. The command refuses to write the page when a contract count differs from the number of test functions in `contracts/test`.

The optional `step` ties a transaction to a step of the recorded cycle on `/judge` (`apps/web/public/replay/cycle.json`, written by `scripts/demo/record-replay.ts`). Keys in use: `register`, `deploy`, `overlay`, `open-account`, `set-path`, `job-fund`, `shield`, `restore-refused`, `restore`, `job-settle`. A step without an entry says on the page that it has no BNB Chain transaction yet; nothing is shown in its place. `scripts/demo/mainnet.ts` appends its own transactions here with `chainId`.

