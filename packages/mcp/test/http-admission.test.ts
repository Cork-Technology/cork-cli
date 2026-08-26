// HTTP ingress admission (audit MCP-NET-003, 2026-08-24). The deployed endpoint is public by
// design, so "open" has to mean "bounded", not "unbounded": an ingress can count requests and
// bytes, but only the application can see a 10,000-deep JSON body, a 5,000-message batch, or a
// tool call waiting on a slow upstream. These tests drive the REAL fetch handler (and, for the
// per-client accounting, the controller itself), never a mock of it.
import { describe, expect, it } from "vitest";
import { AdmissionController, createHttpHandler, MCP_HTTP_LIMITS, principalOf, SHARED_PRINCIPAL } from "../src/index.ts";

type RpcError = { error: { code: number; message: string } };
const rpcError = async (res: Response): Promise<RpcError> => (await res.json()) as RpcError;

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://mcp.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

/** JSON nested `depth` levels: `{"a":{"a":…}}`. */
const nested = (depth: number): unknown => {
  let node: unknown = 1;
  for (let i = 0; i < depth; i++) node = { a: node };
  return node;
};

describe("body and shape bounds", () => {
  const handler = createHttpHandler();

  it("refuses an oversized body by its declared length, before reading it", async () => {
    const res = await handler(post(initialize, { "content-length": String(MCP_HTTP_LIMITS.bodyBytes + 1) }));
    expect(res.status).toBe(413);
    expect((await rpcError(res)).error.message).toContain(String(MCP_HTTP_LIMITS.bodyBytes));
  });

  it("refuses an oversized body that LIED about its length", async () => {
    // A caller controls the header; the bytes are what actually cost us.
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(MCP_HTTP_LIMITS.bodyBytes) } });
    const res = await handler(post(big, { "content-length": "10" }));
    expect(res.status).toBe(413);
  });

  it("refuses JSON nested past the depth bound, and accepts JSON just inside it", async () => {
    const tooDeep = await handler(post(nested(MCP_HTTP_LIMITS.jsonDepth + 1)));
    expect(tooDeep.status).toBe(400);
    expect((await rpcError(tooDeep)).error.message).toContain("nests deeper");
    // Just inside the bound: the shape check passes it through to the SDK, which rejects it as a
    // malformed JSON-RPC message — a different, later refusal. Not a 400 from the depth gate.
    const okDepth = await handler(post(nested(MCP_HTTP_LIMITS.jsonDepth - 1)));
    expect(await okDepth.text()).not.toContain("nests deeper");
  });

  it("refuses a batch larger than the message bound", async () => {
    const res = await handler(post(Array.from({ length: MCP_HTTP_LIMITS.batchMessages + 1 }, () => initialize)));
    expect(res.status).toBe(400);
    expect((await rpcError(res)).error.message).toContain("batch exceeds");
  });

  it("answers malformed JSON with the JSON-RPC parse error, not a stack trace", async () => {
    const res = await handler(post("{not json"));
    expect(res.status).toBe(400);
    expect((await rpcError(res)).error).toMatchObject({ code: -32700 });
  });

  it("still serves a well-formed request end to end", async () => {
    const res = await handler(post(initialize));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("serverInfo");
  });
});

