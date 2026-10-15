// Under vitest the RPC breaker state never reaches the developer's real cache file unless a test
// opts in with CORK_RPC_CACHE_FILE (the scan and constants caches follow the same rule). Found
// 2026-10-12: fake hosts injected by the failover tests sat in the real file with 179 failures each.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function endpointFailureInChild(home: string, url: string, file?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, VITEST: "true" };
  delete env.CORK_RPC_CACHE_FILE;
  if (file !== undefined) env.CORK_RPC_CACHE_FILE = file;
  const moduleUrl = new URL("../src/chain/rpc.ts", import.meta.url).href;
  const { stdout } = await execFileAsync(process.execPath, ["--eval", `
    import { homedir } from "node:os";
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const { reportEndpointFailure } = await import(${JSON.stringify(moduleUrl)});
    const home = homedir();
    const cacheFile = process.env.CORK_RPC_CACHE_FILE ?? join(home, ".cache", "cork-helper-cli", "rpc-state.json");
    reportEndpointFailure(8453, ${JSON.stringify(url)});
    const exists = existsSync(cacheFile);
    console.log(JSON.stringify({ home, cacheFile, exists, state: exists ? JSON.parse(readFileSync(cacheFile, "utf8")) : null }));
  `], { env });
  const result = JSON.parse(stdout) as { home: string; cacheFile: string; exists: boolean; state: { breaker: Record<string, { failures: number }> } | null };
  expect(result.home).toBe(home);
  return result;
}

describe("the RPC state cache is hermetic under vitest", () => {
  it("with no CORK_RPC_CACHE_FILE, an endpoint failure writes nothing under the home directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "rpc-home-"));
    try {
      const result = await endpointFailureInChild(home, "https://hermetic-default.example/rpc");
      expect(result.cacheFile).toBe(join(home, ".cache", "cork-helper-cli", "rpc-state.json"));
      expect(result.exists).toBe(false);
      expect(existsSync(result.cacheFile)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("a test that names a cache file still gets it written", async () => {
    const home = mkdtempSync(join(tmpdir(), "rpc-file-")), file = join(home, "state.json");
    try {
      const result = await endpointFailureInChild(home, "https://hermetic-optin.example/rpc", file);
      expect(result.cacheFile).toBe(file);
      expect(result.exists).toBe(true);
      expect(result.state?.breaker["https://hermetic-optin.example/rpc"]?.failures).toBe(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
