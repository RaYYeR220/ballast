import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nextOpen, regularCloseAt } from "@ballast/risk";
import { EarningsBuyer, earningsSymbols, earningsUrl, mergedEarnings, parseEarningsResponse } from "../src/desk/earnings";
import { Feed } from "../src/desk/feed";
import { nextEarningsFor } from "../src/desk/publisher";
import { X402Error, type X402Response } from "../src/desk/x402";

const DAY = 86_400;
const WED = Date.UTC(2026, 9, 7) / 1000 / DAY; // 2026-10-07, a trading day
const NOON_WED = WED * DAY + 16 * 3600;
const SAT = NOON_WED + 3 * DAY;

const tmp = () => mkdtemp(path.join(tmpdir(), "desk-earnings-"));

describe("earnings helpers", () => {
  it("buys only for tickers with an earnings gap", () => {
    const s = earningsSymbols();
    expect(s).toContain("NVDA");
    expect(s).not.toContain("SPY");
    expect(s).not.toContain("QQQ");
  });

  it("fills a URL template or appends the query", () => {
    expect(earningsUrl("https://d.example/e/{symbol}?from={from}&to={to}", "NVDA", "2026-10-07", "2027-02-04")).toBe("https://d.example/e/NVDA?from=2026-10-07&to=2027-02-04");
    expect(earningsUrl("https://2s.io/api/calendar/earnings", "TSLA", "2026-10-07", "2027-02-04")).toBe(
      "https://2s.io/api/calendar/earnings?ticker=TSLA&from=2026-10-07&to=2027-02-04",
    );
  });

  it("parses calendar responses into dated bmo/amc entries for the symbol", () => {
    const body = {
      items: [
        { date: "2026-11-18", symbol: "NVDA", hour: "amc" },
        { date: "2026-10-01", symbol: "NVDA", hour: "amc" },
        { date: "2026-11-19", symbol: "AAPL", hour: "bmo" },
        { date: "2027-02-25", symbol: "NVDA", hour: "dmh" },
        { date: "2027-05-27", symbol: "NVDA", hour: "" },
        { date: "bad", symbol: "NVDA" },
      ],
    };
    expect(parseEarningsResponse(body, "NVDA", "2026-10-07")).toEqual([
      { date: "2026-11-18", timing: "amc" },
      { date: "2027-02-25", timing: "bmo" },
      { date: "2027-05-27", timing: "amc" },
    ]);
    expect(parseEarningsResponse({ earningsCalendar: [{ date: "2026-10-22", symbol: "TSLA", hour: "bmo" }] }, "TSLA", "2026-10-07")).toEqual([{ date: "2026-10-22", timing: "bmo" }]);
    expect(() => parseEarningsResponse({ nope: 1 }, "NVDA", "2026-10-07")).toThrow(/no list/);
  });

  it("merges the purchase with the operator file per symbol so the earliest upcoming date wins", async () => {
    const dir = await tmp();
    const op = path.join(dir, "earnings.json");
    const paid = path.join(dir, "earnings-paid.json");
    const at = (y: number, m: number, d: number) => nextOpen(regularCloseAt(Date.UTC(y, m - 1, d) / 1000 / DAY));
    // NVDA: the operator's estimate is a day late; TSLA: the purchase is the late one.
    await writeFile(op, JSON.stringify({ earnings: { NVDA: [{ date: "2026-11-19", timing: "amc" }], TSLA: [{ date: "2026-10-21", timing: "amc" }] } }));
    await writeFile(
      paid,
      JSON.stringify({ version: 1, fetchedOn: "2026-10-07", done: [], source: "x", earnings: { NVDA: [{ date: "2026-11-18", timing: "amc" }], TSLA: [{ date: "2026-10-22", timing: "amc" }, { date: "2026-10-21", timing: "amc" }] } }),
    );
    const s = await mergedEarnings(op, paid, () => NOON_WED)();
    expect(s.get("NVDA")).toEqual([at(2026, 11, 18), at(2026, 11, 19)]);
    expect(s.get("TSLA")).toEqual([at(2026, 10, 21), at(2026, 10, 22)]);
    expect(nextEarningsFor(s, "NVDA", NOON_WED)).toBe(at(2026, 11, 18));
    expect(nextEarningsFor(s, "TSLA", NOON_WED)).toBe(at(2026, 10, 21));
  });

  it("uses a fresh purchase with dates per symbol and falls back to the operator file otherwise", async () => {
    const dir = await tmp();
    const op = path.join(dir, "earnings.json");
    const paid = path.join(dir, "earnings-paid.json");
    await writeFile(op, JSON.stringify({ earnings: { NVDA: [{ date: "2026-11-19", timing: "amc" }], AAPL: [{ date: "2026-10-29", timing: "amc" }] } }));
    await writeFile(
      paid,
      JSON.stringify({
        version: 1,
        fetchedOn: "2026-10-07",
        done: [],
        source: "x",
        earnings: { NVDA: [{ date: "2026-11-18", timing: "amc" }], TSLA: [{ date: "2026-10-21", timing: "amc" }], AAPL: [] },
      }),
    );
    const at = (y: number, m: number, d: number) => nextOpen(regularCloseAt(Date.UTC(y, m - 1, d) / 1000 / DAY));
    const s = await mergedEarnings(op, paid, () => NOON_WED)();
    expect(s.get("NVDA")).toEqual([at(2026, 11, 18), at(2026, 11, 19)]);
    expect(s.get("TSLA")).toEqual([at(2026, 10, 21)]);
    expect(s.get("AAPL")).toEqual([at(2026, 10, 29)]); // empty purchase: the operator's date stays
    // a stale purchase is ignored
    const stale = await mergedEarnings(op, paid, () => NOON_WED + 9 * DAY)();
    expect(stale.get("NVDA")).toEqual([at(2026, 11, 19)]);
    expect(stale.has("TSLA")).toBe(false);
    // a broken purchase falls back to the operator file alone
    await writeFile(paid, "{broken");
    expect([...(await mergedEarnings(op, paid, () => NOON_WED)()).keys()].sort()).toEqual(["AAPL", "NVDA"]);
  });
});

