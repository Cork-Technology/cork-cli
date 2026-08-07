// CREATE2 attestation gate: every shipped attestation must (a) independently re-derive to its
// `expected` address from (deployer, salt, initCodeHash) — a tampered entry fails here, (b) have
// a reproducible GUARDED salt where it came from the AtomicDeployer batch (salt =
// keccak256(abi.encodePacked(guardSender, rawSalt)) — the anti-squatting guard), and (c) agree
// with the addresses cork-defaults.json actually routes calls to, so the attestation layer and
// the config layer can never drift apart silently. This matters most for the registry set: the
// pre-2.1.0 generation still answers current-shaped calls with garbage, so the attestation is
// the tamper-evidence for the addresses we trust.
import { describe, expect, it } from "vitest";
import { encodePacked, keccak256 } from "viem";
import { CREATE2_ATTESTATIONS, CREATE2_DEPLOYER, resolveMarketRegistry, verifyCreate2 } from "@cork/core";

describe("CREATE2 attestations", () => {
  it("every attestation re-derives to its expected address (local keccak, no chain)", () => {
    for (const a of CREATE2_ATTESTATIONS) {
      const v = verifyCreate2({ deployer: a.deployer ?? CREATE2_DEPLOYER, salt: a.salt, initCodeHash: a.initCodeHash, expected: a.expected });
      expect(v.match, `${a.name}: derived ${JSON.stringify(v)} != expected ${a.expected}`).toBe(true);
    }
  });

  it("guarded entries re-derive their EFFECTIVE salt from the recorded guard inputs", () => {
    const guarded = CREATE2_ATTESTATIONS.filter((a) => a.guard);
    expect(guarded.length).toBeGreaterThan(0);
    for (const a of guarded) {
      const derived = keccak256(encodePacked(["address", "bytes32"], [a.guard!.guardSender, a.guard!.rawSalt]));
      expect(derived, `${a.name}: guard inputs do not reproduce the salt`).toBe(a.salt);
    }
  });

  it("covers the full 0.3.2 registry set and agrees with the config the tool routes calls to, on BOTH chains", async () => {
    const byName = Object.fromEntries(CREATE2_ATTESTATIONS.map((a) => [a.name, a.expected.toLowerCase()]));
    for (const chainId of [42161, 8453] as const) {
      const { marketRegistry: mr } = await resolveMarketRegistry(chainId);
      expect(mr, String(chainId)).toBeDefined();
      expect(byName["marketRegistry"]).toBe(mr!.registry.toLowerCase());
      expect(byName["corkLimitOrderAdapter"]).toBe(mr!.adapter!.toLowerCase());
      expect(byName["wrapperRateConsumerFactory"]).toBe(mr!.wrapperFactory!.toLowerCase());
      expect(byName["fixedRateOracleFactory"]).toBe(mr!.fixedRateOracleFactory!.toLowerCase());
      expect(byName["aggregatorAdapterFactory"]).toBe(mr!.aggregatorAdapterFactory!.toLowerCase());
      expect(byName["liquidityPriceRecipe"]).toBe(mr!.recipes!["liquidity"]!.toLowerCase());
      expect(byName["liquidityNavRecipe"]).toBe(mr!.recipes!["nav"]!.toLowerCase());
      expect(byName["fixedRateRecipe"]).toBe(mr!.recipes!["fixed"]!.toLowerCase());
    }
  });
});
