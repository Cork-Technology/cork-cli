// Live smoke for the RPC resolver against the real network. Self-skips unless CORK_RPC_LIVE=1 so
// CI stays offline/deterministic. Proves end-to-end: the committed defaults resolve and answer,
// and a chain with NO committed default (Sepolia 11155111 — Base graduated to a committed
// default 2026-08-12) falls back to a real chainlist public RPC.
import { describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, parseAbi, stringToBytes, zeroAddress } from "viem";
import { generationsOf, resolveRpc, runTool } from "@cork/core";

const LIVE = process.env.CORK_RPC_LIVE === "1";

// The independent reference below re-declares the FLAT (market-registry 0.3.3) ABI: `deploy(ca, ref,
// mode)`, label-keyed denominations, `feedDecimals`. Since the 0.6 generation cutover the primary
// registry speaks the NESTED 0.5.0 wire (`deploy` takes an oracleSalt, address-keyed denominations),
// so this suite pins the generation its ABI speaks; resolving the primary sent 3-argument calls to
// the 0.5.0 registry, which reverted (every live-smoke run since 2026-09-24). The NESTED registry
// has its own independent reference at the end of this file (2026-10-01), declared from the
// Sourcify exact-match ABI of the deployed 0.5.0 registry, against the PRIMARY generation.
const FLAT_GEN = "phoenix/v0.3-rc.1";

describe.skipIf(!LIVE)("resolveRpc — live", () => {
  it("chain 1 uses the committed default and the client answers eth_chainId=1", async () => {
    const r = await resolveRpc(1, undefined);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("default");
    expect(await r!.client.getChainId()).toBe(1);
  }, 30_000);

  it("chain 8453 uses the committed default (added 2026-08-12) and answers eth_chainId=8453", async () => {
    const r = await resolveRpc(8453, undefined);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("default");
    expect(await r!.client.getChainId()).toBe(8453);
  }, 30_000);

  it("chain 11155111 (no default) falls back to a chainlist public RPC answering eth_chainId=11155111", async () => {
    const r = await resolveRpc(11155111, undefined);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("chainlist");
    expect(await r!.client.getChainId()).toBe(11155111);
  }, 60_000);

  it("chain 49222 (staging vnet, not on chainlist) resolves to null without an explicit RPC", async () => {
    expect(await resolveRpc(49222, undefined)).toBeNull();
  }, 15_000);

  it("persists an on-disk cache", async () => {
    // Self-contained: point the resolver at a fresh temp cache file (the test previously assumed
    // the runner exported CORK_RPC_CACHE_FILE, so existsSync(undefined) always read false).
    const cacheFile = join(tmpdir(), `cork-rpc-cache-${process.pid}-${Date.now()}.json`);
    const prev = process.env.CORK_RPC_CACHE_FILE;
    process.env.CORK_RPC_CACHE_FILE = cacheFile;
    try {
      rmSync(cacheFile, { force: true });
      await resolveRpc(1, undefined);
      expect(existsSync(cacheFile)).toBe(true);
    } finally {
      rmSync(cacheFile, { force: true });
      if (prev === undefined) delete process.env.CORK_RPC_CACHE_FILE;
      else process.env.CORK_RPC_CACHE_FILE = prev;
    }
  }, 30_000);
});

