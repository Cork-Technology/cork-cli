// The DEPRECATED pre-2.1.0 MarketRegistry generation: the pure math stays pinned against the OLD
// MarketRegistryLib.sol (bands, mode-string extraData, fill-time derivation), and the handler
// paths verify the general deprecation gate — invisible without CORK_ENABLE_DEPRECATED=1,
// labelled `deprecated` when unlocked.
import { afterEach, describe, expect, it } from "vitest";
import { marketRegistryLegacy as legacy, runTool, type HandlerContext } from "@cork/core";
import { stubRpc, type StubCall } from "./helpers.ts";

const { applyBandsLocal, buildJitExtension, decodeJitExtension, deriveJitMarket, encodeJitExtraData, PERCENTAGE_DENOMINATOR } = legacy;
type ConstraintBands = legacy.ConstraintBands;

const WAD = 10n ** 18n;
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"; // sUSDe (registered on Arbitrum)
const REF = "0x7F6501d3B98eE91f9b9535E4b0ac710Fb0f9e0bc"; // waArbUSDCn
const ACCT = "0xc0ffee0000000000000000000000000000000001";
const OLD_ADAPTER = "0xea15BF1E5565181Ed8678CcFf39D797272858505";

afterEach(() => {
  delete process.env["CORK_ENABLE_DEPRECATED"];
});

describe("legacy applyBands port (old MarketRegistryLib semantics, 1e18 = 1% bands)", () => {
  const bands = (min: bigint, max: bigint, day: bigint, cap: bigint): ConstraintBands => ({ mode: "t", rateMin: min, rateMax: max, rateChangePerDayMax: day, rateChangeCapacityMax: cap });

  it("the doc example: (min 5%, max 10%) at rate 1.0 → floor 0.95, ceiling 1.10", () => {
    const r = applyBandsLocal(bands(5n * WAD, 10n * WAD, WAD, 2n * WAD), WAD);
    expect(r.rateMin).toBe(95n * WAD / 100n);
    expect(r.rateMax).toBe(110n * WAD / 100n);
    expect(r.rateChangePerDayMax).toBe(WAD / 100n);
    expect(r.rateChangeCapacityMax).toBe(2n * WAD / 100n);
  });

  it("rounding tightens: the floor rounds UP, the others DOWN (sub-wei remainders)", () => {
    const r = applyBandsLocal(bands(WAD, WAD, WAD, WAD), 1n);
    expect(r.rateMin).toBe(1n); // ceil
    expect(r.rateChangePerDayMax).toBe(0n); // floor of 0.01 wei
  });

  it("live legacy 'liquidity' recipe shape: min 99% max 100% → floor 1% of rate", () => {
    const r = applyBandsLocal(bands(99n * WAD, 100n * WAD, 100n * WAD, 100n * WAD), WAD);
    expect(r.rateMin).toBe(WAD / 100n);
    expect(r.rateMax).toBe(2n * WAD);
  });

  it("rejects a >100% min band (registry can never store one; would underflow on-chain)", () => {
    expect(() => applyBandsLocal(bands(PERCENTAGE_DENOMINATOR + 1n, 0n, 0n, 0n), WAD)).toThrow();
  });
});

describe("legacy JIT extension bytes (mode-string extraData)", () => {
  const params = { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1795000000n, mode: "liquidity", swapFeePercentage: 0n, unwindSwapFeePercentage: 0n, enableJitMint: true } as const;

  it("round-trips through the ExtensionLib offset table (preInteraction = field 6)", () => {
    const back = decodeJitExtension(buildJitExtension(OLD_ADAPTER, encodeJitExtraData(params, [])));
    expect(back.adapter).toBe(OLD_ADAPTER);
    expect(back.params).toEqual(params);
    expect(back.permits).toEqual([]);
  });
});

describe("legacy deriveJitMarket (fill-time derivation: identity FOLLOWS the rate)", () => {
  const GT_BANDS: ConstraintBands = { mode: "liquidity", rateMin: 99n * WAD, rateMax: 100n * WAD, rateChangePerDayMax: 100n * WAD, rateChangeCapacityMax: 100n * WAD };

  it("poolId moves with the rate (the drift the 2.1.0 redesign removed)", () => {
    const base = { params: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1795000000n, mode: "liquidity" }, oracle: ACCT, bands: GT_BANDS } as const;
    const a = deriveJitMarket({ ...base, rate: WAD });
    const b = deriveJitMarket({ ...base, rate: 2n * WAD });
    expect(a.poolId).not.toBe(b.poolId);
  });

  // Ground truth captured 2026-07-24 from the then-live market-registry-api (old generation).
  it("reproduces the captured pool_id + resolved bands bit-for-bit", () => {
    const d = deriveJitMarket({
      params: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1900000000n, mode: "liquidity" },
      oracle: "0x2ba2103a37c4cff9dbb96e6f74513923d960d757",
      rate: 806233879660299371n,
      bands: GT_BANDS,
    });
    expect(d.poolId).toBe("0xda9325fad061bbcaa92fdec93d81398ca31ad1494c16ac658b9cc67079078c75");
    expect(d.resolved).toEqual({ rateMin: 8062338796602994n, rateMax: 1612467759320598742n, rateChangePerDayMax: 806233879660299371n, rateChangeCapacityMax: 806233879660299371n });
  });
});

