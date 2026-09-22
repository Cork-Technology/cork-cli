// The NESTED registry wire (market-registry 0.5.0, Distribution phoenix/v0.4-rc.1 — the primary
// generation on Arbitrum One + Base since 2026-09-22): every codec row pinned against vectors the
// DEPLOYED contracts computed themselves (42161, 2026-09-22 — adapter.encodeExtraData /
// decodeExtraData, pm.getId, recipe.encodeExtraData), the selectors + word layouts of the calls
// this build emits at them, and the handler paths that bind the primary (JIT maker, create-pool,
// deploy-oracle, registry reads, derive) against the eval stub's nested stack. The flat (0.3.x)
// suites keep their own generation named; this file is the other half of the codec table.
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbiItem, toFunctionSelector } from "viem";
import { DEMO_ACCOUNT } from "@cork/schemas";
import {
  buildCreatePoolCall,
  buildCreatorCreatePoolCall,
  buildDeployOracleCall,
  buildJitExtension,
  buildRecipeVerifyCall,
  BUNDLED_DEFAULTS,
  computeMarketId,
  CREATOR_MARKET_CREATED_TOPIC,
  decodeJitExtension,
  decodeJitExtensionAny,
  decodeJitExtraData,
  decodeKnownLog,
  deriveJitMarket,
  diffJitExtraData,
  encodeImpairmentArgs,
  encodeJitExtraData,
  generationsOf,
  JIT_EVENTS,
  type JITMarketParams,
  marketCreatorNestedAbi,
  marketRegistryForWire,
  type PermitParams,
  POOL_MANAGER_MARKET_CREATED_10_TOPIC,
  primaryOf,
  readRoleHolder,
  RECIPE_CATALOG,
  runTool,
  ToolInputError,
  WIRES,
  wireCodec,
  ZERO_ORACLE_SALT,
  type HandlerContext,
} from "@cork/core";
import { CST, JIT_TASK_CONSTRAINT, JIT_TASK_PAIR, LIQUIDITY_RECIPE, IMPAIRMENT_RECIPE, stubContext } from "../../../evals/stub.ts";
import { resolveFeeRule } from "../src/handlers/jit.ts";

const WAD = 10n ** 18n;
const NOW = 1_790_000_000n; // the eval stub's clock
const EXPIRY = (NOW + 20n * 86_400n).toString(); // inside the registry's 30-day creation bound
const PRIMARY = primaryOf(generationsOf(BUNDLED_DEFAULTS, 42161))!;
const FLAT = marketRegistryForWire(generationsOf(BUNDLED_DEFAULTS, 42161), "flat")!;
const NESTED_MR = PRIMARY.marketRegistry!;
const STUB_ORACLE = "0x14115b5fdab3afcd72cf03785041c720100edb0e"; // the stub's deployed pair wrapper

// ── The chain-captured sample (scratchpad live-vectors.ts, 42161, 2026-09-22) ─────────────────
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const BASEUSD = "0x9c6864105AEC23388C89600046213a44C384c831" as const;
const NAV_RECIPE = "0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3" as const;
const SAMPLE: JITMarketParams = {
  collateralAsset: USDC,
  referenceAsset: BASEUSD,
  expiryTimestamp: 1_800_000_000n,
  recipe: "0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9",
  rateOverride: 0n,
  constraint: { rateMin: WAD, rateMax: 2n * WAD, rateChangePerDayMax: 10n ** 16n, rateChangeCapacityMax: 5n * 10n ** 16n },
  extraData: "0xaabbcc",
  oracleSalt: `0x${"11".repeat(32)}`,
  swapFeePercentage: WAD,
  unwindSwapFeePercentage: 2n * WAD,
  enableJitMint: true,
};
const SAMPLE_PERMIT: PermitParams = { token: USDC, value: 123n, deadline: 1_800_000_000n, v: 27, r: `0x${"22".repeat(32)}`, s: `0x${"33".repeat(32)}` };
/** adapter.encodeExtraData({ market, enableJitMint: true }, [permit]) — the deployed 0.4.0 adapter's own bytes. */
const LIVE_EXTRA_DATA =
  "0x0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000009c6864105aec23388c89600046213a44c384c831000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000d5e8f76aafa20aa9a8983a35b71ad3a793070ed900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000001bc16d674ec80000000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000b1a2bc2ec5000000000000000000000000000000000000000000000000000000000000000001a011111111111111111111111111111111111111111111111111111111111111110000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000001bc16d674ec800000000000000000000000000000000000000000000000000000000000000000003aabbcc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000007b000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000000000000000000000000000000000000000001b22222222222222222222222222222222222222222222222222222222222222223333333333333333333333333333333333333333333333333333333333333333" as const;
/** adapter.encodeExtraData({ market, enableJitMint: false }, []). */
const LIVE_EXTRA_DATA_NO_PERMIT =
  "0x0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000009c6864105aec23388c89600046213a44c384c831000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000d5e8f76aafa20aa9a8983a35b71ad3a793070ed900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000001bc16d674ec80000000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000b1a2bc2ec5000000000000000000000000000000000000000000000000000000000000000001a011111111111111111111111111111111111111111111111111111111111111110000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000001bc16d674ec800000000000000000000000000000000000000000000000000000000000000000003aabbcc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" as const;
/** pm.getId(Market10{ sample pair/expiry/constraint, rateOracle = the NAV recipe address, fees 1e18/2e18 }) — the live 10-field pool manager. */
const LIVE_GET_ID = "0xf749ab18e2ca039a13f874ef8aff8bffcc18e618da6c8d8382538a5d85f0f7c3";
/** impairment.encodeExtraData(1e18, 604800, 10e18). */
const LIVE_IMPAIRMENT_EXTRA_DATA = "0x0000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000093a800000000000000000000000000000000000000000000000008ac7230489e80000";

