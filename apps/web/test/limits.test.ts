/* The bounds on what one request may cost: capped lists, validated parameters, shared reads, deadlines, a
   concurrency gate and capped bodies. Each test would fail if its cap were removed. */
import { bscConfig, tickers } from "@ballast/risk";
import { getAddress, stringToHex, zeroHash } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deskFeed } from "../lib/server/agent";
import { ttlCache } from "../lib/server/cache";
import type { DeploymentStatus } from "../lib/server/deployment";
import { serverEnv } from "../lib/server/env";
import { BusyError, DeadlineError, gate, readCapped, readGate, TooLargeError, withDeadline } from "../lib/server/guard";
import { handleDesk } from "../lib/server/handlers/desk";
import { handleOracle } from "../lib/server/handlers/oracle";
import { handleAccounts, handleLoans, handleToken, summarizeDefi } from "../lib/server/handlers/reads";
import { handleSimulate, simulateDeps } from "../lib/server/handlers/simulate";
import { LIMITS } from "../lib/server/limits";
import { addressParam, intParam, query, SYMBOL, symbolParam } from "../lib/server/params";
import { head, readAccounts, readCovers } from "../lib/server/reads";
import { addr, cloneCode, DEPLOYMENT, fakeReads, NO_COVER, stubClient } from "./helpers";

const E18 = 10n ** 18n;
const TUE_1100 = 1_791_298_800n;
const CLOSE = 1_791_316_800;
const OPEN = 1_791_379_800;
const OK: DeploymentStatus = { ok: true, chainId: 31337, deployment: DEPLOYMENT, source: "test" };
const OWNER = addr(0xb1);
const KEEPER = addr(0xb2);
const USD1 = getAddress(bscConfig.tokens.USD1);
const NVDAB = getAddress(bscConfig.lista.markets.NVDAB_USD1.collateralToken);
const MP = { loanToken: USD1, collateralToken: NVDAB, oracle: addr(0xc4), irm: addr(0xc5), lltv: 75n * 10n ** 16n };

function paramsFor({ args }: { args: readonly unknown[] }) {
  const m = Object.values(bscConfig.lista.markets).find((x) => x.id === args[0]);
  if (!m) return new Error("unknown market");
  return [USD1, getAddress(m.collateralToken), MP.oracle, MP.irm, BigInt(m.lltv)];
}

/** every read one Lista account, its oracle and the covers need; `extra` overrides */
const answers = (accounts: readonly string[], extra: Record<string, unknown> = {}) => ({
  session: 5,
  nextClose: BigInt(CLOSE),
  nextOpen: BigInt(OPEN),
  nextWindow: [1, BigInt(CLOSE), BigInt(OPEN)],
  [`currentWindow@${DEPLOYMENT.calendar.toLowerCase()}`]: [0, 0n, 0n],
  rawPrice: [18_640_000_000n, true],
  perSharePrice: [18_640_000_000n, true],
  referenceFor: [18_650_000_000n, TUE_1100 - 30n, true],
  converged: [true, 5n, 0],
  canAddRisk: [true, 0],
  windowAhead: [1, BigInt(CLOSE), BigInt(OPEN), 417],
  [`currentWindow@${DEPLOYMENT.sessionOracle.toLowerCase()}`]: [0, 0, 0n],
  overlay: { validUntil: BigInt(CLOSE), nextEarnings: 0n, flags: 0, ondoMultiplier: 0n, referencePrice: 0n, postedAt: TUE_1100 - 60n },
  params: [5400, 10800, 60, 93600, 21600, 100, 300],
  accountsOf: accounts,
  idToMarketParams: paramsFor,
  cover: NO_COVER,
  owner: OWNER,
  keeper: KEEPER,
  symbol: stringToHex("NVDA", { size: 32 }),
  mandate: [6000, 4500, 100, true],
  trackedCollateral: 120n * E18,
  liquidationRecorded: false,
  liquidated: false,
  healthStatus: [true, true],
  position: [120n * E18, 9_000n * E18],
  ltvBps: 4024n,
  cushion: 3_000n * E18,
  loanToken: USD1,
  collateralToken: NVDAB,
  decimals: 18,
  moolah: addr(0xc3),
  marketId: `0x${"11".repeat(32)}`,
  marketParams: MP,
  deleveragePathHash: zeroHash,
  getPrice: 18_640n * 10n ** 34n,
  minLoan: 15n * E18,
  ...extra,
});

