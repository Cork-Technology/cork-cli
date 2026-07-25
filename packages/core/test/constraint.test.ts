import { describe, expect, it } from "vitest";
import {
  calculateRate,
  creditsRefilled,
  impairmentFloor,
  previewAdjustedRate,
  refillRatePerSecond,
} from "@cork/core";
import type { ConstraintState, Market } from "@cork/core";

const WAD = 10n ** 18n;
const DAY = 86400n;

// BaseTest AdjustedRateTests config: min 0.9, max 1.1, perDay 0.1, capacity 0.1.
// Bootstrap: lastAdjustedRate = 1e18, remainingCredits = capacity, ts = 1.
const CFG = {
  rateMin: (9n * WAD) / 10n,
  rateMax: (11n * WAD) / 10n,
  perDay: WAD / 10n,
  capacity: WAD / 10n,
};
const base = (over: Partial<Parameters<typeof calculateRate>[0]> = {}) => ({
  newRate: WAD,
  lastAdjustedRate: WAD,
  remainingCredits: CFG.capacity,
  lastAdjustmentTimestamp: 1n,
  currentTimestamp: 1n,
  rateChangePerDayMax: CFG.perDay,
  rateChangeCapacityMax: CFG.capacity,
  rateMin: CFG.rateMin,
  rateMax: CFG.rateMax,
  ...over,
});

describe("refill primitives (independent Python ground-truth)", () => {
  it("refillRatePerSecond(0.1e18/day) floors", () => {
    expect(refillRatePerSecond(CFG.perDay)).toBe(1157407407407407407407407407407n);
  });
  it("creditsRefilled over 1 day double-floors below 0.1e18", () => {
    expect(creditsRefilled(DAY, CFG.perDay)).toBe(99999999999999999n);
  });
});

describe("calculateRate — single-step golden vectors (elapsed=0)", () => {
  it("A exceed-up: clamps by credits to 1.1e18, remaining 0", () => {
    const r = calculateRate(base({ newRate: 2n * WAD }));
    expect(r.rate).toBe((11n * WAD) / 10n);
    expect(r.remainingCredits).toBe(0n);
    expect(r.updated).toBe(true);
  });
  it("B within-limit up: 1.0005e18, remaining 0.0995e18", () => {
    const r = calculateRate(base({ newRate: 10005n * (WAD / 10000n) }));
    expect(r.rate).toBe(1000500000000000000n);
    expect(r.remainingCredits).toBe(99500000000000000n);
  });
  it("C oracle below rateMin clamps to rateMin, remaining 0", () => {
    const r = calculateRate(base({ newRate: (8n * WAD) / 10n }));
    expect(r.rate).toBe(CFG.rateMin);
    expect(r.remainingCredits).toBe(0n);
  });
  it("C' credits let the move overshoot rateMin, so the hard clamp (not capping) pins it", () => {
    // Mirror of D': incoming -0.5 fully consumed -> pre-clamp rate 0.5e18, below rateMin 0.9e18,
    // so the `rate < rateMin` clamp fires (distinct from C's credit-cap landing exactly on rateMin).
    const r = calculateRate(base({ newRate: 5n * (WAD / 10n), rateChangeCapacityMax: WAD, remainingCredits: WAD }));
    expect(r.rate).toBe(CFG.rateMin);
    expect(r.remainingCredits).toBe(WAD - WAD / 10n); // creditsCapped(1.0) - actualChange(0.1)
    expect(r.updated).toBe(true);
  });
  it("D oracle above rateMax clamps to rateMax, remaining 0", () => {
    const r = calculateRate(base({ newRate: (12n * WAD) / 10n }));
    expect(r.rate).toBe(CFG.rateMax);
    expect(r.remainingCredits).toBe(0n);
  });
  it("D' credits let the move overshoot rateMax, so the hard clamp (not capping) pins it", () => {
    // Generous capacity + credits: incoming 0.5 is fully consumed -> pre-clamp rate 1.5e18,
    // above rateMax 1.1e18, so the `rate > rateMax` clamp fires (distinct from D's credit-cap).
    const r = calculateRate(base({ newRate: 15n * (WAD / 10n), rateChangeCapacityMax: WAD, remainingCredits: WAD }));
    expect(r.rate).toBe(CFG.rateMax);
    expect(r.remainingCredits).toBe(WAD - WAD / 10n); // creditsCapped(1.0) - actualChange(0.1)
    expect(r.updated).toBe(true);
  });
  it("E downward within limit: 0.9995e18", () => {
    const r = calculateRate(base({ newRate: 9995n * (WAD / 10000n) }));
    expect(r.rate).toBe(999500000000000000n);
    expect(r.remainingCredits).toBe(99500000000000000n);
  });
  it("F same rate: unchanged, not updated", () => {
    const r = calculateRate(base({ newRate: WAD }));
    expect(r.rate).toBe(WAD);
    expect(r.remainingCredits).toBe(CFG.capacity);
    expect(r.updated).toBe(false);
  });
});

describe("calculateRate — multi-step refill (matches Foundry AdjustedRate 1.001e18 assertion)", () => {
  it("exhaust up, wait a day, small down, then partial up -> 1.001e18", () => {
    // s1: oracle 2e18 @ ts1 -> 1.1e18, remaining 0
    const s1 = calculateRate(base({ newRate: 2n * WAD }));
    expect([s1.rate, s1.remainingCredits]).toEqual([(11n * WAD) / 10n, 0n]);
    // s2: oracle 1e18, +1 day
    const s2 = calculateRate(
      base({ newRate: WAD, lastAdjustedRate: s1.rate, remainingCredits: s1.remainingCredits, currentTimestamp: 1n + DAY }),
    );
    expect(s2.rate).toBe(1000000000000000001n);
    // s3: oracle 1.1e18, +1 day/100 later
    const s3 = calculateRate(
      base({
        newRate: (11n * WAD) / 10n,
        lastAdjustedRate: s2.rate,
        remainingCredits: s2.remainingCredits,
        lastAdjustmentTimestamp: 1n + DAY,
        currentTimestamp: 1n + DAY + DAY / 100n,
      }),
    );
    expect(s3.rate).toBe(1001000000000000000n); // == 1.001 ether, matches on-chain test
  });
});

