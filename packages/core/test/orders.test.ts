import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, toFunctionSelector, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildCancelOrder, buildMakerOrder, buildMakerTraits, buildTakerFill, finalizeMakerOrder, hashLopOrder, LOP_ADDRESSES, type LopOrder } from "@cork/core";

const MAKER = "0x0000000000000000000000000000000000000abc" as const;
const MAKER_ASSET = "0x0000000000000000000000000000000000000001" as const;
const TAKER_ASSET = "0x0000000000000000000000000000000000000002" as const;
const TAKER = "0x00000000000000000000000000000000000000dd" as const;
// A syntactically valid 65-byte (r,s,v) secp256k1 signature; s is small so vs keeps yParity=0.
const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as const;
const baseOrder: LopOrder = { salt: 7n, maker: MAKER, receiver: zeroAddress, makerAsset: MAKER_ASSET, takerAsset: TAKER_ASSET, makingAmount: 100n, takingAmount: 200n, makerTraits: 0n };

describe("buildMakerTraits bit layout (MakerTraitsLib)", () => {
  it("sets NO_PARTIAL_FILLS only when partial fills disallowed", () => {
    expect(buildMakerTraits({ allowPartialFills: true, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 0n }) & (1n << 255n)).toBe(0n);
    expect(buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 0n }) & (1n << 255n)).toBe(1n << 255n);
  });
  it("sets USE_PERMIT2 at bit 248 and packs expiry at offset 80", () => {
    const t = buildMakerTraits({ allowPartialFills: true, allowMultipleFills: false, usePermit2: true, expiry: 1893456000n, nonce: 0n });
    expect(t & (1n << 248n)).toBe(1n << 248n);
    expect((t >> 80n) & ((1n << 40n) - 1n)).toBe(1893456000n);
  });
  it("sets ALLOW_MULTIPLE_FILLS only when multiple fills allowed", () => {
    expect(buildMakerTraits({ allowPartialFills: true, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: 0n }) & (1n << 254n)).toBe(0n);
    expect(buildMakerTraits({ allowPartialFills: true, allowMultipleFills: true, usePermit2: false, expiry: 0n, nonce: 0n }) & (1n << 254n)).toBe(1n << 254n);
  });
});

