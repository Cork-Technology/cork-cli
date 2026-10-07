// Rollover RFQs (venue RFQ v2, kind "rollover"): the venue's write rules and its quoteRef rule,
// mirrored; the signed bodies; the pool checks against the chain; a rollover order accepting a
// quote (rollover-intent fills its terms from it, cork_submit relays the citation); and the
// rollover firmness join on rfqs reads. Offline: the venue is a fetch stub, the chain a stub.
import { describe, expect, it } from "vitest";
import { zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashJitMarketParams, runTool, ToolInputError, type HandlerContext } from "@cork/core";
import { planRfqWrite } from "../src/rfq-bodies.ts";
import {
  findRolloverQuote,
  jitMarketParamsOfWire,
  premiumTokenAllowed,
  rfqCounterKindFieldsViolation,
  rfqOpenKindFieldsViolation,
  rolloverJitMarketWire,
  rolloverOptionToWire,
  rolloverOptionViolation,
  rolloverQuoteDefaults,
  rolloverQuoteRefMismatch,
} from "../src/rfq-rollover.ts";
import { citedRolloverOptionKeys, markFirmOptions } from "../src/handlers/query-offers.ts";
import { stubRpc } from "./helpers.ts";

const NOW = 1_790_000_000n;
const REQUESTER = privateKeyToAccount(`0x${"4a".repeat(32)}`);
const UNDERWRITER = privateKeyToAccount(`0x${"4b".repeat(32)}`);
const SRC_POOL = `0x${"11".repeat(32)}` as const;
const DST_POOL = `0x${"22".repeat(32)}` as const;
const DEAD_POOL = `0x${"33".repeat(32)}` as const;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;
const SUSDE = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" as const;
// The 0.2-wire ExactSettler of the primary generation on 42161 (cork-defaults.v2.json).
const EXACT_02 = "0x0F2Ce7a5b817865ebFf50c58439B9A27E38f452E" as const;
const SRC_CST = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const DST_CST = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;
const CLONE = "0xc0ffee0000000000000000000000000000000001" as const;

const JIT_INPUT = {
  collateralAsset: USDC,
  referenceAsset: SUSDE,
  expiryTimestamp: 1_800_000_000,
  recipe: `0x${"ab".repeat(20)}`,
  constraint: { rateMin: "1", rateMax: "2", rateChangePerDayMax: "3", rateChangeCapacityMax: "4" },
  extraData: "0x1234",
} as const;

/** A rollover RFQ record as the venue serves it (request fields lifted beside the row's). */
function rolloverRecord(o: { answers?: unknown[]; truncated?: boolean; chainId?: number } = {}): Record<string, unknown> {
  const request = {
    schema_version: "2",
    kind: "rollover",
    requester: REQUESTER.address.toLowerCase(),
    chain_id: o.chainId ?? 42161,
    source: { pool_id: SRC_POOL, shares: "100000000000000000000" },
    reference_asset: SUSDE.toLowerCase(),
    collateral_asset: { exact: USDC.toLowerCase() },
    expiry_window: { not_before: 1_795_000_000, not_after: 1_800_000_000 },
    premium_token: { one_of: [USDC.toLowerCase(), WETH.toLowerCase()] },
    valid_until: 1_791_000_000,
  };
  return { ...request, rfq_id: "rfq_r", state: "open", version: 1, received_at: 1_790_000_000, answers: o.answers ?? [], truncated: o.truncated ?? false, request };
}

const POOL_OPTION = {
  option_id: "o1",
  chain_id: 42161,
  destination: { pool_id: DST_POOL },
  premium_token: USDC.toLowerCase(),
  premium_per_share: "5000000",
  shares_max: "60000000000000000000",
  fresh_until: 1_790_000_600,
};

function quotedAnswer(options: unknown[], status = "quoted"): Record<string, unknown> {
  return { answer_id: "ans_1", received_at: 1_790_000_100, answer: { schema_version: "2", kind: "rollover", underwriter: UNDERWRITER.address.toLowerCase(), status, ...(status === "quoted" ? { options } : { reason_code: "PASS" }) } };
}

interface Seen { url: string; method: string; body?: unknown }

