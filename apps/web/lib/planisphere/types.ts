/** organic = a real borrower; seed = the tripwire test address; loan = the one market where a bStock was the loan asset */
export type LiquidationGroup = "organic" | "seed" | "loan";

/** One Lista (Moolah) Liquidate event as stored in data/liquidations-week.json. */
export interface LiquidationRow {
  /** hour of the week in New York time, Monday 00:00 = 0 */
  h: number;
  /** repaid amount in USD */
  usd: number;
  /** session label at the time of the event */
  s: "regular" | "pre" | "post" | "overnight" | "holiday" | "weekend";
  g: LiquidationGroup;
  /** collateral symbol */
  c: string;
  tx: `0x${string}`;
  /** timestamp as written in New York, e.g. "Thu 2026-06-18 10:41 ET" */
  et: string;
  /** timing class from the source, e.g. "regular: first 90 min"; empty for seed rows */
  t: string;
}

/** A row with the fields the page reads, derived once in lib/liquidations.ts. */
export interface Liquidation extends LiquidationRow {
  /** organic row repaid in the first 90 minutes after a regular open */
  first90: boolean;
  /** ... after an open that followed a weekend or a holiday */
  afterLongClose: boolean;
  /** the NYSE holiday the event fell on, or on the eve of, read from the calendar */
  holiday: string | null;
}

export type SectorKind = "regular" | "pre" | "post" | "overnight" | "weekend" | "holiday";

/** A run of one session kind on the week, in hours since Monday 00:00 New York. */
export interface Sector {
  h0: number;
  h1: number;
  kind: SectorKind;
  /** for a holiday closure, the holiday's name */
  holiday?: string;
}

/** A closure window in unix seconds, e.g. the next close to the next open. */
export interface ClosureWindow {
  startsAt: number;
  endsAt: number;
}

/** What a turn of the dial reports: the hour under the meridian and that instant in the week shown. */
export interface ScrubPoint {
  hourOfWeek: number;
  ts: number;
}
