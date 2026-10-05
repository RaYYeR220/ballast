import { healthAfterGap, type Position } from "./position";

export interface ShieldInput {
  position: Position;
  gapBps: number;
  targetHfAfterGap: number;
  cushionUsd: number;
  maxSlippageBps: number;
  canSellCollateral: boolean;
}

export type ShieldPlan =
  | { kind: "noop"; reason: string }
  | { kind: "repay"; repayUsd: number; hfAfterGap: number; reason: string }
  | { kind: "repay+deleverage"; repayUsd: number; sellTokens: number; flashRepayUsd: number; hfAfterGap: number; reason: string }
  | { kind: "insufficient"; repayUsd: number; hfAfterGap: number; reason: string };

const round2up = (x: number) => Math.ceil(x * 100) / 100;

/** Largest debt at which the position still has `target` health after the gap. */
function maxDebtFor(p: Position, gapBps: number, target: number, collateralTokens = p.collateralTokens) {
  return (collateralTokens * p.collateralPriceUsd * (1 - gapBps / 10_000) * p.lltv) / target;
}

export function planShield(i: ShieldInput): ShieldPlan {
  const p = i.position;
  const hf0 = healthAfterGap(p, i.gapBps);
  if (hf0 >= i.targetHfAfterGap) return { kind: "noop", reason: `survives a ${i.gapBps} bps gap at HF ${hf0.toFixed(3)}` };

  const needed = round2up(p.debtUsd - maxDebtFor(p, i.gapBps, i.targetHfAfterGap));
  // Respect the venue's minimum loan: never leave 0 < debt < minLoan.
  const clampRepay = (want: number) => {
    const remaining = p.debtUsd - want;
    if (remaining > 0 && remaining < p.minLoanUsd) {
      if (p.debtUsd <= i.cushionUsd) return p.debtUsd; // repay everything
      return Math.max(0, p.debtUsd - p.minLoanUsd); // stop at the minimum
    }
    return want;
  };

  if (needed <= i.cushionUsd) {
    const repayUsd = clampRepay(needed);
    const hf = healthAfterGap({ ...p, debtUsd: p.debtUsd - repayUsd }, i.gapBps);
    if (repayUsd < needed && hf < i.targetHfAfterGap) {
      return { kind: "insufficient", repayUsd, hfAfterGap: hf, reason: "minimum loan prevents reaching the target" };
    }
    return { kind: "repay", repayUsd, hfAfterGap: hf, reason: `repay ${repayUsd} from the cushion before the close` };
  }

  const fromCushion = clampRepay(Math.min(i.cushionUsd, needed));
  if (!i.canSellCollateral) {
    const hf = healthAfterGap({ ...p, debtUsd: p.debtUsd - fromCushion }, i.gapBps);
    return { kind: "insufficient", repayUsd: fromCushion, hfAfterGap: hf, reason: "cushion too small and selling is not allowed now" };
  }

  // Sell x tokens at price·(1−slippage) into debt: debt' = D − c − x·px·(1−s);
  // require debt' ≤ (C − x)·px·(1−g)·lltv / T  → solve linearly for x.
  const px = p.collateralPriceUsd;
  const s = i.maxSlippageBps / 10_000;
  const T = i.targetHfAfterGap * 1.0001; // margin so cent/micro-unit rounding never lands below target
  const k = (px * (1 - i.gapBps / 10_000) * p.lltv) / T; // debt headroom per remaining token
  const D = p.debtUsd - fromCushion;
  const x = Math.max(0, (D - p.collateralTokens * k) / (px * (1 - s) - k));
  const sellTokens = Math.ceil(x * 1e6) / 1e6;
  const flashRepayUsd = Math.floor(sellTokens * px * (1 - s) * 100) / 100;
  const after: Position = { ...p, collateralTokens: p.collateralTokens - sellTokens, debtUsd: D - flashRepayUsd };
  return {
    kind: "repay+deleverage",
    repayUsd: fromCushion,
    sellTokens,
    flashRepayUsd,
    hfAfterGap: healthAfterGap(after, i.gapBps),
    reason: `repay ${fromCushion} from the cushion and sell ${sellTokens} tokens into debt before the close`,
  };
}

export interface RestoreInput { position: Position; cushionUsd: number; targetDebtUsd: number; maxLtv: number }

export function planRestore(i: RestoreInput): { kind: "noop"; reason: string } | { kind: "borrow"; borrowUsd: number; ltvAfter: number } {
  const p = i.position;
  const value = p.collateralTokens * p.collateralPriceUsd;
  const capDebt = value * i.maxLtv;
  const target = Math.min(i.targetDebtUsd, capDebt);
  const borrowUsd = Math.floor((target - p.debtUsd) * 100) / 100;
  if (borrowUsd <= 0) return { kind: "noop", reason: "already at or above the restore target" };
  return { kind: "borrow", borrowUsd, ltvAfter: (p.debtUsd + borrowUsd) / value };
}
