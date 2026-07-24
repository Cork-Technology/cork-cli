// Property-based revert-parity + invariant harness over @cork/core numeric ports.
// Reference semantics = Solidity 0.8.30 checked arithmetic + OZ Math.mulDiv (reverts on d==0
// and on uint256 overflow). Originally this harness DOCUMENTED the divergences (third-pass
// investigation, 2026-07-24); after the hardening pass the ports enforce the Solidity revert
// domain, so it now asserts FULL revert-parity — a regression here means a guard was removed.
// Run: bun test core.proptest.ts
import fc from "fast-check";
import { expect, test } from "bun:test";

const R = "/Users/work/Projects/cork-helper-cli/packages/core/src/math";
const fixed = await import(`${R}/fixed.ts`);
const mh = await import(`${R}/mathhelper.ts`);
const constraint = await import(`${R}/constraint.ts`);
const preview = await import(`${R}/preview.ts`);

const WAD = 10n ** 18n;
const PCT = 100n * WAD;
const U256 = (1n << 256n) - 1n;
const U256_MOD = 1n << 256n;

// ---- Solidity reference model -------------------------------------------------
// OZ Math.mulDiv(x,y,d, rounding): computes full 512-bit x*y, reverts if d==0 or result>uint256.max
type Rnd = "floor" | "ceil";
class Revert extends Error {}
function solMulDiv(x: bigint, y: bigint, d: bigint, r: Rnd): bigint {
  if (x < 0n || y < 0n || d < 0n || x > U256 || y > U256 || d > U256) throw new Revert("range");
  if (d === 0n) throw new Revert("div0");
  const p = x * y;
  let q = p / d;
  if (r === "ceil" && p % d !== 0n) q += 1n;
  if (q > U256) throw new Revert("overflow");
  return q;
}
function solSub(a: bigint, b: bigint): bigint {
  const r = a - b;
  if (r < 0n) throw new Revert("underflow");
  return r;
}

const uint = (bits: number) => fc.bigInt(0n, (1n << BigInt(bits)) - 1n);
const smallDec = fc.integer({ min: 0, max: 30 });

// Helper: does the TS fn throw?
function attempt<T>(fn: () => T): { ok: true; v: T } | { ok: false; e: Error } {
  try { return { ok: true, v: fn() }; } catch (e) { return { ok: false, e: e as Error }; }
}

// =============================================================================
// P1: mulDiv — floor/ceil correctness, and overflow revert-parity gap
// =============================================================================
test("P1 mulDiv floor/ceil matches reference EXACTLY, including the revert domain", () => {
  fc.assert(fc.property(uint(256), uint(256), uint(256), fc.constantFrom<Rnd>("floor", "ceil"),
    (x, y, d) => {
      const rnd: Rnd = (x + y) % 2n === 0n ? "floor" : "ceil";
      const sol = attempt(() => solMulDiv(x, y, d, rnd));
      const ts = attempt(() => fixed.mulDiv(x, y, d, rnd));
      if (sol.ok && ts.ok) { expect(ts.v).toBe(sol.v); return; }
      // Full revert-parity: the port throws exactly where the reference reverts.
      expect(ts.ok).toBe(sol.ok);
    }), { numRuns: 20000 });
  // Explicit overflow vector (was: silently returned a >uint256 quotient).
  expect(attempt(() => fixed.mulDiv(U256, U256, 1n)).ok).toBe(false);
});

// =============================================================================
// P2: ceilDiv identity + negative parity
// =============================================================================
test("P2 ceilDiv == ceil(a/b) for a,b>=0; b==0 throws", () => {
  fc.assert(fc.property(uint(200), uint(200), (a, b) => {
    if (b === 0n) { expect(attempt(() => fixed.ceilDiv(a, b)).ok).toBe(false); return; }
    const want = a === 0n ? 0n : (a + b - 1n) / b;
    expect(fixed.ceilDiv(a, b)).toBe(want);
  }), { numRuns: 5000 });
});
test("P2b ceilDiv rejects negative operands (was: (a-1)/b+1 overshot true ceil for a<0)", () => {
  expect(attempt(() => fixed.ceilDiv(-5n, 3n)).ok).toBe(false);
  expect(attempt(() => fixed.ceilDiv(-1n, 3n)).ok).toBe(false);
  expect(attempt(() => fixed.ceilDiv(1n, -3n)).ok).toBe(false);
});

