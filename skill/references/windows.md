# Sessions, windows and gap buffers

## Sessions

The session calendar tells the oracle what the US market is doing right now. `session_state` and `oracle_price` return one of:

| Session | Meaning |
| --- | --- |
| `REGULAR` | The regular US session. The only time new risk may be added. |
| `PRE`, `POST` | Extended hours. Thin liquidity, prices are indicative. |
| `OVERNIGHT` | Between the post session and the next pre session on a trading day. |
| `CLOSED_WEEKEND` | Saturday and Sunday. |
| `CLOSED_HOLIDAY` | An exchange holiday. |
| `UNKNOWN` | The calendar does not cover this time. Treat as closed. |

NYSE is closed for about 81% of the week. Tokens keep trading on-chain the whole time, so for most of the week a loan is priced against a market that is not open.

## Windows

A window is a closure the oracle can name ahead of time: from a regular close to the next regular open.

| Window | What it is |
| --- | --- |
| `OVERNIGHT` | A weeknight closure. |
| `WEEKEND` | Friday close to Monday open. |
| `HOLIDAY` | A closure around an exchange holiday. |
| `EARNINGS` | A symbol-specific risk window the publisher flags before a company reports. |

Two views per symbol:

- `windowAhead`: the next closure, with its start, end and gap buffer.
- `currentWindow`: the closure in progress, or `NONE` during the regular session.

The oracle `horizon` (in seconds) is how far ahead a closure counts as imminent. Inside it `canAddRisk` is false with reason `WINDOW_AHEAD`, and the keeper is allowed to deleverage by selling collateral.

## Gap buffers

The gap buffer (`gapBps`) is how far the price is assumed to move between the close and the next open, in basis points. A position is judged by its health after that move:

```
healthAfterGap = collateral value * (1 - gap) * liquidation LTV / debt
```

Ballast keeps that number at or above a target (1.05 by default, `targetHf` in `plan_shield`). If an account would fall below it, the plan repays from the cushion first and, where the venue allows, sells collateral into debt.

Gap buffers come from the p99 of observed close-to-open moves per window:

| Window | p99 gap |
| --- | --- |
| Overnight | 4.4% |
| Weekend | 5.5% |
| Holiday | 4.3% |
| Earnings | 17.9% |

## What the data says

- 81% of organic liquidated dollars land in the first 90 minutes after the open.
- 0 liquidations happened on weekends. Positions do not break while the market is shut; they break when it reopens and the price jumps.

That is why Ballast shields before a close and holds restores back until the oracle says risk may be added again (`TOO_SOON_AFTER_OPEN` covers the first minutes after the open while prices settle).

## Practical use

1. Call `session_state` to see where you are and when the next closure starts.
2. Call `oracle_price` for the symbol: check `canAddRisk`, `reason` and `windowAhead.gapBps`.
3. For a loan, call `position_risk`: compare `healthFactor.afterGap` with the target.
4. If it is short, call `plan_shield` and hand the steps to the owner or keeper.
5. Do not borrow more or restore while `canAddRisk` is false. Shields are always allowed.
