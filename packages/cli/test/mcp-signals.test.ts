// `ch mcp` is PID 1 in the container, where SIGTERM has no default action: the server must
// handle it itself, or every `docker stop` waits out its timeout and SIGKILLs (measured 10.5 s
// on the v0.4.0-rc.1 image, 0.5 s behind an init). Spawns the REAL entry under bun, signals it,
// and expects a prompt, clean exit (code 0, no signal) — for both transports. Offline.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const env = { ...process.env, CORK_CONFIG_NO_FETCH: "1", CORK_NO_UPDATE_NOTIFIER: "1" };

/** Start `ch mcp …`, send SIGTERM once it is up, and report how it exited. */
function exitAfterSignal(args: string[], readyMarker: string | null): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["packages/cli/src/bin.ts", ...args], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let sent = false;
    const fire = () => {
      if (sent) return;
      sent = true;
      child.kill("SIGTERM");
    };
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (readyMarker && stderr.includes(readyMarker)) fire();
    });
    // stdio prints no ready line; give the runtime time to finish its imports first.
    if (!readyMarker) setTimeout(fire, 1500);
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no exit within the guard after SIGTERM — the handler is missing or hangs; stderr:\n${stderr}`));
    }, 12_000);
    child.on("exit", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stderr });
    });
    child.on("error", reject);
  });
}

describe("ch mcp exits cleanly on SIGTERM (PID-1 safe)", () => {
  it("--http: stops the server and exits 0, not by signal", async () => {
    const r = await exitAfterSignal(["mcp", "--http", "--port", "0"], "Streamable HTTP on");
    expect(r.signal, r.stderr).toBeNull();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("SIGTERM — shutting down");
  }, 25_000);

  it("stdio: closes the transport and exits 0, not by signal", async () => {
    const r = await exitAfterSignal(["mcp"], null);
    expect(r.signal, r.stderr).toBeNull();
    expect(r.code, r.stderr).toBe(0);
  }, 25_000);
});
