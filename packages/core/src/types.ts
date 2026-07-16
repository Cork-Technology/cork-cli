export type Hex40 = `0x${string}`;

/** phoenix-private IPoolManager.Market (8 fields), bigint-typed. */
export interface Market {
  collateralAsset: Hex40;
  referenceAsset: Hex40;
  expiryTimestamp: bigint;
  rateMin: bigint;
  rateMax: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
  rateOracle: Hex40;
}

/** ConstraintRateAdapter.constraints(poolId) → (lastAdjustedRate, lastAdjustmentTimestamp, remainingCredits). */
export interface ConstraintState {
  lastAdjustedRate: bigint;
  lastAdjustmentTimestamp: bigint;
  remainingCredits: bigint;
}

/** Per-pool fee state (1e18 = 1%). */
export interface PoolFees {
  swapFeePercentage: bigint;
  unwindSwapFeePercentage: bigint;
}

export interface Decimals {
  collateralDecimals: number;
  referenceDecimals: number;
}