describe("buildMakerOrder", () => {
  const base = { chainId: 1 as const, lop: LOP_ADDRESSES[1]!, maker: MAKER, makerAsset: MAKER_ASSET, takerAsset: TAKER_ASSET, makingAmount: 100n, takingAmount: 200n };

  it("produces a bytes32 orderHash, deterministic per clientRequestId", () => {
    const a = buildMakerOrder({ ...base, clientRequestId: "req-abc-0001" });
    const b = buildMakerOrder({ ...base, clientRequestId: "req-abc-0001" });
    const c = buildMakerOrder({ ...base, clientRequestId: "req-abc-0002" });
    expect(a.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.orderHash).toBe(b.orderHash);
    expect(a.orderHash).not.toBe(c.orderHash); // salt derives from the idempotency key
    expect(a.order.salt < 1n << 160n).toBe(true); // no extension -> salt fits low 160 bits
    expect(a.domain.name).toBe("1inch Aggregation Router");
    expect(a.domain.version).toBe("6");
  });

  // Regression: a plain order must NOT carry any interaction flag; an order with a
  // preInteraction extension MUST set PRE_INTERACTION_CALL_FLAG (bit 252) or the LOP
  // fills it as a no-op and the JIT hook never runs (caught by the fork round-trip test).
  const PRE_INTERACTION_CALL_FLAG = 1n << 252n;
  const POST_INTERACTION_CALL_FLAG = 1n << 251n;
  const HAS_EXTENSION_FLAG = 1n << 249n;

  it("plain order sets no interaction flag", () => {
    const o = buildMakerOrder({ ...base, clientRequestId: "req-plain-0001" });
    expect(o.order.makerTraits & PRE_INTERACTION_CALL_FLAG).toBe(0n);
    expect(o.order.makerTraits & HAS_EXTENSION_FLAG).toBe(0n);
    expect(o.extension).toBe("0x");
  });

  it("preInteraction extension sets HAS_EXTENSION + PRE_INTERACTION_CALL_FLAG", () => {
    // A minimal ExtensionLib header whose only non-empty field is preInteractionData (field 6):
    // eight uint32 END offsets, field 6 = 4 (a 4-byte payload), field 7 = 4 (post empty).
    const end = 4n;
    const offsets = (end << (32n * 6n)) | (end << (32n * 7n));
    const extension = (`0x${offsets.toString(16).padStart(64, "0")}deadbeef`) as `0x${string}`;
    const o = buildMakerOrder({ ...base, clientRequestId: "req-ext-0001", extension });
    expect(o.order.makerTraits & HAS_EXTENSION_FLAG).not.toBe(0n);
    expect(o.order.makerTraits & PRE_INTERACTION_CALL_FLAG).not.toBe(0n);
    // A pre-only extension must NOT set the post flag (field 7 empty).
    expect(o.order.makerTraits & POST_INTERACTION_CALL_FLAG).toBe(0n);
    // salt low 160 bits are bound to keccak(extension); entropy in the top 96 bits.
    expect(o.order.salt >= 1n << 160n).toBe(true);
  });

  it("extension with both pre- and post-interaction sets both interaction flags", () => {
    // Header offsets: field 6 (pre) ends at 4, field 7 (post) ends at 8 -> each field is a
    // non-empty 4-byte span. extensionInteractionFlags must set PRE and POST both.
    const offsets = (4n << (32n * 6n)) | (8n << (32n * 7n));
    const extension = (`0x${offsets.toString(16).padStart(64, "0")}deadbeefcafebabe`) as `0x${string}`;
    const o = buildMakerOrder({ ...base, clientRequestId: "req-ext-0002", extension });
    expect(o.order.makerTraits & HAS_EXTENSION_FLAG).not.toBe(0n);
    expect(o.order.makerTraits & PRE_INTERACTION_CALL_FLAG).not.toBe(0n);
    expect(o.order.makerTraits & POST_INTERACTION_CALL_FLAG).not.toBe(0n);
  });

  it("an extension with data but EMPTY interaction fields sets NEITHER interaction flag (boundary: equal cumulative offsets mean empty)", () => {
    // Field 0 holds 4 bytes; every later field is EMPTY, so ALL eight cumulative END offsets are
    // 4 — off(6) == off(5) must read as "no preInteraction". A >= comparison here would set the
    // PRE flag and make OrderMixin call an interaction target parsed from an empty span.
    let offsets = 0n;
    for (let k = 0n; k < 8n; k++) offsets |= 4n << (32n * k);
    const extension = (`0x${offsets.toString(16).padStart(64, "0")}deadbeef`) as `0x${string}`;
    const o = buildMakerOrder({ ...base, clientRequestId: "req-ext-0003", extension });
    expect(o.order.makerTraits & HAS_EXTENSION_FLAG).not.toBe(0n);
    expect(o.order.makerTraits & PRE_INTERACTION_CALL_FLAG).toBe(0n);
    expect(o.order.makerTraits & POST_INTERACTION_CALL_FLAG).toBe(0n);
  });

  it("rejects an extension whose offsets header is NOT monotonically non-decreasing", () => {
    // field 6 ends at 8 but field 7 ends at 4 (< 8): a decreasing cumulative offset is a malformed
    // 1inch v4 extension that signs fine and only misparses/reverts at fill — refuse at bind time.
    const offsets = (8n << (32n * 6n)) | (4n << (32n * 7n));
    const extension = (`0x${offsets.toString(16).padStart(64, "0")}deadbeefcafebabe`) as `0x${string}`;
    expect(() => buildMakerOrder({ ...base, clientRequestId: "req-ext-badmono", extension })).toThrow(/monotonically non-decreasing/);
  });
});

