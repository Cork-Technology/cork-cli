// `cancel` scope "slot" — one bitsInvalidateForOrder that retires the
// anchor order's bit AND the bit of every other resting order of the maker in the same 256-bit
// slot word, read from the venue book. Semantics pinned against limit-order-protocol v4 source:
// BitInvalidatorLib.massInvalidate(nonce, mask) writes word[nonce >> 8] |= (1 << (nonce & 0xff))
// | mask; OrderMixin.bitsInvalidateForOrder reverts OrderIsNotSuitableForMassInvalidation for a
// remaining-invalidator order. Nothing here is mocked below the venue: rows are REAL signed
// orders (buildMakerOrder with pinned nonces, hashed and signed by real keys), the venue is the
// usual fetch stub, and the chain effect is proven on a fork.
import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toFunctionSelector, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildBitsInvalidateForOrder,
  buildCancelOrder,
  buildMakerOrder,
  buildMakerTraits,
  decodeLopCall,
  decodeMakerTraits,
  hashLopOrder,
  LOP_ADDRESSES,
  lopCancelAbi,
  lopInvalidatorPlan,
  maskBits,
  planSlotSweep,
  runTool,
  type HandlerContext,
  type LopOrder,
} from "@cork/core";
import abiFixture from "./fixtures/lop-v4-cancel-abi.json" with { type: "json" };

const CHAIN = 8453 as const;
const LOP = LOP_ADDRESSES[CHAIN]!;
const NOW = 1_800_000_000n;
const maker = privateKeyToAccount(keccak256(toHex("cancel-sweep-maker")));
const stranger = privateKeyToAccount(keccak256(toHex("cancel-sweep-stranger")));
const MAKER_ASSET = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const TAKER_ASSET = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;
const SLOT = 0x1234n;
const nonceIn = (slot: bigint, bit: number) => (slot << 8n) | BigInt(bit);
const hex32 = (v: bigint) => v.toString(16).padStart(64, "0");

/** A real signed order with a pinned nonce, in the venue's row shape. */
async function row(signer: typeof maker, id: string, nonce: bigint, over: Partial<LopOrder> = {}) {
  const built = buildMakerOrder({ chainId: CHAIN, lop: LOP, maker: signer.address, makerAsset: MAKER_ASSET, takerAsset: TAKER_ASSET, makingAmount: 10n ** 18n, takingAmount: 1_000_000n, clientRequestId: id, nonce });
  const order: LopOrder = { ...built.order, ...over };
  const orderHash = hashLopOrder(CHAIN, LOP, order);
  const signature = await signer.sign({ hash: orderHash });
  return {
    orderHash,
    order: { salt: order.salt.toString(), maker: order.maker, receiver: order.receiver, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: order.makingAmount.toString(), takingAmount: order.takingAmount.toString(), makerTraits: order.makerTraits.toString() },
    signature,
    extension: "0x",
    makerAccountType: "EOA",
    traits: order.makerTraits,
  };
}

/** A venue that serves `items` for the orderbook and records every URL it was asked. */
function venue(rows: unknown[], opts: { hasMore?: boolean; status?: number } = {}) {
  const urls: string[] = [];
  // The row helper carries the bigint `traits` for the test's own assertions; the wire is JSON.
  const items = rows.map((r) => { const { traits: _traits, ...wire } = r as { traits?: bigint }; return wire; });
  const fetch: NonNullable<HandlerContext["venueFetch"]> = async (url: string) => {
    urls.push(url);
    if (opts.status !== undefined && opts.status >= 400) return new Response(JSON.stringify({ error: "boom" }), { status: opts.status });
    return new Response(JSON.stringify({ items, hasMore: opts.hasMore ?? false }), { status: 200 });
  };
  return { urls, fetch };
}

const cancel = (ctx: HandlerContext, action: Record<string, unknown>) =>
  runTool("cork_prepare_orders", { chainId: CHAIN, account: maker.address, clientRequestId: "cancel-sweep-test-0001", action: { type: "cancel", ...action } }, { nowSeconds: NOW, ...ctx });

