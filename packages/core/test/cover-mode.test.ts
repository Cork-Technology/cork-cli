// Cover against mode, from identities (cork-cli#6) and the fixed recipe's resolvable domain
// (cork-cli#5). The pure readers are pinned on their own; the three surfaces — answer-rfq, the
// rfq-answer relay, and the requester's fill of a cited venue row — run the REAL handlers
// against the eval stub's chain + venue (the production derivation, not a mock of it).
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { buildJitExtension, buildMakerOrder, BUNDLED_DEFAULTS, encodeJitExtraData, fixedRateBoundaryNote, generationsOf, hashLopOrder, LOP_ADDRESSES, premiumAmount, runTool, type HandlerContext } from "@cork/core";
import { quotedOrderWire } from "../src/rfq-quotes.ts";
import { DEMO_ACCOUNT, RFQ_MODES } from "@cork/schemas";
import { answerOptionsCoverWarnings, deliveredCoverOfExtension, requesterCoverVerdict, rfqModesOf } from "../src/handlers/cover-mode.ts";
import { FIXED_RECIPE, IMPAIRMENT_RECIPE, JIT_TASK_PAIR, LIQUIDITY_RECIPE, RFQ_FIXED_ID, RFQ_IMPAIRMENT_EXPIRY, RFQ_OPEN_ID, stubContext } from "../../../evals/stub.ts";
import { proveRfqWrite, signQuotes, stubRpc } from "./helpers.ts";

const CHAIN = 42161;
const NOW = 1_790_000_000n;
const GENS = generationsOf(BUNDLED_DEFAULTS, CHAIN);
const UINT256_MAX = 2n ** 256n - 1n;
/** The phoenix/v0.3-rc.1 (flat-wire) JIT adapter on 42161 — a classified hook target. */
const ADAPTER = "0x8902a88912a334263fe3d731d03c267715b9374f" as const;
const UNNAMED_RECIPE = "0x00000000000000000000000000000000000000ee" as const;
const EXPIRY = NOW + 7n * 86_400n;
const codes = (w: ReadonlyArray<{ code: string }>) => w.map((x) => x.code);
const coverWarnings = (env: { warnings: ReadonlyArray<{ code: string; message: string }> }) => env.warnings.filter((w) => w.code === "cover_mode_mismatch");

const jitExtension = (recipe: `0x${string}`, constraint = { rateMin: 10n ** 18n, rateMax: 2n * 10n ** 18n, rateChangePerDayMax: 10n ** 16n, rateChangeCapacityMax: 10n ** 17n }) =>
  buildJitExtension(ADAPTER, encodeJitExtraData("flat", { collateralAsset: JIT_TASK_PAIR.collateralAsset, referenceAsset: JIT_TASK_PAIR.referenceAsset, expiryTimestamp: EXPIRY, recipe, rateOverride: 0n, constraint, extraData: "0x", swapFeePercentage: 0n, unwindSwapFeePercentage: 0n, enableJitMint: false }, []));

