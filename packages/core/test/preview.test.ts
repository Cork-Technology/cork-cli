import { describe, expect, it } from "vitest";
import {
  previewExercise,
  previewExerciseOther,
  previewSwap,
  previewUnwindExercise,
  previewUnwindExerciseOther,
  previewUnwindSwap,
} from "@cork/core";
import type { SwapContext, UnwindContext } from "@cork/core";

const WAD = 10n ** 18n;
const RATE = 8n * 10n ** 17n; // 0.8e18
const SWAP_FEE = 5n * 10n ** 17n; // 0.5%
const UNWIND_FEE = WAD; // 1%
// Unwind time window with t = 0.5 (start 100, end 1100, cur 600).
const T = { issuedAt: 100n, expiryTimestamp: 1100n, nowTs: 600n };

const swapCtx = (collateralDecimals: number, referenceDecimals: number): SwapContext => ({
  swapRate: RATE,
  swapFeePercentage: SWAP_FEE,
  collateralDecimals,
  referenceDecimals,
});
const unwindCtx = (collateralDecimals: number, referenceDecimals: number): UnwindContext => ({
  swapRate: RATE,
  unwindSwapFeePercentage: UNWIND_FEE,
  collateralDecimals,
  referenceDecimals,
  ...T,
});

// All expected values computed independently in Python mirroring PoolLib/MathHelper integer math.
describe("previewSwap", () => {
  it("18/18 dec", () => {
    expect(previewSwap(1000n * WAD, swapCtx(18, 18))).toEqual({
      cstSharesIn: 1005025125628140703518n,
      referenceAssetsIn: 1256281407035175879398n,
      fee: 5025125628140703518n,
    });
  });
  it("collateral 6 dec / reference 18 dec", () => {
    expect(previewSwap(1000n * 10n ** 6n, swapCtx(6, 18))).toEqual({
      cstSharesIn: 1005025126000000000000n,
      referenceAssetsIn: 1256281407500000000000n,
      fee: 5025126n,
    });
  });
});

describe("previewExercise / previewExerciseOther", () => {
  it("previewExercise 18/18, cstIn 500e18", () => {
    expect(previewExercise(500n * WAD, swapCtx(18, 18))).toEqual({
      collateralAssetsOut: 497500000000000000000n,
      referenceAssetsIn: 625000000000000000000n,
      fee: 2500000000000000000n,
    });
  });
  it("previewExerciseOther 18/18, refIn 400e18", () => {
    expect(previewExerciseOther(400n * WAD, swapCtx(18, 18))).toEqual({
      collateralAssetsOut: 318400000000000000000n,
      cstSharesIn: 320000000000000000000n,
      fee: 1600000000000000000n,
    });
  });
});

describe("previewUnwindSwap (time-decay fee)", () => {
  it("18/18, caIn 1000e18, t=0.5", () => {
    expect(previewUnwindSwap(1000n * WAD, unwindCtx(18, 18))).toEqual({
      cstSharesOut: 995000000000000000000n,
      referenceAssetsOut: 1243750000000000000000n,
      fee: 5000000000000000000n,
    });
  });
});

describe("previewUnwindExercise / previewUnwindExerciseOther", () => {
  it("previewUnwindExercise 18/18, cstOut 500e18", () => {
    expect(previewUnwindExercise(500n * WAD, unwindCtx(18, 18))).toEqual({
      collateralAssetsIn: 502512562814070351759n,
      fee: 2512562814070351759n,
      referenceAssetsOut: 625000000000000000000n,
    });
  });
  it("previewUnwindExerciseOther, reference 18 dec / collateral 6 dec, refOut 300e18", () => {
    expect(previewUnwindExerciseOther(300n * WAD, unwindCtx(6, 18))).toEqual({
      collateralAssetsIn: 241206031n,
      fee: 1206031n,
      cstSharesOut: 240000000000000000000n,
    });
  });
});

// Every preview short-circuits a zero request to an all-zero result, mirroring the on-chain
// `if (amount == 0) return 0` guards in PoolLib — the shared contract, pinned across the family.
describe("zero request short-circuits to all-zero", () => {
  const s = swapCtx(18, 18);
  const u = unwindCtx(18, 18);
  // Return-type union keeps Object.values typed as bigint[] (the preview interfaces have no
  // index signature, so a Record<string, bigint> annotation would not accept them).
  type ZeroPreview =
    | ReturnType<typeof previewSwap>
    | ReturnType<typeof previewExercise>
    | ReturnType<typeof previewExerciseOther>
    | ReturnType<typeof previewUnwindSwap>
    | ReturnType<typeof previewUnwindExercise>
    | ReturnType<typeof previewUnwindExerciseOther>;
  const cases: Array<[string, ZeroPreview]> = [
    ["previewSwap", previewSwap(0n, s)],
    ["previewExercise", previewExercise(0n, s)],
    ["previewExerciseOther", previewExerciseOther(0n, s)],
    ["previewUnwindSwap", previewUnwindSwap(0n, u)],
    ["previewUnwindExercise", previewUnwindExercise(0n, u)],
    ["previewUnwindExerciseOther", previewUnwindExerciseOther(0n, u)],
  ];
  it.each(cases)("%s returns every field as 0n", (_name, result) => {
    for (const v of Object.values(result)) expect(v).toBe(0n);
  });
});
