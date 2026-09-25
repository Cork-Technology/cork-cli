// MarketRegistry + CorkLimitOrderAdapter integration — contracts release 2.1.0 (Arbitrum One,
// deployed at block 489540043; ABI pinned against market-registry tag 2.1.0 commit
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
//
// Two IMPLEMENTED registry wires live here since 0.6 (2026-09-22), keyed by `MarketRegistryWire`
// (generations.ts): `flat` — the 0.3.x set above, byte-identical to what it always emitted — and
// `nested` — market-registry 0.5.0 (Distribution phoenix/v0.4-rc.1, deployed 2026-09-22 on
// Arbitrum One + Base at identical addresses): the adapter's JITMarketParams became a WRAPPER
// `(MarketParams market, bool enableJitMint)` around the creator's own 10-field MarketParams
// (`bytes extraData` — renamed from additionalData — then `bytes32 oracleSalt`, then the two
// fees), `verify` takes the pool expiry and a `creating` flag, `deploy` takes the salt, the
// creator moved into the registry package and HOLDS the pool-creator role (the adapter delegates
// creation to it and holds none), denominations are plain address units, and the pool manager it
// creates on is the 10-field phoenix (fees inside the Market AND its id). The `legacy` wire stays
// in market-registry-legacy.ts behind the deprecation gate. Every encoder/decoder/call builder
// below takes the wire EXPLICITLY — a flat payload handed to a nested adapter decodes into a
// plausible market that is not the one meant, which is exactly why no default wire exists.
// Golden vectors for the nested wire were captured from the deployed contracts themselves
// (adapter.encodeExtraData / decodeExtraData, pm.getId, registry.predictFixedRateOracle,
// recipe.encodeExtraData; 42161, 2026-09-22) and are pinned in test/market-registry-nested.test.ts.
import { concatHex, decodeAbiParameters, decodeErrorResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, size, sliceHex, toEventSelector, toHex, zeroAddress } from "viem";
import type { Abi, PublicClient } from "viem";
import { computeMarketId } from "./marketid.ts";
import { cachedContractConstantBytes32, refreshContractConstant } from "./chain/constants-cache.ts";
import type { MarketRegistryWire, PhoenixWire } from "./generations.ts";
import type { Market, Market10, Market8 } from "./types.ts";

const ZERO_ADDRESS = zeroAddress;
/** The zero oracle salt: the pair's DEFAULT wrapper on the nested wire. `registry.deploy` mixes the
 *  salt into the CREATE2 salt of a pair's FIRST wrapper only — an existing (ca, ref, mode) wrapper
 *  is returned whatever salt rides along (MarketRegistry 0.5.0 `deploy`: lookup first, salt only
 *  on the factory call). */
export const ZERO_ORACLE_SALT = `0x${"00".repeat(32)}` as const;

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
  "function maxExpiryDuration() view returns (uint256)",
  // The registry's typed reverts (IMarketRegistry, 0.3.x). Declared so viem decodes them
  // into simulate/read error messages — which is what lets diagnoseOracleDeployFailure tell
  // a NAMED registration failure from the unnamed CREATE2-collision class (a raw create
  // collision bubbles EMPTY revert data, decoding to nothing).
  "error EntryAlreadyExists()",
  "error EntryNotFound()",
  "error ArrayLengthMismatch()",
  "error ZeroAddress()",
  "error EmptyName()",
  "error UnregisteredDenomination(string label)",
  "error NoConversionPathToUsd(address fromUnit, uint256 maxHops)",
  "error MissingSource(address asset, uint8 mode)",
  "error NavModeWithoutNavSource(address ca, address ref)",
  "error SourceTypeMismatch(uint8 expected, uint8 provided)",
  "error RecipeNotRegistered(address recipe)",
  "error RecipeNotContract(address recipe)",
  "error ZeroBound()",
]);

/** The deploy-revert error names that identify a REGISTRATION problem (as opposed to the
 *  unnamed CREATE2-collision class) — see diagnoseOracleDeployFailure in handlers/shared.ts. */
export const REGISTRY_DEPLOY_ERROR_NAMES = [
  "MissingSource",
  "NavModeWithoutNavSource",
  "NoConversionPathToUsd",
  "UnregisteredDenomination",
  "SourceTypeMismatch",
  "EntryNotFound",
  "ZeroAddress",
] as const;

export const recipeAbi = parseAbi([
  "function source() view returns (uint8)",
  "function description() view returns (string)",
  "function REGISTRY() view returns (address)",
  "function resolve(address ca, address ref, address rateOracle, bytes additionalData) view returns ((uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint)",
  "function verify(address ca, address ref, address rateOracle, (uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint, bytes additionalData) view returns (bool ok)",
  // ApySpreadImpairmentRecipe's typed errors (market-registry 0.4.0, src/recipes/, verified
  // against the tag's source 2026-09-21). Carried on the shared recipe ABI so a resolve/verify
  // revert is NAMED in recipe_refused instead of surfacing as a raw selector; selectors are
  // recipe-specific, so they can never mis-decode another recipe's revert.
  "error MalformedAdditionalData(uint256 length)",
  "error ZeroAnchorRate()",
  "error ZeroDuration()",
  "error DurationTooLong(uint256 durationSeconds, uint256 maxDuration)",
  "error BandTooWide(uint256 bandPercentage)",
  "error WindowCollapsed(uint256 rateMin, uint256 rateMax)",
  "error RateOracleNotDeployed(address ca, address ref)",
]);

// ── Nested-wire ABIs (market-registry 0.5.0; selectors + struct orders verified against the
// Distribution component records 2026-09-22: deploy 0x5475abdc, wrapperKey 0xc8346949,
// createNewPool 0x59c8eb4c, verify 0x15bb9583, decodeExtraData 0x5ef271c6 — the LAST is the same
// selector the flat adapter answers, with a DIFFERENT return layout, which is why the decode
// round-trip must be dispatched by wire and never by trial). ─────────────────────────────────
export const marketRegistryNestedAbi = parseAbi([
  // AssetSource.denomination is an ADDRESS unit (the label/labelHash denomination is gone);
  // ConversionFeed lost feedDecimals.
  "struct AssetSourceN { address addr; uint8 sourceType; uint8 sourceInterface; address denomination; }",
  "struct AssetN { address addr; string name; uint8 kind; AssetSourceN priceSource; AssetSourceN navSource; }",
  "struct ConversionFeedN { address base; address quote; address aggregatorAddress; }",
  "function WRAPPER_FACTORY() view returns (address)",
  "function FIXED_RATE_ORACLE_FACTORY() view returns (address)",
  "function owner() view returns (address)",
  "function version() pure returns (string)",
  "function isAsset(address addr) view returns (bool)",
  "function isRecipe(address recipe) view returns (bool)",
  "function isDenomination(address unit) view returns (bool)",
  "function lookupAssetByAddress(address addr) view returns (bool found, AssetN entry)",
  "function lookupAssetByName(string name) view returns (bool found, AssetN entry)",
  "function lookupConversionFeed(address base, address quote) view returns (bool found, ConversionFeedN entry)",
  "function lookupWrapper(address ca, address ref, uint8 mode) view returns (address wrapper)",
  "function wrapperKey(address ca, address ref, uint8 mode) view returns (bytes32)",
  "function predictFixedRateOracle(uint256 rate) view returns (address oracle)",
  "function getAssets(uint256 offset, uint256 limit) view returns (AssetN[] page, uint256 total)",
  "function getConversionFeeds(uint256 offset, uint256 limit) view returns (ConversionFeedN[] page, uint256 total)",
  "function getDenominations(uint256 offset, uint256 limit) view returns (address[] page, uint256 total)",
  "function getRecipes(uint256 offset, uint256 limit) view returns (address[] page, uint256 total)",
  "function deploy(address ca, address ref, uint8 mode, bytes32 oracleSalt) returns (address wrapper)",
  "function deployFixedRateOracle(uint256 rate) returns (address oracle)",
  "function maxExpiryDuration() view returns (uint256)",
  "function DEFAULT_MAX_EXPIRY_DURATION() view returns (uint256)",
  "event EntryAdded(uint8 indexed namespace, bytes32 indexed keyHash, bytes entry)",
  "event EntryRemoved(uint8 indexed namespace, bytes32 indexed keyHash, bytes key)",
  "event MarketOracleDeployed(address indexed ca, address indexed ref, address indexed wrapper, uint8 mode, address caSource, address refSource, address caller)",
  "event FixedRateOracleDeployed(uint256 indexed rate, address indexed oracle, address caller)",
  "error EntryAlreadyExists()",
  "error EntryNotFound()",
  "error ArrayLengthMismatch()",
  "error ZeroAddress()",
  "error EmptyName()",
  "error UnregisteredDenomination(address unit)",
  "error NoConversionPathToUsd(address fromUnit, uint256 maxHops)",
  "error MissingSource(address asset, uint8 mode)",
  "error NavModeWithoutNavSource(address ca, address ref)",
  "error SourceTypeMismatch(uint8 expected, uint8 provided)",
  "error RecipeNotRegistered(address recipe)",
  "error RecipeNotContract(address recipe)",
  "error ZeroBound()",
]);

