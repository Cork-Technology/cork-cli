#!/usr/bin/env node
// stdio entrypoint: `cork-mcp`. Data mode / RPC come from env (explicit, never silent-fallback).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCorkServer } from "./server.ts";

const ctx = {
  ...(process.env.CORK_RPC_URL ? { rpcUrl: process.env.CORK_RPC_URL } : {}),
};

const server = createCorkServer(ctx);
const transport = new StdioServerTransport();
await server.connect(transport);
