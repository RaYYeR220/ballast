import type { Web3Client } from "../client";

export interface AllTokenBalancesQuery {
  address: string;
  /** Single chain only: the API rejects comma-separated lists. */
  chains?: string;
  excludeRiskToken?: boolean;
  page?: number;
  pageSize?: number;
}
export interface TxDetailQuery { binanceChainId: string; txHash: string; itype?: string }

export const allTokenBalances = (c: Web3Client, q: AllTokenBalancesQuery) => c.get<unknown>("/api/v1/dex/balance/all-token-balances-by-address", { ...q });
export const txDetail = (c: Web3Client, q: TxDetailQuery) => c.get<unknown>("/api/v1/dex/post-transaction/transaction-detail-by-txhash", { ...q });
