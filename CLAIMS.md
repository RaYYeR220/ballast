# Claims

Every statement the README and the other documents make, with the kind of evidence behind it. If a statement is not in this ledger, treat it as unproven and tell us.

## Tiers

| Tier | Meaning |
|---|---|
| REPRODUCIBLE | A command in this repository gives the result on your machine. The command is in the row. |
| VERIFIED-LIVE | A transaction or a URL shows it. The link is in the row or in [PROOF.md](PROOF.md). |
| MODELED | The output of a model or an argument. The assumptions are in the row. |
| MEASURED | Our own measurement from public data. Sources and method are in the row. The script and the row-level table are not in this repository, so you cannot re-run it from here. |
| NOT-CLAIMED | Something we do not say. Listed so that nobody assumes it. |

The first three and the last are the usual ledger. MEASURED is there because some of our headline numbers fit none of the others honestly: they are not models, and without the scanner in the repository they are not reproducible either.

Commands assume the repository root, `pnpm install` done, and Foundry installed. `forge` commands run in `contracts/`.

## A. The measurement

| # | Claim | Tier | Evidence |
|---|---|---|---|
| A1 | 120 liquidations of bStock collateral on Lista Lending between BSC blocks 101,500,000 and 123,963,563 (2026-05-31 to 2026-09-25); none between Friday 20:00 and Sunday 20:00 New York time. | MEASURED | `Liquidate` events of Lista Moolah, `0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c`, topic0 `0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41`. Each market id resolved with `idToMarketParams` and kept when the collateral is a bStock. Block times converted to US Eastern. To recount you need an archive RPC and your own filter; the events are public. |
| A2 | Those 120 liquidations repaid $31.6k of debt and left no bad debt. | MEASURED | Same events (`repaidAssets`, `badDebtAssets`). Loans are stablecoins counted at $1. |
| A3 | 87 of the 120 are dust-sized positions of one account opened at the liquidation threshold (about $1.0k in total). The other 33, the "organic" set, repaid $30.6k. | MEASURED | Same events, grouped by borrower. We publish no address and no row-level table. |
| A4 | 81% of organic repaid dollars fell in the first 90 minutes after the regular open ($24.8k of $30.6k); 59% in the first 90 minutes after a weekend or holiday ($17.9k). | MEASURED | Same events, bucketed by time since 09:30 New York time on the day of the liquidation. |
| A5 | Venus seized no bStock collateral in the same period. | MEASURED | Transfer logs of the four bStock vTokens checked for `LiquidateBorrow`, and Venus's public liquidations API. |
| A6 | p99 close-to-open down-gap: 4.4% weekday overnight, 5.5% weekend, 4.3% holiday, 17.9% around earnings. | MEASURED | Daily split-adjusted prices from Yahoo Finance, 2020-06-01 to 2026-09-24, 36 US tickers with at least 5 years of history. Gap = (open + ex-dividend cash) / previous close - 1; the quantile is taken over max(0, -gap). Earnings nights from the Nasdaq earnings calendar. Sample sizes 42,678 / 9,997 / 2,160 / 788. |
| A7 | The per-ticker gap buffers the contracts use. | REPRODUCIBLE | They are in the repository: `node -e "for (const t of require('./config/bsc-mainnet.json').tickers) console.log(t.symbol, JSON.stringify(t.gapBps))"`. How they were derived is A6, per ticker. |
| A8 | The NYSE regular session is 32.5 of 168 hours; the market is closed about 81% of the week. | REPRODUCIBLE | Arithmetic: 5 sessions of 6.5 hours. The session boundaries are in `config/nyse-calendar.json`. |
| A9 | The closure dataset holds 3,378 closures of 77 bStocks: 2,688 overnight, 597 weekend, 93 holiday. | REPRODUCIBLE | `node -e "const w=require('./data/closure-windows.json');const t={};for(const r of w)t[r.type]=(t[r.type]||0)+1;console.log(w.length,new Set(w.map(r=>r.sym)).size,t)"`. The file was built from Binance public klines and Yahoo daily prices; that builder is not in the repository (`data/README.md` describes the fields). |
| A10 | Backtest on an LLTV 0.75 market: from a starting LTV of 0.70 the shield fires in 652 of 697 windows, repays 2.6% of the debt on average and cuts liquidations from 5 to 2; from 0.72 it fires in all 697, repays 5.1% and cuts 27 to 2. | MODELED, REPRODUCIBLE | `pnpm backtest`. Assumptions, from `data/README.md`: the cushion always covers the shield, no collateral is sold, no minimum loan, earnings nights are not flagged in the data, oracle lag and the bStock premium are ignored, only the 12 tickers with a configured buffer are replayed, one sample of about three and a half months. |
| A11 | A shielded loan "survives the gap". | MODELED | It survives a gap up to the ticker's p99 buffer for that window with health factor 1.05 to spare. A larger gap still liquidates it: A10 has two such cases. |

