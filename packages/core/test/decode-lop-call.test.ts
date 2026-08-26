// cork_decode on 1inch LOP v4 fill/cancel calldata (COR-174). The tool builds these bytes itself
// (taker-fill, cancel), so its own validate-before-broadcast decode must label them — the
// rehearsal of 2026-08-20 found both called UNREADABLE, which under the signing rules means
// "do not sign". The fixture is REAL output from that rehearsal: a JIT maker order (sell 0.3 cST
// for 750 USDC units, enableJitMint, one embedded ERC-2612 permit), its EOA signature, the
// fillOrderArgs calldata built for it, and a cancelOrder calldata. Nothing here is mocked: the
// decoder is driven with those bytes, with bytes buildTakerFill/buildCancelOrder produce in-test,
// and with a signed transaction carrying them.
import { beforeAll, describe, expect, it } from "vitest";
import { parseSignature, signatureToCompactSignature } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildCancelOrder,
  buildMakerOrder,
  buildTakerFill,
  decodeLopCall,
  decodeTakerTraits,
  encodeMulticall,
  hashLopOrder,
  LOP_ADDRESSES,
  lopInvalidatorPlan,
  runTool,
  splitTakerArgs,
  ToolInputError,
  type LopOrder,
} from "@cork/core";
import fixture from "./fixtures/rehearsal-lop-calls.json" with { type: "json" };
import corkDefaults from "../../../cork-defaults.json" with { type: "json" };

const BUNDLER3_8453 = (corkDefaults.deployments as Record<string, { bundler3?: string }>)["8453"]!.bundler3! as `0x${string}`;

const LOP = LOP_ADDRESSES[8453]!;
const NOW = 1_790_000_000n;
const lc = (s: string) => s.toLowerCase();
type Hex = `0x${string}`;

/** The fixture's order record (decimal strings on the wire) as a LopOrder. */
const fixtureOrder = (): LopOrder => {
  const o = fixture.jitOrder.order;
  return {
    salt: BigInt(o.salt),
    maker: o.maker as Hex,
    receiver: o.receiver as Hex,
    makerAsset: o.makerAsset as Hex,
    takerAsset: o.takerAsset as Hex,
    makingAmount: BigInt(o.makingAmount),
    takingAmount: BigInt(o.takingAmount),
    makerTraits: BigInt(o.makerTraits),
  };
};

const decode = (input: Record<string, unknown>) => runTool("cork_decode", { format: "concise", ...input }, { nowSeconds: NOW });

describe("decodeLopCall — the rehearsal's real fill and cancel bytes", () => {
  it("fillOrderArgs: recovers the signed order, the amount, the traits, the compact signature, and the JIT extension", () => {
    const d = decodeLopCall(fixture.fill.calldata as Hex);
    expect(d.fn).toBe("fillOrderArgs");
    if (d.fn === "cancelOrder") throw new Error("unreachable");
    const expected = fixtureOrder();
    expect({ ...d.order, maker: lc(d.order.maker), makerAsset: lc(d.order.makerAsset), takerAsset: lc(d.order.takerAsset), receiver: lc(d.order.receiver) })
      .toEqual({ ...expected, maker: lc(expected.maker), makerAsset: lc(expected.makerAsset), takerAsset: lc(expected.takerAsset), receiver: lc(expected.receiver) });
    // A full fill: amount = makingAmount, denominated in the maker asset, capped at the signed taking amount.
    expect(d.amount).toBe(BigInt(fixture.fill.requiredMakingAmount));
    expect(d.takerTraits.amountIsMakerAsset).toBe(true);
    expect(d.takerTraits.threshold).toBe(BigInt(fixture.fill.requiredTakingAmount));
    expect(d.takerTraits.raw).toBe(BigInt(fixture.fill.takerTraits));
    // The maker's signature rides as (r, vs) — the compact form of the fixture's 65-byte signature.
    const compact = signatureToCompactSignature(parseSignature(fixture.jitOrder.signature as Hex));
    expect(d.signature).toEqual({ r: compact.r, vs: compact.yParityAndS });
    // args = the extension verbatim (no receiver, no taker interaction on a maker-side JIT fill).
    expect(d.args.receiver).toBeUndefined();
    expect(d.args.interaction).toBeUndefined();
    expect(lc(d.args.extension!)).toBe(lc(fixture.jitOrder.extension));
  });

  it("the decoded order hashes to the orderHash the prepare reported, under the chain-8453 LOP domain", () => {
    const d = decodeLopCall(fixture.fill.calldata as Hex);
    if (d.fn === "cancelOrder") throw new Error("unreachable");
    expect(lc(hashLopOrder(8453, LOP, d.order))).toBe(lc(fixture.jitOrder.orderHash));
  });

  it("cancelOrder: makerTraits and orderHash verbatim", () => {
    const d = decodeLopCall(fixture.cancel.calldata as Hex);
    expect(d).toEqual({ fn: "cancelOrder", makerTraits: BigInt(fixture.cancel.makerTraits), orderHash: fixture.cancel.orderHash });
  });

  it("decodeTakerTraits is the bit-exact inverse of what buildTakerFill packed", () => {
    const t = decodeTakerTraits(BigInt(fixture.fill.takerTraits));
    expect(t).toEqual({
      amountIsMakerAsset: true,
      unwrapWeth: false,
      skipMakerPermit: false,
      usePermit2: false,
      argsHasReceiver: false,
      extensionLength: (fixture.jitOrder.extension.length - 2) / 2,
      interactionLength: 0,
      threshold: BigInt(fixture.fill.requiredTakingAmount),
    });
  });
});

