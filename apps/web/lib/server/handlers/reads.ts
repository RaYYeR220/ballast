/* GET handlers for the app's chain reads: /api/accounts?owner=&offset=, /api/loans?user=, /api/markets,
   /api/token?token=&owner=&spender=. Each answer is cached by its inputs and the head block with one read in
   flight, runs under a deadline and behind the shared read gate, and reads a bounded amount of chain state. */
import { Web3Client, defi } from "@ballast/binance";
import { bscExternal, type ReadClient } from "@ballast/sdk";
import type { Address } from "viem";
import type { MarketView, TokenView } from "@/lib/views";
import { ttlCache } from "../cache";
import type { DeploymentStatus } from "../deployment";
import type { ServerEnv } from "../env";
import { BusyError, readGate, withDeadline } from "../guard";
import { LIMITS } from "../limits";
import { addressParam, badRequest, intParam, optionalAddress, query } from "../params";
import { head, isKnownToken, readAccounts, readLoans, readMarkets, readToken, type AccountsPage } from "../reads";
import { shortMessage } from "../simulate";

const NO_STORE = { "cache-control": "no-store" };

const clientIds = new WeakMap<object, number>();
let nextClientId = 1;
/** Cache keys carry the client they were read through (one per RPC endpoint), so answers never cross endpoints. */
function clientId(c: object): number {
  let id = clientIds.get(c);
  if (id === undefined) {
    id = nextClientId++;
    clientIds.set(c, id);
  }
  return id;
}

/** An uncached read: behind the gate (a full gate answers 503) and under the route deadline. */
const bounded = <T>(job: () => Promise<T>) => readGate.run(() => withDeadline(job()));

/** A failed read as an answer: 503 with Retry-After when the instance is busy, else an "unavailable" state. */
function failed(err: unknown, extra: Record<string, unknown> = {}): Response {
  if (err instanceof BusyError) {
    return Response.json({ error: err.message }, { status: 503, headers: { ...NO_STORE, "retry-after": "2" } });
  }
  return Response.json({ status: "unavailable", detail: `chain read failed: ${shortMessage(err)}`, ...extra }, { headers: NO_STORE });
}

/** a refusal by the gate is about this instance, not about the chain: the next caller may try again at once */
const replayError = (err: unknown) => !(err instanceof BusyError);

const accountsCache = ttlCache<AccountsPage>(10_000, { errorTtlMs: 2_000, replayError });

export async function handleAccounts(req: Request, s: DeploymentStatus, c: ReadClient): Promise<Response> {
  const q = query(req);
  if (q instanceof Response) return q;
  const owner = addressParam(q, "owner");
  if (owner instanceof Response) return owner;
  const offset = intParam(q, "offset", { min: 0, max: LIMITS.maxAccountOffset, fallback: 0 });
  if (offset instanceof Response) return offset;
  if (!s.ok) return Response.json({ status: "not-deployed", detail: s.detail }, { headers: NO_STORE });
  try {
    const h = await withDeadline(head(c), LIMITS.rpcTimeoutMs * 2);
    const key = `${clientId(c)}|${s.chainId}|${s.deployment.factory}|${owner}|${offset}|${h.blockNumber}`;
    const r = await accountsCache.get(key, () => bounded(() => readAccounts(c, s.deployment, owner, { offset, head: h })));
    return Response.json({ status: "ok", chainId: s.chainId, ...r }, { headers: NO_STORE });
  } catch (err) {
    return failed(err);
  }
}

export interface DefiSummary {
  status: "ok" | "unavailable" | "not-configured";
  protocols: { id: string; valueUsd: string }[];
  detail?: string;
}

/** Per-protocol totals from the DeFi API's nested position list (addressList > protocolList), at most 50 rows. */
export function summarizeDefi(data: unknown): { id: string; valueUsd: string }[] {
  const out: { id: string; valueUsd: string }[] = [];
  const addrs = (data as { addressList?: unknown })?.addressList;
  if (!Array.isArray(addrs)) return out;
  for (const a of addrs.slice(0, 5)) {
    const list = (a as { protocolList?: unknown })?.protocolList;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (out.length >= 50) return out;
      const id = (p as { defiProtocolId?: unknown })?.defiProtocolId;
      const v = (p as { protocolTotalValue?: unknown })?.protocolTotalValue;
      if (typeof id === "string" || typeof id === "number") out.push({ id: String(id).slice(0, 64), valueUsd: (typeof v === "string" ? v : String(v ?? "")).slice(0, 40) });
    }
  }
  return out;
}