describe("the pure readers", () => {
  it("rfqModesOf reads a flattened record or a raw v2 row, and drops what the venue would not serve", () => {
    expect(rfqModesOf({ modes: ["fixed_rate", "bogus"] })).toEqual(["fixed_rate"]);
    expect(rfqModesOf({ request: { modes: ["liquidity_only", "liquidity_impairment"] } })).toEqual(["liquidity_only", "liquidity_impairment"]);
    expect(rfqModesOf(undefined)).toEqual([]);
    for (const m of RFQ_MODES) expect(rfqModesOf({ modes: [m] })).toEqual([m]);
  });

  it("deliveredCoverOfExtension: the recipe the JIT block names decides; an unnamed recipe is read from its limits; no block, no verdict", () => {
    expect(deliveredCoverOfExtension(GENS, jitExtension(LIQUIDITY_RECIPE))).toMatchObject({ kind: "liquidity", by: "recipe", recipe: LIQUIDITY_RECIPE, recipeName: "liquidity", generation: "phoenix/v0.3-rc.1" });
    expect(deliveredCoverOfExtension(GENS, jitExtension(IMPAIRMENT_RECIPE))).toMatchObject({ kind: "impairment", by: "recipe" });
    expect(deliveredCoverOfExtension(GENS, jitExtension(FIXED_RECIPE))).toMatchObject({ kind: "fixed-rate", by: "recipe" });
    // A recipe no generation names, carrying a fixed recipe's signature limits (both allowances zero).
    const unnamed = deliveredCoverOfExtension(GENS, jitExtension(UNNAMED_RECIPE, { rateMin: 7n, rateMax: 8n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n }));
    expect(unnamed).toMatchObject({ kind: "fixed-rate", by: "constraint", recipeName: null });
    expect(unnamed.recipe?.toLowerCase()).toBe(UNNAMED_RECIPE);
    expect(deliveredCoverOfExtension(GENS, undefined)).toEqual({ kind: null, by: "no-jit-block", recipe: null });
    expect(deliveredCoverOfExtension(GENS, "0x")).toEqual({ kind: null, by: "no-jit-block", recipe: null });
    // A hook at an adapter no generation configures is unknown, never a guessed layout.
    expect(deliveredCoverOfExtension(GENS, buildJitExtension("0x00000000000000000000000000000000000000ad", "0x1234"))).toEqual({ kind: null, by: "unclassified-adapter", recipe: null });
  });

  it("requesterCoverVerdict: a cover the request did not ask for is warned from the recipe, whatever the label says", () => {
    const delivered = deliveredCoverOfExtension(GENS, jitExtension(LIQUIDITY_RECIPE));
    const mismatch = requesterCoverVerdict({ rfqId: "rfq_x", requested: ["fixed_rate"], delivered, citedOptionMode: "fixed_rate", requester: DEMO_ACCOUNT, filler: DEMO_ACCOUNT });
    expect(codes(mismatch.warnings)).toEqual(["cover_mode_mismatch"]);
    expect(mismatch.warnings[0]!.message).toMatch(/asks for fixed_rate = fixed-rate cover.*liquidity recipe.*gives liquidity cover.*labelled fixed_rate, which does not name this cover either.*for you, the requester, to accept or refuse/u);
    expect(mismatch.cover).toMatchObject({ requestedModes: ["fixed_rate"], requestedCovers: ["fixed-rate"], delivered: { kind: "liquidity", by: "recipe" }, citedOptionMode: "fixed_rate", agrees: false, fillerIsRequester: true });
    // The same fill by someone else: the wording addresses the requester in the third person.
    const other = requesterCoverVerdict({ rfqId: "rfq_x", requested: ["fixed_rate"], delivered, citedOptionMode: undefined, requester: DEMO_ACCOUNT, filler: "0x00000000000000000000000000000000000000f1" });
    expect(other.warnings[0]!.message).toMatch(/for the requester to accept or refuse/u);
    expect(other.cover).toMatchObject({ fillerIsRequester: false, citedOptionMode: null });
  });

  it("requesterCoverVerdict: a matching cover is silent; a wrong label on a matching cover is named; no modes = no verdict; an unread RFQ is said", () => {
    const delivered = deliveredCoverOfExtension(GENS, jitExtension(LIQUIDITY_RECIPE));
    const ok = requesterCoverVerdict({ rfqId: "rfq_x", requested: ["liquidity_only", "fixed_rate"], delivered, citedOptionMode: "liquidity_only", requester: undefined, filler: DEMO_ACCOUNT });
    expect(ok.warnings).toEqual([]);
    expect(ok.cover).toMatchObject({ agrees: true });
    const label = requesterCoverVerdict({ rfqId: "rfq_x", requested: ["liquidity_only"], delivered, citedOptionMode: "fixed_rate", requester: undefined, filler: DEMO_ACCOUNT });
    expect(codes(label.warnings)).toEqual(["cover_mode_mismatch"]);
    expect(label.warnings[0]!.message).toMatch(/labelled fixed_rate \(fixed-rate cover.*gives liquidity cover \(.*\): the label misdescribes the cover.*do admit liquidity cover/u);
    expect(label.cover).toMatchObject({ agrees: true });
    const none = requesterCoverVerdict({ rfqId: "rfq_x", requested: [], delivered, citedOptionMode: undefined, requester: undefined, filler: DEMO_ACCOUNT });
    expect(none.warnings).toEqual([]);
    expect(none.cover).toMatchObject({ agrees: null });
    const plain = requesterCoverVerdict({ rfqId: "rfq_x", requested: ["fixed_rate"], delivered: { kind: null, by: "no-jit-block", recipe: null }, citedOptionMode: "fixed_rate", requester: undefined, filler: DEMO_ACCOUNT });
    expect(plain.warnings).toEqual([]);
    expect(plain.cover).toMatchObject({ delivered: { kind: null, by: "no-jit-block" }, agrees: null });
    expect((plain.cover as { delivered: { note: string } }).delivered.note).toMatch(/read the pool/u);
    const unread = requesterCoverVerdict({ rfqId: "rfq_x", requested: [], delivered, citedOptionMode: undefined, requester: undefined, filler: DEMO_ACCOUNT, notRead: "HTTP 503" });
    expect(codes(unread.warnings)).toEqual(["invalid_order_terms"]);
    expect(unread.warnings[0]!.message).toMatch(/could not be read \(HTTP 503\).*NOT compared/u);
    expect(unread.cover).toMatchObject({ notRead: "HTTP 503" });
  });

  it("answerOptionsCoverWarnings: a label against its template's recipe, and against the request's modes", async () => {
    const rfq = { rfq_id: "rfq_a", modes: ["liquidity_only"] };
    const navTemplate = { inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: { schema: "cork-inline-fixed/1", rate_override: "750000000000000000" } } };
    const w = await answerOptionsCoverWarnings(CHAIN, rfq, [
      { option_id: "a", mode: "fixed_rate", market_template: navTemplate }, // label vs recipe, AND vs the request
      { option_id: "b", mode: "liquidity_only", market_template: { inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: {} } } }, // agrees
      { option_id: "c", mode: "liquidity_impairment", market_template: { market_template_id: "tmpl_1" } }, // no recipe to judge; a counter-proposal
      { option_id: "d", mode: "fixed_rate", market_template: { inline: { oracle_recipe: FIXED_RECIPE, oracle_params: { rate_override: "1" } } } }, // fixed on fixed; a counter-proposal
    ]);
    expect(codes(w)).toEqual(["cover_mode_mismatch", "cover_mode_mismatch", "cover_mode_mismatch", "cover_mode_mismatch"]);
    expect(w[0]!.message).toMatch(/^options\[0\] is labelled fixed_rate \(fixed-rate cover.*names the liquidity recipe.*gives liquidity cover.*label the option liquidity_only/u);
    expect(w[1]!.message).toMatch(/^options\[0\] quotes mode fixed_rate, which rfq_a does not ask for \(liquidity_only\)/u);
    expect(w[2]!.message).toMatch(/^options\[2\] quotes mode liquidity_impairment/u);
    expect(w[3]!.message).toMatch(/^options\[3\] quotes mode fixed_rate/u);
    expect(await answerOptionsCoverWarnings(CHAIN, { modes: [] }, [{ mode: "fixed_rate", market_template: { market_template_id: "t" } }])).toEqual([]);
  });

  it("fixedRateBoundaryNote: the maximum alone, naming the helper's domain and the creatable pool", () => {
    expect(fixedRateBoundaryNote(UINT256_MAX)).toMatch(/recipe helper resolves 1 \.\. MAX − 1.*create-pool with the EXPLICIT constraint \{ rateMin: MAX − 1, rateMax: MAX/u);
    expect(fixedRateBoundaryNote(UINT256_MAX - 1n)).toBeUndefined();
    expect(fixedRateBoundaryNote(1n)).toBeUndefined();
  });
});

describe("answer-rfq against the eval stub: the cover the recipe decides vs the RFQ's modes", () => {
  const ctx = stubContext();
  type Answered = { answer: { cover: { kind: string | null; mode: string; deliveredMode: string | null; requestedModes: string[]; agrees: boolean | null; recipe: string; by: string } } };
  it("a liquidity recipe answering a fixed_rate request: cover_mode_mismatch (not invalid_order_terms), answer.cover says why", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: CHAIN, account: DEMO_ACCOUNT, clientRequestId: "cover-answer-0001", action: { type: "answer-rfq", rfqId: RFQ_FIXED_ID, premiumAnnualized: "0.04", expiryTimestamp: RFQ_IMPAIRMENT_EXPIRY.toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const modeWarnings = env.warnings.filter((w) => /does not ask for/u.test(w.message));
    expect(codes(modeWarnings)).toEqual(["cover_mode_mismatch"]);
    expect(modeWarnings[0]!.message).toMatch(/quotes mode liquidity_only \(liquidity cover, decided by the recipe/u);
    expect((env.data as Answered).answer.cover).toEqual({ kind: "liquidity", mode: "liquidity_only", deliveredMode: "liquidity_only", requestedModes: ["fixed_rate"], agrees: false, recipe: LIQUIDITY_RECIPE, by: "the configured recipe hint" });
  });
  it("a caller's label that disagrees with the recipe is named, and the request is judged against the RECIPE's cover, not the label", async () => {
    // fixed_rate label on the liquidity recipe, on a liquidity_only request: the label is wrong, the cover agrees.
    const onLiquidity = await runTool("cork_prepare_orders", { chainId: CHAIN, account: DEMO_ACCOUNT, clientRequestId: "cover-answer-0003", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: RFQ_IMPAIRMENT_EXPIRY.toString(), mode: "fixed_rate", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(onLiquidity.state, JSON.stringify(onLiquidity.warnings)).toBe("ok");
    expect(coverWarnings(onLiquidity).map((w) => w.message)).toEqual([expect.stringMatching(/^this option is labelled fixed_rate \(fixed-rate cover\), but the recipe .* gives liquidity cover: the label misdescribes.*label the option liquidity_only/u)]);
    expect((onLiquidity.data as Answered).answer.cover).toMatchObject({ kind: "liquidity", mode: "fixed_rate", deliveredMode: "liquidity_only", requestedModes: ["liquidity_only"], agrees: true });
    // The same label on a fixed_rate request: the label is wrong AND the delivered cover is a counter-proposal.
    const onFixed = await runTool("cork_prepare_orders", { chainId: CHAIN, account: DEMO_ACCOUNT, clientRequestId: "cover-answer-0004", action: { type: "answer-rfq", rfqId: RFQ_FIXED_ID, premiumAnnualized: "0.04", expiryTimestamp: RFQ_IMPAIRMENT_EXPIRY.toString(), mode: "fixed_rate", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(onFixed.state, JSON.stringify(onFixed.warnings)).toBe("ok");
    expect(codes(coverWarnings(onFixed))).toEqual(["cover_mode_mismatch", "cover_mode_mismatch"]);
    expect(coverWarnings(onFixed)[1]!.message).toMatch(/^this answer quotes mode liquidity_only \(liquidity cover, decided by the recipe/u);
    expect((onFixed.data as Answered).answer.cover).toMatchObject({ kind: "liquidity", mode: "fixed_rate", deliveredMode: "liquidity_only", requestedModes: ["fixed_rate"], agrees: false });
  });
  it("the recipe the request asked for: agrees, no cover warning", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: CHAIN, account: DEMO_ACCOUNT, clientRequestId: "cover-answer-0002", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: RFQ_IMPAIRMENT_EXPIRY.toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(coverWarnings(env)).toEqual([]);
    expect((env.data as Answered).answer.cover).toMatchObject({ kind: "liquidity", mode: "liquidity_only", requestedModes: ["liquidity_only"], agrees: true });
  });
});

describe("derive-cork-pool at uint256's maximum on the fixed recipe: refused as the helper's limit, named", () => {
  const ctx = stubContext();
  const derive = (rate: bigint) => runTool("cork_query", { resource: "derive-cork-pool", chainId: CHAIN, filters: { ...JIT_TASK_PAIR, expiry: RFQ_IMPAIRMENT_EXPIRY.toString(), recipe: FIXED_RECIPE, rate: rate.toString() } }, ctx);
  it("MAX refuses recipe_refused with the boundary note; MAX − 1 and a normal rate derive", async () => {
    const max = await derive(UINT256_MAX);
    expect(max.state).toBe("unavailable");
    expect(max.warnings[0]!.code).toBe("recipe_refused");
    expect(max.warnings[0]!.message).toMatch(/Panic\(17\).*recipe helper resolves 1 \.\. MAX − 1.*create-pool/u);
    const below = await derive(UINT256_MAX - 1n);
    expect(below.state, JSON.stringify(below.warnings)).toBe("ok");
    expect((below.data as { pool: { constraint: { rateMin: string; rateMax: string } } }).pool.constraint).toMatchObject({ rateMin: (UINT256_MAX - 1n).toString(), rateMax: UINT256_MAX.toString() });
    expect(below.warnings.some((w) => /MAX − 1/u.test(w.message))).toBe(false);
    const normal = await derive(10n ** 18n);
    expect(normal.state).toBe("ok");
  });
});

describe("cork_submit rfq-answer: a fixed_rate label on a NAV template is named before relay (relayed as asked)", () => {
  const WRITER = privateKeyToAccount(`0x${"4d".repeat(32)}`);
  const stub = stubContext();
  const posts: Array<Record<string, unknown>> = [];
  const ctx: HandlerContext = {
    ...stub,
    venueFetch: async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return stub.venueFetch!(url, init);
    },
  };
  const STUB_EXPIRY = Number(RFQ_IMPAIRMENT_EXPIRY);
  // The option's terms are held to its order: the premium IS the order's amounts (the ACT/365 amount math).
  const NOTIONAL = 1000n * 10n ** 18n;
  const order = (salt: number) => ({ salt: String(salt), maker: WRITER.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c", takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: NOTIONAL.toString(), takingAmount: premiumAmount("0.05", NOTIONAL, BigInt(STUB_EXPIRY) - NOW).toString(), makerTraits: "0" });
  const option = (over: Record<string, unknown>) => ({ option_id: "opt1", chain_id: CHAIN, collateral_asset: JIT_TASK_PAIR.collateralAsset, reference_asset: JIT_TASK_PAIR.referenceAsset, mode: "liquidity_only", package_id: "balanced-v1", expiry: STUB_EXPIRY, premium_annualized: "0.05", notional_max_assets: "1000000000000000000000", fresh_until: Number(NOW) + 600, order: order(1), ...over });
  const post = async (options: Array<Record<string, unknown>>) => runTool("cork_submit", await proveRfqWrite(WRITER, { chainId: CHAIN, clientRequestId: `cover-relay-${posts.length + 1}`, action: { type: "rfq-answer", rfqId: RFQ_OPEN_ID, underwriter: WRITER.address, status: "quoted", options: await signQuotes(WRITER, options), auth: { method: "signature", signature: "0x00" } } }), ctx);
  it("labelled fixed_rate with the NAV recipe's template on a liquidity_only request: two cover_mode_mismatch, relayed", async () => {
    const env = await post([option({ mode: "fixed_rate", market_template: { inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: { schema: "cork-inline-fixed/1", rate_override: "750000000000000000" } } } })]);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(codes(coverWarnings(env))).toEqual(["cover_mode_mismatch", "cover_mode_mismatch"]);
    expect(coverWarnings(env)[0]!.message).toMatch(/options\[0\] is labelled fixed_rate.*names the liquidity recipe.*gives liquidity cover/u);
    expect(coverWarnings(env)[1]!.message).toMatch(/options\[0\] quotes mode fixed_rate, which rfq_open7 does not ask for \(liquidity_only\)/u);
    expect(posts).toHaveLength(1);
  });
  it("the request's own mode on its own recipe: silent", async () => {
    const env = await post([option({ market_template: { inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: { schema: "cork-inline-liquidity/1", anchor_rate: "700000000000000000" } } } })]);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(coverWarnings(env)).toEqual([]);
  });
});

describe("taker-fill through the venue book: the cover the fill BUYS vs the cited RFQ (the requester's side)", () => {
  const maker = privateKeyToAccount(`0x${"3a".repeat(32)}`);
  const LOP = LOP_ADDRESSES[CHAIN]!;
  const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69" as const;
  const REQUESTER = "0x00000000000000000000000000000000000000ab" as const;
  const world = async (opts: { recipe: `0x${string}`; modes: string[]; citedMode: string; rfqServed?: boolean }) => {
    const extension = jitExtension(opts.recipe);
    const built = buildMakerOrder({ chainId: CHAIN, lop: LOP, maker: maker.address, makerAsset: CST, takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: 10n ** 18n, takingAmount: 10n ** 15n, clientRequestId: "cover-fill-maker-0001", expiry: NOW + 600n, allowPartialFills: false, extension });
    const signature = await maker.sign({ hash: built.orderHash });
    const row = { orderHash: built.orderHash, order: quotedOrderWire(built.order), signature, extension: built.extension, makerAccountType: "EOA", side: "SELL", status: "OPEN", quote_ref: { rfq_id: "rfq_cv1", answer_id: "ans_cv1", option_id: "opt_cv1" } };
    const rfq = { rfq_id: "rfq_cv1", kind: "new_position", state: "open", truncated: false, request: { chain_id: CHAIN, requester: REQUESTER, modes: opts.modes }, answers: [{ answer_id: "ans_cv1", underwriter: maker.address.toLowerCase(), answer: { status: "quoted", options: [{ option_id: "opt_cv1", mode: opts.citedMode, chain_id: CHAIN }] } }] };
    const venueFetch = async (url: string) => {
      if (url.includes("/limit-orders/v1/orderbook")) return new Response(JSON.stringify({ items: [row], hasMore: false }), { status: 200 });
      if (url.includes("/rfqs/v2/rfq_cv1")) return opts.rfqServed === false ? new Response("down", { status: 503 }) : new Response(JSON.stringify(rfq), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const resolveRpc = stubRpc((c) => {
      switch (c.functionName) {
        case "bitInvalidatorForOrder":
          return 0n;
        case "allowance":
        case "balanceOf":
          return 10n ** 24n;
        default:
          throw new Error(`no stub for ${c.functionName}`);
      }
    });
    return { orderHash: built.orderHash, ctx: { nowSeconds: NOW, venueFetch, resolveRpc } as HandlerContext };
  };
  const fill = (w: Awaited<ReturnType<typeof world>>, account: `0x${string}` = REQUESTER) => runTool("cork_prepare_orders", { chainId: CHAIN, account, clientRequestId: "cover-fill-0001", action: { type: "taker-fill", orderHash: w.orderHash } }, w.ctx);
  type FillData = { cover?: { delivered: { kind: string | null }; agrees: boolean | null; fillerIsRequester: boolean; citedOptionMode: string | null; notRead?: string } };

  it("a liquidity order cited on a fixed_rate request: cover_mode_mismatch names the recipe, the label and the requester; the bytes still build", async () => {
    const env = await fill(await world({ recipe: LIQUIDITY_RECIPE, modes: ["fixed_rate"], citedMode: "fixed_rate" }));
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(codes(coverWarnings(env))).toEqual(["cover_mode_mismatch"]);
    expect(coverWarnings(env)[0]!.message).toMatch(/RFQ rfq_cv1 asks for fixed_rate.*liquidity recipe.*gives liquidity cover.*labelled fixed_rate, which does not name this cover either.*for you, the requester/u);
    const d = env.data as FillData;
    expect(d.cover).toMatchObject({ delivered: { kind: "liquidity" }, agrees: false, fillerIsRequester: true, citedOptionMode: "fixed_rate" });
    expect((env.data as { calldata: string }).calldata.startsWith("0x")).toBe(true);
  });
  it("the cover the request asked for, correctly labelled: data.cover agrees, no warning", async () => {
    const env = await fill(await world({ recipe: FIXED_RECIPE, modes: ["fixed_rate", "liquidity_only"], citedMode: "fixed_rate" }));
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(coverWarnings(env)).toEqual([]);
    expect((env.data as FillData).cover).toMatchObject({ delivered: { kind: "fixed-rate" }, agrees: true });
  });
  it("an RFQ the venue does not serve: the comparison is reported as not made, never as agreement", async () => {
    const env = await fill(await world({ recipe: LIQUIDITY_RECIPE, modes: ["fixed_rate"], citedMode: "fixed_rate", rfqServed: false }));
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(coverWarnings(env)).toEqual([]);
    expect(env.warnings.some((w) => w.code === "invalid_order_terms" && /NOT compared/u.test(w.message))).toBe(true);
    expect((env.data as FillData).cover).toMatchObject({ agrees: null });
    expect((env.data as FillData).cover?.notRead).toMatch(/rfq_cv1/u);
  });
  it("an inline signedOrder carries no citation: no cover block, the venue untouched", async () => {
    const w = await world({ recipe: LIQUIDITY_RECIPE, modes: ["fixed_rate"], citedMode: "fixed_rate" });
    const extension = jitExtension(LIQUIDITY_RECIPE);
    const built = buildMakerOrder({ chainId: CHAIN, lop: LOP, maker: maker.address, makerAsset: CST, takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: 10n ** 18n, takingAmount: 10n ** 15n, clientRequestId: "cover-fill-maker-0002", expiry: NOW + 600n, allowPartialFills: false, extension });
    const signature = await maker.sign({ hash: built.orderHash });
    expect(hashLopOrder(CHAIN, LOP, built.order)).toBe(built.orderHash);
    const env = await runTool("cork_prepare_orders", { chainId: CHAIN, account: REQUESTER, clientRequestId: "cover-fill-0002", action: { type: "taker-fill", orderHash: built.orderHash, signedOrder: { order: quotedOrderWire(built.order), signature, extension: built.extension } } }, { ...w.ctx, venueFetch: async () => { throw new Error("venue contacted"); } });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as FillData).cover).toBeUndefined();
  });
});
