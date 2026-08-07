// Fusion dutch-auction pricing: offline, but every golden number here is CHAIN-VERIFIED — the
// synthetic vectors were proven wei-exact against the DEPLOYED settlement getters on mainnet AND
// Arbitrum via eth_call (experiments/fusion-spike/probe.ts, 2026-07-28), and the fixture order is
// a REAL production fill captured from Arbitrum calldata whose price the live getter reproduced
// wei-exactly (validate-real-order.ts). If these constants ever need "fixing", suspect the port.
import { describe, expect, it } from "vitest";
import {
  buildAuctionAmountData,
  decodeExtensionFields,
  decodeFusionOrder,
  decodeJitExtension,
  encodeAuctionGetterData,
  encodeExtensionFields,
  FUSION_SETTLEMENTS,
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

  it("warns makingamount_exceeds_order when the priced makingAmount is larger than the order [N2]", async () => {
    // EXAMPLE_ORDER makes 1e18; ask for 10x → linear extrapolation past any fillable amount.
    const over = await runTool("cork_compute", { params: { kind: "dutch-auction-price", order: EXAMPLE_ORDER, makingAmount: "10000000000000000000" }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: 0n });
    expect(over.state).toBe("ok");
    expect(over.warnings.map((w) => w.code)).toContain("makingamount_exceeds_order");
    // At or below the order size there is no warning (a genuine marginal-price query).
    const within = await runTool("cork_compute", { params: { kind: "dutch-auction-price", order: EXAMPLE_ORDER, makingAmount: "500000000000000000" }, at: { timestamp: NOW.toString() }, format: "concise" }, { nowSeconds: 0n });
    expect(within.warnings.map((w) => w.code)).not.toContain("makingamount_exceeds_order");
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

// ── F2: the BUILD side (Cork-native decaying-premium orders) ─────────────────────────────────

describe("encodeAuctionGetterData: exact inverse of the parser", () => {
  it("round-trips the pinned probe auction (points included) with a ZEROED fee section", () => {
    const { auction, fees } = parseAuctionGetterData(encodeAuctionGetterData(AUCTION));
    expect(auction).toEqual(AUCTION);
    expect(fees).toEqual({ integratorFee: 0n, integratorShare: 0n, resolverFee: 0n, whitelistDiscountNumerator: 0n, whitelist: [] });
  });

  it("buildAuctionAmountData: settlement-prefixed, taking == making byte-for-byte", () => {
    const { makingAmountData, takingAmountData, settlement } = buildAuctionAmountData(1, AUCTION);
    expect(takingAmountData).toBe(makingAmountData);
    expect(settlement.toLowerCase()).toBe(FUSION_SETTLEMENTS[1]!.current.toLowerCase());
    expect(makingAmountData.toLowerCase().startsWith(settlement.toLowerCase())).toBe(true);
  });

  it("width guards throw with the field named, never truncate", () => {
    expect(() => encodeAuctionGetterData({ ...AUCTION, initialRateBump: 1n << 24n })).toThrow(/initialRateBump.*3 byte/);
    expect(() => encodeAuctionGetterData({ ...AUCTION, duration: 1n << 24n })).toThrow(/duration/);
    expect(() => encodeAuctionGetterData({ ...AUCTION, startTime: 1n << 32n })).toThrow(/startTime/);
  });

  it("curve guards: zero duration, non-decaying point, overlong tail all refuse", () => {
    expect(() => encodeAuctionGetterData({ ...AUCTION, duration: 0n })).toThrow(/zero duration/);
    expect(() => encodeAuctionGetterData({ ...AUCTION, points: [{ rateBump: AUCTION.initialRateBump + 1n, timeDelta: 60n }] })).toThrow(/exceeds the preceding bump/);
    expect(() => encodeAuctionGetterData({ ...AUCTION, points: [{ rateBump: 1n, timeDelta: 3000n }, { rateBump: 0n, timeDelta: 3000n }] })).toThrow(/past the/);
  });

  it("enforces true monotonic decay: a down-THEN-up curve (each point <= initialRateBump) is REJECTED [N1]", () => {
    // The old guard only checked each point <= initialRateBump, so 100→10→90 slipped through and
    // produced a curve that RISES from +10% to +90% mid-window — contradicting every "decays to
    // the floor" doc. The fix checks each point against the PRECEDING bump.
    const initialRateBump = 1_000_000n;
    const downThenUp = { ...AUCTION, initialRateBump, points: [{ rateBump: 100_000n, timeDelta: 60n }, { rateBump: 900_000n, timeDelta: 60n }] };
    expect(() => encodeAuctionGetterData(downThenUp)).toThrow(/exceeds the preceding bump 100000/);
    // A genuinely non-increasing multi-point curve (each <= the one before) still encodes and
    // round-trips through the parser unchanged.
    const decaying = { ...AUCTION, initialRateBump, points: [{ rateBump: 600_000n, timeDelta: 60n }, { rateBump: 200_000n, timeDelta: 60n }] };
    const { auction } = parseAuctionGetterData(encodeAuctionGetterData(decaying));
    expect(auction.points.map((p) => p.rateBump)).toEqual([600_000n, 200_000n]);
  });
});

describe("encodeExtensionFields: inverse of decodeExtensionFields", () => {
  it("round-trips a composed extension (amount getters + preInteraction) and the empty case", () => {
    const fields = { makingAmountData: "0xaabb" as const, takingAmountData: "0xaabb" as const, preInteractionData: "0x112233" as const };
    const back = decodeExtensionFields(encodeExtensionFields(fields));
    expect(back.makingAmountData).toBe("0xaabb");
    expect(back.takingAmountData).toBe("0xaabb");
    expect(back.preInteractionData).toBe("0x112233");
    expect(back.postInteractionData).toBe("0x");
    expect(encodeExtensionFields({})).toBe("0x");
  });
});

describe("runTool: cork_prepare_orders maker-order + auction (offline, pure local)", () => {
  const base = {
    chainId: 1 as const,
    account: "0xc0ffee0000000000000000000000000000000001",
    clientRequestId: "fusion-build-0001",
    action: {
      type: "maker-order",
      poolId: `0x${"11".repeat(32)}`,
      side: "SELL",
      makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
      makingAmount: "1000000000000000000",
      takingAmount: "1000000",
    },
  };
  const NOW = 1_790_000_000n;

  it("builds a salt-bound auction order our own decoder + pricer accept (build→price parity)", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: { ...base.action, auction: { durationSeconds: 3600, initialRateBump: "1000000" } } }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { extension: `0x${string}`; typedData: { message: Record<string, string> }; fusion: Record<string, unknown> };
    expect(env.warnings.some((w) => w.code === "decaying_price_notice")).toBe(true);
    // Self-decode: the built bytes ARE a Fusion order, permissionless (no postInteraction).
    const m = d.typedData.message;
    const order: LopOrder = { salt: BigInt(m.salt!), maker: m.maker as `0x${string}`, receiver: m.receiver as `0x${string}`, makerAsset: m.makerAsset as `0x${string}`, takerAsset: m.takerAsset as `0x${string}`, makingAmount: BigInt(m.makingAmount!), takingAmount: BigInt(m.takingAmount!), makerTraits: BigInt(m.makerTraits!) };
    const dec = decodeFusionOrder(order, d.extension, 1);
    expect(dec.saltBoundToExtension).toBe(true);
    expect(dec.postInteraction).toBeNull();
    expect(dec.classification).toBe("current");
    expect(dec.auction.initialRateBump).toBe(1_000_000n);
    // fusion echo: phase decaying at start; ceiling = floor * 1.1 (bump 1e6/1e7 = +10%), floor = takingAmount.
    expect(d.fusion["phase"]).toBe("decaying");
    expect(d.fusion["floorTakingAmount"]).toBe("1000000");
    expect(d.fusion["takerPaysCeiling"]).toBe("1100000");
    expect(d.fusion["takerPaysNow"]).toBe("1100000"); // t == startTime → full bump
    // Build→price parity with the ACTIVATED pricer on the same bytes.
    const priced = await runTool("cork_compute", { chainId: 1, params: { kind: "dutch-auction-price", order: { ...m, extension: d.extension } } }, { nowSeconds: NOW });
    expect(priced.state).toBe("ok");
    const pd = priced.data as { price: { takerPays: string } } & Record<string, unknown>;
    expect(JSON.stringify(pd)).toContain("1100000");
  });

  it("the price decays to the signed floor after the window (phase: floor)", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "fusion-build-0002", action: { ...base.action, auction: { startTime: String(NOW - 4000n), durationSeconds: 3600, initialRateBump: "1000000" } } }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { fusion: Record<string, unknown> };
    expect(d.fusion["phase"]).toBe("floor");
    expect(d.fusion["takerPaysNow"]).toBe("1000000");
  });

  it("auction + raw extension are mutually exclusive (format throw)", async () => {
    await expect(
      runTool("cork_prepare_orders", { ...base, action: { ...base.action, extension: "0x" + "00".repeat(33), auction: { durationSeconds: 3600, initialRateBump: "1000000" } } }, { nowSeconds: NOW }),
    ).rejects.toThrow(ToolInputError);
  });

  it("a curve rule violation returns invalid_order_terms (envelope, exit-3 class), not a crash", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, clientRequestId: "fusion-build-0003", action: { ...base.action, auction: { durationSeconds: 3600, initialRateBump: String(1n << 24n) } } }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("initialRateBump");
  });

  it("composes with jitMarket: ONE extension carries the JIT preInteraction AND the auction getters, one salt binding", async () => {
    const constraint = { rateMin: "1", rateMax: "2000000000000000000", rateChangePerDayMax: "1000000000000000000", rateChangeCapacityMax: "3000000000000000000" };
    const env = await runTool(
      "cork_prepare_orders",
      {
        chainId: 42161,
        account: "0xc0ffee0000000000000000000000000000000001",
        clientRequestId: "fusion-jit-0001",
        action: {
          ...base.action,
          makerAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
          takerAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
          auction: { durationSeconds: 3600, initialRateBump: "500000" },
          jitMarket: { collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610", expiryTimestamp: "1795000000", recipe: "0xD27c7BB8564Db019B41d9C48d1ABCEd9A7d90291", constraint },
        },
      },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { extension: `0x${string}`; typedData: { message: Record<string, string> }; jit: unknown; fusion: unknown };
    expect(d.jit).toBeDefined();
    expect(d.fusion).toBeDefined();
    // BOTH decoders read the same composed blob.
    const jit = decodeJitExtension(d.extension);
    expect(jit.params.recipe.toLowerCase()).toBe("0xd27c7bb8564db019b41d9c48d1abced9a7d90291");
    const m = d.typedData.message;
    const order: LopOrder = { salt: BigInt(m.salt!), maker: m.maker as `0x${string}`, receiver: m.receiver as `0x${string}`, makerAsset: m.makerAsset as `0x${string}`, takerAsset: m.takerAsset as `0x${string}`, makingAmount: BigInt(m.makingAmount!), takingAmount: BigInt(m.takingAmount!), makerTraits: BigInt(m.makerTraits!) };
    const dec = decodeFusionOrder(order, d.extension, 42161);
    expect(dec.auction.initialRateBump).toBe(500_000n);
    expect(dec.saltBoundToExtension).toBe(true);
  });
});

