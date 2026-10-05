import { describe, expect, it } from "vitest";
import { perSharePrice, tokenPriceFromShare, sharesHeld, devBps, gapBps } from "../src/normalize";

describe("normalize", () => {
  it("raw bStock price → per share", () => {
    expect(perSharePrice(225.17505, 1.000778)).toBeCloseTo(225.0, 3);
    expect(tokenPriceFromShare(225, 1.000778)).toBeCloseTo(225.17505, 4);
  });
  it("shares held per issuer", () => {
    expect(sharesHeld(10n * 10n ** 18n, 1.000778, "bstock")).toBeCloseTo(10.00778, 5);
    expect(sharesHeld(10n * 10n ** 18n, 1.009473, "ondo")).toBeCloseTo(10.09473, 5);
    expect(sharesHeld(10n * 10n ** 18n, 1.005715, "xstock")).toBe(10); // rebasing: balance already in shares
  });
  it("devBps", () => {
    expect(devBps(227.25, 225)).toBeCloseTo(100, 6);
    expect(devBps(222.75, 225)).toBeCloseTo(100, 6);
  });
  it("gap buffers from config, earnings = max(earnings, window)", () => {
    expect(gapBps("NVDA", "WEEKEND")).toBe(737);
    expect(gapBps("NVDA", "EARNINGS")).toBe(737); // weekend 737 > earnings 502 when no base given
    expect(gapBps("SPY", "EARNINGS")).toBe(223);
    expect(gapBps("META", "EARNINGS")).toBe(2446);
    expect(gapBps("NVDA", "NONE")).toBe(0);
  });
});
