/* One row of the explorer per ticker, assembled from the three sources it has: the Session Oracle on chain,
   the Binance Web3 RWA prices and Binance's keyless asset status. Each field says where it came from, and a
   missing source leaves the field empty instead of filling it in. Pure and client-safe. */
import { tickers } from "@ballast/risk";
import { bandBps } from "./band";
import { latestClosure } from "./closures";
import { venueSpread, type PricesBody, type Spread, type Venue, type VenuePrice } from "./market-view";
import { isSymbolView, usd8, type OracleSymbolView, type OracleView } from "./oracle-view";

export interface RwaStatusView {
  status: "ok" | "unavailable";
  detail?: string;
  market?: { marketStatus: string | null; openState: boolean; nextOpenTime?: number | null; nextCloseTime?: number | null };
  assets?: { symbol: string; token: string; status: { openState: boolean; marketStatus: string | null; reasonCode: string | null; reasonMsg: string | null } | null; error?: string }[];
}

export type BandNow =
  /** New York is open: the feed passes the upstream price through */
  | { kind: "open" }
  /** read from SessionAwareFeed.band() */
  | { kind: "chain"; bps: number; lo: number; hi: number }
  /** the contract's rule applied to the calendar and the configured gap, because the contract was not read */
  | { kind: "rule"; bps: number }
  /** closed, but the feed has no anchor and passes the price through */
  | { kind: "no-anchor" }
  | { kind: "unknown"; why: string };

export interface OracleRow {
  symbol: string;
  venues: Record<Venue, VenuePrice | null>;
  spread: Spread | null;
  /** per-share USD the oracle compares against, and where it was read */
  reference: { price: number; updatedAt: number; source: "session-oracle" | "chainlink" } | null;
  referenceNote: string | null;
  band: BandNow;
  /** the on-chain snapshot, when the oracle was read */
  chain: OracleSymbolView | null;
  chainError: string | null;
  /** Binance's keyless status of the bStock */
  asset: { open: boolean; code: string | null } | null;
}

const GAP_OF = { overnight: "overnight", weekend: "weekend", holiday: "holiday" } as const;

function bandNow(symbol: string, chain: OracleSymbolView | null, now: number): BandNow {
  if (chain) {
    if (chain.session === "REGULAR") return { kind: "open" };
    const b = chain.band;
    if (b && !("error" in b)) {
      if (!b.ok) return { kind: "no-anchor" };
      const lo = usd8(b.lo);
      const hi = usd8(b.hi);
      if (lo !== null && hi !== null) return { kind: "chain", bps: b.bandBps, lo, hi };
    }
    if (chain.currentWindow.gapBps > 0 && chain.currentWindow.closedAt > 0) return { kind: "rule", bps: bandBps(chain.currentWindow.gapBps, chain.at - chain.currentWindow.closedAt) };
    return { kind: "unknown", why: b && "error" in b ? b.error : "the feed's band was not read" };
  }
  const closure = latestClosure(now);
  if (!closure) return { kind: "unknown", why: "outside the calendar" };
  if (!closure.inProgress) return { kind: "open" };
  const t = tickers.find((x) => x.symbol === symbol);
  const base = t ? t.gapBps[GAP_OF[closure.kind]] : 0;
  return base > 0 ? { kind: "rule", bps: bandBps(base, now - closure.closedAt) } : { kind: "no-anchor" };
}

export function oracleRows(prices: PricesBody | null, oracle: OracleView | null, rwa: RwaStatusView | null, now: number): OracleRow[] {
  return tickers.map((t): OracleRow => {
    const p = prices?.status === "ok" ? (prices.symbols.find((x) => x.symbol === t.symbol) ?? null) : null;
    const o = oracle?.status === "ok" ? (oracle.symbols.find((x) => x.symbol === t.symbol) ?? null) : null;
    const chain = o && isSymbolView(o) ? o : null;
    const venues: OracleRow["venues"] = { bstock: null, ondo: null, xstock: null };
    for (const v of p?.venues ?? []) venues[v.venue] = v;
    const onChainRef = chain ? usd8(chain.reference) : null;
    const reference: OracleRow["reference"] =
      chain && onChainRef !== null && chain.referenceUpdatedAt !== null
        ? { price: onChainRef, updatedAt: chain.referenceUpdatedAt, source: "session-oracle" }
        : p?.reference
          ? { price: p.reference.price, updatedAt: p.reference.updatedAt, source: "chainlink" }
          : null;
    const a = rwa?.status === "ok" ? (rwa.assets?.find((x) => x.symbol === t.symbol) ?? null) : null;
    return {
      symbol: t.symbol,
      venues,
      spread: p ? venueSpread(p.venues) : null,
      reference,
      referenceNote: reference ? null : (p?.referenceNote ?? null),
      band: bandNow(t.symbol, chain, now),
      chain,
      chainError: o && !isSymbolView(o) ? o.error : null,
      asset: a?.status ? { open: a.status.openState, code: a.status.reasonCode } : null,
    };
  });
}

/** Venues of a row that have a fresh per-share price. */
export const freshVenues = (r: OracleRow): Venue[] => (["bstock", "ondo", "xstock"] as const).filter((v) => r.venues[v]?.perShare != null && !r.venues[v]?.stale);
