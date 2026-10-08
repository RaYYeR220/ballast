/* Chain definitions for viem and wagmi, written out so the bundle does not pull in viem's whole chain list. */
import { defineChain } from "viem";

const MULTICALL3 = { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as const, blockCreated: 15921452 };

export const bsc = defineChain({
  id: 56,
  name: "BNB Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: { default: { http: ["https://bsc-dataseed.bnbchain.org"] } },
  blockExplorers: { default: { name: "BscScan", url: "https://bscscan.com" } },
  contracts: { multicall3: MULTICALL3 },
});

/** A local anvil fork of BNB Chain (chain id 31337). */
export const bscFork = (rpc: string) =>
  defineChain({
    id: 31337,
    name: "BNB Chain fork (local)",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    contracts: { multicall3: { address: MULTICALL3.address } },
  });
