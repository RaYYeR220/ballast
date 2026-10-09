# Claims

Every statement the README and the other documents make, with the kind of evidence behind it. If a statement is not in this ledger, treat it as unproven and tell us.

## Tiers

| Tier | Meaning |
|---|---|
| REPRODUCIBLE | A command in this repository gives the result on your machine. The command is in the row. |
| VERIFIED-LIVE | A transaction or a URL shows it. The link is in the row or in [PROOF.md](PROOF.md). |
| MODELED | The output of a model or an argument. The assumptions are in the row. |
| NOT-CLAIMED | Something we do not say. Listed so that nobody assumes it. |

Commands assume the repository root, `pnpm install` done, and Foundry installed. `forge` commands run in `contracts/`.

## A. The measurement

The study, its scripts and its data are in [research/](research/README.md). `python research/check_figures.py` recomputes every figure below from the committed data, with no network and no dependency, and exits non-zero if one differs. "Re-run" in a row means the download steps in `research/README.md`, which rebuild that data from the chain and from public market data.

| # | Claim | Tier | Evidence |
|---|---|---|---|
| A1 | 120 liquidations of bStock collateral on Lista Lending between BSC blocks 101,500,000 and 123,963,563 (2026-05-31 to 2026-09-25); none between Friday 20:00 and Sunday 20:00 New York time. | REPRODUCIBLE | `python research/check_figures.py`, from `research/data/liquidations_moolah_bstock_ctx.json`: one row per `Liquidate` event with its transaction hash, session recomputed from the timestamp. Re-run: `scan_logs.py liq`, `liq_analysis.py`, `liq_context.py`; needs an archive RPC. Our re-run on 2026-10-08 returned the same file byte for byte. |
| A2 | Those 120 liquidations repaid $31.6k of debt and left no bad debt. | REPRODUCIBLE | Same command, same file (`repaid_usd`, `bad_debt_usd`). Stablecoin loans count as $1. |
| A3 | 87 of the 120 are dust-sized positions of one account opened at the liquidation threshold (about $1.0k in total, 52 markets). The other 33, the "organic" set, repaid $30.6k. | REPRODUCIBLE | Same command. The rule that separates the seed account (20 or more liquidations, median under $50) is in `research/liq_stats.py` and is ours; see the caveats in `research/README.md`. |
| A4 | 81% of organic repaid dollars fell in the first 90 minutes after the regular open ($24.8k of $30.6k); 59% in the first 90 minutes after a weekend or holiday ($17.9k). | REPRODUCIBLE | Same command. Three liquidations carry the 59%: the percentages describe a small sample. |
| A5 | Venus seized no bStock collateral in the same period. | REPRODUCIBLE | Re-run: `scan_logs.py venus`, then `venus_seizures.py`, with an archive RPC. The checker only reads the recorded result (`research/data/venus_seizures.json`): the proof is in transaction receipts, which it cannot recompute offline. |
| A6 | p99 close-to-open down-gap: 4.4% weekday overnight, 5.5% weekend, 4.3% holiday, 17.9% around earnings (36 tickers, 2020-06-01 to 2026-09-24; 42,678 / 9,997 / 2,160 / 788 closures). | REPRODUCIBLE | `python research/check_figures.py`, from the 62,213 gap rows in `research/data/gap_windows.csv`. Re-run: `fetch_yahoo.py`, `fetch_earnings.py`, `gaps.py`. Earnings nights are inferred, see the caveats. |
| A7 | The per-ticker gap buffers the contracts use are the per-ticker p99 of that study. | REPRODUCIBLE | Same command: it compares all 48 values in `config/bsc-mainnet.json` with the study. |
| A8 | The NYSE regular session is 32.5 of 168 hours; the market is closed about 81% of the week (81.6% of the sample period, which had three holidays). | REPRODUCIBLE | Same command. Arithmetic, and the calendar in `research/session.py`. |
| A9 | The closure dataset holds 3,378 closures of 77 bStocks: 2,688 overnight, 597 weekend, 93 holiday. | REPRODUCIBLE | Same command, from `data/closure-windows.json`. Re-run: `fetch_klines.py`, `fetch_yahoo.py`, `weekend.py`; our re-run on 2026-10-08 returned the same file byte for byte. |
| A10 | On Saturday and Sunday a bStock's price says little about Monday's open: R2 against the Monday gap is at most 0.2 until the US overnight venues reopen on Sunday at 20:00 New York time. At 09:00 on Monday it is 0.94 and the correlation is 0.97 (597 weekends, 77 bStocks). | REPRODUCIBLE | Same command, from `research/data/weekend_timing_points.json`. "Price" is the Binance spot price of the bStock, used as a proxy for the lending oracle. |
| A11 | The 152 Moolah liquidations in markets without a bStock, same period, same liquidators: 18 on a weekend (12%). | REPRODUCIBLE | Same command, from `research/data/liquidations_moolah_other.json`. |
| A12 | Backtest on an LLTV 0.75 market: from a starting LTV of 0.70 the shield fires in 652 of 697 windows, repays 2.6% of the debt on average and cuts liquidations from 5 to 2; from 0.72 it fires in all 697, repays 5.1% and cuts 27 to 2. | MODELED, REPRODUCIBLE | `pnpm backtest`. Assumptions, from `data/README.md`: the cushion always covers the shield, no collateral is sold, no minimum loan, earnings nights are not flagged in the data, oracle lag and the bStock premium are ignored, only the 12 tickers with a configured buffer are replayed, one sample of about three and a half months. |
| A13 | A shielded loan "survives the gap". | MODELED | It survives a gap up to the ticker's p99 buffer for that window with health factor 1.05 to spare. A larger gap still liquidates it: A12 has two such cases. |

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
| B18 | Test counts: 57 unit, 99 fork, 987 TypeScript (2 skipped). | REPRODUCIBLE | The commands in [PROOF.md](PROOF.md) section 3. `pnpm proof` refuses to write the page when the contract counts differ from the test functions in the tree. |
| B19 | The parameters the deploy script sets: restore delay 90 minutes, horizon 3 hours, convergence 60 bps, reference age 26 hours, overlay lifetime 6 hours, Ondo drift 100 bps, reference deviation 300 bps; vault horizon 3 hours; guard job minimum budget 0.01 token and grace 1 hour. | REPRODUCIBLE | `contracts/script/Deploy.s.sol`. `pnpm verify:onchain` checks a deployment against the same values. |

