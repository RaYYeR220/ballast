import { calendarConfig as C } from "./config";

export type Session = "UNKNOWN" | "CLOSED_WEEKEND" | "CLOSED_HOLIDAY" | "OVERNIGHT" | "PRE" | "REGULAR" | "POST";
export type WindowType = "NONE" | "OVERNIGHT" | "WEEKEND" | "HOLIDAY";
type DayType = "TRADING" | "EARLY_CLOSE" | "HOLIDAY" | "WEEKEND";

const DAY = 86400;
const HOLIDAYS = new Set(C.holidayDays);
const EARLY = new Set(C.earlyCloseDays);
const S = C.secondsOfDay;
const SEARCH_DAYS = 10;

export const isDst = (ts: number) => C.dst.some(([a, b]) => ts >= a && ts < b);
export const utcOffset = (ts: number) => (isDst(ts) ? 4 * 3600 : 5 * 3600);
export function localDay(ts: number) {
  const local = ts - utcOffset(ts);
  return { day: Math.floor(local / DAY), secondOfDay: ((local % DAY) + DAY) % DAY };
}
export const weekday = (day: number) => (day + 4) % 7;

function dayType(day: number): DayType {
  const wd = weekday(day);
  if (wd === 0 || wd === 6) return "WEEKEND";
  if (HOLIDAYS.has(day)) return "HOLIDAY";
  if (EARLY.has(day)) return "EARLY_CLOSE";
  return "TRADING";
}
export const isTradingDay = (day: number) => {
  const t = dayType(day);
  return t === "TRADING" || t === "EARLY_CLOSE";
};
const inRange = (ts: number) => ts >= C.validFrom && ts < C.validThrough;

function evening(day: number): Session {
  if (isTradingDay(day + 1)) return "OVERNIGHT";
  return dayType(day + 1) === "WEEKEND" ? "CLOSED_WEEKEND" : "CLOSED_HOLIDAY";
}

export function session(ts: number): Session {
  if (!inRange(ts)) return "UNKNOWN";
  const { day, secondOfDay: s } = localDay(ts);
  const t = dayType(day);
  if (t === "TRADING" || t === "EARLY_CLOSE") {
    if (s < S.preOpen) return "OVERNIGHT";
    if (s < S.regularOpen) return "PRE";
    if (s < (t === "EARLY_CLOSE" ? S.earlyClose : S.regularClose)) return "REGULAR";
    if (s < S.postClose) return "POST";
    return evening(day);
  }
  if (s >= S.postClose && isTradingDay(day + 1)) return "OVERNIGHT";
  return t === "WEEKEND" ? "CLOSED_WEEKEND" : "CLOSED_HOLIDAY";
}

function toUtc(day: number, localSecond: number) {
  const guess = day * DAY + localSecond + 5 * 3600;
  return day * DAY + localSecond + utcOffset(guess);
}
export const regularOpenAt = (day: number) => toUtc(day, S.regularOpen);
export const regularCloseAt = (day: number) => toUtc(day, dayType(day) === "EARLY_CLOSE" ? S.earlyClose : S.regularClose);

export function nextOpen(ts: number): number {
  if (!inRange(ts)) return 0;
  const { day } = localDay(ts);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const d = day + i;
    if (!isTradingDay(d)) continue;
    const o = regularOpenAt(d);
    if (o > ts) return o < C.validThrough ? o : 0;
  }
  return 0;
}
export function nextClose(ts: number): number {
  if (!inRange(ts)) return 0;
  const { day } = localDay(ts);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const d = day + i;
    if (!isTradingDay(d)) continue;
    const c = regularCloseAt(d);
    if (c > ts) return c < C.validThrough ? c : 0;
  }
  return 0;
}
export function prevClose(ts: number): number {
  if (!inRange(ts)) return 0;
  const { day } = localDay(ts);
  for (let i = 0; i < SEARCH_DAYS && i <= day; i++) {
    const d = day - i;
    if (!isTradingDay(d)) continue;
    const c = regularCloseAt(d);
    if (c <= ts) return c >= C.validFrom ? c : 0;
  }
  return 0;
}
export function windowAfter(day: number): WindowType {
  if (!isTradingDay(day)) return "NONE";
  let holiday = false;
  let n = day + 1;
  for (let i = 0; i < SEARCH_DAYS && !isTradingDay(n); i++) {
    if (dayType(n) === "HOLIDAY") holiday = true;
    n++;
  }
  if (n === day + 1) return "OVERNIGHT";
  return holiday ? "HOLIDAY" : "WEEKEND";
}
export function nextWindow(ts: number): { type: WindowType; startsAt: number; endsAt: number } {
  const startsAt = nextClose(ts);
  if (!startsAt) return { type: "NONE", startsAt: 0, endsAt: 0 };
  const endsAt = nextOpen(startsAt);
  if (!endsAt) return { type: "NONE", startsAt: 0, endsAt: 0 };
  return { type: windowAfter(localDay(startsAt).day), startsAt, endsAt };
}
export function currentWindow(ts: number): { type: WindowType; closedAt: number; opensAt: number } {
  const s = session(ts);
  if (s === "UNKNOWN" || s === "REGULAR") return { type: "NONE", closedAt: 0, opensAt: 0 };
  const closedAt = prevClose(ts);
  const opensAt = nextOpen(ts);
  if (!closedAt || !opensAt) return { type: "NONE", closedAt: 0, opensAt: 0 };
  return { type: windowAfter(localDay(closedAt).day), closedAt, opensAt };
}
