// RECIPE_CATALOG is the teaching layer over the deployed recipe contracts — keyed by lowercased
// deployed ADDRESS, hand-maintained in TS. cork-defaults.json owns the addresses themselves, and
// on the 0.3.2→0.3.3 redeploy the catalog had to be hand-edited in step with the JSON — the
// exact drift class the config architecture exists to prevent, and until now the ONLY cross-check
// was the env-gated live parity test (which CI forks and offline runs never execute). This is the
// offline gate: every configured recipe hint must have a catalog entry, so a future redeploy that
// updates the JSON without the catalog fails HERE, not in a live run someone happens to start.
import { describe, expect, it } from "vitest";
import { BUNDLED_DEFAULTS, generationsOf, RECIPE_CATALOG } from "@cork/core";

describe("RECIPE_CATALOG ↔ config.default.json parity (offline drift gate)", () => {
  // Every GENERATION's recipe hints on every chain (the v2 document; the v1 file is frozen and
  // not read by this build) — the flat 0.3.3 set and the nested 0.5.0 set both catalog.
  const configured = new Map<string, string>(); // lowercased address → "chain/generation/mode" provenance
  for (const chain of Object.keys(BUNDLED_DEFAULTS.generations)) {
    for (const g of generationsOf(BUNDLED_DEFAULTS, Number(chain))) {
      for (const [mode, addr] of Object.entries(g.marketRegistry?.recipes ?? {})) configured.set(addr.toLowerCase(), `${chain}/${g.label}/${mode}`);
    }
  }

  it("every configured recipe address has a catalog entry (the 0.3.3 hand-edit direction)", () => {
    expect(configured.size).toBeGreaterThan(0);
    for (const [addr, where] of configured) {
      expect(RECIPE_CATALOG[addr], `recipe ${addr} (${where}) is in config.default.json but missing from RECIPE_CATALOG — the redeploy updated the config without the teaching catalog`).toBeDefined();
    }
  });

  it("no stale catalog entries survive a redeploy (keys ⊆ configured addresses)", () => {
    for (const key of Object.keys(RECIPE_CATALOG)) {
      expect(configured.has(key), `RECIPE_CATALOG key ${key} matches no configured recipe — a superseded generation's entry left behind (git history keeps its record; delete it here)`).toBe(true);
    }
  });

  it("catalog keys are lowercased addresses (the lookup normalisation contract)", () => {
    for (const key of Object.keys(RECIPE_CATALOG)) expect(key).toBe(key.toLowerCase());
  });
});
