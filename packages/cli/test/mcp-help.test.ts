// `ch mcp` is intercepted BEFORE commander (the stdio server must own stdout from process
// start), so its --help cannot come from the commander projection — bin.ts answers it itself.
// This spawns the REAL entrypoint: the regression this pins is `ch mcp --help` silently starting
// a stdio server and blocking on stdin (observed 2026-08-06).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function runBin(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [BIN, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    // The failure mode is a HANG (server waiting on stdin) — a hard kill turns it into a
    // visible non-zero exit instead of a vitest timeout.
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.on("error", reject);
  });
}

describe("ch mcp --help (pre-commander intercept)", () => {
  it("prints usage and exits 0 instead of starting the stdio server", async () => {
    const r = await runBin(["mcp", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: ch mcp");
    expect(r.stdout).toContain("--http");
    expect(r.stdout).toContain("CORK_MCP_TOKEN");
  });

  it("-h behaves the same", async () => {
    const r = await runBin(["mcp", "-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: ch mcp");
  });
});
