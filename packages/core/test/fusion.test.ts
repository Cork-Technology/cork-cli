// Fusion dutch-auction pricing: offline, but every golden number here is CHAIN-VERIFIED — the
// synthetic vectors were proven wei-exact against the DEPLOYED settlement getters on mainnet AND
// Arbitrum via eth_call (experiments/fusion-spike/probe.ts, 2026-07-28), and the fixture order is
// a REAL production fill captured from Arbitrum calldata whose price the live getter reproduced
// wei-exactly (validate-real-order.ts). If these constants ever need "fixing", suspect the port.
import { describe, expect, it } from "vitest";
import {
  decodeExtensionFields,
  decodeFusionOrder,
  fusionMakerGives,
  fusionRateBump,
  fusionTakerPays,
  fusionTotalFee,
  NotAFusionOrder,
  parseAuctionGetterData,
  runTool,
  ToolInputError,
  type FusionAuction,
  type LopOrder,
} from "@cork/core";
import realFixture from "./fixtures/fusion-real-order.json" with { type: "json" };

const M = 10n ** 18n;
const T = 2_000_000_000n;
const START = 1_785_204_827n - 600n; // the probe's pinned-block shape: 600s into the auction
const AUCTION: FusionAuction = {
  gasBumpEstimate: 0n,
  gasPriceEstimate: 0n,
  startTime: START,
  duration: 3600n,
  initialRateBump: 1_000_000n,
  points: [
    { rateBump: 700_000n, timeDelta: 900n },
    { rateBump: 300_000n, timeDelta: 900n },
  ],
};
const TS = START + 600n;

// The synthetic example order from TOOL_EXAMPLES (mk-example.ts): 2-point auction, zero fees,
// salt bound to the extension, HAS_EXTENSION traits.
const EXAMPLE_EXT =
  "0x0000006e0000006e0000006e0000006e0000006e0000003700000000000000002ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a922100000e100f4240020aae6003840493e00384000000000000002ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a922100000e100f4240020aae6003840493e0038400000000000000" as const;
const EXAMPLE_ORDER = {
  salt: "72116775394861435818731221900729193628876322478708569",
  maker: "0xc0ffee0000000000000000000000000000000001",
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
  makingAmount: "1000000000000000000",
  takingAmount: "1000000",
  makerTraits: (1n << 249n).toString(),
  extension: EXAMPLE_EXT,
};

describe("fusion pricing math — chain-verified goldens (probe.ts, 2026-07-28, both chains)", () => {
  it("mid-auction interpolation, no fees: 800000 bump; taking 540000000 / making 231481481481481481", () => {
    const bump = fusionRateBump(AUCTION, TS, null);
    expect(bump.effective).toBe(800_000n);
    expect(fusionTakerPays(M, T, 250_000_000_000_000_000n, 0n, bump.effective)).toBe(540_000_000n);
    expect(fusionMakerGives(M, T, 500_000_000n, 0n, bump.effective)).toBe(231_481_481_481_481_481n);
  });

  it("fees + whitelist discount (200 → 150 via 75/100, +100 integrator = 250): 541350000 / 230904220929158584", () => {
    const fees = { integratorFee: 100n, integratorShare: 50n, resolverFee: 200n, whitelistDiscountNumerator: 75n, whitelist: ["0x00000000000000000a11ce".slice(0, 22) as `0x${string}`] };
    expect(fusionTotalFee(fees, true)).toBe(250n);
    expect(fusionTotalFee(fees, false)).toBe(300n);
    const bump = fusionRateBump(AUCTION, TS, null).effective;
    expect(fusionTakerPays(M, T, 250_000_000_000_000_000n, 250n, bump)).toBe(541_350_000n);
    expect(fusionMakerGives(M, T, 500_000_000n, 250n, bump)).toBe(230_904_220_929_158_584n);
  });

  it("pre-start pins the initial bump (550000000 / 227272727272727272); post-finish floors at 0 (500000000 / 250000000000000000)", () => {
    const pre = fusionRateBump({ ...AUCTION, startTime: TS + 1000n }, TS, null);
    expect(pre.effective).toBe(1_000_000n);
    expect(fusionTakerPays(M, T, 250_000_000_000_000_000n, 0n, pre.effective)).toBe(550_000_000n);
    expect(fusionMakerGives(M, T, 500_000_000n, 0n, pre.effective)).toBe(227_272_727_272_727_272n);
    const post = fusionRateBump({ ...AUCTION, startTime: TS - 10_000n }, TS, null);
    expect(post.effective).toBe(0n);
    expect(fusionTakerPays(M, T, 250_000_000_000_000_000n, 0n, 0n)).toBe(500_000_000n);
    expect(fusionMakerGives(M, T, 500_000_000n, 0n, 0n)).toBe(250_000_000_000_000_000n);
  });

  it("gas bump reduces the auction bump (floored at 0) and is SKIPPED when baseFee is null", () => {
    const a = { ...AUCTION, gasBumpEstimate: 50_000n, gasPriceEstimate: 1_000n };
    // gasBump = 50000 * baseFee / 1000 / 1e6
    expect(fusionRateBump(a, TS, 45_375_050n)).toEqual({ auctionBump: 800_000n, gasBump: 2_268n, effective: 797_732n });
    expect(fusionRateBump(a, TS, null).effective).toBe(800_000n); // upper bound
    expect(fusionRateBump(a, TS, 10n ** 15n).effective).toBe(0n); // bump can only floor, never negative
  });

  it("interpolates past the last point toward (finishTime, 0)", () => {
    // 2000s in: past both points (start+900, start+1800); segment (1800, 300000) → (3600, 0)
    const bump = fusionRateBump(AUCTION, START + 2000n, null);
    expect(bump.auctionBump).toBe(((START + 3600n - (START + 2000n)) * 300_000n) / (START + 3600n - (START + 1800n)));
  });
});