async function defiPositions(e: ServerEnv, user: Address, fetchImpl?: typeof fetch): Promise<DefiSummary> {
  if (!e.binance || e.chainId !== 56) return { status: "not-configured", protocols: [] };
  try {
    const web3 = new Web3Client({ apiKey: e.binance.apiKey, apiSecret: e.binance.apiSecret, probe: () => {}, fetch: fetchImpl, timeoutMs: LIMITS.rpcTimeoutMs, maxRetries: 1 });
    return { status: "ok", protocols: summarizeDefi(await defi.positions(web3, [user], ["56"])) };
  } catch (err) {
    return { status: "unavailable", protocols: [], detail: shortMessage(err) };
  }
}

type LoansAnswer = { chain: Awaited<ReturnType<typeof readLoans>>; defi: DefiSummary };
const loansCache = ttlCache<LoansAnswer>(15_000, { errorTtlMs: 2_000, replayError });

/** The wallet's own Lista/Venus loans, read on chain; the Binance DeFi API adds its position summary when keyed. */
export async function handleLoans(req: Request, e: ServerEnv, c: ReadClient, fetchImpl?: typeof fetch): Promise<Response> {
  const q = query(req);
  if (q instanceof Response) return q;
  const user = addressParam(q, "user");
  if (user instanceof Response) return user;
  try {
    const h = await withDeadline(head(c), LIMITS.rpcTimeoutMs * 2);
    const r = await loansCache.get(`${clientId(c)}|${e.chainId}|${user}|${h.blockNumber}`, () =>
      bounded(async () => {
        const [chain, defiSummary] = await Promise.all([readLoans(c, bscExternal(), user, { head: h }), defiPositions(e, user, fetchImpl)]);
        return { chain, defi: defiSummary };
      }),
    );
    return Response.json({ status: "ok", chainId: e.chainId, ...r.chain, defi: r.defi }, { headers: NO_STORE });
  } catch (err) {
    return failed(err, { defi: { status: "unavailable", protocols: [] } satisfies DefiSummary });
  }
}

const marketsCache = ttlCache<MarketView[]>(10 * 60_000, { errorTtlMs: 5_000, replayError });

export async function handleMarkets(e: ServerEnv, c: ReadClient): Promise<Response> {
  try {
    const markets = await marketsCache.get(`${clientId(c)}|${e.chainId}`, () => bounded(() => readMarkets(c, bscExternal())));
    return Response.json({ status: "ok", markets }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
  } catch (err) {
    if (err instanceof BusyError) return failed(err);
    return Response.json({ status: "unavailable", detail: shortMessage(err) }, { headers: NO_STORE });
  }
}

const tokenCache = ttlCache<TokenView>(10_000, { errorTtlMs: 2_000, replayError });

export async function handleToken(req: Request, c: ReadClient): Promise<Response> {
  const q = query(req);
  if (q instanceof Response) return q;
  const token = addressParam(q, "token");
  if (token instanceof Response) return token;
  const owner = addressParam(q, "owner");
  if (owner instanceof Response) return owner;
  const spender = optionalAddress(q, "spender");
  if (spender instanceof Response) return spender;
  if (!isKnownToken(token)) return badRequest("token is not one this app uses");
  try {
    const h = await withDeadline(head(c), LIMITS.rpcTimeoutMs * 2);
    const t = await tokenCache.get(`${clientId(c)}|${token}|${owner}|${spender ?? ""}|${h.blockNumber}`, () => bounded(() => readToken(c, token, owner, spender, { head: h })));
    return Response.json({ status: "ok", ...t }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BusyError) return failed(err);
    return Response.json({ status: "unavailable", detail: shortMessage(err) }, { headers: NO_STORE });
  }
}
