// answer-rfq and refresh-order — the underwriter's two most frequent moves as one call each.
// The amount math is pinned to the kernel's golden (the venue's golden-units script);
// the handler runs against the eval stub's full chain + venue (the same stack the JIT tasks use:
// registry, recipe.resolve, share prediction via eth_simulateV1, decimals), so the derivation is
// the production path, not a mock of it.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { answerOcoGroup, buildMakerOrder, coverMakingAmount, decodeMakerTraits, impliedPremiumWad, LOP_ADDRESSES, premiumAmount, premiumFraction, RE_REST_MAX_SECONDS, RE_REST_MIN_SECONDS, reRestExpirySeconds, runTool, ToolInputError, YEAR_SECONDS, type HandlerContext, type ResolvedRpc } from "@cork/core";
import { stubRpc } from "./helpers.ts";
import { DEMO_ACCOUNT } from "@cork/schemas";
import { encodeAnchorArgs, encodeImpairmentArgs, inlineAdditionalData, inlineParamsOfTemplate, INLINE_IMPAIRMENT_SCHEMA, INLINE_LIQUIDITY_SCHEMA } from "@cork/core";
import { DERIVED_JIT_POOL, FIRM_ANSWER_ID, JIT_TASK_CONSTRAINT, JIT_TASK_EXPIRY, JIT_TASK_PAIR, LIQUIDITY_RECIPE, RC2_CLONE_OWNER, RFQ_INLINE_ANCHOR, RFQ_INLINE_ANSWER_ID, RFQ_INLINE_ID, RFQ_INLINE_OPTION_ANCHOR, RFQ_NOSENDER_ID, RFQ_OPEN_ID, SIGNED_LOP_PAYLOAD, stubContext, DEPLOYED_FIXED_RATE, FIXED_RECIPE, RFQ_FIXED_ID, RFQ_FIXED_ABOVE_ID, RFQ_FIXED_RATE, RFQ_FIXED_ANSWER_ID, RFQ_FIXED_OPTION_RATE, RFQ_IMPAIRMENT_ID, RFQ_IMPAIRMENT_PARTIAL_ID, RFQ_IMPAIRMENT_DURATION, RFQ_IMPAIRMENT_SPREAD, RFQ_IMPAIRMENT_EXPIRY, IMPAIRMENT_RECIPE } from "../../../evals/stub.ts";

describe("the kernel's amount math (ACT/365, rounded toward the maker)", () => {
  it("golden: 3.6% on 50,000 bbqUSDC (6 dec) for exactly one day → 4931507 (scripts/golden-units.mjs)", () => {
    expect(premiumAmount("0.036", 50_000n * 10n ** 6n, 86_400n)).toBe(4931507n);
    // toward the maker: the exact quotient is 4931506.849…, so floor would short the maker.
    expect((36n * 50_000n * 10n ** 6n * 86_400n) / (1000n * YEAR_SECONDS)).toBe(4931506n);
  });
  it("an exact quotient is not bumped; the fraction parses exactly (no float)", () => {
    expect(premiumAmount("0.5", 2n * YEAR_SECONDS, YEAR_SECONDS)).toBe(YEAR_SECONDS);
    expect(premiumFraction("0.041")).toEqual({ num: 41n, den: 1000n });
    expect(premiumFraction("1")).toEqual({ num: 1n, den: 1n });
    expect(premiumFraction("0.49999999999999999")).toEqual({ num: 49999999999999999n, den: 10n ** 17n });
    expect(() => premiumFraction("4.1%")).toThrow(/decimal-fraction/);
    expect(() => premiumAmount("0.04", 0n, 1n)).toThrow(/notional/);
    expect(() => premiumAmount("0.04", 1n, 0n)).toThrow(/tenor/);
  });
  it("makingAmount is the notional as 18-decimal cST; the amounts decode back to the fraction within a microunit", () => {
    expect(coverMakingAmount(50_000n * 10n ** 6n, 6)).toBe(50_000n * 10n ** 18n);
    expect(coverMakingAmount(7n * 10n ** 18n, 18)).toBe(7n * 10n ** 18n);
    const wad = impliedPremiumWad(4931507n, 50_000n * 10n ** 6n, 86_400n);
    expect(wad - 36n * 10n ** 15n).toBeLessThan(10n ** 12n);
    expect(wad).toBeGreaterThanOrEqual(36n * 10n ** 15n);
  });
  it("re-rest rule: max(90 s, min(600 s, remaining / 2))", () => {
    expect(reRestExpirySeconds(5_000_000n)).toBe(RE_REST_MAX_SECONDS);
    expect(reRestExpirySeconds(700n)).toBe(350);
    expect(reRestExpirySeconds(100n)).toBe(RE_REST_MIN_SECONDS);
    expect(answerOcoGroup("rfq_1")).toBe("rfq:rfq_1");
  });
});

