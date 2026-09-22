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
import { DERIVED_JIT_POOL, FIRM_ANSWER_ID, JIT_TASK_CONSTRAINT, JIT_TASK_EXPIRY, JIT_TASK_PAIR, LIQUIDITY_RECIPE, RC2_CLONE_OWNER, RFQ_INLINE_ANCHOR, RFQ_INLINE_ANSWER_ID, RFQ_INLINE_ID, RFQ_INLINE_OPTION_ANCHOR, RFQ_NOSENDER_ID, RFQ_OPEN_ID, SIGNED_LOP_PAYLOAD, stubContext, RFQ_IMPAIRMENT_ID, RFQ_IMPAIRMENT_PARTIAL_ID, RFQ_IMPAIRMENT_DURATION, RFQ_IMPAIRMENT_SPREAD, RFQ_IMPAIRMENT_EXPIRY, IMPAIRMENT_RECIPE } from "../../../evals/stub.ts";

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
    expect(d.answer.quoteRef).toBeNull();
    expect(d.execution.then.some((s) => s.includes("refresh-order"))).toBe(true);
    expect(env.warnings.some((w) => w.code === "oco_group_notice")).toBe(true);
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

  it("cited: a maker may cite only its OWN answer; the answer's underwriter gets quoteRef + the option's premium and expiry", async () => {
    const other = await runTool("cork_prepare_orders", { ...base, clientRequestId: "answer-0003", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, answerId: FIRM_ANSWER_ID, optionId: "opt1", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(other.state).toBe("unavailable");
    expect(other.warnings[0]!.code).toBe("invalid_order_terms");
    expect(other.warnings[0]!.message).toContain("OWN answer");
    const underwriter = SIGNED_LOP_PAYLOAD.order.maker as `0x${string}`;
    const mine = await runTool("cork_prepare_orders", { ...base, account: underwriter, clientRequestId: "answer-0004", action: { type: "answer-rfq", rfqId: RFQ_OPEN_ID, answerId: FIRM_ANSWER_ID, optionId: "opt1", jitMarket: { recipe: LIQUIDITY_RECIPE } } }, ctx);
    expect(mine.state, JSON.stringify(mine.warnings)).toBe("ok");
    const d = mine.data as Answered;
    expect(d.answer.quoteRef).toEqual({ rfqId: RFQ_OPEN_ID, answerId: FIRM_ANSWER_ID, optionId: "opt1" });
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
    const note = env.warnings.find((w) => w.code === "invalid_order_terms" && w.message.includes("duration_seconds"));
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
