import { describe, expect, it } from "vitest";
import { runBacktest, type ClosureWindow } from "../src/backtest";

const w = (sym: string, type: ClosureWindow["type"], gap: number, max_dn: number): ClosureWindow => ({
  sym, und: sym.replace(/B$/, ""), type, d0: "2026-07-10", d1: "2026-07-13", gap, max_dn, wick_dn: null,
});

describe("runBacktest", () => {
  it("counts a liquidation only when the worst move breaches LLTV", () => {
    const r = runBacktest(
      [w("NVDAB", "weekend", -0.08, -0.09), w("NVDAB", "weekend", -0.01, -0.02), w("SPYB", "overnight", 0.01, -0.005)],
      { lltv: 0.75, startLtv: 0.7, targetHfAfterGap: 1.05 },
    );
    expect(r.windows).toBe(3);
    expect(r.unprotectedLiquidations).toBe(1); // 0.70/0.91 = 0.769 > 0.75
    expect(r.protectedLiquidations).toBe(0);
    expect(r.shieldsTriggered).toBeGreaterThanOrEqual(1);
    expect(r.byType.weekend!.unprotected).toBe(1);
  });

  it("does not shield positions that already survive", () => {
    const r = runBacktest([w("SPYB", "overnight", 0.0, -0.001)], { lltv: 0.85, startLtv: 0.3, targetHfAfterGap: 1.05 });
    expect(r.shieldsTriggered).toBe(0);
  });
});
