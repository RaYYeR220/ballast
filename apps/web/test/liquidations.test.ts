import { describe, expect, it } from "vitest";
import { FACTS, kUsd, LIQUIDATIONS, pct } from "../lib/liquidations";

describe("liquidation data behind the landing copy", () => {
  it("has the 121 rows: 33 organic, 87 tripwire seeds, 1 stock-loan", () => {
    expect(FACTS.total).toBe(121);
    expect(FACTS.organic).toBe(33);
    expect(FACTS.seeds).toBe(87);
    expect(FACTS.loans).toBe(1);
    expect(FACTS.bStockCollateral).toBe(120);
  });

  it("has no liquidation between Friday 20:00 and Sunday 20:00 New York", () => {
    expect(FACTS.weekend).toBe(0);
    expect(LIQUIDATIONS.filter((r) => r.h >= 116 && r.h < 164)).toEqual([]);
  });

  it("81% of organic dollars fell in the first 90 minutes after an open", () => {
    expect(FACTS.firstWindowShare).toBeCloseTo(0.8124, 4);
    expect(pct(FACTS.firstWindowShare)).toBe("81%");
    expect(kUsd(FACTS.firstWindowUsd)).toBe("$24.8k");
    expect(kUsd(FACTS.organicUsd)).toBe("$30.6k");
  });

  it("the Monday open after a weekend or holiday: 3 liquidations, $17.9k, 59% of organic dollars", () => {
    expect(FACTS.mondayOpen).toHaveLength(3);
    expect(kUsd(FACTS.mondayUsd)).toBe("$17.9k");
    expect(pct(FACTS.mondayShare)).toBe("59%");
  });

  it("tripwire positions were $4 to $26", () => {
    expect(Math.round(FACTS.seedMinUsd)).toBe(4);
    expect(Math.round(FACTS.seedMaxUsd)).toBe(26);
  });

  it("every row is placed on the week and links to a transaction hash", () => {
    for (const r of LIQUIDATIONS) {
      expect(r.h).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeLessThan(168);
      expect(r.tx).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});
