/* Session sectors and the "now" marker, read from the NYSE calendar in @ballast/risk
   (the same calendar the contracts enforce), so holidays, early closes and DST land where the chain puts them. */
import { calendarConfig, localDay, session, utcOffset, weekday, type Session } from "@ballast/risk";
import { hourLabel, WEEK_HOURS, wrapHour } from "./geometry";
import type { Sector, SectorKind } from "./types";

const DAY = 86_400;
const STEP = 900; // the calendar changes state only on quarter hours
const STEPS_PER_WEEK = (WEEK_HOURS * 3600) / STEP;

const KIND: Record<Exclude<Session, "UNKNOWN">, SectorKind> = {
  REGULAR: "regular",
  PRE: "pre",
  POST: "post",
  OVERNIGHT: "overnight",
  CLOSED_WEEKEND: "weekend",
  CLOSED_HOLIDAY: "holiday",
};

/** A plain week (no holiday, no early close): Monday 14 September 2026, 12:00 New York. */
export const TYPICAL_WEEK_TS = 1789401600;

const HOLIDAY_DAYS = new Set(calendarConfig.holidayDays);

/** The NYSE holiday on a New York local day number, named by the exchange's holiday rules;
    null when the calendar has no holiday that day. */
export function holidayName(day: number): string | null {
  if (!HOLIDAY_DAYS.has(day)) return null;
  const d = new Date(day * DAY * 1000);
  const date = d.getUTCDate();
  switch (d.getUTCMonth() + 1) {
    case 1:
      return date <= 2 ? "New Year's Day" : "Martin Luther King Jr. Day";
    case 2:
      return "Washington's Birthday";
    case 3:
    case 4:
      return "Good Friday";
    case 5:
      return "Memorial Day";
    case 6:
      return "Juneteenth";
    case 7:
      return "Independence Day";
    case 9:
      return "Labor Day";
    case 11:
      return "Thanksgiving";
    case 12:
      return date >= 30 ? "New Year's Day" : "Christmas";
    default:
      return "Holiday";
  }
}

/** The holiday a closed-for-holiday instant belongs to: that day, or the next one (the evening before). */
export const holidayFor = (day: number): string | null => holidayName(day) ?? holidayName(day + 1);

/** New York local day number for a "YYYY-MM-DD" date. */
export const dayNumber = (isoDate: string) => Math.round(Date.parse(`${isoDate}T00:00:00Z`) / (DAY * 1000));

/** UTC unix seconds for a New York local day number and second of that day. */
export function localToUtc(day: number, second: number): number {
  const guess = day * DAY + second + 5 * 3600;
  return day * DAY + second + utcOffset(guess);
}

/** New York local day number of the Monday that starts the week containing ts. */
export function mondayOf(ts: number): number {
  const { day } = localDay(ts);
  return day - ((weekday(day) + 6) % 7);
}

/** Intl fallback for instants the bundled calendar does not cover (before 2026, after 2027). */
function hourOfWeekIntl(ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(ts * 1000));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "0";
  const d = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return d * 24 + (Number(get("hour")) % 24) + Number(get("minute")) / 60 + Number(get("second")) / 3600;
}

/** Hour of the New York week for a unix timestamp: Monday 00:00 = 0, Sunday 23:59 = 167.98. */
export function hourOfWeek(ts: number): number {
  if (session(ts) === "UNKNOWN") return hourOfWeekIntl(ts);
  const { day, secondOfDay } = localDay(ts);
  return ((weekday(day) + 6) % 7) * 24 + secondOfDay / 3600;
}

/** Unix seconds of an hour of the week, in the week that starts on `monday` (local day number). */
export function tsOfHour(monday: number, h: number): number {
  const w = wrapHour(h);
  const d = Math.floor(w / 24);
  return localToUtc(monday + d, Math.round((w - d * 24) * 3600));
}

export interface WeekSectors {
  sectors: Sector[];
  /** "calendar" = the actual week containing ts; "typical" = fallback outside the calendar's range */
  source: "calendar" | "typical";
  /** local day number of the Monday */
  monday: number;
}

