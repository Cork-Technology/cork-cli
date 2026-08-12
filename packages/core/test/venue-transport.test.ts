// Venue TRANSPORT resilience, fully offline: the per-host circuit breaker (shared state machine
// with the RPC resolver — breaker.ts), the single silent GET retry, the POST no-retry rule, and
// 429 Retry-After propagation into the rate-limit envelope. Every test injects its own breaker
// container — the module singleton guards only the REAL network (an injected fetch stub is not a
// network), which is what keeps the rest of the offline suite from polluting shared state.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VENUE_URL,
  getLopFills,
  getLopMarkets,
  getLopOrderbook,
  getPools,
  getRfq,
  getRfqs,
  getRolloverContracts,
  getRolloverFills,
  getRolloverOrder,
  getRolloverOrders,
  postLopOrder,
  postRfq,
  postRfqAnswer,
  postRfqCounter,
  postRolloverOrder,
  resetVenueBreaker,
  runTool,
  venueBaseUrl,
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

describe("module-scoped routing (cork-api 0.3.3): base normalization + canonical literals", () => {
  const seenUrl = (capture: string[]): VenueDeps => ({
    fetch: async (url: string) => (capture.push(url), okList()),
    breaker: null,
  });

  it("DEFAULT_VENUE_URL is the bare origin — the version moved into the module paths", () => {
    expect(DEFAULT_VENUE_URL).toBe("https://api-phoenix.cork.tech");
    expect(venueBaseUrl()).toBe("https://api-phoenix.cork.tech");
  });

  it("normalizes a configured base still carrying the retired base-versioned form", () => {
    // The pre-0.3.3 convention (version in the base) composes with module-versioned literals
    // into /v1/<module>/v1/… — a path no form of the API ever served. One trailing /v<n>
    // segment strips, with or without a trailing slash.
    expect(venueBaseUrl("https://api-phoenix.cork.tech/v1")).toBe("https://api-phoenix.cork.tech");
    expect(venueBaseUrl("https://api-phoenix.cork.tech/v1/")).toBe("https://api-phoenix.cork.tech");
    expect(venueBaseUrl("https://api-phoenix.cork.tech/v2")).toBe("https://api-phoenix.cork.tech");
    expect(venueBaseUrl("https://proxy.example/venue/")).toBe("https://proxy.example/venue");
    // Only a trailing VERSION segment strips — a path that merely contains "v1" is untouched.
    expect(venueBaseUrl("https://proxy.example/v1proxy")).toBe("https://proxy.example/v1proxy");
    expect(venueBaseUrl("https://proxy.example/v1/venue")).toBe("https://proxy.example/v1/venue");
  });

  it("composes canonical module-versioned paths (exact URLs — literal rot dies here)", async () => {
    const urls: string[] = [];
    await getPools(seenUrl(urls), 42161);
    await getLopOrderbook(seenUrl(urls), { chainId: 42161 });
    await getLopFills(seenUrl(urls), { chainId: 42161 });
    await getLopMarkets(seenUrl(urls), 42161);
    await getRolloverOrders(seenUrl(urls), { chainId: 42161 });
    await getRolloverFills(seenUrl(urls), { chainId: 42161 });
    await getRolloverContracts(seenUrl(urls), { chainId: 42161 });
    await getRfqs(seenUrl(urls), { chainId: 42161 });
    await getRfq(seenUrl(urls), "rfq_x");
    await getRolloverOrder(seenUrl(urls), "0xdigest");
    expect(urls).toEqual([
      "https://api-phoenix.cork.tech/pools/v1?chainId=42161",
      "https://api-phoenix.cork.tech/limit-orders/v1/orderbook?chainId=42161",
      "https://api-phoenix.cork.tech/limit-orders/v1/fills?chainId=42161",
      "https://api-phoenix.cork.tech/limit-orders/v1/markets?chainId=42161",
      "https://api-phoenix.cork.tech/rollover/v1/orders?chainId=42161",
      "https://api-phoenix.cork.tech/rollover/v1/fills?chainId=42161",
      "https://api-phoenix.cork.tech/rollover/v1/contracts?chainId=42161",
      "https://api-phoenix.cork.tech/rfqs/v1?chain_id=42161",
      "https://api-phoenix.cork.tech/rfqs/v1/rfq_x",
      "https://api-phoenix.cork.tech/rollover/v1/orders/0xdigest",
    ]);
  });

  it("POST paths are canonical too", async () => {
    const urls: string[] = [];
    const deps: VenueDeps = { fetch: async (url: string) => (urls.push(url), new Response("{}", { status: 201 })), breaker: null };
    await postLopOrder(deps, {});
    await postRolloverOrder(deps, {});
    await postRfq(deps, {});
    await postRfqAnswer(deps, "rfq_x", {});
    await postRfqCounter(deps, "rfq_x", {});
    expect(urls).toEqual([
      "https://api-phoenix.cork.tech/limit-orders/v1",
      "https://api-phoenix.cork.tech/rollover/v1/orders",
      "https://api-phoenix.cork.tech/rfqs/v1",
      "https://api-phoenix.cork.tech/rfqs/v1/rfq_x/answers",
      "https://api-phoenix.cork.tech/rfqs/v1/rfq_x/counters",
    ]);
  });
});