describe("cork_prepare_orders answer-rfq — the RFQ record + the caller's premium → one signable reserved cover order", () => {
  const NOW = 1_790_000_000n; // the eval stub's clock
  const ctx = stubContext();
  const base = { chainId: 42161 as const, account: DEMO_ACCOUNT, clientRequestId: "answer-0001" };
  type Answered = { kind: string; orderHash: string; nonce: string; ocoGroup: string; allowedSender: string | null; typedData: { message: Record<string, string> }; jit?: { derivedPoolId: string; predictedCorkSwapToken?: string }; answer: { reach: string; requester: string; takingAmount: string; makingAmount: string; tenorSeconds: string; reservedFor: string; expirySeconds: number; expiryRule: string; quoteRef: unknown; pool: { poolId: string; corkSwapToken: string; exists: boolean }; collateralDecimals: number; impliedPremiumWad: string }; execution: { then: string[] } };

  it("uncited: pair/notional/requester from the RFQ, the kernel's amounts, reserved for the requester, the re-rest expiry, one bit per RFQ", async () => {
    // 20 days out: inside the registry's 30-day creation bound (the stub RFQ's own window sits years
    // out, so this is a visible counter-proposal — warned, built).
    const expiry = NOW + 20n * 86_400n;
    const env = await runTool("cork_prepare_orders", { ...base, action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry.toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    expect(d.kind).toBe("maker-order"); // the SAME artifact maker-order returns (finalize takes it verbatim)
    const notional = 1000n * 10n ** 18n; // the RFQ's notional_assets
    const tenor = expiry - NOW;
    expect(d.answer.tenorSeconds).toBe(tenor.toString());
    expect(d.answer.collateralDecimals).toBe(18);
    expect(d.answer.takingAmount).toBe(premiumAmount("0.04", notional, tenor).toString());
    expect(d.answer.makingAmount).toBe(notional.toString());
    expect(d.typedData.message.takingAmount).toBe(d.answer.takingAmount);
    expect(d.typedData.message.makingAmount).toBe(d.answer.makingAmount);
    expect(d.typedData.message.takerAsset!.toLowerCase()).toBe(JIT_TASK_PAIR.collateralAsset.toLowerCase());
    // The maker side is the DERIVED pool's cST — the pool the cover creates on fill — and the id
    // is the one derive-cork-pool answers for the same legs (one derivation, two doors).
    const derived = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, filters: { ...JIT_TASK_PAIR, expiry: expiry.toString(), recipe: LIQUIDITY_RECIPE } }, ctx);
    const dp = derived.data as { pool: { poolId: string }; shares: { corkSwapToken: string } };
    expect(d.answer.pool.poolId.toLowerCase()).toBe(dp.pool.poolId.toLowerCase());
    expect(d.typedData.message.makerAsset!.toLowerCase()).toBe(dp.shares.corkSwapToken.toLowerCase());
    expect(d.jit?.derivedPoolId.toLowerCase()).toBe(dp.pool.poolId.toLowerCase());
    expect(env.warnings.some((w) => w.code === "invalid_order_terms" && w.message.includes("expiry_window"))).toBe(true);
    // Reach: reserved for the RFQ's DECLARED fill_sender (low 80 bits), by default — the stub RFQ
    // declares one (it happens to be the requester's own address).
    expect(d.answer.reservedFor.toLowerCase()).toBe(RC2_CLONE_OWNER.toLowerCase());
    expect(d.allowedSender).toBe(`0x${RC2_CLONE_OWNER.slice(-20).toLowerCase()}`);
    expect(d.answer.reach).toBe("reserved");
    expect(env.warnings.some((w) => w.code === "fill_sender_unknown")).toBe(false);
    // Expiry: the RFQ's valid_until (1795000000) is 5e6 s away → the 600 s cap applies.
    expect(d.answer.expirySeconds).toBe(600);
    expect(d.answer.expiryRule).toContain("re-rest rule");
    expect(BigInt(decodeMakerTraits(BigInt(d.typedData.message.makerTraits!)).expiry)).toBe(NOW + 600n);
    expect(d.ocoGroup).toBe(`rfq:${RFQ_OPEN_ID}`);
    // RFQ v2: the answer option is built from the SAME numbers as the order, and carries it.
    const q = (d.answer as unknown as { quotedOption: Record<string, unknown>; supersedes: string | null; orderHash: string }).quotedOption;
    expect(q).toMatchObject({ chain_id: 42161, collateral_asset: JIT_TASK_PAIR.collateralAsset.toLowerCase(), reference_asset: JIT_TASK_PAIR.referenceAsset.toLowerCase(), mode: "liquidity_only", package_id: "pkg_default", expiry: Number(expiry), premium_annualized: "0.04", notional_max_assets: notional.toString(), fresh_until: Number(NOW + 600n) });
    expect(q.option_id).toMatch(/^opt-[0-9a-f]{12}$/u);
    expect((q.market_template as { inline: { oracle_recipe: string } }).inline.oracle_recipe).toBe(LIQUIDITY_RECIPE.toLowerCase());
    const sent = q.order as Record<string, string>;
    for (const k of ["salt", "makingAmount", "takingAmount", "makerTraits"]) expect(sent[k]).toBe(d.typedData.message[k]);
    for (const k of ["maker", "receiver", "makerAsset", "takerAsset"]) expect(sent[k]).toBe(d.typedData.message[k]!.toLowerCase());
    expect((d.answer as unknown as { orderHash: string }).orderHash).toBe(d.orderHash);
    expect((d.answer as unknown as { supersedes: string | null }).supersedes).toBeNull();
    // The answer id is known only once the answer is posted.
    expect(d.answer.quoteRef).toEqual({ rfqId: RFQ_OPEN_ID, answerId: null, optionId: q.option_id });
    // The answer goes before the book: the venue refuses a quote whose order already rests there.
    const steps = d.execution.then;
    const at = (needle: string) => steps.findIndex((x) => x.includes(needle));
    expect(at("finalize-maker-order")).toBeLessThan(at("rfq-write"));
    expect(at("cork_submit rfq-answer")).toBeLessThan(at("cork_submit lop-order"));
    expect(d.execution.then.some((s) => s.includes("refresh-order"))).toBe(true);
    expect(env.warnings.some((w) => w.code === "oco_group_notice")).toBe(true);
  });

  it("the UNDERWRITER is told when a NAV-read reference keeps bad debt out of its share price — and ONLY for a NAV-sourced recipe", async () => {
    // The same chain, with the reference answering the MetaMorpho v1.1 view (YCSUSDC's counter, 31.38 of it covered).
    const lossy = (fault?: Error): typeof ctx => ({
      ...ctx,
      resolveRpc: async (chainId, url) => {
        const r = (await ctx.resolveRpc!(chainId, url))!;
        const inner = r.client.readContract.bind(r.client) as (a: { functionName: string }) => Promise<unknown>;
        const view: Record<string, bigint> = { lostAssets: 131_382_052n, totalAssets: 701_674_000_000n, balanceOf: 10n ** 18n, convertToAssets: 31_382_052n };
        return { ...r, client: { ...r.client, readContract: (async (a: { functionName: string }) => { if (fault && a.functionName === "lostAssets") throw fault; return a.functionName in view ? view[a.functionName] : inner(a); }) as never } };
      },
    });
    // The impairment recipe reads the NAV oracle: its underwriter carries an open shortfall.
    const nav = (c: typeof ctx) => runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-loss-0001", action: { type: "answer-rfq", rfqId: RFQ_IMPAIRMENT_ID, premiumAnnualized: "0.04", expiryTimestamp: RFQ_IMPAIRMENT_EXPIRY } }, c);
    const warned = await nav(lossy());
    expect(warned.state, JSON.stringify(warned.warnings)).toBe("ok");
    const w = warned.warnings.find((x) => x.code === "reference_loss_unreported")!;
    // 131.38 lost, 31.38 covered through address(1): 100.00 is open.
    expect(w.message).toMatch(/cover 31382052 of it, and 100000000 of 701674000000 reported total assets is OPEN shortfall \(0\.014251%/u);
    expect(w.message).toMatch(/your cPT side receives shares backed by less.*price it yourself, or pass/u);
    expect((warned.data as { answer: { notRead?: string[] } }).answer.notRead).toBeUndefined();
    // The eval stub's reference exposes no lostAssets(): the view is absent — silent, and not "unread".
    const quiet = await nav(ctx);
    expect(quiet.state).toBe("ok");
    expect(quiet.warnings.map((x) => x.code)).not.toContain("reference_loss_unreported");
    expect((quiet.data as { answer: { notRead?: string[] } }).answer.notRead).toBeUndefined();
    // A counter read that failed in TRANSPORT is neither: nobody knows, and the answer says so.
    const unread = await nav(lossy(Object.assign(new Error("socket hang up"), { name: "HttpRequestError" })));
    expect(unread.state).toBe("ok");
    expect(unread.warnings.map((x) => x.code)).not.toContain("reference_loss_unreported");
    expect((unread.data as { answer: { notRead?: string[] } }).answer.notRead).toEqual(["the reference's lost-assets counter: socket hang up"]);
    // The liquidity recipe here reads a PRICE oracle: a market price, not the vault's share
    // price — the same lossy vault raises nothing on it.
    const price = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-loss-0002", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: (NOW + 20n * 86_400n).toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, lossy());
    expect(price.state, JSON.stringify(price.warnings)).toBe("ok");
    expect(price.warnings.map((x) => x.code)).not.toContain("reference_loss_unreported");
  });

  it("an RFQ that declares NO fill_sender is answered OPEN with fill_sender_unknown — never reserved for the requester account by guess (the LOP compares allowedSender with its CALLER; an adapter-bound requester would be locked out)", async () => {
    const expiry = NOW + 20n * 86_400n;
    const open = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-nosender-0001", action: { type: "answer-rfq", rfqId: RFQ_NOSENDER_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry.toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(open.state, JSON.stringify(open.warnings)).toBe("ok");
    const d = open.data as Answered;
    expect(d.allowedSender).toBeNull();
    expect(d.answer.reservedFor).toBeNull();
    expect(d.answer.reach).toBe("open");
    expect(decodeMakerTraits(BigInt(d.typedData.message.makerTraits!)).allowedSender).toBeNull();
    const w = open.warnings.find((x) => x.code === "fill_sender_unknown");
    expect(w).toBeDefined();
    expect(w!.message).toContain("PrivateOrder");
    expect(w!.message).toContain("fillSender");
    // The requester is still echoed (identity), it is just not the reach.
    expect(d.answer.requester.toLowerCase()).toBe(RC2_CLONE_OWNER.toLowerCase());
    // The caller's fillSender reserves the fill and silences the warning (it knows the caller).
    const reserved = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-nosender-0002", action: { type: "answer-rfq", rfqId: RFQ_NOSENDER_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry.toString(), fillSender: RC2_CLONE_OWNER.toLowerCase() as `0x${string}`, jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(reserved.state, JSON.stringify(reserved.warnings)).toBe("ok");
    const r = reserved.data as Answered;
    expect(r.allowedSender).toBe(`0x${RC2_CLONE_OWNER.slice(-20).toLowerCase()}`);
    expect(r.answer.reach).toBe("reserved");
    expect(reserved.warnings.some((x) => x.code === "fill_sender_unknown")).toBe(false);
    // reserve:false is open by CHOICE — no warning about an unknown sender.
    const chosen = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-nosender-0003", action: { type: "answer-rfq", rfqId: RFQ_NOSENDER_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry.toString(), reserve: false, jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(chosen.state).toBe("ok");
    expect((chosen.data as Answered).answer.reach).toBe("open");
    expect(chosen.warnings.some((x) => x.code === "fill_sender_unknown")).toBe(false);
  });

  it("the derived amounts are the kernel's, digit for digit, and a caller expirySeconds / open reach / notional override are honored", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-0002", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.036", expiryTimestamp: (NOW + 86_400n).toString(), notionalAssets: (50_000n * 10n ** 18n).toString(), reserve: false, expirySeconds: 300, ocoGroup: "capacity-slot-7", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    // 18-dec collateral: the same 3.6% × 50,000 × 1 day quotient as the 6-dec golden, scaled by 1e12.
    expect(BigInt(d.answer.takingAmount)).toBe(premiumAmount("0.036", 50_000n * 10n ** 18n, 86_400n));
    expect(d.allowedSender).toBeNull();
    expect(d.answer.expirySeconds).toBe(300);
    expect(d.answer.expiryRule).toBe("caller");
    expect(d.ocoGroup).toBe("capacity-slot-7");
    // The pool expiry sits below the RFQ's window → a counter-proposal, built and warned.
    expect(env.warnings.some((w) => w.code === "invalid_order_terms" && w.message.includes("expiry_window"))).toBe(true);
  });

  it("re-quote: an underwriter re-quotes only its OWN answer; the new option keeps the option id and the option's premium and expiry, and supersedes the answer", async () => {
    const other = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-0003", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, answerId: FIRM_ANSWER_ID, optionId: "opt1", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(other.state).toBe("unavailable");
    expect(other.warnings[0]!.code).toBe("invalid_order_terms");
    expect(other.warnings[0]!.message).toContain("OWN answer");
    const underwriter = SIGNED_LOP_PAYLOAD.order.maker as `0x${string}`;
    const mine = await runTool("cork_prepare_orders", { ...base, account: underwriter, clientRequestId: "answer-0004", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, answerId: FIRM_ANSWER_ID, optionId: "opt1", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(mine.state, JSON.stringify(mine.warnings)).toBe("ok");
    const d = mine.data as Answered;
    expect(d.answer.quoteRef).toEqual({ rfqId: RFQ_OPEN_ID, answerId: null, optionId: "opt1" });
    const requoted = d.answer as unknown as { quotedOption: Record<string, unknown>; supersedes: string };
    expect(requoted.supersedes).toBe(FIRM_ANSWER_ID);
    expect(requoted.quotedOption).toMatchObject({ option_id: "opt1", premium_annualized: "0.05", expiry: 1_900_000_000 });
    expect(d.execution.then.some((x) => x.includes("supersedes: answer.supersedes"))).toBe(true);
    // The option's terms (premium 0.05, expiry 1900000000), not the caller's — and that expiry is
    // the JIT task fixture's, so the pool is the fixture pair's derivation at that expiry (the
    // 10-field id of the nested primary, zero fees — DERIVED_JIT_POOL is its 8-field twin, the
    // rollover task's).
    expect(BigInt(d.answer.takingAmount)).toBe(premiumAmount("0.05", 1000n * 10n ** 18n, 1_900_000_000n - NOW));
    const derivedCited = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, filters: { ...JIT_TASK_PAIR, expiry: JIT_TASK_EXPIRY.toString(), recipe: LIQUIDITY_RECIPE } }, ctx);
    expect(d.answer.pool.poolId.toLowerCase()).toBe((derivedCited.data as { pool: { poolId: string } }).pool.poolId.toLowerCase());
    expect(d.answer.pool.poolId.toLowerCase()).not.toBe(DERIVED_JIT_POOL.toLowerCase());
  });

  it("shape refusals are teaching errors: half a citation, a citation plus a premium, an uncited answer without a premium, a bad fraction, a missing recipe", async () => {
    const attempt = (action: Record<string, unknown>) => runTool("cork_prepare_orders", { ...base, action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, ...action } }, ctx);
    await expect(attempt({ answerId: FIRM_ANSWER_ID })).rejects.toBeInstanceOf(ToolInputError);
    await expect(attempt({ answerId: FIRM_ANSWER_ID, optionId: "opt1", premiumAnnualized: "0.04" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(attempt({ expiryTimestamp: "1900000000" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(attempt({ premiumAnnualized: "4.1%", expiryTimestamp: "1900000000", jitMarket: { recipe: LIQUIDITY_RECIPE } })).rejects.toBeInstanceOf(ToolInputError);
    await expect(attempt({ premiumAnnualized: "0.04", expiryTimestamp: "1900000000" })).rejects.toMatchObject({ issues: [{ path: ["action", "jitMarket", "recipe"] }] });
  });

  it("an unknown RFQ is rfq_not_found; a pool expiry in the past has no tenor", async () => {
    const missing = await runTool("cork_prepare_orders", { ...base, action: { type: "answer-rfq", rfqId: "rfq_nope", premiumAnnualized: "0.04", expiryTimestamp: "1900000000", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(missing.state).toBe("unavailable");
    expect(missing.warnings[0]!.code).toBe("rfq_not_found");
    const past = await runTool("cork_prepare_orders", { ...base, action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: (NOW - 1n).toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(past.state).toBe("unavailable");
    expect(past.warnings[0]!.code).toBe("invalid_order_terms");
  });
});

describe("answer-rfq reads the requester's inline template (cork-inline-liquidity/1): anchor, expiry, fees", () => {
  const NOW = 1_790_000_000n;
  const ctx = stubContext();
  const base = { chainId: 42161 as const, account: DEMO_ACCOUNT, clientRequestId: "answer-inline-0001" };
  type Inline = { schema: string; source: string; anchorRate: string | null; expiry: string | null; swapFeeWad: string | null; unwindSwapFeeWad: string | null; extraData: string | null; anchorHonored: boolean | null; note: string };
  type AnsweredInline = { jit?: { constraint?: Record<string, string>; derivedPoolId: string }; answer: { pool: { poolId: string; oracleDeployed: boolean; oracleRate?: string }; inline: Inline | null } };
  const expiry = JIT_TASK_EXPIRY.toString();

  it("inlineParamsOfTemplate: only the cork-inline-liquidity/1 schema is read; `{}`, a foreign schema, and non-digit values yield nothing", () => {
    expect(inlineParamsOfTemplate(undefined)).toBeUndefined();
    expect(inlineParamsOfTemplate({ market_template_id: "tpl" })).toBeUndefined();
    expect(inlineParamsOfTemplate({ inline: { oracle_recipe: LIQUIDITY_RECIPE } })).toBeUndefined();
    expect(inlineParamsOfTemplate({ inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: {} } })).toBeUndefined();
    expect(inlineParamsOfTemplate({ inline: { oracle_params: { schema: "someone-else/1", anchor_rate: "1" } } })).toBeUndefined();
    const full = inlineParamsOfTemplate({ inline: { oracle_params: { schema: INLINE_LIQUIDITY_SCHEMA, anchor_rate: RFQ_INLINE_ANCHOR, expiry, swap_fee_wad: "1000000000000000000", unwind_swap_fee_wad: "0" } } });
    expect(full).toEqual({ schema: INLINE_LIQUIDITY_SCHEMA, anchorRate: 7n * 10n ** 17n, expiry: JIT_TASK_EXPIRY, swapFeeWad: "1000000000000000000", unwindSwapFeeWad: "0" });
    // Non-digit or zero anchor/expiry are absent, not zero; fee strings are passed through as digits only.
    expect(inlineParamsOfTemplate({ inline: { oracle_params: { schema: INLINE_LIQUIDITY_SCHEMA, anchor_rate: "0.7", expiry: "0", swap_fee_wad: "1e18" } } })).toEqual({ schema: INLINE_LIQUIDITY_SCHEMA });
    expect(encodeAnchorArgs(7n * 10n ** 17n)).toBe(`0x${(7n * 10n ** 17n).toString(16).padStart(64, "0")}`);
  });

  it("both inline schemas read an OPTIONAL oracle_salt (bytes32 hex — the destination pair's first-wrapper salt on a nested generation, our requester↔underwriter convention); anything but 32 bytes of hex is absent, never a guess", () => {
    const salt = `0x${"11".repeat(32)}`;
    const liq = inlineParamsOfTemplate({ inline: { oracle_params: { schema: INLINE_LIQUIDITY_SCHEMA, anchor_rate: RFQ_INLINE_ANCHOR, oracle_salt: salt } } });
    expect(liq).toMatchObject({ schema: INLINE_LIQUIDITY_SCHEMA, oracleSalt: salt });
    const imp = inlineParamsOfTemplate({ inline: { oracle_params: { schema: "cork-inline-impairment/1", anchor_rate: RFQ_INLINE_ANCHOR, duration_seconds: "86400", apy_spread_percentage: "1000000000000000000", oracle_salt: salt } } });
    expect(imp).toMatchObject({ schema: "cork-inline-impairment/1", oracleSalt: salt });
    for (const bad of ["0x11", "11".repeat(32), `0x${"gg".repeat(32)}`, 7, null]) {
      expect(inlineParamsOfTemplate({ inline: { oracle_params: { schema: INLINE_LIQUIDITY_SCHEMA, anchor_rate: RFQ_INLINE_ANCHOR, oracle_salt: bad } } })).not.toHaveProperty("oracleSalt");
    }
    expect(inlineParamsOfTemplate({ inline: { oracle_params: { schema: INLINE_LIQUIDITY_SCHEMA, anchor_rate: RFQ_INLINE_ANCHOR } } })).not.toHaveProperty("oracleSalt");
  });

  it("uncited: the RFQ's anchor rides as additionalData, its fees fill the JIT block, and against a DEPLOYED oracle the drift notice says the anchor is not honored", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: { type: "answer-rfq", rfqId: RFQ_INLINE_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as AnsweredInline;
    expect(d.answer.inline).not.toBeNull();
    const inline = d.answer.inline!;
    expect(inline.source).toBe("rfq");
    expect(inline.schema).toBe(INLINE_LIQUIDITY_SCHEMA);
    expect(inline.anchorRate).toBe(RFQ_INLINE_ANCHOR);
    expect(inline.expiry).toBe(expiry);
    expect(inline.swapFeeWad).toBe("1000000000000000000");
    expect(inline.unwindSwapFeeWad).toBe("0");
    expect(inline.extraData).toBe(encodeAnchorArgs(BigInt(RFQ_INLINE_ANCHOR)));
    // The stub's oracle is deployed at 0.8e18: the recipe anchors on THAT, so the carried 0.7e18 is not honored.
    expect(d.answer.pool.oracleDeployed).toBe(true);
    expect(d.answer.pool.oracleRate).toBe(RFQ_INLINE_OPTION_ANCHOR);
    expect(inline.anchorHonored).toBe(false);
    const drift = env.warnings.find((w) => w.code === "rate_drift_notice");
    expect(drift).toBeDefined();
    expect(drift!.message).toContain(RFQ_INLINE_ANCHOR);
    expect(drift!.message).toContain(RFQ_INLINE_OPTION_ANCHOR);
    expect(drift!.message).toContain("ignores the carried anchor");
    // The pinned constraint is the derivation's own (the stub resolves the 0.8e18 shape), and the
    // pool is the one derive-cork-pool answers for the same legs + args.
    expect(d.jit?.constraint).toEqual(JIT_TASK_CONSTRAINT);
    // …with the template's fees: on the 10-field primary they are part of the pool id.
    const derived = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, filters: { ...JIT_TASK_PAIR, expiry, recipe: LIQUIDITY_RECIPE, args: inline.extraData, swapFeePercentage: "1000000000000000000", unwindSwapFeePercentage: "0" } }, ctx);
    expect(d.answer.pool.poolId.toLowerCase()).toBe((derived.data as { pool: { poolId: string } }).pool.poolId.toLowerCase());
    // The RFQ's expiry and this answer's agree: no inline-expiry warning.
    expect(env.warnings.some((w) => w.code === "invalid_order_terms" && w.message.includes("oracle_params.expiry"))).toBe(false);
    // The recipe came from the RFQ's inline template (no jitMarket passed at all).
    expect(d.jit?.derivedPoolId.toLowerCase()).toBe(d.answer.pool.poolId.toLowerCase());
    // The signed extension carries the requester's fees and anchor: decode the built order and
    // read them back from the bytes, not from the echo.
    const built = env.data as { typedData: { message: Record<string, string> }; extension: string };
    const decoded = await runTool("cork_decode", { kind: "order", chainId: 42161, data: { ...built.typedData.message, extension: built.extension } }, ctx);
    expect(decoded.state, JSON.stringify(decoded.warnings)).toBe("ok");
    const jit = (decoded.data as { jit: { swapFeePercentage: string; unwindSwapFeePercentage: string; extraData: string; constraint: Record<string, string> } }).jit;
    expect(jit.swapFeePercentage).toBe("1000000000000000000");
    expect(jit.unwindSwapFeePercentage).toBe("0");
    expect(jit.extraData).toBe(inline.extraData);
    expect(jit.constraint).toMatchObject(JIT_TASK_CONSTRAINT);
  });

  it("an answer at a different pool expiry than the RFQ's inline template is warned as a different pool — and still builds", async () => {
    const other = (NOW + 20n * 86_400n).toString();
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-inline-0002", action: { type: "answer-rfq", rfqId: RFQ_INLINE_ID, premiumAnnualized: "0.04", expiryTimestamp: other } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const w = env.warnings.find((x) => x.code === "invalid_order_terms" && x.message.includes("oracle_params.expiry"));
    expect(w).toBeDefined();
    expect(w!.message).toContain(expiry);
    expect(w!.message).toContain(other);
    expect((env.data as AnsweredInline).answer.inline!.expiry).toBe(expiry);
  });

  it("the caller's explicit jitMarket fields win over the inline block (fees, additionalData); an explicit anchor that matches the live rate raises no drift notice", async () => {
    const args = encodeAnchorArgs(BigInt(RFQ_INLINE_OPTION_ANCHOR));
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-inline-0003", action: { type: "answer-rfq", rfqId: RFQ_INLINE_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry, jitMarket: { recipe: LIQUIDITY_RECIPE, additionalData: args, swapFeePercentage: "0" } } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as AnsweredInline;
    expect(d.answer.inline!.extraData).toBe(args);
    expect(d.answer.inline!.anchorRate).toBe(RFQ_INLINE_ANCHOR); // the RFQ's block is still echoed
    // The drift notice compares the RFQ's anchor with the live rate, and they differ here too.
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(true);
  });

  it("cited: the option's inline block wins over the RFQ's; its anchor equals the live rate, so no drift notice", async () => {
    const underwriter = SIGNED_LOP_PAYLOAD.order.maker as `0x${string}`;
    const env = await runTool("cork_prepare_orders", { ...base, account: underwriter, clientRequestId: "answer-inline-0004", action: { type: "answer-rfq", rfqId: RFQ_INLINE_ID, answerId: RFQ_INLINE_ANSWER_ID, optionId: "opt1" } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as AnsweredInline;
    expect(d.answer.inline!.source).toBe("cited option");
    expect(d.answer.inline!.anchorRate).toBe(RFQ_INLINE_OPTION_ANCHOR);
    expect(d.answer.inline!.extraData).toBe(encodeAnchorArgs(BigInt(RFQ_INLINE_OPTION_ANCHOR)));
    expect(d.answer.inline!.anchorHonored).toBe(false); // deployed oracle: the live rate rules, whatever the anchor says
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(false);
    // The option's block carries a 1% swap fee: on the 10-field primary that fee is part of the
    // pool id, so the pool is the fixture derivation WITH that fee (not the zero-fee twin).
    const derivedFee = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, filters: { ...JIT_TASK_PAIR, expiry: JIT_TASK_EXPIRY.toString(), recipe: LIQUIDITY_RECIPE, swapFeePercentage: "1000000000000000000" } }, ctx);
    expect(d.answer.pool.poolId.toLowerCase()).toBe((derivedFee.data as { pool: { poolId: string } }).pool.poolId.toLowerCase());
  });

  it("a pair whose oracle is NOT deployed: the anchor reaches recipe.resolve as additionalData, is honoured, and no drift notice fires (the fresh-pair path the RFQ contract was written for)", async () => {
    // Compose over the eval stub: the wrapper lookup answers zero, its rate cannot be read, and
    // the registry's deploy simulation predicts the wrapper address — the shape a registered
    // pair has before anyone calls deploy. Every resolve call's args are captured.
    const ZERO = "0x0000000000000000000000000000000000000000";
    const PREDICTED = "0x14115b5fdab3afcd72cf03785041c720100edb0e";
    const resolveArgs: unknown[][] = [];
    const stub = stubContext();
    const fresh: HandlerContext = {
      ...stub,
      resolveRpc: async (chainId, url) => {
        const r = (await stub.resolveRpc!(chainId, url)) as ResolvedRpc;
        const client = r.client as unknown as { readContract: (a: { functionName: string; args?: unknown[] }) => Promise<unknown> };
        const wrapped = {
          ...(r.client as unknown as Record<string, unknown>),
          readContract: async (a: { functionName: string; args?: unknown[] }) => {
            if (a.functionName === "lookupWrapper") return ZERO;
            if (a.functionName === "rate") throw Object.assign(new Error("execution reverted"), { shortMessage: 'The contract function "rate" reverted.' });
            if (a.functionName === "resolve") resolveArgs.push(a.args ?? []);
            return client.readContract(a);
          },
          simulateContract: async () => ({ result: PREDICTED }),
        };
        return { ...r, client: wrapped as unknown as ResolvedRpc["client"] };
      },
    };
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-inline-0006", action: { type: "answer-rfq", rfqId: RFQ_INLINE_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry } }, fresh);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as AnsweredInline;
    expect(d.answer.pool.oracleDeployed).toBe(false);
    expect(d.answer.pool.oracleRate).toBeUndefined();
    expect(d.answer.inline!.anchorHonored).toBe(true);
    expect(d.answer.inline!.extraData).toBe(encodeAnchorArgs(BigInt(RFQ_INLINE_ANCHOR)));
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(false);
    expect(env.warnings.some((w) => w.code === "oracle_not_deployed")).toBe(true);
    // The anchor reached the recipe: every resolve staticcall carried abi.encode(anchorRate) as
    // its args leg and the ZERO oracle (the recipe's undeployed branch reads the anchor there).
    expect(resolveArgs.length).toBeGreaterThan(0);
    for (const args of resolveArgs) {
      expect(String(args[2]).toLowerCase()).toBe(ZERO);
      expect(args[3]).toBe(encodeAnchorArgs(BigInt(RFQ_INLINE_ANCHOR)));
    }
  });

  it("an RFQ without an inline block answers with inline: null and no additionalData of its own", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-inline-0005", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry, jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as AnsweredInline).answer.inline).toBeNull();
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(false);
  });
});

describe("cork_prepare_orders refresh-order — the same terms on the same bit with a new expiry", () => {
  const LOP = LOP_ADDRESSES[1]!;
  const NOW = 1_800_000_000n;
  const maker = privateKeyToAccount(`0x${"3f".repeat(32)}`);
  const ME = maker.address;
  const TAKER = "0xc0ffee0000000000000000000000000000000002" as const;
  const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
  const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
  const resting = buildMakerOrder({ chainId: 1, lop: LOP, maker: ME, makerAsset: CST, takerAsset: SUSDE, makingAmount: 10n ** 18n, takingAmount: 5n * 10n ** 16n, clientRequestId: "orig-0001", expiry: NOW + 120n, allowedSender: TAKER, allowPartialFills: false, ocoGroup: "rfq:rfq_9" });
  const rowOf = async (built: typeof resting) => ({
    orderHash: built.orderHash,
    order: { salt: built.order.salt.toString(), maker: built.order.maker, receiver: built.order.receiver, makerAsset: built.order.makerAsset, takerAsset: built.order.takerAsset, makingAmount: built.order.makingAmount.toString(), takingAmount: built.order.takingAmount.toString(), makerTraits: built.order.makerTraits.toString() },
    signature: await maker.sign({ hash: built.orderHash }),
    extension: built.extension,
    makerAccountType: "EOA",
    side: "SELL",
    status: "OPEN",
  });
  const venueWith = (rows: unknown[]) => async (url: string) => (url.includes("/limit-orders/v1/orderbook") ? new Response(JSON.stringify({ items: rows, hasMore: false }), { status: 200 }) : new Response(JSON.stringify({ items: [] }), { status: 200 }));
  const chain = (word: bigint) => stubRpc((c) => { if (c.functionName === "bitInvalidatorForOrder") return word; throw new Error(`no stub for ${c.functionName}`); });
  type Refreshed = { kind: string; nonce: string; orderHash: string; allowedSender: string; typedData: { message: Record<string, string> }; refreshes: { orderHash: string; nonce: string; previousExpiry: string; newExpiry: string; extensionCarried: boolean }; execution: { then: string[] } };

  it("re-rests on the SAME nonce (one bit, the two cannot both fill), same assets/amounts/reach/flags, new expiry, new hash", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: ME, clientRequestId: "refresh-0001", action: { type: "refresh-order", orderHash: resting.orderHash } }, { nowSeconds: NOW, venueFetch: venueWith([await rowOf(resting)]), resolveRpc: chain(0n) });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Refreshed;
    expect(d.kind).toBe("maker-order");
    expect(d.nonce).toBe(resting.nonce.toString());
    expect(d.refreshes).toMatchObject({ orderHash: resting.orderHash, nonce: resting.nonce.toString(), previousExpiry: (NOW + 120n).toString(), newExpiry: (NOW + 600n).toString(), extensionCarried: false });
    expect(d.orderHash).not.toBe(resting.orderHash);
    const t = decodeMakerTraits(BigInt(d.typedData.message.makerTraits!));
    expect(t.nonce).toBe(resting.nonce);
    expect(t.expiry).toBe(NOW + 600n);
    expect(t.allowedSender).toBe(`0x${TAKER.slice(-20).toLowerCase()}`);
    expect(t.allowPartialFills).toBe(false);
    expect(d.typedData.message.makingAmount).toBe(resting.order.makingAmount.toString());
    expect(d.typedData.message.takingAmount).toBe(resting.order.takingAmount.toString());
    expect(env.warnings.some((w) => w.code === "oco_group_notice" && w.message.includes(resting.orderHash))).toBe(true);
    expect(d.execution.then.some((s) => s.includes("SAME nonce"))).toBe(true);
  });

  it("a spent bit refuses (status_mismatch): a refresh on a dead bit could never fill", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: ME, clientRequestId: "refresh-0002", action: { type: "refresh-order", orderHash: resting.orderHash } }, { nowSeconds: NOW, venueFetch: venueWith([await rowOf(resting)]), resolveRpc: chain((1n << 256n) - 1n) });
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("status_mismatch");
    expect(env.warnings[0]!.message).toContain("NEW maker-order");
  });

  it("only the maker refreshes its order; an absent row is order_not_found; no RPC builds on the venue's word and says so", async () => {
    const notMine = await runTool("cork_prepare_orders", { chainId: 1, account: TAKER, clientRequestId: "refresh-0003", action: { type: "refresh-order", orderHash: resting.orderHash } }, { nowSeconds: NOW, venueFetch: venueWith([await rowOf(resting)]), resolveRpc: chain(0n) });
    expect(notMine.state).toBe("unavailable");
    expect(notMine.warnings[0]!.code).toBe("invalid_order_terms");
    const gone = await runTool("cork_prepare_orders", { chainId: 1, account: ME, clientRequestId: "refresh-0004", action: { type: "refresh-order", orderHash: resting.orderHash } }, { nowSeconds: NOW, venueFetch: venueWith([]), resolveRpc: chain(0n) });
    expect(gone.state).toBe("unavailable");
    expect(gone.warnings[0]!.code).toBe("order_not_found");
    const offline = await runTool("cork_prepare_orders", { chainId: 1, account: ME, clientRequestId: "refresh-0005", action: { type: "refresh-order", orderHash: resting.orderHash } }, { nowSeconds: NOW, venueFetch: venueWith([await rowOf(resting)]), resolveRpc: async () => null });
    expect(offline.state).toBe("ok");
    expect(offline.warnings.some((w) => w.code === "venue_reported" && w.message.includes("no RPC"))).toBe(true);
  });

  it("a JIT or auction extension is carried verbatim: the refreshed salt re-binds to it", async () => {
    const auction = await runTool("cork_prepare_orders", { chainId: 1, account: ME, clientRequestId: "decay-0001", action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: CST, takerAsset: SUSDE, makingAmount: (10n ** 18n).toString(), takingAmount: (5n * 10n ** 16n).toString(), auction: { durationSeconds: 3600, initialRateBump: "1000000" } } }, { nowSeconds: NOW });
    const a = auction.data as { orderHash: `0x${string}`; extension: `0x${string}`; typedData: { message: Record<string, string> }; nonce: string };
    const row = { orderHash: a.orderHash, order: a.typedData.message, signature: await maker.sign({ hash: a.orderHash }), extension: a.extension, makerAccountType: "EOA", side: "SELL", status: "OPEN" };
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: ME, clientRequestId: "refresh-0006", action: { type: "refresh-order", orderHash: a.orderHash, expirySeconds: 900 } }, { nowSeconds: NOW, venueFetch: venueWith([row]), resolveRpc: chain(0n) });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Refreshed & { extension: string };
    expect(d.extension).toBe(a.extension);
    expect(d.refreshes.extensionCarried).toBe(true);
    expect(d.nonce).toBe(a.nonce);
  });
});

