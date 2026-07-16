// MarketId = keccak256(abi.encode(Market)) — verified against
// CorkPoolManager.sol:113/143 and IPoolManager.sol:29. Field order is the struct order:
// collateralAsset, referenceAsset, expiryTimestamp, rateMin, rateMax,
// rateChangePerDayMax, rateChangeCapacityMax, rateOracle.
import { encodeAbiParameters, keccak256 } from "viem";
import type { Market } from "./types.ts";

const MARKET_ABI = [
  {
    type: "tuple",
    components: [
      { name: "collateralAsset", type: "address" },
      { name: "referenceAsset", type: "address" },
      { name: "expiryTimestamp", type: "uint256" },
      { name: "rateMin", type: "uint256" },
      { name: "rateMax", type: "uint256" },
      { name: "rateChangePerDayMax", type: "uint256" },
      { name: "rateChangeCapacityMax", type: "uint256" },
      { name: "rateOracle", type: "address" },
    ],
  },
] as const;

export function computeMarketId(market: Market): `0x${string}` {
  const encoded = encodeAbiParameters(MARKET_ABI, [
    {
      collateralAsset: market.collateralAsset,
      referenceAsset: market.referenceAsset,
      expiryTimestamp: market.expiryTimestamp,
      rateMin: market.rateMin,
      rateMax: market.rateMax,
      rateChangePerDayMax: market.rateChangePerDayMax,
      rateChangeCapacityMax: market.rateChangeCapacityMax,
      rateOracle: market.rateOracle,
    },
  ]);
  return keccak256(encoded);
}
