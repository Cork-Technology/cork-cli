// MarketRegistry + JIT adapter integration: pure math pinned against MarketRegistryLib.sol,
// extension bytes pinned against 1inch ExtensionLib layout, and the handler paths offline via
// injected RPC stubs. Live parity (applyBands vs chain, real recipes) runs ad hoc — see the
// integration notes in notes/market-registry-integration.md.
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeFunctionData } from "viem";
import {
  applyBandsLocal,
  buildDeployOracleCall,
  buildJitExtension,
  decodeJitExtension,
  deriveJitMarket,
  encodeJitExtraData,
  JIT_MARKET_CREATED_TOPIC,
  JIT_MINTED_TOPIC,
  marketRegistryAbi,
  PERCENTAGE_DENOMINATOR,
  runTool,
  type ConstraintBands,
  type HandlerContext,
} from "@cork/core";

const WAD = 10n ** 18n;
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"; // sUSDe (registered on Arbitrum)
const REF = "0x7F6501d3B98eE91f9b9535E4b0ac710Fb0f9e0bc"; // waArbUSDCn
const ACCT = "0xc0ffee0000000000000000000000000000000001";

describe("applyBands port (MarketRegistryLib semantics, 1e18 = 1% bands)", () => {
  const bands = (min: bigint, max: bigint, day: bigint, cap: bigint): ConstraintBands => ({ mode: "t", rateMin: min, rateMax: max, rateChangePerDayMax: day, rateChangeCapacityMax: cap });

  it("the doc example: (min 5%, max 10%) at rate 1.0 → floor 0.95, ceiling 1.10", () => {
    const r = applyBandsLocal(bands(5n * WAD, 10n * WAD, WAD, 2n * WAD), WAD);
    expect(r.rateMin).toBe(95n * WAD / 100n);
    expect(r.rateMax).toBe(110n * WAD / 100n);
    expect(r.rateChangePerDayMax).toBe(WAD / 100n);
    expect(r.rateChangeCapacityMax).toBe(2n * WAD / 100n);
  });

  it("rounding tightens: the floor rounds UP, the others DOWN (sub-wei remainders)", () => {
    // rate 1 wei, min band 1%: floor = ceil(1 * 99e18 / 100e18) = 1 (never widens to 0)
    const r = applyBandsLocal(bands(WAD, WAD, WAD, WAD), 1n);
    expect(r.rateMin).toBe(1n); // ceil
    expect(r.rateChangePerDayMax).toBe(0n); // floor of 0.01 wei
  });

  it("min 0% resolves the floor to exactly the rate (a mode that forbids falling)", () => {
    const r = applyBandsLocal(bands(0n, WAD, 0n, 0n), 123456789n);
    expect(r.rateMin).toBe(123456789n);
  });

  it("live Arbitrum 'liquidity' recipe shape: min 99% max 100% → floor 1% of rate", () => {
    const r = applyBandsLocal(bands(99n * WAD, 100n * WAD, 100n * WAD, 100n * WAD), WAD);
    expect(r.rateMin).toBe(WAD / 100n);
    expect(r.rateMax).toBe(2n * WAD);
  });

  it("rejects a >100% min band (registry can never store one; would underflow on-chain)", () => {
    expect(() => applyBandsLocal(bands(PERCENTAGE_DENOMINATOR + 1n, 0n, 0n, 0n), WAD)).toThrow();
  });
});

