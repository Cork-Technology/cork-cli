#!/usr/bin/env bun
// stdio entrypoint: `cork-mcp`. Data mode / RPC come from env (explicit, never silent-fallback).
// Always launched under Bun (never node — TS parameter properties). The MCP client spawns it as
// `bun packages/mcp/src/bin.ts`; the shebang matters only if the package bin is linked/published.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCorkServer } from "./server.ts";

// Deliberate crash policy (same as packages/cli/src/bin.ts): log to STDERR — stdout is the MCP
// protocol stream — and exit nonzero so the client sees a dead process, not a wedged one.
process.on("uncaughtException", (err) => {
  process.stderr.write(`cork-mcp: fatal uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`cork-mcp: fatal unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});

const ctx = {
  ...(process.env.CORK_RPC_URL ? { rpcUrl: process.env.CORK_RPC_URL } : {}),
};

const server = createCorkServer(ctx);
const transport = new StdioServerTransport();
await server.connect(transport);
