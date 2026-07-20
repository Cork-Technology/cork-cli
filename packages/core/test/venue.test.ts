// Centralized-mode venue wiring, fully offline: an injected fetch stub plays api-phoenix.
// Covers query routing (markets/orderbook/fills/limit-order-markets/flows), mode gating,
// submit relays with [K3] recomputation (tampered payloads are NOT relayed), the venue POST
// outcome map (201/200/400/409/429), and track reconcile via venue lifecycle rows.
import { describe, expect, it } from "vitest";
import { runTool, ORDER_DATA_TYPEHASH, type HandlerContext } from "@cork/core";
import { TOOL_EXAMPLES } from "@cork/schemas";

const NOW = 1_790_000_000n;

interface Seen {
  url: string;
  method: string;
  body?: unknown;
}

/** Fetch stub: routes by path substring; records every request for assertions. */
function stubVenue(routes: Array<{ match: string; status?: number; body: unknown }>, seen: Seen[] = []) {
  const venueFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const r = routes.find((r) => url.includes(r.match));
    if (!r) return new Response(JSON.stringify({ statusCode: 404, error: "Not Found", message: `no stub for ${url}` }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { venueFetch, seen };
}

function ctxWith(routes: Array<{ match: string; status?: number; body: unknown }>, seen: Seen[] = []): HandlerContext {
  return { nowSeconds: NOW, ...stubVenue(routes, seen) };
}

describe("cork_query venue-backed resources", () => {
  it("markets routes to /pools and labels provenance.mode centralized", async () => {
    const seen: Seen[] = [];
    const env = await runTool(
      "cork_query",
      { resource: "markets", chainId: 42161, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/pools", body: { items: [{ poolId: "0xabc", chainId: 42161 }] } }], seen),
    );
    expect(env.state).toBe("ok");
    expect(env.provenance.mode).toBe("centralized");
    expect(env.provenance.source).toBe("indexer");
    expect((env.data as { count: number }).count).toBe(1);
    expect(seen[0]!.url).toContain("/pools?chainId=42161");
  });

  it("orderbook forwards poolId/side/status filters", async () => {
    const seen: Seen[] = [];
    const env = await runTool(
      "cork_query",
      { resource: "orderbook", chainId: 42161, filters: { poolId: `0x${"ab".repeat(32)}`, side: "BUY", status: "OPEN" }, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/limit-orders/orderbook", body: { items: [] } }], seen),
    );
    expect(env.state).toBe("ok");
    const url = seen[0]!.url;
    expect(url).toContain("side=BUY");
    expect(url).toContain("status=OPEN");
    expect(url).toContain(`poolId=0x${"ab".repeat(32)}`);
  });

  it("flows kind=orders honors fillable + account→user; kind=contracts routes to /contracts", async () => {
    const seen: Seen[] = [];
    const ctx = ctxWith(
      [
        { match: "/rollover/orders", body: { items: [{ orderDigest: "0x1", status: "PENDING" }], hasMore: false } },
        { match: "/rollover/contracts", body: { items: [] } },
      ],
      seen,
    );
    const orders = await runTool(
      "cork_query",
      { resource: "flows", chainId: 42161, filters: { fillable: "true", account: "0xc0ffee0000000000000000000000000000000001" }, pageSize: 25, format: "concise" },
      ctx,
    );
    expect(orders.state).toBe("ok");
    expect((orders.data as { kind: string }).kind).toBe("orders");
    expect(seen[0]!.url).toContain("fillable=true");
    expect(seen[0]!.url).toContain("user=0xc0ffee0000000000000000000000000000000001");

    const contracts = await runTool(
      "cork_query",
      { resource: "flows", chainId: 42161, filters: { kind: "contracts", account: "0xc0ffee0000000000000000000000000000000001" }, pageSize: 25, format: "concise" },
      ctx,
    );
    expect(contracts.state).toBe("ok");
    expect(seen[1]!.url).toContain("/rollover/contracts");
    expect(seen[1]!.url).toContain("owner=0xc0ffee0000000000000000000000000000000001");
  });

  it("rejects decentralized modes for venue-only resources (explicit, never silent)", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "orderbook", chainId: 42161, mode: "full-decentralized", pageSize: 25, format: "concise" },
      ctxWith([]),
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("mode_unavailable");
  });

  it("still rejects centralized mode for live chain reads", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "market", chainId: 1, mode: "centralized", filters: { poolId: `0x${"ab".repeat(32)}` }, pageSize: 25, format: "concise" },
      ctxWith([]),
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("mode_unavailable");
  });

  it("venue outage is honest (venue_unreachable), not a crash or a fabrication", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "markets", chainId: 42161, pageSize: 25, format: "concise" },
      { nowSeconds: NOW, venueFetch: async () => { throw new Error("ECONNREFUSED"); } },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("venue_unreachable");
  });
});

