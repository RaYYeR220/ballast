import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import { PublicRwaClient, type ProbeRecord } from "@ballast/binance";
import { loadDeployment } from "@ballast/sdk";
import { fail, tools, type ToolContext } from "./tools";

export const SERVER_INFO = { name: "ballast", version: "0.1.0" } as const;
const PROBE_KEEP = 200;

/**
 * Builds the context from env: BSC_RPC_URL, CHAIN_ID (56, or 31337 for a fork), DEPLOYMENT_FILE and optionally
 * RWA_CHAIN_ID. The Binance RWA status is keyless mainnet data: on a fork it still describes chain 56.
 */
export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): ToolContext {
  const chainId = Number(env.CHAIN_ID ?? 56);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`CHAIN_ID must be a positive integer: ${env.CHAIN_ID}`);
  const deployment = loadDeployment(chainId, env.DEPLOYMENT_FILE ? { file: env.DEPLOYMENT_FILE } : {});
  const url = env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
  const client = createPublicClient({ chain: { ...bsc, id: chainId }, transport: http(url) });
  const records: ProbeRecord[] = [];
  const probe = (r: ProbeRecord) => {
    records.push(r);
    if (records.length > PROBE_KEEP) records.shift();
  };
  return { client, deployment, rwa: new PublicRwaClient({ probe }), probes: () => [...records], ...(env.RWA_CHAIN_ID ? { rwaChainId: env.RWA_CHAIN_ID } : {}) };
}

/** An MCP server with every Ballast tool registered. All tools are read or plan only. */
export function createBallastServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.shape, annotations: { readOnlyHint: true, openWorldHint: true } },
      async (args: unknown) => {
        try {
          return await t.handler(ctx, args);
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
  return server;
}

export const MAX_BODY_BYTES = 1_000_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, -32600, "request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, -32600, "request body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, -32700, "Parse error: invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const DEFAULT_RATE_PER_MIN = 120;
const HOST_VALUE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::\d{1,5})?$/;

/** A comma-separated Host allowlist: names as the client sends them (`mcp.example.org`, `example.org:8443`). */
export function parseAllowedHosts(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const h = part.trim().toLowerCase();
    if (!h) continue;
    if (!HOST_VALUE.test(h)) throw new Error(`allowed host "${part.trim()}" must be a host name with an optional port, without scheme or path`);
    out.push(h);
  }
  return out;
}

/** A comma-separated Origin allowlist: `https://app.example.org`, scheme and host only. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const o = part.trim().toLowerCase();
    if (!o) continue;
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`allowed origin "${part.trim()}" is not a URL`);
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== o) throw new Error(`allowed origin "${part.trim()}" must be scheme://host[:port] and nothing else`);
    out.push(o);
  }
  return out;
}

function isLoopbackPeer(peer: string): boolean {
  if (peer === "::1") return true;
  return isIP(peer) === 4 && peer.split(".")[0] === "127";
}

export interface HttpOptions {
  /** Interface to bind. Default 127.0.0.1. A non-loopback host exposes an unauthenticated read API: put a proxy in front of it. */
  host?: string;
  port?: number;
  ctx?: ToolContext;
  /** Extra Host header values to accept: the public name a reverse proxy forwards (`mcp.example.org`). */
  allowedHosts?: string[];
  /** Extra Origin header values to accept. `https://<host>` and `http://<host>` of every allowed host are accepted already. */
  allowedOrigins?: string[];
  /** Requests per minute per client address; 0 turns the limit off. Default 120. */
  ratePerMin?: number;
  /** Take the client address from X-Forwarded-For when the peer is loopback (a reverse proxy on this host). Default true. */
  trustLoopbackProxy?: boolean;
  /** Milliseconds, for the rate-limit window. */
  clock?: () => number;
}

/**
 * The HTTP options from the command line and the environment: `--host`, `--port` (PORT), `--allowed-hosts`
 * (MCP_ALLOWED_HOSTS), `--allowed-origins` (MCP_ALLOWED_ORIGINS), `--rate-per-min` (MCP_RATE_PER_MIN).
 * A flag wins over its variable.
 */
