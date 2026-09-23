// A venue row's extension names every contract the LOP will CALL inside the taker's fill
// (owner requirement 2026-09-23: the user must be safe when the venue returns an order whose
// extension addresses match no known generation). Three consumers, one classifier:
//   taker-fill REFUSES a row with an unknown pre/post-interaction hook (no bytes, raw AND forSelf);
//   the ranked book EXCLUDES it as `foreign-hook` (never dropped — the venue served it; disclosed);
//   decode LABELS every target and lists the foreign ones.
// The getter rule of 2026-08-26 is preserved and pinned beside it: an unknown GETTER refuses only
// the DERIVED cap, because the LOP enforces an explicit cap on-chain; a HOOK has no such bound.
// Fixtures derive from the canonical auction example (TOOL_EXAMPLES), never a hand-copied blob.
import { describe, expect, it } from "vitest";
import { getAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TOOL_EXAMPLES } from "@cork/schemas";
import { BUNDLED_DEFAULTS, decodeExtensionFields, encodeExtensionFields, FUSION_SETTLEMENTS, generationsOf, hashLopOrder, LOP_ADDRESSES, type LopOrder, rankBookRows, runTool } from "@cork/core";
import { extensionTargets, foreignExtensionTargets } from "../src/extension-targets.ts";
import { stubResolved } from "./helpers.ts";

const CHAIN = 42161;
const NOW = 1_753_000_000n;
const LOP = LOP_ADDRESSES[CHAIN]!;
const GENS = generationsOf(BUNDLED_DEFAULTS, CHAIN);
const CURRENT_GETTER = FUSION_SETTLEMENTS[CHAIN]!.current;
const JIT_ADAPTER = GENS.find((g) => g.primary)!.marketRegistry!.adapter as `0x${string}`;
const POOL_MANAGER = GENS.find((g) => g.primary)!.phoenix!.poolManager as `0x${string}`;
// Checksummed on purpose: the classifier returns canonical checksum spellings whatever case the
// venue used, and the assertions compare against that canonical form.
const STRANGER = getAddress("0xbad0000000000000000000000000000000000bad");
const maker = privateKeyToAccount(keccak256(new TextEncoder().encode("foreign-hook-maker") as unknown as `0x${string}`));

const EXAMPLE_EXT = (TOOL_EXAMPLES.cork_compute!.find((e) => (e.input as { params?: { kind?: string } }).params?.kind === "dutch-auction-price")!.input as { params: { order: { extension: `0x${string}` } } }).params.order.extension;

/** The canonical auction extension with one hook slot pointed at `target` (target ++ 4 bytes of payload). */
function withHook(slot: "preInteractionData" | "postInteractionData", target: `0x${string}`): `0x${string}` {
  const f = decodeExtensionFields(EXAMPLE_EXT);
  return encodeExtensionFields({ ...f, [slot]: `${target}deadbeef` as `0x${string}` });
}

/** A signed-shaped order bound to its extension (OrderLib: salt.low160 = keccak(extension).low160, HAS_EXTENSION set). */
function orderFor(extension: `0x${string}`): { order: LopOrder; wire: Record<string, string>; orderHash: `0x${string}` } {
  const salt = (1n << 200n) | (BigInt(keccak256(extension)) & ((1n << 160n) - 1n));
  const makerTraits = (1n << 249n) | (1n << 255n); // HAS_EXTENSION | NO_PARTIAL_FILLS-free bit-invalidator shape used by Cork-built orders
  const order: LopOrder = {
    salt,
    maker: maker.address,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
    makingAmount: 10n ** 18n,
    takingAmount: 1_000_000n,
    makerTraits,
  };
  const wire = Object.fromEntries(Object.entries(order).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : String(v)]));
  return { order, wire, orderHash: hashLopOrder(CHAIN, LOP, order) };
}

const liveChain = async () =>
  stubResolved({
    getBlockNumber: async () => 1_000n,
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "bitInvalidatorForOrder":
          return 0n;
        case "allowance":
          return 10n ** 30n;
        case "balanceOf":
          return 10n ** 30n;
        case "decimals":
          return 18;
        default:
          return 0n;
      }
    },
    getCode: async () => "0x",
  });

