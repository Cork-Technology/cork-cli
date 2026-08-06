// Centralized-mode venue wiring, fully offline: an injected fetch stub plays api-phoenix.
// Covers query routing (markets/orderbook/fills/limit-order-markets/flows), mode gating,
// submit relays with [K3] recomputation (tampered payloads are NOT relayed), the venue POST
// outcome map (201/200/400/409/429), and track reconcile via venue lifecycle rows.
import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, parseAbi } from "viem";
import { buildAuctionAmountData, buildJitExtension, buildMakerOrder, computeOrderDigest, encodeExtensionFields, encodeJitExtraData, runTool, hashLopOrder, LOP_ADDRESSES, ORDER_DATA_TYPEHASH, POOL_CREATOR_ROLE, ToolInputError, parseSignedLopOrder, type HandlerContext, type LopOrder, type OrderDataStruct } from "@cork/core";
import { TOOL_EXAMPLES } from "@cork/schemas";
import { stubRpc, type StubCall } from "./helpers.ts";

const NOW = 1_790_000_000n;

// cork_submit now RECOVERS signatures against the recomputed commitments [K3/F3/F14], so relay
// fixtures must be genuinely signed. Anvil dev key #0 — public knowledge, test-only.
const SIGNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

type LopOrderWire = Record<string, string>;
const toLopOrder = (o: LopOrderWire): LopOrder => ({
  salt: BigInt(o.salt!),
  maker: o.maker as `0x${string}`,
  receiver: o.receiver as `0x${string}`,
  makerAsset: o.makerAsset as `0x${string}`,
  takerAsset: o.takerAsset as `0x${string}`,
  makingAmount: BigInt(o.makingAmount!),
  takingAmount: BigInt(o.takingAmount!),
  makerTraits: BigInt(o.makerTraits!),
});
const signLop = (chainId: number, o: LopOrderWire) =>
  SIGNER.sign({ hash: hashLopOrder(chainId, LOP_ADDRESSES[chainId]!, toLopOrder(o)) });