/** `n` account addresses and code that makes each a Lista clone of this deployment */
const manyAccounts = (n: number) => Array.from({ length: n }, (_, i) => addr(0x10000 + i));
const listaCode = () => cloneCode(DEPLOYMENT.listaImpl);

afterEach(() => {
  vi.useRealTimers();
});

describe("ttlCache", () => {
  it("replays a failure for its short TTL instead of retrying it for every caller", async () => {
    let t = 0;
    const c = ttlCache<number>(1000, { errorTtlMs: 300, clock: () => t });
    const load = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(c.get("k", load)).rejects.toThrow("down");
    await expect(c.get("k", load)).rejects.toThrow("down");
    expect(load).toHaveBeenCalledTimes(1);
    t = 301;
    await expect(c.get("k", load)).rejects.toThrow("down");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not replay a failure that is about this instance, not the source", async () => {
    const c = ttlCache<number>(1000, { errorTtlMs: 300, replayError: (e) => !(e instanceof BusyError) });
    let busy = true;
    const load = vi.fn(async () => {
      if (busy) throw new BusyError();
      return 1;
    });
    await expect(c.get("k", load)).rejects.toBeInstanceOf(BusyError);
    busy = false;
    await expect(c.get("k", load)).resolves.toBe(1);
  });

  it("never holds more than its maximum number of entries", async () => {
    const c = ttlCache<number>(60_000, { max: 3 });
    for (let i = 0; i < 50; i++) await c.get(`k${i}`, async () => i);
    expect(c.size).toBe(3);
    const reload = vi.fn(async () => -1);
    expect(await c.get("k49", reload)).toBe(49);
    expect(await c.get("k0", reload)).toBe(-1);
  });
});

describe("rate limiter", () => {
  it("remembers a bounded number of clients", async () => {
    const { rateLimiter } = await import("../lib/server/ratelimit");
    const l = rateLimiter(5, () => 0);
    for (let i = 0; i < 6000; i++) l.check(new Request("http://x/", { headers: { "x-forwarded-for": `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` } }));
    expect(l.size).toBeLessThanOrEqual(5000);
  });
});

describe("guards", () => {
  it("gives up on a read that does not answer within the deadline", async () => {
    vi.useFakeTimers();
    const never = new Promise<number>(() => {});
    const r = withDeadline(never, 5000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await r).toBeInstanceOf(DeadlineError);
    await expect(withDeadline(Promise.resolve(7), 5000)).resolves.toBe(7);
  });

  it("refuses work beyond the concurrency cap instead of queueing it", async () => {
    const g = gate(2);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const a = g.run(() => hold);
    const b = g.run(() => hold);
    expect(g.active).toBe(2);
    await expect(g.run(async () => 1)).rejects.toBeInstanceOf(BusyError);
    release();
    await Promise.all([a, b]);
    expect(g.active).toBe(0);
    await expect(g.run(async () => 1)).resolves.toBe(1);
  });

  it("refuses a body declared larger than the cap without reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new Uint8Array(1024));
      },
    });
    const req = new Request("http://x/", { method: "POST", body, headers: { "content-length": "999999" }, duplex: "half" } as RequestInit);
    await expect(readCapped(req, 4096)).rejects.toBeInstanceOf(TooLargeError);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("cuts off a stream that runs past the cap", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new Uint8Array(1024));
      },
    });
    const req = new Request("http://x/", { method: "POST", body: endless, duplex: "half" } as RequestInit);
    await expect(readCapped(req, 4096)).rejects.toBeInstanceOf(TooLargeError);
    // it stopped right after the cap, not at the end of an endless stream
    expect(pulled).toBeLessThan(10);
    expect(await readCapped(new Response("hello"), 4096)).toBe("hello");
  });
});

