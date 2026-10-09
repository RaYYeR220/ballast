/* The Session Oracle explorer's data: closures from the calendar, per-share prices, the band against candles,
   and the two Binance-backed routes with mocked fetch and a stubbed chain. */
import { tickers } from "@ballast/risk";
import { describe, expect, it, vi } from "vitest";
import { latestClosure, recentClosures } from "../lib/closures";
import { bandAt, bandSeries, closureChart, judgeCandles, perShare, venueSpread, type BandInputs, type Candle, type VenuePrice } from "../lib/market-view";
import { oracleRows } from "../lib/oracle-rows";
import type { OracleView } from "../lib/oracle-view";
import { serverEnv } from "../lib/server/env";
import { handleCandles, handlePrices, MARKET_LIMITS, parseCandles, readCandles, readPrices, readReferenceHistory } from "../lib/server/handlers/market";
import type { DeploymentStatus } from "../lib/server/deployment";
import { addr, DEPLOYMENT } from "./helpers";

// Thursday 8 October 2026
const THU_1400 = 1_791_482_400; // 14:00 New York, regular session
const THU_CLOSE = 1_791_489_600; // 16:00
const THU_1800 = 1_791_496_800; // 18:00, after hours
const FRI_OPEN = 1_791_552_600; // 09:30
const WEEKEND_CLOSE = 1_790_971_200; // Fri 2 Oct 16:00
const WEEKEND_OPEN = 1_791_207_000; // Mon 5 Oct 09:30
const SAT_NOON = 1_791_648_000; // Sat 10 Oct 12:00

const NVDA = tickers.find((t) => t.symbol === "NVDA")!;
const MISSING: DeploymentStatus = { ok: false, chainId: 56, reason: "missing", detail: "no deployment file for chain 56" };
const OK: DeploymentStatus = { ok: true, chainId: 31337, deployment: DEPLOYMENT, source: "test" };
const KEYED = serverEnv({ BINANCE_WEB3_API_KEY: "k", BINANCE_WEB3_API_SECRET: "s" });

describe("closures from the calendar", () => {
  it("reads the closure in progress and the last weekend after the bell", () => {
    expect(recentClosures(THU_1800)).toEqual([
      { kind: "overnight", closedAt: THU_CLOSE, opensAt: FRI_OPEN, inProgress: true },
      { kind: "weekend", closedAt: WEEKEND_CLOSE, opensAt: WEEKEND_OPEN, inProgress: false },
    ]);
  });

  it("during the regular session the latest closure is last night, finished", () => {
    const c = latestClosure(THU_1400)!;
    expect(c).toMatchObject({ kind: "overnight", opensAt: THU_1400 - 4.5 * 3600, inProgress: false });
    expect(c.opensAt - c.closedAt).toBe(17.5 * 3600);
  });

  it("on a weekend there is one closure to chart", () => {
    const cs = recentClosures(SAT_NOON);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: "weekend", inProgress: true });
    expect((cs[0]!.opensAt - cs[0]!.closedAt) / 3600).toBe(65.5);
  });

  it("answers nothing outside the calendar", () => {
    expect(recentClosures(1_500_000_000)).toEqual([]);
  });
});

describe("per-share prices", () => {
  const v = (venue: VenuePrice["venue"], per: number | null, stale = false): VenuePrice => ({ venue, token: addr(1), platform: null, tokenPrice: per, referencePrice: null, updatedAt: 1, multiplier: 1, multiplierSource: "rebasing", perShare: per, stale });

  it("divides the token price by the shares per token", () => {
    expect(perShare(230.65, 1.000778223752807865)).toBeCloseTo(230.470642, 5);
    expect(perShare(230.898703564399885934, 1.0017152487959898)).toBeCloseTo(230.503333, 5);
    expect(perShare(230, null)).toBeNull();
    expect(perShare(null, 1)).toBeNull();
    expect(perShare(230, 0)).toBeNull();
  });

  it("measures the spread over fresh venues only", () => {
    expect(venueSpread([v("bstock", 100), v("ondo", 101), v("xstock", 120, true)])!.bps).toBeCloseTo((1 / 100.5) * 10_000, 6);
    expect(venueSpread([v("bstock", 100), v("ondo", 101), v("xstock", 120, true)])!.venues).toEqual(["bstock", "ondo"]);
    expect(venueSpread([v("bstock", 100), v("xstock", 120, true)])).toBeNull();
  });
});

