// Centralized-mode venue wiring, fully offline: an injected fetch stub plays api-phoenix.
// Covers query routing (markets/orderbook/fills/limit-order-markets/flows), mode gating,
// submit relays with [K3] recomputation (tampered payloads are NOT relayed), the venue POST
// outcome map (201/200/400/409/429), and track reconcile via venue lifecycle rows.
import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { runTool, hashLopOrder, LOP_ADDRESSES, ORDER_DATA_TYPEHASH, ToolInputError, parseSignedLopOrder, type HandlerContext, type LopOrder } from "@cork/core";
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

  it("rfqs by id: a known id returns the record; an unknown id is rfq_not_found, never fabricated", async () => {
    const found = await runTool(
      "cork_query",
      { resource: "rfqs", chainId: 42161, filters: { rfqId: "rfq_abc" }, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/rfqs/rfq_abc", body: { rfq_id: "rfq_abc", state: "open" } }]),
    );
    expect(found.state).toBe("ok");
    expect((found.data as { items: unknown[] }).items).toHaveLength(1);

    // No stub route for the id -> the stub answers 404 -> getRfq returns null -> honest gap.
    const missing = await runTool(
      "cork_query",
      { resource: "rfqs", chainId: 42161, filters: { rfqId: "rfq_missing" }, pageSize: 25, format: "concise" },
      ctxWith([]),
    );
    expect(missing.state).toBe("unavailable");
    expect(missing.warnings[0]?.code).toBe("rfq_not_found");
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
    // 2026-07-22: the LOP surface reports the richer "lop-order" shape (fills + resting flag +
    // optional on-chain invalidator leg — see lop-invalidator.test.ts for that leg's coverage).
    expect((withFills.data as { kind: string }).kind).toBe("lop-order");
    expect((withFills.data as { resting: boolean }).resting).toBe(false);

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

describe("R4: numbers-contract tripwires + quote_ref cross-check + extension orders", () => {
  const lopBase = {
    chainId: 1,
    clientRequestId: "test-lop-r4-01",
    action: {
      type: "lop-order",
      order: { salt: "123", maker: "0xc0ffee0000000000000000000000000000000001", receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" },
      signature: `0x${"11".repeat(65)}`,
      side: "SELL",
      premium: 0.036, // a fraction pasted into the percent field
      expiry: 1795000000,
      nonce: "0",
      allowsPartialFills: true,
    },
  };

  it("sub-0.1% premium → premium_scale_suspect warning (relayed, matching venue leniency)", async () => {
    const env = await runTool("cork_submit", lopBase, ctxWith([{ match: "/limit-orders", status: 201, body: { orderHash: "0x1" } }]));
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "premium_scale_suspect")).toBe(true);
  });

  it("quote_ref citing a diverging premium → conflict premium_scale_mismatch, NOT relayed", async () => {
    const seen: Seen[] = [];
    const rfq = { rfq_id: "rfq_1", answers: [{ answer_id: "ans_1", answer: { options: [{ option_id: "1", premium_annualized: "0.036" }] } }] };
    const env = await runTool(
      "cork_submit",
      { ...lopBase, action: { ...lopBase.action, premium: 0.036, quoteRef: { rfqId: "rfq_1", answerId: "ans_1", optionId: "1" } } },
      ctxWith([{ match: "/rfqs/rfq_1", body: rfq }, { match: "/limit-orders", status: 201, body: {} }], seen),
    );
    // declared 0.036 percent vs cited 3.6 percent = 1/100x divergence
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("premium_scale_mismatch");
    expect(seen.filter((s) => s.method === "POST").length).toBe(0);
  });

  it("quote_ref with a consistent premium relays cleanly", async () => {
    const rfq = { rfq_id: "rfq_1", answers: [{ answer_id: "ans_1", answer: { options: [{ option_id: "1", premium_annualized: "0.036" }] } }] };
    const env = await runTool(
      "cork_submit",
      { ...lopBase, action: { ...lopBase.action, premium: 3.6, quoteRef: { rfqId: "rfq_1", answerId: "ans_1", optionId: "1" } } },
      ctxWith([{ match: "/rfqs/rfq_1", body: rfq }, { match: "/limit-orders", status: 201, body: { orderHash: "0x1" } }]),
    );
    expect(env.state).toBe("ok");
  });

  it("rfq-answer options must carry fraction-string premiums (< 0.5)", async () => {
    const bad = await runTool(
      "cork_submit",
      { chainId: 42161, clientRequestId: "test-ans-r4-01", action: { type: "rfq-answer", rfqId: "rfq_1", underwriter: "0xc0ffee0000000000000000000000000000000001", status: "quoted", options: [{ option_id: "1", premium_annualized: 4.1 }], signature: "0x00" } },
      ctxWith([]),
    );
    expect(bad.state).toBe("unavailable");
    expect(bad.warnings[0]?.code).toBe("invalid_order_terms");
    expect(bad.warnings[0]?.message).toContain("FRACTION");
  });

  it("prepare maker-order with extension binds salt low-160 to keccak(extension) + sets the flag", async () => {
    const ext = "0xdeadbeefcafe";
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: "0xc0ffee0000000000000000000000000000000001", clientRequestId: "test-ext-0001", action: { type: "maker-order", poolId: `0x${"ab".repeat(32)}`, side: "SELL", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1", takingAmount: "1", extension: ext } },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { extension: string; typedData: { message: { salt: string; makerTraits: string } } };
    expect(d.extension).toBe(ext);
    const salt = BigInt(d.typedData.message.salt);
    const { keccak256 } = await import("viem");
    expect(salt & ((1n << 160n) - 1n)).toBe(BigInt(keccak256(ext)) & ((1n << 160n) - 1n));
    expect(BigInt(d.typedData.message.makerTraits) & (1n << 249n)).toBe(1n << 249n); // HAS_EXTENSION_FLAG
  });
});

describe("edge branches: pass answers, hooks round-trip, list shapes, transport oddities", () => {
  it("rfq-answer 'pass' relays reason_code (defaults to PASS) and never options", async () => {
    const seen: Seen[] = [];
    const env = await runTool(
      "cork_submit",
      { chainId: 42161, clientRequestId: "test-pass-0001", action: { type: "rfq-answer", rfqId: "rfq_9", underwriter: "0xc0ffee0000000000000000000000000000000001", status: "pass", reasonCode: "NO_CAPACITY", signature: "0x00" } },
      ctxWith([{ match: "/rfqs/rfq_9/answers", status: 201, body: { answer_id: "ans_9" } }], seen),
    );
    expect(env.state).toBe("ok");
    const body = seen[0]!.body as Record<string, unknown>;
    expect(body.reason_code).toBe("NO_CAPACITY");
    expect(body.options).toBeUndefined();
    expect(body.status).toBe("pass");
  });

  it("rollover-order with NON-EMPTY hooks: recomputed hash matches → relayed with the hooks intact", async () => {
    // Build a coherent hooked payload from the library itself, then relay it.
    const { intentStructHash } = await import("@cork/core");
    const hook = { target: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", value: "0", callData: "0xdeadbeef", allowFailure: false, isDelegateCall: true };
    const example = JSON.parse(JSON.stringify(TOOL_EXAMPLES.cork_submit![0]!.input)) as {
      action: { order: Record<string, unknown> & { rolloverIntentHash: string }; intent: Record<string, unknown> };
    };
    example.action.intent.preRolloverHooks = [hook];
    example.action.order.rolloverIntentHash = intentStructHash({
      rolloverContract: example.action.intent.rolloverContract as `0x${string}`,
      orderDigest: `0x${"00".repeat(32)}`,
      deadline: BigInt(example.action.intent.deadline as string),
      nonce: BigInt(example.action.intent.nonce as string),
      preRolloverHooks: [{ target: hook.target as `0x${string}`, value: 0n, callData: "0xdeadbeef", allowFailure: false, isDelegateCall: true }],
      midRolloverHooks: [],
      postRolloverHooks: [],
      premiumHooks: [],
    });
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", example, ctxWith([{ match: "/rollover/orders", status: 201, body: {} }], seen));
    expect(env.state).toBe("ok");
    const posted = seen[0]!.body as { intent: { preRolloverHooks: unknown[] } };
    expect(posted.intent.preRolloverHooks.length).toBe(1);
  });

  it("bare-array venue responses parse as lists (shape tolerance)", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "limit-order-markets", chainId: 42161, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/limit-orders/markets", body: [{ poolId: "0x1" }, { poolId: "0x2" }] }]),
    );
    expect(env.state).toBe("ok");
    expect((env.data as { count: number }).count).toBe(2);
  });

  it("quote_ref citing an unknown RFQ → invalid_order_terms, NOT relayed", async () => {
    const seen: Seen[] = [];
    const env = await runTool(
      "cork_submit",
      { chainId: 1, clientRequestId: "test-qr-0001", action: { type: "lop-order", order: { salt: "1", maker: "0xc0ffee0000000000000000000000000000000001", receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1", takingAmount: "1", makerTraits: "0" }, signature: "0x00", side: "SELL", premium: 3.6, expiry: 1, nonce: "0", allowsPartialFills: true, quoteRef: { rfqId: "rfq_missing", answerId: "a", optionId: "1" } } },
      ctxWith([{ match: "/rfqs/rfq_missing", status: 404, body: { message: "not found" } }], seen),
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(seen.filter((s) => s.method === "POST").length).toBe(0);
  });

  it("venue POST with an empty (non-JSON) error body keeps the HTTP status", async () => {
    const env = await runTool(
      "cork_submit",
      TOOL_EXAMPLES.cork_submit![1]!.input,
      { nowSeconds: NOW, venueFetch: async () => new Response(null, { status: 503 }) },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("venue_rejected");
    expect(env.warnings[0]?.message).toContain("503");
  });

  it("submissionRef with an rfq_ prefix explains itself instead of guessing", async () => {
    const env = await runTool(
      "cork_track",
      { mode: "reconcile", subject: { kind: "submissionRef", submissionRef: "rfq_abc123" }, format: "concise" },
      ctxWith([]),
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("order_not_found");
    expect(env.warnings[0]?.message).toContain("rfq_");
  });
});

describe("cork_query rfqs (venue RFQ discovery feed)", () => {
  it("list routes to /rfqs with snake_case params (state, requester, with_answers)", async () => {
    const seen: Seen[] = [];
    const env = await runTool(
      "cork_query",
      { resource: "rfqs", chainId: 42161, filters: { state: "open", account: "0xc0ffee0000000000000000000000000000000001", withAnswers: true }, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/rfqs?", body: { items: [{ rfq_id: "rfq_abc", state: "open", answer_count: 2, request: {} }], next_cursor: null } }], seen),
    );
    expect(env.state).toBe("ok");
    expect(env.provenance.mode).toBe("centralized");
    expect((env.data as { count: number }).count).toBe(1);
    const url = seen[0]!.url;
    expect(url).toContain("chain_id=42161");
    expect(url).toContain("state=open");
    expect(url).toContain("requester=0xc0ffee0000000000000000000000000000000001");
    expect(url).toContain("with_answers=true");
    // next_cursor:null → the traversal completed; no resume cursor surfaces.
    const pg = (env.data as { pagination: { complete: boolean; nextCursor?: string } }).pagination;
    expect(pg.complete).toBe(true);
    expect("nextCursor" in pg).toBe(false);
  });

  it("walks the venue's keyset cursor to exhaustion and aggregates pages", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "rfqs", chainId: 42161, pageSize: 25, format: "concise" },
      ctxWith([
        { match: "cursor=rfq_a", body: { items: [{ rfq_id: "rfq_b" }], next_cursor: null } },
        { match: "/rfqs?", body: { items: [{ rfq_id: "rfq_a" }], next_cursor: "rfq_a" } },
      ]),
    );
    expect(env.state).toBe("ok");
    const d = env.data as { count: number; pagination: { complete: boolean; pagesFetched: number } };
    expect(d.count).toBe(2); // page 1 (rfq_a) + page 2 (rfq_b)
    expect(d.pagination.complete).toBe(true);
    expect(d.pagination.pagesFetched).toBe(2);
  });

  it("filters.rfqId fetches one record with all answers; 404 → rfq_not_found (a normal outcome)", async () => {
    const seen: Seen[] = [];
    const hit = await runTool(
      "cork_query",
      { resource: "rfqs", chainId: 42161, filters: { rfqId: "rfq_abc123" }, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/rfqs/rfq_abc123", body: { rfq_id: "rfq_abc123", state: "open", answers: [], answer_count: 0, truncated: false, request: {} } }], seen),
    );
    expect(hit.state).toBe("ok");
    expect((hit.data as { items: Array<{ rfq_id: string }> }).items[0]!.rfq_id).toBe("rfq_abc123");
    expect(seen[0]!.url).toContain("/rfqs/rfq_abc123");

    const miss = await runTool(
      "cork_query",
      { resource: "rfqs", chainId: 42161, filters: { rfqId: "rfq_missing" }, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/rfqs/rfq_missing", status: 404, body: { message: "Unknown rfq_id" } }]),
    );
    expect(miss.state).toBe("unavailable");
    expect(miss.warnings[0]?.code).toBe("rfq_not_found");
  });

  it("malformed rfqId / state are teachable input errors (exit 2), not venue calls", async () => {
    const seen: Seen[] = [];
    await expect(
      runTool("cork_query", { resource: "rfqs", filters: { rfqId: "ans_123" }, pageSize: 25, format: "concise" }, ctxWith([], seen)),
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      runTool("cork_query", { resource: "rfqs", filters: { state: "closed" }, pageSize: 25, format: "concise" }, ctxWith([], seen)),
    ).rejects.toBeInstanceOf(ToolInputError);
    expect(seen.length).toBe(0);
  });

  it("rfqs is venue-only in EVERY mode: full-decentralized is a structural no, not a phase gap", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "rfqs", chainId: 42161, mode: "full-decentralized", pageSize: 25, format: "concise" },
      ctxWith([]),
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("mode_unavailable");
    expect(env.warnings[0]?.message).toContain("emit");
  });

  it("unknown filter keys are a teachable error naming the near-miss (as the schema advertises)", async () => {
    const err = await runTool(
      "cork_query",
      { resource: "rfqs", filters: { rfq_id: "rfq_abc123" }, pageSize: 25, format: "concise" },
      ctxWith([]),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolInputError);
    const issues = (err as ToolInputError).issues as Array<{ path: unknown[]; message: string }>;
    expect(issues[0]!.path).toEqual(["filters", "rfq_id"]);
    expect(issues[0]!.message).toContain("rfqId");
  });
});

describe("pagination completeness: bounded traversal, never silent truncation", () => {
  type Pg = { complete: boolean; pagesFetched: number; reason?: string; nextCursor?: string };
  const pgOf = (env: { data: unknown }) => (env.data as { pagination: Pg }).pagination;

  it("maxPages bound → state ok with a pagination_incomplete warning and a resume cursor (never faked as complete)", async () => {
    // Dynamic venue: every page hands back a fresh cursor, so the set is unbounded and the walk
    // stops at the hard page bound rather than looping or truncating silently.
    let n = 0;
    const ctx: HandlerContext = {
      nowSeconds: NOW,
      venueFetch: async () => {
        n += 1;
        return new Response(JSON.stringify({ items: [{ i: n }], next_cursor: `c${n}` }), { status: 200 });
      },
    };
    const env = await runTool("cork_query", { resource: "markets", chainId: 42161, pageSize: 5, maxPages: 3, format: "concise" }, ctx);
    expect(env.state).toBe("ok");
    const pg = pgOf(env);
    expect(pg.complete).toBe(false);
    expect(pg.pagesFetched).toBe(3);
    expect(pg.reason).toBe("max_pages");
    expect(pg.nextCursor).toBe("c3");
    expect(env.warnings[0]?.code).toBe("pagination_incomplete");
    expect((env.data as { count: number }).count).toBe(3);
  });

  it("a venue that repeats a cursor is a CONFLICT (the venue contradicts itself), not a silent stop", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "markets", chainId: 42161, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/pools", body: { items: [{ x: 1 }], next_cursor: "loop" } }]),
    );
    expect(env.state).toBe("conflict");
    expect(pgOf(env).reason).toBe("cursor_repeated");
    expect(env.warnings[0]?.code).toBe("pagination_incomplete");
  });

  it("a bare-array response has unprovable completeness → incomplete (metadata_absent), disclosed not hidden", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "fills", chainId: 42161, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/limit-orders/fills", body: [{ orderHash: "0x1" }] }]),
    );
    expect(env.state).toBe("ok");
    const pg = pgOf(env);
    expect(pg.complete).toBe(false);
    expect(pg.reason).toBe("metadata_absent");
    expect(env.warnings[0]?.code).toBe("pagination_incomplete");
  });

  it("hasMore:false on the first page → complete in one page, no warning", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "markets", chainId: 42161, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/pools", body: { items: [{ poolId: "0xabc" }], hasMore: false } }]),
    );
    expect(env.state).toBe("ok");
    expect(pgOf(env).complete).toBe(true);
    expect(env.warnings).toEqual([]);
  });
});