describe("query parameters", () => {
  const q = (s: string) => new URL(`http://x/api?${s}`).searchParams;

  it("refuses a query longer than any valid one", () => {
    const long = query(new Request(`http://x/api/accounts?owner=${"0".repeat(LIMITS.queryChars)}`));
    expect(long).toBeInstanceOf(Response);
    expect((long as Response).status).toBe(414);
    expect(query(new Request(`http://x/api/accounts?owner=${OWNER}`))).toBeInstanceOf(URLSearchParams);
  });

  it("accepts only 20-byte addresses", () => {
    expect(addressParam(q(`a=${OWNER}`), "a")).toBe(OWNER);
    expect(addressParam(q(`a=${OWNER.toLowerCase()}`), "a")).toBe(OWNER);
    for (const bad of ["", "0x12", `${OWNER}00`, `0x${"zz".repeat(20)}`, "vitalik.eth", OWNER.slice(2)]) {
      const r = addressParam(q(`a=${bad}`), "a");
      expect(r, bad).toBeInstanceOf(Response);
      expect((r as Response).status).toBe(400);
    }
  });

  it("accepts only short plain symbols", () => {
    for (const ok of ["NVDA", "BRK.B", "a", "QQQ_1", "x-y", "A".repeat(31)]) expect(SYMBOL.test(ok), ok).toBe(true);
    for (const bad of ["", "A".repeat(32), "NV DA", "NVDA/USD", "<script>", "NVDA%00", "0x" + "ab".repeat(32)]) expect(SYMBOL.test(bad), bad).toBe(false);
    expect(symbolParam(q("s=NVDA"), "s")).toBe("NVDA");
    expect(symbolParam(q(""), "s")).toBeNull();
    expect(symbolParam(q(`s=${"A".repeat(40)}`), "s")).toBeInstanceOf(Response);
  });

  it("refuses a number outside its range instead of clamping it into a loop bound", () => {
    const o = { min: 0, max: LIMITS.maxAccountOffset, fallback: 0 };
    expect(intParam(q(""), "offset", o)).toBe(0);
    expect(intParam(q("offset=40"), "offset", o)).toBe(40);
    for (const bad of ["-1", "1.5", "abc", "1e9", String(LIMITS.maxAccountOffset + 1), "9".repeat(30)]) {
      expect(intParam(q(`offset=${bad}`), "offset", o), bad).toBeInstanceOf(Response);
    }
  });
});

describe("head block", () => {
  it("is read once for everyone inside its TTL, with one request in flight", async () => {
    let t = 0;
    const { client, chain } = fakeReads({});
    const a = await Promise.all([head(client, () => t), head(client, () => t), head(client, () => t)]);
    expect(chain.headReads).toBe(1);
    expect(a[0]).toEqual({ blockNumber: 1000n, at: 1_791_300_000 });
    t = LIMITS.headTtlMs - 1;
    await head(client, () => t);
    expect(chain.headReads).toBe(1);
    chain.blockNumber = 1001n;
    t = LIMITS.headTtlMs;
    expect((await head(client, () => t)).blockNumber).toBe(1001n);
    expect(chain.headReads).toBe(2);
  });
});