/** IMarketRecipe on the nested wire: `verify` gained the pool expiry and a `creating` flag BEFORE
 *  the constraint (positions 3 and 4), `resolve` kept its shape; the bytes member is `extraData`.
 *  Both current recipes' typed errors ride here (selectors are recipe-specific). */
export const recipeNestedAbi = parseAbi([
  "function source() view returns (uint8)",
  "function description() view returns (string)",
  "function version() pure returns (string)",
  "function REGISTRY() view returns (address)",
  "function resolve(address ca, address ref, address rateOracle, bytes extraData) view returns ((uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint)",
  "function verify(address ca, address ref, address rateOracle, uint256 expiryTimestamp, bool creating, (uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax) constraint, bytes extraData) view returns (bool ok)",
  "error BandOutOfRange(uint256 percentage)",
  "error BandTooWide(uint256 bandPercentage, uint256 maxBandPercentage)",
  "error DurationTooLong(uint256 durationSeconds, uint256 maxDuration)",
  "error MalformedExtraData(uint256 length)",
  "error RateOracleNotDeployed(address ca, address ref)",
  "error SpreadTooHigh(uint256 apySpreadPercentage, uint256 maxSpreadPercentage)",
  "error UnexpectedExtraData()",
  "error WindowCollapsed(uint256 rateMin, uint256 rateMax)",
  "error ZeroAnchorRate()",
  "error ZeroDuration()",
  "error ZeroRegistry()",
]);

/** CorkLimitOrderAdapter 0.4.0 (nested wire): binds the LOP, the POOL MANAGER and the MARKET
 *  CREATOR — no CONTROLLER()/MARKET_REGISTRY() (creation is delegated to the creator, which holds
 *  them), no MAX_FEE_PERCENTAGE(). decodeExtraData returns the WRAPPER shape. */
export const jitAdapterNestedAbi = parseAbi([
  "function LIMIT_ORDER_PROTOCOL() view returns (address)",
  "function POOL_MANAGER() view returns (address)",
  "function MARKET_CREATOR() view returns (address)",
  "function version() pure returns (string)",
  "struct RateConstraintN { uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
  "struct MarketParamsN { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; address recipe; uint256 rateOverride; RateConstraintN constraint; bytes extraData; bytes32 oracleSalt; uint256 swapFeePercentage; uint256 unwindSwapFeePercentage; }",
  "struct JITMarketParamsN { MarketParamsN market; bool enableJitMint; }",
  "struct PermitParamsN { address token; uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function encodeExtraData(JITMarketParamsN market, PermitParamsN[] permits) pure returns (bytes)",
  "function decodeExtraData(bytes extraData) pure returns (JITMarketParamsN market, PermitParamsN[] permits)",
  "error MintAmountDrift()",
  "error MintUnavailable()",
  "error OnlyLimitOrderProtocol()",
  "error OrderNotForPool()",
  "error ZeroAddress()",
]);

/** CorkMarketCreator 0.1.0 shipped by market-registry 0.5.0 (nested wire): createNewPool over the
 *  10-field MarketParams (selector 0x59c8eb4c), getters CONTROLLER/MARKET_REGISTRY/POOL_MANAGER,
 *  and the typed reverts of the creation sequence. */
export const marketCreatorNestedAbi = parseAbi([
  "struct CreatorRateConstraintN { uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
  "struct CreatorMarketParamsN { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; address recipe; uint256 rateOverride; CreatorRateConstraintN constraint; bytes extraData; bytes32 oracleSalt; uint256 swapFeePercentage; uint256 unwindSwapFeePercentage; }",
  "function CONTROLLER() view returns (address)",
  "function MARKET_REGISTRY() view returns (address)",
  "function POOL_MANAGER() view returns (address)",
  "function version() pure returns (string)",
  "function createNewPool(CreatorMarketParamsN params) returns (bytes32 poolId, address cst, address cpt)",
  "event MarketCreated(bytes32 indexed poolId, address indexed rateOracle, address collateralAsset, address referenceAsset, uint256 expiryTimestamp, address recipe, uint256 swapFeePercentage, uint256 unwindSwapFeePercentage, address indexed caller)",
  "error EntryNotFound()",
  "error ExpiryOutOfRange(uint256 expiryTimestamp, uint256 maxExpiryTimestamp)",
  "error RateUnavailable()",
  "error RecipeNotRegistered(address recipe)",
  "error RecipeRejectedConstraint(address recipe)",
  "error UnexpectedRateOverride(address recipe)",
  "error ZeroAddress()",
]);

/** DefaultCorkController.createNewPool on the 10-field phoenix (v1.4.0-rc.1, selector
 *  0xa0e0024d): `PoolCreationParams { Market pool; bool isWhitelistEnabled }` — the two fees moved
 *  INTO the Market (swap THEN unwind, the reverse of the 8-field params' unwind-then-swap). */
export const controllerCreatePool10Abi = parseAbi([
  "struct Market10_ { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; address rateOracle; uint256 swapFeePercentage; uint256 unwindSwapFeePercentage; }",
  "struct PoolCreationParams10 { Market10_ pool; bool isWhitelistEnabled; }",
  "function createNewPool(PoolCreationParams10 params)",
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
  // Versioning policy (2026-09-03): every externally supplied `bytes` parameter gets an external pure
  // decode helper sharing the hook's own decoder, so the layout is visible in the shipped ABI.
  // Shipped from the 0.4.0 adapter; this tool reads it back as the
  // layout ORACLE for the bytes it encodes — a pre-0.4.0 adapter has no such view and the check
  // degrades to "unchecked", never to a guess.
  "struct RateConstraint_ { uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
  "struct JITMarketParams_ { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; address recipe; uint256 rateOverride; RateConstraint_ constraint; bytes additionalData; uint256 swapFeePercentage; uint256 unwindSwapFeePercentage; bool enableJitMint; }",
  "struct PermitParams_ { address token; uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function decodeExtraData(bytes extraData) pure returns (JITMarketParams_ params, PermitParams_[] permits)",
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
  "function POOL_CREATOR_ROLE() view returns (bytes32)",
]);

/** DefaultCorkController.createNewPool — used in state-override simulations to predict the cST
 *  of a not-yet-created pool. Field order is load-bearing: unwind fee BEFORE swap fee. */
export const controllerCreatePoolAbi = parseAbi([
  "struct Market_ { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; address rateOracle; }",
  "struct PoolCreationParams { Market_ pool; uint256 unwindSwapFeePercentage; uint256 swapFeePercentage; bool isWhitelistEnabled; }",
  "function createNewPool(PoolCreationParams params)",
]);

/** Controller role hashes (keccak256 of the role name; declared in DefaultCorkController).
 *  FALLBACKS: the pre-flights probe the controller's own role views (long-TTL cached — the
 *  constants-cache module) and these compiled values answer only when the chain never has.
 *  CONFIGURATOR is the exception — pre-0.3.2 controllers expose no view for it, which is why
 *  it exists at all. */
export const POOL_CREATOR_ROLE = "0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52" as const;
export const CONFIGURATOR_ROLE = "0x3b49a237fe2d18fa4d9642b8a0e065923cceb71b797783b619a030a61d848bf0" as const;

/** The protocol fee ceiling, 1e18 = 1% — the adapter's and the creator's MAX_FEE_PERCENTAGE
 *  restated as the offline fallback. Online, the value gates read the deployed contract's own
 *  view through the long-TTL constants cache (resolveFeeCap in handlers/jit.ts), so a redeploy
 *  that moves the cap cannot leave this literal silently authoritative. */
export const MAX_FEE_PERCENTAGE_FALLBACK = 5n * 10n ** 18n;

