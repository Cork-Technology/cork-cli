#!/usr/bin/env bun
import { runCli } from "./app.ts";

const ctx = {
  ...(process.env.CORK_RPC_URL ? { rpcUrl: process.env.CORK_RPC_URL } : {}),
};

// The environment is passed in rather than read inside runCli so tests can drive output
// mode (CH_JSON) without mutating the process they run in.
const { code, stdout, stderr } = await runCli(process.argv.slice(2), ctx, process.env);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
// exitCode (not process.exit): a hard exit can truncate a large piped envelope whose stdout
// write hasn't flushed yet; setting exitCode lets the runtime drain the streams first.
process.exitCode = code;
