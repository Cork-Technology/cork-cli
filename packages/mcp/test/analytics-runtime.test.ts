// The runtime half of the tracking guard: the REAL binary, run with Cork's analytics opt-in, a
// Cork project key and its CORK_ENV in the environment — and DO_NOT_TRACK removed — must make no
// PostHog request from `ch mcp` (stdio) or from a CLI command, while `ch mcp --http` with the
// same environment does (the positive control: the observation below would see it).
//
// How a request is observed: every child runs with HTTPS_PROXY pointing at a local recorder
// that logs each CONNECT target and refuses it, so nothing leaves the machine. POSTHOG_HOST is
// `https://posthog.invalid` and the venue `https://venue.invalid` (a reserved TLD that never
// resolves), so even a runtime that ignored the proxy could reach no one. The venue CONNECT each
// child makes proves that child's traffic goes through the recorder.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { PROJECT_KEYS } from "../src/lib/analytics.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BIN = join(ROOT, "packages", "cli", "src", "bin.ts");

let proxy: Server;
let proxyUrl = "";
const connects: string[] = [];

beforeAll(async () => {
  proxy = createServer((sock) => {
    sock.once("data", (d: Buffer) => {
      const first = d.toString("latin1").split("\r\n")[0] ?? "";
      const m = /^CONNECT (\S+) /u.exec(first);
      if (m) connects.push(m[1]!);
      sock.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

/** The environment a careless operator could have: everything that would turn analytics on. */
function trackingEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CORK_MCP_ANALYTICS: "1",
    POSTHOG_KEY: PROJECT_KEYS.staging,
    CORK_ENV: "staging",
    POSTHOG_HOST: "https://posthog.invalid",
    CORK_VENUE_URL: "https://venue.invalid",
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    CORK_CONFIG_NO_FETCH: "1",
    CORK_NO_UPDATE_NOTIFIER: "1",
  };
  for (const k of ["DO_NOT_TRACK", "CORK_TELEMETRY", "NO_PROXY", "no_proxy"]) delete env[k];
  return env;
}

function exited(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child did not exit in time"));
    }, ms);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

const posthogConnects = (): string[] => connects.filter((c) => c.startsWith("posthog.invalid"));

describe("with every analytics setting present, only the hosted server would send", () => {
  it("`ch query` makes no PostHog request", async () => {
    connects.length = 0;
    const child = spawn("bun", [BIN, "query", "rfq", "--json"], { cwd: ROOT, env: trackingEnv(), stdio: ["ignore", "ignore", "ignore"] });
    await exited(child, 60_000);
    expect(connects.some((c) => c.startsWith("venue.invalid"))).toBe(true);
    expect(posthogConnects()).toEqual([]);
  }, 70_000);

  it("`ch mcp` over stdio makes no PostHog request, through a tool call and a shutdown", async () => {
    connects.length = 0;
    const child = spawn("bun", [BIN, "mcp"], { cwd: ROOT, env: trackingEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const answered = new Promise<void>((resolve) => {
      child.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes('"id":3')) resolve();
      });
    });
    const send = (m: unknown) => child.stdin!.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0.0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cork_capabilities", arguments: {} } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cork_query", arguments: { resource: "rfqs" } } });
    await answered;
    child.kill("SIGTERM");
    await exited(child, 15_000);
    expect(connects.some((c) => c.startsWith("venue.invalid"))).toBe(true);
    expect(posthogConnects()).toEqual([]);
  }, 70_000);

  it("positive control: `ch mcp --http` with the same environment does flush to PostHog (on SIGTERM)", async () => {
    connects.length = 0;
    const child = spawn("bun", [BIN, "mcp", "--http", "--port", "0"], { cwd: ROOT, env: trackingEnv(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no readiness line: ${stderr}`)), 15_000);
      child.stderr!.on("data", (d: Buffer) => {
        stderr += d.toString();
        const m = /Streamable HTTP on [^\s:]+:(\d+)/u.exec(stderr);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
    });
    expect(stderr).toMatch(/analytics on \(staging/u);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0.0" } } }),
    });
    expect(res.status).toBe(200);
    child.kill("SIGTERM");
    expect(await exited(child, 15_000)).toBe(0);
    expect(posthogConnects().length).toBeGreaterThan(0);
  }, 40_000);
});