## C. Desk, client and tools

| # | Claim | Tier | Evidence |
|---|---|---|---|
| C1 | In the desk, no language-model output reaches a decision. | REPRODUCIBLE | `git grep -n "generateText" -- apps/agent/src` finds one caller, `notes.ts`. Its output goes to `NotesStore`, which only the read API reads: `git grep -n "NotesStore" -- apps/agent/src`. The Agent Studio project under `apps/agent/app/agent` also holds the scaffold's model call for seller deliverables; that rail is off (C10). |
| C2 | The desk sends nothing until `DRY_RUN=false`. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/config.test.ts apps/agent/test/tx.test.ts` |
| C3 | The keeper shields in the hour before a close and for the whole session before an earnings gap, restores only up to what it repaid itself and never above the pre-shield LTV, and falls back to a cushion repay when a sale fails. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/keeper.test.ts` |
| C4 | The publisher turns Binance RWA status into overlay flags, posts only values the contract will accept, and backs off a symbol the contract refuses. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/publisher.test.ts` |
| C5 | The keyless Binance RWA status endpoints answer without a key. | VERIFIED-LIVE | `curl -s "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=56&contractAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436"` returned `"code":"000000"` with a status for NVDAB on 2026-10-08. The mainnet desk's `/api-health` (URL in [JUDGES.md](JUDGES.md)) lists every call it makes to these endpoints with their response codes. |
| C6 | The Transaction API calls are wired into the desk's sender for chain 56 (`simulate` before every write, `broadcast` for collateral sales only) and into the app's previews (`/api/simulate`). | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/tx.test.ts` and `pnpm exec vitest run apps/web` run both against a stand-in for the API. Live: the desk's `/api-health` counts its `simulate` calls and their codes, and the shield of D3 has `sim.via: "binance"` in `/feed?kind=shield` (VERIFIED-LIVE, URL in [JUDGES.md](JUDGES.md)). `broadcast` has carried the owner's buy (D9) and no collateral sale (E8). |
| C7 | Request signing and envelope handling of the keyed client. | REPRODUCIBLE | `pnpm exec vitest run packages/binance`. Against the live API: `BINANCE_WEB3_API_KEY=... BINANCE_WEB3_API_SECRET=... pnpm exec vitest run packages/binance/test/live.test.ts`. |
| C8 | The web app calls keyed RWA Data `price`, Market `candles`, Wallet `allTokenBalances`, DeFi `positions` and Transaction `simulate`, and the keyless status endpoints. The demo script calls Trading `quote`, `approveTransaction` and `swap`. b402 has no caller. | REPRODUCIBLE | `git grep -n "@ballast/binance" -- apps scripts packages ":!*test*"` lists every import; the README table names each call site. The Trading buy happened on mainnet: D9. |
| C9 | The x402 buyer pays only the exact scheme with EIP-3009 in three pinned stablecoins, and checks a per-call cap ($0.05 at most) and a daily cap ($0.50 at most) before it signs. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/x402.test.ts apps/agent/test/earnings.test.ts` against a stand-in merchant. |
| C10 | The Agent Studio ERC-8183 seller rail is off and the faces stay on loopback on chain 56. | REPRODUCIBLE | `grep -n -A6 "payments.erc8183" apps/agent/app/agent/studio.toml`, and `pnpm exec vitest run apps/agent/test/config.test.ts`. |
| C11 | A guard job's deliverable is the keccak256 of a stored evidence file, written once and served byte for byte. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/guardian.test.ts apps/agent/test/api.test.ts` |
| C12 | The read API is GET only and never returns a configured secret. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/api.test.ts` |
| C13 | The MCP server has eight tools; none signs or sends. | REPRODUCIBLE | `pnpm exec vitest run packages/mcp`. `packages/mcp/src/tools.ts` imports no wallet or account code. |
| C14 | `pnpm verify:onchain` compares deployed bytecode with the local build, the wiring, the parameters, the tickers, the publisher's ERC-8004 identity and the calendar. | REPRODUCIBLE | Run it against a fork deployment (`CHAIN_ID=31337 BSC_RPC_URL=http://127.0.0.1:8545 pnpm verify:onchain`); the byte comparison has its own test, `apps/agent/test/verify-onchain.test.ts`. |
| C15 | The fork demo: a desk on a local fork shields a Lista account and a cover before the close and settles a guard job after its window. | REPRODUCIBLE | The commands in the README. It needs an archive-capable RPC endpoint. [MOCKS.md](MOCKS.md) lists what the demo replaces on the fork. |
| C16 | `/judge` plays a cycle recorded on a fork of BNB Chain against the deployed contracts: every step is a real transaction on that fork, with its decoded result or revert. | REPRODUCIBLE | `apps/web/public/replay/cycle.json`, written by `scripts/demo/record-replay.ts` (the command is in its header; needs an anvil fork). The file's `forkOnly` list, shown on the page, says what the fork changed: the clock, frozen Lista prices, a mocked Chainlink feed, the impersonated desk address, a funded throwaway borrower. It is not a record of mainnet. |
| C17 | The sender keeps one transaction of the desk key in flight, never signs above a gas-price cap, halts when it cannot account for a nonce, and sends collateral sales only through the MEV-protected broadcast. | REPRODUCIBLE | `pnpm exec vitest run apps/agent/test/tx.test.ts`; the rules are written out in `apps/agent/README.md`. |
| C18 | The live desk runs with a target health of 1.30 after the gap, not the default 1.05. | VERIFIED-LIVE | `targetHfAfterGap` in the desk's `/health`. Venus's factors for TSLAB (60% collateral factor, 70% liquidation threshold): `cast call 0xfd36e2c2a6789db23113685031d7f16329158384 "markets(address)(bool,uint256,bool,uint256)" 0x97421799419eb782628e73e7220d8e0a207469a3 --rpc-url https://bsc-dataseed.bnbchain.org`. |

