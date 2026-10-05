import { describe, expect, it } from "vitest";
import { planShield, planRestore } from "../src/planner";
import { healthAfterGap, type Position } from "../src/position";

const base: Position = { collateralTokens: 10, collateralPriceUsd: 225, debtUsd: 1500, lltv: 0.75, minLoanUsd: 15 };

describe("planShield", () => {
  it("does nothing when the position already survives the gap", () => {
    const p = { ...base, debtUsd: 1000 };
    expect(planShield({ position: p, gapBps: 737, targetHfAfterGap: 1.05, cushionUsd: 500, maxSlippageBps: 150, canSellCollateral: true }).kind).toBe("noop");
  });

  it("repays from the cushion exactly to the target", () => {
    const plan = planShield({ position: base, gapBps: 737, targetHfAfterGap: 1.05, cushionUsd: 1000, maxSlippageBps: 150, canSellCollateral: true });
    expect(plan.kind).toBe("repay");
    if (plan.kind !== "repay") return;
    const after = healthAfterGap({ ...base, debtUsd: base.debtUsd - plan.repayUsd }, 737);
    expect(after).toBeGreaterThanOrEqual(1.05 - 1e-9);
    expect(after).toBeLessThan(1.06);
  });

  it("repays everything instead of leaving dust below the minimum loan", () => {
    const p = { ...base, debtUsd: 20, collateralTokens: 0.1 };
    const plan = planShield({ position: p, gapBps: 737, targetHfAfterGap: 1.05, cushionUsd: 100, maxSlippageBps: 150, canSellCollateral: false });
    expect(plan.kind).toBe("repay");
    if (plan.kind === "repay") expect(plan.repayUsd).toBe(20);
  });

  it("stops at the minimum loan when the cushion cannot repay everything", () => {
    const p = { ...base, debtUsd: 20, collateralTokens: 0.1 };
    const plan = planShield({ position: p, gapBps: 737, targetHfAfterGap: 1.05, cushionUsd: 10, maxSlippageBps: 150, canSellCollateral: false });
    expect(plan.kind).toBe("insufficient");
    if (plan.kind === "insufficient") expect(plan.repayUsd).toBe(5); // leaves exactly $15
  });

  it("adds a flash deleverage when the cushion is short and selling is allowed", () => {
    const plan = planShield({ position: { ...base, debtUsd: 1600 }, gapBps: 737, targetHfAfterGap: 1.05, cushionUsd: 50, maxSlippageBps: 150, canSellCollateral: true });
    expect(plan.kind).toBe("repay+deleverage");
    if (plan.kind !== "repay+deleverage") return;
    expect(plan.repayUsd).toBe(50);
    expect(plan.sellTokens).toBeGreaterThan(0);
    expect(plan.hfAfterGap).toBeGreaterThanOrEqual(1.05 - 1e-6);
    expect(plan.flashRepayUsd).toBeLessThanOrEqual(plan.sellTokens * 225 * (1 - 0.015) + 1e-9);
  });

  it("reports insufficient when it cannot reach the target and cannot sell", () => {
    const plan = planShield({ position: { ...base, debtUsd: 1600 }, gapBps: 737, targetHfAfterGap: 1.05, cushionUsd: 50, maxSlippageBps: 150, canSellCollateral: false });
    expect(plan.kind).toBe("insufficient");
  });
});

describe("planRestore", () => {
  it("borrows back up to the target debt within the LTV cap", () => {
    const p = { ...base, debtUsd: 1000 };
    const r = planRestore({ position: p, cushionUsd: 0, targetDebtUsd: 1500, maxLtv: 0.6 });
    expect(r).toEqual({ kind: "borrow", borrowUsd: 350, ltvAfter: 1350 / 2250 });
  });
  it("noop when already at target", () => {
    expect(planRestore({ position: base, cushionUsd: 0, targetDebtUsd: 1500, maxLtv: 0.8 }).kind).toBe("noop");
  });
});
