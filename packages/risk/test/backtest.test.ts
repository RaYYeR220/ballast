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
    expect(r.shieldsTriggered).toBe(2); // both NVDA weekend rows exceed the 737 bps buffer at 0.70; SPY overnight (223 bps) already survives
    expect(r.byType.weekend!.protected).toBe(0);
    expect(r.byType.weekend!.unprotected).toBe(1);
  });

  it("does not shield positions that already survive", () => {
    const r = runBacktest([w("SPYB", "overnight", 0.0, -0.001)], { lltv: 0.85, startLtv: 0.3, targetHfAfterGap: 1.05 });
    expect(r.shieldsTriggered).toBe(0);
  });

  it("converts an unprotected liquidation when the move is within the p99 buffer", () => {
    const r = runBacktest([w("NVDAB", "weekend", -0.07, -0.07)], { lltv: 0.75, startLtv: 0.7, targetHfAfterGap: 1.05 });
    expect(r.unprotectedLiquidations).toBe(1); // 0.70/0.93 = 0.7527 > 0.75
    expect(r.protectedLiquidations).toBe(0);
    expect(r.shieldsTriggered).toBe(1);
  });

  it("still liquidates when the realised move exceeds the buffer (shield insufficient)", () => {
    const r = runBacktest([w("NVDAB", "weekend", -0.2, -0.2)], { lltv: 0.75, startLtv: 0.7, targetHfAfterGap: 1.05 });
    expect(r.unprotectedLiquidations).toBe(1);
    expect(r.protectedLiquidations).toBe(1);
    expect(r.shieldsTriggered).toBe(1);
  });

  it("treats the data-file holiday label as a holiday window and skips unknown types/tickers", () => {
    const rows = [w("NVDAB", "long_weekend_holiday", -0.01, -0.01), { ...w("NVDAB", "weekend", 0, 0), type: "other" as never }, w("ZZZZB", "weekend", -0.5, -0.5)];
    const r = runBacktest(rows, { lltv: 0.75, startLtv: 0.7, targetHfAfterGap: 1.05 });
    expect(r.windows).toBe(1);
    expect(r.byType.long_weekend_holiday!.windows).toBe(1);
  });
});
