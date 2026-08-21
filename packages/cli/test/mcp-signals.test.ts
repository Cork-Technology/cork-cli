// `ch mcp` is PID 1 in the container, where SIGTERM has no default action: the server must
// handle it itself, or every `docker stop` waits out its timeout and SIGKILLs (measured 10.5 s
// on the v0.4.0-rc.1 image, 0.5 s behind an init). Spawns the REAL entry under bun, waits for
// the transport's own readiness line on stderr, signals it, and expects a prompt, clean exit
// (code 0, no signal) — for both transports. Offline, no timing guesses.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const env = { ...process.env, CORK_CONFIG_NO_FETCH: "1", CORK_NO_UPDATE_NOTIFIER: "1" };

/** Start `ch mcp …`, send SIGTERM once its readiness line appears, and report how it exited. */
function exitAfterSignal(args: string[], readyMarker: string): Promise<{ code: number | null; signal: string | null; stderr: string; stopMs: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["packages/cli/src/bin.ts", ...args], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let sentAt = 0;
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (!sentAt && stderr.includes(readyMarker)) {
        sentAt = Date.now();
        child.kill("SIGTERM");
      }
    });
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no exit within the guard after SIGTERM — the handler is missing or hangs; stderr:\n${stderr}`));
    }, 15_000);
    child.on("exit", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stderr, stopMs: sentAt ? Date.now() - sentAt : -1 });
    });
    child.on("error", reject);
  });
}

describe("ch mcp exits cleanly on SIGTERM (PID-1 safe)", () => {
  it("--http: drains, stops the server, exits 0 — not by signal, and well inside the drain bound", async () => {
    const r = await exitAfterSignal(["mcp", "--http", "--port", "0"], "Streamable HTTP on");
    expect(r.signal, r.stderr).toBeNull();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("SIGTERM — shutting down");
    expect(r.stopMs).toBeLessThan(5_000); // nothing in flight: the drain resolves at once, the bound never fires
  }, 30_000);

  it("stdio: closes the transport and exits 0 — not by signal", async () => {
    const r = await exitAfterSignal(["mcp"], "stdio transport connected");
    expect(r.signal, r.stderr).toBeNull();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stopMs).toBeLessThan(5_000);
  }, 30_000);
});
