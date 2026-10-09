#!/usr/bin/env -S npx tsx
// Ballast MCP server. stdio by default; `--http [--port 8787] [--host 127.0.0.1]` serves Streamable HTTP at /mcp.
//
// Public use: keep the loopback bind, put a TLS reverse proxy in front and name its public host:
//   ballast-mcp --http --port 8790 --allowed-hosts mcp.example.org     (or MCP_ALLOWED_HOSTS)
//   [--allowed-origins https://app.example.org] [--rate-per-min 120]   (MCP_ALLOWED_ORIGINS, MCP_RATE_PER_MIN)
// The endpoint has no authentication. Every tool is read or plan only, requests are limited per client
// address (X-Forwarded-For is believed only from a proxy on loopback) and heavy reads are capped in flight.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contextFromEnv, createBallastServer, createHttpServer, httpOptionsFrom } from "../src/server";

const argv = process.argv.slice(2);

const ctx = contextFromEnv();
if (argv.includes("--http")) {
  let options: ReturnType<typeof httpOptionsFrom>;
  try {
    options = httpOptionsFrom(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const { url } = await createHttpServer({ ctx, ...options });
  if (!["127.0.0.1", "localhost", "::1"].includes(options.host)) console.error("warning: binding a non-loopback host; this endpoint has no authentication");
  console.error(`ballast-mcp listening on ${url}`);
  if (options.allowedHosts.length) console.error(`also answering for ${options.allowedHosts.join(", ")}; ${options.ratePerMin || "unlimited"} requests a minute per client address`);
} else {
  await createBallastServer(ctx).connect(new StdioServerTransport());
  console.error("ballast-mcp ready on stdio");
}
