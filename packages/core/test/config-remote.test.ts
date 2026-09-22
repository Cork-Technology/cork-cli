// Offline unit tests for remote-first config sourcing: GitHub fetch (validated) → disk cache
// (positive AND negative) → bundled fallback. Noise policy under test: 404 ("not published") is
// silent; transient failures warn once per 10-min window. All I/O injected.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Address } from "@cork/schemas";
import {
  BUNDLED_DEFAULTS,
  MAINNET_DEPLOYMENT,
  generationsOf,
  parseDefaults,
  resetConfigMemo,
  resolveConfig,
  resolveDeployment,
  resolveGenerations,
  resolveMarketRegistry,
  resolveRollover,
  activeRolloverGenerations,
  rolloverDigestScanTargets,
  rolloverFactoryScanTargets,
  rolloverGenerations,
  rolloverGenerationsOf,
  rolloverScanTargets,
  type ConfigDeps,
  type CorkRolloverDeployment,
  type ResolvedGeneration,
  type StoredCache,
} from "@cork/core";

const MAINNET_PHOENIX = {
  poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC",
  constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A",
  corkAdapter: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407",
  bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
  whitelistManager: "0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE",
  wire: "8-field",
};
const REMOTE_OK = {
  schemaVersion: 2,
  updated: "2099-01-01",
  generations: {
    "1": { primary: "mainnet", sets: { mainnet: { status: "active", phoenix: MAINNET_PHOENIX } } },
    // a chain the bundled copy does NOT know — proves remote-first override works
    // (was 8453 until the Base shadow stack entered the bundled copy, 2026-08-07)
    "11155111": {
      primary: "sepolia",
      sets: {
        sepolia: {
          status: "active",
          phoenix: { poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC", constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A", wire: "8-field" },
        },
      },
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
    expect(r.defaults.generations["1"]?.sets["mainnet"]?.phoenix?.corkAdapter).toBe(MAINNET_DEPLOYMENT.corkAdapter);
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
    const evil = { ...REMOTE_OK, generations: { "1": { primary: "mainnet", sets: { mainnet: { status: "active", phoenix: { poolManager: "not-an-address", constraintAdapter: "0x00", wire: "8-field" } } } } } };
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
    const set = (poolManager: string) => ({ schemaVersion: 2, updated: "x", generations: { "1": { primary: "m", sets: { m: { status: "active", phoenix: { poolManager, constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A", wire: "8-field" } } } } }, lopAddresses: {} });
    expect(() => parseDefaults(set("0xccccccccccccfae2ee43f0e727a8c2969d74b9ec".toUpperCase()))).toThrow();
    expect(() => parseDefaults(set("0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC"))).not.toThrow();
  });

  it("parseDefaults refuses a schema-1 document, an unknown wire, and a primary that names no set or a read-only set", () => {
    // The 0.6 line reads only v2 — a v1 file served at the v2 URL is invalid content, never a
    // silently mis-shaped fallback.
    expect(() => parseDefaults({ ...REMOTE_OK, schemaVersion: 1 })).toThrow();
    const wire = JSON.parse(JSON.stringify(REMOTE_OK));
    wire.generations["1"].sets.mainnet.phoenix.wire = "9-field";
    expect(() => parseDefaults(wire)).toThrow();
    const orphan = JSON.parse(JSON.stringify(REMOTE_OK));
    orphan.generations["1"].primary = "nowhere";
    expect(() => parseDefaults(orphan)).toThrow(/names no set/);
    const readOnly = JSON.parse(JSON.stringify(REMOTE_OK));
    readOnly.generations["1"].sets.mainnet.status = "read-only";
    expect(() => parseDefaults(readOnly)).toThrow(/must be active/);
  });
});

describe("old-binary safety: the FROZEN schema-1 file still parses under the v1 schema", () => {
  // `cork-defaults.json` keeps serving 0.5.x binaries at the v1 URL. Its shape is pinned HERE, by
  // a copy of the v1 schema that no longer exists in src — the test IS the freeze: a change to
  // the frozen file that an old binary would reject fails offline. The primary addresses it
  // carries stay the 0.5 line's (phoenix v1.3.0-rc.1 / market-registry 0.3.3 / rollover rc.2),
  // because a v1 file whose primary moved would send those binaries to a wire they do not speak.
  const V1_Address = Address;
  const V1_Deployment = z.object({ poolManager: V1_Address, constraintAdapter: V1_Address, corkAdapter: V1_Address.optional(), bundler3: V1_Address.optional(), whitelistManager: V1_Address.optional() }).strip();
  const V1_RolloverGeneration = z.object({ factory: V1_Address, exactSettler: V1_Address, partialSettler: V1_Address, seededAtBlock: z.number().int().nonnegative(), retired: z.string().optional(), label: z.string().optional(), contractsVersion: z.string().optional() }).strip();
  const V1_Rollover = V1_RolloverGeneration.extend({ settlerDomain: z.object({ name: z.string(), version: z.string() }).strip(), activeGenerations: z.array(V1_RolloverGeneration).optional(), legacyGenerations: z.array(V1_RolloverGeneration).optional() }).strip();
  const V1_MarketRegistry = z.object({ registry: V1_Address, adapter: V1_Address.optional(), marketCreator: V1_Address.optional(), controller: V1_Address.optional(), wrapperFactory: V1_Address.optional(), fixedRateOracleFactory: V1_Address.optional(), aggregatorAdapterFactory: V1_Address.optional(), recipes: z.record(z.string(), V1_Address).optional(), owner: V1_Address.optional(), contractsVersion: z.string().optional(), deployedAtBlock: z.number().int().nonnegative().optional() }).strip();
  const V1_MarketRegistryLegacy = z.object({ registry: V1_Address, oracleFactory: V1_Address.optional(), adapter: V1_Address.optional(), controller: V1_Address.optional() }).strip();
  const V1_Schema = z.object({
    schemaVersion: z.literal(1),
    updated: z.string(),
    deployments: z.record(z.string(), V1_Deployment),
    lopAddresses: z.record(z.string(), V1_Address),
    fusionSettlements: z.record(z.string(), z.object({ current: V1_Address, legacy: z.array(V1_Address).default([]) }).strip()).optional(),
    marketRegistry: z.record(z.string(), V1_MarketRegistry).optional(),
    marketRegistryLegacy: z.record(z.string(), V1_MarketRegistryLegacy).optional(),
    deploymentProfiles: z.record(z.string(), z.record(z.string(), V1_Deployment)).optional(),
    rollover: z.record(z.string(), V1_Rollover).optional(),
    approvedImplementations: z.record(z.string(), z.record(z.string(), z.object({ proxy: z.literal("eip1967").optional(), approved: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/u)) }).strip())).optional(),
  });
  const v1 = JSON.parse(readFileSync(new URL("../../../cork-defaults.json", import.meta.url), "utf8")) as unknown;

  it("cork-defaults.json is schema 1 and parses under the v1 schema", () => {
    const parsed = V1_Schema.parse(v1);
    expect(parsed.schemaVersion).toBe(1);
    // The frozen primaries: the 0.5 line's generation, never the 0.6 one.
    expect(parsed.deployments["42161"]?.poolManager).toBe("0x02803Bb52D2184f906F45B50C66AA969C2E37263");
    expect(parsed.marketRegistry?.["42161"]?.registry).toBe("0xa78d8137B01058dD23e545b6557209eBBc9611F1");
    expect(parsed.rollover?.["42161"]?.factory).toBe("0x697A6A2d5e09dc1CaBD0AA46678E053567275F82");
  });

  it("cork-defaults.json is BYTE-FROZEN at its v0.5.1 contents (sha256 pinned)", () => {
    // Frozen means frozen: on 2026-09-22 a cherry-pick had added `rollover.*.activeGenerations`
    // (the 0.2 settlers under a candidate label, with NO wire) to this file after v0.5.1 — a v1
    // reader honouring it would hash rc.2 typehashes for 0.2 settlers, exactly the class the freeze
    // exists to prevent (0.5.x binaries strip the key today, but the file is a published surface).
    // The pin is the v0.5.1 tag's bytes; a deliberate change to the frozen file must re-pin here
    // AND explain why an old binary is safe with it.
    const bytes = readFileSync(new URL("../../../cork-defaults.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("9ae3a0eeb73f182008c2dae0fe73a6ce3623cfe51122991cfd518a1c2c3acf97");
  });

  it("the 0.6 parser refuses the frozen v1 file (the two lines never read each other's document)", () => {
    expect(() => parseDefaults(v1)).toThrow();
  });

  it("every address the v1 file routes to is still a configured generation contract in v2 (nothing retired)", () => {
    const parsed = V1_Schema.parse(v1);
    const v2Addresses = new Set(
      Object.keys(BUNDLED_DEFAULTS.generations)
        .flatMap((c) => generationsOf(BUNDLED_DEFAULTS, Number(c)))
        .flatMap((g) => [...Object.values(g.phoenix ?? {}), ...Object.values(g.marketRegistry ?? {}).flatMap((v) => (typeof v === "object" ? Object.values(v) : [v])), ...Object.values(g.rollover ?? {})])
        .filter((v): v is string => typeof v === "string" && v.startsWith("0x"))
        .map((a) => a.toLowerCase()),
    );
    const v1Addresses = [
      ...Object.values(parsed.deployments).flatMap((d) => Object.values(d)),
      ...Object.values(parsed.deploymentProfiles ?? {}).flatMap((c) => Object.values(c).flatMap((d) => Object.values(d))),
      ...Object.values(parsed.marketRegistry ?? {}).flatMap((m) => [m.registry, m.adapter, m.marketCreator, m.controller, ...Object.values(m.recipes ?? {})]),
      ...Object.values(parsed.marketRegistryLegacy ?? {}).flatMap((m) => [m.registry, m.adapter, m.oracleFactory, m.controller]),
      ...Object.values(parsed.rollover ?? {}).flatMap((r) => [r.factory, r.exactSettler, r.partialSettler, ...(r.activeGenerations ?? []).flatMap((g) => [g.factory, g.exactSettler, g.partialSettler]), ...(r.legacyGenerations ?? []).flatMap((g) => [g.factory, g.exactSettler, g.partialSettler])]),
    ].filter((a): a is `0x${string}` => typeof a === "string");
    for (const a of v1Addresses) expect(v2Addresses.has(a.toLowerCase()), `${a} is routed by the frozen v1 file but no v2 generation carries it`).toBe(true);
  });
});

describe("resolveRollover", () => {
  it("serves the PRIMARY generation's rollover (v0.2.0, wire 0.2) on BOTH chains — identical CREATE2 addresses, per-chain seed blocks", async () => {
    const arb = await resolveRollover(42161);
    expect(arb.rollover).toMatchObject({
      factory: "0x99A5C47CbF062D4E6665afAF32aE6496F9f93F65",
      exactSettler: "0x0F2Ce7a5b817865ebFf50c58439B9A27E38f452E",
      partialSettler: "0x5E19Be0743fE521d8BF85b5A558356675499bE9e",
      settlerDomain: { name: "CorkSettler", version: "1.0.0" },
      seededAtBlock: 503918966,
      contractsVersion: "v0.2.0",
      wire: "0.2",
      label: "phoenix/v0.4-rc.1",
      status: "active",
      primary: true,
    });
    expect(arb.generation).toEqual({ label: "phoenix/v0.4-rc.1", status: "active", distribution: "phoenix/v0.4-rc.1", wire: "0.2" });
    const base = await resolveRollover(8453);
    expect(base.rollover).toMatchObject({ factory: "0x99A5C47CbF062D4E6665afAF32aE6496F9f93F65", seededAtBlock: 51153216, wire: "0.2" });
  });
  it("the whole flattened list rides along: rc.2 (phoenix/v0.3-rc.1) stays ACTIVE beside the primary, and Arbitrum's July set is RETIRED", async () => {
    const arb = (await resolveRollover(42161)).rollover!;
    expect(arb.generations.map((g) => [g.label, g.status, g.primary, g.wire])).toEqual([
      ["phoenix/v0.4-rc.1", "active", true, "0.2"],
      ["phoenix/v0.3-rc.1", "active", false, "rc.2"],
      ["arbitrum-v1.1", "retired", false, "rc.1"],
    ]);
    expect(arb.generations[1]).toMatchObject({ factory: "0x697A6A2d5e09dc1CaBD0AA46678E053567275F82", exactSettler: "0xF4ffd4b3FAedb784b04d1883119840515f224C2f", partialSettler: "0xC0fbA28687D16e9A94527F7864C7c8D41f1E6B4e", seededAtBlock: 494104750, contractsVersion: "v0.1.0-rc.2" });
    expect(arb.generations[2]).toMatchObject({ factory: "0xBBcC54c637c26b484A8c57b5695c04e09daCE13A", exactSettler: "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D", partialSettler: "0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a", seededAtBlock: 484973917, retired: "2026-08-13" });
    // Base has never had a RETIRED generation.
    const base = (await resolveRollover(8453)).rollover!;
    expect(base.generations.map((g) => [g.label, g.status])).toEqual([["phoenix/v0.4-rc.1", "active"], ["phoenix/v0.3-rc.1", "active"]]);
    expect(rolloverGenerations(base).find((g) => g.label === "phoenix/v0.3-rc.1")?.seededAtBlock).toBe(49917191);
  });
  it("a generation label selects THAT set's block as the top-level fields; the list is unchanged", async () => {
    const r = await resolveRollover(42161, undefined, "phoenix/v0.3-rc.1");
    expect(r.rollover).toMatchObject({ factory: "0x697A6A2d5e09dc1CaBD0AA46678E053567275F82", wire: "rc.2", label: "phoenix/v0.3-rc.1", primary: false });
    expect(r.generation).toMatchObject({ label: "phoenix/v0.3-rc.1", wire: "rc.2" });
    expect(r.rollover!.generations).toHaveLength(3);
    // A generation without a rollover block answers undefined but still names itself.
    const ro = await resolveRollover(42161, undefined, "arbitrum-legacy");
    expect(ro.rollover).toBeUndefined();
    expect(ro.generation).toEqual({ label: "arbitrum-legacy", status: "read-only" });
    // An unknown label is a typed refusal that lists the chain's labels.
    const bad = await resolveRollover(42161, undefined, "nope");
    expect(bad.rollover).toBeUndefined();
    expect(bad.refusal?.code).toBe("generation_unknown");
    expect(bad.refusal?.message).toContain("phoenix/v0.4-rc.1 (active, primary)");
  });
  it("is undefined for chains without a rollover deployment", async () => {
    const r = await resolveRollover(1);
    expect(r.rollover).toBeUndefined();
    expect(r.generation).toEqual({ label: "mainnet", status: "active" });
  });
});

describe("rolloverGenerations — the ONE flattening every generation-aware consumer reads", () => {
  const DOMAIN = { name: "CorkSettler", version: "1.0.0" };
  /** A hand-built chain: the same three sets the bundled 42161 config carries, as generations. */
  const gens = (over: Partial<Record<"primary" | "rc2" | "july", Partial<ResolvedGeneration["rollover"]> | null>> = {}): ResolvedGeneration[] => {
    const set = (label: string, status: "active" | "read-only", primary: boolean, rollover: NonNullable<ResolvedGeneration["rollover"]> | undefined): ResolvedGeneration => ({ label, status, primary, ...(rollover ? { rollover } : {}) });
    const p = over.primary === null ? undefined : { factory: "0x99A5C47CbF062D4E6665afAF32aE6496F9f93F65", exactSettler: "0x0F2Ce7a5b817865ebFf50c58439B9A27E38f452E", partialSettler: "0x5E19Be0743fE521d8BF85b5A558356675499bE9e", settlerDomain: DOMAIN, seededAtBlock: 503918966, contractsVersion: "v0.2.0", wire: "0.2" as const, ...over.primary };
    const rc2 = over.rc2 === null ? undefined : { factory: "0x697A6A2d5e09dc1CaBD0AA46678E053567275F82", exactSettler: "0xF4ffd4b3FAedb784b04d1883119840515f224C2f", partialSettler: "0xC0fbA28687D16e9A94527F7864C7c8D41f1E6B4e", settlerDomain: DOMAIN, seededAtBlock: 494104750, contractsVersion: "v0.1.0-rc.2", wire: "rc.2" as const, ...over.rc2 };
    const july = over.july === null ? undefined : { factory: "0xBBcC54c637c26b484A8c57b5695c04e09daCE13A", exactSettler: "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D", partialSettler: "0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a", settlerDomain: DOMAIN, seededAtBlock: 484973917, retired: "2026-08-13", wire: "rc.1" as const, ...over.july };
    return [set("phoenix/v0.4-rc.1", "active", true, p as never), set("phoenix/v0.3-rc.1", "active", false, rc2 as never), set("arbitrum-v1.1", "active", false, july as never), set("arbitrum-legacy", "read-only", false, undefined)];
  };
  const dep = (list = gens()): CorkRolloverDeployment => {
    const generations = rolloverGenerationsOf(list);
    return { ...generations[0]!, generations };
  };

  it("orders primary → other active → retired, with status, wire and the primary flag on exactly one entry; a set without a rollover block is absent", () => {
    const flat = rolloverGenerations(dep());
    expect(flat.map((g) => [g.label, g.status, g.primary, g.wire])).toEqual([
      ["phoenix/v0.4-rc.1", "active", true, "0.2"],
      ["phoenix/v0.3-rc.1", "active", false, "rc.2"],
      ["arbitrum-v1.1", "retired", false, "rc.1"],
    ]);
    expect(flat[0]).toMatchObject({ factory: "0x99A5C47CbF062D4E6665afAF32aE6496F9f93F65", seededAtBlock: 503918966, contractsVersion: "v0.2.0", settlerDomain: DOMAIN });
    // The deployment-only field never leaks into a generation entry.
    expect(flat[0]).not.toHaveProperty("generations");
    expect(activeRolloverGenerations(dep())).toHaveLength(2);
    expect(activeRolloverGenerations(dep()).map((g) => g.primary)).toEqual([true, false]);
  });

  it("the primary flag follows the PRIMARY GENERATION's live block, or the first live block when the primary generation carries none", () => {
    // Primary generation without a rollover block: the next live block (rc.2) becomes the
    // rollover primary — consumers always have exactly one when any active rollover exists.
    const noPrimary = rolloverGenerationsOf(gens({ primary: null }));
    expect(noPrimary.map((g) => [g.label, g.primary])).toEqual([["phoenix/v0.3-rc.1", true], ["arbitrum-v1.1", false]]);
    // A retired block on the primary generation never takes the flag.
    const retiredPrimary = rolloverGenerationsOf(gens({ primary: { retired: "2099-01-01" } }));
    expect(retiredPrimary.map((g) => [g.label, g.status, g.primary])).toEqual([["phoenix/v0.3-rc.1", "active", true], ["phoenix/v0.4-rc.1", "retired", false], ["arbitrum-v1.1", "retired", false]]);
    // No rollover anywhere: an empty list, no invented primary.
    expect(rolloverGenerationsOf(gens({ primary: null, rc2: null, july: null }))).toEqual([]);
  });

  it("a record without `generations` (a hand-built single set) is exactly one active primary generation", () => {
    const single = { factory: "0x99A5C47CbF062D4E6665afAF32aE6496F9f93F65", exactSettler: "0x0F2Ce7a5b817865ebFf50c58439B9A27E38f452E", partialSettler: "0x5E19Be0743fE521d8BF85b5A558356675499bE9e", seededAtBlock: 1, contractsVersion: "v0.2.0", wire: "0.2" as const };
    const flat = rolloverGenerations(single);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ status: "active", primary: true, label: "v0.2.0", wire: "0.2" });
  });

  it("scan targets span every generation from the earliest seed; scoping follows the OWNING generation's seed", async () => {
    const full = rolloverScanTargets(dep());
    expect(full.settlers.map((a) => a.toLowerCase())).toEqual([
      "0x0f2ce7a5b817865ebff50c58439b9a27e38f452e",
      "0x5e19be0743fe521d8bf85b5a558356675499be9e",
      "0xf4ffd4b3faedb784b04d1883119840515f224c2f",
      "0xc0fba28687d16e9a94527f7864c7c8d41f1e6b4e",
      "0x983270ae48545665cee4d7ef61c65ff3fdc8222d",
      "0x8e9ca640338d3bdbfe3781d7178ca73af66f366a",
    ]);
    expect(full.factories).toHaveLength(3);
    expect(full.fromBlock).toBe(484973917); // the retired July seed is still the floor
    // The 0.2 set is seeded ~9M blocks after rc.2: scoping to it must NOT fall back to the rc.2
    // or July floor (an "active means primary" regression would).
    expect(rolloverDigestScanTargets(dep(), "0x5E19Be0743fE521d8BF85b5A558356675499bE9e")).toEqual({ addresses: ["0x5E19Be0743fE521d8BF85b5A558356675499bE9e"], fromBlock: 503918966 });
    expect(rolloverDigestScanTargets(dep(), "0xF4ffd4b3FAedb784b04d1883119840515f224C2f")).toEqual({ addresses: ["0xF4ffd4b3FAedb784b04d1883119840515f224C2f"], fromBlock: 494104750 });
    expect(rolloverFactoryScanTargets(dep(), "0x99a5c47cbf062d4e6665afaf32ae6496f9f93f65")).toEqual({ addresses: ["0x99a5c47cbf062d4e6665afaf32ae6496f9f93f65"], fromBlock: 503918966 });
    // Base: the same 0.2 set seeds at 51153216 and rc.2 at 49917191 — the bundled config.
    const base = (await resolveRollover(8453)).rollover!;
    expect(rolloverScanTargets(base).fromBlock).toBe(49917191);
    expect(rolloverDigestScanTargets(base, "0x0F2Ce7a5b817865ebFf50c58439B9A27E38f452E").fromBlock).toBe(51153216);
  });
});

describe("generations in the bundled defaults", () => {
  // 2026-09-22: the Distribution phoenix/v0.4-rc.1 set (phoenix v1.4.0-rc.1, 10-field wire) is
  // the primary on 42161 + 8453; phoenix/v0.3-rc.1 (the 0.5 line's primary, 8-field) stays
  // ACTIVE beside it; arbitrum-v1.1 (the venue's existing markets, the legacy registry, the
  // retired July rollover) stays active; arbitrum-legacy (the pre-launch pair) is read-only.
  it("42161: four generations in resolution order (primary, other active in config order, read-only last), each block declaring its wire", async () => {
    const { generations, primary } = await resolveGenerations(42161);
    expect(generations.map((g) => [g.label, g.status, g.primary])).toEqual([
      ["phoenix/v0.4-rc.1", "active", true],
      ["phoenix/v0.3-rc.1", "active", false],
      ["arbitrum-v1.1", "active", false],
      ["arbitrum-legacy", "read-only", false],
    ]);
    expect(primary?.label).toBe("phoenix/v0.4-rc.1");
    expect(generations.map((g) => [g.phoenix?.wire, g.marketRegistry?.wire, g.rollover?.wire])).toEqual([
      ["10-field", "nested", "0.2"],
      ["8-field", "flat", "rc.2"],
      ["8-field", "legacy", "rc.1"],
      ["8-field", undefined, undefined],
    ]);
  });
  it("the primary 42161 deployment is the v1.4.0-rc.1 stack (Distribution record, bindings verified live 2026-09-22)", async () => {
    const r = await resolveDeployment(42161);
    expect(r.deployment).toMatchObject({
      poolManager: "0xcC17224A8710fa23BdA40c2CB563b85CeDDb0C2D",
      constraintAdapter: "0x2f9d816191B390A429174902E4A276A019cBf554",
      corkAdapter: "0x71eB628c3A40FB3896613804847840426f9284A7",
      bundler3: "0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13",
      whitelistManager: "0x8aF6659d864cB632bcadF0744Fb8B5eE78fBEA51",
      controller: "0x66025095Ab3a7E60BA9C2b15e203822d5d3647b5",
      wire: "10-field",
    });
    expect(r.generation).toEqual({ label: "phoenix/v0.4-rc.1", status: "active", distribution: "phoenix/v0.4-rc.1", wire: "10-field" });
    // Base carries the SAME set except bundler3 (Morpho's per-chain deployment, read from the
    // adapter's own BUNDLER3() immutable on Base).
    expect((await resolveDeployment(8453)).deployment).toMatchObject({ poolManager: "0xcC17224A8710fa23BdA40c2CB563b85CeDDb0C2D", bundler3: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4", wire: "10-field" });
  });
  it("the phoenix/v0.3-rc.1 generation keeps the v1.3.0-rc.1 stack + the 0.3.3 registry fully reachable by label", async () => {
    const r = await resolveDeployment(42161, undefined, "phoenix/v0.3-rc.1");
    expect(r.deployment).toMatchObject({ poolManager: "0x02803Bb52D2184f906F45B50C66AA969C2E37263", corkAdapter: "0xfa8A94046f0bC16Da683Aa8219bd960FDAF572AD", controller: "0x6b65D663e0B445BAf1870D5af806d57Ebb2C82A1", wire: "8-field" });
    const mr = await resolveMarketRegistry(42161, undefined, "phoenix/v0.3-rc.1");
    expect(mr.marketRegistry).toMatchObject({ registry: "0xa78d8137B01058dD23e545b6557209eBBc9611F1", adapter: "0x8902a88912a334263fe3d731d03c267715b9374f", marketCreator: "0x0aCccE0ef90da8b8d95DBFeE2ADaaED9b566586C", contractsVersion: "0.3.3", wire: "flat" });
    expect(mr.generation).toMatchObject({ label: "phoenix/v0.3-rc.1", wire: "flat" });
    // The primary registry is the 0.5.0 nested-wire set.
    expect((await resolveMarketRegistry(42161)).marketRegistry).toMatchObject({ registry: "0xe1f569f152bDB6eBB2d49cFd9d4aB98ECEe955c5", adapter: "0x3E01C558fc0854e92e6ef2a84c19D6Bf9D82B104", marketCreator: "0x1A074F17647504D1c50B436074a74d051D502dEa", contractsVersion: "0.5.0", deployedAtBlock: 503851928, wire: "nested" });
    expect((await resolveMarketRegistry(8453)).marketRegistry).toMatchObject({ deployedAtBlock: 51145039, wire: "nested" });
  });
  it("arbitrum-v1.1 keeps the previous production stack and the legacy registry; arbitrum-legacy keeps the old read-path pair (read-only)", async () => {
    const v11 = await resolveDeployment(42161, undefined, "arbitrum-v1.1");
    expect(v11.deployment).toMatchObject({ poolManager: "0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2", corkAdapter: "0xe9f364dfcc358DC745Ff7C54cb087AE2520F1bed", whitelistManager: "0xeC187bA7BBd4016d8db326ea1DFb3DD48d17Bd3A", controller: "0xdCC0388c68f85e65FA08dCb445B4d0927e9E6172", wire: "8-field" });
    expect((await resolveMarketRegistry(42161, undefined, "arbitrum-v1.1")).marketRegistry).toMatchObject({ registry: "0xF674488bf4643e205ccd826951e8b0d29f77600A", oracleFactory: "0x0d81045225932C8B99a5DBD3cAe8d047b44D44A2", adapter: "0xea15BF1E5565181Ed8678CcFf39D797272858505", wire: "legacy" });
    const legacy = await resolveDeployment(42161, undefined, "arbitrum-legacy");
    expect(legacy.deployment?.poolManager).toBe("0xc2De56fb1C7a85250ce69C37B4773767C77954AE");
    expect(legacy.generation).toEqual({ label: "arbitrum-legacy", status: "read-only", wire: "8-field" });
    expect((await resolveDeployment(42161)).deployment?.poolManager).not.toBe(legacy.deployment?.poolManager);
  });
  it("chain 1 is the single `mainnet` generation with no registry or rollover; an unknown label refuses with the list", async () => {
    const { generations } = await resolveGenerations(1);
    expect(generations.map((g) => [g.label, g.primary])).toEqual([["mainnet", true]]);
    expect((await resolveDeployment(1)).deployment).toEqual({ ...MAINNET_DEPLOYMENT });
    expect((await resolveMarketRegistry(1)).marketRegistry).toBeUndefined();
    const bad = await resolveDeployment(42161, undefined, "phoenix/v9");
    expect(bad.deployment).toBeUndefined();
    expect(bad.refusal).toMatchObject({ code: "generation_unknown" });
    expect(bad.refusal?.message).toContain("arbitrum-legacy (read-only)");
    // A chain with no generations answers undefined, no refusal (nothing to select from).
    const none = await resolveDeployment(11155111);
    expect(none.deployment).toBeUndefined();
    expect(none.refusal).toBeUndefined();
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
    expect(r.defaults.generations["11155111"]).toBeDefined(); // 11155111 exists ONLY in REMOTE_OK, not bundled
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
    expect(r.defaults.generations["11155111"]).toBeDefined();
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