describe("decodeLopCall — every builder output round-trips", () => {
  const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // throwaway (Anvil #1)
  const TAKER = "0x00000000000000000000000000000000000000aa" as const;
  let order: LopOrder;
  let signature: Hex;
  beforeAll(async () => {
    order = buildMakerOrder({
      chainId: 1,
      lop: LOP_ADDRESSES[1]!,
      maker: maker.address,
      makerAsset: "0x00000000000000000000000000000000000000c5",
      takerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      makingAmount: 10n ** 18n,
      takingAmount: 5n * 10n ** 16n,
      clientRequestId: "decode-lop-0001",
    }).order;
    signature = await maker.sign({ hash: hashLopOrder(1, LOP_ADDRESSES[1]!, order) });
  });

  it("fillOrder (EOA, no args): amount, traits, and an empty args split", () => {
    const f = buildTakerFill({ order, signature, taker: TAKER });
    expect(f.functionName).toBe("fillOrder");
    const d = decodeLopCall(f.calldata);
    if (d.fn === "cancelOrder") throw new Error("unreachable");
    expect(d.fn).toBe("fillOrder");
    expect(d.order).toEqual(order);
    expect(d.amount).toBe(order.makingAmount);
    expect(d.takerTraits.threshold).toBe(order.takingAmount);
    expect(d.args).toEqual({});
  });

  it("fillOrderArgs with an explicit receiver: the 20-byte prefix is split off before the extension", () => {
    const receiver = "0x00000000000000000000000000000000000000ee" as const;
    const extension = `0x${"cd".repeat(40)}` as const;
    const f = buildTakerFill({ order, signature, taker: TAKER, receiver, extension });
    const d = decodeLopCall(f.calldata);
    if (d.fn === "cancelOrder") throw new Error("unreachable");
    expect(d.fn).toBe("fillOrderArgs");
    expect(d.takerTraits.argsHasReceiver).toBe(true);
    expect(lc(d.args.receiver!)).toBe(receiver);
    expect(d.args.extension).toBe(extension);
    expect(d.args.interaction).toBeUndefined();
  });

  it("fillContractOrderArgs (ERC-1271 maker): signature bytes, and the amount/traits read from the contract-fill positions", () => {
    const extension = `0x${"ab".repeat(8)}` as const;
    const interaction = `0x${"11".repeat(20)}${"22".repeat(4)}` as const;
    const f = buildTakerFill({ order, signature, makerAccountType: "ERC1271", taker: TAKER, extension, interaction, fillMakingAmount: 10n ** 18n, maximumTakingAmount: 7n * 10n ** 16n });
    const d = decodeLopCall(f.calldata);
    if (d.fn === "cancelOrder") throw new Error("unreachable");
    expect(d.fn).toBe("fillContractOrderArgs");
    expect(d.signature).toEqual({ bytes: signature });
    expect(d.amount).toBe(10n ** 18n);
    expect(d.takerTraits.threshold).toBe(7n * 10n ** 16n);
    expect(d.takerTraits.raw).toBe(BigInt(f.takerTraits));
    expect(d.args).toEqual({ extension, interaction });
  });

  it("cancelOrder round-trips", () => {
    const hash = hashLopOrder(1, LOP_ADDRESSES[1]!, order);
    expect(decodeLopCall(buildCancelOrder(order.makerTraits, hash).data)).toEqual({ fn: "cancelOrder", makerTraits: order.makerTraits, orderHash: hash });
  });

  it("splitTakerArgs refuses args shorter than the traits announce, naming the missing part", () => {
    const t = decodeTakerTraits((1n << 251n) | (4n << 224n)); // receiver + 4-byte extension
    expect(() => splitTakerArgs(t, `0x${"00".repeat(22)}`)).toThrow(/4-byte extension/);
    expect(() => splitTakerArgs(t, "0x")).toThrow(/20-byte receiver/);
    expect(splitTakerArgs(t, `0x${"ee".repeat(20)}${"ab".repeat(4)}`)).toEqual({ receiver: `0x${"ee".repeat(20)}`, extension: `0x${"ab".repeat(4)}` });
  });

  it("an unknown selector is refused (the caller degrades it to an unreadable leg)", () => {
    expect(() => decodeLopCall("0xdeadbeef")).toThrow();
  });
});

