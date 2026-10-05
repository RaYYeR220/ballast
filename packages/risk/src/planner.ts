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
  | { kind: "insufficient"; repayUsd: number; hfAfterGap: number; reason: string; sellTokens?: number; flashRepayUsd?: number };

const round2up = (x: number) => Math.ceil(x * 100) / 100;

/** Largest debt at which the position still has `target` health after the gap. */
function maxDebtFor(p: Position, gapBps: number, target: number, collateralTokens = p.collateralTokens) {
  return (collateralTokens * p.collateralPriceUsd * (1 - gapBps / 10_000) * p.lltv) / target;
}

export function planShield(i: ShieldInput): ShieldPlan {
  const p = i.position;
  if (!(i.gapBps >= 0 && i.gapBps < 10_000)) throw new RangeError(`gapBps must be in [0, 10000), got ${i.gapBps}`);
  if (!(i.maxSlippageBps >= 0 && i.maxSlippageBps < 10_000)) throw new RangeError(`maxSlippageBps must be in [0, 10000), got ${i.maxSlippageBps}`);
  const hf0 = healthAfterGap(p, i.gapBps);
  if (hf0 >= i.targetHfAfterGap) return { kind: "noop", reason: `survives a ${i.gapBps} bps gap at HF ${hf0.toFixed(3)}` };

  const needed = round2up(p.debtUsd - maxDebtFor(p, i.gapBps, i.targetHfAfterGap));
  // Respect the venue's minimum loan: never leave 0 < debt < minLoan.
  const clampRepay = (want: number) => {
    const remaining = p.debtUsd - want;
    if (remaining > 0 && remaining < p.minLoanUsd) {
      if (p.debtUsd <= i.cushionUsd) return p.debtUsd; // repay everything
      return Math.max(0, Math.floor((p.debtUsd - p.minLoanUsd) * 100) / 100); // stop at the minimum, cents rounded down
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
  const net = px * (1 - s); // proceeds per token sold
  const T = i.targetHfAfterGap * 1.0001; // margin so cent/micro-unit rounding never lands below target
  const k = (px * (1 - i.gapBps / 10_000) * p.lltv) / T; // debt headroom per remaining token
  const D = p.debtUsd - fromCushion;
  const C = p.collateralTokens;
  const finish = (sellTokens: number, flashRepayUsd: number, why?: string): ShieldPlan => {
    const after: Position = { ...p, collateralTokens: C - sellTokens, debtUsd: D - flashRepayUsd };
    const hf = healthAfterGap(after, i.gapBps);
    if (why || hf < i.targetHfAfterGap - 1e-9) {
      return { kind: "insufficient", repayUsd: fromCushion, hfAfterGap: hf, reason: why ?? "selling collateral cannot reach the target", sellTokens, flashRepayUsd };
    }
    return {
      kind: "repay+deleverage",
      repayUsd: fromCushion,
      sellTokens,
      flashRepayUsd,
      hfAfterGap: hf,
      reason: `repay ${fromCushion} from the cushion and sell ${sellTokens} tokens into debt before the close`,
    };
  };
  const tokensFor = (usd: number) => Math.ceil((usd / net) * 1e6) / 1e6;
  const cents = (x: number) => Math.floor(x * 100) / 100;

  const den = net - k;
  if (den <= 0) {
    // each token sold removes more headroom than it repays: selling never helps
    return finish(0, 0, "slippage and gap leave no headroom: selling collateral cannot reach the target");
  }
  let sellTokens: number;
  let reason: string | undefined;
  const x = Math.max(0, (D - C * k) / den);
  if (x > C) {
    sellTokens = C;
    reason = "even selling all collateral cannot reach the target";
  } else {
    sellTokens = Math.ceil(x * 1e6) / 1e6;
  }
  let flash = Math.min(D, cents(sellTokens * net));
  if (flash === D) sellTokens = Math.min(sellTokens, tokensFor(D)); // never sell more than the debt needs

  // Respect the minimum loan after the flash repay too.
  const remaining = D - flash;
  if (remaining > 0 && remaining < p.minLoanUsd) {
    if (tokensFor(D) <= C) {
      sellTokens = tokensFor(D);
      flash = D;
      reason = undefined;
    } else {
      flash = Math.max(0, cents(D - p.minLoanUsd));
      sellTokens = Math.min(C, tokensFor(flash));
      reason = "minimum loan prevents repaying everything";
    }
  }
  return finish(sellTokens, flash, reason);
}

/** Borrows back toward `targetDebtUsd` within `maxLtv`. `cushionUsd` is not consulted: restoring never spends the cushion. */
export interface RestoreInput { position: Position; cushionUsd: number; targetDebtUsd: number; maxLtv: number }

export function planRestore(i: RestoreInput): { kind: "noop"; reason: string } | { kind: "borrow"; borrowUsd: number; ltvAfter: number } {
  const p = i.position;
  const value = p.collateralTokens * p.collateralPriceUsd;
  const capDebt = value * i.maxLtv;
  const target = Math.min(i.targetDebtUsd, capDebt);
  const borrowUsd = Math.floor((target - p.debtUsd) * 100) / 100;
  if (borrowUsd <= 0) return { kind: "noop", reason: "already at or above the restore target" };
  if (p.debtUsd + borrowUsd < p.minLoanUsd) return { kind: "noop", reason: "restored debt would be below the venue minimum loan" };
  return { kind: "borrow", borrowUsd, ltvAfter: (p.debtUsd + borrowUsd) / value };
}