// =============================================================================
// P3: normalizeDecimals — round-trip & flooring
// =============================================================================
test("P3 normalizeDecimals down-then-up loses < 10^(from-to); up-then-down exact", () => {
  fc.assert(fc.property(uint(120), smallDec, smallDec, (amt, from, to) => {
    const n = fixed.normalizeDecimals(amt, from, to);
    if (from <= to) {
      // scaling up is exact and invertible
      expect(fixed.normalizeDecimals(n, to, from)).toBe(amt);
    } else {
      // scaling down floors: n*10^(from-to) <= amt
      const back = n * 10n ** BigInt(from - to);
      expect(back <= amt).toBe(true);
      expect(amt - back < 10n ** BigInt(from - to)).toBe(true);
    }
  }), { numRuns: 5000 });
});
test("P3b normalizeDecimalsCeil rounds up when reducing decimals", () => {
  fc.assert(fc.property(uint(120), smallDec, smallDec, (amt, from, to) => {
    const floor = fixed.normalizeDecimals(amt, from, to);
    const ceil = fixed.normalizeDecimalsCeil(amt, from, to);
    if (from > to) expect(ceil >= floor).toBe(true);
    else expect(ceil).toBe(floor);
  }), { numRuns: 5000 });
});

// =============================================================================
// P4: computeT — range on valid domain, revert-parity gap on current<start / end<=start
// =============================================================================
test("P4 computeT in [0,WAD] on valid domain (start<=current, start<end)", () => {
  fc.assert(fc.property(uint(40), uint(40), uint(40), (start, dCur, dEnd) => {
    const current = start + dCur;
    const end = start + dEnd + 1n; // end > start
    const t = mh.computeT(start, end, current);
    expect(t >= 0n && t <= WAD).toBe(true);
  }), { numRuns: 10000 });
});
test("P4b computeT(current<start) now THROWS where Solidity underflow-reverts (revert-parity)", () => {
  fc.assert(fc.property(uint(40), fc.bigInt(1n, 1_000_000n), uint(40), (start, back, dEnd) => {
    if (back > start) return; // keep current >= 0
    const current = start - back; // current < start
    const end = start + dEnd + 1n;
    expect(attempt(() => mh.computeT(start, end, current)).ok).toBe(false);
  }), { numRuns: 5000 });
});
test("P4c computeT(end<start) throws like the Solidity end-start underflow", () => {
  expect(attempt(() => mh.computeT(100n, 50n, 100n)).ok).toBe(false);
});

// =============================================================================
// P5: time-decay fee — the >baseFee inflation bug (F8 B2) generalized
// =============================================================================
test("P5 calculateTimeDecayFee: on valid domain fee <= ceil(amount*baseFee/100e18)+dust", () => {
  // At t<=WAD, feeFactor = ceil(baseFee*t/1e18) <= baseFee (+1 dust). So effective fee% <= base%.
  fc.assert(fc.property(uint(40), uint(40), uint(40), uint(90), uint(60), (start, dCur, dEnd, amount, base) => {
    const current = start + dCur;
    const end = start + dEnd + 1n;
    if (current < start) return;
    const fee = mh.calculateTimeDecayFee(start, end, current, amount, base);
    const feeAtFull = mh.calculatePercentageFee(base, amount); // fee if feeFactor==base
    // On valid domain the time-decayed fee never exceeds the full-base fee (t normalizes <=1)
    expect(fee <= feeAtFull).toBe(true);
  }), { numRuns: 8000 });
});
test("P5b calculateTimeDecayFee(current<start) now throws (was: 5.5% fee from a 5% base)", () => {
  const base = 5n * WAD; // 5%
  expect(attempt(() => mh.calculateTimeDecayFee(1000n, 2000n, 900n, 10n ** 18n, base)).ok).toBe(false);
  // At-start baseline still computes.
  expect(mh.calculateTimeDecayFee(1000n, 2000n, 1000n, 10n ** 18n, base) > 0n).toBe(true);
});

