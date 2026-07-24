// Bit-exact port of ConstraintRateAdapter._calculateRate / previewAdjustedRate,
// plus the committed-descent impairment-floor projection (RFC §5.2, C7).
import { max, min, mulDiv, WAD } from "./fixed.ts";
import type { ConstraintState, Market } from "../types.ts";

export const SECONDS_PER_DAY = 86400n;

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** refillRatePerSeconds = mulDiv(rateChangePerDayMax, 1e18, 1 days) — floor. */
export function refillRatePerSecond(rateChangePerDayMax: bigint): bigint {
  return mulDiv(rateChangePerDayMax, WAD, SECONDS_PER_DAY, "floor");
}

/** creditsRefilled = mulDiv(elapsed, refillRatePerSeconds, 1e18) — floor. Contract's two-step form. */
export function creditsRefilled(elapsedSeconds: bigint, rateChangePerDayMax: bigint): bigint {
  if (elapsedSeconds <= 0n) return 0n;
  return mulDiv(elapsedSeconds, refillRatePerSecond(rateChangePerDayMax), WAD, "floor");
}

export interface RateCalcParams {
  newRate: bigint;
  lastAdjustedRate: bigint;
  remainingCredits: bigint;
  lastAdjustmentTimestamp: bigint;
  currentTimestamp: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
  rateMin: bigint;
  rateMax: bigint;
}

export interface RateCalcResult {
  rate: bigint;
  remainingCredits: bigint;
  updated: boolean;
}

/** Verbatim port of ConstraintRateAdapter._calculateRate. */
export function calculateRate(p: RateCalcParams): RateCalcResult {
  const rateChangeIncoming = p.newRate - p.lastAdjustedRate;
  if (rateChangeIncoming === 0n) {
    return { rate: p.lastAdjustedRate, remainingCredits: p.remainingCredits, updated: false };
  }
  const refilled = creditsRefilled(p.currentTimestamp - p.lastAdjustmentTimestamp, p.rateChangePerDayMax);
  const creditsCapped = min(p.rateChangeCapacityMax, p.remainingCredits + refilled);

  const absIncoming = abs(rateChangeIncoming);
  const creditsConsumed = min(absIncoming, creditsCapped);

  let rate = rateChangeIncoming > 0n
    ? p.lastAdjustedRate + creditsConsumed
    : p.lastAdjustedRate - creditsConsumed;

  if (rate < p.rateMin) rate = p.rateMin;
  else if (rate > p.rateMax) rate = p.rateMax;

  const actualRateChange = rate > p.lastAdjustedRate ? rate - p.lastAdjustedRate : p.lastAdjustedRate - rate;
  return { rate, remainingCredits: creditsCapped - actualRateChange, updated: true };
}

/**
 * ConstraintRateAdapter.previewAdjustedRate: single-move adjusted rate toward the oracle at `nowTs`.
 * This is what CorkPoolManager.swapRate / the preview functions read.
 */
export function previewAdjustedRate(args: {
  market: Market;
  state: ConstraintState;
  oracleRate: bigint;
  nowTs: bigint;
}): bigint {
  return calculateRate({
    newRate: args.oracleRate,
    lastAdjustedRate: args.state.lastAdjustedRate,
    remainingCredits: args.state.remainingCredits,
    lastAdjustmentTimestamp: args.state.lastAdjustmentTimestamp,
    currentTimestamp: args.nowTs,
    rateChangePerDayMax: args.market.rateChangePerDayMax,
    rateChangeCapacityMax: args.market.rateChangeCapacityMax,
    rateMin: args.market.rateMin,
    rateMax: args.market.rateMax,
  }).rate;
}

export interface ImpairmentFloor {
  /** Worst reachable swapRate at the horizon (WAD). */
  worstRate: bigint;
  /** Max REF paid per 1e18 cST at that rate = ceil(1e18 / worstRate) (WAD). NULL exactly when
   *  worstRate is 0 (rateMin = 0 and full descent): impairment can be total and the ref-per-cST
   *  cost is unbounded — a meaningful answer, not a division-by-zero crash. */
  maxReferencePerCst: bigint | null;
  /** Whether the floor is pinned at rateMin over the horizon. */
  clampedAtMin: boolean;
  /** Descent budget available at tEval after refilling the stored bucket to now. */
  availableAtEval: bigint;
}

/**
 * Committed-descent worst-case floor over `horizonSeconds` from `tEval` (RFC §5.2, verified C7).
 *
 * The on-chain preview can only move the rate by one bucket; the *reachable* floor requires
 * modelling repeated adversarial commits. The stored `remainingCredits` is as of
 * `lastAdjustmentTimestamp`, so we FIRST advance the bucket to `tEval` (capped at capacity),
 * THEN add refill accrued over the horizon (a single interval maximizes refill — floor is
 * subadditive, so splitting into many commits can only lose wei). Descent is NOT capacity-capped
 * cumulatively; capacity only caps the instantaneous bucket.
 */
export function impairmentFloor(args: {
  market: Market;
  state: ConstraintState;
  horizonSeconds: bigint;
  tEval: bigint;
}): ImpairmentFloor {
  const { market: m, state: s } = args;
  const availUncapped = s.remainingCredits + creditsRefilled(args.tEval - s.lastAdjustmentTimestamp, m.rateChangePerDayMax);
  const availableAtEval = min(m.rateChangeCapacityMax, availUncapped);
  const horizonRefill = creditsRefilled(args.horizonSeconds, m.rateChangePerDayMax);
  const descent = availableAtEval + horizonRefill;

  const floorFromLast = s.lastAdjustedRate > descent ? s.lastAdjustedRate - descent : 0n;
  const worstRate = max(m.rateMin, floorFromLast);
  // worstRate can be 0 only when rateMin = 0 (createNewPool enforces rateMin > 0, but recipe/
  // library callers can construct it): the honest answer is "impairment can be total".
  const maxReferencePerCst = worstRate === 0n ? null : mulDiv(WAD, WAD, worstRate, "ceil");
  return {
    worstRate,
    maxReferencePerCst,
    clampedAtMin: worstRate === m.rateMin,
    availableAtEval,
  };
}
