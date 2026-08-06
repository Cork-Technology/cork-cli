// DEPRECATED — the pre-2.1.0 MarketRegistry + CorkLimitOrderAdapter generation (registry
// 0xF674…600A, adapter 0xea15…8505). Superseded 2026-07-31 by the 2.1.0 redeploy
// (market-registry.ts); kept intact behind the general deprecation gate (deprecation.ts,
// CORK_ENABLE_DEPRECATED=1) because the OLD adapter still holds both controller roles on-chain
// (verified 2026-08-03) — until governance grants them to the 2.1.0 adapter, this is the only
// fillable JIT path. The old registry ALSO still answers 2.1.0-shaped calls with misdecoded
// garbage, which is exactly why the new module never talks to these addresses.
// Old model (all of this changed in 2.1.0): recipes are mode STRINGS with PERCENTAGE bands
// (1e18 = 1%) resolved at FILL time from the live oracle rate via applyBands — so the pool id
// drifts with the rate; oracles are per-pair with no mode; extraData carries the mode string.
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, size, sliceHex, toEventSelector, toHex } from "viem";
import type { PublicClient } from "viem";
import { computeMarketId } from "./marketid.ts";
import type { Market } from "./types.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// ── ABIs (verified against Sourcify-published ABIs / INTEGRATOR.md) ──────────
export const marketRegistryAbi = parseAbi([
  "struct AssetSource { address addr; string quoteUnit; }",
  "struct Asset { address addr; uint64 chainId; string name; uint8 kind; string denomination; AssetSource[] sources; }",
  "struct ConstraintBands { string mode; uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
  "struct ResolvedConstraint { uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
  "function lookupAssetByAddress(address addr, uint64 chainId) view returns (bool found, Asset entry)",
  "function lookupWrapper(address ca, address ref) view returns (address wrapper)",
  "function lookupRecipe(string mode) view returns (bool found, ConstraintBands entry)",
  "function applyBands(string mode, uint256 rate) view returns (ResolvedConstraint constraint)",
  "function getAssets(uint256 offset, uint256 limit) view returns (Asset[] page, uint256 total)",
  "function getRecipes(uint256 offset, uint256 limit) view returns (ConstraintBands[] page, string[] modes, uint256 total)",
  "function deploy(address ca, address ref) returns (address wrapper)",
]);

export const jitAdapterAbi = parseAbi([
  "function LIMIT_ORDER_PROTOCOL() view returns (address)",
  "function POOL_MANAGER() view returns (address)",
  "function CONTROLLER() view returns (address)",
  "function MARKET_REGISTRY() view returns (address)",
]);

export const accessControlAbi = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

/** DefaultCorkController.createNewPool — Sourcify-verified shape; used ONLY in eth_simulateV1
 *  chains (from: adapter, which holds POOL_CREATOR_ROLE) to predict the cST of a not-yet-created
 *  pool. Field order is load-bearing: unwind fee BEFORE swap fee. */
export const controllerCreatePoolAbi = parseAbi([
  "struct Market_ { address collateralAsset; address referenceAsset; uint256 expiryTimestamp; uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; address rateOracle; }",
  "struct PoolCreationParams { Market_ pool; uint256 unwindSwapFeePercentage; uint256 swapFeePercentage; bool isWhitelistEnabled; }",
  "function createNewPool(PoolCreationParams params)",
]);

/** Controller role hashes (INTEGRATOR.md; confirmed granted on-chain 2026-07-22). */
export const POOL_CREATOR_ROLE = "0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52" as const;
export const CONFIGURATOR_ROLE = "0x3b49a237fe2d18fa4d9642b8a0e065923cceb71b797783b619a030a61d848bf0" as const;

// ── applyBands: bit-exact port of MarketRegistryLib.applyBands ───────────────
// Bands are PERCENTAGES (1e18 = 1%, denominator 100e18); rate and the resolved outputs are plain
// 18-decimal fixed point (1e18 = 1.0). Rounding always tightens: the floor rounds UP, the other
// three round DOWN. bigint products are exact, matching mulDiv's 512-bit intermediate.
export const PERCENTAGE_DENOMINATOR = 100n * 10n ** 18n;

export interface ConstraintBands {
  mode: string;
  rateMin: bigint;
  rateMax: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
}
export interface ResolvedConstraint {
  rateMin: bigint;
  rateMax: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
}

const mulDivFloor = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivCeil = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

export function applyBandsLocal(b: ConstraintBands, rate: bigint): ResolvedConstraint {
  if (b.rateMin > PERCENTAGE_DENOMINATOR) throw new Error("rateMin band above 100% — registry would never store this");
  return {
    rateMin: mulDivCeil(rate, PERCENTAGE_DENOMINATOR - b.rateMin, PERCENTAGE_DENOMINATOR),
    rateMax: mulDivFloor(rate, PERCENTAGE_DENOMINATOR + b.rateMax, PERCENTAGE_DENOMINATOR),
    rateChangePerDayMax: mulDivFloor(rate, b.rateChangePerDayMax, PERCENTAGE_DENOMINATOR),
    rateChangeCapacityMax: mulDivFloor(rate, b.rateChangeCapacityMax, PERCENTAGE_DENOMINATOR),
  };
}

