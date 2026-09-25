// Docs-freshness gate — the drift class behind cork-cli issue #1 (the partner quickstart shipped
// a full release cycle documenting the RETIRED registry generation while cork-defaults.json at
// the same tag carried the current one). Docs are prose, so no type checker sees them rot; this
// suite makes the rot self-announcing by tying the quickstart's generation markers to the SAME
// config the tool resolves. The next registry redeploy edits cork-defaults.json → this fails →
// the doc refresh becomes part of the change, not a partner-filed issue.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const quickstart = read("../../../docs/zyfai-quickstart.md");
const anatomy = read("../../../docs/jit-order-anatomy.md");
// Schema 2 (0.6): a chain hosts a SET of generations, one primary. The quickstart's worked
// examples are live captures against cork/v0.3 (0.3.3), which stays ACTIVE — so the doc
// must name BOTH the primary set's addresses (what a new market uses) and the 0.3.3 set's (what
// every listed pool still reads as), and no address from a retired or legacy set.
type MarketRegistryBlock = { registry: string; adapter: string; contractsVersion: string; wire: string; recipes?: Record<string, string> };
const config = JSON.parse(read("../../../config.default.json")) as {
  generations: Record<string, { primary: string; sets: Record<string, { status: string; marketRegistry?: MarketRegistryBlock & Record<string, unknown> }> }>;
};

// The quickstart's walkthrough chain (Base).
const BASE = config.generations["8453"]!;
const PRIMARY = BASE.sets[BASE.primary]!.marketRegistry!;
const ACTIVE_REGISTRIES = Object.values(BASE.sets)
  .filter((g) => g.status === "active" && g.marketRegistry && g.marketRegistry.wire !== "legacy")
  .map((g) => g.marketRegistry!);
// The set the examples were captured against; the test names it by wire so a future relabel fails loudly.
const FLAT = ACTIVE_REGISTRIES.find((mr) => mr.wire === "flat")!;
const ARBITRUM = config.generations["42161"]!;
const LEGACY_STACKS = Object.values(ARBITRUM.sets)
  .map((g) => g.marketRegistry)
  .filter((mr): mr is MarketRegistryBlock & Record<string, unknown> => mr !== undefined && mr.wire === "legacy");

/** Superseded 0.3.x stacks, pinned as history: these exact addresses shipped in the quickstart's
 *  worked examples after the 0.3.3 redeploy retired them (issue #1's drift inventory). Config no
 *  longer records them anywhere (git history does), so they are constants here — append the next
 *  generation's set when it retires; never remove entries. */
const RETIRED_032_STACK = [
  "0xF5323F305360A792284814a7EDe78c2209A1DC94", // MarketRegistry 0.3.2
  "0x1b754F17EDd87784b01542aAe0e4CA672CFdc7CE", // CorkLimitOrderAdapter 0.3.2
  "0xD27c7BB8564Db019B41d9C48d1ABCEd9A7d90291", // LiquidityPriceRecipe 0.3.2
  "0x1cF1ef3F0d2f59Bf26A373ce7Dcf0F88612C1506", // LiquidityNavRecipe 0.3.2
  "0x6d838136bbbE7D34Ce8dDDc431Ce1bB4A1F9D98D", // FixedRateRecipe 0.3.2
  "0x0846D8849887fC377891E716D3bF4ad46208aA82", // sUSDe/mwUSDC nav wrapper under the 0.3.2 registry
];

const has = (doc: string, needle: string) => doc.toLowerCase().includes(needle.toLowerCase());

