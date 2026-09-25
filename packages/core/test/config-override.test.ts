// The local `config.json` override layer (config-override.ts + config-remote.ts applyOverride).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOverride,
  BUNDLED_DEFAULTS,
  generationsOf,
  loadOverrideFrom,
  mergeConfig,
  overrideCandidatePaths,
  parseOverride,
  resetConfigMemo,
  resolveConfig,
  resolveGenerations,
  runTool,
  type ConfigDeps,
  type HandlerContext,
} from "@cork/core";

const ctx: HandlerContext = { nowSeconds: 1n };
const base = BUNDLED_DEFAULTS;
const v03 = base.generations["8453"]!.sets["cork/v0.3"]!;
const v04 = base.generations["8453"]!.sets["cork/v0.4"]!;
const STAGING = { ...v04, status: "active" as const, distribution: "phoenix/v0.5-dark-launch" };

const deps = (loaded: ReturnType<ConfigDeps["loadOverride"] & object>): ConfigDeps => ({
  now: () => 1,
  fetchRemote: async () => ({ kind: "absent" as const }),
  loadOverride: () => loaded,
  loadCache: () => null,
  saveCache: () => {},
});

afterEach(() => resetConfigMemo());

describe("mergeConfig — the override wins at WHOLE-SET granularity", () => {
  it("adds a set and replaces a set by key; the replaced set is the override's, not a field merge", () => {
    const { merged, summary } = mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "8453": { sets: { "cork/v0.5-staging": STAGING, "cork/v0.3": { ...v03, status: "read-only" } } } } }));
    expect(Object.keys(merged.generations["8453"]!.sets)).toEqual(["cork/v0.4", "cork/v0.3", "cork/v0.5-staging"]);
    expect(merged.generations["8453"]!.sets["cork/v0.3"]!.status).toBe("read-only");
    expect(merged.generations["8453"]!.sets["cork/v0.3"]!.phoenix).toEqual(v03.phoenix); // the override's own copy — complete
    expect(merged.generations["8453"]!.primary).toBe("cork/v0.4");
    expect(summary).toEqual({ sets: ["8453/cork/v0.5-staging", "8453/cork/v0.3"], primaryMoved: [], filtered: [], chainEntries: [] });
    // the base is untouched
    expect(Object.keys(base.generations["8453"]!.sets)).toEqual(["cork/v0.4", "cork/v0.3"]);
    // other chains ride through
    expect(merged.generations["42161"]).toEqual(base.generations["42161"]);
    expect(merged.approvedImplementations).toEqual(base.approvedImplementations);
  });

  it("a partial set is refused by the schema — R5b: every set is complete", () => {
    expect(() => parseOverride({ schemaVersion: 2, generations: { "8453": { sets: { "cork/v0.3": { status: "active", phoenix: { poolManager: v03.phoenix!.poolManager } } } } } })).toThrow();
  });

  it("primary moves; a primary naming no set or a read-only set is refused", () => {
    const { merged, summary } = mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "8453": { primary: "cork/v0.5-staging", sets: { "cork/v0.5-staging": STAGING } } } }));
    expect(merged.generations["8453"]!.primary).toBe("cork/v0.5-staging");
    expect(summary.primaryMoved).toEqual(["8453"]);
    expect(generationsOf(merged, 8453)[0]!.label).toBe("cork/v0.5-staging");
    expect(() => mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "8453": { primary: "nope" } } }))).toThrow(/names no set/u);
    expect(() => mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "8453": { primary: "cork/v0.3", sets: { "cork/v0.3": { ...v03, status: "read-only" } } } } }))).toThrow(/must be active/u);
  });

  it("`only` keeps the listed sets (a partner pinning what it integrated); dropping the primary or naming a ghost is refused", () => {
    const { merged, summary } = mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "42161": { only: ["cork/v0.4", "cork/v0.3"] } } }));
    expect(Object.keys(merged.generations["42161"]!.sets)).toEqual(["cork/v0.4", "cork/v0.3"]);
    expect(summary.filtered).toEqual(["42161: arbitrum-v1.1, arbitrum-legacy"]);
    expect(() => mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "42161": { only: ["cork/v0.3"] } } }))).toThrow(/drops the primary/u);
    expect(() => mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "42161": { only: ["cork/v0.4", "ghost"] } } }))).toThrow(/do not exist/u);
    // `only` + a moved primary is the way to pin the previous generation alone
    const pinned = mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "8453": { primary: "cork/v0.3", only: ["cork/v0.3"] } } })).merged;
    expect(generationsOf(pinned, 8453).map((g) => [g.label, g.primary])).toEqual([["cork/v0.3", true]]);
  });

  it("a chain the default does not configure needs its own primary; LOP and Fusion entries are replaceable", () => {
    expect(() => mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "49222": { sets: { staging: STAGING } } } }))).toThrow(/must name `primary`/u);
    const { merged, summary } = mergeConfig(base, parseOverride({ schemaVersion: 2, generations: { "49222": { primary: "staging", sets: { staging: STAGING } } }, lopAddresses: { "49222": "0x111111125421cA6dc452d289314280a0f8842A65" } }));
    expect(merged.generations["49222"]!.primary).toBe("staging");
    expect(merged.lopAddresses["49222"]).toBe("0x111111125421cA6dc452d289314280a0f8842A65");
    expect(summary.chainEntries).toEqual(["49222/lop"]);
  });

  it("approvedImplementations is never overridable — the key alone refuses the document", () => {
    expect(() => parseOverride({ schemaVersion: 2, approvedImplementations: {} })).toThrow(/never overridable/u);
    expect(() => parseOverride({ schemaVersion: 2, unknownKey: 1 })).toThrow();
    expect(() => parseOverride({ schemaVersion: 1 })).toThrow();
  });
});

