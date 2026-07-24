// Bit-exact ports of OpenZeppelin Math + Cork TransferHelper, in bigint.
// bigint is arbitrary-precision, so intermediate products never overflow the way
// they must be guarded against in Solidity — the rounding must match exactly, and so must the
// REVERT DOMAIN: the Solidity originals take uint256 and revert on d==0 or a quotient above
// uint256.max, so the ports reject negative operands, non-positive denominators, and oversized
// quotients instead of silently returning values the chain could never produce.

export const WAD = 10n ** 18n; // 1e18
export const PCT_DENOM = 100n * WAD; // 100e18 — fee denominator (1e18 = 1%)
export const TARGET_DECIMALS = 18;

const U256_MAX = (1n << 256n) - 1n;

export type Rounding = "floor" | "ceil";

/** OZ Math.mulDiv(x, y, d, rounding). Floor = (x*y)/d; Ceil = floor + (remainder>0?1:0). */
export function mulDiv(x: bigint, y: bigint, d: bigint, rounding: Rounding = "floor"): bigint {
  if (d === 0n) throw new Error("mulDiv: division by zero");
  if (x < 0n || y < 0n || d < 0n) throw new Error("mulDiv: negative operand — the Solidity original is uint256-only and would underflow-revert before reaching this division");
  const p = x * y;
  let q = p / d;
  if (rounding === "ceil" && p % d !== 0n) q += 1n;
  if (q > U256_MAX) throw new Error("mulDiv: quotient exceeds uint256 — the Solidity original reverts here");
  return q;
}

/** OZ Math.ceilDiv(a, b) = a == 0 ? 0 : (a - 1) / b + 1. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("ceilDiv: division by zero");
  if (a < 0n || b < 0n) throw new Error("ceilDiv: negative operand — the Solidity original is uint256-only; the (a-1)/b+1 form does not even compute a true ceiling for a<0");
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** TransferHelper.normalizeDecimals — floor when reducing decimals. */
export function normalizeDecimals(amount: bigint, from: number, to: number): bigint {
  if (from > to) return amount / pow10(from - to);
  if (from < to) return amount * pow10(to - from);
  return amount;
}

/** TransferHelper.normalizeDecimalsWithCeilDiv — ceil when reducing decimals. */
export function normalizeDecimalsCeil(amount: bigint, from: number, to: number): bigint {
  if (from > to) return ceilDiv(amount, pow10(from - to));
  if (from < to) return amount * pow10(to - from);
  return amount;
}

export const tokenNativeDecimalsToFixed = (amount: bigint, decimals: number): bigint =>
  normalizeDecimals(amount, decimals, TARGET_DECIMALS);

export const fixedToTokenNativeDecimals = (amount: bigint, decimals: number): bigint =>
  normalizeDecimals(amount, TARGET_DECIMALS, decimals);

export const fixedToTokenNativeDecimalsCeil = (amount: bigint, decimals: number): bigint =>
  normalizeDecimalsCeil(amount, TARGET_DECIMALS, decimals);