describe("accounts: capped however many the owner has", () => {
  it("reads one page of the newest accounts, not all of them", async () => {
    const all = manyAccounts(45);
    const { client, reads } = fakeReads(answers(all), { timestamp: TUE_1100, code: listaCode });
    const page = await readAccounts(client, DEPLOYMENT, OWNER);
    expect(page.total).toBe(45);
    expect(page.accounts).toHaveLength(LIMITS.accountsPerPage);
    expect(page.more).toBe(true);
    // newest first
    expect(page.accounts[0]!.address).toBe(all[44]);
    expect(page.accounts[19]!.address).toBe(all[25]);
    // exactly one page of account state was read: one `owner()` per account
    expect(reads.filter((r) => r.functionName === "owner")).toHaveLength(LIMITS.accountsPerPage);
    expect(reads.filter((r) => r.functionName === "accountsOf")).toHaveLength(1);
    // one oracle snapshot for the one symbol, not one per account
    expect(reads.filter((r) => r.functionName === "windowAhead")).toHaveLength(1);
  });

  it("pages older accounts with a bounded offset", async () => {
    const all = manyAccounts(45);
    const { client, reads } = fakeReads(answers(all), { timestamp: TUE_1100, code: listaCode });
    const last = await readAccounts(client, DEPLOYMENT, OWNER, { offset: 40 });
    expect(last.accounts.map((a) => a.address)).toEqual([all[4], all[3], all[2], all[1], all[0]]);
    expect(last.more).toBe(false);
    expect(reads.filter((r) => r.functionName === "owner")).toHaveLength(5);
    const beyond = await readAccounts(client, DEPLOYMENT, OWNER, { offset: 500 });
    expect(beyond).toMatchObject({ accounts: [], total: 45, more: false });
    // a wild offset is clamped before it is used
    expect((await readAccounts(client, DEPLOYMENT, OWNER, { offset: Number.MAX_SAFE_INTEGER })).offset).toBe(LIMITS.maxAccountOffset);
  });

  it("reads a few accounts at a time", async () => {
    let running = 0;
    let peak = 0;
    const slowOwner = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return OWNER;
    };
    const { client } = fakeReads(answers(manyAccounts(20), { owner: slowOwner }), { timestamp: TUE_1100, code: listaCode });
    await readAccounts(client, DEPLOYMENT, OWNER);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(LIMITS.accountConcurrency);
  });

  it("rejects a bad offset before any read", async () => {
    const { client, reads, chain } = fakeReads(answers([]));
    for (const bad of ["-1", "abc", String(LIMITS.maxAccountOffset + 1)]) {
      const res = await handleAccounts(new Request(`http://x/api/accounts?owner=${OWNER}&offset=${bad}`), OK, client);
      expect(res.status, bad).toBe(400);
    }
    expect((await handleAccounts(new Request(`http://x/api/accounts?owner=${OWNER}&x=${"y".repeat(600)}`), OK, client)).status).toBe(414);
    expect(reads).toHaveLength(0);
    expect(chain.headReads).toBe(0);
  });
});

describe("covers: read by key, never by walking the vault", () => {
  it("costs one read per configured market whatever the vault holds", async () => {
    const { client, reads } = fakeReads({ idToMarketParams: paramsFor, cover: NO_COVER, decimals: 18 });
    const errors: string[] = [];
    expect(await readCovers(client, DEPLOYMENT, OWNER, 1000n, errors)).toEqual([]);
    expect(errors).toEqual([]);
    const coverReads = reads.filter((r) => r.functionName === "cover");
    // three Lista markets and the one Venus debt market
    expect(coverReads).toHaveLength(Object.keys(bscConfig.lista.markets).length + 1);
    expect(coverReads.every((r) => r.args[0] === OWNER)).toBe(true);
    expect(reads.some((r) => r.functionName === "coverCount" || r.functionName === "coverAt")).toBe(false);
  });

  it("returns the covers that are open", async () => {
    const open = { ...NO_COVER, venue: 1, mp: MP, token: USD1, symbol: stringToHex("NVDA", { size: 32 }), keeper: KEEPER, capPerDay: 300n * E18, balance: 400n * E18, dayStart: 1_791_244_800n, usedToday: 13n * E18 };
    const { client } = fakeReads({ idToMarketParams: paramsFor, decimals: 18, cover: ({ args }: { args: readonly unknown[] }) => (String(args[1]).endsWith("0") ? NO_COVER : open) });
    const covers = await readCovers(client, DEPLOYMENT, OWNER, 1000n, []);
    expect(covers.length).toBeGreaterThan(0);
    expect(covers[0]).toMatchObject({ venue: "lista", symbol: "NVDA", tokenSymbol: "USD1", label: "Lista NVDAB / USD1", balance: (400n * E18).toString(), capPerDay: (300n * E18).toString(), keeper: KEEPER });
  });
});

