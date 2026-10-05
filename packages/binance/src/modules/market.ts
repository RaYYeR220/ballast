import type { Web3Client } from "../client";

export interface CandlesQuery {
  binanceChainId: string;
  tokenContractAddress: string;
  bar?: string;
  after?: string;
  before?: string;
  limit?: number;
}
export interface TokenSearchQuery { chains: string; search: string }

export const candles = (c: Web3Client, q: CandlesQuery) => c.get<unknown[]>("/api/v1/dex/market/candles", { ...q });
export const price = (c: Web3Client, body: unknown) => c.post<unknown[]>("/api/v1/dex/market/price", body, { idempotent: true });
export const tokenSearch = (c: Web3Client, q: TokenSearchQuery) => c.get<unknown[]>("/api/v1/dex/market/token/search", { ...q });