## B. Contracts

Unit tests run without a network. Fork tests run against BSC mainnet state; [MOCKS.md](MOCKS.md) says what is mocked on top.

| # | Claim | Tier | Evidence |
|---|---|---|---|
| B1 | The keeper can call `shieldRepay`, `restore` and `shieldDeleverage`; every owner function reverts with `NotOwner()` for it. | REPRODUCIBLE | `forge test --match-test test_keeperCannotTouchOwnerFunctions` |
| B2 | `restore` while the US market is closed reverts with `RestoreRefused(NOT_REGULAR)` and moves nothing, on Lista and on Venus. | REPRODUCIBLE | `forge test --match-test test_restore_refusedOnWeekend` |
| B3 | `canAddRisk` says no for each reason: unknown ticker, calendar unknown, not the regular session, too soon after the open, overlay stale, flagged, price unavailable, reference stale, not converged, window ahead. | REPRODUCIBLE | `forge test --match-contract SessionOracleTest --match-test test_canAddRisk` |
| B4 | A restore cannot pass the owner's `maxLtvBps`, and the keeper cannot restore with `autoRestore` off. | REPRODUCIBLE | `forge test --match-test test_restore_` (see `test_restore_respectsMandate` and `test_restore_keeperNeedsAutoRestore`) |
| B5 | A sale needs the owner's path, an LTV above the shield LTV, a closure within the horizon (or an LTV above the cap), must not overshoot, and must clear the oracle floor and the caller's `minOut`. | REPRODUCIBLE | `forge test --match-test "[dD]eleverage"` (18 tests) |
| B6 | A keeper sale spends the cushion first and sells only if that is not enough; a sale switches `autoRestore` off. | REPRODUCIBLE | `forge test --match-test test_keeperDeleverage_` |
| B7 | Restore and shield cannot be chained across sessions to turn collateral into cushion. | REPRODUCIBLE | `forge test --match-test test_crossSessionRestoreLoop_onlyRepaysNeverSells` |
| B8 | A keeper call never sends a token anywhere but the venue, the owner's swap route and the account itself. | MODELED | An argument from reading `BallastAccountBase.sol` and `ListaAccount.sol`, backed by `test_flashDeleverage_reducesLtvAndKeepsProceedsInside`, `testFuzz_shieldRepayNeverRaisesLtv` and `test_directFlashLoanCallbackUnauthorized`. Assumes Moolah, Venus and the router behave as they do on the fork. No formal proof and no audit. |
| B9 | The owner can always repay, take the collateral out and take the cushion out, also after donated collateral. | REPRODUCIBLE | `forge test --match-test Exit` |
| B10 | A seizure is detected exactly, can be latched by anyone, and cannot be hidden by donating collateral back. | REPRODUCIBLE | `forge test --match-test iquidation` |
| B11 | `CushionVault`: only the cover's keeper, only near a closure, only under the daily cap, only on the user's own debt; the user withdraws at any time; one user's cover cannot pay for another's loan. | REPRODUCIBLE | `forge test --match-contract CushionVaultForkTest` |
| B12 | The publisher cannot post an overlay that lives longer than the maximum, an Ondo multiplier outside its bounds, or a reference price outside its rules. | REPRODUCIBLE | `forge test --match-contract SessionOracleTest --match-test test_post_`, then the same with `test_reference_` |
| B13 | `SessionCalendar` has no admin and no storage, and answers `UNKNOWN` outside 2026 and 2027. | REPRODUCIBLE | Read `contracts/src/SessionCalendar.sol`: constants and `pure` functions only. `forge test --match-test test_sessions_outsideTable` and `forge test --match-test test_canAddRisk_failsClosedAtTableEnd` |
| B14 | The TypeScript calendar the desk plans with agrees with the contract on the same boundary cases. | REPRODUCIBLE | `pnpm exec vitest run packages/risk/test/calendar.test.ts`. On a deployment, `pnpm verify:onchain` also compares the two on the head block. |
| B15 | `SessionAwareFeed`: passes through in the regular session, clamps to the band when closed, widens by one base band per 24 hours, stops at three, and degrades to the upstream price when it has no fresh reference. | REPRODUCIBLE | `forge test --match-contract SessionAwareFeedTest` |
| B16 | A -5% print twelve hours after Friday's close liquidates a Lista-oracle market and not the same market priced by the feed; a move that is still there in Monday's regular session liquidates both. | REPRODUCIBLE | `forge test --match-contract SessionAwareFeedForkTest -vv`. The Friday reference and the prints are set by the test (see MOCKS.md). |
| B17 | `BallastGuardian` pays the guardian only when the account was not liquidated and is healthy, refunds otherwise, settles only Submitted jobs, refuses self-dealing, and writes ERC-8004 feedback. | REPRODUCIBLE | `forge test --match-contract BallastGuardianForkTest` |
| B18 | Test counts: 57 unit, 99 fork, 499 TypeScript (2 skipped). | REPRODUCIBLE | The commands in [PROOF.md](PROOF.md) section 3. `pnpm proof` refuses to write the page when the contract counts differ from the test functions in the tree. |
| B19 | Deployed parameters: restore delay 90 minutes, horizon 3 hours, convergence 60 bps, reference age 26 hours, overlay lifetime 6 hours, Ondo drift 100 bps, reference deviation 300 bps; vault horizon 3 hours; guard job minimum budget 0.01 token and grace 1 hour. | REPRODUCIBLE | `contracts/script/Deploy.s.sol`. `pnpm verify:onchain` checks a deployment against the same values. |

