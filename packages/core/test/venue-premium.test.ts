// The listing premium contract (cork-api 0.3.15): premium_annualized is the ONE premium
// field — the percent-number `premium` completed its scheduled sunset on 2026-08-17 and the
// venue answers a pointed 400 on presence (a preValidation gate, not a silent schema strip).
// The venue's RESOLUTION is replicated operation-for-operation from its post-order route —
// removed-field refusal, fraction required, canonicalized by parseFloat × 100 — so every local
// gate compares exactly what the venue will.
// Offline: the venue is a fetch stub; the signature is a real secp256k1 signing of the real
// EIP-712 order hash (no mocked crypto).
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hashLopOrder, parseSignedLopOrder, runTool, type HandlerContext } from "@cork/core";

const SIGNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const NOW = 1_790_000_000n;
const LOP_MAINNET = "0x111111125421cA6dc452d289314280a0f8842A65" as const;
const WAD_1 = `1${"0".repeat(18)}`; // 1e18 as a base-unit string

interface Seen {
  url: string;
  method: string;
  body?: unknown;
}

function ctxWith(routes: Array<{ match: string; status?: number; body: unknown }>, seen: Seen[] = []): HandlerContext {
  const venueFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const r = routes.find((r) => url.includes(r.match));
    if (!r) return new Response(JSON.stringify({ statusCode: 404, error: "Not Found", message: `no stub for ${url}` }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { nowSeconds: NOW, resolveRpc: async () => null, venueFetch };
}

const order = {
  salt: "123",
  maker: SIGNER.address,
  receiver: `0x${"00".repeat(20)}`,
  makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
  makingAmount: WAD_1,
  takingAmount: `1${"0".repeat(6)}`,
  makerTraits: "0",
};

const signOrder = () =>
  SIGNER.sign({
    hash: hashLopOrder(1, LOP_MAINNET, {
      salt: BigInt(order.salt),
      maker: order.maker as `0x${string}`,
      receiver: order.receiver as `0x${string}`,
      makerAsset: order.makerAsset as `0x${string}`,
      takerAsset: order.takerAsset as `0x${string}`,
      makingAmount: BigInt(order.makingAmount),
      takingAmount: BigInt(order.takingAmount),
      makerTraits: BigInt(order.makerTraits),
    }),
  });

const lop = async (over: Record<string, unknown> = {}, drop: string[] = []) => {
  const action: Record<string, unknown> = { type: "lop-order", order, signature: await signOrder(), side: "SELL", premiumAnnualized: "0.041", expiry: 0, nonce: "0", allowsPartialFills: true, ...over };
  for (const k of drop) delete action[k];
  return { chainId: 1, clientRequestId: "test-pa-0001", action };
};
// The venue omits orderHash on accept; a contradicting echo is a conflict and has its own
// test in venue.test.ts, so these premium fixtures keep the clean shape.
const ok201 = (seen: Seen[] = []) => ctxWith([{ match: "/limit-orders/v1", status: 201, body: {} }], seen);
const postBody = (seen: Seen[]) => seen.find((s) => s.method === "POST")!.body as Record<string, unknown>;

describe("listing premium — the venue's 0.3.15 resolution, op-for-op", () => {
  it("premiumAnnualized is required — its absence is taught before the wire", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({}, ["premiumAnnualized"]), ok201(seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toContain("premiumAnnualized");
    expect(env.warnings[0]!.message).toContain("2026-08-17");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("relays premium_annualized and NO percent key — the ×100 step is retired", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop(), ok201(seen));
    expect(env.state).toBe("ok");
    expect(postBody(seen).premium_annualized).toBe("0.041");
    expect("premium" in postBody(seen)).toBe(false);
    expect(env.warnings.map((w) => w.code)).not.toContain("deprecation_notice");
  });

  it("the REMOVED percent field is refused on presence — the venue's pointed 400, pre-flighted with a converted suggestion", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({ premium: 4.1 }, ["premiumAnnualized"]), ok201(seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toContain("REMOVED");
    expect(env.warnings[0]!.message).toContain('"0.041"'); // the exact fraction spelling for 4.1%
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("the removed field is refused even when the fraction is ALSO present (nothing relays a 400-bound payload)", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({ premium: 4.1 }), ok201(seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.message).toContain("REMOVED");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("the book fraction gate is layered like the RFQ one: shape is STRUCTURE, the 100 bound is POLICY — and the RFQ's 0.5 cap does NOT apply", async () => {
    const shape = await runTool("cork_submit", await lop({ premiumAnnualized: "4.1%" }), ok201());
    expect(shape.state).toBe("unavailable");
    expect(shape.warnings[0]!.message).toContain("STRUCTURE");
    const bound = await runTool("cork_submit", await lop({ premiumAnnualized: "100.1" }), ok201());
    expect(bound.state).toBe("unavailable");
    expect(bound.warnings[0]!.message).toContain("POLICY");
    // Values the venue accepts must relay: exactly 100 (its refine is <= 100); 0.5 (the 0.5 cap
    // is RFQ-only); and 100 followed by 18 zeros-then-1 — syntactically above the bound but
    // parseFloat (the venue's own comparator) collapses it to exactly 100, so the venue takes
    // it and a "stricter" local gate would out-reject the venue.
    for (const legal of ["100", "0.5", `100.${"0".repeat(17)}1`]) {
      const env = await runTool("cork_submit", await lop({ premiumAnnualized: legal }), ok201());
      expect(env.state, `"${legal}" must relay`).toBe("ok");
    }
  });

  it("suspect tripwires fire on the CANONICAL percent: a sub-0.1% fraction and a percent-looking fraction both warn, both relay", async () => {
    const tiny = await runTool("cork_submit", await lop({ premiumAnnualized: "0.0005" }), ok201());
    expect(tiny.state).toBe("ok");
    expect(tiny.warnings.some((w) => w.code === "premium_scale_suspect" && w.message.includes("below 0.1%"))).toBe(true);
    const pasted = await runTool("cork_submit", await lop({ premiumAnnualized: "4.1" }), ok201());
    expect(pasted.state).toBe("ok");
    const warn = pasted.warnings.find((w) => w.code === "premium_scale_suspect")!;
    expect(warn.message).toContain('write "0.041"');
  });

  it("quote_ref band runs on the canonical percent — a fraction-declared order needs NO ×100 of its own", async () => {
    const rfq = (fraction: string) => ({ match: "/rfqs/v1/rfq_p", body: { rfq_id: "rfq_p", request: { requester: SIGNER.address }, answers: [{ answer_id: "ans_1", answer: { options: [{ option_id: "1", premium_annualized: fraction }] } }] } });
    const quoteRef = { rfqId: "rfq_p", answerId: "ans_1", optionId: "1" };
    const good = await runTool("cork_submit", await lop({ premiumAnnualized: "0.041", quoteRef }), ctxWith([rfq("0.036"), { match: "/limit-orders/v1", status: 201, body: {} }]));
    expect(good.state).toBe("ok");
    const seen: Seen[] = [];
    const far = await runTool("cork_submit", await lop({ premiumAnnualized: "0.5", quoteRef }), ctxWith([rfq("0.036"), { match: "/limit-orders/v1", status: 201, body: {} }], seen));
    expect(far.state).toBe("conflict");
    expect(far.warnings[0]!.code).toBe("premium_scale_mismatch");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("wire vocabulary: our ERC1271 posts as the venue's CONTRACT (posting ERC1271 verbatim was schema-rejected at the venue)", async () => {
    const seen: Seen[] = [];
    const rpcMagic = async () => ({ url: "stub", source: "explicit" as const, client: { readContract: async () => "0x1626ba7e", getCode: async () => "0x60" } as never });
    const env = await runTool("cork_submit", await lop({ makerAccountType: "ERC1271", signature: "0x1234" }), { ...ok201(seen), resolveRpc: rpcMagic } as HandlerContext);
    expect(env.state).toBe("ok");
    expect(postBody(seen).makerAccountType).toBe("CONTRACT");
    const seenEoa: Seen[] = [];
    await runTool("cork_submit", await lop(), ok201(seenEoa));
    expect(postBody(seenEoa).makerAccountType).toBe("EOA");
  });

  it("a venue row saying CONTRACT parses as our ERC1271 (every contract-maker row failed row validation before)", () => {
    const row = { ...order, signature: "0x1234", makerAccountType: "CONTRACT", extension: "" };
    const parsed = parseSignedLopOrder(row);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.makerAccountType).toBe("ERC1271");
  });

  it("a successful relay surfaces the venue's in-band warnings[] as venue_notice", async () => {
    const body = { warnings: [{ code: "limit-orders-premium-pct-deprecated", message: "removed 2026-08-17" }] };
    const env = await runTool("cork_submit", await lop(), ctxWith([{ match: "/limit-orders/v1", status: 201, body }]));
    expect(env.state).toBe("ok");
    const notice = env.warnings.find((w) => w.code === "venue_notice")!;
    expect(notice.message).toContain("limit-orders-premium-pct-deprecated");
  });

  it("finalize-maker-order: a premium-less listing refuses BEFORE the signature ceremony; a fraction listing rides into submitInput", async () => {
    // The wire form the caller round-trips back (the handlers.test.ts finalize idiom).
    const orderHash = hashLopOrder(1, LOP_MAINNET, {
      salt: BigInt(order.salt),
      maker: order.maker as `0x${string}`,
      receiver: order.receiver as `0x${string}`,
      makerAsset: order.makerAsset as `0x${string}`,
      takerAsset: order.takerAsset as `0x${string}`,
      makingAmount: BigInt(order.makingAmount),
      takingAmount: BigInt(order.takingAmount),
      makerTraits: BigInt(order.makerTraits),
    });
    const prepared = { kind: "maker-order", lop: LOP_MAINNET, typedData: { domain: { chainId: 1, verifyingContract: LOP_MAINNET }, message: { ...order } }, orderHash, extension: "0x", clientRequestId: "test-pa-fin1" };
    const sig = await signOrder();
    const listing = { side: "SELL", expiry: 0, nonce: "0", allowsPartialFills: true };
    const base = { chainId: 1, account: SIGNER.address, clientRequestId: "test-pa-fin1", action: { type: "finalize-maker-order", prepared, signature: sig, listing } };
    const missing = await runTool("cork_prepare_orders", base, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(missing.state).toBe("unavailable");
    expect(missing.warnings[0]!.code).toBe("invalid_order_terms");
    expect(missing.warnings[0]!.message).toContain("premiumAnnualized");
    const withFraction = { ...base, action: { ...base.action, listing: { ...listing, premiumAnnualized: "0.041" } } };
    const fin = await runTool("cork_prepare_orders", withFraction, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(fin.state).toBe("ok");
    const submitAction = (fin.data as { submitInput: { action: Record<string, unknown> } }).submitInput.action;
    expect(submitAction.premiumAnnualized).toBe("0.041");
    expect("premium" in submitAction).toBe(false);
    // finalize runs the FULL relay resolution: a submitInput that would be refused at submit
    // must never be emitted for a policy gate to admit.
    const badShape = { ...base, action: { ...base.action, listing: { ...listing, premiumAnnualized: "4.1%" } } };
    const refused = await runTool("cork_prepare_orders", badShape, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(refused.state).toBe("unavailable");
    expect(refused.warnings[0]!.message).toContain("STRUCTURE");
    // and a listing still carrying the REMOVED percent field refuses with the relay's teaching.
    const pct = { ...base, action: { ...base.action, listing: { ...listing, premium: 4.1 } } };
    const finPct = await runTool("cork_prepare_orders", pct, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(finPct.state).toBe("unavailable");
    expect(finPct.warnings[0]!.code).toBe("invalid_order_terms");
    expect(finPct.warnings[0]!.message).toContain("REMOVED");
  });
});

describe("percentToFractionString — the suggestion is exact string math, never float division", () => {
  it("shifts the decimal point exactly, and every suggestion passes the very gate it teaches", async () => {
    const { percentToFractionString, bookPremiumAnnualizedViolation } = await import("../src/handlers/submit.ts");
    for (const [pct, want] of [
      [4.1, "0.041"], // float division would say 0.040999999999999995
      [0.036, "0.00036"],
      [100, "1"],
      [2500, "25"], // above the retired local 1000 cap — legal under the venue's old 10000
      [0.5, "0.005"],
      [12.34, "0.1234"],
    ] as const) {
      expect(percentToFractionString(pct)).toBe(want);
      expect(bookPremiumAnnualizedViolation(want)).toBeNull();
    }
    // A canonical repr string math cannot shift (scientific notation) yields NO suggestion —
    // better none than one that fails the pattern gate.
    expect(percentToFractionString(1e21)).toBeUndefined();
    expect(percentToFractionString(1e-7)).toBeUndefined();
  });

  it("out-of-old-cap legacy values (premium: 2500) reach the REMOVED teaching, not a bare shape error", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({ premium: 2500 }, ["premiumAnnualized"]), ok201(seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toContain("REMOVED");
    expect(env.warnings[0]!.message).toContain('"25"'); // the exact fraction spelling for 2500%
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
});
