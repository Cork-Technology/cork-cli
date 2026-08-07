// MarketRegistry + JIT adapter integration, contracts release 2.1.0: extension bytes pinned
// against the adapter's JITMarketParams layout, market identity as a pure function of the
// CARRIED constraint (pinned at signing — the 2.1.0 redesign), and the handler paths offline
// via injected RPC stubs. Live parity runs env-gated in rpc-live.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import {
  buildDeployFixedRateOracleCall,
  buildDeployOracleCall,
  buildJitExtension,
  decodeJitExtension,
  deriveJitMarket,
  encodeJitExtraData,
  JIT_EVENTS,
  JIT_MARKET_CREATED_LEGACY_TOPIC,
  JIT_MARKET_CREATED_TOPIC,
  JIT_MINTED_TOPIC,
  marketRegistryAbi,
  POOL_CREATOR_ROLE,
  resetRegistryBindingGuardCache,
  roleMemberSlot,
  runTool,
  type HandlerContext,
  type ResolvedConstraint,
} from "@cork/core";
import { stubRpc, type StubCall } from "./helpers.ts";

const WAD = 10n ** 18n;
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"; // sUSDe (registered on Arbitrum)
const REF = "0x7F6501d3B98eE91f9b9535E4b0ac710Fb0f9e0bc"; // waArbUSDCn (the captured ground-truth pair)
const ACCT = "0xc0ffee0000000000000000000000000000000001";
// The 2.1.0 deployment set (cork-defaults.json, verified on-chain 2026-08-03).
const REG = "0x47C3AF38435Db64D9400c30575E4c10482c0752D";
const ADAPTER = "0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B";
const CONTROLLER = "0xdCC0388c68f85e65FA08dCb445B4d0927e9E6172";
const LIQ = "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D";
const ZERO = "0x0000000000000000000000000000000000000000";
const ORACLE = "0x00000000000000000000000000000000000000fe";

const CONSTRAINT: ResolvedConstraint = { rateMin: WAD / 100n, rateMax: 2n * WAD, rateChangePerDayMax: WAD, rateChangeCapacityMax: 3n * WAD };
const CONSTRAINT_WIRE = { rateMin: CONSTRAINT.rateMin.toString(), rateMax: CONSTRAINT.rateMax.toString(), rateChangePerDayMax: CONSTRAINT.rateChangePerDayMax.toString(), rateChangeCapacityMax: CONSTRAINT.rateChangeCapacityMax.toString() };

beforeEach(() => resetRegistryBindingGuardCache());

