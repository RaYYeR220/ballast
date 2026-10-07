/* Session sectors and the "now" marker, read from the NYSE calendar in @ballast/risk
   (the same calendar the contracts enforce), so holidays, early closes and DST land where the chain puts them. */
import { localDay, session, utcOffset, weekday, type Session } from "@ballast/risk";
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
    const s = session(localToUtc(monday + Math.floor(q / 96), (q % 96) * STEP));
    if (s === "UNKNOWN") {
      return ts === TYPICAL_WEEK_TS ? { sectors: [], source: "typical", monday } : { ...weekSectors(TYPICAL_WEEK_TS), source: "typical" };
    }
    const kind = KIND[s];
    const h = (q * STEP) / 3600;
    const last = sectors[sectors.length - 1];
    if (last && last.kind === kind) last.h1 = h + STEP / 3600;
    else sectors.push({ h0: h, h1: h + STEP / 3600, kind });
  }
  return { sectors, source: "calendar", monday };
}

export const typicalWeekSectors = (): Sector[] => weekSectors(TYPICAL_WEEK_TS).sectors;

/** Sectors for the week starting on a Monday (local day number), read at its noon. */
export const sectorsOfWeek = (monday: number): Sector[] => weekSectors(localToUtc(monday, 12 * 3600)).sectors;

/** Session kind at an hour of the week, read from a sector list. */
export function kindAt(sectors: readonly Sector[], h: number): SectorKind {
  const w = wrapHour(h);
  for (const s of sectors) if (w >= s.h0 && w < s.h1) return s.kind;
  return "weekend";
}

const STATE: Record<SectorKind, string> = {
  regular: "market open",
  pre: "pre-market",
  post: "after hours",
  overnight: "overnight, closed",
  weekend: "weekend, closed",
  holiday: "holiday, closed",
};

/** "Tuesday 07:35 New York, pre-market" */
export const meridianReadout = (sectors: readonly Sector[], h: number) =>
  `${hourLabel(h)} New York, ${STATE[kindAt(sectors, h)]}`;

/** The regular sessions of a week: drawn as faint daylight with the first 90 minutes dashed. */
export const regularSectors = (sectors: readonly Sector[]) => sectors.filter((s) => s.kind === "regular");