describe("answer-rfq reads the impairment inline template (cork-inline-impairment/1): three words or nothing", () => {
  const ctx = stubContext();
  const base = { chainId: 42161 as const, account: DEMO_ACCOUNT, clientRequestId: "answer-impair-0001" };
  const expiry = RFQ_IMPAIRMENT_EXPIRY; // the RFQ's own: creatable, and coherent with its duration
  type Inline = { schema: string; anchorRate: string | null; durationSeconds?: string | null; apySpreadPercentage?: string | null; complete?: boolean; extraData: string | null };
  type Answered = { jit?: { constraint?: Record<string, string>; derivedPoolId: string }; answer: { pool: { poolId: string; oracleDeployed: boolean }; inline: Inline | null } };

  it("inlineParamsOfTemplate reads the two extra words under the impairment schema; inlineAdditionalData encodes all three or refuses", () => {
    const block = { schema: INLINE_IMPAIRMENT_SCHEMA, anchor_rate: RFQ_INLINE_ANCHOR, duration_seconds: RFQ_IMPAIRMENT_DURATION, apy_spread_percentage: RFQ_IMPAIRMENT_SPREAD, expiry, swap_fee_wad: "0", unwind_swap_fee_wad: "0" };
    const full = inlineParamsOfTemplate({ inline: { oracle_params: block } });
    expect(full).toEqual({ schema: INLINE_IMPAIRMENT_SCHEMA, anchorRate: 7n * 10n ** 17n, durationSeconds: 604_800n, apySpreadPercentage: 10n * 10n ** 18n, expiry: BigInt(expiry), swapFeeWad: "0", unwindSwapFeeWad: "0" });
    expect(inlineAdditionalData(full!)).toBe(encodeImpairmentArgs({ anchorRate: 7n * 10n ** 17n, durationSeconds: 604_800n, apySpreadPercentage: 10n * 10n ** 18n }));
    // A partial block yields NO payload — never a zero word the requester did not ask for.
    const { apy_spread_percentage: _drop, ...partial } = block;
    const p = inlineParamsOfTemplate({ inline: { oracle_params: partial } });
    expect(p?.schema).toBe(INLINE_IMPAIRMENT_SCHEMA);
    expect(inlineAdditionalData(p!)).toBeUndefined();
    // The liquidity path is unchanged by the second schema.
    expect(inlineAdditionalData({ schema: INLINE_LIQUIDITY_SCHEMA, anchorRate: 3n })).toBe(encodeAnchorArgs(3n));
    expect(inlineAdditionalData({ schema: INLINE_LIQUIDITY_SCHEMA })).toBeUndefined();
  });

  it("a complete impairment RFQ: the recipe comes from the template, the three words ride as additionalData, and the pool is the one derive-cork-pool answers for those bytes", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: { type: "answer-rfq", rfqId: RFQ_IMPAIRMENT_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    const inline = d.answer.inline!;
    expect(inline.schema).toBe(INLINE_IMPAIRMENT_SCHEMA);
    expect(inline.durationSeconds).toBe(RFQ_IMPAIRMENT_DURATION);
    expect(inline.apySpreadPercentage).toBe(RFQ_IMPAIRMENT_SPREAD);
    expect(inline.complete).toBe(true);
    const expected = encodeImpairmentArgs({ anchorRate: BigInt(RFQ_INLINE_ANCHOR), durationSeconds: BigInt(RFQ_IMPAIRMENT_DURATION), apySpreadPercentage: BigInt(RFQ_IMPAIRMENT_SPREAD) });
    expect(inline.extraData).toBe(expected);
    // No "incomplete block" warning on a complete one.
    expect(env.warnings.some((w) => w.code === "invalid_order_terms" && w.message.includes("lacks"))).toBe(false);
    // The stub oracle is DEPLOYED at 0.8e18 vs the carried 0.7e18: the impairment recipe anchors
    // on the live rate too, so the drift notice fires on this path exactly as on liquidity.
    const drift = env.warnings.find((w) => w.code === "rate_drift_notice");
    expect(drift?.message).toContain(RFQ_INLINE_ANCHOR);
    expect(drift?.message).toContain("ignores the carried anchor");
    // A well-formed impairment answer is CLEAN: duration matches the tenor within the slack (no
    // window-vs-life note), the expiry is creatable (no would_revert), and it sits inside the
    // RFQ's window. The only notices are the ones every answer carries.
    expect(env.warnings.some((w) => w.code === "invalid_order_terms")).toBe(false);
    expect(env.warnings.some((w) => w.code === "would_revert")).toBe(false);
    // The stub's impairment resolve COMPUTES the band math on the live 0.8e18 anchor: the pinned
    // constraint is that derivation, and the pool id matches a direct derive with the same bytes.
    expect(d.jit?.constraint).toEqual({ rateMin: "798465753424657535", rateMax: "801534246575342465", rateChangePerDayMax: "219178082191780", rateChangeCapacityMax: "1534246575342465" });
    const derived = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, filters: { ...JIT_TASK_PAIR, expiry, recipe: IMPAIRMENT_RECIPE, args: expected, swapFeePercentage: "1000000000000000000" } }, ctx);
    expect(derived.state, JSON.stringify(derived.warnings)).toBe("ok");
    expect(d.answer.pool.poolId.toLowerCase()).toBe((derived.data as { pool: { poolId: string } }).pool.poolId.toLowerCase());
    // The signed bytes carry exactly those 96 bytes.
    const built = env.data as { typedData: { message: Record<string, string> }; extension: string };
    const decoded = await runTool("cork_decode", { kind: "order", chainId: 42161, data: { ...built.typedData.message, extension: built.extension } }, ctx);
    expect((decoded.data as { jit: { extraData: string; recipe: string } }).jit.extraData).toBe(expected);
    expect((decoded.data as { jit: { recipe: string } }).jit.recipe.toLowerCase()).toBe(IMPAIRMENT_RECIPE.toLowerCase());
  });

  it("a window sized for 7 days on a market that lives 20 is DISCLOSED (the wall is reachable) — info, the order still builds", async () => {
    const nowSecs = 1_790_000_000n; // stubContext's clock
    const twentyDaysOut = (nowSecs + 20n * 86_400n).toString();
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-impair-0004", action: { type: "answer-rfq", rfqId: RFQ_IMPAIRMENT_ID, premiumAnnualized: "0.04", expiryTimestamp: twentyDaysOut } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const note = env.warnings.find((w) => w.code === "invalid_order_terms" && w.message.includes("sizes the rate window"));
    expect(note?.message).toMatch(/^the RFQ's impairment block sizes the rate window for a duration of /u);
    expect(note?.message).toContain(RFQ_IMPAIRMENT_DURATION);
    expect(note?.message).toContain("reach its wall before the market expires");
    // The constraint is STILL built from the requester's duration — the tenor never leaks into it.
    expect((env.data as Answered).jit?.constraint?.rateMax).toBe("801534246575342465");
  });

  it("a PARTIAL impairment block (no spread) derives no payload, warns which words are missing, and the caller's explicit additionalData wins over it", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-impair-0002", action: { type: "answer-rfq", rfqId: RFQ_IMPAIRMENT_PARTIAL_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry } }, ctx);
    // The recipe refuses a 0x payload (MalformedAdditionalData) and the derive gates — and the
    // TEACHING that landed before the derive, naming the missing word, must SURVIVE the gate:
    // it is the cause the raw revert cannot name. (A mutation probe caught the version of this
    // test that accepted "gated" alone — the gated return used to drop every earlier warning.)
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_refused"); // the reason stays FIRST
    const missing = env.warnings.find((w) => w.code === "invalid_order_terms" && w.message.includes("lacks"));
    expect(missing, JSON.stringify(env.warnings)).toBeDefined();
    expect(missing!.message).toContain("apySpreadPercentage");
    expect(missing!.message).not.toContain("anchorRate"); // only the truly missing word is named
    // Explicit bytes from the caller bypass the block entirely and the order builds.
    const explicit = encodeImpairmentArgs({ anchorRate: BigInt(RFQ_INLINE_ANCHOR), durationSeconds: 604_800n, apySpreadPercentage: 10n * 10n ** 18n });
    const fixed = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-impair-0003", action: { type: "answer-rfq", rfqId: RFQ_IMPAIRMENT_PARTIAL_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry, jitMarket: { additionalData: explicit } } }, ctx);
    expect(fixed.state, JSON.stringify(fixed.warnings)).toBe("ok");
    const inline = (fixed.data as Answered).answer.inline!;
    expect(inline.complete).toBe(false);
    expect(inline.extraData).toBe(explicit);
    expect(fixed.warnings.some((w) => w.code === "invalid_order_terms" && w.message.includes("lacks"))).toBe(false);
  });
});

