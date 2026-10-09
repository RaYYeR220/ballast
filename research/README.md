# Research: when do bStock loans get liquidated, and how big are the gaps

This directory is the study behind the numbers in the top-level README: the scripts that produced them, the data they produced, and a checker that recomputes every published figure from that data.

```bash
python research/check_figures.py      # no network, standard library only, about 2 seconds
```

It prints one line per figure and exits non-zero if any of them differs from the documented value.

## The figures

| Figure | Value | Recomputed from |
|---|---|---|
| Liquidations of bStock collateral on Lista Lending | 120 | `data/liquidations_moolah_bstock_ctx.json` |
| Of them on a weekend (Friday 20:00 to Sunday 20:00 New York time) | 0 | the same, session derived from each timestamp |
| Debt repaid in them, bad debt | $31.6k, $0 | the same |
| Seed account: liquidations, markets, debt repaid | 87, 52, $1.0k | the same |
| Organic liquidations, borrowers, debt repaid | 33, 15, $30.6k | the same |
| Organic dollars in the first 90 minutes after the regular open | 81% ($24.8k) | the same |
| Organic dollars in the first 90 minutes after a weekend or holiday | 59% ($17.9k) | the same |
| Liquidations while the market was closed, by count and by dollars | 72.5%, 14.5% | the same |
| Share of the sample period the market was closed | 81.6% | the calendar in `session.py` |
| Share of an ordinary week the market is closed | 81% (32.5 of 168 hours open) | arithmetic |
| Overnight session: share of liquidations, share of time | 40.8%, 22.7% (1.8 times) | the same |
| Closed-session liquidations priced more than 3% under the next regular open | 17 of 87, $379 | the same |
| Control: other Moolah liquidations, and how many on a weekend | 152, 18 (12%) | `data/liquidations_moolah_other.json` |
| Closures in the dataset, bStocks | 3,378, 77 | `../data/closure-windows.json` |
| Weekends of the 20 most-held names with the token more than 3% / 5% from Friday's close | 37.4% / 17.5% of 246 | the same |
| R2 of the weekend token price against Monday's gap, before the US overnight venues reopen | at most 0.2 (0.049, -0.021, 0.185) | `data/weekend_timing_points.json` |
| The same when they reopen on Sunday evening, at 04:00 and at 09:00 New York time | 0.203, 0.637, 0.937 | the same |
| Correlation of the token at 09:00 New York time with Monday's gap | 0.97 over 597 weekends | the same |
| p99 down-gap, close to next open: overnight, weekend, holiday, earnings | 4.4%, 5.5%, 4.3%, 17.9% | `data/gap_windows.csv` |
| Tickers and closures behind those four | 36; 42,678 / 9,997 / 2,160 / 788 | the same |
| Gap buffers in `config/bsc-mainnet.json` | equal to the per-ticker p99 of the study | the same |
| Venus: bStock vToken transfers, candidates, liquidations among them | 1,114, 47 in 28 transactions, 0 | recorded in `data/venus_seizures.json` |

The Venus row is the one the checker cannot recompute offline: the answer lives in transaction receipts. `venus_seizures.py` fetches them again.

## Method

### Sample

BSC blocks 101,500,000 to 123,963,563, from 31 May 2026 (before the first bStock listing) to 25 September 2026, the day the study was run. The first liquidation of bStock collateral in that range is on 18 June and the last on 22 September; shares of time are measured between those two.

### Liquidations

`scan_logs.py liq` reads every `Liquidate(bytes32 id, address caller, address borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)` event of Lista Lending (Moolah, `0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c`): 273 in the range. `liq_analysis.py` resolves each market id with `idToMarketParams` and keeps the 121 whose collateral or loan token is one of the 80 bStocks in `data/bstocks.json`. In 120 the bStock is the collateral; in 1 it is the loan. The other 152 are the control group.

Amounts are 18-decimal tokens. A stablecoin loan counts as $1. A bStock amount is valued at the Binance 1h close of the hour of the liquidation.

### Sessions

`session.py` places a timestamp in New York time: regular 09:30 to 16:00, pre-market from 04:00, post-market to 20:00, overnight 20:00 to 04:00 on weeknights and Sunday from 20:00, weekend from Friday 20:00 to Sunday 20:00, and holiday for the whole day of an NYSE full-day holiday. Sunday evening counts as overnight, not weekend, because the US overnight venues are open again. "Closed" is everything but regular.

### Seed and organic