describe("the band against candles", () => {
  const inputs: BandInputs = { closure: { closedAt: THU_CLOSE, opensAt: FRI_OPEN }, baseBps: 417, prints: [{ at: THU_CLOSE - 2473, price: 229.975 }], multiplier: 1.000778223752807865, maxRefAgeSec: 93_600 };

  it("matches SessionAwareFeed.band() as read on BNB Chain", () => {
    // block 126520751, 7497 s after the close: band() returned lo 21972799706, hi 24057994693, 453 bps
    const b = bandAt(THU_CLOSE + 7497, inputs);
    expect(b.bps).toBe(453);
    expect(b.lo).toBeCloseTo(219.72799706, 4);
    expect(b.hi).toBeCloseTo(240.57994693, 4);
  });

  it("re-anchors on a print inside the closure and stops at three bases", () => {
    const s = bandSeries({ ...inputs, closure: { closedAt: WEEKEND_CLOSE, opensAt: WEEKEND_OPEN }, baseBps: 737, prints: [{ at: WEEKEND_CLOSE - 60, price: 100 }, { at: WEEKEND_CLOSE + 10 * 3600, price: 110 }], multiplier: 1 });
    expect(s[0]).toMatchObject({ t: WEEKEND_CLOSE, bps: 737, anchor: 100 });
    expect(s.find((p) => p.t === WEEKEND_CLOSE + 10 * 3600 - 1)!.anchor).toBe(100);
    expect(s.find((p) => p.t === WEEKEND_CLOSE + 10 * 3600)!.anchor).toBe(110);
    expect(s[s.length - 1]).toMatchObject({ t: WEEKEND_OPEN, bps: 2211 });
    expect(s.every((p, i) => i === 0 || p.t > s[i - 1]!.t)).toBe(true);
  });

  it("has no anchor when the reference is older than the oracle accepts", () => {
    const b = bandAt(THU_CLOSE + 3600, { ...inputs, prints: [{ at: THU_CLOSE - 93_601, price: 229 }] });
    expect(b).toMatchObject({ anchor: null, lo: null, hi: null });
    expect(bandAt(THU_CLOSE + 3600, { ...inputs, prints: [] }).anchor).toBeNull();
  });

  const k = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 });

  it("judges only hours wholly inside the closure, against the band at the hour's end", () => {
    const candles = [
      k(THU_CLOSE - 3600, 230, 300, 100, 230), // regular session: not judged, whatever it did
      k(THU_CLOSE, 230, 235, 228, 231), // inside
      k(THU_CLOSE + 3600, 231, 243, 229, 232), // wick above the band
      k(THU_CLOSE + 7200, 232, 233, 215, 216), // closes below the band
      k(FRI_OPEN - 1800, 230, 300, 100, 230), // straddles the open
    ];
    const j = judgeCandles(candles, inputs);
    expect(j.map((x) => x.place)).toEqual(["open", "closed", "closed", "closed", "edge"]);
    expect(j.map((x) => x.outside)).toEqual([false, false, true, true, false]);
    expect(j[2]!.closedOutside).toBe(false);
    expect(j[3]!.closedOutside).toBe(true);
    expect(j[2]!.excessBps).toBeCloseTo((243 / j[2]!.band!.hi! - 1) * 10_000, 6);
    expect(j[0]!.band).toBeNull();
  });

  it("counts what it judged and says why there is no band", () => {
    const closure = { kind: "overnight" as const, closedAt: THU_CLOSE, opensAt: FRI_OPEN, inProgress: true };
    const candles = [k(THU_CLOSE, 230, 235, 228, 231), k(THU_CLOSE + 3600, 231, 243, 229, 232)];
    const chart = closureChart(closure, 417, candles, inputs.prints, inputs.multiplier, 93_600, THU_1800);
    expect(chart).toMatchObject({ judged: 2, outside: 1, closedOutside: 0, baseBps: 417, endBps: 417 + Math.floor((417 * 7200) / 86_400) });
    expect(chart.band[chart.band.length - 1]!.t).toBe(FRI_OPEN);
    expect(closureChart(closure, 417, candles, [], inputs.multiplier, 93_600, THU_1800)).toMatchObject({ judged: 0, band: [], bandNote: expect.stringContaining("No reference print") });
    expect(closureChart(closure, 417, candles, inputs.prints, null, 93_600, THU_1800).bandNote).toContain("share multiplier");
    expect(closureChart(closure, 0, candles, inputs.prints, 1, 93_600, THU_1800).bandNote).toContain("No gap is configured");
  });
});

