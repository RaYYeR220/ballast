import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const reads = vi.hoisted(() => ({
  sessionState: vi.fn(),
  oracleSnapshot: vi.fn(),
  accountState: vi.fn(),
  listAccounts: vi.fn(),
  guardianJobs: vi.fn(),
  readGuardianJobs: vi.fn(),
}));

// Stub only the chain reads; the planner, decoder and enums stay real.
vi.mock("@ballast/sdk", async (importOriginal) => ({ ...(await importOriginal<typeof import("@ballast/sdk")>()), ...reads }));

import type { AccountState, OracleSnapshot } from "@ballast/sdk";
import {
  apiHealthTool,
  createBallastServer,
  createHttpServer,
  httpOptionsFrom,
  MAX_BODY_BYTES,
  parseAllowedHosts,
  parseAllowedOrigins,
  guardianJobsTool,
  listAccountsTool,
  oraclePriceArgs,
  oraclePriceTool,
  planShieldTool,
  positionRiskTool,
  sessionStateTool,
  tokenizedStockStatusTool,
  tools,
  type ToolContext,
} from "../src/index";

const ACCOUNT = "0x00000000000000000000000000000000000000d1";
const OWNER = "0x00000000000000000000000000000000000000b1";
const E18 = 10n ** 18n;

const oracle = (over: Partial<OracleSnapshot> = {}): OracleSnapshot =>
  ({
    symbol: "NVDA",
    at: 1_800_000_000,
    blockNumber: 100n,
    session: "REGULAR",
    rawPrice: 250n * 10n ** 8n,
    perShare: 250n * 10n ** 8n,
    reference: 249n * 10n ** 8n,
    referenceUpdatedAt: 1_799_999_000,
    converged: true,
    devBps: 40,
    convergedReason: "OK",
    canAddRisk: true,
    reason: "OK",
    reasonText: "ok",
    windowAhead: { window: "OVERNIGHT", startsAt: 1_800_003_600, endsAt: 1_800_050_000, gapBps: 2000 },
    currentWindow: { window: "NONE", gapBps: 0, closedAt: 0 },
    overlay: { validUntil: 1_800_010_000, nextEarnings: 0, flags: 0, flagNames: [], ondoMultiplier: 0n, referencePrice: 0n, postedAt: 1_799_990_000, fresh: true },
    params: { restoreDelay: 5400, horizon: 7200, convergenceBps: 100, maxRefAge: 3600, maxOverlayTtl: 86400, maxOndoDriftBps: 50, maxRefDeviationBps: 500 },
    ...over,
  }) as OracleSnapshot;

const account = (over: Partial<AccountState> = {}): AccountState =>
  ({
    address: ACCOUNT,
    blockNumber: 100n,
    venue: "lista",
    owner: OWNER,
    keeper: OWNER,
    symbol: "NVDA",
    mandate: { maxLtvBps: 6000, shieldLtvBps: 5000, maxSlippageBps: 150, autoRestore: true },
    collateral: 10n * E18,
    debt: 1500n * E18,
    cushion: 300n * E18,
    ltvBps: 6000,
    healthKnown: true,
    healthy: true,
    liquidated: false,
    liquidationRecorded: false,
    trackedCollateral: 10n * E18,
    loanDecimals: 18,
    collateralDecimals: 18,
    market: { venue: "lista", deleveragePathSet: true },
    pricing: { collateralPriceUsd: 250, loanPriceUsd: 1, lltv: 0.75, minLoanUsd: 1, minLoanKnown: true },
    ...over,
  }) as unknown as AccountState;

