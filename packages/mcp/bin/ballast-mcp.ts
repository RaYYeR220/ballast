#!/usr/bin/env -S npx tsx
// Ballast MCP server. stdio by default; `--http [--port 8787] [--host 127.0.0.1]` serves Streamable HTTP at /mcp.
// The HTTP endpoint has no authentication: keep it on loopback, or put auth in front of it.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contextFromEnv, createBallastServer, createHttpServer } from "../src/server";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function parsePort(raw: string | undefined): number {
  const port = raw === undefined ? 8787 : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid port: ${raw}`);
    process.exit(2);
  }
  return port;
}

const ctx = contextFromEnv();
if (argv.includes("--http")) {
  const host = flag("--host") ?? "127.0.0.1";
  const { url } = await createHttpServer({ ctx, host, port: parsePort(flag("--port") ?? process.env.PORT) });
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) console.error("warning: binding a non-loopback host; this endpoint has no authentication");
  console.error(`ballast-mcp listening on ${url}`);
} else {
  await createBallastServer(ctx).connect(new StdioServerTransport());
  console.error("ballast-mcp ready on stdio");
}
