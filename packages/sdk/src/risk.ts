// Bridges on-chain account state to the @ballast/risk planner and back to on-chain amounts.
import { formatUnits, parseUnits } from "viem";
import { planRestore, planShield, type Position, type ShieldPlan } from "@ballast/risk";
import { REASON_TEXT } from "./enums";
import type { AccountState, OracleSnapshot } from "./reads";

/** The oracle fields the planner needs (an OracleSnapshot satisfies it). */
export type PlanOracle = Pick<OracleSnapshot, "session" | "canAddRisk" | "reason" | "windowAhead" | "currentWindow">;

export type RestorePlan = { kind: "borrow"; borrowUsd: number; ltvAfter: number };
export type Noop = { kind: "noop"; reason: string };

/** Plan amounts in token units, ready for the writes. Zero where a step does not apply. */
export interface PlanAmounts {
  /** shieldRepay(repayAssets), loan-token units. */
  repayAssets: bigint;
  /** shieldDeleverage repayAssets (the flash loan), loan-token units. */
  flashRepayAssets: bigint;
  /** shieldDeleverage collateralToSell, collateral-token units. */
  sellCollateral: bigint;
  /** shieldDeleverage minOut: the sale must at least return the flash loan. */
  minOut: bigint;
  /** restore(borrowAssets), loan-token units. */
  borrowAssets: bigint;
}

export interface PlanContext {
  mode: "shield" | "restore";
  gapBps: number;
  targetHfAfterGap: number;
  canSellCollateral: boolean;
  amounts: PlanAmounts;
  /** Contract checks the plan is likely to fail (the keeper decides what to do with them). */
  warnings: string[];
}

export type AccountPlan = (ShieldPlan | RestorePlan | Noop) & PlanContext;

export interface PlanOptions {
  /** Health factor to keep after the gap (default 1.05). */
  targetHfAfterGap?: number;
  /** Override the gap. Default: the closure in progress, else the window ahead. */
  gapBps?: number;
  /** Override the collateral price (one whole token, venue unit of account). */
  priceUsd?: number;
  lltv?: number;
  minLoanUsd?: number;
  /** Plan a restore toward this debt instead of a shield (the pre-shield debt the keeper recorded). */
  restoreToDebtUsd?: number;
  /** Plan as the owner: ignores the mandate's autoRestore switch, which only binds the keeper. */
  asOwner?: boolean;
}

export const DEFAULT_TARGET_HF = 1.05;

const ZERO: PlanAmounts = { repayAssets: 0n, flashRepayAssets: 0n, sellCollateral: 0n, minOut: 0n, borrowAssets: 0n };
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const whole = (x: bigint, decimals: number) => Number(formatUnits(x, decimals));

/** Decimal amount to token units (6 fractional digits, plenty for cents and planner token steps). */
function toUnits(x: number, decimals: number): bigint {
  if (!Number.isFinite(x) || x <= 0) return 0n;
  return parseUnits(x.toFixed(Math.min(decimals, 6)), decimals);
}

/** On-chain state as a planner Position. Debt is valued with the loan token price (1 if unknown). */
export function positionForPlanner(state: AccountState, priceUsd: number, lltv: number, minLoanUsd: number): Position {
  return {
    collateralTokens: whole(state.collateral, state.collateralDecimals),
    collateralPriceUsd: priceUsd,
    debtUsd: whole(state.debt, state.loanDecimals) * (state.pricing.loanPriceUsd ?? 1),
    lltv,
    minLoanUsd,
  };
}

function shieldAmounts(state: AccountState, plan: ShieldPlan, p: Position, loanPrice: number): PlanAmounts {
  if (plan.kind === "noop") return ZERO;
  let repayAssets = 0n;
  if (plan.repayUsd > 0) {
    if (plan.repayUsd >= p.debtUsd - 1e-9) {
      // Full close: overshoot by 1 bp so interest accrued before the tx leaves no dust. Both venues
      // repay at most the actual debt when asked for more.
      repayAssets = min(state.cushion, state.debt + state.debt / 10_000n + 1n);
    } else {
      repayAssets = min(state.cushion, toUnits(plan.repayUsd / loanPrice, state.loanDecimals));
    }
  }
  let sellCollateral = 0n;
  let flashRepayAssets = 0n;
  if (plan.kind !== "repay" && plan.sellTokens && plan.flashRepayUsd) {
    sellCollateral = min(state.collateral, toUnits(plan.sellTokens, state.collateralDecimals));
    const remaining = state.debt > repayAssets ? state.debt - repayAssets : 0n;
    // A flash repay of the whole remaining debt must be exact: Moolah rejects a repay above the debt.
    flashRepayAssets =
      plan.flashRepayUsd >= p.debtUsd - plan.repayUsd - 0.005 ? remaining : min(remaining, toUnits(plan.flashRepayUsd / loanPrice, state.loanDecimals));
  }
  return { repayAssets, flashRepayAssets, sellCollateral, minOut: flashRepayAssets, borrowAssets: 0n };
}

