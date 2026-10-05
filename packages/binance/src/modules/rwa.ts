import type { Web3Client } from "../client";

export interface RwaPrice { platformId: string; tokenContractAddress?: string; tokenPrice: string; referencePrice: string; tokenPriceUpdatedAt: number }
export type PlatformId = "ondo" | "bstock";

export const platforms = (c: Web3Client, platformId?: PlatformId) => c.get<unknown[]>("/api/v1/dex/market/rwa/platforms", { platformId });
export const price = (c: Web3Client, binanceChainId: string, addresses: string[]) => {
  if (addresses.length > 100) throw new RangeError(`at most 100 token addresses per request, got ${addresses.length}`);
  return c.get<RwaPrice[]>("/api/v1/dex/market/rwa/price", { binanceChainId, tokenContractAddresses: addresses.join(",") });
};
export const search = (c: Web3Client, keyword: string, platformId?: PlatformId) => c.get<unknown[]>("/api/v1/dex/market/rwa/search", { keyword, platformId });
export const underlyingProfile = (c: Web3Client, binanceChainId: string, tokenContractAddress: string) =>
  c.get<unknown>("/api/v1/dex/market/rwa/underlying-profile", { binanceChainId, tokenContractAddress });
export const tokens = (c: Web3Client, q: { binanceChainId?: string; platformId?: PlatformId; tabId?: number } = {}) =>
  c.get<unknown[]>("/api/v1/dex/market/rwa/tokens", q);
export const underlyingMarket = (c: Web3Client, binanceChainId: string, tokenContractAddress: string) =>
  c.get<unknown>("/api/v1/dex/market/rwa/underlying-market", { binanceChainId, tokenContractAddress });