// ------------------------------------------------------------------ a stubbed chain

const E18 = 10n ** 18n;
const ROUND = (2n << 64n) + 9291n;

interface ChainStub {
  ui?: bigint | null;
  sValue?: [bigint, boolean] | null;
  latest?: readonly [bigint, bigint, bigint, bigint, bigint] | null;
  overlay?: { validUntil: bigint; ondoMultiplier: bigint } | null;
  /** every call fails, as when the RPC is down */
  down?: boolean;
  rounds?: (id: bigint) => readonly [bigint, bigint, bigint, bigint, bigint] | null;
}

function chain(o: ChainStub = {}, at = THU_1800) {
  const seen: { functionName: string; address: string; args?: readonly unknown[] }[][] = [];
  const answer = (fn: string, args?: readonly unknown[]): unknown => {
    if (fn === "uiMultiplier") return o.ui === undefined ? 1_000_778_223_752_807_865n : o.ui;
    if (fn === "getSValue") return o.sValue === undefined ? [1_001_715_248_795_989_800n, false] : o.sValue;
    if (fn === "latestRoundData") return o.latest === undefined ? [ROUND, 22_997_500_000n, 0n, BigInt(THU_CLOSE - 2473), ROUND] : o.latest;
    if (fn === "getRoundData") {
      const id = args![0] as bigint;
      // by default one older round per hour before the latest print
      return o.rounds ? o.rounds(id) : [id, 22_900_000_000n, 0n, BigInt(THU_CLOSE - 2473 - Number(ROUND - id) * 3600), id];
    }
    if (fn === "overlay") return o.overlay ?? null;
    if (fn === "params") return [5400, 10800, 60, 93600, 21600, 100, 300];
    return null;
  };
  const client = {
    getBlock: async () => ({ number: 1000n, timestamp: BigInt(at) }),
    multicall: async ({ contracts }: { contracts: { functionName: string; address: string; args?: readonly unknown[] }[] }) => {
      seen.push(contracts);
      return contracts.map((c) => {
        const r = o.down ? null : answer(c.functionName, c.args);
        return r === null ? { status: "failure", error: new Error("rpc down") } : { status: "success", result: r };
      });
    },
  };
  return { client: client as never, seen };
}

const price = (token: string, tokenPrice: string, platformId: string | null, updatedAtSec: number, referencePrice = tokenPrice) => ({ binanceChainId: "56", tokenContractAddress: token.toLowerCase(), platformId, tokenPrice, referencePrice, tokenPriceUpdatedAt: updatedAtSec * 1000 });
const nvdaPrices = () => [
  price(NVDA.bStock, "230.65000000", "bstock", THU_1800 - 5, "230.470642"),
  price(NVDA.ondo, "230.898703564399885934", "ondo", THU_1800 - 8, "230.503333"),
  price(NVDA.xStock, "237.456713920942956254", null, THU_1800 - 28 * 3600),
];

