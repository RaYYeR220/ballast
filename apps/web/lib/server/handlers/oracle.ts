/* GET /api/oracle[?symbol=]: the Session Oracle for every listed ticker, all read at one block (SDK
   oracleSnapshot), cached 30 s with one read in flight. The set of symbols is the configured ticker list; a
   `symbol` parameter only filters the cached answer and never causes a read of its own. Without a deployment the
   answer says the contracts are not deployed; a symbol that cannot be read carries its own error. */
import { tickers } from "@ballast/risk";
import { oracleSnapshot, sessionState, type ReadClient } from "@ballast/sdk";
import { toJson, ttlCache } from "../cache";
import type { DeploymentStatus } from "../deployment";
import { BusyError, readGate, withDeadline } from "../guard";
import { badRequest, query, symbolParam } from "../params";
import { shortMessage } from "../simulate";

export const ORACLE_TTL_MS = 30_000;
/** symbols read at the same time */
const CONCURRENCY = 6;

export type OracleBody =
  | { status: "ok"; chainId: number; blockNumber: string; at: number; session: unknown; symbols: unknown[] }
  | { status: "not-deployed"; detail: string }
  | { status: "unavailable"; detail: string };

export async function readOracle(c: ReadClient, s: Extract<DeploymentStatus, { ok: true }>): Promise<OracleBody> {
  const d = s.deployment;
  const session = await sessionState(c, d);
  const symbols: unknown[] = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    symbols.push(
      ...(await Promise.all(
        tickers.slice(i, i + CONCURRENCY).map(async (t) => {
          try {
            return toJson(await oracleSnapshot(c, d, t.symbol, { blockNumber: session.blockNumber }));
          } catch (err) {
            return { symbol: t.symbol, error: `snapshot unreadable: ${shortMessage(err)}` };
          }
        }),
      )),
    );
  }
  return { status: "ok", chainId: s.chainId, blockNumber: session.blockNumber.toString(), at: session.at, session: toJson(session), symbols };
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
      body = await cache.get(`${s.chainId}|${s.deployment.sessionOracle}`, () => readGate.run(() => withDeadline(readOracle(c, s))));
    } catch (err) {
      if (err instanceof BusyError) {
        return Response.json({ error: err.message }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "2" } });
      }
      body = { status: "unavailable", detail: `chain read failed: ${shortMessage(err)}` };
    }
  }
  if (symbol !== null && body.status === "ok") {
    body = { ...body, symbols: body.symbols.filter((x) => (x as { symbol?: unknown }).symbol === symbol) };
  }
  const headers = { "cache-control": body.status === "ok" ? "public, s-maxage=30, stale-while-revalidate=60" : "no-store" };
  return Response.json(body, { headers });
}
