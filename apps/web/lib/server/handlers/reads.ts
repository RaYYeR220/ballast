/* GET handlers for the app's chain reads: /api/accounts?owner=, /api/loans?user=, /api/markets, /api/token. */
import { Web3Client, defi } from "@ballast/binance";
import { bscExternal, type ReadClient } from "@ballast/sdk";
import { getAddress, isAddress, type Address } from "viem";
import type { DeploymentStatus } from "../deployment";
import { ttlCache } from "../cache";
import type { ServerEnv } from "../env";
import { readAccounts, readLoans, readMarkets, readToken } from "../reads";
import { shortMessage } from "../simulate";
import type { MarketView } from "@/lib/views";

const NO_STORE = { "cache-control": "no-store" };
const bad = (error: string) => Response.json({ error }, { status: 400, headers: NO_STORE });

function addressParam(req: Request, name: string): Address | Response {
  const v = new URL(req.url).searchParams.get(name);
  if (!v || !isAddress(v, { strict: false })) return bad(`${name} must be a 0x address`);
  return getAddress(v);
}

export async function handleAccounts(req: Request, s: DeploymentStatus, c: ReadClient): Promise<Response> {
  const owner = addressParam(req, "owner");
  if (owner instanceof Response) return owner;
  if (!s.ok) return Response.json({ status: "not-deployed", detail: s.detail }, { headers: NO_STORE });
  try {
    const r = await readAccounts(c, s.deployment, owner);
    return Response.json({ status: "ok", chainId: s.chainId, ...r }, { headers: NO_STORE });
  } catch (err) {
    return Response.json({ status: "unavailable", detail: `chain read failed: ${shortMessage(err)}` }, { headers: NO_STORE });
  }
}

export interface DefiSummary {
  status: "ok" | "unavailable" | "not-configured";
  protocols: { id: string; valueUsd: string }[];
  detail?: string;
}

/** Per-protocol totals from the DeFi API's nested position list (addressList > protocolList). */
export function summarizeDefi(data: unknown): { id: string; valueUsd: string }[] {
  const out: { id: string; valueUsd: string }[] = [];
  const addrs = (data as { addressList?: unknown })?.addressList;
  if (!Array.isArray(addrs)) return out;
  for (const a of addrs) {
    const list = (a as { protocolList?: unknown })?.protocolList;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      const id = (p as { defiProtocolId?: unknown })?.defiProtocolId;
      const v = (p as { protocolTotalValue?: unknown })?.protocolTotalValue;
      if (typeof id === "string" || typeof id === "number") out.push({ id: String(id), valueUsd: typeof v === "string" ? v : String(v ?? "") });
    }
  }
  return out;
}

async function defiPositions(e: ServerEnv, user: Address, fetchImpl?: typeof fetch): Promise<DefiSummary> {
  if (!e.binance || e.chainId !== 56) return { status: "not-configured", protocols: [] };
  try {
    const web3 = new Web3Client({ apiKey: e.binance.apiKey, apiSecret: e.binance.apiSecret, probe: () => {}, fetch: fetchImpl, timeoutMs: 8000, maxRetries: 1 });
    return { status: "ok", protocols: summarizeDefi(await defi.positions(web3, [user], ["56"])) };
  } catch (err) {
    return { status: "unavailable", protocols: [], detail: shortMessage(err) };
  }
}

/** The wallet's own Lista/Venus loans, read on chain; the Binance DeFi API adds its position summary when keyed. */
export async function handleLoans(req: Request, e: ServerEnv, c: ReadClient, fetchImpl?: typeof fetch): Promise<Response> {
  const user = addressParam(req, "user");
  if (user instanceof Response) return user;
  const [chain, defiSummary] = await Promise.all([
    readLoans(c, bscExternal(), user).then(
      (r) => ({ ok: true as const, r }),
      (err) => ({ ok: false as const, detail: `chain read failed: ${shortMessage(err)}` }),
    ),
    defiPositions(e, user, fetchImpl),
  ]);
  if (!chain.ok) return Response.json({ status: "unavailable", detail: chain.detail, defi: defiSummary }, { headers: NO_STORE });
  return Response.json({ status: "ok", chainId: e.chainId, ...chain.r, defi: defiSummary }, { headers: NO_STORE });
}

const marketsCache = ttlCache<MarketView[]>(10 * 60_000);

export async function handleMarkets(e: ServerEnv, c: ReadClient): Promise<Response> {
  try {
    const markets = await marketsCache.get(String(e.chainId), () => readMarkets(c, bscExternal()));
    return Response.json({ status: "ok", markets }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
  } catch (err) {
    return Response.json({ status: "unavailable", detail: shortMessage(err) }, { headers: NO_STORE });
  }
}

export async function handleToken(req: Request, c: ReadClient): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const token = addressParam(req, "token");
  if (token instanceof Response) return token;
  const owner = addressParam(req, "owner");
  if (owner instanceof Response) return owner;
  const sp = q.get("spender");
  if (sp && !isAddress(sp, { strict: false })) return bad("spender must be a 0x address");
  try {
    const t = await readToken(c, token, owner, sp ? getAddress(sp) : null);
    return Response.json({ status: "ok", ...t }, { headers: NO_STORE });
  } catch (err) {
    return Response.json({ status: "unavailable", detail: shortMessage(err) }, { headers: NO_STORE });
  }
}
