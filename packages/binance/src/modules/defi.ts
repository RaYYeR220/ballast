import type { Web3Client } from "../client";

/** Raw position shape as returned by the API; fields are intentionally left untyped. */
export type DefiPosition = Record<string, unknown>;

export const positions = (c: Web3Client, addresses: string[], binanceChainIds?: string[]) =>
  c.post<unknown>("/api/v1/defi/data/position/list", binanceChainIds ? { addresses, binanceChainIds } : { addresses }, { idempotent: true });
export const protocols = (c: Web3Client, body: Record<string, unknown> = {}) => c.post<unknown>("/api/v1/defi/data/protocol/list", body, { idempotent: true });
export const investments = (c: Web3Client, body: { investType: string; binanceChainId?: string; defiProtocolId?: string; tokenAddressList?: string[]; sortField?: string; sortDirection?: string; page?: number; size?: number }) =>
  c.post<unknown>("/api/v1/defi/data/investment/list", body, { idempotent: true });
export const deposit = (c: Web3Client, body: Record<string, unknown>) => c.post<unknown>("/api/v1/defi/transaction/deposit", body);
export const redeem = (c: Web3Client, body: Record<string, unknown>) => c.post<unknown>("/api/v1/defi/transaction/redeem", body);