describe("shim telemetry (Deprecation: true) + in-band venue warnings[]", () => {
  const shimHeaders = { "content-type": "application/json", deprecation: "true", "x-cork-canonical-path": "/limit-orders/v1/orderbook?chainId=1" };

  it("a GET served by the deprecated-path rewrite carries deprecatedPath; a canonical answer does not", async () => {
    const shimmed: VenueDeps = { fetch: async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: shimHeaders }), breaker: null };
    expect((await getLopOrderbook(shimmed, { chainId: 1 })).deprecatedPath).toBe("/limit-orders/v1/orderbook?chainId=1");
    expect((await getLopOrderbook({ fetch: async () => okList(), breaker: null }, { chainId: 1 })).deprecatedPath).toBeUndefined();
  });

  it("a POST served by the rewrite carries deprecatedPath on the post result", async () => {
    const deps: VenueDeps = { fetch: async () => new Response("{}", { status: 201, headers: shimHeaders }), breaker: null };
    expect((await postLopOrder(deps, {})).deprecatedPath).toBe("/limit-orders/v1/orderbook?chainId=1");
  });

  it("body warnings[] ride through as venueWarnings, verbatim; absent/empty stays omitted", async () => {
    const notice = { code: "limit-orders-premium-pct-deprecated", message: "`premium` is removed 2026-08-17", deprecates: "premium", effectiveAt: "2026-08-17" };
    const deps: VenueDeps = { fetch: async () => new Response(JSON.stringify({ items: [], warnings: [notice] }), { status: 200, headers: { "content-type": "application/json" } }), breaker: null };
    expect((await getLopOrderbook(deps, { chainId: 1 })).venueWarnings).toEqual([notice]);
    const empty: VenueDeps = { fetch: async () => new Response(JSON.stringify({ items: [], warnings: [] }), { status: 200 }), breaker: null };
    expect((await getLopOrderbook(empty, { chainId: 1 })).venueWarnings).toBeUndefined();
  });

  it("cork_query surfaces both as info warnings on an ok result — deduped across pages", async () => {
    const notice = { code: "limit-orders-premium-pct-deprecated", message: "removed 2026-08-17" };
    let page = 0;
    const ctx = {
      nowSeconds: 0n,
      venueFetch: async () => {
        page += 1;
        return new Response(
          JSON.stringify({ items: [{ orderHash: `0x${page}` }], warnings: [notice], hasMore: page < 2, nextCursor: page < 2 ? "c2" : undefined }),
          { status: 200, headers: shimHeaders },
        );
      },
    } as never;
    const env = await runTool("cork_query", { resource: "orderbook", chainId: 1 }, ctx);
    expect(env.state).toBe("ok");
    const codes = env.warnings.map((w: { code: string }) => w.code);
    expect(codes.filter((c: string) => c === "venue_notice")).toHaveLength(1); // deduped across 2 pages
    expect(codes).toContain("venue_deprecated_path");
    const noticeWarning = env.warnings.find((w: { code: string }) => w.code === "venue_notice")!;
    expect(noticeWarning.message).toContain("limit-orders-premium-pct-deprecated");
    expect(noticeWarning.message).toContain("removed 2026-08-17");
  });
});

describe("normalization observability on /readyz diagnostics", () => {
  it("a version-suffixed override is visible as the stripped suffix only — never the URL itself", () => {
    const prior = process.env.CORK_VENUE_URL;
    try {
      process.env.CORK_VENUE_URL = "https://gateway.example/private-mount/v1";
      const d = venueDiagnostics(0);
      expect(d.normalizedVersionSuffix).toBe("/v1");
      expect(JSON.stringify(d)).not.toContain("private-mount"); // host only, no path echo
      process.env.CORK_VENUE_URL = "https://api-phoenix.cork.tech";
      expect(venueDiagnostics(0).normalizedVersionSuffix).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.CORK_VENUE_URL;
      else process.env.CORK_VENUE_URL = prior;
    }
  });
});