/** Controller-role pre-flight shared by every JIT prepare site (maker, taker-fill, create-pool,
 *  legacy). The granted/missing decision lives in exactly this one comparator so a single mutation
 *  probe covers every call site — duplicated identical conditionals defeat first-occurrence
 *  probes. `holder` is the account that must hold the roles: the JIT ADAPTER on the flat wire
 *  (it calls the controller itself), the MARKET CREATOR on the nested wire (the adapter delegates
 *  creation to it and holds nothing — verified live 2026-09-22: creator true, adapter false) —
 *  `roleHolderOf(wire)` names it. Role hashes are identical across generations. */
export async function readRoleHolder(
  client: PublicClient,
  controller: `0x${string}`,
  holder: `0x${string}`,
  roles: { creator?: `0x${string}`; second?: `0x${string}`; secondLabel?: string; chainId?: number; /** The phoenix wire the controller belongs to: a 10-field controller has NO fee authority (no FEE_MANAGER_ROLE, no fee setters — the fees ride inside the Market), so POOL_CREATOR alone is the whole requirement. */ phoenixWire?: PhoenixWire } = {},
): Promise<{ hasCreator: boolean; hasSecond: boolean; secondRole: string; granted: boolean }> {
  // The controller's own surface decides which SECOND role the holder needs (chain outranks
  // config): the 0.3.2-generation controller splits fee authority into FEE_MANAGER_ROLE — a
  // public constant view that answers, and the role the rollout grants alongside POOL_CREATOR
  // — while earlier controllers gate fees behind CONFIGURATOR_ROLE. The probed value is used
  // as the role id itself, so even a renamed hash follows the deployed truth. An explicit
  // roles.second override (the pre-2.1.0 legacy path) skips the probe. Both probes run through
  // the long-TTL constants cache when `roles.chainId` is given (a probed hash is a contract
  // constant — one read per TTL, and the COMPILED hashes below become pure fallbacks); without
  // a chainId the probes read live each call, exactly the pre-cache behavior.
  const probe = async (fn: "POOL_CREATOR_ROLE" | "FEE_MANAGER_ROLE"): Promise<`0x${string}` | undefined> => {
    if (roles.chainId !== undefined) {
      const cached = cachedContractConstantBytes32(roles.chainId, controller, fn);
      if (cached !== undefined) return cached;
      const fresh = await refreshContractConstant(client, roles.chainId, controller, fn, "bytes32");
      return fresh === undefined ? undefined : (`0x${fresh.toString(16).padStart(64, "0")}` as `0x${string}`);
    }
    try {
      return (await client.readContract({ address: controller, abi: controllerViewsAbi, functionName: fn })) as `0x${string}`;
    } catch {
      return undefined;
    }
  };
  const creator = roles.creator ?? (await probe("POOL_CREATOR_ROLE")) ?? POOL_CREATOR_ROLE;
  if (roles.phoenixWire === "10-field") {
    // No fee authority exists on this controller generation: probing FEE_MANAGER_ROLE would fall
    // through to CONFIGURATOR and accuse a fully-granted creator of a missing role it never needs.
    const hasCreator = await client.readContract({ address: controller, abi: accessControlAbi, functionName: "hasRole", args: [creator, holder] });
    return { hasCreator, hasSecond: true, secondRole: "none (10-field: fees ride inside the Market, no fee-authority role)", granted: hasCreator };
  }
  let second = roles.second;
  let secondRole = roles.secondLabel ?? "CONFIGURATOR";
  if (second === undefined) {
    const probed = await probe("FEE_MANAGER_ROLE");
    if (probed !== undefined) {
      second = probed;
      secondRole = "FEE_MANAGER";
    } else {
      second = CONFIGURATOR_ROLE;
    }
  }
  const [hasCreator, hasSecond] = await Promise.all([
    client.readContract({ address: controller, abi: accessControlAbi, functionName: "hasRole", args: [creator, holder] }),
    client.readContract({ address: controller, abi: accessControlAbi, functionName: "hasRole", args: [second, holder] }),
  ]);
  return { hasCreator, hasSecond, secondRole, granted: hasCreator && hasSecond };
}

// ── Recipe constants catalog (mirrors the read API's hand-maintained annotation layer) ──────
// Keyed by lowercased recipe address (CREATE2 ⇒ chain-stable). Supplies only the constant getter
// NAMES + the extraData arg annotation; every VALUE is read live off the recipe. Catalog
// absence is NOT a gate — isRecipe on chain is the only membership check; an uncatalogued recipe
// still lists, still self-describes, it just arrives with argsKnown:false.
export interface RecipeCatalogEntry {
  constants: readonly string[];
  args: { type: string; display: string } | null;
}
const LIQUIDITY_RECIPE_CONSTANTS = ["RATE_MIN", "RATE_MIN_PERCENTAGE", "RATE_MAX_PERCENTAGE", "RATE_CHANGE_PER_DAY_MAX_PERCENTAGE", "RATE_CHANGE_CAPACITY_MAX_PERCENTAGE"] as const;
const IMPAIRMENT_ARGS_DISPLAY =
  "abi.encode(uint256 anchorRate, uint256 durationSeconds, uint256 apySpreadPercentage) — exactly 96 bytes (encodeImpairmentArgs builds it). anchorRate is on the RATE scale (1e18 = 1.0) and is honoured only while the pair's oracle is undeployed; durationSeconds is plain seconds, must not exceed the registry's maxExpiryDuration, and is the AUTHOR'S choice independent of the pool's expiry (usually expiry minus now); apySpreadPercentage is on the PERCENTAGE scale (1e18 = 1%, so a 10%/year spread is 10e18 — NOT the rate scale). Window = anchor ± spread×duration/365d, per-day = one day of the spread, capacity = seven";
export const RECIPE_CATALOG: Record<string, RecipeCatalogEntry> = {
  // 0.3.3 recipes (identical addresses on 42161 + 8453; constant getters re-probed live on the
  // deployed contracts 2026-08-10 — same constant set as 0.3.2, both liquidity flavors alike).
  "0xb881db48ad6da84a8f0d1ce4150caf7ae016dc55": {
    constants: LIQUIDITY_RECIPE_CONSTANTS,
    args: { type: "(uint256)", display: "abi.encode(uint256 anchorRate)" },
  },
  "0xaed3d0e3c86a994d88741c285657c3e78550f66d": {
    constants: LIQUIDITY_RECIPE_CONSTANTS,
    args: { type: "(uint256)", display: "abi.encode(uint256 anchorRate)" },
  },
  "0x133ac0fa9e3d44a34b8ce4e4b8d468758fd165c1": {
    constants: ["WINDOW_WIDTH"],
    args: { type: "()", display: "no payload — the fixed-rate recipe rejects any additionalData" },
  },
  // ApySpreadImpairmentRecipe (market-registry 0.4.0, deployed 2026-08-31; identical address on
  // 42161 + 8453; approved on the 0.3.3-generation registry — isRecipe read live on both chains
  // 2026-09-21). The 0.4.0 release moved NO registry/adapter address (owner statement
  // 2026-09-03), so this entry deliberately adopts the recipe alone, not the later 0.4-rc.1
  // shadow deployment set.
  "0x7340bfbedf3657a7bbce0dd2b4ab205754cc9eca": {
    constants: ["SECONDS_PER_YEAR", "CAPACITY_DAYS"],
    args: { type: "(uint256,uint256,uint256)", display: IMPAIRMENT_ARGS_DISPLAY },
  },
  // market-registry 0.5.0 recipes (the nested-wire generation cork/v0.4; identical
  // addresses on 42161 + 8453; constant getters + encode/decodeExtraData read live 2026-09-22:
  // liquidity price/nav answer the five RATE_* views, the impairment recipe its five constants
  // incl. EXTRA_DATA_LENGTH = 96 and MAX_BAND_PERCENTAGE = 50e18, the fixed recipe WINDOW_WIDTH).
  // The bytes member is `extraData` on this generation — same layouts, new name.
  "0x679cbd016587c423f342e5ba31e58356228c964d": {
    constants: LIQUIDITY_RECIPE_CONSTANTS,
    args: { type: "(uint256)", display: "encodeExtraData(uint256 anchorRate) = abi.encode(anchorRate) — read only while the pair's oracle is undeployed" },
  },
  "0xed6a6b0448b89f35889aaf6df1bdef27f83787e3": {
    constants: LIQUIDITY_RECIPE_CONSTANTS,
    args: { type: "(uint256)", display: "encodeExtraData(uint256 anchorRate) = abi.encode(anchorRate) — read only while the pair's oracle is undeployed" },
  },
  "0xec26bb7d911afe374721ecd963543f7e52468c49": {
    constants: ["WINDOW_WIDTH"],
    args: { type: "()", display: "no payload — the fixed-rate recipe rejects any extraData (UnexpectedExtraData)" },
  },
  "0xd5e8f76aafa20aa9a8983a35b71ad3a793070ed9": {
    constants: ["CAPACITY_DAYS", "EXTRA_DATA_LENGTH", "MAX_APY_SPREAD_PERCENTAGE", "MAX_BAND_PERCENTAGE", "SECONDS_PER_YEAR"],
    args: { type: "(uint256,uint256,uint256)", display: IMPAIRMENT_ARGS_DISPLAY },
  },
};

