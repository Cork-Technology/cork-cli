import { describe, expect, it } from "vitest";
import { computeMarketId } from "@cork/core";
import type { Market } from "@cork/core";

describe("computeMarketId = keccak256(abi.encode(Market))", () => {
  it("matches independent `cast abi-encode|keccak` ground-truth", () => {
    // Golden vector produced out-of-band with foundry:
    //   cast abi-encode 'f((address,address,uint256,uint256,uint256,uint256,uint256,address))' '(...)' | cast keccak
    const m: Market = {
      collateralAsset: "0x1111111111111111111111111111111111111111",
      referenceAsset: "0x2222222222222222222222222222222222222222",
      expiryTimestamp: 1893456000n,
      rateMin: 500000000000000000n,
      rateMax: 1000000000000000000n,
      rateChangePerDayMax: 1000000000000n,
      rateChangeCapacityMax: 7000000000000000n,
      rateOracle: "0x3333333333333333333333333333333333333333",
    };
    expect(computeMarketId(m)).toBe(
      "0x2d14be74c573620a56ee10efe092ef80866d597b8e3d73cd6dffa223bb50b4f7",
    );
  });

  it("is sensitive to every field (changing rateMin changes id)", () => {
    const m: Market = {
      collateralAsset: "0x1111111111111111111111111111111111111111",
      referenceAsset: "0x2222222222222222222222222222222222222222",
      expiryTimestamp: 1893456000n,
      rateMin: 500000000000000000n,
      rateMax: 1000000000000000000n,
      rateChangePerDayMax: 1000000000000n,
      rateChangeCapacityMax: 7000000000000000n,
      rateOracle: "0x3333333333333333333333333333333333333333",
    };
    expect(computeMarketId({ ...m, rateMin: m.rateMin + 1n })).not.toBe(computeMarketId(m));
  });
});
