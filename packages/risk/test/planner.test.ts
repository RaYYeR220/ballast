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

describe("planShield bounds", () => {
  const input = { gapBps: 737, targetHfAfterGap: 1.05, maxSlippageBps: 150, canSellCollateral: true };

  it("never sells more than held or repays more than the debt (unreachable target)", () => {
    const plan = planShield({ ...input, position: { ...base, debtUsd: 2300 }, cushionUsd: 0 });
    expect(plan.kind).toBe("insufficient");
    if (plan.kind !== "insufficient") return;
    expect(plan.reason).toMatch(/selling all collateral/);
    expect(plan.hfAfterGap).toBeLessThan(1.05);
  });

  it("best-effort insufficient plan stays within held collateral and debt", () => {
    const plan = planShield({ ...input, position: { ...base, debtUsd: 2300 }, cushionUsd: 0 });
    expect(plan.kind).toBe("insufficient");
    if (plan.kind !== "insufficient") return;
    expect(plan.sellTokens).toBeLessThanOrEqual(10);
    expect(plan.flashRepayUsd).toBeLessThanOrEqual(2300);
  });

  it("insufficient when slippage leaves no headroom (denominator <= 0)", () => {
    const plan = planShield({ ...input, maxSlippageBps: 6000, position: { ...base, debtUsd: 1600 }, cushionUsd: 50 });
    expect(plan.kind).toBe("insufficient");
    if (plan.kind === "insufficient") expect(plan.reason).toMatch(/no headroom/);
  });

  it("rejects out-of-range gap and slippage", () => {
    expect(() => planShield({ ...input, gapBps: 10_000, position: base, cushionUsd: 0 })).toThrow(RangeError);
    expect(() => planShield({ ...input, maxSlippageBps: 10_000, position: base, cushionUsd: 0 })).toThrow(RangeError);
    expect(() => planShield({ ...input, gapBps: -1, position: base, cushionUsd: 0 })).toThrow(RangeError);
  });

  it("a large-debt deleverage still succeeds within bounds", () => {
    const plan = planShield({ ...input, position: { ...base, debtUsd: 1750 }, cushionUsd: 0 });
    expect(plan.kind).toBe("repay+deleverage");
    if (plan.kind !== "repay+deleverage") return;
    expect(plan.sellTokens).toBeGreaterThan(0);
    expect(plan.sellTokens).toBeLessThanOrEqual(10);
    expect(plan.flashRepayUsd).toBeLessThanOrEqual(1750);
    expect(plan.hfAfterGap).toBeGreaterThanOrEqual(1.05 - 1e-6);
  });

  it("never leaves 0 < debt < minLoan after the flash repay", () => {
    for (let debt = 1560; debt <= 1760; debt += 7) {
      const plan = planShield({ ...input, position: { ...base, debtUsd: debt, minLoanUsd: 400 }, cushionUsd: 0 });
      if (plan.kind !== "repay+deleverage") continue;
      const left = debt - plan.repayUsd - plan.flashRepayUsd;
      expect(left <= 1e-9 || left >= 400 - 1e-9).toBe(true);
    }
  });

  it("repays everything via sale when the remainder would be dust and collateral allows", () => {
    // needs ~ $1600-... remainder just under minLoan: huge minLoan forces full repay
    const plan = planShield({ ...input, position: { ...base, debtUsd: 1600, minLoanUsd: 1500 }, cushionUsd: 0 });
    expect(plan.kind).toBe("repay+deleverage");
    if (plan.kind === "repay+deleverage") expect(plan.flashRepayUsd).toBe(1600);
  });

  it("leaves exactly minLoan and reports insufficient when collateral cannot repay all", () => {
    const plan = planShield({ ...input, position: { collateralTokens: 1, collateralPriceUsd: 225, debtUsd: 300, lltv: 0.75, minLoanUsd: 200 }, cushionUsd: 0 });
    expect(plan.kind).toBe("insufficient");
    if (plan.kind === "insufficient") expect(300 - (plan.flashRepayUsd ?? 0)).toBeGreaterThanOrEqual(200 - 1e-9);
  });
});

describe("planRestore", () => {
  it("borrows back up to the target debt within the LTV cap", () => {
    const p = { ...base, debtUsd: 1000 };
    const r = planRestore({ position: p, cushionUsd: 0, targetDebtUsd: 1500, maxLtv: 0.6 });
    expect(r).toEqual({ kind: "borrow", borrowUsd: 350, ltvAfter: 1350 / 2250 });
  });
  it("never borrows into a debt below the minimum loan", () => {
    const r = planRestore({ position: { ...base, debtUsd: 0 }, cushionUsd: 0, targetDebtUsd: 10, maxLtv: 0.6 });
    expect(r.kind).toBe("noop");
  });
  it("noop when already at target", () => {
    expect(planRestore({ position: base, cushionUsd: 0, targetDebtUsd: 1500, maxLtv: 0.8 }).kind).toBe("noop");
  });
});

describe("planShield min-loan fallthrough", () => {
  it("sells collateral to clear the loan when the min-loan clamp blocks a cushion-only repay", () => {
    const p: Position = { collateralTokens: 0.1, collateralPriceUsd: 225, debtUsd: 20, lltv: 0.75, minLoanUsd: 15 };
    const plan = planShield({ position: p, gapBps: 737, targetHfAfterGap: 1.05, cushionUsd: 10, maxSlippageBps: 150, canSellCollateral: true });
    expect(plan.kind).toBe("repay+deleverage");
    if (plan.kind !== "repay+deleverage") return;
    expect(plan.repayUsd + plan.flashRepayUsd).toBeCloseTo(20, 2);
    expect(plan.hfAfterGap).toBe(Infinity);
  });
});
