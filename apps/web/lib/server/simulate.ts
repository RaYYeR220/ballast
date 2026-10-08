/* Simulation before every send. On BSC mainnet with BINANCE_WEB3_API_KEY/SECRET set, the Binance Transaction API
   simulates first; a failure there is replayed with eth_call for the decoded Ballast error, and when the two
   disagree eth_call against the head decides. Without keys, on the fork, or when Binance is unavailable,
   eth_call on our RPC runs. The answer always says which one ran. */
import type { transaction } from "@ballast/binance";
import { decodeBallastError, isRevert } from "@ballast/sdk";
import type { Address, Hex } from "viem";
import type { SimError, SimResult } from "@/lib/sim";

export interface SimTx {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
}

type BinanceSimulation = Awaited<ReturnType<typeof transaction.simulate>>;

export interface SimulateDeps {
  chainId: number;
  /** eth_call from `from`; throws on revert (viem error) or on transport failure. */
  call(tx: SimTx): Promise<unknown>;
  /** Keyed Binance Transaction API simulate; null when no keys are configured. */
  binance: ((body: Parameters<typeof transaction.simulate>[1]) => Promise<BinanceSimulation>) | null;
}

const BINANCE_BSC = "56";

const stringify = (v: unknown): string =>
  typeof v === "bigint" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** One line from a viem error: its short message, long hex elided. */
export function shortMessage(err: unknown): string {
  const e = (err ?? {}) as { shortMessage?: unknown; message?: unknown };
  let m = typeof e.shortMessage === "string" ? e.shortMessage : typeof e.message === "string" ? e.message : String(err);
  m = m.replace(/0x[0-9a-fA-F]{120,}/g, (h) => `0x[${h.length - 2} hex chars]`).replace(/\s+/g, " ").trim();
  return m.length > 300 ? `${m.slice(0, 300)}...` : m;
}

/** A revert as a SimError, or null when `err` is not a revert (RPC or network failure). */
export function revertError(err: unknown): SimError | null {
  const d = decodeBallastError(err);
  if (d) return { name: d.name, message: d.message, args: d.args.map(stringify), ...(d.reason ? { reason: d.reason } : {}) };
  if (isRevert(err)) return { name: "Reverted", message: shortMessage(err) };
  return null;
}

async function rpc(tx: SimTx, deps: SimulateDeps): Promise<SimResult> {
  try {
    await deps.call(tx);
    return { via: "rpc", ok: true };
  } catch (err) {
    const error = revertError(err);
    if (!error) throw err;
    return { via: "rpc", ok: false, error };
  }
}

export async function simulateTx(tx: SimTx, deps: SimulateDeps): Promise<SimResult> {
  const binance = deps.chainId === 56 ? deps.binance : null;
  if (!binance) return rpc(tx, deps);
  let r: BinanceSimulation;
  try {
    r = await binance({ binanceChainId: BINANCE_BSC, evmTx: { from: tx.from, to: tx.to, value: tx.value.toString(), data: tx.data } });
  } catch (err) {
    const sim = await rpc(tx, deps);
    return { ...sim, note: `Binance simulation unavailable, eth_call ran instead (${shortMessage(err)})` };
  }
  if (r.status === "SUCCESS") {
    return { via: "binance", ok: true, balanceChanges: r.balanceChanges ?? [] };
  }
  const reason = r.failReason ?? "simulation failed";
  let replay: SimResult;
  try {
    replay = await rpc(tx, deps);
  } catch {
    return { via: "binance", ok: false, error: { name: "SimulationFailed", message: reason } };
  }
  if (replay.ok) return { via: "rpc", ok: true, note: `Binance reported a failure (${reason}) but eth_call at the head succeeded` };
  return { via: "binance", ok: false, error: replay.error ?? { name: "SimulationFailed", message: reason } };
}
