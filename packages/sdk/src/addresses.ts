import { getAddress, isAddress, type Address } from "viem";
import { bscConfig } from "@ballast/risk";

/** Addresses of the protocols Ballast builds on (from config/bsc-mainnet.json). */
export interface ExternalAddresses {
  /** ERC-8183 AgenticCommerce kernel (APEX). */
  kernel: Address;
  moolah: Address;
  comptroller: Address;
  venusOracle: Address;
  identityRegistry: Address;
  reputationRegistry: Address;
  pancakeV3Router: Address;
  tokens: Record<string, Address>;
}

/** One Ballast deployment: contracts/deployments/<chainId>.json plus the external addresses. */
export interface Deployment {
  chainId: number;
  calendar: Address;
  sessionOracle: Address;
  sessionAwareFeed: Address;
  factory: Address;
  listaImpl: Address;
  venusImpl: Address;
  cushionVault: Address;
  guardian: Address;
  /** Deployer and owner of the Ownable contracts, if recorded. */
  owner: Address | null;
  /** Block of the deployment, the lower bound for log scans. */
  block: number;
  external: ExternalAddresses;
}

export const DEPLOYMENT_KEYS = [
  "calendar",
  "sessionOracle",
  "sessionAwareFeed",
  "factory",
  "listaImpl",
  "venusImpl",
  "cushionVault",
  "guardian",
] as const;

/** Chains whose external addresses are BSC mainnet's: the chain itself and a local fork of it. */
const BSC_LIKE = new Set([56, 31337]);

function address(json: Record<string, unknown>, key: string, where: string): Address {
  const v = json[key];
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${where}: missing or invalid address "${key}"`);
  return getAddress(v);
}

/** External addresses for BSC mainnet (also used for an anvil fork of it). */
export function bscExternal(): ExternalAddresses {
  const tokens: Record<string, Address> = {};
  for (const [k, v] of Object.entries(bscConfig.tokens)) tokens[k] = getAddress(v);
  return {
    kernel: getAddress(bscConfig.erc8183.kernel),
    moolah: getAddress(bscConfig.lista.moolah),
    comptroller: getAddress(bscConfig.venus.comptroller),
    venusOracle: getAddress(bscConfig.venus.oracle),
    identityRegistry: getAddress(bscConfig.erc8004.identity),
    reputationRegistry: getAddress(bscConfig.erc8004.reputation),
    pancakeV3Router: getAddress(bscConfig.pancake.v3SwapRouter),
    tokens,
  };
}

/** Validates a deployment JSON object. Off BSC (56) and its fork (31337) pass `external` explicitly. */
export function parseDeployment(chainId: number, json: unknown, external?: ExternalAddresses): Deployment {
  const where = `deployment ${chainId}`;
  if (!json || typeof json !== "object") throw new Error(`${where}: not an object`);
  const j = json as Record<string, unknown>;
  if (!external && !BSC_LIKE.has(chainId)) throw new Error(`${where}: no external addresses known for this chain, pass them`);
  const block = Number(j.block ?? 0);
  if (!Number.isSafeInteger(block) || block < 0) throw new Error(`${where}: invalid block`);
  const out = { chainId, block, owner: j.owner === undefined ? null : address(j, "owner", where) } as Deployment;
  for (const k of DEPLOYMENT_KEYS) out[k] = address(j, k, where);
  out.external = external ?? bscExternal();
  return out;
}

/**
 * Reads contracts/deployments/<chainId>.json from this repository, or `opts.file`.
 * Node only (uses the fs builtin lazily so browser bundles that never call it still build).
 */
export function loadDeployment(chainId: number, opts: { file?: string; external?: ExternalAddresses } = {}): Deployment {
  const fs = process.getBuiltinModule("node:fs");
  const file = opts.file ?? new URL(`../../../contracts/deployments/${chainId}.json`, import.meta.url);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`no deployment for chain ${chainId} at ${String(file)}: ${(err as Error).message}`);
  }
  return parseDeployment(chainId, JSON.parse(raw), opts.external);
}
