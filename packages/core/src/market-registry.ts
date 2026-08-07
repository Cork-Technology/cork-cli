// MarketRegistry + CorkLimitOrderAdapter integration — contracts release 2.1.0 (Arbitrum One,
// deployed at block 489540043; ABI pinned against market-registry-private tag 2.1.0 commit
// 70c2cf8, cross-checked on-chain 2026-08-03: adapter immutables, recipe membership, factory
// bindings, predictFixedRateOracle parity with the read API).
//
// The 2.1.0 model (everything the legacy module did differently):
//  - A recipe is an approved CONTRACT ADDRESS (isRecipe is the only membership gate), not a mode
//    string. It self-reports source()/description() and resolves the four rate limits itself via
//    a staticcall — registry applyBands/percentage bands are gone from the public surface.
//  - The constraint is derived OFF-CHAIN at signing time and CARRIED in the order; on-chain the
//    fill only re-checks it with recipe.verify (false ⇒ RecipeRejectedConstraint). Pool id and
//    the CREATE2-derived share addresses are therefore PINNED the moment the order is signed —
//    market identity no longer follows the live rate.
//  - Pair oracles are MODE-KEYED (one pair can hold a PRICE and a NAV wrapper at different
//    addresses), and fixed-rate oracles are keyed on the RATE, not a pair.
//  - ENUM TRAP: RecipeSource is NAV=0,PRICE=1,FIXED=2 while OracleMode/SourceType are
//    PRICE=0,NAV=1 — inverted. Never pass one where the other is expected.
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, size, sliceHex, toEventSelector, toHex } from "viem";
import type { PublicClient } from "viem";
import { computeMarketId } from "./marketid.ts";
import type { Market } from "./types.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// ── Enums (numeric values from IMarketRegistry.sol / IMarketRecipe.sol, tag 2.1.0) ──────────
export const ASSET_KIND = ["ERC20", "ERC4626"] as const;
export const SOURCE_TYPE = ["PRICE", "NAV"] as const;
export const SOURCE_INTERFACE = ["AGGREGATOR_V3", "ERC4626"] as const;
/** OracleMode: PRICE=0, NAV=1 (NOT the RecipeSource ordering). */
export const ORACLE_MODE = { price: 0, nav: 1 } as const;
export type OracleModeName = keyof typeof ORACLE_MODE;
/** RecipeSource: NAV=0, PRICE=1, FIXED=2 (inverted vs OracleMode — deliberate upstream). */
export const RECIPE_SOURCE = ["nav", "price", "fixed"] as const;
export type RecipeSourceName = (typeof RECIPE_SOURCE)[number];

/** The OracleMode ordinal a fill would use for a recipe source (FIXED has no pair oracle). */
export function oracleModeForSource(source: RecipeSourceName): (typeof ORACLE_MODE)[OracleModeName] | null {
  if (source === "fixed") return null;
  return ORACLE_MODE[source];
}

// ── ABIs (pinned tag 2.1.0) ─────────────────────────────────────────────────────────────────
export const marketRegistryAbi = parseAbi([
  "struct AssetSource { address addr; uint8 sourceType; uint8 sourceInterface; string denomination; }",
  "struct Asset { address addr; string name; uint8 kind; AssetSource priceSource; AssetSource navSource; }",
  "struct ConversionFeed { address base; address quote; address aggregatorAddress; uint8 feedDecimals; }",
  "struct Denomination { bytes32 labelHash; address unit; }",
  "function WRAPPER_FACTORY() view returns (address)",
  "function FIXED_RATE_ORACLE_FACTORY() view returns (address)",
  "function owner() view returns (address)",
  "function isAsset(address addr) view returns (bool)",
  "function isRecipe(address recipe) view returns (bool)",
  "function lookupAssetByAddress(address addr) view returns (bool found, Asset entry)",
  "function lookupAssetByName(string name) view returns (bool found, Asset entry)",
  "function lookupConversionFeed(address base, address quote) view returns (bool found, ConversionFeed entry)",
  "function lookupDenomination(string label) view returns (bool found, address unit)",
  "function lookupWrapper(address ca, address ref, uint8 mode) view returns (address wrapper)",
  "function predictFixedRateOracle(uint256 rate) view returns (address oracle)",
  "function getAssets(uint256 offset, uint256 limit) view returns (Asset[] page, uint256 total)",
  "function getConversionFeeds(uint256 offset, uint256 limit) view returns (ConversionFeed[] page, uint256 total)",
  "function getDenominations(uint256 offset, uint256 limit) view returns (Denomination[] page, uint256 total)",
  "function getRecipes(uint256 offset, uint256 limit) view returns (address[] page, uint256 total)",
  "function deploy(address ca, address ref, uint8 mode) returns (address wrapper)",
  "function deployFixedRateOracle(uint256 rate) returns (address oracle)",
]);

