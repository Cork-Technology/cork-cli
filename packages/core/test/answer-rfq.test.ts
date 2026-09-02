// answer-rfq and refresh-order — the underwriter's two most frequent moves as one call each.
// The amount math is pinned to the kernel's golden (cork-indexing-api scripts/golden-units.mjs);
// the handler runs against the eval stub's full chain + venue (the same stack the JIT tasks use:
// registry, recipe.resolve, share prediction via eth_simulateV1, decimals), so the derivation is
// the production path, not a mock of it.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { answerOcoGroup, buildMakerOrder, coverMakingAmount, decodeMakerTraits, impliedPremiumWad, LOP_ADDRESSES, premiumAmount, premiumFraction, RE_REST_MAX_SECONDS, RE_REST_MIN_SECONDS, reRestExpirySeconds, runTool, ToolInputError, YEAR_SECONDS } from "@cork/core";
import { stubRpc } from "./helpers.ts";
import { DEMO_ACCOUNT } from "@cork/schemas";
import { DERIVED_JIT_POOL, FIRM_ANSWER_ID, JIT_TASK_PAIR, LIQUIDITY_RECIPE, RC2_CLONE_OWNER, RFQ_OPEN_ID, SIGNED_LOP_PAYLOAD, stubContext } from "../../../evals/stub.ts";

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
  type Answered = { kind: string; orderHash: string; nonce: string; ocoGroup: string; allowedSender: string | null; typedData: { message: Record<string, string> }; jit?: { derivedPoolId: string; predictedCorkSwapToken?: string }; answer: { takingAmount: string; makingAmount: string; tenorSeconds: string; reservedFor: string; expirySeconds: number; expiryRule: string; quoteRef: unknown; pool: { poolId: string; corkSwapToken: string; exists: boolean }; collateralDecimals: number; impliedPremiumWad: string }; execution: { then: string[] } };

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
    // Reach: reserved for the requester (low 80 bits), by default.
    expect(d.answer.reservedFor.toLowerCase()).toBe(RC2_CLONE_OWNER.toLowerCase());
    expect(d.allowedSender).toBe(`0x${RC2_CLONE_OWNER.slice(-20).toLowerCase()}`);
    // Expiry: the RFQ's valid_until (1795000000) is 5e6 s away → the 600 s cap applies.
    expect(d.answer.expirySeconds).toBe(600);
    expect(d.answer.expiryRule).toContain("re-rest rule");
    expect(BigInt(decodeMakerTraits(BigInt(d.typedData.message.makerTraits!)).expiry)).toBe(NOW + 600n);
    expect(d.ocoGroup).toBe(`rfq:${RFQ_OPEN_ID}`);
    expect(d.answer.quoteRef).toBeNull();
    expect(d.execution.then.some((s) => s.includes("refresh-order"))).toBe(true);
    expect(env.warnings.some((w) => w.code === "oco_group_notice")).toBe(true);
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
    // the JIT task fixture's, so the pool is DERIVED_JIT_POOL.
    expect(BigInt(d.answer.takingAmount)).toBe(premiumAmount("0.05", 1000n * 10n ** 18n, 1_900_000_000n - NOW));
    expect(d.answer.pool.poolId.toLowerCase()).toBe(DERIVED_JIT_POOL.toLowerCase());
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
