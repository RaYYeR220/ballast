/* US market closures read from the NYSE calendar in @ballast/risk: the one in progress or just ended, and the
   last long one (a weekend or a holiday). A closure runs from a regular close to the next regular open, the
   same span SessionCalendar.currentWindow() reports on chain. Pure and client-safe. */
import { localDay, nextOpen, prevClose, session, windowAfter } from "@ballast/risk";

export type ClosureKind = "overnight" | "weekend" | "holiday";

export interface Closure {
  kind: ClosureKind;
  /** unix seconds of the regular close that starts it */
  closedAt: number;
  /** unix seconds of the regular open that ends it */
  opensAt: number;
  /** New York was still closed at the time the closure was read */
  inProgress: boolean;
}

const KIND = { OVERNIGHT: "overnight", WEEKEND: "weekend", HOLIDAY: "holiday" } as const;

function closureFrom(closedAt: number, now: number): Closure | null {
  if (!closedAt) return null;
  const opensAt = nextOpen(closedAt);
  const type = windowAfter(localDay(closedAt).day);
  if (!opensAt || type === "NONE") return null;
  return { kind: KIND[type], closedAt, opensAt, inProgress: now < opensAt };
}

/** The closure in progress at `now`, or the one that ended at the latest regular open. Null outside the calendar. */
export function latestClosure(now: number): Closure | null {
  if (session(now) === "UNKNOWN") return null;
  return closureFrom(prevClose(now), now);
}

/** The closure before `c`. */
export function closureBefore(c: Closure, now: number): Closure | null {
  return closureFrom(prevClose(c.closedAt - 1), now);
}

/** How far back the search for the last weekend or holiday closure goes (closures, not days). */
const LOOKBACK = 8;

/**
 * The closures the explorer charts: the latest one, and the last weekend or holiday closure when the latest
 * is an ordinary night. At most two entries, newest first.
 */
export function recentClosures(now: number): Closure[] {
  const latest = latestClosure(now);
  if (!latest) return [];
  if (latest.kind !== "overnight") return [latest];
  let c: Closure | null = latest;
  for (let i = 0; i < LOOKBACK && c; i++) {
    c = closureBefore(c, now);
    if (c && c.kind !== "overnight") return [latest, c];
  }
  return [latest];
}

export const closureHours = (c: Closure) => (c.opensAt - c.closedAt) / 3600;

export const CLOSURE_NAME: Record<ClosureKind, string> = { overnight: "overnight", weekend: "weekend", holiday: "holiday" };