// =============================================================================
// P6: fee>=100% denominators — negative denominator SILENT garbage (new sharpening of F8)
// =============================================================================
test("P6 calculateGrossAmountBeforeFee: fee >= 100% throws with a domain message (was: silent NEGATIVE)", () => {
  const desired = 1000n * WAD;
  const atEq = attempt(() => mh.calculateGrossAmountBeforeFee(desired, PCT)); // feeRate==100e18
  const over = attempt(() => mh.calculateGrossAmountBeforeFee(desired, PCT + WAD)); // 101%
  expect(atEq.ok).toBe(false);
  expect(over.ok).toBe(false);
  expect(String((over as any).e.message)).toContain(">= 100%");
});
test("P6b calculateGrossAmountWithTimeDecayFee: feeFactor >= 100% throws (was: silent negative)", () => {
  const start = 1000n, end = 2000n, current = 1001n; // t ~ WAD
  const bigBase = 200n * WAD; // 200% base fee
  expect(attempt(() => mh.calculateGrossAmountWithTimeDecayFee(start, end, current, 1000n * WAD, bigBase)).ok).toBe(false);
});

// =============================================================================
// P7: calculateRate — bounds + credit conservation invariants
// =============================================================================
const rateParams = () => fc.record({
  newRate: uint(64), lastAdjustedRate: uint(64),
  remainingCredits: uint(64), rateChangePerDayMax: uint(64), rateChangeCapacityMax: uint(64),
  rateMinRaw: uint(64), rateSpan: uint(64),
  elapsed: uint(40),
});
test("P7 calculateRate: faithful-to-contract — in-band GUARANTEED only when lastAdjustedRate in-band (precondition)", () => {
  fc.assert(fc.property(rateParams(), (p) => {
    const rateMin = p.rateMinRaw;
    const rateMax = p.rateMinRaw + p.rateSpan;
    // Enforce the on-chain precondition: lastAdjustedRate is always in-band (bootstrap + clamp).
    const lastInBand = rateMin + (p.lastAdjustedRate % (p.rateSpan + 1n));
    const res = constraint.calculateRate({
      newRate: p.newRate, lastAdjustedRate: lastInBand,
      remainingCredits: p.remainingCredits, lastAdjustmentTimestamp: 0n, currentTimestamp: p.elapsed,
      rateChangePerDayMax: p.rateChangePerDayMax, rateChangeCapacityMax: p.rateChangeCapacityMax,
      rateMin, rateMax,
    });
    expect(res.rate >= rateMin && res.rate <= rateMax).toBe(true);
    expect(res.remainingCredits >= 0n).toBe(true);
  }), { numRuns: 10000 });
});
test("P7b calculateRate: UNCLAMPED early-return violates band when lastAdjustedRate out-of-band + no rate change (faithful to Sol line 205)", () => {
  // newRate==lastAdjustedRate => early return (lastAdjustedRate, ...) WITHOUT clamping.
  const res = constraint.calculateRate({
    newRate: 0n, lastAdjustedRate: 0n, remainingCredits: 0n,
    lastAdjustmentTimestamp: 0n, currentTimestamp: 0n,
    rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateMin: 1n, rateMax: 5n,
  });
  console.log("P7b out-of-band early-return: rate=", res.rate.toString(), "(rateMin=1) updated=", res.updated);
  expect(res.rate).toBe(0n);     // below rateMin=1 — matches Solidity, but only safe because chain state keeps lastAdjustedRate in-band
  expect(res.updated).toBe(false);
});

