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
const config = JSON.parse(read("../../../cork-defaults.json")) as {
  marketRegistry: Record<string, { registry: string; adapter: string; contractsVersion: string; recipes: Record<string, string> }>;
  marketRegistryLegacy: Record<string, Record<string, string>>;
};

// The quickstart's walkthrough chain. Its examples are live captures, so every stack address it
// shows must belong to the generation the config currently pins.
const MR = config.marketRegistry["8453"]!;

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

describe("docs freshness: zyfai-quickstart.md tracks the pinned registry generation", () => {
  it("names the CURRENT generation: registry, adapter, and all three recipes from cork-defaults.json", () => {
    for (const addr of [MR.registry, MR.adapter, MR.recipes.liquidity!, MR.recipes.nav!, MR.recipes.fixed!]) {
      expect(has(quickstart, addr), `quickstart must show the current-generation address ${addr}`).toBe(true);
    }
  });

  it("every 'contracts release X' claim names the config's contractsVersion — a config relabel without a doc refresh fails here", () => {
    const claims = [...quickstart.matchAll(/contracts release \*{0,2}(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(claims.length, "the quickstart is expected to state its target release at least twice (status block, §5G)").toBeGreaterThanOrEqual(2);
    for (const v of claims) expect(v).toBe(MR.contractsVersion);
  });

  it("carries NO retired-generation addresses — neither the superseded 0.3.x stack nor the legacy config stack", () => {
    const legacy = Object.values(config.marketRegistryLegacy).flatMap((chain) => Object.values(chain));
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

  it("pins the on-chain-verified role pair (POOL_CREATOR + FEE_MANAGER, not the pre-v1.3 CONFIGURATOR)", () => {
    // keccak256("POOL_CREATOR_ROLE") / keccak256("FEE_MANAGER_ROLE") — verified against the live
    // controller 2026-08-12: the adapter holds these two and does NOT hold CONFIGURATOR_ROLE.
    expect(anatomy).toContain("0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52");
    expect(anatomy).toContain("0x6c0757dc3e6b28b2580c03fd9e96c274acf4f99d91fbec9b418fa1d70604ff1c");
    // The stale pair's hash must not be presented as a precondition (prose may NAME the role).
    expect(anatomy).not.toContain("0x3b49a237fe2d18fa4d9642b8a0e065923cceb71b797783b619a030a61d848bf0");
  });
});