const word = (data: string, i: number): string => `0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
/** Word i of a call's ABI body (after the 4-byte selector). */
const bodyWord = (calldata: string, i: number): string => word(`0x${calldata.slice(10)}`, i);

describe("nested wire — the deployed adapter's own bytes (golden, 42161 2026-09-22)", () => {
  it("encodeJitExtraData('nested') reproduces adapter.encodeExtraData byte for byte, with and without permits", () => {
    expect(encodeJitExtraData("nested", SAMPLE, [SAMPLE_PERMIT])).toBe(LIVE_EXTRA_DATA);
    expect(encodeJitExtraData("nested", { ...SAMPLE, enableJitMint: false }, [])).toBe(LIVE_EXTRA_DATA_NO_PERMIT);
    expect(WIRES.nested.encodeExtraData(SAMPLE, [SAMPLE_PERMIT])).toBe(LIVE_EXTRA_DATA);
  });

  it("decodeJitExtraData('nested') reads the live bytes back to the sample — the adapter's decodeExtraData answer, unwrapped", () => {
    const back = decodeJitExtraData("nested", LIVE_EXTRA_DATA);
    expect(diffJitExtraData({ params: SAMPLE, permits: [SAMPLE_PERMIT] }, back)).toEqual([]);
    expect(back.params.oracleSalt).toBe(SAMPLE.oracleSalt);
    expect(back.params.extraData).toBe("0xaabbcc");
    expect(back.params.enableJitMint).toBe(true);
    expect(back.permits).toEqual([SAMPLE_PERMIT]);
    const noPermit = decodeJitExtraData("nested", LIVE_EXTRA_DATA_NO_PERMIT);
    expect(noPermit.params.enableJitMint).toBe(false);
    expect(noPermit.permits).toEqual([]);
  });

  it("the salt sits at MarketParams index 7 — between the bytes offset and the fees — and the mint flag is the WRAPPER's second member", () => {
    // Outer: (wrapper offset 0x40, permits offset 0x260); wrapper: (market offset 0x40, enableJitMint 1).
    expect(word(LIVE_EXTRA_DATA, 0)).toBe(`0x${"40".padStart(64, "0")}`);
    expect(word(LIVE_EXTRA_DATA, 2)).toBe(`0x${"40".padStart(64, "0")}`);
    expect(BigInt(word(LIVE_EXTRA_DATA, 3))).toBe(1n); // enableJitMint, wrapper member 1
    // The market tuple starts at word 4: ca, ref, expiry, recipe, rateOverride, constraint×4 (5..8),
    // extraData offset (9), oracleSalt (10), swapFee (11), unwindFee (12).
    expect(word(LIVE_EXTRA_DATA, 4)).toBe(`0x${USDC.slice(2).toLowerCase().padStart(64, "0")}`);
    expect(word(LIVE_EXTRA_DATA, 4 + 10)).toBe(SAMPLE.oracleSalt);
    expect(BigInt(word(LIVE_EXTRA_DATA, 4 + 11))).toBe(WAD);
    expect(BigInt(word(LIVE_EXTRA_DATA, 4 + 12))).toBe(2n * WAD);
  });

  it("a flat decode of nested bytes never reads as the same params, and a nested decode of flat bytes never does either", () => {
    const flatBytes = encodeJitExtraData("flat", { ...SAMPLE, oracleSalt: undefined }, [SAMPLE_PERMIT]);
    expect(flatBytes).not.toBe(LIVE_EXTRA_DATA);
    const readNestedAsFlat = (): string[] | "threw" => {
      try {
        return diffJitExtraData({ params: SAMPLE, permits: [SAMPLE_PERMIT] }, decodeJitExtraData("flat", LIVE_EXTRA_DATA));
      } catch {
        return "threw";
      }
    };
    const readFlatAsNested = (): string[] | "threw" => {
      try {
        return diffJitExtraData({ params: SAMPLE, permits: [SAMPLE_PERMIT] }, decodeJitExtraData("nested", flatBytes));
      } catch {
        return "threw";
      }
    };
    for (const r of [readNestedAsFlat(), readFlatAsNested()]) expect(r === "threw" || r.length > 0).toBe(true);
    // decodeJitExtensionAny names the wire that read the bytes.
    const adapter = NESTED_MR.adapter as `0x${string}`;
    expect(decodeJitExtensionAny(buildJitExtension(adapter, LIVE_EXTRA_DATA)).wire).toBe("nested");
    expect(decodeJitExtensionAny(buildJitExtension(adapter, flatBytes)).wire).toBe("flat");
    expect(decodeJitExtension("nested", buildJitExtension(adapter, LIVE_EXTRA_DATA)).adapter).toBe(adapter);
  });

  it("the flat encoder refuses a non-zero oracleSalt (no field carries it); the zero salt is the same as no salt on both wires", () => {
    expect(() => encodeJitExtraData("flat", SAMPLE)).toThrow(/oracleSalt/);
    expect(encodeJitExtraData("nested", { ...SAMPLE, oracleSalt: undefined })).toBe(encodeJitExtraData("nested", { ...SAMPLE, oracleSalt: ZERO_ORACLE_SALT }));
    expect(diffJitExtraData({ params: { ...SAMPLE, oracleSalt: undefined }, permits: [] }, { params: { ...SAMPLE, oracleSalt: ZERO_ORACLE_SALT }, permits: [] })).toEqual([]);
    expect(diffJitExtraData({ params: SAMPLE, permits: [] }, { params: { ...SAMPLE, oracleSalt: ZERO_ORACLE_SALT }, permits: [] })).toEqual(["oracleSalt"]);
  });
});

describe("nested wire — the 10-field identity and the calls this build emits (selectors + word layouts)", () => {
  it("deriveJitMarket on the 10-field wire reproduces pm.getId — the fees ARE the id", () => {
    const d = deriveJitMarket({ collateralAsset: USDC, referenceAsset: BASEUSD, expiryTimestamp: 1_800_000_000n, constraint: SAMPLE.constraint, oracle: NAV_RECIPE, wire: "10-field", swapFeePercentage: WAD, unwindSwapFeePercentage: 2n * WAD });
    expect(d.poolId).toBe(LIVE_GET_ID);
    expect(d.wire).toBe("10-field");
    expect("swapFeePercentage" in d.market).toBe(true);
    // Different fees, different pool; the 8-field twin of the same legs is another id entirely.
    expect(deriveJitMarket({ collateralAsset: USDC, referenceAsset: BASEUSD, expiryTimestamp: 1_800_000_000n, constraint: SAMPLE.constraint, oracle: NAV_RECIPE, wire: "10-field", swapFeePercentage: 2n * WAD, unwindSwapFeePercentage: WAD }).poolId).not.toBe(LIVE_GET_ID);
    expect(deriveJitMarket({ collateralAsset: USDC, referenceAsset: BASEUSD, expiryTimestamp: 1_800_000_000n, constraint: SAMPLE.constraint, oracle: NAV_RECIPE }).poolId).not.toBe(LIVE_GET_ID);
    expect(computeMarketId({ ...d.market }, "10-field")).toBe(LIVE_GET_ID);
  });

  it("CorkMarketCreator.createNewPool(MarketParams) — selector 0x59c8eb4c; the salt is tuple word 10, the fees words 11/12", () => {
    const { enableJitMint: _flag, ...params } = SAMPLE;
    const data = buildCreatorCreatePoolCall("nested", params);
    expect(data.slice(0, 10)).toBe("0x59c8eb4c");
    expect(toFunctionSelector("createNewPool((address,address,uint256,address,uint256,(uint256,uint256,uint256,uint256),bytes,bytes32,uint256,uint256))")).toBe("0x59c8eb4c");
    // Body: word 0 = the tuple's head offset (0x20); the tuple's words follow.
    expect(BigInt(bodyWord(data, 0))).toBe(0x20n);
    expect(bodyWord(data, 1 + 0)).toBe(`0x${USDC.slice(2).toLowerCase().padStart(64, "0")}`);
    expect(bodyWord(data, 1 + 3)).toBe(`0x${SAMPLE.recipe.slice(2).toLowerCase().padStart(64, "0")}`);
    expect(BigInt(bodyWord(data, 1 + 5))).toBe(SAMPLE.constraint.rateMin);
    expect(BigInt(bodyWord(data, 1 + 8))).toBe(SAMPLE.constraint.rateChangeCapacityMax);
    expect(bodyWord(data, 1 + 10)).toBe(SAMPLE.oracleSalt);
    expect(BigInt(bodyWord(data, 1 + 11))).toBe(WAD);
    expect(BigInt(bodyWord(data, 1 + 12))).toBe(2n * WAD);
    const decoded = decodeFunctionData({ abi: marketCreatorNestedAbi, data });
    expect(decoded.functionName).toBe("createNewPool");
    expect(decoded.args[0]).toMatchObject({ collateralAsset: USDC, oracleSalt: SAMPLE.oracleSalt, extraData: "0xaabbcc", swapFeePercentage: WAD, unwindSwapFeePercentage: 2n * WAD });
    // The flat creator refuses the salt it cannot carry; the flat call is a different selector.
    expect(() => buildCreatorCreatePoolCall("flat", params)).toThrow(/oracleSalt/);
    expect(buildCreatorCreatePoolCall("flat", { ...params, oracleSalt: undefined }).slice(0, 10)).toBe("0xb6747077");
    expect(WIRES.nested.creatorCreatePoolCall(params)).toBe(data);
  });

  it("recipe.verify on the nested wire — selector 0x15bb9583; expiryTimestamp at word 3, creating at word 4, the constraint after them", () => {
    const args = { recipe: SAMPLE.recipe, collateralAsset: USDC, referenceAsset: BASEUSD, oracle: STUB_ORACLE as `0x${string}`, expiryTimestamp: 1_800_000_000n, creating: true, constraint: SAMPLE.constraint, extraData: "0xaabbcc" as const };
    const data = buildRecipeVerifyCall("nested", args);
    expect(data.slice(0, 10)).toBe("0x15bb9583");
    expect(toFunctionSelector("verify(address,address,address,uint256,bool,(uint256,uint256,uint256,uint256),bytes)")).toBe("0x15bb9583");
    expect(BigInt(bodyWord(data, 3))).toBe(1_800_000_000n);
    expect(BigInt(bodyWord(data, 4))).toBe(1n);
    expect(BigInt(bodyWord(data, 5))).toBe(SAMPLE.constraint.rateMin);
    expect(BigInt(bodyWord(data, 8))).toBe(SAMPLE.constraint.rateChangeCapacityMax);
    expect(BigInt(buildRecipeVerifyCall("nested", { ...args, creating: false }).slice(10).slice(4 * 64, 5 * 64).padStart(64, "0").replace(/^/, "0x"))).toBe(0n);
    // The flat verify is the five-arg form: a different selector, no expiry/creating words.
    expect(buildRecipeVerifyCall("flat", args).slice(0, 10)).toBe(toFunctionSelector("verify(address,address,address,(uint256,uint256,uint256,uint256),bytes)"));
  });

  it("MarketRegistry.deploy(ca, ref, mode, oracleSalt) — selector 0x5475abdc, the salt at word 3; flat deploy(3) refuses a non-zero salt", () => {
    const data = buildDeployOracleCall("nested", USDC, BASEUSD, "nav", SAMPLE.oracleSalt);
    expect(data.slice(0, 10)).toBe("0x5475abdc");
    expect(BigInt(bodyWord(data, 2))).toBe(1n); // OracleMode.NAV
    expect(bodyWord(data, 3)).toBe(SAMPLE.oracleSalt);
    expect(bodyWord(buildDeployOracleCall("nested", USDC, BASEUSD, "price"), 3)).toBe(ZERO_ORACLE_SALT);
    expect(buildDeployOracleCall("flat", USDC, BASEUSD, "price").slice(0, 10)).toBe("0x7f1d68cf");
    expect(buildDeployOracleCall("flat", USDC, BASEUSD, "price", ZERO_ORACLE_SALT)).toBe(buildDeployOracleCall("flat", USDC, BASEUSD, "price"));
    expect(() => buildDeployOracleCall("flat", USDC, BASEUSD, "price", SAMPLE.oracleSalt)).toThrow(/oracleSalt/);
  });

  it("DefaultCorkController.createNewPool((Market10, isWhitelistEnabled)) — selector 0xa0e0024d, the fees inside the Market (words 8/9), no fee arguments", () => {
    const d = deriveJitMarket({ collateralAsset: USDC, referenceAsset: BASEUSD, expiryTimestamp: 1_800_000_000n, constraint: SAMPLE.constraint, oracle: NAV_RECIPE, wire: "10-field", swapFeePercentage: WAD, unwindSwapFeePercentage: 2n * WAD });
    const data = buildCreatePoolCall("10-field", d.market);
    expect(data.slice(0, 10)).toBe("0xa0e0024d");
    // Static tuple: the ten Market words then the bool — no head offset.
    expect(BigInt(bodyWord(data, 8))).toBe(WAD);
    expect(BigInt(bodyWord(data, 9))).toBe(2n * WAD);
    expect(BigInt(bodyWord(data, 10))).toBe(0n); // isWhitelistEnabled false
    // Wire/shape refusals: a 10-field market on the 8-field controller and the reverse.
    expect(() => buildCreatePoolCall("8-field", d.market)).toThrow(/8-field controller/);
    const eight = deriveJitMarket({ collateralAsset: USDC, referenceAsset: BASEUSD, expiryTimestamp: 1_800_000_000n, constraint: SAMPLE.constraint, oracle: NAV_RECIPE }).market;
    expect(() => buildCreatePoolCall("10-field", eight)).toThrow(/10-field controller/);
    expect(buildCreatePoolCall("8-field", eight).slice(0, 10)).toBe("0xc2e8dc2f");
  });

  it("the impairment recipe's three-word extraData equals the deployed recipe's own encodeExtraData; the 0.5.0 recipes are catalogued", () => {
    expect(encodeImpairmentArgs({ anchorRate: WAD, durationSeconds: 604_800n, apySpreadPercentage: 10n * WAD })).toBe(LIVE_IMPAIRMENT_EXTRA_DATA);
    for (const addr of Object.values(NESTED_MR.recipes!)) expect(RECIPE_CATALOG[addr.toLowerCase()], addr).toBeDefined();
    expect(RECIPE_CATALOG[NESTED_MR.recipes!.impairment!.toLowerCase()]!.constants).toEqual(["CAPACITY_DAYS", "EXTRA_DATA_LENGTH", "MAX_APY_SPREAD_PERCENTAGE", "MAX_BAND_PERCENTAGE", "SECONDS_PER_YEAR"]);
    expect(RECIPE_CATALOG[NESTED_MR.recipes!.liquidity!.toLowerCase()]!.constants).toContain("RATE_MAX_PERCENTAGE");
    expect(RECIPE_CATALOG[NESTED_MR.recipes!.fixed!.toLowerCase()]!.args?.type).toBe("()");
  });

  it("the codec table: one row per implemented wire, the legacy wire refused; the role holder is the adapter (flat) and the creator (nested)", () => {
    expect(Object.keys(WIRES)).toEqual(["flat", "nested"]);
    expect(wireCodec("flat").roleHolder).toBe("adapter");
    expect(wireCodec("nested").roleHolder).toBe("creator");
    expect(wireCodec("nested").hasFeeCapView).toBe(false);
    expect(wireCodec("nested").bytesField).toBe("extraData");
    expect(wireCodec("flat").bytesField).toBe("additionalData");
    expect(() => wireCodec("legacy")).toThrow(/legacy/);
  });

  it("the two nested-wire MarketCreated topics are source-verified: pinned values, full decodes, and named in JIT_EVENTS", () => {
    expect(CREATOR_MARKET_CREATED_TOPIC).toBe("0x566120dd68ccf09e63c8d973b541997a96e57542cde725599ed6c10ded255aef");
    expect(POOL_MANAGER_MARKET_CREATED_10_TOPIC).toBe("0xd6ed59268acd885a5f5c3b08d31cba4c64aa369f08bae1b32cf1de63385170c7");
    expect(JIT_EVENTS[CREATOR_MARKET_CREATED_TOPIC]).toContain("CorkMarketCreator");
    expect(JIT_EVENTS[POOL_MANAGER_MARKET_CREATED_10_TOPIC]).toContain("10-field");
    const creatorEvent = parseAbiItem("event MarketCreated(bytes32 indexed poolId, address indexed rateOracle, address collateralAsset, address referenceAsset, uint256 expiryTimestamp, address recipe, uint256 swapFeePercentage, uint256 unwindSwapFeePercentage, address indexed caller)");
    const topics = encodeEventTopics({ abi: [creatorEvent], args: { poolId: LIVE_GET_ID, rateOracle: NAV_RECIPE, caller: NESTED_MR.adapter as `0x${string}` } });
    expect(topics[0]).toBe(CREATOR_MARKET_CREATED_TOPIC);
    const data = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [USDC, BASEUSD, 1_800_000_000n, SAMPLE.recipe, WAD, 2n * WAD]);
    const row = decodeKnownLog({ address: NESTED_MR.marketCreator as `0x${string}`, topics: topics as string[], data });
    expect(row.known).toBe(true);
    expect((row as { args: Record<string, unknown> }).args).toMatchObject({ poolId: LIVE_GET_ID, recipe: SAMPLE.recipe, swapFeePercentage: WAD.toString(), unwindSwapFeePercentage: (2n * WAD).toString() });
  });

  it("readRoleHolder on a 10-field controller asks for POOL_CREATOR alone (no fee-authority role exists there)", async () => {
    const asked: string[] = [];
    const client = {
      readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
        asked.push(a.functionName);
        if (a.functionName === "hasRole") return String(a.args?.[1]).toLowerCase() === (NESTED_MR.marketCreator as string).toLowerCase();
        if (a.functionName === "POOL_CREATOR_ROLE") return `0x${"ab".repeat(32)}`;
        throw new Error(`no ${a.functionName} on a 10-field controller`);
      },
    } as never;
    const creator = await readRoleHolder(client, PRIMARY.phoenix!.controller as `0x${string}`, NESTED_MR.marketCreator as `0x${string}`, { phoenixWire: "10-field" });
    expect(creator).toMatchObject({ hasCreator: true, hasSecond: true, granted: true });
    expect(creator.secondRole).toContain("no fee-authority role");
    expect(asked).not.toContain("FEE_MANAGER_ROLE");
    const adapter = await readRoleHolder(client, PRIMARY.phoenix!.controller as `0x${string}`, NESTED_MR.adapter as `0x${string}`, { phoenixWire: "10-field" });
    expect(adapter.granted).toBe(false); // the adapter holds nothing on the nested wire (live 2026-09-22)
  });
});

// ── Handler paths against the eval stub's nested stack (the 42161 primary) ──────────────────────
type Client = { readContract: (a: { functionName: string; args?: unknown[]; address?: string }) => Promise<unknown> } & Record<string, unknown>;
/** The eval stub with one client view replaced. */
function wrapped(patch: (client: Client) => Partial<Client>): HandlerContext {
  const base = stubContext();
  return {
    ...base,
    resolveRpc: async (chainId, url) => {
      const r = await base.resolveRpc!(chainId, url);
      if (!r) return r;
      const client = r.client as unknown as Client;
      return { ...r, client: { ...client, ...patch(client) } as never };
    },
  };
}
const makerJit = (ctx: HandlerContext, id: string, jm: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
  runTool("cork_prepare_orders", { chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: id, ...input, action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: CST, takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: "1000000000000000000", takingAmount: "50000000000000000", jitMarket: { ...JIT_TASK_PAIR, expiryTimestamp: EXPIRY, recipe: LIQUIDITY_RECIPE, ...jm } } }, ctx);

describe("the JIT maker path binds the PRIMARY (nested) generation", () => {
  it("builds a nested-wire extension at the 0.5.0 adapter: 10-field identity, verified round-trip, wire + generation echoed, salt carried", async () => {
    const env = await makerJit(stubContext(), "nested-maker-0001", { oracleSalt: SAMPLE.oracleSalt, swapFeePercentage: "1000000000000000000" });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { extension: `0x${string}`; jit: { adapter: string; wire: string; generation: string; derivedPoolId: string; extraDataLayout: string; constraint: Record<string, string>; predictedCorkSwapToken?: string } };
    expect(d.jit.adapter.toLowerCase()).toBe((NESTED_MR.adapter as string).toLowerCase());
    expect(d.jit).toMatchObject({ wire: "nested", generation: "phoenix/v0.4-rc.1" });
    expect(d.jit.extraDataLayout).toContain("verified-on-chain");
    const back = decodeJitExtension("nested", d.extension);
    expect(back.adapter.toLowerCase()).toBe((NESTED_MR.adapter as string).toLowerCase());
    expect(back.params.oracleSalt).toBe(SAMPLE.oracleSalt);
    expect(back.params.recipe.toLowerCase()).toBe(LIQUIDITY_RECIPE.toLowerCase());
    expect(back.params.swapFeePercentage).toBe(WAD);
    // The id is the 10-field one: fees inside the Market, hashed on the 10-field wire.
    const c = { rateMin: BigInt(d.jit.constraint.rateMin!), rateMax: BigInt(d.jit.constraint.rateMax!), rateChangePerDayMax: BigInt(d.jit.constraint.rateChangePerDayMax!), rateChangeCapacityMax: BigInt(d.jit.constraint.rateChangeCapacityMax!) };
    const expected = deriveJitMarket({ ...JIT_TASK_PAIR, expiryTimestamp: BigInt(EXPIRY), constraint: c, oracle: STUB_ORACLE as `0x${string}`, wire: "10-field", swapFeePercentage: WAD, unwindSwapFeePercentage: 0n }).poolId;
    expect(d.jit.derivedPoolId).toBe(expected);
    expect(d.jit.derivedPoolId).not.toBe(deriveJitMarket({ ...JIT_TASK_PAIR, expiryTimestamp: BigInt(EXPIRY), constraint: c, oracle: STUB_ORACLE as `0x${string}` }).poolId);
    expect(d.jit.predictedCorkSwapToken?.toLowerCase()).toBe(CST.toLowerCase());
    // The decode labels it by CLASSIFICATION: the primary's adapter → its generation, its wire.
    const built = env.data as { typedData: { message: Record<string, string> } };
    const decoded = await runTool("cork_decode", { kind: "order", chainId: 42161, data: { ...built.typedData.message, extension: d.extension } }, stubContext());
    expect(decoded.state).toBe("ok");
    const jit = (decoded.data as { jit: Record<string, unknown> }).jit;
    expect(jit).toMatchObject({ verification: "trusted", generation: "phoenix/v0.4-rc.1", wire: "nested", oracleSalt: SAMPLE.oracleSalt, extraData: "0x" });
    expect((jit["scales"] as Record<string, string>).swapFeePercentage).toContain("PART OF THE POOL ID");
  });

  it("the recipe-bytes alias: additionalData alone is accepted with a deprecation_notice; extraData + a DIFFERENT additionalData refuses as invalid input", async () => {
    const anchor = `0x${WAD.toString(16).padStart(64, "0")}` as const;
    const alias = await makerJit(stubContext(), "nested-maker-0002", { additionalData: anchor });
    expect(alias.state, JSON.stringify(alias.warnings)).toBe("ok");
    expect(alias.warnings.find((w) => w.code === "deprecation_notice")?.message).toContain("extraData");
    expect(decodeJitExtension("nested", (alias.data as { extension: `0x${string}` }).extension).params.extraData).toBe(anchor);
    const same = await makerJit(stubContext(), "nested-maker-0003", { additionalData: anchor, extraData: anchor });
    expect(same.state).toBe("ok");
    expect(same.warnings.some((w) => w.code === "deprecation_notice")).toBe(false);
    const err = await makerJit(stubContext(), "nested-maker-0004", { additionalData: anchor, extraData: "0xdead" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(JSON.stringify((err as ToolInputError).issues)).toContain("two spellings");
    expect(JSON.stringify((err as ToolInputError).issues)).toContain("jitMarket");
  });

  it("a non-zero oracleSalt on a FLAT-wire generation is refused as invalid input naming the generation (its deploy has no salt field)", async () => {
    const flat = { ...stubContext(), generation: FLAT.label };
    const err = await makerJit(flat, "nested-maker-0005", { oracleSalt: SAMPLE.oracleSalt, constraint: JIT_TASK_CONSTRAINT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(JSON.stringify((err as ToolInputError).issues)).toContain("oracleSalt");
    expect(JSON.stringify((err as ToolInputError).issues)).toContain(FLAT.label);
    // The zero salt is fine on flat (the same as no salt); the flat bytes stay flat.
    const zero = await makerJit(flat, "nested-maker-0006", { oracleSalt: ZERO_ORACLE_SALT, constraint: JIT_TASK_CONSTRAINT });
    expect(zero.state, JSON.stringify(zero.warnings)).toBe("ok");
    expect(decodeJitExtensionAny((zero.data as { extension: `0x${string}` }).extension).wire).toBe("flat");
    expect((zero.data as { jit: { wire: string } }).jit.wire).toBe("flat");
  });

  it("the input's `generation` label rides into ctx: naming the flat set on the INPUT builds flat bytes at the flat adapter", async () => {
    const env = await makerJit(stubContext(), "nested-maker-0007", { constraint: JIT_TASK_CONSTRAINT }, { generation: FLAT.label });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as { jit: { adapter: string; wire: string; generation: string } }).jit).toMatchObject({ wire: "flat", generation: FLAT.label });
    expect((env.data as { jit: { adapter: string } }).jit.adapter.toLowerCase()).toBe((FLAT.marketRegistry!.adapter as string).toLowerCase());
    const cfg = await runTool("cork_query", { resource: "protocol-config", chainId: 42161, generation: FLAT.label }, { nowSeconds: NOW });
    expect((cfg.data as { generation: { label: string } }).generation.label).toBe(FLAT.label);
  });

  it("the binding chain: the creator's MARKET_REGISTRY must be the configured registry and the adapter's MARKET_CREATOR the configured creator — either link broken is a conflict", async () => {
    const creator = (NESTED_MR.marketCreator as string).toLowerCase();
    const badRegistry = wrapped((client) => ({ readContract: async (a) => (a.functionName === "MARKET_REGISTRY" && String(a.address).toLowerCase() === creator ? "0x000000000000000000000000000000000000dEaD" : client.readContract(a)) }));
    const env = await makerJit(badRegistry, "nested-maker-0008");
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("adapter_binding_mismatch");
    expect(env.warnings[0]?.message).toContain("creator.MARKET_REGISTRY");
    const badCreator = wrapped((client) => ({ readContract: async (a) => (a.functionName === "MARKET_CREATOR" ? "0x000000000000000000000000000000000000dEaD" : client.readContract(a)) }));
    const env2 = await makerJit(badCreator, "nested-maker-0009");
    expect(env2.state).toBe("conflict");
    expect(env2.warnings[0]?.code).toBe("adapter_binding_mismatch");
  });

  it("the controller role is read on the CREATOR (the adapter holds none on the nested wire) — POOL_CREATOR alone", async () => {
    const creator = (NESTED_MR.marketCreator as string).toLowerCase();
    const seen: Array<[string, string]> = [];
    const onlyCreator = wrapped((client) => ({
      readContract: async (a) => {
        if (a.functionName === "hasRole") {
          seen.push([String(a.args?.[0]), String(a.args?.[1]).toLowerCase()]);
          return String(a.args?.[1]).toLowerCase() === creator;
        }
        return client.readContract(a);
      },
    }));
    const env = await makerJit(onlyCreator, "nested-maker-0010");
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(env.warnings.some((w) => w.code === "roles_not_granted")).toBe(false);
    expect(seen.every(([, account]) => account === creator)).toBe(true);
    expect(seen).toHaveLength(1); // POOL_CREATOR only — no FEE_MANAGER/CONFIGURATOR probe on a 10-field controller
    const onlyAdapter = wrapped((client) => ({ readContract: async (a) => (a.functionName === "hasRole" ? String(a.args?.[1]).toLowerCase() === (NESTED_MR.adapter as string).toLowerCase() : client.readContract(a)) }));
    const missing = await makerJit(onlyAdapter, "nested-maker-0011");
    expect(missing.state).toBe("ok");
    const w = missing.warnings.find((x) => x.code === "roles_not_granted");
    expect(w?.message).toContain("market creator");
    expect(w?.message).toContain("POOL_CREATOR: false");
  });

  it("recipe.verify is called on the seven-arg shape with the pool expiry and creating=true for a pool the manager does not know", async () => {
    let verifyArgs: readonly unknown[] | undefined;
    const spy = wrapped((client) => ({
      readContract: async (a) => {
        if (a.functionName === "verify") verifyArgs = a.args;
        return client.readContract(a);
      },
    }));
    const env = await makerJit(spy, "nested-maker-0012");
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(verifyArgs).toHaveLength(7);
    expect(verifyArgs![3]).toBe(BigInt(EXPIRY));
    expect(verifyArgs![4]).toBe(true);
    expect(verifyArgs![5]).toMatchObject({ rateMin: 1n });
    expect(verifyArgs![6]).toBe("0x");
  });

  it("the fee rule follows the phoenix wire: 99e18 builds on the 10-field primary, 100e18 refuses naming InvalidFees; the flat generation refuses above 5e18", async () => {
    const rule = await resolveFeeRule(42161, "adapter", stubContext());
    expect(rule).toMatchObject({ phoenixWire: "10-field", maxAllowed: 100n * WAD - 1n });
    const high = await makerJit(stubContext(), "nested-maker-0013", { swapFeePercentage: (99n * WAD).toString() });
    expect(high.state, JSON.stringify(high.warnings)).toBe("ok");
    const tooHigh = await makerJit(stubContext(), "nested-maker-0014", { swapFeePercentage: (100n * WAD).toString() });
    expect(tooHigh.state).toBe("unavailable");
    expect(tooHigh.warnings[0]?.code).toBe("invalid_order_terms");
    expect(tooHigh.warnings[0]?.message).toContain("InvalidFees");
    const flatHigh = await makerJit({ ...stubContext(), generation: FLAT.label }, "nested-maker-0015", { swapFeePercentage: (6n * WAD).toString(), constraint: JIT_TASK_CONSTRAINT });
    expect(flatHigh.state).toBe("unavailable");
    expect(flatHigh.warnings[0]?.message).toContain("5e18 (5%)");
  });

  it("decode dispatches by classification, never by trial: nested bytes at the FLAT adapter's address (or flat bytes at the nested one) get NO JIT label", async () => {
    const nestedBytes = encodeJitExtraData("nested", SAMPLE, []);
    const flatBytes = encodeJitExtraData("flat", { ...SAMPLE, oracleSalt: undefined }, []);
    const orderWith = async (extension: `0x${string}`) => {
      const { keccak256 } = await import("viem");
      const salt = (BigInt(keccak256(extension)) & ((1n << 160n) - 1n)) | (7n << 160n);
      return { salt: salt.toString(), maker: DEMO_ACCOUNT, receiver: DEMO_ACCOUNT, makerAsset: USDC, takerAsset: BASEUSD, makingAmount: "1", takingAmount: "1", makerTraits: "0", extension };
    };
    const wrongPlace = await runTool("cork_decode", { kind: "order", chainId: 42161, data: await orderWith(buildJitExtension(FLAT.marketRegistry!.adapter as `0x${string}`, nestedBytes)) }, { nowSeconds: NOW });
    expect(wrongPlace.state).toBe("ok");
    expect((wrongPlace.data as { jit?: unknown }).jit).toBeUndefined();
    const wrongPlace2 = await runTool("cork_decode", { kind: "order", chainId: 42161, data: await orderWith(buildJitExtension(NESTED_MR.adapter as `0x${string}`, flatBytes)) }, { nowSeconds: NOW });
    expect((wrongPlace2.data as { jit?: unknown }).jit).toBeUndefined();
    const rightPlace = await runTool("cork_decode", { kind: "order", chainId: 42161, data: await orderWith(buildJitExtension(NESTED_MR.adapter as `0x${string}`, nestedBytes)) }, { nowSeconds: NOW });
    expect((rightPlace.data as { jit: { wire: string; generation: string; verification: string } }).jit).toMatchObject({ wire: "nested", generation: "phoenix/v0.4-rc.1", verification: "trusted" });
  });
});

describe("cork_prepare_market on the nested primary", () => {
  const CA = JIT_TASK_PAIR.collateralAsset;
  const REF = JIT_TASK_PAIR.referenceAsset;

  it("create-pool builds the 0.5.0 creator's createNewPool(MarketParams) with extraData + oracleSalt, the 10-field id and the creator as `to`", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "nested-create-0001", action: { type: "create-pool", collateralAsset: CA, referenceAsset: REF, expiryTimestamp: EXPIRY, recipe: LIQUIDITY_RECIPE, oracleSalt: SAMPLE.oracleSalt, swapFeePercentage: "1000000000000000000" } }, stubContext());
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { to: string; calldata: `0x${string}`; wire: string; phoenixWire: string; generation: string; oracleSalt: string; pool: { poolId: string; exists: boolean }; constraint: Record<string, string>; scales: Record<string, string> };
    expect(d.to.toLowerCase()).toBe((NESTED_MR.marketCreator as string).toLowerCase());
    expect(d.calldata.slice(0, 10)).toBe("0x59c8eb4c");
    expect(d).toMatchObject({ wire: "nested", phoenixWire: "10-field", generation: "phoenix/v0.4-rc.1", oracleSalt: SAMPLE.oracleSalt });
    const decoded = decodeFunctionData({ abi: marketCreatorNestedAbi, data: d.calldata });
    expect(decoded.args[0]).toMatchObject({ oracleSalt: SAMPLE.oracleSalt, swapFeePercentage: WAD, unwindSwapFeePercentage: 0n, extraData: "0x" });
    const c = { rateMin: BigInt(d.constraint.rateMin!), rateMax: BigInt(d.constraint.rateMax!), rateChangePerDayMax: BigInt(d.constraint.rateChangePerDayMax!), rateChangeCapacityMax: BigInt(d.constraint.rateChangeCapacityMax!) };
    expect(d.pool.poolId).toBe(deriveJitMarket({ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: BigInt(EXPIRY), constraint: c, oracle: STUB_ORACLE as `0x${string}`, wire: "10-field", swapFeePercentage: WAD, unwindSwapFeePercentage: 0n }).poolId);
    expect(d.pool.exists).toBe(false);
    expect(d.scales.swapFeePercentage).toContain("PART OF THE 10-field POOL ID");
    expect(env.warnings.some((w) => w.code === "roles_not_granted")).toBe(false);
  });

  it("deploy-oracle carries the salt on the nested wire (selector 0x5475abdc) and refuses a non-zero salt on the flat generation", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "nested-deploy-0001", action: { type: "deploy-oracle", collateralAsset: CA, referenceAsset: REF, mode: "nav", oracleSalt: SAMPLE.oracleSalt } }, stubContext());
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { calldata: `0x${string}`; to: string; oracleSalt: string; wire: string };
    expect(d.calldata.slice(0, 10)).toBe("0x5475abdc");
    expect(bodyWord(d.calldata, 3)).toBe(SAMPLE.oracleSalt);
    expect(d).toMatchObject({ wire: "nested", oracleSalt: SAMPLE.oracleSalt });
    expect(d.to.toLowerCase()).toBe(NESTED_MR.registry.toLowerCase());
    const flat = await runTool("cork_prepare_market", { chainId: 42161, generation: FLAT.label, clientRequestId: "nested-deploy-0002", action: { type: "deploy-oracle", collateralAsset: CA, referenceAsset: REF, mode: "nav", oracleSalt: SAMPLE.oracleSalt } }, stubContext()).catch((e: unknown) => e);
    expect(flat).toBeInstanceOf(ToolInputError);
    const flatZero = await runTool("cork_prepare_market", { chainId: 42161, generation: FLAT.label, clientRequestId: "nested-deploy-0003", action: { type: "deploy-oracle", collateralAsset: CA, referenceAsset: REF, mode: "nav" } }, stubContext());
    expect((flatZero.data as { calldata: string }).calldata.slice(0, 10)).toBe("0x7f1d68cf");
  });
});

describe("cork_query registry-* and derive-cork-pool on the nested primary", () => {
  const ctx = stubContext();

  it("registry-denominations lists unit ADDRESSES with best-effort symbols; filters.label refuses with teaching (→ filters.address); filters.address looks one up", async () => {
    const list = await runTool("cork_query", { resource: "registry-denominations", chainId: 42161 }, ctx);
    expect(list.state, JSON.stringify(list.warnings)).toBe("ok");
    const d = list.data as { keyedBy: string; wire: string; items: Array<{ unit: string; symbol: string | null; name: string | null; labelSource: string | null }> };
    expect(d.keyedBy).toBe("unit address");
    expect(d.wire).toBe("nested");
    expect(d.items.map((i) => i.symbol)).toEqual(["USD", "ETH"]); // the pseudo-unit table
    expect(d.items[0]!.unit.toLowerCase()).toBe("0x0000000000000000000000000000000000000348");
    const byLabel = await runTool("cork_query", { resource: "registry-denominations", chainId: 42161, filters: { label: "USD" } }, ctx);
    expect(byLabel.state).toBe("unavailable");
    expect(byLabel.warnings[0]?.code).toBe("missing_filter");
    expect(byLabel.warnings[0]?.message).toContain("filters.address");
    const byAddress = await runTool("cork_query", { resource: "registry-denominations", chainId: 42161, filters: { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" } }, ctx);
    expect(byAddress.state, JSON.stringify(byAddress.warnings)).toBe("ok");
    expect((byAddress.data as { items: Array<{ symbol: string }> }).items[0]!.symbol).toBe("ETH");
    const unknown = await runTool("cork_query", { resource: "registry-denominations", chainId: 42161, filters: { address: DEMO_ACCOUNT } }, ctx);
    expect(unknown.warnings[0]?.code).toBe("denomination_not_found");
    // The flat generation keeps its label→unit records (labelHash is the identity there).
    const flat = await runTool("cork_query", { resource: "registry-denominations", chainId: 42161, generation: FLAT.label }, ctx);
    expect(flat.state, JSON.stringify(flat.warnings)).toBe("ok");
    expect((flat.data as { items: Array<{ labelHash: string; label: string }> }).items[0]).toMatchObject({ label: "USD" });
    const flatByAddress = await runTool("cork_query", { resource: "registry-denominations", chainId: 42161, generation: FLAT.label, filters: { address: DEMO_ACCOUNT } }, ctx);
    expect(flatByAddress.warnings[0]?.message).toContain("filters.label");
  });

  it("registry-recipes on the primary lists the 0.5.0 recipes with their catalogued constants", async () => {
    const env = await runTool("cork_query", { resource: "registry-recipes", chainId: 42161, filters: { recipe: IMPAIRMENT_RECIPE } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const item = (env.data as { items: Array<{ address: string; constants: Record<string, string>; argsKnown: boolean }> }).items[0]!;
    expect(item.address.toLowerCase()).toBe(IMPAIRMENT_RECIPE.toLowerCase());
    expect(item.argsKnown).toBe(true);
    expect(item.constants).toMatchObject({ EXTRA_DATA_LENGTH: "96", MAX_BAND_PERCENTAGE: (50n * WAD).toString(), CAPACITY_DAYS: "7" });
  });

  it("derive-cork-pool takes the fees and the salt: a 10-field id that moves with the fee, echoed wire + generation; the salt is refused non-zero on the flat set", async () => {
    const CA = JIT_TASK_PAIR.collateralAsset;
    const REF = JIT_TASK_PAIR.referenceAsset;
    const plain = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, filters: { collateralAsset: CA, referenceAsset: REF, expiry: EXPIRY, recipe: LIQUIDITY_RECIPE } }, ctx);
    expect(plain.state, JSON.stringify(plain.warnings)).toBe("ok");
    const p = plain.data as { input: { wire: string; phoenixWire: string; generation: string; oracleSalt: string; swapFeePercentage: string }; pool: { poolId: string; wire: string; swapFeePercentage: string; constraint: Record<string, string> } };
    expect(p.input).toMatchObject({ wire: "nested", phoenixWire: "10-field", generation: "phoenix/v0.4-rc.1", oracleSalt: ZERO_ORACLE_SALT, swapFeePercentage: "0" });
    expect(p.pool.wire).toBe("10-field");
    const c = { rateMin: BigInt(p.pool.constraint.rateMin!), rateMax: BigInt(p.pool.constraint.rateMax!), rateChangePerDayMax: BigInt(p.pool.constraint.rateChangePerDayMax!), rateChangeCapacityMax: BigInt(p.pool.constraint.rateChangeCapacityMax!) };
    expect(p.pool.poolId).toBe(deriveJitMarket({ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: BigInt(EXPIRY), constraint: c, oracle: STUB_ORACLE as `0x${string}`, wire: "10-field" }).poolId);
    const withFee = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, filters: { collateralAsset: CA, referenceAsset: REF, expiry: EXPIRY, recipe: LIQUIDITY_RECIPE, swapFeePercentage: "1000000000000000000", oracleSalt: SAMPLE.oracleSalt } }, ctx);
    expect(withFee.state, JSON.stringify(withFee.warnings)).toBe("ok");
    const f = withFee.data as { pool: { poolId: string; swapFeePercentage: string }; input: { oracleSalt: string } };
    expect(f.pool.poolId).toBe(deriveJitMarket({ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: BigInt(EXPIRY), constraint: c, oracle: STUB_ORACLE as `0x${string}`, wire: "10-field", swapFeePercentage: WAD }).poolId);
    expect(f.pool.poolId).not.toBe(p.pool.poolId);
    expect(f.pool.swapFeePercentage).toBe(WAD.toString());
    expect(f.input.oracleSalt).toBe(SAMPLE.oracleSalt);
    // (The stub approves the primary's recipe addresses on every generation — the flat derive
    // below exercises the 8-field path with the same recipe address.)
    const flatSalt = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, generation: FLAT.label, filters: { collateralAsset: CA, referenceAsset: REF, expiry: EXPIRY, recipe: LIQUIDITY_RECIPE, oracleSalt: SAMPLE.oracleSalt } }, ctx);
    expect(flatSalt.state).toBe("unavailable");
    expect(flatSalt.warnings[0]?.message).toContain("oracleSalt");
    // The flat set derives the 8-field id (fees outside) — a different pool from the same legs.
    const flat = await runTool("cork_query", { resource: "derive-cork-pool", chainId: 42161, generation: FLAT.label, filters: { collateralAsset: CA, referenceAsset: REF, expiry: EXPIRY, recipe: LIQUIDITY_RECIPE } }, ctx);
    expect(flat.state, JSON.stringify(flat.warnings)).toBe("ok");
    expect((flat.data as { pool: { wire: string } }).pool.wire).toBe("8-field");
    expect((flat.data as { input: { generation: string } }).input.generation).toBe(FLAT.label);
  });

  it("registry-oracle takes the salt on the nested wire (echoed with its note) and refuses it non-zero on the flat set", async () => {
    const env = await runTool("cork_query", { resource: "registry-oracle", chainId: 42161, filters: { collateralAsset: JIT_TASK_PAIR.collateralAsset, referenceAsset: JIT_TASK_PAIR.referenceAsset, mode: "nav", oracleSalt: SAMPLE.oracleSalt } }, ctx);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as { oracleSalt: string; oracleSaltNote: string }).oracleSalt).toBe(SAMPLE.oracleSalt);
    expect((env.data as { oracleSaltNote: string }).oracleSaltNote).toContain("FIRST wrapper");
    const flat = await runTool("cork_query", { resource: "registry-oracle", chainId: 42161, generation: FLAT.label, filters: { collateralAsset: JIT_TASK_PAIR.collateralAsset, referenceAsset: JIT_TASK_PAIR.referenceAsset, oracleSalt: SAMPLE.oracleSalt } }, ctx);
    expect(flat.state).toBe("unavailable");
    expect(flat.warnings[0]?.message).toContain("oracleSalt");
  });
});