describe("buildTakerFill (canonical 1inch v6 uint256-tuple selector)", () => {
  const UINT8 = "(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)";

  it("plain order (no extension) → fillOrder with selector 0x9fda64bd", () => {
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER });
    expect(fill.functionName).toBe("fillOrder");
    // The selector is the uint256-tuple form, NOT the address-tuple form (which the router rejects).
    expect(fill.calldata.slice(0, 10)).toBe("0x9fda64bd");
    expect(fill.calldata.slice(0, 10)).toBe(toFunctionSelector(`fillOrder(${UINT8},bytes32,bytes32,uint256,uint256)`));
  });

  it("extension order → fillOrderArgs with selector 0xf497df75, extension carried in args", () => {
    const extension = `0x${"ab".repeat(20)}` as const; // 20-byte payload
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER, extension });
    expect(fill.functionName).toBe("fillOrderArgs");
    expect(fill.calldata.slice(0, 10)).toBe("0xf497df75");
    expect(fill.calldata.slice(0, 10)).toBe(toFunctionSelector(`fillOrderArgs(${UINT8},bytes32,bytes32,uint256,uint256,bytes)`));
    // The args tail is exactly the extension, and takerTraits encodes its length at bit offset 224.
    const { args } = decodeFunctionData({ abi: parseAbi([`function fillOrderArgs(${UINT8} o, bytes32 r, bytes32 vs, uint256 a, uint256 t, bytes args)`]), data: fill.calldata });
    expect(args[5]).toBe(extension);
    expect((BigInt(fill.takerTraits) >> 224n) & 0xffffffn).toBe(20n);
  });

  it("taker interaction rides in args AFTER the extension, length at bits 200-223 (OrderMixin._parseArgs order — the walkthrough's canonical settle path)", () => {
    // Lifting a BUY-cover order: the taker delivers a not-yet-minted cST by packing the JIT
    // adapter as a taker interaction — invoked after the maker asset moves, before the taker
    // asset is pulled. args = extension ++ interaction; two independent length fields.
    const extension = `0x${"ab".repeat(20)}` as const;
    const interaction = `0x${"cd".repeat(52)}` as const; // adapter (20B) ++ 32B payload stand-in
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER, extension, interaction });
    expect(fill.functionName).toBe("fillOrderArgs");
    const { args } = decodeFunctionData({ abi: parseAbi([`function fillOrderArgs(${UINT8} o, bytes32 r, bytes32 vs, uint256 a, uint256 t, bytes args)`]), data: fill.calldata });
    expect(args[5]).toBe(`0x${"ab".repeat(20)}${"cd".repeat(52)}`);
    const traits = BigInt(fill.takerTraits);
    expect((traits >> 224n) & 0xffffffn).toBe(20n); // extension length
    expect((traits >> 200n) & 0xffffffn).toBe(52n); // interaction length
  });

  it("interaction alone (no extension) still routes through fillOrderArgs with only the interaction length set", () => {
    const interaction = `0x${"cd".repeat(52)}` as const;
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER, interaction });
    expect(fill.functionName).toBe("fillOrderArgs");
    const traits = BigInt(fill.takerTraits);
    expect((traits >> 224n) & 0xffffffn).toBe(0n);
    expect((traits >> 200n) & 0xffffffn).toBe(52n);
  });

  it("packs MAKER_AMOUNT flag (bit 255) and the exact taking-amount cap by default", () => {
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER });
    const traits = BigInt(fill.takerTraits);
    expect(traits & (1n << 255n)).toBe(1n << 255n);
    expect(traits & ((1n << 185n) - 1n)).toBe(200n); // full-fill taking amount
    expect(fill.requiredTakingAmount).toBe("200");
  });

  it("partial fill rounds the taking cap UP (taker never underpays the maker)", () => {
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER, fillMakingAmount: 33n });
    // ceil(33 * 200 / 100) = ceil(66) = 66
    expect(fill.requiredTakingAmount).toBe("66");
  });

  it("ERC1271 maker → fillContractOrderArgs (signature bytes, not r/vs)", () => {
    const extension = `0x${"cd".repeat(4)}` as const;
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, makerAccountType: "ERC1271", taker: TAKER, extension });
    expect(fill.functionName).toBe("fillContractOrderArgs");
    expect(fill.calldata.slice(0, 10)).toBe(toFunctionSelector(`fillContractOrderArgs(${UINT8},bytes,uint256,uint256,bytes)`));
  });

  it("an explicit receiver sets ARGS_HAS_RECEIVER (bit 251) and prefixes args with the 20-byte receiver", () => {
    const receiver = "0x00000000000000000000000000000000000000ee" as const;
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER, receiver });
    expect(fill.functionName).toBe("fillOrderArgs"); // args present (receiver) even without an extension
    expect(BigInt(fill.takerTraits) & (1n << 251n)).toBe(1n << 251n);
    const { args } = decodeFunctionData({ abi: parseAbi([`function fillOrderArgs(${UINT8} o, bytes32 r, bytes32 vs, uint256 a, uint256 t, bytes args)`]), data: fill.calldata });
    expect((args[5] as string).toLowerCase()).toBe(receiver.toLowerCase());
  });

  it("ERC1271 maker without an extension → fillContractOrder (signature bytes, no args)", () => {
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, makerAccountType: "ERC1271", taker: TAKER });
    expect(fill.functionName).toBe("fillContractOrder");
    expect(fill.calldata.slice(0, 10)).toBe(toFunctionSelector(`fillContractOrder(${UINT8},bytes,uint256,uint256)`));
  });

  it("a receiver equal to the taker is NOT treated as explicit (no receiver prefix)", () => {
    const fill = buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER, receiver: TAKER });
    expect(fill.functionName).toBe("fillOrder");
    expect(BigInt(fill.takerTraits) & (1n << 251n)).toBe(0n);
  });

  it("rejects a taking cap that overflows the 185-bit threshold field", () => {
    expect(() => buildTakerFill({ order: baseOrder, signature: SIG, taker: TAKER, maximumTakingAmount: 1n << 185n })).toThrow(/185-bit/);
  });
});