describe("parseSignedLopOrder (untrusted venue row → validated signed order)", () => {
  const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";

  it("normalizes a nested, snake_cased row and maps EIP1271 → ERC1271", () => {
    const row = {
      order: { salt: "5", maker: A, receiver: zeroAddress, maker_asset: A, taker_asset: B, making_amount: "100", taking_amount: "200", maker_traits: "0" },
      signature: SIG,
      extension: "",
      maker_account_type: "eip-1271",
      order_hash: `0x${"cd".repeat(32)}`,
    };
    const r = parseSignedLopOrder(row);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.order.makerAsset.toLowerCase()).toBe(A);
      expect(r.value.order.makingAmount).toBe(100n);
      expect(r.value.extension).toBe("0x"); // "" normalized
      expect(r.value.makerAccountType).toBe("ERC1271");
      expect(r.value.venueOrderHash).toBe(`0x${"cd".repeat(32)}`);
    }
  });

  it("returns a Result error (never throws) on a malformed address", () => {
    const r = parseSignedLopOrder({ salt: "1", maker: "not-an-address", receiver: zeroAddress, makerAsset: A, takerAsset: B, makingAmount: "1", takingAmount: "1", makerTraits: "0", signature: SIG });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/maker/);
  });

  it("rejects an unsupported makerAccountType", () => {
    const r = parseSignedLopOrder({ salt: "1", maker: A, receiver: zeroAddress, makerAsset: A, takerAsset: B, makingAmount: "1", takingAmount: "1", makerTraits: "0", signature: SIG, makerAccountType: "MULTISIG" });
    expect(r.ok).toBe(false);
  });
});