function ctxWith(routes: Array<{ match: string; status?: number; body: unknown }>, seen: Seen[] = [], over: Partial<HandlerContext> = {}): HandlerContext {
  const venueFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const r = routes.find((x) => url.includes(x.match));
    if (!r) return new Response(JSON.stringify({ message: `no stub for ${url}` }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { nowSeconds: NOW, resolveRpc: async () => null, venueFetch, ...over };
}

/** A chain where `pools` exist with the given expiries (any other pool id is unknown). */
function poolChain(pools: Record<string, bigint>): NonNullable<HandlerContext["resolveRpc"]> {
  const ZERO = "0x0000000000000000000000000000000000000000";
  return stubRpc((c) => {
    const id = String(c.args?.[0] ?? "").toLowerCase();
    if (c.functionName === "shares") return pools[id] === undefined ? [ZERO, ZERO] : [DST_CST, SRC_CST];
    if (c.functionName === "market") {
      return { collateralAsset: USDC, referenceAsset: SUSDE, expiryTimestamp: pools[id] ?? 0n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n, rateOracle: ZERO, swapFeePercentage: 0n, unwindSwapFeePercentage: 0n };
    }
    throw new Error(`unexpected read ${c.functionName}`);
  });
}

const LIVE = NOW + 86_400n * 30n;

async function signed(input: { chainId: number; clientRequestId: string; action: Record<string, unknown> }, target?: { kind: "rollover" }): Promise<typeof input> {
  const { auth: _a, ...request } = input.action;
  const plan = planRfqWrite({ chainId: input.chainId, clientRequestId: input.clientRequestId, request: request as never, ...(target ? { target } : {}) });
  const signer = plan.signer === REQUESTER.address.toLowerCase() ? REQUESTER : UNDERWRITER;
  const signature = await signer.signTypedData(plan.typedData as never);
  return { ...input, action: { ...input.action, auth: { method: "signature", signature } } };
}

const OPEN = {
  type: "rfq-open",
  kind: "rollover",
  requester: REQUESTER.address,
  source: { poolId: SRC_POOL, shares: "100000000000000000000" },
  referenceAsset: SUSDE,
  collateralAsset: { exact: USDC },
  expiryWindow: { notBefore: 1_795_000_000, notAfter: 1_800_000_000 },
  premiumToken: { one_of: [USDC, WETH] },
  validUntil: 1_791_000_000,
} as const;

describe("rollover RFQ rules (pure, the venue's mirrored)", () => {
  it("an open carries its own kind's fields only", () => {
    expect(rfqOpenKindFieldsViolation({ ...OPEN })).toBeNull();
    expect(rfqOpenKindFieldsViolation({ ...OPEN, modes: ["liquidity_only"] })).toMatch(/modes belongs to a new_position RFQ only/u);
    expect(rfqOpenKindFieldsViolation({ ...OPEN, source: undefined })).toMatch(/needs source/u);
    expect(rfqOpenKindFieldsViolation({ ...OPEN, premiumToken: undefined })).toMatch(/needs premiumToken/u);
    expect(rfqOpenKindFieldsViolation({ ...OPEN, premiumToken: { one_of: [USDC, USDC.toLowerCase()] } })).toMatch(/each token once/u);
    expect(rfqOpenKindFieldsViolation({ kind: "new_position", modes: ["liquidity_only"], packageIds: ["p"], notionalAssets: "1", source: OPEN.source })).toMatch(/source belongs to a rollover RFQ only/u);
    expect(rfqOpenKindFieldsViolation({ kind: "new_position", modes: ["liquidity_only"], packageIds: ["p"] })).toMatch(/needs notionalAssets/u);
  });

  it("a counter is priced in its kind's unit", () => {
    expect(rfqCounterKindFieldsViolation("rollover", { premiumPerShare: "5", premiumToken: USDC })).toBeNull();
    expect(rfqCounterKindFieldsViolation("rollover", { premiumAnnualized: "0.03" })).toMatch(/prices a new_position counter/u);
    expect(rfqCounterKindFieldsViolation("rollover", { premiumPerShare: "5" })).toMatch(/needs premiumPerShare.*and premiumToken/u);
    expect(rfqCounterKindFieldsViolation("rollover", { premiumPerShare: "0", premiumToken: USDC })).toMatch(/positive integer/u);
    expect(rfqCounterKindFieldsViolation("new_position", { premiumAnnualized: "0.03" })).toBeNull();
    expect(rfqCounterKindFieldsViolation("new_position", { premiumPerShare: "5", premiumToken: USDC })).toMatch(/price a rollover counter/u);
  });

  it("premium tokens compare without case, exact or one_of", () => {
    expect(premiumTokenAllowed({ exact: USDC.toLowerCase() }, USDC)).toBe(true);
    expect(premiumTokenAllowed({ one_of: [WETH.toLowerCase()] }, USDC)).toBe(false);
    expect(premiumTokenAllowed(undefined, USDC)).toBe(false);
  });

  it("a jitMarket input becomes the venue's JITMarketParams wire with the zero salt and zero fees by default, and hashes to BaseFiller 0.2's commitment", () => {
    const w = rolloverJitMarketWire(JIT_INPUT as never);
    expect(w.ok).toBe(true);
    const wire = (w as { wire: Record<string, unknown> }).wire;
    expect(wire).toMatchObject({ expiryTimestamp: "1800000000", rateOverride: "0", additionalData: "0x1234", oracleSalt: zeroHash, swapFeePercentage: "0", unwindSwapFeePercentage: "0" });
    // The same struct the venue's Foundry vector pins (rfq-signing.test.ts), through the wire.
    const vectorWire = { collateralAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", referenceAsset: "0x4200000000000000000000000000000000000006", expiryTimestamp: "1900086400", recipe: `0x${"ab".repeat(20)}`, rateOverride: "0", constraint: { rateMin: "1", rateMax: "2", rateChangePerDayMax: "3", rateChangeCapacityMax: "4" }, additionalData: "0x1234", oracleSalt: `0x${"33".repeat(32)}`, swapFeePercentage: "300000000000000000", unwindSwapFeePercentage: "100000000000000000" };
    expect(hashJitMarketParams(jitMarketParamsOfWire(vectorWire), "0.2")).toBe("0x50e23ebeb99b7f374db763d851e32aa2bd87ab3fa18a22abab59c2ed3a9bf622");
    expect(rolloverJitMarketWire({ ...JIT_INPUT, additionalData: "0x9999" } as never)).toMatchObject({ ok: false });
    expect(rolloverOptionToWire({ ...POOL_OPTION, destination: { jitMarket: JIT_INPUT } })).toMatchObject({ ok: true, option: { destination: { jit_market: { additionalData: "0x1234" } } } });
  });

  it("a quote option: the RFQ's chain, an accepted token, no more shares than asked, one destination that is not the source, no order fields", () => {
    const rfq = rolloverRecord();
    expect(rolloverOptionViolation(0, POOL_OPTION, rfq)).toBeNull();
    expect(rolloverOptionViolation(0, { ...POOL_OPTION, chain_id: 8453 }, rfq)).toMatch(/must be the RFQ's chain/u);
    expect(rolloverOptionViolation(0, { ...POOL_OPTION, premium_token: SUSDE }, rfq)).toMatch(/not one the requester accepts/u);
    expect(rolloverOptionViolation(0, { ...POOL_OPTION, shares_max: "100000000000000000001" }, rfq)).toMatch(/more than the RFQ's source\.shares/u);
    expect(rolloverOptionViolation(0, { ...POOL_OPTION, destination: { pool_id: SRC_POOL } }, rfq)).toMatch(/is the RFQ's source pool/u);
    expect(rolloverOptionViolation(0, { ...POOL_OPTION, destination: { pool_id: DST_POOL, jit_market: {} } }, rfq)).toMatch(/exactly one of/u);
    expect(rolloverOptionViolation(0, { ...POOL_OPTION, premium_per_share: "0" }, rfq)).toMatch(/premium_per_share must be a positive/u);
    expect(rolloverOptionViolation(0, { ...POOL_OPTION, order: {} }, rfq)).toMatch(/order belongs to a new_position quote/u);
  });

  it("findRolloverQuote: a rollover RFQ on this chain, a quoted answer holding the option; a truncated miss is unresolved", () => {
    const rfq = rolloverRecord({ answers: [quotedAnswer([POOL_OPTION])] });
    expect(findRolloverQuote(42161, rfq, { answerId: "ans_1", optionId: "o1" })).toMatchObject({ found: true, option: { option_id: "o1" } });
    expect(findRolloverQuote(8453, rfq, { answerId: "ans_1", optionId: "o1" })).toMatchObject({ found: false, reason: expect.stringMatching(/chain 42161, not 8453/u) });
    expect(findRolloverQuote(42161, { ...rfq, kind: "new_position" }, { answerId: "ans_1", optionId: "o1" })).toMatchObject({ found: false, reason: expect.stringMatching(/new_position RFQ/u) });
    expect(findRolloverQuote(42161, rfq, { answerId: "ans_1", optionId: "o9" })).toMatchObject({ found: false, unresolved: false });
    expect(findRolloverQuote(42161, rolloverRecord({ answers: [quotedAnswer([], "pass")] }), { answerId: "ans_1", optionId: "o1" })).toMatchObject({ found: false, reason: expect.stringMatching(/not a quote/u) });
    expect(findRolloverQuote(42161, rolloverRecord({ truncated: true }), { answerId: "ans_1", optionId: "o1" })).toMatchObject({ found: false, unresolved: true });
  });

  it("the venue's quoteRef rule, rule for rule", () => {
    const rfq = rolloverRecord();
    const order = { user: REQUESTER.address, premiumToken: USDC, orderSize: 60n * 10n ** 18n, minPremiumPerShare: 5_000_000n, srcPoolId: SRC_POOL, dstPoolId: DST_POOL, jitMarketHash: zeroHash };
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, order)).toBeNull();
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, { ...order, user: UNDERWRITER.address })).toMatch(/not the requester/u);
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, { ...order, srcPoolId: DST_POOL })).toMatch(/not the RFQ's source pool/u);
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, { ...order, dstPoolId: DEAD_POOL })).toMatch(/not the quoted destination pool/u);
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, { ...order, jitMarketHash: `0x${"aa".repeat(32)}` })).toMatch(/jitMarketHash must be zero/u);
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, { ...order, premiumToken: WETH })).toMatch(/not the quoted premium_token/u);
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, { ...order, minPremiumPerShare: 4_999_999n })).toMatch(/below the quoted premium_per_share/u);
    expect(rolloverQuoteRefMismatch(rfq, POOL_OPTION, { ...order, orderSize: 60n * 10n ** 18n + 1n })).toMatch(/more than the quoted shares_max/u);
    const jitOption = { ...POOL_OPTION, destination: { jit_market: {} }, jit_market_hash: `0x${"bb".repeat(32)}` };
    expect(rolloverQuoteRefMismatch(rfq, jitOption, { ...order, jitMarketHash: `0x${"BB".repeat(32)}` })).toBeNull();
    expect(rolloverQuoteRefMismatch(rfq, jitOption, order)).toMatch(/not the quoted just-in-time market/u);
    expect(rolloverQuoteRefMismatch(rfq, jitOption, { ...order, jitMarketHash: `0x${"cc".repeat(32)}` })).toMatch(/not the quoted just-in-time market/u);
  });

  it("the terms a quote supplies: source, destination, token, premium per share, and the smaller of shares_max and source.shares", () => {
    const d = rolloverQuoteDefaults(rolloverRecord(), POOL_OPTION);
    expect(d).toMatchObject({ srcPoolId: SRC_POOL, dstPoolId: DST_POOL, premiumToken: USDC.toLowerCase(), minPremiumPerShare: "5000000", orderSize: "60000000000000000000" });
    const big = rolloverQuoteDefaults({ ...rolloverRecord(), source: { pool_id: SRC_POOL, shares: "1000" } }, POOL_OPTION);
    expect(big.orderSize).toBe("1000");
    const jit = rolloverQuoteDefaults(rolloverRecord(), { ...POOL_OPTION, destination: { jit_market: (rolloverJitMarketWire(JIT_INPUT as never) as { wire: Record<string, unknown> }).wire }, jit_market_hash: `0x${"bb".repeat(32)}` });
    expect(jit.dstPoolId).toBeUndefined();
    expect(jit.jitMarket).toMatchObject({ extraData: "0x1234", expiryTimestamp: 1_800_000_000 });
  });
});