describe("identical requests share one round of reads", () => {
  it("serves many concurrent and repeated requests for one wallet from one read per head", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const account = addr(0xbb);
    const { client, reads, chain } = fakeReads(answers([account]), { timestamp: TUE_1100, code: { [account.toLowerCase()]: listaCode() } });
    const url = `http://x/api/accounts?owner=${OWNER}`;
    const first = await Promise.all(Array.from({ length: 25 }, () => handleAccounts(new Request(url), OK, client)));
    expect(first.every((r) => r.status === 200)).toBe(true);
    expect((await first[0]!.json()).accounts).toHaveLength(1);
    const count = () => reads.filter((r) => r.functionName === "accountsOf").length;
    expect(count()).toBe(1);
    expect(chain.headReads).toBe(1);
    const perRound = reads.length;

    // later, same head: nothing is read again
    vi.setSystemTime(1_000_000 + LIMITS.headTtlMs - 1);
    await handleAccounts(new Request(url), OK, client);
    expect(reads.length).toBe(perRound);

    // a new block after the head TTL: one more round, again shared
    chain.blockNumber = 1001n;
    vi.setSystemTime(1_000_000 + LIMITS.headTtlMs);
    await Promise.all(Array.from({ length: 10 }, () => handleAccounts(new Request(url), OK, client)));
    expect(count()).toBe(2);
    expect(chain.headReads).toBe(2);

    // a different wallet is its own read
    await handleAccounts(new Request(`http://x/api/accounts?owner=${addr(0xb9)}`), OK, client);
    expect(count()).toBe(3);
  });

  it("shares loans and token reads the same way", async () => {
    const { client, reads } = fakeReads({ idToMarketParams: paramsFor, position: [0n, 0n, 0n], market: [0n, 0n, 0n, 0n, 0n, 0n], borrowBalanceStored: 0n, decimals: 18, balanceOf: 5n * E18, allowance: 0n });
    const env = serverEnv({ NEXT_PUBLIC_CHAIN_ID: "31337" });
    await Promise.all(Array.from({ length: 12 }, () => handleLoans(new Request(`http://x/api/loans?user=${OWNER}`), env, client)));
    expect(reads.filter((r) => r.functionName === "borrowBalanceStored")).toHaveLength(1);
    await Promise.all(Array.from({ length: 12 }, () => handleToken(new Request(`http://x/api/token?token=${USD1}&owner=${OWNER}&spender=${KEEPER}`), client)));
    expect(reads.filter((r) => r.functionName === "allowance")).toHaveLength(1);
  });
});