export const recipeAbi = parseAbi([
  "function source() view returns (uint8)",
  "function description() view returns (string)",
  "function REGISTRY() view returns (address)",
  "function resolve(address ca, address ref, address rateOracle, bytes additionalData) view returns ((uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint)",
  "function verify(address ca, address ref, address rateOracle, (uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint, bytes additionalData) view returns (bool ok)",
]);

/** Token self-description for asset/denomination display (best-effort — a token that will not
 *  name itself degrades to nulls, never a failed read). */
export const erc20MetadataAbi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** Chainlink-style aggregator surface for conversion-feed live answers. */
export const aggregatorV3Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** Chainlink pseudo-addresses used as denomination units for fiat/native labels — code-less, so
 *  their display text comes from this table instead of symbol(). */
export const DENOMINATION_PSEUDO_UNITS: Record<string, string> = {
  "0x0000000000000000000000000000000000000348": "USD", // ISO-4217 code 840
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": "ETH",
};

export const jitAdapterAbi = parseAbi([
  "function LIMIT_ORDER_PROTOCOL() view returns (address)",
  "function POOL_MANAGER() view returns (address)",
  "function CONTROLLER() view returns (address)",
  "function MARKET_REGISTRY() view returns (address)",
]);

export const accessControlAbi = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

/** The controller's own self-descriptive views: its pool-manager binding (the pool manager its
 *  createNewPool creates on) and the fee-authority role constant that only the 0.3.2-generation
 *  controller exposes — the generation marker for the adapter's required role set. */
export const controllerViewsAbi = parseAbi([
  "function CORK_POOL_MANAGER() view returns (address)",
  "function FEE_MANAGER_ROLE() view returns (bytes32)",
]);

/** DefaultCorkController.createNewPool — used in state-override simulations to predict the cST
 *  of a not-yet-created pool. Field order is load-bearing: unwind fee BEFORE swap fee. */
export const controllerCreatePoolAbi = parseAbi([
  "struct Market_ { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; address rateOracle; }",
  "struct PoolCreationParams { Market_ pool; uint256 unwindSwapFeePercentage; uint256 swapFeePercentage; bool isWhitelistEnabled; }",
  "function createNewPool(PoolCreationParams params)",
]);

/** Controller role hashes (keccak256 of the role name; declared in DefaultCorkController). */
export const POOL_CREATOR_ROLE = "0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52" as const;
export const CONFIGURATOR_ROLE = "0x3b49a237fe2d18fa4d9642b8a0e065923cceb71b797783b619a030a61d848bf0" as const;

/** Controller-role pre-flight shared by every JIT prepare site (maker, taker-fill, legacy).
 *  The granted/missing decision lives in exactly this one comparator so a single mutation
 *  probe covers every call site — duplicated identical conditionals defeat first-occurrence
 *  probes. Role hashes are identical across registry generations; pass overrides if that
 *  ever diverges. */