type SweepData = {
  kind: string;
  scope: string;
  to: string;
  calldata: `0x${string}`;
  retires: {
    invalidator: string;
    nonce: string;
    slot: string;
    anchorBit: string;
    additionalMask: `0x${string}`;
    additionalBits: number[];
    scope: string;
    orders: Array<{ orderHash: string; nonce: string; bit: number; relation: string; listed: boolean }>;
    skipped: Array<{ orderHash: string; reason: string }>;
    book: { rows: number; pagesFetched: number; complete: boolean; unreadable: Array<{ venueOrderHash: string | null; reason: string }> };
  };
};

describe("lopCancelAbi — the three v4 cancel entrypoints, golden against IOrderMixin", () => {
  it("names, input types and selectors match the interface fixture", () => {
    const ours = lopCancelAbi.map((f) => ({ name: f.name, selector: toFunctionSelector(f), inputs: f.inputs.map((i) => ({ name: i.name, type: i.type })) }));
    const expected = abiFixture.functions.map((f) => ({ name: f.name, selector: f.selector, inputs: f.inputs.map((i) => ({ name: i.name, type: i.type })) }));
    expect(ours).toEqual(expected);
    expect(toFunctionSelector("bitsInvalidateForOrder(uint256,uint256)")).toBe("0x05b1ea03");
    expect(toFunctionSelector("cancelOrders(uint256[],bytes32[])")).toBe("0x89e7c650");
  });

  it("buildBitsInvalidateForOrder: selector ‖ makerTraits ‖ additionalMask, byte for byte", () => {
    const traits = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: nonceIn(SLOT, 5) });
    const mask = (1n << 9n) | (1n << 200n);
    const { to, data } = buildBitsInvalidateForOrder(traits, mask);
    expect(to).toBeNull();
    expect(data).toBe(`0x05b1ea03${hex32(traits)}${hex32(mask)}`);
    expect(decodeLopCall(data)).toEqual({ fn: "bitsInvalidateForOrder", makerTraits: traits, additionalMask: mask });
  });

  it("refuses a remaining-invalidator order (the LOP reverts OrderIsNotSuitableForMassInvalidation) and a mask outside uint256", () => {
    const remaining = buildMakerTraits({ allowPartialFills: true, allowMultipleFills: true, usePermit2: false, expiry: 0n, nonce: 1n });
    expect(lopInvalidatorPlan(remaining).mode).toBe("remaining");
    expect(() => buildBitsInvalidateForOrder(remaining, 0n)).toThrow(/OrderIsNotSuitableForMassInvalidation/);
    const bit = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 1n });
    expect(() => buildBitsInvalidateForOrder(bit, 1n << 256n)).toThrow(/uint256/);
    expect(() => buildBitsInvalidateForOrder(bit, (1n << 256n) - 1n)).not.toThrow();
  });

  it("cancelOrders decodes pairwise and refuses mismatched array lengths (MismatchArraysLengths)", () => {
    const t1 = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 1n });
    const t2 = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 2n });
    const h1 = `0x${"a1".repeat(32)}` as const;
    const h2 = `0x${"a2".repeat(32)}` as const;
    const data = encodeFunctionData({ abi: lopCancelAbi, functionName: "cancelOrders", args: [[t1, t2], [h1, h2]] });
    expect(data.startsWith("0x89e7c650")).toBe(true);
    expect(decodeLopCall(data)).toEqual({ fn: "cancelOrders", orders: [{ makerTraits: t1, orderHash: h1 }, { makerTraits: t2, orderHash: h2 }] });
    const lopsided = encodeFunctionData({ abi: lopCancelAbi, functionName: "cancelOrders", args: [[t1, t2], [h1]] });
    expect(() => decodeLopCall(lopsided)).toThrow(/MismatchArraysLengths/);
  });

  it("maskBits lists set positions ascending", () => {
    expect(maskBits(0n)).toEqual([]);
    expect(maskBits(1n)).toEqual([0]);
    expect(maskBits((1n << 255n) | (1n << 9n) | 1n)).toEqual([0, 9, 255]);
  });
});