## C. Desk, client and tools

| # | Claim | Tier | Evidence |
|---|---|---|---|
| C1 | In the desk, no language-model output reaches a decision. | REPRODUCIBLE | `git grep -n "generateText" -- apps/agent/src` finds one caller, `notes.ts`. Its output goes to `NotesStore`, which only the read API reads: `git grep -n "NotesStore" -- apps/agent/src`. The Agent Studio project under `apps/agent/app/agent` also holds the scaffold's model call for seller deliverables; that rail is off (C10). |
| C2 | The desk sends nothing until `DRY_RUN=false`. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/config.test.ts apps/agent/test/tx.test.ts` |
| C3 | The keeper shields in the hour before a close and for the whole session before an earnings gap, restores only up to what it repaid itself and never above the pre-shield LTV, and falls back to a cushion repay when a sale fails. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/keeper.test.ts` |
| C4 | The publisher turns Binance RWA status into overlay flags, posts only values the contract will accept, and backs off a symbol the contract refuses. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/publisher.test.ts` |
| C5 | The keyless Binance RWA status endpoints answer without a key. | VERIFIED-LIVE | `curl -s "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=56&contractAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436"` returned `"code":"000000"` with a status for NVDAB on 2026-10-08. |
| C6 | The Transaction API calls (`simulate`, `broadcast`) are wired into the desk's sender for chain 56. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/tx.test.ts` runs the sender against a stand-in for the API. That the live API accepts these requests is NOT-CLAIMED (E8). |
| C7 | Request signing and envelope handling of the keyed client. | REPRODUCIBLE | `pnpm exec vitest run packages/binance`. Against the live API: `BINANCE_WEB3_API_KEY=... BINANCE_WEB3_API_SECRET=... pnpm exec vitest run packages/binance/test/live.test.ts`, which we have not been able to run. |
| C8 | Market, Trading, Wallet, DeFi, b402 and the keyed RWA Data module have no caller. | REPRODUCIBLE | `git grep -n "@ballast/binance" -- apps packages scripts ":!*/test/*"` lists every import: the keyless client, the keyed client, `transaction`, and types. |
| C9 | The x402 buyer pays only the exact scheme with EIP-3009 in three pinned stablecoins, and checks a per-call cap ($0.05 at most) and a daily cap ($0.50 at most) before it signs. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/x402.test.ts apps/agent/test/earnings.test.ts` against a stand-in merchant. |
| C10 | The Agent Studio ERC-8183 seller rail is off and the faces stay on loopback on chain 56. | REPRODUCIBLE | `grep -n -A6 "payments.erc8183" apps/agent/app/agent/studio.toml`, and `pnpm exec vitest run apps/agent/test/config.test.ts`. |
| C11 | A guard job's deliverable is the keccak256 of a stored evidence file, written once and served byte for byte. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/guardian.test.ts apps/agent/test/api.test.ts` |
| C12 | The read API is GET only and never returns a configured secret. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/api.test.ts` |
| C13 | The MCP server has eight tools; none signs or sends. | REPRODUCIBLE | `pnpm exec vitest run packages/mcp`. `packages/mcp/src/tools.ts` imports no wallet or account code. |
| C14 | `pnpm verify:onchain` compares deployed bytecode with the local build, the wiring, the parameters, the tickers, the publisher's ERC-8004 identity and the calendar. | REPRODUCIBLE | Run it against a fork deployment (`CHAIN_ID=31337 BSC_RPC_URL=http://127.0.0.1:8545 pnpm verify:onchain`); the byte comparison has its own test, `apps/agent/test/verify-onchain.test.ts`. |
| C15 | The fork demo: a desk on a local fork shields a Lista account and a cover before the close and settles a guard job after its window. | REPRODUCIBLE | The commands in the README. It needs an archive-capable RPC endpoint. [MOCKS.md](MOCKS.md) lists what the demo replaces on the fork. |

