import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { buildCancelOrder, buildMakerOrder, buildMakerTraits, LOP_ADDRESSES } from "@cork/core";

const MAKER = "0x0000000000000000000000000000000000000abc" as const;
const MAKER_ASSET = "0x0000000000000000000000000000000000000001" as const;
const TAKER_ASSET = "0x0000000000000000000000000000000000000002" as const;

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
});

describe("buildCancelOrder", () => {
  it("encodes LOP.cancelOrder(makerTraits, orderHash)", () => {
    const { data } = buildCancelOrder(0n, `0x${"1".repeat(64)}`);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("function cancelOrder(uint256 makerTraits, bytes32 orderHash)"));
  });
});