describe("fusion extension decode [K3]", () => {
  it("decodeExtensionFields splits the example extension into its fields", () => {
    const f = decodeExtensionFields(EXAMPLE_EXT);
    expect(f.makingAmountData.toLowerCase()).toBe(f.takingAmountData.toLowerCase());
    expect(f.makingAmountData.slice(0, 42).toLowerCase()).toBe("0x2ad5004c60e16e54d5007c80ce329adde5b51ef5");
    expect(f.preInteractionData).toBe("0x");
    expect(f.postInteractionData).toBe("0x");
    expect(f.customData).toBe("0x");
  });

  it("parseAuctionGetterData rejects trailing bytes (a tail would delegate to another getter)", () => {
    const f = decodeExtensionFields(EXAMPLE_EXT);
    const extra = f.makingAmountData.slice(42) + "ff"; // extraData hex (address stripped) + 1 junk byte
    expect(() => parseAuctionGetterData(`0x${extra}` as `0x${string}`)).toThrow(/trailing/);
  });

  it("decodeFusionOrder verifies the salt binding and settlement identity", () => {
    const order: LopOrder = {
      salt: BigInt(EXAMPLE_ORDER.salt),
      maker: EXAMPLE_ORDER.maker as `0x${string}`,
      receiver: EXAMPLE_ORDER.receiver as `0x${string}`,
      makerAsset: EXAMPLE_ORDER.makerAsset as `0x${string}`,
      takerAsset: EXAMPLE_ORDER.takerAsset as `0x${string}`,
      makingAmount: M,
      takingAmount: 1_000_000n,
      makerTraits: 1n << 249n,
    };
    const d = decodeFusionOrder(order, EXAMPLE_EXT, 42161);
    expect(d.classification).toBe("current");
    expect(d.saltBoundToExtension).toBe(true);
    expect(d.auction.points).toHaveLength(2);
    expect(d.postInteraction).toBeNull(); // permissionless-fill shape (no L3)
    expect(() => decodeFusionOrder({ ...order, salt: 1n }, EXAMPLE_EXT, 42161)).not.toThrow(); // binding reported, not thrown
    expect(decodeFusionOrder({ ...order, salt: 1n }, EXAMPLE_EXT, 42161).saltBoundToExtension).toBe(false);
    expect(() => decodeFusionOrder(order, "0x", 42161)).toThrow(NotAFusionOrder);
  });
});