describe("GET /api/market/prices", () => {
  it("says so when the server has no Binance key, and asks nobody", async () => {
    const fetchSpy = vi.fn();
    const res = await handlePrices(serverEnv({}), MISSING, chain().client, fetchSpy as never);
    expect(await res.json()).toMatchObject({ status: "not-configured", detail: expect.stringContaining("BINANCE_WEB3_API_KEY") });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks Binance once for every listed token and brings each to a per-share price", async () => {
    const rwaPrice = vi.fn(async () => nvdaPrices() as never);
    const body = await readPrices({ rwaPrice, chain: chain().client, deployment: null, now: () => THU_1800 * 1000 });
    if (body.status !== "ok") throw new Error("expected ok");
    const listed = tickers.flatMap((t) => [t.bStock, t.ondo, t.xStock]).filter((a) => !/^0x0+$/.test(a));
    expect(rwaPrice).toHaveBeenCalledTimes(1);
    expect((rwaPrice.mock.calls[0] as unknown as [string[]])[0]).toEqual(listed);
    expect(body.symbols).toHaveLength(tickers.length);
    const [b, o, x] = body.symbols[0]!.venues;
    expect(b).toMatchObject({ venue: "bstock", platform: "bstock", multiplierSource: "bstock-token", stale: false });
    expect(b!.perShare).toBeCloseTo(230.470642, 4);
    expect(o).toMatchObject({ venue: "ondo", multiplierSource: "ondo-shares-oracle", stale: false });
    expect(o!.perShare).toBeCloseTo(230.503333, 3);
    // xStocks rebase (one token is one share); this print is a day old
    expect(x).toMatchObject({ venue: "xstock", platform: null, multiplier: 1, multiplierSource: "rebasing", stale: true });
    expect(x!.perShare).toBeCloseTo(237.4567, 3);
    expect(body.symbols[0]!.reference).toMatchObject({ price: 229.975, updatedAt: THU_CLOSE - 2473 });
    expect(body.blockNumber).toBe("1000");
    // a ticker Binance returned nothing for is not filled in
    expect(body.symbols[1]!.venues[0]).toMatchObject({ tokenPrice: null, perShare: null, note: expect.stringContaining("no price") });
    // no Chainlink feed: the reference is left empty and says why
    expect(body.symbols.find((s) => s.symbol === "MSTR")).toMatchObject({ reference: null, referenceNote: expect.stringContaining("publisher") });
  });

  it("prefers the live Ondo multiplier in a valid overlay, and ignores an expired one", async () => {
    const live = { validUntil: BigInt(THU_1800 + 600), ondoMultiplier: (E18 * 1002n) / 1000n };
    const fresh = await readPrices({ rwaPrice: async () => nvdaPrices() as never, chain: chain({ overlay: live }).client, deployment: DEPLOYMENT, now: () => THU_1800 * 1000 });
    const stale = await readPrices({ rwaPrice: async () => nvdaPrices() as never, chain: chain({ overlay: { ...live, validUntil: BigInt(THU_1800 - 1) } }).client, deployment: DEPLOYMENT, now: () => THU_1800 * 1000 });
    if (fresh.status !== "ok" || stale.status !== "ok") throw new Error("expected ok");
    expect(fresh.symbols[0]!.venues[1]).toMatchObject({ multiplier: 1.002, multiplierSource: "session-oracle-overlay" });
    expect(stale.symbols[0]!.venues[1]).toMatchObject({ multiplierSource: "ondo-shares-oracle" });
  });

  it("leaves out a paused Ondo shares oracle instead of trusting it", async () => {
    const body = await readPrices({ rwaPrice: async () => nvdaPrices() as never, chain: chain({ sValue: [E18, true] }).client, deployment: null, now: () => THU_1800 * 1000 });
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.symbols[0]!.venues[1]).toMatchObject({ multiplier: null, perShare: null, note: expect.stringContaining("multiplier") });
  });

  it("keeps Binance's prices per token and says the chain half is missing when the RPC fails", async () => {
    const body = await readPrices({ rwaPrice: async () => nvdaPrices() as never, chain: chain({ down: true }).client, deployment: null, now: () => THU_1800 * 1000 });
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.blockNumber).toBeNull();
    expect(body.chainNote).toContain("unavailable");
    expect(body.symbols[0]!.venues[0]).toMatchObject({ tokenPrice: 230.65, perShare: null, multiplier: null });
    expect(body.symbols[0]!.reference).toBeNull();
  });

  it("answers unavailable when Binance fails, whatever the chain says", async () => {
    const body = await readPrices({ rwaPrice: async () => Promise.reject(new Error("HTTP 200 code 40304")), chain: chain().client, deployment: null });
    expect(body).toMatchObject({ status: "unavailable", detail: expect.stringContaining("40304") });
  });
});