describe("planSlotSweep — pure, judged from the SIGNED traits", () => {
  const bitTraits = (nonce: bigint) => buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce });
  const anchor = { orderHash: `0x${"01".repeat(32)}` as const, makerTraits: bitTraits(nonceIn(SLOT, 5)) };
  const me = maker.address;

  it("a same-slot sibling adds its bit; a shared-bit sibling is listed without adding; other maker / other slot / remaining mode are skipped with reasons", () => {
    const plan = planSlotSweep(anchor, me, [
      { orderHash: `0x${"02".repeat(32)}`, makerTraits: bitTraits(nonceIn(SLOT, 9)), maker: me },
      { orderHash: `0x${"03".repeat(32)}`, makerTraits: bitTraits(nonceIn(SLOT, 5)), maker: me },
      { orderHash: `0x${"04".repeat(32)}`, makerTraits: bitTraits(nonceIn(SLOT + 1n, 5)), maker: me },
      { orderHash: `0x${"05".repeat(32)}`, makerTraits: bitTraits(nonceIn(SLOT, 7)), maker: stranger.address },
      { orderHash: `0x${"06".repeat(32)}`, makerTraits: buildMakerTraits({ allowPartialFills: true, allowMultipleFills: true, usePermit2: false, expiry: 0n, nonce: nonceIn(SLOT, 8) }), maker: me },
      { orderHash: `0x${"07".repeat(32)}`, makerTraits: bitTraits(nonceIn(SLOT, 255)), maker: me.toUpperCase().replace("0X", "0x") as `0x${string}` },
    ]);
    expect(plan.nonce).toBe(nonceIn(SLOT, 5));
    expect(plan.slot).toBe(SLOT);
    expect(plan.anchorBit).toBe(1n << 5n);
    expect(plan.additionalMask).toBe((1n << 9n) | (1n << 255n));
    expect(plan.retires.map((r) => [r.orderHash.slice(0, 6), r.relation])).toEqual([["0x0101", "anchor"], ["0x0202", "same-slot"], ["0x0303", "shared-bit"], ["0x0707", "same-slot"]]);
    expect(plan.skipped).toEqual([
      { orderHash: `0x${"04".repeat(32)}`, reason: "other-slot" },
      { orderHash: `0x${"05".repeat(32)}`, reason: "other-maker" },
      { orderHash: `0x${"06".repeat(32)}`, reason: "remaining-invalidator" },
    ]);
  });

  it("the anchor's own bit never rides in additionalMask (the call spends it regardless), and a duplicate row counts once", () => {
    const plan = planSlotSweep(anchor, me, [
      { orderHash: anchor.orderHash, makerTraits: anchor.makerTraits, maker: me },
      { orderHash: `0x${"02".repeat(32)}`, makerTraits: bitTraits(nonceIn(SLOT, 9)), maker: me },
      { orderHash: `0x${"02".repeat(32)}`, makerTraits: bitTraits(nonceIn(SLOT, 9)), maker: me },
    ]);
    expect(plan.additionalMask & plan.anchorBit).toBe(0n);
    expect(plan.additionalMask).toBe(1n << 9n);
    expect(plan.retires).toHaveLength(2);
  });

  it("refuses a remaining-invalidator anchor — there is no slot word to sweep", () => {
    const remaining = buildMakerTraits({ allowPartialFills: true, allowMultipleFills: true, usePermit2: false, expiry: 0n, nonce: 1n });
    expect(() => planSlotSweep({ orderHash: anchor.orderHash, makerTraits: remaining }, me, [])).toThrow(/remaining-invalidator/);
  });
});

