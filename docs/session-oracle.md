# Session Oracle: integration guide

The Session Oracle answers the questions a protocol has to ask before it trusts a tokenized-stock price:

- Is the US market open right now, and when does it next close and reopen?
- What is one share worth, whichever wrapper token I hold?
- How old is the independent reference, and has the on-chain price converged to it?
- How big a gap should I survive across the closure that is coming?
- All things considered, may risk be added right now?

It is three contracts. You can use any of them without the Ballast accounts.

| Contract | Source | Use it for |
|---|---|---|
| `SessionCalendar` | `contracts/src/SessionCalendar.sol` | sessions and closures by timestamp. Pure, no admin. |
| `SessionOracle` | `contracts/src/SessionOracle.sol` | per-share prices, multipliers, reference age, gap buffers, `canAddRisk` |
| `SessionAwareFeed` | `contracts/src/SessionAwareFeed.sol` | a Lista-style `peek` price source that holds a band while the market is closed |

Addresses on BSC mainnet are in [PROOF.md](../PROOF.md), section 1, once the deployment exists. On a local fork they are in `contracts/deployments/31337.json` after you run the deploy script.

## Units and symbols

| Thing | Unit |
|---|---|
| Symbol | `bytes32`, the ASCII ticker left-aligned: `bytes32(bytes("TSLA"))`. With cast: `cast format-bytes32-string TSLA`. |
| Price | USD with 8 decimals |
| Multiplier | shares per token with 18 decimals |
| Gap buffer, deviation | basis points |
| Time | unix seconds |

Listed tickers and their p99 down-gap buffers in basis points (`config/bsc-mainnet.json`, set at listing by the oracle owner):

| Symbol | Overnight | Weekend | Holiday | Earnings | Chainlink reference |
|---|---|---|---|---|---|
| NVDA | 417 | 737 | 450 | 502 | yes |
| SPY | 155 | 223 | 159 | none | yes |
| QQQ | 202 | 318 | 264 | none | yes |
| TSLA | 585 | 551 | 1052 | 880 | yes |
| AAPL | 255 | 276 | 399 | 742 | yes |
| GOOGL | 247 | 387 | 308 | 770 | yes |
| META | 318 | 299 | 318 | 2446 | yes |
| MSFT | 241 | 260 | 263 | 844 | yes |
| AMZN | 300 | 391 | 326 | 1139 | yes |
| COIN | 773 | 946 | 473 | 2200 | yes |
| CRCL | 513 | 466 | 357 | 447 | no, publisher print |
| MSTR | 770 | 1209 | 605 | 661 | no, publisher print |

## Solidity interface

These interfaces are a subset of the deployed ABI. Copy what you need.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISessionCalendar {
    enum Session { UNKNOWN, CLOSED_WEEKEND, CLOSED_HOLIDAY, OVERNIGHT, PRE, REGULAR, POST }
    enum WindowType { NONE, OVERNIGHT, WEEKEND, HOLIDAY }

    function session(uint256 ts) external view returns (Session);
    function nextOpen(uint256 ts) external view returns (uint256);
    function nextClose(uint256 ts) external view returns (uint256);
    function prevClose(uint256 ts) external view returns (uint256);
    function nextWindow(uint256 ts) external view returns (WindowType w, uint256 startsAt, uint256 endsAt);
    function currentWindow(uint256 ts) external view returns (WindowType w, uint256 closedAt, uint256 opensAt);
    function VALID_FROM() external view returns (uint256);
    function VALID_THROUGH() external view returns (uint256);
}

interface ISessionOracle {
    enum Reason {
        OK, UNKNOWN_TICKER, CALENDAR_UNKNOWN, NOT_REGULAR, TOO_SOON_AFTER_OPEN, OVERLAY_STALE,
        FLAGGED, PRICE_UNAVAILABLE, REFERENCE_STALE, NOT_CONVERGED, WINDOW_AHEAD
    }
    enum RiskWindow { NONE, OVERNIGHT, WEEKEND, HOLIDAY, EARNINGS }
    enum Issuer { BSTOCK, ONDO, XSTOCK }

    function canAddRisk(bytes32 sym) external view returns (bool ok, Reason reason);
    function windowAhead(bytes32 sym) external view returns (RiskWindow w, uint64 startsAt, uint64 endsAt, uint16 gapBps);
    function currentWindow(bytes32 sym) external view returns (RiskWindow w, uint16 gapBps, uint256 closedAt);
    function gapFor(bytes32 sym, RiskWindow w) external view returns (uint16);
    function rawPrice(bytes32 sym) external view returns (uint256 price, bool ok);
    function perSharePrice(bytes32 sym) external view returns (uint256 price, bool ok);
    function sharesPerToken(bytes32 sym, Issuer issuer) external view returns (uint256 multiplier, bool stale);
    function referenceFor(bytes32 sym) external view returns (uint256 price, uint256 updatedAt, bool ok);
    function converged(bytes32 sym) external view returns (bool ok, uint256 devBps, Reason reason);
    function params()
        external
        view
        returns (
            uint32 restoreDelay,
            uint32 horizon,
            uint16 convergenceBps,
            uint32 maxRefAge,
            uint32 maxOverlayTtl,
            uint16 maxOndoDriftBps,
            uint16 maxRefDeviationBps
        );
    function calendar() external view returns (address);
    function symbolCount() external view returns (uint256);
    function symbols(uint256 i) external view returns (bytes32);
}

