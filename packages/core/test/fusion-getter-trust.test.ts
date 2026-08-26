// A Fusion order's price comes from the contract its extension NAMES, not from the bytes after
// the address — those are caller-controlled data (audit ARTIFACT-FUSION-003, 2026-08-24). So a
// getter that is not the release-pinned current deployment cannot be priced here, and the
// consequences differ by surface:
//   compute dutch-auction-price — unavailable, with the classification reported;
//   prepare taker-fill        — the AUTOMATIC (curve-derived) cap is refused, but an explicit
//                               maximumTakingAmount still builds: the LOP enforces that cap
//                               on-chain, so an unknown getter can make the fill revert, never
//                               overcharge;
//   decode order              — the shape still decodes; nothing is inferred from it.
// The taking-side getter is classified BEFORE the making==taking invariant, because the taking
// side is the one that decides what the taker pays.
import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeExtensionFields, encodeExtensionFields, hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import { decodeFusionOrder, NotAFusionOrder } from "../src/fusion.ts";
import { runTool } from "../src/handlers.ts";
import { TOOL_EXAMPLES } from "@cork/schemas";
import { stubRpc } from "./helpers.ts";

const NOW = 1_790_000_000n;
const LOP = LOP_ADDRESSES[42161]!;
const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as const;
const CURRENT_GETTER = "2ad5004c60e16e54d5007c80ce329adde5b51ef5"; // the pinned v3.1 settlement
const UNKNOWN_GETTER = "00000000000000000000000000000000000000aa";
const LEGACY_GETTER = "fb2809a5314473e1165f6b58018e20ed8f07b840"; // a configured legacy deployment

// The canonical auction example, read from TOOL_EXAMPLES rather than copied: a hand-copied
// extension literal is one dropped nibble away from testing the wrong thing (it was, once).
const EXAMPLE_EXT = (
  (TOOL_EXAMPLES.cork_compute!.find((e) => (e.input as { params?: { kind?: string } }).params?.kind === "dutch-auction-price")!.input as {
    params: { order: { extension: `0x${string}` } };
  }).params.order.extension
);

/** The same order with `getter` substituted on BOTH amount-getter sides, salt re-bound. */
function orderWithGetter(getter: string): { wire: Record<string, string>; order: LopOrder } {
  const extension = EXAMPLE_EXT.replaceAll(CURRENT_GETTER, getter) as `0x${string}`;
  return buildOrder(extension);
}

/** The same order with the getter substituted on the TAKING side ONLY — the side that decides
 *  what the taker pays. A decoder that checks the equality invariant first would call this
 *  "not a Fusion order" and fall through to a plain fill. */
function orderWithTakingGetter(getter: string): { wire: Record<string, string>; order: LopOrder } {
  const fields = decodeExtensionFields(EXAMPLE_EXT);
  const takingAmountData = `0x${getter}${fields.takingAmountData.slice(42)}` as `0x${string}`;
  return buildOrder(encodeExtensionFields({ ...fields, takingAmountData }));
}

function buildOrder(extension: `0x${string}`): { wire: Record<string, string>; order: LopOrder } {
  // OrderLib: salt.low160 must equal keccak256(extension).low160, and HAS_EXTENSION must be set.
  const salt = (1n << 200n) | (BigInt(keccak256(extension)) & ((1n << 160n) - 1n));
  const order: LopOrder = {
    salt,
    maker: maker.address,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
    makingAmount: 10n ** 18n,
    takingAmount: 1_000_000n,
    makerTraits: 1n << 249n,
  };
  return {
    order,
    wire: {
      salt: salt.toString(),
      maker: order.maker,
      receiver: order.receiver,
      makerAsset: order.makerAsset,
      takerAsset: order.takerAsset,
      makingAmount: order.makingAmount.toString(),
      takingAmount: order.takingAmount.toString(),
      makerTraits: order.makerTraits.toString(),
      extension,
    },
  };
}

/** A live bit-invalidator so the fill's liveness pre-flight passes and the auction leg is reached. */
const liveChain = stubRpc((c) => {
  if (c.functionName === "bitInvalidatorForOrder") return 0n;
  throw new Error(`no stub for ${c.functionName}`);
});

async function takerFill(getterOrder: { wire: Record<string, string>; order: LopOrder }, over: Record<string, unknown> = {}) {
  const extension = getterOrder.wire.extension as `0x${string}`;
  const { extension: _drop, ...orderWire } = getterOrder.wire;
  const orderHash = hashLopOrder(42161, LOP, getterOrder.order);
  return runTool(
    "cork_prepare_orders",
    {
      chainId: 42161,
      account: ACCOUNT,
      clientRequestId: "fusion-trust-0001",
      action: { type: "taker-fill", orderHash, signedOrder: { order: orderWire, signature: await maker.sign({ hash: orderHash }), extension }, ...over },
      format: "concise",
    },
    { nowSeconds: NOW, venueFetch: async () => { throw new Error("venue must not be contacted"); }, resolveRpc: liveChain },
  );
}