/** Wire rollover order (decimal strings) → the typed struct, re-signed by SIGNER. */
const signRollover = (chainId: number, o: Record<string, unknown>) => {
  const p = o.rolloverParams as Record<string, string>;
  const struct: OrderDataStruct = {
    user: o.user as `0x${string}`,
    settler: o.settler as `0x${string}`,
    fillerHint: o.fillerHint as `0x${string}`,
    exclusiveFiller: o.exclusiveFiller as `0x${string}`,
    srcCstToken: o.srcCstToken as `0x${string}`,
    dstCstToken: o.dstCstToken as `0x${string}`,
    premiumToken: o.premiumToken as `0x${string}`,
    rolloverContract: o.rolloverContract as `0x${string}`,
    originChainId: BigInt(o.originChainId as string),
    destinationChainId: BigInt(o.destinationChainId as string),
    openDeadline: BigInt(o.openDeadline as string),
    fillDeadline: BigInt(o.fillDeadline as string),
    orderSalt: BigInt(o.orderSalt as string),
    orderSize: BigInt(o.orderSize as string),
    minPremiumPerShare: BigInt(o.minPremiumPerShare as string),
    allowPartialFills: o.allowPartialFills as boolean,
    allowUnderfill: o.allowUnderfill as boolean,
    premiumPaymentMode: o.premiumPaymentMode as 0 | 1,
    rolloverIntentHash: o.rolloverIntentHash as `0x${string}`,
    rolloverParams: {
      srcCstToken: p.srcCstToken as `0x${string}`,
      dstCstToken: p.dstCstToken as `0x${string}`,
      minCaReceived: BigInt(p.minCaReceived!),
      minSharesOut: BigInt(p.minSharesOut!),
      srcPoolId: p.srcPoolId as `0x${string}`,
      dstPoolId: p.dstPoolId as `0x${string}`,
      settler: p.settler as `0x${string}`,
    },
  };
  return SIGNER.sign({ hash: computeOrderDigest(chainId, struct) });
};

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

  it("orderbook applies filters.orderHash CLIENT-side (the venue path has no such param)", async () => {
    // A known filter key must never be silently unapplied: without the client-side filter this
    // read returned the WHOLE book for an orderHash query (observed live 2026-08-06).
    const target = `0x${"9c".repeat(32)}`;
    const other = `0x${"11".repeat(32)}`;
    const seen: Seen[] = [];
    const env = await runTool(
      "cork_query",
      { resource: "orderbook", chainId: 42161, filters: { orderHash: target.toUpperCase().replace("0X", "0x") }, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/limit-orders/orderbook", body: { items: [{ orderHash: target, status: "OPEN" }, { orderHash: other, status: "OPEN" }] } }], seen),
    );
    expect(env.state).toBe("ok");
    const data = env.data as { count: number; items: Array<{ orderHash: string }> };
    expect(data.count).toBe(1);
    expect(data.items[0]!.orderHash).toBe(target);
    // and the hash was NOT forwarded as a venue query param (it has no server-side meaning here)
    expect(seen[0]!.url).not.toContain("orderHash");
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
    const order = { salt: "123", maker: SIGNER.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" };
    const base = {
      chainId: 1,
      clientRequestId: "test-lop-0001",
      action: {
        type: "lop-order",
        order,
        signature: await signLop(1, order),
        side: "SELL",
        premium: 3.6,
        expiry: 0, // makerTraits "0" encode no expiry — the listing must agree [F3]
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

describe("footgun hardening: derive-and-clamp on submit (F3/F14) + exact-arithmetic tripwires (F5) + rfq-open validation (F6)", () => {
  const order = { salt: "123", maker: SIGNER.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" };
  const lop = async (over: Record<string, unknown> = {}) => ({
    chainId: 1,
    clientRequestId: "test-fh-0001",
    action: { type: "lop-order", order, signature: await signLop(1, order), side: "SELL", premium: 4.1, expiry: 0, nonce: "0", allowsPartialFills: true, ...over },
  });

  it("F3: listing fields contradicting the signed makerTraits → conflict listing_traits_mismatch, NOT relayed", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({ expiry: 1795000000 }), ctxWith([{ match: "/limit-orders", status: 201, body: {} }], seen));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("listing_traits_mismatch");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);

    const partialLie = await runTool("cork_submit", await lop({ allowsPartialFills: false }), ctxWith([{ match: "/limit-orders", status: 201, body: {} }]));
    expect(partialLie.state).toBe("conflict");
    expect(partialLie.warnings[0]?.code).toBe("listing_traits_mismatch");
  });

  it("F3: a signature that does not recover to the maker → conflict, NOT relayed", async () => {
    const seen: Seen[] = [];
    const base = await lop();
    const forged = { ...base, action: { ...base.action, order: { ...order, maker: "0xc0ffee0000000000000000000000000000000001" } } };
    const env = await runTool("cork_submit", forged, ctxWith([{ match: "/limit-orders", status: 201, body: {} }], seen));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("signature_or_reconstruction_mismatch");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("F14: a rollover order whose signature does not recover to order.user → conflict, NOT relayed", async () => {
    const seen: Seen[] = [];
    const tampered = JSON.parse(JSON.stringify(TOOL_EXAMPLES.cork_submit![0]!.input)) as { action: { order: { orderSize: string } } };
    tampered.action.order.orderSize = "999"; // digest changes → the example's real signature no longer matches
    const env = await runTool("cork_submit", tampered, ctxWith([{ match: "/rollover/orders", status: 201, body: {} }], seen));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("signature_or_reconstruction_mismatch");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("F14: submit re-runs the settler-mode gate the prepare path enforces", async () => {
    const seen: Seen[] = [];
    const flipped = JSON.parse(JSON.stringify(TOOL_EXAMPLES.cork_submit![0]!.input)) as { action: { order: Record<string, unknown> } };
    flipped.action.order.allowPartialFills = true; // example settler is the ExactSettler
    const env = await runTool("cork_submit", flipped, ctxWith([{ match: "/rollover/orders", status: 201, body: {} }], seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("settler_mode_mismatch");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("F5: an EXACTLY-100x premium divergence is blocked (the float ratio rounded to 99.99999999999999)", async () => {
    const rfq = { rfq_id: "rfq_1", answers: [{ answer_id: "ans_1", answer: { options: [{ option_id: "1", premium_annualized: "0.041" }] } }] };
    const env = await runTool(
      "cork_submit",
      await lop({ premium: 410, quoteRef: { rfqId: "rfq_1", answerId: "ans_1", optionId: "1" } }),
      ctxWith([{ match: "/rfqs/rfq_1", body: rfq }, { match: "/limit-orders", status: 201, body: {} }]),
    );
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("premium_scale_mismatch");
  });

  it("F5: a cited option with no parsable premium is a conflict, not a silent skip", async () => {
    const rfq = { rfq_id: "rfq_1", answers: [{ answer_id: "ans_1", answer: { options: [{ option_id: "1" }] } }] };
    const env = await runTool(
      "cork_submit",
      await lop({ quoteRef: { rfqId: "rfq_1", answerId: "ans_1", optionId: "1" } }),
      ctxWith([{ match: "/rfqs/rfq_1", body: rfq }, { match: "/limit-orders", status: 201, body: {} }]),
    );
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("quote_ref_unverifiable");
  });

  it("F5: the rfq-answer 0.5 cap is decided on the string — a 17-digit just-under value passes, 0.5 fails", async () => {
    const answer = (p: string) => ({ chainId: 42161, clientRequestId: "test-edge-0001", action: { type: "rfq-answer", rfqId: "rfq_1", underwriter: "0xc0ffee0000000000000000000000000000000001", status: "quoted", options: [{ option_id: "1", premium_annualized: p }], signature: "0x00" } });
    const justUnder = await runTool("cork_submit", answer("0.49999999999999999"), ctxWith([{ match: "/rfqs/rfq_1/answers", status: 201, body: { answer_id: "a" } }]));
    expect(justUnder.state).toBe("ok"); // Number("0.49999999999999999") === 0.5 falsely rejected this before
    const atCap = await runTool("cork_submit", answer("0.5"), ctxWith([]));
    expect(atCap.state).toBe("unavailable");
    expect(atCap.warnings[0]?.code).toBe("invalid_order_terms");
  });

  it("F6: rfq-open validates the window and validUntil like its rollover sibling", async () => {
    const seen: Seen[] = [];
    const base = JSON.parse(JSON.stringify(TOOL_EXAMPLES.cork_submit![1]!.input)) as { action: Record<string, unknown> };
    const inverted = JSON.parse(JSON.stringify(base));
    (inverted.action.expiryWindow as { notBefore: number; notAfter: number }).notBefore = 1795604800;
    (inverted.action.expiryWindow as { notBefore: number; notAfter: number }).notAfter = 1795000000;
    const r1 = await runTool("cork_submit", inverted, ctxWith([{ match: "/rfqs", status: 201, body: {} }], seen));
    expect(r1.state).toBe("unavailable");
    expect(r1.warnings[0]?.message).toContain("inverted");

    const expired = JSON.parse(JSON.stringify(base));
    (expired.action as { validUntil: number }).validUntil = Number(NOW) - 10;
    const r2 = await runTool("cork_submit", expired, ctxWith([{ match: "/rfqs", status: 201, body: {} }], seen));
    expect(r2.state).toBe("unavailable");
    expect(r2.warnings[0]?.message).toContain("validUntil");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
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
        { match: "/limit-orders/orderbook", body: { items: [] } },
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
        { match: "/limit-orders/orderbook", body: { items: [] } },
      ]),
    );
    expect(nowhere.state).toBe("unavailable");
    expect(nowhere.warnings[0]?.code).toBe("order_not_found");
  });
});

describe("R4: numbers-contract tripwires + quote_ref cross-check + extension orders", () => {
  const lopOrder = { salt: "123", maker: SIGNER.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" };
  const lopBaseP = (async () => ({
    chainId: 1,
    clientRequestId: "test-lop-r4-01",
    action: {
      type: "lop-order",
      order: lopOrder,
      signature: await signLop(1, lopOrder),
      side: "SELL",
      premium: 0.036, // a fraction pasted into the percent field
      expiry: 0, // makerTraits "0" encode no expiry — the listing must agree [F3]
      nonce: "0",
      allowsPartialFills: true,
    },
  }))();

  it("sub-0.1% premium → premium_scale_suspect warning (relayed, matching venue leniency)", async () => {
    const lopBase = await lopBaseP;
    const env = await runTool("cork_submit", lopBase, ctxWith([{ match: "/limit-orders", status: 201, body: { orderHash: "0x1" } }]));
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "premium_scale_suspect")).toBe(true);
  });

  it("quote_ref citing a diverging premium → conflict premium_scale_mismatch, NOT relayed", async () => {
    const seen: Seen[] = [];
    const lopBase = await lopBaseP;
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

  it("quote_ref band matches the BOOK's 10x acceptance: exactly-10x conflicts, ~9x (an honest re-price) relays", async () => {
    const lopBase = await lopBaseP;
    const rfq = { rfq_id: "rfq_1", answers: [{ answer_id: "ans_1", answer: { options: [{ option_id: "1", premium_annualized: "0.036" }] } }] };
    const at10x = await runTool(
      "cork_submit",
      { ...lopBase, action: { ...lopBase.action, premium: 36, quoteRef: { rfqId: "rfq_1", answerId: "ans_1", optionId: "1" } } },
      ctxWith([{ match: "/rfqs/rfq_1", body: rfq }, { match: "/limit-orders", status: 201, body: {} }]),
    );
    expect(at10x.state).toBe("conflict"); // 36% vs 3.6% = 10x — the venue's own rejection band, enforced early
    expect(at10x.warnings[0]?.code).toBe("premium_scale_mismatch");

    const rePrice = await runTool(
      "cork_submit",
      { ...lopBase, action: { ...lopBase.action, premium: 32, quoteRef: { rfqId: "rfq_1", answerId: "ans_1", optionId: "1" } } },
      ctxWith([{ match: "/rfqs/rfq_1", body: rfq }, { match: "/limit-orders", status: 201, body: { orderHash: "0x1" } }]),
    );
    expect(rePrice.state).toBe("ok"); // inside the band: tolerated as a re-price, exactly like the book
  });

  it("quote_ref with a consistent premium relays cleanly", async () => {
    const lopBase = await lopBaseP;
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
    // Structurally valid v4 extension: 32-byte offsets header (all fields empty) + customData.
    // (A bare "0xdeadbeefcafe" is now rejected — no offsets header means it would misparse at fill.)
    const ext = `0x${"00".repeat(32)}deadbeefcafe` as const;
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
    // The intent hash changed, so the order digest changed — re-sign the mutated order.
    (example.action as unknown as { signature: string }).signature = await signRollover(42161, example.action.order);
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
    const order = { salt: "1", maker: SIGNER.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1", takingAmount: "1", makerTraits: "0" };
    const env = await runTool(
      "cork_submit",
      { chainId: 1, clientRequestId: "test-qr-0001", action: { type: "lop-order", order, signature: await signLop(1, order), side: "SELL", premium: 3.6, expiry: 0, nonce: "0", allowsPartialFills: true, quoteRef: { rfqId: "rfq_missing", answerId: "a", optionId: "1" } } },
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
    expect(env.warnings[0]?.code).toBe("venue_unreachable"); // 5xx = server fault, retryable
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

  it("hasMore:true but no cursor to continue → incomplete (cursor_absent), disclosed not hidden", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "markets", chainId: 42161, pageSize: 25, format: "concise" },
      ctxWith([{ match: "/pools", body: { items: [{ poolId: "0xa" }], hasMore: true } }]),
    );
    expect(env.state).toBe("ok");
    expect(pgOf(env).reason).toBe("cursor_absent");
    expect(env.warnings[0]?.code).toBe("pagination_incomplete");
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

  // ── taker-side JIT: the walkthrough's canonical settle path (underwriter lifts a BUY order,
  // takerInteraction mints the cST into the fill gap) ──────────────────────────────────────
  describe("jitMarket on taker-fill", () => {
    const REG = "0x47C3AF38435Db64D9400c30575E4c10482c0752D";
    const ADAPTER = "0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B";
    const CONTROLLER = "0xdCC0388c68f85e65FA08dCb445B4d0927e9E6172";
    const LIQ = "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D";
    const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
    const CPT = "0xc37d9aCe13C63806c6fA475aD507E94c70b6e110";
    const ORACLE = "0x00000000000000000000000000000000000000fe";
    const WAD = 10n ** 18n;
    const ZERO = "0x0000000000000000000000000000000000000000";
    const sharesWord = (a: string) => "000000000000000000000000" + a.replace(/^0x/, "").toLowerCase();
    // A BUY-cover resting order: maker pays sUSDe premium, receives the (predicted) cST.
    const buyOrderT: LopOrder = { salt: 7n, maker: MAKER, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: CST.toLowerCase() as `0x${string}`, makingAmount: 100n, takingAmount: 200n, makerTraits: 0n };
    const buyOrderWire = { salt: "7", maker: MAKER, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: CST.toLowerCase(), makingAmount: "100", takingAmount: "200", makerTraits: "0" };
    const buyHash = hashLopOrder(42161, LOP, buyOrderT);
    const buyRow = { orderHash: buyHash, order: buyOrderWire, signature: SIG, extension: "0x" };
    const jm = { collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610", expiryTimestamp: "1795000000", recipe: LIQ };
    const rpcStub = (over?: (c: StubCall) => unknown, code?: Record<string, string>) =>
      stubRpc(
        (c) => {
          const o = over?.(c);
          if (o !== undefined) return o;
          if (c.functionName === "LIMIT_ORDER_PROTOCOL") return LOP;
          if (c.functionName === "MARKET_REGISTRY") return REG;
          if (c.functionName === "CONTROLLER") return CONTROLLER;
          if (c.functionName === "hasRole") return true;
          if (c.functionName === "isRecipe") return true;
          if (c.functionName === "source") return 1;
          if (c.functionName === "lookupWrapper") return ORACLE;
          if (c.functionName === "rate") return WAD;
          if (c.functionName === "resolve") return { rateMin: 1n, rateMax: 2n * WAD, rateChangePerDayMax: WAD, rateChangeCapacityMax: 3n * WAD };
          if (c.functionName === "verify") return true;
          if (c.functionName === "shares") return [ZERO, ZERO];
          throw new Error(`unexpected ${c.functionName}`);
        },
        { simulateCalls: () => ({ results: [{ status: "success", data: "0x" }, { status: "success", data: "0x" + sharesWord(CPT) + sharesWord(CST) }] }), code },
      );
    const fillJit = (extra: Record<string, unknown> = {}, over?: (c: StubCall) => unknown, row: Record<string, unknown> = buyRow, code?: Record<string, string>) =>
      runTool(
        "cork_prepare_orders",
        { chainId: 42161, account: "0x00000000000000000000000000000000000000dd", clientRequestId: "test-fill-jit-0001", action: { type: "taker-fill", orderHash: (row["orderHash"] as string) ?? buyHash, jitMarket: { ...jm, ...extra } }, format: "concise" },
        { ...ctxWith([{ match: "/limit-orders/orderbook", body: { items: [row], hasMore: false } }]), nowSeconds: 1_790_000_000n, resolveRpc: rpcStub(over, code) },
      );

    it("builds the interaction (adapter ++ extraData), packs its length at bits 200-223, and reports the taker-side jit data", async () => {
      const env = await fillJit();
      expect(env.state).toBe("ok");
      const d = env.data as { fillFunction: string; takerTraits: string; calldata: string; jit: Record<string, unknown> };
      expect(d.fillFunction).toBe("fillOrderArgs");
      expect((BigInt(d.takerTraits) >> 200n) & 0xffffffn).toBeGreaterThan(0n);
      // The interaction is args verbatim (no extension on this order) and its FIRST 20 bytes must
      // be the adapter — the fill dispatches to whatever address leads these bytes.
      const decodedArgs = decodeFunctionData({ abi: parseAbi(["function fillOrderArgs((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) o, bytes32 r, bytes32 vs, uint256 a, uint256 t, bytes args)"]), data: d.calldata as `0x${string}` });
      expect(String(decodedArgs.args[5]).slice(0, 42).toLowerCase()).toBe(ADAPTER.toLowerCase());
      expect(String(d.jit["hook"])).toContain("takerInteraction");
      expect(String(d.jit["predictedCorkSwapToken"]).toLowerCase()).toBe(CST.toLowerCase());
      expect(String(d.jit["permitNote"])).toContain("TAKER as owner");
      expect(env.warnings.some((w) => w.code === "jit_side_mismatch")).toBe(false); // order.takerAsset IS the derived cST
      expect(env.warnings.some((w) => w.code === "roles_not_granted")).toBe(false); // stub grants both roles — the live path stays silent
    });

    it("a resting order whose side is another pool's LIVE share contract → stale_share_prediction (the consumed-nonce diagnosis, mutation killer)", async () => {
      // The 2026-08-04 live failure: the venue's first new-generation batch carried predicted
      // cST addresses that interleaving pool creations had consumed — every fill reverted
      // OrderNotForPool. The order here names a takerAsset with code that reports a FOREIGN
      // poolId; the tool must say WHY the order is dead, not just that it is.
      const FOREIGN = "0x000000000000000000000000000000000000f0e1" as const;
      const FOREIGN_POOL = `0x${"deadbeef".repeat(8)}`;
      const staleOrderT: LopOrder = { ...buyOrderT, takerAsset: FOREIGN };
      const staleHash = hashLopOrder(42161, LOP, staleOrderT);
      const staleRow = { orderHash: staleHash, order: { ...buyOrderWire, takerAsset: FOREIGN }, signature: SIG, extension: "0x" };
      const env = await fillJit({}, (c) => (c.functionName === "poolId" ? FOREIGN_POOL : undefined), staleRow, { [FOREIGN]: "0x6080" });
      expect(env.state).toBe("ok");
      expect(env.warnings.some((w) => w.code === "jit_side_mismatch")).toBe(true);
      const w = env.warnings.find((x) => x.code === "stale_share_prediction");
      expect(w).toBeDefined();
      expect(w?.message).toContain("takerAsset");
      expect(w?.message).toContain(FOREIGN_POOL);
      expect(w?.message).toContain("consumed");
    });

    it("taker pre-flight: a PARTIAL role grant warns and names the missing role (mutation killer for the taker roles gate)", async () => {
      // Creator granted, configurator missing — keyed on the role hash so a swapped-constant
      // mutant flips the per-role truth and a dropped-warning mutant goes silent. Both die here.
      const env = await fillJit({}, (c) => (c.functionName === "hasRole" ? c.args?.[0] === POOL_CREATOR_ROLE : undefined));
      expect(env.state).toBe("ok");
      const w = env.warnings.find((x) => x.code === "roles_not_granted");
      expect(w).toBeDefined();
      expect(w?.message).toContain("POOL_CREATOR: true");
      expect(w?.message).toContain("CONFIGURATOR: false");
    });

    it("UNDEPLOYED oracle on the taker path: the share simulation prepends the fill's own deploy (mutation killer for the taker preCalls branch)", async () => {
      const env = await fillJit({ additionalData: `0x${WAD.toString(16).padStart(64, "0")}` }, (c) => {
        if (c.functionName === "lookupWrapper") return ZERO; // NOT deployed
        if (c.functionName === "simulate:deploy") return ORACLE;
        return undefined;
      });
      // rpcStub's simulateCalls returns only 2 results — with the deploy prepended the SHARES leg
      // sits at index 2 and is absent, so the prediction must degrade honestly (never misread
      // the create-leg data as share addresses).
      expect(env.state).toBe("ok");
      const d = env.data as { jit: Record<string, unknown> };
      expect(String(d.jit["oracle"] && (d.jit["oracle"] as Record<string, unknown>)["deployed"])).toBe("false");
      expect(d.jit["predictedCorkSwapToken"]).toBeUndefined();
      expect(env.warnings.some((w) => w.code === "share_prediction_unavailable")).toBe(true);
    });

    it("rejects jitMarket + raw interaction together (mutually exclusive)", async () => {
      await expect(
        runTool(
          "cork_prepare_orders",
          { chainId: 42161, account: "0x00000000000000000000000000000000000000dd", clientRequestId: "test-fill-jit-0002", action: { type: "taker-fill", orderHash: buyHash, interaction: "0xdeadbeef", jitMarket: jm }, format: "concise" },
          { ...ctxWith([{ match: "/limit-orders/orderbook", body: { items: [buyRow], hasMore: false } }]), nowSeconds: 1_790_000_000n, resolveRpc: rpcStub() },
        ),
      ).rejects.toThrow(/invalid input/);
    });

    it("a resting order carrying its OWN jit extension pins the market: mismatched taker params → conflict marketid_mismatch", async () => {
      // The maker signed for a DIFFERENT expiry; the taker's params derive a different pool id.
      const makerExt = buildJitExtension(ADAPTER, encodeJitExtraData({ collateralAsset: jm.collateralAsset as `0x${string}`, referenceAsset: jm.referenceAsset as `0x${string}`, expiryTimestamp: 1_796_000_000n, recipe: LIQ, rateOverride: 0n, constraint: { rateMin: 1n, rateMax: 2n * WAD, rateChangePerDayMax: WAD, rateChangeCapacityMax: 3n * WAD }, additionalData: "0x", swapFeePercentage: 0n, unwindSwapFeePercentage: 0n, enableJitMint: false }));
      const rowWithExt = { ...buyRow, extension: makerExt };
      const env = await fillJit({}, undefined, rowWithExt);
      expect(env.state).toBe("conflict");
      expect(env.warnings[0]?.code).toBe("marketid_mismatch");
      expect(env.warnings[0]?.message).toContain("decode order");
    });

    it("offline with an explicit constraint: interaction still builds, skipped pre-flights disclosed", async () => {
      const env = await runTool(
        "cork_prepare_orders",
        { chainId: 42161, account: "0x00000000000000000000000000000000000000dd", clientRequestId: "test-fill-jit-0003", action: { type: "taker-fill", orderHash: buyHash, jitMarket: { ...jm, constraint: { rateMin: "1", rateMax: (2n * WAD).toString(), rateChangePerDayMax: WAD.toString(), rateChangeCapacityMax: (3n * WAD).toString() } } }, format: "concise" },
        { ...ctxWith([{ match: "/limit-orders/orderbook", body: { items: [buyRow], hasMore: false } }]), nowSeconds: 1_790_000_000n, resolveRpc: async () => null },
      );
      expect(env.state).toBe("ok");
      expect((env.data as { jit: unknown }).jit).toBeDefined();
      expect(env.warnings.some((w) => w.code === "funding_needs_rpc")).toBe(true);
    });

    it("offline WITHOUT a constraint → requires_rpc teaching where the constraint comes from", async () => {
      const env = await runTool(
        "cork_prepare_orders",
        { chainId: 42161, account: "0x00000000000000000000000000000000000000dd", clientRequestId: "test-fill-jit-0004", action: { type: "taker-fill", orderHash: buyHash, jitMarket: jm }, format: "concise" },
        { ...ctxWith([{ match: "/limit-orders/orderbook", body: { items: [buyRow], hasMore: false } }]), nowSeconds: 1_790_000_000n, resolveRpc: async () => null },
      );
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe("requires_rpc");
    });
  });
});

// ── auction-priced resting orders on taker-fill (fusion F2, the fill side) ───────────────────
// The amount getter charges the DECAYED price, so the default slippage cap must be the curve's
// CEILING — a floor-based cap (the plain signed ratio) reverts TakingAmountTooHigh for the whole
// decay window, making the default artifact dead bytes.
describe("taker-fill of an auction-priced resting order", () => {
  const LOP = LOP_ADDRESSES[42161]!;
  const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  const NOW2 = 1_790_000_000n;
  const THRESHOLD_MASK = (1n << 185n) - 1n;
  const auction = { gasBumpEstimate: 0n, gasPriceEstimate: 0n, startTime: NOW2 - 600n, duration: 3600n, initialRateBump: 1_000_000n, points: [] as { rateBump: bigint; timeDelta: bigint }[] };
  const mkRow = (ext: `0x${string}`) => {
    const built = buildMakerOrder({ chainId: 42161, lop: LOP, maker: "0x00000000000000000000000000000000000000a1", makerAsset: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", takerAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610", makingAmount: 10n ** 18n, takingAmount: 1_000_000n, clientRequestId: "auction-row-0001", extension: ext });
    const o = built.order;
    const wire = { salt: o.salt.toString(), maker: o.maker, receiver: o.receiver, makerAsset: o.makerAsset, takerAsset: o.takerAsset, makingAmount: o.makingAmount.toString(), takingAmount: o.takingAmount.toString(), makerTraits: o.makerTraits.toString() };
    return { built, row: { orderHash: built.orderHash, order: wire, signature: SIG, extension: built.extension } };
  };
  const fill = (row: Record<string, unknown>, orderHash: string, extra: Record<string, unknown> = {}) =>
    runTool(
      "cork_prepare_orders",
      { chainId: 42161, account: "0x00000000000000000000000000000000000000dd", clientRequestId: "auction-fill-0001", action: { type: "taker-fill", orderHash, ...extra }, format: "concise" },
      { ...ctxWith([{ match: "/limit-orders/orderbook", body: { items: [row], hasMore: false } }]), nowSeconds: NOW2 },
    );

  it("defaults the slippage cap to the curve CEILING (not the floor) and reports current/floor prices", async () => {
    const { makingAmountData, takingAmountData } = buildAuctionAmountData(42161, auction);
    const { built, row } = mkRow(encodeExtensionFields({ makingAmountData, takingAmountData }));
    const env = await fill(row, built.orderHash);
    expect(env.state).toBe("ok");
    const d = env.data as { takerTraits: string; auction: Record<string, unknown> };
    // ceiling = ceil(1_000_000 * (1e7 + 1e6) / 1e7) = 1_100_000 — NOT the signed floor 1_000_000.
    expect((BigInt(d.takerTraits) & THRESHOLD_MASK).toString()).toBe("1100000");
    expect(d.auction["ceilingTakerPays"]).toBe("1100000");
    expect(d.auction["floorTakerPays"]).toBe("1000000");
    expect(d.auction["phase"]).toBe("decaying");
    // current at 600s into 3600s: bump 833333 → ceil(1_000_000 * 10833333 / 1e7) = 1083334.
    expect(d.auction["currentTakerPays"]).toBe("1083334");
    expect(env.warnings.some((w) => w.code === "decaying_price_notice")).toBe(true);
  });

  it("an explicit cap BELOW the current decayed price is respected but disclosed as would_revert-for-now", async () => {
    const { makingAmountData, takingAmountData } = buildAuctionAmountData(42161, auction);
    const { built, row } = mkRow(encodeExtensionFields({ makingAmountData, takingAmountData }));
    const env = await fill(row, built.orderHash, { maximumTakingAmount: "1000001" });
    expect(env.state).toBe("ok");
    const d = env.data as { takerTraits: string };
    expect((BigInt(d.takerTraits) & THRESHOLD_MASK).toString()).toBe("1000001");
    expect(env.warnings.some((w) => w.code === "would_revert")).toBe(true);
  });

  it("a FOREIGN curve with a point ABOVE initialRateBump: the ceiling uses the curve MAXIMUM (mutation killer for the maxBump fold)", async () => {
    // Our own encoder refuses non-decaying points, so patch the bytes: point 0x0ABCDE (703710)
    // → 0x1ABCDE (1752286) > initial 1_000_000. The parser accepts it; the safe cap must too.
    const withPoint = { ...auction, points: [{ rateBump: 0x0abcden, timeDelta: 600n }] };
    const { makingAmountData } = buildAuctionAmountData(42161, withPoint);
    expect(makingAmountData).toContain("0abcde");
    const patched = makingAmountData.replace("0abcde", "1abcde") as `0x${string}`;
    const { built, row } = mkRow(encodeExtensionFields({ makingAmountData: patched, takingAmountData: patched }));
    const env = await fill(row, built.orderHash);
    expect(env.state).toBe("ok");
    const d = env.data as { takerTraits: string; auction: Record<string, unknown> };
    // ceiling = ceil(1_000_000 * (1e7 + 1_752_286) / 1e7) = 1_175_229 — the POINT's bump, not initial's.
    expect((BigInt(d.takerTraits) & THRESHOLD_MASK).toString()).toBe("1175229");
    expect(d.auction["ceilingTakerPays"]).toBe("1175229");
  });

  it("a plain (non-auction) resting order gets NO auction block and keeps the signed-ratio cap", async () => {
    const { built, row } = mkRow("0x");
    const env = await fill(row, built.orderHash);
    expect(env.state).toBe("ok");
    const d = env.data as { takerTraits: string; auction?: unknown };
    expect(d.auction).toBeUndefined();
    expect((BigInt(d.takerTraits) & THRESHOLD_MASK).toString()).toBe("1000000");
    expect(env.warnings.some((w) => w.code === "decaying_price_notice")).toBe(false);
  });
});
