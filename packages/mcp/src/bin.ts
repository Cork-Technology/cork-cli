#!/usr/bin/env bun
// stdio entrypoint: `cork-mcp`. Data mode / RPC come from env (explicit, never silent-fallback).
// Always launched under Bun (never node — TS parameter properties). The MCP client spawns it as
// `bun packages/mcp/src/bin.ts`; the shebang matters only if the package bin is linked/published.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCorkServer } from "./server.ts";

const ctx = {
  ...(process.env.CORK_RPC_URL ? { rpcUrl: process.env.CORK_RPC_URL } : {}),
};

const server = createCorkServer(ctx);
const transport = new StdioServerTransport();
await server.connect(transport);
