/* What the server tells the app shell about where it runs. Safe for client bundles: no node imports. */
import { getAddress, isAddress, type Address } from "viem";

export type AppChainId = 56 | 31337;

/** contracts/deployments/<chainId>.json with addresses checksummed and bigints as strings. */
export interface DeploymentJson {
  chainId: number;
  calendar: Address;
  sessionOracle: Address;
  sessionAwareFeed: Address;
  factory: Address;
  listaImpl: Address;
  venusImpl: Address;
  cushionVault: Address;
  guardian: Address;
  owner: Address | null;
  block: number;
  guardianStartJobId?: string;
}

export type DeploymentInfo =
  | { status: "ok"; json: DeploymentJson; source: string }
  | { status: "missing" | "invalid"; detail: string };

export interface AppConfig {
  chainId: AppChainId;
  deployment: DeploymentInfo;
  /** Desk agent address from the environment; the desk's own /health may supply it at runtime instead. */
  deskAgent: Address | null;
  /** AGENT_API_URL is set (reachability is checked per request). */
  deskConfigured: boolean;
  /** RPC the wallet uses for the local fork chain (31337 only). */
  localRpcUrl: string | null;
}

export const CHAIN_NAME: Record<AppChainId, string> = { 56: "BNB Chain", 31337: "BNB Chain fork (local)" };

export function asAppChainId(raw: string | undefined): AppChainId {
  return raw?.trim() === "31337" ? 31337 : 56;
}

export function checksum(raw: string | null | undefined): Address | null {
  const v = raw?.trim();
  return v && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

/** BscScan link for mainnet; a local fork has no explorer. */
export function txUrl(chainId: number, hash: string): string | null {
  return chainId === 56 ? `https://bscscan.com/tx/${hash}` : null;
}

export function addressUrl(chainId: number, address: string): string | null {
  return chainId === 56 ? `https://bscscan.com/address/${address}` : null;
}
