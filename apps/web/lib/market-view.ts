/* What /api/market/* returns and the arithmetic behind it: per-share prices across the three issuers, and the
   band SessionAwareFeed.band() would enforce over a closure, evaluated against real hourly candles.
   Pure and client-safe: no reads, no node imports. */
import { bandBps } from "./band";
import type { Closure } from "./closures";

export type Venue = "bstock" | "ondo" | "xstock";
export const VENUES: readonly Venue[] = ["bstock", "ondo", "xstock"];
export const VENUE_NAME: Record<Venue, string> = { bstock: "bStocks", ondo: "Ondo", xstock: "xStocks" };

/** Where a shares-per-token figure was read. */
export type MultiplierSource =
  /** the bStock's own EIP-8056 uiMultiplier() */
  | "bstock-token"
  /** Ondo's on-chain shares oracle (getSValue) */
  | "ondo-shares-oracle"
  /** the live Ondo multiplier in the Session Oracle overlay */
  | "session-oracle-overlay"
  /** xStocks rebase: one token is one share */
  | "rebasing";

export interface VenuePrice {
  venue: Venue;
  token: string;
  /** Binance's platform id for the token; null when Binance lists it under no RWA platform */
  platform: string | null;
  /** USD per token, as Binance reports it */
  tokenPrice: number | null;
  /** Binance's reference price for the token (per underlying share for platform tokens) */
  referencePrice: number | null;
  /** unix seconds of the token price */
  updatedAt: number | null;
  /** shares per token */
  multiplier: number | null;
  multiplierSource: MultiplierSource | null;
  /** USD per underlying share: tokenPrice / multiplier */
  perShare: number | null;
  /** the print is older than STALE_AFTER_SEC */
  stale: boolean;
  /** why a figure is missing */
  note?: string;
}

/** A venue print older than this is shown but left out of the spread. */
export const STALE_AFTER_SEC = 3600;

export interface ChainReference {
  /** per-share USD */
  price: number;
  /** unix seconds of the round */
  updatedAt: number;
  feed: string;
}

export interface SymbolPrices {
  symbol: string;
  venues: VenuePrice[];
  /** the Chainlink feed the Session Oracle reads as its reference; null for tickers without one */
  reference: ChainReference | null;
  referenceNote?: string;
}

export type PricesBody =
  | {
      status: "ok";
      /** unix seconds the answer was assembled */
      fetchedAt: number;
      /** head block the multipliers and references were read at; null when the chain read failed */
      blockNumber: string | null;
      chainNote?: string;
      symbols: SymbolPrices[];
    }
  | { status: "not-configured"; detail: string }
  | { status: "unavailable"; detail: string };

/** USD per underlying share from a token price and the token's shares-per-token multiplier. */
export function perShare(tokenPrice: number | null, multiplier: number | null): number | null {
  if (tokenPrice === null || multiplier === null || !(multiplier > 0) || !Number.isFinite(tokenPrice)) return null;
  return tokenPrice / multiplier;
}

export interface Spread {
  /** (max - min) / mean over the fresh per-share prices, in bps */
  bps: number;
  venues: Venue[];
}

/** Spread across the venues that have a fresh per-share price. Null with fewer than two. */
export function venueSpread(venues: readonly VenuePrice[]): Spread | null {
  const fresh = venues.filter((v) => v.perShare !== null && !v.stale);
  if (fresh.length < 2) return null;
  const xs = fresh.map((v) => v.perShare as number);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!(mean > 0)) return null;
  return { bps: ((Math.max(...xs) - Math.min(...xs)) / mean) * 10_000, venues: fresh.map((v) => v.venue) };
}

// ---------------------------------------------------------------- candles and the band