describe("a caller cannot widen what is read", () => {
  it("reads only tokens the app uses", async () => {
    const { client, reads } = fakeReads({ decimals: 18, balanceOf: 1n, allowance: 0n });
    const res = await handleToken(new Request(`http://x/api/token?token=${addr(0xdead)}&owner=${OWNER}`), client);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not one this app uses");
    expect(reads).toHaveLength(0);
    expect((await handleToken(new Request(`http://x/api/token?token=${USD1}&owner=${OWNER}&spender=nope`), client)).status).toBe(400);
  });

  it("filters the oracle answer by symbol without reading anything more", async () => {
    const { client, reads } = fakeReads(answers([]), { timestamp: TUE_1100 });
    const all = await (await handleOracle(OK, client, new Request("http://x/api/oracle"))).json();
    expect(all.symbols).toHaveLength(tickers.length);
    const afterAll = reads.length;
    const one = await (await handleOracle(OK, client, new Request("http://x/api/oracle?symbol=SPY"))).json();
    expect(one.symbols).toHaveLength(1);
    expect(one.symbols[0].symbol).toBe("SPY");
    expect(reads.length).toBe(afterAll);
    expect((await handleOracle(OK, client, new Request("http://x/api/oracle?symbol=NOPE"))).status).toBe(404);
    expect((await handleOracle(OK, client, new Request(`http://x/api/oracle?symbol=${encodeURIComponent("NV DA")}`))).status).toBe(400);
    expect((await handleOracle(OK, client, new Request(`http://x/api/oracle?symbol=${"A".repeat(40)}`))).status).toBe(400);
    expect(reads.length).toBe(afterAll);
  });

  it("keeps the desk feed and the DeFi summary to their maxima", async () => {
    const events = Array.from({ length: 900 }, (_, i) => ({ seq: i, ts: 1_791_000_000 + i, kind: "noop" }));
    const fetchAll = (async () => new Response(JSON.stringify({ events }))) as never;
    const r = await deskFeed({}, { baseUrl: "http://desk", fetch: fetchAll });
    expect(r.status).toBe("online");
    if (r.status === "online") expect(r.data.events).toHaveLength(LIMITS.feedEvents);
    const f = vi.fn(async () => new Response(JSON.stringify({ events: [] })));
    await handleDesk(new Request("http://x/api/desk/feed?limit=9999"), "feed", { baseUrl: "http://desk", fetch: f as never });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`http://desk/feed?limit=${LIMITS.feedEvents}`);
    expect((await handleDesk(new Request("http://x/api/desk/feed?limit=99999"), "feed", { baseUrl: "http://desk", fetch: f as never })).status).toBe(400);
    const protocolList = Array.from({ length: 500 }, (_, i) => ({ defiProtocolId: `p${i}`, protocolTotalValue: "1" }));
    expect(summarizeDefi({ addressList: [{ protocolList }] })).toHaveLength(50);
  });

  it("does not read a desk answer past its size cap", async () => {
    const huge = "x".repeat(LIMITS.deskAnswerBytes + 10);
    const r = await deskFeed({}, { baseUrl: "http://desk", fetch: (async () => new Response(`{"events":[],"pad":"${huge}"}`)) as never });
    expect(r).toMatchObject({ status: "offline", reason: "error", detail: "the desk's answer was too large to read" });
  });

  it("refuses an oversized simulate body with 413 and simulates nothing", async () => {
    const { client, calls } = stubClient(() => ({ ok: "0x" }));
    const deps = simulateDeps(serverEnv({}), client);
    const big = JSON.stringify({ from: OWNER, to: KEEPER, data: `0x${"00".repeat(LIMITS.bodyBytes)}` });
    const res = await handleSimulate(new Request("http://x/api/simulate", { method: "POST", body: big }), deps);
    expect(res.status).toBe(413);
    const declared = await handleSimulate(new Request("http://x/api/simulate", { method: "POST", body: "{}", headers: { "content-length": String(LIMITS.bodyBytes + 1) } }), deps);
    expect(declared.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe("a slow or busy chain is an answer, not a pile-up", () => {
  it("answers unavailable when the chain does not answer within the deadline", async () => {
    vi.useFakeTimers();
    const { client } = fakeReads(answers([], { accountsOf: () => new Promise(() => {}) }));
    const pending = handleAccounts(new Request(`http://x/api/accounts?owner=${addr(0xd1)}`), OK, client);
    await vi.advanceTimersByTimeAsync(LIMITS.routeDeadlineMs + 1);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "unavailable", detail: expect.stringContaining("no answer within") });
    expect(readGate.active).toBe(0);
  });

  it("answers 503 with Retry-After when too many reads are already running", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const held = Array.from({ length: LIMITS.concurrentReads }, () => readGate.run(() => hold));
    const { client, reads } = fakeReads(answers([]));
    const res = await handleAccounts(new Request(`http://x/api/accounts?owner=${addr(0xd2)}`), OK, client);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(reads.filter((r) => r.functionName === "accountsOf")).toHaveLength(0);
    release();
    await Promise.all(held);
    expect(readGate.active).toBe(0);
  });
});