/** ABI-encode decimal uint256 words in order — the extraData shape every current recipe
 *  reads (liquidity: one word; impairment: three). One 32-byte word per value, no hand-built
 *  hex; the schema's `argsUints` rides through here. */
export function encodeUintWords(words: readonly bigint[]): `0x${string}` {
  return encodeAbiParameters(words.map(() => ({ type: "uint256" }) as const), words);
}

/** The ApySpreadImpairmentRecipe's order-carried args, built the one way its _decode accepts
 *  them: abi.encode(anchorRate, durationSeconds, apySpreadPercentage), exactly 96 bytes — the
 *  same bytes the 0.5.0 recipe's own `encodeExtraData(uint256,uint256,uint256)` returns
 *  (golden vector captured live 2026-09-22). Scales are the recipe's own (its description()
 *  states them): anchorRate 1e18 = 1.0 (honoured only while the pair's oracle is undeployed — a
 *  live oracle's rate wins, the liquidity recipe's rule), durationSeconds plain seconds (the
 *  recipe rejects 0 and anything over the registry's maxExpiryDuration), apySpreadPercentage
 *  1e18 = 1% (a 10%/year spread is 10e18 — the PERCENTAGE scale, not the rate scale; the recipe
 *  rejects a band of 100% or more). */
export function encodeImpairmentArgs(a: { anchorRate: bigint; durationSeconds: bigint; apySpreadPercentage: bigint }): `0x${string}` {
  return encodeUintWords([a.anchorRate, a.durationSeconds, a.apySpreadPercentage]);
}

/** One-getter ABI synthesized from a constant name alone (`RATE_MIN()` style, uint256 out).
 *  Typed as plain `Abi` (the name is a runtime value, so viem cannot infer the return type);
 *  callers narrow the read result at runtime. */
