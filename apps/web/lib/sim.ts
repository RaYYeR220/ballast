/* The /api/simulate contract, shared by the route handler and the app. */
import { formatUnits } from "viem";
import { tokenSymbol } from "./markets";

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
  allowanceChanges?: { tokenAddress: string; owner: string; spender: string; preAmount: string; postAmount: string }[];
}

export interface SimRequest {
  from: string;
  to: string;
  data: string;
  value?: string;
  /** for a transaction the server built itself (a swap): the ticket it came with */
  ticket?: string;
}

export const SIMULATOR_NAME: Record<SimResult["via"], string> = {
  binance: "Binance Transaction API",
  rpc: "eth_call on BNB Chain",
};

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/**
 * What the Binance simulation says the sender's balances change by, e.g. "Your wallet: -5.5 USDT, +0.0149 TSLAB".
 * Only tokens this app knows are named (all 18 decimals on BNB Chain, like BNB itself); the simulator reports
 * raw token units. Empty when the simulator gave no balance changes (eth_call gives none).
 */
export function balanceChangeText(sim: Pick<SimResult, "balanceChanges" | "allowanceChanges">, owner: string): string {
  const parts: string[] = [];
  for (const c of sim.balanceChanges ?? []) {
    if (c.owner?.toLowerCase() !== owner.toLowerCase()) continue;
    const symbol = c.contractAddress?.toLowerCase() === NATIVE ? "BNB" : tokenSymbol(c.contractAddress ?? "");
    if (!symbol || !/^-?\d+$/.test(c.change ?? "")) continue;
    const raw = BigInt(c.change);
    if (raw === 0n) continue;
    const n = Number(formatUnits(raw < 0n ? -raw : raw, 18));
    const amount = n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });
    if (amount === "0") continue; // dust below a millionth of a token is not worth a line
    parts.push(`${raw < 0n ? "-" : "+"}${amount} ${symbol}`);
    if (parts.length === 4) break;
  }
  const out = parts.length > 0 ? [`Your wallet: ${parts.join(", ")}`] : [];
  // an approval moves no tokens: what changes is how much the spender may pull
  for (const a of (sim.allowanceChanges ?? []).slice(0, 2)) {
    const symbol = tokenSymbol(a.tokenAddress ?? "");
    if (a.owner?.toLowerCase() !== owner.toLowerCase() || !symbol || !/^\d+$/.test(a.postAmount ?? "")) continue;
    const n = Number(formatUnits(BigInt(a.postAmount), 18));
    const amount = n > 1e15 ? "an unlimited amount of" : n.toLocaleString("en-US", { maximumFractionDigits: 6 });
    out.push(`Allowance after: ${amount} ${symbol} for ${a.spender.slice(0, 6)}...${a.spender.slice(-4)}`);
  }
  return out.join(". ");
}

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