## D. Mainnet

A row is VERIFIED-LIVE when, and only when, [PROOF.md](PROOF.md) shows its address or transaction. PROOF.md is rendered from a deployment file and a transaction list; it cannot show something that is not in them. Rows that have not happened yet say so and are NOT-CLAIMED. Dates are 2026-10-09 and times are UTC unless a row says otherwise.

| # | Claim | Tier | Where |
|---|---|---|---|
| D1 | The eight Ballast contracts are deployed on BSC mainnet. | VERIFIED-LIVE | PROOF.md section 1 |
| D2 | The desk has an ERC-8004 identity and is the Session Oracle's publisher. | VERIFIED-LIVE | PROOF.md section 2, and `pnpm verify:onchain` |
| D3 | The desk shielded a live Venus account before a closure, by itself: `shieldRepay(0.18017 USDT)` at 19:03:48, 56 minutes before the weekend close. Debt 3.0101 to 2.8299 USDT, LTV 53.95% to 50.60%. | VERIFIED-LIVE | [The transaction](https://bscscan.com/tx/0x5a95ef60855620aa19156eccb223f1ad603df97d399e626de6828265b72104e5), in PROOF.md section 2. Its sender is the desk agent: `cast receipt 0x5a95ef60855620aa19156eccb223f1ad603df97d399e626de6828265b72104e5 from --rpc-url https://bsc-dataseed.bnbchain.org` prints `0xccD7f069275549793b2A8804A5691fCa6665D152`. The account is `0x64b08268efb8B266c43A1751dDbB91702CA925e3`; the desk's `/feed?kind=shield` has the event with its plan and simulation, and `/accounts` the state after it. |
| D4 | A `restore` sent while the market was closed reverted on mainnet with `RestoreRefused(NOT_REGULAR)`. | NOT-CLAIMED until PROOF.md lists it | Not sent yet: the owner sends it over the weekend of 10 and 11 October, and PROOF.md will show it with "revert, on purpose". Until then the refusal is REPRODUCIBLE on a fork (`forge test --match-test test_restore_refusedOnWeekend -vv`), and the oracle's answer can be read on mainnet at any time: `cast call 0x8Fc983D9cC9880e0FbBcd7F48304A175b4055388 "canAddRisk(bytes32)(bool,uint8)" $(cast format-bytes32-string TSLA) --rpc-url https://bsc-dataseed.bnbchain.org`. |
| D5 | Guard job 56956 was funded by the account's owner with 0.01 USD1, submitted by the desk after its window (15:14 to 16:14) and settled through `BallastGuardian`, which paid the desk and wrote ERC-8004 feedback. | VERIFIED-LIVE | [Fund](https://bscscan.com/tx/0x8188fe89d495e8810105e6e719db118416ef97aabcb880953d178cc7afb24af2), [submit](https://bscscan.com/tx/0x3530d03e046adcc653495ab8bc6821405f3d43edfa5947df03d00663598a9c79) and [settle](https://bscscan.com/tx/0x598a78fc848ae61106cfc86de48c19b7c82e58bc59d6ffd11177ac83e3a54c9d), in PROOF.md section 2. The deliverable is the keccak256 of the file served at https://34-185-146-173.sslip.io/evidence/56956, `0x2e35301a5aa7ac490019fc7e386969317e82cc6f0aa71a7d682cd71be7a19a3e`; the command under this table recomputes it, and the hash is in the input of the submit transaction. What the job does not show is in E21. |
| D6 | The desk is running and its read API is public. | VERIFIED-LIVE | The URL in [JUDGES.md](JUDGES.md) |
| D7 | The web app is live, with `/app`, `/oracle`, `/guardians`, `/evidence` and `/judge`. | VERIFIED-LIVE | https://ballast-desk.vercel.app |
| D8 | The desk's first overlay posts were all mined, although its own feed recorded 11 of them as dropped (nonces 2 to 12 of its key, 2026-10-08 18:07 to 20:02) and two as pending (nonces 13 and 15, 2026-10-09 about 01:07 and 06:10). The cause was the RPC: `bsc-rpc.publicnode.com` refuses `eth_getTransactionReceipt`. | VERIFIED-LIVE for the chain half and for the cause | `cast nonce 0xccD7f069275549793b2A8804A5691fCa6665D152 --rpc-url https://bsc-dataseed.bnbchain.org` is far above 15, and the first post is in PROOF.md. The refusal can be reproduced with the check in `deploy/README.md`: HTTP 403, "Archive requests require a personal token", for a transaction of any age. That the feed of those hours was wrong, and that it is archived on the desk host, is our own account. The fixes are the commit "Wait for receipts that lag behind the nonce" and the desk's move to another endpoint. |
| D9 | The collateral of the live account was bought through the Binance Trading API (`quote`, `approveTransaction`, `swap`), and the signed swap was submitted through the Transaction API's MEV-protected `broadcast`. | VERIFIED-LIVE for the swap; the route is our own record | [The buy](https://bscscan.com/tx/0x04ed824f67ad208903c1e381e90a529b29bb283a2d9e317b11a1eb4acf460681): 5.60 USDT for about 0.0145 TSLAB, sent to `0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5`, the spender the quote named and the address the approval before it went to (both in PROOF.md). The chain does not show how a transaction was submitted: `scripts/demo/mainnet.ts` logs `via Binance MEV-protected broadcast` only when the call succeeded and falls back to the RPC otherwise, and it logged the first. |
| D10 | The owner's `restore(0.05 USDT)` at 15:08:42, in the regular session and 98 minutes after the open, was allowed by the Session Oracle on real mainnet prices. | VERIFIED-LIVE | [The transaction](https://bscscan.com/tx/0x5f6fb4c5e1bb366dfd45c22d292c219d3ac5d95f75d99ba4022d585d2902e49a), in PROOF.md section 2. The caller is the owner, not the desk (E20). |
| D11 | The desk's ERC-8004 registration file lists what is served and nothing else: `web`, `MCP`, `desk-api`, `agentWallet`; no A2A service; `x402Support: false`. | VERIFIED-LIVE | `cast call 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432 "tokenURI(uint256)(string)" 368122 --rpc-url https://bsc-dataseed.bnbchain.org` returns the file as a base64 `data:` URI. That the file is built from explicit flags is REPRODUCIBLE: `pnpm exec vitest run apps/agent/test/register.test.ts`. |
| D12 | The Ballast MCP server is public at https://34-185-146-173.sslip.io/mcp: no key, eight read and plan tools. | VERIFIED-LIVE | The `curl` in the README, "Public MCP endpoint", lists the tools. |

Checking the deliverable of D5 (needs `curl`, `xxd` and Foundry's `cast`):

```bash
cast keccak "0x$(curl -s https://34-185-146-173.sslip.io/evidence/56956 | xxd -p | tr -d '\n')"
```

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
| E8 | That the MEV-protected `broadcast` has carried a collateral sale on mainnet. It has carried one transaction, the owner's collateral buy (D9). The one live account is on Venus, which has no sale path. |
| E9 | That b402 is used, or that the Trading API is used by anything but the demo script, which made one buy with it (D9). |
| E10 | That an x402 payment has ever been made. The buyer is off by default and has only met a stand-in merchant in tests. |
| E11 | That the measurement is more than it is: three and a half months, $31.6k of liquidations, Binance prices standing in for the lending oracle. The caveats are in `research/README.md`. |
| E12 | Anything about positions that are open on Lista or Venus today. The published rows are past liquidations; the part of the study on open positions is not published. |
| E13 | That a language model decides anything. It writes notes after the event. |
| E14 | That the contracts are audited. |
| E15 | That the desk is highly available. It is one process with one hot key. |
| E16 | That the fork demo runs on a keyless public RPC. The fork tests do; the demo needs an endpoint that keeps serving the forked block. |
| E17 | That a test shows `canAddRisk` answering yes on real mainnet prices. In the fork tests the yes is mocked ([MOCKS.md](MOCKS.md)); every refusal is real. The real yes is the owner's mainnet restore, D10. |
| E18 | That `/judge` shows mainnet. It plays a fork recording (C16); mainnet is PROOF.md. |
| E19 | That the desk's default behaviour is what runs live. The live desk uses a more conservative target (C18). |
| E20 | That the desk has restored an account on mainnet by itself. After Friday's shield the contract allows a restore from Monday 12 October, 15:00 UTC, at the earliest, which is after the submission deadline. The restore on mainnet is the owner's (D10); a keeper restore is shown on a fork with the oracle's yes mocked: `forge test --match-test test_restore_venusWhenAllowed -vv`. |
| E21 | That the live guard job covered a market closure, or that its evidence shows the desk at work. Job 56956's window was one hour of the regular session and its evidence file lists no desk events. It shows the escrow, the bound terms, the submit after the window, the evaluation and the payment. |
| E22 | That a restore has been refused on mainnet. Not yet: D4. |
