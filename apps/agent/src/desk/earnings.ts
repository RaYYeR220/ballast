// Earnings dates for the publisher's nextEarnings. When X402_EARNINGS_URL is set the desk buys the next dates
// once per trading day from that x402 data endpoint and keeps them in <dataDir>/earnings-paid.json (same
// format as the operator file). The publisher sees both sources merged per symbol, so the earliest upcoming
// date of either wins (shielding a day early costs little; missing an earnings gap does not). With the
// purchase off, failed or stale, the operator file (config/earnings.json) is used alone.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isTradingDay, localDay, tickers } from "@ballast/risk";
import type { Feed } from "./feed";
import { loadEarnings, parseEarnings, type EarningsSchedule } from "./publisher";
import { safeMessage } from "./tx";
import { X402Error, resourceLabel, type X402Client } from "./x402";

export const EARNINGS_CHECK_SEC = 3600;
/** How far ahead each purchase looks. */
export const HORIZON_DAYS = 120;
const MAX_DATES_PER_SYMBOL = 4;

export interface PaidEarningsFile {
  version: 1;
  /** New York trading day of the last run (YYYY-MM-DD). */
  fetchedOn: string;
  /** Symbols done that day (bought, or paid for and failed): never paid twice in a day. */
  done: string[];
  source: string;
  earnings: Record<string, { date: string; timing: "bmo" | "amc" }[]>;
}

const DAY = 86_400;
const iso = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);

/** Symbols worth a purchase: listed tickers that have an earnings gap configured (ETFs have none). */
export function earningsSymbols(): string[] {
  return tickers.filter((t) => t.gapBps.earnings > 0).map((t) => t.symbol);
}

/** Fills {symbol}, {from} and {to} in the template, or appends ticker/from/to query parameters. */
export function earningsUrl(template: string, symbol: string, from: string, to: string): string {
  if (/\{symbol\}/.test(template)) {
    return template.replace(/\{symbol\}/g, encodeURIComponent(symbol)).replace(/\{from\}/g, from).replace(/\{to\}/g, to);
  }
  const u = new URL(template);
  u.searchParams.set("ticker", symbol);
  u.searchParams.set("from", from);
  u.searchParams.set("to", to);
  return u.toString();
}

/**
 * The next dates for `symbol` from an earnings-calendar response: `{ items: [...] }`, `{ earningsCalendar: [...] }`
 * (Finnhub), `{ earnings: [...] }` or a bare list, each `{ date: "YYYY-MM-DD", symbol?, hour? }`. hour "bmo"
 * stays before the open; "amc" and anything unknown count as after the close; "dmh" (during market hours)
 * counts as before the open, so the closure ahead of that session is the one shielded.
 */
export function parseEarningsResponse(body: unknown, symbol: string, fromDate: string): { date: string; timing: "bmo" | "amc" }[] {
  const b = body as Record<string, unknown> | unknown[] | null;
  const list = Array.isArray(b) ? b : b && typeof b === "object" ? (b.items ?? b.earningsCalendar ?? b.earnings ?? b.data) : null;
  if (!Array.isArray(list)) throw new Error("earnings response has no list of dates");
  const seen = new Map<string, "bmo" | "amc">();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { date?: unknown; symbol?: unknown; hour?: unknown };
    if (typeof e.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || Number.isNaN(Date.parse(`${e.date}T00:00:00Z`))) continue;
    if (typeof e.symbol === "string" && e.symbol.toUpperCase() !== symbol.toUpperCase()) continue;
    if (e.date < fromDate) continue;
    const hour = typeof e.hour === "string" ? e.hour.trim().toLowerCase() : "";
    seen.set(e.date, hour === "bmo" || hour === "dmh" ? "bmo" : "amc");
  }
  return [...seen.entries()]
    .sort(([a], [b2]) => a.localeCompare(b2))
    .slice(0, MAX_DATES_PER_SYMBOL)
    .map(([date, timing]) => ({ date, timing }));
}

async function readPaid(file: string): Promise<PaidEarningsFile | null> {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as PaidEarningsFile;
    if (j && j.version === 1 && typeof j.earnings === "object") return { ...j, done: Array.isArray(j.done) ? j.done : [] };
  } catch {
    // missing or unreadable: no purchase on record
  }
  return null;
}

/** A purchase older than this is not trusted any more: the operator file takes over. */
export const PAID_MAX_AGE_DAYS = 7;

/**
 * The schedule the publisher uses: per symbol, the operator's dates and the purchased ones (when the purchase
 * is at most PAID_MAX_AGE_DAYS old) merged and sorted, so the earliest upcoming date of either source is the
 * one posted. A broken operator file throws (the publisher keeps its last good schedule); a broken or stale
 * purchase is ignored.
 */
