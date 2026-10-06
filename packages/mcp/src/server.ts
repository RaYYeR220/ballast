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

/** Builds the context from env: BSC_RPC_URL, CHAIN_ID (56, or 31337 for a fork), DEPLOYMENT_FILE. */
export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): ToolContext {
  const chainId = Number(env.CHAIN_ID ?? 56);
  if (!Number.isInteger(chainId)) throw new Error(`CHAIN_ID is not an integer: ${env.CHAIN_ID}`);
  const deployment = loadDeployment(chainId, env.DEPLOYMENT_FILE ? { file: env.DEPLOYMENT_FILE } : {});
  const url = env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
  const client = createPublicClient({ chain: { ...bsc, id: chainId }, transport: http(url) });
  const records: ProbeRecord[] = [];
  const probe = (r: ProbeRecord) => {
    records.push(r);
    if (records.length > PROBE_KEEP) records.shift();
  };
  return { client, deployment, rwa: new PublicRwaClient({ probe }), probes: () => [...records] };
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export interface HttpOptions {
  host?: string;
  port?: number;
  ctx?: ToolContext;
}
export interface HttpHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** Streamable HTTP endpoint at /mcp (stateless: one server and transport per request). Binds to 127.0.0.1 by default. */
export async function createHttpServer(opts: HttpOptions = {}): Promise<HttpHandle> {
  const host = opts.host ?? "127.0.0.1";
  const ctx = opts.ctx ?? contextFromEnv();
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/health") return send(res, 200, { ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version });
    if (path !== "/mcp") return send(res, 404, { error: "not found" });
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    }
    try {
      const body = await readBody(req);
      const mcp = createBallastServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
