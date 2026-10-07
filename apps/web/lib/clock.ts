/* Clock figures on the landing page, read from the NYSE calendar in @ballast/risk. Server-side only:
   the sample window is walked quarter hour by quarter hour. */
import { clockShares, dayNumber, localToUtc, typicalWeekSectors, weekShare } from "./planisphere/sessions";

/** The sample window the page states: 18 June to 22 September 2026, whole New York days. */
export const SAMPLE = { from: localToUtc(dayNumber("2026-06-18"), 0), to: localToUtc(dayNumber("2026-09-23"), 0) } as const;

/** Share of the wall clock in each session group over the sample window. */
export const SAMPLE_CLOCK = clockShares(SAMPLE.from, SAMPLE.to);

const PLAIN_WEEK = typicalWeekSectors();

/** A plain week: how much of it New York's regular session is shut, and how much of it is the weekend. */
export const WEEK = {
  closedShare: 1 - weekShare(PLAIN_WEEK, ["regular"]),
  weekendShare: weekShare(PLAIN_WEEK, ["weekend"]),
};
