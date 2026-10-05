import { createHmac } from "node:crypto";

/** HMAC-SHA256 (base64) over timestamp + METHOD + requestPath + body, the Binance Web3 API scheme. */
export function signWeb3(secret: string, timestamp: string, method: string, requestPath: string, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}${method.toUpperCase()}${requestPath}${body}`, "utf8")
    .digest("base64");
}

export interface AuthHeaderOptions {
  apiKey: string;
  apiSecret: string;
  method: string;
  /** URL path including `/build`, plus `?query` exactly as sent. */
  requestPath: string;
  body: string;
  now?: Date;
  recvWindowMs?: number;
  nonce?: string;
}

export function buildAuthHeaders(o: AuthHeaderOptions): Record<string, string> {
  const timestamp = (o.now ?? new Date()).toISOString();
  const headers: Record<string, string> = {
    "X-OC-APIKEY": o.apiKey,
    "X-OC-TIMESTAMP": timestamp,
    "X-OC-SIGN": signWeb3(o.apiSecret, timestamp, o.method, o.requestPath, o.body),
  };
  if (o.recvWindowMs !== undefined) headers["X-OC-RECV-WINDOW"] = String(o.recvWindowMs);
  if (o.nonce !== undefined) headers["X-OC-NONCE"] = o.nonce;
  return headers;
}
