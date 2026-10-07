// Read and plan tools. Every handler is pure over a context: no signing, no keys, no sends.
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import {
  accountState,
  ballastFactoryAbi,
  decodeBallastError,
  guardianJobs,
  listAccounts,
  oracleSnapshot,
  planForAccount,
  positionForPlanner,
  readGuardianJobs,
  sessionState,
  DEFAULT_TARGET_HF,
  type Deployment,
  type GuardianJob,
  type ReadClient,
} from "@ballast/sdk";
import { healthAfterGap, healthFactor } from "@ballast/risk";
import type { AssetStatus, ProbeRecord } from "@ballast/binance";

export interface GuardianCache {
  /** Scan floor the cache was built from: it holds every guardian job with an id above this. */
  floor: bigint;
  /** Highest kernel job id scanned so far. */
  cursor: bigint;
  jobs: Map<bigint, GuardianJob>;
}

export interface ToolState {
  guardian: GuardianCache | null;
  heavyInFlight: number;
}

export interface ToolContext {
  client: ReadClient;
  deployment: Deployment;
  /** Keyless Binance RWA reads. */
  rwa: { assetStatus(chainId: string, contractAddress: string): Promise<AssetStatus> };
  /** Most recent API probe records, oldest first. */
  probes: () => ProbeRecord[];
  /** Chain id sent to the Binance RWA status endpoint (default: the deployment chain, or 56 for a fork). */
  rwaChainId?: string;
  /** In-process state shared by calls: the guardian job cache and the heavy-call counter. Created on first use. */
  state?: ToolState;
}

export interface ToolResult {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** At most this many heavy tools (guardian_jobs, list_accounts) run at once per server. */
export const MAX_HEAVY_IN_FLIGHT = 2;

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;
const JOB_PAGE = 1000;
const REFRESH_BATCH = 500;
const DEFAULT_LOOKBACK = 5000;
const MAX_LOOKBACK = 20000;
const FINAL_STATUSES = new Set(["Completed", "Rejected", "Expired"]);

/** JSON with bigints as decimal strings and non-finite numbers as strings. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : typeof x === "number" && !Number.isFinite(x) ? String(x) : x), 2);
}

const ok = (v: unknown): ToolResult => ({ content: [{ type: "text", text: toJson(v) }] });

export function fail(e: unknown): ToolResult {
  const decoded = decodeBallastError(e);
  const message = decoded ? decoded.message : e instanceof Error ? (e.message.split("\n")[0] ?? "error") : String(e);
  return { isError: true, content: [{ type: "text", text: toJson({ error: message, ...(decoded ? { name: decoded.name } : {}) }) }] };
}

const stateOf = (ctx: ToolContext): ToolState => (ctx.state ??= { guardian: null, heavyInFlight: 0 });

/** Runs a heavy read under the in-flight cap; over the cap it answers with a busy error instead of queueing. */
async function heavy(ctx: ToolContext, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const st = stateOf(ctx);
  if (st.heavyInFlight >= MAX_HEAVY_IN_FLIGHT) return fail(new Error("busy: too many heavy reads in flight, retry shortly"));
  st.heavyInFlight++;
  try {
    return await fn();
  } finally {
    st.heavyInFlight--;
  }
}

/** Throws a clear error unless the address is an account made by this deployment's factory. */
async function requireAccount(ctx: ToolContext, account: Address): Promise<void> {
  const known = await ctx.client.readContract({ address: ctx.deployment.factory, abi: ballastFactoryAbi, functionName: "isAccount", args: [account] });
  if (!known) throw new Error(`${account} is not a Ballast account of this deployment`);
}

const address = z.string().refine((s) => isAddress(s, { strict: false }), "not an address");
const iso = (t: number) => (t > 0 ? new Date(t * 1000).toISOString() : null);
const usd8 = (x: bigint | null) => (x === null ? null : formatUnits(x, 8));

export const sessionStateArgs = {};
export async function sessionStateTool(ctx: ToolContext, _a: Record<string, never> = {}): Promise<ToolResult> {
  try {
    const s = await sessionState(ctx.client, ctx.deployment);
    return ok({
      ...s,
      atIso: iso(s.at),
      nextCloseIso: iso(s.nextClose),
      nextOpenIso: iso(s.nextOpen),
      window: { ...s.window, startsAtIso: iso(s.window.startsAt), endsAtIso: iso(s.window.endsAt) },
      current: { ...s.current, closedAtIso: iso(s.current.closedAt), opensAtIso: iso(s.current.opensAt) },
    });
  } catch (e) {
    return fail(e);
  }
}

export const oraclePriceArgs = {
  symbol: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,31}$/, "letters, digits, dot, dash and underscore only")
    .describe("Tokenized stock ticker as registered in the oracle, e.g. TSLA"),
};
export async function oraclePriceTool(ctx: ToolContext, a: { symbol: string }): Promise<ToolResult> {
  try {
    const o = await oracleSnapshot(ctx.client, ctx.deployment, a.symbol.toUpperCase());
    return ok({
      symbol: o.symbol,
      session: o.session,
      canAddRisk: o.canAddRisk,
      reason: o.reason,
      reasonText: o.reasonText,
      rawPriceUsd: usd8(o.rawPrice),
      perSharePriceUsd: usd8(o.perShare),
      referenceUsd: usd8(o.reference),
      referenceUpdatedAtIso: o.referenceUpdatedAt === null ? null : iso(o.referenceUpdatedAt),
      converged: o.converged,
      deviationBps: o.devBps,
      windowAhead: { ...o.windowAhead, startsAtIso: iso(o.windowAhead.startsAt), endsAtIso: iso(o.windowAhead.endsAt) },
      currentWindow: { ...o.currentWindow, closedAtIso: iso(o.currentWindow.closedAt) },
      overlay: { ...o.overlay, referencePriceUsd: usd8(o.overlay.referencePrice), validUntilIso: iso(o.overlay.validUntil), nextEarningsIso: iso(o.overlay.nextEarnings) },
      blockNumber: o.blockNumber,
      at: o.at,
    });
  } catch (e) {
    return fail(e);
  }
}

