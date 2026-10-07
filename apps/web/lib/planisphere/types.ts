/** organic = a real borrower; seed = the tripwire test address; loan = the one market where a bStock was the loan asset */
export type LiquidationGroup = "organic" | "seed" | "loan";

/** One Lista (Moolah) Liquidate event, placed on the New York week. */
export interface Liquidation {
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
  /** timing class, e.g. "regular: first 90 min"; empty for seed rows */
  t: string;
}

export type SectorKind = "regular" | "pre" | "post" | "overnight" | "weekend" | "holiday";

/** A run of one session kind on the week, in hours since Monday 00:00 New York. */
export interface Sector {
  h0: number;
  h1: number;
  kind: SectorKind;
}

/** A closure window in unix seconds, e.g. the next close to the next open. */
export interface ClosureWindow {
  startsAt: number;
  endsAt: number;
}