export async function readAdapterRoles(
  client: PublicClient,
  controller: `0x${string}`,
  adapter: `0x${string}`,
  roles: { creator?: `0x${string}`; second?: `0x${string}`; secondLabel?: string } = {},
): Promise<{ hasCreator: boolean; hasSecond: boolean; secondRole: string; granted: boolean }> {
  // The controller's own surface decides which SECOND role the adapter needs (chain outranks
  // config): the 0.3.2-generation controller splits fee authority into FEE_MANAGER_ROLE — a
  // public constant view that answers, and the role the rollout grants alongside POOL_CREATOR
  // — while earlier controllers gate fees behind CONFIGURATOR_ROLE. The probed value is used
  // as the role id itself, so even a renamed hash follows the deployed truth. An explicit
  // roles.second override (the pre-2.1.0 legacy path) skips the probe.
  let second = roles.second;
  let secondRole = roles.secondLabel ?? "CONFIGURATOR";
  if (second === undefined) {
    try {
      second = (await client.readContract({ address: controller, abi: controllerViewsAbi, functionName: "FEE_MANAGER_ROLE" })) as `0x${string}`;
      secondRole = "FEE_MANAGER";
    } catch {
      second = CONFIGURATOR_ROLE;
    }
  }
  const [hasCreator, hasSecond] = await Promise.all([
    client.readContract({ address: controller, abi: accessControlAbi, functionName: "hasRole", args: [roles.creator ?? POOL_CREATOR_ROLE, adapter] }),
    client.readContract({ address: controller, abi: accessControlAbi, functionName: "hasRole", args: [second, adapter] }),
  ]);
  return { hasCreator, hasSecond, secondRole, granted: hasCreator && hasSecond };
}

// ── Recipe constants catalog (mirrors the read API's hand-maintained annotation layer) ──────
// Keyed by lowercased recipe address (CREATE2 ⇒ chain-stable). Supplies only the constant getter
// NAMES + the additionalData arg annotation; every VALUE is read live off the recipe. Catalog
// absence is NOT a gate — isRecipe on chain is the only membership check; an uncatalogued recipe
// still lists, still self-describes, it just arrives with argsKnown:false.
export interface RecipeCatalogEntry {
  constants: readonly string[];
  args: { type: string; display: string } | null;
}
export const RECIPE_CATALOG: Record<string, RecipeCatalogEntry> = {
  // 0.3.2 recipes (identical addresses on 42161 + 8453; constant getters probed live on the
  // deployed contracts 2026-08-07 — both liquidity flavors carry the same band constants).
  "0xd27c7bb8564db019b41d9c48d1abced9a7d90291": {
    constants: ["RATE_MIN", "RATE_MIN_PERCENTAGE", "RATE_MAX_PERCENTAGE", "RATE_CHANGE_PER_DAY_MAX_PERCENTAGE", "RATE_CHANGE_CAPACITY_MAX_PERCENTAGE"],
    args: { type: "(uint256)", display: "abi.encode(uint256 anchorRate)" },
  },
  "0x1cf1ef3f0d2f59bf26a373ce7dcf0f88612c1506": {
    constants: ["RATE_MIN", "RATE_MIN_PERCENTAGE", "RATE_MAX_PERCENTAGE", "RATE_CHANGE_PER_DAY_MAX_PERCENTAGE", "RATE_CHANGE_CAPACITY_MAX_PERCENTAGE"],
    args: { type: "(uint256)", display: "abi.encode(uint256 anchorRate)" },
  },
  "0x6d838136bbbe7d34ce8dddc431ce1bb4a1f9d98d": {
    constants: ["WINDOW_WIDTH"],
    args: { type: "()", display: "no payload — the fixed-rate recipe rejects any additionalData" },
  },
};

/** One-getter ABI synthesized from a constant name alone (`RATE_MIN()` style, uint256 out). */
export function constantGetterAbi(name: string) {
  return [{ type: "function" as const, name, stateMutability: "view" as const, inputs: [], outputs: [{ type: "uint256" as const }] }];
}

