import { describe, expect, it } from "vitest";
import {
  calculateDepositAmountWithSwapRate,
  calculateEqualSwapAmount,
  calculateGrossAmountBeforeFee,
  calculateGrossAmountWithTimeDecayFee,
  calculatePercentageFee,
  calculateTimeDecayFee,
  ceilDiv,
  computeT,
  fixedToTokenNativeDecimals,
  fixedToTokenNativeDecimalsCeil,
  mulDiv,
  normalizeDecimals,
  normalizeDecimalsCeil,
  PCT_DENOM,
  tokenNativeDecimalsToFixed,
  WAD,
} from "@cork/core";

const ether = (n: string): bigint => {
  // parse decimal string to 1e18-fixed exactly
  const [whole, frac = ""] = n.split(".");
  const fracPad = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole ?? "0") * WAD + BigInt(fracPad || "0");
};

describe("mulDiv / ceilDiv (OZ Math parity)", () => {
  it("floors by default", () => {
    expect(mulDiv(7n, 3n, 2n)).toBe(10n); // 21/2 = 10.5 -> 10
  });
  it("ceils on remainder", () => {
    expect(mulDiv(7n, 3n, 2n, "ceil")).toBe(11n);
  });
  it("ceil is exact when divisible", () => {
    expect(mulDiv(6n, 2n, 3n, "ceil")).toBe(4n);
  });
  it("ceilDiv(0)=0, ceilDiv rounds up", () => {
    expect(ceilDiv(0n, 5n)).toBe(0n);
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
  });
});

describe("computeT (golden vectors from Foundry computeT.t.sol)", () => {
  it("start of period (elapsed=1)", () => {
    expect(computeT(1000n, 2000n, 1001n)).toBe(ether("1") - ether("0.001"));
  });
  it("middle", () => {
    expect(computeT(1000n, 2000n, 1500n)).toBe(ether("0.5"));
  });
  it("end", () => {
    expect(computeT(1000n, 2000n, 2000n)).toBe(0n);
  });
  it("past maturity", () => {
    expect(computeT(1000n, 2000n, 2500n)).toBe(0n);
  });
  it("zero duration returns 0", () => {
    expect(computeT(1000n, 1000n, 1000n)).toBe(0n);
  });
  it("almost at end within (0, 0.01)", () => {
    const t = computeT(1000n, 2000n, 1999n);
    expect(t > 0n && t < ether("0.01")).toBe(true);
  });
});

describe("calculateTimeDecayFee (golden vectors from Foundry CalculateTimeDecayFee.t.sol)", () => {
  const fee = (start: bigint, end: bigint, cur: bigint, amt: bigint, base: bigint) =>
    calculateTimeDecayFee(start, end, cur, amt, base);
  it("start of period: 49.95 ether", () => {
    expect(fee(1000n, 2000n, 1001n, ether("1000"), ether("5"))).toBe(ether("49.95"));
  });
  it("middle: 20 ether", () => {
    expect(fee(1000n, 2000n, 1500n, ether("1000"), ether("4"))).toBe(ether("20"));
  });
  it("end / past maturity: 0", () => {
    expect(fee(1000n, 2000n, 2000n, ether("1000"), ether("5"))).toBe(0n);
    expect(fee(1000n, 2000n, 2500n, ether("1000"), ether("5"))).toBe(0n);
  });
  it("zero amount / zero base fee: 0", () => {
    expect(fee(1000n, 2000n, 1500n, 0n, ether("5"))).toBe(0n);
    expect(fee(1000n, 2000n, 1500n, ether("1000"), 0n)).toBe(0n);
  });
  it("ceil rounding: 999 wei @ 1% halfway -> 5 wei", () => {
    expect(fee(1000n, 2000n, 1500n, 999n, ether("1"))).toBe(5n);
  });
});

describe("calculateGrossAmountWithTimeDecayFee (Foundry minimumFee vector)", () => {
  it("100 wei @ feeRate=1 near end -> fee 1 wei", () => {
    const { fee, assetIn } = calculateGrossAmountWithTimeDecayFee(1000n, 2000n, 1999n, 100n, 1n);
    expect(fee).toBe(1n);
    expect(assetIn).toBe(101n);
  });
});

describe("percentage / gross / swap-rate math (formula-exact)", () => {
  it("calculatePercentageFee ceil: 5% of 1000e18 = 50e18", () => {
    expect(calculatePercentageFee(ether("5"), ether("1000"))).toBe(ether("50"));
  });
  it("calculatePercentageFee ceil rounds up", () => {
    // 1% of 99 wei = 0.99 -> ceil 1
    expect(calculatePercentageFee(ether("1"), 99n)).toBe(1n);
  });
  it("calculateGrossAmountBeforeFee: desired 1000e18 @ 5% = ceil(1000e18*100e18/95e18)", () => {
    const expected = mulDiv(ether("1000"), PCT_DENOM, PCT_DENOM - ether("5"), "ceil");
    expect(calculateGrossAmountBeforeFee(ether("1000"), ether("5"))).toBe(expected);
    // gross - desired == fee charged, and gross*(1-fee%) >= desired
    expect(expected).toBeGreaterThan(ether("1000"));
  });
  it("calculateEqualSwapAmount: ref * rate / 1e18 floor", () => {
    expect(calculateEqualSwapAmount(ether("100"), ether("0.8"))).toBe(ether("80"));
  });
  it("calculateDepositAmountWithSwapRate round-up vs round-down differ on remainder", () => {
    // 1 wei * 1e18 / 3e18 = 0.333.. -> floor 0, ceil 1
    expect(calculateDepositAmountWithSwapRate(1n, 3n * WAD, false)).toBe(0n);
    expect(calculateDepositAmountWithSwapRate(1n, 3n * WAD, true)).toBe(1n);
  });
});

describe("decimal normalization (TransferHelper parity)", () => {
  it("6->18 scales up, 18->6 floors down", () => {
    expect(tokenNativeDecimalsToFixed(1_000_000n, 6)).toBe(WAD); // 1.0
    expect(fixedToTokenNativeDecimals(WAD + 999_999_999_999n, 6)).toBe(1_000_000n); // floor
  });
  it("fixedToTokenNativeDecimalsCeil rounds up on truncation", () => {
    expect(fixedToTokenNativeDecimalsCeil(WAD + 1n, 6)).toBe(1_000_001n);
  });
  it("normalizeDecimals identity when equal", () => {
    expect(normalizeDecimals(12345n, 8, 8)).toBe(12345n);
  });
  it("normalizeDecimalsCeil reducing rounds up", () => {
    expect(normalizeDecimalsCeil(1_500_001n, 8, 6)).toBe(15_001n); // /100 ceil
    expect(normalizeDecimals(1_500_001n, 8, 6)).toBe(15_000n); // floor
  });
});