interface ISessionAwareFeed {
    function peek(address asset) external view returns (uint256);
    function band(bytes32 sym) external view returns (uint256 lo, uint256 hi, uint256 bandBps, bool ok);
    function symbolOf(address asset) external view returns (bytes32);
}
```

The oracle's views are written not to revert on bad market data. A missing price, a stale reference or an unknown ticker comes back as `ok = false`, `stale = true` or a reason code, so a caller can fall back to refusing.

## Reading `canAddRisk`

```solidity
contract BorrowGate {
    ISessionOracle public immutable oracle;

    error RiskNotAllowed(ISessionOracle.Reason reason);

    constructor(ISessionOracle oracle_) {
        oracle = oracle_;
    }

    modifier whenRiskMayBeAdded(bytes32 sym) {
        (bool ok, ISessionOracle.Reason reason) = oracle.canAddRisk(sym);
        if (!ok) revert RiskNotAllowed(reason);
        _;
    }

    function borrow(bytes32 sym, uint256 amount) external whenRiskMayBeAdded(sym) {
        // ... your borrow logic
    }
}
```

`canAddRisk` checks in this order and returns the first reason that fails:

| Order | Check | Reason when it fails |
|---|---|---|
| 1 | the ticker is listed | `UNKNOWN_TICKER` |
| 2 | the calendar covers the current time | `CALENDAR_UNKNOWN` |
| 3 | the session is `REGULAR` | `NOT_REGULAR` |
| 4 | at least `restoreDelay` has passed since today's regular open | `TOO_SOON_AFTER_OPEN` |
| 5 | the publisher overlay has not expired | `OVERLAY_STALE` |
| 6 | the overlay carries no flag (halt, corporate action, earnings window, limited asset) | `FLAGGED` |
| 7 | the on-chain per-share price is available | `PRICE_UNAVAILABLE` |
| 8 | a reference exists and is at most `maxRefAge` old | `REFERENCE_STALE` |
| 9 | price and reference differ by at most `convergenceBps` | `NOT_CONVERGED` |
| 10 | the next closure is known and starts later than `horizon` from now | `CALENDAR_UNKNOWN`, `WINDOW_AHEAD` |

With the deployed parameters (90 minutes, 3 hours, 60 bps, 26 hours) a yes is possible only between 11:00 and 13:00 New York time on a full trading day, and never on a day with a 13:00 early close. If that is too strict for your action, read the individual views below and apply your own rule; `canAddRisk` is one policy, not the only one the data supports.

Treat a yes as valid for the current block only. Do not cache it.

## Reading the closure and the gap buffer

```solidity
/// @return Health factor (1e18) after the gap buffer of the coming closure.
function healthAfterGap(bytes32 sym, uint256 collateralValue, uint256 debt, uint256 lltv) external view returns (uint256) {
    if (debt == 0) return type(uint256).max;
    (,,, uint16 gapBps) = oracle.windowAhead(sym);
    return collateralValue * (10_000 - gapBps) / 10_000 * lltv / debt;
}
```

- `windowAhead(sym)` is the next closure: from the next regular close (`startsAt`) to the following regular open (`endsAt`). `w` is `OVERNIGHT`, `WEEKEND` or `HOLIDAY` from the calendar, upgraded to `EARNINGS` when the publisher posted an earnings date whose gap lands at that open. `gapBps` is then the larger of the two buffers. `NONE` with zeros means the calendar cannot say.
- `currentWindow(sym)` is the closure in progress, with the time it started. During the regular session it is `NONE`.
- `gapFor(sym, w)` is the raw buffer for a window type.

The buffers are 99th-percentile down-gaps per ticker. They are statistics, not bounds.

## Reading the reference and its age

```solidity
/// @return Seconds since the reference for `sym` was last updated.
function referenceAge(bytes32 sym) external view returns (uint256) {
    (, uint256 updatedAt, bool ok) = oracle.referenceFor(sym);
    require(ok && updatedAt <= block.timestamp, "no reference");
    return block.timestamp - updatedAt;
}
```

- `referenceFor(sym)` returns the per-share reference price and when it was last updated. For a ticker with a Chainlink feed that is the feed's `latestRoundData`. For a ticker without one it is the last print the publisher posted and the contract accepted: only in the regular session, only within `maxRefDeviationBps` of the on-chain per-share price. That print survives overlay expiry, so it ages like a feed does.
- `converged(sym)` compares `perSharePrice` with the reference: `ok`, the deviation in basis points, and the reason (`PRICE_UNAVAILABLE`, `REFERENCE_STALE`, `NOT_CONVERGED` or `OK`).

The age is the useful number on its own. Over a weekend the reference does not move; a lender can see how long the price it relies on has gone unconfirmed.

## Reading prices across wrappers

One underlying share can sit behind three tokens on BNB Chain. The oracle gives one share price and three multipliers.

| View | Returns |
|---|---|
| `rawPrice(sym)` | USD price of one raw bStock token, as the configured price source reports it (Lista's resilient oracle) |
| `perSharePrice(sym)` | `rawPrice * 1e18 / uiMultiplier()` of the bStock (EIP-8056): USD per share |
| `sharesPerToken(sym, BSTOCK)` | the bStock's `uiMultiplier()` |
| `sharesPerToken(sym, XSTOCK)` | the xStocks token's `multiplier()` |
| `sharesPerToken(sym, ONDO)` | the publisher's Ondo multiplier while the overlay is fresh; otherwise Ondo's on-chain sValue with `stale = true` |

`stale = true` also covers a missing token, a reverting call and a paused Ondo oracle. Do not size anything off a stale multiplier.

Two cautions. The per-share price comes from the bStock feed only; the oracle does not read an Ondo or xStocks price feed, it lets you value their shares at the same per-share price. And xStocks rebase: a balance read from the token already reflects its multiplier (`packages/risk/src/normalize.ts`, `sharesHeld`).

## The lender adapter

`SessionAwareFeed` has the price-source interface Lista's lending markets read: `peek(address asset) returns (uint256)`, 8 decimals, raw token units. It wraps an upstream source of the same shape.

```solidity
SessionAwareFeed feed = new SessionAwareFeed(owner, sessionOracle, upstream);
feed.mapAsset(bStockToken, "TSLA");   // owner only
// use address(feed) wherever the market expects its oracle
```

What `peek` returns:

| Situation | Result |
|---|---|
| the asset is not mapped (a stablecoin, for example) | the upstream price |
| regular session | the upstream price |
| the calendar does not cover the time | the upstream price |
| market closed, reference available | the upstream price clamped to `[anchor * (1 - band), anchor * (1 + band)]` |
| market closed, no usable reference | the upstream price |
| the upstream source reverts | the revert propagates |

- `anchor` is the reference price times the bStock's `uiMultiplier`, so it is in the same raw units as the upstream price. Map only a ticker's bStock token: the anchor uses that token's multiplier.
- `band` starts at the ticker's gap buffer for the closure in progress and grows by one base band per 24 hours since the close, linearly, up to three times the base (and never above 90%). SPY over a weekend: 223 bps at the close, 334 bps twelve hours later, 446 bps after a day, 669 bps from two days on.
- "Closed" means every session except `REGULAR`: pre-market, post-market and overnight are clamped too, with the overnight buffer on an ordinary weeknight.
- A reference is usable when it was updated no earlier than `maxRefAge` before the close. Without one the feed is no worse than its upstream, and no better.
- `band(sym)` exposes the current bounds and width, so a front end can draw them and a liquidator can see why a price did not move.

What this buys a lender: a print outside the band cannot change collateral value while no US venue can confirm it. A real move is priced at the band edge while the market is closed, a wider edge each day, and in full from the first regular-session read.

What it costs: during a closure the feed lags a real move beyond the band. A lender that adopts it accepts that liquidations of such a move wait for the band to widen or the market to open.

The fork test `contracts/test/fork/SessionAwareFeed.fork.t.sol` wires the feed into a real Moolah market as `MarketParams.oracle` and shows both sides. No lender uses the feed today.

## From the command line

```bash
ORACLE=<SessionOracle address>
RPC=https://bsc-dataseed.bnbchain.org
SYM=$(cast format-bytes32-string TSLA)

