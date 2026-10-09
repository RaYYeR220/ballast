/* On-chain state -> the JSON the app renders. Pure functions over SDK types, so they are tested without a chain. */
import { currentWindow as calendarCurrentWindow, tickerBySymbol } from "@ballast/risk";
import { planForAccount, type AccountPlan, type AccountState, type OracleSnapshot } from "@ballast/sdk";
import { tokenSymbol } from "@/lib/markets";
import type { AccountView, ComingGap, GapsView, PlanView } from "@/lib/views";

const s = (x: bigint) => x.toString();

function gapsFor(symbol: string): GapsView | null {
  try {
    return { ...tickerBySymbol(symbol).gapBps };
  } catch {
    return null;
  }
}

/** The gap the loan has to survive next: the closure under way, else the next one (oracle windows). */
export function comingGap(o: Pick<OracleSnapshot, "at" | "currentWindow" | "windowAhead">): ComingGap | null {
  if (o.currentWindow.window !== "NONE") {
    const opensAt = calendarCurrentWindow(o.at).opensAt;
    return { window: o.currentWindow.window, gapBps: o.currentWindow.gapBps, startsAt: o.currentWindow.closedAt, endsAt: opensAt, inProgress: true };
  }
  if (o.windowAhead.window === "NONE") return null;
  return { window: o.windowAhead.window, gapBps: o.windowAhead.gapBps, startsAt: o.windowAhead.startsAt, endsAt: o.windowAhead.endsAt, inProgress: false };
}

/** LTV after the collateral opens `gapBps` lower: debt / (value * (1 - gap)). */
export function ltvAfterGap(ltvBps: number, gapBps: number): number {
  return gapBps >= 10_000 ? Number.POSITIVE_INFINITY : ltvBps / (1 - gapBps / 10_000);
}

export function planView(p: AccountPlan): PlanView {
  return {
    kind: p.kind,
    mode: p.mode,
    ...("reason" in p && typeof p.reason === "string" ? { reason: p.reason } : {}),
    gapBps: p.gapBps,
    targetHfAfterGap: p.targetHfAfterGap,
    ...("hfAfterGap" in p && Number.isFinite(p.hfAfterGap) ? { hfAfterGap: p.hfAfterGap } : {}),
    ...("repayUsd" in p ? { repayUsd: p.repayUsd } : {}),
    ...("sellTokens" in p && p.sellTokens !== undefined ? { sellTokens: p.sellTokens } : {}),
    inDeleverageWindow: p.inDeleverageWindow,
    canSellCollateral: p.canSellCollateral,
    steps: p.steps.map((st) =>
      st.fn === "shieldDeleverage"
        ? { fn: st.fn, repayAssets: s(st.repayAssets), collateralToSell: s(st.collateralToSell) }
        : { fn: st.fn, assets: s(st.assets) },
    ),
    warnings: p.warnings,
  };
}

export function accountView(state: AccountState, oracle: OracleSnapshot | null, oracleError?: string): AccountView {
  const ltvBps = state.ltvBps !== null && Number.isFinite(state.ltvBps) ? state.ltvBps : null;
  const coming = oracle ? comingGap(oracle) : null;
  let plan: PlanView | null = null;
  if (oracle) {
    try {
      plan = planView(planForAccount(state, oracle));
    } catch {
      plan = null; // planner refused its inputs (e.g. a gap out of range): show no plan rather than a wrong one
    }
  }
  const m = state.market;
  return {
    address: state.address,
    venue: state.venue,
    owner: state.owner,
    keeper: state.keeper,
    symbol: state.symbol,
    collateralSymbol: tokenSymbol(state.collateralToken) ?? `${state.symbol}B`,
    loanSymbol: tokenSymbol(state.loanToken) ?? "loan token",
    collateralToken: state.collateralToken,
    loanToken: state.loanToken,
    collateralDecimals: state.collateralDecimals,
    loanDecimals: state.loanDecimals,
    collateral: s(state.collateral),
    debt: s(state.debt),
    cushion: s(state.cushion),
    mandate: { ...state.mandate },
    ltvBps,
    ltvUnbounded: state.ltvBps === Number.POSITIVE_INFINITY,
    healthKnown: state.healthKnown,
    healthy: state.healthy,
    liquidated: state.liquidated,
    priceUsd: state.pricing.collateralPriceUsd,
    loanPriceUsd: state.pricing.loanPriceUsd,
    lltvBps: Math.round(state.pricing.lltv * 10_000),
    minLoan: m.venue === "lista" && m.minLoan !== null ? s(m.minLoan) : null,
    ...(m.venue === "lista"
      ? {
          lista: {
            marketId: m.marketId,
            deleveragePathSet: m.deleveragePathSet,
            deleveragePathHash: m.deleveragePathHash,
            marketParams: { ...m.marketParams, lltv: s(m.marketParams.lltv) },
          },
        }
      : { venus: { vCollateral: m.vCollateral, vDebt: m.vDebt } }),
    gaps: gapsFor(state.symbol),
    coming,
    ltvAfterGapBps: ltvBps !== null && coming ? ltvAfterGap(ltvBps, coming.gapBps) : null,
    oracle: oracle
      ? {
          session: oracle.session,
          canAddRisk: oracle.canAddRisk,
          reason: oracle.reason,
          reasonText: oracle.reasonText,
          horizon: oracle.params.horizon,
          restoreDelay: oracle.params.restoreDelay,
          perShare: oracle.perShare === null ? null : s(oracle.perShare),
          referenceUpdatedAt: oracle.referenceUpdatedAt,
        }
      : null,
    ...(oracleError ? { oracleError } : {}),
    plan,
  };
}
