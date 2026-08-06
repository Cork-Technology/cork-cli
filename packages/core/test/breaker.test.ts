// The shared circuit-breaker state machine (breaker.ts) — the comparators here decide when the
// RPC resolver and the venue transport stop burning timeouts on a dead upstream, so the
// boundaries are pinned exactly (and mutation-probed: breaker-threshold-boundary /
// breaker-cooldown-boundary in scripts/mutation-probes.ts).
import { describe, expect, it } from "vitest";
import { breakerOnFailure, breakerOnSuccess, breakerOpen, breakerRemainingMs, type BreakerEntry, type BreakerPolicy } from "@cork/core";

const P: BreakerPolicy = { openThreshold: 3, cooldownMs: 30_000 };
const T0 = 1_000_000;

function fail(times: number, b?: BreakerEntry, at: number = T0): BreakerEntry {
  let e = b;
  for (let i = 0; i < times; i++) e = breakerOnFailure(e, at, P);
  return e!;
}

describe("breaker threshold boundary", () => {
  it("stays closed strictly below openThreshold and opens exactly AT it", () => {
    const two = fail(2);
    expect(two.failures).toBe(2);
    expect(two.openedAt).toBeNull();
    expect(breakerOpen(two, T0, P)).toBe(false);

    const three = breakerOnFailure(two, T0, P); // failure #3 == threshold → opens NOW
    expect(three.openedAt).toBe(T0);
    expect(breakerOpen(three, T0, P)).toBe(true);
  });

  it("failures at/above threshold REFRESH the open window (a still-failing upstream never half-opens on schedule)", () => {
    const opened = fail(3, undefined, T0);
    const later = breakerOnFailure(opened, T0 + 25_000, P); // failure #4, 25s into the cooldown
    expect(later.openedAt).toBe(T0 + 25_000); // window slides
    expect(breakerOpen(later, T0 + 30_000 + 1, P)).toBe(true); // old window would have lapsed; refreshed one has not
  });

  it("undefined entry (never seen) is closed and counts from zero", () => {
    expect(breakerOpen(undefined, T0, P)).toBe(false);
    expect(breakerOnFailure(undefined, T0, P)).toEqual({ failures: 1, openedAt: null });
  });
});

describe("breaker cooldown boundary", () => {
  it("open strictly INSIDE the cooldown; half-open eligible exactly AT cooldownMs", () => {
    const b: BreakerEntry = { failures: 3, openedAt: T0 };
    expect(breakerOpen(b, T0 + P.cooldownMs - 1, P)).toBe(true);
    expect(breakerOpen(b, T0 + P.cooldownMs, P)).toBe(false); // strict <: the half-open probe is allowed at the boundary
  });

  it("remainingMs counts down to zero and never goes negative", () => {
    const b: BreakerEntry = { failures: 3, openedAt: T0 };
    expect(breakerRemainingMs(b, T0, P)).toBe(P.cooldownMs);
    expect(breakerRemainingMs(b, T0 + 10_000, P)).toBe(P.cooldownMs - 10_000);
    expect(breakerRemainingMs(b, T0 + P.cooldownMs + 5, P)).toBe(0);
    expect(breakerRemainingMs(undefined, T0, P)).toBe(0);
  });
});

describe("breaker success reset", () => {
  it("one success closes the breaker and clears the consecutive-failure count", () => {
    expect(breakerOnSuccess()).toEqual({ failures: 0, openedAt: null });
    // consecutive semantics: 2 failures + success + 2 failures never opens (threshold 3)
    let b = fail(2);
    b = breakerOnSuccess();
    b = fail(2, b);
    expect(b.openedAt).toBeNull();
  });
});