describe("applyOverride / resolveConfig — the layer is disclosed, a refused file serves the default alone", () => {
  it("none → the default layer, no warnings", async () => {
    const r = applyOverride({ defaults: base, source: "bundled" }, { kind: "none" });
    expect(r.override).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });
  it("ok → merged document, `override` provenance, config_override_active after the fetch warning", async () => {
    const r = applyOverride({ defaults: base, source: "cache", warning: { code: "config_fetch_failed", message: "x" } }, { kind: "ok", path: "/etc/cork/config.json", override: parseOverride({ schemaVersion: 2, generations: { "8453": { sets: { "cork/v0.5-staging": STAGING } } } }) });
    expect(r.override).toEqual({ path: "/etc/cork/config.json", sets: ["8453/cork/v0.5-staging"], primaryMoved: [], filtered: [], chainEntries: [] });
    expect(r.warnings.map((w) => w.code)).toEqual(["config_fetch_failed", "config_override_active"]);
    expect(r.warnings[1]!.message).toContain("/etc/cork/config.json");
    expect(r.warnings[1]!.message).toContain("8453/cork/v0.5-staging");
    expect(Object.keys(r.defaults.generations["8453"]!.sets)).toContain("cork/v0.5-staging");
  });
  it("a file that changes nothing is disclosed in provenance but does not warn (the private tree's empty placeholder)", () => {
    const r = applyOverride({ defaults: base, source: "bundled" }, { kind: "ok", path: "/repo/config.json", override: parseOverride({ schemaVersion: 2, generations: {} }) });
    expect(r.override).toEqual({ path: "/repo/config.json", sets: [], primaryMoved: [], filtered: [], chainEntries: [] });
    expect(r.warnings).toEqual([]);
    expect(r.defaults).toEqual(base);
  });
  it("invalid (schema) and invalid (merge) → the default alone + config_override_invalid; nothing partial", async () => {
    const bad = applyOverride({ defaults: base, source: "bundled" }, { kind: "invalid", path: "/x/config.json", error: "boom" });
    expect(bad.defaults).toBe(base);
    expect(bad.override).toBeUndefined();
    expect(bad.warnings.map((w) => w.code)).toEqual(["config_override_invalid"]);
    const merge = applyOverride({ defaults: base, source: "bundled" }, { kind: "ok", path: "/x/config.json", override: parseOverride({ schemaVersion: 2, generations: { "42161": { only: ["cork/v0.3"] } } }) });
    expect(merge.defaults).toBe(base);
    expect(merge.override).toBeUndefined(); // a refused file leaves NO provenance of an applied layer
    expect(merge.warnings[0]!.code).toBe("config_override_invalid");
    expect(merge.warnings[0]!.message).toMatch(/drops the primary/u);
  });
  it("resolveConfig applies the injected override on the offline path too, and the resolvers carry it", async () => {
    const d = deps({ kind: "ok", path: "/x/config.json", override: parseOverride({ schemaVersion: 2, generations: { "8453": { sets: { "cork/v0.5-staging": STAGING } } } }) });
    const cfg = await resolveConfig(d);
    expect(cfg.override?.sets).toEqual(["8453/cork/v0.5-staging"]);
    const gens = await resolveGenerations(8453, d);
    expect(gens.generations.map((g) => g.label)).toEqual(["cork/v0.4", "cork/v0.3", "cork/v0.5-staging"]);
    expect(gens.warnings.map((w) => w.code)).toEqual(["config_override_active"]);
    expect(gens.configOverride?.path).toBe("/x/config.json");
  });
});

describe("loadOverrideFrom — where the file comes from", () => {
  it("the first existing candidate wins; a missing file is silence; CORK_CONFIG_FILE naming a missing file is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "cork-override-"));
    const good = join(dir, "config.json");
    writeFileSync(good, JSON.stringify({ schemaVersion: 2, generations: {} }));
    expect(loadOverrideFrom([join(dir, "absent.json"), good], undefined)).toMatchObject({ kind: "ok", path: good });
    expect(loadOverrideFrom([join(dir, "absent.json")], undefined)).toEqual({ kind: "none" });
    expect(loadOverrideFrom([join(dir, "absent.json")], join(dir, "absent.json"))).toMatchObject({ kind: "invalid" });
    writeFileSync(join(dir, "broken.json"), "{ not json");
    expect(loadOverrideFrom([join(dir, "broken.json")], undefined)).toMatchObject({ kind: "invalid", path: join(dir, "broken.json") });
  });
  it("candidate order: CORK_CONFIG_FILE, the user's config dir, then the source tree's root", () => {
    const paths = overrideCandidatePaths({ CORK_CONFIG_FILE: "/explicit/config.json", XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv);
    expect(paths[0]).toBe("/explicit/config.json");
    expect(paths[1]).toBe("/xdg/cork-helper-cli/config.json");
    expect(paths.at(-1)).toMatch(/\/config\.json$/u);
    expect(overrideCandidatePaths({} as NodeJS.ProcessEnv)[0]).toMatch(/\.config\/cork-helper-cli\/config\.json$/u);
  });
});

describe("protocol-config discloses the layers", () => {
  it("data.config names the default source and, when applied, the override", async () => {
    const plain = await runTool("cork_query", { resource: "protocol-config", chainId: 8453 }, ctx);
    expect((plain.data as { config: unknown }).config).toEqual({ default: { file: "config.default.json", source: "bundled" } });
    expect(plain.warnings.map((w) => w.code)).not.toContain("config_override_active");
  });
});