export function httpOptionsFrom(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Required<Pick<HttpOptions, "host" | "port" | "allowedHosts" | "allowedOrigins" | "ratePerMin">> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const whole = (label: string, raw: string | undefined, fallback: number, max: number) => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${label} must be a whole number from 0 to ${max}: ${raw}`);
    return n;
  };
  return {
    host: flag("--host") ?? "127.0.0.1",
    port: whole("the port", flag("--port") ?? env.PORT, 8787, 65535),
    allowedHosts: parseAllowedHosts(flag("--allowed-hosts") ?? env.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseAllowedOrigins(flag("--allowed-origins") ?? env.MCP_ALLOWED_ORIGINS),
    ratePerMin: whole("the rate limit", flag("--rate-per-min") ?? env.MCP_RATE_PER_MIN, DEFAULT_RATE_PER_MIN, 100_000),
  };
}
export interface HttpHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/**
 * Streamable HTTP endpoint at /mcp (stateless: one server and transport per request).
 * Binds to 127.0.0.1 by default and rejects requests whose Host or Origin is neither the bound address nor on
 * the allowlist (DNS rebinding). To serve it publicly, keep the loopback bind, put a TLS reverse proxy in
 * front and allow the proxy's public host name. There is no authentication: every tool is read or plan only,
 * and each client address gets `ratePerMin` requests a minute.
 */
export async function createHttpServer(opts: HttpOptions = {}): Promise<HttpHandle> {
  const host = opts.host ?? "127.0.0.1";
  const ctx = opts.ctx ?? contextFromEnv();
  const hosts = new Set((opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()));
  const origins = new Set((opts.allowedOrigins ?? []).map((o) => o.trim().toLowerCase()));
  // A page served from an allowed host is the same origin as the endpoint.
  for (const h of hosts) for (const scheme of ["https", "http"]) origins.add(`${scheme}://${h}`);
  const ratePerMin = opts.ratePerMin ?? DEFAULT_RATE_PER_MIN;
  const trustProxy = opts.trustLoopbackProxy ?? true;
  const clock = opts.clock ?? Date.now;
  const hits = new Map<string, { start: number; n: number }>();

  // The peer, or the address a reverse proxy on this host reports for it. X-Forwarded-For from anyone else
  // is ignored: a client could write whatever it likes there.
  const clientIp = (req: IncomingMessage) => {
    const peer = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    const fwd = req.headers["x-forwarded-for"];
    if (trustProxy && isLoopbackPeer(peer) && typeof fwd === "string" && fwd.trim()) {
      const last = fwd.split(",").at(-1)?.trim();
      if (last) return last;
    }
    return peer;
  };
  /** Seconds until the client may try again, or null when the request is within its budget. */
  const limited = (ip: string): number | null => {
    if (ratePerMin <= 0) return null;
    const now = clock();
    const h = hits.get(ip);
    if (!h || now - h.start >= 60_000) {
      if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start >= 60_000) hits.delete(k);
      hits.set(ip, { start: now, n: 1 });
      return null;
    }
    h.n++;
    return h.n > ratePerMin ? Math.max(1, Math.ceil((h.start + 60_000 - now) / 1000)) : null;
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const hostHeader = req.headers.host?.toLowerCase();
    if (!hostHeader || !hosts.has(hostHeader)) return send(res, 403, rpcError(-32000, "Host not allowed"));
    // The transport compares the header as it is: hand it the normalised form the check above accepted.
    req.headers.host = hostHeader;
    const origin = req.headers.origin;
    if (origin && !origins.has(origin.toLowerCase())) return send(res, 403, rpcError(-32000, "Origin not allowed"));
    const retry = limited(clientIp(req));
    if (retry !== null) {
      res.setHeader("retry-after", String(retry));
      return send(res, 429, rpcError(-32000, "Too many requests"));
    }
    if (path === "/health") return send(res, 200, { ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version });
    if (path !== "/mcp") return send(res, 404, { error: "not found" });
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return send(res, 405, rpcError(-32000, "Method not allowed"));
    }
    try {
      const body = await readBody(req);
      const mcp = createBallastServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts: [...hosts],
        allowedOrigins: [...origins],
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) {
          // Let the client read the answer: discard the rest of the body briefly, then hang up.
          res.setHeader("connection", "close");
          req.resume();
          setTimeout(() => req.destroy(), 1000).unref();
        }
        if (!res.headersSent) send(res, e.status, rpcError(e.code, e.message));
        return;
      }
      if (!res.headersSent) send(res, 500, rpcError(-32603, "Internal server error"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const names = LOOPBACK.has(host) ? ["127.0.0.1", "localhost", "[::1]"] : [host.includes(":") ? `[${host}]` : host];
  for (const n of names) {
    hosts.add(`${n}:${port}`.toLowerCase());
    origins.add(`http://${n}:${port}`.toLowerCase());
  }
  return {
    server,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