/** Mirrors ListaAccount.shieldDeleverage's LTV bounds (inside the shield window). */
function deleverageWarnings(state: AccountState, plan: ShieldPlan, p: Position): string[] {
  if (plan.kind !== "repay+deleverage") return [];
  const out: string[] = [];
  const shield = state.mandate.shieldLtvBps;
  const before = ((p.debtUsd - plan.repayUsd) / (p.collateralTokens * p.collateralPriceUsd)) * 10_000;
  if (before <= shield) {
    out.push(`deleverage would be refused: LTV after the cushion repay (${Math.round(before)} bps) is at or below the shield LTV (${shield} bps)`);
  }
  const valueAfter = (p.collateralTokens - plan.sellTokens) * p.collateralPriceUsd;
  const after = valueAfter > 0 ? ((p.debtUsd - plan.repayUsd - plan.flashRepayUsd) / valueAfter) * 10_000 : 0;
  if (after + 100 < shield) {
    out.push(`deleverage lands at ${Math.round(after)} bps, more than 1% below the shield LTV (${shield} bps), and would be refused`);
  }
  return out;
}

/**
 * Shield (default) or restore plan for one account from its on-chain state and the oracle.
 * Deterministic and side-effect free; `insufficient` plans are returned as-is for the caller to decide.
 */
export function planForAccount(state: AccountState, oracle: PlanOracle, opts: PlanOptions = {}): AccountPlan {
  const restoring = opts.restoreToDebtUsd !== undefined;
  const inClosure = oracle.currentWindow.window !== "NONE";
  const ctx: PlanContext = {
    mode: restoring ? "restore" : "shield",
    gapBps: opts.gapBps ?? (inClosure ? oracle.currentWindow.gapBps : oracle.windowAhead.gapBps),
    targetHfAfterGap: opts.targetHfAfterGap ?? DEFAULT_TARGET_HF,
    canSellCollateral:
      !restoring && state.market.venue === "lista" && oracle.session === "REGULAR" && state.market.deleveragePathSet,
    amounts: ZERO,
    warnings: [],
  };
  const noop = (reason: string): AccountPlan => ({ kind: "noop", reason, ...ctx });

  if (state.liquidated) return noop("the account was liquidated");
  if (!restoring && state.debt === 0n) return noop("no debt to shield");
  const price = opts.priceUsd ?? state.pricing.collateralPriceUsd;
  if (price === null || !(price > 0)) return noop("collateral price unavailable, cannot size a plan");
  const loanPrice = state.pricing.loanPriceUsd;
  if (loanPrice === null || !(loanPrice > 0)) return noop("loan token price unavailable, cannot size a plan");
  const position = positionForPlanner(state, price, opts.lltv ?? state.pricing.lltv, opts.minLoanUsd ?? state.pricing.minLoanUsd);
  const cushionUsd = whole(state.cushion, state.loanDecimals) * loanPrice;

  if (restoring) {
    if (!oracle.canAddRisk) return noop(`restore refused: ${oracle.reason} (${REASON_TEXT[oracle.reason]})`);
    if (!state.mandate.autoRestore && !opts.asOwner) return noop("auto-restore is disabled by the owner");
    const r = planRestore({
      position,
      cushionUsd,
      targetDebtUsd: opts.restoreToDebtUsd as number,
      maxLtv: state.mandate.maxLtvBps / 10_000,
    });
    if (r.kind === "noop") return { ...r, ...ctx };
    return { ...r, ...ctx, amounts: { ...ZERO, borrowAssets: toUnits(r.borrowUsd / loanPrice, state.loanDecimals) } };
  }

  const plan = planShield({
    position,
    gapBps: ctx.gapBps,
    targetHfAfterGap: ctx.targetHfAfterGap,
    cushionUsd,
    maxSlippageBps: state.mandate.maxSlippageBps,
    canSellCollateral: ctx.canSellCollateral,
  });
  return { ...plan, ...ctx, amounts: shieldAmounts(state, plan, position, loanPrice), warnings: deleverageWarnings(state, plan, position) };
}