const rows = (from: number, n: number, px = 230) => Array.from({ length: n }, (_, i) => [px, px + 1, px - 1, px + 0.5, 1000 + i, (from + i * 3600) * 1000, 12]);
const envelope = (data: unknown, code = "000000", msg?: string) => new Response(JSON.stringify({ code, msg, data }));
const req = (symbol: string) => new Request(`http://app.test/api/market/candles?symbol=${symbol}`);

describe("GET /api/market/candles", () => {
  it("keeps only well-formed rows, in time order", () => {
    const parsed = parseCandles([[2, 3, 1, 2.5, 10, 7_200_000, 4], ["1", "2", "0.5", "1.5", "9", "3600000"], [0, 1, 1, 1, 1, 1], [1, 0.5, 2, 1, 1, 10_800_000], "junk", [1, 2]]);
    expect(parsed).toEqual([
      { t: 3600, o: 1, h: 2, l: 0.5, c: 1.5, v: 9 },
      { t: 7200, o: 2, h: 3, l: 1, c: 2.5, v: 10 },
    ]);
    expect(parseCandles({})).toEqual([]);
  });

  it("refuses a missing, malformed or unlisted symbol before asking anyone", async () => {
    const fetchSpy = vi.fn();
    const c = chain().client;
    expect((await handleCandles(new Request("http://app.test/api/market/candles"), KEYED, MISSING, c, { fetch: fetchSpy as never })).status).toBe(400);
    expect((await handleCandles(req("NV%20DA"), KEYED, MISSING, c, { fetch: fetchSpy as never })).status).toBe(400);
    expect((await handleCandles(req("DOGE"), KEYED, MISSING, c, { fetch: fetchSpy as never })).status).toBe(404);
    expect((await handleCandles(new Request(`http://app.test/api/market/candles?symbol=NVDA&x=${"a".repeat(600)}`), KEYED, MISSING, c, { fetch: fetchSpy as never })).status).toBe(414);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks the keyed Market API for one-hour bars of the bStock and judges them against the band", async () => {
    const tsla = tickers.find((t) => t.symbol === "TSLA")!;
    // hourly bars from five hours before last weekend's close up to the hour before "now"
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => envelope(rows(WEEKEND_CLOSE - 5 * 3600, 151)));
    const keyless = vi.fn();
    const res = await handleCandles(req("TSLA"), KEYED, MISSING, chain().client, { fetch: fetchSpy as never, keyless: keyless as never, now: () => THU_1800 * 1000 });
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", symbol: "TSLA", source: "market-api", referenceSource: "chainlink", maxRefAgeSec: 93_600 });
    expect(body.sourceNote).toBeUndefined();
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe("/build/api/v1/dex/market/candles");
    expect(Object.fromEntries(url.searchParams)).toEqual({ binanceChainId: "56", tokenContractAddress: tsla.bStock, bar: "1h", limit: String(MARKET_LIMITS.candles) });
    const headers = new Headers(fetchSpy.mock.calls[0]![1]!.headers);
    expect(headers.get("X-OC-APIKEY")).toBe("k");
    expect(headers.get("X-OC-SIGN")).toBeTruthy();
    // the key and its secret stay on the server
    expect(JSON.stringify(body)).not.toMatch(/"(k|s)"/);
    expect(keyless).not.toHaveBeenCalled();
    expect(body.closures.map((c: { kind: string }) => c.kind)).toEqual(["overnight", "weekend"]);
    expect(body.closures[0]).toMatchObject({ inProgress: true, baseBps: tsla.gapBps.overnight, judged: 2 });
    // the stub's reference prints reach back four days, to Sunday afternoon: the band is drawn from there and says so
    expect(body.closures[1]).toMatchObject({ inProgress: false, baseBps: tsla.gapBps.weekend, judged: 17, bandNote: expect.stringContaining("does not reach back") });
    expect(body.closures[1].band.find((p: { anchor: number | null }) => p.anchor !== null).t).toBeGreaterThan(WEEKEND_CLOSE + 40 * 3600);
    expect(res.headers.get("cache-control")).toContain("s-maxage");
  });

  it("falls back to the keyless klines when the keyed API answers with an error code, and says which ran", async () => {
    // errors come back as HTTP 200 with a code
    const fetchSpy = vi.fn(async () => envelope(null, "40001", "Parameter bar error"));
    const keyless = vi.fn(async () => rows(THU_CLOSE - 3600, 4).map((r) => ({ open: r[0]!, high: r[1]!, low: r[2]!, close: r[3]!, volume: r[4]!, openTime: r[5]!, closeTime: r[5]! + 3_600_000 })));
    const body = await (await handleCandles(req("AAPL"), KEYED, MISSING, chain().client, { fetch: fetchSpy as never, keyless: keyless as never, now: () => THU_1800 * 1000 })).json();
    expect(body).toMatchObject({ status: "ok", source: "public-klines", sourceNote: expect.stringContaining("40001") });
    expect(keyless).toHaveBeenCalledTimes(1);
    expect(body.closures[0].candles).toHaveLength(4);
  });

  it("runs on the keyless klines alone when no key is set", async () => {
    const keyless = vi.fn(async () => rows(THU_CLOSE - 3600, 3).map((r) => ({ open: r[0]!, high: r[1]!, low: r[2]!, close: r[3]!, volume: r[4]!, openTime: r[5]!, closeTime: r[5]! + 3_600_000 })));
    const body = await readCandles("NVDA", { keyed: null, keyless: keyless as never, chain: chain().client, deployment: null, now: () => THU_1800 * 1000 });
    expect(body).toMatchObject({ status: "ok", source: "public-klines", sourceNote: expect.stringContaining("no API key") });
  });

  it("answers unavailable, uncached, when Binance has no candles at all", async () => {
    const fetchSpy = vi.fn(async () => envelope(null, "50000", "down"));
    const res = await handleCandles(req("META"), KEYED, MISSING, chain().client, { fetch: fetchSpy as never, keyless: (async () => Promise.reject(new Error("fetch failed"))) as never, now: () => THU_1800 * 1000 });
    expect(await res.json()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("fetch failed") });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("draws candles without a band, marked partial, when the chain cannot be read", async () => {
    const body = await readCandles("NVDA", { keyed: async () => rows(THU_CLOSE - 3600, 4), keyless: (async () => []) as never, chain: chain({ down: true }).client, deployment: null, now: () => THU_1800 * 1000 });
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body).toMatchObject({ partial: true, referenceSource: "none", multiplier: null, referenceNote: expect.stringContaining("could not be read on chain") });
    expect(body.closures[0]).toMatchObject({ judged: 0, band: [] });
  });

  it("names the reason a ticker without a Chainlink feed has no band", async () => {
    const body = await readCandles("MSTR", { keyed: async () => rows(THU_CLOSE - 3600, 4), keyless: (async () => []) as never, chain: chain().client, deployment: null, now: () => THU_1800 * 1000 });
    if (body.status !== "ok") throw new Error("expected ok");
    expect(body.referenceNote).toContain("no Chainlink feed");
    expect(body.partial).toBeUndefined();
  });
});