export interface Candle {
  /** unix seconds the hour opens */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

/** One print of the reference feed: per-share USD at a unix time. */
export interface RefPrint {
  at: number;
  price: number;
}

export interface BandPoint {
  /** unix seconds */
  t: number;
  /** band width in bps at t */
  bps: number;
  /** per-token USD the band is centred on; null when the feed has no anchor and passes the price through */
  anchor: number | null;
  lo: number | null;
  hi: number | null;
}

export interface BandInputs {
  closure: Pick<Closure, "closedAt" | "opensAt">;
  /** the ticker's p99 gap for this kind of closure, bps */
  baseBps: number;
  /** reference prints, any order */
  prints: readonly RefPrint[];
  /** shares per bStock token */
  multiplier: number;
  /** SessionOracle maxRefAge, seconds */
  maxRefAgeSec: number;
}

/** The latest reference print at or before t. */
export function printAt(prints: readonly RefPrint[], t: number): RefPrint | null {
  let best: RefPrint | null = null;
  for (const p of prints) if (p.at <= t && (!best || p.at > best.at)) best = p;
  return best;
}

/**
 * SessionAwareFeed.band() at time t inside a closure: width = base + base * elapsed / 1 day, capped at three
 * bases and 90%; centred on the latest reference print times the token's multiplier. A reference older than
 * maxRefAge before the close gives no anchor (the feed then passes the upstream price through).
 */
export function bandAt(t: number, i: BandInputs): BandPoint {
  const bps = bandBps(i.baseBps, t - i.closure.closedAt);
  const ref = printAt(i.prints, t);
  if (!ref || i.baseBps <= 0 || !(i.multiplier > 0) || ref.at + i.maxRefAgeSec < i.closure.closedAt) {
    return { t, bps, anchor: null, lo: null, hi: null };
  }
  const anchor = ref.price * i.multiplier;
  return { t, bps, anchor, lo: (anchor * (10_000 - bps)) / 10_000, hi: (anchor * (10_000 + bps)) / 10_000 };
}

const HOUR = 3600;

/** The band sampled on every hour of the closure, at its two ends and at each reference print inside it. */
export function bandSeries(i: BandInputs): BandPoint[] {
  const { closedAt, opensAt } = i.closure;
  const ts = new Set<number>([closedAt, opensAt]);
  for (let t = Math.ceil(closedAt / HOUR) * HOUR; t < opensAt; t += HOUR) ts.add(t);
  for (const p of i.prints) {
    if (p.at > closedAt && p.at < opensAt) {
      ts.add(p.at);
      // one second earlier too, so a new print draws as a step and not as a ramp
      ts.add(p.at - 1);
    }
  }
  return [...ts].sort((a, b) => a - b).map((t) => bandAt(t, i));
}

export type CandlePlace =
  /** the whole hour lies inside the closure: the band applies */
  | "closed"
  /** the hour straddles the close or the open */
  | "edge"
  /** regular session: the feed passes the price through */
  | "open";

export interface JudgedCandle extends Candle {
  place: CandlePlace;
  /** the band at the end of the hour (its widest point within the hour); null outside the closure */
  band: BandPoint | null;
  /** the hour traded above the band's upper edge or below its lower edge */
  outside: boolean;
  /** how far past the edge the hour's extreme went, in bps of the edge (0 when inside) */
  excessBps: number;
  /** the hour closed outside the band */
  closedOutside: boolean;
}

export function placeOf(k: Pick<Candle, "t">, closure: Pick<Closure, "closedAt" | "opensAt">): CandlePlace {
  const end = k.t + HOUR;
  if (k.t >= closure.closedAt && end <= closure.opensAt) return "closed";
  return end <= closure.closedAt || k.t >= closure.opensAt ? "open" : "edge";
}

const unjudged = (k: Candle, place: CandlePlace, band: BandPoint | null = null): JudgedCandle => ({ ...k, place, band, outside: false, excessBps: 0, closedOutside: false });

/** Each candle against the band at the end of its hour. Only hours wholly inside the closure are judged. */
export function judgeCandles(candles: readonly Candle[], i: BandInputs): JudgedCandle[] {
  return candles.map((k): JudgedCandle => {
    const place = placeOf(k, i.closure);
    if (place !== "closed") return unjudged(k, place);
    const band = bandAt(k.t + HOUR, i);
    if (band.lo === null || band.hi === null) return unjudged(k, place, band);
    const over = k.h > band.hi ? (k.h / band.hi - 1) * 10_000 : 0;
    const under = k.l < band.lo ? (1 - k.l / band.lo) * 10_000 : 0;
    return { ...k, place, band, outside: over > 0 || under > 0, excessBps: Math.max(over, under), closedOutside: k.c > band.hi || k.c < band.lo };
  });
}

export interface ClosureChart extends Closure {
  /** the ticker's p99 gap for this kind of closure, bps */
  baseBps: number;
  /** band at the open (or now, for a closure in progress), bps */
  endBps: number;
  candles: JudgedCandle[];
  band: BandPoint[];
  /** reference prints from the close's anchor onward */
  prints: RefPrint[];
  /** hours judged against the band */
  judged: number;
  outside: number;
  closedOutside: number;
  /** why there is no band to draw, when there is none */
  bandNote?: string;
}

export type CandlesBody =
  | {
      status: "ok";
      symbol: string;
      token: string;
      fetchedAt: number;
      /** "market-api": keyed Binance Web3 Market API candles; "public-klines": Binance's keyless RWA klines */
      source: "market-api" | "public-klines";
      sourceNote?: string;
      /** shares per bStock token used for the anchor; null when it could not be read */
      multiplier: number | null;
      /** SessionOracle maxRefAge used, seconds */
      maxRefAgeSec: number;
      /** "chainlink": the on-chain feed's round history; "none": no reference could be read */
      referenceSource: "chainlink" | "none";
      referenceNote?: string;
      /** the chain half of the answer failed: shown as it is, and read again within seconds */
      partial?: boolean;
      closures: ClosureChart[];
    }
  | { status: "not-configured"; detail: string }
  | { status: "unavailable"; detail: string };

/** Padding around a closure that the chart shows for context, seconds. */
export const CONTEXT_SEC = 3 * HOUR;

/** Assembles one closure's chart from candles and reference prints. */
export function closureChart(closure: Closure, baseBps: number, candles: readonly Candle[], prints: readonly RefPrint[], multiplier: number | null, maxRefAgeSec: number, now: number): ClosureChart {
  const end = closure.inProgress ? Math.min(now, closure.opensAt) : closure.opensAt;
  const inView = candles.filter((k) => k.t + HOUR > closure.closedAt - CONTEXT_SEC && k.t < closure.opensAt + CONTEXT_SEC);
  const anchor = printAt(prints, closure.closedAt);
  const used = prints.filter((p) => (anchor ? p.at >= anchor.at : p.at >= closure.closedAt) && p.at <= closure.opensAt).sort((a, b) => a.at - b.at);
  const endBps = bandBps(baseBps, end - closure.closedAt);
  if (multiplier === null || used.length === 0 || baseBps <= 0) {
    const bandNote =
      baseBps <= 0
        ? "No gap is configured for this ticker and window, so the feed passes the price through."
        : multiplier === null
          ? "The token's share multiplier could not be read, so the band cannot be anchored."
          : "No reference print reaches back to this close, so the band cannot be anchored.";
    return {
      ...closure,
      baseBps,
      endBps,
      candles: inView.map((k) => unjudged(k, placeOf(k, closure))),
      band: [],
      prints: used,
      judged: 0,
      outside: 0,
      closedOutside: 0,
      bandNote,
    };
  }
  const inputs: BandInputs = { closure, baseBps, prints: used, multiplier, maxRefAgeSec };
  const judged = judgeCandles(inView, inputs);
  const band = bandSeries(inputs);
  const inside = judged.filter((k) => k.place === "closed" && k.band !== null && k.band.lo !== null);
  const noAnchor = band.every((p) => p.anchor === null);
  return {
    ...closure,
    baseBps,
    endBps,
    candles: judged,
    band,
    prints: used,
    judged: inside.length,
    outside: inside.filter((k) => k.outside).length,
    closedOutside: inside.filter((k) => k.closedOutside).length,
    ...(noAnchor
      ? { bandNote: "The last reference print before this close is older than the oracle accepts, so the feed passes the price through." }
      : anchor === null
        ? { bandNote: "The reference history read on chain does not reach back to this close: the band is drawn from the first print it has." }
        : {}),
  };
}
