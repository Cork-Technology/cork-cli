// Bit-exact port of phoenix-private/contracts/libraries/MathHelper.sol
import { mulDiv, PCT_DENOM, WAD } from "./fixed.ts";

/** amount * swapRate / 1e18, floor. */
export function calculateEqualSwapAmount(referenceAsset: bigint, swapRate: bigint): bigint {
  return mulDiv(referenceAsset, swapRate, WAD, "floor");
}

/** ceil(amount * fee1e18 / 100e18). fee1e18: 1e18 = 1%. */
export function calculatePercentageFee(fee1e18: bigint, amount: bigint): bigint {
  return mulDiv(amount, fee1e18, PCT_DENOM, "ceil");
}

/** amount * 1e18 / swapRate, ceil if isRoundUp else floor. */
export function calculateDepositAmountWithSwapRate(
  amount: bigint,
  swapRate: bigint,
  isRoundUp: boolean,
): bigint {
  return mulDiv(amount, WAD, swapRate, isRoundUp ? "ceil" : "floor");
}

/** A fee at or above 100% has no finite gross amount; the Solidity original div-by-zero/underflow
 *  reverts, so the ports refuse with a domain message instead of dividing by <= 0. */
function assertFeeBelowFull(fee1e18: bigint, fn: string): void {
  if (fee1e18 >= PCT_DENOM) {
    throw new Error(`${fn}: fee percentage ${fee1e18} is >= 100% (PCT_DENOM ${PCT_DENOM}, 1e18 = 1%) — no finite gross amount exists; the contract reverts here`);
  }
}

/** ceil(desiredAmount * 100e18 / (100e18 - feeRate)). */
export function calculateGrossAmountBeforeFee(desiredAmount: bigint, feeRate: bigint): bigint {
  assertFeeBelowFull(feeRate, "calculateGrossAmountBeforeFee");
  return mulDiv(desiredAmount, PCT_DENOM, PCT_DENOM - feeRate, "ceil");
}

/**
 * Normalized time-to-maturity in [0,1] WAD. 1 = at start, 0 = at/after maturity.
 * elapsed = current-start (min 1); if elapsed >= total → 0; else (total-elapsed)*1e18/total (floor).
 * Revert-parity: the Solidity original is uint256 arithmetic, so current<start / end<start
 * underflow-revert there — the port throws on the same domain instead of returning t>WAD.
 */
export function computeT(start: bigint, end: bigint, current: bigint): bigint {
  if (current < start) throw new Error(`computeT: current (${current}) is before start (${start}) — the contract underflow-reverts here`);
  if (end < start) throw new Error(`computeT: end (${end}) is before start (${start}) — the contract underflow-reverts here`);
  let elapsed = current - start;
  if (elapsed === 0n) elapsed = 1n;
  const total = end - start;
  if (elapsed >= total) return 0n;
  return ((total - elapsed) * WAD) / total;
}

/** Time-decay fee: feeFactor = ceil(baseFee*t/1e18); fee = ceil(amount*feeFactor/100e18). */
export function calculateTimeDecayFee(
  start: bigint,
  end: bigint,
  current: bigint,
  amount: bigint,
  baseFeePercentage: bigint,
): bigint {
  if (amount === 0n) return 0n;
  const t = computeT(start, end, current);
  const feeFactor = mulDiv(baseFeePercentage, t, WAD, "ceil");
  return mulDiv(amount, feeFactor, PCT_DENOM, "ceil");
}

/** Inverse: gross amount whose net-after-time-decay-fee equals `amount`. Returns {fee, assetIn}. */
export function calculateGrossAmountWithTimeDecayFee(
  start: bigint,
  end: bigint,
  current: bigint,
  amount: bigint,
  baseFeePercentage: bigint,
): { fee: bigint; assetIn: bigint } {
  if (amount === 0n) return { fee: 0n, assetIn: 0n };
  const t = computeT(start, end, current);
  const feeFactor = mulDiv(baseFeePercentage, t, WAD, "ceil");
  assertFeeBelowFull(feeFactor, "calculateGrossAmountWithTimeDecayFee");
  const withFee = mulDiv(amount, PCT_DENOM, PCT_DENOM - feeFactor, "ceil");
  return { fee: withFee - amount, assetIn: withFee };
}
