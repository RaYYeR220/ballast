import { describe, expect, it } from "vitest";
import { listaDebt, listaLif, ltv, healthFactor, healthAfterGap, liquidationPrice, type Position } from "../src/position";

const p: Position = { collateralTokens: 10, collateralPriceUsd: 225, debtUsd: 1000, lltv: 0.75, minLoanUsd: 15 };

describe("position math", () => {
  it("lista debt rounds up with virtual shares", () => {
    const d = listaDebt(1_000_000n, { totalBorrowAssets: 999n, totalBorrowShares: 999_000_000n, lltv: 750000000000000000n });
    expect(d).toBe(1n); // ceil(1e6 * (999 + 1) / (999e6 + 1e6)) = 1
  });
  it("liquidation incentive", () => {
    expect(listaLif(0.75)).toBeCloseTo(1.0811, 4);
    expect(listaLif(0.85)).toBeCloseTo(1.0471, 4);
    expect(listaLif(0.5)).toBe(1.15);
  });
  it("ltv / hf / gap / liquidation price", () => {
    expect(ltv(p)).toBeCloseTo(1000 / 2250, 9);
    expect(healthFactor(p)).toBeCloseTo((2250 * 0.75) / 1000, 9);
    expect(healthAfterGap(p, 737)).toBeCloseTo(((2250 * (1 - 0.0737)) * 0.75) / 1000, 9);
    expect(liquidationPrice(p)).toBeCloseTo(1000 / (10 * 0.75), 9);
    expect(healthFactor({ ...p, debtUsd: 0 })).toBe(Infinity);
  });
});