const assetStatus = vi.fn();
const FACTORY = "0x00000000000000000000000000000000000000a4";
const ACCOUNTS = [1, 2, 3, 4, 5].map((i) => `0x00000000000000000000000000000000000001${i}0`);
const readContract = vi.fn(async (req: { functionName: string; args?: unknown[] }) => {
  if (req.functionName === "isAccount") return String(req.args?.[0]).toLowerCase() === ACCOUNT;
  if (req.functionName === "accountCount") return BigInt(ACCOUNTS.length);
  if (req.functionName === "allAccounts") return ACCOUNTS[Number(req.args?.[0])];
  throw new Error(`unexpected read ${req.functionName}`);
});
const ctx: ToolContext = {
  client: { readContract } as unknown as ToolContext["client"],
  deployment: { chainId: 31337, factory: FACTORY } as unknown as ToolContext["deployment"],
  rwa: { assetStatus },
  probes: () => [
    { ts: "2026-10-05T10:00:00Z", surface: "public", method: "GET", endpoint: "/v1/x", status: 200, code: "000000", ok: true, latencyMs: 100, attempt: 1 },
    { ts: "2026-10-05T10:01:00Z", surface: "public", method: "GET", endpoint: "/v1/x", status: 500, code: "500", ok: false, latencyMs: 300, attempt: 1 },
  ],
};

const text = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

beforeEach(() => {
  for (const f of [...Object.values(reads), assetStatus]) f.mockReset();
  ctx.state = undefined;
  ctx.deployment = { chainId: 31337, factory: FACTORY } as unknown as ToolContext["deployment"];
  delete ctx.rwaChainId;
  reads.oracleSnapshot.mockResolvedValue(oracle());
  reads.accountState.mockResolvedValue(account());
});