// ── JIT hook payload (2.1.0 shape) + 1inch v4 extension building ────────────────────────────
export interface ResolvedConstraint {
  rateMin: bigint;
  rateMax: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
}

export interface JITMarketParams {
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  expiryTimestamp: bigint;
  /** The approved IMarketRecipe contract — required, never zero (no unverified path). */
  recipe: `0x${string}`;
  /** FIXED recipes only: the rate a FixedRateOracle is deployed at. Else MUST be 0 — a non-zero
   *  value on a price/nav recipe is REJECTED by the fill (UnexpectedRateOverride), not ignored. */
  rateOverride: bigint;
  /** The four limits, derived OFF-CHAIN at signing time (recipe.resolve) — part of pool identity. */
  constraint: ResolvedConstraint;
  /** The recipe-specific bytes the constraint was derived from (verify re-reads them). */
  additionalData: `0x${string}`;
  swapFeePercentage: bigint; // 1e18 = 1%, max 5e18 — consumed only when the fill creates the pool
  unwindSwapFeePercentage: bigint;
  enableJitMint: boolean; // gates the maker-side mint; IGNORED on the taker path (always mints)
}
export interface PermitParams {
  token: `0x${string}`;
  value: bigint;
  deadline: bigint;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

const JIT_PARAMS_ABI = [
  {
    type: "tuple" as const,
    components: [
      { name: "collateralAsset", type: "address" },
      { name: "referenceAsset", type: "address" },
      { name: "expiryTimestamp", type: "uint256" },
      { name: "recipe", type: "address" },
      { name: "rateOverride", type: "uint256" },
      {
        name: "constraint",
        type: "tuple",
        components: [
          { name: "rateMin", type: "uint256" },
          { name: "rateMax", type: "uint256" },
          { name: "rateChangePerDayMax", type: "uint256" },
          { name: "rateChangeCapacityMax", type: "uint256" },
        ],
      },
      { name: "additionalData", type: "bytes" },
      { name: "swapFeePercentage", type: "uint256" },
      { name: "unwindSwapFeePercentage", type: "uint256" },
      { name: "enableJitMint", type: "bool" },
    ],
  },
  {
    type: "tuple[]" as const,
    components: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
  },
];

/** Hook extraData = abi.encode(JITMarketParams, PermitParams[]) — the adapter decodes exactly this. */
export function encodeJitExtraData(params: JITMarketParams, permits: readonly PermitParams[] = []): `0x${string}` {
  return encodeAbiParameters(JIT_PARAMS_ABI, [
    {
      collateralAsset: params.collateralAsset,
      referenceAsset: params.referenceAsset,
      expiryTimestamp: params.expiryTimestamp,
      recipe: params.recipe,
      rateOverride: params.rateOverride,
      constraint: { ...params.constraint },
      additionalData: params.additionalData,
      swapFeePercentage: params.swapFeePercentage,
      unwindSwapFeePercentage: params.unwindSwapFeePercentage,
      enableJitMint: params.enableJitMint,
    },
    permits.map((p) => ({ token: p.token, value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s })),
  ]);
}

/** Build the 1inch LOP v4 extension whose ONLY dynamic field is PreInteractionData =
 *  adapter address ++ extraData (ExtensionLib layout: a 32-byte word of eight cumulative
 *  uint32 END offsets — PreInteractionData is field 6 — followed by the concatenated fields).
 *  The maker-signed salt must commit to keccak(extension)'s low 160 bits; buildMakerOrder
 *  already does that when handed these bytes. */
export function buildJitExtension(adapter: `0x${string}`, extraData: `0x${string}`): `0x${string}` {
  const pre = concatHex([getAddress(adapter), extraData]);
  const end = BigInt(size(pre));
  const offsets = (end << (32n * 6n)) | (end << (32n * 7n));
  return concatHex([toHex(offsets, { size: 32 }), pre]);
}

/** Round-trip reader for tests + decode paths: extract field 6 (PreInteractionData) per
 *  ExtensionLib._get semantics, then split target/extraData. */
export function decodeJitExtension(extension: `0x${string}`): { adapter: `0x${string}`; params: JITMarketParams; permits: PermitParams[] } {
  const offsets = BigInt(sliceHex(extension, 0, 32));
  const concat = sliceHex(extension, 32);
  const begin = Number((offsets >> (32n * 5n)) & 0xffffffffn);
  const end = Number((offsets >> (32n * 6n)) & 0xffffffffn);
  const pre = sliceHex(concat, begin, end);
  const adapter = getAddress(sliceHex(pre, 0, 20));
  const [p, permits] = decodeAbiParameters(JIT_PARAMS_ABI, sliceHex(pre, 20)) as [
    {
      collateralAsset: `0x${string}`;
      referenceAsset: `0x${string}`;
      expiryTimestamp: bigint;
      recipe: `0x${string}`;
      rateOverride: bigint;
      constraint: { rateMin: bigint; rateMax: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint };
      additionalData: `0x${string}`;
      swapFeePercentage: bigint;
      unwindSwapFeePercentage: bigint;
      enableJitMint: boolean;
    },
    Array<{ token: `0x${string}`; value: bigint; deadline: bigint; v: number; r: `0x${string}`; s: `0x${string}` }>,
  ];
  return { adapter, params: { ...p, constraint: { ...p.constraint } }, permits: permits.map((x) => ({ ...x })) };
}

// ── Market derivation (what the fill will compute) ──────────────────────────────────────────
/** Build the Market struct + poolId a fill carrying `constraint` would produce. In 2.1.0 the
 *  constraint comes IN (resolved off-chain at signing), so the identity is a pure function of
 *  the order — no rate read, no drift. Field order matches the adapter/controller exactly; the
 *  id is our verified computeMarketId (keccak256(abi.encode(Market)), bit-identical to
 *  poolManager.getId). */
export function deriveJitMarket(args: {
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  expiryTimestamp: bigint;
  constraint: ResolvedConstraint;
  oracle: `0x${string}`;
}): { market: Market; poolId: `0x${string}` } {
  const market: Market = {
    collateralAsset: args.collateralAsset,
    referenceAsset: args.referenceAsset,
    expiryTimestamp: args.expiryTimestamp,
    rateMin: args.constraint.rateMin,
    rateMax: args.constraint.rateMax,
    rateChangePerDayMax: args.constraint.rateChangePerDayMax,
    rateChangeCapacityMax: args.constraint.rateChangeCapacityMax,
    rateOracle: args.oracle,
  };
  return { market, poolId: computeMarketId(market) };
}

/** Unsigned MarketRegistry.deploy(ca, ref, mode) calldata — permissionless + idempotent (an
 *  existing pair/mode just returns the recorded wrapper). */
export function buildDeployOracleCall(ca: `0x${string}`, ref: `0x${string}`, mode: OracleModeName): `0x${string}` {
  return encodeFunctionData({ abi: marketRegistryAbi, functionName: "deploy", args: [ca, ref, ORACLE_MODE[mode]] });
}

/** Unsigned MarketRegistry.deployFixedRateOracle(rate) calldata — CREATE2-salted by the rate,
 *  so a given rate has ONE oracle per chain; idempotent; a zero rate reverts in the oracle
 *  constructor. */
export function buildDeployFixedRateOracleCall(rate: bigint): `0x${string}` {
  return encodeFunctionData({ abi: marketRegistryAbi, functionName: "deployFixedRateOracle", args: [rate] });
}

/** controller.createNewPool calldata for share-prediction simulations. */
export function buildCreatePoolCall(market: Market, unwindSwapFeePercentage: bigint, swapFeePercentage: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: controllerCreatePoolAbi,
    functionName: "createNewPool",
    args: [{ pool: { ...market }, unwindSwapFeePercentage, swapFeePercentage, isWhitelistEnabled: false }],
  });
}

