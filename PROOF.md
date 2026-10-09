# Proof

This page is written by `pnpm proof` from the data files below. To change it, change the data and run the command again.

| Source | What it holds |
|---|---|
| `contracts/deployments/56.json` | addresses written by the mainnet deploy script |
| `data/proof-txs.json` | mainnet transactions, appended by `scripts/demo/mainnet.ts` as it sends them, or by hand |
| `data/proof-notes.json` | corrections and incidents, shown under the transactions |
| `data/test-counts.json` | test results, updated by hand after each full run |
| `config/bsc-mainnet.json` | the existing mainnet contracts Ballast calls |

Nothing here is fetched or estimated. A missing deployment file renders as "pending". A malformed address, hash or date stops the command.

## 1. Mainnet deployment

BSC mainnet (chain 56), deployed at block [126486842](https://bscscan.com/block/126486842), owner [`0xE507125d7F8aE8f482B9F55a1b07Abe58b2564Bf`](https://bscscan.com/address/0xE507125d7F8aE8f482B9F55a1b07Abe58b2564Bf).

| Contract | Address | Source | What it does |
|---|---|---|---|
| SessionCalendar | [`0xED58C46715c3cb0Aea67ed8F1876e4A7315D89AB`](https://bscscan.com/address/0xED58C46715c3cb0Aea67ed8F1876e4A7315D89AB#code) | [Sourcify](https://repo.sourcify.dev/56/0xED58C46715c3cb0Aea67ed8F1876e4A7315D89AB/) | NYSE session calendar for 2026 and 2027. No admin, no oracle. |
| SessionOracle | [`0x8Fc983D9cC9880e0FbBcd7F48304A175b4055388`](https://bscscan.com/address/0x8Fc983D9cC9880e0FbBcd7F48304A175b4055388#code) | [Sourcify](https://repo.sourcify.dev/56/0x8Fc983D9cC9880e0FbBcd7F48304A175b4055388/) | Per-share prices, closure windows, the publisher overlay and `canAddRisk`. |
| SessionAwareFeed | [`0xC544236Aa3E4CB5cb7f2bb9b72019f85fb35aE20`](https://bscscan.com/address/0xC544236Aa3E4CB5cb7f2bb9b72019f85fb35aE20#code) | [Sourcify](https://repo.sourcify.dev/56/0xC544236Aa3E4CB5cb7f2bb9b72019f85fb35aE20/) | Lista-compatible price source that holds a band while the market is closed. |
| BallastFactory | [`0xE12f14595BCEC5616192660880829F400A310a72`](https://bscscan.com/address/0xE12f14595BCEC5616192660880829F400A310a72#code) | [Sourcify](https://repo.sourcify.dev/56/0xE12f14595BCEC5616192660880829F400A310a72/) | Creates and registers the per-user accounts. |
| ListaAccount (implementation) | [`0x77EAfc448aAb09ECA06d21fd409fa3DB491BA191`](https://bscscan.com/address/0x77EAfc448aAb09ECA06d21fd409fa3DB491BA191#code) | [Sourcify](https://repo.sourcify.dev/56/0x77EAfc448aAb09ECA06d21fd409fa3DB491BA191/) | Logic behind every Lista account clone. |
| VenusAccount (implementation) | [`0x7bd36fD3fF6050BB830a2ee74fcBC72FeAaf94eE`](https://bscscan.com/address/0x7bd36fD3fF6050BB830a2ee74fcBC72FeAaf94eE#code) | [Sourcify](https://repo.sourcify.dev/56/0x7bd36fD3fF6050BB830a2ee74fcBC72FeAaf94eE/) | Logic behind every Venus account clone. |
| CushionVault | [`0xf0089b0e6afa2f80dbc9006E1B3D1a77E114E334`](https://bscscan.com/address/0xf0089b0e6afa2f80dbc9006E1B3D1a77E114E334#code) | [Sourcify](https://repo.sourcify.dev/56/0xf0089b0e6afa2f80dbc9006E1B3D1a77E114E334/) | Cushions for loans that stay on the user's own address. |
| BallastGuardian | [`0x1049E94c5Bc186f0495C5c04EAe80FD0eaFCBcD8`](https://bscscan.com/address/0x1049E94c5Bc186f0495C5c04EAe80FD0eaFCBcD8#code) | [Sourcify](https://repo.sourcify.dev/56/0x1049E94c5Bc186f0495C5c04EAe80FD0eaFCBcD8/) | ERC-8183 hook and evaluator for guard jobs. |

The ERC-8183 kernel's job counter stood at 56923 when the guardian was deployed, so no guard job has a lower id.

The address opens the contract's code tab on BscScan; the Sourcify link opens its verified source, if there is one. Neither is taken on trust here: to check the deployment against the chain, the repository config and a local build, run

```bash
pnpm contracts:build
BSC_RPC_URL=<rpc> pnpm verify:onchain
```

## 2. Mainnet transactions

| When | What | Transaction | Expected | Note |
|---|---|---|---|---|
| 2026-10-08 17:43 UTC | Desk agent registered in the ERC-8004 identity registry (agentId 368122) | [`0x751156e3...6dc37d47`](https://bscscan.com/tx/0x751156e36180eb7fd6e46c990df0470b645c5959de352efd6a05a4b16dc37d47) | success | register() from the desk key 0xccD7f069275549793b2A8804A5691fCa6665D152 |
| 2026-10-08 17:43 UTC | Desk agent registration file written (setAgentURI) | [`0x7384932d...800a582d`](https://bscscan.com/tx/0x7384932d77c88a9231e8a29d5483efdb69fea2844cbbae7a8221ab21800a582d) | success | second step of the registration: the URI now names agentId 368122 |
| 2026-10-08 17:50 UTC | First deployment transaction: SessionCalendar | [`0x46fbea5b...0d5a949f`](https://bscscan.com/tx/0x46fbea5bf2ba4053a700d17e1e520dd3b7b73c10ff30a1459f47be910d5a949f) | success | first of the 31 transactions of the deploy script; all eight contracts are exact matches on Sourcify (checked 2026-10-08) |
| 2026-10-08 18:07 UTC | First Session Oracle overlay posted by the desk | [`0x95177e85...fd432368`](https://bscscan.com/tx/0x95177e85cae6071af68b7d6a11735c0515529352595a8b418cce3606fd432368) | success | postOverlays from the publisher key, which is the desk agent |
| 2026-10-09 13:37 UTC | Owner approves 5.60 USDT to the swap contract named by the Binance Trading API quote | [`0x3edd1a6e...e03fb32c`](https://bscscan.com/tx/0x3edd1a6ecb1555ba202d23a9064cfc319be6a401dc32163ce441e1b0e03fb32c) | success | exactly 5.60 USDT to 0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5 (the quote's approveTarget) |
| 2026-10-09 13:37 UTC | Owner buys TSLAB with 5.60 USDT through the Binance Trading API (sent by the MEV-protected broadcast) | [`0x04ed824f...cf460681`](https://bscscan.com/tx/0x04ed824f67ad208903c1e381e90a529b29bb283a2d9e317b11a1eb4acf460681) | success | 5.60 USDT -> about 0.014543 TSLAB, at least 0.014325 (1.5% slippage), Binance Trading API via LiquidMesh |
| 2026-10-09 13:37 UTC | Owner creates the Ballast Venus account (keeper = the desk agent) | [`0x44c4d80b...b25a70f2`](https://bscscan.com/tx/0x44c4d80b90c3e427625ff39b25cc8502247966fbdcbeaeeea430e5b4b25a70f2) | success | vTSLAB collateral, vUSDT debt, keeper = the desk 0xccD7f069275549793b2A8804A5691fCa6665D152, mandate maxLtv 6000 / shieldLtv 5000 / slippage 150 bps / autoRestore true |
| 2026-10-09 13:38 UTC | Owner approves TSLAB to the account | [`0x884efd60...79d2ee1e`](https://bscscan.com/tx/0x884efd60a2e19a672292cc519e67d42046e165de31f773710b1c14c479d2ee1e) | success | exactly 0.014553 TSLAB |
| 2026-10-09 13:38 UTC | Owner deposits 0.014553 TSLAB as collateral through the account | [`0x40dc2ce3...b98ac0f6`](https://bscscan.com/tx/0x40dc2ce3921952d1947b89e5e76752860c1cd421b8cf8b6063d3a95cb98ac0f6) | success | 0.014553 TSLAB into Venus through the account |
| 2026-10-09 13:38 UTC | Owner borrows 2.96 USDT from Venus into the account cushion (LTV 53.36%) | [`0xac13e100...4d119784`](https://bscscan.com/tx/0xac13e100c62c0bcd703f5a56bc84eb6fe4c87536894908f4f0e5a18c4d119784) | success | 2.96 USDT from Venus, kept in the account (LTV 53.36%) |
| 2026-10-09 15:08 UTC | Owner calls restore during the regular session: allowed by the Session Oracle (Restored event) | [`0x5f6fb4c5...2902e49a`](https://bscscan.com/tx/0x5f6fb4c5e1bb366dfd45c22d292c219d3ac5d95f75d99ba4022d585d2902e49a) | success | restore(0.0500 USDT): borrowed back into the cushion while the Session Oracle allows added risk (OK) |
| 2026-10-09 15:09 UTC | Owner approves 0.10 USDT to PancakeSwap v3 (to pay the guardian in USD1) | [`0xc10c19af...e948b7dc`](https://bscscan.com/tx/0xc10c19afd72946cf1da5cf186f9fbc265c3734688645d5db1af67dc3e948b7dc) | success | exactly 0.10 USDT to the v3 router 0x1b81D678ffb9C0263b24A97847620C99d213eB14 |
| 2026-10-09 15:09 UTC | Owner swaps 0.10 USDT to USD1 on PancakeSwap v3 | [`0x9cce71b1...d16de7a5`](https://bscscan.com/tx/0x9cce71b10bedeaaa4feccd3fb97ba31247bfe7b4c86344afcb6e6489d16de7a5) | success | 0.10 USDT -> about 0.1000 USD1, at least 0.0995 (0.5% slippage), PancakeSwap v3 USDT/USD1 0.01% pool |
| 2026-10-09 15:09 UTC | Owner creates the guardian job on the ERC-8183 kernel (provider = the desk, evaluator = BallastGuardian) | [`0xfd493d30...773af111`](https://bscscan.com/tx/0xfd493d30fbb76df224fdb0dbae0b9467cbd54e1fff6ef761f9b0d78c773af111) | success | ERC-8183 kernel 0xEa4DAa3100A767e86FDed867729ae7446476EBA6: provider = the desk, evaluator = hook = BallastGuardian, paid in USD1, expires 2026-10-12T15:30:00Z |
| 2026-10-09 15:09 UTC | Owner sets the guardian job budget (0.01 USD1) | [`0x65bb1da9...f57baa2e`](https://bscscan.com/tx/0x65bb1da9c470e18d9a51e5a2e24ab5b60eb55fca87411f9568a9e152f57baa2e) | success | job 56956: 0.0100 USD1 |
| 2026-10-09 15:09 UTC | Owner approves the budget to the ERC-8183 kernel | [`0x1e4739aa...4ccd189a`](https://bscscan.com/tx/0x1e4739aae9ba8e83d70c9910223b37dd5e0ee0702966710198d217f84ccd189a) | success | exactly 0.0100 USD1 to the ERC-8183 kernel 0xEa4DAa3100A767e86FDed867729ae7446476EBA6 |
| 2026-10-09 15:09 UTC | Owner funds the guardian job: 0.01 USD1 in escrow, terms bound by BallastGuardian | [`0x8188fe89...afb24af2`](https://bscscan.com/tx/0x8188fe89d495e8810105e6e719db118416ef97aabcb880953d178cc7afb24af2) | success | job 56956: 0.0100 USD1 into escrow with the terms (account 0x64b08268efb8B266c43A1751dDbB91702CA925e3, 2026-10-09T15:14:12Z to 2026-10-09T16:14:12Z, agent 368122) |
| 2026-10-09 16:16 UTC | Desk submits the guardian evidence hash for job 56956 after the window | [`0x3530d03e...598a9c79`](https://bscscan.com/tx/0x3530d03e046adcc653495ab8bc6821405f3d43edfa5947df03d00663598a9c79) | success | sent by the desk agent; the evidence file is served at https://34-185-146-173.sslip.io/evidence/56956 and its keccak256 is the on-chain deliverable |
| 2026-10-09 16:16 UTC | Desk settles guardian job 56956: the account survived the window, 0.01 USD1 paid to the desk | [`0x598a78fc...e3a54c9d`](https://bscscan.com/tx/0x598a78fc848ae61106cfc86de48c19b7c82e58bc59d6ffd11177ac83e3a54c9d) | success | BallastGuardian evaluated the account as healthy and not liquidated; ERC-8004 reputation feedback written |
| 2026-10-09 19:03 UTC | Desk shields the account 56 minutes before the weekend close: shieldRepay(0.18017 USDT) from the cushion | [`0x5a95ef60...b72104e5`](https://bscscan.com/tx/0x5a95ef60855620aa19156eccb223f1ad603df97d399e626de6828265b72104e5) | success | sent by the desk agent on its own; debt 3.0101 to 2.8299 USDT, LTV 53.95% to 50.60%, health after a 5.51% weekend gap 1.30 (the desk's target); simulated through the Binance Transaction API before sending |

A revert on purpose is a restore sent while the Session Oracle refuses added risk: the transaction is mined, fails with `RestoreRefused` and moves nothing. The Expected column comes from the entry, not from the chain: the link shows what happened.

Notes:

- Incident, 2026-10-08 and 2026-10-09: the public RPC the desk first used (bsc-rpc.publicnode.com) refused eth_getTransactionReceipt with HTTP 403, "Archive requests require a personal token", even for a transaction mined a second earlier, so the desk could not see its own receipts. Its audit feed recorded the first 11 overlay posts (nonces 2 to 12 of the desk key, 2026-10-08 18:07 to 20:02 UTC) as dropped and two more (nonces 13 and 15, 2026-10-09 about 01:07 and 06:10 UTC) as pending. All of them were mined and nothing on chain was affected. Fixes: the sender waits for late receipts and no longer reports a transaction the node knows as dropped, and the desk moved to an RPC that serves receipts and accepts batched eth_call. The feed of those hours is archived on the desk host and is not what the read API serves.
- A restore sent by the desk itself is not in this list. After the shield of 2026-10-09 the contract allows a restore from Monday 2026-10-12 15:00 UTC at the earliest, which is after the submission deadline. The restore listed above was called by the owner.

## 3. Tests

| Suite | Covers | Passed | Failed | Skipped | Last full run | Command |
|---|---|---|---|---|---|---|
| TypeScript | SDK, risk model, Binance client, MCP server, desk, web app, demo scripts | 1001 | 0 | 2 | 2026-10-09 | `pnpm test` |
| Contracts, unit | calendar, Session Oracle, SessionAwareFeed | 57 | 0 | 0 | 2026-10-09 | `cd contracts && forge test --no-match-path "test/fork/*"` |
| Contracts, fork of BSC mainnet | accounts, vault, guardian, feed against real mainnet state | 99 | 0 | 0 | 2026-10-09 | `cd contracts && forge test --match-path "test/fork/*"` |

- TypeScript: 54 test files. The 2 skipped tests call the keyed Binance Web3 API and only run when BINANCE_WEB3_API_KEY is set.
- Contracts, unit: External contracts are mocks here (contracts/test/mocks/Mocks.sol).
- Contracts, fork of BSC mainnet: Last full fork run. Forked at the chain head (no pinned block) through the default public RPC, https://bsc-rpc.publicnode.com.

The two contract rows are checked against the tree each time this page is written: contracts/test holds 57 unit test functions and 99 fork test functions.

## 4. What the fork tests prove

The fork suite runs the contracts against real BSC mainnet state: Lista Lending, Venus, PancakeSwap v3, the bStock tokens, the ERC-8183 kernel and the ERC-8004 registries. `MOCKS.md` lists what is mocked on top of that state. To run one test:

```bash
cd contracts && forge test --match-test <test name> -vv
```

| Claim | Test | File (contracts/test/fork) |
|---|---|---|
| A keeper `restore` while the US market is closed reverts with `RestoreRefused(NOT_REGULAR)` and the debt does not move | `test_restore_refusedOnWeekend_andMovesNothing` | `ListaAccount.fork.t.sol` |
| The same refusal on a Venus account | `test_restore_refusedOnWeekend_venus` | `VenusAccount.fork.t.sol` |
| The keeper cannot borrow out, withdraw collateral or cushion, change the mandate or the keeper, rescue tokens or set the swap path | `test_keeperCannotTouchOwnerFunctions` | `ListaAccount.fork.t.sol` |
| A cushion repay works while Lista's stock oracle refuses to price the collateral | `test_shieldRepay_worksWhileListaSwitchClosed` | `ListaAccount.fork.t.sol` |
| A flash deleverage through a real PancakeSwap v3 pool lowers the LTV and the proceeds stay in the account | `test_flashDeleverage_reducesLtvAndKeepsProceedsInside` | `ListaAccount.fork.t.sol` |
| The sale must clear a floor derived from the venue oracle | `test_flashDeleverage_enforcesOracleFloor` | `ListaAccount.fork.t.sol` |
| A sale is refused when no closure is near and the loan is under the owner's cap | `test_deleverage_refusedOutsideWindow` | `ListaAccount.fork.t.sol` |
| A keeper sale switches auto-restore off until the owner turns it back on | `test_keeperDeleverage_cushionShort_sellsAndHandsBackRestore` | `ListaAccount.fork.t.sol` |
| Restore and shield repeated over three sessions only ever repay; no collateral leaves the account | `test_crossSessionRestoreLoop_onlyRepaysNeverSells` | `ListaAccount.fork.t.sol` |
| The owner can always repay, withdraw the collateral and withdraw the cushion | `test_ownerCanAlwaysExit` | `ListaAccount.fork.t.sol` |
| A seizure is detected, anyone can latch it, and donated collateral cannot hide it | `test_liquidationIsDetected` | `ListaAccount.fork.t.sol` |
| A $5 Venus position, the size planned for mainnet, can be shielded | `test_tinyPosition_likeMainnetDemo` | `VenusAccount.fork.t.sol` |
| CushionVault: the keeper repays a loan held on the user's own address, with no authorization from that address | `test_keeperRepaysUserDebtBeforeClose_withoutAuthorization` | `CushionVault.fork.t.sol` |
| CushionVault refuses to spend far from a closure | `test_refusedFarFromClose` | `CushionVault.fork.t.sol` |
| CushionVault enforces the user's daily cap | `test_dailyCap` | `CushionVault.fork.t.sol` |
| A -5% print on a Saturday liquidates a market priced by Lista's oracle and not the same market priced by SessionAwareFeed | `test_saturdayWick_liquidatesListaMarketOnly` | `SessionAwareFeed.fork.t.sol` |
| A move that is still there in Monday's regular session liquidates both markets | `test_persistentMove_liquidatesBothAtTheOpen` | `SessionAwareFeed.fork.t.sol` |
| Guardian: an account that survived the window pays the guardian and writes ERC-8004 feedback | `test_survivedWindow_paysGuardianAndWritesReputation` | `BallastGuardian.fork.t.sol` |
| Guardian: a liquidated account refunds the client | `test_liquidatedAccount_refundsClientAndWritesZero` | `BallastGuardian.fork.t.sol` |
| Guardian: a job that was never submitted cannot be settled; the client claims the refund from the kernel at expiry | `test_fundedNeverSubmitted_settleReverts_thenClientClaimsRefundAtExpiry` | `BallastGuardian.fork.t.sol` |
| Guardian: a client cannot hire itself | `test_selfDealing_clientIsProvider` | `BallastGuardian.fork.t.sol` |

## 5. Mainnet contracts Ballast builds on

From `config/bsc-mainnet.json`. These belong to other teams and are listed so the wiring can be checked.

| Contract | Address |
|---|---|
| Lista Lending (Moolah) | [`0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c`](https://bscscan.com/address/0x8f73b65b4caaf64fba2af91cc5d4a2a1318e5d8c#code) |
| Lista resilient oracle (the Session Oracle's raw price source) | [`0xf3afd82a4071f272f403dc176916141f44e6c750`](https://bscscan.com/address/0xf3afd82a4071f272f403dc176916141f44e6c750#code) |
| Venus core pool comptroller | [`0xfd36e2c2a6789db23113685031d7f16329158384`](https://bscscan.com/address/0xfd36e2c2a6789db23113685031d7f16329158384#code) |
| Venus oracle | [`0x6592b5de802159f3e74b2486b091d11a8256ab8a`](https://bscscan.com/address/0x6592b5de802159f3e74b2486b091d11a8256ab8a#code) |
| PancakeSwap v3 swap router | [`0x1b81d678ffb9c0263b24a97847620c99d213eb14`](https://bscscan.com/address/0x1b81d678ffb9c0263b24a97847620c99d213eb14#code) |
| Ondo shares oracle (sValue) | [`0xf4fd8a1b412633e10527454137a29db7aa35f15e`](https://bscscan.com/address/0xf4fd8a1b412633e10527454137a29db7aa35f15e#code) |
| ERC-8183 kernel (BNB Chain AgenticCommerce) | [`0xea4daa3100a767e86fded867729ae7446476eba6`](https://bscscan.com/address/0xea4daa3100a767e86fded867729ae7446476eba6#code) |
| ERC-8004 identity registry | [`0x8004a169fb4a3325136eb29fa0ceb6d2e539a432`](https://bscscan.com/address/0x8004a169fb4a3325136eb29fa0ceb6d2e539a432#code) |
| ERC-8004 reputation registry | [`0x8004baa17c55a88189ae136b182e5fda19de9b63`](https://bscscan.com/address/0x8004baa17c55a88189ae136b182e5fda19de9b63#code) |
