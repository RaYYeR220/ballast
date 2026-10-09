import type { Metadata, Viewport } from "next";
import { OracleExplorer, type OracleInitial } from "@/components/oracle/OracleExplorer";
import { deployment, env, publicClient } from "@/lib/server/context";
import { withDeadline } from "@/lib/server/guard";
import { handleCandles, handlePrices } from "@/lib/server/handlers/market";
import { handleOracle } from "@/lib/server/handlers/oracle";
import { handleRwaStatus } from "@/lib/server/handlers/rwa";

export const metadata: Metadata = {
  title: "Session Oracle | Ballast",
  description:
    "Per-share prices of tokenized US stocks across bStocks, Ondo and xStocks, the New York session as the chain sees it, and the band a lending feed enforces while the market is closed, drawn against real hourly candles.",
};

export const viewport: Viewport = { themeColor: "#070f22" };

// prices, candles and the oracle are read per request (each behind its own cache)
export const dynamic = "force-dynamic";
export const preferredRegion = "cdg1";

/** How long the page waits for its first answers before it lets the browser fetch them instead. */
const FIRST_PAINT_MS = 3500;

async function first<T>(answer: Promise<Response>): Promise<T | null> {
  try {
    const res = await withDeadline(answer, FIRST_PAINT_MS);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export default async function OraclePage() {
  const e = env();
  const d = deployment(e);
  const c = publicClient(e);
  const [oracle, prices, rwa, candles] = await Promise.all([
    first<OracleInitial["oracle"]>(handleOracle(d, c)),
    first<OracleInitial["prices"]>(handlePrices(e, d, c)),
    first<OracleInitial["rwa"]>(handleRwaStatus()),
    first<OracleInitial["candles"]>(handleCandles(new Request("http://app.internal/api/market/candles?symbol=NVDA"), e, d, c)),
  ]);
  return <OracleExplorer initial={{ now: Math.floor(Date.now() / 1000), oracle, prices, rwa, candles }} />;
}