const sharesAbi = parseAbi(["function shares(bytes32 poolId) view returns (address principalToken, address swapToken)"]);

/** poolManager.shares(poolId) calldata, for the second leg of the prediction simulation. */
export function buildSharesCall(poolId: `0x${string}`): `0x${string}` {
  return encodeFunctionData({ abi: sharesAbi, functionName: "shares", args: [poolId] });
}

/** Storage slot of `_roles[role].hasRole[account]` in plain OZ AccessControl (mapping at slot 0,
 *  NOT ERC-7201 — empirically verified upstream). Used to GRANT the role inside a simulation's
 *  state override, since post-redeploy no live account may hold POOL_CREATOR_ROLE yet. */
export function roleMemberSlot(role: `0x${string}`, account: `0x${string}`): `0x${string}` {
  const roleDataSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [role, 0n]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [account, roleDataSlot]));
}

export const sharePoolIdAbi = parseAbi(["function poolId() view returns (bytes32)"]);

/** Best-effort probe behind the stale_share_prediction diagnosis: when `addr` already hosts a
 *  live PoolShare, report which pool it serves; undefined in every other case (silent on every
 *  failure — this only decorates an existing jit_side_mismatch warning, never blocks a build).
 *  Why it matters: cST/cPT deploy via plain nonce CREATE (see the predictShares note below), so
 *  a prediction embedded in a resting order is consumed by ANY interleaving pool creation, after
 *  which that order reverts OrderNotForPool forever. Empirically established 2026-08-04 on the
 *  venue's first new-generation batch. */