describe("handlers", () => {
  it("session_state adds ISO times", async () => {
    reads.sessionState.mockResolvedValue({
      at: 1_800_000_000,
      blockNumber: 1n,
      session: "REGULAR",
      nextClose: 1_800_003_600,
      nextOpen: 1_800_050_000,
      window: { kind: "OVERNIGHT", startsAt: 1_800_003_600, endsAt: 1_800_050_000 },
      current: { kind: "NONE", closedAt: 0, opensAt: 0 },
    });
    const r = text(await sessionStateTool(ctx));
    expect(r.session).toBe("REGULAR");
    expect(r.nextCloseIso).toBe("2027-01-15T09:00:00.000Z");
    expect(r.current.closedAtIso).toBeNull();
    expect(r.blockNumber).toBe("1");
  });

  it("oracle_price formats 1e8 prices and keeps the can-add-risk answer", async () => {
    reads.oracleSnapshot.mockResolvedValue(oracle({ canAddRisk: false, reason: "WINDOW_AHEAD", reasonText: "a closure is coming" }));
    const r = text(await oraclePriceTool(ctx, { symbol: "NVDA" }));
    expect(reads.oracleSnapshot).toHaveBeenCalledWith(ctx.client, ctx.deployment, "NVDA");
    expect(r).toMatchObject({ canAddRisk: false, reason: "WINDOW_AHEAD", perSharePriceUsd: "250", referenceUsd: "249" });
    expect(r.windowAhead.gapBps).toBe(2000);
  });

  it("position_risk reports health now, after the gap and the plan", async () => {
    const r = text(await positionRiskTool(ctx, { account: ACCOUNT }));
    expect(r.healthFactor.now).toBeCloseTo(1.25, 6);
    expect(r.healthFactor.afterGap).toBeCloseTo(1.0, 6);
    expect(r.gap).toEqual({ bps: 2000, source: "window ahead" });
    expect(r.plan.kind).toBe("repay");
    expect(r.plan.steps[0].fn).toBe("shieldRepay");
    expect(r.debt).toBe("1500");
  });

  it("position_risk uses the closure in progress when there is one", async () => {
    reads.oracleSnapshot.mockResolvedValue(oracle({ currentWindow: { window: "WEEKEND", gapBps: 1000, closedAt: 1_799_990_000 } }));
    const r = text(await positionRiskTool(ctx, { account: ACCOUNT }));
    expect(r.gap).toEqual({ bps: 1000, source: "current closure" });
    expect(r.healthFactor.afterGap).toBeCloseTo(1.125, 6);
  });

  it("plan_shield returns steps and amounts without sending anything", async () => {
    const r = text(await planShieldTool(ctx, { account: ACCOUNT, targetHf: 1.05 }));
    expect(r.kind).toBe("repay");
    expect(r.steps).toHaveLength(1);
    expect(BigInt(r.steps[0].assets)).toBeGreaterThan(0n);
    expect(r.hfAfterGap).toBeGreaterThanOrEqual(1.05);
    expect(r.note).toMatch(/Plan only/);
  });

  it("plan_shield is a noop for a safe account", async () => {
    reads.accountState.mockResolvedValue(account({ debt: 500n * E18 }));
    const r = text(await planShieldTool(ctx, { account: ACCOUNT }));
    expect(r.kind).toBe("noop");
    expect(r.steps).toEqual([]);
  });

  it("list_accounts pages the owner filter", async () => {
    reads.listAccounts.mockResolvedValue([ACCOUNT, ACCOUNTS[0]]);
    const r = text(await listAccountsTool(ctx, { owner: OWNER, offset: 1, limit: 1 }));
    expect(reads.listAccounts.mock.calls[0]![2]).toEqual({ owner: "0x00000000000000000000000000000000000000B1" });
    expect(r).toMatchObject({ total: 2, offset: 1, limit: 1, hasMore: false, accounts: [ACCOUNTS[0]] });
  });

  it("list_accounts reads only the requested page of all accounts", async () => {
    const r = text(await listAccountsTool(ctx, { offset: 1, limit: 2 }));
    expect(r).toMatchObject({ total: 5, hasMore: true, accounts: ACCOUNTS.slice(1, 3) });
    expect(readContract.mock.calls.filter((c) => c[0].functionName === "allAccounts")).toHaveLength(2);
  });

  it("position_risk and plan_shield refuse an address that is not a factory account", async () => {
    const other = "0x0000000000000000000000000000000000000999";
    for (const f of [positionRiskTool, planShieldTool]) {
      const res = await f(ctx, { account: other });
      expect(res.isError).toBe(true);
      expect(text(res).error).toMatch(/not a Ballast account/);
    }
    expect(reads.accountState).not.toHaveBeenCalled();
  });

  it("oracle_price validates and upper-cases the symbol", async () => {
    await oraclePriceTool(ctx, { symbol: "nvda" });
    expect(reads.oracleSnapshot.mock.calls[0]![2]).toBe("NVDA");
    expect(() => z.object(oraclePriceArgs).parse({ symbol: "a b" })).toThrow();
    expect(() => z.object(oraclePriceArgs).parse({ symbol: "x".repeat(32) })).toThrow();
  });

  describe("guardian_jobs", () => {
    const job = (id: bigint, status = "Open", settled = false) => ({ jobId: id, status, terms: { account: ACCOUNT, settled } });
    const kernel = (head: bigint) => {
      reads.guardianJobs.mockImplementation(async (_c, _d, o: { fromJobId: bigint; limit?: number }) => {
        if (o.fromJobId > 10n ** 30n) return { jobs: [], nextCursor: o.fromJobId, head };
        const to = [head, o.fromJobId + BigInt(o.limit ?? 1000)].reduce((a, b) => (a < b ? a : b));
        const jobs = [];
        for (let id = o.fromJobId + 1n; id <= to; id += 500n) jobs.push(job(id));
        return { jobs, nextCursor: to, head };
      });
      reads.readGuardianJobs.mockImplementation(async (_c, _d, ids: bigint[]) => ids.map((id) => job(id, "Completed", true)));
    };

    it("scans the lookback and flags truncation when the start is unknown", async () => {
      kernel(2500n);
      const r = text(await guardianJobsTool(ctx, { lookback: 1200 }));
      expect(r).toMatchObject({ head: "2500", scannedFrom: "1300", truncated: true, guardianStartJobId: null });
      expect(reads.guardianJobs.mock.calls[1]![2].fromJobId).toBe(1300n);
    });

    it("starts at guardianStartJobId and is complete once the scan reaches it", async () => {
      kernel(2500n);
      ctx.deployment = { ...ctx.deployment, guardianStartJobId: 2000n };
      const r = text(await guardianJobsTool(ctx, { lookback: 5000 }));
      expect(r).toMatchObject({ scannedFrom: "2000", truncated: false, guardianStartJobId: "2000" });
      expect(r.jobs.every((j: { jobId: string }) => BigInt(j.jobId) > 2000n)).toBe(true);
    });

    it("is truncated when the lookback cuts above the guardian start", async () => {
      kernel(2500n);
      ctx.deployment = { ...ctx.deployment, guardianStartJobId: 100n };
      const r = text(await guardianJobsTool(ctx, { lookback: 1000 }));
      expect(r).toMatchObject({ scannedFrom: "1500", truncated: true });
    });

    it("advances the cache by cursor and refreshes known jobs instead of rescanning", async () => {
      kernel(2500n);
      ctx.deployment = { ...ctx.deployment, guardianStartJobId: 2000n };
      await guardianJobsTool(ctx, {});
      reads.guardianJobs.mockClear();
      kernel(2600n);
      const r = text(await guardianJobsTool(ctx, {}));
      const scans = reads.guardianJobs.mock.calls.map((c) => c[2].fromJobId).filter((f: bigint) => f < 10n ** 30n);
      expect(scans).toEqual([2500n]);
      expect(reads.readGuardianJobs).toHaveBeenCalled();
      expect(r.jobs.some((j: { status: string }) => j.status === "Completed")).toBe(true);
      expect(r.head).toBe("2600");
    });

    it("filters by account", async () => {
      kernel(2500n);
      ctx.deployment = { ...ctx.deployment, guardianStartJobId: 2000n };
      const none = text(await guardianJobsTool(ctx, { account: "0x0000000000000000000000000000000000000999" }));
      expect(none.count).toBe(0);
    });
  });

  it("caps heavy reads in flight and answers busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    reads.listAccounts.mockImplementation(async () => {
      await gate;
      return [];
    });
    const pending = [listAccountsTool(ctx, { owner: OWNER }), listAccountsTool(ctx, { owner: OWNER })];
    const busy = await listAccountsTool(ctx, { owner: OWNER });
    expect(busy.isError).toBe(true);
    expect(text(busy).error).toMatch(/busy/);
    release();
    await Promise.all(pending);
    expect((await listAccountsTool(ctx, { owner: OWNER })).isError).toBeUndefined();
  });

  it("queries the configured RWA chain", async () => {
    assetStatus.mockResolvedValue({ openState: true, marketStatus: "OPEN", reasonCode: null, reasonMsg: null });
    ctx.rwaChainId = "97";
    await tokenizedStockStatusTool(ctx, { address: ACCOUNT });
    expect(assetStatus.mock.calls[0]![0]).toBe("97");
  });

  it("tokenized_stock_status reads the keyless RWA status", async () => {
    assetStatus.mockResolvedValue({ openState: false, marketStatus: "CLOSED", reasonCode: "EARNINGS", reasonMsg: "Earnings halt", nextOpenTime: 1_800_050_000_000 });
    const r = text(await tokenizedStockStatusTool(ctx, { address: ACCOUNT }));
    expect(assetStatus).toHaveBeenCalledWith("56", "0x00000000000000000000000000000000000000D1");
    expect(r).toMatchObject({ open: false, reasonCode: "EARNINGS", reason: "Earnings halt" });
  });

  it("api_health summarises the probes", async () => {
    const r = text(await apiHealthTool(ctx));
    expect(r).toMatchObject({ records: 2, failures: 1 });
    expect(r.endpoints[0]).toMatchObject({ endpoint: "/v1/x", calls: 2, failures: 1, avgLatencyMs: 200, lastCode: "500" });
  });

  it("turns a failing read into an error result", async () => {
    reads.accountState.mockRejectedValue(new Error("rpc down\nstack"));
    const res = await positionRiskTool(ctx, { account: ACCOUNT });
    expect(res.isError).toBe(true);
    expect(text(res).error).toBe("rpc down");
  });

  it("exposes only read and plan tools", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "session_state",
      "oracle_price",
      "position_risk",
      "plan_shield",
      "list_accounts",
      "guardian_jobs",
      "tokenized_stock_status",
      "api_health",
    ]);
  });
});

