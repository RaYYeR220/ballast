import { tickerBySymbol } from "@ballast/risk";
import { describe, expect, it } from "vitest";
import { bandBps, bandExamples, baseGapBps, MAX_BAND_BPS } from "../lib/band";

const H = 3600;

describe("band rule (SessionAwareFeed.band)", () => {
  it("starts at the base gap and adds one base per 24 h closed, in the contract's integer maths", () => {
    expect(bandBps(417, 0)).toBe(417);
    expect(bandBps(417, 12 * H)).toBe(417 + 208);
    expect(bandBps(417, 17.5 * H)).toBe(721);
    expect(bandBps(417, 24 * H)).toBe(834);
    expect(bandBps(417, 24 * H - 1)).toBe(833);
  });

  it("is capped at three times the base", () => {
    expect(bandBps(737, 48 * H)).toBe(2211);
    expect(bandBps(737, 65.5 * H)).toBe(2211);
    expect(bandBps(450, 89.5 * H)).toBe(1350);
  });

  it("and at 90%", () => {
    expect(bandBps(3500, 24 * H)).toBe(7000);
    expect(bandBps(3500, 48 * H)).toBe(MAX_BAND_BPS);
  });

  it("is zero without a base gap", () => {
    expect(bandBps(0, 10 * H)).toBe(0);
  });

  it("an earnings window starts from the larger of the closure's gap and the earnings gap", () => {
    const nvda = tickerBySymbol("NVDA");
    expect(baseGapBps(nvda, "overnight")).toBe(417);
    expect(baseGapBps(nvda, "earnings")).toBe(502);
    expect(baseGapBps(nvda, "earnings", "weekend")).toBe(737);
    expect(baseGapBps(tickerBySymbol("SPY"), "earnings")).toBe(155); // no earnings gap for an ETF
  });
});

describe("band examples drawn on the landing page", () => {
  it("one closure of each kind from the calendar, with NVDA's gaps", () => {
    const ex = bandExamples("NVDA");
    expect(ex.map((e) => [e.window, e.hours, e.baseBps, e.openBps, e.capAtHours])).toEqual([
      ["overnight", 17.5, 417, 721, null],
      ["earnings", 17.5, 502, 868, null],
      ["weekend", 65.5, 737, 2211, 48],
      ["holiday", 89.5, 450, 1350, 48],
    ]);
  });

  it("curves start at the measured gap at the close and end at the band at the open", () => {
    for (const e of bandExamples("NVDA")) {
      expect(e.curve[0]).toEqual([0, e.baseBps]);
      expect(e.curve.at(-1)).toEqual([e.hours, e.openBps]);
      for (let i = 1; i < e.curve.length; i++) expect(e.curve[i]![1]).toBeGreaterThanOrEqual(e.curve[i - 1]![1]);
    }
  });
});