describe("the Chainlink round history", () => {
  it("reads back a bounded number of rounds inside the current phase", async () => {
    const { client, seen } = chain({ rounds: (id) => [id, 22_900_000_000n + (id & 0xffffn), 0n, BigInt(THU_CLOSE - 3000 - Number(ROUND - id) * 3600), id] });
    const h = await readReferenceHistory(client, NVDA, null);
    const walk = seen[1]!;
    expect(walk).toHaveLength(MARKET_LIMITS.rounds - 1);
    expect(walk[0]!.args).toEqual([ROUND - 1n]);
    expect(h.prints).toHaveLength(MARKET_LIMITS.rounds);
    expect(h.prints[0]).toEqual({ at: THU_CLOSE - 2473, price: 229.975 });
    expect(h.multiplier).toBeCloseTo(1.000778223752807865, 12);
    expect(h.maxRefAgeSec).toBe(93_600);
  });

  it("never walks below the first round of the phase, and takes the oracle's own age limit once deployed", async () => {
    const young = (2n << 64n) + 3n;
    const { client, seen } = chain({ latest: [young, 100_000_000n, 0n, BigInt(THU_CLOSE), young], rounds: (id) => [id, 100_000_000n, 0n, BigInt(THU_CLOSE - 100), id] });
    const h = await readReferenceHistory(client, NVDA, DEPLOYMENT);
    expect(seen[0]!.map((c) => c.functionName)).toEqual(["uiMultiplier", "latestRoundData", "params"]);
    expect(seen[1]!.map((c) => c.args![0])).toEqual([young - 1n, young - 2n]);
    expect(h.prints).toHaveLength(3);
  });

  it("throws on a dead RPC instead of answering that nothing exists", async () => {
    await expect(readReferenceHistory(chain({ down: true }).client, NVDA, null)).rejects.toThrow("chain read failed");
  });
});