describe("mcp server", () => {
  it("lists tools and calls one over an in-memory transport", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createBallastServer(ctx);
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain("plan_shield");
    expect(listed.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const res = await client.callTool({ name: "oracle_price", arguments: { symbol: "NVDA" } });
    const content = res.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ symbol: "NVDA", canAddRisk: true });

    const bad = await client.callTool({ name: "position_risk", arguments: { account: "nope" } });
    expect(bad.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("serves the same tools over Streamable HTTP on loopback", async () => {
    const h = await createHttpServer({ ctx });
    try {
      expect(h.url.startsWith("http://127.0.0.1:")).toBe(true);
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(h.url)));
      expect((await client.listTools()).tools).toHaveLength(8);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it("calls session_state through the server", async () => {
    reads.sessionState.mockResolvedValue({
      at: 1_800_000_000,
      blockNumber: 7n,
      session: "PRE",
      nextClose: 1_800_003_600,
      nextOpen: 1_800_050_000,
      window: { kind: "OVERNIGHT", startsAt: 1_800_003_600, endsAt: 1_800_050_000 },
      current: { kind: "NONE", closedAt: 0, opensAt: 0 },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createBallastServer(ctx);
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = await client.callTool({ name: "session_state", arguments: {} });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toMatchObject({ session: "PRE", blockNumber: "7" });
    await client.close();
    await server.close();
  });

  describe("http hardening", () => {
    let h: Awaited<ReturnType<typeof createHttpServer>>;
    const base = () => h.url.replace(/\/mcp$/, "");
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(h.url, { method: "POST", body, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } });
    beforeEach(async () => {
      h = await createHttpServer({ ctx });
    });
    afterEach(async () => {
      await h.close();
    });

    it("answers 404 for other paths and 405 for non-POST on /mcp", async () => {
      expect((await fetch(`${base()}/nope`)).status).toBe(404);
      const get = await fetch(h.url);
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
      expect((await fetch(`${base()}/health`)).status).toBe(200);
    });

    it("answers 400 with a parse error for malformed JSON", async () => {
      const res = await post("{not json");
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe(-32700);
    });

    const rawPost = (headers: Record<string, string>, body: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(h.url);
        const req = http.request({ host: u.hostname, port: u.port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        // The server may hang up while the oversized body is still being sent.
        req.on("error", (e) => (/EPIPE|ECONNRESET/.test(String(e)) ? resolve(-1) : reject(e)));
        req.write(body);
        req.end();
      });

    it("answers 413 for an oversized body, by header and by streaming", async () => {
      const big = "x".repeat(MAX_BODY_BYTES + 10);
      expect(await rawPost({ "content-length": String(big.length) }, big)).toBe(413);
      // Without a content-length the stream itself is counted.
      expect(await rawPost({ "transfer-encoding": "chunked" }, big)).toBe(413);
    });

    it("rejects a foreign Host header and a foreign Origin (DNS rebinding)", async () => {
      const u = new URL(h.url);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: u.hostname, port: u.port, path: "/health", headers: { host: `evil.example:${u.port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
      const origin = await post("{}", { origin: "http://evil.example" });
      expect(origin.status).toBe(403);
    });

    it("accepts localhost as the Host", async () => {
      const port = new URL(h.url).port;
      expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200);
    });
  });
});

describe("public endpoint behind a reverse proxy", () => {
  const PUBLIC = "mcp.example.org";
  type Handle = Awaited<ReturnType<typeof createHttpServer>>;
  const open: { close(): Promise<void> }[] = [];
  const serve = async (o: Parameters<typeof createHttpServer>[0] = {}): Promise<Handle> => {
    const h = await createHttpServer({ ctx, ...o });
    open.push(h);
    return h;
  };
  afterEach(async () => {
    for (const h of open.splice(0)) await h.close();
  });

  const raw = (h: Handle, o: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const u = new URL(h.url);
      const req = http.request({ host: u.hostname, port: u.port, path: o.path ?? "/health", method: o.method ?? "GET", headers: o.headers ?? {} }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on("error", reject);
      req.end(o.body);
    });

  /** A proxy on loopback, as Caddy is on the VPS: it forwards with the public Host and appends the client address. */
  async function proxyTo(target: string, clientIp: string) {
    const t = new URL(target);
    const proxy = http.createServer((req, res) => {
      const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: PUBLIC, "x-forwarded-for": clientIp } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => res.writeHead(502).end());
      req.pipe(up);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as { port: number };
    const handle = { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((r) => proxy.close(() => r())) };
    open.push(handle);
    return handle;
  }

  it("lists and calls a tool through a proxy that forwards the public host", async () => {
    const h = await serve({ allowedHosts: [PUBLIC] });
    const p = await proxyTo(h.url, "203.0.113.7");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(p.url)));
    expect((await client.listTools()).tools).toHaveLength(8);
    const res = await client.callTool({ name: "oracle_price", arguments: { symbol: "NVDA" } });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toMatchObject({ symbol: "NVDA", canAddRisk: true });
    await client.close();
  });

  it("answers for the public host only when it is allowed, whatever its case", async () => {
    const closed = await serve();
    expect((await raw(closed, { headers: { host: PUBLIC } })).status).toBe(403);
    const h = await serve({ allowedHosts: [PUBLIC] });
    expect((await raw(h, { headers: { host: PUBLIC } })).status).toBe(200);
    expect((await raw(h, { headers: { host: "MCP.Example.ORG" } })).status).toBe(200);
    expect((await raw(h, { headers: { host: `${PUBLIC}:8443` } })).status).toBe(403);
    expect((await raw(h, { headers: { host: "evil.example" } })).status).toBe(403);
    // The loopback names keep working next to the public one.
    expect((await raw(h)).status).toBe(200);
  });

  it("accepts the allowed host's own origin and the listed origins, nothing else", async () => {
    const h = await serve({ allowedHosts: [PUBLIC], allowedOrigins: ["https://app.example.org"] });
    const from = (origin: string) => raw(h, { headers: { host: PUBLIC, origin } }).then((r) => r.status);
    expect(await from(`https://${PUBLIC}`)).toBe(200);
    expect(await from("https://app.example.org")).toBe(200);
    expect(await from("https://APP.example.org")).toBe(200);
    expect(await from("https://evil.example")).toBe(403);
    expect(await from("https://app.example.org.evil.example")).toBe(403);
  });

  it("limits each client address, as reported by the proxy on loopback", async () => {
    let now = 1_000_000;
    const h = await serve({ allowedHosts: [PUBLIC], ratePerMin: 3, clock: () => now });
    const get = (forwarded?: string) => raw(h, { headers: { host: PUBLIC, ...(forwarded ? { "x-forwarded-for": forwarded } : {}) } });
    for (let i = 0; i < 3; i++) expect((await get("203.0.113.7")).status).toBe(200);
    const over = await get("203.0.113.7");
    expect(over.status).toBe(429);
    expect(over.headers["retry-after"]).toBe("60");
    // Another client has its own budget, and so has a caller that comes without a proxy.
    expect((await get("198.51.100.9")).status).toBe(200);
    expect((await get()).status).toBe(200);
    // Only the last hop counts: the proxy appended it, the rest is whatever the client wrote.
    expect((await get("198.51.100.200, 203.0.113.7")).status).toBe(429);
    now += 45_000;
    expect((await get("203.0.113.7")).headers["retry-after"]).toBe("15");
    now += 15_000;
    expect((await get("203.0.113.7")).status).toBe(200);
  });

  it("limits POST /mcp too, with a JSON-RPC error body", async () => {
    const h = await serve({ ratePerMin: 1 });
    const post = () => fetch(h.url, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect((await post()).status).toBe(400);
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { message: "Too many requests" } });
  });

  it("does not believe X-Forwarded-For when told not to trust a proxy, and 0 turns the limit off", async () => {
    const strict = await serve({ ratePerMin: 2, trustLoopbackProxy: false });
    const statuses: number[] = [];
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) statuses.push((await raw(strict, { headers: { host: new URL(strict.url).host, "x-forwarded-for": ip } })).status);
    expect(statuses).toEqual([200, 200, 429]);
    const off = await serve({ ratePerMin: 0 });
    for (let i = 0; i < 5; i++) expect((await raw(off)).status).toBe(200);
  });

  it("reads the options from flags and the environment, flags first", () => {
    expect(httpOptionsFrom(["--http"], {})).toEqual({ host: "127.0.0.1", port: 8787, allowedHosts: [], allowedOrigins: [], ratePerMin: 120 });
    expect(httpOptionsFrom(["--http"], { PORT: "8790", MCP_ALLOWED_HOSTS: " MCP.example.org , other.example:8443 ", MCP_ALLOWED_ORIGINS: "https://App.example.org", MCP_RATE_PER_MIN: "30" })).toEqual({
      host: "127.0.0.1",
      port: 8790,
      allowedHosts: ["mcp.example.org", "other.example:8443"],
      allowedOrigins: ["https://app.example.org"],
      ratePerMin: 30,
    });
    expect(httpOptionsFrom(["--http", "--port", "9000", "--allowed-hosts", "a.example", "--rate-per-min", "0"], { PORT: "8790", MCP_ALLOWED_HOSTS: "b.example", MCP_RATE_PER_MIN: "30" })).toMatchObject({
      port: 9000,
      allowedHosts: ["a.example"],
      ratePerMin: 0,
    });
    expect(() => httpOptionsFrom(["--http", "--port"], {})).toThrow(/--port needs a value/);
    expect(() => httpOptionsFrom(["--http", "--port", "70000"], {})).toThrow(/the port must be a whole number/);
    expect(() => httpOptionsFrom(["--http"], { MCP_RATE_PER_MIN: "fast" })).toThrow(/the rate limit must be a whole number/);
  });

  it("refuses allowlist entries that are not a bare host or a bare origin", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("[::1]:8790,127.0.0.1")).toEqual(["[::1]:8790", "127.0.0.1"]);
    for (const bad of ["https://mcp.example.org", "mcp.example.org/mcp", "mcp example", "*", "-x.example"]) expect(() => parseAllowedHosts(bad)).toThrow(/must be a host name/);
    expect(parseAllowedOrigins("http://localhost:3000")).toEqual(["http://localhost:3000"]);
    expect(() => parseAllowedOrigins("app.example.org")).toThrow(/not a URL|must be scheme/);
    expect(() => parseAllowedOrigins("https://app.example.org/")).toThrow(/must be scheme/);
    expect(() => parseAllowedOrigins("https://app.example.org/page")).toThrow(/must be scheme/);
    expect(() => parseAllowedOrigins("ftp://app.example.org")).toThrow(/must be scheme/);
  });
});

afterAll(() => vi.restoreAllMocks());
