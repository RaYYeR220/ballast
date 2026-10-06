// Read and plan tools. Every handler is pure over a context: no signing, no keys, no sends.
import { formatUnits, getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import {
  accountState,
  decodeBallastError,
  guardianJobs,
  listAccounts,
  oracleSnapshot,
  planForAccount,
  positionForPlanner,
  sessionState,
  DEFAULT_TARGET_HF,
  type Deployment,
  type ReadClient,
} from "@ballast/sdk";
import { healthAfterGap, healthFactor } from "@ballast/risk";
import type { AssetStatus, ProbeRecord } from "@ballast/binance";

export interface ToolContext {
  client: ReadClient;
  deployment: Deployment;
  /** Keyless Binance RWA reads. */
  rwa: { assetStatus(chainId: string, contractAddress: string): Promise<AssetStatus> };
  /** Most recent API probe records, oldest first. */
  probes: () => ProbeRecord[];
}

export interface ToolResult {
  [k: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const MAX_ACCOUNTS = 200;
const JOB_PAGE = 1000;
const DEFAULT_LOOKBACK = 5000;
const MAX_LOOKBACK = 20000;

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

export const oraclePriceArgs = { symbol: z.string().min(1).max(31).describe("Tokenized stock ticker as registered in the oracle, e.g. TSLA") };
export async function oraclePriceTool(ctx: ToolContext, a: { symbol: string }): Promise<ToolResult> {
  try {
    const o = await oracleSnapshot(ctx.client, ctx.deployment, a.symbol);
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
    const state = await accountState(ctx.client, ctx.deployment, getAddress(a.account));
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
    const state = await accountState(ctx.client, ctx.deployment, getAddress(a.account));
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

export const listAccountsArgs = { owner: address.optional().describe("Only accounts of this owner") };
export async function listAccountsTool(ctx: ToolContext, a: { owner?: string } = {}): Promise<ToolResult> {
  try {
    const all = await listAccounts(ctx.client, ctx.deployment, a.owner ? { owner: getAddress(a.owner) } : {});
    return ok({ count: all.length, truncated: all.length > MAX_ACCOUNTS, accounts: all.slice(0, MAX_ACCOUNTS) });
  } catch (e) {
    return fail(e);
  }
}

export const guardianJobsArgs = {
  account: address.optional().describe("Only jobs guarding this account"),
  lookback: z.number().int().min(1).max(MAX_LOOKBACK).optional().describe(`How many recent kernel job ids to scan (default ${DEFAULT_LOOKBACK})`),
};
export async function guardianJobsTool(ctx: ToolContext, a: { account?: string; lookback?: number } = {}): Promise<ToolResult> {
  try {
    const account: Address | undefined = a.account ? getAddress(a.account) : undefined;
    const lookback = BigInt(Math.min(a.lookback ?? DEFAULT_LOOKBACK, MAX_LOOKBACK));
    // A cursor past the head scans nothing and returns the head.
    const { head } = await guardianJobs(ctx.client, ctx.deployment, { fromJobId: 2n ** 200n });
    const from = head > lookback ? head - lookback : 0n;
    let cursor = from;
    const jobs = [];
    while (cursor < head) {
      const page = await guardianJobs(ctx.client, ctx.deployment, { fromJobId: cursor, limit: JOB_PAGE, ...(account ? { account } : {}) });
      jobs.push(...page.jobs);
      if (page.nextCursor <= cursor) break;
      cursor = page.nextCursor;
    }
    return ok({ head, scannedFrom: from, count: jobs.length, jobs });
  } catch (e) {
    return fail(e);
  }
}

export const tokenizedStockStatusArgs = { address: address.describe("Tokenized stock token contract address on BNB Chain") };
export async function tokenizedStockStatusTool(ctx: ToolContext, a: { address: string }): Promise<ToolResult> {
  try {
    const addr = getAddress(a.address);
    const chain = ctx.deployment.chainId === 31337 ? 56 : ctx.deployment.chainId;
    const s = await ctx.rwa.assetStatus(String(chain), addr);
    return ok({
      address: addr,
      open: s.openState,
      marketStatus: s.marketStatus,
      reasonCode: s.reasonCode,
      reason: s.reasonMsg,
      nextOpenIso: s.nextOpenTime ? new Date(s.nextOpenTime).toISOString() : null,
      nextCloseIso: s.nextCloseTime ? new Date(s.nextCloseTime).toISOString() : null,
      source: "binance public rwa status",
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
  { name: "list_accounts", title: "List accounts", description: "Ballast accounts, all or by owner.", shape: listAccountsArgs, handler: listAccountsTool },
  { name: "guardian_jobs", title: "Guardian jobs", description: "Recent guardian jobs (ERC-8183) evaluated by the Ballast guardian, with their guarded account, window and status.", shape: guardianJobsArgs, handler: guardianJobsTool },
  { name: "tokenized_stock_status", title: "Tokenized stock status", description: "Keyless Binance status for a tokenized stock token: open or closed, and the reason (closed session, corporate action, earnings).", shape: tokenizedStockStatusArgs, handler: tokenizedStockStatusTool },
  { name: "api_health", title: "API health", description: "Summary of the latest Binance public API probe records seen by this server: calls, failures, latency.", shape: apiHealthArgs, handler: apiHealthTool },
];
