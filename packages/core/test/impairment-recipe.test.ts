// The fourth recipe — ApySpreadImpairmentRecipe (market-registry 0.4.0, deployed 2026-08-31 at
// 0x7340BfbE… on both chains and approved on the CURRENT 0.3.3-generation registry; the 0.4.0
// release moved no registry/adapter address, and the later 0.4-rc.1 shadow deployment set is
// deliberately NOT adopted). Offline coverage: the args encoder's exact bytes, the catalog's
// teaching, the error ABI's naming power over the recipe's typed reverts, the mode sugar, and
// the refusal teaching. The wei-exact resolve parity against the DEPLOYED recipe rides the
// CORK_RPC_LIVE suite (impairment-recipe-live.test.ts).
import { describe, expect, it } from "vitest";
import { decodeErrorResult, encodeErrorResult } from "viem";
import { encodeImpairmentArgs, RECIPE_CATALOG, recipeAbi, runTool, ToolInputError } from "@cork/core";
import type { HandlerContext } from "../src/handlers/shared.ts";
import { stubRpc, type StubCall } from "./helpers.ts";

const IMP = "0x7340BfbEdF3657a7bBCe0dD2b4ab205754cc9eCA" as const;
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" as const;
const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ORACLE = "0x00000000000000000000000000000000000000e1" as const;
const DAY = 86_400n;

describe("encodeImpairmentArgs — the 96-byte three-word contract, byte-pinned", () => {
  it("golden bytes: anchor 1.0, 30 days, 10%/year — word order anchor|duration|spread", () => {
    const hex = encodeImpairmentArgs({ anchorRate: 10n ** 18n, durationSeconds: 30n * DAY, apySpreadPercentage: 10n * 10n ** 18n });
    expect(hex).toBe(
      "0x" +
        "0000000000000000000000000000000000000000000000000de0b6b3a7640000" + // 1e18 — the RATE scale anchor
        "0000000000000000000000000000000000000000000000000000000000278d00" + // 2 592 000 s = 30 days
        "0000000000000000000000000000000000000000000000008ac7230489e80000", // 10e18 = 10% on the 1e18 = 1% scale
    );
    expect((hex.length - 2) / 2).toBe(96); // exactly three ABI words — _decode rejects anything else
  });
});

describe("cork-defaults.v2 — the impairment hint rides BOTH chains' recipe maps of the flat-wire (0.3.3) generation", () => {
  it("42161 and 8453 both hint 'impairment' at the deployed address (identical CREATE2 address)", async () => {
    const { BUNDLED_DEFAULTS, generationsOf, marketRegistryForWire } = await import("@cork/core");
    for (const chain of [42161, 8453]) {
      const flat = marketRegistryForWire(generationsOf(BUNDLED_DEFAULTS, chain), "flat");
      expect(flat?.marketRegistry?.recipes?.["impairment"]?.toLowerCase(), `chain ${chain}`).toBe(IMP.toLowerCase());
    }
  });
});

describe("RECIPE_CATALOG — the impairment entry teaches the scales", () => {
  const entry = RECIPE_CATALOG[IMP.toLowerCase()];
  it("constants and args are catalogued; the display names both scale hazards and the byte length", () => {
    expect(entry).toBeDefined();
    expect(entry!.constants).toEqual(["SECONDS_PER_YEAR", "CAPACITY_DAYS"]);
    expect(entry!.args?.type).toBe("(uint256,uint256,uint256)");
    expect(entry!.args?.display).toContain("96 bytes");
    expect(entry!.args?.display).toContain("1e18 = 1%");
    expect(entry!.args?.display).toContain("1e18 = 1.0");
    expect(entry!.args?.display).toContain("encodeImpairmentArgs");
  });
});

describe("recipeAbi — the impairment recipe's typed reverts decode BY NAME", () => {
  // The naming power is what recipe_refused rides: viem decodes a revert only when the ABI
  // carries the error. Round-trip every variant so a dropped entry fails on its own name.
  const cases = [
    { errorName: "MalformedAdditionalData", args: [64n] },
    { errorName: "ZeroAnchorRate", args: [] },
    { errorName: "ZeroDuration", args: [] },
    { errorName: "DurationTooLong", args: [90n * DAY, 30n * DAY] },
    { errorName: "BandTooWide", args: [150n * 10n ** 18n] },
    { errorName: "WindowCollapsed", args: [0n, 2n * 10n ** 18n] },
    { errorName: "RateOracleNotDeployed", args: [CA, REF] },
  ] as const;
  for (const c of cases) {
    it(`${c.errorName} round-trips through the shared recipe ABI`, () => {
      const data = encodeErrorResult({ abi: recipeAbi, errorName: c.errorName, args: c.args as never });
      const decoded = decodeErrorResult({ abi: recipeAbi, data });
      expect(decoded.errorName).toBe(c.errorName);
    });
  }
});

