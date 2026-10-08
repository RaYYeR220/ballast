/* The /api/simulate contract, shared by the route handler and the app. */

export interface SimError {
  name: string;
  message: string;
  args?: string[];
  /** Session Oracle reason for RestoreRefused */
  reason?: string;
}

export interface SimResult {
  /** binance: the Binance Transaction API simulated it; rpc: eth_call on our BNB Chain RPC */
  via: "binance" | "rpc";
  ok: boolean;
  error?: SimError;
  note?: string;
  balanceChanges?: { contractAddress: string; tokenType: string; change: string; owner: string }[];
}

export interface SimRequest {
  from: string;
  to: string;
  data: string;
  value?: string;
}

export const SIMULATOR_NAME: Record<SimResult["via"], string> = {
  binance: "Binance Transaction API",
  rpc: "eth_call on BNB Chain",
};

/** POSTs one transaction to /api/simulate. Throws when the simulator itself is unavailable. */
export async function requestSimulation(req: SimRequest, f: typeof fetch = fetch): Promise<SimResult> {
  const res = await f("/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const body = (await res.json().catch(() => null)) as (SimResult & { error?: unknown }) | { error: string } | null;
  if (!res.ok || !body || !("via" in body)) {
    const msg = body && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}
