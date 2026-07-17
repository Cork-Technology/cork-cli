#!/usr/bin/env bun
import { runCli } from "./app.ts";

const ctx = {
  ...(process.env.CORK_RPC_URL ? { rpcUrl: process.env.CORK_RPC_URL } : {}),
};

const { code, stdout, stderr } = await runCli(process.argv.slice(2), ctx);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(code);