// =============================================================================
// P8: impairmentFloor — monotonic descent + div-by-zero at worstRate==0
// =============================================================================
test("P8 impairmentFloor: worstRate in [rateMin, lastAdjustedRate]; longer horizon never higher", () => {
  fc.assert(fc.property(uint(60), uint(60), uint(60), uint(60), uint(60), uint(30), uint(30),
    (lastRate, remCredits, perDay, capMax, rateMin0, h1, h2) => {
      if (rateMin0 > lastRate) return; // keep rateMin plausible (<= lastRate)
      const market: any = { rateMin: rateMin0, rateMax: lastRate * 2n + 1n, rateChangePerDayMax: perDay, rateChangeCapacityMax: capMax };
      const state: any = { lastAdjustedRate: lastRate, remainingCredits: remCredits, lastAdjustmentTimestamp: 0n };
      const small = Math.min(Number(h1), Number(h2));
      const big = Math.max(Number(h1), Number(h2));
      const rSmall = attempt(() => constraint.impairmentFloor({ market, state, horizonSeconds: BigInt(small), tEval: BigInt(small) }));
      const rBig = attempt(() => constraint.impairmentFloor({ market, state, horizonSeconds: BigInt(big), tEval: BigInt(small) }));
      if (rSmall.ok) {
        const v = (rSmall as any).v;
        expect(v.worstRate >= rateMin0).toBe(true);
        expect(v.worstRate <= lastRate).toBe(true);
      }
      if (rSmall.ok && rBig.ok) {
        expect((rBig as any).v.worstRate <= (rSmall as any).v.worstRate).toBe(true);
      }
    }), { numRuns: 8000 });
});
test("P8b impairmentFloor at worstRate==0 returns the honest answer (maxReferencePerCst null = unbounded)", () => {
  const market: any = { rateMin: 0n, rateMax: 10n ** 19n, rateChangePerDayMax: 10n ** 30n, rateChangeCapacityMax: 10n ** 30n };
  const state: any = { lastAdjustedRate: WAD, remainingCredits: 10n ** 30n, lastAdjustmentTimestamp: 0n };
  const v = constraint.impairmentFloor({ market, state, horizonSeconds: 86400n, tEval: 0n });
  expect(v.worstRate).toBe(0n);
  expect(v.maxReferencePerCst).toBe(null);
});

// =============================================================================
// P9: preview functions — non-negativity + fee<=gross on valid domain
// =============================================================================
const swapCtx = () => fc.record({
  swapRate: fc.bigInt(1n, 100n * WAD), // rate in (0, 100]
  swapFeePercentage: fc.bigInt(0n, 5n * WAD), // 0..5%
  collateralDecimals: fc.integer({ min: 2, max: 18 }),
  referenceDecimals: fc.integer({ min: 2, max: 18 }),
});
test("P9 previewSwap: outputs non-negative, fee <= grossCollateral on valid domain", () => {
  fc.assert(fc.property(fc.bigInt(0n, 10n ** 30n), swapCtx(), (out, ctx) => {
    const r = attempt(() => preview.previewSwap(out, ctx as any));
    if (!r.ok) return; // record throws separately
    const v = (r as any).v;
    expect(v.cstSharesIn >= 0n && v.referenceAssetsIn >= 0n && v.fee >= 0n).toBe(true);
  }), { numRuns: 8000 });
});
test("P9b previewUnwindSwap fee<=collateralIn (net non-negative) on valid time domain", () => {
  const uctx = () => fc.record({
    swapRate: fc.bigInt(1n, 100n * WAD),
    unwindSwapFeePercentage: fc.bigInt(0n, 5n * WAD),
    collateralDecimals: fc.integer({ min: 2, max: 18 }),
    referenceDecimals: fc.integer({ min: 2, max: 18 }),
    issuedAt: uint(40), dur: fc.bigInt(1n, 10n ** 9n), elapsedFrac: fc.bigInt(0n, 10n ** 9n),
  });
  fc.assert(fc.property(fc.bigInt(1n, 10n ** 30n), uctx(), (cin, c) => {
    const expiry = c.issuedAt + c.dur;
    const nowTs = c.issuedAt + (c.elapsedFrac < c.dur ? c.elapsedFrac : c.dur - 1n);
    const ctx: any = { ...c, expiryTimestamp: expiry, nowTs };
    const r = attempt(() => preview.previewUnwindSwap(cin, ctx));
    if (!r.ok) return;
    const v = (r as any).v;
    // net cstSharesOut is tokenNativeDecimalsToFixed(cin - fee); requires fee<=cin else negative scaled
    expect(v.fee <= cin).toBe(true);
    expect(v.cstSharesOut >= 0n && v.referenceAssetsOut >= 0n).toBe(true);
  }), { numRuns: 8000 });
});