describe("cork_decode kind:calldata / kind:tx — 1inch legs label, with the same JIT label as kind:order", () => {
  it("calldata: the rehearsal fill labels with orderHash, maker traits, and the carried JIT market; the summary names the trade", async () => {
    const env = await decode({ kind: "calldata", chainId: 8453, data: fixture.fill.calldata });
    expect(env.state).toBe("ok");
    const d = env.data as { summary: string[]; legs: Array<Record<string, unknown>> };
    expect(d.legs).toHaveLength(1);
    const leg = d.legs[0]! as { kind: string; call: { fn: string }; label: { orderHash: string; makerTraits: { nonce: string; allowPartialFills: boolean }; jit?: Record<string, unknown> } };
    expect(leg.kind).toBe("lop");
    expect(leg.call.fn).toBe("fillOrderArgs");
    expect(lc(leg.label.orderHash)).toBe(lc(fixture.jitOrder.orderHash));
    expect(leg.label.makerTraits.nonce).toBe(fixture.jitOrder.nonce); // bigints cross the envelope as decimal strings
    expect(leg.label.makerTraits.allowPartialFills).toBe(false);
    // The JIT label is the one kind:"order" gives the resting order — adapter, recipe, mint flag, permit count, constraint.
    expect(leg.label.jit).toBeDefined();
    expect(lc(String(leg.label.jit!.adapter))).toBe("0x8902a88912a334263fe3d731d03c267715b9374f");
    expect(leg.label.jit!.enableJitMint).toBe(true);
    expect(leg.label.jit!.permits).toBe(1);
    expect((leg.label.jit!.constraint as { rateMax: string }).rateMax).toBe(fixture.jitOrder.constraint.rateMax);
    expect(d.summary).toHaveLength(1);
    const line = d.summary[0]!;
    // Raw calldata names no target contract, so the leg is labeled by shape and SAID to be
    // unverified — the same bytes decoded as a signed tx to the LOP read as trusted (below).
    expect(line).toMatch(/^1\. UNVERIFIED target: fill 1inch limit order 0x/);
    expect(line).toContain(`take ${fixture.fill.requiredMakingAmount} of`);
    expect(line).toContain(`paying at most ${fixture.fill.requiredTakingAmount} of`);
    expect(line).toMatch(/Cork just-in-time market via adapter 0x8902…374f/);
    expect(line).toMatch(/mints the cST from the maker's collateral, 1 embedded permit\]/);
    expect(line).not.toMatch(/UNREADABLE/);
    expect(env.warnings.map((w) => w.code)).toEqual(["target_unverified"]);
    expect(env.warnings[0]!.message).toMatch(/Raw calldata names no target contract/);
  });

  it("calldata without chainId: the orderHash defaults to the mainnet domain and says so (chainid_defaulted)", async () => {
    const env = await decode({ kind: "calldata", data: fixture.fill.calldata });
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "chainid_defaulted")).toBe(true);
    const leg = (env.data as { legs: Array<{ label: { orderHash: string } }> }).legs[0]!;
    expect(lc(leg.label.orderHash)).not.toBe(lc(fixture.jitOrder.orderHash)); // chain-specific hash, different domain
  });

  it("calldata: the cancel labels with its orderHash and the invalidator it touches", async () => {
    const env = await decode({ kind: "calldata", chainId: 8453, data: fixture.cancel.calldata });
    expect(env.state).toBe("ok");
    const d = env.data as { summary: string[]; legs: Array<{ kind: string; call: { fn: string }; label: { orderHash: string; makerTraits: { nonce: string } } }> };
    expect(d.legs[0]!.kind).toBe("lop");
    expect(d.legs[0]!.call.fn).toBe("cancelOrder");
    expect(d.legs[0]!.label.orderHash).toBe(fixture.cancel.orderHash);
    expect(d.legs[0]!.label.makerTraits.nonce).toBe(fixture.cancel.nonce);
    const plan = lopInvalidatorPlan(BigInt(fixture.cancel.makerTraits));
    expect(plan.mode).toBe("bit");
    expect(d.summary[0]).toMatch(/^1\. UNVERIFIED target: cancel 1inch limit order 0x/);
    expect(d.summary[0]).toContain(`bit invalidator (nonce ${fixture.cancel.nonce})`);
  });

  it("calldata: a fill NESTED in a Bundler3 multicall (a reenter bundle, a router wrap) is labeled the same as a bare one", async () => {
    // The label walker must recurse: a bundle that forwards a LOP fill one level down would
    // otherwise carry an unlabeled lop leg — no orderHash, no JIT label — and a signer reading
    // the summary would not see the just-in-time market the fill creates.
    const lop = LOP_ADDRESSES[8453]!;
    const wrapped = encodeMulticall([
      { to: lop, data: fixture.fill.calldata as `0x${string}`, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` },
      { to: lop, data: fixture.cancel.calldata as `0x${string}`, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` },
    ]);
    const outer = encodeMulticall([{ to: BUNDLER3_8453, data: wrapped, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` }]);
    const env = await decode({ kind: "calldata", chainId: 8453, data: outer });
    expect(env.state).toBe("ok");
    // Inner targets are verifiable (a multicall's legs name their contracts): the reenter
    // bundle targets the chain's Bundler3 and the fills its LOP, so every leg is trusted.
    expect(env.warnings.filter((w) => w.code === "target_unverified" || w.code === "target_mismatch")).toEqual([]);
    type Leg = { kind: string; legs?: Leg[]; label?: { orderHash: string | null; jit?: { adapter: string } } };
    const d = env.data as { summary: string[]; legs: Leg[] };
    const inner = d.legs[0]!.legs!;
    expect(inner.map((l) => l.kind)).toEqual(["lop", "lop"]);
    expect(lc(inner[0]!.label!.orderHash!)).toBe(lc(fixture.jitOrder.orderHash));
    expect(inner[0]!.label!.jit!.adapter).toMatch(/^0x8902/i); // the JIT label rode along (0.3.3 adapter 0x8902…374f)
    expect(inner[1]!.label!.orderHash).toBe(fixture.cancel.orderHash);
    expect(d.summary.filter((l) => /fill 1inch limit order 0x/.test(l))).toHaveLength(1);
    expect(d.summary.filter((l) => /cancel 1inch limit order 0x/.test(l))).toHaveLength(1);
    expect(d.summary.some((l) => /UNREADABLE|UNVERIFIED|MISMATCH/.test(l))).toBe(false);
  });

  it("calldata: a fill wrapped by a multicall at an address that is NOT the chain's Bundler3 is a target mismatch — labeled, and a conflict", async () => {
    // The `multicall(Call[])` selector proves a shape, not the executor. A router that speaks
    // Bundler3's ABI would run these legs under a different msg.sender, so the label the
    // signer reads ("a nested bundle") would be a lie about who executes it.
    const lop = LOP_ADDRESSES[8453]!;
    const wrapped = encodeMulticall([{ to: lop, data: fixture.fill.calldata as `0x${string}`, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` }]);
    const router = "0x00000000000000000000000000000000000000b3";
    const outer = encodeMulticall([{ to: router, data: wrapped, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` }]);
    const env = await decode({ kind: "calldata", chainId: 8453, data: outer });
    expect(env.state).toBe("conflict");
    const mismatch = env.warnings.filter((w) => w.code === "target_mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]!.message).toContain(router);
    expect(mismatch[0]!.message.toLowerCase()).toContain(BUNDLER3_8453.toLowerCase());
    type Leg = { kind: string; verification: string; expectedTarget?: string; legs?: Leg[]; label?: { orderHash: string | null } };
    const d = env.data as { summary: string[]; legs: Leg[] };
    expect(d.legs[0]!.verification).toBe("mismatch");
    expect(d.legs[0]!.expectedTarget!.toLowerCase()).toBe(BUNDLER3_8453.toLowerCase());
    // The inner fill still labels (the walker recursed) and is itself trusted: it targets the LOP.
    expect(d.legs[0]!.legs![0]!.verification).toBe("trusted");
    expect(lc(d.legs[0]!.legs![0]!.label!.orderHash!)).toBe(lc(fixture.jitOrder.orderHash));
    expect(d.summary[0]).toMatch(/^1\. TARGET MISMATCH/);
  });

  it("calldata that is neither a bundle nor a recognized call is invalid input that names the selector", async () => {
    await expect(decode({ kind: "calldata", chainId: 8453, data: "0xdeadbeef00" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(decode({ kind: "calldata", chainId: 8453, data: "0xdeadbeef00" })).rejects.toMatchObject({ issues: [{ path: ["data"], message: expect.stringMatching(/selector 0xdeadbeef/) }] });
  });

  it("tx: a signed fill to the LOP names the target, labels the leg, and raises no unknown_target", async () => {
    const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 3, to: LOP, value: 0n, data: fixture.fill.calldata as Hex, gas: 2_184_439n, maxFeePerGas: 11_000_000n, maxPriorityFeePerGas: 1_000_000n });
    const env = await decode({ kind: "tx", chainId: 8453, data: raw });
    expect(env.state).toBe("ok");
    const d = env.data as { signer: string; to: string; toLabel: string | null; summary: string[]; legs: Array<{ kind: string; label: { orderHash: string } }> };
    expect(lc(d.signer)).toBe(lc(signer.address));
    expect(d.toLabel).toBe("1inch LOP v4");
    expect(d.legs[0]!.kind).toBe("lop");
    expect(lc(d.legs[0]!.label.orderHash)).toBe(lc(fixture.jitOrder.orderHash));
    expect(d.summary[0]).toMatch(/fill 1inch limit order/);
    expect(d.summary[0]).not.toMatch(/UNREADABLE/);
    expect(env.warnings.some((w) => w.code === "unknown_target")).toBe(false);
  });

  it("tx: a truncated fill body degrades to an UNREADABLE leg that names fillOrderArgs — never a throw that hides the tx", async () => {
    const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const truncated = fixture.fill.calldata.slice(0, 200) as Hex;
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 4, to: LOP, value: 0n, data: truncated, gas: 100_000n, maxFeePerGas: 11_000_000n, maxPriorityFeePerGas: 1_000_000n });
    const env = await decode({ kind: "tx", chainId: 8453, data: raw });
    expect(env.state).toBe("ok");
    const d = env.data as { summary: string[]; legs: Array<{ kind: string; note?: string }> };
    expect(d.legs[0]!.kind).toBe("unknown");
    expect(d.legs[0]!.note).toMatch(/selector matches fillOrderArgs but the body failed to decode/);
    expect(d.summary[0]).toMatch(/UNREADABLE/);
  });

  it("a fill nested inside a Bundler3 multicall still gets its label", async () => {
    const multicall = encodeMulticall([{ to: LOP, data: fixture.fill.calldata as Hex, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` }]);
    const env = await decode({ kind: "calldata", chainId: 8453, data: multicall });
    expect(env.state).toBe("ok");
    const d = env.data as { summary: string[]; legs: Array<{ kind: string; label?: { orderHash: string } }> };
    expect(d.legs[0]!.kind).toBe("lop");
    expect(lc(d.legs[0]!.label!.orderHash)).toBe(lc(fixture.jitOrder.orderHash));
    expect(d.summary[0]).toMatch(/fill 1inch limit order 0x/);
  });
});
