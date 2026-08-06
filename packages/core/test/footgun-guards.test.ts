// Regression tests for the 2026-07-24 footgun-hardening pass (notes/footgun-investigation-*.md).
// Each block names the finding it pins. These tests FAILED before the fixes: the old code
// returned values (or clean `ok` envelopes) on every input below.
import { describe, expect, it } from "vitest";
import {
  buildMakerOrder,
  buildMakerTraits,
  buildTakerFill,
  call,
  ceilDiv,
  decodeBundle,
  encodeMulticall,
  impairmentFloor,
  mulDiv,
  resolveConfig,
  runTool,
  WAD,
  type StoredCache,
} from "@cork/core";
import { computeT, calculateGrossAmountBeforeFee, calculateTimeDecayFee, resetConfigMemo } from "@cork/core";
import { UnixSeconds } from "@cork/schemas";
import { encodeFunctionData, parseAbi } from "viem";
import bundledDefaults from "../../../cork-defaults.json" with { type: "json" };

const A = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const B = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;
const TAKER = "0xc0ffee0000000000000000000000000000000001" as const;
const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as const;

describe("T1/T2/T9 — math primitives enforce the Solidity revert domain (class item 9)", () => {
  it("mulDiv rejects negative operands, zero/negative denominators, and uint256 quotient overflow", () => {
    const U256 = (1n << 256n) - 1n;
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(/division by zero/);
    expect(() => mulDiv(1n, 1n, -1n)).toThrow(/negative operand/);
    expect(() => mulDiv(-1n, 1n, 1n)).toThrow(/negative operand/);
    expect(() => mulDiv(U256, U256, 1n)).toThrow(/exceeds uint256/);
    expect(mulDiv(U256, U256, U256)).toBe(U256); // boundary still fine
    expect(mulDiv(10n, 10n, 3n, "ceil")).toBe(34n);
  });

  it("ceilDiv rejects negative operands (the (a-1)/b+1 form overshoots true ceil for a<0)", () => {
    expect(() => ceilDiv(-1n, 3n)).toThrow(/negative operand/);
    expect(ceilDiv(5n, 3n)).toBe(2n);
  });

  it("computeT throws on current<start and end<start where the contract underflow-reverts (was: t>WAD → inflated fee)", () => {
    expect(() => computeT(100n, 1100n, 0n)).toThrow(/underflow/);
    expect(() => computeT(100n, 50n, 100n)).toThrow(/underflow/);
    expect(computeT(100n, 1100n, 100n)).toBe((999n * WAD) / 1000n); // valid domain untouched (elapsed min 1)
    // The 5.5%-fee-from-a-5%-base repro now throws instead of inflating.
    expect(() => calculateTimeDecayFee(100n, 1100n, 0n, WAD, 5n * 10n ** 18n)).toThrow(/underflow/);
  });

  it("gross-before-fee refuses fee >= 100% (was: silent NEGATIVE amounts / raw div-by-zero)", () => {
    expect(() => calculateGrossAmountBeforeFee(WAD, 100n * 10n ** 18n)).toThrow(/>= 100%/);
    expect(() => calculateGrossAmountBeforeFee(WAD, 101n * 10n ** 18n)).toThrow(/>= 100%/);
    expect(calculateGrossAmountBeforeFee(WAD, 5n * 10n ** 18n)).toBeGreaterThan(WAD);
  });
});

describe("T4 — impairment floor at worstRate=0 answers instead of crashing", () => {
  it("returns maxReferencePerCst null (unbounded) when the floor collapses to zero", () => {
    const market = { collateralAsset: A, referenceAsset: B, expiryTimestamp: 0n, rateMin: 0n, rateMax: 2n * WAD, rateChangePerDayMax: WAD, rateChangeCapacityMax: WAD, rateOracle: A } as never;
    const state = { lastAdjustedRate: WAD / 2n, remainingCredits: WAD, lastAdjustmentTimestamp: 0n } as never;
    const r = impairmentFloor({ market, state, horizonSeconds: 86400n, tEval: 86400n });
    expect(r.worstRate).toBe(0n);
    expect(r.maxReferencePerCst).toBeNull();
  });
});

describe("F2 — buildMakerTraits range-checks before bit-packing (no silent 40-bit wrap)", () => {
  it("throws on an expiry/nonce that does not fit the 40-bit slot", () => {
    const U40 = (1n << 40n) - 1n;
    expect(() => buildMakerTraits({ allowPartialFills: true, allowMultipleFills: false, usePermit2: false, expiry: U40 + 1n, nonce: 0n })).toThrow(/40-bit/);
    expect(() => buildMakerTraits({ allowPartialFills: true, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: U40 + 1n })).toThrow(/40-bit/);
    // Boundary passes and round-trips exactly.
    const t = buildMakerTraits({ allowPartialFills: true, allowMultipleFills: false, usePermit2: false, expiry: U40, nonce: 0n });
    expect((t >> 80n) & U40).toBe(U40);
  });
});

