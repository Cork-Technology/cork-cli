// Offline unit tests for remote-first config sourcing: GitHub fetch (validated) → disk cache
// (positive AND negative) → bundled fallback. Noise policy under test: 404 ("not published") is
// silent; transient failures warn once per 10-min window. All I/O injected.
import { afterEach, describe, expect, it } from "vitest";
import {
  MAINNET_DEPLOYMENT,
  parseDefaults,
  resetConfigMemo,
  resolveConfig,
  resolveDeployment,
  resolveRollover,
  type ConfigDeps,
  type StoredCache,
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
    // (was 8453 until the Base shadow stack entered the bundled copy, 2026-08-07)
    "11155111": {
      poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC",
      constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A",
    },
  },
  lopAddresses: { "1": "0x111111125421cA6dc452d289314280a0f8842A65" },
};

function deps(opts: {
  remote?: unknown | Error | "absent";
  cache?: StoredCache | null;
  now?: number;
}): ConfigDeps & { saved: StoredCache[]; fetches: () => number } {
  const saved: StoredCache[] = [];
  let fetchCount = 0;
  return {
    saved,
    fetches: () => fetchCount,
    now: () => opts.now ?? 1_000_000_000,
    fetchRemote: async () => {
      fetchCount++;
      if (opts.remote instanceof Error) throw opts.remote;
      if (opts.remote === undefined) throw new Error("no remote configured");
      if (opts.remote === "absent") return { kind: "absent" };
      return { kind: "ok", data: opts.remote };
    },
    loadCache: () => opts.cache ?? null,
    saveCache: (entry) => saved.push(entry),
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
    expect(d.saved[0]?.defaults).toBeTruthy();
    resetConfigMemo();
    const dep = await resolveDeployment(11155111, deps({ remote: REMOTE_OK }));
    expect(dep.deployment?.poolManager).toBe("0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC"); // remote-only chain served
  });

  it("transient fetch failure → bundled fallback + one-line warning + negative cache entry", async () => {
    liftNoFetch();
    const d = deps({ remote: new Error("HTTP 503") });
    const r = await resolveConfig(d);
    expect(r.source).toBe("bundled");
    expect(r.warning?.code).toBe("config_fetch_failed");
    expect(r.warning?.message).toMatch(/bundled copy/);
    expect(r.warning?.message).toMatch(/stale/);
    expect(r.warning?.message).not.toContain("\n"); // one line, budgeted like success verbosity
    expect(d.saved[0]?.failure).toBe("error");
    // bundled content still serves the known chains
    expect(r.defaults.deployments["1"]?.corkAdapter).toBe(MAINNET_DEPLOYMENT.corkAdapter);
  });

  it("404/absent (file not published) → bundled fallback SILENTLY, negative-cached as 'absent'", async () => {
    liftNoFetch();
    const d = deps({ remote: "absent" });
    const r = await resolveConfig(d);
    expect(r.source).toBe("bundled");
    expect(r.warning).toBeUndefined(); // a deliberate state, not a failure — no noise
    expect(d.saved[0]?.failure).toBe("absent");
  });

  it("tampered/malformed remote content is rejected (treated as transient failure)", async () => {
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
    expect(d.fetches()).toBe(0);
  });

  it("fresh NEGATIVE cache suppresses refetching (error keeps its warning, absent stays silent)", async () => {
    liftNoFetch();
    // 60s after a transient failure: warn again, but do NOT re-attempt the fetch
    const dErr = deps({ remote: new Error("must not be called"), cache: { fetchedAt: 999_999_940, failure: "error" }, now: 1_000_000_000 });
    const rErr = await resolveConfig(dErr);
    expect(rErr.source).toBe("bundled");
    expect(rErr.warning?.code).toBe("config_fetch_failed");
    expect(dErr.fetches()).toBe(0);
    resetConfigMemo();
    // 60s after an absent result: silent, no re-attempt
    const dAbs = deps({ remote: new Error("must not be called"), cache: { fetchedAt: 999_999_940, failure: "absent" }, now: 1_000_000_000 });
    const rAbs = await resolveConfig(dAbs);
    expect(rAbs.warning).toBeUndefined();
    expect(dAbs.fetches()).toBe(0);
  });

  it("expired negative cache re-attempts the fetch (and can recover to github)", async () => {
    liftNoFetch();
    // 11 min after a failure, with the remote now healthy: fetch again and serve it
    const d = deps({ remote: REMOTE_OK, cache: { fetchedAt: 999_340_000, failure: "error" }, now: 1_000_000_000 });
    const r = await resolveConfig(d);
    expect(r.source).toBe("github");
    expect(r.warning).toBeUndefined();
    expect(d.fetches()).toBe(1);
  });

  it("CORK_CONFIG_NO_FETCH serves bundled with no warning and no I/O", async () => {
    process.env.CORK_CONFIG_NO_FETCH = "1";
    const d = deps({ remote: new Error("must not be called") });
    const r = await resolveConfig(d);
    expect(r.source).toBe("bundled");
    expect(r.warning).toBeUndefined();
    expect(d.fetches()).toBe(0);
  });

  it("parseDefaults enforces checksummed addresses", () => {
    expect(() => parseDefaults({ schemaVersion: 1, updated: "x", deployments: { "1": { poolManager: "0xccccccccccccfae2ee43f0e727a8c2969d74b9ec".toUpperCase(), constraintAdapter: "0x0" } }, lopAddresses: {} })).toThrow();
  });
});

