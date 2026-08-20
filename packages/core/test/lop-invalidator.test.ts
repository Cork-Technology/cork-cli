// LOP cancel-flow UX: the on-chain invalidator leg of track reconcile for LOP orders, plus the
// pure invalidator math — semantics pinned against limit-order-protocol source (MakerTraitsLib,
// RemainingInvalidatorLib, OrderMixin.cancelOrder): bit mode when NO_PARTIAL_FILLS(255) is set OR
// ALLOW_MULTIPLE_FILLS(254) is unset; slot = nonceOrEpoch >> 8, mask = 1 << (nonce & 0xff);
// remaining mode reads the RAW view (the non-raw one REVERTS for a never-touched order),
// raw == 0 → untouched, else remaining = ~raw.
import { describe, expect, it } from "vitest";
import {
  buildMakerOrder,
  classifyBitInvalidator,
  classifyInvalidatorWord,
  classifyRemainingRaw,
  LOP_ADDRESSES,
  lopInvalidatorPlan,
  readLopInvalidator,
  runTool,
  type ContractReader,
  type HandlerContext,
} from "@cork/core";
import { stubResolved } from "./helpers.ts";
import { FakeLopInvalidators } from "./lop-fakes.ts";

const U256_MAX = (1n << 256n) - 1n;
const HASH = `0x${"7".repeat(64)}` as const;
const MAKER = "0x00000000000000000000000000000000000000a1" as const;
const LOP = LOP_ADDRESSES[1]!;

describe("lopInvalidatorPlan (MakerTraitsLib layout)", () => {
  const mk = (clientRequestId: string) =>
    buildMakerOrder({
      chainId: 1,
      lop: "0x111111125421cA6dc452d289314280a0f8842A65",
      maker: "0x00000000000000000000000000000000000000A1",
      makerAsset: "0x00000000000000000000000000000000000000B1",
      takerAsset: "0x00000000000000000000000000000000000000C1",
      makingAmount: 1n,
      takingAmount: 1n,
      clientRequestId,
    });

  it("Cork-built maker orders (allowMultipleFills:false) always use the bit invalidator", () => {
    const plan = lopInvalidatorPlan(mk("inv-test-0001").order.makerTraits);
    expect(plan.mode).toBe("bit");
  });

  it("distinct requests get distinct invalidator bits, so two live orders do not kill each other", () => {
    // BitInvalidatorLib.checkAndInvalidate keys on (maker, nonce), NOT orderHash. A fixed nonce
    // would put every order one maker signs on a single bit: the first fill or cancel of any one
    // would revert every other with BitInvalidatedOrder.
    const a = lopInvalidatorPlan(mk("inv-test-0001").order.makerTraits);
    const b = lopInvalidatorPlan(mk("inv-test-0002").order.makerTraits);
    expect(a.mode).toBe("bit");
    expect(b.mode).toBe("bit");
    if (a.mode === "bit" && b.mode === "bit") {
      // same (slot, mask) is the collision we are preventing
      expect(`${a.slot}:${a.mask}`).not.toBe(`${b.slot}:${b.mask}`);
      expect(a.nonceOrEpoch).not.toBe(b.nonceOrEpoch);
    }
  });

  it("the same request id reproduces the same nonce (byte-identical retries [K2])", () => {
    expect(mk("inv-test-0001").order.makerTraits).toBe(mk("inv-test-0001").order.makerTraits);
    expect(mk("inv-test-0001").nonce).toBe(mk("inv-test-0001").nonce);
  });

  it("the derived nonce fits the 40-bit trait slot", () => {
    const U40 = (1n << 40n) - 1n;
    for (const id of ["a", "inv-test-0001", "x".repeat(120)]) {
      const { nonce, order } = mk(id);
      expect(nonce).toBeLessThanOrEqual(U40);
      expect((order.makerTraits >> 120n) & U40).toBe(nonce); // packed where the fill path reads it
    }
  });
  it("no-partial-fills orders use the bit invalidator with slot/mask from nonceOrEpoch", () => {
    const nonce = 0x1b3n; // slot 1, bit 0xb3
    const traits = (1n << 255n) | (nonce << 120n);
    const plan = lopInvalidatorPlan(traits);
    expect(plan).toMatchObject({ mode: "bit", slot: 1n, mask: 1n << 0xb3n, nonceOrEpoch: nonce });
  });

  it("readLopInvalidator passes the NONCE to bitInvalidatorForOrder — the view shifts by 8 itself", async () => {
    // OrderMixin.bitInvalidatorForOrder(maker, slot) forwards to BitInvalidatorLib.checkSlot(nonce),
    // which reads _raw[nonce >> 8]. Passing the pre-shifted slot index reads _raw[nonce >> 16]: an
    // empty word, so a cancelled order looked live (2026-08-20). The fake below keeps storage the
    // way the library does, so only the right argument sees the spent bit.
    const nonce = 0x1b3n;
    const traits = (1n << 255n) | (nonce << 120n);
    const plan = lopInvalidatorPlan(traits);
    const chain = new FakeLopInvalidators();
    chain.spendNonce(MAKER, nonce);
    const word = await readLopInvalidator(chain as unknown as ContractReader, plan, LOP, MAKER, HASH);
    expect(chain.calls).toEqual([{ functionName: "bitInvalidatorForOrder", args: [MAKER, nonce] }]);
    expect(word).toBe(1n << 0xb3n);
    expect(classifyInvalidatorWord(plan, word)).toEqual({ status: "filled-or-cancelled" });
    // The same order before anything spent it: live.
    expect(classifyInvalidatorWord(plan, await readLopInvalidator(new FakeLopInvalidators() as unknown as ContractReader, plan, LOP, MAKER, HASH))).toEqual({ status: "live-untouched" });
  });

  it("readLopInvalidator reads the RAW remaining view by orderHash for multiple-fill orders", async () => {
    const plan = lopInvalidatorPlan(1n << 254n);
    const chain = new FakeLopInvalidators();
    chain.setRemaining(MAKER, HASH, 250n);
    const word = await readLopInvalidator(chain as unknown as ContractReader, plan, LOP, MAKER, HASH);
    expect(chain.calls).toEqual([{ functionName: "rawRemainingInvalidatorForOrder", args: [MAKER, HASH] }]);
    expect(classifyInvalidatorWord(plan, word)).toEqual({ status: "live-partially-filled", remaining: 250n });
  });
  it("partial+multiple-fill orders use the remaining invalidator", () => {
    const traits = 1n << 254n; // ALLOW_MULTIPLE_FILLS set, NO_PARTIAL_FILLS unset
    expect(lopInvalidatorPlan(traits)).toEqual({ mode: "remaining" });
  });
});