describe("docs freshness: zyfai-quickstart.md tracks the configured registry generations", () => {
  it("the config pins a nested-wire primary and a flat-wire active set on Base (the two generations the doc describes)", () => {
    expect(PRIMARY.wire).toBe("nested");
    expect(FLAT, "an ACTIVE flat-wire (0.3.x) registry on Base — the set the worked examples were captured against").toBeDefined();
    expect(BASE.primary).toBe("cork/v0.4");
  });

  it("names the PRIMARY generation: registry, adapter, market creator and all four recipes from config.default.json", () => {
    const r = PRIMARY.recipes!;
    for (const addr of [PRIMARY.registry, PRIMARY.adapter, PRIMARY["marketCreator"] as string, r.liquidity!, r.nav!, r.fixed!, r.impairment!]) {
      expect(has(quickstart, addr), `quickstart must show the primary-generation address ${addr}`).toBe(true);
    }
  });

  it("still names the ACTIVE flat-wire generation its examples were captured against: registry, adapter, and all three original recipes", () => {
    for (const addr of [FLAT.registry, FLAT.adapter, FLAT.recipes!.liquidity!, FLAT.recipes!.nav!, FLAT.recipes!.fixed!]) {
      expect(has(quickstart, addr), `quickstart must show the 0.3.3 address ${addr} (its captures)`).toBe(true);
    }
  });

  it("every 'contracts release X' claim names an ACTIVE generation's contractsVersion, and the primary's is claimed — a config relabel without a doc refresh fails here", () => {
    const claims = [...quickstart.matchAll(/contracts release \*{0,2}(\d+\.\d+\.\d+)/g)].map((m) => m[1]!);
    expect(claims.length, "the quickstart is expected to state its releases at least twice (status block, §5G)").toBeGreaterThanOrEqual(2);
    const active = new Set(ACTIVE_REGISTRIES.map((mr) => mr.contractsVersion));
    for (const v of claims) expect(active.has(v), `'contracts release ${v}' names no ACTIVE registry generation (${[...active].join(", ")})`).toBe(true);
    expect(claims, "the primary's release must be claimed somewhere").toContain(PRIMARY.contractsVersion);
  });

  it("carries NO retired-generation addresses — neither the superseded 0.3.2 stack nor the legacy (pre-2.1.0) registry stack", () => {
    const legacy = LEGACY_STACKS.flatMap((mr) => Object.values(mr).filter((v): v is string => typeof v === "string" && v.startsWith("0x")));
    expect(legacy.length, "the legacy registry stack is still configured (arbitrum-v1.1)").toBeGreaterThan(0);
    for (const addr of [...RETIRED_032_STACK, ...legacy]) {
      expect(has(quickstart, addr), `retired address ${addr} must not appear in the quickstart`).toBe(false);
    }
  });
});

describe("docs freshness: jit-order-anatomy.md is address-free by design", () => {
  it("contains no 20-byte addresses (role hashes are bytes32 and allowed)", () => {
    // exactly 40 hex chars — a 64-char bytes32 fails the negative lookahead at position 40.
    const addresses = anatomy.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? [];
    expect(addresses, "the anatomy doc survives redeploys precisely because it names no deployment").toEqual([]);
  });

  it("pins the on-chain-verified role pair (POOL_CREATOR + FEE_MANAGER, not the pre-v1.3 CONFIGURATOR) and the nested-wire role holder", () => {
    // keccak256("POOL_CREATOR_ROLE") / keccak256("FEE_MANAGER_ROLE") — verified against the live
    // v1.3 controller 2026-08-12: the adapter holds these two and does NOT hold CONFIGURATOR_ROLE.
    expect(anatomy).toContain("0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52");
    expect(anatomy).toContain("0x6c0757dc3e6b28b2580c03fd9e96c274acf4f99d91fbec9b418fa1d70604ff1c");
    // The stale pair's hash must not be presented as a precondition (prose may NAME the role).
    expect(anatomy).not.toContain("0x3b49a237fe2d18fa4d9642b8a0e065923cceb71b797783b619a030a61d848bf0");
    // 0.5.0 (nested wire, verified live 2026-09-22): the role moved to the CREATOR, and the
    // 1.4.0 controller has no FEE_MANAGER_ROLE — the doc must say both, per generation.
    expect(anatomy).toMatch(/the \*\*creator\*\*/);
    expect(anatomy).toMatch(/no `FEE_MANAGER_ROLE`/);
  });

  it("documents both payload layouts by their wire names and the fields that moved", () => {
    for (const needle of ["`flat`", "`nested`", "bytes32 oracleSalt", "bytes   extraData", "bool         enableJitMint", "InvalidFees", "MARKET_CREATOR"]) {
      expect(anatomy, `anatomy must mention ${needle}`).toContain(needle);
    }
  });
});
