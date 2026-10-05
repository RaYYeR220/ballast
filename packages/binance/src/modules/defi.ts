import type { Web3Client } from "../client";

export const positions = (c: Web3Client, addresses: string[], binanceChainIds?: string[]) =>
  c.post<unknown>("/api/v1/defi/data/position/list", binanceChainIds ? { addresses, binanceChainIds } : { addresses });
export const protocols = (c: Web3Client, body: Record<string, unknown> = {}) => c.post<unknown>("/api/v1/defi/data/protocol/list", body);
export const investments = (c: Web3Client, body: { investType: string; binanceChainId?: string; defiProtocolId?: string; tokenAddressList?: string[]; sortField?: string; sortDirection?: string; page?: number; size?: number }) =>
  c.post<unknown>("/api/v1/defi/data/investment/list", body);
export const deposit = (c: Web3Client, body: Record<string, unknown>) => c.post<unknown>("/api/v1/defi/transaction/deposit", body);
export const redeem = (c: Web3Client, body: Record<string, unknown>) => c.post<unknown>("/api/v1/defi/transaction/redeem", body);
