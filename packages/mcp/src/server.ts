import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
  const url = env.BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com";
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

export interface HttpOptions {
  /** Interface to bind. Default 127.0.0.1. A non-loopback host exposes an unauthenticated read API: put auth in front of it. */
  host?: string;
  port?: number;
  ctx?: ToolContext;
  /** Extra Host header values to accept (for example a proxy's public name). */
  allowedHosts?: string[];
  /** Extra Origin header values to accept. */
  allowedOrigins?: string[];
}
export interface HttpHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/**
 * Streamable HTTP endpoint at /mcp (stateless: one server and transport per request).
 * Binds to 127.0.0.1 by default and rejects requests whose Host or Origin is not the bound address (DNS rebinding).
 * There is no authentication: a non-loopback host is open to anyone who can reach it.
 */
export async function createHttpServer(opts: HttpOptions = {}): Promise<HttpHandle> {
  const host = opts.host ?? "127.0.0.1";
  const ctx = opts.ctx ?? contextFromEnv();
  const hosts = new Set(opts.allowedHosts ?? []);
  const origins = new Set(opts.allowedOrigins ?? []);
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const hostHeader = req.headers.host;
    if (!hostHeader || !hosts.has(hostHeader.toLowerCase())) return send(res, 403, rpcError(-32000, "Host not allowed"));
    const origin = req.headers.origin;
    if (origin && !origins.has(origin.toLowerCase())) return send(res, 403, rpcError(-32000, "Origin not allowed"));
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
