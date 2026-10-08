/* GET /api/rwa-status: Binance's keyless RWA market status (the US session as Binance sees it) and the status of
   each listed bStock, cached 60 s. A failed read is reported as unavailable, per asset or as a whole. */
import { PublicRwaClient, type AssetStatus, type MarketStatus } from "@ballast/binance";
import { tickers } from "@ballast/risk";
import { ttlCache } from "../cache";
import { shortMessage } from "../simulate";

export const RWA_TTL_MS = 60_000;
const BSC_CHAIN = "56";

export interface RwaAsset {
  symbol: string;
  token: string;
  status: AssetStatus | null;
  error?: string;
}

export type RwaStatusBody =
  | { status: "ok"; fetchedAt: number; market: MarketStatus; assets: RwaAsset[] }
  | { status: "unavailable"; detail: string };

export async function readRwaStatus(client: Pick<PublicRwaClient, "marketStatus" | "assetStatus">, now = Date.now): Promise<RwaStatusBody> {
  const [market, ...assets] = await Promise.allSettled([
    client.marketStatus(),
    ...tickers.map((t) => client.assetStatus(BSC_CHAIN, t.bStock)),
  ]);
  if (market!.status === "rejected") return { status: "unavailable", detail: `Binance RWA market status unavailable: ${shortMessage(market!.reason)}` };
  return {
    status: "ok",
    fetchedAt: Math.floor(now() / 1000),
    market: market!.value as MarketStatus,
    assets: tickers.map((t, i) => {
      const r = assets[i]!;
      return r.status === "fulfilled"
        ? { symbol: t.symbol, token: t.bStock, status: r.value as AssetStatus }
        : { symbol: t.symbol, token: t.bStock, status: null, error: shortMessage(r.reason) };
    }),
  };
}

const cache = ttlCache<RwaStatusBody>(RWA_TTL_MS);
const client = new PublicRwaClient({ probe: () => {}, timeoutMs: 8000 });

export async function handleRwaStatus(c: Pick<PublicRwaClient, "marketStatus" | "assetStatus"> = client): Promise<Response> {
  let body: RwaStatusBody;
  try {
    body = await cache.get("rwa", async () => {
      const r = await readRwaStatus(c);
      if (r.status !== "ok") throw Object.assign(new Error(r.detail), { body: r });
      return r;
    });
  } catch (err) {
    body = (err as { body?: RwaStatusBody }).body ?? { status: "unavailable", detail: shortMessage(err) };
  }
  const headers = { "cache-control": body.status === "ok" ? "public, s-maxage=60, stale-while-revalidate=120" : "no-store" };
  return Response.json(body, { headers });
}