const mkt = (over: Partial<Market> = {}): Market => ({
  collateralAsset: "0x0000000000000000000000000000000000000001",
  referenceAsset: "0x0000000000000000000000000000000000000002",
  expiryTimestamp: 10n ** 12n,
  rateMin: CFG.rateMin,
  rateMax: CFG.rateMax,
  rateChangePerDayMax: CFG.perDay,
  rateChangeCapacityMax: CFG.capacity,
  rateOracle: "0x0000000000000000000000000000000000000003",
  ...over,
});

describe("previewAdjustedRate wraps calculateRate", () => {
  it("returns oracle rate within limits", () => {
    const state: ConstraintState = { lastAdjustedRate: WAD, lastAdjustmentTimestamp: 1n, remainingCredits: CFG.capacity };
    expect(previewAdjustedRate({ market: mkt(), state, oracleRate: 1000500000000000000n, nowTs: 1n })).toBe(
      1000500000000000000n,
    );
  });
  it("oracle 0 -> rateMin (never below floor)", () => {
    const state: ConstraintState = { lastAdjustedRate: WAD, lastAdjustmentTimestamp: 1n, remainingCredits: CFG.capacity };
    expect(previewAdjustedRate({ market: mkt(), state, oracleRate: 0n, nowTs: 1n })).toBe(CFG.rateMin);
  });
});

describe("impairmentFloor — committed-descent (verified <= brute-force adversary)", () => {
  // Live vnet fixture pool config: min 0.5, max 1.0, perDay 1e15, capacity 7e15, last 0.8e18, rem 7e15.
  const F = {
    rateMin: 5n * 10n ** 17n,
    rateMax: WAD,
    perDay: 10n ** 15n,
    capacity: 7n * 10n ** 15n,
    lastAdjustedRate: 8n * 10n ** 17n,
    remainingCredits: 7n * 10n ** 15n,
  };
  const fMarket = mkt({
    rateMin: F.rateMin,
    rateMax: F.rateMax,
    rateChangePerDayMax: F.perDay,
    rateChangeCapacityMax: F.capacity,
  });
  const fState: ConstraintState = {
    lastAdjustedRate: F.lastAdjustedRate,
    lastAdjustmentTimestamp: 1n,
    remainingCredits: F.remainingCredits,
  };

  it("horizon 0: floor = last - available = 0.793e18", () => {
    const r = impairmentFloor({ market: fMarket, state: fState, horizonSeconds: 0n, tEval: 1n });
    expect(r.worstRate).toBe(793000000000000000n);
    expect(r.maxReferencePerCst).toBe(1261034047919293821n); // independent ceil(1e18/0.793e18)
    expect(r.clampedAtMin).toBe(false);
  });

  it("very long horizon pins the floor at rateMin (descent exceeds the last rate), maxRef = 2e18", () => {
    // 2000 days of refill > lastAdjustedRate (0.8e18), so floorFromLast bottoms at 0 and the
    // worst case is rateMin regardless — the extreme-horizon invariant.
    const r = impairmentFloor({ market: fMarket, state: fState, horizonSeconds: 2000n * DAY, tEval: 1n });
    expect(r.worstRate).toBe(F.rateMin);
    expect(r.maxReferencePerCst).toBe(2000000000000000000n);
    expect(r.clampedAtMin).toBe(true);
  });

  it("never exceeds brute-force adversary minimum (Python-derived golden)", () => {
    // {horizonSeconds: brute-force reachable min} from independent adversary simulation.
    const brute: Array<[bigint, bigint]> = [
      [0n, 793000000000000000n],
      [3600n, 792958333333333600n],
      [DAY, 792000150462963335n],
      [2592000n, 763000000000002000n],
      [34560000n, 500000000000000000n],
    ];
    for (const [h, bf] of brute) {
      const cf = impairmentFloor({ market: fMarket, state: fState, horizonSeconds: h, tEval: 1n }).worstRate;
      expect(cf <= bf).toBe(true); // conservative-safe: floor never optimistic vs a real adversary
    }
  });

  it("rateMin 0 + full descent → worstRate 0 and maxReferencePerCst NULL (unbounded, never a div-by-zero)", () => {
    // createNewPool enforces rateMin > 0, but a recipe/library caller can construct rateMin = 0.
    // When the reachable floor collapses to 0 the ref-per-cST cost is unbounded — the honest
    // answer is `null`, not a thrown division-by-zero deep in the port.
    const market = mkt({ rateMin: 0n, rateMax: WAD, rateChangePerDayMax: 10n ** 15n, rateChangeCapacityMax: WAD });
    const state: ConstraintState = { lastAdjustedRate: 8n * 10n ** 17n, lastAdjustmentTimestamp: 1n, remainingCredits: WAD };
    const r = impairmentFloor({ market, state, horizonSeconds: 2000n * DAY, tEval: 1n });
    expect(r.worstRate).toBe(0n);
    expect(r.maxReferencePerCst).toBeNull();
    expect(r.clampedAtMin).toBe(true); // worstRate === rateMin === 0
  });
});