const targetHf = z.number().min(1).max(3).optional().describe(`Health factor to keep after the gap (default ${DEFAULT_TARGET_HF})`);

export const positionRiskArgs = { account: address.describe("Ballast account address"), targetHf };
export async function positionRiskTool(ctx: ToolContext, a: { account: string; targetHf?: number }): Promise<ToolResult> {
  try {
    const acct = getAddress(a.account);
    await requireAccount(ctx, acct);
    const state = await accountState(ctx.client, ctx.deployment, acct);
    const oracle = await oracleSnapshot(ctx.client, ctx.deployment, state.symbol);
    const plan = planForAccount(state, oracle, a.targetHf === undefined ? {} : { targetHfAfterGap: a.targetHf });
    const inClosure = oracle.currentWindow.window !== "NONE";
    const gapBps = inClosure ? oracle.currentWindow.gapBps : oracle.windowAhead.gapBps;
    const price = state.pricing.collateralPriceUsd;
    let hfNow: number | null = null;
    let hfAfterGap: number | null = null;
    if (price !== null && price > 0 && state.pricing.loanPriceUsd !== null) {
      const p = positionForPlanner(state, price, state.pricing.lltv, state.pricing.minLoanUsd);
      hfNow = healthFactor(p);
      hfAfterGap = healthAfterGap(p, gapBps);
    }
    return ok({
      account: state.address,
      venue: state.venue,
      symbol: state.symbol,
      owner: state.owner,
      collateral: formatUnits(state.collateral, state.collateralDecimals),
      debt: formatUnits(state.debt, state.loanDecimals),
      cushion: formatUnits(state.cushion, state.loanDecimals),
      ltvBps: state.ltvBps,
      healthy: state.healthy,
      liquidated: state.liquidated,
      mandate: state.mandate,
      pricing: state.pricing,
      oracle: { session: oracle.session, canAddRisk: oracle.canAddRisk, reason: oracle.reason, windowAhead: oracle.windowAhead, currentWindow: oracle.currentWindow },
      gap: { bps: gapBps, source: inClosure ? "current closure" : "window ahead" },
      healthFactor: { now: hfNow, afterGap: hfAfterGap },
      plan,
      blockNumber: state.blockNumber,
    });
  } catch (e) {
    return fail(e);
  }
}

export const planShieldArgs = { account: address.describe("Ballast account address"), targetHf };
/** Shield plan only: the ordered account calls to make. Nothing is sent. */
export async function planShieldTool(ctx: ToolContext, a: { account: string; targetHf?: number }): Promise<ToolResult> {
  try {
    const acct = getAddress(a.account);
    await requireAccount(ctx, acct);
    const state = await accountState(ctx.client, ctx.deployment, acct);
    const oracle = await oracleSnapshot(ctx.client, ctx.deployment, state.symbol);
    const plan = planForAccount(state, oracle, a.targetHf === undefined ? {} : { targetHfAfterGap: a.targetHf });
    return ok({
      account: state.address,
      symbol: state.symbol,
      kind: plan.kind,
      reason: "reason" in plan ? plan.reason : null,
      hfAfterGap: "hfAfterGap" in plan ? plan.hfAfterGap : null,
      gapBps: plan.gapBps,
      targetHfAfterGap: plan.targetHfAfterGap,
      canSellCollateral: plan.canSellCollateral,
      inDeleverageWindow: plan.inDeleverageWindow,
      steps: plan.steps,
      amounts: plan.amounts,
      warnings: plan.warnings,
      note: "Plan only. Nothing was sent; the account owner or its keeper signs the calls.",
      blockNumber: state.blockNumber,
    });
  } catch (e) {
    return fail(e);
  }
}

