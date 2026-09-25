import { describe, expect, it } from "vitest";
import { assertMarketWire, computeMarketId, isMarket10 } from "@cork/core";
import type { Market10, Market8 } from "@cork/core";

const M8: Market8 = {
  collateralAsset: "0x1111111111111111111111111111111111111111",
  referenceAsset: "0x2222222222222222222222222222222222222222",
  expiryTimestamp: 1893456000n,
  rateMin: 500000000000000000n,
  rateMax: 1000000000000000000n,
  rateChangePerDayMax: 1000000000000n,
  rateChangeCapacityMax: 7000000000000000n,
  rateOracle: "0x3333333333333333333333333333333333333333",
};

// The 10-field sample `pm.getId` was called with on the live cork/v0.4 pool manager
// (0xcC17…0C2D, Arbitrum One), captured 2026-09-22 on 42161 (live-vectors.json): USDC / the
// 0x9c68… reference, expiry 1800000000, constraint 1e18 / 2e18 / 1e16 / 5e16, the
// LiquidityNavRecipe address standing in as rateOracle, fees 1e18 / 2e18.
const M10: Market10 = {
  collateralAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  referenceAsset: "0x9c6864105AEC23388C89600046213a44C384c831",
  expiryTimestamp: 1800000000n,
  rateMin: 1000000000000000000n,
  rateMax: 2000000000000000000n,
  rateChangePerDayMax: 10000000000000000n,
  rateChangeCapacityMax: 50000000000000000n,
  rateOracle: "0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3",
  swapFeePercentage: 1000000000000000000n,
  unwindSwapFeePercentage: 2000000000000000000n,
};
const M10_GET_ID = "0xf749ab18e2ca039a13f874ef8aff8bffcc18e618da6c8d8382538a5d85f0f7c3";

describe("computeMarketId = keccak256(abi.encode(Market)) — one struct width per wire", () => {
  it("8-field: matches independent `cast abi-encode|keccak` ground-truth", () => {
    // Golden vector produced out-of-band with foundry:
    //   cast abi-encode 'f((address,address,uint256,uint256,uint256,uint256,uint256,address))' '(...)' | cast keccak
    expect(computeMarketId(M8, "8-field")).toBe("0x2d14be74c573620a56ee10efe092ef80866d597b8e3d73cd6dffa223bb50b4f7");
  });

  it("10-field: matches the live pool manager's getId (captured live 2026-09-22 on 42161)", () => {
    expect(computeMarketId(M10, "10-field")).toBe(M10_GET_ID);
  });

  it("is sensitive to every field on both wires (changing rateMin or a fee changes the id)", () => {
    expect(computeMarketId({ ...M8, rateMin: M8.rateMin + 1n }, "8-field")).not.toBe(computeMarketId(M8, "8-field"));
    expect(computeMarketId({ ...M10, swapFeePercentage: M10.swapFeePercentage + 1n }, "10-field")).not.toBe(M10_GET_ID);
    expect(computeMarketId({ ...M10, unwindSwapFeePercentage: M10.unwindSwapFeePercentage + 1n }, "10-field")).not.toBe(M10_GET_ID);
  });

  it("never a silent widening: a 10-field market cannot be hashed on the 8-field wire, nor an 8-field one on the 10-field wire", () => {
    // TypeScript would let Market10 flow into an 8-field parameter (structural superset) — the
    // runtime shape check is what refuses it. The 8-field hash of the first eight fields is a
    // DIFFERENT id from getId's, so a silent narrowing would name a pool that does not exist.
    expect(() => computeMarketId(M10, "8-field")).toThrow(/10-field Market .* cannot be hashed on the 8-field wire/);
    expect(() => computeMarketId(M8, "10-field")).toThrow(/8-field Market cannot be hashed on the 10-field wire/);
    const { swapFeePercentage: _s, unwindSwapFeePercentage: _u, ...first8 } = M10;
    expect(computeMarketId(first8, "8-field")).not.toBe(M10_GET_ID);
  });

  it("a market with only one fee field is malformed on either wire", () => {
    const { unwindSwapFeePercentage: _u, ...half } = M10;
    expect(() => computeMarketId(half as unknown as Market10, "10-field")).toThrow(/both be present/);
    expect(() => computeMarketId(half as unknown as Market10, "8-field")).toThrow(/both be present/);
    expect(() => assertMarketWire(M8, "8-field")).not.toThrow();
    expect(isMarket10(M10)).toBe(true);
    expect(isMarket10(M8)).toBe(false);
  });
});