describe("finalizeMakerOrder (recover the external signer; never sign)", () => {
  const LOP = LOP_ADDRESSES[1]!;
  const acct = privateKeyToAccount(`0x${"01".repeat(32)}`);
  const order: LopOrder = { ...baseOrder, maker: acct.address };
  const orderHash = hashLopOrder(1, LOP, order);

  it("accepts a signature that recovers to the maker and echoes the recovered signer", async () => {
    const signature = await acct.sign({ hash: orderHash });
    const f = await finalizeMakerOrder({ chainId: 1, lop: LOP, order, claimedOrderHash: orderHash, signature, extension: "0x" });
    expect(f.orderHash).toBe(orderHash);
    expect(f.recoveredSigner).toBe(acct.address);
  });

  it("rejects a prepared orderHash that does not match the reconstruction", async () => {
    const signature = await acct.sign({ hash: orderHash });
    await expect(finalizeMakerOrder({ chainId: 1, lop: LOP, order, claimedOrderHash: `0x${"9".repeat(64)}`, signature, extension: "0x" })).rejects.toThrow(/does not match/);
  });

  it("rejects a signature that recovers to someone other than the maker", async () => {
    const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
    const signature = await other.sign({ hash: orderHash });
    await expect(finalizeMakerOrder({ chainId: 1, lop: LOP, order, claimedOrderHash: orderHash, signature, extension: "0x" })).rejects.toThrow(/not the order maker/);
  });

  it("rejects an extension whose keccak is not bound into the salt's low 160 bits", async () => {
    // order.salt is not derived from any extension, so any non-empty extension fails the binding.
    const signature = await acct.sign({ hash: orderHash });
    await expect(finalizeMakerOrder({ chainId: 1, lop: LOP, order, claimedOrderHash: orderHash, signature, extension: `0x${"ab".repeat(20)}` })).rejects.toThrow(/InvalidExtension|bound/);
  });
});

describe("buildCancelOrder", () => {
  it("encodes LOP.cancelOrder(makerTraits, orderHash)", () => {
    const { data } = buildCancelOrder(0n, `0x${"1".repeat(64)}`);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("function cancelOrder(uint256 makerTraits, bytes32 orderHash)"));
  });
});