export async function readForeignSharePool(client: PublicClient, addr: `0x${string}`): Promise<`0x${string}` | undefined> {
  try {
    const code = await client.getCode({ address: addr });
    if (!code || code === "0x") return undefined;
    return (await client.readContract({ address: addr, abi: sharePoolIdAbi, functionName: "poolId" })) as `0x${string}`;
  } catch {
    return undefined;
  }
}

/** The pool's two share tokens as the chain would produce them for `poolId`.
 *  - `read`: the pool already exists — the addresses are PINNED (read straight from poolManager).
 *  - `simulated`: the pool does not exist — created in-memory via eth_simulateV1 with a state
 *    override granting the simulating account POOL_CREATOR_ROLE on the controller (the same
 *    trick the read API uses over eth_call+Multicall3), then read back. For an order that
 *    CARRIES its constraint the poolId — and hence these addresses once created — is pinned at
 *    signing; before creation they are still conditioned on the oracle ADDRESS resolution.
 *  - `unavailable`: the RPC lacks eth_simulateV1/state overrides or the simulation reverted.
 *  cST/cPT are deployed via plain `new PoolShare(...)` (nonce CREATE, NOT CREATE2 — see
 *  SharesFactory.sol), so there is no off-chain address derivation: simulation is the only
 *  predictor. Fees are NOT part of market identity; callers that only want the tokens pass 0. */
export interface PredictSharesResult {
  cst?: `0x${string}` | undefined;
  cpt?: `0x${string}` | undefined;
  exists: boolean;
  status: "read" | "simulated" | "unavailable";
}

