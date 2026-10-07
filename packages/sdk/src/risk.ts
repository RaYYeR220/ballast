// Bridges on-chain account state to the @ballast/risk planner and back to on-chain amounts and calls.
import { formatUnits, parseUnits } from "viem";
import { planRestore, planShield, type Position, type ShieldPlan } from "@ballast/risk";
import { REASON_TEXT } from "./enums";
import type { AccountState, OracleSnapshot } from "./reads";

/** The oracle fields the planner needs (an OracleSnapshot satisfies it). */
export type PlanOracle = Pick<OracleSnapshot, "at" | "session" | "canAddRisk" | "reason" | "windowAhead" | "currentWindow" | "params">;

export type RestorePlan = { kind: "borrow"; borrowUsd: number; ltvAfter: number };
export type Noop = { kind: "noop"; reason: string };

/** Plan amounts in token units. Zero where a step does not apply. */
export interface PlanAmounts {
  /** Cushion put on the debt, loan-token units (shieldRepay, or spent first inside a keeper shieldDeleverage). */
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

/** One account call, in order. The keeper turns these into writes (the deleverage path comes from config). */
export type PlanStep =
  | { fn: "shieldRepay"; assets: bigint }
  | { fn: "shieldDeleverage"; repayAssets: bigint; collateralToSell: bigint; minOut: bigint }
  | { fn: "restore"; assets: bigint };

export interface PlanContext {
  mode: "shield" | "restore";
  gapBps: number;
  targetHfAfterGap: number;
  /** The next closure starts within the oracle horizon (ListaAccount's deleverage window). */
  inDeleverageWindow: boolean;
  canSellCollateral: boolean;
  amounts: PlanAmounts;
  /**
   * Calls to send. A keeper sale is one shieldDeleverage: the contract spends the cushion first in the same
   * transaction and sells only if LTV is still above the shield LTV. `insufficient` plans carry only the
   * cushion repay, never the best-effort sale.
   */
  steps: PlanStep[];
  /** Contract checks the plan is likely to fail, or inputs that were unknown. The caller decides. */
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
  /**
   * Plan as the owner: ignores the autoRestore switch (it binds the keeper only), and a sale is a separate
   * shieldRepay + shieldDeleverage because the contract spends the cushion first only for the keeper.
   */
  asOwner?: boolean;
}

export const DEFAULT_TARGET_HF = 1.05;

const ZERO: PlanAmounts = { repayAssets: 0n, flashRepayAssets: 0n, sellCollateral: 0n, minOut: 0n, borrowAssets: 0n };
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const whole = (x: bigint, decimals: number) => Number(formatUnits(x, decimals));
/** One basis point plus one wei on top of a debt read a few blocks before the transaction (interest accrual). */
const withAccrual = (debt: bigint) => debt + debt / 10_000n + 1n;

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
    // A full close overshoots for accrual; both venues repay at most the actual debt.
    const full = plan.repayUsd >= p.debtUsd - 1e-9;
    repayAssets = min(state.cushion, full ? withAccrual(state.debt) : toUnits(plan.repayUsd / loanPrice, state.loanDecimals));
  }
  let sellCollateral = 0n;
  let flashRepayAssets = 0n;
  if (plan.kind !== "repay" && plan.sellTokens && plan.flashRepayUsd) {
    const remaining = state.debt > repayAssets ? state.debt - repayAssets : 0n;
    if (plan.flashRepayUsd >= p.debtUsd - plan.repayUsd - 0.005) {
      // The sale clears the loan: the flash callback repays by shares at or above the debt and keeps the
      // rest as cushion, so overshoot by a bp for accrual and sell a bp more to cover it.
      flashRepayAssets = withAccrual(remaining);
      sellCollateral = min(state.collateral, toUnits(plan.sellTokens * 1.0001, state.collateralDecimals));
    } else {
      flashRepayAssets = min(remaining, toUnits(plan.flashRepayUsd / loanPrice, state.loanDecimals));
      sellCollateral = min(state.collateral, toUnits(plan.sellTokens, state.collateralDecimals));
    }
  }
  return { repayAssets, flashRepayAssets, sellCollateral, minOut: flashRepayAssets, borrowAssets: 0n };
}

/** Mirrors ListaAccount.shieldDeleverage's LTV bounds; `floorBps` is shieldLtv in the window, maxLtv outside. */
function deleverageWarnings(state: AccountState, plan: ShieldPlan, p: Position, floorBps: number): string[] {
  if (plan.kind !== "repay+deleverage") return [];
  const out: string[] = [];
  const shield = state.mandate.shieldLtvBps;
  const before = ((p.debtUsd - plan.repayUsd) / (p.collateralTokens * p.collateralPriceUsd)) * 10_000;
  if (before <= shield) {
    out.push(`no sale will happen: LTV after the cushion repay (${Math.round(before)} bps) is at or below the shield LTV (${shield} bps)`);
  }
  const valueAfter = (p.collateralTokens - plan.sellTokens) * p.collateralPriceUsd;
  const after = valueAfter > 0 ? ((p.debtUsd - plan.repayUsd - plan.flashRepayUsd) / valueAfter) * 10_000 : 0;
  if (after + 100 < floorBps) {
    out.push(`OverDeleverage: the sale lands at ${Math.round(after)} bps, more than 1% below the floor (${floorBps} bps), and would be refused`);
  }
  return out;
}

