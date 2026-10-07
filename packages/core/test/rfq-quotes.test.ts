// RFQ v2 quotes carry their order: answer-rfq builds the option beside the order, rfq-write and
// cork_submit hold every option to the order it carries before anything is signed or relayed,
// lop-order takes under a citation only the order the quote carries, and refresh-order
// supersedes the quote together with the order. Offline: the eval stub's chain + venue.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { buildMakerOrder, decodeMakerTraits, hashLopOrder, impliedPremiumWad, LOP_ADDRESSES, runTool, type HandlerContext } from "@cork/core";
import { JIT_TASK_PAIR, LIQUIDITY_RECIPE, RFQ_OPEN_ID, stubContext } from "../../../evals/stub.ts";
import { parseQuotedOrder, quotedOptionTermsViolation, quotedOrderWire } from "../src/rfq-quotes.ts";
import { quotedOrderCitationViolation, orderReuseTeaching } from "../src/handlers/submit.ts";
import { answerTemplate, wadToFraction } from "../src/handlers/prepare-orders-sugars.ts";
import { proveRfqWrite, stubRpc } from "./helpers.ts";

const NOW = 1_790_000_000n; // the eval stub's clock
const UW = privateKeyToAccount(`0x${"5c".repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${"5d".repeat(32)}`);
const EXPIRY = NOW + 20n * 86_400n;

type Answered = { orderHash: `0x${string}`; answer: { quotedOption: Record<string, unknown> } };