export async function predictShares(
  client: PublicClient,
  args: {
    adapter: `0x${string}`;
    controller: `0x${string}`;
    poolManager: `0x${string}`;
    market: Market;
    poolId: `0x${string}`;
    unwindSwapFeePercentage?: bigint;
    swapFeePercentage?: bigint;
    /** Legs to run BEFORE createNewPool in the simulation — e.g. the permissionless
     *  registry.deploy / deployFixedRateOracle the fill itself performs when the market's oracle
     *  is not deployed yet. Mirrors the fill exactly, so prediction works pre-deploy. */
    preCalls?: readonly { to: `0x${string}`; data: `0x${string}` }[];
  },
): Promise<PredictSharesResult> {
  // 0. Generation consistency: shares must be read from the pool manager THIS controller
  //    creates pools on — the controller's own on-chain binding — not from whichever
  //    deployment the config currently defaults to. The two diverge whenever a new phoenix
  //    generation is promoted before this registry generation is redeployed against it
  //    (observed 2026-08-07: v1.3.0-rc.1 default + the v1.1-bound registry would otherwise
  //    simulate creation on one pool manager and read shares from the other, predicting
  //    nothing). args.poolManager survives as the fallback when the controller won't answer.
  let poolManager = args.poolManager;
  try {
    poolManager = getAddress(
      await client.readContract({ address: args.controller, abi: controllerViewsAbi, functionName: "CORK_POOL_MANAGER" }),
    );
  } catch {
    /* keep the configured fallback */
  }
  // 1. Direct read — a non-zero swapToken means the pool exists; both addresses are pinned.
  try {
    const [principalToken, swapToken] = (await client.readContract({
      address: poolManager,
      abi: sharesAbi,
      functionName: "shares",
      args: [args.poolId],
    })) as readonly [`0x${string}`, `0x${string}`];
    if (swapToken !== ZERO_ADDRESS) {
      return { cst: getAddress(swapToken), cpt: principalToken === ZERO_ADDRESS ? undefined : getAddress(principalToken), exists: true, status: "read" };
    }
  } catch {
    /* pool does not exist yet — fall through to simulation */
  }
  // 2. Simulate the creation the fill would perform, granting the simulating account (the
  //    adapter) POOL_CREATOR_ROLE via state override — role-grant-independent, so the
  //    prediction works both before and after governance grants the real roles.
  try {
    const pre = args.preCalls ?? [];
    const createData = buildCreatePoolCall(args.market, args.unwindSwapFeePercentage ?? 0n, args.swapFeePercentage ?? 0n);
    const simulated = await client.simulateCalls({
      account: args.adapter,
      calls: [
        ...pre.map((c) => ({ to: c.to, data: c.data })),
        { to: args.controller, data: createData },
        { to: poolManager, data: buildSharesCall(args.poolId) },
      ],
      stateOverrides: [
        { address: args.controller, stateDiff: [{ slot: roleMemberSlot(POOL_CREATOR_ROLE, args.adapter), value: toHex(1n, { size: 32 }) }] },
      ],
    });
    const create = simulated.results[pre.length];
    const last = simulated.results[pre.length + 1];
    // The creation leg must have SUCCEEDED and the shares read must decode to a non-zero cST —
    // a zero address here means the pool was not actually created in-memory (e.g. a pre-leg
    // failed), and serving it as a prediction would be an invention.
    if (create?.status === "success" && last?.status === "success" && last.data && last.data.length >= 2 + 64 * 2) {
      const cpt = getAddress(`0x${last.data.slice(2 + 24, 2 + 64)}`);
      const cst = getAddress(`0x${last.data.slice(2 + 64 + 24, 2 + 128)}`);
      if (cst !== ZERO_ADDRESS) {
        return { cst, cpt: cpt === ZERO_ADDRESS ? undefined : cpt, exists: false, status: "simulated" };
      }
    }
  } catch {
    /* eth_simulateV1 / state overrides unsupported, or the simulation reverted */
  }
  return { exists: false, status: "unavailable" };
}

// ── JIT lifecycle events (adapter source, frozen signatures) ────────────────────────────────
// 2.1.0 JITMarketCreated carries the RECIPE ADDRESS where the legacy event carried a mode
// string — both topics stay decodable (receipts from either generation label correctly).
export const JIT_MARKET_CREATED_TOPIC = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,address)");
export const JIT_MINTED_TOPIC = toEventSelector("JITMinted(bytes32,address,uint256,uint256)");
export const JIT_MARKET_CREATED_LEGACY_TOPIC = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,string)");
export const JIT_EVENTS: Record<string, string> = {
  [JIT_MARKET_CREATED_TOPIC]: "JITMarketCreated",
  [JIT_MINTED_TOPIC]: "JITMinted",
  [JIT_MARKET_CREATED_LEGACY_TOPIC]: "JITMarketCreated (legacy pre-2.1.0)",
};