function fakeClient(answer: (url: string) => X402Response | Error) {
  const urls: string[] = [];
  return {
    urls,
    get: async (url: string) => {
      urls.push(url);
      const a = answer(url);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const paidResponse = (symbol: string, date: string): X402Response => ({
  status: 200,
  body: { items: [{ date, symbol, hour: "amc" }] },
  payment: { ledgerId: 1, usd: 0.0025, network: "eip155:56", symbol: "USD1", payTo: "0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc", txHash: "0xabc" },
});

describe("EarningsBuyer", () => {
  it("buys once per trading day and records each payment in the feed", async () => {
    const dir = await tmp();
    let now = NOON_WED;
    const feed = new Feed({ dir, secrets: [], clock: () => now });
    const client = fakeClient((url) => paidResponse(new URL(url).searchParams.get("ticker")!, "2026-11-18"));
    const file = path.join(dir, "earnings-paid.json");
    const b = new EarningsBuyer({ client, urlTemplate: "https://2s.io/api/calendar/earnings", file, feed, symbols: () => ["NVDA", "TSLA"], clock: () => now });
    const r = await b.tick();
    expect(r.bought).toEqual(["NVDA", "TSLA"]);
    expect(r.spentUsd).toBeCloseTo(0.005);
    expect(client.urls[0]).toBe("https://2s.io/api/calendar/earnings?ticker=NVDA&from=2026-10-07&to=2027-02-04");
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored).toMatchObject({ fetchedOn: "2026-10-07", done: ["NVDA", "TSLA"], earnings: { NVDA: [{ date: "2026-11-18", timing: "amc" }] } });
    expect(feed.list({ kind: "payment" })).toHaveLength(2);
    now += 3600;
    expect((await b.tick()).ran).toBe(false);
    now = SAT;
    expect((await b.tick()).ran).toBe(false);
    expect(client.urls).toHaveLength(2);
  });

  it("stops at the cap, keeps earlier dates and does not retry that day", async () => {
    const dir = await tmp();
    const feed = new Feed({ dir, secrets: [], clock: () => NOON_WED });
    const file = path.join(dir, "earnings-paid.json");
    await writeFile(file, JSON.stringify({ version: 1, fetchedOn: "2026-10-06", done: ["NVDA"], source: "x", earnings: { TSLA: [{ date: "2026-10-21", timing: "amc" }] } }));
    const client = fakeClient(() => new X402Error("cap", "the daily x402 cap would be exceeded by $0.0025"));
    const b = new EarningsBuyer({ client, urlTemplate: "https://2s.io/api/calendar/earnings", file, feed, symbols: () => ["NVDA", "TSLA"], clock: () => NOON_WED });
    await b.tick();
    expect(client.urls).toHaveLength(1);
    expect(feed.list({ kind: "refused" })[0]).toMatchObject({ source: "x402", reason: expect.stringMatching(/cap/) });
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.earnings.TSLA).toEqual([{ date: "2026-10-21", timing: "amc" }]);
    expect((await b.tick()).ran).toBe(false);
  });

  it("does not pay twice for a symbol whose paid answer could not be parsed", async () => {
    const dir = await tmp();
    const feed = new Feed({ dir, secrets: [], clock: () => NOON_WED });
    const file = path.join(dir, "earnings-paid.json");
    const client = fakeClient((url) => {
      const sym = new URL(url).searchParams.get("ticker")!;
      const ok = paidResponse(sym, "2026-11-18");
      return sym === "NVDA" ? { ...ok, body: { unexpected: true } } : ok;
    });
    const b = new EarningsBuyer({ client, urlTemplate: "https://2s.io/api/calendar/earnings", file, feed, symbols: () => ["NVDA", "TSLA"], clock: () => NOON_WED });
    const r1 = await b.tick();
    expect(r1.bought).toEqual(["TSLA"]);
    expect(r1.spentUsd).toBeCloseTo(0.005);
    expect(r1.failed.NVDA).toMatch(/no list/);
    const r2 = await b.tick();
    expect(r2.ran).toBe(false);
    expect(client.urls.filter((u) => u.includes("NVDA"))).toHaveLength(1);
    expect(JSON.parse(await readFile(file, "utf8")).done).toEqual(["NVDA", "TSLA"]);
  });

  it("retries a symbol that failed before any payment, but not one that was paid for", async () => {
    const dir = await tmp();
    const feed = new Feed({ dir, secrets: [], clock: () => NOON_WED });
    const file = path.join(dir, "earnings-paid.json");
    let calls = 0;
    const client = fakeClient((url) => {
      calls++;
      const sym = new URL(url).searchParams.get("ticker")!;
      if (calls <= 2) return sym === "NVDA" ? new X402Error("http", "answered 503") : new X402Error("paid-failed", "the paid request answered 500");
      return paidResponse(sym, "2026-11-18");
    });
    const b = new EarningsBuyer({ client, urlTemplate: "https://2s.io/api/calendar/earnings", file, feed, symbols: () => ["NVDA", "TSLA"], clock: () => NOON_WED });
    await b.tick();
    const r = await b.tick();
    expect(r.bought).toEqual(["NVDA"]);
    expect(client.urls.filter((u) => u.includes("TSLA"))).toHaveLength(1);
    expect(feed.list({ kind: "finding" })).toHaveLength(2);
  });
});
