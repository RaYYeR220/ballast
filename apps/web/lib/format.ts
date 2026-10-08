/* Number, time and hash formatting for the app. Every time is New York time. */
import { formatUnits } from "viem";

const NY = "America/New_York";

/** token units -> "9,170" or "1,234.56" (at most `frac` fraction digits, trailing zeros dropped) */
export function units(raw: bigint | string, decimals: number, frac = 2): string {
  const n = Number(formatUnits(typeof raw === "string" ? BigInt(raw) : raw, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: frac });
}

export const usd = (x: number, frac = 0) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;

/** basis points -> "41.0%" */
export const pctBps = (bps: number, digits = 1) => `${(bps / 100).toFixed(digits)}%`;

/** "0x51c2...a09f" */
export function shortHex(h: string, head = 4, tail = 4): string {
  if (h.length <= 2 + head + tail + 3) return h;
  return `${h.slice(0, 2 + head)}...${h.slice(-tail)}`;
}

const dayTime = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDay = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "long" });
const clock12 = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit", hour12: true });
const dayDate = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", day: "numeric", month: "short" });

const part = (f: Intl.DateTimeFormat, ts: number, type: Intl.DateTimeFormatPartTypes) =>
  f.formatToParts(new Date(ts * 1000)).find((p) => p.type === type)?.value ?? "";

/** "Mon 15:31" in New York */
export function nyDayTime(ts: number): string {
  return `${part(dayTime, ts, "weekday")} ${part(dayTime, ts, "hour")}:${part(dayTime, ts, "minute")}`;
}

/** "Tuesday 4:00 PM" in New York */
export function nyWeekdayClock(ts: number): string {
  return `${longDay.format(new Date(ts * 1000))} ${clock12.format(new Date(ts * 1000))}`;
}

/** "Mon 12 Oct" in New York */
export const nyDate = (ts: number) => dayDate.format(new Date(ts * 1000)).replace(",", "");

/** "8 h 24 min", "24 min", "2 d 3 h" */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m} min`;
}

/** "a few seconds ago" style age for a unix time */
export function age(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}
