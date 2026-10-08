/* Server-only environment. Secrets (RPC URL with a provider key, Binance Web3 API key and secret) are read
   here and used only inside route handlers; nothing in this file may be imported by a client component. */
import type { Address } from "viem";
import { asAppChainId, checksum, type AppChainId } from "@/lib/app-config";

export interface ServerEnv {
  chainId: AppChainId;
  rpcUrl: string;
  /** Desk read API base URL without a trailing slash, or null. */
  agentApiUrl: string | null;
  binance: { apiKey: string; apiSecret: string } | null;
  deskAgent: Address | null;
  localRpcUrl: string | null;
}

const PUBLIC_BSC_RPC = "https://bsc-dataseed.bnbchain.org";
const LOCAL_RPC = "http://127.0.0.1:8545";

const text = (v: string | undefined) => {
  const t = v?.trim();
  return t ? t : undefined;
};

function httpUrl(raw: string | undefined): string | null {
  const v = text(raw);
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return v.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function serverEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const chainId = asAppChainId(env.NEXT_PUBLIC_CHAIN_ID ?? env.CHAIN_ID);
  const key = text(env.BINANCE_WEB3_API_KEY);
  const secret = text(env.BINANCE_WEB3_API_SECRET);
  return {
    chainId,
    rpcUrl: httpUrl(env.BSC_RPC_URL) ?? (chainId === 56 ? PUBLIC_BSC_RPC : LOCAL_RPC),
    agentApiUrl: httpUrl(env.AGENT_API_URL),
    binance: key && secret ? { apiKey: key, apiSecret: secret } : null,
    deskAgent: checksum(env.DESK_AGENT_ADDRESS ?? env.NEXT_PUBLIC_DESK_AGENT),
    localRpcUrl: chainId === 31337 ? (httpUrl(env.NEXT_PUBLIC_LOCAL_RPC_URL) ?? LOCAL_RPC) : null,
  };
}