cast call $ORACLE "canAddRisk(bytes32)(bool,uint8)" $SYM --rpc-url $RPC
cast call $ORACLE "perSharePrice(bytes32)(uint256,bool)" $SYM --rpc-url $RPC
cast call $ORACLE "referenceFor(bytes32)(uint256,uint256,bool)" $SYM --rpc-url $RPC
cast call $ORACLE "converged(bytes32)(bool,uint256,uint8)" $SYM --rpc-url $RPC
cast call $ORACLE "windowAhead(bytes32)(uint8,uint64,uint64,uint16)" $SYM --rpc-url $RPC
```

## From TypeScript

`packages/sdk` reads the same state with viem. It is a workspace package (`@ballast/sdk`), not published to npm: use it from a clone.

```ts
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { loadDeployment, oracleSnapshot, sessionState } from "@ballast/sdk";

const client = createPublicClient({ chain: bsc, transport: http(process.env.BSC_RPC_URL) });
const deployment = loadDeployment(56);

const s = await sessionState(client, deployment);
// s.session, s.nextClose, s.nextOpen, s.window { kind, startsAt, endsAt }, s.current { kind, closedAt, opensAt }

const o = await oracleSnapshot(client, deployment, "TSLA");
// o.canAddRisk, o.reason, o.reasonText
// o.rawPrice, o.perShare, o.reference, o.referenceUpdatedAt, o.converged, o.devBps
// o.windowAhead { window, startsAt, endsAt, gapBps }, o.currentWindow { window, gapBps, closedAt }
// o.overlay { validUntil, flagNames, nextEarnings, ondoMultiplier, fresh }, o.params
```

Every read of one call is pinned to one block, and `o.blockNumber` says which.

## From an agent: the MCP tools

`packages/mcp` serves the same reads as MCP tools over stdio or Streamable HTTP. See the README for how to start it and `skill/SKILL.md` for the rules an agent should follow.

| Tool | Arguments | What you get |
|---|---|---|
| `session_state` | none | session, next close and open, the next closure and the one in progress, with ISO times |
| `oracle_price` | `symbol` | raw, per-share and reference prices, convergence, `canAddRisk` with its reason in words, the window ahead with its gap buffer, the overlay |
| `tokenized_stock_status` | `address` | Binance's keyless status for a token: open or not, and why (closed session, corporate action, earnings) |
| `position_risk` | `account`, `targetHf` | a Ballast account's health factor now and after the coming gap, with the plan |
| `plan_shield` | `account`, `targetHf` | the ordered calls that keep an account above the target through the closure. Nothing is sent. |
| `list_accounts`, `guardian_jobs`, `api_health` | see `skill/references/tools.md` | accounts, guard jobs, and the server's Binance call statistics |

The first three need no Ballast account at all.

## The publisher overlay

The oracle's on-chain inputs cannot say that a stock is halted, that earnings are tonight, or what Ondo's multiplier is this minute. A publisher key posts that as an overlay per symbol with `postOverlays(bytes32[] syms, Overlay[] data)`:

| Field | Meaning | Bound enforced on-chain |
|---|---|---|
| `validUntil` | when the overlay expires | in the future, at most `maxOverlayTtl` ahead |
| `flags` | bit 1 halted, 2 corporate action, 4 earnings window, 8 limited asset | any flag makes `canAddRisk` false |
| `nextEarnings` | the regular-open time at which the next earnings gap is realised, 0 for none | only ever raises the buffer of the window it lands in; ignored once the post is 7 days old |
| `ondoMultiplier` | shares per Ondo token, 0 for not posted | between the on-chain sValue and `maxOndoDriftBps` above it |
| `referencePrice` | per-share reference, 0 for not posted | tickers without Chainlink only, regular session only, within `maxRefDeviationBps` of the on-chain per-share price |

The desk's publisher (`apps/agent/src/desk/publisher.ts`) builds it from Binance's keyless RWA status endpoints every 10 minutes and after each open and close, and posts when something changed or the 5 hour heartbeat is due. Each accepted post emits `OverlayPosted`.

## Trust and limits

- **The calendar** is constants for 2026 and 2027 with no admin. After 2027 it answers `UNKNOWN`, `canAddRisk` is false and the feed passes its upstream through. The oracle's calendar address is immutable.
- **The owner** of `SessionOracle` (two-step ownable, no timelock) can list or relist a ticker with new buffers and feeds, set parameters inside fixed bounds, and replace the price source and the publisher. The owner of `SessionAwareFeed` maps assets. If you integrate, that owner is in your trust model.
- **Parameter bounds:** `restoreDelay` 30 minutes to 6 hours, `horizon` 1 to 24 hours, `convergenceBps` 1 to 500, `maxRefAge` 1 hour to 7 days, `maxOverlayTtl` up to 24 hours, `maxOndoDriftBps` up to 500, `maxRefDeviationBps` up to 2000.
- **The publisher** is one key. It can withhold overlays, which only turns `canAddRisk` off, or keep posting clean overlays through an event it should have flagged, in which case the session, delay, convergence and horizon checks still apply. It cannot move a price outside its bounds.
- **The raw price** is whatever the configured source reports for the bStock, today Lista's resilient oracle. If that source refuses to price, the oracle answers `PRICE_UNAVAILABLE`.
- **Twelve tickers** are listed. Anything else is `UNKNOWN_TICKER`.
- **Not audited.** The tests are in `contracts/test`; what they mock is in [MOCKS.md](../MOCKS.md).