describe("rollover RFQ writes (cork_prepare_orders rfq-write → cork_submit)", () => {
  const openInput = { chainId: 42161, clientRequestId: "test-roll-open-0001", action: { ...OPEN, auth: { method: "signature", signature: "0x00" } } };

  it("a rollover open: the body names the position and the premium tokens, never cover fields; prepare and submit build the same body; a live source pool relays", async () => {
    const { auth: _a, ...request } = openInput.action;
    const prep = await runTool("cork_prepare_orders", { chainId: 42161, account: REQUESTER.address, clientRequestId: openInput.clientRequestId, action: { type: "rfq-write", request } }, ctxWith([], [], { resolveRpc: poolChain({ [SRC_POOL]: LIVE }) }));
    expect(prep.state).toBe("ok");
    const body = (prep.data as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ schema_version: "2", kind: "rollover", source: { pool_id: SRC_POOL, shares: "100000000000000000000" }, premium_token: { one_of: [USDC.toLowerCase(), WETH.toLowerCase()] } });
    for (const k of ["modes", "package_ids", "notional_assets"]) expect(body).not.toHaveProperty(k);
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await signed(openInput), ctxWith([{ match: "/rfqs/v2", status: 201, body: { rfq_id: "rfq_r", state: "open" } }], seen, { resolveRpc: poolChain({ [SRC_POOL]: LIVE }) }));
    expect(env.state).toBe("ok");
    const post = seen.find((s) => s.method === "POST")!;
    const { signature: _s, ...sent } = post.body as Record<string, unknown>;
    expect(sent).toEqual(body);
  });

  it("a source pool no manager knows, or one that expired, is refused and nothing is sent; an unreadable chain relays with a warning", async () => {
    const missing: Seen[] = [];
    const a = await runTool("cork_submit", await signed(openInput), ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], missing, { resolveRpc: poolChain({}) }));
    expect(a.state).toBe("unavailable");
    expect(a.warnings[0]?.code).toBe("pool_not_found");
    expect(missing.filter((s) => s.method === "POST")).toHaveLength(0);
    const expired: Seen[] = [];
    const b = await runTool("cork_submit", await signed(openInput), ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], expired, { resolveRpc: poolChain({ [SRC_POOL]: NOW - 1n }) }));
    expect(b.state).toBe("unavailable");
    expect(b.warnings[0]?.message).toMatch(/expired/u);
    expect(expired.filter((s) => s.method === "POST")).toHaveLength(0);
    const blind: Seen[] = [];
    const c = await runTool("cork_submit", await signed(openInput), ctxWith([{ match: "/rfqs/v2", status: 201, body: { rfq_id: "rfq_r" } }], blind));
    expect(c.state).toBe("ok");
    expect(c.warnings.map((w) => w.code)).toContain("chain_read_failed");
    expect(blind.filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("a rollover open with new_position fields is refused before anything is sent", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", { ...openInput, action: { ...openInput.action, modes: ["liquidity_only"] } }, ctxWith([], seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(seen).toHaveLength(0);
  });

  const answerInput = (options: unknown[]) => ({ chainId: 42161, clientRequestId: "test-roll-ans-0001", action: { type: "rfq-answer", rfqId: "rfq_r", underwriter: UNDERWRITER.address, status: "quoted", options, auth: { method: "signature", signature: "0x00" } } });

  it("a quote into an existing live pool relays with its echo; a dead destination is refused", async () => {
    const seen: Seen[] = [];
    const ok = await runTool("cork_submit", await signed(answerInput([POOL_OPTION]), { kind: "rollover" }), ctxWith([{ match: "/rfqs/v2/rfq_r/answers", status: 201, body: { answer_id: "ans_1" } }, { match: "/rfqs/v2/rfq_r", body: rolloverRecord() }], seen, { resolveRpc: poolChain({ [DST_POOL]: LIVE }) }));
    expect(ok.state).toBe("ok");
    expect((ok.data as { rolloverOptions: unknown[] }).rolloverOptions).toEqual([{ optionId: "o1", destination: "pool", poolId: DST_POOL, notChecked: [] }]);
    const sent = seen.find((s) => s.method === "POST")!.body as { kind: string; options: Array<Record<string, unknown>> };
    expect(sent.kind).toBe("rollover");
    expect(sent.options[0]).toEqual(POOL_OPTION);
    const dead: Seen[] = [];
    const no = await runTool("cork_submit", await signed(answerInput([POOL_OPTION]), { kind: "rollover" }), ctxWith([{ match: "/rfqs/v2/rfq_r", body: rolloverRecord() }], dead, { resolveRpc: poolChain({ [DST_POOL]: NOW - 5n }) }));
    expect(no.state).toBe("unavailable");
    expect(dead.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("a just-in-time quote: sent as the venue's jit_market, and the result names the 0.2 commitment the requester's order must sign", async () => {
    const option = { ...POOL_OPTION, destination: { jitMarket: JIT_INPUT } };
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", await signed(answerInput([option]), { kind: "rollover" }), ctxWith([{ match: "/rfqs/v2/rfq_r/answers", status: 201, body: { answer_id: "ans_1" } }, { match: "/rfqs/v2/rfq_r", body: rolloverRecord() }], seen));
    expect(env.state).toBe("ok");
    const wire = (rolloverJitMarketWire(JIT_INPUT as never) as { wire: Record<string, unknown> }).wire;
    const echo = (env.data as { rolloverOptions: Array<Record<string, unknown>> }).rolloverOptions[0]!;
    expect(echo.jitMarketHash).toBe(hashJitMarketParams(jitMarketParamsOfWire(wire), "0.2"));
    expect(echo.poolId).toBeNull();
    const sent = seen.find((s) => s.method === "POST")!.body as { options: Array<{ destination: { jit_market: Record<string, unknown> } }> };
    expect(sent.options[0]!.destination.jit_market.recipe).toBe(JIT_INPUT.recipe.toLowerCase());
    expect(sent.options[0]!.destination.jit_market.additionalData).toBe("0x1234");
  });

  it("a rollover quote breaking a venue rule is refused before signing and before relay", async () => {
    const bad = { ...POOL_OPTION, premium_token: SUSDE };
    const { auth: _a, ...request } = answerInput([bad]).action;
    const prep = await runTool("cork_prepare_orders", { chainId: 42161, account: UNDERWRITER.address, clientRequestId: "test-roll-ans-0001", action: { type: "rfq-write", request } }, ctxWith([{ match: "/rfqs/v2/rfq_r", body: rolloverRecord() }]));
    expect(prep.state).toBe("unavailable");
    expect(prep.warnings[0]?.message).toMatch(/not one the requester accepts/u);
    const seen: Seen[] = [];
    const sub = await runTool("cork_submit", answerInput([bad]), ctxWith([{ match: "/rfqs/v2/rfq_r", body: rolloverRecord() }], seen));
    expect(sub.state).toBe("unavailable");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });

  it("a rollover counter bids per share in an accepted token", async () => {
    const counter = (over: Record<string, unknown>) => ({ chainId: 42161, clientRequestId: "test-roll-ctr-0001", action: { type: "rfq-counter", rfqId: "rfq_r", requester: REQUESTER.address, premiumPerShare: "4000000", premiumToken: WETH, auth: { method: "signature", signature: "0x00" }, ...over } });
    const seen: Seen[] = [];
    const ok = await runTool("cork_submit", await signed(counter({}), { kind: "rollover" }), ctxWith([{ match: "/rfqs/v2/rfq_r/counters", status: 201, body: { counter_id: "ctr_1" } }, { match: "/rfqs/v2/rfq_r", body: rolloverRecord() }], seen));
    expect(ok.state).toBe("ok");
    expect(seen.find((s) => s.method === "POST")!.body).toMatchObject({ kind: "rollover", premium_per_share: "4000000", premium_token: WETH.toLowerCase() });
    expect(seen.find((s) => s.method === "POST")!.body).not.toHaveProperty("premium_annualized");
    const other = await runTool("cork_submit", counter({ premiumToken: SUSDE }), ctxWith([{ match: "/rfqs/v2/rfq_r", body: rolloverRecord() }]));
    expect(other.state).toBe("unavailable");
    expect(other.warnings[0]?.message).toMatch(/not in this RFQ's premium_token set/u);
    const unit = await runTool("cork_submit", counter({ premiumAnnualized: "0.03", premiumPerShare: undefined, premiumToken: undefined }), ctxWith([{ match: "/rfqs/v2/rfq_r", body: rolloverRecord() }]));
    expect(unit.state).toBe("unavailable");
    expect(unit.warnings[0]?.message).toMatch(/prices a new_position counter/u);
  });
});

describe("accepting a rollover quote (rollover-intent quoteRef → cork_submit rollover-order)", () => {
  const record = rolloverRecord({ answers: [quotedAnswer([POOL_OPTION])] });
  const routes = [{ match: "/rfqs/v2/rfq_r", body: record }];
  const intent = (over: Record<string, unknown> = {}) => ({
    chainId: 42161,
    account: REQUESTER.address,
    clientRequestId: "test-roll-accept-0001",
    action: { type: "rollover-intent", settler: EXACT_02, rolloverContract: CLONE, srcCstToken: SRC_CST, dstCstToken: DST_CST, openDeadline: String(NOW + 3_600n), fillDeadline: String(NOW + 86_400n), quoteRef: { rfqId: "rfq_r", answerId: "ans_1", optionId: "o1" }, ...over },
  });

  it("every term left out comes from the quote, and the result names the accepted quote", async () => {
    const env = await runTool("cork_prepare_orders", intent(), ctxWith(routes));
    expect(env.state).toBe("ok");
    const order = (env.data as { venuePost: { order: Record<string, unknown> } }).venuePost.order;
    expect(order).toMatchObject({ premiumToken: USDC.toLowerCase(), minPremiumPerShare: "5000000", orderSize: "60000000000000000000" });
    expect((order.rolloverParams as Record<string, unknown>).srcPoolId).toBe(SRC_POOL);
    expect((order.rolloverParams as Record<string, unknown>).dstPoolId).toBe(DST_POOL);
    expect((env.data as { quoteRef: unknown }).quoteRef).toEqual({ rfqId: "rfq_r", answerId: "ans_1", optionId: "o1" });
    expect((env.data as { acceptedQuote: { premiumPerShare: string } }).acceptedQuote.premiumPerShare).toBe("5000000");
  });

  it("an explicit term that breaks the quote is refused; an account other than the requester is refused", async () => {
    const low = await runTool("cork_prepare_orders", intent({ minPremiumPerShare: "4999999" }), ctxWith(routes));
    expect(low.state).toBe("unavailable");
    expect(low.warnings[0]?.message).toMatch(/below the quoted premium_per_share/u);
    const big = await runTool("cork_prepare_orders", intent({ orderSize: "60000000000000000001" }), ctxWith(routes));
    expect(big.warnings[0]?.message).toMatch(/more than the quoted shares_max/u);
    const higher = await runTool("cork_prepare_orders", intent({ minPremiumPerShare: "6000000" }), ctxWith(routes));
    expect(higher.state).toBe("ok");
    const stranger = await runTool("cork_prepare_orders", { ...intent(), account: UNDERWRITER.address }, ctxWith(routes));
    expect(stranger.state).toBe("unavailable");
    expect(stranger.warnings[0]?.message).toMatch(/only the RFQ's requester/u);
  });

  it("a just-in-time quote: the order commits to the quoted market's hash; a dstPoolId must be given when it cannot be derived here", async () => {
    const wire = (rolloverJitMarketWire(JIT_INPUT as never) as { wire: Record<string, unknown> }).wire;
    const hash = hashJitMarketParams(jitMarketParamsOfWire(wire), "0.2");
    const jitRecord = rolloverRecord({ answers: [quotedAnswer([{ ...POOL_OPTION, destination: { jit_market: wire }, jit_market_hash: hash }])] });
    const jitRoutes = [{ match: "/rfqs/v2/rfq_r", body: jitRecord }];
    const noPool = await runTool("cork_prepare_orders", intent(), ctxWith(jitRoutes));
    expect(noPool.state).toBe("unavailable");
    expect(noPool.warnings[0]?.message).toMatch(/pass dstPoolId yourself/u);
    const env = await runTool("cork_prepare_orders", intent({ dstPoolId: DST_POOL }), ctxWith(jitRoutes));
    expect(env.state).toBe("ok");
    expect(((env.data as { venuePost: { order: { rolloverParams: Record<string, unknown> } } }).venuePost.order.rolloverParams).jitMarketHash).toBe(hash);
  });

  it("without a quoteRef, the terms a quote would supply are required input", async () => {
    await expect(runTool("cork_prepare_orders", intent({ quoteRef: undefined }), ctxWith([]))).rejects.toBeInstanceOf(ToolInputError);
  });

  it("cork_submit rollover-order relays the citation when the order matches the quote, and refuses one that does not", async () => {
    const built = await runTool("cork_prepare_orders", intent(), ctxWith(routes));
    const d = built.data as { typedData: Record<string, unknown>; venuePost: { order: Record<string, unknown>; intent: Record<string, unknown> } };
    const signature = await REQUESTER.signTypedData(d.typedData as never);
    const seen: Seen[] = [];
    const sub = { chainId: 42161, clientRequestId: "test-roll-accept-0001", action: { type: "rollover-order", order: d.venuePost.order, intent: d.venuePost.intent, signature, quoteRef: { rfqId: "rfq_r", answerId: "ans_1", optionId: "o1" } } };
    const env = await runTool("cork_submit", sub, ctxWith([...routes, { match: "/rollover/v1/orders", status: 201, body: {} }], seen));
    expect(env.state).toBe("ok");
    expect((seen.find((s) => s.method === "POST")!.body as { quoteRef: unknown }).quoteRef).toEqual({ rfqId: "rfq_r", answerId: "ans_1", optionId: "o1" });
    const other = rolloverRecord({ answers: [quotedAnswer([{ ...POOL_OPTION, premium_per_share: "9000000" }])] });
    const refusedSeen: Seen[] = [];
    const refused = await runTool("cork_submit", sub, ctxWith([{ match: "/rfqs/v2/rfq_r", body: other }, { match: "/rollover/v1/orders", status: 201, body: {} }], refusedSeen));
    expect(refused.state).toBe("unavailable");
    expect(refused.warnings[0]?.message).toMatch(/below the quoted premium_per_share/u);
    expect(refusedSeen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
});

describe("rollover firmness", () => {
  it("only a confirmed live rollover order citing the quote backs it, and only rollover RFQs are labeled by it", () => {
    const cited = citedRolloverOptionKeys([
      { verification: "confirmed", quoteRef: { rfqId: "rfq_r", answerId: "ans_1", optionId: "o1" } },
      { verification: "unverified", quoteRef: { rfqId: "rfq_r", answerId: "ans_1", optionId: "o2" } },
    ]);
    expect([...cited]).toEqual(["ans_1|o1"]);
    const rows = [rolloverRecord({ answers: [quotedAnswer([POOL_OPTION, { ...POOL_OPTION, option_id: "o2" }])] }), { kind: "new_position", answers: [] }];
    const [roll, np] = markFirmOptions(rows, cited, "rollover");
    expect(roll).toMatchObject({ firmQuotes: 1, indicativeQuotes: 1 });
    expect(np).not.toHaveProperty("firmQuotes");
    expect(markFirmOptions([rows[0]!], cited)[0]).not.toHaveProperty("firmQuotes");
  });

  it("an rfqs read of a rollover RFQ joins the rollover order feed by rfqId (fillable only)", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_query", { resource: "rfqs", chainId: 42161, filters: { rfqId: "rfq_r" } }, ctxWith([
      { match: "/rollover/v1/orders", body: { items: [{ orderDigest: `0x${"77".repeat(32)}`, settler: EXACT_02, status: "OPEN", quoteRef: { rfqId: "rfq_r", answerId: "ans_1", optionId: "o1" } }] } },
      { match: "/limit-orders/v1/orderbook", body: { items: [] } },
      { match: "/rfqs/v2/rfq_r", body: rolloverRecord({ answers: [quotedAnswer([POOL_OPTION])] }) },
    ], seen));
    expect(env.state).toBe("ok");
    const call = seen.find((s) => s.url.includes("/rollover/v1/orders"))!;
    expect(call.url).toContain("rfqId=rfq_r");
    expect(call.url).toContain("fillable=true");
    // No chain to confirm the order: it backs nothing.
    const row = (env.data as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(row).toMatchObject({ firmQuotes: 0, indicativeQuotes: 1 });
    expect((env.data as { rolloverFirmness: unknown }).rolloverFirmness).toBeDefined();
  });
});