describe("resolveRollover", () => {
  it("returns the bundled Arbitrum rollover deployment (factory + both settlers + seed block)", async () => {
    const r = await resolveRollover(42161);
    expect(r.rollover).toMatchObject({
      factory: "0xBBcC54c637c26b484A8c57b5695c04e09daCE13A",
      exactSettler: "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D",
      partialSettler: "0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a",
      settlerDomain: { name: "CorkSettler", version: "1.0.0" },
      seededAtBlock: 484973917,
    });
  });
  it("is undefined for chains without a rollover deployment", async () => {
    const r = await resolveRollover(1);
    expect(r.rollover).toBeUndefined();
  });
});

describe("deploymentProfiles in the bundled defaults", () => {
  // 2026-07-22 promotion: the announced Arbitrum deployment (formerly the arbitrum-staging
  // shadow) is now the primary; the pre-launch read-path pair survives as arbitrum-legacy
  // (3 calibration pools live on the old PM, none API-listed — verified via HyperSync scan).
  it("the primary 42161 deployment carries the full tx-path contract set (announced 2026-07-22, bindings verified on-chain)", async () => {
    const cfg = await resolveConfig();
    expect(cfg.defaults.deployments["42161"]).toMatchObject({
      poolManager: "0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2",
      corkAdapter: "0xe9f364dfcc358DC745Ff7C54cb087AE2520F1bed", // CORK() = the PM above
      bundler3: "0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13", // adapter BUNDLER3() = this
      whitelistManager: "0xeC187bA7BBd4016d8db326ea1DFb3DD48d17Bd3A",
    });
  });
  it("the arbitrum-legacy profile keeps the old read-path pair reachable", async () => {
    const cfg = await resolveConfig();
    const legacy = cfg.defaults.deploymentProfiles?.["42161"]?.["arbitrum-legacy"];
    expect(legacy?.poolManager).toBe("0xc2De56fb1C7a85250ce69C37B4773767C77954AE");
    // distinct from the primary deployment on the same chain
    expect(cfg.defaults.deployments["42161"]?.poolManager).not.toBe(legacy?.poolManager);
  });
});

describe("F16: a transient refresh failure never rolls addresses back to the bundled copy", () => {
  const OLD = 900_000_000_000; // fetchedAt far in the past so the good copy is TTL-expired
  const NOW = 1_000_000_000_000;

  it("keeps the last GOOD fetched defaults, serves them stale with a warning, and marks failedAt (no failure marker overwrite)", async () => {
    liftNoFetch();
    const d = deps({ remote: new Error("ECONNRESET"), cache: { fetchedAt: OLD, defaults: REMOTE_OK }, now: NOW });
    const r = await resolveConfig(d);
    // served the fetched-good copy, NOT the bundled fallback
    expect(r.source).toBe("cache");
    expect(r.warning?.code).toBe("config_fetch_failed");
    expect(r.defaults.deployments["11155111"]).toBeDefined(); // 11155111 exists ONLY in REMOTE_OK, not bundled
    // the good defaults survive on disk; only a failedAt back-off marker is added
    expect(d.saved).toHaveLength(1);
    expect(d.saved[0]?.defaults).toBeDefined();
    expect(d.saved[0]?.failure).toBeUndefined();
    expect(d.saved[0]?.failedAt).toBe(NOW);
    expect(d.fetches()).toBe(1); // it did attempt the refresh
  });

  it("during the failure back-off, serves the stale good copy WITHOUT re-fetching", async () => {
    liftNoFetch();
    // good defaults on disk, TTL-expired, with a recent failedAt inside the 10-min back-off window
    const d = deps({
      remote: new Error("must not be called during back-off"),
      cache: { fetchedAt: OLD, defaults: REMOTE_OK, failedAt: NOW - 60_000 }, // 1 min ago < 10 min
      now: NOW,
    });
    const r = await resolveConfig(d);
    expect(r.source).toBe("cache");
    expect(r.warning?.code).toBe("config_fetch_failed");
    expect(r.defaults.deployments["11155111"]).toBeDefined();
    expect(d.fetches()).toBe(0); // back-off honored — no network attempt
  });

  it("corrupt cached defaults do NOT block a fresh fetch (treated as absent)", async () => {
    liftNoFetch();
    const d = deps({ remote: REMOTE_OK, cache: { fetchedAt: OLD, defaults: { not: "valid defaults" } }, now: NOW });
    const r = await resolveConfig(d);
    expect(r.source).toBe("github"); // fell through to the (successful) fetch
    expect(d.fetches()).toBe(1);
  });
});
