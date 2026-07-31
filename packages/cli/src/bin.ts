#!/usr/bin/env bun
export {}; // top-level await needs module context; this file is an entrypoint, not a library

const argv = process.argv.slice(2);

const ctx = {
  ...(process.env.CORK_RPC_URL ? { rpcUrl: process.env.CORK_RPC_URL } : {}),
};

// `ch mcp` — the MCP stdio server must own stdout from process start (any stray byte corrupts
// the protocol stream), so it is intercepted BEFORE the commander projection ever loads. The
// server module is shared with the `cork-mcp` dev entrypoint (packages/mcp/src/bin.ts): one
// core, two thin shells (RFC 011).
if (argv[0] === "mcp") {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createCorkServer } = await import("../../mcp/src/server.ts");
  const server = createCorkServer(ctx);
  await server.connect(new StdioServerTransport());
  // The open stdin stream keeps the process alive until the client closes it.
} else if (argv[0] === "__update-check") {
  // Hidden: the detached refresh half of the update notifier. Not registered in --help.
  const { refreshUpdateCache } = await import("./update-notify.ts");
  await refreshUpdateCache();
} else {
  const { runCli } = await import("./app.ts");

  // The environment is passed in rather than read inside runCli so tests can drive output
  // mode (CORK_JSON / CORK_EXPLAIN_JSON) without mutating the process they run in.
  const { code, stdout, stderr } = await runCli(argv, ctx, process.env);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  // exitCode (not process.exit): a hard exit can truncate a large piped envelope whose stdout
  // write hasn't flushed yet; setting exitCode lets the runtime drain the streams first.
  process.exitCode = code;

  // Passive update notice (stderr, TTY-only, heavily gated — see update-notify.ts). Loaded
  // last and failure-proof so it can never affect the command that just ran.
  const { maybeNotifyUpdates } = await import("./update-notify.ts");
  const { BUILD_VERSION } = await import("@cork/core");
  maybeNotifyUpdates(argv, BUILD_VERSION);
}
