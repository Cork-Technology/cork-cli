export type Hex40 = `0x${string}`;

/** phoenix IPoolManager.Market on the `8-field` wire (phoenix ≤ v1.3.0-rc.1), bigint-typed:
 *  fees live OUTSIDE the struct (swapFee/unwindSwapFee views, creation-time settings) and
 *  outside the pool id. */
export interface Market8 {
  collateralAsset: Hex40;
  referenceAsset: Hex40;
  expiryTimestamp: bigint;
  rateMin: bigint;
  rateMax: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
  rateOracle: Hex40;
}

/** phoenix IPoolManager.Market on the `10-field` wire (phoenix v1.4.0-rc.1, Distribution
 *  cork/v0.4): the two fee percentages (1e18 = 1%, strictly below 100%) are the last two
 *  struct fields — fixed for the pool lifetime and PART OF THE POOL ID. Structurally a superset
 *  of Market8, which is exactly why `computeMarketId` takes the wire explicitly: TypeScript would
 *  otherwise let a 10-field market flow into an 8-field hash unnoticed. */
export interface Market10 extends Market8 {
  swapFeePercentage: bigint;
  unwindSwapFeePercentage: bigint;
}

/** Either wire's Market. Consumers pinned to one wire type the variant they read; the generation's
 *  `phoenix.wire` says which. */
export type Market = Market8 | Market10;

/** ConstraintRateAdapter.constraints(poolId) → (lastAdjustedRate, lastAdjustmentTimestamp, remainingCredits). */
export interface ConstraintState {
  lastAdjustedRate: bigint;
  lastAdjustmentTimestamp: bigint;
  remainingCredits: bigint;
}

/** Per-pool fee state (1e18 = 1%). On the 8-field wire these are separate views; on the 10-field
 *  wire they are the Market's own last two fields. */
export interface PoolFees {
  swapFeePercentage: bigint;
  unwindSwapFeePercentage: bigint;
}

export interface Decimals {
  collateralDecimals: number;
  referenceDecimals: number;
}