describe("cork_prepare_orders cancel scope 'slot' — the handler over a venue book", () => {
  it("builds one bitsInvalidateForOrder for the anchor's slot with the mask of its same-slot siblings, lists every order it retires from the book, and skips the rest with reasons", async () => {
    const anchor = await row(maker, "sweep-anchor", nonceIn(SLOT, 5));
    const sib9 = await row(maker, "sweep-sib-9", nonceIn(SLOT, 9));
    const sib200 = await row(maker, "sweep-sib-200", nonceIn(SLOT, 200));
    const sharedBit = await row(maker, "sweep-oco-rung", nonceIn(SLOT, 5)); // same nonce, other salt — an ocoGroup sibling
    const otherSlot = await row(maker, "sweep-other-slot", nonceIn(SLOT + 1n, 5));
    const foreign = await row(stranger, "sweep-foreign", nonceIn(SLOT, 7));
    const liar = { ...(await row(maker, "sweep-liar", nonceIn(SLOT, 77))), orderHash: `0x${"ff".repeat(32)}` };
    const v = venue([anchor, sib9, sib200, sharedBit, otherSlot, foreign, liar]);
    const env = await cancel({ venueFetch: v.fetch }, { orderHash: anchor.orderHash, makerTraits: anchor.traits.toString(), scope: "slot" });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as SweepData;
    expect(d.kind).toBe("cancel");
    expect(d.scope).toBe("slot");
    expect(d.to).toBe(LOP);
    // The bytes: the anchor's SIGNED traits and the two same-slot bits, nothing else.
    const mask = (1n << 9n) | (1n << 200n);
    expect(d.calldata).toBe(`0x05b1ea03${hex32(anchor.traits)}${hex32(mask)}`);
    expect(decodeLopCall(d.calldata)).toEqual({ fn: "bitsInvalidateForOrder", makerTraits: anchor.traits, additionalMask: mask });
    // The ledger: who dies, who is left alone, and why.
    expect(d.retires.invalidator).toBe("bit");
    expect(d.retires.nonce).toBe(nonceIn(SLOT, 5).toString());
    expect(d.retires.slot).toBe(SLOT.toString());
    expect(d.retires.anchorBit).toBe((1n << 5n).toString());
    expect(d.retires.additionalMask).toBe(`0x${hex32(mask)}`);
    expect(d.retires.additionalBits).toEqual([9, 200]);
    expect(d.retires.orders).toEqual([
      { orderHash: anchor.orderHash, nonce: nonceIn(SLOT, 5).toString(), bit: 5, relation: "anchor", listed: true },
      { orderHash: sib9.orderHash, nonce: nonceIn(SLOT, 9).toString(), bit: 9, relation: "same-slot", listed: true },
      { orderHash: sib200.orderHash, nonce: nonceIn(SLOT, 200).toString(), bit: 200, relation: "same-slot", listed: true },
      { orderHash: sharedBit.orderHash, nonce: nonceIn(SLOT, 5).toString(), bit: 5, relation: "shared-bit", listed: true },
    ]);
    expect(d.retires.skipped).toEqual([
      { orderHash: otherSlot.orderHash, reason: "other-slot" },
      { orderHash: foreign.orderHash, reason: "other-maker" },
    ]);
    expect(d.retires.book).toMatchObject({ rows: 7, pagesFetched: 1, complete: true });
    expect(d.retires.book.unreadable).toEqual([{ venueOrderHash: liar.orderHash, reason: expect.stringContaining("does not hash to its own claimed orderHash") }]);
    expect(d.retires.scope).toContain(`slot ${SLOT}`);
    expect(d.retires.scope).toContain("2 other resting order(s)");
    // The notice names the same-slot orders only this sweep reaches, and the venue's blindness.
    const codes = env.warnings.map((w) => w.code);
    expect(codes).toEqual(["cancel_sweep_notice"]);
    expect(env.warnings[0]!.message).toContain(sib9.orderHash);
    expect(env.warnings[0]!.message).toContain(sib200.orderHash);
    expect(env.warnings[0]!.message).toContain("1 sharing its bit");
    expect(env.warnings[0]!.message).toContain("does not index cancels");
    // The venue was asked for THIS maker's rows, once.
    expect(v.urls).toHaveLength(1);
    expect(v.urls[0]!.toLowerCase()).toContain(`maker=${maker.address.toLowerCase()}`);
    expect(v.urls[0]).toContain("/limit-orders/v1/orderbook");
  });

  it("with no sibling in the slot the sweep is still built (an empty additional mask) and the notice says it equals cancelOrder", async () => {
    const anchor = await row(maker, "sweep-lonely", nonceIn(SLOT, 5));
    const elsewhere = await row(maker, "sweep-elsewhere", nonceIn(SLOT + 7n, 5));
    const env = await cancel({ venueFetch: venue([anchor, elsewhere]).fetch }, { orderHash: anchor.orderHash, makerTraits: anchor.traits.toString(), scope: "slot" });
    expect(env.state).toBe("ok");
    const d = env.data as SweepData;
    expect(d.calldata).toBe(`0x05b1ea03${hex32(anchor.traits)}${hex32(0n)}`);
    expect(d.retires.additionalBits).toEqual([]);
    expect(d.retires.orders).toHaveLength(1);
    expect(d.retires.skipped).toEqual([{ orderHash: elsewhere.orderHash, reason: "other-slot" }]);
    expect(d.retires.scope).toContain("exactly what cancelOrder would");
    expect(env.warnings.map((w) => w.code)).toEqual(["cancel_sweep_notice"]);
    expect(env.warnings[0]!.message).toContain("no other resting order of yours shares slot");
    expect(env.warnings[0]!.message).toContain("2^32");
  });

  it("an anchor the venue does not list is still swept from the supplied traits, with order_not_found riding as info", async () => {
    const anchor = await row(maker, "sweep-unlisted", nonceIn(SLOT, 5));
    const sib = await row(maker, "sweep-unlisted-sib", nonceIn(SLOT, 9));
    const env = await cancel({ venueFetch: venue([sib]).fetch }, { orderHash: anchor.orderHash, makerTraits: anchor.traits.toString(), scope: "slot" });
    expect(env.state).toBe("ok");
    const d = env.data as SweepData;
    expect(d.retires.additionalBits).toEqual([9]);
    expect(d.retires.orders[0]).toMatchObject({ relation: "anchor", listed: false });
    expect(env.warnings.map((w) => w.code).sort()).toEqual(["cancel_sweep_notice", "order_not_found"]);
  });

  it("supplied makerTraits that disagree with the SIGNED traits of the venue's row for that hash refuse (the wrong slot would be swept)", async () => {
    const anchor = await row(maker, "sweep-traits-lie", nonceIn(SLOT, 5));
    const claimed = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: nonceIn(SLOT + 99n, 5) });
    const env = await cancel({ venueFetch: venue([anchor]).fetch }, { orderHash: anchor.orderHash, makerTraits: claimed.toString(), scope: "slot" });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toContain("SIGNED makerTraits");
    expect(env.warnings[0]!.message).toContain(`slot ${SLOT + 99n}`);
    expect(env.warnings[0]!.message).toContain(`slot ${SLOT}`);
  });

  it("a remaining-invalidator anchor refuses BEFORE the venue is contacted", async () => {
    const remaining = buildMakerTraits({ allowPartialFills: true, allowMultipleFills: true, usePermit2: false, expiry: 0n, nonce: 1n });
    const v = venue([]);
    const env = await cancel({ venueFetch: v.fetch }, { orderHash: `0x${"ab".repeat(32)}`, makerTraits: remaining.toString(), scope: "slot" });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toContain("OrderIsNotSuitableForMassInvalidation");
    expect(v.urls).toHaveLength(0);
  });

  it("an incomplete walk over the book is a conflict (pagination_incomplete) — no bytes from a partial mask", async () => {
    const anchor = await row(maker, "sweep-partial", nonceIn(SLOT, 5));
    const env = await cancel({ venueFetch: venue([anchor], { hasMore: true }).fetch }, { orderHash: anchor.orderHash, makerTraits: anchor.traits.toString(), scope: "slot", maxPages: 3 });
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("pagination_incomplete");
    expect(env.warnings[0]!.message).toContain("no bytes were built");
    expect(env.data).toMatchObject({ scope: "slot", reason: "cursor_absent" });
    expect(env.data).not.toHaveProperty("calldata");
  });

  it("a venue failure is the usual venue envelope, nothing built", async () => {
    const anchor = await row(maker, "sweep-venue-down", nonceIn(SLOT, 5));
    const env = await cancel({ venueFetch: venue([], { status: 503 }).fetch }, { orderHash: anchor.orderHash, makerTraits: anchor.traits.toString(), scope: "slot" });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("venue_unreachable");
  });

  it("scope 'order' (the default) is unchanged: cancelOrder bytes, chain-free, no venue contact", async () => {
    const anchor = await row(maker, "sweep-plain", nonceIn(SLOT, 5));
    const v = venue([anchor]);
    const env = await cancel({ venueFetch: v.fetch }, { orderHash: anchor.orderHash, makerTraits: anchor.traits.toString() });
    expect(env.state).toBe("ok");
    const d = env.data as SweepData & { retires: { nonce: string } };
    expect(d.scope).toBe("order");
    expect(d.calldata).toBe(buildCancelOrder(anchor.traits, anchor.orderHash).data);
    expect(d.retires.nonce).toBe(nonceIn(SLOT, 5).toString());
    expect(v.urls).toHaveLength(0);
    expect(env.warnings).toEqual([]);
  });
});

