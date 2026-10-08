// The desk's read API (node:http, GET only): health, the audit feed with desk notes, accounts, the Session
// Oracle, the ledger, guardian evidence files and a summary of the Binance API probes. It binds to loopback
// behind a reverse proxy; CORS answers only the configured web origin; every body is scrubbed of the desk's
// secrets before it is sent; each client IP gets a small per-minute budget.
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { ProbeRecord } from "@ballast/binance";
import { isLoopbackHost } from "./config";
import type { Feed, FeedEvent, FeedKind, FeedSource } from "./feed";
import type { Ledger, LedgerEntry } from "./ledger";
import type { NotesStore } from "./notes";

const FEED_KINDS: readonly FeedKind[] = ["shield", "restore", "refused", "alert", "noop", "publish", "finding", "pending", "submit", "settle", "payment"];
const FEED_SOURCES: readonly FeedSource[] = ["keeper", "publisher", "guardian", "x402"];
const LEDGER_KINDS: readonly LedgerEntry["kind"][] = ["gas", "income", "x402"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const JOB_ID = /^\d{1,78}$/;
const MAX_URL = 2048;

// ---------------------------------------------------------------- probes

interface EndpointStats {
  surface: string;
  endpoint: string;
  calls: number;
  errors: number;
  codes: Record<string, number>;
  latencies: number[];
  lastStatus: number;
  lastAt: string;
}

const pct = (sorted: number[], p: number) => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number) : null);

/** Latency and error-code summary of the Binance calls the desk makes (fed by the clients' probe hook). */
export class ApiProbe {
  readonly #stats = new Map<string, EndpointStats>();
  readonly #since = new Date().toISOString();
  readonly #window: number;

  constructor(window = 200) {
    this.#window = window;
  }

  record(r: ProbeRecord): void {
    const k = `${r.surface} ${r.method} ${r.endpoint}`;
    let s = this.#stats.get(k);
    if (!s) {
      s = { surface: r.surface, endpoint: `${r.method} ${r.endpoint}`, calls: 0, errors: 0, codes: {}, latencies: [], lastStatus: 0, lastAt: "" };
      this.#stats.set(k, s);
    }
    s.calls++;
    if (!r.ok) s.errors++;
    s.codes[r.code] = (s.codes[r.code] ?? 0) + 1;
    s.latencies.push(r.latencyMs);
    if (s.latencies.length > this.#window) s.latencies.shift();
    s.lastStatus = r.status;
    s.lastAt = r.ts;
  }

  summary() {
    return {
      since: this.#since,
      endpoints: [...this.#stats.values()].map((s) => {
        const sorted = [...s.latencies].sort((a, b) => a - b);
        return { surface: s.surface, endpoint: s.endpoint, calls: s.calls, errors: s.errors, p50Ms: pct(sorted, 50), p95Ms: pct(sorted, 95), codes: s.codes, lastStatus: s.lastStatus, lastAt: s.lastAt };
      }),
    };
  }
}

