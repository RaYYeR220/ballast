import type { Web3Client } from "../client";

export interface EvmTx { from: string; to: string; value: string; data: string }
export interface SimulationResult {
  status: "SUCCESS" | "FAILED";
  failReason: string | null;
  balanceChanges: { contractAddress: string; tokenType: string; change: string; owner: string }[];
  allowanceChanges: { tokenAddress: string; owner: string; spender: string; preAmount: string; postAmount: string }[];
}

export const simulate = (c: Web3Client, body: { binanceChainId: string; evmTx: EvmTx }) =>
  c.post<SimulationResult>("/api/v1/dex/pre-transaction/simulate", body, { idempotent: true });
export const broadcast = (c: Web3Client, body: { binanceChainId: string; signedTransaction: string; address: string; enableMevProtection?: boolean }) =>
  c.post<{ orderId: string; txHash: string }>("/api/v1/dex/pre-transaction/broadcast-transaction", body);
export const gasPrice = (c: Web3Client, binanceChainId: string) => c.get<unknown>("/api/v1/dex/pre-transaction/gas-price", { binanceChainId });
export const orders = (c: Web3Client, q: { address: string; binanceChainId: string; txStatus?: string; orderId?: string; cursor?: string; limit?: number }) => c.get<unknown>("/api/v1/dex/post-transaction/orders", { ...q });