describe("explorer rows", () => {
  const snapshot = (over: Record<string, unknown> = {}) => ({
    symbol: "NVDA",
    at: THU_1800,
    session: "POST",
    rawPrice: "23127409643",
    perShare: "23109425339",
    reference: "22997500000",
    referenceUpdatedAt: THU_CLOSE - 2473,
    converged: true,
    devBps: 48,
    convergedReason: "OK",
    canAddRisk: false,
    reason: "NOT_REGULAR",
    reasonText: "the US market is not in its regular session",
    windowAhead: { window: "WEEKEND", startsAt: FRI_OPEN + 23_400, endsAt: FRI_OPEN + 259_200, gapBps: 737 },
    currentWindow: { window: "OVERNIGHT", gapBps: 417, closedAt: THU_CLOSE },
    overlay: { validUntil: THU_1800 + 3600, nextEarnings: 0, flags: 0, flagNames: [], ondoMultiplier: "0", referencePrice: "0", postedAt: THU_1800 - 600, fresh: true },
    params: { restoreDelay: 5400, horizon: 10800, convergenceBps: 60, maxRefAge: 93600, maxOverlayTtl: 21600, maxOndoDriftBps: 100, maxRefDeviationBps: 300 },
    band: { ok: true, lo: "21972799706", hi: "24057994693", bandBps: 453 },
    ...over,
  });
  const oracle = (sym: Record<string, unknown>): OracleView => ({ status: "ok", chainId: 56, blockNumber: "1", at: THU_1800, session: {} as never, symbols: [sym as never] });

  it("takes the band and the reference from the chain when the oracle was read", () => {
    const r = oracleRows(null, oracle(snapshot()), null, THU_1800)[0]!;
    expect(r.band).toEqual({ kind: "chain", bps: 453, lo: 219.72799706, hi: 240.57994693 });
    expect(r.reference).toEqual({ price: 229.975, updatedAt: THU_CLOSE - 2473, source: "session-oracle" });
    expect(r.chain!.reason).toBe("NOT_REGULAR");
    expect(r.venues).toEqual({ bstock: null, ondo: null, xstock: null });
  });

  it("says the feed passes the price through in the regular session or without an anchor", () => {
    expect(oracleRows(null, oracle(snapshot({ session: "REGULAR" })), null, THU_1400)[0]!.band).toEqual({ kind: "open" });
    expect(oracleRows(null, oracle(snapshot({ band: { ok: false, lo: "0", hi: "0", bandBps: 0 } })), null, THU_1800)[0]!.band).toEqual({ kind: "no-anchor" });
  });

  it("falls back to the contract's rule, labelled as such, when the oracle is not deployed", () => {
    const rows2 = oracleRows(null, { status: "not-deployed", detail: "x" }, null, THU_1800);
    expect(rows2).toHaveLength(tickers.length);
    expect(rows2[0]!.band).toEqual({ kind: "rule", bps: 417 + Math.floor((417 * 7200) / 86_400) });
    expect(rows2[0]!.chain).toBeNull();
    expect(rows2[0]!.reference).toBeNull();
    expect(oracleRows(null, null, null, THU_1400)[0]!.band).toEqual({ kind: "open" });
  });

  it("keeps a symbol the oracle could not read apart from the rest", () => {
    const r = oracleRows(null, oracle({ symbol: "NVDA", error: "snapshot unreadable: rpc timeout" }), null, THU_1800)[0]!;
    expect(r.chain).toBeNull();
    expect(r.chainError).toContain("rpc timeout");
  });
});