export function constantGetterAbi(name: string): Abi {
  return [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
}

// ── JIT hook payload + 1inch v4 extension building (one TS shape, two wire layouts) ─────────
export interface ResolvedConstraint {
  rateMin: bigint;
  rateMax: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
}

/** The JIT market instruction as THIS TOOL holds it — FLAT for callers on every wire; the codec
 *  nests it for the nested adapter. `extraData` is the one internal name for the recipe bytes
 *  (the 0.5.0 contracts' word; the 0.3.x wire calls the same member additionalData and the
 *  flat encoder writes it there). `oracleSalt` exists only on the nested wire: undefined or the
 *  zero salt = the pair's default wrapper; the flat encoder REFUSES a non-zero salt because
 *  no field carries it. */
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
  extraData: `0x${string}`;
  /** Nested wire only: mixed into the CREATE2 salt of the pair's FIRST oracle wrapper. */
  oracleSalt?: `0x${string}` | undefined;
  swapFeePercentage: bigint; // 1e18 = 1% — consumed only when the fill creates the pool; part of the 10-field id
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

/** The two registry wires this build's codecs implement (the `legacy` wire is the deprecated
 *  lane in market-registry-legacy.ts, reached through its own module). */
export type ImplementedMarketRegistryWire = Extract<MarketRegistryWire, "flat" | "nested">;

function assertImplementedWire(wire: MarketRegistryWire): asserts wire is ImplementedMarketRegistryWire {
  if (wire !== "flat" && wire !== "nested") throw new Error(`market-registry codec: wire '${wire}' is not implemented here (the legacy wire lives in market-registry-legacy.ts behind the deprecation gate)`);
}

const CONSTRAINT_COMPONENTS = [
  { name: "rateMin", type: "uint256" },
  { name: "rateMax", type: "uint256" },
  { name: "rateChangePerDayMax", type: "uint256" },
  { name: "rateChangeCapacityMax", type: "uint256" },
] as const;
const PERMITS_ABI = {
  type: "tuple[]" as const,
  components: [
    { name: "token", type: "address" },
    { name: "value", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
};

/** FLAT wire: abi.encode(JITMarketParams_{9 fields + bool enableJitMint LAST}, PermitParams[]). */
const JIT_PARAMS_FLAT_ABI = [
  {
    type: "tuple" as const,
    components: [
      { name: "collateralAsset", type: "address" },
      { name: "referenceAsset", type: "address" },
      { name: "expiryTimestamp", type: "uint256" },
      { name: "recipe", type: "address" },
      { name: "rateOverride", type: "uint256" },
      { name: "constraint", type: "tuple", components: CONSTRAINT_COMPONENTS },
      { name: "additionalData", type: "bytes" },
      { name: "swapFeePercentage", type: "uint256" },
      { name: "unwindSwapFeePercentage", type: "uint256" },
      { name: "enableJitMint", type: "bool" },
    ],
  },
  PERMITS_ABI,
];

/** The creator's 10-field MarketParams — the SAME struct in createNewPool and inside the nested
 *  adapter's wrapper. oracleSalt sits between the bytes and the fees (index 7). */
const MARKET_PARAMS_NESTED_COMPONENTS = [
  { name: "collateralAsset", type: "address" },
  { name: "referenceAsset", type: "address" },
  { name: "expiryTimestamp", type: "uint256" },
  { name: "recipe", type: "address" },
  { name: "rateOverride", type: "uint256" },
  { name: "constraint", type: "tuple", components: CONSTRAINT_COMPONENTS },
  { name: "extraData", type: "bytes" },
  { name: "oracleSalt", type: "bytes32" },
  { name: "swapFeePercentage", type: "uint256" },
  { name: "unwindSwapFeePercentage", type: "uint256" },
] as const;

/** NESTED wire: abi.encode((MarketParams market, bool enableJitMint), PermitParams[]). */
const JIT_PARAMS_NESTED_ABI = [
  {
    type: "tuple" as const,
    components: [
      { name: "market", type: "tuple", components: MARKET_PARAMS_NESTED_COMPONENTS },
      { name: "enableJitMint", type: "bool" },
    ],
  },
  PERMITS_ABI,
];

type DecodedConstraint = { rateMin: bigint; rateMax: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint };
type DecodedPermit = { token: `0x${string}`; value: bigint; deadline: bigint; v: number; r: `0x${string}`; s: `0x${string}` };
/** The nested wire's inner MarketParams as decoded/encoded. */
type NestedMarketParams = {
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  expiryTimestamp: bigint;
  recipe: `0x${string}`;
  rateOverride: bigint;
  constraint: DecodedConstraint;
  extraData: `0x${string}`;
  oracleSalt: `0x${string}`;
  swapFeePercentage: bigint;
  unwindSwapFeePercentage: bigint;
};

const isZeroSalt = (salt: `0x${string}` | undefined): boolean => salt === undefined || /^0x0*$/i.test(salt);

/** The creator-shaped nested MarketParams for a TS JITMarketParams (the salt defaults to zero). */
function nestedMarketParamsOf(p: Omit<JITMarketParams, "enableJitMint">): NestedMarketParams {
  return {
    collateralAsset: p.collateralAsset,
    referenceAsset: p.referenceAsset,
    expiryTimestamp: p.expiryTimestamp,
    recipe: p.recipe,
    rateOverride: p.rateOverride,
    constraint: { ...p.constraint },
    extraData: p.extraData,
    oracleSalt: p.oracleSalt ?? ZERO_ORACLE_SALT,
    swapFeePercentage: p.swapFeePercentage,
    unwindSwapFeePercentage: p.unwindSwapFeePercentage,
  };
}

/** Hook extraData for the given wire — flat: abi.encode(JITMarketParams_, PermitParams[]) with
 *  the bytes member written as `additionalData` and the mint flag LAST; nested:
 *  abi.encode((MarketParams, enableJitMint), PermitParams[]) with `extraData`, `oracleSalt`, and
 *  the mint flag as the wrapper's second member. The adapter of that wire decodes exactly this. */
export function encodeJitExtraData(wire: MarketRegistryWire, params: JITMarketParams, permits: readonly PermitParams[] = []): `0x${string}` {
  assertImplementedWire(wire);
  const permitRows = permits.map((p) => ({ token: p.token, value: p.value, deadline: p.deadline, v: p.v, r: p.r, s: p.s }));
  if (wire === "flat") {
    if (!isZeroSalt(params.oracleSalt)) throw new Error("encodeJitExtraData: the flat (0.3.x) wire carries no oracleSalt — a non-zero salt cannot be encoded for a flat-wire adapter");
    return encodeAbiParameters(JIT_PARAMS_FLAT_ABI, [
      {
        collateralAsset: params.collateralAsset,
        referenceAsset: params.referenceAsset,
        expiryTimestamp: params.expiryTimestamp,
        recipe: params.recipe,
        rateOverride: params.rateOverride,
        constraint: { ...params.constraint },
        additionalData: params.extraData,
        swapFeePercentage: params.swapFeePercentage,
        unwindSwapFeePercentage: params.unwindSwapFeePercentage,
        enableJitMint: params.enableJitMint,
      },
      permitRows,
    ]);
  }
  return encodeAbiParameters(JIT_PARAMS_NESTED_ABI, [{ market: nestedMarketParamsOf(params), enableJitMint: params.enableJitMint }, permitRows]);
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

/** Normalize the nested adapter's own decodeExtraData return (or our decode) into the flat TS
 *  shape — the ONE place the wrapper is unwrapped, shared by decodeJitExtraData and the on-chain
 *  round-trip so the two cannot read the same words differently. */
export function flattenNestedJitParams(out: readonly [{ market: NestedMarketParams; enableJitMint: boolean }, readonly DecodedPermit[]]): { params: JITMarketParams; permits: PermitParams[] } {
  const m = out[0].market;
  return {
    params: {
      collateralAsset: m.collateralAsset,
      referenceAsset: m.referenceAsset,
      expiryTimestamp: m.expiryTimestamp,
      recipe: m.recipe,
      rateOverride: m.rateOverride,
      constraint: { ...m.constraint },
      extraData: m.extraData,
      oracleSalt: m.oracleSalt,
      swapFeePercentage: m.swapFeePercentage,
      unwindSwapFeePercentage: m.unwindSwapFeePercentage,
      enableJitMint: out[0].enableJitMint,
    },
    permits: out[1].map((x) => ({ ...x })),
  };
}

/** Decode the adapter's extraData alone for the given wire — the same layout that wire's
 *  on-chain decodeExtraData helper returns, unwrapped into the flat TS shape. */
export function decodeJitExtraData(wire: MarketRegistryWire, extraData: `0x${string}`): { params: JITMarketParams; permits: PermitParams[] } {
  assertImplementedWire(wire);
  if (wire === "flat") {
    const [p, permits] = decodeAbiParameters(JIT_PARAMS_FLAT_ABI, extraData) as [
      { collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; expiryTimestamp: bigint; recipe: `0x${string}`; rateOverride: bigint; constraint: DecodedConstraint; additionalData: `0x${string}`; swapFeePercentage: bigint; unwindSwapFeePercentage: bigint; enableJitMint: boolean },
      DecodedPermit[],
    ];
    const { additionalData, ...rest } = p;
    return { params: { ...rest, constraint: { ...p.constraint }, extraData: additionalData }, permits: permits.map((x) => ({ ...x })) };
  }
  const out = decodeAbiParameters(JIT_PARAMS_NESTED_ABI, extraData) as unknown as readonly [{ market: NestedMarketParams; enableJitMint: boolean }, readonly DecodedPermit[]];
  return flattenNestedJitParams(out);
}

/** Field-by-field difference between the params this tool ENCODED and what a decoder READ back:
 *  the names of every field that disagrees (empty = the two layouts agree). Addresses and hex
 *  compare case-insensitively; everything else exactly. An absent oracleSalt is the zero salt. */
export function diffJitExtraData(encoded: { params: JITMarketParams; permits: readonly PermitParams[] }, decoded: { params: JITMarketParams; permits: readonly PermitParams[] }): string[] {
  const out: string[] = [];
  const lc = (s: string) => s.toLowerCase();
  const e = encoded.params, d = decoded.params;
  if (lc(e.collateralAsset) !== lc(d.collateralAsset)) out.push("collateralAsset");
  if (lc(e.referenceAsset) !== lc(d.referenceAsset)) out.push("referenceAsset");
  if (e.expiryTimestamp !== d.expiryTimestamp) out.push("expiryTimestamp");
  if (lc(e.recipe) !== lc(d.recipe)) out.push("recipe");
  if (e.rateOverride !== d.rateOverride) out.push("rateOverride");
  for (const k of ["rateMin", "rateMax", "rateChangePerDayMax", "rateChangeCapacityMax"] as const) if (e.constraint[k] !== d.constraint[k]) out.push(`constraint.${k}`);
  if (lc(e.extraData) !== lc(d.extraData)) out.push("extraData");
  if (lc(e.oracleSalt ?? ZERO_ORACLE_SALT) !== lc(d.oracleSalt ?? ZERO_ORACLE_SALT)) out.push("oracleSalt");
  if (e.swapFeePercentage !== d.swapFeePercentage) out.push("swapFeePercentage");
  if (e.unwindSwapFeePercentage !== d.unwindSwapFeePercentage) out.push("unwindSwapFeePercentage");
  if (e.enableJitMint !== d.enableJitMint) out.push("enableJitMint");
  if (encoded.permits.length !== decoded.permits.length) out.push("permits.length");
  else {
    encoded.permits.forEach((ep, i) => {
      const dp = decoded.permits[i]!;
      if (lc(ep.token) !== lc(dp.token) || ep.value !== dp.value || ep.deadline !== dp.deadline || ep.v !== dp.v || lc(ep.r) !== lc(dp.r) || lc(ep.s) !== lc(dp.s)) out.push(`permits[${i}]`);
    });
  }
  return out;
}

/** Split a LOP v4 extension into the JIT hook's target adapter and its extraData bytes — the
 *  wire-INDEPENDENT half of a JIT decode (field 6, PreInteractionData, per ExtensionLib._get).
 *  Decode callers classify the adapter FIRST (generations.ts classifyAddress → the generation's
 *  registry wire) and only then pick the codec; trial-decoding across wires would let a flat
 *  payload read as a plausible nested market, or the reverse. */
export function jitExtensionTarget(extension: `0x${string}`): { adapter: `0x${string}`; extraData: `0x${string}` } {
  const offsets = BigInt(sliceHex(extension, 0, 32));
  const concat = sliceHex(extension, 32);
  const begin = Number((offsets >> (32n * 5n)) & 0xffffffffn);
  const end = Number((offsets >> (32n * 6n)) & 0xffffffffn);
  const pre = sliceHex(concat, begin, end);
  return { adapter: getAddress(sliceHex(pre, 0, 20)), extraData: sliceHex(pre, 20) };
}

/** Decode a JIT extension on a KNOWN wire: adapter + params + permits. */
export function decodeJitExtension(wire: MarketRegistryWire, extension: `0x${string}`): { adapter: `0x${string}`; params: JITMarketParams; permits: PermitParams[] } {
  const { adapter, extraData } = jitExtensionTarget(extension);
  return { adapter, ...decodeJitExtraData(wire, extraData) };
}

// ── Market derivation (what the fill will compute) ──────────────────────────────────────────
/** Build the Market struct + poolId a fill carrying `constraint` would produce — the ONE
 *  derivation of a JIT pool's identity (the rollover branch had a twin, `deriveRolloverJitPool`,
 *  deleted 2026-09-22, review B6). The constraint comes IN (resolved off-chain at signing), so
 *  the identity is a pure function of the order — no rate read, no drift. The width is the
 *  PHOENIX wire of the generation the fill creates on and is REQUIRED (the pre-0.6 8-field
 *  default let a caller that forgot it hash the wrong width silently — review D): 8-field keeps
 *  the fees outside the id; 10-field makes the two fee percentages the Market's last two
 *  members AND part of the id (they default to zero there — a pool with a different fee is a
 *  different pool). The id is computeMarketId on that wire, bit-identical to poolManager.getId
 *  (10-field golden vector captured live 2026-09-22). */
export function deriveJitMarket(args: {
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  expiryTimestamp: bigint;
  constraint: ResolvedConstraint;
  oracle: `0x${string}`;
  wire: PhoenixWire;
  swapFeePercentage?: bigint | undefined;
  unwindSwapFeePercentage?: bigint | undefined;
}): { market: Market; poolId: `0x${string}`; wire: PhoenixWire } {
  const wire: PhoenixWire = args.wire;
  const eight: Market8 = {
    collateralAsset: args.collateralAsset,
    referenceAsset: args.referenceAsset,
    expiryTimestamp: args.expiryTimestamp,
    rateMin: args.constraint.rateMin,
    rateMax: args.constraint.rateMax,
    rateChangePerDayMax: args.constraint.rateChangePerDayMax,
    rateChangeCapacityMax: args.constraint.rateChangeCapacityMax,
    rateOracle: args.oracle,
  };
  if (wire === "10-field") {
    const market: Market10 = { ...eight, swapFeePercentage: args.swapFeePercentage ?? 0n, unwindSwapFeePercentage: args.unwindSwapFeePercentage ?? 0n };
    return { market, poolId: computeMarketId(market, "10-field"), wire };
  }
  return { market: eight, poolId: computeMarketId(eight, "8-field"), wire };
}

/** Unsigned MarketRegistry.deploy calldata for the wire — flat: deploy(ca, ref, mode); nested:
 *  deploy(ca, ref, mode, oracleSalt) (zero salt = the pair's default wrapper; the salt is refused
 *  non-zero on flat, which has no field for it). Permissionless + idempotent on both (an existing
 *  pair/mode wrapper is returned whatever the salt). */
export function buildDeployOracleCall(wire: MarketRegistryWire, ca: `0x${string}`, ref: `0x${string}`, mode: OracleModeName, oracleSalt?: `0x${string}` | undefined): `0x${string}` {
  assertImplementedWire(wire);
  if (wire === "flat") {
    if (!isZeroSalt(oracleSalt)) throw new Error("buildDeployOracleCall: the flat (0.3.x) registry's deploy(ca, ref, mode) carries no oracleSalt — a non-zero salt cannot be encoded for a flat-wire registry");
    return encodeFunctionData({ abi: marketRegistryAbi, functionName: "deploy", args: [ca, ref, ORACLE_MODE[mode]] });
  }
  return encodeFunctionData({ abi: marketRegistryNestedAbi, functionName: "deploy", args: [ca, ref, ORACLE_MODE[mode], oracleSalt ?? ZERO_ORACLE_SALT] });
}

/** Unsigned MarketRegistry.deployFixedRateOracle(rate) calldata — CREATE2-salted by the rate,
 *  so a given rate has ONE oracle per chain; idempotent; a zero rate reverts in the oracle
 *  constructor. Identical bytes on both wires (the selector and shape did not change). */
export function buildDeployFixedRateOracleCall(rate: bigint): `0x${string}` {
  return encodeFunctionData({ abi: marketRegistryAbi, functionName: "deployFixedRateOracle", args: [rate] });
}

/** controller.createNewPool calldata for share-prediction simulations, per PHOENIX wire:
 *  8-field `(Market_ pool, unwindFee, swapFee, isWhitelistEnabled)` (unwind BEFORE swap);
 *  10-field `((Market10 pool, isWhitelistEnabled))` — the fees are the market's own last two
 *  members, so a 10-field call takes NO fee arguments (they are already in `market`). */
export function buildCreatePoolCall(wire: PhoenixWire, market: Market, fees: { unwindSwapFeePercentage: bigint; swapFeePercentage: bigint } = { unwindSwapFeePercentage: 0n, swapFeePercentage: 0n }): `0x${string}` {
  if (wire === "10-field") {
    if (!("swapFeePercentage" in market)) throw new Error("buildCreatePoolCall: a 10-field controller takes a 10-field Market (fees inside the struct) — derive it on the 10-field wire");
    return encodeFunctionData({ abi: controllerCreatePool10Abi, functionName: "createNewPool", args: [{ pool: { ...market }, isWhitelistEnabled: false }] });
  }
  if ("swapFeePercentage" in market) throw new Error("buildCreatePoolCall: an 8-field controller takes an 8-field Market — the fees ride as separate arguments there");
  return encodeFunctionData({
    abi: controllerCreatePoolAbi,
    functionName: "createNewPool",
    args: [{ pool: { ...market }, unwindSwapFeePercentage: fees.unwindSwapFeePercentage, swapFeePercentage: fees.swapFeePercentage, isWhitelistEnabled: false }],
  });
}

const sharesAbi = parseAbi(["function shares(bytes32 poolId) view returns (address principalToken, address swapToken)"]);

/** poolManager.shares(poolId) calldata, for the second leg of the prediction simulation. */
export function buildSharesCall(poolId: `0x${string}`): `0x${string}` {
  return encodeFunctionData({ abi: sharesAbi, functionName: "shares", args: [poolId] });
}

// ── CorkMarketCreator: direct pool creation ahead of a fill ─────────────────────────────────

/** CorkMarketCreator surface on the FLAT wire (cork-periphery 0.1.0). `MarketParams` is the
 *  adapter's JITMarketParams WITHOUT the fill-only mint flag — the nine shared fields keep the
 *  same names, types, and ORDER (wire format; the contract states the parity as a rule). The
 *  typed errors are declared so simulate/decode name the creator's own reverts. */
export const marketCreatorAbi = parseAbi([
  "struct CreatorRateConstraint { uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
  "struct CreatorMarketParams { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; address recipe; uint256 rateOverride; CreatorRateConstraint constraint; bytes additionalData; uint256 swapFeePercentage; uint256 unwindSwapFeePercentage; }",
  "function POOL_MANAGER() view returns (address)",
  "function CONTROLLER() view returns (address)",
  "function MARKET_REGISTRY() view returns (address)",
  "function MAX_FEE_PERCENTAGE() view returns (uint256)",
  "function version() view returns (string)",
  "function createNewPool(CreatorMarketParams params) returns (bytes32 poolId, address cst, address cpt)",
  "error RateUnavailable()",
  "error UnexpectedRateOverride(address recipe)",
  "error RecipeRejectedConstraint(address recipe)",
  "error ExpiryOutOfRange(uint256 expiryTimestamp, uint256 maxExpiryTimestamp)",
  "error SwapFeeOutOfRange(uint256 fee, uint256 maxFee)",
  "error UnwindSwapFeeOutOfRange(uint256 fee, uint256 maxFee)",
]);

/** The creator's input: JITMarketParams minus `enableJitMint` (creation only, never a mint). */
export type CreatorMarketParams = Omit<JITMarketParams, "enableJitMint">;

/** Unsigned CorkMarketCreator.createNewPool(params) calldata for the wire — the same pool a JIT
 *  fill would derive and create, creatable AHEAD of the fill; permissionless + idempotent (an
 *  existing pool is a lookup returning (poolId, cst, cpt)). Flat: the nine-field periphery
 *  struct (bytes as `additionalData`, no salt — refused non-zero); nested: the registry
 *  package's 10-field MarketParams (selector 0x59c8eb4c; `extraData`, `oracleSalt` at index 7). */
export function buildCreatorCreatePoolCall(wire: MarketRegistryWire, params: CreatorMarketParams): `0x${string}` {
  assertImplementedWire(wire);
  if (wire === "flat") {
    if (!isZeroSalt(params.oracleSalt)) throw new Error("buildCreatorCreatePoolCall: the flat (cork-periphery 0.1.0) creator's MarketParams carries no oracleSalt — a non-zero salt cannot be encoded for a flat-wire creator");
    return encodeFunctionData({
      abi: marketCreatorAbi,
      functionName: "createNewPool",
      args: [{
        collateralAsset: params.collateralAsset,
        referenceAsset: params.referenceAsset,
        expiryTimestamp: params.expiryTimestamp,
        recipe: params.recipe,
        rateOverride: params.rateOverride,
        constraint: { ...params.constraint },
        additionalData: params.extraData,
        swapFeePercentage: params.swapFeePercentage,
        unwindSwapFeePercentage: params.unwindSwapFeePercentage,
      }],
    });
  }
  return encodeFunctionData({ abi: marketCreatorNestedAbi, functionName: "createNewPool", args: [nestedMarketParamsOf(params)] });
}

/** The recipe.verify staticcall per wire — flat: verify(ca, ref, oracle, constraint, bytes);
 *  nested: verify(ca, ref, oracle, expiryTimestamp, creating, constraint, bytes) — `creating` is
 *  what the creator/adapter pass when THIS call would create the pool (the recipe applies its
 *  creation-only rules once, e.g. the impairment duration bound). One call site for the arg
 *  order, so the maker ladder, the taker ladder and create-pool cannot hold it differently. */
export async function recipeVerify(
  wire: MarketRegistryWire,
  client: Pick<PublicClient, "readContract">,
  a: { recipe: `0x${string}`; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; oracle: `0x${string}`; expiryTimestamp: bigint; creating: boolean; constraint: ResolvedConstraint; extraData: `0x${string}` },
): Promise<boolean> {
  assertImplementedWire(wire);
  if (wire === "flat") {
    return client.readContract({ address: a.recipe, abi: recipeAbi, functionName: "verify", args: [a.collateralAsset, a.referenceAsset, a.oracle, { ...a.constraint }, a.extraData] });
  }
  return client.readContract({ address: a.recipe, abi: recipeNestedAbi, functionName: "verify", args: [a.collateralAsset, a.referenceAsset, a.oracle, a.expiryTimestamp, a.creating, { ...a.constraint }, a.extraData] });
}

/** The verify calldata alone (for tests pinning the selector/arg layout and for simulations). */
export function buildRecipeVerifyCall(wire: MarketRegistryWire, a: Parameters<typeof recipeVerify>[2]): `0x${string}` {
  assertImplementedWire(wire);
  if (wire === "flat") return encodeFunctionData({ abi: recipeAbi, functionName: "verify", args: [a.collateralAsset, a.referenceAsset, a.oracle, { ...a.constraint }, a.extraData] });
  return encodeFunctionData({ abi: recipeNestedAbi, functionName: "verify", args: [a.collateralAsset, a.referenceAsset, a.oracle, a.expiryTimestamp, a.creating, { ...a.constraint }, a.extraData] });
}

/** Which contract holds the controller's pool-creator role on each wire — the adapter (flat:
 *  it creates pools itself) or the market creator (nested: the adapter delegates creation to
 *  it). The share-prediction simulation grants the role to and runs as THIS account. */
export function roleHolderOf(wire: MarketRegistryWire): "adapter" | "creator" {
  assertImplementedWire(wire);
  return wire === "flat" ? "adapter" : "creator";
}

/** The ONE codec table keyed by implemented registry wire: every per-wire ABI and builder in one
 *  row, so a handler picks the row once (`wireCodec(mr.wire)`) and cannot mix a flat ABI with a
 *  nested builder. The binding chain and role holder are the pre-flight facts a handler reads
 *  off the chain for that wire. */
export interface WireCodec {
  wire: ImplementedMarketRegistryWire;
  adapterAbi: Abi;
  creatorAbi: Abi;
  registryAbi: Abi;
  recipeAbi: Abi;
  /** The account the controller's POOL_CREATOR_ROLE must be granted to. */
  roleHolder: "adapter" | "creator";
  /** The adapter's binding reads → what each must equal (teaching + the pre-flight's shape). */
  bindingChain: readonly string[];
  /** Whether the registry stack exposes MAX_FEE_PERCENTAGE() (flat: adapter + creator do). */
  hasFeeCapView: boolean;
  /** The name the wire's own contracts use for the recipe bytes. */
  bytesField: "additionalData" | "extraData";
  encodeExtraData: (params: JITMarketParams, permits?: readonly PermitParams[]) => `0x${string}`;
  decodeExtraData: (extraData: `0x${string}`) => { params: JITMarketParams; permits: PermitParams[] };
  deployCall: (ca: `0x${string}`, ref: `0x${string}`, mode: OracleModeName, oracleSalt?: `0x${string}` | undefined) => `0x${string}`;
  creatorCreatePoolCall: (params: CreatorMarketParams) => `0x${string}`;
  verify: (client: Pick<PublicClient, "readContract">, a: Parameters<typeof recipeVerify>[2]) => Promise<boolean>;
}

export const WIRES: Readonly<Record<ImplementedMarketRegistryWire, WireCodec>> = {
  flat: {
    wire: "flat",
    adapterAbi: jitAdapterAbi,
    creatorAbi: marketCreatorAbi,
    registryAbi: marketRegistryAbi,
    recipeAbi,
    roleHolder: "adapter",
    bindingChain: ["adapter.LIMIT_ORDER_PROTOCOL == the chain's LOP", "adapter.MARKET_REGISTRY == the configured registry", "adapter.CONTROLLER → the controller whose roles gate creation"],
    hasFeeCapView: true,
    bytesField: "additionalData",
    encodeExtraData: (params, permits) => encodeJitExtraData("flat", params, permits),
    decodeExtraData: (bytes) => decodeJitExtraData("flat", bytes),
    deployCall: (ca, ref, mode, salt) => buildDeployOracleCall("flat", ca, ref, mode, salt),
    creatorCreatePoolCall: (params) => buildCreatorCreatePoolCall("flat", params),
    verify: (client, a) => recipeVerify("flat", client, a),
  },
  nested: {
    wire: "nested",
    adapterAbi: jitAdapterNestedAbi,
    creatorAbi: marketCreatorNestedAbi,
    registryAbi: marketRegistryNestedAbi,
    recipeAbi: recipeNestedAbi,
    roleHolder: "creator",
    bindingChain: ["adapter.LIMIT_ORDER_PROTOCOL == the chain's LOP", "adapter.MARKET_CREATOR == the configured market creator", "creator.MARKET_REGISTRY == the configured registry", "creator.CONTROLLER → the controller whose POOL_CREATOR role the CREATOR holds", "adapter.POOL_MANAGER == creator.POOL_MANAGER == the generation's pool manager"],
    hasFeeCapView: false,
    bytesField: "extraData",
    encodeExtraData: (params, permits) => encodeJitExtraData("nested", params, permits),
    decodeExtraData: (bytes) => decodeJitExtraData("nested", bytes),
    deployCall: (ca, ref, mode, salt) => buildDeployOracleCall("nested", ca, ref, mode, salt),
    creatorCreatePoolCall: (params) => buildCreatorCreatePoolCall("nested", params),
    verify: (client, a) => recipeVerify("nested", client, a),
  },
};

/** The codec row for a generation's declared registry wire; throws on the legacy wire (its lane
 *  is market-registry-legacy.ts, reached only through the deprecation gate). */
export function wireCodec(wire: MarketRegistryWire): WireCodec {
  assertImplementedWire(wire);
  return WIRES[wire];
}

/** rateOverride ↔ recipe-source coherence — the ONE comparator behind the JIT ladder's and the
 *  create-pool prepare's gates (the wording differs per site; the rule must not): a FIXED
 *  recipe's oracle is FixedRateOracle(rateOverride), whose constructor reverts on 0; a
 *  price/nav path REJECTS a non-zero override (UnexpectedRateOverride), it is not ignored. */
export function rateOverrideCoherence(source: RecipeSourceName, rateOverride: bigint): "needs-rate" | "must-be-zero" | "ok" {
  if (source === "fixed") return rateOverride === 0n ? "needs-rate" : "ok";
  return rateOverride !== 0n ? "must-be-zero" : "ok";
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
 *  predictor. On the 8-field wire fees are NOT part of market identity (callers that only want
 *  the tokens pass 0); on the 10-field wire they ride inside `market` and ARE the identity. */
export interface PredictSharesResult {
  cst?: `0x${string}` | undefined;
  cpt?: `0x${string}` | undefined;
  exists: boolean;
  status: "read" | "simulated" | "unavailable";
  /** Why `unavailable`: the creation leg's REVERT (decoded against the creator/pool-manager/
   *  registry/recipe error sets when it matches one — `InvalidRate()`, `RecipeRejectedConstraint(…)`,
   *  `ExpiryOutOfRange(…)`), a pre-leg's revert, a shares read that decoded to a zero cST, or the
   *  transport ("eth_simulateV1 unsupported"). The 2026-09-22 nested fill rehearsal spent three runs
   *  on a market the FILL rejected while this result said only "unsupported, or config missing" —
   *  a simulated revert is a fact about the market, and the caller must see it. */
  reason?: string | undefined;
}

/** The pool manager's creation-time refusals (phoenix IPoolManager, both wires) — the errors a
 *  simulated createNewPool surfaces when the MARKET is the fault: a live rate outside the carried
 *  window (`InvalidRate`), an expiry in the past, a fee at or over the 10-field cap, a paused
 *  manager, or a creator/adapter without POOL_CREATOR_ROLE (the state override should prevent the
 *  last one; seeing it means the override missed). Declared here for the decoder only. */
const poolManagerRevertAbi = parseAbi([
  "error InvalidRate()",
  "error InvalidExpiry()",
  "error InvalidFees()",
  "error InvalidParams()",
  "error EnforcedPause()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

/** Name a simulate leg's failure: the decoded custom error when the bytes match a known Cork error
 *  set, else the raw selector — never a guess at what the contract meant. */
function simulateLegFailure(leg: { status: string; error?: unknown; data?: `0x${string}` | undefined } | undefined, label: string): string {
  if (!leg) return `${label}: no result returned by eth_simulateV1`;
  const raw = leg.data;
  if (raw && raw.length >= 10) {
    for (const abi of [marketCreatorNestedAbi, marketCreatorAbi, recipeNestedAbi, recipeAbi, marketRegistryNestedAbi, marketRegistryAbi, controllerCreatePoolAbi, controllerCreatePool10Abi, poolManagerRevertAbi]) {
      try {
        const d = decodeErrorResult({ abi, data: raw });
        return `${label} reverted ${d.errorName}(${(d.args ?? []).map((a) => String(a)).join(", ")})`;
      } catch {
        /* not this error set */
      }
    }
    return `${label} reverted with selector ${raw.slice(0, 10)}`;
  }
  const err = leg.error;
  return `${label} failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err ?? leg.status)}`;
}

export async function predictShares(
  client: PublicClient,
  args: {
    /** The account the simulation runs AS and grants POOL_CREATOR to: the role holder of the
     *  registry wire — the JIT adapter (flat) or the market creator (nested), see roleHolderOf. */
    adapter: `0x${string}`;
    controller: `0x${string}`;
    poolManager: `0x${string}`;
    market: Market;
    poolId: `0x${string}`;
    /** The controller's wire — REQUIRED (the pre-0.6 8-field default was removed 2026-09-22,
     *  review D); a 10-field market must be derived on the 10-field wire — buildCreatePoolCall
     *  refuses a mixed pair. */
    wire: PhoenixWire;
    unwindSwapFeePercentage?: bigint;
    swapFeePercentage?: bigint;
    /** Legs to run BEFORE createNewPool in the simulation — e.g. the permissionless
     *  registry.deploy / deployFixedRateOracle the fill itself performs when the market's oracle
     *  is not deployed yet. Mirrors the fill exactly, so prediction works pre-deploy. */
    preCalls?: readonly { to: `0x${string}`; data: `0x${string}` }[];
    /** Enables the constants-cache lookup of the controller's live POOL_CREATOR_ROLE hash for
     *  the state-override grant (cache-read only — no extra RPC on this hot path); omitted =
     *  the compiled fallback, the pre-cache behavior. */
    chainId?: number;
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
  // 2. Simulate the creation the fill would perform, granting the simulating account (the role
  //    holder) POOL_CREATOR_ROLE via state override — role-grant-independent, so the prediction
  //    works both before and after governance grants the real roles. The role hash prefers the
  //    controller's own cached live value (warmed by readRoleHolder in the same prepare); the
  //    compiled fallback covers a cold cache.
  try {
    const pre = args.preCalls ?? [];
    const creatorRole = (args.chainId !== undefined ? cachedContractConstantBytes32(args.chainId, args.controller, "POOL_CREATOR_ROLE") : undefined) ?? POOL_CREATOR_ROLE;
    const createData = buildCreatePoolCall(args.wire, args.market, { unwindSwapFeePercentage: args.unwindSwapFeePercentage ?? 0n, swapFeePercentage: args.swapFeePercentage ?? 0n });
    const simulated = await client.simulateCalls({
      account: args.adapter,
      calls: [
        ...pre.map((c) => ({ to: c.to, data: c.data })),
        { to: args.controller, data: createData },
        { to: poolManager, data: buildSharesCall(args.poolId) },
      ],
      stateOverrides: [
        { address: args.controller, stateDiff: [{ slot: roleMemberSlot(creatorRole, args.adapter), value: toHex(1n, { size: 32 }) }] },
      ],
    });
    const create = simulated.results[pre.length];
    const last = simulated.results[pre.length + 1];
    // Legs run in ONE simulated block state and a failed leg does NOT stop the ones after it, so
    // the pre-legs are judged FIRST: an oracle deploy that reverted leaves the creation leg
    // running against an address with no code, and whatever it then returns describes nothing.
    const failedPre = pre.findIndex((_c, i) => simulated.results[i]?.status !== "success");
    if (failedPre >= 0) {
      return { exists: false, status: "unavailable", reason: simulateLegFailure(simulated.results[failedPre], `pre-leg ${failedPre + 1} of ${pre.length} (${pre[failedPre]!.to})`) };
    }
    // The creation leg must have SUCCEEDED and the shares read must decode to a non-zero cST —
    // a zero address here means the pool was not actually created in-memory, and serving it as a
    // prediction would be an invention.
    if (create?.status === "success" && last?.status === "success" && last.data && last.data.length >= 2 + 64 * 2) {
      const cpt = getAddress(`0x${last.data.slice(2 + 24, 2 + 64)}`);
      const cst = getAddress(`0x${last.data.slice(2 + 64 + 24, 2 + 128)}`);
      if (cst !== ZERO_ADDRESS) {
        return { cst, cpt: cpt === ZERO_ADDRESS ? undefined : cpt, exists: false, status: "simulated" };
      }
      return { exists: false, status: "unavailable", reason: "the creation leg succeeded but shares(poolId) read a zero cST — the pool the controller created is not the pool id derived here (identity inputs disagree)" };
    }
    // A revert here is a fact about the MARKET (the rate outside its window, the recipe rejecting
    // the constraint, an expiry past the bound), not about the transport.
    const reason = create?.status !== "success" ? simulateLegFailure(create, "controller.createNewPool") : simulateLegFailure(last, "poolManager.shares");
    return { exists: false, status: "unavailable", reason };
  } catch (err) {
    // The TRANSPORT failed us: eth_simulateV1 or state overrides unsupported by this endpoint, or
    // the request was refused before any leg ran.
    return { exists: false, status: "unavailable", reason: `eth_simulateV1 with state overrides failed on this endpoint: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}

// ── JIT + market lifecycle events (source-verified signatures) ─────────────────────────────
// 2.1.0 JITMarketCreated carries the RECIPE ADDRESS where the legacy event carried a mode
// string — both topics stay decodable (receipts from either generation label correctly). The
// nested-wire adapter emits ONLY JITMinted (same signature); market creation is announced by the
// CREATOR's MarketCreated (9 args, poolId/rateOracle/caller indexed) and by the 10-field pool
// manager's MarketCreated (9 args: the 8-field seven plus the two fees) — both topic0s verified
// against the 0.5.0 / 1.4.0-rc.1 ABIs 2026-09-22.
export const JIT_MARKET_CREATED_TOPIC = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,address)");
export const JIT_MINTED_TOPIC = toEventSelector("JITMinted(bytes32,address,uint256,uint256)");
export const JIT_MARKET_CREATED_LEGACY_TOPIC = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,string)");
export const CREATOR_MARKET_CREATED_TOPIC = toEventSelector("MarketCreated(bytes32,address,address,address,uint256,address,uint256,uint256,address)");
export const POOL_MANAGER_MARKET_CREATED_10_TOPIC = toEventSelector("MarketCreated(bytes32,address,address,uint256,address,address,address,uint256,uint256)");
export const JIT_EVENTS: Record<string, string> = {
  [JIT_MARKET_CREATED_TOPIC]: "JITMarketCreated",
  [JIT_MINTED_TOPIC]: "JITMinted",
  [JIT_MARKET_CREATED_LEGACY_TOPIC]: "JITMarketCreated (legacy pre-2.1.0)",
  [CREATOR_MARKET_CREATED_TOPIC]: "MarketCreated (CorkMarketCreator, nested wire)",
  [POOL_MANAGER_MARKET_CREATED_10_TOPIC]: "MarketCreated (pool manager, 10-field wire)",
};
