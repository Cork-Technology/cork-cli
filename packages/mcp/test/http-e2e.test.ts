// Real-socket end-to-end for `ch mcp --http`: vitest workers run on Node (no Bun global), so
// Bun.serve cannot be exercised in-process — instead the ACTUAL CLI entrypoint is spawned as a
// Bun subprocess and driven over HTTP, which also covers the --port flag, the CORK_MCP_TOKEN env
// wiring, and the stderr readiness line. Offline-safe: localhost only, port 0 = kernel-assigned.
import { afterAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "..", "cli", "src", "bin.ts");
const children: ChildProcess[] = [];

/** Spawn `bun <bin> mcp --http --port 0 [extraArgs] [env]` and resolve the bind host + kernel-
 *  assigned port from the readiness line on stderr. Rejects on process exit or a 15s deadline,
 *  so a broken server fails the test instead of hanging it. */
function startServer(env: Record<string, string> = {}, extraArgs: string[] = []): Promise<{ host: string; port: number; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [BIN, "mcp", "--http", "--port", "0", ...extraArgs], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    const deadline = setTimeout(() => reject(new Error(`server never printed its readiness line: ${stderr}`)), 15_000);
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const m = stderr.match(/Streamable HTTP on ([^\s:]+):(\d+)/);
      if (m) {
        clearTimeout(deadline);
        resolve({ host: m[1]!, port: Number(m[2]), child });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`server exited early (code ${code}): ${stderr}`));
    });
  });
}

afterAll(() => {
  for (const c of children) c.kill();
});

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
});
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("ch mcp --http (real Bun.serve socket)", () => {
  it("serves initialize (with instructions), healthz, and docs over a kernel-assigned port", async () => {
    const { host, port } = await startServer();
    // The default bind is LOOPBACK — a bare `ch mcp --http` (possibly open, no token) must never
    // listen on external interfaces by accident. Widening is the explicit --host act, below.
    expect(host).toBe("127.0.0.1");
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toMatch(/^ok /);

    const init = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: MCP_HEADERS, body: INIT_BODY });
    expect(init.status).toBe(200);
    const rpc = (await init.json()) as { result: { serverInfo: { name: string }; instructions?: string } };
    expect(rpc.result.serverInfo.name).toBe("cork-mcp");
    expect(rpc.result.instructions).toContain("UNSIGNED");

    const docs = await fetch(`http://127.0.0.1:${port}/docs/signing`);
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain("eth_sendRawTransaction");
  }, 30_000);

  it("CORK_MCP_TOKEN gates /mcp (401 bare, 200 with bearer) but not healthz", async () => {
    const { port } = await startServer({ CORK_MCP_TOKEN: "e2e-secret" });
    const bare = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: MCP_HEADERS, body: INIT_BODY });
    expect(bare.status).toBe(401);
    const authed = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: "Bearer e2e-secret" }, body: INIT_BODY });
    expect(authed.status).toBe(200);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
  }, 30_000);

  it("--host 0.0.0.0 widens the bind (the container/compose path) and still serves", async () => {
    const { host, port } = await startServer({}, ["--host", "0.0.0.0"]);
    expect(host).toBe("0.0.0.0");
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
  }, 30_000);

  it("--host without an address is refused (exit 2), not silently defaulted", async () => {
    const child = spawn("bun", [BIN, "mcp", "--http", "--port", "0", "--host"], { stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(2);
    expect(stderr).toContain("--host requires an address");
  }, 30_000);
});
