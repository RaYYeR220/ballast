/* Server-only environment. Secrets (RPC URL with a provider key, Binance Web3 API key and secret) are read
   here and used only inside route handlers; nothing in this file may be imported by a client component.
   `envProblems` lists what is wrong with the configuration in words that never repeat a value, and the server
   refuses to start on any of them (instrumentation.ts). */
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

/** Ballast on BNB Chain mainnet: the desk agent that keeps accounts and publishes overlays, and the deployer. */
export const MAINNET = {
  deskAgent: "0xccD7f069275549793b2A8804A5691fCa6665D152",
  /** the desk's ERC-8004 identity */
  deskAgentId: 368122n,
  owner: "0xE507125d7F8aE8f482B9F55a1b07Abe58b2564Bf",
} as const satisfies { deskAgent: Address; deskAgentId: bigint; owner: Address };

/** a public endpoint that accepts batched eth_call (the dataseed nodes reject batches) */
const PUBLIC_BSC_RPC = "https://bsc-rpc.publicnode.com";
const LOCAL_RPC = "http://127.0.0.1:8545";

type Env = Record<string, string | undefined>;

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

export function serverEnv(env: Env = process.env): ServerEnv {
  const chainId = asAppChainId(env.NEXT_PUBLIC_CHAIN_ID ?? env.CHAIN_ID);
  const key = text(env.BINANCE_WEB3_API_KEY);
  const secret = text(env.BINANCE_WEB3_API_SECRET);
  return {
    chainId,
    rpcUrl: httpUrl(env.BSC_RPC_URL) ?? (chainId === 56 ? PUBLIC_BSC_RPC : LOCAL_RPC),
    agentApiUrl: httpUrl(env.AGENT_API_URL),
    binance: key && secret ? { apiKey: key, apiSecret: secret } : null,
    // on mainnet the keeper is the known desk agent unless the environment names another; a fork has no default
    deskAgent: checksum(env.DESK_AGENT_ADDRESS ?? env.NEXT_PUBLIC_DESK_AGENT) ?? (chainId === 56 ? MAINNET.deskAgent : null),
    localRpcUrl: chainId === 31337 ? (httpUrl(env.NEXT_PUBLIC_LOCAL_RPC_URL) ?? LOCAL_RPC) : null,
  };
}

/**
 * Everything wrong with the environment, one line each, naming the variable and the rule but never the value
 * (several of them are secrets). Unset variables are fine: each has a documented default or an explicit state.
 */
export function envProblems(env: Env = process.env): string[] {
  const out: string[] = [];
  const chain = text(env.NEXT_PUBLIC_CHAIN_ID ?? env.CHAIN_ID);
  if (chain !== undefined && chain !== "56" && chain !== "31337") out.push("NEXT_PUBLIC_CHAIN_ID: must be 56 (BNB Chain) or 31337 (a local fork)");
  for (const name of ["BSC_RPC_URL", "AGENT_API_URL", "NEXT_PUBLIC_LOCAL_RPC_URL"] as const) {
    if (text(env[name]) !== undefined && httpUrl(env[name]) === null) out.push(`${name}: must be an http(s) URL`);
  }
  for (const name of ["DESK_AGENT_ADDRESS", "NEXT_PUBLIC_DESK_AGENT"] as const) {
    if (text(env[name]) !== undefined && checksum(env[name]) === null) out.push(`${name}: must be a 0x address of 40 hex characters`);
  }
  const key = text(env.BINANCE_WEB3_API_KEY);
  const secret = text(env.BINANCE_WEB3_API_SECRET);
  if (!!key !== !!secret) out.push("BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET: set both or neither");
  if (text(env.DEPLOYMENT_JSON) !== undefined && text(env.DEPLOYMENT_FILE) !== undefined) out.push("DEPLOYMENT_JSON and DEPLOYMENT_FILE: set one, not both");
  return out;
}

/** One line that is safe to log: which sources are configured, never their values. */
export function describeEnv(env: Env = process.env): string {
  const e = serverEnv(env);
  return [
    `chain=${e.chainId}`,
    `rpc=${text(env.BSC_RPC_URL) ? "configured" : "default public endpoint"}`,
    `desk=${e.agentApiUrl ? "configured" : "none"}`,
    `deskAgent=${text(env.DESK_AGENT_ADDRESS ?? env.NEXT_PUBLIC_DESK_AGENT) ? "configured" : e.deskAgent ? "mainnet default" : "from the desk"}`,
    `binance=${e.binance ? "keyed" : "keyless"}`,
    `deployment=${text(env.DEPLOYMENT_JSON) ? "DEPLOYMENT_JSON" : text(env.DEPLOYMENT_FILE) ? "DEPLOYMENT_FILE" : "repository file"}`,
  ].join(" ");
}