// ── the deprecation gate itself ─────────────────────────────────────────────
const LIQ_BANDS = { mode: "liquidity", rateMin: 99n * WAD, rateMax: 100n * WAD, rateChangePerDayMax: 100n * WAD, rateChangeCapacityMax: 100n * WAD };

describe("deprecation gate (CORK_ENABLE_DEPRECATED)", () => {
  const ctx = (handler: (c: StubCall) => unknown): HandlerContext => ({ nowSeconds: 1_790_000_000n, resolveRpc: stubRpc(handler) });

  it("filters.legacy WITHOUT the env → unavailable deprecated_gated, nothing executed", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes", filters: { legacy: true } }, ctx(() => {
      throw new Error("must not read chain");
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("deprecated_gated");
    expect(env.warnings[0]?.message).toContain("CORK_ENABLE_DEPRECATED");
  });

  it("filters.legacy WITH the env → the old mode-keyed read runs, labelled `deprecated`", async () => {
    process.env["CORK_ENABLE_DEPRECATED"] = "1";
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes", filters: { legacy: true } }, ctx((c) => {
      if (c.functionName === "getRecipes") return [[LIQ_BANDS], ["liquidity"], 1n];
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    expect((env.data as { modes: string[] }).modes).toEqual(["liquidity"]);
    expect((env.data as { registry: string }).registry.toLowerCase()).toBe("0xf674488bf4643e205ccd826951e8b0d29f77600a");
    expect(env.warnings.some((w) => w.code === "deprecated")).toBe(true);
  });

  it("compute resolve-recipe legacy:true is gated the same way", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", legacy: true, mode: "liquidity", rate: WAD.toString() } }, ctx(() => {
      throw new Error("must not read chain");
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("deprecated_gated");
  });

  it("compute resolve-recipe legacy:true WITH the env runs the old parity-checked band math", async () => {
    process.env["CORK_ENABLE_DEPRECATED"] = "1";
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", legacy: true, mode: "liquidity", rate: WAD.toString() } }, ctx((c) => {
      if (c.functionName === "lookupRecipe") return [true, LIQ_BANDS];
      if (c.functionName === "applyBands") return applyBandsLocal(LIQ_BANDS, WAD);
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { resolved: { rateMin: string }; parity: string };
    expect(BigInt(d.resolved.rateMin)).toBe(WAD / 100n);
    expect(d.parity).toContain("verified");
    expect(env.warnings.some((w) => w.code === "deprecated")).toBe(true);
  });

  it("jitMarket.legacy WITHOUT the env → deprecated_gated; WITH it the OLD adapter + mode extraData build offline", async () => {
    const base = {
      chainId: 42161 as const,
      account: ACCT,
      clientRequestId: "leg-jit-0001",
      action: {
        type: "maker-order",
        poolId: `0x${"11".repeat(32)}`,
        side: "SELL",
        makerAsset: CA,
        takerAsset: REF,
        makingAmount: "1000000000000000000",
        takingAmount: "1000000",
        jitMarket: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: "1795000000", mode: "liquidity", legacy: true, enableJitMint: true },
      },
    };
    const gated = await runTool("cork_prepare_orders", base, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(gated.state).toBe("unavailable");
    expect(gated.warnings[0]?.code).toBe("deprecated_gated");

    process.env["CORK_ENABLE_DEPRECATED"] = "1";
    const env = await runTool("cork_prepare_orders", base, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    const d = env.data as { extension: `0x${string}`; jit: { adapter: string; generation: string } };
    const decoded = decodeJitExtension(d.extension);
    expect(decoded.adapter.toLowerCase()).toBe(OLD_ADAPTER.toLowerCase());
    expect(decoded.params.mode).toBe("liquidity");
    expect(d.jit.generation).toContain("legacy");
    expect(env.warnings.some((w) => w.code === "deprecated")).toBe(true);
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(true);
  });
});