describe("T3 — taker-fill derives-and-clamps against the signed order (class item 10)", () => {
  const order = { salt: 1n, maker: TAKER, receiver: "0x0000000000000000000000000000000000000000" as const, makerAsset: A, takerAsset: B, makingAmount: 100n, takingAmount: 7n, makerTraits: 0n };

  it("refuses an over-ask instead of reporting 10x-wrong amounts and a 10x-loose cap", () => {
    expect(() => buildTakerFill({ order, signature: SIG, taker: TAKER, fillMakingAmount: 1000n })).toThrow(/exceeds the order's signed makingAmount/);
  });

  it("refuses a partial fill of a signed all-or-nothing (NO_PARTIAL_FILLS) order", () => {
    const aon = { ...order, makerTraits: 1n << 255n };
    expect(() => buildTakerFill({ order: aon, signature: SIG, taker: TAKER, fillMakingAmount: 50n })).toThrow(/NO_PARTIAL_FILLS/);
    // A FULL fill of the same order is fine.
    expect(buildTakerFill({ order: aon, signature: SIG, taker: TAKER }).requiredMakingAmount).toBe("100");
  });

  it("refuses a zero-makingAmount order (malformed venue row) instead of a divisor RangeError", () => {
    expect(() => buildTakerFill({ order: { ...order, makingAmount: 0n }, signature: SIG, taker: TAKER })).toThrow(/makingAmount is 0/);
  });

  it("valid partials still ceil the taking amount exactly", () => {
    const r = buildTakerFill({ order, signature: SIG, taker: TAKER, fillMakingAmount: 50n });
    expect(r.requiredMakingAmount).toBe("50");
    expect(r.requiredTakingAmount).toBe("4"); // ceil(50*7/100) = 4
  });
});

describe("T7 — malformed caller extensions are refused at build time", () => {
  const base = { chainId: 1, lop: A, maker: TAKER, makerAsset: A, takerAsset: B, makingAmount: 1n, takingAmount: 1n, clientRequestId: "ext-shape-01" };
  it("rejects an extension shorter than the 32-byte offsets header", () => {
    expect(() => buildMakerOrder({ ...base, extension: "0x01" })).toThrow(/32-byte offsets header/);
  });
  it("rejects a truncated extension whose offsets claim more bytes than present", () => {
    // every field's cumulative END offset claims 0x40 bytes, but no field bytes follow.
    const offsets = "00000040".repeat(8);
    expect(() => buildMakerOrder({ ...base, extension: `0x${offsets}` })).toThrow(/truncated/);
  });
});

describe("F17 — decode degrades bad legs instead of hiding the whole bundle", () => {
  it("a leg with a known selector but truncated body decodes to kind unknown with a note; siblings survive", () => {
    // erc20TransferFrom selector with a truncated body.
    const full = encodeFunctionData({ abi: parseAbi(["function erc20TransferFrom(address token, address receiver, uint256 amount)"]), args: [A, B, 1n], functionName: "erc20TransferFrom" });
    const truncated = full.slice(0, 20) as `0x${string}`;
    const multicall = encodeMulticall([call(A, "0xdeadbeef"), call(A, truncated)]);
    const legs = decodeBundle(multicall);
    expect(legs).toHaveLength(2);
    expect(legs[0]!.kind).toBe("unknown"); // unrecognized selector, surfaced raw (pre-existing behavior)
    expect(legs[1]!.kind).toBe("unknown");
    expect((legs[1] as { note?: string }).note).toMatch(/failed to decode/);
  });

  it("cork_decode maps malformed top-level calldata to teachable invalid input, not internal_error", async () => {
    await expect(runTool("cork_decode", { kind: "calldata", data: "0x12345678" })).rejects.toMatchObject({ name: "ToolInputError" });
  });
});

describe("F16 — a transient refresh failure never rolls good cached defaults back to the bundle", () => {
  const goodDefaults = () => JSON.parse(JSON.stringify(bundledDefaults));

  it("expired good cache + fetch error → serves the stale GOOD copy with a warning; cache keeps the defaults", async () => {
    const prev = process.env.CORK_CONFIG_NO_FETCH;
    delete process.env.CORK_CONFIG_NO_FETCH;
    try {
      resetConfigMemo();
      const saved: StoredCache[] = [];
      const t0 = 1_000_000_000_000;
      const r = await resolveConfig({
        now: () => t0,
        fetchRemote: async () => {
          throw new Error("network down");
        },
        loadCache: () => ({ fetchedAt: t0 - 2 * 3_600_000, defaults: goodDefaults() }), // expired, but GOOD
        saveCache: (e) => saved.push(e),
      });
      expect(r.source).toBe("cache"); // NOT "bundled"
      expect(r.warning?.code).toBe("config_fetch_failed");
      // The failure marker never replaced the good defaults.
      expect(saved[0]?.defaults).toBeDefined();
      expect(saved[0]?.failure).toBeUndefined();
      expect(saved[0]?.failedAt).toBe(t0);
      resetConfigMemo();
    } finally {
      if (prev !== undefined) process.env.CORK_CONFIG_NO_FETCH = prev;
    }
  });
});

describe("F1/T6 — UnixSeconds plausibility bound (ms-detector) rides every absolute-time field", () => {
  it("rejects a Date.now() (milliseconds) paste with the divide-by-1000 teaching", () => {
    const r = UnixSeconds.safeParse("1753363200000");
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("MILLISECONDS");
  });
  it("accepts the year-2100 boundary", () => {
    expect(UnixSeconds.safeParse("4102444800").success).toBe(true);
    expect(UnixSeconds.safeParse("4102444801").success).toBe(false);
  });
  it("derive-market filters.expiry goes through the same bound (was: bare digit regex)", async () => {
    await expect(
      runTool("cork_query", { resource: "derive-market", chainId: 42161, filters: { collateralAsset: A, referenceAsset: B, expiry: "1753363200000", mode: "liquidity" } }),
    ).rejects.toMatchObject({ name: "ToolInputError" });
  });
});
