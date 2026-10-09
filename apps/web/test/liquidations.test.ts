import { describe, expect, it } from "vitest";
import { SAMPLE, SAMPLE_CLOCK, WEEK } from "../lib/clock";
import { FACTS, kUsd, LIQUIDATIONS, liquidationFacts, pct, withDerived } from "../lib/liquidations";
import { hourOfWeek } from "../lib/planisphere/sessions";

describe("liquidation data behind the landing copy", () => {
  it("has the 121 rows: 33 organic, 87 tripwire seeds, 1 stock-loan", () => {
    expect(FACTS.total).toBe(121);
    expect(FACTS.organic).toBe(33);
    expect(FACTS.seeds).toBe(87);
    expect(FACTS.loans).toBe(1);
    expect(FACTS.bStockCollateral).toBe(120);
  });

  it("counts weekend rows by hour of the week (Friday 20:00 to Sunday 20:00), not by the label", () => {
    expect(FACTS.weekend).toBe(0);
    const relabelled = LIQUIDATIONS.map((r, i) => (i === 0 ? { ...r, s: "weekend" as const } : r));
    expect(liquidationFacts(relabelled).weekend).toBe(0);
    const moved = LIQUIDATIONS.map((r, i) => (i === 0 ? { ...r, h: 130 } : r));
    expect(liquidationFacts(moved).weekend).toBe(1);
  });

  it("81% of organic dollars fell in the first 90 minutes after an open", () => {
    expect(FACTS.firstWindowShare).toBeCloseTo(0.8124, 4);
    expect(pct(FACTS.firstWindowShare)).toBe("81%");
    expect(kUsd(FACTS.firstWindowUsd)).toBe("$24.8k");
    expect(kUsd(FACTS.organicUsd)).toBe("$30.6k");
  });

  it("the open after a weekend or holiday: 3 organic liquidations, $17.9k, 59% of organic dollars", () => {
    expect(FACTS.mondayOpen).toHaveLength(3);
    expect(FACTS.mondayOpen.every((r) => r.g === "organic")).toBe(true);
    expect(kUsd(FACTS.mondayUsd)).toBe("$17.9k");
    expect(pct(FACTS.mondayShare)).toBe("59%");
  });

  it("derives first-90 and the holiday name once, as fields", () => {
    expect(LIQUIDATIONS.filter((r) => r.first90)).toHaveLength(11);
    expect(LIQUIDATIONS.filter((r) => r.first90 && r.g !== "organic")).toHaveLength(0);
    expect(LIQUIDATIONS.filter((r) => r.afterLongClose)).toHaveLength(3);
    const holiday = LIQUIDATIONS.filter((r) => r.holiday);
    expect(holiday).toHaveLength(3);
    expect(new Set(holiday.map((r) => r.holiday))).toEqual(new Set(["Juneteenth"]));
    const seed = withDerived({ h: 1, usd: 5, s: "regular", g: "seed", c: "X", tx: "0x00", et: "Mon 2026-07-06 00:01 ET", t: "regular: first 90 min" });
    expect(seed.first90).toBe(false);
  });

  it("tripwire positions were $4 to $26", () => {
    expect(Math.round(FACTS.seedMinUsd)).toBe(4);
    expect(Math.round(FACTS.seedMaxUsd)).toBe(26);
  });

  it("every row is placed on the week, matches its own timestamp, and links to a transaction hash", () => {
    for (const r of LIQUIDATIONS) {
      expect(r.h).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeLessThan(168);
      expect(r.tx).toMatch(/^0x[0-9a-f]{64}$/);
      const [, date, hh, mm] = /(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(r.et)!;
      const ts = Date.parse(`${date}T${hh}:${mm}:00-04:00`) / 1000; // the whole sample is EDT
      expect(hourOfWeek(ts)).toBeCloseTo(r.h, 3);
    }
  });

  it("the dollars row of the clock-vs-money chart comes from the file", () => {
    const d = FACTS.dollarShares;
    expect(kUsd(FACTS.collateralUsd)).toBe("$31.6k");
    expect(Math.round(d.regular * 1000) / 10).toBe(85.5);
    expect(Math.round(d.prePost * 1000) / 10).toBe(7.3);
    expect(Math.round(d.overnight * 1000) / 10).toBe(7.1);
    expect(Math.round(d.holiday * 1000) / 10).toBe(0.1);
    expect(d.weekend).toBe(0);
    expect(Object.values(d).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
});

describe("clock figures from the calendar", () => {
  it("the clock row covers 18 June to 22 September 2026 in whole New York days", () => {
    expect(SAMPLE.to - SAMPLE.from).toBe(97 * 86_400);
    const c = SAMPLE_CLOCK;
    expect(Math.round(c.regular * 1000) / 10).toBe(18.4);
    expect(Math.round(c.prePost * 1000) / 10).toBe(26.9);
    expect(Math.round(c.overnight * 1000) / 10).toBe(22.7);
    expect(Math.round(c.holiday * 1000) / 10).toBe(3.3);
    expect(Math.round(c.weekend * 1000) / 10).toBe(28.7);
  });

  it("a plain week: NYSE is shut 80.65% of the time (the 81% headline), the weekend is 28.6% (29%)", () => {
    expect(WEEK.closedShare).toBeCloseTo(0.80655, 5);
    expect(pct(WEEK.closedShare)).toBe("81%");
    expect(WEEK.weekendShare).toBeCloseTo(48 / 168, 12);
    expect(pct(WEEK.weekendShare)).toBe("29%");
  });
});
