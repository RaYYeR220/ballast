// The desk's viem clients. The SDK pins each read to the head block number; viem caches getBlockNumber for
// 4 s by default, which would let the keeper's pre-send re-read see the state it planned on. cacheTime 0
// makes every pin a fresh head.
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { DESK_CHAINS, type DeskConfig } from "./config";

export function deskChain(config: Pick<DeskConfig, "chainId" | "rpcUrl">): Chain {
  return defineChain({
    id: config.chainId,
    name: DESK_CHAINS[config.chainId],
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl.reveal()] } },
  });
}

export function deskPublicClient(config: Pick<DeskConfig, "chainId" | "rpcUrl">): PublicClient {
  return createPublicClient({
    chain: deskChain(config),
    transport: http(config.rpcUrl.reveal(), { batch: { wait: 10 }, retryCount: 2 }),
    cacheTime: 0,
    pollingInterval: 1_000,
  });
}
