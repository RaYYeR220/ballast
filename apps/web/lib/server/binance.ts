/* The keyed Binance Web3 API client, one per instance. Its limiter (five requests a second per endpoint) and
   its retries only mean something when every route shares the same client, so nothing else constructs one. */
import { Web3Client } from "@ballast/binance";
import type { ServerEnv } from "./env";
import { LIMITS } from "./limits";

let shared: { key: string; client: Web3Client } | null = null;

const make = (e: NonNullable<ServerEnv["binance"]>, fetchImpl?: typeof fetch) =>
  new Web3Client({ apiKey: e.apiKey, apiSecret: e.apiSecret, probe: () => {}, fetch: fetchImpl, timeoutMs: LIMITS.rpcTimeoutMs, maxRetries: 1 });

/** Null without credentials. `fetchImpl` is for tests and gets a client of its own. */
export function web3Client(e: ServerEnv, fetchImpl?: typeof fetch): Web3Client | null {
  if (!e.binance) return null;
  if (fetchImpl) return make(e.binance, fetchImpl);
  if (shared?.key !== e.binance.apiKey) shared = { key: e.binance.apiKey, client: make(e.binance) };
  return shared.client;
}

/** Binance's own chain id for BNB Chain; its APIs know mainnet state only, never a fork. */
export const BINANCE_BSC = "56";

/** A Binance failure as one short line without request details: "40375 Minimum order amount is 5 USD." */
export function binanceMessage(err: unknown): string {
  const e = err as { code?: unknown; serverMessage?: unknown; message?: unknown };
  if (typeof e?.code === "string" && typeof e?.serverMessage === "string") return `${e.code} ${e.serverMessage}`.slice(0, 200);
  return (typeof e?.message === "string" ? e.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
}
