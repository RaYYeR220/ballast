import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const reads = vi.hoisted(() => ({
  sessionState: vi.fn(),
  oracleSnapshot: vi.fn(),
  accountState: vi.fn(),
  listAccounts: vi.fn(),
  guardianJobs: vi.fn(),
}));

// Stub only the chain reads; the planner, decoder and enums stay real.
vi.mock("@ballast/sdk", async (importOriginal) => ({ ...(await importOriginal<typeof import("@ballast/sdk")>()), ...reads }));

import type { AccountState, OracleSnapshot } from "@ballast/sdk";
import {
  apiHealthTool,
  createBallastServer,
  createHttpServer,
  guardianJobsTool,
  listAccountsTool,
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
const ctx: ToolContext = {
  client: {} as ToolContext["client"],
  deployment: { chainId: 31337 } as ToolContext["deployment"],
  rwa: { assetStatus },
  probes: () => [
    { ts: "2026-10-05T10:00:00Z", surface: "public", method: "GET", endpoint: "/v1/x", status: 200, code: "000000", ok: true, latencyMs: 100, attempt: 1 },
    { ts: "2026-10-05T10:01:00Z", surface: "public", method: "GET", endpoint: "/v1/x", status: 500, code: "500", ok: false, latencyMs: 300, attempt: 1 },
  ],
};

const text = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

beforeEach(() => {
  for (const f of [...Object.values(reads), assetStatus]) f.mockReset();
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

  it("list_accounts passes the owner filter", async () => {
    reads.listAccounts.mockResolvedValue([ACCOUNT]);
    const r = text(await listAccountsTool(ctx, { owner: OWNER }));
    expect(reads.listAccounts.mock.calls[0]![2]).toEqual({ owner: "0x00000000000000000000000000000000000000B1" });
    expect(r).toMatchObject({ count: 1, truncated: false, accounts: [ACCOUNT] });
  });

  it("guardian_jobs follows the cursor to the head and filters by account", async () => {
    reads.guardianJobs.mockImplementation(async (_c, _d, o: { fromJobId: bigint }) => {
      if (o.fromJobId > 10n ** 30n) return { jobs: [], nextCursor: o.fromJobId, head: 2500n };
      const next = o.fromJobId + 1000n > 2500n ? 2500n : o.fromJobId + 1000n;
      return { jobs: [{ jobId: next }], nextCursor: next, head: 2500n };
    });
    const r = text(await guardianJobsTool(ctx, { account: ACCOUNT }));
    expect(r).toMatchObject({ head: "2500", scannedFrom: "0", count: 3 });
    expect(reads.guardianJobs.mock.calls.slice(1).every((c) => c[2].account === "0x00000000000000000000000000000000000000D1")).toBe(true);
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
});

afterAll(() => vi.restoreAllMocks());
