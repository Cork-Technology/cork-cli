// taker-fill `signedOrder`: the venue-free fill path. The caller already holds the signed
// order (finalize-maker-order's submitInput carries the exact shape), so the venue must not be
// contacted at all — every inline test here proves that with a venueFetch that THROWS on any
// call. The verification bar mirrors the venue path and adds the checks the venue used to do
// at post time: local re-hash against the claimed orderHash [K3], the salt↔extension binding
// OrderLib enforces at fill, and the maker signature verified the way the fill verifies it
// (EOA ecrecover / the ERC-1271 isValidSignature staticcall). The shared tail (liveness [K7],
// auction, JIT, forSelf) is the same code object for both paths — the parity test pins that.
import { describe, expect, it } from "vitest";
import { keccak256, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import { runTool } from "../src/handlers.ts";
import { stubRpc } from "./helpers.ts";

const LOP = LOP_ADDRESSES[1]!;
const MAKER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // throwaway
const maker = privateKeyToAccount(MAKER_PK);
const stranger = privateKeyToAccount(`0x${"04".repeat(32)}`);
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as const;
const CST = "0x00000000000000000000000000000000000000c5" as const;
const COLLATERAL = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const NOW = 1_790_000_000n;

const venueMustNotBeCalled = async (): Promise<Response> => {
  throw new Error("the venue was contacted — the signedOrder path must be venue-free");
};

/** Chain stub: order live in the bit invalidator; every address without an entry in `code`
 *  answers eth_getCode "0x" (an EOA). */
const liveChain = (opts: { code?: Record<string, string>; isValidSignature?: string | Error } = {}) =>
  stubRpc(
    (c) => {
      switch (c.functionName) {
        case "bitInvalidatorForOrder":
          return 0n; // untouched slot — live
        case "isValidSignature":
          if (opts.isValidSignature instanceof Error) throw opts.isValidSignature;
          return opts.isValidSignature ?? "0x1626ba7e";
        default:
          throw new Error(`no stub for ${c.functionName}`);
      }
    },
    { code: opts.code },
  );

function baseOrder(over: Partial<LopOrder> = {}): LopOrder {
  return {
    salt: 42n,
    maker: maker.address,
    receiver: zeroAddress,
    makerAsset: CST,
    takerAsset: COLLATERAL,
    makingAmount: 10n ** 18n,
    takingAmount: 5n * 10n ** 16n,
    makerTraits: 0n,
    ...over,
  };
}

const wire = (o: LopOrder) => ({
  salt: o.salt.toString(),
  maker: o.maker,
  receiver: o.receiver,
  makerAsset: o.makerAsset,
  takerAsset: o.takerAsset,
  makingAmount: o.makingAmount.toString(),
  takingAmount: o.takingAmount.toString(),
  makerTraits: o.makerTraits.toString(),
});

async function signedInline(over: Partial<LopOrder> = {}) {
  const order = baseOrder(over);
  const orderHash = hashLopOrder(1, LOP, order);
  const signature = await maker.sign({ hash: orderHash });
  return { order, orderHash, signature };
}

const fill = (orderHash: `0x${string}`, signedOrder: Record<string, unknown>, ctxOver: Record<string, unknown> = {}) =>
  runTool(
    "cork_prepare_orders",
    { chainId: 1, account: ACCOUNT, clientRequestId: "inline-fill-0001", action: { type: "taker-fill", orderHash, signedOrder }, format: "concise" },
    { nowSeconds: NOW, venueFetch: venueMustNotBeCalled, resolveRpc: liveChain(), ...ctxOver },
  );

describe("taker-fill signedOrder — the venue-free path", () => {
  it("builds fill bytes without touching the venue, byte-identical to the venue path's build", async () => {
    const { order, orderHash, signature } = await signedInline();
    const inline = await fill(orderHash, { order: wire(order), signature });
    expect(inline.state).toBe("ok");
    const d = inline.data as { calldata: string; to: string; orderHash: string; fillFunction: string; requiredTakingAmount: string };
    expect(d.orderHash).toBe(orderHash);
    expect(d.to).toBe(LOP);

    // Path parity: the same order served by a venue row must produce IDENTICAL calldata —
    // the tail is one code object, and this pins that the acquisition split stays byte-neutral.
    const row = { orderHash, order: wire(order), signature, extension: "0x", makerAccountType: "EOA" };
    const venuePath = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: ACCOUNT, clientRequestId: "inline-fill-0001", action: { type: "taker-fill", orderHash }, format: "concise" },
      {
        nowSeconds: NOW,
        venueFetch: async (url: string) => (url.includes("orderbook") ? new Response(JSON.stringify({ items: [row], hasMore: false }), { status: 200 }) : new Response(JSON.stringify({ items: [] }), { status: 200 })),
        resolveRpc: liveChain(),
      },
    );
    expect(venuePath.state).toBe("ok");
    expect((venuePath.data as { calldata: string }).calldata).toBe(d.calldata);
    expect((venuePath.data as { takerTraits: string }).takerTraits).toBe((inline.data as { takerTraits: string }).takerTraits);
  });

  it("accepts the exact submitInput shape finalize-maker-order emits (round-trip)", async () => {
    const { order, orderHash, signature } = await signedInline();
    const prepared = { kind: "maker-order", lop: LOP, typedData: { domain: { chainId: 1, verifyingContract: LOP }, message: wire(order) }, orderHash, extension: "0x", clientRequestId: "inline-fin-0001" };
    const fin = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: maker.address, clientRequestId: "inline-fin-0001", action: { type: "finalize-maker-order", prepared, signature, listing: { side: "SELL", premiumAnnualized: "0.041", expiry: 0, nonce: "1", allowsPartialFills: false } }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(fin.state).toBe("ok");
    const sub = (fin.data as { submitInput: { action: { order: Record<string, string>; signature: `0x${string}`; extension: `0x${string}` } } }).submitInput.action;
    const env = await fill(orderHash, { order: sub.order, signature: sub.signature, extension: sub.extension });
    expect(env.state).toBe("ok");
    expect((env.data as { orderHash: string }).orderHash).toBe(orderHash);
  });

  it("refuses an order that does not hash to orderHash (order_hash_mismatch, no bytes)", async () => {
    const { order, signature } = await signedInline();
    const other = hashLopOrder(1, LOP, baseOrder({ salt: 43n }));
    const env = await fill(other, { order: wire(order), signature });
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "order_hash_mismatch")).toBe(true);
    expect((env.data as { localOrderHash: string }).localOrderHash).toBe(hashLopOrder(1, LOP, order));
    expect((env.data as { calldata?: string }).calldata).toBeUndefined();
  });

  it("refuses an extension the salt does not commit to (InvalidExtension at fill)", async () => {
    const { order, orderHash, signature } = await signedInline();
    const env = await fill(orderHash, { order: wire(order), signature, extension: "0xdeadbeef" });
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "signature_or_reconstruction_mismatch" && w.message.includes("keccak256(extension)"))).toBe(true);
  });

  it("accepts an extension the salt DOES commit to", async () => {
    const extension = "0x00000001" as const;
    const extLow = BigInt(keccak256(extension)) & ((1n << 160n) - 1n);
    const order = baseOrder({ salt: extLow });
    const orderHash = hashLopOrder(1, LOP, order);
    const signature = await maker.sign({ hash: orderHash });
    const env = await fill(orderHash, { order: wire(order), signature, extension });
    expect(env.state).toBe("ok");
  });

  it("refuses a signature from the wrong signer (recoveredSigner disclosed)", async () => {
    const { order, orderHash } = await signedInline();
    const signature = await stranger.sign({ hash: orderHash });
    const env = await fill(orderHash, { order: wire(order), signature });
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "signature_or_reconstruction_mismatch" && w.message.includes("recovers to"))).toBe(true);
    expect((env.data as { recoveredSigner: string }).recoveredSigner.toLowerCase()).toBe(stranger.address.toLowerCase());
  });

  it("attributes a zero makingAmount to the CALLER (invalid_order_terms, not invalid_service_response)", async () => {
    const { order, signature } = await signedInline({ makingAmount: 0n });
    const orderHash = hashLopOrder(1, LOP, { ...order, makingAmount: 0n });
    const env = await fill(orderHash, { order: wire({ ...order, makingAmount: 0n }), signature });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
  });

  it("still runs the on-chain liveness pre-flight [K7]: a dead order yields no bytes", async () => {
    const { order, orderHash, signature } = await signedInline();
    const deadChain = stubRpc((c) => {
      if (c.functionName === "bitInvalidatorForOrder") return (1n << 42n) | 1n; // every low slot bit spent
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await fill(orderHash, { order: wire(order), signature }, { resolveRpc: deadChain });
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "status_mismatch")).toBe(true);
  });

  it("verifies a CONTRACT maker via the ERC-1271 staticcall (magic value → ok)", async () => {
    const { order, orderHash } = await signedInline();
    const signature = `0x${"11".repeat(65)}` as const; // opaque contract-scheme bytes
    const env = await fill(orderHash, { order: wire(order), signature }, { resolveRpc: liveChain({ code: { [maker.address.toLowerCase()]: "0x6080" } }) });
    expect(env.state).toBe("ok");
  });

  it("refuses a CONTRACT maker whose isValidSignature does not answer the magic value", async () => {
    const { order, orderHash } = await signedInline();
    const signature = `0x${"11".repeat(65)}` as const;
    const env = await fill(orderHash, { order: wire(order), signature }, { resolveRpc: liveChain({ code: { [maker.address.toLowerCase()]: "0x6080" }, isValidSignature: "0xffffffff" }) });
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "signature_or_reconstruction_mismatch" && w.message.includes("ERC-1271"))).toBe(true);
    expect((env.data as { isValidSignatureAnswer: string }).isValidSignatureAnswer).toBe("0xffffffff");
  });

  it("without an RPC: ecrecover still gates, code-detection gap disclosed, liveness skipped", async () => {
    const { order, orderHash, signature } = await signedInline();
    const env = await fill(orderHash, { order: wire(order), signature }, { resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "chain_read_failed" && w.message.includes("whether the maker has code"))).toBe(true);
    // ...and the wrong signer still refuses offline.
    const bad = await fill(orderHash, { order: wire(order), signature: await stranger.sign({ hash: orderHash }) }, { resolveRpc: async () => null });
    expect(bad.state).toBe("conflict");
  });
});
