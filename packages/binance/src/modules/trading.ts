import type { Web3Client } from "../client";

export interface QuoteQuery {
  binanceChainId: string;
  amount: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  userWalletAddress?: string;
  vendor?: string;
}
export interface SwapQuery extends QuoteQuery { userWalletAddress: string; quoteId: string; slippagePercent?: string }

export const quote = (c: Web3Client, q: QuoteQuery) => c.get<unknown>("/api/v1/dex/aggregator/quote", { ...q });
export const swap = (c: Web3Client, q: SwapQuery) => c.get<unknown>("/api/v1/dex/aggregator/swap", { ...q });
export const approveTransaction = (c: Web3Client, q: { binanceChainId: string; tokenContractAddress?: string; approveAmount: string; vendor?: string }) =>
  c.get<unknown>("/api/v1/dex/aggregator/approve-transaction", q);
export const submitRfqOrder = (c: Web3Client, body: { requestId: string; userSignature: string; vendor: string; quoteId: string; signingScheme?: string }) => c.post<unknown>("/api/v1/dex/aggregator/order/submit", body, { idempotent: true });
const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const order = (c: Web3Client, orderId: string) => {
  if (!ORDER_ID.test(orderId)) throw new Error("invalid orderId");
  return c.get<unknown>(`/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`);
};
