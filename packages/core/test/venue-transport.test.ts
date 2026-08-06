// Venue TRANSPORT resilience, fully offline: the per-host circuit breaker (shared state machine
// with the RPC resolver — breaker.ts), the single silent GET retry, the POST no-retry rule, and
// 429 Retry-After propagation into the rate-limit envelope. Every test injects its own breaker
// container — the module singleton guards only the REAL network (an injected fetch stub is not a
// network), which is what keeps the rest of the offline suite from polluting shared state.
import { describe, expect, it } from "vitest";
import {
  getPools,
  postLopOrder,
  resetVenueBreaker,
  runTool,
  venueDiagnostics,
  VenueHttpError,
  VENUE_BREAKER_POLICY,
  type VenueBreakerState,
  type VenueDeps,
} from "@cork/core";

const HOST = "api-phoenix.cork.tech";
const okList = () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });

describe("venue per-host circuit breaker", () => {
  it("opens after 3 consecutive transport failures, fails fast while open, half-opens after cooldown", async () => {
    let calls = 0;
    let t = 1_000_000;
    const breaker: VenueBreakerState = { byHost: {} };
    const deps: VenueDeps = {
      fetch: async () => {
        calls++;
        throw new Error("connect ECONNREFUSED");
      },
      now: () => t,
      breaker,
    };
    // Call 1: attempt + one GET retry → failures 1, 2 (below threshold 3).
    await expect(getPools(deps, 1)).rejects.toThrow(/unreachable/);
    expect(calls).toBe(2);
    // Call 2: attempt → failure 3 OPENS the breaker; the retry is skipped (fail-fast wins).
    // The call that OPENS the breaker made a REAL attempt, so it reports the real transport
    // error — not the fail-fast message (that would misattribute an actual network failure to
    // the breaker; without the retry's own breaker re-check, the skipped retry's admission
    // throw would replace the true error).
    await expect(getPools(deps, 1)).rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toBe(3);
    expect(breaker.byHost[HOST]?.failures).toBe(3);
    // Call 3: breaker open → no fetch at all, and the message says when to come back.
    await expect(getPools(deps, 1)).rejects.toThrow(/failing fast/);
    expect(calls).toBe(3);
    // After the cooldown: exactly one half-open attempt (its failure re-opens; no GET retry).
    t += VENUE_BREAKER_POLICY.cooldownMs + 1;
    await expect(getPools(deps, 1)).rejects.toThrow(/unreachable/);
    expect(calls).toBe(4);
  });

  it("a success resets the consecutive-failure count", async () => {
    let calls = 0;
    const breaker: VenueBreakerState = { byHost: { [HOST]: { failures: 2, openedAt: null } } };
    const deps: VenueDeps = { fetch: async () => (calls++, okList()), now: () => 0, breaker };
    await getPools(deps, 1);
    expect(breaker.byHost[HOST]).toEqual({ failures: 0, openedAt: null });
    expect(calls).toBe(1);
  });

  it("an injected fetch WITHOUT an injected breaker neither consults nor pollutes the module singleton", async () => {
    resetVenueBreaker();
    let calls = 0;
    const deps: VenueDeps = {
      fetch: async () => {
        calls++;
        throw new Error("stub down");
      },
    };
    for (let i = 0; i < 3; i++) await expect(getPools(deps, 1)).rejects.toThrow(/unreachable/);
    expect(calls).toBe(6); // 3 calls × (attempt + GET retry) — never fail-fast: no breaker engaged
    expect(venueDiagnostics().breaker).toBeNull(); // singleton untouched
  });
});

describe("GET retry vs POST no-retry", () => {
  it("one silent GET retry heals a single transport blip", async () => {
    let calls = 0;
    const breaker: VenueBreakerState = { byHost: {} };
    const deps: VenueDeps = {
      fetch: async () => {
        calls++;
        if (calls === 1) throw new Error("read ECONNRESET");
        return okList();
      },
      now: () => 0,
      breaker,
    };
    const out = await getPools(deps, 1);
    expect(out.items).toEqual([]);
    expect(calls).toBe(2);
    expect(breaker.byHost[HOST]).toEqual({ failures: 0, openedAt: null }); // the success reset the blip
  });

  it("POST relays are NEVER transport-retried ([K2] retries are the caller's, keyed by clientRequestId)", async () => {
    let calls = 0;
    const deps: VenueDeps = {
      fetch: async () => {
        calls++;
        throw new Error("connect ECONNREFUSED");
      },
      now: () => 0,
      breaker: { byHost: {} },
    };
    await expect(postLopOrder(deps, { any: "payload" })).rejects.toThrow(/unreachable/);
    expect(calls).toBe(1);
  });
});

describe("429 Retry-After propagation", () => {
  const rateLimited = (headers: Record<string, string>) =>
    new Response(JSON.stringify({ message: "slow down" }), { status: 429, headers: { "content-type": "application/json", ...headers } });

  it("delta-seconds Retry-After lands on VenueHttpError", async () => {
    const deps: VenueDeps = { fetch: async () => rateLimited({ "retry-after": "17" }), now: () => 0 };
    const err = await getPools(deps, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VenueHttpError);
    expect((err as VenueHttpError).status).toBe(429);
    expect((err as VenueHttpError).retryAfterSeconds).toBe(17);
  });

  it("HTTP-date Retry-After converts to seconds from the injected clock", async () => {
    const nowMs = Date.parse("2026-08-06T12:00:00Z");
    const deps: VenueDeps = { fetch: async () => rateLimited({ "retry-after": "Thu, 06 Aug 2026 12:00:45 GMT" }), now: () => nowMs };
    const err = await getPools(deps, 1).catch((e: unknown) => e);
    expect((err as VenueHttpError).retryAfterSeconds).toBe(45);
  });

  it("a venue-read 429 maps to venue_rate_limited (not venue_rejected) with the wait surfaced — full runTool path", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "orderbook", chainId: 1 },
      { venueFetch: async () => rateLimited({ "retry-after": "17" }) },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("venue_rate_limited");
    expect(env.warnings[0]!.message).toContain("retry after 17s");
  });
});