describe("the generic read/resolve machinery serves the fourth recipe", () => {
  // The 0.4.0 impairment recipe is approved on the FLAT (0.3.3) registry — the ctx names that
  // generation (the primary's nested 0.5.0 set carries its own impairment recipe address).
  const ctx = (handler: (c: StubCall) => unknown): HandlerContext => ({ nowSeconds: 1_790_000_000n, generation: "cork/v0.3", resolveRpc: stubRpc(handler) });
  const metaStub = (c: StubCall): unknown => {
    switch (c.functionName) {
      case "isRecipe":
        return true;
      case "MARKET_REGISTRY":
        return "0xa78d8137B01058dD23e545b6557209eBBc9611F1"; // the adapter binding guard's read
      case "REGISTRY":
        return "0xa78d8137B01058dD23e545b6557209eBBc9611F1";
      case "source":
        return 0; // RecipeSource.NAV — the ordinal the deployed recipe returns
      case "description":
        return "Impairment: the rate window is the anchor plus or minus apySpreadPercentage * durationSeconds / 365 days of it";
      case "SECONDS_PER_YEAR":
        return 365n * DAY;
      case "CAPACITY_DAYS":
        return 7n;
      default:
        return undefined;
    }
  };

  it("registry-recipes single lookup: source nav, both constants read live, argsKnown with the three-word type", async () => {
    const env = await runTool("cork_query", { chainId: 8453, resource: "registry-recipes", filters: { recipe: IMP } }, ctx((c) => {
      const meta = metaStub(c);
      if (meta !== undefined) return meta;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const item = (env.data as { items: Array<{ address: string; source: string; argsKnown: boolean; args: { type: string; display: string }; constants: Record<string, string> }> }).items[0]!;
    expect(item.address.toLowerCase()).toBe(IMP.toLowerCase());
    expect(item.source).toBe("nav");
    expect(item.argsKnown).toBe(true);
    expect(item.args.type).toBe("(uint256,uint256,uint256)");
    expect(item.constants["SECONDS_PER_YEAR"]).toBe((365n * DAY).toString());
    expect(item.constants["CAPACITY_DAYS"]).toBe("7");
  });

  it("mode sugar 'impairment' resolves the config hint to the deployed address, with the deprecation_notice", async () => {
    const env = await runTool("cork_query", { chainId: 8453, resource: "registry-recipes", filters: { mode: "impairment" } }, ctx((c) => {
      if (c.functionName === "isRecipe") {
        expect(String(c.args?.[0]).toLowerCase()).toBe(IMP.toLowerCase());
        return true;
      }
      const meta = metaStub(c);
      if (meta !== undefined) return meta;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    expect((env.data as { items: Array<{ address: string }> }).items[0]?.address.toLowerCase()).toBe(IMP.toLowerCase());
    expect(env.warnings.some((w) => w.code === "deprecation_notice")).toBe(true);
  });

  it("argsUints encodes the decimal words INTO the resolve staticcall — byte-identical to the hex path, no hand-built hex", async () => {
    const seen: string[] = [];
    const handler = (c: StubCall): unknown => {
      if (c.functionName === "lookupWrapper") return ZERO;
      if (c.functionName === "simulate:deploy") return ORACLE;
      if (c.functionName === "resolve") {
        seen.push(String(c.args?.[3] ?? ""));
        return { rateMin: 1n, rateMax: 2n * 10n ** 18n, rateChangePerDayMax: 10n ** 15n, rateChangeCapacityMax: 7n * 10n ** 15n };
      }
      const meta = metaStub(c);
      if (meta !== undefined) return meta;
      throw new Error(`unexpected ${c.functionName}`);
    };
    const base = { chainId: 8453, params: { kind: "recipe-rate-constraint", recipe: IMP, collateralAsset: CA, referenceAsset: REF } } as const;
    const viaWords = await runTool("cork_compute", { ...base, params: { ...base.params, argsUints: ["1000000000000000000", "604800", "10000000000000000000"] } }, ctx(handler));
    expect(viaWords.state).toBe("ok");
    const viaHex = await runTool("cork_compute", { ...base, params: { ...base.params, args: encodeImpairmentArgs({ anchorRate: 10n ** 18n, durationSeconds: 604_800n, apySpreadPercentage: 10n * 10n ** 18n }) } }, ctx(handler));
    expect(viaHex.state).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]); // the two spellings reach the recipe as the SAME bytes
    expect((seen[0]!.length - 2) / 2).toBe(96);
  });

  it("args and argsUints together are refused — they race for the same additionalData", async () => {
    await expect(
      runTool("cork_compute", { chainId: 8453, params: { kind: "recipe-rate-constraint", recipe: IMP, collateralAsset: CA, referenceAsset: REF, args: "0x00", argsUints: ["1"] } }, ctx(() => 0n)),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("a refusal while the oracle is undeployed teaches the impairment shape: 96 bytes, three words, the encoder's name", async () => {
    const env = await runTool("cork_query", { chainId: 8453, resource: "derive-cork-pool", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", recipe: IMP } }, ctx((c) => {
      if (c.functionName === "lookupWrapper") return ZERO;
      if (c.functionName === "simulate:deploy") return ORACLE;
      if (c.functionName === "resolve") throw new Error("execution reverted: MalformedAdditionalData(0)");
      const meta = metaStub(c);
      if (meta !== undefined) return meta;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_refused");
    expect(env.warnings[0]?.message).toContain("MalformedAdditionalData");
    expect(env.warnings[0]?.message).toContain("96 bytes");
    expect(env.warnings[0]?.message).toContain("encodeImpairmentArgs");
  });
});