export const listAccountsArgs = {
  owner: address.optional().describe("Only accounts of this owner"),
  offset: z.number().int().min(0).optional().describe("Skip this many accounts (default 0)"),
  limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`Page size (default ${DEFAULT_PAGE}, max ${MAX_PAGE})`),
};
export async function listAccountsTool(ctx: ToolContext, a: { owner?: string; offset?: number; limit?: number } = {}): Promise<ToolResult> {
  return heavy(ctx, async () => {
    try {
      const offset = a.offset ?? 0;
      const limit = Math.min(a.limit ?? DEFAULT_PAGE, MAX_PAGE);
      let total: number;
      let page: Address[];
      if (a.owner) {
        const mine = await listAccounts(ctx.client, ctx.deployment, { owner: getAddress(a.owner) });
        total = mine.length;
        page = mine.slice(offset, offset + limit);
      } else {
        const f = { address: ctx.deployment.factory, abi: ballastFactoryAbi } as const;
        total = Number(await ctx.client.readContract({ ...f, functionName: "accountCount" }));
        const n = Math.max(0, Math.min(limit, total - offset));
        page = await Promise.all(
          Array.from({ length: n }, (_, i) => ctx.client.readContract({ ...f, functionName: "allAccounts", args: [BigInt(offset + i)] })),
        );
      }
      return ok({ total, offset, limit, hasMore: offset + page.length < total, accounts: page });
    } catch (e) {
      return fail(e);
    }
  });
}

export const guardianJobsArgs = {
  account: address.optional().describe("Only jobs guarding this account"),
  lookback: z.number().int().min(1).max(MAX_LOOKBACK).optional().describe(`How many recent kernel job ids to scan at most (default ${DEFAULT_LOOKBACK})`),
};

/** Scans new kernel job ids into the cache, then refreshes the jobs that can still change. */
async function syncGuardianCache(ctx: ToolContext, floor: bigint, head: bigint): Promise<GuardianCache> {
  const st = stateOf(ctx);
  let cache = st.guardian;
  // A cache built from a higher floor misses older jobs: rebuild it.
  if (!cache || cache.floor > floor) cache = st.guardian = { floor, cursor: floor, jobs: new Map() };
  const live = [...cache.jobs.values()].filter((j) => !FINAL_STATUSES.has(j.status) || (j.terms !== null && !j.terms.settled)).map((j) => j.jobId);
  for (let i = 0; i < live.length; i += REFRESH_BATCH) {
    for (const j of await readGuardianJobs(ctx.client, ctx.deployment, live.slice(i, i + REFRESH_BATCH))) cache.jobs.set(j.jobId, j);
  }
  while (cache.cursor < head) {
    const page = await guardianJobs(ctx.client, ctx.deployment, { fromJobId: cache.cursor, limit: JOB_PAGE });
    for (const j of page.jobs) cache.jobs.set(j.jobId, j);
    if (page.nextCursor <= cache.cursor) break;
    cache.cursor = page.nextCursor;
  }
  return cache;
}

export async function guardianJobsTool(ctx: ToolContext, a: { account?: string; lookback?: number } = {}): Promise<ToolResult> {
  return heavy(ctx, async () => {
    try {
      const account: Address | undefined = a.account ? getAddress(a.account) : undefined;
      const lookback = BigInt(Math.min(a.lookback ?? DEFAULT_LOOKBACK, MAX_LOOKBACK));
      // A cursor past the head scans nothing and returns the head.
      const { head } = await guardianJobs(ctx.client, ctx.deployment, { fromJobId: 2n ** 200n });
      const start = ctx.deployment.guardianStartJobId;
      const byLookback = head > lookback ? head - lookback : 0n;
      const floor = start !== undefined && start > byLookback ? start : byLookback;
      // Complete only when the scan reaches the guardian's first possible job (or the start of the kernel).
      const truncated = floor > (start ?? 0n);
      const cache = await syncGuardianCache(ctx, floor, head);
      const jobs = [...cache.jobs.values()]
        .filter((j) => j.jobId > floor && (!account || (j.terms !== null && getAddress(j.terms.account) === account)))
        .sort((x, y) => (x.jobId < y.jobId ? -1 : 1));
      return ok({ head, scannedFrom: floor, guardianStartJobId: start ?? null, truncated, count: jobs.length, jobs });
    } catch (e) {
      return fail(e);
    }
  });
}