// End-to-end 2.1.0 parity: our chain-native registry reads (built-in Arbitrum RPC) vs an
// INDEPENDENT in-test raw-read reference over the same chain. The reference declares its own
// minimal ABI fragments HERE — nothing imported from the production reader — so a transform,
// pagination, enum-ordering, or field-mapping bug in the reader cannot hide inside a shared
// declaration. This replaced the external market-registry read API as the reference
// (2026-08-12: this suite was the ONLY consumer of api-phoenix.cork.tech/registry; the
// dependency is removed). One check retired with it, honestly: the API's free-form
// contracts_version label has no on-chain getter and therefore no internal source of truth —
// config still declares the label, but nothing external arbitrates a relabel anymore.
describe.skipIf(!LIVE)("2.1.0 registry — live parity vs an independent raw-read reference", () => {
  const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"; // sUSDe (registered on Arbitrum)
  const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610"; // sUSDS (registered on Arbitrum)
  const LIQ = "0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55"; // LiquidityRecipe (approved)
  const ANCHOR_ARGS = `0x${(10n ** 18n).toString(16).padStart(64, "0")}` as const; // abi.encode(1e18)
  const PRICE_MODE = 0; // OracleMode.PRICE — re-declared here (the reader's ORACLE_MODE is under test)

  // The reference ABI, re-declared from IMarketRegistry.sol / IMarketRecipe.sol (tag 2.1.0) —
  // deliberately NOT imported from market-registry.ts (see the block comment above).
  const refAbi = parseAbi([
    "struct AssetSource { address addr; uint8 sourceType; uint8 sourceInterface; string denomination; }",
    "struct Asset { address addr; string name; uint8 kind; AssetSource priceSource; AssetSource navSource; }",
    "struct ConversionFeed { address base; address quote; address aggregatorAddress; uint8 feedDecimals; }",
    "struct Denomination { bytes32 labelHash; address unit; }",
    "function getAssets(uint256 offset, uint256 limit) view returns (Asset[] page, uint256 total)",
    "function getConversionFeeds(uint256 offset, uint256 limit) view returns (ConversionFeed[] page, uint256 total)",
    "function getDenominations(uint256 offset, uint256 limit) view returns (Denomination[] page, uint256 total)",
    "function getRecipes(uint256 offset, uint256 limit) view returns (address[] page, uint256 total)",
    "function lookupWrapper(address ca, address ref, uint8 mode) view returns (address wrapper)",
    "function predictFixedRateOracle(uint256 rate) view returns (address oracle)",
    "function deploy(address ca, address ref, uint8 mode) returns (address wrapper)",
    "function source() view returns (uint8)",
    "function decimals() view returns (uint8)",
    "function resolve(address ca, address ref, address rateOracle, bytes additionalData) view returns ((uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint)",
  ]);
  // RecipeSource ordinals, re-declared: NAV=0, PRICE=1, FIXED=2 (inverted vs OracleMode — the
  // deliberate upstream trap this suite must be able to catch, so no import).
  const REF_RECIPE_SOURCE = ["nav", "price", "fixed"] as const;

  const ref42161 = async () => {
    const { resolveMarketRegistry } = await import("@cork/core");
    const { marketRegistry: mr } = await resolveMarketRegistry(42161, undefined, FLAT_GEN);
    expect(mr?.registry).toBeDefined();
    const r = await resolveRpc(42161, undefined);
    expect(r).not.toBeNull();
    return { registry: mr!.registry as `0x${string}`, contractsVersion: mr!.contractsVersion, client: r!.client };
  };

  it("the configured registry address answers registry views on-chain (identity check)", async () => {
    const { registry, contractsVersion, client } = await ref42161();
    // The contracts-release label is free-form VENUE vocabulary (relabels "2.1.0"→"0.3.0"→
    // "0.3.2"→"0.3.3" all happened there), so the venue's registry module is its LEGITIMATE
    // arbiter — re-added 2026-08-13 as the one deliberate best-effort venue check in this
    // suite: unreachable → skip, never fail (the SUBSTANCE of registry identity is guarded
    // harder by the approvedImplementations codehash allowlist).
    expect(contractsVersion).toBeDefined();
    const [, total] = await client.readContract({ address: registry, abi: refAbi, functionName: "getAssets", args: [0n, 1n] });
    expect(total).toBeGreaterThan(0n);
    try {
      const res = await fetch("https://api-phoenix.cork.tech/registry/v1/registries");
      if (res.ok) {
        const api = (await res.json()) as { registries: Array<{ chain_id: number; registry: string; contracts_version: string }> };
        const row = api.registries.find((r) => r.chain_id === 42161);
        expect(row?.registry.toLowerCase()).toBe(registry.toLowerCase());
        expect(row?.contracts_version).toBe(contractsVersion);
      }
    } catch {
      /* venue unreachable — the label stays config-declared for this run */
    }
  }, 30_000);

  it("registry-assets matches a raw one-shot getAssets read (same address set)", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, generation: FLAT_GEN, resource: "registry-assets", format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(ours.state).toBe("ok");
    const ourAddrs = ((ours.data as { items: Array<{ address: string }> }).items.map((i) => i.address.toLowerCase())).sort();
    const { registry, client } = await ref42161();
    // One-shot with a large limit — cross-checks the reader's PAGINATED assembly.
    const [page] = await client.readContract({ address: registry, abi: refAbi, functionName: "getAssets", args: [0n, 500n] });
    expect(ourAddrs).toEqual(page.map((a) => a.addr.toLowerCase()).sort());
  }, 60_000);

  it("registry-recipes matches raw getRecipes + per-recipe source()/constant reads", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, generation: FLAT_GEN, resource: "registry-recipes", format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(ours.state).toBe("ok");
    const ourItems = (ours.data as { items: Array<{ address: string; source: string; constants: Record<string, string> }> }).items;
    const { registry, client } = await ref42161();
    const [addrs] = await client.readContract({ address: registry, abi: refAbi, functionName: "getRecipes", args: [0n, 100n] });
    expect(ourItems.map((i) => i.address.toLowerCase()).sort()).toEqual(addrs.map((a) => a.toLowerCase()).sort());
    for (const addr of addrs) {
      const mine = ourItems.find((i) => i.address.toLowerCase() === addr.toLowerCase())!;
      const ordinal = await client.readContract({ address: addr, abi: refAbi, functionName: "source" });
      expect(mine.source, `source of ${addr}`).toBe(REF_RECIPE_SOURCE[ordinal]);
      // Every constant our read reports must exist as a live getter answering the same raw
      // value (the reader's RECIPE_CATALOG is a teaching superset asserted offline; VALUES
      // must come from the chain).
      for (const [name, v] of Object.entries(mine.constants)) {
        const raw = await client.readContract({ address: addr, abi: parseAbi([`function ${name}() view returns (uint256)`] as const), functionName: name });
        expect(String(raw), `constant ${name} on ${addr}`).toBe(v);
      }
    }
  }, 90_000);

  it("registry-denominations matches raw getDenominations; labels re-hash to their labelHash", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, generation: FLAT_GEN, resource: "registry-denominations", format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(ours.state).toBe("ok");
    const ourItems = (ours.data as { items: Array<{ labelHash: string; unit: string; label: string | null }> }).items;
    const { registry, client } = await ref42161();
    const [page] = await client.readContract({ address: registry, abi: refAbi, functionName: "getDenominations", args: [0n, 200n] });
    expect(ourItems.length).toBe(page.length);
    const mineByHash = Object.fromEntries(ourItems.map((i) => [i.labelHash.toLowerCase(), i]));
    for (const row of page) {
      const mine = mineByHash[row.labelHash.toLowerCase()];
      expect(mine, `denomination ${row.labelHash} missing from our read`).toBeDefined();
      expect(mine!.unit.toLowerCase()).toBe(row.unit.toLowerCase());
      // The label is display text the reader resolves; the HASH is the identity — a resolved
      // label must re-hash to it (labels are exact bytes, case-sensitive).
      if (mine!.label !== null) expect(keccak256(stringToBytes(mine!.label)).toLowerCase()).toBe(row.labelHash.toLowerCase());
    }
  }, 60_000);

  it("registry-feeds matches raw getConversionFeeds; live decimals match the aggregator's own", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, generation: FLAT_GEN, resource: "registry-feeds", format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(ours.state).toBe("ok");
    const ourItems = (ours.data as { items: Array<{ base: string; quote: string; aggregator: string; feedDecimals: number; live: { decimals: number } | null }> }).items;
    const { registry, client } = await ref42161();
    const [page] = await client.readContract({ address: registry, abi: refAbi, functionName: "getConversionFeeds", args: [0n, 200n] });
    expect(ourItems.length).toBe(page.length);
    for (const row of page) {
      const mine = ourItems.find((i) => i.base.toLowerCase() === row.base.toLowerCase() && i.quote.toLowerCase() === row.quote.toLowerCase());
      expect(mine, `feed ${row.base}→${row.quote} missing from our read`).toBeDefined();
      expect(mine!.aggregator.toLowerCase()).toBe(row.aggregatorAddress.toLowerCase());
      expect(mine!.feedDecimals).toBe(row.feedDecimals);
      // The live answer is block-conditioned; the decimals (drift-detector input) must agree
      // with what the aggregator itself reports.
      if (mine!.live) {
        const dec = await client.readContract({ address: row.aggregatorAddress, abi: refAbi, functionName: "decimals" });
        expect(mine!.live.decimals).toBe(dec);
      }
    }
  }, 60_000);

  it("fixed-rate oracle prediction matches the registry's own predictFixedRateOracle view", async () => {
    const RATE = (10n ** 18n).toString();
    const ours = await runTool("cork_query", { chainId: 42161, generation: FLAT_GEN, resource: "registry-oracle", filters: { rate: RATE }, format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(ours.state).toBe("ok");
    const od = (ours.data as { oracle: { address: string; deployed: boolean } }).oracle;
    const { registry, client } = await ref42161();
    // Genuinely independent derivations: the reader simulates the deploy; the reference asks
    // the on-chain prediction view and checks code existence directly.
    const predicted = await client.readContract({ address: registry, abi: refAbi, functionName: "predictFixedRateOracle", args: [10n ** 18n] });
    expect(od.address.toLowerCase()).toBe(predicted.toLowerCase());
    const code = await client.getCode({ address: predicted });
    expect(od.deployed).toBe(code !== undefined && code !== "0x");
  }, 60_000);

  it("pair oracle prediction (price mode) matches raw lookupWrapper / a raw deploy simulation", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, generation: FLAT_GEN, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF, mode: "price" }, format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(ours.state).toBe("ok");
    const od = (ours.data as { oracle: { address: string; deployed: boolean } }).oracle;
    const { registry, client } = await ref42161();
    const wrapper = await client.readContract({ address: registry, abi: refAbi, functionName: "lookupWrapper", args: [CA, REF, PRICE_MODE] });
    if (wrapper !== zeroAddress) {
      expect(od.deployed).toBe(true);
      expect(od.address.toLowerCase()).toBe(wrapper.toLowerCase());
    } else {
      expect(od.deployed).toBe(false);
      const sim = await client.simulateContract({ address: registry, abi: refAbi, functionName: "deploy", args: [CA, REF, PRICE_MODE] });
      expect(od.address.toLowerCase()).toBe(sim.result.toLowerCase());
    }
  }, 60_000);

  /** 0.3.3 (2026-08-10): the recipes are deployed on 42161 but NOT YET approved there
   *  (isRecipe false ×3; they ARE approved on Base). Recipe-dependent legs adapt to that
   *  live state instead of pinning it: unapproved → assert the honest recipe_not_found gate;
   *  approved (the moment the contracts team's approval txs land) → full wei-for-wei parity, no edit needed. */
  const liqApprovedOn42161 = async (): Promise<boolean> => {
    const r = await runTool("cork_query", { chainId: 42161, generation: FLAT_GEN, resource: "registry-recipes", format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(r.state).toBe("ok");
    return (r.data as { items: Array<{ address: string }> }).items.some((i) => i.address.toLowerCase() === LIQ.toLowerCase());
  };

  it("recipe-rate-constraint matches a raw recipe.resolve staticcall wei-for-wei (liquidity + anchor)", async () => {
    const approved = await liqApprovedOn42161();
    const ours = await runTool(
      "cork_compute",
      { chainId: 42161, generation: FLAT_GEN, params: { kind: "recipe-rate-constraint", recipe: LIQ, collateralAsset: CA, referenceAsset: REF, args: ANCHOR_ARGS }, format: "concise" },
      { nowSeconds: 1_790_000_000n },
    );
    if (!approved) {
      // The tool must refuse to resolve against an unapproved recipe — a constraint a fill
      // would reject (RecipeRejectedConstraint at best, OrderNotForPool at worst) must not
      // be signable-looking. Flips to the full-parity branch when the approvals land.
      expect(ours.state).toBe("unavailable");
      expect(ours.warnings.some((w) => w.code === "recipe_not_found")).toBe(true);
      return;
    }
    expect(ours.state).toBe("ok");
    const oc = (ours.data as { constraint: Record<string, string> }).constraint;
    const { registry, client } = await ref42161();
    // Mirror the documented oracle resolution independently: the pair's live wrapper if
    // deployed, address(0) otherwise (which is what lets the liquidity recipe take the
    // anchor fallback from args).
    const wrapper = await client.readContract({ address: registry, abi: refAbi, functionName: "lookupWrapper", args: [CA, REF, PRICE_MODE] });
    const raw = await client.readContract({ address: LIQ, abi: refAbi, functionName: "resolve", args: [CA, REF, wrapper, ANCHOR_ARGS] });
    expect(oc["rateMin"]).toBe(raw.rateMin.toString());
    expect(oc["rateMax"]).toBe(raw.rateMax.toString());
    expect(oc["rateChangePerDayMax"]).toBe(raw.rateChangePerDayMax.toString());
    expect(oc["rateChangeCapacityMax"]).toBe(raw.rateChangeCapacityMax.toString());
  }, 60_000);

  // weETH/wstETH: a second registered pair, kept so the derive leg is not single-pair. (Under
  // 0.3.2 this was the "clean" pair vs the sUSDe/sUSDS CREATE2-collision pair; 0.3.3 keys the
  // wrapper salt on the registry address, so the collision class is gone — its leg below now
  // pins deployability instead of the divergence.)
  const CLEAN_CA = "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe"; // weETH
  const CLEAN_REF = "0x5979D7b546E38E414F7E9822514be443A4800529"; // wstETH

  it("derive-cork-pool: oracle matches the raw prediction; poolId re-derives from an independent encode", async () => {
    const approved = await liqApprovedOn42161();
    const ours = await runTool(
      "cork_query",
      { chainId: 42161, generation: FLAT_GEN, resource: "derive-cork-pool", filters: { collateralAsset: CLEAN_CA, referenceAsset: CLEAN_REF, expiry: "1900000000", recipe: LIQ, args: ANCHOR_ARGS }, format: "concise" },
      { nowSeconds: 1_790_000_000n },
    );
    if (!approved) {
      // Same adaptive gate as the constraint leg: derivation refuses an unapproved recipe.
      expect(ours.state).toBe("unavailable");
      expect(ours.warnings.some((w) => w.code === "recipe_not_found")).toBe(true);
      return;
    }
    expect(ours.state).toBe("ok");
    const od = ours.data as { oracle: { address: string; deployed: boolean }; pool: { poolId: string; exists: boolean; constraint: Record<string, string> } | null };
    const { registry, client } = await ref42161();
    // Oracle leg: same independent reference as the pair-oracle test, on the clean pair.
    const wrapper = await client.readContract({ address: registry, abi: refAbi, functionName: "lookupWrapper", args: [CLEAN_CA, CLEAN_REF, PRICE_MODE] });
    if (wrapper !== zeroAddress) {
      expect(od.oracle.deployed).toBe(true);
      expect(od.oracle.address.toLowerCase()).toBe(wrapper.toLowerCase());
    } else {
      expect(od.oracle.deployed).toBe(false);
      const sim = await client.simulateContract({ address: registry, abi: refAbi, functionName: "deploy", args: [CLEAN_CA, CLEAN_REF, PRICE_MODE] });
      expect(od.oracle.address.toLowerCase()).toBe(sim.result.toLowerCase());
    }
    // Identity leg: MarketId = keccak256(abi.encode(Market)) — re-encoded HERE with the struct
    // layout declared independently (CorkPoolManager.sol field order), so a field-order or
    // encoding bug in marketid.ts fails live too, against the reported constraint + oracle.
    // (The constraint VALUES are cross-checked wei-for-wei in the resolve leg; the share
    // prediction is proven end-to-end by the fork harness, which needs state overrides no
    // public RPC serves reliably.)
    expect(od.pool).not.toBeNull();
    const c = od.pool!.constraint;
    const encoded = encodeAbiParameters(
      [{
        type: "tuple",
        components: [
          { name: "collateralAsset", type: "address" },
          { name: "referenceAsset", type: "address" },
          { name: "expiryTimestamp", type: "uint256" },
          { name: "rateMin", type: "uint256" },
          { name: "rateMax", type: "uint256" },
          { name: "rateChangePerDayMax", type: "uint256" },
          { name: "rateChangeCapacityMax", type: "uint256" },
          { name: "rateOracle", type: "address" },
        ],
      }],
      [{
        collateralAsset: CLEAN_CA,
        referenceAsset: CLEAN_REF,
        expiryTimestamp: 1_900_000_000n,
        rateMin: BigInt(c["rateMin"]!),
        rateMax: BigInt(c["rateMax"]!),
        rateChangePerDayMax: BigInt(c["rateChangePerDayMax"]!),
        rateChangeCapacityMax: BigInt(c["rateChangeCapacityMax"]!),
        rateOracle: od.oracle.address as `0x${string}`,
      }],
    );
    expect(od.pool!.poolId.toLowerCase()).toBe(keccak256(encoded).toLowerCase());
  }, 90_000);

  it("collision pair (sUSDe/sUSDS): DEPLOYABLE on the 0.3.3 registry — the wrapper-salt fix, pinned live", async () => {
    // FLIPPED 2026-08-10, exactly as the pre-flip comment instructed. Under 0.3.2 the wrapper
    // salt had no generation domain: this pair's PRICE-oracle address was occupied by the
    // previous generation's oracle and deploy reverted with no data (fork-proven 2026-08-08;
    // OUR derive answered oracle.address null + oracle_not_deployable while the API's predict
    // handed out the colliding address). 0.3.3 keys the wrapper salt on the registry address —
    // every registry gets its own salt space — so the same pair now simulates DEPLOYABLE.
    // registry-oracle (not derive) is the right probe: deployability needs no recipe, so this
    // leg stays green whether or not the 42161 recipe approvals have landed.
    const ours = await runTool(
      "cork_query",
      { chainId: 42161, generation: FLAT_GEN, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF, mode: "price" }, format: "concise" },
      { nowSeconds: 1_790_000_000n },
    );
    expect(ours.state).toBe("ok");
    const od = (ours.data as { oracle: { address: string | null; deployed: boolean; deployable: boolean } }).oracle;
    expect(od.deployable).toBe(true);
    expect(od.address).not.toBeNull();
    // Independent confirmation of the same verdict: a raw deploy simulation must succeed and
    // predict the same address the reader reports (under 0.3.2 this very call reverted with
    // no data — the collision), and the deployed flag must agree with a raw lookupWrapper.
    const { registry, client } = await ref42161();
    const wrapper = await client.readContract({ address: registry, abi: refAbi, functionName: "lookupWrapper", args: [CA, REF, PRICE_MODE] });
    expect(od.deployed).toBe(wrapper !== zeroAddress);
    if (wrapper === zeroAddress) {
      const sim = await client.simulateContract({ address: registry, abi: refAbi, functionName: "deploy", args: [CA, REF, PRICE_MODE] });
      expect(od.address!.toLowerCase()).toBe(sim.result.toLowerCase());
    } else {
      expect(od.address!.toLowerCase()).toBe(wrapper.toLowerCase());
    }
  }, 90_000);
});