describe("cork_prepare_orders taker-fill (orderbook lookup + local re-hash + unsigned fill)", () => {
  const LOP = LOP_ADDRESSES[42161]!;
  const MAKER = "0x00000000000000000000000000000000000000a1";
  const SUSDE = "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2";
  const VBUSDC = "0x53e82abbb12638f09d9e624578ccb666217a765e";
  const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  const orderT: LopOrder = { salt: 7n, maker: MAKER, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: 100n, takingAmount: 200n, makerTraits: 0n };
  const orderWire = { salt: "7", maker: MAKER, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "100", takingAmount: "200", makerTraits: "0" };
  const hash = hashLopOrder(42161, LOP, orderT);
  const bookRow = { orderHash: hash, order: orderWire, signature: SIG, extension: "0x" };
  const fill = (routes: Parameters<typeof ctxWith>[0], orderHash = hash) =>
    runTool("cork_prepare_orders", { chainId: 42161, account: "0x00000000000000000000000000000000000000dd", clientRequestId: "test-fill-0001", action: { type: "taker-fill", orderHash }, format: "concise" }, ctxWith(routes));

  it("finds the resting order, re-hashes it, and returns unsigned canonical fill calldata", async () => {
    const env = await fill([{ match: "/limit-orders/orderbook", body: { items: [bookRow], hasMore: false } }]);
    expect(env.state).toBe("ok");
    const d = env.data as { kind: string; to: string; from: string; orderHash: string; calldata: string; fillFunction: string };
    expect(d.kind).toBe("taker-fill");
    expect(d.to.toLowerCase()).toBe(LOP.toLowerCase());
    expect(d.from).toBe("0x00000000000000000000000000000000000000dd");
    expect(d.orderHash).toBe(hash);
    expect(d.fillFunction).toBe("fillOrder");
    expect(d.calldata.slice(0, 10)).toBe("0x9fda64bd"); // uint256-tuple selector
    expect(env.warnings.some((w) => w.code === "unsigned_artifact")).toBe(true);
  });

  it("a row that does not hash to the requested order → conflict digest_mismatch (no fill bytes)", async () => {
    // Claim the requested hash but carry an order that hashes elsewhere (different salt).
    const liar = { orderHash: hash, order: { ...orderWire, salt: "9999" }, signature: SIG, extension: "0x" };
    const env = await fill([{ match: "/limit-orders/orderbook", body: { items: [liar], hasMore: false } }]);
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("digest_mismatch");
  });

  it("order absent from a COMPLETE book → order_not_found (a normal outcome)", async () => {
    const env = await fill([{ match: "/limit-orders/orderbook", body: { items: [], hasMore: false } }]);
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("order_not_found");
  });

  it("order absent from an INCOMPLETE book → conflict, never a false not-found", async () => {
    // Bare array = unprovable completeness (metadata_absent).
    const env = await fill([{ match: "/limit-orders/orderbook", body: [] }]);
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("pagination_incomplete");
  });

  it("malformed signed row → invalid_service_response (honest, not a crash)", async () => {
    const bad = { orderHash: hash, order: { ...orderWire, maker: "nope" }, signature: SIG, extension: "0x" };
    const env = await fill([{ match: "/limit-orders/orderbook", body: { items: [bad], hasMore: false } }]);
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_service_response");
  });
});
