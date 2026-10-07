// Solidity enums as TypeScript names. Order must match the contracts (pinned by test/enums.test.ts).

/** SessionOracle.Reason */
export const REASONS = [
  "OK",
  "UNKNOWN_TICKER",
  "CALENDAR_UNKNOWN",
  "NOT_REGULAR",
  "TOO_SOON_AFTER_OPEN",
  "OVERLAY_STALE",
  "FLAGGED",
  "PRICE_UNAVAILABLE",
  "REFERENCE_STALE",
  "NOT_CONVERGED",
  "WINDOW_AHEAD",
] as const;
export type ReasonName = (typeof REASONS)[number];

/** SessionOracle.Reason as a name -> code map. */
export const Reason = {
  OK: 0,
  UNKNOWN_TICKER: 1,
  CALENDAR_UNKNOWN: 2,
  NOT_REGULAR: 3,
  TOO_SOON_AFTER_OPEN: 4,
  OVERLAY_STALE: 5,
  FLAGGED: 6,
  PRICE_UNAVAILABLE: 7,
  REFERENCE_STALE: 8,
  NOT_CONVERGED: 9,
  WINDOW_AHEAD: 10,
} as const satisfies Record<ReasonName, number>;

export const REASON_TEXT: Record<ReasonName, string> = {
  OK: "risk may be added",
  UNKNOWN_TICKER: "the symbol is not listed on the Session Oracle",
  CALENDAR_UNKNOWN: "the session calendar does not cover this time",
  NOT_REGULAR: "the US market is not in its regular session",
  TOO_SOON_AFTER_OPEN: "too soon after the regular open, prices are still settling",
  OVERLAY_STALE: "the publisher overlay has expired",
  FLAGGED: "the symbol is flagged (halt, corporate action, earnings or limited asset)",
  PRICE_UNAVAILABLE: "the on-chain price is unavailable",
  REFERENCE_STALE: "the reference price is missing or too old",
  NOT_CONVERGED: "the on-chain price has not converged to the reference",
  WINDOW_AHEAD: "a market closure starts within the oracle horizon",
};

/** SessionOracle.RiskWindow */
export const RISK_WINDOWS = ["NONE", "OVERNIGHT", "WEEKEND", "HOLIDAY", "EARNINGS"] as const;
export type RiskWindowName = (typeof RISK_WINDOWS)[number];

/** SessionCalendar.Session */
export const SESSIONS = ["UNKNOWN", "CLOSED_WEEKEND", "CLOSED_HOLIDAY", "OVERNIGHT", "PRE", "REGULAR", "POST"] as const;
export type SessionName = (typeof SESSIONS)[number];

/** SessionCalendar.WindowType */
export const WINDOW_TYPES = ["NONE", "OVERNIGHT", "WEEKEND", "HOLIDAY"] as const;
export type WindowTypeName = (typeof WINDOW_TYPES)[number];

/** IACP.JobStatus (ERC-8183 kernel) */
export const JOB_STATUSES = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"] as const;
export type JobStatusName = (typeof JOB_STATUSES)[number];

/** SessionOracle.Issuer */
export const ISSUERS = ["BSTOCK", "ONDO", "XSTOCK"] as const;
export type IssuerName = (typeof ISSUERS)[number];

/** SessionOracle overlay flag bits. */
export const OVERLAY_FLAGS = { HALTED: 1, CORPORATE_ACTION: 2, EARNINGS_WINDOW: 4, ASSET_LIMITED: 8 } as const;
export type OverlayFlagName = keyof typeof OVERLAY_FLAGS;

/** Venue ids used by BallastFactory and CushionVault. */
export const VENUES = { lista: 1, venus: 2 } as const;
export type Venue = keyof typeof VENUES;

function enumName<T extends readonly string[]>(names: T, value: number | bigint, what: string): T[number] {
  const name = names[Number(value)];
  if (name === undefined) throw new RangeError(`unknown ${what} value ${value}`);
  return name;
}

export const reasonName = (v: number | bigint): ReasonName => enumName(REASONS, v, "Reason");
export const riskWindowName = (v: number | bigint): RiskWindowName => enumName(RISK_WINDOWS, v, "RiskWindow");
export const sessionName = (v: number | bigint): SessionName => enumName(SESSIONS, v, "Session");
export const windowTypeName = (v: number | bigint): WindowTypeName => enumName(WINDOW_TYPES, v, "WindowType");
export const jobStatusName = (v: number | bigint): JobStatusName => enumName(JOB_STATUSES, v, "JobStatus");

export function venueName(v: number | bigint): Venue {
  if (Number(v) === VENUES.lista) return "lista";
  if (Number(v) === VENUES.venus) return "venus";
  throw new RangeError(`unknown venue ${v}`);
}

export function flagNames(flags: number): OverlayFlagName[] {
  return (Object.keys(OVERLAY_FLAGS) as OverlayFlagName[]).filter((k) => (flags & OVERLAY_FLAGS[k]) !== 0);
}