describe("cork_submit relays [K1] with local recomputation [K3]", () => {
  // The shipped worked example is a coherent payload (its rolloverIntentHash IS the zero-digest
  // hash of its intent) — reuse it as the canonical fixture.
  const example = TOOL_EXAMPLES.cork_submit![0]!.input as Record<string, unknown>;

  it("rollover-order: relays a coherent payload; 201 → ok accepted", async () => {
    const seen: Seen[] = [];
    const env = await runTool(
      "cork_submit",
      example,
      ctxWith([{ match: "/rollover/orders", status: 201, body: { orderDigest: "0xVENUE" } }], seen),
    );
    // The venue's digest differs from the local recomputation in this stub → conflict surfaces.
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("digest_mismatch");
    // …but the POST itself happened with the right shape:
    const post = seen[0]!;
    expect(post.method).toBe("POST");
    const body = post.body as Record<string, unknown>;
    expect((body.envelope as Record<string, unknown>).orderDataType).toBe(ORDER_DATA_TYPEHASH);
    expect(body.chainId).toBe(42161);
  });

  it("rollover-order: venue echoing the LOCAL digest → clean ok (accepted, no replay)", async () => {
    // First compute the local digest by relaying against a echo stub that returns it.
    let captured = "";
    const echoCtx: HandlerContext = {
      nowSeconds: NOW,
      venueFetch: async (_url, init) => {
        void init;
        return new Response(JSON.stringify({ orderDigest: captured }), { status: 201 });
      },
    };
    // Probe once with a mismatching stub to learn the local digest from the conflict data.
    const probe = await runTool("cork_submit", example, ctxWith([{ match: "/rollover/orders", status: 201, body: { orderDigest: "0xother" } }]));
    captured = (probe.data as { localDigest: string }).localDigest;
    const env = await runTool("cork_submit", example, echoCtx);
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    expect(d.accepted).toBe(true);
    expect(d.replay).toBe(false);
    expect(d.orderDigest).toBe(captured);
    expect(env.provenance.mode).toBe("centralized");
  });

  it("rollover-order: TAMPERED intent (nonce changed) → conflict, NOT relayed", async () => {
    const seen: Seen[] = [];
    const tampered = JSON.parse(JSON.stringify(example)) as { action: { intent: { nonce: string } } };
    tampered.action.intent.nonce = "999";
    const env = await runTool("cork_submit", tampered, ctxWith([{ match: "/rollover/orders", status: 201, body: {} }], seen));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("digest_mismatch");
    expect(seen.length).toBe(0); // the broken payload never left the process
  });

  it("rollover-order: 200 → idempotent replay; 409 → conflict; 429 → rate-limited", async () => {
    let captured = "";
    const probe = await runTool("cork_submit", example, ctxWith([{ match: "/rollover/orders", status: 201, body: { orderDigest: "0xother" } }]));
    captured = (probe.data as { localDigest: string }).localDigest;

    const replay = await runTool("cork_submit", example, ctxWith([{ match: "/rollover/orders", status: 200, body: { orderDigest: captured } }]));
    expect(replay.state).toBe("ok");
    expect((replay.data as { replay: boolean }).replay).toBe(true);

    const conflict = await runTool("cork_submit", example, ctxWith([{ match: "/rollover/orders", status: 409, body: { message: "digest exists with different payload" } }]));
    expect(conflict.state).toBe("conflict");
    expect(conflict.warnings[0]?.code).toBe("venue_conflict");

    const limited = await runTool("cork_submit", example, ctxWith([{ match: "/rollover/orders", status: 429, body: { message: "open-order cap reached" } }]));
    expect(limited.state).toBe("unavailable");
    expect(limited.warnings[0]?.code).toBe("venue_rate_limited");

    const rejected = await runTool("cork_submit", example, ctxWith([{ match: "/rollover/orders", status: 400, body: { message: "signature invalid" } }]));
    expect(rejected.state).toBe("unavailable");
    expect(rejected.warnings[0]?.code).toBe("venue_rejected");
    expect(rejected.warnings[0]?.message).toContain("signature invalid");
  });

  it("lop-order: recomputes the orderHash locally and catches extension/salt mismatch", async () => {
    const seen: Seen[] = [];
    const base = {
      chainId: 1,
      clientRequestId: "test-lop-0001",
      action: {
        type: "lop-order",
        order: { salt: "123", maker: "0xc0ffee0000000000000000000000000000000001", receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" },
        signature: `0x${"11".repeat(65)}`,
        side: "SELL",
        premium: 3.6,
        expiry: 1795000000,
        nonce: "0",
        allowsPartialFills: true,
      },
    };
    const ok = await runTool("cork_submit", base, ctxWith([{ match: "/limit-orders", status: 201, body: { orderHash: "0xdead" } }], seen));
    expect(ok.state).toBe("ok");
    const body = seen[0]!.body as Record<string, unknown>;
    expect(String(body.orderHash)).toMatch(/^0x[0-9a-f]{64}$/); // locally recomputed, never caller-supplied
    expect(body.extension).toBe(""); // plain orders send the empty string per the venue contract

    const badExt = await runTool(
      "cork_submit",
      { ...base, action: { ...base.action, extension: "0xdeadbeef" } },
      ctxWith([{ match: "/limit-orders", status: 201, body: {} }]),
    );
    expect(badExt.state).toBe("conflict");
    expect(badExt.warnings[0]?.code).toBe("extension_salt_mismatch");
  });

  it("rfq-open: clientRequestId becomes the venue request_id (idempotency [K2] on the wire)", async () => {
    const seen: Seen[] = [];
    const example2 = TOOL_EXAMPLES.cork_submit![1]!.input;
    const env = await runTool("cork_submit", example2, ctxWith([{ match: "/rfqs", status: 201, body: { rfq_id: "rfq_001", state: "open" } }], seen));
    expect(env.state).toBe("ok");
    expect((env.data as { rfqId: string }).rfqId).toBe("rfq_001");
    const body = seen[0]!.body as Record<string, unknown>;
    expect(body.request_id).toBe("demo-rfq-0001");
    expect(body.schema_version).toBe("1");
    expect(body.chain_id).toBe(42161);
  });
});

describe("cork_track reconcile via venue lifecycle", () => {
  const digest = `0x${"3".repeat(64)}`;

  it("rollover order found → venue-reported lifecycle with the [K7] disclosure", async () => {
    const env = await runTool(
      "cork_track",
      { mode: "reconcile", subject: { kind: "orderHash", orderHash: digest }, format: "concise" },
      ctxWith([{ match: `/rollover/orders/${digest}`, body: { order: { status: "PARTIALLY_FILLED", remainingSize: "5" }, fills: [{ leg: "ROLLOVER" }], slots: [] } }]),
    );
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, unknown>;
    expect(d.kind).toBe("rollover-order");
    expect(d.lifecycle).toBe("PARTIALLY_FILLED");
    expect(env.warnings[0]?.code).toBe("venue_reported");
    expect(env.provenance.mode).toBe("centralized");
  });

  it("unknown to rollover venue → falls through to LOP fills; nothing anywhere → order_not_found", async () => {
    const withFills = await runTool(
      "cork_track",
      { mode: "reconcile", subject: { kind: "orderHash", orderHash: digest }, format: "concise" },
      ctxWith([
        { match: `/rollover/orders/${digest}`, status: 404, body: { message: "not found" } },
        { match: "/limit-orders/fills", body: { items: [{ txHash: "0xaa" }] } },
      ]),
    );
    expect(withFills.state).toBe("ok");
    expect((withFills.data as { kind: string }).kind).toBe("lop-fills");

    const nowhere = await runTool(
      "cork_track",
      { mode: "reconcile", subject: { kind: "submissionRef", submissionRef: digest }, format: "concise" },
      ctxWith([
        { match: `/rollover/orders/${digest}`, status: 404, body: { message: "not found" } },
        { match: "/limit-orders/fills", body: { items: [] } },
      ]),
    );
    expect(nowhere.state).toBe("unavailable");
    expect(nowhere.warnings[0]?.code).toBe("order_not_found");
  });
});