describe("answer-rfq for FIXED-RATE cover (cork-api 0.4.4): the frozen rate rides as the order's rateOverride, never as recipe bytes", () => {
  const NOW = 1_790_000_000n;
  const ctx = stubContext();
  const base = { chainId: 42161 as const, account: DEMO_ACCOUNT };
  type Fixed = { rateOverride: string; rateFrom: string; requestedRate: string | null; liveRate?: string; liveRateSource?: string; position?: string; gapPercentage?: string; scales: Record<string, string> };
  type Answered = { orderHash: string; extension: `0x${string}`; typedData: { message: Record<string, string> }; jit: { derivedPoolId: string; constraint: Record<string, string> }; answer: { fixed?: Fixed; notRead?: string[]; inline: { schema: string; rateOverride?: string | null; extraData: string | null } | null; pool: { recipe: string; oracleDeployed: boolean } } };
  const answer = (id: string, rfqId: string, over: Record<string, unknown> = {}, c: HandlerContext = ctx) =>
    runTool("cork_prepare_orders", { ...base, clientRequestId: `answer-fixed-${id}`, action: { type: "answer-rfq", rfqId, premiumAnnualized: "0.04", expiryTimestamp: RFQ_IMPAIRMENT_EXPIRY, ...over } }, c);
  const hookOf = async (d: Answered) => ((await runTool("cork_decode", { chainId: 42161, kind: "order", data: { ...d.typedData.message, extension: d.extension } }, ctx)).data as { jit: { recipe: string; rateOverride: string; extraData?: string; constraint: Record<string, string> } }).jit;

  it("the RFQ's rate_override becomes the order's rateOverride with EMPTY extraData; the constraint is the recipe's rate .. rate + 1", async () => {
    const env = await answer("0001", RFQ_FIXED_ID);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    expect(d.answer.pool).toMatchObject({ recipe: FIXED_RECIPE, oracleDeployed: false });
    expect(d.jit.constraint).toEqual({ rateMin: RFQ_FIXED_RATE, rateMax: (BigInt(RFQ_FIXED_RATE) + 1n).toString(), rateChangePerDayMax: "0", rateChangeCapacityMax: "0" });
    // Read back from the bytes the maker signs — not from the tool's own echo.
    const hook = await hookOf(d);
    expect(hook.recipe.toLowerCase()).toBe(FIXED_RECIPE.toLowerCase());
    expect(hook.rateOverride).toBe(RFQ_FIXED_RATE);
    expect(hook.extraData ?? "0x").toBe("0x");
    expect(hook.constraint).toMatchObject({ rateMin: RFQ_FIXED_RATE, rateChangePerDayMax: "0" });
    // 0.75 against the pair's 0.8: the reference must lose 6.25% before this cover pays.
    expect(d.answer.fixed).toMatchObject({ rateOverride: RFQ_FIXED_RATE, rateFrom: "rfq", requestedRate: RFQ_FIXED_RATE, liveRate: "800000000000000000", liveRateSource: "nav", position: "below", gapPercentage: "6250000000000000000" });
    expect(d.answer.fixed!.scales["gapPercentage"]).toMatch(/1e18 = 1%/u);
    expect(d.answer.inline).toMatchObject({ schema: "cork-inline-fixed/1", rateOverride: RFQ_FIXED_RATE, extraData: null });
    expect(d.answer.notRead).toBeUndefined();
    expect(env.warnings.map((w) => w.code)).not.toContain("fixed_rate_in_the_money");
    // A fixed-rate pool reads no feed: the loss reading is not its concern.
    expect(env.warnings.map((w) => w.code)).not.toContain("reference_loss_unreported");
  });

  it("a fixed answer carries no floating-rate text: no stale-constraint notice, no anchor drift, no anchor echo, and the undeployed oracle is named as keyed on the rate", async () => {
    const env = await answer("0014", RFQ_FIXED_ID);
    expect(env.warnings.map((w) => w.code)).toEqual(["oracle_not_deployed", "oco_group_notice"]);
    expect(env.warnings[0]!.message).toMatch(/the FixedRateOracle for this rate is not deployed yet .*keyed on the rate alone/u);
    expect(env.warnings[0]!.message).not.toMatch(/oracleSalt|LIVE rate|re-registering/u);
    const inline = (env.data as Answered).answer.inline as Record<string, unknown>;
    expect(inline).not.toHaveProperty("anchorHonored");
    expect(inline).not.toHaveProperty("note");
    // A recipe that reads an oracle keeps both notices (the liquidity answer of the first describe).
    const floating = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-fixed-0015", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, premiumAnnualized: "0.04", expiryTimestamp: (NOW + 20n * 86_400n).toString(), jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(floating.warnings.map((w) => w.code)).toContain("constraint_window_notice");
  });

  it("a rate whose FixedRateOracle already EXISTS: the order builds against the deployed oracle, and an anchor_rate a requester left in the block raises no drift notice (a fixed recipe has no anchor)", async () => {
    // The stub's RFQ, with its block rewritten to the one rate deployed in this world plus a stray anchor.
    const rewritten: HandlerContext = {
      ...ctx,
      venueFetch: async (url: string, init?: RequestInit) => {
        const res = await ctx.venueFetch!(url, init);
        if (init?.method === "POST" || !url.includes(RFQ_FIXED_ID)) return res;
        const body = (await res.json()) as { request: { market_template: { inline: { oracle_params: Record<string, string> } } } };
        body.request.market_template.inline.oracle_params = { ...body.request.market_template.inline.oracle_params, rate_override: DEPLOYED_FIXED_RATE.toString(), anchor_rate: "700000000000000000" };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    };
    const env = await answer("0018", RFQ_FIXED_ID, {}, rewritten);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    expect(d.answer.pool.oracleDeployed).toBe(true);
    expect(d.jit.constraint).toMatchObject({ rateMin: DEPLOYED_FIXED_RATE.toString(), rateMax: (DEPLOYED_FIXED_RATE + 1n).toString() });
    expect(env.warnings.map((w) => w.code)).toEqual(["oco_group_notice"]);
  });

  it("a CITED option's own rate is the rate the order builds at (cork-api 0.4.4: each option carries its own template) — said as a counter-proposal to the request", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 42161, account: SIGNED_LOP_PAYLOAD.order.maker as `0x${string}`, clientRequestId: "answer-fixed-0016", action: { type: "answer-rfq", rfqId: RFQ_FIXED_ID, answerId: RFQ_FIXED_ANSWER_ID, optionId: "opt1" } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    expect(d.answer.fixed).toMatchObject({ rateOverride: RFQ_FIXED_OPTION_RATE, rateFrom: "cited option", requestedRate: RFQ_FIXED_RATE });
    expect((await hookOf(d)).rateOverride).toBe(RFQ_FIXED_OPTION_RATE);
    expect(env.warnings.some((x) => /the RFQ asks for the frozen rate 750000000000000000, and this answer builds at 740000000000000000 \(cited option\)/u.test(x.message))).toBe(true);
  });

  it("a recipe whose source() cannot be READ is not treated as 'not fixed': a transport fault refuses with the reason instead of dropping the rate", async () => {
    const flaky: HandlerContext = {
      ...ctx,
      resolveRpc: async (chainId, url) => {
        const r = (await ctx.resolveRpc!(chainId, url))!;
        const inner = r.client.readContract.bind(r.client) as (a: { functionName: string }) => Promise<unknown>;
        return { ...r, client: { ...r.client, readContract: (async (a: { functionName: string }) => { if (a.functionName === "source") throw Object.assign(new Error("socket hang up"), { name: "HttpRequestError" }); return inner(a); }) as never } };
      },
    };
    const env = await answer("0017", RFQ_FIXED_ID, {}, flaky);
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]).toMatchObject({ code: "chain_read_failed" });
    expect(env.warnings[0]!.message).toMatch(/could not read source\(\) of recipe .*: socket hang up — a transport failure.*nothing is built on a guess/u);
  });

  it("a rate ABOVE the reference's rate: the underwriter is told it would be out of pocket from the first block — and the order still builds", async () => {
    const env = await answer("0002", RFQ_FIXED_ABOVE_ID);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const w = env.warnings.find((x) => x.code === "fixed_rate_in_the_money")!;
    expect(w.message).toMatch(/the frozen rate 900000000000000000 is 12\.5000% ABOVE the reference's rate today.*You would be out of pocket by that gap on every cST from the first block/u);
    expect((env.data as Answered).answer.fixed).toMatchObject({ position: "above", gapPercentage: "12500000000000000000" });
  });

  it("another rate than the RFQ's is a visible counter-proposal: another oracle, another pool, said", async () => {
    const asked = (await answer("0003", RFQ_FIXED_ID)).data as Answered;
    const env = await answer("0004", RFQ_FIXED_ID, { jitMarket: { rateOverride: "740000000000000000" } });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    expect(d.answer.fixed).toMatchObject({ rateOverride: "740000000000000000", rateFrom: "jitMarket.rateOverride", requestedRate: RFQ_FIXED_RATE });
    expect(d.jit.derivedPoolId).not.toBe(asked.jit.derivedPoolId);
    expect((await hookOf(d)).rateOverride).toBe("740000000000000000");
    expect(env.warnings.find((x) => /a different FixedRateOracle and so a different pool/u.test(x.message))!.message).toMatch(/the RFQ asks for the frozen rate 750000000000000000, and this answer builds at 740000000000000000 \(jitMarket\.rateOverride\)/u);
    // The SAME rate passed explicitly is not a counter-proposal.
    const same = await answer("0005", RFQ_FIXED_ID, { jitMarket: { rateOverride: RFQ_FIXED_RATE } });
    expect(same.warnings.some((x) => /a different FixedRateOracle/u.test(x.message))).toBe(false);
    expect((same.data as Answered).jit.derivedPoolId).toBe(asked.jit.derivedPoolId);
  });

  it("the fixed recipe without a rate anywhere is refused before any derivation; with an explicit rate it builds", async () => {
    const expiry = (NOW + 20n * 86_400n).toString();
    const none = await answer("0006", RFQ_OPEN_ID, { expiryTimestamp: expiry, jitMarket: { recipe: FIXED_RECIPE } });
    expect(none.state).toBe("unavailable");
    expect(none.warnings[0]).toMatchObject({ code: "invalid_order_terms" });
    expect(none.warnings[0]!.message).toMatch(/is the FIXED-rate recipe, and neither the RFQ nor this call names the frozen rate.*Pass jitMarket\.rateOverride/u);
    // A literal "0" is the schema's "no rate", not a rate.
    const zero = await answer("0007", RFQ_OPEN_ID, { expiryTimestamp: expiry, jitMarket: { recipe: FIXED_RECIPE, rateOverride: "0" } });
    expect(zero.state).toBe("unavailable");
    expect(zero.warnings[0]!.message).toMatch(/neither the RFQ nor this call names the frozen rate/u);
    const explicit = await answer("0008", RFQ_OPEN_ID, { expiryTimestamp: expiry, jitMarket: { recipe: FIXED_RECIPE, rateOverride: "770000000000000000" } });
    expect(explicit.state, JSON.stringify(explicit.warnings)).toBe("ok");
    expect((explicit.data as Answered).answer.fixed).toMatchObject({ rateOverride: "770000000000000000", rateFrom: "jitMarket.rateOverride", requestedRate: null });
    // No request rate to differ from: not a counter-proposal.
    expect(explicit.warnings.some((x) => /a different FixedRateOracle/u.test(x.message))).toBe(false);
  });

  it("a rate on the template with a recipe that reads an ORACLE is not carried — the fill would revert — and recipe bytes on the fixed recipe are the recipe's refusal", async () => {
    const env = await answer("0009", RFQ_FIXED_ID, { jitMarket: { recipe: LIQUIDITY_RECIPE } });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    // The same two contradictions rfq-open names, in the underwriter's words: the block is
    // another cover's, and the rate cannot ride on a recipe that reads an oracle.
    const said = env.warnings.filter((x) => x.code === "invalid_order_terms").map((x) => x.message);
    expect(said.some((m) => /the inline block is cork-inline-fixed\/1.*gives liquidity \(duration-risk\) cover.*The block's bytes are NOT carried into this order/u.test(m))).toBe(true);
    expect(said.some((m) => /carries rate_override 750000000000000000, but the recipe .* reads a rate oracle.*UnexpectedRateOverride.*The rate is NOT carried into this order/u.test(m))).toBe(true);
    expect((await hookOf(d)).rateOverride).toBe("0");
    expect(d.answer.fixed).toBeUndefined();
    expect(d.jit.constraint["rateMin"]).toBe("1"); // the liquidity window, not a frozen rate
    // An EXPLICIT rate on such a recipe is not silently dropped and then refused downstream:
    // it is refused here, with the reason.
    const explicit = await answer("0013", RFQ_OPEN_ID, { expiryTimestamp: (NOW + 20n * 86_400n).toString(), jitMarket: { recipe: LIQUIDITY_RECIPE, rateOverride: "750000000000000000" } });
    expect(explicit.state).toBe("unavailable");
    expect(explicit.warnings[0]).toMatchObject({ code: "invalid_order_terms" });
    expect(explicit.warnings[0]!.message).toMatch(/jitMarket\.rateOverride 750000000000000000 with recipe .*, which reads a price oracle.*UnexpectedRateOverride/u);
    const bytes = await answer("0010", RFQ_FIXED_ID, { jitMarket: { extraData: "0x01" } });
    expect(bytes.state).toBe("unavailable");
    expect(bytes.warnings[0]).toMatchObject({ code: "recipe_refused" });
    expect(bytes.warnings[0]!.message).toMatch(/answer-rfq could not derive the pool the cover creates.*UnexpectedExtraData\(1\)/u);
  });

  /** The stub's fixed-rate RFQ with its one answer's first option changed. */
  const withOption = (change: (oracleParams: Record<string, unknown>) => void): HandlerContext => ({
    ...ctx,
    venueFetch: async (url: string, init?: RequestInit) => {
      const res = await ctx.venueFetch!(url, init);
      if (!new URL(url).pathname.endsWith(`/rfqs/v2/${RFQ_FIXED_ID}`)) return res;
      const row = (await res.json()) as { answers: Array<{ answer: { options: Array<{ market_template: { inline: { oracle_params: Record<string, unknown> } } }> } }> };
      change(row.answers[0]!.answer.options[0]!.market_template.inline.oracle_params);
      return new Response(JSON.stringify(row), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const cite = (id: string, c: HandlerContext, over: Record<string, unknown> = {}) =>
    runTool("cork_prepare_orders", { ...base, account: SIGNED_LOP_PAYLOAD.order.maker as `0x${string}`, clientRequestId: `answer-fixed-${id}`, action: { type: "answer-rfq", rfqId: RFQ_FIXED_ID, answerId: RFQ_FIXED_ANSWER_ID, optionId: "opt1", ...over } }, c);

  it("a CITED option brings its own rate: one without a rate is refused, and the RFQ's rate is never used in its place", async () => {
    // Building at the REQUEST's rate would sign an order that cites a quote and creates a pool
    // the quote never named.
    const noRate = withOption((op) => { delete op["rate_override"]; });
    const refused = await cite("0020", noRate);
    expect(refused.state).toBe("unavailable");
    expect(refused.warnings[0]).toMatchObject({ code: "invalid_order_terms" });
    expect(refused.warnings[0]!.message).toMatch(/neither the cited option nor this call names the frozen rate/u);
    for (const bad of ["0", "01", 750000000000000000]) {
      expect((await cite("0021", withOption((op) => { op["rate_override"] = bad; }))).state, JSON.stringify(bad)).toBe("unavailable");
    }
    // The caller's own rate is the way out the message names.
    const own = await cite("0022", noRate, { jitMarket: { rateOverride: "730000000000000000" } });
    expect(own.state, JSON.stringify(own.warnings)).toBe("ok");
    expect((await hookOf(own.data as Answered)).rateOverride).toBe("730000000000000000");
    // A cited option's rate is labeled as the option's, also when it equals the RFQ's.
    const same = await cite("0023", withOption((op) => { op["rate_override"] = RFQ_FIXED_RATE; }));
    expect((same.data as Answered).answer.fixed).toMatchObject({ rateOverride: RFQ_FIXED_RATE, rateFrom: "cited option" });
  });

  it("an explicit rate that differs from the CITED option's is named: the order then cites a quote it does not back", async () => {
    // The explicit rate EQUALS the RFQ's, so the request-side comparison is silent — and the
    // order still builds another pool than the cited quote (RFQ_FIXED_OPTION_RATE) names.
    const other = await cite("0024", ctx, { jitMarket: { rateOverride: RFQ_FIXED_RATE } });
    expect(other.state, JSON.stringify(other.warnings)).toBe("ok");
    const said = other.warnings.filter((x) => x.code === "invalid_order_terms").map((x) => x.message);
    expect(said.some((m) => new RegExp(`the cited option quotes the frozen rate ${RFQ_FIXED_OPTION_RATE}, and jitMarket\\.rateOverride builds this order at ${RFQ_FIXED_RATE} .*a different pool than the quote it cites.*The order still builds`, "u").test(m))).toBe(true);
    expect((await hookOf(other.data as Answered)).rateOverride).toBe(RFQ_FIXED_RATE);
    // The option's own rate, passed explicitly, is no difference; uncited, there is no quote to differ from.
    const equal = await cite("0025", ctx, { jitMarket: { rateOverride: RFQ_FIXED_OPTION_RATE } });
    expect(equal.warnings.some((x) => /the cited option quotes the frozen rate/u.test(x.message))).toBe(false);
    const uncited = await answer("0026", RFQ_FIXED_ID, { jitMarket: { rateOverride: "730000000000000000" } });
    expect(uncited.state, JSON.stringify(uncited.warnings)).toBe("ok");
    expect(uncited.warnings.some((x) => /the cited option quotes the frozen rate/u.test(x.message))).toBe(false);
  });

  it("useRequestedRate builds at the RFQ's own rate by name: the way to cite a rate-less option, and never applied where it cannot be honoured", async () => {
    const noRate = withOption((op) => { delete op["rate_override"]; });
    // The refusal names the parameter and the rate it would use.
    expect((await cite("0030", noRate)).warnings[0]!.message).toMatch(new RegExp(`Pass jitMarket\\.rateOverride .*, or useRequestedRate: true to build at the rate the RFQ asks for \\(${RFQ_FIXED_RATE}\\)`, "u"));
    const asked = await cite("0031", noRate, { useRequestedRate: true });
    expect(asked.state, JSON.stringify(asked.warnings)).toBe("ok");
    expect((await hookOf(asked.data as Answered)).rateOverride).toBe(RFQ_FIXED_RATE);
    expect((asked.data as Answered).answer.fixed).toMatchObject({ rateOverride: RFQ_FIXED_RATE, rateFrom: "rfq", requestedRate: RFQ_FIXED_RATE });
    // The option named no rate, and the order builds what the request asked: nothing to differ from.
    expect(asked.warnings.some((x) => /a different FixedRateOracle/u.test(x.message))).toBe(false);
    // The cited option names ANOTHER rate: the request's rate wins as asked, and the difference is said.
    const other = await cite("0032", ctx, { useRequestedRate: true });
    expect(other.state, JSON.stringify(other.warnings)).toBe("ok");
    expect((await hookOf(other.data as Answered)).rateOverride).toBe(RFQ_FIXED_RATE);
    expect((other.data as Answered).answer.fixed).toMatchObject({ rateFrom: "rfq" });
    expect(other.warnings.some((x) => new RegExp(`the cited option quotes the frozen rate ${RFQ_FIXED_OPTION_RATE}, and useRequestedRate builds this order at ${RFQ_FIXED_RATE} .*or drop useRequestedRate\\. The order still builds`, "u").test(x.message))).toBe(true);
    // Without the flag the same citation builds at the option's rate.
    expect((await hookOf((await cite("0033", ctx)).data as Answered)).rateOverride).toBe(RFQ_FIXED_OPTION_RATE);
    // Two names for one rate are refused as input; the schema's "0" names no rate.
    await expect(cite("0034", ctx, { useRequestedRate: true, jitMarket: { rateOverride: RFQ_FIXED_RATE } })).rejects.toMatchObject({ issues: [{ path: ["action", "useRequestedRate"] }] });
    expect((await cite("0035", noRate, { useRequestedRate: true, jitMarket: { rateOverride: "0" } })).state).toBe("ok");
    // An RFQ that names no rate has none to use.
    const expiry = (NOW + 20n * 86_400n).toString();
    const none = await answer("0036", RFQ_OPEN_ID, { expiryTimestamp: expiry, useRequestedRate: true, jitMarket: { recipe: FIXED_RECIPE } });
    expect(none.state).toBe("unavailable");
    expect(none.warnings[0]).toMatchObject({ code: "invalid_order_terms" });
    expect(none.warnings[0]!.message).toMatch(/useRequestedRate: RFQ .* names no admissible frozen rate.*Pass jitMarket\.rateOverride/u);
    // A recipe that reads an oracle carries no frozen rate: refused, not silently unapplied.
    const oracle = await answer("0037", RFQ_FIXED_ID, { useRequestedRate: true, jitMarket: { recipe: LIQUIDITY_RECIPE } });
    expect(oracle.state).toBe("unavailable");
    expect(oracle.warnings[0]!.message).toMatch(/useRequestedRate with recipe .*, which reads a price oracle.*Drop useRequestedRate/u);
    // Uncited, the RFQ's rate is the default already: the flag changes nothing.
    const uncited = await answer("0038", RFQ_FIXED_ID, { useRequestedRate: true });
    expect((uncited.data as Answered).answer.fixed).toMatchObject({ rateOverride: RFQ_FIXED_RATE, rateFrom: "rfq" });
  });

  it("when the reference's rate cannot be read the order still builds and the answer says the comparison was not made", async () => {
    const wrappers = (lookup: () => string): HandlerContext => ({
      ...ctx,
      resolveRpc: async (chainId, url) => {
        const r = (await ctx.resolveRpc!(chainId, url))!;
        const inner = r.client.readContract.bind(r.client) as (a: { functionName: string }) => Promise<unknown>;
        return { ...r, client: { ...r.client, readContract: (async (a: { functionName: string }) => (a.functionName === "lookupWrapper" ? lookup() : inner(a))) as never } };
      },
    });
    // The registry read itself failing is said with its reason — never swallowed.
    const failed = await answer("0012", RFQ_FIXED_ID, {}, wrappers(() => { throw new Error("registry read timed out"); }));
    expect(failed.state, JSON.stringify(failed.warnings)).toBe("ok");
    expect((failed.data as Answered).answer.notRead).toEqual(["the reference's rate today: registry read timed out"]);
    expect((failed.data as Answered).answer.fixed!.position).toBeUndefined();
    const env = await answer("0011", RFQ_FIXED_ID, {}, wrappers(() => "0x0000000000000000000000000000000000000000"));
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Answered;
    expect(d.answer.fixed).toMatchObject({ rateOverride: RFQ_FIXED_RATE });
    expect(d.answer.fixed!.position).toBeUndefined();
    expect(d.answer.notRead).toEqual(["the reference's rate today: the pair has no deployed nav or price oracle to compare the frozen rate with"]);
  });
});

describe("answer-rfq: an impairment window longer than the market's life — the recipe's verdict, with the cause this tool can see", () => {
  const NOW = 1_790_000_000n;
  const ctx = stubContext();
  const base = { chainId: 42161 as const, account: DEMO_ACCOUNT };
  const answerAt = (id: string, expiry: bigint, over: Record<string, unknown> = {}, c: HandlerContext = ctx) =>
    runTool("cork_prepare_orders", { ...base, clientRequestId: `answer-dur-${id}`, action: { type: "answer-rfq", rfqId: RFQ_IMPAIRMENT_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry.toString(), ...over } }, c);
  const reverts = (env: { warnings: Array<{ code: string; message: string }> }) => env.warnings.filter((x) => x.code === "would_revert").map((x) => x.message);

  it("against a deployed oracle the maker path runs recipe.verify — the creating fill's check — which REJECTS; the cause is said beside it; at the boundary both are silent", async () => {
    // The RFQ's block sizes the window for 7 days; this answer's market lives 3.
    const short = await answerAt("0001", NOW + 3n * 86_400n);
    expect(short.state, JSON.stringify(short.warnings)).toBe("ok");
    const said = reverts(short);
    expect(said).toHaveLength(2);
    // The chain's verdict (the maker path) …
    expect(said.some((m) => /recipe\.verify REJECTS this constraint/u.test(m))).toBe(true);
    // … and why: the recipe's false carries no reason, so the cause this tool can see is named.
    expect(said.some((m) => /^the RFQ's impairment block sizes the rate window for a duration of 604800 s, and this answer's market expires at \d+ \(now 1790000000\): the fill that creates the pool reverts RecipeRejectedConstraint\. The carried duration 604800 s exceeds the market's remaining life 259200 s/u.test(m))).toBe(true);
    // A market that lives exactly the duration is the boundary the recipe admits.
    expect(reverts(await answerAt("0002", NOW + 604_800n))).toEqual([]);
    expect(reverts(await answerAt("0003", NOW + 604_799n))).toHaveLength(2);
  });

  it("the duration judged is the one the ORDER carries: explicit bytes with a shorter duration silence both, with a longer one raise both — attributed to the bytes", async () => {
    const threeDays = NOW + 3n * 86_400n;
    const shorter = await answerAt("0004", threeDays, { jitMarket: { extraData: encodeImpairmentArgs({ anchorRate: 800_000_000_000_000_000n, durationSeconds: 100_000n, apySpreadPercentage: 10n * 10n ** 18n }) } });
    expect(shorter.state, JSON.stringify(shorter.warnings)).toBe("ok");
    expect(reverts(shorter)).toEqual([]);
    // 100000 s against a 259200 s market: more than a day apart, disclosed — and attributed to the bytes, not the block.
    expect(shorter.warnings.find((x) => /sizes the rate window/u.test(x.message))!.message).toMatch(/^jitMarket\.extraData sizes the rate window for a duration of 100000 s while this answer's market lives 259200 s/u);
    const longer = await answerAt("0005", NOW + 604_800n, { jitMarket: { extraData: encodeImpairmentArgs({ anchorRate: 800_000_000_000_000_000n, durationSeconds: 700_000n, apySpreadPercentage: 10n * 10n ** 18n }) } });
    expect(reverts(longer)).toHaveLength(2);
    expect(reverts(longer).some((m) => /^jitMarket\.extraData sizes the rate window for a duration of 700000 s.*The carried duration 700000 s exceeds the market's remaining life 604800 s/u.test(m))).toBe(true);
  });

  it("the rule applies when the pool is CREATED: for a pool that already exists the recipe accepts any duration, and nothing is said", async () => {
    const existing: HandlerContext = {
      ...ctx,
      resolveRpc: async (chainId, url) => {
        const r = (await ctx.resolveRpc!(chainId, url))!;
        const inner = r.client.readContract.bind(r.client) as (a: { functionName: string }) => Promise<unknown>;
        return { ...r, client: { ...r.client, readContract: (async (a: { functionName: string }) => (a.functionName === "shares" ? ["0x00000000000000000000000000000000000000e1", "0x00000000000000000000000000000000000000e2"] : inner(a))) as never } };
      },
    };
    const env = await answerAt("0007", NOW + 3n * 86_400n, {}, existing);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(reverts(env)).toEqual([]);
  });

  it("where verify cannot run yet (the pair's oracle is not deployed) the cause is still said — ahead of the fill's check, not instead of it", async () => {
    const noOracle: HandlerContext = {
      ...ctx,
      resolveRpc: async (chainId, url) => {
        const r = (await ctx.resolveRpc!(chainId, url))!;
        const inner = r.client.readContract.bind(r.client) as (a: { functionName: string }) => Promise<unknown>;
        return { ...r, client: { ...r.client, readContract: (async (a: { functionName: string }) => (a.functionName === "lookupWrapper" ? "0x0000000000000000000000000000000000000000" : inner(a))) as never, simulateContract: (async () => ({ result: "0x00000000000000000000000000000000000000c1" })) as never } };
      },
    };
    const env = await answerAt("0006", NOW + 3n * 86_400n, {}, noOracle);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(reverts(env)).toHaveLength(1);
    expect(reverts(env)[0]).toMatch(/The carried duration 604800 s exceeds the market's remaining life 259200 s.*this generation's impairment recipe rejects such a constraint when the pool is created/u);
  });
});

describe("the recipe.verify pre-flight (JIT ladder and create-pool): a revert is the recipe's refusal, a transport fault is not a verdict", () => {
  const NOW = 1_790_000_000n;
  const stub = stubContext();
  /** The stub chain with its recipe.verify replaced. */
  const withVerify = (verify: () => unknown): HandlerContext => ({
    ...stub,
    resolveRpc: async (chainId, url) => {
      const r = (await stub.resolveRpc!(chainId, url))!;
      const inner = r.client.readContract.bind(r.client) as (a: { functionName: string }) => Promise<unknown>;
      return { ...r, client: { ...r.client, readContract: (async (a: { functionName: string }) => (a.functionName === "verify" ? verify() : inner(a))) as never } };
    },
  });
  const reverting = withVerify(() => { throw new Error("execution reverted: SomeRecipeError(7)"); });
  const flaky = withVerify(() => { throw Object.assign(new Error("verify timed out"), { name: "HttpRequestError" }); });
  const rejecting = withVerify(() => false);
  const answer = (c: HandlerContext, id: string) => runTool("cork_prepare_orders", { chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: `verify-preflight-${id}`, action: { type: "answer-rfq", rfqId: RFQ_IMPAIRMENT_ID, premiumAnnualized: "0.04", expiryTimestamp: RFQ_IMPAIRMENT_EXPIRY } }, c);
  const createPool = (c: HandlerContext, id: string) =>
    runTool("cork_prepare_market", { chainId: 42161, clientRequestId: `verify-preflight-pool-${id}`, action: { type: "create-pool", collateralAsset: JIT_TASK_PAIR.collateralAsset, referenceAsset: JIT_TASK_PAIR.referenceAsset, expiryTimestamp: (NOW + 604_800n).toString(), recipe: IMPAIRMENT_RECIPE, extraData: encodeImpairmentArgs({ anchorRate: 800_000_000_000_000_000n, durationSeconds: 604_800n, apySpreadPercentage: 10n * 10n ** 18n }) } }, c);
  const of = (env: { warnings: Array<{ code: string; message: string }> }, code: string) => env.warnings.filter((w) => w.code === code).map((w) => w.message);

  for (const [name, run] of [["the JIT ladder (answer-rfq → maker-order)", answer], ["create-pool", createPool]] as const) {
    it(`${name}: a REVERT of recipe.verify is would_revert with the recipe's own error name — the artifact must not look fillable`, async () => {
      const env = await run(reverting, "revert");
      expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
      expect(of(env, "would_revert")).toHaveLength(1);
      expect(of(env, "would_revert")[0]).toMatch(/recipe\.verify REVERTS for this constraint: .*SomeRecipeError\(7\).*reverts the same way/u);
      expect(of(env, "chain_read_failed")).toEqual([]);
    });

    it(`${name}: a transport fault on recipe.verify is chain_read_failed, and says nothing about the recipe`, async () => {
      const env = await run(flaky, "transport");
      expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
      expect(of(env, "would_revert")).toEqual([]);
      expect(of(env, "chain_read_failed")).toHaveLength(1);
      expect(of(env, "chain_read_failed")[0]).toMatch(/the recipe\.verify pre-flight read failed in transport \(.*verify timed out.*\)/u);
    });

    it(`${name}: recipe.verify answering false is the rejection (RecipeRejectedConstraint); answering true is silent`, async () => {
      const no = await run(rejecting, "false");
      expect(of(no, "would_revert")).toHaveLength(1);
      expect(of(no, "would_revert")[0]).toMatch(/recipe\.verify REJECTS this constraint.*RecipeRejectedConstraint/u);
      const yes = await run(stub, "true");
      expect(yes.state, JSON.stringify(yes.warnings)).toBe("ok");
      expect(of(yes, "would_revert")).toEqual([]);
      expect(of(yes, "chain_read_failed")).toEqual([]);
    });
  }
});

describe("answer-rfq: every market term comes from the source that stated it", () => {
  const NOW = 1_790_000_000n;
  const ctx = stubContext();
  const underwriter = SIGNED_LOP_PAYLOAD.order.maker as `0x${string}`;
  const expiry = (NOW + 20n * 86_400n).toString();
  type Row = { request: Record<string, any>; answers: Array<{ answer: { options: Array<Record<string, any>> } }> } & Record<string, any>;
  /** The stub's inline RFQ with its venue row changed before the tool reads it. */
  const withRow = (change: (row: Row) => void): HandlerContext => ({
    ...ctx,
    venueFetch: async (url: string, init?: RequestInit) => {
      const res = await ctx.venueFetch!(url, init);
      if (!new URL(url).pathname.endsWith(`/rfqs/v2/${RFQ_INLINE_ID}`)) return res;
      const row = (await res.json()) as Row;
      change(row);
      return new Response(JSON.stringify(row), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  type Built = { typedData: { message: Record<string, string> }; extension: string; answer: { pool: { poolId: string }; inline?: { source: string } } };
  const feesOf = async (d: Built) => {
    const jit = ((await runTool("cork_decode", { chainId: 42161, kind: "order", data: { ...d.typedData.message, extension: d.extension } }, ctx)).data as { jit: Record<string, string> }).jit;
    return { swap: jit["swapFeePercentage"], unwind: jit["unwindSwapFeePercentage"] };
  };
  const uncited = (id: string, jitMarket?: Record<string, unknown>, c: HandlerContext = ctx) =>
    runTool("cork_prepare_orders", { chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: `answer-terms-${id}`, action: { type: "answer-rfq", rfqId: RFQ_INLINE_ID, premiumAnnualized: "0.04", expiryTimestamp: expiry, ...(jitMarket !== undefined ? { jitMarket } : {}) } }, c);
  const cite = (id: string, c: HandlerContext, over: Record<string, unknown> = {}) =>
    runTool("cork_prepare_orders", { chainId: 42161, account: underwriter, clientRequestId: `answer-terms-${id}`, action: { type: "answer-rfq", rfqId: RFQ_INLINE_ID, answerId: RFQ_INLINE_ANSWER_ID, optionId: "opt1", ...over } }, c);
  const said = (env: { warnings: Array<{ code: string; message: string }> }) => env.warnings.filter((w) => w.code === "invalid_order_terms").map((w) => w.message);

  it("a jitMarket object that names no fee keeps the TEMPLATE's fees: the same pool as no jitMarket at all", async () => {
    // The fees are part of the pool id on the 10-field primary. A schema default of "0" used to
    // arrive looking like the caller's own "0" and silently built the zero-fee pool.
    const plain = await uncited("0001");
    expect(plain.state, JSON.stringify(plain.warnings)).toBe("ok");
    const pool = (plain.data as Built).answer.pool.poolId;
    expect(await feesOf(plain.data as Built)).toEqual({ swap: "1000000000000000000", unwind: "0" });
    for (const [id, jitMarket] of [["0002", {}], ["0003", { permits: [] }], ["0004", { recipe: LIQUIDITY_RECIPE }], ["0005", { enableJitMint: false }]] as const) {
      const env = await uncited(id, jitMarket);
      expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
      expect((env.data as Built).answer.pool.poolId, JSON.stringify(jitMarket)).toBe(pool);
      expect(await feesOf(env.data as Built), JSON.stringify(jitMarket)).toEqual({ swap: "1000000000000000000", unwind: "0" });
    }
    // The unwind fee follows the same rule (the stub's template names none, so give it one).
    const unwindFee = withRow((row) => { row.request["market_template"].inline.oracle_params.unwind_swap_fee_wad = "500000000000000000"; });
    expect(await feesOf((await uncited("0008", undefined, unwindFee)).data as Built)).toEqual({ swap: "1000000000000000000", unwind: "500000000000000000" });
    expect(await feesOf((await uncited("0009", {}, unwindFee)).data as Built)).toEqual({ swap: "1000000000000000000", unwind: "500000000000000000" });
    // The caller's own fee still wins — an explicit "0" included.
    const zero = await uncited("0006", { swapFeePercentage: "0" });
    expect((zero.data as Built).answer.pool.poolId).not.toBe(pool);
    expect(await feesOf(zero.data as Built)).toEqual({ swap: "0", unwind: "0" });
    const own = await uncited("0007", { unwindSwapFeePercentage: "2000000000000000000" });
    expect(await feesOf(own.data as Built)).toEqual({ swap: "1000000000000000000", unwind: "2000000000000000000" });
  });

  it("a cited option that states no recipe and no block: the order borrows the request's, and says which", async () => {
    const byId = withRow((row) => { row.answers[0]!.answer.options[0]!["market_template"] = { market_template_id: "tmpl_x" }; });
    const env = await cite("0010", byId);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as Built).answer.inline!.source).toBe("rfq");
    const notice = said(env).find((m) => /states no recipe and no inline block of its own/u.test(m));
    expect(notice).toMatch(new RegExp(`^cited option opt1 states no recipe and no inline block of its own.*takes the recipe ${LIQUIDITY_RECIPE} and the inline block cork-inline-liquidity/1 .*from the RFQ's template.*pass jitMarket\\.recipe to state the recipe yourself\\. The order still builds$`, "u"));
    // The caller's own recipe is not borrowed; the block still is.
    const ownRecipe = await cite("0011", byId, { jitMarket: { recipe: LIQUIDITY_RECIPE } });
    const only = said(ownRecipe).find((m) => /of its own/u.test(m));
    expect(only).toMatch(/states no inline block of its own.*takes the inline block cork-inline-liquidity\/1 .*pass the jitMarket fields to state them yourself/u);
    expect(only).not.toMatch(/no recipe/u);
    // An option that states both borrows nothing; an uncited answer has no quote to vouch.
    expect(said(await cite("0012", ctx)).some((m) => /of its own/u.test(m))).toBe(false);
    expect(said(await uncited("0013")).some((m) => /of its own/u.test(m))).toBe(false);
  });

  it("a warning about a BORROWED block names the RFQ as its owner, not the cited option", async () => {
    const other = (NOW + 21n * 86_400n).toString();
    const byId = withRow((row) => {
      row.answers[0]!.answer.options[0]!["market_template"] = { market_template_id: "tmpl_x" };
      row.request["market_template"].inline.oracle_params.expiry = other;
    });
    const borrowed = said(await cite("0020", byId)).find((m) => /inline template \(oracle_params\.expiry\) names pool expiry/u.test(m));
    expect(borrowed).toMatch(/^the RFQ's inline template/u);
    // The option's own block: the option is the owner.
    const own = withRow((row) => { row.answers[0]!.answer.options[0]!["market_template"].inline.oracle_params.expiry = other; });
    expect(said(await cite("0021", own)).find((m) => /inline template \(oracle_params\.expiry\) names pool expiry/u.test(m))).toMatch(/^the cited option's inline template/u);
  });

  it("the cited option's collateral: the pick on a one_of request, and a difference from the order is named", async () => {
    const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", OTHER = "0xdDb46999F8891663a8F2828d25298f70416d7610", THIRD = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const oneOf = (optionCollateral: string | undefined) => withRow((row) => {
      row.request["collateral_asset"] = { one_of: [CA, THIRD] };
      if (optionCollateral !== undefined) row.answers[0]!.answer.options[0]!["collateral_asset"] = optionCollateral;
    });
    // The quote names its collateral: the caller need not repeat it.
    const quoted = await cite("0030", oneOf(CA));
    expect(quoted.state, JSON.stringify(quoted.warnings)).toBe("ok");
    expect((quoted.data as Built).typedData.message["takerAsset"]!.toLowerCase()).toBe(CA.toLowerCase());
    expect(said(quoted).some((m) => /the cited option quotes collateral/u.test(m))).toBe(false);
    // An option that names none, and no pick: still the caller's to choose.
    await expect(cite("0031", oneOf(undefined))).rejects.toMatchObject({ issues: [{ path: ["action", "collateralAsset"] }] });
    // The option's collateral outside the request's list is refused as the option's.
    const outside = await cite("0032", oneOf(OTHER));
    expect(outside.state).toBe("unavailable");
    expect(outside.warnings[0]!.message).toMatch(/\(the cited option's collateral_asset\) is not among the collateral tokens the RFQ accepts/u);
    // The order builds with another collateral than the quote: said, with the venue's verdict.
    const differs = await cite("0033", withRow((row) => { row.answers[0]!.answer.options[0]!["collateral_asset"] = THIRD; }));
    expect(differs.state, JSON.stringify(differs.warnings)).toBe("ok");
    expect(said(differs).some((m) => new RegExp(`the cited option quotes collateral ${THIRD}, and this order builds with ${CA} .*HTTP 400.*The order still builds`, "u").test(m))).toBe(true);
  });
});