describe("extensionTargets — every call target, classified", () => {
  it("the canonical auction example names ONLY the pinned Fusion settlement, on both getter slots — no hooks", () => {
    const t = extensionTargets(EXAMPLE_EXT, GENS, CHAIN);
    expect(t.map((x) => [x.slot, x.classification])).toEqual([["makingAmountGetter", "known"], ["takingAmountGetter", "known"]]);
    expect(t.every((x) => x.address.toLowerCase() === CURRENT_GETTER.toLowerCase())).toBe(true);
    expect(foreignExtensionTargets(t)).toEqual([]);
  });
  it("a configured JIT adapter as preInteraction is known (with its generation label); a STRANGER is unknown and foreign", () => {
    const known = extensionTargets(withHook("preInteractionData", JIT_ADAPTER), GENS, CHAIN);
    expect(known.find((x) => x.slot === "preInteraction")).toMatchObject({ classification: "known", as: expect.stringContaining("jitAdapter") });
    const strange = extensionTargets(withHook("postInteractionData", STRANGER), GENS, CHAIN);
    expect(strange.find((x) => x.slot === "postInteraction")).toMatchObject({ address: STRANGER, classification: "unknown" });
    expect(foreignExtensionTargets(strange).map((x) => x.slot)).toEqual(["postInteraction"]);
  });
  it("a Cork contract that is NOT a JIT adapter (the pool manager) in a hook slot is foreign — role-checked, not address-book membership", () => {
    const t = extensionTargets(withHook("preInteractionData", POOL_MANAGER), GENS, CHAIN);
    expect(foreignExtensionTargets(t).map((x) => x.address)).toEqual([POOL_MANAGER]);
  });
  it("an unknown GETTER is classified unknown but is NOT a foreign target (the 2026-08-26 explicit-cap rule owns getters)", () => {
    const f = decodeExtensionFields(EXAMPLE_EXT);
    const ext = encodeExtensionFields({ ...f, makingAmountData: `${STRANGER}${f.makingAmountData.slice(42)}` as `0x${string}`, takingAmountData: `${STRANGER}${f.takingAmountData.slice(42)}` as `0x${string}` });
    const t = extensionTargets(ext, GENS, CHAIN);
    expect(t.filter((x) => x.classification === "unknown").map((x) => x.slot)).toEqual(["makingAmountGetter", "takingAmountGetter"]);
    expect(foreignExtensionTargets(t)).toEqual([]);
  });
  it("a MIS-CASED stranger hook (a checksum-invalid spelling, as a venue may serve it) is still classified — bytes are bytes, the case is presentation", () => {
    const upper = `0x${STRANGER.slice(2).toUpperCase()}` as `0x${string}`; // uppercase hex is never a valid EIP-55 checksum for a mixed-digit address
    const t = extensionTargets(withHook("postInteractionData", upper), GENS, CHAIN);
    expect(foreignExtensionTargets(t).map((x) => x.address)).toEqual([STRANGER]); // canonical checksum out
  });
  it("an empty or unreadable extension names no target", () => {
    expect(extensionTargets("0x", GENS, CHAIN)).toEqual([]);
    expect(extensionTargets("0x1234", GENS, CHAIN)).toEqual([]);
  });
});