describe("invalidator classification (RemainingInvalidatorLib semantics)", () => {
  it("raw 0 = never touched (the non-raw view would revert here)", () => {
    expect(classifyRemainingRaw(0n)).toEqual({ status: "live-untouched" });
  });
  it("raw uint256.max = fully filled or cancelled (remaining 0)", () => {
    expect(classifyRemainingRaw(U256_MAX)).toEqual({ status: "filled-or-cancelled" });
  });
  it("partially filled: remaining = ~raw", () => {
    const remaining = 500n;
    expect(classifyRemainingRaw(U256_MAX ^ remaining)).toEqual({ status: "live-partially-filled", remaining });
  });
  it("bit invalidator: bit unset = live, set = filled-or-cancelled", () => {
    expect(classifyBitInvalidator(0n, 1n)).toEqual({ status: "live-untouched" });
    expect(classifyBitInvalidator(0b100n, 0b100n)).toEqual({ status: "filled-or-cancelled" });
    expect(classifyBitInvalidator(0b011n, 0b100n)).toEqual({ status: "live-untouched" });
  });
});

// ── tool-level: track reconcile orderHash on a LOP order (offline stubs) ─────
function stubCtx(args: {
  bookRow?: Record<string, unknown>;
  fills?: Array<Record<string, unknown>>;
  chainRead?: bigint; // invalidator view return; undefined = no RPC resolves
}): HandlerContext {
  return {
    nowSeconds: 1_790_000_000n,
    venueFetch: async (url) => {
      if (url.includes("/rollover/v1/orders/")) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      if (url.includes("/limit-orders/v1/fills")) return new Response(JSON.stringify({ items: args.fills ?? [] }), { status: 200 });
      if (url.includes("/limit-orders/v1/orderbook")) return new Response(JSON.stringify({ items: args.bookRow ? [args.bookRow] : [] }), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
    resolveRpc:
      args.chainRead === undefined
        ? async () => null
        : async () => stubResolved({ readContract: async () => args.chainRead }),
  };
}

const track = (ctx: HandlerContext) =>
  runTool("cork_track", { mode: "reconcile", chainId: 1, subject: { kind: "orderHash", orderHash: HASH }, format: "concise" }, ctx);

const BIT_TRAITS = ((1n << 255n) | (0n << 120n)).toString(); // no-partial, nonce 0 → slot 0 mask 1

describe("track reconcile: LOP invalidator leg [K7]", () => {
  it("resting order, chain says live → ok, chain-sourced, cancellable", async () => {
    const env = await track(stubCtx({ bookRow: { orderHash: HASH, maker: MAKER, makerTraits: BIT_TRAITS }, chainRead: 0n }));
    expect(env.state).toBe("ok");
    expect(env.provenance.source).toBe("chain");
    const v = (env.data as { chainVerification: Record<string, unknown>; resting: boolean });
    expect(v.resting).toBe(true);
    expect(v.chainVerification.onChainStatus).toBe("live-untouched");
    expect(v.chainVerification.cancellable).toBe(true);
  });

  it("venue still lists it but the chain bit is set → CONFLICT, chain outranks [K7]", async () => {
    const env = await track(stubCtx({ bookRow: { orderHash: HASH, maker: MAKER, makerTraits: BIT_TRAITS }, chainRead: 1n }));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("status_mismatch");
    expect((env.data as { chainStatus: string }).chainStatus).toBe("filled-or-cancelled");
  });

  it("against a faithful invalidator model, a cancelled order with a NON-ZERO nonce reconciles dead", async () => {
    // Nonce 0x1b3 lives in slot 1. A read keyed on the slot index would ask the contract for
    // nonce 1 → slot 0 → an empty word → "live". The faithful fake makes that mistake visible.
    const nonce = 0x1b3n;
    const traits = ((1n << 255n) | (nonce << 120n)).toString();
    const chain = new FakeLopInvalidators();
    chain.spendNonce(MAKER, nonce);
    const ctx = { ...stubCtx({ bookRow: { orderHash: HASH, maker: MAKER, makerTraits: traits } }), resolveRpc: chain.resolveRpc() };
    const env = await track(ctx);
    expect(env.state).toBe("conflict");
    expect((env.data as { chainStatus: string }).chainStatus).toBe("filled-or-cancelled");
    expect(chain.calls.map((c) => c.args[1])).toEqual([nonce]);
  });

  it("remaining-mode order partially filled → remaining amount surfaced, still cancellable", async () => {
    const remaining = 250n;
    const traits = (1n << 254n).toString(); // partial+multiple → remaining mode
    const env = await track(stubCtx({ fills: [{ orderHash: HASH, maker: MAKER, makerTraits: traits }], chainRead: U256_MAX ^ remaining }));
    expect(env.state).toBe("ok");
    const v = (env.data as { chainVerification: Record<string, unknown> }).chainVerification;
    expect(v.onChainStatus).toBe("live-partially-filled");
    expect(String(v.remainingMakingAmount)).toBe("250");
    expect(v.cancellable).toBe(true);
  });

  it("no RPC resolvable → venue-reported with the disclosure warning, never fabricated", async () => {
    const env = await track(stubCtx({ bookRow: { orderHash: HASH, maker: MAKER, makerTraits: BIT_TRAITS } }));
    expect(env.state).toBe("ok");
    expect(env.provenance.source).toBe("indexer");
    expect(env.warnings.some((w) => w.code === "venue_reported")).toBe(true);
  });

  it("venue rows without maker/makerTraits → the gap is disclosed, not guessed", async () => {
    const env = await track(stubCtx({ fills: [{ orderHash: HASH, taker: MAKER }], chainRead: 0n }));
    expect(env.state).toBe("ok");
    expect(env.provenance.source).toBe("indexer");
    expect(env.warnings[0]?.message).toContain("maker/makerTraits");
  });

  it("unknown everywhere → order_not_found (a normal outcome)", async () => {
    const env = await track(stubCtx({}));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("order_not_found");
  });
});