describe("runTool: cork_compute dutch-auction-price", () => {
  const NOW = 1_787_962_200n; // 600s into the example auction

  it("prices the example order at a pinned timestamp (bump 800000 → takerPays 1080000)", async () => {
    const env = await runTool("cork_compute", { params: { kind: "dutch-auction-price", order: EXAMPLE_ORDER }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: 0n });
    expect(env.state).toBe("ok");
    const d = env.data as { phase: string; rateBump: { effective: string }; price: { takerPays: { whitelistedTaker: string; nonWhitelistedTaker: string } }; at: { source: string }; fillability: { gated: boolean }; settlement: { classification: string }; scales: Record<string, string> };
    expect(d.settlement.classification).toBe("current");
    expect(d.phase).toBe("decaying");
    expect(d.rateBump.effective).toBe("800000");
    expect(d.price.takerPays.nonWhitelistedTaker).toBe("1080000");
    expect(d.at.source).toContain("pinned");
    expect(d.fillability.gated).toBe(false);
    expect(d.scales.rateBump).toContain("1e7");
  });

  it("REAL production order (Arbitrum fill, frozen fixture): decode + price reproduce the captured values", async () => {
    const env = await runTool(
      "cork_compute",
      { chainId: 42161, params: { kind: "dutch-auction-price", order: realFixture.order }, at: { timestamp: realFixture.blockTimestamp }, format: "concise" },
      { nowSeconds: 0n },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { settlement: { classification: string }; rateBump: { effective: string }; price: { takerPays: { whitelistedTaker: string; nonWhitelistedTaker: string } }; fillability: { gated: boolean; whitelistSize: number; resolvingStartTime: string; publicFillTime: string }; auction: { duration: string } };
    expect(d.settlement.classification).toBe(realFixture.expected.classification);
    expect(d.rateBump.effective).toBe(realFixture.expected.effectiveBump);
    expect(d.price.takerPays.nonWhitelistedTaker).toBe(realFixture.expected.takerPaysNonWhitelisted);
    expect(d.price.takerPays.whitelistedTaker).toBe(realFixture.expected.takerPaysWhitelisted);
    expect(d.fillability.gated).toBe(true);
    expect(d.fillability.whitelistSize).toBe(realFixture.expected.fillability.whitelistSize);
    expect(d.auction.duration).toBe(realFixture.expected.auction.duration);
  });

  it("floor price of the real order equals its nominal takingAmount — and matched the LIVE getter wei-exactly at capture time", async () => {
    const env = await runTool(
      "cork_compute",
      { chainId: 42161, params: { kind: "dutch-auction-price", order: realFixture.order }, at: { timestamp: (BigInt(realFixture.blockTimestamp) + 10_000n).toString() }, format: "concise" },
      { nowSeconds: 0n },
    );
    const d = env.data as { phase: string; price: { takerPays: { nonWhitelistedTaker: string } } };
    expect(d.phase).toBe("floor");
    expect(d.price.takerPays.nonWhitelistedTaker).toBe(realFixture.order.takingAmount);
    expect(d.price.takerPays.nonWhitelistedTaker).toBe(realFixture.expected.onChainGetterNonWhitelisted);
  });

  it("taker given: single price + whitelist membership; unknown settlement discloses; salt mismatch conflicts", async () => {
    const withTaker = await runTool("cork_compute", { chainId: 42161, params: { kind: "dutch-auction-price", order: realFixture.order, taker: "0x00000000000000000000000000000000000a11ce" }, at: { timestamp: realFixture.blockTimestamp }, format: "concise" }, { nowSeconds: 0n });
    const dt = (withTaker.data as { price: { takerIsGetterWhitelisted: boolean; takerPays: string } }).price;
    expect(dt.takerIsGetterWhitelisted).toBe(false);
    expect(typeof dt.takerPays).toBe("string");

    const unknownSettlement = EXAMPLE_EXT.replaceAll("2ad5004c60e16e54d5007c80ce329adde5b51ef5", "00000000000000000000000000000000000000aa") as `0x${string}`;
    // rebind the salt to the mutated extension so ONLY the classification differs
    const { keccak256 } = await import("viem");
    const salt = ((1n << 200n) | (BigInt(keccak256(unknownSettlement)) & ((1n << 160n) - 1n))).toString();
    const env = await runTool("cork_compute", { params: { kind: "dutch-auction-price", order: { ...EXAMPLE_ORDER, salt, extension: unknownSettlement } }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: 0n });
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "settler_not_recognized")).toBe(true);

    const mismatch = await runTool("cork_compute", { params: { kind: "dutch-auction-price", order: { ...EXAMPLE_ORDER, salt: "12345" } }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: 0n });
    expect(mismatch.state).toBe("conflict");
    expect(mismatch.warnings[0]?.code).toBe("extension_salt_mismatch");
  });

  it("legacy settlement → phase_gated; missing extension → teachable invalid input", async () => {
    const legacyExt = EXAMPLE_EXT.replaceAll("2ad5004c60e16e54d5007c80ce329adde5b51ef5", "fb2809a5314473e1165f6b58018e20ed8f07b840") as `0x${string}`;
    const { keccak256 } = await import("viem");
    const salt = ((1n << 200n) | (BigInt(keccak256(legacyExt)) & ((1n << 160n) - 1n))).toString();
    const env = await runTool("cork_compute", { params: { kind: "dutch-auction-price", order: { ...EXAMPLE_ORDER, salt, extension: legacyExt } }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: 0n });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("phase_gated");
    expect(env.warnings[0]?.message).toMatch(/LEGACY/);

    const { extension: _omit, ...noExt } = EXAMPLE_ORDER;
    await expect(runTool("cork_compute", { params: { kind: "dutch-auction-price", order: noExt }, format: "concise" }, { nowSeconds: NOW })).rejects.toThrow(ToolInputError);
  });

  it("cork_decode order labels the real fixture as a Fusion order", async () => {
    const env = await runTool("cork_decode", { kind: "order", data: realFixture.order, chainId: 42161, format: "concise" }, { nowSeconds: 0n });
    expect(env.state).toBe("ok");
    const f = (env.data as { fusion?: { classification: string; postInteractionGated: boolean; auction: { points: number } } }).fusion;
    expect(f?.classification).toBe("current");
    expect(f?.postInteractionGated).toBe(true);
    expect(f?.auction.points).toBe(1);
  });
});