describe("cork_decode labels the sweep and the batch cancel; the summary names flag 250's series", () => {
  const decode = (data: `0x${string}`) => runTool("cork_decode", { kind: "calldata", chainId: CHAIN, data }, { nowSeconds: NOW });
  type Leg = { kind: string; call: { fn: string }; label: { orderHash: string | null; makerTraits: { nonce: string; series: string; needCheckEpochManager: boolean } | null; orders?: Array<{ orderHash: string; makerTraits: { nonce: string } }>; sweep?: { slot: string; nonce: string; anchorBit: number; additionalMask: string; additionalBits: number[] } } };

  it("bitsInvalidateForOrder: label.sweep carries the slot word, the anchor bit and the additional bits; the summary says SWEEP", async () => {
    const traits = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: nonceIn(SLOT, 5) });
    const mask = (1n << 9n) | (1n << 200n);
    const env = await decode(buildBitsInvalidateForOrder(traits, mask).data);
    expect(env.state).toBe("ok");
    const d = env.data as { summary: string[]; legs: Leg[] };
    const leg = d.legs[0]!;
    expect(leg.kind).toBe("lop");
    expect(leg.call.fn).toBe("bitsInvalidateForOrder");
    expect(leg.label.orderHash).toBeNull();
    expect(leg.label.makerTraits!.nonce).toBe(nonceIn(SLOT, 5).toString());
    expect(leg.label.sweep).toEqual({ slot: SLOT.toString(), nonce: nonceIn(SLOT, 5).toString(), anchorBit: 5, additionalMask: `0x${hex32(mask)}`, additionalBits: [9, 200] });
    expect(d.summary[0]).toMatch(/UNVERIFIED target: SWEEP slot 4660 of your bit invalidator/);
    expect(d.summary[0]).toContain("spends bit 5");
    expect(d.summary[0]).toContain("AND bits 9,200 in one transaction");
    // An empty additional mask is said to equal cancelOrder.
    const plain = await decode(buildBitsInvalidateForOrder(traits, 0n).data);
    expect((plain.data as { summary: string[] }).summary[0]).toContain("the same effect as cancelOrder");
  });

  it("cancelOrders: label.orders carries every pair, label.makerTraits is null, the summary counts them", async () => {
    const t1 = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 11n });
    const t2 = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 12n });
    const h1 = `0x${"a1".repeat(32)}` as const;
    const h2 = `0x${"a2".repeat(32)}` as const;
    const env = await decode(encodeFunctionData({ abi: lopCancelAbi, functionName: "cancelOrders", args: [[t1, t2], [h1, h2]] }));
    expect(env.state).toBe("ok");
    const d = env.data as { summary: string[]; legs: Leg[] };
    expect(d.legs[0]!.call.fn).toBe("cancelOrders");
    expect(d.legs[0]!.label.makerTraits).toBeNull();
    expect(d.legs[0]!.label.orders).toEqual([{ orderHash: h1, makerTraits: expect.objectContaining({ nonce: "11" }) }, { orderHash: h2, makerTraits: expect.objectContaining({ nonce: "12" }) }]);
    expect(d.summary[0]).toContain("cancel 2 1inch limit orders");
  });

  it("flag 250 (NEED_CHECK_EPOCH_MANAGER) is labeled on the traits and the cancel summary names the series an epoch bump would also retire", async () => {
    const base = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 33n });
    const withEpoch = base | (1n << 250n) | (7n << 160n);
    expect(decodeMakerTraits(withEpoch)).toMatchObject({ needCheckEpochManager: true, series: 7n, nonce: 33n });
    expect(decodeMakerTraits(base).needCheckEpochManager).toBe(false);
    const hash = `0x${"c0".repeat(32)}` as const;
    const env = await decode(buildCancelOrder(withEpoch, hash).data);
    const d = env.data as { summary: string[]; legs: Leg[] };
    expect(d.legs[0]!.label.makerTraits).toMatchObject({ needCheckEpochManager: true, series: "7" });
    expect(d.summary[0]).toContain("checks the epoch of series 7 — an epoch bump retires it too");
    const plain = await decode(buildCancelOrder(base, hash).data);
    expect((plain.data as { summary: string[] }).summary[0]).not.toContain("epoch");
    const sweep = await decode(buildBitsInvalidateForOrder(withEpoch, 0n).data);
    expect((sweep.data as { summary: string[] }).summary[0]).toContain("checks the epoch of series 7");
  });
});
