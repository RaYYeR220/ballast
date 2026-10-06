#!/usr/bin/env -S npx tsx
// Ballast MCP server. stdio by default; `--http [--port 8787] [--host 127.0.0.1]` serves Streamable HTTP at /mcp.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contextFromEnv, createBallastServer, createHttpServer } from "../src/server";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ctx = contextFromEnv();
if (argv.includes("--http")) {
  const { url } = await createHttpServer({ ctx, host: flag("--host") ?? "127.0.0.1", port: Number(flag("--port") ?? process.env.PORT ?? 8787) });
  console.error(`ballast-mcp listening on ${url}`);
} else {
  await createBallastServer(ctx).connect(new StdioServerTransport());
  console.error("ballast-mcp ready on stdio");
}
