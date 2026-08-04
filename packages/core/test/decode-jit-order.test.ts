// cork_decode kind:"order" — the JIT extension label: a taker inspecting a venue row must be
// able to see what a fill DOES (adapter, recipe/constraint or legacy mode, permits) before
// signing anything. Two fixtures: a REAL resting order captured from the live venue orderbook
// (legacy generation — today's entire book), and a 2.1.0 extension built by our own encoder.
import { describe, expect, it } from "vitest";
import { buildJitExtension, encodeJitExtraData, runTool } from "@cork/core";
import venueFixture from "./fixtures/venue-legacy-jit-order.json";

const LIQ = "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D";
const ADAPTER_210 = "0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B";
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2";
const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610";

describe("cork_decode order — JIT extension labeling", () => {
  it("a REAL venue resting order decodes with a LEGACY jit label (old adapter, mode string) and a verified hash", async () => {
    const env = await runTool("cork_decode", { kind: "order", chainId: 42161, data: venueFixture.order }, { nowSeconds: 1n });
    expect(env.state).toBe("ok"); // incl. salt↔extension binding + claimed-hash cross-check
    const d = env.data as { jit: Record<string, unknown>; claimedHashVerified: boolean; saltBoundToExtension: boolean };
    expect(d.saltBoundToExtension).toBe(true);
    expect(d.claimedHashVerified).toBe(true);
    expect(d.jit["generation"]).toContain("legacy");
    expect(String(d.jit["adapter"]).toLowerCase()).toBe("0xea15bf1e5565181ed8678ccff39d797272858505");
    expect(d.jit["mode"]).toBe("liquidity");
    expect(String(d.jit["note"])).toContain("LEGACY");
  });

  it("a 2.1.0 extension decodes with recipe + carried constraint + permit count", async () => {
    const extension = buildJitExtension(
      ADAPTER_210,
      encodeJitExtraData(
        {
          collateralAsset: CA,
          referenceAsset: REF,
          expiryTimestamp: 1_790_000_000n,
          recipe: LIQ,
          rateOverride: 0n,
          constraint: { rateMin: 1n, rateMax: 2n * 10n ** 18n, rateChangePerDayMax: 10n ** 18n, rateChangeCapacityMax: 3n * 10n ** 18n },
          additionalData: "0x",
          swapFeePercentage: 0n,
          unwindSwapFeePercentage: 0n,
          enableJitMint: true,
        },
        [{ token: CA, value: 1n, deadline: 1_790_000_000n, v: 27, r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}` }],
      ),
    );
    // Salt must commit to the extension for the decode to be ok (OrderLib InvalidExtension rule).
    const { keccak256 } = await import("viem");
    const bound = (BigInt(keccak256(extension)) & ((1n << 160n) - 1n)) | (7n << 160n);
    const env = await runTool(
      "cork_decode",
      { kind: "order", chainId: 42161, data: { salt: bound.toString(), maker: CA, receiver: CA, makerAsset: CA, takerAsset: REF, makingAmount: "1", takingAmount: "1", makerTraits: "0", extension } },
      { nowSeconds: 1n },
    );
    expect(env.state).toBe("ok");
    const jit = (env.data as { jit: Record<string, unknown> }).jit;
    expect(jit["generation"]).toBe("2.1.0");
    expect(String(jit["adapter"]).toLowerCase()).toBe(ADAPTER_210.toLowerCase());
    expect(String(jit["recipe"]).toLowerCase()).toBe(LIQ.toLowerCase());
    expect((jit["constraint"] as Record<string, string>)["rateMax"]).toBe((2n * 10n ** 18n).toString());
    expect(jit["permits"]).toBe(1);
    expect(jit["enableJitMint"]).toBe(true);
  });

  it("a non-JIT, non-Fusion extension gets NO jit label (no guessing)", async () => {
    const extension = `0x${"00".repeat(32)}deadbeef` as const; // empty offset table + stray bytes
    const { keccak256 } = await import("viem");
    const bound = (BigInt(keccak256(extension)) & ((1n << 160n) - 1n)) | (7n << 160n);
    const env = await runTool(
      "cork_decode",
      { kind: "order", chainId: 42161, data: { salt: bound.toString(), maker: CA, receiver: CA, makerAsset: CA, takerAsset: REF, makingAmount: "1", takingAmount: "1", makerTraits: "0", extension } },
      { nowSeconds: 1n },
    );
    expect(env.state).toBe("ok");
    expect((env.data as { jit?: unknown }).jit).toBeUndefined();
  });
});