/** A read cached for `ttlMs`, with one request in flight at a time; failures are not cached. */
export function cached<T>(fn: () => Promise<T>, ttlMs: number, clock: () => number = Date.now): () => Promise<T> {
  let value: { at: number; v: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (value && clock() - value.at < ttlMs) return Promise.resolve(value.v);
    if (inflight) return inflight;
    inflight = fn()
      .then((v) => {
        value = { at: clock(), v };
        return v;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

// ------------------------------------------------------------------ server

export interface DeskApiOptions {
  feed: Feed;
  notes?: NotesStore | null;
  ledger: Ledger;
  /** Evidence files live in <dataDir>/evidence/. */
  dataDir: string;
  health: () => Record<string, unknown>;
  accounts: () => Promise<unknown>;
  oracle: () => Promise<unknown>;
  apiHealth: () => unknown;
  webOrigin: string | null;
  secrets: readonly string[];
  ratePerMin: number;
  /** Take the client IP from X-Forwarded-For when the peer is a loopback proxy (default true). */
  trustLoopbackProxy?: boolean;
  /** Milliseconds. */
  clock?: () => number;
  log?: (line: string) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function intParam(v: string | null, def: number, max: number): number {
  if (v === null || v === "") return def;
  if (!/^\d{1,6}$/.test(v)) throw new HttpError(400, "limit must be a positive integer");
  const n = Number(v);
  if (n < 1) throw new HttpError(400, "limit must be a positive integer");
  return Math.min(n, max);
}

export function createDeskApi(o: DeskApiOptions): http.Server {
  const clock = o.clock ?? Date.now;
  const secrets = [...new Set(o.secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  const hits = new Map<string, { start: number; n: number }>();
  const trustProxy = o.trustLoopbackProxy ?? true;

  const scrub = (s: string) => {
    let out = s;
    for (const secret of secrets) {
      out = out.split(secret).join("[redacted]");
      const enc = JSON.stringify(secret).slice(1, -1); // as it appears inside a JSON string
      if (enc !== secret) out = out.split(enc).join("[redacted]");
    }
    return out;
  };

  const clientIp = (req: http.IncomingMessage) => {
    const peer = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    const fwd = req.headers["x-forwarded-for"];
    if (trustProxy && isLoopbackHost(peer) && typeof fwd === "string" && fwd.trim()) {
      const last = fwd.split(",").at(-1)?.trim();
      if (last) return last;
    }
    return peer;
  };

  const limited = (ip: string): number | null => {
    const now = clock();
    const h = hits.get(ip);
    if (!h || now - h.start >= 60_000) {
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start >= 60_000) hits.delete(k);
      hits.set(ip, { start: now, n: 1 });
      return null;
    }
    h.n++;
    return h.n > o.ratePerMin ? Math.ceil((h.start + 60_000 - now) / 1000) : null;
  };

  const withNote = (e: FeedEvent) => {
    const note = o.notes?.get(e.seq);
    return note ? { ...e, note } : e;
  };

  async function route(url: URL): Promise<{ status: number; body: unknown; raw?: string }> {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;
    if (p === "/health") return { status: 200, body: o.health() };
    if (p === "/feed") {
      const account = q.get("account");
      if (account && !ADDRESS.test(account)) throw new HttpError(400, "account must be a 0x address");
      const kind = q.get("kind");
      if (kind && !FEED_KINDS.includes(kind as FeedKind)) throw new HttpError(400, "unknown kind");
      const source = q.get("source");
      if (source && !FEED_SOURCES.includes(source as FeedSource)) throw new HttpError(400, "unknown source");
      const limit = intParam(q.get("limit"), 100, 500);
      const events = o.feed.list({ ...(account ? { account } : {}), ...(kind ? { kind: kind as FeedKind } : {}), ...(source ? { source: source as FeedSource } : {}), limit });
      return { status: 200, body: { events: events.map(withNote) } };
    }
    if (p === "/accounts") return { status: 200, body: await chain(o.accounts) };
    if (p === "/oracle") return { status: 200, body: await chain(o.oracle) };
    if (p === "/ledger") {
      const kind = q.get("kind");
      if (kind && !LEDGER_KINDS.includes(kind as LedgerEntry["kind"])) throw new HttpError(400, "unknown kind");
      const limit = intParam(q.get("limit"), 100, 500);
      const nowSec = Math.floor(clock() / 1000);
      return {
        status: 200,
        body: {
          x402: { capUsd: o.ledger.capUsd, spentTodayUsd: o.ledger.x402SpentToday(nowSec) },
          total: o.ledger.summary(),
          today: o.ledger.summary(nowSec - (nowSec % 86_400)),
          entries: o.ledger.list({ ...(kind ? { kind: kind as LedgerEntry["kind"] } : {}), limit }),
        },
      };
    }
    const ev = /^\/evidence\/([^/]+?)(\.json)?$/.exec(p);
    if (ev) {
      const id = ev[1] as string;
      if (!JOB_ID.test(id)) throw new HttpError(400, "jobId must be a decimal number");
      try {
        const raw = await readFile(path.join(o.dataDir, "evidence", `${BigInt(id).toString()}.json`), "utf8");
        return { status: 200, body: null, raw };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "no evidence for this job");
        throw err;
      }
    }
    if (p === "/api-health") return { status: 200, body: o.apiHealth() };
    if (p === "/") return { status: 200, body: { endpoints: ["/health", "/feed?account=&kind=&source=&limit=", "/accounts", "/oracle", "/ledger?kind=&limit=", "/evidence/:jobId", "/api-health"] } };
    throw new HttpError(404, "not found");
  }

  async function chain(fn: () => Promise<unknown>) {
    try {
      return await fn();
    } catch (err) {
      o.log?.(`api chain read failed: ${(err as Error).message?.slice(0, 200)}`);
      throw new HttpError(503, "chain read failed, try again shortly");
    }
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    if (o.webOrigin && origin === o.webOrigin) {
      headers["Access-Control-Allow-Origin"] = o.webOrigin;
      headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
      headers["Access-Control-Max-Age"] = "600";
    }
    const send = (status: number, text: string) => {
      if (res.headersSent) return;
      res.writeHead(status, { ...headers, "Content-Length": String(Buffer.byteLength(text)) });
      res.end(req.method === "HEAD" ? undefined : text);
    };
    const json = (status: number, body: unknown) => send(status, scrub(JSON.stringify(body, bigintSafe)));
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        res.end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        headers.Allow = "GET, HEAD, OPTIONS";
        json(405, { error: "method not allowed" });
        return;
      }
      if ((req.url ?? "").length > MAX_URL) {
        json(414, { error: "URL too long" });
        return;
      }
      const retry = limited(clientIp(req));
      if (retry !== null) {
        headers["Retry-After"] = String(retry);
        json(429, { error: "too many requests" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://desk.local");
      const r = await route(url);
      if (r.raw !== undefined) {
        // Evidence is served byte for byte (its keccak256 is the on-chain deliverable). The feed it was built
        // from is scrubbed already; if a secret is in there anyway, refuse rather than leak or alter it.
        if (scrub(r.raw) !== r.raw) {
          o.log?.(`api: evidence at ${url.pathname} contains a desk secret, not served`);
          json(500, { error: "evidence cannot be served" });
        } else send(r.status, r.raw);
      } else json(r.status, r.body);
    } catch (err) {
      if (err instanceof HttpError) {
        json(err.status, { error: err.message });
        return;
      }
      o.log?.(`api error: ${(err as Error).message?.slice(0, 200)}`);
      json(500, { error: "internal error" });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function listen(server: http.Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}