describe("decodeFusionOrder classifies the TAKING-side getter before the equality invariant", () => {
  it("an unknown or legacy TAKING getter throws with its classification — never degrades to 'not a Fusion order'", () => {
    for (const [getter, classification] of [[UNKNOWN_GETTER, "unknown"], [LEGACY_GETTER, "legacy"]] as const) {
      const { order, wire } = orderWithTakingGetter(getter);
      try {
        decodeFusionOrder(order, wire.extension as `0x${string}`, 42161);
        throw new Error("expected a refusal");
      } catch (err) {
        expect(err).toBeInstanceOf(NotAFusionOrder);
        const e = err as NotAFusionOrder;
        expect(e.classification).toBe(classification);
        expect(e.settlement?.toLowerCase()).toBe(`0x${getter}`);
        // Not the equality message: the classification ran first, which is the whole point.
        expect(e.message).not.toMatch(/differs from makingAmountData/);
      }
    }
  });

  it("a plain non-auction extension still decodes as 'not a Fusion order', with NO classification", () => {
    const { order } = buildOrder("0x");
    try {
      decodeFusionOrder(order, "0x", 42161);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(NotAFusionOrder);
      expect((err as NotAFusionOrder).classification).toBeUndefined();
      expect((err as NotAFusionOrder).settlement).toBeUndefined();
    }
  });
});

describe("cork_compute dutch-auction-price", () => {
  it.each([
    [UNKNOWN_GETTER, "unknown", "settler_not_recognized"],
    [LEGACY_GETTER, "legacy", "phase_gated"],
  ])("refuses to price a %s getter, reporting the classification", async (getter, classification, code) => {
    const { wire } = orderWithGetter(getter);
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "dutch-auction-price", order: wire }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings.map((w) => w.code)).toContain(code);
    expect(env.data).toMatchObject({ classification, settlement: `0x${getter}` });
    expect(env.data).not.toHaveProperty("price");
    expect(env.data).not.toHaveProperty("auction");
  });

  it("the recognized getter still prices", async () => {
    const { wire } = orderWithGetter(CURRENT_GETTER);
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "dutch-auction-price", order: wire }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    expect(env.data).toHaveProperty("price");
  });
});

describe("cork_prepare_orders taker-fill", () => {
  it("refuses the AUTOMATIC cap on an unrecognized getter — no bytes, and the message names the way forward", async () => {
    const env = await takerFill(orderWithGetter(UNKNOWN_GETTER));
    expect(env.state).toBe("unavailable");
    expect(env.warnings.map((w) => w.code)).toContain("settler_not_recognized");
    expect(env.warnings[0]!.message).toMatch(/explicit maximumTakingAmount/);
    expect(env.data).toMatchObject({ classification: "unknown" });
    expect(env.data).not.toHaveProperty("calldata");
  });

  it("an EXPLICIT maximumTakingAmount builds and warns — the LOP enforces that cap on-chain", async () => {
    const env = await takerFill(orderWithGetter(UNKNOWN_GETTER), { maximumTakingAmount: "1200000" });
    expect(env.state).toBe("ok");
    const d = env.data as { calldata: string; auction?: unknown };
    expect(d.calldata.startsWith("0x")).toBe(true);
    expect(d.auction).toBeUndefined(); // nothing was derived from the unreadable curve
    const w = env.warnings.find((x) => x.code === "settler_not_recognized")!;
    expect(w.message).toMatch(/was NOT derived here/);
  });

  it("a legacy getter behaves the same way, under phase_gated", async () => {
    const refused = await takerFill(orderWithGetter(LEGACY_GETTER));
    expect(refused.state).toBe("unavailable");
    expect(refused.warnings.map((x) => x.code)).toContain("phase_gated");
    const built = await takerFill(orderWithGetter(LEGACY_GETTER), { maximumTakingAmount: "1200000" });
    expect(built.state).toBe("ok");
    expect(built.warnings.map((x) => x.code)).toContain("phase_gated");
  });

  it("the recognized getter still derives its ceiling cap and reports the curve", async () => {
    const env = await takerFill(orderWithGetter(CURRENT_GETTER));
    expect(env.state).toBe("ok");
    const d = env.data as { auction: { classification?: string; currentTakerPays: string } };
    expect(d.auction).toBeDefined();
    expect(BigInt(d.auction.currentTakerPays) > 0n).toBe(true);
    expect(env.warnings.map((x) => x.code)).toContain("decaying_price_notice");
  });

  it("an order whose TAKING getter alone is unrecognized is refused too — it is the side that charges the taker", async () => {
    const env = await takerFill(orderWithTakingGetter(UNKNOWN_GETTER));
    expect(env.state).toBe("unavailable");
    expect(env.warnings.map((x) => x.code)).toContain("settler_not_recognized");
    expect(env.data).not.toHaveProperty("calldata");
  });
});