// CorkMarketCreator (cork-periphery 0.1.0) — live parity on Base: the tool's create-pool
// prepare against the DEPLOYED creator. The reference is a raw eth_call of the tool-built
// calldata: the contract itself runs the whole derivation (recipe membership → oracle deploy →
// constraint verify → derivation) and returns (poolId, cst, cpt) — which must equal the
// tool's own predicted pool block wei-for-wei. First proven 2026-08-28 (two anchors, both
// triples byte-exact).
describe.skipIf(!LIVE)("CorkMarketCreator — live parity (Base)", () => {
  // mwUSDC (nav source) / USDC — both registered on Base; the NAV LiquidityRecipe.
  const MW_USDC = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca" as const;
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
  const NAV_RECIPE = "0xAeD3D0e3C86A994d88741C285657c3e78550f66d" as const;
  // Wide-window anchor (the nav liquidity recipe resolves rateMin=1, rateMax=2×anchor): the
  // live NAV (~1.086 CA-quoted or its inverse) sits inside the window either way, so
  // recipe.verify passes at creation whichever direction the wrapper reports.
  const ANCHOR = `0x${(105n * 10n ** 16n).toString(16).padStart(64, "0")}` as const;
  const creatorAbi = parseAbi([
    "function POOL_MANAGER() view returns (address)",
    "function CONTROLLER() view returns (address)",
    "function MARKET_REGISTRY() view returns (address)",
    "function version() view returns (string)",
    "function POOL_CREATOR_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ]);

  it("the configured creator answers its views, matches the config wiring, and holds POOL_CREATOR_ROLE", async () => {
    const { resolveMarketRegistry, resolveConfig } = await import("@cork/core");
    const { marketRegistry: mr } = await resolveMarketRegistry(8453, undefined, FLAT_GEN);
    expect(mr?.marketCreator).toBeDefined();
    expect(mr?.controller).toBeDefined();
    const cfg = await resolveConfig();
    const pm = generationsOf(cfg.defaults, 8453).find((g) => g.marketRegistry?.registry === mr!.registry)?.phoenix?.poolManager as `0x${string}`;
    const r = await resolveRpc(8453, undefined);
    expect(r).not.toBeNull();
    const creator = mr!.marketCreator as `0x${string}`;
    const [boundPm, boundController, boundRegistry, version] = await Promise.all([
      r!.client.readContract({ address: creator, abi: creatorAbi, functionName: "POOL_MANAGER" }),
      r!.client.readContract({ address: creator, abi: creatorAbi, functionName: "CONTROLLER" }),
      r!.client.readContract({ address: creator, abi: creatorAbi, functionName: "MARKET_REGISTRY" }),
      r!.client.readContract({ address: creator, abi: creatorAbi, functionName: "version" }),
    ]);
    expect(boundPm.toLowerCase()).toBe(pm.toLowerCase());
    expect(boundController.toLowerCase()).toBe(mr!.controller!.toLowerCase());
    expect(boundRegistry.toLowerCase()).toBe(mr!.registry.toLowerCase());
    expect(version).toBe("0.1.0");
    const role = await r!.client.readContract({ address: boundController, abi: creatorAbi, functionName: "POOL_CREATOR_ROLE" });
    expect(await r!.client.readContract({ address: boundController, abi: creatorAbi, functionName: "hasRole", args: [role, creator] })).toBe(true);
  }, 60_000);

  it("a raw eth_call of tool-built createNewPool calldata returns the tool's exact predicted (poolId, cst, cpt)", async () => {
    // Expiry inside the registry's 30-day creation bound at run time.
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 20 * 86_400);
    const env = await runTool(
      "cork_prepare_market",
      { chainId: 8453, generation: FLAT_GEN, clientRequestId: `live-creator-${expiry}`, action: { type: "create-pool", collateralAsset: MW_USDC, referenceAsset: USDC, expiryTimestamp: expiry.toString(), recipe: NAV_RECIPE, additionalData: ANCHOR } },
      { nowSeconds: expiry - 20n * 86_400n },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { to: `0x${string}`; calldata: `0x${string}`; pool: { poolId: string; exists: boolean }; shares: { corkSwapToken: string | null; corkPrincipalToken: string | null } | undefined };
    expect(d.pool?.poolId).toBeDefined();
    const r = await resolveRpc(8453, undefined);
    const res = await r!.client.call({ to: d.to, data: d.calldata });
    expect(res.data).toBeDefined();
    const poolId = res.data!.slice(0, 66);
    const cst = `0x${res.data!.slice(2 + 64 + 24, 2 + 128)}`;
    const cpt = `0x${res.data!.slice(2 + 128 + 24, 2 + 192)}`;
    expect(poolId.toLowerCase()).toBe(d.pool.poolId.toLowerCase());
    // When the share simulation ran (eth_simulateV1 supported), the triple must match exactly.
    if (d.shares?.corkSwapToken) expect(cst.toLowerCase()).toBe(d.shares.corkSwapToken.toLowerCase());
    if (d.shares?.corkPrincipalToken) expect(cpt.toLowerCase()).toBe(d.shares.corkPrincipalToken.toLowerCase());
  }, 90_000);
});

// Nested-wire parity (market-registry 0.5.0, the phoenix/v0.4-rc.1 PRIMARY on Arbitrum): the same
// independent-reference discipline as the flat suite above, with the ABI re-declared HERE from the
// Sourcify exact-match verification of the deployed registry 0xe1f5…55c5 (fetched 2026-10-01) —
// `deploy` takes an oracleSalt, denominations are ADDRESS units, feeds carry no feedDecimals, and
// the pool id is the 10-field Market with the two fees INSIDE (CorkPoolManager v1.4.0-rc.1 field
// order, re-declared below). Nothing is imported from market-registry.ts or marketid.ts.
describe.skipIf(!LIVE)("0.5.0 registry (nested wire, the primary) — live parity vs an independent raw-read reference", () => {
  const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"; // sUSDe (registered on the 0.5.0 registry 2026-09-23)
  const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610"; // sUSDS (registered on the 0.5.0 registry 2026-09-23)
  const LIQ = "0x679Cbd016587c423f342e5Ba31e58356228c964d"; // LiquidityRecipe of the 0.5.0 set
  const ANCHOR_ARGS = `0x${(10n ** 18n).toString(16).padStart(64, "0")}` as const; // abi.encode(1e18)
  const PRICE_MODE = 0; // OracleMode.PRICE
  const ZERO_SALT = `0x${"00".repeat(32)}` as const;
  const EXPIRY = 1_900_000_000n;
  const ctx = { nowSeconds: 1_790_000_000n };

  const nestedAbi = parseAbi([
    "struct AssetSource { address addr; uint8 sourceType; uint8 sourceInterface; address denomination; }",
    "struct Asset { address addr; string name; uint8 kind; AssetSource priceSource; AssetSource navSource; }",
    "struct ConversionFeed { address base; address quote; address aggregatorAddress; }",
    "function getAssets(uint256 offset, uint256 limit) view returns (Asset[] page, uint256 total)",
    "function getConversionFeeds(uint256 offset, uint256 limit) view returns (ConversionFeed[] page, uint256 total)",
    "function getDenominations(uint256 offset, uint256 limit) view returns (address[] page, uint256 total)",
    "function getRecipes(uint256 offset, uint256 limit) view returns (address[] page, uint256 total)",
    "function isRecipe(address recipe) view returns (bool)",
    "function lookupWrapper(address ca, address ref, uint8 mode) view returns (address wrapper)",
    "function predictFixedRateOracle(uint256 rate) view returns (address oracle)",
    "function deploy(address ca, address ref, uint8 mode, bytes32 oracleSalt) returns (address wrapper)",
    "function version() pure returns (string)",
    "function source() view returns (uint8)",
    "function decimals() view returns (uint8)",
    "function resolve(address ca, address ref, address rateOracle, bytes extraData) view returns ((uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint)",
  ]);
  const REF_RECIPE_SOURCE = ["nav", "price", "fixed"] as const;

  const primary42161 = async () => {
    const { resolveMarketRegistry } = await import("@cork/core");
    const { marketRegistry: mr, generation } = await resolveMarketRegistry(42161);
    expect(generation?.wire).toBe("nested"); // no generation passed = the PRIMARY, and the primary speaks the nested wire
    expect(generation?.label).toBe("phoenix/v0.4-rc.1");
    const r = await resolveRpc(42161, undefined);
    expect(r).not.toBeNull();
    return { registry: mr!.registry as `0x${string}`, client: r!.client };
  };

  it("the primary registry is the 0.5.0 contract (version() says so) and answers the nested views", async () => {
    const { registry, client } = await primary42161();
    expect(await client.readContract({ address: registry, abi: nestedAbi, functionName: "version" })).toBe("0.5.0");
    const [, total] = await client.readContract({ address: registry, abi: nestedAbi, functionName: "getAssets", args: [0n, 1n] });
    expect(total).toBeGreaterThan(0n);
  }, 30_000);

  it("registry-assets (primary) matches a raw one-shot getAssets read; denominations are address units", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, resource: "registry-assets", format: "concise" }, ctx);
    expect(ours.state).toBe("ok");
    const items = (ours.data as { items: Array<{ address: string; priceSource: { address: string; denomination: string } | null }> }).items;
    const { registry, client } = await primary42161();
    const [page] = await client.readContract({ address: registry, abi: nestedAbi, functionName: "getAssets", args: [0n, 500n] });
    expect(items.map((i) => i.address.toLowerCase()).sort()).toEqual(page.map((a) => a.addr.toLowerCase()).sort());
    for (const row of page) {
      const mine = items.find((i) => i.address.toLowerCase() === row.addr.toLowerCase())!;
      if (row.priceSource.addr === zeroAddress) expect(mine.priceSource).toBeNull();
      else {
        expect(mine.priceSource!.address.toLowerCase()).toBe(row.priceSource.addr.toLowerCase());
        // The denomination is an ADDRESS on this wire — served verbatim, never a label.
        expect(mine.priceSource!.denomination.toLowerCase()).toBe(row.priceSource.denomination.toLowerCase());
      }
    }
  }, 60_000);

  it("registry-recipes (primary) matches raw getRecipes + per-recipe source()/constant reads", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, resource: "registry-recipes", format: "concise" }, ctx);
    expect(ours.state).toBe("ok");
    const items = (ours.data as { items: Array<{ address: string; source: string; constants: Record<string, string> }> }).items;
    const { registry, client } = await primary42161();
    const [addrs] = await client.readContract({ address: registry, abi: nestedAbi, functionName: "getRecipes", args: [0n, 100n] });
    expect(items.map((i) => i.address.toLowerCase()).sort()).toEqual(addrs.map((a) => a.toLowerCase()).sort());
    for (const addr of addrs) {
      const mine = items.find((i) => i.address.toLowerCase() === addr.toLowerCase())!;
      const ordinal = await client.readContract({ address: addr, abi: nestedAbi, functionName: "source" });
      expect(mine.source, `source of ${addr}`).toBe(REF_RECIPE_SOURCE[ordinal]);
      for (const [name, v] of Object.entries(mine.constants)) {
        const raw = await client.readContract({ address: addr, abi: parseAbi([`function ${name}() view returns (uint256)`] as const), functionName: name });
        expect(String(raw), `constant ${name} on ${addr}`).toBe(v);
      }
    }
  }, 90_000);

  it("registry-denominations (primary) matches raw getDenominations — address units, same set, same order", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, resource: "registry-denominations", format: "concise" }, ctx);
    expect(ours.state).toBe("ok");
    const items = (ours.data as { items: Array<{ unit: string }> }).items;
    const { registry, client } = await primary42161();
    const [page] = await client.readContract({ address: registry, abi: nestedAbi, functionName: "getDenominations", args: [0n, 200n] });
    expect(items.map((i) => i.unit.toLowerCase())).toEqual(page.map((u) => u.toLowerCase()));
    // The flat-wire filter is refused on this wire with teaching, never answered from a stale table.
    const byLabel = await runTool("cork_query", { chainId: 42161, resource: "registry-denominations", filters: { label: "USD" }, format: "concise" }, ctx);
    expect(byLabel.state).not.toBe("ok");
  }, 60_000);

  it("registry-feeds (primary) matches raw getConversionFeeds (3-tuple, no feedDecimals); live decimals match the aggregator", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, resource: "registry-feeds", format: "concise" }, ctx);
    expect(ours.state).toBe("ok");
    const items = (ours.data as { items: Array<{ base: string; quote: string; aggregator: string; feedDecimals?: number; live: { decimals: number } | null }> }).items;
    const { registry, client } = await primary42161();
    const [page] = await client.readContract({ address: registry, abi: nestedAbi, functionName: "getConversionFeeds", args: [0n, 200n] });
    expect(items.length).toBe(page.length);
    for (const row of page) {
      const mine = items.find((i) => i.base.toLowerCase() === row.base.toLowerCase() && i.quote.toLowerCase() === row.quote.toLowerCase());
      expect(mine, `feed ${row.base}→${row.quote} missing from our read`).toBeDefined();
      expect(mine!.aggregator.toLowerCase()).toBe(row.aggregatorAddress.toLowerCase());
      expect(mine!.feedDecimals, "feedDecimals is a flat-wire field; the nested row must not invent one").toBeUndefined();
      if (mine!.live) {
        const dec = await client.readContract({ address: row.aggregatorAddress, abi: nestedAbi, functionName: "decimals" });
        expect(mine!.live.decimals).toBe(dec);
      }
    }
  }, 60_000);

  it("fixed-rate oracle prediction (primary) matches the registry's own predictFixedRateOracle view", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { rate: (10n ** 18n).toString() }, format: "concise" }, ctx);
    expect(ours.state).toBe("ok");
    const od = (ours.data as { oracle: { address: string; deployed: boolean } }).oracle;
    const { registry, client } = await primary42161();
    const predicted = await client.readContract({ address: registry, abi: nestedAbi, functionName: "predictFixedRateOracle", args: [10n ** 18n] });
    expect(od.address.toLowerCase()).toBe(predicted.toLowerCase());
    const code = await client.getCode({ address: predicted });
    expect(od.deployed).toBe(code !== undefined && code !== "0x");
  }, 60_000);

  it("pair oracle prediction (price mode, primary) matches raw lookupWrapper / a raw 4-argument deploy simulation with the zero salt", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF, mode: "price" }, format: "concise" }, ctx);
    expect(ours.state).toBe("ok");
    const od = (ours.data as { oracle: { address: string; deployed: boolean } }).oracle;
    const { registry, client } = await primary42161();
    const wrapper = await client.readContract({ address: registry, abi: nestedAbi, functionName: "lookupWrapper", args: [CA, REF, PRICE_MODE] });
    if (wrapper !== zeroAddress) {
      expect(od.deployed).toBe(true);
      expect(od.address.toLowerCase()).toBe(wrapper.toLowerCase());
    } else {
      expect(od.deployed).toBe(false);
      const sim = await client.simulateContract({ address: registry, abi: nestedAbi, functionName: "deploy", args: [CA, REF, PRICE_MODE, ZERO_SALT] });
      expect(od.address.toLowerCase()).toBe(sim.result.toLowerCase());
    }
  }, 60_000);

  const liqApproved = async (): Promise<boolean> => {
    const { registry, client } = await primary42161();
    return client.readContract({ address: registry, abi: nestedAbi, functionName: "isRecipe", args: [LIQ] });
  };

  it("recipe-rate-constraint (primary) matches a raw recipe.resolve staticcall wei-for-wei", async () => {
    const ours = await runTool("cork_compute", { chainId: 42161, params: { kind: "recipe-rate-constraint", recipe: LIQ, collateralAsset: CA, referenceAsset: REF, args: ANCHOR_ARGS }, format: "concise" }, ctx);
    if (!(await liqApproved())) {
      expect(ours.state).toBe("unavailable");
      expect(ours.warnings.some((w) => w.code === "recipe_not_found")).toBe(true);
      return;
    }
    expect(ours.state).toBe("ok");
    const oc = (ours.data as { constraint: Record<string, string> }).constraint;
    const { registry, client } = await primary42161();
    const wrapper = await client.readContract({ address: registry, abi: nestedAbi, functionName: "lookupWrapper", args: [CA, REF, PRICE_MODE] });
    const raw = await client.readContract({ address: LIQ, abi: nestedAbi, functionName: "resolve", args: [CA, REF, wrapper, ANCHOR_ARGS] });
    expect(oc["rateMin"]).toBe(raw.rateMin.toString());
    expect(oc["rateMax"]).toBe(raw.rateMax.toString());
    expect(oc["rateChangePerDayMax"]).toBe(raw.rateChangePerDayMax.toString());
    expect(oc["rateChangeCapacityMax"]).toBe(raw.rateChangeCapacityMax.toString());
  }, 60_000);

  it("derive-cork-pool (primary): oracle matches the raw prediction; the 10-field poolId re-derives from an independent encode with the fees INSIDE", async () => {
    const fees = { swapFeePercentage: (10n ** 18n).toString(), unwindSwapFeePercentage: (5n * 10n ** 17n).toString() }; // 1% / 0.5% — part of the id on this wire
    const ours = await runTool("cork_query", { chainId: 42161, resource: "derive-cork-pool", filters: { collateralAsset: CA, referenceAsset: REF, expiry: EXPIRY.toString(), recipe: LIQ, args: ANCHOR_ARGS, ...fees }, format: "concise" }, ctx);
    if (!(await liqApproved())) {
      expect(ours.state).toBe("unavailable");
      expect(ours.warnings.some((w) => w.code === "recipe_not_found")).toBe(true);
      return;
    }
    expect(ours.state).toBe("ok");
    const od = ours.data as { oracle: { address: string; deployed: boolean }; pool: { poolId: string; constraint: Record<string, string> } | null };
    const { registry, client } = await primary42161();
    const wrapper = await client.readContract({ address: registry, abi: nestedAbi, functionName: "lookupWrapper", args: [CA, REF, PRICE_MODE] });
    if (wrapper !== zeroAddress) expect(od.oracle.address.toLowerCase()).toBe(wrapper.toLowerCase());
    else {
      const sim = await client.simulateContract({ address: registry, abi: nestedAbi, functionName: "deploy", args: [CA, REF, PRICE_MODE, ZERO_SALT] });
      expect(od.oracle.address.toLowerCase()).toBe(sim.result.toLowerCase());
    }
    expect(od.pool).not.toBeNull();
    const c = od.pool!.constraint;
    // Market (v1.4.0-rc.1, 10 fields): the two fees AFTER rateOracle, swap THEN unwind.
    const encoded = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "collateralAsset", type: "address" }, { name: "referenceAsset", type: "address" }, { name: "expiryTimestamp", type: "uint256" },
        { name: "rateMin", type: "uint256" }, { name: "rateMax", type: "uint256" }, { name: "rateChangePerDayMax", type: "uint256" }, { name: "rateChangeCapacityMax", type: "uint256" },
        { name: "rateOracle", type: "address" }, { name: "swapFeePercentage", type: "uint256" }, { name: "unwindSwapFeePercentage", type: "uint256" },
      ] }],
      [{ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: EXPIRY, rateMin: BigInt(c["rateMin"]!), rateMax: BigInt(c["rateMax"]!), rateChangePerDayMax: BigInt(c["rateChangePerDayMax"]!), rateChangeCapacityMax: BigInt(c["rateChangeCapacityMax"]!), rateOracle: od.oracle.address as `0x${string}`, swapFeePercentage: BigInt(fees.swapFeePercentage), unwindSwapFeePercentage: BigInt(fees.unwindSwapFeePercentage) }],
    );
    expect(od.pool!.poolId.toLowerCase()).toBe(keccak256(encoded).toLowerCase());
    // The fees are IDENTITY on this wire: the same pair with zero fees is a different pool.
    const zeroFees = await runTool("cork_query", { chainId: 42161, resource: "derive-cork-pool", filters: { collateralAsset: CA, referenceAsset: REF, expiry: EXPIRY.toString(), recipe: LIQ, args: ANCHOR_ARGS }, format: "concise" }, ctx);
    expect(zeroFees.state).toBe("ok");
    expect((zeroFees.data as { pool: { poolId: string } }).pool.poolId).not.toBe(od.pool!.poolId);
  }, 90_000);
});
