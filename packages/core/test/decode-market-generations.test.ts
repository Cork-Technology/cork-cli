// cork_prepare_market builds for ANY active generation, and the signing guide says: decode the
// bytes before the broadcast. So the tool's own market-infrastructure bytes must decode as
// trusted on every generation it builds for — the registry and the creator are per-generation
// contracts, like the adapters. (Before 2026-10-02 only the primary's were known, and a
// deploy-oracle built for phoenix/v0.3-rc.1 decoded as "TARGET MISMATCH — do not sign".)
import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runTool, type HandlerContext } from "../src/index.ts";
import { resolveGenerations } from "../src/config-remote.ts";

const ctx: HandlerContext = { resolveRpc: async () => null, nowSeconds: 1_790_000_000n };
const PAIR = { collateralAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", referenceAsset: "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A" } as const;
const CONSTRAINT = { rateMin: "1", rateMax: "2000000000000000000", rateChangePerDayMax: "1000000000000000000", rateChangeCapacityMax: "3000000000000000000" };
type Tx = { to: `0x${string}`; calldata: `0x${string}` };
type Leg = { kind: string; role: string; action: string; verification: string; generation?: string; expectedTarget?: string };

describe.each([8453, 42161] as const)("cork_decode of cork_prepare_market bytes, chain %i", (chainId) => {
  it("the registry and creator of EVERY generation the tool builds for decode as trusted, the non-primary ones with their label", async () => {
    const { generations, primary } = await resolveGenerations(chainId);
    const built = generations.filter((g) => g.status === "active" && g.marketRegistry !== undefined && g.marketRegistry.wire !== "legacy");
    expect(built.length).toBeGreaterThanOrEqual(2); // the primary and at least one older active set
    for (const g of built) {
      const isPrimary = g.label === primary!.label;
      const recipe = g.marketRegistry!.recipes?.["liquidity"] ?? Object.values(g.marketRegistry!.recipes ?? {})[0];
      const actions = [
        { type: "deploy-oracle", ...PAIR, mode: "nav" },
        { type: "deploy-fixed-oracle", rate: "1000000000000000000" },
        { type: "create-pool", ...PAIR, expiryTimestamp: "1791000000", recipe, constraint: CONSTRAINT },
      ];
      for (const action of actions) {
        const prep = await runTool("cork_prepare_market", { chainId, clientRequestId: `decode-gen-${action.type}`, generation: g.label, action }, ctx);
        expect(prep.state, `${g.label} ${action.type}: ${JSON.stringify(prep.warnings)}`).toBe("ok");
        const tx = prep.data as Tx;
        const role = action.type === "create-pool" ? "marketCreator" : "marketRegistry";
        expect(tx.to.toLowerCase()).toBe((role === "marketCreator" ? g.marketRegistry!.marketCreator : g.marketRegistry!.registry)!.toLowerCase());
        const dec = await runTool("cork_decode", { kind: "calldata", chainId, data: tx.calldata, to: tx.to }, ctx);
        expect(dec.state, `${g.label} ${action.type}: ${JSON.stringify(dec.warnings)}`).toBe("ok");
        expect(dec.warnings.some((w) => w.code === "target_mismatch" || w.code === "target_unverified")).toBe(false);
        const leg = (dec.data as { legs: Leg[] }).legs[0]!;
        expect(leg).toMatchObject({ kind: "market", role, verification: "trusted" });
        // The primary's contract is the expected state and carries no label; another set's does.
        expect(leg.generation).toBe(isPrimary ? undefined : g.label);
      }
    }
  });

  it("a contract of NO generation is still a mismatch, and a role is not interchangeable: registry bytes at a creator are refused", async () => {
    const { generations, primary } = await resolveGenerations(chainId);
    const prim = primary!.marketRegistry!;
    const older = generations.find((g) => g.label !== primary!.label && g.status === "active" && g.marketRegistry?.wire === "flat")!.marketRegistry!;
    const prep = await runTool("cork_prepare_market", { chainId, clientRequestId: "decode-gen-foreign", generation: "phoenix/v0.3-rc.1", action: { type: "deploy-oracle", ...PAIR, mode: "nav" } }, ctx);
    const tx = prep.data as Tx;
    for (const to of ["0x000000000000000000000000000000000000dEaD", older.marketCreator!, prim.marketCreator!]) {
      const dec = await runTool("cork_decode", { kind: "calldata", chainId, data: tx.calldata, to }, ctx);
      expect(dec.state, to).toBe("conflict");
      const leg = (dec.data as { legs: Leg[] }).legs[0]!;
      // The contradiction names ONE address: the primary's registry.
      expect(leg).toMatchObject({ verification: "mismatch", expectedTarget: prim.registry });
    }
  });

  it("a signed tx to an older generation's registry is a known Cork target, named with its generation", async () => {
    const { generations, primary } = await resolveGenerations(chainId);
    const signer = privateKeyToAccount(keccak256(toHex("decode-market-generations")));
    for (const g of generations.filter((g) => g.status === "active" && g.marketRegistry !== undefined && g.marketRegistry.wire !== "legacy")) {
      const prep = await runTool("cork_prepare_market", { chainId, clientRequestId: "decode-gen-tx", generation: g.label, action: { type: "deploy-fixed-oracle", rate: "1000000000000000000" } }, ctx);
      const tx = prep.data as Tx;
      const raw = await signer.signTransaction({ chainId, to: tx.to, data: tx.calldata, nonce: 0, gas: 500_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
      const dec = await runTool("cork_decode", { kind: "tx", chainId, data: raw }, ctx);
      expect(dec.state, JSON.stringify(dec.warnings)).toBe("ok");
      expect(dec.warnings.some((w) => w.code === "unknown_target"), g.label).toBe(false);
      expect(JSON.stringify(dec.data)).toContain(g.label === primary!.label ? '"marketRegistry"' : `marketRegistry (${g.label} generation)`);
    }
  });
});
