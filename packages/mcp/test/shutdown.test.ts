// How the hosted server stops with analytics on (packages/mcp/src/lib/shutdown.ts, wired in
// packages/cli/src/bin.ts): SIGTERM flushes concurrently with the drain, a crash closes the
// listener before its bounded flush, and the crash path is held to 2 s whatever PostHog does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAnalyticsForTests, scrubEvent } from "../src/lib/analytics.ts";
import { analyticsFromEnv } from "../src/lib/mcp-analytics.ts";
import { PostHogHttpSink } from "../src/lib/posthog-http.ts";
import { boundedFatal, FATAL_FLUSH_MS, fatalStop, gracefulStop } from "../src/lib/shutdown.ts";

function recordingAnalytics(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
  resetAnalyticsForTests();
  const posts: Array<{ url: string; events: string[] }> = [];
  const doFetch =
    fetchImpl ??
    (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { batch?: Array<{ event: string }> };
      posts.push({ url, events: (body.batch ?? []).map((e) => e.event) });
      return new Response("{}");
    });
  const sink = new PostHogHttpSink("phc_test", { host: "https://eu.i.posthog.com", flushInterval: 0, fetch: doFetch, before_send: (e) => scrubEvent(e), warn: () => undefined });
  const { analytics } = analyticsFromEnv({ CORK_MCP_ANALYTICS: "1", POSTHOG_KEY: "phc_test", POSTHOG_LOGS: "false" }, { sink, warn: () => undefined });
  if (!analytics) throw new Error("analytics did not start");
  return { analytics, posts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SIGTERM: the flush does not wait for the drain", () => {
  it("queued events are sent while a slow in-flight call still holds server.stop()", async () => {
    const { analytics, posts } = recordingAnalytics();
    analytics.initialize({});
    let releaseDrain!: () => void;
    const server = { stop: vi.fn(() => new Promise<void>((resolve) => (releaseDrain = resolve))) };
    const stopping = gracefulStop(server, analytics);
    await vi.waitFor(() => expect(posts.flatMap((p) => p.events)).toEqual(["$mcp_initialize"]));
    expect(server.stop).toHaveBeenCalledWith();
    // The drained call records its event; the shutdown after the drain sends it.
    analytics.toolCall({ tool: "cork_query", durationMs: 1, state: "ok", isError: false }, {});
    releaseDrain();
    await stopping;
    expect(posts.flatMap((p) => p.events)).toEqual(["$mcp_initialize", "$mcp_tool_call"]);
  });

  it("without analytics it is just the drain", async () => {
    const server = { stop: vi.fn(async () => undefined) };
    await gracefulStop(server);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });
});

describe("a crash: stop the listener, then a bounded flush", () => {
  it("closes the listener and its connections first, captures the exception, flushes", async () => {
    const order: string[] = [];
    const { analytics, posts } = recordingAnalytics();
    const server = { stop: vi.fn(async (closeActive?: boolean) => void order.push(`stop(${String(closeActive)})`)) };
    const flush = analytics.shutdown.bind(analytics);
    vi.spyOn(analytics, "shutdown").mockImplementation(async () => {
      order.push("flush");
      await flush();
    });
    await fatalStop(server, analytics, new TypeError("boom"));
    expect(order).toEqual(["stop(true)", "flush"]);
    expect(posts.flatMap((p) => p.events)).toEqual(["$exception"]);
  });

  it("a server whose stop never settles does not delay the flush", async () => {
    const { analytics, posts } = recordingAnalytics();
    await fatalStop({ stop: () => new Promise<void>(() => undefined) }, analytics, new Error("boom"));
    expect(posts.flatMap((p) => p.events)).toEqual(["$exception"]);
  });

  it("is bounded at 2 s when PostHog hangs", async () => {
    vi.useFakeTimers();
    expect(FATAL_FLUSH_MS).toBe(2_000);
    const { analytics } = recordingAnalytics(() => new Promise<Response>(() => undefined));
    let settled = false;
    const done = boundedFatal(() => fatalStop(undefined, analytics, new Error("boom"))).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(settled).toBe(true);
  });

  it("a failing crash handler still settles (the process still exits)", async () => {
    await expect(boundedFatal(async () => Promise.reject(new Error("handler failed")), 50)).resolves.toBeUndefined();
  });
});
