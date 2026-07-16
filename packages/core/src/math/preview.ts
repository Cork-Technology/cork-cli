// Bit-exact ports of phoenix-private PoolLib preview functions (verified against
// contracts/libraries/PoolLib.sol). These are PURE: the caller supplies the already-resolved
// `swapRate` (from previewAdjustedRate) plus decimals/fees/time, so each function can be
// fork-verified wei-for-wei against the on-chain preview*/previewAdjustedRate pair.
import {
  fixedToTokenNativeDecimals,
  fixedToTokenNativeDecimalsCeil,
  mulDiv,
  normalizeDecimalsCeil,
  tokenNativeDecimalsToFixed,
  WAD,
} from "./fixed.ts";
import {
  calculateDepositAmountWithSwapRate,
  calculateEqualSwapAmount,
  calculateGrossAmountBeforeFee,
  calculateGrossAmountWithTimeDecayFee,
  calculatePercentageFee,
  calculateTimeDecayFee,
} from "./mathhelper.ts";

export interface SwapContext {
  swapRate: bigint; // resolved previewAdjustedRate (WAD)
  swapFeePercentage: bigint; // 1e18 = 1%
  collateralDecimals: number;
  referenceDecimals: number;
}

export interface UnwindContext {
  swapRate: bigint;
  unwindSwapFeePercentage: bigint;
  collateralDecimals: number;
  referenceDecimals: number;
  issuedAt: bigint;
  expiryTimestamp: bigint;
  nowTs: bigint;
}

export interface SwapPreview {
  cstSharesIn: bigint;
  referenceAssetsIn: bigint;
  fee: bigint;
}
export interface ExercisePreview {
  collateralAssetsOut: bigint;
  referenceAssetsIn: bigint;
  fee: bigint;
}
export interface ExerciseOtherPreview {
  collateralAssetsOut: bigint;
  cstSharesIn: bigint;
  fee: bigint;
}
export interface UnwindSwapPreview {
  cstSharesOut: bigint;
  referenceAssetsOut: bigint;
  fee: bigint;
}
export interface UnwindExercisePreview {
  collateralAssetsIn: bigint;
  fee: bigint;
  referenceAssetsOut: bigint;
}
export interface UnwindExerciseOtherPreview {
  collateralAssetsIn: bigint;
  fee: bigint;
  cstSharesOut: bigint;
}

/** PoolLib._getPreviewExerciseFeeAndCollateralAssetsOut. */
function exerciseFeeAndOut(cstSharesIn: bigint, ctx: SwapContext): { collateralAssetsOut: bigint; fee: bigint } {
  const assetsBeforeFee = fixedToTokenNativeDecimals(cstSharesIn, ctx.collateralDecimals);
  const fee = calculatePercentageFee(ctx.swapFeePercentage, assetsBeforeFee);
  return { collateralAssetsOut: assetsBeforeFee - fee, fee };
}

/** PoolLib.previewSwap — cST + REF needed to receive exactly `collateralAssetsOut`. */
export function previewSwap(collateralAssetsOut: bigint, ctx: SwapContext): SwapPreview {
  if (collateralAssetsOut === 0n) return { cstSharesIn: 0n, referenceAssetsIn: 0n, fee: 0n };
  const grossCollateralAssets = calculateGrossAmountBeforeFee(collateralAssetsOut, ctx.swapFeePercentage);
  const cstSharesIn = tokenNativeDecimalsToFixed(grossCollateralAssets, ctx.collateralDecimals);
  const fee = grossCollateralAssets - collateralAssetsOut;
  const referenceAssetsInFixed = calculateDepositAmountWithSwapRate(cstSharesIn, ctx.swapRate, true);
  const referenceAssetsIn = fixedToTokenNativeDecimalsCeil(referenceAssetsInFixed, ctx.referenceDecimals);
  return { cstSharesIn, referenceAssetsIn, fee };
}

/** PoolLib.previewExercise — collateral out for `cstSharesIn` cST (18-dec) locked. */
export function previewExercise(cstSharesIn: bigint, ctx: SwapContext): ExercisePreview {
  if (cstSharesIn === 0n) return { collateralAssetsOut: 0n, referenceAssetsIn: 0n, fee: 0n };
  const referenceAssetsIn = fixedToTokenNativeDecimalsCeil(
    calculateDepositAmountWithSwapRate(cstSharesIn, ctx.swapRate, true),
    ctx.referenceDecimals,
  );
  const { collateralAssetsOut, fee } = exerciseFeeAndOut(cstSharesIn, ctx);
  return { collateralAssetsOut, referenceAssetsIn, fee };
}

