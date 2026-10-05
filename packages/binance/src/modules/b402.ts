import type { Web3Client } from "../client";

/** B402 wraps request bodies in an outer `body` object and signs those exact bytes. */
export const supported = (c: Web3Client) => c.post<unknown>("/api/v2/b402/supported", { body: {} });
export const verify = (c: Web3Client, body: unknown) => c.post<unknown>("/api/v2/b402/verify", { body }, { idempotent: true });
export const settle = (c: Web3Client, body: unknown) => c.post<unknown>("/api/v2/b402/settle", { body }, { idempotent: true });
