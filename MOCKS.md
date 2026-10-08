# What is real and what is mocked

Four settings, from the most artificial to the least. The line in each is exact: if a thing is not named as mocked here, the test or the demo runs the real one.

| Setting | Chain state | Time | Prices | Other parties |
|---|---|---|---|---|
| Contract unit tests | none, everything deployed in the test | set by the test | mocks | mocks |
| Contract fork tests | real BSC mainnet at the fork block | warped forward | real, then pinned or overridden | real contracts, impersonated accounts |
| Fork demo | real BSC mainnet at the fork block | warped forward | real, then frozen behind a mock | real contracts, a real desk process |
| Mainnet | real | real | real | real |

## 1. Contract unit tests

`contracts/test/*.t.sol`, 57 tests: `SessionCalendar`, `SessionOracle`, `SessionAwareFeed`.

Real: the three contracts under test, deployed fresh in each test.

Mocked, all from `contracts/test/mocks/Mocks.sol`:

| Mock | Stands in for |
|---|---|
| `MockPriceSource` | Lista's resilient oracle (`peek`), including a switch that makes it revert like a closed stock |
| `MockAggregator` | a Chainlink stock feed (`latestRoundData`, 8 decimals) |
| `MockBStock` | a bStock token's EIP-8056 `uiMultiplier` |
| `MockBacked` | an xStocks token's `multiplier` |
| `MockOndoShares` | Ondo's shares oracle (`getSValue`) |

Time is a timestamp argument or a `vm.warp` to fixed moments in 2026 and 2027: ordinary Fridays, weekends, holidays, an early close, a DST change, the edges of the calendar table.

## 2. Contract fork tests

`contracts/test/fork/*.t.sol`, 99 tests. Each test forks BSC mainnet (`BSC_RPC_URL`, at the chain head unless `FORK_BLOCK` is set) and deploys fresh Ballast contracts on the fork with the deploy script's parameters. They do not test an existing Ballast deployment.

Real, read from the fork and called as they are on mainnet:

- Lista Lending (Moolah): markets, positions, interest, the minimum loan, flash loans, liquidation
- Lista's stock oracle and resilient oracle, until a test pins them (below)
- Venus core pool: comptroller, vTokens, oracle, liquidator
- PancakeSwap v3 swap router and the real pools on the deleverage route
- the bStock tokens and their `uiMultiplier`, USD1, USDT
- the Chainlink stock feeds, for `decimals` when each ticker is listed
- the ERC-8183 kernel: `createJobWithToken`, `setBudget`, `fund`, `submit`, `complete`, `reject`, `claimRefund`
- the ERC-8004 identity and reputation registries: `register`, `ownerOf`, `giveFeedback`, feedback reads

Wired but not called by any fork test: a live Chainlink `latestRoundData`, Ondo's shares oracle, and overlay posting. The paths that need them are refused earlier (a weekend restore stops at the session check) or mocked (below). Unit tests cover them against mocks.

Mocked or forced, and why:

| What | How | Why |
|---|---|---|
| Time | `vm.warp`, forward only, to moments derived from the on-chain calendar (the next Saturday noon, an hour before the next close, the next restore window) | The tests need a weekend, a pre-close hour and a restore window on demand. Warping backwards would underflow the venues' interest accrual. |
| Lista prices after a warp | `_freezePrices`: `vm.mockCall` on `peek` of both Lista oracles, returning the value read just before | The real feeds go stale once the clock moves, and the venue then refuses to price the loan. |
| A price move | `_setPrice`: the same `vm.mockCall` with a chosen value | To cause a liquidation, a thin-book print, or a persistent move. |
| A closed stock | `vm.mockCallRevert` on the stock oracle's `peek` with `StockMarketClosed()` | To reproduce what Lista's oracle does when its market-hours switch is closed. |
| `SessionOracle.canAddRisk` returning yes | `_mockCanAddRisk`: `vm.mockCall` on the test's own oracle | Only in tests of what a restore does once it is allowed (cushion grows, cap holds, `autoRestore` is needed, the restore and shield loop). A fork at an arbitrary block has no fresh overlay and often is not in the restore window. Every refusal test calls the real function. |
| The Friday reference for the feed test | `vm.mockCall` on the SPY Chainlink feed's `latestRoundData`, set to the Friday-close price | The band needs a reference print from before the close; the fork block is not a Friday close. |
| Venue price for one check | `vm.mockCall` on `Moolah.getPrice` (the oracle-floor test) and on the Venus oracle (the Venus liquidation test) | To make the floor unreachable, and to make a Venus position liquidatable. |
| A second Lista market | `vm.prank` as the holder of Moolah's operator role, then `createMarket` with `SessionAwareFeed` as its oracle | Only the operator can create a market. This is the one place a Lista market reads the feed. |
| Token balances | `vm.prank` as a large exchange wallet to transfer bStocks and stablecoins to the test accounts | The test accounts start empty. |
| Liquidators | `vm.prank` as Lista's liquidator account and Venus's liquidator contract | The tests liquidate the way each venue's own liquidator does. |
| Identity and reputation edge cases | `vm.mockCall` and `vm.mockCallRevert` on `getAgentWallet` and `giveFeedback` | To test a provider that is the agent wallet, a wallet lookup that reverts, and a feedback write that fails. |

