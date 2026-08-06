// Circuit-breaker state machine, shared by every transport that needs fail-fast memory: the RPC
// resolver (chain/rpc.ts, per-endpoint, disk-persisted) and the venue datasource (datasources/
// venue.ts, per-host, in-memory). ONE implementation on purpose — the comparators here decide
// when a subsystem stops burning timeouts on a dead upstream, and duplicated copies would drift
// out of each other's mutation-probe coverage (the same argument as the transport classifier).
//
// Semantics (identical to the original rpc.ts helpers, extracted verbatim):
//   - `failures` counts CONSECUTIVE failures; any success resets to zero.
//   - The breaker opens when failures reaches `openThreshold`, and every further failure at or
//     above the threshold REFRESHES `openedAt` — a still-failing endpoint keeps its cooldown
//     window sliding instead of half-opening on a fixed schedule.
//   - Open means "opened less than `cooldownMs` ago". At exactly `cooldownMs` the breaker is no
//     longer open (strict `<`): one caller may probe again (half-open); a failure re-opens it.
//
// Pure functions over plain data: callers own where the entries live (a disk-persisted record,
// a module-level map) and when `now` advances — which is what makes the machine unit-testable
// offline and reusable across transports without a shared registry.

export interface BreakerEntry {
  failures: number;
  openedAt: number | null;
}

export interface BreakerPolicy {
  /** Consecutive failures that trip the breaker open. */
  openThreshold: number;
  /** How long the breaker stays open before a half-open retry is allowed. */
  cooldownMs: number;
}

/** Is the breaker open (fail fast, do not attempt) at `now`? */
export function breakerOpen(b: BreakerEntry | undefined, now: number, policy: BreakerPolicy): boolean {
  return b?.openedAt != null && now - b.openedAt < policy.cooldownMs;
}

/** State after a success: consecutive-failure count cleared, breaker closed. */
export function breakerOnSuccess(): BreakerEntry {
  return { failures: 0, openedAt: null };
}

/** State after a failure: count incremented; opens (or refreshes the open window) at threshold. */
export function breakerOnFailure(b: BreakerEntry | undefined, now: number, policy: BreakerPolicy): BreakerEntry {
  const failures = (b?.failures ?? 0) + 1;
  return { failures, openedAt: failures >= policy.openThreshold ? now : (b?.openedAt ?? null) };
}

/** Milliseconds of cooldown remaining (0 when closed or already half-open eligible) — for
 *  diagnostics surfaces; never used to decide admission (that is `breakerOpen`). */
export function breakerRemainingMs(b: BreakerEntry | undefined, now: number, policy: BreakerPolicy): number {
  if (b?.openedAt == null) return 0;
  return Math.max(0, policy.cooldownMs - (now - b.openedAt));
}