export function mergedEarnings(operatorFile: string, paidFile: string | null, clock: () => number = () => Math.floor(Date.now() / 1000)): () => Promise<EarningsSchedule> {
  return async () => {
    const operator = await loadEarnings(operatorFile);
    if (!paidFile) return operator;
    const paid = await readPaid(paidFile);
    if (!paid || !/^\d{4}-\d{2}-\d{2}$/.test(paid.fetchedOn)) return operator;
    const ageDays = (clock() - Date.parse(`${paid.fetchedOn}T00:00:00Z`) / 1000) / DAY;
    if (!(ageDays <= PAID_MAX_AGE_DAYS + 1)) return operator;
    let bought: EarningsSchedule;
    try {
      bought = parseEarnings({ earnings: paid.earnings });
    } catch {
      return operator;
    }
    const out = new Map<string, readonly number[]>(operator);
    for (const [sym, list] of bought) {
      if (list.length === 0) continue;
      out.set(sym, [...new Set([...(operator.get(sym) ?? []), ...list])].sort((a, b) => a - b));
    }
    return out;
  };
}

export interface EarningsBuyerOptions {
  client: Pick<X402Client, "get">;
  urlTemplate: string;
  file: string;
  feed: Feed;
  symbols?: () => string[];
  /** Unix seconds (wall clock). */
  clock?: () => number;
  log?: (line: string) => void;
}

export interface EarningsRunReport {
  ran: boolean;
  bought: string[];
  failed: Record<string, string>;
  spentUsd: number;
}

export class EarningsBuyer {
  readonly #o: EarningsBuyerOptions;
  #dryRunNoted = "";

  constructor(o: EarningsBuyerOptions) {
    this.#o = o;
  }

  /** Buys once per New York trading day; later calls that day only retry symbols that never got as far as a payment. */
  async tick(): Promise<EarningsRunReport> {
    const now = (this.#o.clock ?? (() => Math.floor(Date.now() / 1000)))();
    const { day } = localDay(now);
    const report: EarningsRunReport = { ran: false, bought: [], failed: {}, spentUsd: 0 };
    if (!isTradingDay(day)) return report;
    const today = iso(day);
    const prev = await readPaid(this.#o.file);
    const state: PaidEarningsFile =
      prev && prev.fetchedOn === today
        ? prev
        : { version: 1, fetchedOn: today, done: [], source: resourceLabel(this.#o.urlTemplate.replace(/\{(symbol|from|to)\}/g, "x")), earnings: prev?.earnings ?? {} };
    const symbols = (this.#o.symbols ?? earningsSymbols)().filter((s) => !state.done.includes(s));
    if (symbols.length === 0) return report;
    report.ran = true;
    const to = iso(day + HORIZON_DAYS);
    for (const sym of symbols) {
      const url = earningsUrl(this.#o.urlTemplate, sym, today, to);
      try {
        const r = await this.#o.client.get(url);
        // Paid: this symbol is done for the day whatever the answer turns out to be (never pay twice).
        if (r.payment) {
          report.spentUsd += r.payment.usd;
          state.done.push(sym);
        }
        const dates = parseEarningsResponse(r.body, sym, today);
        state.earnings[sym] = dates;
        if (!r.payment) state.done.push(sym);
        report.bought.push(sym);
        await this.#o.feed.record({
          kind: "payment",
          source: "x402",
          symbol: sym,
          reason: `earnings dates bought: ${dates.map((d) => `${d.date} ${d.timing}`).join(", ") || "none in the next 120 days"}`,
          data: {
            resource: resourceLabel(url),
            usd: r.payment?.usd ?? 0,
            network: r.payment?.network ?? null,
            asset: r.payment?.symbol ?? null,
            settlementTx: r.payment?.txHash ?? null,
          },
        });
      } catch (err) {
        const e = err instanceof X402Error ? err : null;
        report.failed[sym] = safeMessage(err);
        if (e?.code === "dry-run") {
          // One line per day is enough to show what the run would cost.
          if (this.#dryRunNoted !== today) {
            this.#dryRunNoted = today;
            await this.#o.feed.record({ kind: "finding", source: "x402", symbol: sym, reason: e.message, data: { resource: resourceLabel(url), ...(e.route ?? {}) } });
          }
          break;
        }
        if (e?.code === "cap" || e?.code === "price") {
          await this.#o.feed.record({ kind: "refused", source: "x402", symbol: sym, reason: e.message, data: { resource: resourceLabel(url), ...(e.route ?? {}) } });
          state.done.push(...symbols.filter((s) => !state.done.includes(s))); // nothing more today
          break;
        }
        // Paid but failed: never pay again today for this symbol. Before any payment: retried next run.
        if (e?.code === "paid-failed") state.done.push(sym);
        await this.#o.feed.record({
          kind: "finding",
          source: "x402",
          symbol: sym,
          reason: `earnings purchase failed, keeping the previous dates: ${safeMessage(err)}`,
          data: { resource: resourceLabel(url), code: e?.code ?? "error" },
        });
      }
    }
    await this.#write(state);
    this.#o.log?.(`earnings: bought ${report.bought.join(",") || "nothing"} for $${report.spentUsd.toFixed(4)}`);
    return report;
  }

  async #write(state: PaidEarningsFile) {
    await mkdir(path.dirname(this.#o.file), { recursive: true });
    await writeFile(`${this.#o.file}.tmp`, `${JSON.stringify(state, null, 1)}\n`, "utf8");
    await rename(`${this.#o.file}.tmp`, this.#o.file);
  }
}
