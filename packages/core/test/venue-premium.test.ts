// The premium_annualized migration (cork-api 0.3.3, COR-35): the venue's premium RESOLUTION is
// replicated operation-for-operation from its post-order route — at least one spelling, fraction
// canonicalized by parseFloat × 100, both-sent agreement within an exact 1e-9-relative
// comparison, fraction precedence — so every local gate compares exactly what the venue will.
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
  const action: Record<string, unknown> = { type: "lop-order", order, signature: await signOrder(), side: "SELL", premium: 4.1, expiry: 0, nonce: "0", allowsPartialFills: true, ...over };
  for (const k of drop) delete action[k];
  return { chainId: 1, clientRequestId: "test-pa-0001", action };
};
const ok201 = (seen: Seen[] = []) => ctxWith([{ match: "/limit-orders/v1", status: 201, body: { orderHash: "0xdead" } }], seen);
const postBody = (seen: Seen[]) => seen.find((s) => s.method === "POST")!.body as Record<string, unknown>;

describe("premium_annualized migration — the venue's resolution, op-for-op", () => {
  it("at least one premium spelling is required — the venue's own rule, taught before the wire", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({}, ["premium"]), ok201(seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toContain("premiumAnnualized");
    expect(env.warnings[0]!.message).toContain("2026-08-17");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("fraction-only relays premium_annualized and NO percent key — the ×100 step is retired", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({ premiumAnnualized: "0.041" }, ["premium"]), ok201(seen));
    expect(env.state).toBe("ok");
    expect(postBody(seen).premium_annualized).toBe("0.041");
    expect("premium" in postBody(seen)).toBe(false);
    expect(env.warnings.map((w) => w.code)).not.toContain("deprecation_notice");
  });

  it("percent-only still relays (compat window) but carries the dated deprecation_notice", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop(), ok201(seen));
    expect(env.state).toBe("ok");
    expect(postBody(seen).premium).toBe(4.1);
    expect("premium_annualized" in postBody(seen)).toBe(false);
    const note = env.warnings.find((w) => w.code === "deprecation_notice")!;
    expect(note.message).toContain("2026-08-17");
    expect(note.message).toContain("premiumAnnualized");
  });

  it("both fields agreeing (within the venue's exact 1e-9-relative comparison) relay BOTH", async () => {
    // 0.041 × 100 floats a hair above 4.1 — the venue's tolerance absorbs exactly this.
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({ premiumAnnualized: "0.041" }), ok201(seen));
    expect(env.state).toBe("ok");
    expect(postBody(seen).premium).toBe(4.1);
    expect(postBody(seen).premium_annualized).toBe("0.041");
    // The tolerance is RELATIVE (scaled by Math.max(1, …) like the venue's): at premium 100, a
    // 5e-8-percent difference sits inside 1e-9 × 100 but outside a bare 1e-9 — this case is
    // what tells the venue's scaled comparison apart from an absolute one.
    const scaled = await runTool("cork_submit", await lop({ premium: 100, premiumAnnualized: "1.0000000005" }), ok201());
    expect(scaled.state).toBe("ok");
  });

  it("both fields disagreeing → conflict premium_fields_disagree, NOT relayed (the venue's hard 400, pre-flighted)", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await lop({ premiumAnnualized: "0.41" }), ok201(seen));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("premium_fields_disagree");
    expect(env.warnings[0]!.message).toContain("percent-vs-fraction");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("the book fraction gate is layered like the RFQ one: shape is STRUCTURE, the 100 bound is POLICY — and the RFQ's 0.5 cap does NOT apply", async () => {
    const shape = await runTool("cork_submit", await lop({ premiumAnnualized: "4.1%" }, ["premium"]), ok201());
    expect(shape.state).toBe("unavailable");
    expect(shape.warnings[0]!.message).toContain("STRUCTURE");
    const bound = await runTool("cork_submit", await lop({ premiumAnnualized: "100.1" }, ["premium"]), ok201());
    expect(bound.state).toBe("unavailable");
    expect(bound.warnings[0]!.message).toContain("POLICY");
    // Values the venue accepts must relay: exactly 100 (its refine is <= 100); 0.5 (the 0.5 cap
    // is RFQ-only); and 100 followed by 18 zeros-then-1 — syntactically above the bound but
    // parseFloat (the venue's own comparator) collapses it to exactly 100, so the venue takes
    // it and a "stricter" local gate would out-reject the venue.
    for (const legal of ["100", "0.5", `100.${"0".repeat(17)}1`]) {
      const env = await runTool("cork_submit", await lop({ premiumAnnualized: legal }, ["premium"]), ok201());
      expect(env.state, `"${legal}" must relay`).toBe("ok");
    }
  });

  it("suspect tripwires fire on the CANONICAL percent: a sub-0.1% fraction and a percent-looking fraction both warn, both relay", async () => {
    const tiny = await runTool("cork_submit", await lop({ premiumAnnualized: "0.0005" }, ["premium"]), ok201());
    expect(tiny.state).toBe("ok");
    expect(tiny.warnings.some((w) => w.code === "premium_scale_suspect" && w.message.includes("below 0.1%"))).toBe(true);
    const pasted = await runTool("cork_submit", await lop({ premiumAnnualized: "4.1" }, ["premium"]), ok201());
    expect(pasted.state).toBe("ok");
    const warn = pasted.warnings.find((w) => w.code === "premium_scale_suspect")!;
    expect(warn.message).toContain('write "0.041"');
  });

  it("quote_ref band runs on the canonical percent — a fraction-declared order needs NO ×100 of its own", async () => {
    const rfq = (fraction: string) => ({ match: "/rfqs/v1/rfq_p", body: { rfq_id: "rfq_p", request: { requester: SIGNER.address }, answers: [{ answer_id: "ans_1", answer: { options: [{ option_id: "1", premium_annualized: fraction }] } }] } });
    const quoteRef = { rfqId: "rfq_p", answerId: "ans_1", optionId: "1" };
    const good = await runTool("cork_submit", await lop({ premiumAnnualized: "0.041", quoteRef }, ["premium"]), ctxWith([rfq("0.036"), { match: "/limit-orders/v1", status: 201, body: {} }]));
    expect(good.state).toBe("ok");
    const seen: Seen[] = [];
    const far = await runTool("cork_submit", await lop({ premiumAnnualized: "0.5", quoteRef }, ["premium"]), ctxWith([rfq("0.036"), { match: "/limit-orders/v1", status: 201, body: {} }], seen));
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
    const body = { orderHash: "0xdead", warnings: [{ code: "limit-orders-premium-pct-deprecated", message: "removed 2026-08-17" }] };
    const env = await runTool("cork_submit", await lop({ premiumAnnualized: "0.041" }, ["premium"]), ctxWith([{ match: "/limit-orders/v1", status: 201, body }]));
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
    // finalize runs the FULL relay resolution, not just at-least-one: a submitInput that would
    // be refused at submit must never be emitted for a policy gate to admit.
    const disagree = { ...base, action: { ...base.action, listing: { ...listing, premium: 4.1, premiumAnnualized: "0.41" } } };
    const conflicted = await runTool("cork_prepare_orders", disagree, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(conflicted.state).toBe("conflict");
    expect(conflicted.warnings[0]!.code).toBe("premium_fields_disagree");
    const badShape = { ...base, action: { ...base.action, listing: { ...listing, premiumAnnualized: "4.1%" } } };
    const refused = await runTool("cork_prepare_orders", badShape, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(refused.state).toBe("unavailable");
    expect(refused.warnings[0]!.message).toContain("STRUCTURE");
    // and a percent-spelling listing carries the SAME dated deprecation notice the relay emits.
    const pct = { ...base, action: { ...base.action, listing: { ...listing, premium: 4.1 } } };
    const finPct = await runTool("cork_prepare_orders", pct, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(finPct.state).toBe("ok");
    expect(finPct.warnings.some((w) => w.code === "deprecation_notice" && w.message.includes("2026-08-17"))).toBe(true);
  });
});