One borrower was liquidated 87 times in 52 markets for $4 to $26 a time: positions of about $15 opened at the liquidation threshold. Those liquidations are useful, they mark the moment the oracle crossed a threshold, but they are nobody's loss. The rule in `liq_stats.py`: an account with at least 20 liquidations and a median repaid amount under $50 is a seed account. One account qualifies. The other 33 liquidations, by 15 borrowers, are the organic set.

The "0 of 120" counts all 120, seed included. The dollar shares use the organic set, because 87 near-identical dust liquidations would otherwise say nothing about money.

### The first 90 minutes

An organic liquidation in the regular session is "first 90 min" when it happened less than 90 minutes after 09:30 New York time, and "after weekend/holiday" when in addition the calendar day before was not a trading day. 11 of the 33 are in the first 90 minutes and carry $24.8k of $30.6k (81%); 3 of those follow a weekend or holiday and carry $17.9k (59%).

### The control group

The 152 Moolah liquidations in markets without a bStock went through the same oracle stack and the same liquidators over the same period. 18 of them (12%) fell on a weekend. So the liquidators do work weekends; bStock prices just did not move enough.

### Venus

`scan_logs.py venus` reads every `Transfer` of the four Venus vTokens backed by a bStock. A liquidation would move seized vTokens from borrower to liquidator, a transfer that is neither a mint nor a redeem. `venus_seizures.py` takes those candidates and looks for `LiquidateBorrow` in the receipt of each transaction. None has one.

### Closures and the weekend price

`fetch_klines.py` and `fetch_yahoo.py` download Binance 1h klines of every bStock/USDT pair and daily regular-session prices of the underlying. `weekend.py` builds one row per bStock and closure, from a regular close of the stock to its next regular open, with the token's path in between: 3,378 rows, committed as `../data/closure-windows.json` (the backtest replays the same file; its fields are described in `../data/README.md`).

`weekend_timing.py` reads the token at six moments of each ordinary weekend, as a return against Friday's close, and scores it as a forecast of the stock's Monday gap. R2 is `1 - sum((token - gap)^2) / sum((gap - mean gap)^2)`. Until the US overnight venues reopen on Sunday at 20:00 New York time it never exceeds 0.2 (it is 0.203 at the moment they do); at 09:00 on Monday it is 0.94, and the correlation is 0.97.

### Gaps

`gaps.py` measures `gap = (open + dividend going ex that day) / previous close - 1` on daily regular-session prices from 1 June 2020 to 24 September 2026 for the 46 tickers in `data/tickers.json`. Each closure is a weekday overnight (consecutive days), a weekend (Friday to Monday) or a holiday or long weekend (anything else). Earnings come from the Nasdaq calendar, which does not say whether a company reported before the open or after the close: of the two closures next to an earnings date the one with the larger absolute gap is the earnings closure, and the other is dropped from every class.

The down-gap is `max(0, -gap)`. Quantiles use linear interpolation. The pooled figures use the 36 tickers with at least 5 years of history, without the two 3x leveraged ETFs. The start date is where the earnings calendar starts; it also leaves out March 2020.

## Reproduce

Python 3.9 or newer. The checker and the offline steps need nothing else.

```bash
cd research
pip install -r requirements.txt          # requests, for the download steps only
export ARCHIVE_RPC_URL=<a BSC archive node>

python scan_logs.py liq                  # 1  Liquidate logs: about 450 requests
python fetch_klines.py                   # 2  Binance klines, 80 pairs
python fetch_yahoo.py                    # 3  daily prices, 80 tickers
python fetch_earnings.py                 # 4  earnings calendar: about 1,650 requests
python liq_analysis.py                   # 5  one row per liquidation      -> data/liquidations_moolah_other.json
python liq_context.py                    # 6  next-open context            -> data/liquidations_moolah_bstock_ctx.json
python liq_stats.py                      # 7  session shares, organic set  -> data/liq_headline.json, data/liq_organic.json
python weekend.py                        # 8  closures                     -> ../data/closure-windows.json
python weekend_stats.py                  # 9  excursions                   -> data/weekend_stats.json
python weekend_timing.py                 # 10 the weekend price            -> data/weekend_timing.json, data/weekend_timing_points.json
python gaps.py                           # 11 gap quantiles                -> data/gap_windows.csv, data/gap_quantiles.json
python scan_logs.py venus                # 12 vToken transfers
python venus_seizures.py                 #    receipts                     -> data/venus_seizures.json
python check_figures.py
git status --short data ../data          # what changed against the committed files
```

