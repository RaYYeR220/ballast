import { gapBps } from "./normalize";
import { planShield } from "./planner";

export interface ClosureWindow {
  sym: string;
  und: string;
  /** "long_weekend_holiday" is the label used in data/closure-windows.json for holiday closures. */
  type: "overnight" | "weekend" | "holiday" | "long_weekend_holiday";
  d0: string;
  d1: string;
  gap: number;
  max_dn: number;
  wick_dn: number | null;
}

export interface BacktestResult {
  windows: number;
  unprotectedLiquidations: number;
  protectedLiquidations: number;
  shieldsTriggered: number;
  avgRepayShareOfDebt: number;
  byType: Record<string, { windows: number; unprotected: number; protected: number }>;
}

const WINDOW = { overnight: "OVERNIGHT", weekend: "WEEKEND", holiday: "HOLIDAY", long_weekend_holiday: "HOLIDAY" } as const;

export function runBacktest(windows: ClosureWindow[], opts: { lltv: number; startLtv: number; targetHfAfterGap: number }): BacktestResult {
  const r: BacktestResult = { windows: 0, unprotectedLiquidations: 0, protectedLiquidations: 0, shieldsTriggered: 0, avgRepayShareOfDebt: 0, byType: {} };
  let repayShareSum = 0;
  for (const w of windows) {
    const wt = WINDOW[w.type as keyof typeof WINDOW];
    if (!wt) continue; // unknown window type in the data file
    let g: number;
    try {
      g = gapBps(w.und, wt);
    } catch {
      continue; // ticker without a configured gap buffer
    }
    r.windows++;
    const bucket = (r.byType[w.type] ??= { windows: 0, unprotected: 0, protected: 0 });
    bucket.windows++;
    const worst = Math.min(w.gap, w.max_dn, 0);
    const price = 100;
    const collateralTokens = 1;
    const debt = opts.startLtv * price;
    const liquidated = (d: number, c: number) => d / (c * price * (1 + worst)) > opts.lltv;
    if (liquidated(debt, collateralTokens)) {
      r.unprotectedLiquidations++;
      bucket.unprotected++;
    }
    const plan = planShield({
      position: { collateralTokens, collateralPriceUsd: price, debtUsd: debt, lltv: opts.lltv, minLoanUsd: 0 },
      gapBps: g,
      targetHfAfterGap: opts.targetHfAfterGap,
      cushionUsd: debt,
      maxSlippageBps: 150,
      canSellCollateral: false,
    });
    let debtAfter = debt;
    if (plan.kind === "repay" || plan.kind === "insufficient") {
      if (plan.repayUsd > 0) {
        r.shieldsTriggered++;
        repayShareSum += plan.repayUsd / debt;
        debtAfter = debt - plan.repayUsd;
      }
    }
    if (liquidated(debtAfter, collateralTokens)) {
      r.protectedLiquidations++;
      bucket.protected++;
    }
  }
  r.avgRepayShareOfDebt = r.shieldsTriggered ? repayShareSum / r.shieldsTriggered : 0;
  return r;
}
