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
});

describe("buildCancelOrder", () => {
  it("encodes LOP.cancelOrder(makerTraits, orderHash)", () => {
    const { data } = buildCancelOrder(0n, `0x${"1".repeat(64)}`);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("function cancelOrder(uint256 makerTraits, bytes32 orderHash)"));
  });
});