export const tokenizedStockStatusArgs = { address: address.describe("Tokenized stock token contract address on BNB Chain") };
export async function tokenizedStockStatusTool(ctx: ToolContext, a: { address: string }): Promise<ToolResult> {
  try {
    const addr = getAddress(a.address);
    const chain = ctx.rwaChainId ?? String(ctx.deployment.chainId === 31337 ? 56 : ctx.deployment.chainId);
    const s = await ctx.rwa.assetStatus(chain, addr);
    return ok({
      address: addr,
      open: s.openState,
      marketStatus: s.marketStatus,
      reasonCode: s.reasonCode,
      reason: s.reasonMsg,
      nextOpenIso: s.nextOpenTime ? new Date(s.nextOpenTime).toISOString() : null,
      nextCloseIso: s.nextCloseTime ? new Date(s.nextCloseTime).toISOString() : null,
      source: "binance public rwa status",
      chainQueried: chain,
    });
  } catch (e) {
    return fail(e);
  }
}

export const apiHealthArgs = {};
export async function apiHealthTool(ctx: ToolContext, _a: Record<string, never> = {}): Promise<ToolResult> {
  const recs = ctx.probes();
  const byEndpoint = new Map<string, { calls: number; failures: number; totalMs: number; lastCode: string; lastTs: string }>();
  for (const r of recs) {
    const e = byEndpoint.get(r.endpoint) ?? { calls: 0, failures: 0, totalMs: 0, lastCode: "", lastTs: "" };
    e.calls++;
    if (!r.ok) e.failures++;
    e.totalMs += r.latencyMs;
    e.lastCode = r.code;
    e.lastTs = r.ts;
    byEndpoint.set(r.endpoint, e);
  }
  return ok({
    records: recs.length,
    failures: recs.filter((r) => !r.ok).length,
    endpoints: [...byEndpoint].map(([endpoint, e]) => ({
      endpoint,
      calls: e.calls,
      failures: e.failures,
      avgLatencyMs: Math.round(e.totalMs / e.calls),
      lastCode: e.lastCode,
      lastAt: e.lastTs,
    })),
    note: recs.length === 0 ? "No calls recorded yet in this process." : undefined,
  });
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  // Handlers are typed per tool; the server passes args that the shape already validated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: ToolContext, args: any) => Promise<ToolResult>;
}

export const tools: ToolDef[] = [
  { name: "session_state", title: "Session state", description: "Current market session on the Ballast calendar, the next close and open, and the next and current closure windows.", shape: sessionStateArgs, handler: sessionStateTool },
  { name: "oracle_price", title: "Oracle price", description: "Session Oracle read for a tokenized stock: prices, whether new risk may be added (canAddRisk and why), the closure window ahead with its gap buffer, and the overlay.", shape: oraclePriceArgs, handler: oraclePriceTool },
  { name: "position_risk", title: "Position risk", description: "A Ballast account's collateral, debt and cushion, its health factor now and after the coming gap, and the shield or restore plan. Read only.", shape: positionRiskArgs, handler: positionRiskTool },
  { name: "plan_shield", title: "Plan shield", description: "The ordered account calls that keep an account above the target health factor through the next closure. Plan only, nothing is signed or sent.", shape: planShieldArgs, handler: planShieldTool },
  { name: "list_accounts", title: "List accounts", description: "Ballast accounts, all or by owner, paged with offset and limit.", shape: listAccountsArgs, handler: listAccountsTool },
  { name: "guardian_jobs", title: "Guardian jobs", description: "Guardian jobs (ERC-8183) evaluated by the Ballast guardian, with their guarded account, window and status. Reports truncated when the scan did not reach the guardian's first possible job.", shape: guardianJobsArgs, handler: guardianJobsTool },
  { name: "tokenized_stock_status", title: "Tokenized stock status", description: "Keyless Binance status for a tokenized stock token: open or closed, and the reason (closed session, corporate action, earnings).", shape: tokenizedStockStatusArgs, handler: tokenizedStockStatusTool },
  { name: "api_health", title: "API health", description: "Summary of the latest Binance public API probe records seen by this server: calls, failures, latency.", shape: apiHealthArgs, handler: apiHealthTool },
];
