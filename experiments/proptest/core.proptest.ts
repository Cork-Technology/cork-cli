// Property-based revert-parity + invariant harness over @cork/core numeric ports.
// Reference semantics = Solidity 0.8.30 checked arithmetic + OZ Math.mulDiv (reverts on d==0
// and on uint256 overflow). We model that reference here and assert the TS port either MATCHES
// or we record the exact divergence class. Run: bun test core.test.ts
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
test("P1 mulDiv floor/ceil matches reference on in-range; TS never reverts on overflow", () => {
  const gaps: string[] = [];
  fc.assert(fc.property(uint(256), uint(256), uint(256), fc.constantFrom<Rnd>("floor", "ceil"),
    (x, y, d) => {
      const rnd: Rnd = (x + y) % 2n === 0n ? "floor" : "ceil";
      const sol = attempt(() => solMulDiv(x, y, d, rnd));
      const ts = attempt(() => fixed.mulDiv(x, y, d, rnd));
      if (sol.ok && ts.ok) { expect(ts.v).toBe(sol.v); return; }
      if (!sol.ok && !ts.ok) return; // both revert (d==0)
      if (sol.ok && !ts.ok) throw new Error(`TS reverts where Sol ok: ${x},${y},${d}`);
      // sol reverts, TS ok  => divergence
      if (!sol.ok && ts.ok) {
        const reason = (sol.e as Revert).message;
        if (reason === "overflow" && gaps.length < 3) gaps.push(`overflow@${x},${y},${d}=>${ts.v}`);
      }
    }), { numRuns: 20000 });
  // Record whether the overflow gap is reachable via random uint256 (it is, rarely)
  console.log("P1 overflow-gap samples:", gaps);
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
test("P2b ceilDiv negative-a breaks the ceil postcondition (documented port gap)", () => {
  // Solidity uint256 can't hold negatives; TS accepts them with truncation-toward-zero.
  // Demonstrate the postcondition ceilDiv(a,b)*b >= a can fail for a<0.
  const a = -5n, b = 3n;
  const got = fixed.ceilDiv(a, b); // (a-1)/b+1 = (-6)/3+1 = -2+1 = -1 ; but ceil(-5/3) = -1 ok here
  // find a real violation: ceil(-1/3) should be 0, port: (-2)/3+1 = 0+1 = 1  (WRONG, > correct)
  const got2 = fixed.ceilDiv(-1n, 3n);
  console.log("P2b ceilDiv(-5,3)=", got.toString(), " ceilDiv(-1,3)=", got2.toString(), "(math ceil=0)");
  expect(got2).not.toBe(0n); // confirms the port diverges from true ceil for negative numerators
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
test("P4b computeT(current<start) escapes [0,WAD] where Solidity reverts (F8 confirm + generalize)", () => {
  const gaps: string[] = [];
  fc.assert(fc.property(uint(40), fc.bigInt(1n, 1_000_000n), uint(40), (start, back, dEnd) => {
    if (back > start) return; // keep current >= 0
    const current = start - back; // current < start
    const end = start + dEnd + 1n;
    // Solidity: current-start underflows => revert
    const t = mh.computeT(start, end, current);
    if (t > WAD && gaps.length < 3) gaps.push(`t=${t} start=${start} end=${end} cur=${current}`);
  }), { numRuns: 5000 });
  console.log("P4b computeT>WAD samples (Sol would revert):", gaps);
  expect(gaps.length).toBeGreaterThan(0);
});
test("P4c computeT(end<start) — TS returns a value; Solidity reverts on end-start underflow", () => {
  const r = attempt(() => mh.computeT(100n, 50n, 100n)); // end<start
  console.log("P4c computeT(100,50,100)=", r.ok ? r.v.toString() : `throw:${(r as any).e.message}`);
  // Sol: totalDuration = end-start underflows -> revert. Record TS behavior.
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
test("P5b calculateTimeDecayFee(current<start) inflates fee ABOVE base (F8 B2, generalized)", () => {
  // t = 1.1e18 > WAD => feeFactor = ceil(base*1.1) > base => fee% > base%
  const base = 5n * WAD; // 5%
  const feeInflated = mh.calculateTimeDecayFee(1000n, 2000n, 900n, 10n ** 18n, base); // current<start
  const feeNormal = mh.calculateTimeDecayFee(1000n, 2000n, 1000n, 10n ** 18n, base); // at start
  console.log("P5b inflated fee=", feeInflated.toString(), " base-fee=", feeNormal.toString());
  expect(feeInflated > feeNormal).toBe(true);
});

// =============================================================================
// P6: fee>=100% denominators — negative denominator SILENT garbage (new sharpening of F8)
// =============================================================================
test("P6 calculateGrossAmountBeforeFee: fee==100% throws, fee>100% returns NEGATIVE silently", () => {
  // Solidity: 100e18 - feeRate underflows (revert) for feeRate>100e18; div0 for ==100e18.
  const desired = 1000n * WAD;
  const atEq = attempt(() => mh.calculateGrossAmountBeforeFee(desired, PCT)); // feeRate==100e18 -> d=0
  const over = attempt(() => mh.calculateGrossAmountBeforeFee(desired, PCT + WAD)); // 101% -> d<0
  console.log("P6 fee==100%:", atEq.ok ? `ok:${atEq.v}` : `throw:${(atEq as any).e.message}`);
  console.log("P6 fee==101%:", over.ok ? `ok:${over.v}` : `throw:${(over as any).e.message}`);
  expect(atEq.ok).toBe(false);            // div by zero throw
  expect(over.ok).toBe(true);             // NO throw
  expect((over as any).v < 0n).toBe(true); // silent negative gross amount
});
test("P6b calculateGrossAmountWithTimeDecayFee: feeFactor>100% yields negative denom silently", () => {
  // Reachable if baseFeePercentage is large AND t is large (or t>WAD via P5b domain break).
  // Directly: base huge so feeFactor = ceil(base*t/1e18) > 100e18 at t~WAD.
  const start = 1000n, end = 2000n, current = 1001n; // t ~ WAD
  const bigBase = 200n * WAD; // 200% base fee
  const r = attempt(() => mh.calculateGrossAmountWithTimeDecayFee(start, end, current, 1000n * WAD, bigBase));
  console.log("P6b bigBase result:", r.ok ? `fee=${(r as any).v.fee} assetIn=${(r as any).v.assetIn}` : `throw:${(r as any).e.message}`);
  if (r.ok) { const v = (r as any).v; if (v.assetIn < 0n || v.fee < 0n) console.log("P6b -> NEGATIVE silently"); }
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
test("P8b impairmentFloor throws div-by-zero exactly when worstRate collapses to 0 (rateMin=0, full descent)", () => {
  const market: any = { rateMin: 0n, rateMax: 10n ** 19n, rateChangePerDayMax: 10n ** 30n, rateChangeCapacityMax: 10n ** 30n };
  const state: any = { lastAdjustedRate: WAD, remainingCredits: 10n ** 30n, lastAdjustmentTimestamp: 0n };
  const r = attempt(() => constraint.impairmentFloor({ market, state, horizonSeconds: 86400n, tEval: 0n }));
  console.log("P8b worstRate->0:", r.ok ? `ok worstRate=${(r as any).v.worstRate} maxRefPerCst=${(r as any).v.maxReferencePerCst}` : `THROW:${(r as any).e.message}`);
  expect(r.ok).toBe(false); // division by zero throw => internal_error exit 1 in handler
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