describe("JIT extension bytes (2.1.0 JITMarketParams: recipe + carried constraint)", () => {
  const params = {
    collateralAsset: CA,
    referenceAsset: REF,
    expiryTimestamp: 1795000000n,
    recipe: LIQ,
    rateOverride: 0n,
    constraint: CONSTRAINT,
    additionalData: "0x" as const,
    swapFeePercentage: 0n,
    unwindSwapFeePercentage: 0n,
    enableJitMint: true,
  } as const;

  it("round-trips through the ExtensionLib offset table (preInteraction = field 6)", () => {
    const back = decodeJitExtension(buildJitExtension(ADAPTER, encodeJitExtraData(params, [])));
    expect(back.adapter).toBe(ADAPTER);
    expect(back.params).toEqual(params);
    expect(back.permits).toEqual([]);
  });

  it("carries permits and preserves their fields exactly", () => {
    const permit = { token: CA, value: 42n, deadline: 1795000000n, v: 27, r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}` } as const;
    const back = decodeJitExtension(buildJitExtension(ADAPTER, encodeJitExtraData(params, [permit])));
    expect(back.permits).toEqual([permit]);
  });

  it("the extraData tail is exactly abi.encode(JITMarketParams, PermitParams[]) in the adapter's field ORDER", () => {
    const extra = encodeJitExtraData(params, []);
    // Decode with an independently-authored parameter list — guards the tuple field ORDER
    // (collateralAsset, referenceAsset, expiryTimestamp, recipe, rateOverride, constraint,
    // additionalData, swapFee, unwindFee, enableJitMint), matching CorkLimitOrderAdapter.sol.
    const [p] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "collateralAsset", type: "address" },
            { name: "referenceAsset", type: "address" },
            { name: "expiryTimestamp", type: "uint256" },
            { name: "recipe", type: "address" },
            { name: "rateOverride", type: "uint256" },
            { name: "constraint", type: "tuple", components: [{ name: "rateMin", type: "uint256" }, { name: "rateMax", type: "uint256" }, { name: "rateChangePerDayMax", type: "uint256" }, { name: "rateChangeCapacityMax", type: "uint256" }] },
            { name: "additionalData", type: "bytes" },
            { name: "swapFeePercentage", type: "uint256" },
            { name: "unwindSwapFeePercentage", type: "uint256" },
            { name: "enableJitMint", type: "bool" },
          ],
        },
        { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
      ],
      extra,
    ) as unknown as [{ recipe: string; constraint: { rateMax: bigint }; enableJitMint: boolean }, unknown[]];
    expect(p.recipe).toBe(LIQ);
    expect(p.constraint.rateMax).toBe(2n * WAD);
    expect(p.enableJitMint).toBe(true);
  });

  it("event topics: the 2.1.0 JITMarketCreated (recipe address) differs from the legacy one (mode string); both stay decodable", () => {
    expect(JIT_MARKET_CREATED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JIT_MARKET_CREATED_TOPIC).not.toBe(JIT_MARKET_CREATED_LEGACY_TOPIC);
    expect(JIT_EVENTS[JIT_MARKET_CREATED_TOPIC]).toBe("JITMarketCreated");
    expect(JIT_EVENTS[JIT_MARKET_CREATED_LEGACY_TOPIC]).toContain("legacy");
    expect(JIT_EVENTS[JIT_MINTED_TOPIC]).toBe("JITMinted");
  });
});

describe("deriveJitMarket (2.1.0): identity is a pure function of the CARRIED constraint", () => {
  it("same constraint → same poolId regardless of any rate; different constraint → different id", () => {
    const base = { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1795000000n, oracle: ACCT } as const;
    const a = deriveJitMarket({ ...base, constraint: CONSTRAINT });
    const b = deriveJitMarket({ ...base, constraint: CONSTRAINT });
    const c = deriveJitMarket({ ...base, constraint: { ...CONSTRAINT, rateMax: 3n * WAD } });
    expect(a.poolId).toBe(b.poolId);
    expect(a.poolId).not.toBe(c.poolId);
    expect(a.market.rateOracle).toBe(ACCT);
  });

  it("maps every constraint field to its OWN Market slot (mutation killer: the captured GT has perDay == capacity, so a field-cross was invisible to it)", () => {
    // Four DISTINCT values — any crossed assignment changes both the struct echo and the id.
    const distinct: ResolvedConstraint = { rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n };
    const d = deriveJitMarket({ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 5n, constraint: distinct, oracle: ACCT });
    expect(d.market.rateMin).toBe(1n);
    expect(d.market.rateMax).toBe(2n);
    expect(d.market.rateChangePerDayMax).toBe(3n);
    expect(d.market.rateChangeCapacityMax).toBe(4n);
    // Independent id: keccak256(abi.encode(Market)) authored here from the pinned field order,
    // not via computeMarketId — kills any silent re-ordering inside the derivation path.
    const independent = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }],
        [CA, REF, 5n, 1n, 2n, 3n, 4n, ACCT],
      ),
    );
    expect(d.poolId).toBe(independent);
  });

  // The Market struct + hash are UNCHANGED across generations, so the ground truth captured
  // 2026-07-24 from the live API still pins our derivation: feeding the resolved constraint the
  // old fill would have computed must yield the identical pool id.
  it("reproduces the captured live pool_id bit-for-bit from the constraint alone", () => {
    const d = deriveJitMarket({
      collateralAsset: CA,
      referenceAsset: REF,
      expiryTimestamp: 1900000000n,
      constraint: { rateMin: 8062338796602994n, rateMax: 1612467759320598742n, rateChangePerDayMax: 806233879660299371n, rateChangeCapacityMax: 806233879660299371n },
      oracle: "0x2ba2103a37c4cff9dbb96e6f74513923d960d757",
    });
    expect(d.poolId).toBe("0xda9325fad061bbcaa92fdec93d81398ca31ad1494c16ac658b9cc67079078c75");
  });
});

describe("roleMemberSlot (plain OZ AccessControl mapping at slot 0)", () => {
  it("matches an independently-constructed abi.encode layout", () => {
    const pad = (a: string) => "00".repeat(12) + a.replace(/^0x/, "").toLowerCase();
    const inner = keccak256(`0x${POOL_CREATOR_ROLE.replace(/^0x/, "")}${"00".repeat(32)}`);
    const expected = keccak256(`0x${pad(ADAPTER)}${inner.replace(/^0x/, "")}`);
    expect(roleMemberSlot(POOL_CREATOR_ROLE, ADAPTER)).toBe(expected);
  });
});

// ── handler paths (offline; injected RPC stub answering registry views) ─────
// Shared stub base: the binding guard reads the adapter's MARKET_REGISTRY() first.
const withBinding = (handler: (c: StubCall) => unknown) => (c: StubCall) => {
  if (c.functionName === "MARKET_REGISTRY" && c.address.toLowerCase() === ADAPTER.toLowerCase()) return REG;
  return handler(c);
};

const recipeMetaStub = (c: StubCall): unknown => {
  if (c.functionName === "source") return 1; // RecipeSource.PRICE
  if (c.functionName === "description") return "Liquidity: the widest rate window …";
  if (c.functionName === "REGISTRY") return REG;
  if (c.functionName === "RATE_MIN") return 1n;
  if (c.functionName === "RATE_MIN_PERCENTAGE") return 100n * WAD;
  if (c.functionName === "RATE_MAX_PERCENTAGE") return 100n * WAD;
  if (c.functionName === "RATE_CHANGE_PER_DAY_MAX_PERCENTAGE") return 100n * WAD;
  if (c.functionName === "RATE_CHANGE_CAPACITY_MAX_PERCENTAGE") return 300n * WAD;
  return undefined;
};

describe("cork_query registry-* (2.1.0 chain views)", () => {
  const ctx = (handler: (c: StubCall) => unknown, opts?: Parameters<typeof stubRpc>[1]): HandlerContext => ({ nowSeconds: 1_790_000_000n, resolveRpc: stubRpc(withBinding(handler), opts) });

  it("registry-recipes lists recipe CONTRACTS with live self-description + catalogued constants", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes" }, ctx((c) => {
      if (c.functionName === "getRecipes") return [[LIQ], 1n];
      const meta = recipeMetaStub(c);
      if (meta !== undefined) return meta;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { contractsVersion: string; scale: string; items: Array<{ address: string; source: string; registryMatches: boolean; argsKnown: boolean; constants: Record<string, string>; args: { type: string } }> };
    // The config's release tag, echoed verbatim ("0.3.0" = the contracts-release label the
    // registry read API serves; "2.1.0" remains the GENERATION name in prose/docs).
    expect(d.contractsVersion).toBe("0.3.0");
    expect(d.items[0]?.source).toBe("price");
    expect(d.items[0]?.registryMatches).toBe(true);
    expect(d.items[0]?.argsKnown).toBe(true);
    expect(d.items[0]?.args.type).toBe("(uint256)");
    expect(d.items[0]?.constants["RATE_MIN"]).toBe("1");
    expect(d.items[0]?.constants["RATE_MAX_PERCENTAGE"]).toBe((100n * WAD).toString());
    expect(d.scale).toContain("_PERCENTAGE");
  });

  it("registry-recipes filters.mode is DEPRECATED sugar → resolves via config hints with a deprecation_notice", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes", filters: { mode: "liquidity" } }, ctx((c) => {
      if (c.functionName === "isRecipe") return true;
      const meta = recipeMetaStub(c);
      if (meta !== undefined) return meta;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    expect((env.data as { items: Array<{ address: string }> }).items[0]?.address.toLowerCase()).toBe(LIQ.toLowerCase());
    expect(env.warnings.some((w) => w.code === "deprecation_notice" && w.message.includes("mode"))).toBe(true);
  });

  it("registry-recipes filters.recipe not approved → recipe_not_found (isRecipe is the only gate)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes", filters: { recipe: ACCT } }, ctx((c) => {
      if (c.functionName === "isRecipe") return false;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_not_found");
  });

  it("registry-assets: two named source slots (absent slot → null) + token self-description", async () => {
    const entry = {
      addr: CA,
      name: "sUSDe",
      kind: 0,
      priceSource: { addr: ORACLE, sourceType: 0, sourceInterface: 0, denomination: "USD" },
      navSource: { addr: ZERO, sourceType: 0, sourceInterface: 0, denomination: "" },
    };
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-assets" }, ctx((c) => {
      if (c.functionName === "getAssets") return [[entry], 1n];
      if (c.functionName === "decimals") return 18;
      if (c.functionName === "symbol") return "sUSDe";
      if (c.functionName === "name") return "Staked USDe";
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const item = (env.data as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item["kind"]).toBe("ERC20");
    expect(item["priceSource"]).toEqual({ address: ORACLE, sourceType: "PRICE", sourceInterface: "AGGREGATOR_V3", denomination: "USD" });
    expect(item["navSource"]).toBeNull();
    expect(item["token"]).toEqual({ decimals: 18, symbol: "sUSDe", name: "Staked USDe" });
  });

  it("registry-assets filters.address miss → asset_not_found (single lookup, no chainId arg in 2.1.0)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-assets", filters: { address: REF } }, ctx((c) => {
      if (c.functionName === "lookupAssetByAddress") {
        expect(c.args).toEqual([REF]);
        return [false, { addr: ZERO, name: "", kind: 0, priceSource: { addr: ZERO, sourceType: 0, sourceInterface: 0, denomination: "" }, navSource: { addr: ZERO, sourceType: 0, sourceInterface: 0, denomination: "" } }];
      }
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("asset_not_found");
  });

  it("a wrong adapter binding → CONFLICT adapter_binding_mismatch (the old-generation hazard guard)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-assets" }, { nowSeconds: 1n, resolveRpc: stubRpc((c) => {
      if (c.functionName === "MARKET_REGISTRY") return "0xF674488bf4643e205ccd826951e8b0d29f77600A"; // the OLD registry
      throw new Error(`unexpected ${c.functionName}`);
    }) });
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("adapter_binding_mismatch");
  });

  it("registry-denominations resolves display labels (pseudo-unit table + unit symbol); labelHash stays the identity", async () => {
    const USD_UNIT = "0x0000000000000000000000000000000000000348";
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-denominations" }, ctx((c) => {
      if (c.functionName === "getDenominations") return [[{ labelHash: keccak256("0x555344"), unit: USD_UNIT }, { labelHash: keccak256("0x55534453"), unit: REF }], 2n];
      if (c.functionName === "decimals") return 18;
      if (c.functionName === "symbol") return "USDS";
      if (c.functionName === "name") return "USDS Stablecoin";
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const items = (env.data as { items: Array<{ label: string | null; labelSource: string | null }> }).items;
    expect(items[0]?.label).toBe("USD");
    expect(items[0]?.labelSource).toContain("pseudo");
    expect(items[1]?.label).toBe("USDS");
  });

  it("registry-denominations filters.label miss teaches exact-bytes case sensitivity", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-denominations", filters: { label: "usd" } }, ctx((c) => {
      if (c.functionName === "lookupDenomination") return [false, ZERO];
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("denomination_not_found");
    expect(env.warnings[0]?.message).toContain("case-sensitive");
  });

  it("registry-feeds lists directed edges with live answers (decimals drift visible)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-feeds" }, ctx((c) => {
      if (c.functionName === "getConversionFeeds") return [[{ base: CA, quote: REF, aggregatorAddress: ORACLE, feedDecimals: 8 }], 1n];
      if (c.functionName === "decimals") return 8;
      if (c.functionName === "latestRoundData") return [1n, 99991234n, 0n, 1_790_000_000n, 1n];
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const f = (env.data as { items: Array<{ feedDecimals: number; live: { answer: string; decimals: number } }> }).items[0]!;
    expect(f.feedDecimals).toBe(8);
    expect(f.live.answer).toBe("99991234");
    expect(f.live.decimals).toBe(8);
  });

  it("registry-oracle defaults to mode 'price' (disclosed), reads the 3-arg lookupWrapper", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF } }, ctx((c) => {
      if (c.functionName === "lookupWrapper") {
        expect(c.args).toEqual([CA, REF, 0]); // OracleMode.PRICE = 0
        return ORACLE;
      }
      if (c.functionName === "rate") return WAD;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { mode: string; modeNote?: string; oracle: { address: string; deployed: boolean; rate: string } };
    expect(d.mode).toBe("price");
    expect(d.modeNote).toContain("defaulted"); // the applied default is disclosed in data, not a warning
    expect(d.oracle.deployed).toBe(true);
    expect(BigInt(d.oracle.rate)).toBe(WAD);
  });

  it("registry-oracle mode 'nav' keys a DIFFERENT wrapper (OracleMode.NAV = 1)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF, mode: "nav" } }, ctx((c) => {
      if (c.functionName === "lookupWrapper") {
        expect(c.args).toEqual([CA, REF, 1]);
        return ZERO;
      }
      if (c.functionName === "simulate:deploy") return ORACLE;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { oracle: { address: string; deployed: boolean; deployable: boolean } };
    expect(d.oracle.deployed).toBe(false);
    expect(d.oracle.deployable).toBe(true);
    expect(d.oracle.address).toBe(ORACLE);
  });

  it("registry-oracle filters.rate keys a FIXED-RATE oracle (no pair); getCode decides deployed", async () => {
    const PREDICTED = "0xB3bFce4cC9319F1E311e0367E7A9f57022dFA732";
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { rate: WAD.toString() } }, ctx((c) => {
      if (c.functionName === "predictFixedRateOracle") return PREDICTED;
      throw new Error(`unexpected ${c.functionName}`);
    }, { code: { [PREDICTED.toLowerCase()]: "0x6001" } }));
    expect(env.state).toBe("ok");
    const d = env.data as { oracle: { address: string; deployed: boolean } };
    expect(d.oracle.address).toBe(PREDICTED);
    expect(d.oracle.deployed).toBe(true);
  });

  it("no registry on mainnet → unknown_deployment naming 42161", async () => {
    const env = await runTool("cork_query", { chainId: 1, resource: "registry-recipes" }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
    expect(env.warnings[0]?.message).toContain("42161");
  });
});

describe("cork_query derive-market (2.1.0: recipe contract + off-chain constraint)", () => {
  const ctx = (handler: (c: StubCall) => unknown, opts?: Parameters<typeof stubRpc>[1]): HandlerContext => ({ nowSeconds: 1_790_000_000n, resolveRpc: stubRpc(withBinding(handler), opts) });
  // Live-captured ground truth: the identical Market struct hash across generations.
  const GT = {
    oracle: "0x2ba2103a37c4cff9dbb96e6f74513923d960d757",
    rate: 806233879660299371n,
    constraint: { rateMin: 8062338796602994n, rateMax: 1612467759320598742n, rateChangePerDayMax: 806233879660299371n, rateChangeCapacityMax: 806233879660299371n },
    poolId: "0xda9325fad061bbcaa92fdec93d81398ca31ad1494c16ac658b9cc67079078c75",
    cst: "0x5d16b802b397dffced2468f63b936a835dc8bf10",
    cpt: "0x77db0b6c1d956865c2b3217f90be1a394ba08f4c",
  };
  const sharesWord = (a: string) => "000000000000000000000000" + a.replace(/^0x/, "").toLowerCase();

  it("missing recipe AND mode → missing_filter (no chain call)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-market", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000" } }, ctx(() => { throw new Error("must not read chain"); }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("missing_filter");
    expect(env.warnings[0]?.message).toContain("recipe");
  });

  it("ca === ref is a domain-rule envelope (invalid_pair), not a throw", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-market", filters: { collateralAsset: CA, referenceAsset: CA, expiry: "1900000000", recipe: LIQ } }, ctx(() => 0));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_pair");
  });

  it("full prediction (deployed oracle, pool NOT created): local pool_id parity, simulated cST/cPT, drift notice teaches signing pins it", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-market", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", recipe: LIQ } }, ctx(
      (c) => {
        if (c.functionName === "isRecipe") return true;
        if (c.functionName === "source") return 1; // PRICE
        if (c.functionName === "lookupWrapper") return GT.oracle;
        if (c.functionName === "rate") return GT.rate;
        if (c.functionName === "resolve") {
          expect(c.args?.[2]).toBe(GT.oracle); // live oracle passed to resolve
          return GT.constraint;
        }
        if (c.functionName === "shares") return [ZERO, ZERO]; // pool does not exist yet
        throw new Error(`unexpected ${c.functionName}`);
      },
      {
        simulateCalls: (a) => {
          expect(a.stateOverrides).toBeTruthy(); // the POOL_CREATOR_ROLE grant rides the simulation
          return { results: [{ status: "success", data: "0x" }, { status: "success", data: "0x" + sharesWord(GT.cpt) + sharesWord(GT.cst) }] };
        },
      },
    ));
    expect(env.state).toBe("ok");
    const d = env.data as { recipe: string; source: string; oracle: { deployed: boolean; rate: string }; market: { poolId: string; exists: boolean; constraint: { rateMin: string } }; shares: { corkSwapToken: string; corkPrincipalToken: string; source: string } };
    expect(d.recipe).toBe(LIQ);
    expect(d.source).toBe("price");
    expect(d.oracle.deployed).toBe(true);
    expect(BigInt(d.oracle.rate)).toBe(GT.rate);
    expect(d.market.poolId).toBe(GT.poolId); // end-to-end parity with the live endpoint
    expect(d.market.exists).toBe(false);
    expect(BigInt(d.market.constraint.rateMin)).toBe(GT.constraint.rateMin);
    expect(d.shares.corkSwapToken.toLowerCase()).toBe(GT.cst);
    expect(d.shares.corkPrincipalToken.toLowerCase()).toBe(GT.cpt);
    expect(d.shares.source).toBe("simulated");
    const drift = env.warnings.find((w) => w.code === "rate_drift_notice");
    expect(drift?.message).toContain("signing");
  });

  it("deployable-but-undeployed oracle → FULL identity from the predicted address + anchor constraint (the walkthrough's intended shape — the HTTP endpoint still nulls here)", async () => {
    // The pool id's only oracle-derived input is the ADDRESS (already predicted); the constraint
    // resolves from the anchor in args; the share simulation prepends the same permissionless
    // deploy the fill performs. Nothing has to be deployed first.
    const anchorArgs = `0x${WAD.toString(16).padStart(64, "0")}`;
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-market", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", recipe: LIQ, args: anchorArgs } }, ctx(
      (c) => {
        if (c.functionName === "isRecipe") return true;
        if (c.functionName === "source") return 1;
        if (c.functionName === "lookupWrapper") return ZERO;
        if (c.functionName === "simulate:deploy") return GT.oracle;
        if (c.functionName === "resolve") {
          expect(c.args?.[2]).toBe(ZERO); // predicted oracle is passed as address(0) — the anchor fallback
          expect(c.args?.[3]).toBe(anchorArgs);
          return GT.constraint;
        }
        if (c.functionName === "shares") return [ZERO, ZERO]; // pool does not exist
        throw new Error(`unexpected ${c.functionName}`);
      },
      {
        simulateCalls: (a) => {
          expect(a.calls.length).toBe(3); // deploy prepended before createNewPool + shares
          return { results: [{ status: "success", data: "0x" }, { status: "success", data: "0x" }, { status: "success", data: "0x" + sharesWord(GT.cpt) + sharesWord(GT.cst) }] };
        },
      },
    ));
    expect(env.state).toBe("ok");
    const d = env.data as { oracle: { deployed: boolean }; market: { poolId: string; exists: boolean }; shares: { corkSwapToken: string; source: string }; constraint?: unknown };
    expect(d.oracle.deployed).toBe(false);
    expect(d.market.poolId).toBe(GT.poolId); // same identity as the deployed-oracle case: address + constraint are identical
    expect(d.market.exists).toBe(false);
    expect(d.shares.corkSwapToken.toLowerCase()).toBe(GT.cst);
    expect(d.shares.source).toBe("simulated");
    const note = env.warnings.find((w) => w.code === "oracle_not_deployed");
    expect(note?.message).toContain("does not need to be");
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(false); // anchor-derived identity does not drift with the rate
  });

  it("share prediction is GENERATION-consistent: reads target the controller's own pool manager, not the config default", async () => {
    // The mixed-generation shape proven live during the 2026-08-07 v1.3.0-rc.1 dry run
    // (and the exact shape the pending registry redeploy will create): the registry's
    // controller creates pools on ONE phoenix generation's pool manager while the config
    // default points at ANOTHER. The prediction must follow the CONTROLLER's binding —
    // simulate creation there AND read shares there — or it predicts nothing. Here the
    // controller binds the v1.3 pool manager while the config default is still v1.1.
    const CONTROLLER_PM = "0x02803Bb52D2184f906F45B50C66AA969C2E37263"; // v1.3, ≠ config default
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-market", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", recipe: LIQ } }, ctx(
      (c) => {
        if (c.functionName === "isRecipe") return true;
        if (c.functionName === "source") return 1;
        if (c.functionName === "lookupWrapper") return GT.oracle;
        if (c.functionName === "getRate") return GT.rate;
        if (c.functionName === "resolve") return GT.constraint;
        if (c.functionName === "CORK_POOL_MANAGER") return CONTROLLER_PM; // the controller's own binding
        if (c.functionName === "shares") {
          // The discriminating assertion: a shares read against ANY other pool manager —
          // in particular the config default — is the generation bug this test pins.
          expect(c.address.toLowerCase()).toBe(CONTROLLER_PM.toLowerCase());
          return [ZERO, ZERO]; // pool does not exist yet
        }
        throw new Error(`unexpected ${c.functionName}`);
      },
      {
        simulateCalls: (a) => {
          const last = a.calls[a.calls.length - 1]!;
          expect(last.to.toLowerCase()).toBe(CONTROLLER_PM.toLowerCase()); // shares leg follows the controller too
          return { results: a.calls.map((_, i) => (i === a.calls.length - 1 ? { status: "success", data: "0x" + sharesWord(GT.cpt) + sharesWord(GT.cst) } : { status: "success", data: "0x" })) };
        },
      },
    ));
    expect(env.state).toBe("ok");
    const d = env.data as { shares: { corkSwapToken: string; source: string } };
    expect(d.shares.corkSwapToken.toLowerCase()).toBe(GT.cst);
    expect(d.shares.source).toBe("simulated");
  });

  it("a refusing recipe → recipe_refused naming the contract's own error", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-market", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", recipe: LIQ } }, ctx((c) => {
      if (c.functionName === "isRecipe") return true;
      if (c.functionName === "source") return 1;
      if (c.functionName === "lookupWrapper") return ZERO;
      if (c.functionName === "simulate:deploy") return ORACLE;
      if (c.functionName === "resolve") throw new Error("execution reverted: MalformedAdditionalData(0)");
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_refused");
    expect(env.warnings[0]?.message).toContain("MalformedAdditionalData");
  });

  it("mode sugar resolves via config hints with a deprecation_notice", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-market", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" } }, ctx((c) => {
      if (c.functionName === "isRecipe") {
        expect(String(c.args?.[0]).toLowerCase()).toBe(LIQ.toLowerCase());
        return true;
      }
      if (c.functionName === "source") return 1;
      if (c.functionName === "lookupWrapper") return ZERO;
      if (c.functionName === "simulate:deploy") return ORACLE;
      if (c.functionName === "resolve") return GT.constraint;
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "deprecation_notice")).toBe(true);
  });
});

describe("cork_compute resolve-recipe (2.1.0: the recipe resolves its own constraint)", () => {
  const ctx = (handler: (c: StubCall) => unknown): HandlerContext => ({ nowSeconds: 1n, resolveRpc: stubRpc(withBinding(handler)) });

  it("resolves against the LIVE oracle and returns the four raw values an order carries", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", recipe: LIQ, collateralAsset: CA, referenceAsset: REF } }, ctx((c) => {
      if (c.functionName === "isRecipe") return true;
      if (c.functionName === "source") return 1;
      if (c.functionName === "lookupWrapper") return ORACLE;
      if (c.functionName === "rate") return WAD;
      if (c.functionName === "resolve") {
        expect(c.args?.[2]).toBe(ORACLE);
        return { rateMin: 1n, rateMax: 2n * WAD, rateChangePerDayMax: WAD, rateChangeCapacityMax: 3n * WAD };
      }
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("ok");
    const d = env.data as { recipe: string; source: string; constraint: { rateMax: string }; rateOracle: { status: string; rate: string } };
    expect(d.recipe).toBe(LIQ);
    expect(d.source).toBe("price");
    expect(BigInt(d.constraint.rateMax)).toBe(2n * WAD);
    expect(d.rateOracle.status).toBe("live");
    expect(BigInt(d.rateOracle.rate)).toBe(WAD);
  });

  it("missing pair → missing_filter teaching the 2.1.0 shape", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", recipe: LIQ } }, ctx(() => { throw new Error("must not read chain"); }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("missing_filter");
  });

  it("a refusing recipe (e.g. fixed-rate with an undeployed oracle) → recipe_refused with guidance", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "resolve-recipe", recipe: LIQ, collateralAsset: CA, referenceAsset: REF } }, ctx((c) => {
      if (c.functionName === "isRecipe") return true;
      if (c.functionName === "source") return 2; // FIXED
      if (c.functionName === "resolve") throw new Error("execution reverted: RateOracleNotDeployed(0x211C…, 0x7F65…)");
      throw new Error(`unexpected ${c.functionName}`);
    }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_refused");
    expect(env.warnings[0]?.message).toContain("deploy-fixed-oracle");
  });
});

describe("cork_prepare_market (unsigned oracle-infrastructure txs)", () => {
  it("deploy-oracle defaults to PRICE mode (ordinal 0 in the calldata, disclosed) and flags an existing wrapper", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "reg-mkt-0001", action: { type: "deploy-oracle", collateralAsset: CA, referenceAsset: REF } }, {
      nowSeconds: 1n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "lookupWrapper") {
          expect(c.args).toEqual([CA, REF, 0]);
          return ORACLE;
        }
        throw new Error("unexpected");
      }),
    });
    expect(env.state).toBe("ok");
    const d = env.data as { calldata: string; mode: string; modeNote?: string; oracle: { deployed: boolean } };
    expect(d.calldata).toBe(buildDeployOracleCall(CA, REF, "price"));
    expect(d.calldata).toBe(encodeFunctionData({ abi: marketRegistryAbi, functionName: "deploy", args: [CA, REF, 0] }));
    expect(d.mode).toBe("price");
    expect(d.modeNote).toContain("defaulted"); // disclosed in data, not a warning
    expect(d.oracle.deployed).toBe(true);
    expect(env.warnings.some((w) => w.code === "oracle_already_deployed")).toBe(true);
  });

  it("deploy-oracle mode 'nav' encodes ordinal 1; offline still builds with the gap disclosed", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "reg-mkt-0002", action: { type: "deploy-oracle", collateralAsset: CA, referenceAsset: REF, mode: "nav" } }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect((env.data as { calldata: string }).calldata).toBe(encodeFunctionData({ abi: marketRegistryAbi, functionName: "deploy", args: [CA, REF, 1] }));
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc")).toBe(true);
  });

  it("a MID-CALL RPC failover is disclosed in rpc_fallback — even when the heal landed back on the default tier, which a source check alone cannot see", async () => {
    const resolved = {
      url: "https://healed.example/rpc",
      source: "default" as const,
      failedOverInCall: true,
      client: { readContract: async () => ORACLE, getCode: async () => "0x" } as never,
    };
    const env = await runTool(
      "cork_prepare_market",
      { chainId: 42161, clientRequestId: "reg-mkt-fo01", action: { type: "deploy-fixed-oracle", rate: "1000000000000000000" } },
      { nowSeconds: 1n, resolveRpc: async () => resolved },
    );
    expect(env.state).toBe("ok");
    const w = env.warnings.find((x) => x.code === "rpc_fallback");
    expect(w, "mid-call failover must be disclosed").toBeDefined();
    expect(w!.message).toContain("MID-CALL");
    expect(w!.message).toContain("healed.example"); // host of the endpoint that finished the call
    expect(w!.message).toContain("earlier in this result"); // the mixing caveat itself
  });

  it("deploy-fixed-oracle builds deployFixedRateOracle(rate) calldata and detects an existing oracle via getCode", async () => {
    const PREDICTED = "0xB3bFce4cC9319F1E311e0367E7A9f57022dFA732";
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "reg-mkt-0003", action: { type: "deploy-fixed-oracle", rate: WAD.toString() } }, {
      nowSeconds: 1n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "predictFixedRateOracle") return PREDICTED;
        throw new Error("unexpected");
      }, { code: { [PREDICTED.toLowerCase()]: "0x6001" } }),
    });
    expect(env.state).toBe("ok");
    const d = env.data as { calldata: string; oracle: { address: string; deployed: boolean } };
    expect(d.calldata).toBe(buildDeployFixedRateOracleCall(WAD));
    expect(d.oracle.deployed).toBe(true);
    expect(env.warnings.some((w) => w.code === "oracle_already_deployed")).toBe(true);
  });

  it("deploy-fixed-oracle with rate 0 → invalid_order_terms (the constructor reverts)", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "reg-mkt-0004", action: { type: "deploy-fixed-oracle", rate: "0" } }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
  });
});

describe("cork_prepare_orders maker-order + jitMarket (2.1.0)", () => {
  const jitAction = (jm: Record<string, unknown>) => ({
    type: "maker-order",
    poolId: `0x${"11".repeat(32)}`,
    side: "SELL",
    makerAsset: CA, // deliberately NOT the derived cST → side-mismatch warning expected online
    takerAsset: REF,
    makingAmount: "1000000000000000000",
    takingAmount: "1000000",
    jitMarket: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: "1795000000", enableJitMint: true, ...jm },
  });
  const base = { chainId: 42161 as const, account: ACCT, clientRequestId: "reg-jit-0001" };

  it("offline WITH an explicit constraint: extension builds against the 2.1.0 adapter; skipped pre-flights disclosed", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ, constraint: CONSTRAINT_WIRE }) }, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    const d = env.data as { extension: `0x${string}`; jit: { adapter: string; hook: string; recipe: string } };
    const decoded = decodeJitExtension(d.extension);
    expect(decoded.adapter.toLowerCase()).toBe(ADAPTER.toLowerCase());
    expect(decoded.params.recipe.toLowerCase()).toBe(LIQ.toLowerCase());
    expect(decoded.params.constraint).toEqual(CONSTRAINT);
    expect(decoded.params.rateOverride).toBe(0n);
    expect(d.jit.hook).toContain("preInteraction");
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc")).toBe(true);
  });

  it("offline WITHOUT a constraint → requires_rpc teaching where the constraint comes from", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ }) }, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("requires_rpc");
    expect(env.warnings[0]?.message).toContain("resolve");
  });

  it("online auto-resolve: constraint from recipe.resolve, verify pre-flight, PINNED identity, cST side-check", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ }) }, {
      nowSeconds: 1_790_000_000n,
      resolveRpc: stubRpc(
        (c) => {
          if (c.functionName === "LIMIT_ORDER_PROTOCOL") return "0x111111125421cA6dc452d289314280a0f8842A65";
          if (c.functionName === "MARKET_REGISTRY") return REG;
          if (c.functionName === "CONTROLLER") return CONTROLLER;
          if (c.functionName === "hasRole") return false; // both roles missing (pre-2026-08-04 state)
          if (c.functionName === "isRecipe") return true;
          if (c.functionName === "source") return 1;
          if (c.functionName === "lookupWrapper") return ORACLE;
          if (c.functionName === "rate") return WAD;
          if (c.functionName === "resolve") return CONSTRAINT;
          if (c.functionName === "verify") return true;
          if (c.functionName === "shares") return [ZERO, ZERO];
          throw new Error(`unexpected ${c.functionName}`);
        },
        {
          simulateCalls: () => ({ results: [{ status: "success", data: "0x" }, { status: "success", data: "0x" + "00".repeat(12) + "77db0b6c1d956865c2b3217f90be1a394ba08f4c" + "00".repeat(12) + "5d16b802b397dffced2468f63b936a835dc8bf10" }] }),
        },
      ),
    });
    expect(env.state).toBe("ok");
    const d = env.data as { extension: `0x${string}`; jit: { derivedPoolId: string; identity: string; predictedCorkSwapToken: string; constraint: { rateMax: string } } };
    const decoded = decodeJitExtension(d.extension);
    expect(decoded.params.constraint).toEqual(CONSTRAINT); // the RESOLVED constraint rode into the bytes
    expect(d.jit.identity).toContain("PINNED");
    expect(d.jit.predictedCorkSwapToken.toLowerCase()).toBe("0x5d16b802b397dffced2468f63b936a835dc8bf10");
    expect(env.warnings.some((w) => w.code === "roles_not_granted")).toBe(true);
    expect(env.warnings.some((w) => w.code === "constraint_window_notice")).toBe(true);
    expect(env.warnings.some((w) => w.code === "jit_side_mismatch")).toBe(true);
    expect(env.warnings.some((w) => w.code === "rate_drift_notice")).toBe(false); // the drift world ended at signing
  });

  // The roles pre-flight has three meaningful states, and each catches a different mutant class.
  // Both-missing is asserted above; the two below cover the branches that became load-bearing
  // when the grant landed on-chain (block 491025419, 2026-08-04).
  const rolesStub = (hasRole: (c: StubCall) => boolean, opts: { code?: Record<string, string>; poolIdOf?: (addr: string) => `0x${string}` } = {}) =>
    stubRpc(
      (c) => {
        if (c.functionName === "poolId" && opts.poolIdOf) return opts.poolIdOf(c.address);
        if (c.functionName === "LIMIT_ORDER_PROTOCOL") return "0x111111125421cA6dc452d289314280a0f8842A65";
        if (c.functionName === "MARKET_REGISTRY") return REG;
        if (c.functionName === "CONTROLLER") return CONTROLLER;
        if (c.functionName === "hasRole") return hasRole(c);
        if (c.functionName === "isRecipe") return true;
        if (c.functionName === "source") return 1;
        if (c.functionName === "lookupWrapper") return ORACLE;
        if (c.functionName === "rate") return WAD;
        if (c.functionName === "resolve") return CONSTRAINT;
        if (c.functionName === "verify") return true;
        if (c.functionName === "shares") return [ZERO, ZERO];
        throw new Error(`unexpected ${c.functionName}`);
      },
      {
        simulateCalls: () => ({ results: [{ status: "success", data: "0x" }, { status: "success", data: "0x" + "00".repeat(12) + "77db0b6c1d956865c2b3217f90be1a394ba08f4c" + "00".repeat(12) + "5d16b802b397dffced2468f63b936a835dc8bf10" }] }),
        code: opts.code,
      },
    );

  it("BOTH roles granted → no roles_not_granted warning (the live path since 2026-08-04)", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ }) }, { nowSeconds: 1_790_000_000n, resolveRpc: rolesStub(() => true) });
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "roles_not_granted")).toBe(false);
    // side-mismatch fires (sides are deliberately CA/REF) but neither side has code, so the
    // consumed-prediction diagnosis stays SILENT — a plain user error, not a stale prediction.
    expect(env.warnings.some((w) => w.code === "jit_side_mismatch")).toBe(true);
    expect(env.warnings.some((w) => w.code === "stale_share_prediction")).toBe(false);
  });

  it("a mismatched side that ALREADY hosts another pool's shares → stale_share_prediction names that pool (mutation killer for the diagnosis gate)", async () => {
    // The exact live failure of 2026-08-04: the venue's predicted cST addresses were consumed
    // by interleaving pool creations. Here the order's takerAsset (REF) has code and reports a
    // FOREIGN poolId — the diagnosis must name the side and the foreign pool.
    const FOREIGN_POOL = `0x${"deadbeef".repeat(8)}` as const;
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ }) }, {
      nowSeconds: 1_790_000_000n,
      resolveRpc: rolesStub(() => true, { code: { [REF.toLowerCase()]: "0x6080" }, poolIdOf: () => FOREIGN_POOL }),
    });
    expect(env.state).toBe("ok");
    const w = env.warnings.find((x) => x.code === "stale_share_prediction");
    expect(w).toBeDefined();
    expect(w?.message).toContain("takerAsset");
    expect(w?.message).toContain(FOREIGN_POOL);
    expect(w?.message).toContain("consumed");
  });

  it("a PARTIAL grant still warns and names which role is missing (mutation killer: && vs ||, swapped role args)", async () => {
    // hasRole keyed on the ROLE HASH: creator granted, configurator missing — the state a
    // half-executed governance action produces. An &&→|| mutant reports granted; a swapped
    // role-constant mutant flips the per-role truth in the message. Both die here.
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ }) }, { nowSeconds: 1_790_000_000n, resolveRpc: rolesStub((c) => c.args?.[0] === POOL_CREATOR_ROLE) });
    expect(env.state).toBe("ok");
    const w = env.warnings.find((x) => x.code === "roles_not_granted");
    expect(w).toBeDefined();
    expect(w?.message).toContain("POOL_CREATOR: true");
    expect(w?.message).toContain("CONFIGURATOR: false");
  });

  it("online auto-resolve with an UNDEPLOYED oracle: the share simulation prepends the fill's own deploy (mutation killer for the preCalls branch)", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ, additionalData: `0x${WAD.toString(16).padStart(64, "0")}` }) }, {
      nowSeconds: 1_790_000_000n,
      resolveRpc: stubRpc(
        (c) => {
          if (c.functionName === "LIMIT_ORDER_PROTOCOL") return "0x111111125421cA6dc452d289314280a0f8842A65";
          if (c.functionName === "MARKET_REGISTRY") return REG;
          if (c.functionName === "CONTROLLER") return CONTROLLER;
          if (c.functionName === "hasRole") return true;
          if (c.functionName === "isRecipe") return true;
          if (c.functionName === "source") return 1;
          if (c.functionName === "lookupWrapper") return ZERO; // NOT deployed
          if (c.functionName === "simulate:deploy") return ORACLE;
          if (c.functionName === "resolve") return CONSTRAINT;
          if (c.functionName === "shares") return [ZERO, ZERO];
          throw new Error(`unexpected ${c.functionName}`);
        },
        {
          simulateCalls: (a) => {
            expect(a.calls.length).toBe(3); // deploy prepended before createNewPool + shares
            return { results: [{ status: "success", data: "0x" }, { status: "success", data: "0x" }, { status: "success", data: "0x" + "00".repeat(12) + "77db0b6c1d956865c2b3217f90be1a394ba08f4c" + "00".repeat(12) + "5d16b802b397dffced2468f63b936a835dc8bf10" }] };
          },
        },
      ),
    });
    expect(env.state).toBe("ok");
    const d = env.data as { jit: { predictedCorkSwapToken: string; oracle: { deployed: boolean } } };
    expect(d.jit.oracle.deployed).toBe(false);
    expect(d.jit.predictedCorkSwapToken.toLowerCase()).toBe("0x5d16b802b397dffced2468f63b936a835dc8bf10");
    expect(env.warnings.some((w) => w.code === "oracle_not_deployed")).toBe(true);
  });

  it("a stale explicit constraint failing recipe.verify → would_revert naming RecipeRejectedConstraint", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ, constraint: CONSTRAINT_WIRE }) }, {
      nowSeconds: 1_790_000_000n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "LIMIT_ORDER_PROTOCOL") return "0x111111125421cA6dc452d289314280a0f8842A65";
        if (c.functionName === "MARKET_REGISTRY") return REG;
        if (c.functionName === "CONTROLLER") return CONTROLLER;
        if (c.functionName === "hasRole") return true;
        if (c.functionName === "isRecipe") return true;
        if (c.functionName === "source") return 1;
        if (c.functionName === "lookupWrapper") return ORACLE;
        if (c.functionName === "rate") return WAD;
        if (c.functionName === "verify") return false; // the recipe rejects it
        if (c.functionName === "shares") return [ZERO, ZERO];
        throw new Error(`unexpected ${c.functionName}`);
      }),
    });
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "would_revert" && w.message.includes("RecipeRejectedConstraint"))).toBe(true);
  });

  it("FIXED recipe with rateOverride 0 → invalid_order_terms (before any resolve attempt)", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ }) }, {
      nowSeconds: 1_790_000_000n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "LIMIT_ORDER_PROTOCOL") return "0x111111125421cA6dc452d289314280a0f8842A65";
        if (c.functionName === "MARKET_REGISTRY") return REG;
        if (c.functionName === "CONTROLLER") return CONTROLLER;
        if (c.functionName === "hasRole") return true;
        if (c.functionName === "isRecipe") return true;
        if (c.functionName === "source") return 2; // FIXED
        throw new Error(`unexpected ${c.functionName}`);
      }),
    });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("rateOverride");
  });

  it("price recipe with a non-zero rateOverride → invalid_order_terms (rejected, not ignored)", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ, rateOverride: WAD.toString() }) }, {
      nowSeconds: 1_790_000_000n,
      resolveRpc: stubRpc((c) => {
        if (c.functionName === "LIMIT_ORDER_PROTOCOL") return "0x111111125421cA6dc452d289314280a0f8842A65";
        if (c.functionName === "MARKET_REGISTRY") return REG;
        if (c.functionName === "CONTROLLER") return CONTROLLER;
        if (c.functionName === "hasRole") return true;
        if (c.functionName === "isRecipe") return true;
        if (c.functionName === "source") return 1; // PRICE
        if (c.functionName === "lookupWrapper") return ORACLE;
        if (c.functionName === "rate") return WAD;
        throw new Error(`unexpected ${c.functionName}`);
      }),
    });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("UnexpectedRateOverride");
  });

  it("rejects jitMarket + raw extension together (mutually exclusive)", async () => {
    const env = jitAction({ recipe: LIQ, constraint: CONSTRAINT_WIRE });
    await expect(runTool("cork_prepare_orders", { ...base, action: { ...env, extension: "0xdeadbeef" } }, { nowSeconds: 1n })).rejects.toThrow(/invalid input/);
  });

  it("fee above 5e18 (5%) is a domain-rule envelope (invalid_order_terms), not a throw", async () => {
    const envlp = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ, constraint: CONSTRAINT_WIRE, swapFeePercentage: "6000000000000000000" }) }, { nowSeconds: 1n });
    expect(envlp.state).toBe("unavailable");
    expect(envlp.warnings[0]?.code).toBe("invalid_order_terms");
  });

  it("fee of EXACTLY 5e18 (the cap) is accepted — the chain rule is <= 5%, not < 5% (boundary killer)", async () => {
    const envlp = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ, constraint: CONSTRAINT_WIRE, swapFeePercentage: "5000000000000000000", unwindSwapFeePercentage: "5000000000000000000" }) }, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(envlp.state).toBe("ok");
    const decoded = decodeJitExtension((envlp.data as { extension: `0x${string}` }).extension);
    expect(decoded.params.swapFeePercentage).toBe(5n * 10n ** 18n);
  });

  it("expiry EXACTLY equal to now is rejected — pool creation requires strictly-future expiry (boundary killer)", async () => {
    const envlp = await runTool("cork_prepare_orders", { ...base, action: jitAction({ recipe: LIQ, constraint: CONSTRAINT_WIRE, expiryTimestamp: "1790000000" }) }, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(envlp.state).toBe("unavailable");
    expect(envlp.warnings[0]?.code).toBe("invalid_order_terms");
    expect(envlp.warnings[0]?.message).toContain("not in the future");
  });

  it("no adapter configured on mainnet → unknown_deployment naming 42161", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, chainId: 1, action: jitAction({ recipe: LIQ, constraint: CONSTRAINT_WIRE }) }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
  });

  it("plain maker order (no jitMarket) is byte-identical to before — the opt-out path", async () => {
    const plain = { ...base, action: { type: "maker-order", poolId: `0x${"11".repeat(32)}`, side: "SELL", makerAsset: CA, takerAsset: REF, makingAmount: "1", takingAmount: "1" } };
    const env = await runTool("cork_prepare_orders", plain, { nowSeconds: 1_790_000_000n, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect((env.data as { extension: string }).extension).toBe("0x");
    expect((env.data as { jit?: unknown }).jit).toBeUndefined();
    expect(env.warnings.length).toBe(0);
  });
});
