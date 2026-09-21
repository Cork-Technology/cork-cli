// Live parity for the DEPLOYED ApySpreadImpairmentRecipe (0x7340BfbE…, Base) — the empirical
// spine of the integration. Three claims, each settled on chain, none from memory:
//   1. the recipe binds the CURRENT generation: its REGISTRY() equals the configured registry
//      (the 0.4.0 release moved no registry address — this read is the proof that stays true);
//   2. resolve() is wei-exact against the chain-verified applyBands rounding (ceil the floor,
//      floor the other three) fed by the recipe's own band math — a rounding change in a later
//      registry lib generation fails HERE, not in a signed order;
//   3. the recipe's typed reverts are REAL: an oversized band reverts BandTooWide on chain and
//      the shared recipeAbi names it — the recipe_refused path proven against deployed bytecode.
// Self-skips unless CORK_RPC_LIVE=1 (the live-smoke job runs it).
import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { encodeImpairmentArgs, recipeAbi, resolveRpc } from "@cork/core";
import { applyBandsLocal } from "../src/market-registry-legacy.ts";
import corkDefaults from "../../../cork-defaults.json" with { type: "json" };

const LIVE = process.env.CORK_RPC_LIVE === "1";
const IMP = "0x7340BfbEdF3657a7bBCe0dD2b4ab205754cc9eCA" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const DAY = 86_400n;
const YEAR = 365n * DAY;

describe.skipIf(!LIVE)("ApySpreadImpairmentRecipe — live parity on Base (CORK_RPC_LIVE=1)", () => {
  it("REGISTRY() binds the configured (current-generation) registry — the recipe rode 0.4.0 without a registry move", async () => {
    const { client } = (await resolveRpc(8453, undefined))!;
    const bound = (await client.readContract({ address: IMP, abi: recipeAbi, functionName: "REGISTRY" })) as string;
    const configured = (corkDefaults as { marketRegistry: Record<string, { registry: string }> }).marketRegistry["8453"]!.registry;
    expect(bound.toLowerCase()).toBe(configured.toLowerCase());
  });

  it("resolve() is wei-exact against the applyBands reference: anchor 1.0, 7 days, 10%/year, no oracle", async () => {
    const { client } = (await resolveRpc(8453, undefined))!;
    const anchor = 10n ** 18n;
    const duration = 7n * DAY;
    const spread = 10n * 10n ** 18n; // 10%/year on the 1e18 = 1% scale
    const c = (await client.readContract({
      address: IMP,
      abi: recipeAbi,
      functionName: "resolve",
      args: [ZERO, ZERO, ZERO, encodeImpairmentArgs({ anchorRate: anchor, durationSeconds: duration, apySpreadPercentage: spread })],
    })) as { rateMin: bigint; rateMax: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint };
    // The recipe's own derivation, mirrored: band = spread×duration/365d, perDay = spread×1d/365d,
    // capacity = 7×perDay — all PERCENTAGE-scale bands handed to the shared applyBands.
    const band = (spread * duration) / YEAR;
    const perDay = (spread * DAY) / YEAR;
    const expected = applyBandsLocal({ mode: "impairment", rateMin: band, rateMax: band, rateChangePerDayMax: perDay, rateChangeCapacityMax: 7n * perDay }, anchor);
    expect(c.rateMin).toBe(expected.rateMin);
    expect(c.rateMax).toBe(expected.rateMax);
    expect(c.rateChangePerDayMax).toBe(expected.rateChangePerDayMax);
    expect(c.rateChangeCapacityMax).toBe(expected.rateChangeCapacityMax);
    // The window is symmetric around the anchor — the midpoint verify() recovers.
    expect((c.rateMin + c.rateMax) / 2n).toBe(anchor);
  });

  it("an oversized band reverts BandTooWide on the DEPLOYED bytecode, and the shared ABI names it", async () => {
    const { client } = (await resolveRpc(8453, undefined))!;
    // band = spread×7d/365d ≥ 100e18 needs spread ≥ 100e18×365/7 ≈ 5215e18; 6000e18 clears it.
    const args = encodeImpairmentArgs({ anchorRate: 10n ** 18n, durationSeconds: 7n * DAY, apySpreadPercentage: 6000n * 10n ** 18n });
    let name: string | null = null;
    try {
      await client.readContract({ address: IMP, abi: recipeAbi, functionName: "resolve", args: [ZERO, ZERO, ZERO, args] });
    } catch (err) {
      if (err instanceof BaseError) {
        const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
        if (revert instanceof ContractFunctionRevertedError) name = revert.data?.errorName ?? null;
      }
    }
    expect(name).toBe("BandTooWide");
  });
});