Steps 7, 9 and `check_figures.py` run from the committed data alone. Steps 6, 8, 10 and 11 need the downloads in `cache/`, which is not committed.

Runtime on a home connection: the two log scans 10 to 15 minutes each on a rate-limited public archive endpoint (faster with a key), the earnings calendar about 15 minutes, the other downloads a minute or two, every offline step a few seconds.

We ran the whole sequence again on 8 October 2026, two weeks after the first run. Steps 1 to 10 gave back, byte for byte, every file the first run had produced: the liquidation files, the closure dataset, the weekend statistics and the timing summary. Step 11 gave the same quantile table but for one per-ticker maximum that moved by 1 bp, because this version rounds each gap to seven decimals before it summarises. Step 12 found the same 1,114 transfers, 47 candidates and no liquidation.

## Data

| File | What it is |
|---|---|
| `data/bstocks.json` | the 80 bStock token addresses with symbol and underlying ticker (input) |
| `data/tickers.json` | the 46 underlying tickers of the gap study (input) |
| `data/market_params.json` | Moolah market id to loan token, collateral token, oracle, rate model and LLTV, as read from the chain |
| `data/liquidations_moolah_bstock_ctx.json` | the 121 liquidations: time, session, market, symbols, borrower, liquidator, amounts, USD values, transaction, and for closed-session rows the next regular open |
| `data/liquidations_moolah_other.json` | the 152 control liquidations: time, session, market, transaction |
| `data/liq_headline.json` | count and dollars per session, and the share of time in each session |
| `data/liq_organic.json` | the 33 organic liquidations with their timing tag, and the seed totals |
| `data/weekend_stats.json` | excursion and forecast statistics per group and closure type |
| `data/weekend_timing.json` | the six-moment forecast scores, and the dark-window excursions |
| `data/weekend_timing_points.json` | the samples behind it: per weekend, the token's return at each moment |
| `data/gap_windows.csv` | 62,213 closures: ticker, reopening day, days closed, gap, class (`on`, `we`, `hol`, `earn`, `adj`) |
| `data/gap_quantiles.json` | p95, p99 and p99.9 per ticker and class, and pooled |
| `data/venus_seizures.json` | counts from the Venus check |
| `../data/closure-windows.json` | the 3,378 closures (step 8) |

Every liquidation row carries its transaction hash, so any of them can be opened on BscScan. Addresses in these files are those of the public `Liquidate` events. A dataset elsewhere in this repository that shows the same liquidations in another shape, for a chart for instance, is derived from `data/liquidations_moolah_bstock_ctx.json`.

## Caveats

- **The klines are a proxy for the oracle.** The lenders read an on-chain feed, not Binance. We compared the two over one weekend by reading the feed at past blocks: it updated hourly and stayed within about 12 bps of the Binance price. That comparison is not part of the published scripts. Everything here that says "the token's price" means the Binance spot price of the bStock/USDT pair.
- **An archive node is required** for the two log scans and for block timestamps. Public full nodes refuse `eth_getLogs` over history. A re-scan to a later block will find more liquidations than the committed files; the defaults reproduce the sample.
- **Three and a half months.** The liquidation sample starts with the first listing. Zero weekend liquidations in 14 weekends is an observation, not a law. In the same period the token moved more than 5% from Friday's close on 17.5% of weekends for the most-held names.
- **Small dollars.** $31.6k was repaid in total and three liquidations account for 59% of the organic dollars. The percentages are what happened; they are not stable estimates.
- **The seed rule is ours.** Twenty liquidations and a $50 median separate one account cleanly here. Another sample may need another rule. The 0 of 120 does not depend on it; the 81% and 59% do.
- **Sessions are approximate at the edges.** Only full-day holidays of 2026 are modelled, no early closes, and the closure builder assumes daylight time (true for the whole sample).
- **Earnings timing is inferred.** Taking the larger of the two adjacent gaps biases the earnings class upward when neither closure was the reaction. With about 25 earnings dates per ticker, a per-ticker earnings p99 is close to the worst quarter on record.
- **Gaps ignore the path.** A gap is measured to the regular open. A token that trades around the clock can go further than that in between, which is what the closure dataset is for.
- **Third-party data can be revised.** Yahoo and Nasdaq serve what they serve today. Our re-run two weeks later matched, which is no promise for next year.

## Not here

The original study had one more part, on positions that were open at the time and how far they were from liquidation. It is not published: it describes loans that are still open.
