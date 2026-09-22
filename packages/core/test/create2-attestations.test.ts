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
import { CREATE2_ATTESTATIONS, CREATE2_DEPLOYER, resolveGenerations, verifyCreate2 } from "@cork/core";

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

  it("every `binds` declaration agrees with the GENERATION block the tool routes calls to, on every bound chain", async () => {
    // Data-driven from the attestation entries themselves (the binds field is part of the
    // shipped attestation, rendered by topic:"verify") — not a hand-maintained mapping here
    // that could silently miss an entry. A config edit without a matching attestation edit,
    // or vice versa, fails this offline. Since 0.6 a bind names a generation: the block lives
    // at generations[chain].sets[generation][section].
    const bound = CREATE2_ATTESTATIONS.filter((a) => a.binds);
    expect(bound.length).toBeGreaterThan(0);
    for (const a of bound) {
      for (const chainId of a.binds!.chains) {
        const { generations } = await resolveGenerations(chainId);
        const generation = generations.find((g) => g.label === a.binds!.generation);
        expect(generation, `${a.name}: no generation '${a.binds!.generation}' on chain ${chainId}`).toBeDefined();
        const perChain = generation![a.binds!.section];
        expect(perChain, `${a.name}: generation '${a.binds!.generation}' has no ${a.binds!.section} block on chain ${chainId}`).toBeDefined();
        const value = a.binds!.path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], perChain);
        expect(typeof value, `${a.name}: ${a.binds!.generation}.${a.binds!.section}[${chainId}].${a.binds!.path} missing from config`).toBe("string");
        expect((value as string).toLowerCase(), `${a.name}: attestation disagrees with ${a.binds!.generation}.${a.binds!.section}[${chainId}].${a.binds!.path}`).toBe(a.expected.toLowerCase());
      }
    }
  });

  it("the attested set is the phoenix/v0.3-rc.1 generation (+ mainnet); phoenix/v0.4-rc.1 has NO attestation because its Distribution records carry no CREATE2 inputs", () => {
    // An attestation that cannot be re-derived from recorded (deployer, salt, initCodeHash)
    // would be a hardcode dressed as evidence — the gap is stated, not papered over. The
    // moment the 0.5.0 / v1.4.0-rc.1 deploy broadcasts are published this roster grows.
    const generations = new Set(CREATE2_ATTESTATIONS.filter((a) => a.binds).map((a) => a.binds!.generation));
    expect([...generations].sort()).toEqual(["mainnet", "phoenix/v0.3-rc.1"]);
    for (const a of CREATE2_ATTESTATIONS) expect(a.expected.toLowerCase()).not.toBe("0xe1f569f152bDB6eBB2d49cFd9d4aB98ECEe955c5".toLowerCase());
  });

  it("covers every config-routed address of the attested generation: the registry set, the phoenix v1.3 stack, and the mainnet adapter", () => {
    // Coverage guard: binds-driven agreement above can't notice a DELETED entry, so the
    // required roster is pinned here. New config-referenced contracts join this list.
    const names = new Set(CREATE2_ATTESTATIONS.map((a) => a.name));
    for (const required of [
      "corkAdapter",
      "atomicDeployer",
      "marketRegistry",
      "corkLimitOrderAdapter",
      "wrapperRateConsumerFactory",
      "fixedRateOracleFactory",
      "aggregatorAdapterFactory",
      "liquidityPriceRecipe",
      "liquidityNavRecipe",
      "fixedRateRecipe",
      "poolManagerV13",
      "constraintAdapterV13",
      "whitelistManagerV13",
      "defaultCorkController",
      "corkAdapterV13",
    ]) {
      expect(names.has(required), `attestation roster is missing ${required}`).toBe(true);
    }
  });

  it("every registry-set and phoenix-set entry names a PUBLIC rebuildable source (repo + tag OR commit + forge path)", () => {
    // The mainnet corkAdapter predates public tagging — the one sanctioned source-less entry.
    for (const a of CREATE2_ATTESTATIONS) {
      if (a.name === "corkAdapter") continue;
      expect(a.source, `${a.name}: missing source provenance`).toBeDefined();
      expect(a.source!.repo).toMatch(/^github\.com\/Cork-Technology\//);
      const pin = a.source!.tag ?? a.source!.commit;
      expect(pin, `${a.name}: neither tag nor commit`).toBeDefined();
      expect(pin!.length).toBeGreaterThan(0);
      if (a.source!.commit !== undefined) expect(a.source!.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(a.source!.contract).toMatch(/^[\w\-/.]+\.sol:\w+$/);
    }
  });
});
