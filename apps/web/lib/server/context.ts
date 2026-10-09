/* Shared server state for route handlers and the app page: environment, deployment and a viem public client. */
import { createPublicClient, http, type PublicClient } from "viem";
import { bsc, bscFork } from "@/lib/chains";
import type { AppChainId } from "@/lib/app-config";
import { resolveDeployment, type DeploymentStatus } from "./deployment";
import { serverEnv, type ServerEnv } from "./env";
import { LIMITS } from "./limits";

const DEPLOYMENT_TTL_MS = 60_000;

let deploymentMemo: { at: number; key: string; v: DeploymentStatus } | null = null;
let clientMemo: { key: string; v: PublicClient } | null = null;

export function env(): ServerEnv {
  return serverEnv();
}

export function deployment(e: ServerEnv = env()): DeploymentStatus {
  const key = `${e.chainId}|${process.env.DEPLOYMENT_JSON ?? ""}|${process.env.DEPLOYMENT_FILE ?? ""}`;
  if (deploymentMemo && deploymentMemo.key === key && Date.now() - deploymentMemo.at < DEPLOYMENT_TTL_MS) return deploymentMemo.v;
  const v = resolveDeployment({ chainId: e.chainId });
  deploymentMemo = { at: Date.now(), key, v };
  return v;
}

export function chainFor(chainId: AppChainId, rpc: string) {
  return chainId === 56 ? bsc : bscFork(rpc);
}

/** viem public client on BSC_RPC_URL; the URL may carry a provider key and never leaves the server. */
export function publicClient(e: ServerEnv = env()): PublicClient {
  const key = `${e.chainId}|${e.rpcUrl}`;
  if (clientMemo?.key === key) return clientMemo.v;
  const v = createPublicClient({
    chain: chainFor(e.chainId, e.rpcUrl),
    // every JSON-RPC request is aborted after LIMITS.rpcTimeoutMs; a batch carries at most 50 calls
    transport: http(e.rpcUrl, { timeout: LIMITS.rpcTimeoutMs, retryCount: 1, batch: { batchSize: 50, wait: 8 } }),
  }) as PublicClient;
  clientMemo = { key, v };
  return v;
}
