/* GET /api/oracle[?symbol=]: the Session Oracle for every listed ticker, all read at one block (SDK
   oracleSnapshot), cached 30 s with one read in flight. The set of symbols is the configured ticker list; a
   `symbol` parameter only filters the cached answer and never causes a read of its own. Without a deployment the
   answer says the contracts are not deployed; a symbol that cannot be read carries its own error. */
import { tickers } from "@ballast/risk";
import { identityRegistryAbi, oracleSnapshot, sessionAwareFeedAbi, sessionOracleAbi, sessionState, symbolToBytes32, type Deployment, type ReadClient } from "@ballast/sdk";
import { getAddress } from "viem";
import { DESK_ADDRESS, type IdentityView } from "@/lib/identity";
import type { FeedBandView, PublisherView } from "@/lib/oracle-view";
import { toJson, ttlCache } from "../cache";
import type { DeploymentStatus } from "../deployment";
import { BusyError, readGate, withDeadline } from "../guard";
import { badRequest, query, symbolParam } from "../params";
import { shortMessage } from "../simulate";

export const ORACLE_TTL_MS = 30_000;
/** symbols read at the same time */
const CONCURRENCY = 6;

export type OracleBody =
  | {
      status: "ok";
      chainId: number;
      blockNumber: string;
      at: number;
      session: unknown;
      symbols: unknown[];
      contracts?: { sessionOracle: string; sessionAwareFeed: string; calendar: string };
      publisher?: PublisherView;
    }
  | { status: "not-deployed"; detail: string }
  | { status: "unavailable"; detail: string };

const ZERO = "0x0000000000000000000000000000000000000000";

/** The ERC-8004 registry's record for an agent id: who owns it and which wallet it names. Never throws. */
export async function readIdentity(c: ReadClient, d: Pick<Deployment, "external">, agentId: bigint, blockNumber?: bigint): Promise<IdentityView> {
  const registry = d.external.identityRegistry;
  const at = { address: registry, abi: identityRegistryAbi, blockNumber } as const;
  const base = { agentId: agentId.toString(), registry };
  try {
    const [owner, wallet] = await Promise.all([
      c.readContract({ ...at, functionName: "ownerOf", args: [agentId] }),
      c.readContract({ ...at, functionName: "getAgentWallet", args: [agentId] }).catch(() => null),
    ]);
    const w = wallet && wallet !== ZERO ? getAddress(wallet) : null;
    const o = getAddress(owner);
    return { ...base, owner: o, wallet: w, matchesDesk: o === DESK_ADDRESS || w === DESK_ADDRESS };
  } catch (err) {
    return { ...base, owner: null, wallet: null, matchesDesk: null, error: `the identity registry could not be read: ${shortMessage(err)}` };
  }
}

/** Who may post overlays, and the ERC-8004 identity the oracle names for it. Never throws. */
async function readPublisher(c: ReadClient, d: Deployment, blockNumber: bigint): Promise<PublisherView> {
  const or = { address: d.sessionOracle, abi: sessionOracleAbi, blockNumber } as const;
  try {
    const [address, agentId] = await Promise.all([c.readContract({ ...or, functionName: "publisher" }), c.readContract({ ...or, functionName: "publisherAgentId" })]);
    return { address: getAddress(address), agentId: agentId.toString(), identity: agentId > 0n ? await readIdentity(c, d, agentId, blockNumber) : null };
  } catch (err) {
    return { address: null, agentId: null, identity: null, error: `the publisher could not be read: ${shortMessage(err)}` };
  }
}

/** SessionAwareFeed.band(symbol) at the block of the snapshot. Never throws. */
async function readBand(c: ReadClient, d: Deployment, symbol: string, blockNumber: bigint): Promise<FeedBandView> {
  try {
    const [lo, hi, bandBps, ok] = await c.readContract({ address: d.sessionAwareFeed, abi: sessionAwareFeedAbi, blockNumber, functionName: "band", args: [symbolToBytes32(symbol)] });
    return { ok, lo: lo.toString(), hi: hi.toString(), bandBps: Number(bandBps) };
  } catch (err) {
    return { error: `band unreadable: ${shortMessage(err)}` };
  }
}

export async function readOracle(c: ReadClient, s: Extract<DeploymentStatus, { ok: true }>): Promise<OracleBody> {
  const d = s.deployment;
  const session = await sessionState(c, d);
  const blockNumber = session.blockNumber;
  const publisher = readPublisher(c, d, blockNumber);
  const symbols: unknown[] = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    symbols.push(
      ...(await Promise.all(
        tickers.slice(i, i + CONCURRENCY).map(async (t) => {
          try {
            const [snap, band] = await Promise.all([oracleSnapshot(c, d, t.symbol, { blockNumber }), readBand(c, d, t.symbol, blockNumber)]);
            return { ...(toJson(snap) as object), band };
          } catch (err) {
            return { symbol: t.symbol, error: `snapshot unreadable: ${shortMessage(err)}` };
          }
        }),
      )),
    );
  }
  return {
    status: "ok",
    chainId: s.chainId,
    blockNumber: blockNumber.toString(),
    at: session.at,
    session: toJson(session),
    symbols,
    contracts: { sessionOracle: d.sessionOracle, sessionAwareFeed: d.sessionAwareFeed, calendar: d.calendar },
    publisher: await publisher,
  };
}

const cache = ttlCache<OracleBody>(ORACLE_TTL_MS, { errorTtlMs: 5_000, replayError: (err) => !(err instanceof BusyError) });

export async function handleOracle(s: DeploymentStatus, c: ReadClient, req?: Request): Promise<Response> {
  let symbol: string | null = null;
  if (req) {
    const q = query(req);
    if (q instanceof Response) return q;
    const sym = symbolParam(q, "symbol");
    if (sym instanceof Response) return sym;
    if (sym !== null && !tickers.some((t) => t.symbol === sym)) return badRequest("symbol is not listed", 404);
    symbol = sym;
  }
  let body: OracleBody;
  if (!s.ok) body = { status: "not-deployed", detail: s.detail };
  else {
    try {
      body = await cache.get(`${s.chainId}|${s.deployment.sessionOracle}`, () =>
        readGate.run(() =>
          withDeadline(readOracle(c, s)).then((r) => {
            // an answer with unreadable symbols is served as it is, but read again within seconds instead of being kept
            if (r.status === "ok" && r.symbols.some((x) => typeof (x as { error?: unknown }).error === "string")) throw Object.assign(new Error("partial"), { body: r });
            return r;
          }),
        ),
      );
    } catch (err) {
      if (err instanceof BusyError) {
        return Response.json({ error: err.message }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "2" } });
      }
      body = (err as { body?: OracleBody }).body ?? { status: "unavailable", detail: `chain read failed: ${shortMessage(err)}` };
    }
  }
  if (symbol !== null && body.status === "ok") {
    body = { ...body, symbols: body.symbols.filter((x) => (x as { symbol?: unknown }).symbol === symbol) };
  }
  const whole = body.status === "ok" && !body.symbols.some((x) => typeof (x as { error?: unknown }).error === "string");
  const headers = { "cache-control": whole ? "public, s-maxage=30, stale-while-revalidate=60" : "no-store" };
  return Response.json(body, { headers });
}