/** One quoted option, as the underwriter would hold it after signing its order. */
async function quotedOption(ctx: HandlerContext, clientRequestId: string, signer = UW): Promise<{ option: Record<string, unknown>; orderHash: `0x${string}` }> {
  const env = await runTool("cork_prepare_orders", { chainId: 42161, account: UW.address, clientRequestId, action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: EXPIRY.toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
  expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
  const d = env.data as Answered;
  return { option: { ...d.answer.quotedOption, order_signature: await signer.sign({ hash: d.orderHash }) }, orderHash: d.orderHash };
}

const writeAnswer = (options: unknown[], over: Record<string, unknown> = {}) => ({ chainId: 42161, account: UW.address, clientRequestId: "quote-answer-0001", action: { type: "rfq-write", request: { type: "rfq-answer", rfqId: RFQ_OPEN_ID, underwriter: UW.address, status: "quoted", options, ...over } } });

describe("answer-rfq → rfq-write → cork_submit: a quote carries its signed order", () => {
  const ctx = stubContext();

  it("the option answer-rfq builds passes every check, and the posted body carries the order and its signature", async () => {
    const { option, orderHash } = await quotedOption(ctx, "quote-0001");
    const prepared = await runTool("cork_prepare_orders", writeAnswer([option]), ctx);
    expect(prepared.state, JSON.stringify(prepared.warnings)).toBe("ok");
    const p = prepared.data as { quotedOrders: Array<{ orderHash: string; signerType: string; notChecked: string[] }>; execution: { then: string[] } };
    expect(p.quotedOrders).toHaveLength(1);
    expect(p.quotedOrders[0]).toMatchObject({ orderHash, signerType: "eoa" });
    // The quote travels without the order's extension: what that hides is said, not skipped.
    expect(p.quotedOrders[0]!.notChecked.join(" ")).toContain("extension");
    expect(p.execution.then.at(-1)).toContain("lop-order");

    const seen: Array<{ url: string; body: unknown }> = [];
    const watching: HandlerContext = { ...ctx, venueFetch: async (url, init) => { if (init?.method === "POST") seen.push({ url, body: JSON.parse(String(init.body)) }); return ctx.venueFetch!(url, init); } };
    const { request } = writeAnswer([option]).action;
    const signed = await proveRfqWrite(UW, { chainId: 42161, clientRequestId: "quote-answer-0001", action: request }, "new_position");
    const env = await runTool("cork_submit", signed, watching);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as { quotedOrders: unknown[] }).quotedOrders).toHaveLength(1);
    const posted = (seen[0]!.body as { options: Array<Record<string, unknown>> }).options[0]!;
    expect(posted.order).toEqual(option.order);
    expect(posted.order_signature).toBe(option.order_signature);
  });

  it("several options in one answer, each its own order", async () => {
    const a = await quotedOption(ctx, "quote-multi-0001");
    const b = await quotedOption(ctx, "quote-multi-0002");
    expect(a.option.option_id).not.toBe(b.option.option_id);
    const env = await runTool("cork_prepare_orders", writeAnswer([a.option, b.option]), ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as { quotedOrders: Array<{ orderHash: string }> }).quotedOrders.map((q) => q.orderHash)).toEqual([a.orderHash, b.orderHash]);
  });

  it("refusals before anything is signed: another maker, one order twice, another chain, a signature by another key", async () => {
    const { option } = await quotedOption(ctx, "quote-bad-0001");
    const refused = async (options: unknown[], code: string, msg: RegExp) => {
      const env = await runTool("cork_prepare_orders", writeAnswer(options), ctx);
      expect(env.state, msg.source).not.toBe("ok");
      expect(env.warnings[0]?.code, msg.source).toBe(code);
      expect(env.warnings[0]?.message, msg.source).toMatch(msg);
    };
    await refused([{ ...option, order: { ...(option.order as object), maker: STRANGER.address } }], "invalid_order_terms", /must be the answer's underwriter/u);
    await refused([option, { ...option, option_id: "other" }], "invalid_order_terms", /carry the same order|repeats another option's order/u);
    // The same order spelled another way (a leading zero) is still one order: the hash decides.
    const respelled = { ...option, option_id: "other", order: { ...(option.order as Record<string, string>), salt: `0${(option.order as Record<string, string>).salt}` } };
    await refused([option, respelled], "invalid_order_terms", /options\[1\] and options\[0\] carry the same order/u);
    await refused([{ ...option, chain_id: 8453 }], "invalid_order_terms", /must be the RFQ's chain \(42161\)/u);
    const forged = (await quotedOption(ctx, "quote-bad-0001", STRANGER)).option;
    await refused([forged], "signature_or_reconstruction_mismatch", /recovers to .*not the underwriter/u);
  });

  it("the option's terms must be the terms its order fills at: premium, collateral, capacity, freshness", async () => {
    const { option } = await quotedOption(ctx, "quote-terms-0001");
    const order = option.order as Record<string, string>;
    const expiry = decodeMakerTraits(BigInt(order.makerTraits!)).expiry;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ premium_annualized: "0.02" }, /quotes premium_annualized 0\.02, but its order takes/u],
      [{ collateral_asset: "0x00000000000000000000000000000000000000c0" }, /but its order takes/u],
      [{ notional_max_assets: "1" }, /more than the option's notional_max_assets 1/u],
      [{ fresh_until: Number(expiry) + 1 }, /is after its order's expiry/u],
    ];
    for (const [over, msg] of cases) {
      const env = await runTool("cork_prepare_orders", writeAnswer([{ ...option, ...over }]), ctx);
      expect(env.state, msg.source).toBe("unavailable");
      expect(env.warnings[0]?.code, msg.source).toBe("invalid_order_terms");
      expect(env.warnings[0]?.message, msg.source).toMatch(msg);
    }
  });
});

describe("lop-order under a v2 citation: the book takes only the order the quote carries", () => {
  it("the quoted order relays; another order of the same underwriter under that citation is refused before relay", async () => {
    const base = stubContext();
    const quoted = await runTool("cork_prepare_orders", { chainId: 42161, account: UW.address, clientRequestId: "cite-0001", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: EXPIRY.toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, base);
    const other = await runTool("cork_prepare_orders", { chainId: 42161, account: UW.address, clientRequestId: "cite-0002", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: EXPIRY.toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, base);
    const q = quoted.data as Answered & { nonce: string; typedData: { message: Record<string, string> } };
    const rfq = { rfq_id: RFQ_OPEN_ID, kind: "new_position", state: "open", truncated: false, request: { requester: "0x00000000000000000000000000000000000000aa", chain_id: 42161 }, answers: [{ answer_id: "ans_q", underwriter: UW.address.toLowerCase(), answer: { status: "quoted", options: [q.answer.quotedOption] } }] };
    const ctx: HandlerContext = { ...base, venueFetch: async (url, init) => (init?.method !== "POST" && url.includes(`/rfqs/v2/${RFQ_OPEN_ID}`) ? new Response(JSON.stringify(rfq), { status: 200 }) : base.venueFetch!(url, init)) };
    const lopOf = async (env: typeof quoted) => {
      const d = env.data as Answered & { nonce: string; typedData: { message: Record<string, string> } };
      const fin = await runTool("cork_prepare_orders", { chainId: 42161, account: UW.address, clientRequestId: (env.data as { clientRequestId: string }).clientRequestId, action: { type: "finalize-maker-order", prepared: env.data, signature: await UW.sign({ hash: d.orderHash }), listing: { side: "SELL", premiumAnnualized: "0.04", expiry: Number(decodeMakerTraits(BigInt(d.typedData.message.makerTraits!)).expiry), nonce: d.nonce, allowsPartialFills: false } } }, ctx);
      expect(fin.state, JSON.stringify(fin.warnings)).toBe("ok");
      const submitInput = (fin.data as { submitInput: { action: Record<string, unknown> } }).submitInput;
      return { ...submitInput, action: { ...submitInput.action, quoteRef: { rfqId: RFQ_OPEN_ID, answerId: "ans_q", optionId: q.answer.quotedOption.option_id } } };
    };
    const ok = await runTool("cork_submit", await lopOf(quoted), ctx);
    expect(ok.state, JSON.stringify(ok.warnings)).toBe("ok");
    const refused = await runTool("cork_submit", await lopOf(other), ctx);
    expect(refused.state).toBe("unavailable");
    expect(refused.warnings[0]?.code).toBe("invalid_order_terms");
    expect(refused.warnings[0]?.message).toMatch(/only the exact order it quoted/u);
  });
});

describe("the option's market template", () => {
  const RECIPE = "0x00000000000000000000000000000000000000Ff";
  it("a fixed recipe carries its rate inline, even over a template id; any other recipe drops a stray rate", () => {
    expect(answerTemplate({ base: { market_template_id: `0x${"ab".repeat(32)}` }, recipe: RECIPE, rateOverride: 9n })).toEqual({ inline: { oracle_recipe: RECIPE.toLowerCase(), oracle_params: { rate_override: "9" } } });
    expect(answerTemplate({ base: { inline: { oracle_recipe: "0x01", oracle_params: { schema: "s", rate_override: "9" } } }, recipe: RECIPE, rateOverride: undefined })).toEqual({ inline: { oracle_recipe: RECIPE.toLowerCase(), oracle_params: { schema: "s" } } });
    const id = { market_template_id: `0x${"cd".repeat(32)}` };
    expect(answerTemplate({ base: id, recipe: RECIPE, rateOverride: undefined })).toBe(id);
    expect(answerTemplate({ base: undefined, recipe: RECIPE, rateOverride: undefined })).toEqual({ inline: { oracle_recipe: RECIPE.toLowerCase(), oracle_params: {} } });
  });
});

describe("the quote checks, pure", () => {
  const LOP = LOP_ADDRESSES[42161]!;
  const built = buildMakerOrder({ chainId: 42161, lop: LOP, maker: UW.address, makerAsset: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: 1000n * 10n ** 18n, takingAmount: 2_191_781n * 10n ** 12n, clientRequestId: "pure-0001", expiry: NOW + 86_400n, allowPartialFills: false });
  const option = { collateral_asset: JIT_TASK_PAIR.collateralAsset.toLowerCase(), premium_annualized: "0.04", expiry: Number(NOW + 20n * 86_400n), notional_max_assets: "1000000000000000000000", fresh_until: Number(NOW + 86_400n) };

  it("the wire order round-trips: lowercased addresses, decimal strings, the same hash", () => {
    const wire = quotedOrderWire(built.order);
    expect(wire.maker).toBe(UW.address.toLowerCase());
    const parsed = parseQuotedOrder(wire);
    expect(parsed.ok && hashLopOrder(42161, LOP, parsed.order)).toBe(built.orderHash);
    expect(parseQuotedOrder({ ...wire, extension: "0x" })).toMatchObject({ ok: false });
    expect(parseQuotedOrder({ ...wire, makingAmount: "0" })).toMatchObject({ ok: false });
  });

  it("the premium allows the order to have been priced up to a day ago, and no more than 1% off", () => {
    const at = (nowSeconds: bigint) => quotedOptionTermsViolation({ index: 0, option, order: built.order, nowSeconds, collateralDecimals: 18 });
    expect(at(NOW).violation).toBeNull();
    // An hour later the tenor is shorter, the same amounts mean a little more: still the quote.
    expect(at(NOW + 3600n).violation).toBeNull();
    // Six hours on a 20-day tenor is more than 1% of drift: still the quote, because the order
    // may have been priced up to a day before the check.
    expect(at(NOW + 6n * 3600n).violation).toBeNull();
    // Without the decimals, the comparison is listed as not made, never passed silently.
    const blind = quotedOptionTermsViolation({ index: 0, option, order: built.order, nowSeconds: NOW, collateralDecimals: undefined });
    expect(blind.violation).toBeNull();
    expect(blind.violation === null && blind.notChecked.join(" ")).toContain("decimals were not read");
    expect(quotedOptionTermsViolation({ index: 0, option: { ...option, premium_annualized: "0.03" }, order: built.order, nowSeconds: NOW, collateralDecimals: 18 }).violation).toMatch(/premium/u);
    // A dead order cannot back a quote.
    expect(at(NOW + 86_401n).violation).toMatch(/expired/u);
  });

  it("lop-order: under a citation, an underwriter posts only the order the quote carries; a requester's order is not covered", () => {
    const quoted = { order: quotedOrderWire(built.order) };
    expect(quotedOrderCitationViolation({ chainId: 42161, option: quoted, underwriter: UW.address, maker: UW.address, orderHash: built.orderHash })).toBeNull();
    expect(quotedOrderCitationViolation({ chainId: 42161, option: quoted, underwriter: UW.address, maker: UW.address, orderHash: `0x${"11".repeat(32)}` })).toMatch(/only the exact order it quoted/u);
    expect(quotedOrderCitationViolation({ chainId: 42161, option: quoted, underwriter: UW.address, maker: STRANGER.address, orderHash: `0x${"11".repeat(32)}` })).toBeNull();
    expect(quotedOrderCitationViolation({ chainId: 42161, option: {}, underwriter: UW.address, maker: UW.address, orderHash: `0x${"11".repeat(32)}` })).toBeNull();
  });

  it("the venue's one-order-one-quote 409 is taught; other 409s are not", () => {
    expect(orderReuseTeaching("options[0].order (0xab) is already on the limit-order book. Sign a fresh order (new salt) for this answer.")).toContain("BEFORE its order goes to the book");
    expect(orderReuseTeaching('This RFQ is kind "rollover"')).toBe("");
  });

  it("a WAD fraction becomes the venue's decimal string", () => {
    expect(wadToFraction(4n * 10n ** 16n)).toBe("0.04");
    expect(wadToFraction(10n ** 18n)).toBe("1");
    expect(wadToFraction(1n)).toBe("0.000000000000000001");
  });
});

describe("refresh-order supersedes the quote its order carries", () => {
  const LOP = LOP_ADDRESSES[1]!;
  const NOW1 = 1_800_000_000n;
  const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
  const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
  const POOL_EXPIRY = NOW1 + 10n * 86_400n;
  const resting = buildMakerOrder({ chainId: 1, lop: LOP, maker: UW.address, makerAsset: CST, takerAsset: SUSDE, makingAmount: 10n ** 18n, takingAmount: 10n ** 15n, clientRequestId: "rq-orig-0001", expiry: NOW1 + 120n, allowPartialFills: false, ocoGroup: "rfq:rfq_9" });
  const quote = { option_id: "o1", chain_id: 1, collateral_asset: SUSDE.toLowerCase(), reference_asset: "0x00000000000000000000000000000000000000f1", mode: "liquidity_only", package_id: "p1", expiry: Number(POOL_EXPIRY), market_template: { market_template_id: `0x${"ab".repeat(32)}` }, premium_annualized: "0.03", notional_max_assets: "1000000000000000000", fresh_until: Number(NOW1 + 120n), order: quotedOrderWire(resting.order), order_hash: resting.orderHash };

  it("the refreshed order rides a superseding answer, priced at what its unchanged amounts mean now", async () => {
    const row = { orderHash: resting.orderHash, order: { ...quotedOrderWire(resting.order), maker: UW.address }, signature: await UW.sign({ hash: resting.orderHash }), extension: resting.extension, makerAccountType: "EOA", side: "SELL", status: "OPEN", quoteRef: { rfq_id: "rfq_9", answer_id: "ans_1", option_id: "o1" } };
    const rfq = { rfq_id: "rfq_9", kind: "new_position", state: "open", answers: [{ answer_id: "ans_1", underwriter: UW.address.toLowerCase(), answer: { status: "quoted", options: [quote] } }], request: { chain_id: 1 } };
    const venueFetch = async (url: string) => new Response(JSON.stringify(url.includes("/limit-orders/v1/orderbook") ? { items: [row], hasMore: false } : url.includes("/rfqs/v2/rfq_9") ? rfq : { items: [] }), { status: 200 });
    const resolveRpc = stubRpc((c) => (c.functionName === "bitInvalidatorForOrder" ? 0n : c.functionName === "decimals" ? 18 : (() => { throw new Error(c.functionName); })()));
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: UW.address, clientRequestId: "rq-refresh-0001", action: { type: "refresh-order", orderHash: resting.orderHash } }, { nowSeconds: NOW1, venueFetch, resolveRpc });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { orderHash: string; requote: { rfqId: string; supersedes: string; option: Record<string, unknown> }; execution: { then: string[] } };
    expect(d.requote.rfqId).toBe("rfq_9");
    expect(d.requote.supersedes).toBe("ans_1");
    expect(d.requote.option).not.toHaveProperty("order_hash");
    expect(d.requote.option.fresh_until).toBe(Number(NOW1 + 600n));
    const parsed = parseQuotedOrder(d.requote.option.order);
    expect(parsed.ok && hashLopOrder(1, LOP, parsed.order)).toBe(d.orderHash);
    expect(d.requote.option.premium_annualized).toBe(wadToFraction(impliedPremiumWad(10n ** 15n, 10n ** 18n, POOL_EXPIRY - NOW1)));
    expect(d.execution.then.some((s) => s.includes("supersedes: requote.supersedes"))).toBe(true);
  });
});