describe("JIT extension bytes (1inch ExtensionLib layout)", () => {
  const ADAPTER = "0xea15BF1E5565181Ed8678CcFf39D797272858505";
  const params = { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1795000000n, mode: "liquidity", swapFeePercentage: 0n, unwindSwapFeePercentage: 0n, enableJitMint: true } as const;

  it("round-trips through the ExtensionLib offset table (preInteraction = field 6)", () => {
    const ext = buildJitExtension(ADAPTER, encodeJitExtraData(params, []));
    const back = decodeJitExtension(ext);
    expect(back.adapter).toBe(ADAPTER);
    expect(back.params).toEqual(params);
    expect(back.permits).toEqual([]);
  });

  it("carries permits and preserves their fields exactly", () => {
    const permit = { token: CA, value: 42n, deadline: 1795000000n, v: 27, r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}` } as const;
    const back = decodeJitExtension(buildJitExtension(ADAPTER, encodeJitExtraData(params, [permit])));
    expect(back.permits).toEqual([permit]);
  });

  it("the extraData tail is exactly abi.encode(JITMarketParams, PermitParams[]) — adapter-decodable", () => {
    const extra = encodeJitExtraData(params, []);
    // decode with an independently-authored parameter list (guards the tuple field ORDER)
    const [p] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "collateralAsset", type: "address" }, { name: "referenceAsset", type: "address" }, { name: "expiryTimestamp", type: "uint256" }, { name: "mode", type: "string" }, { name: "swapFeePercentage", type: "uint256" }, { name: "unwindSwapFeePercentage", type: "uint256" }, { name: "enableJitMint", type: "bool" }] }, { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] }],
      extra,
    ) as unknown as [{ mode: string; enableJitMint: boolean }, unknown[]];
    expect(p.mode).toBe("liquidity");
    expect(p.enableJitMint).toBe(true);
  });

  it("event topics are frozen (adapter source signatures)", () => {
    expect(JIT_MARKET_CREATED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JIT_MINTED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JIT_MARKET_CREATED_TOPIC).not.toBe(JIT_MINTED_TOPIC);
  });
});

describe("deriveJitMarket: the fill-time derivation, computable before deployment", () => {
  it("poolId is the keccak of the resolved Market struct and moves with the rate (stepwise identity)", () => {
    const bands: ConstraintBands = { mode: "liquidity", rateMin: 99n * WAD, rateMax: 100n * WAD, rateChangePerDayMax: 100n * WAD, rateChangeCapacityMax: 100n * WAD };
    const base = { params: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1795000000n, mode: "liquidity" }, oracle: ACCT, bands } as const;
    const a = deriveJitMarket({ ...base, rate: WAD });
    const b = deriveJitMarket({ ...base, rate: WAD }); // same rate → same id
    const c = deriveJitMarket({ ...base, rate: 2n * WAD }); // moved rate → different id
    expect(a.poolId).toBe(b.poolId);
    expect(a.poolId).not.toBe(c.poolId);
    expect(a.market.rateOracle).toBe(ACCT);
  });

  // Ground truth captured 2026-07-24 from the live market-registry-api:
  //   GET zian-b.feat.cork.tech/v1/42161/market/predict?collateralAsset=sUSDe&referenceAsset=waArbUSDCn
  //       &expiry=1900000000&mode=liquidity  (pool did not exist; oracle deployed, live rate).
  // Locks our LOCAL derivation (applyBandsLocal + computeMarketId) to the on-chain adapter's result
  // wei-for-wei — if the struct layout or band math ever drifts, this fails.
  it("reproduces the live API pool_id + resolved bands bit-for-bit (liquidity, real Arbitrum pair)", () => {
    const gt = {
      oracle: "0x2ba2103a37c4cff9dbb96e6f74513923d960d757" as `0x${string}`,
      rate: 806233879660299371n,
      // liquidity percentage bands (raw 1e18 = 1%): min 99% (→ floor at 1% of rate),
      // max 100% (→ ceiling at 2× rate), per-day 100%, capacity 100%.
      bands: { mode: "liquidity", rateMin: 99n * WAD, rateMax: 100n * WAD, rateChangePerDayMax: 100n * WAD, rateChangeCapacityMax: 100n * WAD } as ConstraintBands,
      poolId: "0xda9325fad061bbcaa92fdec93d81398ca31ad1494c16ac658b9cc67079078c75",
      resolved: { rateMin: 8062338796602994n, rateMax: 1612467759320598742n, rateChangePerDayMax: 806233879660299371n, rateChangeCapacityMax: 806233879660299371n },
    };
    const d = deriveJitMarket({ params: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1900000000n, mode: "liquidity" }, oracle: gt.oracle, rate: gt.rate, bands: gt.bands });
    expect(d.poolId).toBe(gt.poolId);
    expect(d.resolved).toEqual(gt.resolved);
  });
});

// ── handler paths (offline; injected RPC stub answering registry views) ─────
type Call = { functionName: string; args?: readonly unknown[]; address: string };
function stubRpc(handler: (c: Call) => unknown): NonNullable<HandlerContext["resolveRpc"]> {
  return async () => ({
    url: "https://stub/rpc",
    source: "explicit" as const,
    client: {
      readContract: async (c: Call) => handler(c),
      simulateContract: async (c: Call) => ({ result: handler({ ...c, functionName: `simulate:${c.functionName}` }) }),
    } as never,
  });
}

const LIQ = { mode: "liquidity", rateMin: 99n * WAD, rateMax: 100n * WAD, rateChangePerDayMax: 100n * WAD, rateChangeCapacityMax: 100n * WAD };
const ORACLE = "0x00000000000000000000000000000000000000fe";

describe("cork_query registry-* (chain views)", () => {
  const ctx = (handler: (c: Call) => unknown): HandlerContext => ({ nowSeconds: 1_790_000_000n, resolveRpc: stubRpc(handler) });

  it("registry-recipes lists modes with the two-scales note", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes" }, ctx((c) => {
      if (c.functionName === "getRecipes") return [[LIQ], ["liquidity"], 1n];
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { scale: string; modes: string[] };
    expect(d.modes).toEqual(["liquidity"]);
    expect(d.scale).toContain("1e18 = 1%");
  });

  it("registry-recipes with an unknown filters.mode → recipe_not_found naming the real modes", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes", filters: { mode: "Liquidity" } }, ctx((c) => {
      if (c.functionName === "lookupRecipe") return [false, LIQ];
      if (c.functionName === "getRecipes") return [[LIQ], ["liquidity", "fixed"], 2n];
      throw new Error("unexpected");
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_not_found");
    expect(env.warnings[0]?.message).toContain("case-sensitive");
    expect(env.warnings[0]?.message).toContain("liquidity, fixed");
  });

  it("registry-oracle: deployed pair → wrapper; undeployed-but-deployable → predicted wrapper", async () => {
    const deployed = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF } }, ctx((c) => {
      if (c.functionName === "lookupWrapper") return ORACLE;
      throw new Error("unexpected");
    }));
    expect((deployed.data as { deployed: boolean; wrapper: string }).deployed).toBe(true);

    const deployable = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF } }, ctx((c) => {
      if (c.functionName === "lookupWrapper") return "0x0000000000000000000000000000000000000000";
      if (c.functionName === "simulate:deploy") return ORACLE;
      throw new Error("unexpected");
    }));
    const d = deployable.data as { deployed: boolean; deployable: boolean; predictedWrapper: string };
    expect(d.deployed).toBe(false);
    expect(d.deployable).toBe(true);
    expect(d.predictedWrapper).toBe(ORACLE);
  });

  it("registry-oracle: a non-deployable pair is an OK answer with the reason, not an error", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF } }, ctx((c) => {
      if (c.functionName === "lookupWrapper") return "0x0000000000000000000000000000000000000000";
      if (c.functionName === "simulate:deploy") throw new Error("execution reverted: EntryNotFound()");
      throw new Error("unexpected");
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { deployable: boolean; reason: string };
    expect(d.deployable).toBe(false);
    expect(d.reason).toContain("EntryNotFound");
  });

  it("registry-assets filters.address → single lookupAssetByAddress by natural key; miss → asset_not_found", async () => {
    const ASSET = { assetAddress: CA, chainId: 42161n, symbol: "sUSDe" };
    const hit = await runTool("cork_query", { chainId: 42161, resource: "registry-assets", filters: { address: CA } }, ctx((c) => {
      if (c.functionName === "lookupAssetByAddress") {
        expect(c.args).toEqual([CA, 42161n]);
        return [true, ASSET];
      }
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(hit.state).toBe("ok");
    // The envelope JSON-safes bigints to decimal strings.
    expect((hit.data as { items: unknown[] }).items).toEqual([{ ...ASSET, chainId: "42161" }]);

    const miss = await runTool("cork_query", { chainId: 42161, resource: "registry-assets", filters: { address: REF } }, ctx((c) => {
      if (c.functionName === "lookupAssetByAddress") return [false, ASSET];
      throw new Error("unexpected");
    }));
    expect(miss.state).toBe("unavailable");
    expect(miss.warnings[0]?.code).toBe("asset_not_found");
  });

  it("no registry on mainnet → unknown_deployment naming 42161", async () => {
    const env = await runTool("cork_query", { chainId: 1, resource: "registry-recipes" }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
    expect(env.warnings[0]?.message).toContain("42161");
  });
});

describe("cork_query market-predict (registry+adapter derivation of a not-yet-existing market)", () => {
  const ctx = (handler: (c: Call) => unknown, simulateCalls?: (a: { account: string; calls: { to: string; data: string }[] }) => unknown): HandlerContext => ({
    nowSeconds: 1_790_000_000n,
    resolveRpc: async () => ({
      url: "https://stub/rpc",
      source: "explicit" as const,
      client: {
        readContract: async (c: Call) => handler(c),
        simulateContract: async (c: Call) => ({ result: handler({ ...c, functionName: `simulate:${c.functionName}` }) }),
        simulateCalls: async (a: never) => (simulateCalls ? simulateCalls(a) : { results: [] }),
      } as never,
    }),
  });
  // Live-captured ground truth (see deriveJitMarket parity test above).
  const GT = {
    rate: 806233879660299371n,
    poolId: "0xda9325fad061bbcaa92fdec93d81398ca31ad1494c16ac658b9cc67079078c75",
    cst: "0x5d16b802b397dffced2468f63b936a835dc8bf10",
    cpt: "0x77db0b6c1d956865c2b3217f90be1a394ba08f4c",
    bands: { mode: "liquidity", rateMin: 99n * WAD, rateMax: 100n * WAD, rateChangePerDayMax: 100n * WAD, rateChangeCapacityMax: 100n * WAD },
  };
  const ZERO = "0x0000000000000000000000000000000000000000";
  const sharesWord = (a: string) => "000000000000000000000000" + a.replace(/^0x/, "").toLowerCase();

  it("missing any of ca/ref/expiry/mode → missing_filter (no chain call)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, mode: "liquidity" } }, ctx(() => { throw new Error("must not read chain"); }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("missing_filter");
  });

  it("ca === ref is an invalid-input teaching error", async () => {
    await expect(runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: CA, expiry: "1900000000", mode: "liquidity" } }, ctx(() => 0))).rejects.toThrow(/invalid input/);
  });

  it("unknown mode → recipe_not_found naming the real modes", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "Liquidity" } }, ctx((c) => {
      if (c.functionName === "lookupRecipe") return [false, GT.bands];
      if (c.functionName === "getRecipes") return [[GT.bands], ["liquidity", "fixed"], 2n];
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_not_found");
    expect(env.warnings[0]?.message).toContain("liquidity, fixed");
  });

  it("deployable-but-not-deployed oracle → ok, oracle-only, market/shares null, oracle_not_deployed", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" } }, ctx((c) => {
      if (c.functionName === "lookupRecipe") return [true, GT.bands];
      if (c.functionName === "lookupWrapper") return ZERO;
      if (c.functionName === "simulate:deploy") return "0x00000000000000000000000000000000000000fe";
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { oracle: { deployed: boolean; deployable: boolean }; market: unknown; shares: unknown };
    expect(d.oracle.deployed).toBe(false);
    expect(d.oracle.deployable).toBe(true);
    expect(d.market).toBeNull();
    expect(env.warnings.some((w) => w.code === "oracle_not_deployed")).toBe(true);
  });

  it("full prediction (deployed oracle, pool NOT created): local pool_id matches the live API, cST/cPT simulated, rate_drift_notice", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" } }, ctx(
      (c) => {
        if (c.functionName === "lookupRecipe") return [true, GT.bands];
        if (c.functionName === "lookupWrapper") return "0x2ba2103a37c4cff9dbb96e6f74513923d960d757";
        if (c.functionName === "rate") return GT.rate;
        if (c.functionName === "applyBands") return applyBandsLocal(GT.bands, GT.rate); // chain agrees
        if (c.functionName === "shares") return [ZERO, ZERO]; // pool does not exist yet
        throw new Error(`unexpected ${c.functionName}`);
      },
      () => ({ results: [{ status: "success", data: "0x" }, { status: "success", data: "0x" + sharesWord(GT.cpt) + sharesWord(GT.cst) }] }),
    ));
    expect(env.state).toBe("ok");
    const d = env.data as { oracle: { deployed: boolean; rate: string }; market: { poolId: string; exists: boolean }; shares: { cst: string; cpt: string; source: string } };
    expect(d.oracle.deployed).toBe(true);
    expect(BigInt(d.oracle.rate)).toBe(GT.rate);
    expect(d.market.poolId).toBe(GT.poolId); // end-to-end parity with the live endpoint
    expect(d.market.exists).toBe(false);
    expect(d.shares.cst.toLowerCase()).toBe(GT.cst);
    expect(d.shares.cpt.toLowerCase()).toBe(GT.cpt);
    expect(d.shares.source).toBe("simulated");
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(true);
  });

  it("existing pool → pinned cST/cPT read straight from poolManager, no drift notice", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" } }, ctx((c) => {
      if (c.functionName === "lookupRecipe") return [true, GT.bands];
      if (c.functionName === "lookupWrapper") return "0x2ba2103a37c4cff9dbb96e6f74513923d960d757";
      if (c.functionName === "rate") return GT.rate;
      if (c.functionName === "applyBands") return applyBandsLocal(GT.bands, GT.rate);
      if (c.functionName === "shares") return [GT.cpt, GT.cst]; // pool exists → pinned
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { market: { exists: boolean }; shares: { source: string } };
    expect(d.market.exists).toBe(true);
    expect(d.shares.source).toBe("read");
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(false);
  });

  it("share prediction gap is disclosed but pool_id/oracle/bands still returned (more capable than a 503)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" } }, ctx(
      (c) => {
        if (c.functionName === "lookupRecipe") return [true, GT.bands];
        if (c.functionName === "lookupWrapper") return "0x2ba2103a37c4cff9dbb96e6f74513923d960d757";
        if (c.functionName === "rate") return GT.rate;
        if (c.functionName === "applyBands") return applyBandsLocal(GT.bands, GT.rate);
        if (c.functionName === "shares") return [ZERO, ZERO];
        throw new Error(`unexpected ${c.functionName}`);
      },
      () => { throw new Error("eth_simulateV1 not supported"); },
    ));
    expect(env.state).toBe("ok");
    const d = env.data as { market: { poolId: string }; shares: unknown };
    expect(d.market.poolId).toBe(GT.poolId);
    expect(d.shares).toBeNull();
    expect(env.warnings.some((w) => w.code === "share_prediction_unavailable")).toBe(true);
  });

  it("a disagreeing chain applyBands → CONFLICT band_parity_mismatch (never serve unverified identity)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" } }, ctx((c) => {
      if (c.functionName === "lookupRecipe") return [true, GT.bands];
      if (c.functionName === "lookupWrapper") return "0x2ba2103a37c4cff9dbb96e6f74513923d960d757";
      if (c.functionName === "rate") return GT.rate;
      if (c.functionName === "applyBands") return { ...applyBandsLocal(GT.bands, GT.rate), rateMax: 1n }; // tampered
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("band_parity_mismatch");
  });

  it("no registry on mainnet → unknown_deployment naming 42161", async () => {
    const env = await runTool("cork_query", { chainId: 1, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" } }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
    expect(env.warnings[0]?.message).toContain("42161");
  });
});

describe("cork_compute resolve-recipe (parity-checked band math)", () => {
  it("caller-supplied rate: local math must equal the chain applyBands (ok + parity note)", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", mode: "liquidity", rate: WAD.toString() } }, {
      nowSeconds: 1n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "lookupRecipe") return [true, LIQ];
        if (c.functionName === "applyBands") return applyBandsLocal(LIQ, WAD); // chain agrees
        throw new Error(`unexpected ${c.functionName}`);
      }),
    });
    expect(env.state).toBe("ok");
    const d = env.data as { resolved: { rateMin: string }; parity: string; scales: Record<string, string> };
    expect(BigInt(d.resolved.rateMin)).toBe(WAD / 100n);
    expect(d.parity).toContain("verified");
    expect(d.scales.bands).toContain("1%");
  });

  it("a disagreeing chain → CONFLICT band_parity_mismatch (never serve unverified math)", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", mode: "liquidity", rate: WAD.toString() } }, {
      nowSeconds: 1n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "lookupRecipe") return [true, LIQ];
        if (c.functionName === "applyBands") return { ...applyBandsLocal(LIQ, WAD), rateMax: 1n }; // tampered
        throw new Error("unexpected");
      }),
    });
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("band_parity_mismatch");
  });

  it("live-rate form reads the pair's oracle via the idempotent deploy simulation", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", mode: "liquidity", collateralAsset: CA, referenceAsset: REF } }, {
      nowSeconds: 1n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "lookupRecipe") return [true, LIQ];
        if (c.functionName === "simulate:deploy") return ORACLE;
        if (c.functionName === "rate") return 2n * WAD;
        if (c.functionName === "applyBands") return applyBandsLocal(LIQ, 2n * WAD);
        throw new Error(`unexpected ${c.functionName}`);
      }),
    });
    expect(env.state).toBe("ok");
    const d = env.data as { rate: string; oracle: string; rateSource: string };
    expect(BigInt(d.rate)).toBe(2n * WAD);
    expect(d.oracle).toBe(ORACLE);
    expect(d.rateSource).toBe("live oracle");
  });
});

describe("cork_prepare_market deploy-wrapper (unsigned registry.deploy tx)", () => {
  it("builds exact calldata; already-deployed pair is a disclosed safe no-op", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "reg-mkt-0001", action: { type: "deploy-wrapper", collateralAsset: CA, referenceAsset: REF } }, {
      nowSeconds: 1n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "lookupWrapper") return ORACLE;
        throw new Error("unexpected");
      }),
    });
    expect(env.state).toBe("ok");
    const d = env.data as { to: string; calldata: string; alreadyDeployed: boolean };
    expect(d.calldata).toBe(buildDeployOracleCall(CA, REF));
    expect(d.calldata).toBe(encodeFunctionData({ abi: marketRegistryAbi, functionName: "deploy", args: [CA, REF] }));
    expect(d.alreadyDeployed).toBe(true);
    expect(env.warnings.some((w) => w.code === "oracle_already_deployed")).toBe(true);
  });

  it("offline: calldata still builds, pre-check gap disclosed", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "reg-mkt-0002", action: { type: "deploy-wrapper", collateralAsset: CA, referenceAsset: REF } }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect((env.data as { calldata: string }).calldata).toBe(buildDeployOracleCall(CA, REF));
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc")).toBe(true);
  });
});

describe("cork_prepare_orders maker-order + jitMarket", () => {
  const jitAction = {
    type: "maker-order",
    poolId: `0x${"11".repeat(32)}`,
    side: "SELL",
    makerAsset: CA, // deliberately NOT the derived cST → side-mismatch warning expected
    takerAsset: REF,
    makingAmount: "1000000000000000000",
    takingAmount: "1000000",
    jitMarket: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: "1795000000", mode: "liquidity", enableJitMint: true },
  };
  const base = { chainId: 42161 as const, account: ACCT, clientRequestId: "reg-jit-0001" };

  it("offline: extension is built and committed into the salt; skipped pre-flights disclosed", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction }, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    const d = env.data as { extension: `0x${string}`; typedData: { message: { salt: string } }; jit: { adapter: string; hook: string } };
    expect(d.extension.length).toBeGreaterThan(66);
    const decoded = decodeJitExtension(d.extension);
    expect(decoded.params.mode).toBe("liquidity");
    expect(decoded.adapter.toLowerCase()).toBe("0xea15bf1e5565181ed8678ccff39d797272858505");
    expect(d.jit.hook).toContain("preInteraction");
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc")).toBe(true);
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(true);
  });

  it("rejects jitMarket + raw extension together (mutually exclusive)", async () => {
    await expect(runTool("cork_prepare_orders", { ...base, action: { ...jitAction, extension: "0xdeadbeef" } }, { nowSeconds: 1n })).rejects.toThrow(/invalid input/);
  });

  it("fee above 5e18 (5%) is a teaching error, not a signable dud", async () => {
    const bad = { ...jitAction, jitMarket: { ...jitAction.jitMarket, swapFeePercentage: "6000000000000000000" } };
    await expect(runTool("cork_prepare_orders", { ...base, action: bad }, { nowSeconds: 1n })).rejects.toThrow(/invalid input/);
  });

  it("no adapter configured on mainnet → unknown_deployment naming 42161", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, chainId: 1, action: jitAction }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
  });

  it("plain maker order (no jitMarket) is byte-identical to before — the opt-out path", async () => {
    const plain = { ...base, action: { type: "maker-order", poolId: jitAction.poolId, side: "SELL", makerAsset: CA, takerAsset: REF, makingAmount: "1", takingAmount: "1" } };
    const env = await runTool("cork_prepare_orders", plain, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect((env.data as { extension: string }).extension).toBe("0x");
    expect((env.data as { jit?: unknown }).jit).toBeUndefined();
    expect(env.warnings.length).toBe(0);
  });
});
