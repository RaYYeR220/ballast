/* The Session Oracle band as SessionAwareFeed.band() enforces it on-chain: while New York is closed the
   price is held within +-band of the last reference, where band = the ticker's p99 gap for the window
   (an earnings window takes the larger earnings gap) + one more base per 24 h closed, capped at 3x base
   and at 90%. The integer maths matches the contract. */
import { nextWindow, tickerBySymbol, type TickerConfig, type WindowType } from "@ballast/risk";
import { dayNumber, localToUtc } from "./planisphere/sessions";

export const MAX_BAND_MULTIPLE = 3;
export const MAX_BAND_BPS = 9000;
const DAY = 86_400;

/** Band width in bps after `elapsedSec` closed, for a window whose base gap is `baseBps`. */
export function bandBps(baseBps: number, elapsedSec: number): number {
  if (baseBps <= 0) return 0;
  const grown = baseBps + Math.floor((baseBps * Math.max(0, Math.floor(elapsedSec))) / DAY);
  return Math.min(grown, baseBps * MAX_BAND_MULTIPLE, MAX_BAND_BPS);
}

export type BandWindow = "overnight" | "weekend" | "holiday" | "earnings";

/** The base gap the oracle starts from (SessionOracle.currentWindow): the window type's p99, raised to the
    earnings p99 when earnings land at the next open. */
export function baseGapBps(t: TickerConfig, w: BandWindow, closure: Exclude<BandWindow, "earnings"> = "overnight"): number {
  if (w !== "earnings") return t.gapBps[w];
  return Math.max(t.gapBps[closure], t.gapBps.earnings);
}

export interface BandExample {
  window: BandWindow;
  label: string;
  /** hours from the close to the next open, from the calendar */
  hours: number;
  baseBps: number;
  /** band at the next open */
  openBps: number;
  /** hours after the close at which the cap is reached, or null */
  capAtHours: number | null;
  /** [hours, bps] along the closure */
  curve: [number, number][];
}

const noonOf = (iso: string) => localToUtc(dayNumber(iso), 12 * 3600);

/* one closure of each kind, read from the calendar: a weeknight, a weekend, a holiday long weekend (Labor Day) */
const CLOSURES: { window: BandWindow; label: string; from: string; type: WindowType }[] = [
  { window: "overnight", label: "Overnight", from: "2026-10-06", type: "OVERNIGHT" },
  { window: "earnings", label: "Earnings night", from: "2026-10-06", type: "OVERNIGHT" },
  { window: "weekend", label: "Weekend", from: "2026-10-09", type: "WEEKEND" },
  { window: "holiday", label: "Holiday weekend", from: "2026-09-04", type: "HOLIDAY" },
];

export function bandExamples(symbol = "NVDA"): BandExample[] {
  const t = tickerBySymbol(symbol);
  return CLOSURES.map(({ window, label, from, type }) => {
    const w = nextWindow(noonOf(from));
    if (w.type !== type) throw new Error(`expected a ${type} closure after ${from}, the calendar says ${w.type}`);
    const seconds = w.endsAt - w.startsAt;
    const baseBps = baseGapBps(t, window);
    const curve: [number, number][] = [];
    for (let s = 0; s <= seconds; s += 1800) curve.push([s / 3600, bandBps(baseBps, s)]);
    if (curve[curve.length - 1]![0] !== seconds / 3600) curve.push([seconds / 3600, bandBps(baseBps, seconds)]);
    const capBps = Math.min(baseBps * MAX_BAND_MULTIPLE, MAX_BAND_BPS);
    const capAt = curve.find(([, b]) => b >= capBps);
    return {
      window,
      label,
      hours: seconds / 3600,
      baseBps,
      openBps: bandBps(baseBps, seconds),
      capAtHours: capAt ? capAt[0] : null,
      curve,
    };
  });
}