describe("taker-fill refuses a resting order whose hook targets code nobody here has read", () => {
  const fill = async (extension: `0x${string}`, over: Record<string, unknown> = {}) => {
    const { wire, orderHash } = orderFor(extension);
    return runTool(
      "cork_prepare_orders",
      { chainId: CHAIN, account: "0x00000000000000000000000000000000000000AA", clientRequestId: "foreign-hook-0001", format: "concise", action: { type: "taker-fill", orderHash, signedOrder: { order: wire, signature: await maker.sign({ hash: orderHash }), extension }, ...over } },
      { nowSeconds: NOW, resolveRpc: liveChain, venueFetch: async () => { throw new Error("venue must not be contacted"); } },
    );
  };
  it("a STRANGER postInteraction → unavailable foreign_extension_target, no calldata, the address and slot named — even WITH an explicit maximumTakingAmount (a cap bounds a getter, not a hook)", async () => {
    for (const over of [{}, { maximumTakingAmount: "2000000" }]) {
      const env = await fill(withHook("postInteractionData", STRANGER), over);
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe("foreign_extension_target");
      expect(env.warnings[0]?.message).toContain(STRANGER);
      expect(env.warnings[0]?.message).toContain("postInteraction");
      expect(env.data).not.toHaveProperty("calldata");
      expect((env.data as { foreign: unknown[] }).foreign).toHaveLength(1);
    }
  });
  it("a STRANGER preInteraction is refused the same way", async () => {
    const env = await fill(withHook("preInteractionData", STRANGER));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("foreign_extension_target");
  });
  it("the ForSelf WRAPPER path is refused the same way: the wrapper still hands the extension to the LOP, so the stranger hook would still run", async () => {
    const forSelfAdapter = GENS.find((g) => g.primary)!.forSelf!.adapter as `0x${string}`;
    const { wire, orderHash } = orderFor(withHook("postInteractionData", STRANGER));
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: CHAIN, account: "0x00000000000000000000000000000000000000AA", clientRequestId: "foreign-hook-0002", format: "concise", action: { type: "taker-fill", orderHash, signedOrder: { order: wire, signature: await maker.sign({ hash: orderHash }), extension: withHook("postInteractionData", STRANGER) }, forSelf: { adapter: forSelfAdapter, poolId: `0x${"11".repeat(32)}` } } },
      { nowSeconds: NOW, resolveRpc: liveChain, venueFetch: async () => { throw new Error("venue must not be contacted"); } },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings.map((w) => w.code)).toContain("foreign_extension_target");
    expect(env.data).not.toHaveProperty("calldata");
  });
  it("the pinned-getter auction example (no hooks) is NOT refused by this guard — the guard is about hooks", async () => {
    const env = await fill(EXAMPLE_EXT);
    expect(env.warnings.map((w) => w.code)).not.toContain("foreign_extension_target");
  });
});

describe("the ranked book excludes a foreign-hook row (served, disclosed, never ranked)", () => {
  const rowFor = async (extension: `0x${string}`) => {
    const { wire, orderHash } = orderFor(extension);
    return { orderHash, order: wire, extension, signature: await maker.sign({ hash: orderHash }), side: "SELL", status: "open", verification: "confirmed" } as Record<string, unknown>;
  };
  it("with generations given, a stranger-hook row lands in `excluded` as foreign-hook naming the address; a clean row ranks", async () => {
    const rows = [await rowFor(withHook("postInteractionData", STRANGER)), await rowFor(EXAMPLE_EXT)];
    const r = rankBookRows(rows, { chainId: CHAIN, lop: LOP, nowSeconds: NOW, generations: GENS });
    expect(r.items).toHaveLength(1);
    const ex = r.excluded.find((x) => x.exclusion === "foreign-hook");
    expect(ex).toBeDefined();
    expect(ex!.whyNotFillable).toContain(STRANGER);
    expect(ex!.whyNotFillable).toContain("taker-fill refuses");
  });
  it("without generations (offline caller) nothing is classified and the row ranks on price — the classification is a chain-config fact, never guessed", async () => {
    const rows = [await rowFor(withHook("postInteractionData", STRANGER))];
    const r = rankBookRows(rows, { chainId: CHAIN, lop: LOP, nowSeconds: NOW });
    expect(r.items).toHaveLength(1);
  });
});

describe("decode kind:order labels every call target and lists the foreign ones", () => {
  it("a stranger postInteraction shows in `targets` as unknown and in `foreignTargets`; the pinned getters show as known", async () => {
    const { wire, orderHash } = orderFor(withHook("postInteractionData", STRANGER));
    const env = await runTool("cork_decode", { kind: "order", chainId: CHAIN, data: { ...wire, extension: withHook("postInteractionData", STRANGER), orderHash }, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { targets?: Array<{ slot: string; classification: string; address: string }>; foreignTargets?: Array<{ address: string }> };
    expect(d.targets?.map((t) => [t.slot, t.classification])).toEqual([["makingAmountGetter", "known"], ["takingAmountGetter", "known"], ["postInteraction", "unknown"]]);
    expect(d.foreignTargets?.map((t) => t.address)).toEqual([STRANGER]);
  });
});