describe("concurrency is accounted per principal", () => {
  const manual = () => {
    // A deadline scheduler that never fires: these tests are about slots, not timeouts.
    const controller = new AdmissionController(60_000, () => () => {});
    return controller;
  };

  /** Hold `n` slots open for `principal`, resolving each dispatch only when told to. */
  async function occupy(controller: AdmissionController, principal: string, n: number) {
    const releases: Array<() => void> = [];
    const started: Array<Promise<Response>> = [];
    for (let i = 0; i < n; i++) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      releases.push(release);
      started.push(controller.handle(post(initialize), principal, async () => {
        await gate;
        return new Response("ok");
      }));
      await Promise.resolve(); // let handle() take its slot before the next one
    }
    // The slot is taken inside handle(), after an await — give the microtask queue a beat.
    await new Promise((r) => setTimeout(r, 10));
    return { releases, started };
  }

  it("refuses the (n+1)th concurrent request from ONE principal with 429 + Retry-After", async () => {
    const controller = manual();
    const { releases, started } = await occupy(controller, "ip:1.2.3.4", MCP_HTTP_LIMITS.principalRequests);
    expect(controller.inFlight().global).toBe(MCP_HTTP_LIMITS.principalRequests);
    const refused = await controller.handle(post(initialize), "ip:1.2.3.4", async () => new Response("must not run"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");

    // …and a DIFFERENT principal is unaffected: one noisy client must not starve a room.
    const other = await controller.handle(post(initialize), "ip:5.6.7.8", async () => new Response("served"));
    expect(other.status).toBe(200);

    for (const r of releases) r();
    await Promise.all(started);
    expect(controller.inFlight()).toEqual({ global: 0, principals: 0, sharedBucketInUse: false }); // slots always released
  });

  it("refuses beyond the GLOBAL bound however many principals ask", async () => {
    const controller = manual();
    const held: Array<{ releases: Array<() => void>; started: Array<Promise<Response>> }> = [];
    for (let i = 0; i < MCP_HTTP_LIMITS.globalRequests / MCP_HTTP_LIMITS.principalRequests; i++) {
      held.push(await occupy(controller, `ip:10.0.0.${i}`, MCP_HTTP_LIMITS.principalRequests));
    }
    expect(controller.inFlight().global).toBe(MCP_HTTP_LIMITS.globalRequests);
    const refused = await controller.handle(post(initialize), "ip:10.0.0.99", async () => new Response("must not run"));
    expect(refused.status).toBe(429);
    for (const h of held) {
      for (const r of h.releases) r();
      await Promise.all(h.started);
    }
    expect(controller.inFlight().global).toBe(0);
  });

  it("the SHARED bucket (callers indistinguishable) is bounded only globally — fairness cannot apply to one bucket", async () => {
    // If the ingress does not forward client addresses, every attendee lands in one bucket.
    // Capping that bucket at 8 would cap the whole server at one client's budget.
    const controller = manual();
    const { releases, started } = await occupy(controller, SHARED_PRINCIPAL, MCP_HTTP_LIMITS.principalRequests + 4);
    expect(controller.inFlight()).toMatchObject({ global: MCP_HTTP_LIMITS.principalRequests + 4, sharedBucketInUse: true });
    const more = await controller.handle(post(initialize), SHARED_PRINCIPAL, async () => new Response("served"));
    expect(more.status).toBe(200);
    for (const r of releases) r();
    await Promise.all(started);
    expect(controller.inFlight().sharedBucketInUse).toBe(false);
  });

  it("releases the slot even when the dispatch throws", async () => {
    const controller = manual();
    await expect(controller.handle(post(initialize), "ip:1.1.1.1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(controller.inFlight()).toEqual({ global: 0, principals: 0, sharedBucketInUse: false });
  });
});

describe("the deadline cancels the request's own work", () => {
  it("aborts the signal handed to the dispatch, with a TimeoutError", async () => {
    let fired: (() => void) | undefined;
    const controller = new AdmissionController(1_000, (onDeadline) => {
      fired = onDeadline;
      return () => {};
    });
    const seen = await controller.handle(post(initialize), "ip:1", async (_body, signal) => {
      expect(signal.aborted).toBe(false);
      fired?.(); // the deadline elapses mid-request
      expect(signal.aborted).toBe(true);
      expect((signal.reason as DOMException).name).toBe("TimeoutError");
      return new Response("ok");
    });
    expect(seen.status).toBe(200);
  });

  it("refuses a non-positive deadline at construction rather than never firing", () => {
    expect(() => new AdmissionController(0)).toThrow(/positive/);
    expect(() => new AdmissionController(Number.NaN)).toThrow(/positive/);
  });
});

describe("principalOf: a principal must not be mintable by the caller", () => {
  const withHeader = (value: string) => new Request("http://mcp.test/mcp", { headers: { "x-forwarded-for": value } });

  it("ignores X-Forwarded-For when no ingress is declared — otherwise anyone mints a fresh bucket per request", () => {
    expect(principalOf(withHeader("9.9.9.9"), { trustForwardedFor: false, peerAddress: "10.0.0.1" })).toBe("ip:10.0.0.1");
  });

  it("behind an ingress, uses the LAST hop — the one the proxy itself observed", () => {
    // Earlier entries are attacker-authored: a client can send its own X-Forwarded-For and the
    // proxy appends the peer it saw.
    expect(principalOf(withHeader("1.1.1.1, 2.2.2.2, 3.3.3.3"), { trustForwardedFor: true, peerAddress: "10.0.0.1" })).toBe("ip:3.3.3.3");
  });

  it("falls back to the peer, then to one shared bucket — failing toward MORE sharing, not less", () => {
    expect(principalOf(new Request("http://mcp.test/mcp"), { trustForwardedFor: true, peerAddress: "10.0.0.1" })).toBe("ip:10.0.0.1");
    expect(principalOf(new Request("http://mcp.test/mcp"), { trustForwardedFor: true })).toBe(SHARED_PRINCIPAL);
  });
});

// A real listening socket is exercised by http-e2e.test.ts, which spawns the actual `ch mcp
// --http` process — vitest's workers run under Node, where Bun.serve does not exist.
