// MarketId = keccak256(abi.encode(Market)) — CorkPoolManager.getId, one struct width per
// phoenix wire:
//   8-field  (≤ v1.3.0-rc.1; CorkPoolManager.sol:113/143, IPoolManager.sol:29): collateralAsset,
//            referenceAsset, expiryTimestamp, rateMin, rateMax, rateChangePerDayMax,
//            rateChangeCapacityMax, rateOracle.
//   10-field (v1.4.0-rc.1, Distribution phoenix/v0.4-rc.1; IPoolManager.sol:33-44,
//            CorkPoolManager.sol:144): the same eight, then swapFeePercentage,
//            unwindSwapFeePercentage — the fees are part of the identity.
// The wire is an EXPLICIT argument and the market's shape is checked against it: a 10-field
// market hashed as 8 fields (or the reverse) is refused, never silently widened or narrowed — a
// viem decode of a 10-field `market()` return through an 8-field ABI succeeds silently, so the
// hash is the last place this class can be caught (0.6 design contract, "never a silent
// widening"). Golden vectors: the 8-field cast vector and the 10-field `pm.getId` captured live
// 2026-09-22 on 42161, both pinned in test/marketid.test.ts.
import { encodeAbiParameters, keccak256 } from "viem";
import type { PhoenixWire } from "./generations.ts";
import type { Market, Market10, Market8 } from "./types.ts";

const MARKET8_COMPONENTS = [
  { name: "collateralAsset", type: "address" },
  { name: "referenceAsset", type: "address" },
  { name: "expiryTimestamp", type: "uint256" },
  { name: "rateMin", type: "uint256" },
  { name: "rateMax", type: "uint256" },
  { name: "rateChangePerDayMax", type: "uint256" },
  { name: "rateChangeCapacityMax", type: "uint256" },
  { name: "rateOracle", type: "address" },
] as const;

const MARKET8_ABI = [{ type: "tuple", components: MARKET8_COMPONENTS }] as const;

const MARKET10_ABI = [
  {
    type: "tuple",
    components: [
      ...MARKET8_COMPONENTS,
      { name: "swapFeePercentage", type: "uint256" },
      { name: "unwindSwapFeePercentage", type: "uint256" },
    ],
  },
] as const;

/** True when the object carries the two 10-field fee members. Both or neither: a market with one
 *  fee field is malformed and refused by `computeMarketId`. */
export function isMarket10(market: Market): market is Market10 {
  return "swapFeePercentage" in market && "unwindSwapFeePercentage" in market;
}

/** Refuse a market whose shape contradicts the wire it is hashed under. */
export function assertMarketWire(market: Market, wire: PhoenixWire): void {
  const hasSwap = "swapFeePercentage" in market;
  const hasUnwind = "unwindSwapFeePercentage" in market;
  if (hasSwap !== hasUnwind) {
    throw new Error("computeMarketId: malformed Market — swapFeePercentage and unwindSwapFeePercentage must both be present (10-field) or both absent (8-field)");
  }
  if (wire === "8-field" && hasSwap) {
    throw new Error("computeMarketId: a 10-field Market (fees inside the struct) cannot be hashed on the 8-field wire — the fees are part of the 10-field pool id; pass wire '10-field', or drop them only if the pool manager is an 8-field generation");
  }
  if (wire === "10-field" && !hasSwap) {
    throw new Error("computeMarketId: an 8-field Market cannot be hashed on the 10-field wire — swapFeePercentage and unwindSwapFeePercentage are part of the 10-field pool id; supply both (1e18 = 1%)");
  }
}

/** keccak256(abi.encode(Market)) for the given wire. The wire is explicit (no inference): the
 *  caller knows which pool manager generation it is deriving for, and the shape check refuses a
 *  market that does not match it. */
export function computeMarketId(market: Market, wire: PhoenixWire): `0x${string}` {
  assertMarketWire(market, wire);
  if (wire === "10-field") {
    const m = market as Market10;
    return keccak256(
      encodeAbiParameters(MARKET10_ABI, [
        {
          collateralAsset: m.collateralAsset,
          referenceAsset: m.referenceAsset,
          expiryTimestamp: m.expiryTimestamp,
          rateMin: m.rateMin,
          rateMax: m.rateMax,
          rateChangePerDayMax: m.rateChangePerDayMax,
          rateChangeCapacityMax: m.rateChangeCapacityMax,
          rateOracle: m.rateOracle,
          swapFeePercentage: m.swapFeePercentage,
          unwindSwapFeePercentage: m.unwindSwapFeePercentage,
        },
      ]),
    );
  }
  const m = market as Market8;
  const encoded = encodeAbiParameters(MARKET8_ABI, [
    {
      collateralAsset: m.collateralAsset,
      referenceAsset: m.referenceAsset,
      expiryTimestamp: m.expiryTimestamp,
      rateMin: m.rateMin,
      rateMax: m.rateMax,
      rateChangePerDayMax: m.rateChangePerDayMax,
      rateChangeCapacityMax: m.rateChangeCapacityMax,
      rateOracle: m.rateOracle,
    },
  ]);
  return keccak256(encoded);
}
