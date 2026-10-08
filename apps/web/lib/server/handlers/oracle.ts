/* GET /api/oracle: the Session Oracle for every listed ticker, all read at one block (SDK oracleSnapshot),
   cached 30 s. Without a deployment the answer says the contracts are not deployed; a symbol that cannot be
   read carries its own error instead of a number. */
import { tickers } from "@ballast/risk";
import { oracleSnapshot, sessionState, type ReadClient } from "@ballast/sdk";
import type { DeploymentStatus } from "../deployment";
import { toJson, ttlCache } from "../cache";
import { shortMessage } from "../simulate";

export const ORACLE_TTL_MS = 30_000;

export type OracleBody =
  | { status: "ok"; chainId: number; blockNumber: string; at: number; session: unknown; symbols: unknown[] }
  | { status: "not-deployed"; detail: string }
  | { status: "unavailable"; detail: string };

export async function readOracle(c: ReadClient, s: Extract<DeploymentStatus, { ok: true }>): Promise<OracleBody> {
  const d = s.deployment;
  const session = await sessionState(c, d);
  const symbols = await Promise.all(
    tickers.map(async (t) => {
      try {
        return toJson(await oracleSnapshot(c, d, t.symbol, { blockNumber: session.blockNumber }));
      } catch (err) {
        return { symbol: t.symbol, error: `snapshot unreadable: ${shortMessage(err)}` };
      }
    }),
  );
  return { status: "ok", chainId: s.chainId, blockNumber: session.blockNumber.toString(), at: session.at, session: toJson(session), symbols };
}

const cache = ttlCache<OracleBody>(ORACLE_TTL_MS);

export async function handleOracle(s: DeploymentStatus, c: ReadClient): Promise<Response> {
  let body: OracleBody;
  if (!s.ok) body = { status: "not-deployed", detail: s.detail };
  else {
    try {
      body = await cache.get(`${s.chainId}|${s.deployment.sessionOracle}`, () => readOracle(c, s));
    } catch (err) {
      body = { status: "unavailable", detail: `chain read failed: ${shortMessage(err)}` };
    }
  }
  const headers = { "cache-control": body.status === "ok" ? "public, s-maxage=30, stale-while-revalidate=60" : "no-store" };
  return Response.json(body, { headers });
}
