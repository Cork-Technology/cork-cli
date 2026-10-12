// Under vitest the RPC breaker state never reaches the developer's real cache file unless a test
// opts in with CORK_RPC_CACHE_FILE (the scan and constants caches follow the same rule). Found
// 2026-10-12: fake hosts injected by the failover tests sat in the real file with 179 failures each.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportEndpointFailure } from "../src/chain/rpc.ts";

const saved = { home: process.env.HOME, file: process.env.CORK_RPC_CACHE_FILE };
afterEach(() => {
  process.env.HOME = saved.home;
  if (saved.file === undefined) delete process.env.CORK_RPC_CACHE_FILE;
  else process.env.CORK_RPC_CACHE_FILE = saved.file;
});

describe("the RPC state cache is hermetic under vitest", () => {
  it("with no CORK_RPC_CACHE_FILE, an endpoint failure writes nothing under the home directory", () => {
    const home = mkdtempSync(join(tmpdir(), "rpc-home-"));
    process.env.HOME = home;
    delete process.env.CORK_RPC_CACHE_FILE;
    reportEndpointFailure(8453, "https://hermetic-default.example/rpc");
    expect(existsSync(join(home, ".cache", "cork-helper-cli"))).toBe(false);
  });

  it("a test that names a cache file still gets it written", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rpc-file-")), "state.json");
    process.env.CORK_RPC_CACHE_FILE = file;
    reportEndpointFailure(8453, "https://hermetic-optin.example/rpc");
    const state = JSON.parse(readFileSync(file, "utf8")) as { breaker: Record<string, { failures: number }> };
    expect(state.breaker["https://hermetic-optin.example/rpc"]?.failures).toBe(1);
  });
});