function shieldSteps(plan: ShieldPlan, a: PlanAmounts, asOwner: boolean): PlanStep[] {
  const repay: PlanStep[] = a.repayAssets > 0n ? [{ fn: "shieldRepay", assets: a.repayAssets }] : [];
  if (plan.kind === "noop") return [];
  if (plan.kind !== "repay+deleverage") return repay; // repay, or insufficient: the cushion part only
  const sale: PlanStep = { fn: "shieldDeleverage", repayAssets: a.flashRepayAssets, collateralToSell: a.sellCollateral, minOut: a.minOut };
  return asOwner ? [...repay, sale] : [sale];
}

/**
 * Shield (default) or restore plan for one account from its on-chain state and the oracle.
 * Deterministic and side-effect free; `insufficient` plans are returned as-is for the caller to decide.
 */
export function planForAccount(state: AccountState, oracle: PlanOracle, opts: PlanOptions = {}): AccountPlan {
  const restoring = opts.restoreToDebtUsd !== undefined;
  const asOwner = opts.asOwner === true;
  const inClosure = oracle.currentWindow.window !== "NONE";
  const ahead = oracle.windowAhead;
  const ctx: PlanContext = {
    mode: restoring ? "restore" : "shield",
    gapBps: opts.gapBps ?? (inClosure ? oracle.currentWindow.gapBps : ahead.gapBps),
    targetHfAfterGap: opts.targetHfAfterGap ?? DEFAULT_TARGET_HF,
    inDeleverageWindow: ahead.startsAt !== 0 && ahead.startsAt <= oracle.at + oracle.params.horizon,
    canSellCollateral: false,
    amounts: ZERO,
    steps: [],
    warnings: [],
  };
  const noop = (reason: string): AccountPlan => ({ kind: "noop", reason, ...ctx });

  if (state.liquidated) return noop("the account was liquidated");
  if (!restoring && state.debt === 0n) return noop("no debt to shield");
  if (!restoring && opts.gapBps === undefined && !inClosure && ahead.window === "NONE") return noop("no closure window known");
  const price = opts.priceUsd ?? state.pricing.collateralPriceUsd;
  if (price === null || !(price > 0)) return noop("collateral price unavailable, cannot size a plan");
  const loanPrice = state.pricing.loanPriceUsd;
  if (loanPrice === null || !(loanPrice > 0)) return noop("loan token price unavailable, cannot size a plan");
  const position = positionForPlanner(state, price, opts.lltv ?? state.pricing.lltv, opts.minLoanUsd ?? state.pricing.minLoanUsd);
  const cushionUsd = whole(state.cushion, state.loanDecimals) * loanPrice;
  if (!state.pricing.minLoanKnown && opts.minLoanUsd === undefined) {
    ctx.warnings.push("venue minimum loan unknown (minLoan() reverted): a repay that leaves a small loan may be refused (BelowMinLoan)");
  }

  if (restoring) {
    if (!oracle.canAddRisk) return noop(`restore refused: ${oracle.reason} (${REASON_TEXT[oracle.reason]})`);
    if (!state.mandate.autoRestore && !asOwner) return noop("auto-restore is disabled by the owner");
    const r = planRestore({
      position,
      cushionUsd,
      targetDebtUsd: opts.restoreToDebtUsd as number,
      maxLtv: state.mandate.maxLtvBps / 10_000,
    });
    if (r.kind === "noop") return { ...r, ...ctx };
    const borrowAssets = toUnits(r.borrowUsd / loanPrice, state.loanDecimals);
    return { ...r, ...ctx, amounts: { ...ZERO, borrowAssets }, steps: [{ fn: "restore", assets: borrowAssets }] };
  }

  // ListaAccount.shieldDeleverage: owner-fixed path, and either the deleverage window or an LTV above the
  // owner's cap, measured after the keeper's in-transaction cushion spend.
  const value = position.collateralTokens * price;
  const debtAtSale = asOwner ? position.debtUsd : Math.max(0, position.debtUsd - cushionUsd);
  const aboveCap = value > 0 && (debtAtSale / value) * 10_000 > state.mandate.maxLtvBps;
  const saleRoute = state.market.venue === "lista" && oracle.session === "REGULAR" && state.market.deleveragePathSet;
  ctx.canSellCollateral = saleRoute && (ctx.inDeleverageWindow || aboveCap);

  const plan = planShield({
    position,
    gapBps: ctx.gapBps,
    targetHfAfterGap: ctx.targetHfAfterGap,
    cushionUsd,
    maxSlippageBps: state.mandate.maxSlippageBps,
    canSellCollateral: ctx.canSellCollateral,
  });
  const amounts = shieldAmounts(state, plan, position, loanPrice);
  const floor = ctx.inDeleverageWindow ? state.mandate.shieldLtvBps : state.mandate.maxLtvBps;
  const warnings = [...ctx.warnings, ...deleverageWarnings(state, plan, position, floor)];
  if (saleRoute && !ctx.canSellCollateral && plan.kind === "insufficient") {
    warnings.push(
      `NotInShieldWindow: a collateral sale is allowed only within ${oracle.params.horizon} s of the next closure ` +
        `(starts ${ahead.startsAt}) or above the owner's max LTV; repay from the cushion now and sell inside the window`,
    );
  }
  return { ...plan, ...ctx, amounts, steps: shieldSteps(plan, amounts, asOwner), warnings };
}