/** Session sectors for the New York week that contains ts, merged into runs of one kind. */
export function weekSectors(ts: number): WeekSectors {
  const monday = mondayOf(ts);
  const sectors: Sector[] = [];
  for (let q = 0; q < STEPS_PER_WEEK; q++) {
    const day = monday + Math.floor(q / 96);
    const s = session(localToUtc(day, (q % 96) * STEP));
    if (s === "UNKNOWN") {
      return ts === TYPICAL_WEEK_TS ? { sectors: [], source: "typical", monday } : { ...weekSectors(TYPICAL_WEEK_TS), source: "typical" };
    }
    const kind = KIND[s];
    const holiday = kind === "holiday" ? (holidayFor(day) ?? undefined) : undefined;
    const h = (q * STEP) / 3600;
    const last = sectors[sectors.length - 1];
    if (last && last.kind === kind && last.holiday === holiday) last.h1 = h + STEP / 3600;
    else sectors.push(holiday ? { h0: h, h1: h + STEP / 3600, kind, holiday } : { h0: h, h1: h + STEP / 3600, kind });
  }
  return { sectors, source: "calendar", monday };
}

export const typicalWeekSectors = (): Sector[] => weekSectors(TYPICAL_WEEK_TS).sectors;

/** Sectors for the week starting on a Monday (local day number), read at its noon. */
export const sectorsOfWeek = (monday: number): Sector[] => weekSectors(localToUtc(monday, 12 * 3600)).sectors;

/** The sector under an hour of the week. */
export function sectorAt(sectors: readonly Sector[], h: number): Sector | undefined {
  const w = wrapHour(h);
  return sectors.find((s) => w >= s.h0 && w < s.h1);
}

/** Session kind at an hour of the week, read from a sector list. */
export const kindAt = (sectors: readonly Sector[], h: number): SectorKind => sectorAt(sectors, h)?.kind ?? "weekend";

const STATE: Record<SectorKind, string> = {
  regular: "market open",
  pre: "pre-market",
  post: "after hours",
  overnight: "overnight, closed",
  weekend: "weekend, closed",
  holiday: "holiday, closed",
};

/** "Tuesday 07:35 New York, pre-market"; a holiday is named: "Thursday 12:00 New York, Thanksgiving, closed" */
export function meridianReadout(sectors: readonly Sector[], h: number): string {
  const s = sectorAt(sectors, h);
  const state = s?.holiday ? `${s.holiday}, closed` : STATE[s?.kind ?? "weekend"];
  return `${hourLabel(h)} New York, ${state}`;
}

/** The regular sessions of a week: drawn as faint daylight with the first 90 minutes dashed. */
export const regularSectors = (sectors: readonly Sector[]) => sectors.filter((s) => s.kind === "regular");

/** Share of a week that falls in the given kinds of sector (hours / 168). */
export function weekShare(sectors: readonly Sector[], kinds: readonly SectorKind[]): number {
  return sectors.filter((s) => kinds.includes(s.kind)).reduce((a, s) => a + (s.h1 - s.h0), 0) / WEEK_HOURS;
}

/** The session groups of the clock-vs-money chart. */
export type ShareKind = "regular" | "prePost" | "overnight" | "holiday" | "weekend";
export const SHARE_OF: Record<SectorKind, ShareKind> = {
  regular: "regular",
  pre: "prePost",
  post: "prePost",
  overnight: "overnight",
  holiday: "holiday",
  weekend: "weekend",
};

/** Share of wall-clock time in each session group between two instants, read from the calendar every quarter hour. */
export function clockShares(fromTs: number, toTs: number): Record<ShareKind, number> {
  const out: Record<ShareKind, number> = { regular: 0, prePost: 0, overnight: 0, holiday: 0, weekend: 0 };
  let n = 0;
  for (let t = fromTs; t < toTs; t += STEP) {
    const s = session(t);
    if (s === "UNKNOWN") throw new Error(`the calendar does not cover ${t}`);
    out[SHARE_OF[KIND[s]]]++;
    n++;
  }
  for (const k of Object.keys(out) as ShareKind[]) out[k] = n ? out[k] / n : 0;
  return out;
}
