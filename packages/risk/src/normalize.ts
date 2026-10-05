import { tickerBySymbol } from "./config";

export type Issuer = "bstock" | "ondo" | "xstock";
export type RiskWindow = "NONE" | "OVERNIGHT" | "WEEKEND" | "HOLIDAY" | "EARNINGS";

/** Token price (raw units) → price of one underlying share. */
export const perSharePrice = (tokenPriceUsd: number, sharesPerToken: number) => tokenPriceUsd / sharesPerToken;
export const tokenPriceFromShare = (sharePriceUsd: number, sharesPerToken: number) => sharePriceUsd * sharesPerToken;

/** Shares represented by a raw balance. xStocks rebase, so their balance is already in shares. */
export function sharesHeld(balanceWei: bigint, sharesPerToken: number, issuer: Issuer): number {
  const tokens = Number(balanceWei) / 1e18;
  return issuer === "xstock" ? tokens : tokens * sharesPerToken;
}

export const devBps = (a: number, b: number) => (Math.abs(a - b) / b) * 10_000;

/** p99 down-gap for a window. EARNINGS is the larger of the earnings gap and `base` (default: the weekend gap). */
export function gapBps(symbol: string, w: RiskWindow, base?: RiskWindow): number {
  const g = tickerBySymbol(symbol).gapBps;
  switch (w) {
    case "OVERNIGHT":
      return g.overnight;
    case "WEEKEND":
      return g.weekend;
    case "HOLIDAY":
      return g.holiday;
    case "EARNINGS": {
      const b = gapBps(symbol, base ?? "WEEKEND");
      return Math.max(g.earnings, b);
    }
    default:
      return 0;
  }
}