## D. Mainnet

These become VERIFIED-LIVE when, and only when, [PROOF.md](PROOF.md) shows the address or the transaction. PROOF.md is rendered from a deployment file and a transaction list; it cannot show something that is not in them. Until a row's link is there, read the row as NOT-CLAIMED.

| # | Claim | Tier when PROOF.md lists it | Where |
|---|---|---|---|
| D1 | The eight Ballast contracts are deployed on BSC mainnet. | VERIFIED-LIVE | PROOF.md section 1 |
| D2 | The desk has an ERC-8004 identity and is the Session Oracle's publisher. | VERIFIED-LIVE | PROOF.md section 2, and `pnpm verify:onchain` |
| D3 | A Venus account was shielded before a close and restored inside the restore window by the desk. | VERIFIED-LIVE | PROOF.md section 2 |
| D4 | A `restore` sent while the market was closed reverted on mainnet with `RestoreRefused`. | VERIFIED-LIVE | PROOF.md section 2 |
| D5 | A guard job was funded, submitted and settled through `BallastGuardian`. | VERIFIED-LIVE | PROOF.md section 2 |
| D6 | The desk is running and its read API is public. | VERIFIED-LIVE | The URL in [JUDGES.md](JUDGES.md) |

## E. NOT-CLAIMED

| # | We do not claim |
|---|---|
| E1 | That Binance Agentic Wallet or Wallet Skills are used. They are not. |
| E2 | That a Lista loan was opened on mainnet. Lista accounts, flash deleverage and Lista covers are proven on a fork of mainnet state. |
| E3 | That Lista, Venus or any other lender has adopted `SessionAwareFeed`. Nobody reads it. |
| E4 | That the overlay publisher is decentralised. It is one bounded key, and the oracle has an owner with no timelock. |
| E5 | That the calendar works after 2027. It covers 2026 and 2027 and fails closed after that. |
| E6 | That Ballast prevents liquidation. It lowers the odds for gaps inside a p99 buffer. |
| E7 | That closures have cost borrowers or lenders large sums so far. The measured total is $31.6k repaid and no bad debt. |
| E8 | That the keyed Binance Web3 API has been run live from this code. It has not: no key was available. |
| E9 | That Market, Trading, Wallet, DeFi or b402 are used by the product. They are client code with tests. |
| E10 | That an x402 payment has ever been made. The buyer is off by default and has only met a stand-in merchant in tests. |
| E11 | That the headline measurement can be re-run from this repository. See the MEASURED rows. |
| E12 | Anything about specific open positions on Lista or Venus. We publish aggregates only. |
| E13 | That a language model decides anything. It writes notes after the event. |
| E14 | That the contracts are audited. |
| E15 | That the desk is highly available. It is one process with one hot key. |
| E16 | That the fork demo runs on a keyless public RPC. The fork tests do; the demo needs an endpoint that keeps serving the forked block. |
| E17 | That a test shows `canAddRisk` answering yes on real mainnet prices. In the fork tests the yes is mocked ([MOCKS.md](MOCKS.md)); every refusal is real. The real yes is the mainnet restore in D3. |
