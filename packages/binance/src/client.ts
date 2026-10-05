import { buildAuthHeaders } from "./sign";
import { Web3ApiError, isSuccessCode, GEO_BLOCK_CODE } from "./errors";
import { EndpointLimiter } from "./limiter";
import { createProbe, type ProbeRecord } from "./probe";

export { Web3ApiError, isGeoBlocked } from "./errors";

export type Query = Record<string, string | number | boolean | undefined>;

export interface Web3ClientOptions {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  probe?: (r: ProbeRecord) => void;
  maxRetries?: number;
  recvWindowMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface Envelope<T> {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: T;
}

export function encodeQuery(q: Query = {}): string {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export class Web3Client {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly f: typeof fetch;
  private readonly probe: (r: ProbeRecord) => void;
  private readonly limiter = new EndpointLimiter(5);
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: Web3ClientOptions = {}) {
    this.baseUrl = (o.baseUrl ?? "https://web3.binance.com/build").replace(/\/$/, "");
    this.basePath = new URL(this.baseUrl).pathname.replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
    this.probe = o.probe ?? createProbe();
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static fromEnv(extra: Omit<Web3ClientOptions, "apiKey" | "apiSecret"> = {}): Web3Client {
    return new Web3Client({ ...extra, apiKey: process.env.BINANCE_WEB3_API_KEY, apiSecret: process.env.BINANCE_WEB3_API_SECRET });
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, encodeQuery(query), "");
  }

  /**
   * POSTs are state-changing: they are retried only when rejected before processing (429 / 42900),
   * never on network errors or 5xx — unless the caller marks the request `idempotent`.
   */
  post<T>(path: string, body: unknown, opts: { idempotent?: boolean } = {}): Promise<T> {
    return this.request<T>("POST", path, "", JSON.stringify(body ?? {}), opts.idempotent === true);
  }

  private async request<T>(method: "GET" | "POST", path: string, search: string, body: string, idempotent = method === "GET"): Promise<T> {
    if (!this.o.apiKey || !this.o.apiSecret) {
      throw new Error("Binance Web3 API credentials missing: set BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET");
    }
    const maxRetries = this.o.maxRetries ?? 3;
    for (let attempt = 1; ; attempt++) {
      await this.limiter.take(path, this.sleep);
      const requestPath = `${this.basePath}${path}${search}`;
      const headers: Record<string, string> = {
        ...buildAuthHeaders({
          apiKey: this.o.apiKey,
          apiSecret: this.o.apiSecret,
          method,
          requestPath,
          body,
          now: this.o.now?.(),
          recvWindowMs: this.o.recvWindowMs,
        }),
        Accept: "application/json",
      };
      if (method === "POST") headers["Content-Type"] = "application/json";
      const started = performance.now();
      let status = 0;
      let code = "";
      let message = "";
      try {
        const res = await this.f(`${this.baseUrl}${path}${search}`, { method, headers, body: method === "POST" ? body : undefined });
        status = res.status;
        const text = await res.text();
        const env = (text ? JSON.parse(text) : {}) as Envelope<T>;
        code = env.code === undefined ? "" : String(env.code);
        message = env.msg ?? env.message ?? "";
        const ok = status < 400 && isSuccessCode(env.code);
        this.record(method, path, status, code, ok, started, attempt);
        if (ok) return env.data as T;
        const rateLimited = status === 429 || code === "42900";
        const retryable = (rateLimited || status >= 500) && code !== GEO_BLOCK_CODE;
        if (retryable && (rateLimited || idempotent) && attempt <= maxRetries) {
          const ra = Number(res.headers.get("retry-after"));
          await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 250 * 2 ** attempt);
          continue;
        }
        throw new Web3ApiError(path, status, code || String(status), message || text.slice(0, 200), retryable);
      } catch (e) {
        if (e instanceof Web3ApiError) throw e;
        this.record(method, path, status, code, false, started, attempt, String(e));
        if (idempotent && attempt <= maxRetries) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new Web3ApiError(path, status, "NETWORK", String(e), true);
      }
    }
  }

  private record(method: string, endpoint: string, status: number, code: string, ok: boolean, started: number, attempt: number, error?: string) {
    this.probe({
      ts: new Date().toISOString(),
      surface: endpoint.includes("/b402/") ? "b402" : "keyed",
      method,
      endpoint,
      status,
      code,
      ok,
      latencyMs: Math.round(performance.now() - started),
      attempt,
      error,
    });
  }
}