describe("decode order on a COMPOSED extension (auction + JIT): BOTH labels", () => {
  it("a taker inspecting a composed venue row sees the auction AND the JIT commitment", async () => {
    const constraint = { rateMin: "1", rateMax: "2000000000000000000", rateChangePerDayMax: "1000000000000000000", rateChangeCapacityMax: "3000000000000000000" };
    const prep = await runTool(
      "cork_prepare_orders",
      {
        chainId: 42161,
        account: "0xc0ffee0000000000000000000000000000000001",
        clientRequestId: "fusion-jit-decode-0001",
        action: {
          type: "maker-order",
          poolId: `0x${"11".repeat(32)}`,
          side: "SELL",
          makerAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
          takerAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
          makingAmount: "1000000000000000000",
          takingAmount: "1000000",
          auction: { durationSeconds: 3600, initialRateBump: "500000" },
          jitMarket: { collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610", expiryTimestamp: "1795000000", recipe: "0xD27c7BB8564Db019B41d9C48d1ABCEd9A7d90291", constraint },
        },
      },
      { nowSeconds: 1_790_000_000n, resolveRpc: async () => null },
    );
    expect(prep.state).toBe("ok");
    const pd = prep.data as { extension: `0x${string}`; typedData: { message: Record<string, string> } };
    const env = await runTool("cork_decode", { chainId: 42161, kind: "order", data: { ...pd.typedData.message, extension: pd.extension } }, { nowSeconds: 1_790_000_000n });
    expect(env.state).toBe("ok");
    const d = env.data as { fusion?: Record<string, unknown>; jit?: Record<string, unknown> };
    expect(d.fusion).toBeDefined();
    expect(d.jit).toBeDefined();
    expect(String(d.jit!["recipe"]).toLowerCase()).toBe("0xd27c7bb8564db019b41d9c48d1abced9a7d90291");
    expect(d.fusion!["postInteractionGated"]).toBe(false);
  });
});