/** PoolLib.previewExerciseOther — provide `referenceAssetsIn`, receive collateral. */
export function previewExerciseOther(referenceAssetsIn: bigint, ctx: SwapContext): ExerciseOtherPreview {
  if (referenceAssetsIn === 0n) return { collateralAssetsOut: 0n, cstSharesIn: 0n, fee: 0n };
  const cstSharesIn = calculateEqualSwapAmount(
    tokenNativeDecimalsToFixed(referenceAssetsIn, ctx.referenceDecimals),
    ctx.swapRate,
  );
  const { collateralAssetsOut, fee } = exerciseFeeAndOut(cstSharesIn, ctx);
  return { collateralAssetsOut, cstSharesIn, fee };
}

/** PoolLib.previewUnwindSwap — deposit collateral, receive cST + REF (time-decay fee). */
export function previewUnwindSwap(collateralAssetsIn: bigint, ctx: UnwindContext): UnwindSwapPreview {
  if (collateralAssetsIn === 0n) return { cstSharesOut: 0n, referenceAssetsOut: 0n, fee: 0n };
  const fee = calculateTimeDecayFee(
    ctx.issuedAt,
    ctx.expiryTimestamp,
    ctx.nowTs,
    collateralAssetsIn,
    ctx.unwindSwapFeePercentage,
  );
  const net = tokenNativeDecimalsToFixed(collateralAssetsIn - fee, ctx.collateralDecimals);
  const referenceAssetsOut = fixedToTokenNativeDecimals(
    calculateDepositAmountWithSwapRate(net, ctx.swapRate, false),
    ctx.referenceDecimals,
  );
  return { cstSharesOut: net, referenceAssetsOut, fee };
}

/** PoolLib.previewUnwindExercise — unlock `cstSharesOut` cST, pay collateral (gross+time-decay). */
export function previewUnwindExercise(cstSharesOut: bigint, ctx: UnwindContext): UnwindExercisePreview {
  if (cstSharesOut === 0n) return { collateralAssetsIn: 0n, fee: 0n, referenceAssetsOut: 0n };
  const referenceAssetsOut = fixedToTokenNativeDecimals(
    calculateDepositAmountWithSwapRate(cstSharesOut, ctx.swapRate, false),
    ctx.referenceDecimals,
  );
  const collateralAssetsInWithoutFee = fixedToTokenNativeDecimalsCeil(cstSharesOut, ctx.collateralDecimals);
  const { fee, assetIn } = calculateGrossAmountWithTimeDecayFee(
    ctx.issuedAt,
    ctx.expiryTimestamp,
    ctx.nowTs,
    collateralAssetsInWithoutFee,
    ctx.unwindSwapFeePercentage,
  );
  return { collateralAssetsIn: assetIn, fee, referenceAssetsOut };
}

/** PoolLib.previewUnwindExerciseOther — unlock `referenceAssetsOut` REF, pay collateral. */
export function previewUnwindExerciseOther(
  referenceAssetsOut: bigint,
  ctx: UnwindContext,
): UnwindExerciseOtherPreview {
  if (referenceAssetsOut === 0n) return { collateralAssetsIn: 0n, fee: 0n, cstSharesOut: 0n };
  const cstSharesOut = calculateEqualSwapAmount(
    tokenNativeDecimalsToFixed(referenceAssetsOut, ctx.referenceDecimals),
    ctx.swapRate,
  );
  const normalizedReferenceAsset = normalizeDecimalsCeil(
    referenceAssetsOut,
    ctx.referenceDecimals,
    ctx.collateralDecimals,
  );
  const assetsInWithoutFee = mulDiv(normalizedReferenceAsset, ctx.swapRate, WAD, "ceil");
  const { fee, assetIn } = calculateGrossAmountWithTimeDecayFee(
    ctx.issuedAt,
    ctx.expiryTimestamp,
    ctx.nowTs,
    assetsInWithoutFee,
    ctx.unwindSwapFeePercentage,
  );
  return { collateralAssetsIn: assetIn, fee, cstSharesOut };
}
