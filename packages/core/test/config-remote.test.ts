// Offline unit tests for remote-first config sourcing: GitHub fetch (validated) → disk cache →
// bundled fallback with the authenticated-GitHub/fallback warning. All I/O injected.
import { afterEach, describe, expect, it } from "vitest";
import {
  MAINNET_DEPLOYMENT,
  parseDefaults,
  resetConfigMemo,
  resolveConfig,
  resolveDeployment,
  type ConfigDeps,
} from "@cork/core";

const REMOTE_OK = {
  schemaVersion: 1,
  updated: "2099-01-01",
  deployments: {
    "1": {
      poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC",
      constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A",
      corkAdapter: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407",
      bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
      whitelistManager: "0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE",
    },
    // a chain the bundled copy does NOT know — proves remote-first override works
    "8453": {
      poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC",
      constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A",
    },
  },
  lopAddresses: { "1": "0x111111125421cA6dc452d289314280a0f8842A65" },
};

function deps(opts: { remote?: unknown | Error; cache?: { fetchedAt: number; defaults: unknown } | null; now?: number }): ConfigDeps & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    now: () => opts.now ?? 1_000_000_000,
    fetchRemote: async () => {
      if (opts.remote instanceof Error) throw opts.remote;
      if (opts.remote === undefined) throw new Error("no remote configured");
      return opts.remote;
    },
    loadCache: () => opts.cache ?? null,
    saveCache: (fetchedAt, defaults) => saved.push({ fetchedAt, defaults }),
  };
}

// These tests exercise the injected-deps path — the suite-wide CORK_CONFIG_NO_FETCH short-circuit
// must be lifted inside them and restored after.
const NO_FETCH = process.env.CORK_CONFIG_NO_FETCH;
function liftNoFetch() {
  delete process.env.CORK_CONFIG_NO_FETCH;
}
afterEach(() => {
  if (NO_FETCH !== undefined) process.env.CORK_CONFIG_NO_FETCH = NO_FETCH;
  resetConfigMemo();
});

describe("resolveConfig precedence", () => {
  it("valid remote fetch wins, is cached, and carries no warning", async () => {
    liftNoFetch();
    const d = deps({ remote: REMOTE_OK });
    const r = await resolveConfig(d);
    expect(r.source).toBe("github");
    expect(r.warning).toBeUndefined();
    expect(d.saved).toHaveLength(1);
    resetConfigMemo();
    const dep = await resolveDeployment(8453, deps({ remote: REMOTE_OK }));
    expect(dep.deployment?.poolManager).toBe("0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC"); // remote-only chain served
  });

  it("fetch failure → bundled fallback + the authenticated-GitHub/fallback warning", async () => {
    liftNoFetch();
    const r = await resolveConfig(deps({ remote: new Error("HTTP 404") }));
    expect(r.source).toBe("bundled");
    expect(r.warning?.code).toBe("config_fetch_failed");
    expect(r.warning?.message).toMatch(/authenticated GitHub MCP|`gh` CLI/);
    expect(r.warning?.message).toMatch(/whitelisted/);
    expect(r.warning?.message).toMatch(/fallback address file/);
    // bundled content still serves the known chains
    expect(r.defaults.deployments["1"]?.corkAdapter).toBe(MAINNET_DEPLOYMENT.corkAdapter);
  });

  it("tampered/malformed remote content is rejected (treated as fetch failure)", async () => {
    liftNoFetch();
    const evil = { ...REMOTE_OK, deployments: { "1": { poolManager: "not-an-address", constraintAdapter: "0x00" } } };
    const r = await resolveConfig(deps({ remote: evil }));
    expect(r.source).toBe("bundled");
    expect(r.warning?.code).toBe("config_fetch_failed");
  });

  it("fresh disk cache is served without refetching", async () => {
    liftNoFetch();
    const d = deps({ remote: new Error("must not be called"), cache: { fetchedAt: 999_999_000, defaults: REMOTE_OK }, now: 1_000_000_000 });
    const r = await resolveConfig(d);
    expect(r.source).toBe("cache");
    expect(r.warning).toBeUndefined();
  });

  it("CORK_CONFIG_NO_FETCH serves bundled with no warning and no I/O", async () => {
    process.env.CORK_CONFIG_NO_FETCH = "1";
    const d = deps({ remote: new Error("must not be called") });
    const r = await resolveConfig(d);
    expect(r.source).toBe("bundled");
    expect(r.warning).toBeUndefined();
  });

  it("parseDefaults enforces checksummed addresses", () => {
    expect(() => parseDefaults({ schemaVersion: 1, updated: "x", deployments: { "1": { poolManager: "0xccccccccccccfae2ee43f0e727a8c2969d74b9ec".toUpperCase(), constraintAdapter: "0x0" } }, lopAddresses: {} })).toThrow();
  });
});