// ── JIT hook payload + 1inch v4 extension building ───────────────────────────
export interface JITMarketParams {
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  expiryTimestamp: bigint;
  mode: string;
  swapFeePercentage: bigint; // 1e18 = 1%, max 5e18 — consumed only when the fill creates the pool
  unwindSwapFeePercentage: bigint;
  enableJitMint: boolean;
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
      { name: "mode", type: "string" },
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
      mode: params.mode,
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
  // fields 0..5 empty (end offset 0); field 6 ends at `end`; field 7 (postInteraction) ends at
  // the same cumulative offset (empty). CustomData (bits 224+ tail) is empty too.
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
    { collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; expiryTimestamp: bigint; mode: string; swapFeePercentage: bigint; unwindSwapFeePercentage: bigint; enableJitMint: boolean },
    Array<{ token: `0x${string}`; value: bigint; deadline: bigint; v: number; r: `0x${string}`; s: `0x${string}` }>,
  ];
  return { adapter, params: { ...p }, permits: permits.map((x) => ({ ...x })) };
}

// ── Market derivation (what the fill will compute) ───────────────────────────
/** Derive the Market struct + poolId the adapter would derive at fill time, given the live
 *  oracle rate. Field order matches the adapter exactly; the id comes from our verified
 *  computeMarketId (keccak256(abi.encode(Market))). */
export function deriveJitMarket(args: {
  params: Pick<JITMarketParams, "collateralAsset" | "referenceAsset" | "expiryTimestamp" | "mode">;
  oracle: `0x${string}`;
  rate: bigint;
  bands: ConstraintBands;
}): { market: Market; poolId: `0x${string}`; resolved: ResolvedConstraint } {
  const resolved = applyBandsLocal(args.bands, args.rate);
  const market: Market = {
    collateralAsset: args.params.collateralAsset,
    referenceAsset: args.params.referenceAsset,
    expiryTimestamp: args.params.expiryTimestamp,
    rateMin: resolved.rateMin,
    rateMax: resolved.rateMax,
    rateChangePerDayMax: resolved.rateChangePerDayMax,
    rateChangeCapacityMax: resolved.rateChangeCapacityMax,
    rateOracle: args.oracle,
  };
  return { market, poolId: computeMarketId(market), resolved };
}

/** Unsigned MarketRegistry.deploy(ca, ref) calldata — permissionless + idempotent (an existing
 *  pair just returns the recorded wrapper). The `deploy-oracle` prepare_market variant. */
export function buildDeployOracleCall(ca: `0x${string}`, ref: `0x${string}`): `0x${string}` {
  return encodeFunctionData({ abi: marketRegistryAbi, functionName: "deploy", args: [ca, ref] });
}

/** controller.createNewPool calldata for eth_simulateV1 share-prediction chains (from: adapter). */
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

/** The pool's two share tokens as the chain would produce them for `poolId`.
 *  - `read`: the pool already exists — the addresses are PINNED (read straight from poolManager).
 *  - `simulated`: the pool does not exist — created in-memory via eth_simulateV1 (from the adapter,
 *    which holds POOL_CREATOR_ROLE) then read back; rate-conditioned, unpinned until real creation.
 *  - `unavailable`: the RPC lacks eth_simulateV1 or the simulation reverted — cST/cPT unknown.
 *  cST/cPT are deployed via plain `new PoolShare(...)` (nonce CREATE, NOT CREATE2 — see
 *  SharesFactory.sol), so there is no off-chain address derivation: simulation is the only predictor.
 *  Fees are NOT part of market identity, so any fee values yield the same tokens; callers that only
 *  want the tokens can pass 0. */
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
  },
): Promise<PredictSharesResult> {
  // 1. Direct read — a non-zero swapToken means the pool exists; both addresses are pinned.
  try {
    const [principalToken, swapToken] = (await client.readContract({
      address: args.poolManager,
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
  // 2. Simulate the creation the fill would perform, then read shares(poolId) in the same call.
  try {
    const createData = buildCreatePoolCall(args.market, args.unwindSwapFeePercentage ?? 0n, args.swapFeePercentage ?? 0n);
    const simulated = await client.simulateCalls({
      account: args.adapter,
      calls: [
        { to: args.controller, data: createData },
        { to: args.poolManager, data: buildSharesCall(args.poolId) },
      ],
    });
    const last = simulated.results[1];
    if (last?.status === "success" && last.data && last.data.length >= 2 + 64 * 2) {
      const cpt = getAddress(`0x${last.data.slice(2 + 24, 2 + 64)}`);
      const cst = getAddress(`0x${last.data.slice(2 + 64 + 24, 2 + 128)}`);
      return { cst, cpt, exists: false, status: "simulated" };
    }
  } catch {
    /* eth_simulateV1 unsupported or the simulation reverted */
  }
  return { exists: false, status: "unavailable" };
}

// ── JIT lifecycle events (adapter source, frozen signatures) ─────────────────
export const JIT_MARKET_CREATED_TOPIC = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,string)");
export const JIT_MINTED_TOPIC = toEventSelector("JITMinted(bytes32,address,uint256,uint256)");
export const JIT_EVENTS: Record<string, string> = {
  [JIT_MARKET_CREATED_TOPIC]: "JITMarketCreated",
  [JIT_MINTED_TOPIC]: "JITMinted",
};
