// @vitest-environment jsdom
/* The evidence page: every table is computed from the data files, the rows add up, and the page states its
   method, caveats, assumptions and how to reproduce it. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { tickers } from "@ballast/risk";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Evidence } from "../components/evidence/Evidence";
import { BACKTEST, GAP_TABLE, largestOrganic, sessionRows, timingRows } from "../lib/evidence";
import { FACTS, LIQUIDATIONS, pct } from "../lib/liquidations";

class RO {
  observe() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  // jsdom does not lay out SVG text; the wheel's callouts measure theirs
  (SVGElement.prototype as unknown as { getComputedTextLength: () => number }).getComputedTextLength = () => 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const root = path.resolve(__dirname, "..", "..", "..");

describe("session table", () => {
  const rows = sessionRows();
  const total = rows[rows.length - 1]!;
  const parts = rows.slice(0, -1);

  it("covers every bStock-collateral liquidation once", () => {
    expect(total).toMatchObject({ key: "total", count: FACTS.bStockCollateral, organic: FACTS.organic });
    expect(parts.reduce((n, r) => n + r.count, 0)).toBe(total.count);
    expect(parts.reduce((n, r) => n + r.organic, 0)).toBe(total.organic);
    expect(parts.reduce((n, r) => n + r.usd, 0)).toBeCloseTo(total.usd, 6);
    expect(parts.reduce((n, r) => n + r.usdShare, 0)).toBeCloseTo(1, 9);
    expect(parts.reduce((n, r) => n + r.clockShare, 0)).toBeCloseTo(1, 9);
    expect(total.organicUsd).toBeCloseTo(FACTS.organicUsd, 6);
  });

  it("has an empty weekend that is over a quarter of the clock", () => {
    const weekend = rows.find((r) => r.key === "weekend")!;
    expect(weekend).toMatchObject({ count: 0, organic: 0, usd: 0, usdShare: 0 });
    expect(weekend.clockShare).toBeGreaterThan(0.25);
  });

  it("puts most liquidations outside the regular session and most dollars inside it", () => {
    const regular = rows.find((r) => r.key === "regular")!;
    expect(regular.count / total.count).toBeLessThan(0.3);
    expect(regular.usdShare).toBeGreaterThan(0.8);
    for (const r of parts) expect(r.usdShare).toBeCloseTo(FACTS.dollarShares[r.key as keyof typeof FACTS.dollarShares], 9);
  });

  it("recomputes from other data instead of repeating fixed numbers", () => {
    const one = sessionRows(LIQUIDATIONS.filter((r) => r.g === "organic").slice(0, 3));
    expect(one[one.length - 1]).toMatchObject({ count: 3, organic: 3 });
  });
});

describe("timing and largest", () => {
  it("splits real borrowers' liquidations into parts that add up, with the first 90 minutes at the stated share", () => {
    const rows = timingRows();
    const total = rows[rows.length - 1]!;
    const parts = rows.slice(0, -1);
    expect(total.count).toBe(FACTS.organic);
    expect(parts.reduce((n, r) => n + r.count, 0)).toBe(total.count);
    expect(parts.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 9);
    expect(rows[0]!.share + rows[1]!.share).toBeCloseTo(FACTS.firstWindowShare, 9);
    expect(rows[0]!.share).toBeCloseTo(FACTS.mondayShare, 9);
  });

  it("lists the largest organic liquidations, largest first, with real transaction hashes", () => {
    const top = largestOrganic(8);
    expect(top).toHaveLength(8);
    expect(top.every((r, i) => r.g === "organic" && (i === 0 || r.usd <= top[i - 1]!.usd))).toBe(true);
    expect(top[0]!.usd).toBe(Math.max(...LIQUIDATIONS.map((r) => r.usd)));
    for (const r of top) expect(r.tx).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("backtest and gaps", () => {
  it("is the file the backtest script writes, row for row", () => {
    const file = JSON.parse(readFileSync(path.join(root, "data", "backtest-lltv75.json"), "utf8"));
    expect(BACKTEST).toEqual(file);
    for (const r of BACKTEST.results) {
      expect(r.protectedLiquidations).toBeLessThanOrEqual(r.unprotectedLiquidations);
      expect(Object.values(r.byType).reduce((n, t) => n + t.windows, 0)).toBe(r.windows);
      expect(Object.values(r.byType).reduce((n, t) => n + t.unprotected, 0)).toBe(r.unprotectedLiquidations);
    }
  });

  it("lists the configured gap of every ticker", () => {
    expect(GAP_TABLE.map((g) => g.symbol)).toEqual(tickers.map((t) => t.symbol));
    expect(GAP_TABLE[0]).toMatchObject(tickers[0]!.gapBps);
  });
});

describe("/evidence", () => {
  it("leads with the wheel and the computed claims, with no table above them", () => {
    const { container } = render(<Evidence />);
    const hero = screen.getByRole("region", { name: "The measurement" });
    expect(within(hero).getByText(/first 90 minutes after an open/).previousElementSibling!.textContent).toBe(pct(FACTS.firstWindowShare));
    expect(within(hero).getByText(`${FACTS.weekend} of ${FACTS.bStockCollateral}`)).toBeTruthy();
    expect(hero.querySelector("table")).toBeNull();
    expect(hero.querySelectorAll("[data-star]")).toHaveLength(FACTS.total);
    // the first table comes after the wheel in the page
    const firstTable = container.querySelector("table")!;
    expect(hero.compareDocumentPosition(firstTable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("prints the session table from the data, total row included", () => {
    render(<Evidence />);
    const section = screen.getByRole("region", { name: "By session" });
    const rows = sessionRows();
    const body = within(section).getAllByRole("row").slice(1);
    expect(body).toHaveLength(rows.length);
    const weekend = within(section).getByRole("row", { name: /^Weekend/ });
    expect(within(weekend).getAllByRole("cell").map((c) => c.textContent)).toEqual([`${(rows[4]!.clockShare * 100).toFixed(1)}%`, "0", "0", "$0", "$0", "0.0%"]);
    expect(within(section).getByRole("row", { name: /^All sessions/ }).textContent).toContain(String(FACTS.bStockCollateral));
  });

  it("links each of the largest liquidations to its transaction", () => {
    render(<Evidence />);
    const section = screen.getByRole("region", { name: "Largest liquidations" });
    const links = within(section).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(largestOrganic(8).map((r) => `https://bscscan.com/tx/${r.tx}`));
  });

  it("shows the backtest with its assumptions, and the gap table", () => {
    render(<Evidence />);
    const bt = screen.getByRole("region", { name: "Backtest" });
    expect(within(bt).getAllByRole("row")).toHaveLength(BACKTEST.results.length + 1);
    const worst = BACKTEST.results[BACKTEST.results.length - 1]!;
    const row = within(bt).getByRole("row", { name: new RegExp(`^${pct(worst.startLtv)}`) });
    expect(within(row).getAllByRole("cell").slice(0, 3).map((c) => c.textContent)).toEqual([String(worst.windows), String(worst.unprotectedLiquidations), String(worst.protectedLiquidations)]);
    expect(within(bt).getByText("Assumptions to read before quoting it")).toBeTruthy();
    expect(within(bt).getByText(/cushion is assumed large enough/)).toBeTruthy();
    expect(within(bt).getByText(/no earnings flag/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Gap buffers" })).getAllByRole("row")).toHaveLength(tickers.length + 1);
  });

  it("states the method, the caveats and how to reproduce it", () => {
    render(<Evidence />);
    expect(within(screen.getByRole("region", { name: "Method" })).getAllByRole("listitem")).toHaveLength(5);
    expect(within(screen.getByRole("region", { name: "Caveats" })).getByText(/The sample is young/)).toBeTruthy();
    const repro = screen.getByRole("region", { name: "Reproduce" });
    expect(within(repro).getByText("python research/check_figures.py")).toBeTruthy();
    expect(within(repro).getByText(/research\/README\.md/)).toBeTruthy();
    expect(within(repro).getByText("pnpm backtest")).toBeTruthy();
    // the command the page names exists
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts.backtest).toBeTruthy();
  });

  it("never says the contract restricts the owner", () => {
    const { container } = render(<Evidence />);
    expect(container.textContent).not.toMatch(/owner (cannot|can not|is not allowed|may not)/i);
    expect(container.textContent).not.toMatch(/can only reduce risk/i);
  });
});
