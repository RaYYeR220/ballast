/* POST /api/simulate: { from, to, data, value? } -> SimResult. The Binance key and the RPC URL stay server-side. */
import { Web3Client, transaction } from "@ballast/binance";
import { getAddress, isAddress, isHex, type Hex, type PublicClient } from "viem";
import type { ServerEnv } from "../env";
import { readCapped, TooLargeError } from "../guard";
import { LIMITS } from "../limits";
import { shortMessage, simulateTx, type SimulateDeps } from "../simulate";

const noProbe = () => {};

export function simulateDeps(e: ServerEnv, client: Pick<PublicClient, "call">, fetchImpl?: typeof fetch): SimulateDeps {
  const web3 = e.binance
    ? new Web3Client({ apiKey: e.binance.apiKey, apiSecret: e.binance.apiSecret, probe: noProbe, fetch: fetchImpl, timeoutMs: LIMITS.rpcTimeoutMs, maxRetries: 1 })
    : null;
  return {
    chainId: e.chainId,
    call: (tx) => client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value }),
    binance: web3 ? (body) => transaction.simulate(web3, body) : null,
  };
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

export async function handleSimulate(req: Request, deps: SimulateDeps): Promise<Response> {
  // the body is read only up to the limit: a declared or streamed body beyond it is refused, not buffered
  let text: string;
  try {
    text = await readCapped(req, LIMITS.bodyBytes);
  } catch (err) {
    if (err instanceof TooLargeError) return Response.json({ error: "request too large" }, { status: 413, headers: { "cache-control": "no-store" } });
    return bad("unreadable request body");
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("expected a JSON object");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("expected a JSON object");
  }
  const { from, to, data } = body;
  const value = body.value ?? "0";
  if (typeof from !== "string" || !isAddress(from, { strict: false })) return bad("from must be a 0x address");
  if (typeof to !== "string" || !isAddress(to, { strict: false })) return bad("to must be a 0x address");
  if (typeof data !== "string" || !isHex(data) || data.length % 2 !== 0) return bad("data must be 0x hex");
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) return bad("value must be a decimal string of wei");
  try {
    const r = await simulateTx({ from: getAddress(from), to: getAddress(to), data: data as Hex, value: BigInt(value) }, deps);
    return Response.json(r, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: `simulation unavailable: ${shortMessage(err)}` }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