What this means for the headline tests:

- "A restore on a weekend reverts" is the real `canAddRisk` on the real calendar at a warped Saturday. Nothing about the refusal is mocked.
- "A restore is allowed" is never the real `canAddRisk` in a fork test. The yes is mocked, so no test shows the full set of conditions holding at once on real mainnet prices. A restore on mainnet is what shows that; see PROOF.md.
- "A -5% Saturday print liquidates one market and not the other" uses two real Moolah markets with real collateral and debt. The -5% print, the Friday reference and the Saturday clock are set by the test. It shows what the feed does with such a print; it does not show that such a print has happened.
- "The guardian is paid only on survival" settles through the real kernel and writes to the real reputation registry. The liquidation in the failing case is forced with a mocked price and the liquidator's own address.

## 3. TypeScript tests

`pnpm test`, 499 tests. No network.

| What | Stand-in |
|---|---|
| The chain | `packages/sdk/test/fake-chain.ts`, an in-memory `readContract`, `multicall` and `getBlock` |
| The Binance APIs | an injected `fetch`. Keyless responses are recorded ones in `packages/binance/test/fixtures`. Keyed responses are hand-written envelopes. |
| The desk's sender | a fake that records calldata and returns receipts; the real `ChainSender` is tested against a fake RPC client and a fake Transaction API |
| The x402 merchant | an injected `fetch` that answers 402 and then 200 |
| The language model | a function that returns a fixed string |
| Clocks | injected |

The two live tests in `packages/binance/test/live.test.ts` use nothing fake. They are skipped unless a key is set, and we have not run them.

## 4. The fork demo

`scripts/demo/fork-demo.ts` with a desk process on a local anvil fork. The script refuses any chain id but 31337.

Real: the same mainnet contracts as the fork tests, a Ballast deployment made by the real deploy script, the real desk code sending real transactions to the fork, the real ERC-8183 job and ERC-8004 registration.

Replaced on the fork, by `setup`, before the clock moves:

| What | How | Why |
|---|---|---|
| Lista's stock oracle and resilient oracle | `anvil_setCode` puts `MockPriceSource` at both addresses, loaded with the prices read a moment earlier | Same reason as `_freezePrices`: after a warp the real feeds are stale, the Session Oracle reads `PRICE_UNAVAILABLE` and the venue cannot price the account. |
| Code at the two demo accounts | `anvil_setCode` clears it | The published anvil keys carry EIP-7702 delegations on mainnet, and the ERC-8004 registry mints with `safeMint`. |
| Token balances | impersonating a large exchange wallet | The demo accounts start empty. |
| Time | `evm_setNextBlockTimestamp`: 59 minutes before the next close, then just past the guard window | To watch a shield and a settlement without waiting. |
| Keys | anvil's published development keys | They hold nothing outside a local node. |

One thing in the demo is not replaced and does not follow the warped clock: the publisher still reads the live Binance RWA status for mainnet. Its flags describe the real market at the real time, not the moment the fork was warped to.

## 5. Mainnet

No mocks.

- `contracts/script/Deploy.s.sol` deploys only contracts from `contracts/src` and wires them to the addresses in `config/bsc-mainnet.json`. Nothing under `contracts/test` is deployed.
- The desk talks to the Binance Transaction API only on chain 56, and `FORK_TICK_SEC` is refused on any chain but the local fork.
- The fork demo script cannot run against mainnet.
- `DRY_RUN`, which defaults to true, is not a mock: it simulates each real transaction and stops before sending it. Feed events from a dry run are marked `dryRun`.
- Desk notes come from a real language model when one is configured. They are commentary on events that already happened.

Whether anything has actually run on mainnet is recorded in [PROOF.md](PROOF.md), and nowhere else.
