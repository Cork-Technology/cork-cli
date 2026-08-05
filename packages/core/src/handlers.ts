// One typed dispatch shared by the MCP server and the CLI (RFC: "MCP + CLI over one core").
// Pure/offline tools are fully implemented; chain-backed compute runs when an RPC + addresses
// are supplied, else returns an honest `unavailable` envelope; unimplemented phases return
// `unavailable` with a reason rather than a fabricated result [K1/K3].
import { hashTypedData, isAddressEqual, keccak256, recoverAddress, stringToHex } from "viem";
import {
  Address,
  Bytes32,
  Hex,
  UintStr,
  buildTeaching,
  type ChainId,
  MATURITY,
  nearestValue,
  searchTools,
  TOOL_EXAMPLES,
  type Teaching,
  type ToolName,
  ComputeInput,
  type ComputeParams,
  DecodeInput,
  Envelope,
  inputJsonSchema,
  MarketId,
  PrepareOrdersInput,
  PreparePhoenixInput,
  QueryInput,
  SubmitInput,
  TrackInput,
  REGISTRY,
  SCHEMA_VERSION,
  toolByName,
  UnixSeconds,
  type PhoenixAction,
} from "@cork/schemas";
import { WAD, mulDiv } from "./math/fixed.ts";
import { impairmentFloor, previewAdjustedRate } from "./math/constraint.ts";
import { previewSwap, previewUnwindSwap } from "./math/preview.ts";
import { computeMarketId } from "./marketid.ts";
import { corkActionCall, type CorkActionParamMap } from "./bundle/actions.ts";
import { encodeMulticall, type Call } from "./bundle/bundler3.ts";
import { decodeBundle } from "./bundle/decode.ts";
import { summarizeBundle } from "./bundle/summary.ts";
import { buildAuthorityTx, spenderRoleOf, type AuthorityAction } from "./bundle/authority.ts";
import { canAutoFund, fundingPlan, type FundingMode } from "./bundle/funding.ts";
import { poolPreflightWarnings } from "./bundle/preflight.ts";
import { readPoolState, resolvePoolTokens, type CorkAddresses } from "./chain/reads.ts";
import { isTransportError, reportEndpointFailure, resolveRpc as resolveRpcBuiltin, hostOf, RpcChainMismatchError, type ResolvedRpc } from "./chain/rpc.ts";
import { erc20Abi, permit2AllowanceAbi, rateOracleAbi, whitelistManagerAbi } from "./chain/abis.ts";
import { verifyCreate2 } from "./create2.ts";
import { buildCancelOrder, buildMakerOrder, buildTakerFill, classifyBitInvalidator, classifyRemainingRaw, decodeExtensionFields, decodeMakerTraits, decodeOrderTuple, encodeExtensionFields, finalizeMakerOrder, hashLopOrder, lopDomain, lopInvalidatorAbi, lopInvalidatorPlan, LOP_ADDRESSES, type LopOrder, type TakerFillResult } from "./orders.ts";
import { aggregatorV3Abi, ASSET_KIND, buildDeployFixedRateOracleCall, buildDeployOracleCall, buildJitExtension, constantGetterAbi, decodeJitExtension, DENOMINATION_PSEUDO_UNITS, deriveJitMarket, encodeJitExtraData, erc20MetadataAbi, JIT_EVENTS, jitAdapterAbi, marketRegistryAbi, ORACLE_MODE, predictShares, readAdapterRoles, readForeignSharePool, RECIPE_CATALOG, RECIPE_SOURCE, recipeAbi, SOURCE_INTERFACE, SOURCE_TYPE, type OracleModeName, type PermitParams, type PredictSharesResult, type RecipeSourceName, type ResolvedConstraint } from "./market-registry.ts";
import * as legacyRegistry from "./market-registry-legacy.ts";
import { deprecatedEnabled, deprecatedGateMessage } from "./deprecation.ts";
import { CREATE2_ATTESTATIONS, CREATE2_DEPLOYER, type CorkDeployment } from "./config.ts";
import { resolveConfig, resolveDeployment as resolveDeploymentBuiltin, resolveMarketRegistry, resolveMarketRegistryLegacy, resolveRollover } from "./config-remote.ts";
import { buildRolloverIntent, computeOrderDigest, intentStructHash, ORDER_DATA_TYPEHASH, type OrderDataStruct, type RolloverIntentStruct } from "./rollover.ts";
import { chainStatusName, fetchDigestLogs, labelLogs, LogsRangeLimited, resolveLogsEndpoint, SETTLER_EVENTS, settlerStatusAbi, venueChainConsistent, verificationDigest } from "./rollover-verify.ts";
import { CLONE_DEPLOYED_TOPIC, decodeCloneRows, decodeLopFillRows, decodeMarketRows, decodeRolloverFillRows, decodeWhitelistRows, loadHyperSync, LOP_FILLED_TOPIC, MARKET_CREATED_TOPIC, replayWhitelist, ROLLOVER_FILL_TOPICS, WHITELIST_TOPICS, type HyperSyncLog, type HyperSyncSource } from "./datasources/hypersync.ts";
import { decodeKnownLog, type RawLogLike } from "./event-decode.ts";
import { buildAuctionAmountData, decodeFusionOrder, FUSION_BASE_POINTS, fusionRateBump, fusionTakerPays, fusionTotalFee, isGetterWhitelisted, NotAFusionOrder, type DecodedFusionOrder } from "./fusion.ts";
import { envioToken } from "./datasources/envio.ts";
import {
  getLopFills,
  getLopMarkets,
  getLopOrderbook,
  getPools,
  getRolloverContracts,
  getRolloverOrder,
  getRolloverOrders,
  getRolloverFills,
  getRfq,
  getRfqs,
  parseSignedLopOrder,
  postLopOrder,
  postRfq,
  postRfqAnswer,
  postRolloverOrder,
  venueBaseUrl,
  VenueHttpError,
  VenueUnreachable,
  type VenueDeps,
  type VenueList,
  type VenuePostResult,
} from "./datasources/venue.ts";

export class ToolInputError extends Error {
  constructor(
    public tool: string,
    public issues: unknown,
    /** Agent-actionable guidance: per-issue expected/received, remediation, corrected example. */
    public teaching?: Teaching,
  ) {
    super(`invalid input for ${tool}`);
    this.name = "ToolInputError";
  }
}

export interface HandlerContext {
  /** Deterministic clock (seconds) for deadlines + fetchedAt; defaults to wall clock. */
  nowSeconds?: bigint;
  /** RPC URL enabling chain-backed compute (else those return `unavailable`). */
  rpcUrl?: string;
  /** Address overrides; defaults to the built-in deployment for the chainId. */
  deployment?: CorkDeployment;
  /** Pin all chain reads to this block (else latest). Makes chain-backed compute reproducible. */
  atBlock?: bigint;
  /**
   * Override the RPC resolver. Defaults to the built-in resolver (explicit rpcUrl → committed
   * default → chainlist fallback, with a circuit breaker). Tests inject a stub for offline
   * determinism; a caller may inject a custom endpoint policy.
   */
  resolveRpc?: (chainId: ChainId, explicitUrl: string | undefined) => Promise<ResolvedRpc | null>;
  /** Override the venue fetch implementation (tests inject a stub for offline determinism). */
  venueFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Override the venue base URL (default: CORK_VENUE_URL env or api-phoenix.cork.tech/v1). */
  venueUrl?: string;
  /** Override the logs-capable endpoint (default: CORK_LOGS_RPC_URL env, else HyperRPC via ENVIO_API_TOKEN). */
  logsUrl?: string;
  /** Override the logs fetch implementation (tests inject a stub). */
  logsFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Inject a HyperSync source (tests / custom clients); default = the napi client via ENVIO_API_TOKEN. */
  hyperSync?: HyperSyncSource;
}

function venueDepsOf(ctx: HandlerContext): VenueDeps {
  return { ...(ctx.venueFetch ? { fetch: ctx.venueFetch } : {}), ...(ctx.venueUrl ? { baseUrl: ctx.venueUrl } : {}) };
}

/** Map a venue read failure to an honest envelope (transport vs HTTP-rejection distinguished).
 *  5xx is a SERVER fault (likely transient — retry) and must not read as a permanent rejection. */
function venueFailed(chainId: ChainId, err: unknown, ctx: HandlerContext): Envelope {
  if (err instanceof VenueHttpError) {
    if (err.status >= 500) {
      return unavailable(chainId, "venue_unreachable", `venue server error HTTP ${err.status}: ${err.message} — likely transient; retry (or check CORK_VENUE_URL)`, ctx);
    }
    return unavailable(chainId, "venue_rejected", `venue returned HTTP ${err.status}: ${err.message}`, ctx);
  }
  if (err instanceof VenueUnreachable) {
    return unavailable(chainId, "venue_unreachable", `${err.message} — check connectivity or CORK_VENUE_URL`, ctx);
  }
  throw err;
}

/** Resolve a chain client via the ctx hook (default = built-in defaults + chainlist resolver).
 *  A wrong-chain EXPLICIT endpoint (F21) surfaces as teachable invalid input, not a raw throw. */
async function getRpc(ctx: HandlerContext, chainId: ChainId): Promise<ResolvedRpc | null> {
  try {
    return await (ctx.resolveRpc ?? resolveRpcBuiltin)(chainId, ctx.rpcUrl);
  } catch (err) {
    if (err instanceof RpcChainMismatchError) {
      throw new ToolInputError("rpc-resolution", [{ path: ["rpcUrl"], message: err.message }]);
    }
    throw err;
  }
}

/**
 * Resolve the deployment for a chain: ctx override -> remote-first defaults (GitHub-fetched,
 * TTL-cached, bundled fallback). Returns any config-sourcing warning to append to the envelope.
 */
async function getDep(ctx: HandlerContext, chainId: number): Promise<{ dep: CorkDeployment | undefined; depWarn: Array<{ code: string; message: string }> }> {
  if (ctx.deployment) return { dep: ctx.deployment, depWarn: [] };
  const r = await resolveDeploymentBuiltin(chainId);
  return { dep: r.deployment, depWarn: r.warning ? [r.warning] : [] };
}

/** Transparency warning when chain reads fell back to a community RPC (not the configured default). */
function rpcWarn(r: ResolvedRpc): Array<{ code: string; message: string }> {
  return r.source === "chainlist"
    ? [{ code: "rpc_fallback", message: `configured default RPC was unreachable; used a public chainlist endpoint (${hostOf(r.url)}) for chain reads` }]
    : [];
}

/** provenance.rpc payload for format:"full" — which endpoint tier/host served the chain read. */
function rpcProvenance(format: "concise" | "full", r: ResolvedRpc): { rpc?: { source: "explicit" | "default" | "chainlist"; host: string } } {
  return format === "full" ? { rpc: { source: r.source, host: hostOf(r.url) } } : {};
}

/**
 * Map a failed chain read (contract revert, missing pool, transport error) to an honest
 * `unavailable` envelope instead of letting the raw exception escape runTool — the envelope +
 * exit-code contract must hold even when the chain disagrees with the request.
 */
function chainReadFailed(chainId: ChainId, err: unknown, extra: Array<{ code: string; message: string }>, ctx: HandlerContext, endpoint?: ResolvedRpc): Envelope {
  // A transport-class failure means the endpoint itself went bad — feed the breaker so the resolver
  // drops it now instead of serving it until the chosen-TTL expires. (Never for contract reverts.)
  if (endpoint && endpoint.source !== "explicit" && isTransportError(err)) {
    reportEndpointFailure(chainId, endpoint.url);
  }
  const cause =
    err && typeof err === "object" && "shortMessage" in err
      ? String((err as { shortMessage: unknown }).shortMessage)
      : err instanceof Error
        ? err.message.split("\n")[0]!
        : String(err);
  return envelope({
    state: "unavailable",
    data: null,
    chainId,
    source: "chain",
    warnings: [
      { code: "chain_read_failed", message: `chain read failed: ${cause}. Common causes: the pool does not exist on this chain (e.g. a vnet-only fixture pool queried against the real chain), or the RPC/contract rejected the call.` },
      ...extra,
    ],
    ctx,
  });
}

/**
 * Map a LOCAL computation failure (math/domain/encoding throw) to its own honest envelope [C11].
 * Never routed through chainReadFailed: a local port/domain throw relabeled as "chain read
 * failed — the pool probably doesn't exist" sends the caller chasing the wrong cause.
 */
function localComputeFailed(chainId: ChainId, err: unknown, extra: Array<{ code: string; message: string }>, ctx: HandlerContext): Envelope {
  const cause = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  return envelope({
    state: "unavailable",
    data: null,
    chainId,
    source: "chain",
    warnings: [
      { code: "invalid_state", message: `local computation failed (NOT a chain/RPC fault — the on-chain state or derived values violate a domain rule this port enforces): ${cause}` },
      ...extra,
    ],
    ctx,
  });
}

/** Recursively convert bigint → decimal string so envelopes are JSON-safe. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

/** Effective "now" in unix seconds: the caller-pinned clock (ctx.nowSeconds) or the wall clock.
 *  The single source of the fallback so every time-check reads from the same clock. */
function nowSecondsOf(ctx: HandlerContext): bigint {
  return ctx.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
}

function nowIso(ctx: HandlerContext): string {
  const secs = nowSecondsOf(ctx);
  // Guard the Number() conversion: an absurd caller-supplied clock would otherwise produce an
  // Invalid Date whose toISOString() throws deep inside envelope construction.
  if (secs < 0n || secs > 253402300799n) {
    throw new Error(`ctx.nowSeconds ${secs} is outside the representable range (0..253402300799 unix SECONDS — is this a millisecond value?)`);
  }
  return new Date(Number(secs) * 1000).toISOString();
}

function envelope(args: {
  state: Envelope["state"];
  data: unknown;
  chainId: ChainId;
  source: "chain" | "indexer" | "service" | "config";
  block?: bigint;
  warnings?: Array<{ code: string; message: string }>;
  rpc?: { source: "explicit" | "default" | "chainlist"; host: string };
  /** Explicit data-mode override (e.g. HyperSync-served raw logs = full-decentralized). */
  mode?: "lite-decentralized" | "centralized" | "full-decentralized";
  ctx: HandlerContext;
}): Envelope {
  const data = jsonSafe(args.data);
  // Content digest over the canonical (bigint-normalized) data — lets a caller detect drift /
  // pin a result. Deterministic for identical data.
  const digest = keccak256(stringToHex(JSON.stringify(data ?? null)));
  return {
    state: args.state,
    data,
    warnings: args.warnings ?? [],
    provenance: {
      source: args.source,
      // Every backed result states its data mode [R1/§7]: chain reads go over RPC =
      // lite-decentralized; venue-backed reads/writes (api-phoenix) = centralized.
      // full-decentralized (HyperSync) is rejected explicitly at the handler gate.
      ...(args.mode
        ? { mode: args.mode }
        : {
            ...(args.source === "chain" ? { mode: "lite-decentralized" as const } : {}),
            ...(args.source === "indexer" || args.source === "service" ? { mode: "centralized" as const } : {}),
          }),
      chainId: args.chainId,
      fetchedAt: nowIso(args.ctx),
      digest,
      ...(args.block !== undefined ? { block: args.block.toString() } : {}),
      ...(args.rpc !== undefined ? { rpc: args.rpc } : {}),
    },
    schemaVersion: SCHEMA_VERSION,
  };
}

function unavailable(chainId: ChainId, code: string, message: string, ctx: HandlerContext): Envelope {
  return envelope({ state: "unavailable", data: null, chainId, source: "config", warnings: [{ code, message }], ctx });
}

// PhoenixAction.type -> CorkAdapter action name.
const ACTION_MAP = {
  mint: "safeMint",
  deposit: "safeDeposit",
  "unwind-deposit": "safeUnwindDeposit",
  "unwind-mint": "safeUnwindMint",
  withdraw: "safeWithdraw",
  "withdraw-other": "safeWithdrawOther",
  redeem: "safeRedeem",
  swap: "safeSwap",
  exercise: "safeExercise",
  "exercise-other": "safeExerciseOther",
  "unwind-swap": "safeUnwindSwap",
  "unwind-exercise": "safeUnwindExercise",
  "unwind-exercise-other": "safeUnwindExerciseOther",
} as const;

function buildPhoenixCall(
  action: PhoenixAction,
  adapter: `0x${string}`,
  deadline: bigint,
): Call {
  const b = (v: string) => BigInt(v);
  const p = action;
  switch (p.type) {
    case "mint":
      return corkActionCall(adapter, "safeMint", { poolId: p.poolId, cptAndCstSharesOut: b(p.cptAndCstSharesOut), receiver: p.receiver, maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), deadline });
    case "deposit":
      return corkActionCall(adapter, "safeDeposit", { poolId: p.poolId, collateralAssetsIn: b(p.collateralAssetsIn), receiver: p.receiver, minCptAndCstSharesOut: b(p.minCptAndCstSharesOut), deadline });
    case "unwind-deposit":
      return corkActionCall(adapter, "safeUnwindDeposit", { poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), owner: p.owner, receiver: p.receiver, maxCptAndCstSharesIn: b(p.maxCptAndCstSharesIn), deadline });
    case "unwind-mint":
      return corkActionCall(adapter, "safeUnwindMint", { poolId: p.poolId, cptAndCstSharesIn: b(p.cptAndCstSharesIn), owner: p.owner, receiver: p.receiver, minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline });
    case "withdraw":
      return corkActionCall(adapter, "safeWithdraw", { poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), owner: p.owner, receiver: p.receiver, maxCptSharesIn: b(p.maxCptSharesIn), deadline });
    case "withdraw-other":
      return corkActionCall(adapter, "safeWithdrawOther", { poolId: p.poolId, referenceAssetsOut: b(p.referenceAssetsOut), owner: p.owner, receiver: p.receiver, maxCptSharesIn: b(p.maxCptSharesIn), deadline });
    case "redeem":
      return corkActionCall(adapter, "safeRedeem", { poolId: p.poolId, cptSharesIn: b(p.cptSharesIn), owner: p.owner, receiver: p.receiver, minReferenceAssetsOut: b(p.minReferenceAssetsOut), minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline });
    case "swap":
      return corkActionCall(adapter, "safeSwap", { poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), receiver: p.receiver, maxCstSharesIn: b(p.maxCstSharesIn), maxReferenceAssetsIn: b(p.maxReferenceAssetsIn), deadline });
    case "exercise":
      return corkActionCall(adapter, "safeExercise", { poolId: p.poolId, cstSharesIn: b(p.cstSharesIn), receiver: p.receiver, minCollateralAssetsOut: b(p.minCollateralAssetsOut), maxReferenceAssetsIn: b(p.maxReferenceAssetsIn), deadline });
    case "exercise-other":
      return corkActionCall(adapter, "safeExerciseOther", { poolId: p.poolId, referenceAssetsIn: b(p.referenceAssetsIn), receiver: p.receiver, minCollateralAssetsOut: b(p.minCollateralAssetsOut), maxCstSharesIn: b(p.maxCstSharesIn), deadline });
    case "unwind-swap":
      return corkActionCall(adapter, "safeUnwindSwap", { poolId: p.poolId, collateralAssetsIn: b(p.collateralAssetsIn), receiver: p.receiver, minReferenceAssetsOut: b(p.minReferenceAssetsOut), minCstSharesOut: b(p.minCstSharesOut), deadline });
    case "unwind-exercise":
      return corkActionCall(adapter, "safeUnwindExercise", { poolId: p.poolId, cstSharesOut: b(p.cstSharesOut), receiver: p.receiver, minReferenceAssetsOut: b(p.minReferenceAssetsOut), maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), deadline });
    case "unwind-exercise-other":
      return corkActionCall(adapter, "safeUnwindExerciseOther", { poolId: p.poolId, referenceAssetsOut: b(p.referenceAssetsOut), receiver: p.receiver, minCstSharesOut: b(p.minCstSharesOut), maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), deadline });
    default:
      throw new Error(`unknown phoenix action type: ${(p as { type: string }).type}`);
  }
}

/** cork_prepare_phoenix authority-onboard / authority-revoke: byte-building lives in
 *  bundle/authority.ts; this wraps it in the envelope with the spender-role disclosure. */
function handlePhoenixAuthority(input: PreparePhoenixInput, depWarn: Array<{ code: string; message: string }>, dep: CorkDeployment, ctx: HandlerContext): Envelope {
  const a = input.action as AuthorityAction;
  const tx = buildAuthorityTx(a);
  return envelope({
    state: "ok",
    data: {
      kind: a.type,
      to: tx.to,
      calldata: tx.calldata,
      value: "0",
      token: a.token,
      spender: a.spender,
      amount: tx.amount,
      unlimited: tx.unlimited,
      spenderRole: spenderRoleOf(a.spender, dep.corkAdapter, PERMIT2_ADDRESS),
      note: "a direct tx from the token owner (an ERC-20 allowance is keyed to msg.sender, so this cannot ride inside a Bundler3 bundle); current allowances are readable via cork_query account-state",
      clientRequestId: input.clientRequestId,
    },
    chainId: input.chainId,
    source: "config",
    warnings: depWarn,
    ctx,
  });
}

async function handleCompute(input: ComputeInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const p = input.params;

  if (p.kind === "rollover-premium-floor") {
    const floor = mulDiv(BigInt(p.dstCstProduced), BigInt(p.minPremiumPerShare), WAD, "floor");
    return envelope({ state: "ok", data: { kind: p.kind, premiumFloor: floor }, chainId, source: "config", ctx });
  }

  // Chain-backed kinds need an RPC + addresses.
  if (p.kind === "cst-swap-rate" || p.kind === "unwind-rate" || p.kind === "impairment-floor") {
    const { dep, depWarn } = await getDep(ctx, chainId);
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", `${p.kind} needs an RPC endpoint for chainId ${chainId} (none resolved: offline, or a chain with no default/fallback — set CORK_RPC_URL)`, ctx);
    const client = resolved.client;
    const w = [...rpcWarn(resolved), ...depWarn];
    const rpc = rpcProvenance(input.format, resolved);
    const addrs: CorkAddresses = { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter };
    const pinnedBlock = input.at?.block !== undefined ? BigInt(input.at.block) : ctx.atBlock;
    if (input.at?.timestamp !== undefined) {
      // Accepted-but-reserved field (F12): validated, then ignored — say so instead of letting a
      // caller believe their replay was timestamp-pinned.
      w.push({ code: "reserved_field_ignored", message: "at.timestamp is accepted but NOT honored in this iteration — results are anchored to the block/clock; use at.block to pin chain reads" });
    }
    // [C11] Only the RPC read lives in the chain try/catch; the local math below produces its own
    // envelope on a domain violation instead of masquerading as a chain failure.
    let s: Awaited<ReturnType<typeof readPoolState>>;
    try {
      s = await readPoolState(client, addrs, p.poolId, pinnedBlock);
    } catch (err) {
      return chainReadFailed(chainId, err, w, ctx, resolved);
    }
    try {
      const swapRate = previewAdjustedRate({ market: s.market, state: s.constraintState, oracleRate: s.oracleRate, nowTs: s.blockTimestamp });
      const decimals = { collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals };

      if (p.kind === "cst-swap-rate") {
        const r = previewSwap(BigInt(p.collateralAssetsOut), { swapRate, swapFeePercentage: s.swapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals });
        // Unit disclosure (F7): this response mixes three decimal systems; label every field so
        // an integration built on an 18/18 pool doesn't break by 10^12 on a 6-dec asset.
        const scales = {
          swapRate: "1e18 = 1.0 (WAD)",
          cstSharesIn: "cST shares, always 18-decimals",
          referenceAssetsIn: `native decimals of the reference asset (${s.referenceDecimals})`,
          fee: `native decimals of the collateral asset (${s.collateralDecimals})`,
        };
        return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r, scales, ...decimals }, chainId, source: "chain", block: s.blockNumber, warnings: w, ...rpc, ctx });
      }
      if (p.kind === "unwind-rate") {
        const r = previewUnwindSwap(BigInt(p.collateralAssetsIn), { swapRate, unwindSwapFeePercentage: s.unwindSwapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals, issuedAt: s.issuedAt, expiryTimestamp: s.market.expiryTimestamp, nowTs: s.blockTimestamp });
        const scales = {
          swapRate: "1e18 = 1.0 (WAD)",
          cstSharesOut: "cST shares, always 18-decimals",
          referenceAssetsOut: `native decimals of the reference asset (${s.referenceDecimals})`,
          fee: `native decimals of the collateral asset (${s.collateralDecimals})`,
        };
        return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r, scales, ...decimals }, chainId, source: "chain", block: s.blockNumber, warnings: w, ...rpc, ctx });
      }
      const floor = impairmentFloor({ market: s.market, state: s.constraintState, horizonSeconds: BigInt(p.horizonSeconds), tEval: s.blockTimestamp });
      const scales = { worstRate: "1e18 = 1.0 (WAD)", maxReferencePerCst: "reference WAD per 1e18 cST (null = unbounded: impairment can be total)", availableAtEval: "WAD descent budget" };
      if (floor.maxReferencePerCst === null) {
        w.push({ code: "invalid_state", message: "the worst-case rate collapses to ZERO over this horizon (rateMin is 0) — impairment can be total and the reference cost per cST is unbounded" });
      }
      return envelope({ state: "ok", data: { kind: p.kind, ...floor, scales }, chainId, source: "chain", block: s.blockNumber, warnings: w, ...rpc, ctx });
    } catch (err) {
      return localComputeFailed(chainId, err, w, ctx);
    }
  }

  if (p.kind === "resolve-recipe") {
    // 2.1.0: ask the recipe CONTRACT what four rate limits it would impose (a staticcall to
    // recipe.resolve) — THE step that produces the constraint you sign into a JIT order. The
    // registry's percentage-band math is gone from the public surface; p.legacy reaches the
    // deprecated pre-2.1.0 bands behind the gate.
    if (p.legacy) return handleComputeResolveRecipeLegacy(input, p, ctx, chainId);
    if (!p.collateralAsset || !p.referenceAsset) {
      return unavailable(chainId, "missing_filter", "resolve-recipe needs collateralAsset + referenceAsset (the pair the constraint is for), plus recipe (the approved recipe CONTRACT ADDRESS; mode survives as deprecated sugar). Optional: args (recipe additionalData hex), rate (FIXED recipes), rateOracle (explicit oracle)", ctx);
    }
    const r = await getRegistry(ctx, chainId);
    if (r.gate) return r.gate;
    const { mr, resolved, warnings } = r;
    const client = resolved.client;
    const rpc = rpcProvenance(input.format, resolved);
    try {
      const res = await resolveRecipeOracleConstraint({
        client,
        ctx,
        chainId,
        mr,
        recipe: p.recipe,
        mode: p.mode,
        collateralAsset: p.collateralAsset,
        referenceAsset: p.referenceAsset,
        fixedRate: p.rate !== undefined ? BigInt(p.rate) : undefined,
        rateOracle: p.rateOracle,
        additionalData: p.args,
        wantConstraint: true,
      });
      warnings.push(...res.warnings);
      if (res.gate) return res.gate;
      const { recipe, source, oracle, constraint } = res;
      return envelope({
        state: "ok",
        data: {
          kind: p.kind,
          recipe,
          source,
          scales: { constraint: "ABSOLUTE rates, 1e18 = 1.0 — these four raw values are what a JIT order carries, in this order" },
          constraint,
          rateOracle: { address: oracle.address, status: oracle.deployed ? "live" : oracle.address ? "predicted" : "none", ...(oracle.mode ? { mode: oracle.mode } : {}), rate: oracle.rate, ...(oracle.reason ? { reason: oracle.reason } : {}) },
          note: oracle.deployed ? "resolved against the LIVE oracle rate" : "no live oracle — the recipe resolved from its fallback (e.g. the anchorRate in args); the eventual fill deploys the oracle and re-checks with recipe.verify against the LIVE rate",
        },
        chainId,
        source: "chain",
        warnings,
        ...rpc,
        ctx,
      });
    } catch (err) {
      return chainReadFailed(chainId, err, warnings, ctx, resolved);
    }
  }

  if (p.kind === "dutch-auction-price") {
    return handleComputeDutchAuction(input, p, ctx);
  }
  // The one deliberately-gated kind left, naming its REAL blocker and unblock condition.
  return unavailable(chainId, "phase_gated", "rfq-quote would RECOMMEND a price — a pricing-model/product decision that is deliberately deferred, not missing infrastructure. The registry band math it would build on is already live as cork_compute resolve-recipe; discover open RFQs with cork_query rfqs and answer them with cork_submit rfq-answer. A Fusion-style decaying-premium order (compute dutch-auction-price is live) is one modeled-quote-free alternative — see notes/fusion-integration-plan.md", ctx);
}

/**
 * dutch-auction-price: the CURRENT price of a 1inch Fusion (v3.1) dutch-auction order — pure
 * local math over the order's own extension bytes [K3]. Price = f(extension, taker, basefee,
 * timestamp); the port is proven wei-exact against the DEPLOYED settlement getters on mainnet +
 * Arbitrum (experiments/fusion-spike/probe.ts). at.timestamp pins the moment (the one compute
 * input that is clock-anchored, not block-anchored); baseFeeWei omitted = gas bump skipped =
 * upper-bound price.
 */
function handleComputeDutchAuction(input: ComputeInput, p: Extract<ComputeParams, { kind: "dutch-auction-price" }>, ctx: HandlerContext): Envelope {
  const chainId = input.chainId ?? 1;
  const order = parseOrderRecord(p.order, "cork_compute", ["params", "order"]);
  const extRaw = p.order.extension;
  const extParsed = extRaw === undefined ? undefined : Hex.safeParse(extRaw);
  if (extParsed === undefined || !extParsed.success) {
    throw new ToolInputError("cork_compute", [
      { path: ["params", "order", "extension"], message: "dutch-auction-price needs the order's extension bytes (0x-hex) — the auction curve lives in extension.makingAmountData, so an order without its extension cannot be priced; fetch the order WITH its extension" },
    ]);
  }
  const extension = extParsed.data as `0x${string}`;

  let decoded: DecodedFusionOrder;
  try {
    decoded = decodeFusionOrder(order, extension, chainId);
  } catch (err) {
    if (err instanceof NotAFusionOrder) {
      // Well-formed bytes that are structurally not a (supported) Fusion order → domain envelope.
      return unavailable(chainId, err.message.includes("LEGACY") ? "phase_gated" : "invalid_order_terms", err.message, ctx);
    }
    // Malformed extension/auction bytes → teachable invalid input (same split as decode calldata).
    throw new ToolInputError("cork_compute", [{ path: ["params", "order", "extension"], message: err instanceof Error ? err.message : "extension bytes do not decode" }]);
  }

  const warnings: Array<{ code: string; message: string }> = [];
  if (!decoded.saltBoundToExtension) {
    return envelope({
      state: "conflict",
      data: { kind: p.kind, settlement: decoded.settlement, classification: decoded.classification, order },
      chainId,
      source: "config",
      warnings: [{ code: "extension_salt_mismatch", message: "salt's low 160 bits are NOT keccak256(extension)'s low 160 bits — this order/extension pair would revert InvalidExtension at fill; the price of an unfillable pair is not quoted" }],
      ctx,
    });
  }
  if (decoded.classification === "unknown") {
    warnings.push({ code: "settler_not_recognized", message: `settlement ${decoded.settlement} (decoded from the extension) is not in the known Fusion set for chainId ${chainId} — priced as the v3.1 layout since the bytes parse as one; verify the contract independently before acting on this quote` });
  }

  const pinned = input.at?.timestamp !== undefined;
  const ts = pinned ? BigInt(input.at!.timestamp!) : nowSecondsOf(ctx);
  const baseFee = p.baseFeeWei !== undefined ? BigInt(p.baseFeeWei) : null;
  const bump = fusionRateBump(decoded.auction, ts, baseFee);
  const finish = decoded.auction.startTime + decoded.auction.duration;
  const phase = ts <= decoded.auction.startTime ? "pre-start" : ts >= finish ? "floor" : "decaying";

  const m = p.makingAmount !== undefined ? BigInt(p.makingAmount) : order.makingAmount;
  const M = order.makingAmount;
  const T = order.takingAmount;
  const feeWhitelisted = fusionTotalFee(decoded.fees, true);
  const feeOther = fusionTotalFee(decoded.fees, false);
  const takerWhitelisted = p.taker !== undefined ? isGetterWhitelisted(decoded.fees, p.taker) : undefined;
  const price =
    p.taker !== undefined
      ? { makingAmount: m, taker: p.taker, takerIsGetterWhitelisted: takerWhitelisted, takerPays: fusionTakerPays(M, T, m, takerWhitelisted ? feeWhitelisted : feeOther, bump.effective) }
      : { makingAmount: m, takerPays: { whitelistedTaker: fusionTakerPays(M, T, m, feeWhitelisted, bump.effective), nonWhitelistedTaker: fusionTakerPays(M, T, m, feeOther, bump.effective) } };

  const traits = decodeMakerTraits(order.makerTraits);
  const lop = LOP_ADDRESSES[chainId];
  if (!lop) warnings.push({ code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${chainId} — the EIP-712 orderHash needs the verifying contract, so it is omitted` });
  const pi = decoded.postInteraction;
  return envelope({
    state: "ok",
    data: {
      kind: p.kind,
      chainId,
      settlement: { address: decoded.settlement, classification: decoded.classification },
      orderHash: lop ? hashLopOrder(chainId, lop, order) : null,
      at: { timestamp: ts, source: pinned ? "at.timestamp (pinned)" : "ctx clock", baseFeeWei: baseFee },
      auction: { ...decoded.auction, finishTime: finish },
      phase,
      rateBump: {
        auctionBump: bump.auctionBump,
        gasBump: baseFee === null ? null : bump.gasBump,
        effective: bump.effective,
        ...(baseFee === null && decoded.auction.gasBumpEstimate > 0n ? { gasBumpSkipped: "baseFeeWei not supplied — the gas-adjustment term is skipped, so this is the UPPER-BOUND price" } : {}),
      },
      price,
      fees: { integratorFee: decoded.fees.integratorFee, resolverFee: decoded.fees.resolverFee, whitelistDiscountNumerator: decoded.fees.whitelistDiscountNumerator, getterWhitelistSize: decoded.fees.whitelist.length },
      fillability: {
        makerTraitsExpiry: traits.expiry,
        ...(pi
          ? {
              gated: true,
              resolvingStartTime: pi.resolvingStartTime,
              publicFillTime: pi.publicFillTime,
              whitelistSize: pi.whitelist.length,
              accessTokenFallback: "a non-whitelisted taker may fill only after publicFillTime AND while holding the Fusion access token",
              ...(chainId === 1 && decoded.classification === "current" ? { priorityFeeCap: "mainnet Settlement additionally caps the fill tx's priority fee (DAO rule) — a fill above the cap reverts regardless of price" } : {}),
              surplus: { estimatedTakingAmount: pi.estimatedTakingAmount, protocolSurplusFeePercent: pi.surplusFeePercent, note: "surplus fee affects MAKER proceeds, not the taker-side price quoted here" },
            }
          : { gated: false, note: "no post-interaction bound to the settlement — fills are permissionless at the decayed price (Cork-native auction-order shape)" }),
      },
      scales: {
        rateBump: "1e7 = 100% (bump base)",
        fees: "1e5 base (integratorFee/resolverFee)",
        whitelistDiscountNumerator: "1e2 base",
        takerPays: "taker-asset native base units (includes fees; the fee slice is split out in postInteraction)",
        makingAmount: "maker-asset native base units",
      },
      note: "the quote decays with time: re-evaluate (or pin at.timestamp) near fill, and remaining fill capacity is chain state (LOP invalidators via cork_track reconcile), not part of this pure computation",
    },
    chainId,
    source: "config",
    warnings,
    ctx,
  });
}

// ── cork_decode order/event/receipt: pure LOCAL reconstruction [K3] ──────────────────────────

/** Parse a caller-supplied order RECORD (e.g. a typedData.message round-trip) into a LopOrder.
 *  Field-by-field validation with teachable paths; extra keys are ignored (we reconstruct from
 *  the eight struct fields, never from any decoded claims riding along). Shared by cork_decode
 *  (path root "data") and cork_compute dutch-auction-price (path root "params.order"). */
function parseOrderRecord(rec: Record<string, unknown>, tool: "cork_decode" | "cork_compute" = "cork_decode", pathRoot: string[] = ["data"]): LopOrder {
  const fail = (key: string, message: string): never => {
    throw new ToolInputError(tool, [{ path: [...pathRoot, key], message }]);
  };
  const uint = (key: "salt" | "makingAmount" | "takingAmount" | "makerTraits"): bigint => {
    const r = UintStr.safeParse(rec[key] === undefined ? undefined : String(rec[key]));
    if (!r.success) fail(key, "expected an unsigned integer as a decimal string");
    return BigInt(r.data!);
  };
  const addr = (key: "maker" | "receiver" | "makerAsset" | "takerAsset"): `0x${string}` => {
    const r = Address.safeParse(rec[key]);
    if (!r.success) fail(key, "not a valid EVM address");
    return r.data!;
  };
  return {
    salt: uint("salt"),
    maker: addr("maker"),
    receiver: addr("receiver"),
    makerAsset: addr("makerAsset"),
    takerAsset: addr("takerAsset"),
    makingAmount: uint("makingAmount"),
    takingAmount: uint("takingAmount"),
    makerTraits: uint("makerTraits"),
  };
}

const DECODE_U160 = (1n << 160n) - 1n;

/** decode kind:"order" — label a 1inch LOP v4 order (hex tuple or JSON fields): full makerTraits
 *  breakdown + locally recomputed orderHash; any caller-claimed hash is cross-checked, never
 *  trusted [K3]. */
function handleDecodeOrder(input: DecodeInput, chainId: ChainId, ctx: HandlerContext): Envelope {
  let order: LopOrder;
  let claimedOrderHash: `0x${string}` | undefined;
  let extension: `0x${string}` | undefined;
  if (typeof input.data === "string") {
    try {
      order = decodeOrderTuple(input.data as `0x${string}`);
    } catch (err) {
      throw new ToolInputError("cork_decode", [{ path: ["data"], message: err instanceof Error ? err.message : "not a decodable LOP v4 order tuple" }]);
    }
  } else {
    order = parseOrderRecord(input.data);
    if (input.data.orderHash !== undefined) {
      const r = Bytes32.safeParse(input.data.orderHash);
      if (!r.success) throw new ToolInputError("cork_decode", [{ path: ["data", "orderHash"], message: "not a 32-byte hex hash" }]);
      claimedOrderHash = r.data;
    }
    if (input.data.extension !== undefined) {
      const r = Hex.safeParse(input.data.extension);
      if (!r.success) throw new ToolInputError("cork_decode", [{ path: ["data", "extension"], message: "not 0x-prefixed hex" }]);
      extension = r.data as `0x${string}`;
    }
  }
  const traits = decodeMakerTraits(order.makerTraits);
  const lop = LOP_ADDRESSES[chainId];
  const orderHash = lop ? hashLopOrder(chainId, lop, order) : null;
  const warnings: Array<{ code: string; message: string }> = [];
  if (!lop) {
    warnings.push({ code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${chainId} — the order decodes but its EIP-712 orderHash needs the verifying contract; pass a chainId with a known LOP (1, 42161) for the hash` });
  }
  // Fusion labeling (best-effort): when the extension carries an auction amount-getter, summarize
  // it — decode only, never a guess; a non-Fusion or unparseable extension just skips the label.
  let fusion: Record<string, unknown> | undefined;
  if (extension !== undefined && extension !== "0x") {
    try {
      const f = decodeFusionOrder(order, extension, chainId);
      fusion = {
        settlement: f.settlement,
        classification: f.classification,
        auction: { startTime: f.auction.startTime, duration: f.auction.duration, initialRateBump: f.auction.initialRateBump, points: f.auction.points.length },
        postInteractionGated: f.postInteraction !== null,
        note: "auction-priced order — current price via cork_compute dutch-auction-price",
      };
    } catch (err) {
      if (err instanceof NotAFusionOrder && /LEGACY/.test(err.message)) {
        fusion = { classification: "legacy", note: err.message };
      }
      /* not an auction order (or malformed auction bytes) — no label; the raw fields still decode */
    }
  }
  // JIT labeling (best-effort, same decode-only rule): when the extension's preInteraction field
  // carries a Cork JIT payload, unpack it so a taker can see what filling this order DOES —
  // which adapter it calls, which recipe/constraint (2.1.0) or mode (legacy) it commits to, and
  // whether permits ride along. Tried 2.1.0-first; the legacy shape is labeled as such. A
  // non-JIT extension just skips the label [K3: reconstructed from the bytes, never guessed].
  let jit: Record<string, unknown> | undefined;
  if (extension !== undefined && extension !== "0x" && fusion === undefined) {
    try {
      const d = decodeJitExtension(extension);
      jit = {
        generation: "2.1.0",
        adapter: d.adapter,
        collateralAsset: d.params.collateralAsset,
        referenceAsset: d.params.referenceAsset,
        expiryTimestamp: d.params.expiryTimestamp,
        recipe: d.params.recipe,
        rateOverride: d.params.rateOverride,
        constraint: { ...d.params.constraint, scale: "ABSOLUTE rates, 1e18 = 1.0" },
        additionalData: d.params.additionalData,
        swapFeePercentage: d.params.swapFeePercentage,
        unwindSwapFeePercentage: d.params.unwindSwapFeePercentage,
        enableJitMint: d.params.enableJitMint,
        permits: d.permits.length,
        note: "a fill calls the JIT adapter's preInteraction: it deploys the oracle if needed, re-checks the carried constraint with recipe.verify, creates the pool if missing, and mints per enableJitMint — one order side must be the derived pool's cST",
      };
    } catch {
      try {
        const d = legacyRegistry.decodeJitExtension(extension);
        jit = {
          generation: "legacy (pre-2.1.0)",
          adapter: d.adapter,
          collateralAsset: d.params.collateralAsset,
          referenceAsset: d.params.referenceAsset,
          expiryTimestamp: d.params.expiryTimestamp,
          mode: d.params.mode,
          swapFeePercentage: d.params.swapFeePercentage,
          unwindSwapFeePercentage: d.params.unwindSwapFeePercentage,
          enableJitMint: d.params.enableJitMint,
          permits: d.permits.length,
          note: "LEGACY mode-string JIT payload (constraint derived at FILL time from the live rate; pool id drifts with the rate) — targets the pre-2.1.0 adapter generation",
        };
      } catch {
        /* not a JIT extension either — no label; the raw fields still decode */
      }
    }
  }
  const base = {
    kind: "order" as const,
    chainId,
    lop: lop ?? null,
    order,
    makerTraits: { raw: order.makerTraits, ...traits },
    orderHash,
    ...(extension !== undefined ? { extension } : {}),
    ...(fusion ? { fusion } : {}),
    ...(jit ? { jit } : {}),
  };
  // Extension binding: OrderLib enforces salt.low160 == keccak256(extension).low160 at fill.
  if (extension !== undefined && extension !== "0x") {
    const bound = (order.salt & DECODE_U160) === (BigInt(keccak256(extension)) & DECODE_U160);
    if (!bound) {
      return envelope({
        state: "conflict",
        data: { ...base, saltBoundToExtension: false },
        chainId,
        source: "config",
        warnings: [...warnings, { code: "extension_salt_mismatch", message: "salt's low 160 bits are NOT keccak256(extension)'s low 160 bits — this order would revert InvalidExtension at fill" }],
        ctx,
      });
    }
    (base as Record<string, unknown>).saltBoundToExtension = true;
  }
  // Cross-check a caller-claimed hash against the local reconstruction [K3].
  if (claimedOrderHash !== undefined && orderHash !== null && claimedOrderHash.toLowerCase() !== orderHash.toLowerCase()) {
    return envelope({
      state: "conflict",
      data: { ...base, claimedOrderHash },
      chainId,
      source: "config",
      warnings: [...warnings, { code: "digest_mismatch", message: `the supplied orderHash ${claimedOrderHash} does not match the locally recomputed EIP-712 hash ${orderHash} — do not act on the claimed hash` }],
      ctx,
    });
  }
  return envelope({
    state: "ok",
    data: { ...base, ...(claimedOrderHash !== undefined ? { claimedOrderHash, claimedHashVerified: orderHash !== null } : {}) },
    chainId,
    source: "config",
    warnings,
    ctx,
  });
}

/** Normalize a caller-supplied log-shaped record for decodeKnownLog, with teachable failures. */
function asRawLog(rec: Record<string, unknown>, pathPrefix: string[]): RawLogLike {
  const topics = rec.topics;
  if (!Array.isArray(topics)) {
    throw new ToolInputError("cork_decode", [{ path: ["data", ...pathPrefix, "topics"], message: "expected topics: an array of 0x-prefixed 32-byte hex strings (topics[0] is the event selector)" }]);
  }
  return {
    ...(typeof rec.address === "string" ? { address: rec.address } : {}),
    topics: topics.map((t) => (typeof t === "string" ? t : null)),
    ...(typeof rec.data === "string" ? { data: rec.data } : {}),
  };
}

/** decode kind:"event" — one raw log {address?, topics[], data} → named args against the known
 *  Cork/rollover/LOP/ERC-20 ABI set; unknown or unverified layouts come back labeled raw. */
function handleDecodeEvent(input: DecodeInput, chainId: ChainId, ctx: HandlerContext): Envelope {
  if (typeof input.data === "string") {
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: "event decode takes a log OBJECT {address?, topics: string[], data: hex} — raw topics+data are what gets decoded [K3]; for transaction bytes use kind 'calldata'" }]);
  }
  const row = decodeKnownLog(asRawLog(input.data, []));
  return envelope({ state: "ok", data: { kind: "event", ...row }, chainId, source: "config", ctx });
}

/** decode kind:"receipt" — label every log in a tx receipt against the known ABI set. The
 *  receipt's own claims (status etc.) are echoed as claims; the decode work is the logs. */
function handleDecodeReceipt(input: DecodeInput, chainId: ChainId, ctx: HandlerContext): Envelope {
  if (typeof input.data === "string") {
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: "receipt decode takes the receipt OBJECT (eth_getTransactionReceipt result) — at minimum { logs: [{address?, topics[], data}] }" }]);
  }
  const logsRaw = input.data.logs;
  if (!Array.isArray(logsRaw)) {
    throw new ToolInputError("cork_decode", [{ path: ["data", "logs"], message: "expected logs: an array of log objects ({address?, topics[], data}) — the logs are what a receipt decode reconstructs from [K3]" }]);
  }
  const rows = logsRaw.map((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) {
      throw new ToolInputError("cork_decode", [{ path: ["data", "logs", String(i)], message: "expected a log object {address?, topics[], data}" }]);
    }
    return decodeKnownLog(asRawLog(l as Record<string, unknown>, ["logs", String(i)]));
  });
  // Status normalization: echo the receipt's own claim in one canonical vocabulary.
  const s = input.data.status;
  const status = s === "success" || s === "0x1" || s === 1 || s === true ? "success" : s === "reverted" || s === "0x0" || s === 0 || s === false ? "reverted" : undefined;
  const known = rows.filter((r) => r.known).length;
  return envelope({
    state: "ok",
    data: {
      kind: "receipt",
      ...(status !== undefined ? { status, statusNote: "status/blockNumber/gasUsed are the receipt's own claims (echoed, not verifiable locally); the decoded logs below are reconstructed from their raw topics/data [K3]" } : {}),
      ...(typeof input.data.transactionHash === "string" ? { transactionHash: input.data.transactionHash } : {}),
      logCount: rows.length,
      knownCount: known,
      logs: rows,
    },
    chainId,
    source: "config",
    ctx,
  });
}

/** Parse the free-form filters record into typed poolId/account, rejecting malformed values (exit 2). */
interface QueryFilters {
  poolId?: `0x${string}`;
  account?: `0x${string}`;
  kind?: "orders" | "fills" | "contracts";
  side?: "BUY" | "SELL";
  status?: string;
  orderDigest?: `0x${string}`;
  orderHash?: `0x${string}`;
  filler?: `0x${string}`;
  address?: `0x${string}`;
  fillable?: boolean;
  source?: "API" | "CHAIN";
  collateralAsset?: `0x${string}`;
  referenceAsset?: `0x${string}`;
  mode?: string;
  expiry?: bigint;
  rfqId?: string;
  state?: "open" | "expired";
  withAnswers?: boolean;
  recipe?: `0x${string}`;
  args?: `0x${string}`;
  rate?: bigint;
  rateOracle?: `0x${string}`;
  label?: string;
  base?: `0x${string}`;
  quote?: `0x${string}`;
  legacy?: boolean;
}

/** Every filter key parseQueryFilters understands — unknown keys are a teachable error, as advertised.
 *  Exported for the completeness gate: each key must also appear in the schema's filters describe. */
export const KNOWN_FILTER_KEYS = [
  "poolId",
  "account",
  "kind",
  "side",
  "status",
  "orderDigest",
  "orderHash",
  "filler",
  "address",
  "fillable",
  "source",
  "collateralAsset",
  "referenceAsset",
  "mode",
  "expiry",
  "rfqId",
  "state",
  "withAnswers",
  "recipe",
  "args",
  "rate",
  "rateOracle",
  "label",
  "base",
  "quote",
  "legacy",
] as const;

function parseQueryFilters(raw: Record<string, unknown> | undefined): QueryFilters {
  const out: QueryFilters = {};
  const fail = (key: string, message: string): never => {
    throw new ToolInputError("cork_query", [{ path: ["filters", key], message }]);
  };
  for (const key of Object.keys(raw ?? {})) {
    if (!(KNOWN_FILTER_KEYS as readonly string[]).includes(key)) {
      const near = nearestValue(key, KNOWN_FILTER_KEYS);
      fail(key, `unknown filter key${near ? ` — did you mean '${near}'?` : ""} (known: ${KNOWN_FILTER_KEYS.join(", ")})`);
    }
  }
  if (raw?.poolId !== undefined) {
    const r = MarketId.safeParse(raw.poolId);
    if (!r.success) fail("poolId", "not a valid 32-byte pool id");
    else out.poolId = r.data;
  }
  for (const key of ["account", "filler", "address"] as const) {
    if (raw?.[key] !== undefined) {
      const r = Address.safeParse(raw[key]);
      if (!r.success) fail(key, "not a valid EVM address");
      else out[key] = r.data;
    }
  }
  for (const key of ["orderDigest", "orderHash"] as const) {
    if (raw?.[key] !== undefined) {
      const v = String(raw[key]);
      if (!/^0x[0-9a-fA-F]{64}$/.test(v)) fail(key, "not a 32-byte hex hash");
      else out[key] = v.toLowerCase() as `0x${string}`;
    }
  }
  if (raw?.kind !== undefined) {
    const v = String(raw.kind);
    if (v !== "orders" && v !== "fills" && v !== "contracts") fail("kind", "expected 'orders' | 'fills' | 'contracts'");
    else out.kind = v;
  }
  if (raw?.side !== undefined) {
    const v = String(raw.side);
    if (v !== "BUY" && v !== "SELL") fail("side", "expected 'BUY' | 'SELL'");
    else out.side = v;
  }
  if (raw?.source !== undefined) {
    const v = String(raw.source);
    if (v !== "API" && v !== "CHAIN") fail("source", "expected 'API' | 'CHAIN'");
    else out.source = v;
  }
  if (raw?.status !== undefined) out.status = String(raw.status);
  if (raw?.fillable !== undefined) {
    if (typeof raw.fillable === "boolean") out.fillable = raw.fillable;
    else if (raw.fillable === "true" || raw.fillable === "false") out.fillable = raw.fillable === "true";
    else fail("fillable", "expected a boolean");
  }
  // registry-oracle pair (ORDER MATTERS: collateral first) + registry-recipes single-mode lookup.
  for (const key of ["collateralAsset", "referenceAsset"] as const) {
    if (raw?.[key] !== undefined) {
      const r = Address.safeParse(raw[key]);
      if (!r.success) fail(key, "not a valid EVM address");
      else out[key] = r.data;
    }
  }
  if (raw?.mode !== undefined) out.mode = String(raw.mode);
  // market-predict: expiry as a unix-seconds decimal string (part of the derived market
  // identity) — routed through the shared UnixSeconds primitive so the ms-detector and
  // plausibility bound ride this field too (T6a), instead of a bare digit regex that accepted
  // year-58-billion values.
  if (raw?.expiry !== undefined) {
    const r = UnixSeconds.safeParse(String(raw.expiry));
    if (!r.success) fail("expiry", r.error.issues[0]?.message ?? "expected a unix timestamp in SECONDS (decimal string)");
    else out.expiry = BigInt(r.data);
  }
  // RFQ feed (venue ids are opaque but always rfq_-prefixed — same guard the venue itself applies).
  if (raw?.rfqId !== undefined) {
    const v = String(raw.rfqId);
    if (!/^rfq_[0-9a-z]+$/.test(v)) fail("rfqId", "expected a venue RFQ id (rfq_ prefix, lowercase alphanumeric)");
    else out.rfqId = v;
  }
  if (raw?.state !== undefined) {
    const v = String(raw.state);
    if (v !== "open" && v !== "expired") fail("state", "expected 'open' | 'expired'");
    else out.state = v;
  }
  if (raw?.withAnswers !== undefined) {
    if (typeof raw.withAnswers === "boolean") out.withAnswers = raw.withAnswers;
    else if (raw.withAnswers === "true" || raw.withAnswers === "false") out.withAnswers = raw.withAnswers === "true";
    else fail("withAnswers", "expected a boolean");
  }
  // 2.1.0 registry filters: a recipe is an approved CONTRACT ADDRESS; `args` is the recipe's raw
  // additionalData hex; `rate` keys a fixed-rate oracle (18-decimal integer string); `rateOracle`
  // overrides oracle resolution on resolve/predict; label/base/quote are the denominations/feeds
  // point lookups; `legacy` selects the DEPRECATED pre-2.1.0 generation (gated).
  for (const key of ["recipe", "rateOracle", "base", "quote"] as const) {
    if (raw?.[key] !== undefined) {
      const r = Address.safeParse(raw[key]);
      if (!r.success) fail(key, "not a valid EVM address");
      else out[key] = r.data;
    }
  }
  if (raw?.args !== undefined) {
    const v = String(raw.args);
    if (!/^0x[0-9a-fA-F]*$/.test(v)) fail("args", "expected 0x-prefixed hex bytes (the recipe's additionalData, passed verbatim)");
    else out.args = v as `0x${string}`;
  }
  if (raw?.rate !== undefined) {
    const v = String(raw.rate);
    if (!/^[0-9]+$/.test(v)) fail("rate", "expected an 18-decimal rate as a decimal integer string (1e18 = 1.0)");
    else out.rate = BigInt(v);
  }
  if (raw?.label !== undefined) out.label = String(raw.label);
  if (raw?.legacy !== undefined) {
    if (typeof raw.legacy === "boolean") out.legacy = raw.legacy;
    else if (raw.legacy === "true" || raw.legacy === "false") out.legacy = raw.legacy === "true";
    else fail("legacy", "expected a boolean");
  }
  return out;
}

/** Venue-backed resources (centralized mode) vs live-chain resources (lite-decentralized). */
const VENUE_RESOURCES = new Set(["markets", "orderbook", "fills", "limit-order-markets", "flows", "rfqs"]);

/** One event-derived resource's scan, shared by the HyperSync backfill AND the live-tail RPC merge
 *  so the two legs can never scan different addresses/topics or decode differently. `key` yields a
 *  stable per-row identity for de-duplicating the (block-disjoint) tail against the backfill. */
interface HsScanSpec {
  fromBlock: number;
  address: string[];
  topics: Array<string[] | null>;
  decode: (logs: HyperSyncLog[]) => Array<Record<string, unknown>>;
  postFilter: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  key: (row: Record<string, unknown>) => string;
}

/** The two JSON-RPC calls the live-tail needs; the resolved viem client answers both (cast at this
 *  boundary — raw eth_getLogs with array topics is awkward to express in viem's typed surface). */
interface LiveTailClient {
  getBlockNumber(): Promise<bigint>;
  request(args: { method: "eth_getLogs"; params: [{ fromBlock: string; toBlock: string; address: string[]; topics: Array<string[] | null> }] }): Promise<Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }>>;
}

type LiveTailResult =
  | { status: "no-rpc" } // nothing configured / a wrong-chain explicit endpoint — skip silently
  | { status: "current" } // the archive head is already at/above chain head — nothing to add
  | { status: "merged"; rows: Array<Record<string, unknown>>; headBlock: number }
  | { status: "error"; message: string }; // the RPC refused the range (disclosed, non-fatal)

/**
 * Freshness leg for full-decentralized reads: HyperSync is an ARCHIVE index whose head can trail
 * chain head, so a time-sensitive read would miss the most recent events. This scans the tail
 * (archiveHeight+1 → chain head) over the REGULAR resolved Web3 RPC (CORK_RPC_URL / --rpc-url →
 * built-in default → chainlist fallback) with the SAME address+topics+decoder, so recent blocks are
 * covered. Best-effort by design: a missing RPC or a range-capped endpoint degrades to an honest
 * warning, never a failed read — the HyperSync answer still stands. Callers gate this on a COMPLETE
 * backfill (a page-capped partial already left an interior gap, so a disjoint tail would mislead).
 */
async function fetchLiveTail(ctx: HandlerContext, chainId: ChainId, spec: HsScanSpec, archiveHeight: number): Promise<LiveTailResult> {
  let rpc: ResolvedRpc | null;
  try {
    rpc = await getRpc(ctx, chainId);
  } catch {
    return { status: "no-rpc" };
  }
  if (!rpc) return { status: "no-rpc" };
  const client = rpc.client as unknown as LiveTailClient;
  try {
    const head = Number(await client.getBlockNumber());
    if (!Number.isFinite(head) || head <= archiveHeight) return { status: "current" };
    const toHex = (n: number) => `0x${n.toString(16)}`;
    // Bounded to (archiveHeight, head]: disjoint from the backfill by block number, so a small,
    // recent-only range that ordinary public RPCs serve even when they refuse deep history.
    const logs = await client.request({
      method: "eth_getLogs",
      params: [{ fromBlock: toHex(archiveHeight + 1), toBlock: toHex(head), address: spec.address, topics: spec.topics }],
    });
    const rows = spec.postFilter(spec.decode(logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash }))));
    return { status: "merged", rows, headBlock: head };
  } catch (err) {
    return { status: "error", message: `live-tail eth_getLogs via ${hostOf(rpc.url)} failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}

/**
 * full-decentralized [C12]: the event-derived subset over HyperSync, with a live-tail RPC merge for
 * freshness (see fetchLiveTail). Structural honesty: resting orders / RFQs emit no events — those
 * resources are venue-only in EVERY mode.
 */
async function handleQueryHyperSync(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  const kind = filters.kind ?? "orders";
  const structural =
    input.resource === "orderbook" || input.resource === "limit-order-markets"
      ? `'${input.resource}' cannot be served in full-decentralized mode: resting orders live only at the venue (signed-but-unfilled orders emit no events, by design)`
      : input.resource === "rfqs"
        ? "'rfqs' cannot be served in full-decentralized mode: RFQ requests and answers are off-chain venue JSON that never binds and emits no events, by design — omit mode or use 'centralized'"
        : input.resource === "flows" && kind === "orders"
        ? "flows kind='orders' cannot be served in full-decentralized mode: pre-commitment rollover orders emit no events; use kind='fills' or kind='contracts', or centralized mode for the order feed"
        : null;
  if (structural) return unavailable(chainId, "mode_unavailable", structural, ctx);

  // HyperSync and HyperRPC are different Envio products with DIFFERENT tokens; the dedicated
  // var wins, ENVIO_API_TOKEN remains a shared fallback.
  const load = ctx.hyperSync ? { source: ctx.hyperSync } : await loadHyperSync(chainId, envioToken("hypersync"));
  if ("error" in load) return unavailable(chainId, "hypersync_unavailable", load.error, ctx);
  const hs = load.source;

  try {
    const hsWarnings: Array<{ code: string; message: string }> = [];
    // Build the per-resource scan ONCE (address/topics/decoder/filter); both the HyperSync backfill
    // and the live-tail RPC merge below run it, so they can never diverge.
    let spec: HsScanSpec;
    if (input.resource === "markets") {
      // Scan every configured Phoenix PM on this chain (primary deployment + named profiles).
      const cfg = await resolveConfig();
      const pms = new Set<string>();
      const primary = cfg.defaults.deployments[String(chainId)];
      if (primary) pms.add(primary.poolManager);
      for (const profile of Object.values(cfg.defaults.deploymentProfiles?.[String(chainId)] ?? {})) pms.add(profile.poolManager);
      if (pms.size === 0) return unavailable(chainId, "unknown_deployment", `no Cork deployment configured for chainId ${chainId}`, ctx);
      spec = {
        fromBlock: 0,
        address: [...pms],
        topics: [[MARKET_CREATED_TOPIC]],
        decode: decodeMarketRows,
        postFilter: (rows) => (filters.poolId ? rows.filter((m) => String(m.poolId).toLowerCase() === filters.poolId!.toLowerCase()) : rows),
        key: (m) => `market:${String(m.poolId).toLowerCase()}`,
      };
    } else if (input.resource === "fills") {
      const lop = LOP_ADDRESSES[chainId];
      if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
      if (!filters.orderHash) {
        // OrderFilled's orderHash is NOT an indexed topic, so this scan sees the ENTIRE 1inch
        // LOP — a very high-volume address. Without an orderHash filter the rows are all of
        // 1inch's fills, not Cork's; disclose instead of presenting them as Cork activity (F15).
        hsWarnings.push({ code: "pagination_incomplete", message: "fills in full-decentralized mode scan the whole 1inch LOP (orderHash is not an indexed topic) — rows are NOT Cork-scoped; pass filters.orderHash to isolate one order, or use centralized mode for the Cork-only feed" });
      }
      spec = {
        fromBlock: 0,
        address: [lop],
        topics: [[LOP_FILLED_TOPIC]],
        decode: decodeLopFillRows,
        postFilter: (rows) => (filters.orderHash ? rows.filter((f) => String(f.orderHash).toLowerCase() === filters.orderHash!.toLowerCase()) : rows),
        key: (f) => `fill:${String(f.txHash)}:${String(f.orderHash)}:${String(f.remainingAmount)}`,
      };
    } else {
      // flows kind=fills|contracts — needs the rollover deployment (settlers/factory + seed block).
      const { rollover } = await resolveRollover(chainId);
      if (!rollover) return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId}`, ctx);
      if (kind === "fills") {
        const topics: Array<string[] | null> = [ROLLOVER_FILL_TOPICS];
        if (filters.orderDigest) topics.push([filters.orderDigest]);
        spec = {
          fromBlock: rollover.seededAtBlock,
          address: [rollover.exactSettler, rollover.partialSettler],
          topics,
          decode: decodeRolloverFillRows,
          postFilter: (rows) => (filters.filler ? rows.filter((f) => String(f.filler).toLowerCase() === filters.filler!.toLowerCase()) : rows),
          key: (f) => `rfill:${String(f.txHash)}:${String(f.leg)}:${String(f.orderDigest)}`,
        };
      } else {
        spec = {
          fromBlock: rollover.seededAtBlock,
          address: [rollover.factory],
          topics: [[CLONE_DEPLOYED_TOPIC]],
          decode: decodeCloneRows,
          postFilter: (rows) => (filters.account ? rows.filter((c) => String(c.owner).toLowerCase() === filters.account!.toLowerCase()) : rows),
          key: (c) => `clone:${String(c.rolloverContract).toLowerCase()}`,
        };
      }
    }

    const r = await hs.queryLogs({ fromBlock: spec.fromBlock, address: spec.address, topics: spec.topics });
    const archiveHeight = r.archiveHeight;
    // Honest completeness (F15): a HyperSync scan that hits the page bound is partial EVIDENCE,
    // never presented as the complete set — mirroring the venue path's pagination discipline.
    if (r.complete === false) {
      hsWarnings.push({ code: "pagination_incomplete", message: `the HyperSync scan hit the page bound before reaching the archive height${r.nextBlock !== undefined ? ` (stopped at block ${r.nextBlock})` : ""}; counts/items are partial evidence, not the complete set` });
    }
    let items = spec.postFilter(spec.decode(r.logs));

    // Live-tail merge [freshness]: cover blocks the archive index hasn't ingested yet by scanning
    // (archiveHeight, chain head] over the regular RPC. Only when the backfill actually reached its
    // archive head — a page-capped partial already left an interior gap, so a disjoint tail atop it
    // would mislead; that read is honestly labeled pagination_incomplete instead.
    let liveTail: { fromBlock: number; headBlock: number; merged: number } | undefined;
    if (r.complete !== false && archiveHeight !== undefined) {
      const tail = await fetchLiveTail(ctx, chainId, spec, archiveHeight);
      if (tail.status === "merged") {
        // The tail is block-disjoint from the backfill; the seen-set is a defensive guard against a
        // boundary reorg re-emitting an archived log, never the primary correctness mechanism.
        const have = new Set(items.map(spec.key));
        const fresh = tail.rows.filter((row) => !have.has(spec.key(row)));
        items = items.concat(fresh);
        liveTail = { fromBlock: archiveHeight + 1, headBlock: tail.headBlock, merged: fresh.length };
        if (fresh.length > 0) {
          hsWarnings.push({ code: "live_tail_merged", message: `merged ${fresh.length} recent event row(s) from the RPC tail (blocks ${archiveHeight + 1}–${tail.headBlock}) beyond HyperSync's archive height ${archiveHeight}; results reflect chain head, not just the indexer` });
        }
      } else if (tail.status === "error") {
        hsWarnings.push({ code: "live_tail_unavailable", message: `${tail.message} — results reflect the HyperSync archive (height ${archiveHeight}) only; blocks after it may be missing` });
      }
      // "no-rpc" (nothing configured) and "current" (archive already at/above head) add nothing, silently.
    }

    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        ...(input.resource === "flows" ? { kind } : {}),
        count: items.length,
        items,
        ...(archiveHeight !== undefined ? { archiveHeight } : {}),
        ...(liveTail ? { liveTail } : {}),
      },
      chainId,
      source: "chain",
      mode: "full-decentralized",
      warnings: hsWarnings,
      ctx,
    });
  } catch (err) {
    return unavailable(chainId, "hypersync_unavailable", `HyperSync query failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, ctx);
  }
}

// Why a venue list read can stop short of exhaustive. A repeated cursor is the venue
// contradicting itself (pointing back at a page already seen) — a genuine conflict; the
// rest are honest partial reads.
type IncompleteReason = "metadata_absent" | "cursor_absent" | "cursor_repeated" | "max_pages";

// Discriminated so an incomplete traversal can never masquerade as complete.
type PageTraversal =
  | { complete: true; items: Array<Record<string, unknown>>; pagesFetched: number }
  | { complete: false; items: Array<Record<string, unknown>>; pagesFetched: number; reason: IncompleteReason; nextCursor?: string };

/** Walk an opaque venue cursor to exhaustion under a hard page bound — never silently truncating. */
async function collectVenuePages(
  opts: { cursor?: string; pageSize: number; maxPages: number },
  fetchPage: (cursor: string | undefined) => Promise<VenueList>,
): Promise<PageTraversal> {
  const items: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let cursor = opts.cursor;
  for (let page = 1; page <= opts.maxPages; page += 1) {
    if (cursor !== undefined) {
      if (seen.has(cursor)) return { complete: false, items, pagesFetched: page - 1, reason: "cursor_repeated", nextCursor: cursor };
      seen.add(cursor);
    }
    const res = await fetchPage(cursor);
    items.push(...res.items);
    if (!res.paginationKnown) return { complete: false, items, pagesFetched: page, reason: "metadata_absent" };
    const next = typeof res.nextCursor === "string" && res.nextCursor.length > 0 ? res.nextCursor : undefined;
    if (!(res.hasMore ?? next !== undefined)) return { complete: true, items, pagesFetched: page };
    if (next === undefined) return { complete: false, items, pagesFetched: page, reason: "cursor_absent" };
    cursor = next;
  }
  return { complete: false, items, pagesFetched: opts.maxPages, reason: "max_pages", ...(cursor !== undefined ? { nextCursor: cursor } : {}) };
}

async function handleQuery(input: QueryInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const filters = parseQueryFilters(input.filters);

  if (VENUE_RESOURCES.has(input.resource)) {
    // Explicit full-decentralized mode: serve the EVENT-DERIVED subset over HyperSync.
    if (input.mode === "full-decentralized") {
      return handleQueryHyperSync(input, filters, chainId, ctx);
    }
    // Default/centralized: the as-built venue (api-phoenix). Mode is explicit, never a silent
    // substitute [R1/§7] — lite-decentralized cannot serve venue-only resources.
    if (input.mode !== undefined && input.mode !== "centralized") {
      return unavailable(chainId, "mode_unavailable", `cork_query('${input.resource}') is venue-backed; omit mode, use 'centralized', or use 'full-decentralized' for the event-derived subset (markets, fills, flows kind=fills|contracts)`, ctx);
    }
    const deps = venueDepsOf(ctx);
    const paging = { ...(input.cursor ? { cursor: input.cursor } : {}), pageSize: input.pageSize, maxPages: input.maxPages };
    try {
      let traversal: PageTraversal;
      if (input.resource === "markets") {
        traversal = await collectVenuePages(paging, async (cursor) => {
          const list = await getPools(deps, chainId, { ...(cursor ? { cursor } : {}), limit: input.pageSize });
          return filters.poolId ? { ...list, items: list.items.filter((r) => String(r.poolId).toLowerCase() === filters.poolId!.toLowerCase()) } : list;
        });
      } else if (input.resource === "orderbook") {
        traversal = await collectVenuePages(paging, (cursor) => getLopOrderbook(deps, { chainId, ...(filters.poolId ? { poolId: filters.poolId } : {}), ...(filters.side ? { side: filters.side } : {}), ...(filters.status ? { status: filters.status } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
      } else if (input.resource === "fills") {
        traversal = await collectVenuePages(paging, (cursor) => getLopFills(deps, { chainId, ...(filters.orderHash ? { orderHash: filters.orderHash } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
      } else if (input.resource === "limit-order-markets") {
        traversal = await collectVenuePages(paging, (cursor) => getLopMarkets(deps, chainId, { ...(cursor ? { cursor } : {}), limit: input.pageSize }));
      } else if (input.resource === "rfqs") {
        // Single get by id, or the discovery feed (server default: state=open, newest first).
        if (filters.rfqId) {
          const row = await getRfq(deps, filters.rfqId);
          if (!row) return unavailable(chainId, "rfq_not_found", `RFQ '${filters.rfqId}' is unknown to the venue (a normal outcome for a never-posted or mistyped id)`, ctx);
          traversal = { complete: true, items: [row], pagesFetched: 1 };
        } else {
          traversal = await collectVenuePages(paging, (cursor) => getRfqs(deps, {
            chainId,
            ...(filters.state ? { state: filters.state } : {}),
            ...(filters.referenceAsset ? { referenceAsset: filters.referenceAsset.toLowerCase() } : {}),
            ...(filters.account ? { requester: filters.account.toLowerCase() } : {}),
            ...(filters.withAnswers !== undefined ? { withAnswers: filters.withAnswers } : {}),
            ...(cursor ? { cursor } : {}),
            limit: input.pageSize,
          }));
        }
      } else {
        // flows = the rollover venue; filters.kind picks the feed (orders default).
        const kind = filters.kind ?? "orders";
        if (kind === "orders") {
          if (filters.orderDigest) {
            const row = await getRolloverOrder(deps, filters.orderDigest);
            if (!row) return unavailable(chainId, "order_not_found", `rollover order ${filters.orderDigest} is unknown to the venue (a normal outcome for a never-posted digest)`, ctx);
            traversal = { complete: true, items: [row], pagesFetched: 1 };
          } else {
            traversal = await collectVenuePages(paging, (cursor) => getRolloverOrders(deps, { chainId, ...(filters.account ? { user: filters.account.toLowerCase() } : {}), ...(filters.poolId ? { poolId: filters.poolId } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.fillable !== undefined ? { fillable: filters.fillable } : {}), ...(filters.source ? { source: filters.source } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
          }
        } else if (kind === "fills") {
          traversal = await collectVenuePages(paging, (cursor) => getRolloverFills(deps, { chainId, ...(filters.orderDigest ? { orderDigest: filters.orderDigest } : {}), ...(filters.filler ? { filler: filters.filler.toLowerCase() } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
        } else {
          traversal = await collectVenuePages(paging, (cursor) => getRolloverContracts(deps, { chainId, ...(filters.account ? { owner: filters.account.toLowerCase() } : {}), ...(filters.address ? { address: filters.address.toLowerCase() } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
        }
      }
      return envelope({
        // A merely-partial read is honest evidence (state ok + warning); only a self-contradicting
        // venue cursor (repeated) is a conflict.
        state: !traversal.complete && traversal.reason === "cursor_repeated" ? "conflict" : "ok",
        data: {
          resource: input.resource,
          ...(input.resource === "flows" ? { kind: filters.kind ?? "orders" } : {}),
          count: traversal.items.length,
          items: traversal.items,
          pagination: {
            complete: traversal.complete,
            pagesFetched: traversal.pagesFetched,
            pageSize: input.pageSize,
            maxPages: input.maxPages,
            ...(!traversal.complete ? { reason: traversal.reason } : {}),
            ...(!traversal.complete && traversal.nextCursor ? { nextCursor: traversal.nextCursor } : {}),
          },
          ...(input.format === "full" ? { venue: venueBaseUrl(ctx.venueUrl) } : {}),
        },
        chainId,
        source: "indexer",
        warnings: traversal.complete
          ? []
          : [{ code: "pagination_incomplete", message: `venue traversal did not exhaust the set (${traversal.reason}); items are evidence, not a complete list${traversal.nextCursor ? ` — resume from cursor ${traversal.nextCursor}` : ""}` }],
        ctx,
      });
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  // whitelisted-addresses: event-derived enumeration (WhitelistManager's membership mappings are
  // not enumerable on-chain) — its natural mode is full-decentralized, with a live-view [K7]
  // verification leg when an RPC also resolves.
  if (input.resource === "whitelisted-addresses") {
    return handleQueryWhitelistedAddresses(input, filters, chainId, ctx);
  }

  // Data mode is explicit, never a silent fallback [R1/§7]: chain resources serve only
  // lite-decentralized (RPC). Requesting an unwired mode fails loudly instead of being ignored.
  if (input.mode !== undefined && input.mode !== "lite-decentralized") {
    return unavailable(chainId, "mode_unavailable", `data mode '${input.mode}' is not available for cork_query('${input.resource}') (a live chain read); omit mode or use 'lite-decentralized'`, ctx);
  }

  // MarketRegistry reads (registry-*) — live chain views on the registry contract.
  if (input.resource === "registry-assets" || input.resource === "registry-oracle" || input.resource === "registry-recipes" || input.resource === "registry-denominations" || input.resource === "registry-feeds") {
    return handleQueryRegistry(input, filters, chainId, ctx);
  }
  // market-predict — the registry+adapter derivation of a market that may not exist yet.
  if (input.resource === "market-predict") {
    return handleQueryMarketPredict(input, filters, chainId, ctx);
  }
  const { dep, depWarn } = await getDep(ctx, chainId);

  // protocol-config is pure config (no RPC needed).
  if (input.resource === "protocol-config") {
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known deployment for chainId ${chainId}`, ctx);
    return envelope({ state: "ok", data: { resource: input.resource, chainId, deployment: dep, create2Deployer: CREATE2_DEPLOYER }, chainId, source: "config", warnings: depWarn, ctx });
  }

  const chainResources = new Set(["market", "account-state", "pool-whitelist"]);
  if (!chainResources.has(input.resource)) {
    // Unreachable today (every enum resource routes above) — kept so a future enum addition
    // fails honestly instead of falling into the poolId-gated chain-read path below.
    return unavailable(chainId, "needs_indexer", `cork_query('${input.resource}') requires an indexer/service backend not wired in this iteration`, ctx);
  }
  if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
  if (input.resource === "pool-whitelist" && !dep.whitelistManager) {
    return unavailable(chainId, "unknown_deployment", `whitelistManager address is not configured for chainId ${chainId} (partial deployment — read tools for market/account-state still work)`, ctx);
  }
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    return unavailable(chainId, "requires_rpc", `cork_query('${input.resource}') needs an RPC endpoint for chainId ${chainId} (none resolved: offline, or a chain with no default/fallback — set CORK_RPC_URL)`, ctx);
  }
  if (!filters.poolId) return unavailable(chainId, "missing_filter", `cork_query('${input.resource}') requires filters.poolId`, ctx);

  const client = resolved.client;
  const w = [...rpcWarn(resolved), ...depWarn];
  const rpc = rpcProvenance(input.format, resolved);
  const addrs: CorkAddresses = { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter };

  try {
    if (input.resource === "market") {
      const s = await readPoolState(client, addrs, filters.poolId, ctx.atBlock);
      return envelope({
        state: "ok",
        data: {
          resource: input.resource,
          chainId,
          poolId: s.poolId,
          market: s.market,
          constraintState: s.constraintState,
          swapRate: s.onChainSwapRate,
          oracleRate: s.oracleRate,
          swapFeePercentage: s.swapFeePercentage,
          unwindSwapFeePercentage: s.unwindSwapFeePercentage,
          collateralDecimals: s.collateralDecimals,
          referenceDecimals: s.referenceDecimals,
          corkSwapToken: s.cstToken, // cST
          corkPrincipalToken: s.cptToken, // cPT
          issuedAt: s.issuedAt,
        },
        chainId,
        source: "chain",
        block: s.blockNumber,
        warnings: w,
        ...rpc,
        ctx,
      });
    }

    if (input.resource === "account-state") {
      if (!filters.account) return unavailable(chainId, "missing_filter", "account-state requires filters.account", ctx);
      const tokens = await resolvePoolTokens(client, dep.poolManager, filters.poolId, ctx.atBlock);
      const blockOpt = ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {};
      const bal = (token: `0x${string}`) =>
        client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [filters.account!], ...blockOpt });
      const [collateral, reference, corkSwapToken, corkPrincipalToken] = await Promise.all([bal(tokens.collateral), bal(tokens.reference), bal(tokens.cst), bal(tokens.cpt)]);
      // Allowances that gate the funding UX [funding.ts]: erc20-approve mode pulls
      // initiator→ADAPTER (erc20TransferFrom on the adapter), permit2 mode needs the token
      // approved to the canonical Permit2. Only readable where the adapter is configured.
      let allowances: Record<string, unknown> | undefined;
      if (dep.corkAdapter) {
        const alw = (token: `0x${string}`, spender: `0x${string}`) =>
          client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [filters.account!, spender], ...blockOpt });
        const roles = [
          ["collateral", tokens.collateral],
          ["reference", tokens.reference],
          ["corkSwapToken", tokens.cst], // cST
          ["corkPrincipalToken", tokens.cpt], // cPT
        ] as const;
        // permit2 funding needs TWO layers: the ERC-20 approval TO Permit2 (`permit2`) AND the
        // Permit2-INTERNAL (user, token, spender=adapter) allowance with its uint48 expiry
        // (`permit2Internal`) — reporting only the first let bundles look funded and still
        // revert on a zero/expired internal allowance (F18). Internal read is best-effort
        // (null where Permit2 isn't deployed on the chain).
        const nowSecs = nowSecondsOf(ctx);
        const entries = await Promise.all(
          roles.map(async ([role, token]) => {
            const [toAdapter, toPermit2, p2] = await Promise.all([
              alw(token, dep.corkAdapter!),
              alw(token, PERMIT2_ADDRESS),
              client
                .readContract({ address: PERMIT2_ADDRESS, abi: permit2AllowanceAbi, functionName: "allowance", args: [filters.account!, token, dep.corkAdapter!], ...blockOpt })
                .catch(() => null),
            ]);
            const permit2Internal = Array.isArray(p2) && p2.length >= 2
              ? { amount: p2[0] as bigint, expiration: Number(p2[1]), expired: Number(p2[1]) !== 0 && BigInt(Number(p2[1])) <= nowSecs }
              : null;
            return [role, { corkAdapter: toAdapter, permit2: toPermit2, permit2Internal }] as const;
          }),
        );
        allowances = {
          spenders: { corkAdapter: dep.corkAdapter, permit2: PERMIT2_ADDRESS },
          note: "permit2-mode funding requires BOTH the ERC-20 approval to Permit2 (permit2) AND an unexpired Permit2-internal allowance for spender=corkAdapter (permit2Internal)",
          byToken: Object.fromEntries(entries),
        };
      } else {
        w.push({ code: "unknown_deployment", message: `corkAdapter is not configured for chainId ${chainId} — allowances (funding pre-flight) omitted; balances are complete` });
      }
      const tokensOut = { collateral: tokens.collateral, reference: tokens.reference, corkSwapToken: tokens.cst, corkPrincipalToken: tokens.cpt, expiryTimestamp: tokens.expiryTimestamp };
      return envelope({ state: "ok", data: { resource: input.resource, chainId, poolId: filters.poolId, account: filters.account, balances: { collateral, reference, corkSwapToken, corkPrincipalToken }, tokens: tokensOut, ...(allowances ? { allowances } : {}) }, chainId, source: "chain", warnings: w, ...rpc, ctx });
    }

    // pool-whitelist (wlm presence checked above)
    if (!filters.account) return unavailable(chainId, "missing_filter", "pool-whitelist requires filters.account", ctx);
    const isWhitelisted = await client.readContract({
      address: dep.whitelistManager!,
      abi: whitelistManagerAbi,
      functionName: "isWhitelisted",
      args: [filters.poolId, filters.account],
      ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}),
    });
    return envelope({ state: "ok", data: { resource: input.resource, chainId, poolId: filters.poolId, account: filters.account, isWhitelisted }, chainId, source: "chain", warnings: w, ...rpc, ctx });
  } catch (err) {
    return chainReadFailed(chainId, err, w, ctx, resolved);
  }
}

/**
 * whitelisted-addresses: enumerate the WhitelistManager's CURRENT membership by replaying its
 * lifecycle events (global add/remove, per-market add/remove, market enable/disable). The
 * membership mappings are NOT enumerable on-chain, so the event history is the only enumeration
 * source — served over the same HyperSync path that powers markets/fills/flows. When an RPC also
 * resolves, every derived row is re-checked against the live isGlobalWhitelisted /
 * isMarketWhitelisted views [K7: chain outranks any derivation, including our own].
 */
async function handleQueryWhitelistedAddresses(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (input.mode === "centralized") {
    return unavailable(chainId, "mode_unavailable", "'whitelisted-addresses' is chain-event-derived; the venue has no whitelist endpoint — omit mode or use 'full-decentralized'", ctx);
  }
  if (input.mode === "lite-decentralized") {
    return unavailable(chainId, "mode_unavailable", "'whitelisted-addresses' cannot be ENUMERATED over plain RPC views (the WhitelistManager stores membership in non-enumerable mappings) — omit mode or use 'full-decentralized' (HyperSync event replay); for a single-account check use resource 'pool-whitelist'", ctx);
  }
  const { dep, depWarn } = await getDep(ctx, chainId);
  if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
  if (!dep.whitelistManager) {
    return unavailable(chainId, "unknown_deployment", `whitelistManager address is not configured for chainId ${chainId} (partial deployment)`, ctx);
  }
  const load = ctx.hyperSync ? { source: ctx.hyperSync } : await loadHyperSync(chainId, envioToken("hypersync"));
  if ("error" in load) return unavailable(chainId, "hypersync_unavailable", load.error, ctx);
  try {
    const r = await load.source.queryLogs({ fromBlock: 0, address: [dep.whitelistManager], topics: [WHITELIST_TOPICS] });
    const warnings: Array<{ code: string; message: string }> = [...depWarn];
    if (r.complete === false) {
      warnings.push({ code: "pagination_incomplete", message: `the HyperSync scan hit the page bound before reaching the archive height${r.nextBlock !== undefined ? ` (stopped at block ${r.nextBlock})` : ""} — membership replayed from a PARTIAL history can be stale or wrong; treat rows as evidence, not the full set` });
    }
    const replayed = replayWhitelist(decodeWhitelistRows(r.logs));
    const wantPool = filters.poolId?.toLowerCase();
    type Row = { account: `0x${string}`; scope: "global" | "market"; poolId?: string; verified?: boolean };
    const items: Row[] = [
      // Global members ride along even under a poolId filter: isWhitelisted() admits them to
      // every gated pool, so omitting them would misreport the pool's effective allowlist.
      ...replayed.global.map((account): Row => ({ account, scope: "global" })),
      ...Object.entries(replayed.byPool)
        .filter(([poolId]) => !wantPool || poolId === wantPool)
        .flatMap(([poolId, accounts]) => accounts.map((account): Row => ({ account, scope: "market", poolId }))),
    ];
    const enabledByPool = wantPool
      ? { [wantPool]: replayed.enabledByPool[wantPool] ?? false }
      : replayed.enabledByPool;

    // [K7] live-view verification leg (best-effort): re-check every derived row against the
    // contract's own views. A disagreement is possible exactly when the scan was partial.
    const VERIFY_CAP = 200;
    let verification = "skipped (no rows, or no RPC resolved) — rows are event-derived only";
    const resolved = items.length > 0 ? await getRpc(ctx, chainId) : null;
    if (resolved && items.length <= VERIFY_CAP) {
      const wlm = { address: dep.whitelistManager, abi: whitelistManagerAbi } as const;
      try {
        const checks = await Promise.all(
          items.map((row) =>
            resolved.client.readContract(
              row.scope === "global"
                ? { ...wlm, functionName: "isGlobalWhitelisted", args: [row.account] }
                : { ...wlm, functionName: "isMarketWhitelisted", args: [row.poolId as `0x${string}`, row.account] },
            ) as Promise<boolean>,
          ),
        );
        items.forEach((row, i) => {
          row.verified = checks[i]!;
        });
        verification = "live WhitelistManager views (isGlobalWhitelisted / isMarketWhitelisted)";
        warnings.push(...rpcWarn(resolved));
        const stale = items.filter((row) => row.verified === false);
        if (stale.length > 0) {
          warnings.push({ code: "status_mismatch", message: `${stale.length} event-derived row(s) failed live-view verification (verified:false) — the chain view outranks the event replay [K7]; the scan likely missed later removal events` });
        }
      } catch (err) {
        verification = "attempted but the live views failed — rows are event-derived only";
        warnings.push({ code: "chain_read_failed", message: `live-view verification failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — rows are event-derived only` });
      }
    } else if (resolved && items.length > VERIFY_CAP) {
      verification = `skipped (${items.length} rows exceeds the ${VERIFY_CAP}-row live-verification cap) — rows are event-derived only`;
    }

    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        chainId,
        whitelistManager: dep.whitelistManager,
        ...(wantPool ? { poolId: filters.poolId } : {}),
        // Semantics disclosure: a pool with NO enable event was never gated — everyone passes.
        enabledByPool,
        note: "a pool absent from enabledByPool (or false) is NOT gated: isWhitelisted() returns true for every account on it; global rows are admitted to every gated pool",
        verification,
        count: items.length,
        items,
        ...(r.archiveHeight !== undefined ? { archiveHeight: r.archiveHeight } : {}),
      },
      chainId,
      source: "chain",
      mode: "full-decentralized",
      warnings,
      ctx,
    });
  } catch (err) {
    return unavailable(chainId, "hypersync_unavailable", `HyperSync query failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, ctx);
  }
}

/** Resolve the MarketRegistry stack + an RPC for registry-backed calls, or an honest gate. */
async function getRegistry(ctx: HandlerContext, chainId: ChainId): Promise<
  | { gate: Envelope }
  | { gate?: undefined; mr: NonNullable<Awaited<ReturnType<typeof resolveMarketRegistry>>["marketRegistry"]>; resolved: ResolvedRpc; warnings: Array<{ code: string; message: string }> }
> {
  const { marketRegistry: mr, warning } = await resolveMarketRegistry(chainId);
  if (!mr) {
    return { gate: unavailable(chainId, "unknown_deployment", `no MarketRegistry configured for chainId ${chainId} — the registry stack is live on Arbitrum One (42161)`, ctx) };
  }
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    return { gate: unavailable(chainId, "requires_rpc", `MarketRegistry reads need an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx) };
  }
  return { mr, resolved, warnings: [...rpcWarn(resolved), ...(warning ? [warning] : [])] };
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/** First line of a revert, with the custom error name when the ABI decoded it. */
function revertReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return (err.message.split("\n").find((l) => l.includes("Error:") || l.includes("reverted")) ?? err.message.split("\n")[0] ?? err.message).trim();
}

/** Best-effort 2.1.0 generation guard, cached per (chainId, adapter) for the process: the ONE
 *  check that rules out the previous-generation hazard (an old registry ANSWERS 2.1.0-shaped
 *  calls with misdecoded garbage) is the adapter's MARKET_REGISTRY() immutable matching the
 *  configured registry (INTEGRATOR.md). Returns a conflict warning on mismatch; silence when
 *  the adapter is unconfigured or the read fails (the prepare paths re-check hard). */
const bindingGuardCache = new Map<string, boolean>();
/** Test hook: clear the per-process binding-guard memo (mirrors resetConfigMemo). */
export function resetRegistryBindingGuardCache(): void {
  bindingGuardCache.clear();
}
async function registryBindingMismatch(client: ResolvedRpc["client"], chainId: ChainId, mr: { registry: `0x${string}`; adapter?: `0x${string}` | undefined }): Promise<{ code: string; message: string } | undefined> {
  if (!mr.adapter) return undefined;
  const key = `${chainId}:${mr.adapter.toLowerCase()}:${mr.registry.toLowerCase()}`;
  const cached = bindingGuardCache.get(key);
  if (cached === true) return undefined;
  if (cached === undefined) {
    try {
      const bound = (await client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "MARKET_REGISTRY" })) as `0x${string}`;
      bindingGuardCache.set(key, bound.toLowerCase() === mr.registry.toLowerCase());
    } catch {
      return undefined; // disclosed-by-omission: reads proceed; prepares re-check hard
    }
  }
  if (bindingGuardCache.get(key) === false) {
    return { code: "adapter_binding_mismatch", message: `the configured adapter's on-chain MARKET_REGISTRY() does not match the configured registry ${mr.registry} — one of them is a stale/previous-generation address (the old registry answers 2.1.0 calls with misdecoded garbage). Refresh cork-defaults.json; do not trust these reads` }; // conflict-grade
  }
  return undefined;
}

/** Shape an on-chain AssetSource into the API-parity object (absent slot ⇒ null). */
function shapeAssetSource(s: { addr: `0x${string}`; sourceType: number; sourceInterface: number; denomination: string }): Record<string, unknown> | null {
  if (s.addr === ZERO_ADDR) return null;
  return { address: s.addr, sourceType: SOURCE_TYPE[s.sourceType] ?? s.sourceType, sourceInterface: SOURCE_INTERFACE[s.sourceInterface] ?? s.sourceInterface, denomination: s.denomination };
}

type RegistryClient = ResolvedRpc["client"];

/** Best-effort ERC-20 self-description (symbol/name/decimals) — null when the token won't say. */
async function tokenMeta(client: RegistryClient, addr: `0x${string}`): Promise<{ decimals: number; symbol: string; name: string } | null> {
  try {
    const [decimals, symbol, name] = await Promise.all([
      client.readContract({ address: addr, abi: erc20MetadataAbi, functionName: "decimals" }),
      client.readContract({ address: addr, abi: erc20MetadataAbi, functionName: "symbol" }),
      client.readContract({ address: addr, abi: erc20MetadataAbi, functionName: "name" }),
    ]);
    return { decimals: Number(decimals), symbol: symbol as string, name: name as string };
  } catch {
    return null;
  }
}

/** One recipe's live self-description: source()/description()/REGISTRY() + catalogued constants
 *  (values always read live; a constant the contract no longer answers is silently dropped,
 *  matching the read API). Catalog absence is not a gate — argsKnown:false, still resolvable. */
async function readRecipeMeta(client: RegistryClient, recipe: `0x${string}`, configuredRegistry: `0x${string}`): Promise<Record<string, unknown>> {
  const r = { address: recipe, abi: recipeAbi } as const;
  const [source, description, boundRegistry] = await Promise.all([
    client.readContract({ ...r, functionName: "source" }),
    client.readContract({ ...r, functionName: "description" }).catch(() => null),
    client.readContract({ ...r, functionName: "REGISTRY" }).catch(() => null),
  ]);
  const catalog = RECIPE_CATALOG[recipe.toLowerCase()];
  const constants: Record<string, string> = {};
  if (catalog) {
    await Promise.all(
      catalog.constants.map(async (name) => {
        try {
          const v = (await client.readContract({ address: recipe, abi: constantGetterAbi(name), functionName: name })) as unknown as bigint;
          constants[name] = v.toString();
        } catch {
          /* dropped: the contract no longer answers this getter */
        }
      }),
    );
  }
  return {
    address: recipe,
    source: RECIPE_SOURCE[source as number] ?? source,
    description,
    constants,
    registry: boundRegistry,
    registryMatches: boundRegistry !== null && String(boundRegistry).toLowerCase() === configuredRegistry.toLowerCase(),
    argsKnown: Boolean(catalog),
    args: catalog?.args ?? null,
  };
}

/** MarketRegistry chain views (contracts 2.1.0): approved assets (two named source slots),
 *  recipes-as-contracts (self-described, live constants), denominations, conversion feeds, and
 *  mode-keyed / fixed-rate oracle status. filters.legacy routes to the DEPRECATED pre-2.1.0
 *  generation behind the deprecation gate. */
async function handleQueryRegistry(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (filters.legacy) return handleQueryRegistryLegacy(input, filters, chainId, ctx);
  const r = await getRegistry(ctx, chainId);
  if (r.gate) return r.gate;
  const { mr, resolved, warnings } = r;
  const client = resolved.client;
  const rpc = rpcProvenance(input.format, resolved);
  const reg = { address: mr.registry, abi: marketRegistryAbi } as const;
  const version = mr.contractsVersion ? { contractsVersion: mr.contractsVersion } : {};
  try {
    const bindingWarn = await registryBindingMismatch(client, chainId, mr);
    if (bindingWarn) {
      return envelope({ state: "conflict", data: { resource: input.resource, chainId, registry: mr.registry, adapter: mr.adapter }, chainId, source: "chain", warnings: [...warnings, bindingWarn], ...rpc, ctx });
    }
    if (input.resource === "registry-assets") {
      // filters.address → single lookup by natural key (an address keys exactly one asset per chain).
      if (filters.address) {
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupAssetByAddress", args: [filters.address] });
        if (!found) return unavailable(chainId, "asset_not_found", `address ${filters.address} is not a registry-approved asset on chainId ${chainId} — list them with cork_query resource:"registry-assets" (no filters)`, ctx);
        const item = { address: entry.addr, name: entry.name, kind: ASSET_KIND[entry.kind] ?? entry.kind, priceSource: shapeAssetSource(entry.priceSource), navSource: shapeAssetSource(entry.navSource), token: await tokenMeta(client, entry.addr) };
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: 1, items: [item] }, chainId, source: "chain", warnings, ...rpc, ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getAssets", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} assets but this read returns the first ${page.length} — items are partial evidence` });
      }
      const items = await Promise.all(
        page.map(async (a) => ({ address: a.addr, name: a.name, kind: ASSET_KIND[a.kind] ?? a.kind, priceSource: shapeAssetSource(a.priceSource), navSource: shapeAssetSource(a.navSource), token: await tokenMeta(client, a.addr) })),
      );
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: items.length, total, items }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    if (input.resource === "registry-recipes") {
      // A recipe is an approved CONTRACT ADDRESS in 2.1.0 — no modes, no stored bands, no
      // applyBands. filters.recipe → single lookup; filters.mode survives as DEPRECATED sugar
      // over the config's named-recipe hints.
      let single: `0x${string}` | undefined = filters.recipe;
      if (!single && filters.mode !== undefined) {
        const hinted = mr.recipes?.[filters.mode];
        if (!hinted) {
          return unavailable(chainId, "recipe_not_found", `recipe mode '${filters.mode}' has no configured 2.1.0 recipe hint — recipes are CONTRACT ADDRESSES now (filters.recipe); known mode hints: ${Object.keys(mr.recipes ?? {}).join(", ") || "none"}`, ctx);
        }
        warnings.push({ code: "deprecation_notice", message: `filters.mode is deprecated sugar: '${filters.mode}' resolved to recipe ${hinted} via this tool's config hints. Recipes are contract addresses in 2.1.0 — pass filters.recipe; mode will be removed in a later release` });
        single = hinted;
      }
      if (single) {
        const isRecipe = await client.readContract({ ...reg, functionName: "isRecipe", args: [single] });
        if (!isRecipe) return unavailable(chainId, "recipe_not_found", `${single} is not an approved recipe on this registry (isRecipe is the only membership gate) — list them with cork_query resource:"registry-recipes"`, ctx);
        const item = await readRecipeMeta(client, single, mr.registry);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, scale: "constants ending _PERCENTAGE are 1e18 = 1%; RATE_MIN-style constants are ABSOLUTE rates, 1e18 = 1.0; read each value's own name", count: 1, items: [item] }, chainId, source: "chain", warnings, ...rpc, ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getRecipes", args: [0n, 100n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} recipes but this read returns the first ${page.length} — items are partial evidence; a recipe absent here may still exist` });
      }
      const items = await Promise.all(page.map((addr) => readRecipeMeta(client, addr, mr.registry)));
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, scale: "constants ending _PERCENTAGE are 1e18 = 1%; RATE_MIN-style constants are ABSOLUTE rates, 1e18 = 1.0; read each value's own name", count: items.length, total, items }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    if (input.resource === "registry-denominations") {
      // The registry stores the label HASH; display text comes from the unit's own symbol()
      // (fiat/native pseudo-units from a fixed table). labelHash is the identity, label display.
      if (filters.label !== undefined) {
        const [found, unit] = await client.readContract({ ...reg, functionName: "lookupDenomination", args: [filters.label] });
        if (!found) return unavailable(chainId, "denomination_not_found", `denomination '${filters.label}' is not registered on chainId ${chainId} — labels are EXACT BYTES and case-sensitive ('USD' and 'usd' are different denominations); list them with cork_query resource:"registry-denominations"`, ctx);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: 1, items: [{ label: filters.label, unit }] }, chainId, source: "chain", warnings, ...rpc, ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getDenominations", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} denominations but this read returns the first ${page.length}` });
      }
      const items = await Promise.all(
        page.map(async (d) => {
          const pseudo = DENOMINATION_PSEUDO_UNITS[d.unit.toLowerCase()];
          const label = pseudo ?? (await tokenMeta(client, d.unit))?.symbol ?? null;
          return { labelHash: d.labelHash, unit: d.unit, label, labelSource: pseudo ? "pseudo-unit table" : label ? "unit symbol() — display only; labelHash is the identity" : null };
        }),
      );
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: items.length, total, items }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    if (input.resource === "registry-feeds") {
      // A feed is ONE DIRECTED edge of the graph proving an asset reaches US dollars — base→quote
      // and quote→base are different records. `live` is the aggregator's current answer;
      // comparing live.decimals against feedDecimals exposes decimals drift since registration.
      const readLive = async (aggregator: `0x${string}`) => {
        try {
          const [decimals, round] = await Promise.all([
            client.readContract({ address: aggregator, abi: aggregatorV3Abi, functionName: "decimals" }),
            client.readContract({ address: aggregator, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
          ]);
          const [, answer, , updatedAt] = round as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
          return { answer: answer.toString(), decimals: Number(decimals), updatedAt: updatedAt.toString() };
        } catch {
          return null;
        }
      };
      if (filters.base || filters.quote) {
        if (!filters.base || !filters.quote) return unavailable(chainId, "missing_filter", "a single-feed lookup needs BOTH filters.base and filters.quote (direction matters: base→quote and quote→base are different feeds)", ctx);
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupConversionFeed", args: [filters.base, filters.quote] });
        if (!found) return unavailable(chainId, "feed_not_found", `no conversion feed registered for ${filters.base} → ${filters.quote} on chainId ${chainId} (direction matters); list them with cork_query resource:"registry-feeds"`, ctx);
        const item = { base: entry.base, quote: entry.quote, aggregator: entry.aggregatorAddress, feedDecimals: entry.feedDecimals, live: await readLive(entry.aggregatorAddress) };
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: 1, items: [item] }, chainId, source: "chain", warnings, ...rpc, ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getConversionFeeds", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} conversion feeds but this read returns the first ${page.length}` });
      }
      const items = await Promise.all(page.map(async (f) => ({ base: f.base, quote: f.quote, aggregator: f.aggregatorAddress, feedDecimals: f.feedDecimals, live: await readLive(f.aggregatorAddress) })));
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: items.length, total, items }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    // registry-oracle — two keying families, one resource:
    //  · filters.rate → the FIXED-RATE oracle for that rate (keyed on the rate, not a pair);
    //  · filters.collateralAsset+referenceAsset [+ filters.mode price|nav] → the pair's wrapper.
    // The oracle:{address,deployed,deployable,…} shape is shared with market-predict +
    // cork_prepare_market, so oracle.address is one reusable path across those tools.
    if (filters.rate !== undefined) {
      if (filters.collateralAsset || filters.referenceAsset) {
        return unavailable(chainId, "missing_filter", "filters.rate keys a FIXED-RATE oracle (no pair) — pass either rate OR collateralAsset+referenceAsset, not both", ctx);
      }
      if (filters.rate === 0n) return unavailable(chainId, "invalid_state", "a zero fixed rate cannot have an oracle — the FixedRateOracle constructor reverts on 0", ctx);
      const predicted = await client.readContract({ ...reg, functionName: "predictFixedRateOracle", args: [filters.rate] });
      const code = await client.getCode({ address: predicted }).catch(() => undefined);
      const deployed = code !== undefined && code !== "0x";
      return envelope({
        state: "ok",
        data: { resource: input.resource, chainId, registry: mr.registry, ...version, rate: filters.rate, scale: "rate is ABSOLUTE, 1e18 = 1.0", oracle: { address: predicted, deployed, deployable: true }, ...(deployed ? {} : { note: "not deployed yet; registry.deployFixedRateOracle(rate) is permissionless + idempotent (CREATE2-salted by the rate) — cork_prepare_market deploy-fixed-oracle builds that tx, and a JIT fill with rateOverride deploys it automatically" }) },
        chainId,
        source: "chain",
        warnings,
        ...rpc,
        ctx,
      });
    }
    if (!filters.collateralAsset || !filters.referenceAsset) {
      return unavailable(chainId, "missing_filter", "registry-oracle requires filters.collateralAsset AND filters.referenceAsset (order matters: collateral first — the reverse pair is a different oracle), or filters.rate for a fixed-rate oracle", ctx);
    }
    const modeName: OracleModeName = filters.mode === "nav" ? "nav" : "price";
    if (filters.mode !== undefined && filters.mode !== "price" && filters.mode !== "nav") {
      return unavailable(chainId, "missing_filter", `registry-oracle filters.mode must be 'price' or 'nav' (got '${filters.mode}') — one pair can hold BOTH wrappers at different addresses, so the mode is part of the key. For a fixed-rate oracle pass filters.rate instead`, ctx);
    }
    const wrapper = await client.readContract({ ...reg, functionName: "lookupWrapper", args: [filters.collateralAsset, filters.referenceAsset, ORACLE_MODE[modeName]] });
    // The applied default is disclosed in DATA (not a warning: no caller field was ignored —
    // reserved_field_ignored means something else) so the echoed mode is never mistaken for a
    // caller choice.
    const pairEcho = { collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, mode: modeName, ...(filters.mode === undefined ? { modeNote: "no filters.mode given — defaulted to 'price'; one pair can hold a price AND a nav wrapper at different addresses, pass mode explicitly when you mean nav" } : {}) };
    if (wrapper !== ZERO_ADDR) {
      const rate = (await client.readContract({ address: wrapper, abi: rateOracleAbi, functionName: "rate" }).catch(() => null)) as bigint | null;
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, ...pairEcho, oracle: { address: wrapper, deployed: true, deployable: true, ...(rate !== null ? { rate } : {}) } }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    try {
      // Simulating the real deploy (not re-deriving CREATE2 off-chain) is deliberate: the salt
      // includes the RESOLVED source addresses, so re-deriving would duplicate the registry's
      // nav-fallback rules — the simulation cannot drift from what a fill will actually do.
      const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [filters.collateralAsset, filters.referenceAsset, ORACLE_MODE[modeName]] });
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, ...pairEcho, oracle: { address: sim.result, deployed: false, deployable: true }, note: `no ${modeName} oracle yet; registry.deploy(ca, ref, ${modeName}) would succeed (permissionless, idempotent) — cork_prepare_market builds that tx` }, chainId, source: "chain", warnings, ...rpc, ctx });
    } catch (err) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, ...pairEcho, oracle: { address: null, deployed: false, deployable: false, reason: revertReason(err) }, note: `this pair cannot get a ${modeName} oracle as-registered (MissingSource / NavModeWithoutNavSource — an unregistered asset, a missing source slot, or no conversion path) — a JIT fill for it would revert` }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
  } catch (err) {
    return chainReadFailed(chainId, err, warnings, ctx, resolved);
  }
}

/** The DEPRECATED pre-2.1.0 resolve-recipe (percentage bands × live rate via the old registry's
 *  applyBands, bit-parity self-checked) — preserved behind the deprecation gate. */
async function handleComputeResolveRecipeLegacy(
  input: { format: "concise" | "full" },
  p: { kind: "resolve-recipe"; mode?: string | undefined; rate?: string | undefined; collateralAsset?: `0x${string}` | undefined; referenceAsset?: `0x${string}` | undefined },
  ctx: HandlerContext,
  chainId: ChainId,
): Promise<Envelope> {
  if (!deprecatedEnabled()) {
    return unavailable(chainId, "deprecated_gated", deprecatedGateMessage("legacy resolve-recipe (pre-2.1.0 percentage-band math)", "In 2.1.0 a recipe resolves its own constraint — drop `legacy` and pass the recipe CONTRACT ADDRESS."), ctx);
  }
  if (p.mode === undefined) return unavailable(chainId, "missing_filter", "legacy resolve-recipe needs `mode` (the old registry's exact case-sensitive mode string)", ctx);
  const { marketRegistry: mr, warning } = await resolveMarketRegistryLegacy(chainId);
  if (!mr) return unavailable(chainId, "unknown_deployment", `no LEGACY MarketRegistry configured for chainId ${chainId}`, ctx);
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) return unavailable(chainId, "requires_rpc", `MarketRegistry reads need an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx);
  const warnings: Array<{ code: string; message: string }> = [...rpcWarn(resolved), ...(warning ? [warning] : []), { code: "deprecated", message: "this is the DEPRECATED pre-2.1.0 band math against the OLD registry (CORK_ENABLE_DEPRECATED is set) — 2.1.0 recipes resolve their own constraints" }];
  const client = resolved.client;
  const rpc = rpcProvenance(input.format, resolved);
  const reg = { address: mr.registry, abi: legacyRegistry.marketRegistryAbi } as const;
  try {
    const [found, entry] = await client.readContract({ ...reg, functionName: "lookupRecipe", args: [p.mode] });
    if (!found) {
      const [, modes] = await client.readContract({ ...reg, functionName: "getRecipes", args: [0n, 100n] });
      return unavailable(chainId, "recipe_not_found", `recipe mode '${p.mode}' is not in the legacy registry (modes are EXACT case-sensitive strings; available: ${modes.join(", ")})`, ctx);
    }
    let rate: bigint;
    let oracle: `0x${string}` | undefined;
    if (p.rate !== undefined) {
      rate = BigInt(p.rate);
    } else {
      if (!p.collateralAsset || !p.referenceAsset) {
        return unavailable(chainId, "missing_filter", "legacy resolve-recipe needs either an explicit rate, or collateralAsset+referenceAsset to read the pair's live oracle rate", ctx);
      }
      const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [p.collateralAsset, p.referenceAsset] });
      oracle = sim.result;
      rate = (await client.readContract({ address: oracle, abi: rateOracleAbi, functionName: "rate" })) as bigint;
      if (rate === 0n) return unavailable(chainId, "chain_read_failed", "the pair's rate oracle reports a ZERO rate — the bands cannot be meaningfully resolved", ctx);
    }
    const bands: legacyRegistry.ConstraintBands = { mode: entry.mode, rateMin: entry.rateMin, rateMax: entry.rateMax, rateChangePerDayMax: entry.rateChangePerDayMax, rateChangeCapacityMax: entry.rateChangeCapacityMax };
    let local: ReturnType<typeof legacyRegistry.applyBandsLocal>;
    try {
      local = legacyRegistry.applyBandsLocal(bands, rate);
    } catch (err) {
      return localComputeFailed(chainId, err, warnings, ctx);
    }
    const onChain = await client.readContract({ ...reg, functionName: "applyBands", args: [p.mode, rate] });
    const same = onChain.rateMin === local.rateMin && onChain.rateMax === local.rateMax && onChain.rateChangePerDayMax === local.rateChangePerDayMax && onChain.rateChangeCapacityMax === local.rateChangeCapacityMax;
    if (!same) {
      return envelope({ state: "conflict", data: { kind: p.kind, mode: p.mode, rate, local, onChain }, chainId, source: "chain", warnings: [...warnings, { code: "band_parity_mismatch", message: "local applyBands port disagrees with the on-chain view — trust the chain values and report this" }], ctx });
    }
    return envelope({
      state: "ok",
      data: { kind: p.kind, mode: p.mode, scales: { bands: "1e18 = 1% (percentage)", rateAndResolved: "1e18 = 1.0 (absolute)" }, bands, rate, ...(oracle ? { oracle, rateSource: "live oracle" } : { rateSource: "caller-supplied" }), resolved: local, parity: "verified against on-chain applyBands" },
      chainId,
      source: "chain",
      warnings,
      ...rpc,
      ctx,
    });
  } catch (err) {
    return chainReadFailed(chainId, err, warnings, ctx, resolved);
  }
}

/** Value-domain gate shared by BOTH JIT builders (maker extension + taker interaction): the
 *  protocol's fee cap and strictly-future expiry, in one place so a boundary rule can never
 *  drift between the two paths. Returns the gate envelope, or undefined when the values pass. */
function jitValueGate(chainId: ChainId, ctx: HandlerContext, swapFee: bigint, unwindFee: bigint, expiryTimestamp: bigint, nowSecs: bigint): Envelope | undefined {
  if (swapFee > 5n * 10n ** 18n || unwindFee > 5n * 10n ** 18n) {
    return unavailable(chainId, "invalid_order_terms", "JIT fee percentages are 1e18 = 1% and capped at 5e18 (5%) — this value would revert at pool creation", ctx);
  }
  if (expiryTimestamp <= nowSecs) {
    return unavailable(chainId, "invalid_order_terms", `jitMarket.expiryTimestamp ${expiryTimestamp} is not in the future (now ${nowSecs}) — pool creation requires expiryTimestamp > block.timestamp, so a fill would revert. Note this field is ABSOLUTE unix seconds, not a relative duration`, ctx);
  }
  return undefined;
}

/** Decorates a jit_side_mismatch with the WHY, when knowable: an order side that already hosts
 *  a live PoolShare of a DIFFERENT pool is a consumed nonce-based prediction (plain-CREATE share
 *  deploys are first-come-first-served — see readForeignSharePool), and the order can never fill.
 *  ONE shared emission site on purpose: duplicated identical conditionals defeat first-occurrence
 *  mutation probes (the jitValueGate/readAdapterRoles lesson). Best-effort — silent on any read
 *  failure; the jit_side_mismatch warning it decorates already stands. */
async function diagnoseStaleSidePrediction(
  client: Parameters<typeof readForeignSharePool>[0],
  sides: ReadonlyArray<readonly [string, `0x${string}`]>,
  derivedPoolId: `0x${string}`,
  warnings: Array<{ code: string; message: string }>,
  remedy: string,
): Promise<void> {
  for (const [label, side] of sides) {
    const foreign = await readForeignSharePool(client, side);
    if (foreign && foreign.toLowerCase() !== derivedPoolId.toLowerCase()) {
      warnings.push({ code: "stale_share_prediction", message: `${label} ${side} already belongs to a DIFFERENT live pool (${foreign}) — a nonce-based cST prediction consumed by an interleaving pool creation (cST/cPT deploy via plain CREATE, first-come-first-served). ${remedy}` });
    }
  }
}

/** Build the TAKER interaction (`adapter ++ abi.encode(JITMarketParams, PermitParams[])`) for
 *  lifting a resting order — the walkthrough's canonical settle path: the underwriter-taker
 *  delivers a not-yet-minted cST via takerInteraction, which always mints (enableJitMint gates
 *  only the maker-side twin). Reuses the SAME primitives as the maker-side prepare (recipe
 *  resolution, constraint staticcall, verify pre-flight, state-override share prediction), so
 *  every protocol rule stays single-sourced; only the orchestration differs — including one
 *  taker-specific guard: when the RESTING order carries its own JIT extension, the taker's
 *  params must derive the SAME pool id, or the two hooks would fight (conflict, no bytes). */
async function buildTakerJitInteraction(args: {
  ctx: HandlerContext;
  chainId: ChainId;
  lop: `0x${string}`;
  jm: {
    collateralAsset: `0x${string}`;
    referenceAsset: `0x${string}`;
    expiryTimestamp: string;
    recipe?: `0x${string}` | undefined;
    mode?: string | undefined;
    rateOverride: string;
    additionalData?: `0x${string}` | undefined;
    constraint?: { rateMin: string; rateMax: string; rateChangePerDayMax: string; rateChangeCapacityMax: string } | undefined;
    swapFeePercentage: string;
    unwindSwapFeePercentage: string;
    enableJitMint: boolean;
    permits?: Array<{ token: `0x${string}`; value: string; deadline: string; v: number; r: `0x${string}`; s: `0x${string}` }> | undefined;
  };
  taker: `0x${string}`;
  order: LopOrder;
  orderExtension: `0x${string}` | undefined;
}): Promise<{ gate: Envelope } | { gate?: undefined; interaction: `0x${string}`; jit: Record<string, unknown>; warnings: Array<{ code: string; message: string }> }> {
  const { ctx, chainId, lop, jm } = args;
  const warnings: Array<{ code: string; message: string }> = [];
  const nowSecs = nowSecondsOf(ctx);
  const swapFee = BigInt(jm.swapFeePercentage);
  const unwindFee = BigInt(jm.unwindSwapFeePercentage);
  const expiryTimestamp = BigInt(jm.expiryTimestamp);
  const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs);
  if (valueGate) return { gate: valueGate };
  const { marketRegistry: mr, warning: mrWarn } = await resolveMarketRegistry(chainId);
  if (!mr?.adapter) {
    return { gate: unavailable(chainId, "unknown_deployment", `no JIT CorkLimitOrderAdapter configured for chainId ${chainId} — JIT fills are live on Arbitrum One (42161)`, ctx) };
  }
  if (mrWarn) warnings.push(mrWarn);
  let recipe = jm.recipe;
  if (!recipe) {
    if (jm.mode === undefined) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "jitMarket", "recipe"], message: "jitMarket needs `recipe` (the approved IMarketRecipe CONTRACT ADDRESS); `mode` survives only as deprecated sugar" }]);
    }
    const hinted = mr.recipes?.[jm.mode];
    if (!hinted) {
      return { gate: unavailable(chainId, "recipe_not_found", `recipe mode '${jm.mode}' has no configured 2.1.0 recipe hint — recipes are CONTRACT ADDRESSES now (jitMarket.recipe); known mode hints: ${Object.keys(mr.recipes ?? {}).join(", ") || "none"}`, ctx) };
    }
    warnings.push({ code: "deprecation_notice", message: `jitMarket.mode is deprecated sugar: '${jm.mode}' resolved to recipe ${hinted} — pass jitMarket.recipe directly` });
    recipe = hinted;
  }
  const rateOverride = BigInt(jm.rateOverride ?? "0");
  const additionalData = (jm.additionalData ?? "0x") as `0x${string}`;
  let constraint: ResolvedConstraint | undefined = jm.constraint
    ? { rateMin: BigInt(jm.constraint.rateMin), rateMax: BigInt(jm.constraint.rateMax), rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax), rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax) }
    : undefined;
  let jit: Record<string, unknown> = { adapter: mr.adapter, hook: "takerInteraction (taker-side — always mints)", recipe };

  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    if (!constraint) {
      return { gate: unavailable(chainId, "requires_rpc", "jitMarket has no explicit constraint and no RPC resolved to derive one — set CORK_RPC_URL, or pass jitMarket.constraint (from cork_compute resolve-recipe)", ctx) };
    }
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — taker-side JIT pre-flights (adapter bindings, roles, recipe, oracle, verify, cST side-match) were SKIPPED; the interaction is built from the caller-supplied constraint but unverified" });
  } else {
    const client = resolved.client;
    try {
      const [boundLop, boundRegistry, boundController] = await Promise.all([
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "MARKET_REGISTRY" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "CONTROLLER" }),
      ]);
      if (boundLop.toLowerCase() !== lop.toLowerCase() || boundRegistry.toLowerCase() !== mr.registry.toLowerCase()) {
        return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: "the configured JIT adapter's on-chain bindings do not match this tool's LOP/registry config — refresh cork-defaults.json before broadcasting anything" }], ctx }) };
      }
      const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter);
      if (!adapterRoles.granted) {
        warnings.push({ code: "roles_not_granted", message: `the adapter is missing controller roles (POOL_CREATOR: ${adapterRoles.hasCreator}, CONFIGURATOR: ${adapterRoles.hasConfigurator}) — this fill will revert until both are granted (a governance action)` });
      }
      const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, fixedRate: rateOverride > 0n ? rateOverride : undefined, additionalData, wantConstraint: false });
      warnings.push(...res.warnings);
      if (res.gate) return { gate: res.gate };
      const { source, oracle } = res;
      if (source === "fixed" && rateOverride === 0n) {
        return { gate: unavailable(chainId, "invalid_order_terms", `recipe ${recipe} is a FIXED-rate recipe: rateOverride must carry the rate its FixedRateOracle is deployed at — zero reverts the fill`, ctx) };
      }
      if (source !== "fixed" && rateOverride !== 0n) {
        return { gate: unavailable(chainId, "invalid_order_terms", `recipe ${recipe} reads a ${source} oracle: rateOverride must be 0 — a non-zero value is REJECTED by the fill (UnexpectedRateOverride)`, ctx) };
      }
      if (!constraint) {
        const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, oracle, additionalData });
        if ("gate" in c) return { gate: c.gate };
        constraint = c.constraint;
      }
      if (oracle.address === null) {
        return { gate: unavailable(chainId, "oracle_not_deployable", `the recipe's oracle cannot be resolved (${oracle.reason ?? "pair not deployable as-registered"}) — the fill would revert`, ctx) };
      }
      if (oracle.deployed) {
        const ok = await client.readContract({ address: recipe, abi: recipeAbi, functionName: "verify", args: [jm.collateralAsset, jm.referenceAsset, oracle.address, { ...constraint }, additionalData] }).catch(() => null);
        if (ok === false) warnings.push({ code: "would_revert", message: "recipe.verify REJECTS this constraint against the live oracle right now — the fill would revert RecipeRejectedConstraint; re-resolve and rebuild" });
      }
      const derived = deriveJitMarket({ collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, constraint, oracle: oracle.address });
      jit = { ...jit, source, oracle: { address: oracle.address, deployed: oracle.deployed }, derivedPoolId: derived.poolId, constraint };
      // Consistency with the MAKER's signed intent: a resting order carrying its own JIT
      // extension pins the market the maker signed for — the taker's params must re-derive it.
      if (args.orderExtension && args.orderExtension !== "0x") {
        try {
          const makerJit = decodeJitExtension(args.orderExtension);
          const makerDerived = deriveJitMarket({ collateralAsset: makerJit.params.collateralAsset, referenceAsset: makerJit.params.referenceAsset, expiryTimestamp: makerJit.params.expiryTimestamp, constraint: makerJit.params.constraint, oracle: oracle.address });
          if (makerDerived.poolId !== derived.poolId) {
            return { gate: envelope({ state: "conflict", data: { takerDerivedPoolId: derived.poolId, makerDerivedPoolId: makerDerived.poolId }, chainId, source: "chain", warnings: [{ code: "marketid_mismatch", message: "the taker's jitMarket params derive a DIFFERENT pool id than the resting order's own JIT extension — the two hooks would target different markets and the fill would revert OrderNotForPool. Copy the params from `ch decode order` (jit label) of the resting order" }], ctx }) };
          }
        } catch {
          /* the order's extension is not a JIT payload (e.g. Fusion) — nothing to cross-check */
        }
      }
      const { dep: jitDep } = await getDep(ctx, chainId);
      const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      if (!oracle.deployed) {
        preCalls.push({ to: mr.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });
      }
      const pred = await predictShares(client, { adapter: mr.adapter, controller: boundController, poolManager: jitDep!.poolManager, market: derived.market, poolId: derived.poolId, unwindSwapFeePercentage: unwindFee, swapFeePercentage: swapFee, preCalls });
      if (pred.status === "unavailable") {
        warnings.push({ code: "share_prediction_unavailable", message: "could not predict the pool's cST (eth_simulateV1/state overrides unsupported) — VERIFY yourself that one side of the RESTING order is the derived pool's cST, or the fill reverts OrderNotForPool" });
      }
      if (pred.cst) {
        jit = { ...jit, predictedCorkSwapToken: pred.cst, permitNote: "sign the ERC-2612 permit over this cST with the TAKER as owner (spender = the LOP, value >= the cST amount) and pass it in jitMarket.permits — the LOP pulls the just-minted cST from the taker" };
        const cstLc = pred.cst.toLowerCase();
        if (args.order.makerAsset.toLowerCase() !== cstLc && args.order.takerAsset.toLowerCase() !== cstLc) {
          warnings.push({ code: "jit_side_mismatch", message: `NEITHER side of the resting order is the derived pool's cST ${pred.cst} — the fill WILL revert OrderNotForPool` });
          await diagnoseStaleSidePrediction(client, [["the resting order's makerAsset", args.order.makerAsset], ["the resting order's takerAsset", args.order.takerAsset]], derived.poolId, warnings, "This resting order can never fill; it must be re-signed against a fresh share prediction.");
        }
      }
    } catch (err) {
      if (!constraint) {
        return { gate: unavailable(chainId, "chain_read_failed", `taker-side JIT pre-flight reads failed (${revertReason(err)}) and no explicit constraint was supplied — the interaction cannot be built. Retry, or pass jitMarket.constraint`, ctx) };
      }
      warnings.push({ code: "chain_read_failed", message: `taker-side JIT pre-flight reads failed (${revertReason(err)}) — the interaction is built from the caller-supplied constraint but unverified` });
    }
  }
  const permits: PermitParams[] = (jm.permits ?? []).map((p) => ({ token: p.token, value: BigInt(p.value), deadline: BigInt(p.deadline), v: p.v, r: p.r, s: p.s }));
  const extraData = encodeJitExtraData(
    { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint: constraint!, additionalData, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint },
    permits,
  );
  const interaction = `0x${mr.adapter.slice(2)}${extraData.slice(2)}` as `0x${string}`;
  return { interaction, jit, warnings };
}

/** The DEPRECATED pre-2.1.0 JIT extension build (mode-string extraData against the OLD adapter,
 *  bands resolved at fill time) — preserved behind the deprecation gate because the OLD adapter
 *  still holds both controller roles on-chain (verified 2026-08-03): until governance grants
 *  them to the 2.1.0 adapter, this is the only FILLABLE JIT path. */
async function prepareJitLegacy(args: {
  chainId: ChainId;
  ctx: HandlerContext;
  lop: `0x${string}`;
  jm: { collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; expiryTimestamp: string; mode?: string | undefined; swapFeePercentage: string; unwindSwapFeePercentage: string; enableJitMint: boolean; permits?: Array<{ token: `0x${string}`; value: string; deadline: string; v: number; r: `0x${string}`; s: `0x${string}` }> | undefined };
  makerAsset: `0x${string}`;
  takerAsset: `0x${string}`;
}): Promise<{ gate: Envelope } | { gate?: undefined; extension: `0x${string}`; jitData: Record<string, unknown>; warnings: Array<{ code: string; message: string }> }> {
  const { chainId, ctx, lop, jm } = args;
  if (!deprecatedEnabled()) {
    return { gate: unavailable(chainId, "deprecated_gated", deprecatedGateMessage("jitMarket.legacy (the pre-2.1.0 mode-string JIT flow against the old adapter)", "The 2.1.0 flow carries a recipe ADDRESS and the resolved constraint — drop `legacy`, pass jitMarket.recipe (+ constraint or an RPC to auto-resolve it)."), ctx) };
  }
  if (jm.mode === undefined) return { gate: unavailable(chainId, "missing_filter", "legacy JIT orders need jitMarket.mode (the old registry's exact case-sensitive mode string)", ctx) };
  const mode = jm.mode;
  const { marketRegistry: mr, warning: mrWarn } = await resolveMarketRegistryLegacy(chainId);
  if (!mr?.adapter) {
    return { gate: unavailable(chainId, "unknown_deployment", `no LEGACY JIT CorkLimitOrderAdapter configured for chainId ${chainId}`, ctx) };
  }
  const warnings: Array<{ code: string; message: string }> = [
    ...(mrWarn ? [mrWarn] : []),
    { code: "deprecated", message: "this order targets the DEPRECATED pre-2.1.0 adapter/registry generation (CORK_ENABLE_DEPRECATED is set). It is currently the only path whose adapter holds the controller roles, but it derives the constraint at FILL time from the live rate — the pool id drifts with the rate, and the generation will be retired once the 2.1.0 adapter is granted its roles" },
  ];
  const jitParams: legacyRegistry.JITMarketParams = {
    collateralAsset: jm.collateralAsset,
    referenceAsset: jm.referenceAsset,
    expiryTimestamp: BigInt(jm.expiryTimestamp),
    mode,
    swapFeePercentage: BigInt(jm.swapFeePercentage),
    unwindSwapFeePercentage: BigInt(jm.unwindSwapFeePercentage),
    enableJitMint: jm.enableJitMint,
  };
  const permits: legacyRegistry.PermitParams[] = (jm.permits ?? []).map((p) => ({ token: p.token, value: BigInt(p.value), deadline: BigInt(p.deadline), v: p.v, r: p.r, s: p.s }));
  const extension = legacyRegistry.buildJitExtension(mr.adapter, legacyRegistry.encodeJitExtraData(jitParams, permits));
  let jitData: Record<string, unknown> = { generation: "legacy (pre-2.1.0)", adapter: mr.adapter, hook: "preInteraction (maker-side)", mode, enableJitMint: jm.enableJitMint };
  warnings.push({ code: "rate_drift_notice", message: "LEGACY generation: market identity follows the LIVE oracle rate — the derived pool id is only stepwise-stable, and a drifted rate reverts the fill with OrderNotForPool (by design, as a staleness guard)" });
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — legacy JIT pre-flights (adapter bindings, roles, recipe, oracle, derived pool, cST side-match) were SKIPPED; the extension is built but unverified" });
    return { extension, jitData, warnings };
  }
  const client = resolved.client;
  try {
    const [boundLop, boundRegistry, boundController] = await Promise.all([
      client.readContract({ address: mr.adapter, abi: legacyRegistry.jitAdapterAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
      client.readContract({ address: mr.adapter, abi: legacyRegistry.jitAdapterAbi, functionName: "MARKET_REGISTRY" }),
      client.readContract({ address: mr.adapter, abi: legacyRegistry.jitAdapterAbi, functionName: "CONTROLLER" }),
    ]);
    if (boundLop.toLowerCase() !== lop.toLowerCase() || boundRegistry.toLowerCase() !== mr.registry.toLowerCase()) {
      return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: "the LEGACY JIT adapter's on-chain bindings do not match this tool's legacy config — refresh cork-defaults.json before signing anything" }], ctx }) };
    }
    const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter, { creator: legacyRegistry.POOL_CREATOR_ROLE, configurator: legacyRegistry.CONFIGURATOR_ROLE });
    if (!adapterRoles.granted) {
      warnings.push({ code: "roles_not_granted", message: `the legacy adapter is missing controller roles (POOL_CREATOR: ${adapterRoles.hasCreator}, CONFIGURATOR: ${adapterRoles.hasConfigurator}) — a fill through it will revert; the generation has likely been retired. Use the 2.1.0 flow` });
    }
    const reg = { address: mr.registry, abi: legacyRegistry.marketRegistryAbi } as const;
    const [found, entry] = await client.readContract({ ...reg, functionName: "lookupRecipe", args: [mode] });
    if (!found) {
      return { gate: unavailable(chainId, "recipe_not_found", `recipe mode '${mode}' is not in the legacy registry — the fill would revert EntryNotFound`, ctx) };
    }
    const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [jm.collateralAsset, jm.referenceAsset] });
    const oracle = sim.result;
    const rate = (await client.readContract({ address: oracle, abi: rateOracleAbi, functionName: "rate" })) as bigint;
    if (rate === 0n) {
      return { gate: unavailable(chainId, "chain_read_failed", "the pair's rate oracle reports a ZERO rate — the fill would revert RateUnavailable", ctx) };
    }
    const bands: legacyRegistry.ConstraintBands = { mode: entry.mode, rateMin: entry.rateMin, rateMax: entry.rateMax, rateChangePerDayMax: entry.rateChangePerDayMax, rateChangeCapacityMax: entry.rateChangeCapacityMax };
    const derived = legacyRegistry.deriveJitMarket({ params: jitParams, oracle, rate, bands });
    jitData = { ...jitData, oracle, rateAtPrepare: rate, derivedPoolId: derived.poolId, resolvedConstraints: derived.resolved };
    const { dep: jitDep } = await getDep(ctx, chainId);
    if (jitDep?.poolManager && boundController) {
      const pred = await legacyRegistry.predictShares(client, { adapter: mr.adapter, controller: boundController, poolManager: jitDep.poolManager, market: derived.market, poolId: derived.poolId, unwindSwapFeePercentage: jitParams.unwindSwapFeePercentage, swapFeePercentage: jitParams.swapFeePercentage });
      if (pred.cst) {
        jitData = { ...jitData, predictedCorkSwapToken: pred.cst };
        const cstLc = pred.cst.toLowerCase();
        if (args.makerAsset.toLowerCase() !== cstLc && args.takerAsset.toLowerCase() !== cstLc) {
          warnings.push({ code: "jit_side_mismatch", message: `NEITHER order side is the derived pool's cST ${pred.cst} — the fill WILL revert OrderNotForPool` });
        }
      }
    }
  } catch (err) {
    warnings.push({ code: "chain_read_failed", message: `legacy JIT pre-flight reads failed (${revertReason(err)}) — the extension is built but unverified` });
  }
  return { extension, jitData, warnings };
}

/** The DEPRECATED pre-2.1.0 registry reads (mode-keyed recipes with PERCENTAGE bands, two-arg
 *  deploy, chainId-keyed asset lookup), preserved verbatim behind the deprecation gate because
 *  the old generation is still live on-chain. */
async function handleQueryRegistryLegacy(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (!deprecatedEnabled()) {
    return unavailable(chainId, "deprecated_gated", deprecatedGateMessage(`filters.legacy (the pre-2.1.0 registry generation)`, `The 2.1.0 registry is the default read path (drop filters.legacy).`), ctx);
  }
  if (input.resource === "registry-denominations" || input.resource === "registry-feeds") {
    return unavailable(chainId, "missing_filter", `${input.resource} does not exist in the pre-2.1.0 generation — drop filters.legacy`, ctx);
  }
  const { marketRegistry: mr, warning } = await resolveMarketRegistryLegacy(chainId);
  if (!mr) return unavailable(chainId, "unknown_deployment", `no LEGACY MarketRegistry configured for chainId ${chainId}`, ctx);
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) return unavailable(chainId, "requires_rpc", `MarketRegistry reads need an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx);
  const warnings: Array<{ code: string; message: string }> = [...rpcWarn(resolved), ...(warning ? [warning] : []), { code: "deprecated", message: "this is the DEPRECATED pre-2.1.0 registry generation (CORK_ENABLE_DEPRECATED is set) — its answers do not describe the 2.1.0 world" }];
  const client = resolved.client;
  const rpc = rpcProvenance(input.format, resolved);
  const reg = { address: mr.registry, abi: legacyRegistry.marketRegistryAbi } as const;
  try {
    if (input.resource === "registry-assets") {
      if (filters.address) {
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupAssetByAddress", args: [filters.address, BigInt(chainId)] });
        if (!found) return unavailable(chainId, "asset_not_found", `address ${filters.address} is not a legacy-registry asset on chainId ${chainId}`, ctx);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, count: 1, items: [entry] }, chainId, source: "chain", warnings, ...rpc, ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getAssets", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `legacy registry reports ${total} assets but this read returns the first ${page.length} — items are partial evidence` });
      }
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, count: page.length, total, items: page }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    if (input.resource === "registry-recipes") {
      if (filters.mode !== undefined) {
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupRecipe", args: [filters.mode] });
        if (!found) return unavailable(chainId, "recipe_not_found", `recipe mode '${filters.mode}' is not in the legacy registry`, ctx);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, scale: "bands are PERCENTAGES: 1e18 = 1%", items: [entry] }, chainId, source: "chain", warnings, ...rpc, ctx });
      }
      const [page, modes, total] = await client.readContract({ ...reg, functionName: "getRecipes", args: [0n, 100n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `legacy registry reports ${total} recipes but this read returns the first ${page.length} — items (and the modes list) are partial evidence; a mode absent here may still exist` });
      }
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, scale: "bands are PERCENTAGES: 1e18 = 1%", count: page.length, total, modes, items: page }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    if (!filters.collateralAsset || !filters.referenceAsset) {
      return unavailable(chainId, "missing_filter", "registry-oracle requires filters.collateralAsset AND filters.referenceAsset", ctx);
    }
    const wrapper = await client.readContract({ ...reg, functionName: "lookupWrapper", args: [filters.collateralAsset, filters.referenceAsset] });
    if (wrapper !== ZERO_ADDR) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, oracle: { address: wrapper, deployed: true, deployable: true } }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
    try {
      const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [filters.collateralAsset, filters.referenceAsset] });
      return envelope({ state: "ok", data: { resource: input.resource, chainId, collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, oracle: { address: sim.result, deployed: false, deployable: true } }, chainId, source: "chain", warnings, ...rpc, ctx });
    } catch (err) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, oracle: { address: null, deployed: false, deployable: false, reason: revertReason(err) } }, chainId, source: "chain", warnings, ...rpc, ctx });
    }
  } catch (err) {
    return chainReadFailed(chainId, err, warnings, ctx, resolved);
  }
}

/** Shared 2.1.0 recipe/oracle/constraint resolution — the exact sequence a fill's _resolveOracle
 *  runs, and the one place its rules live so cork_compute resolve-recipe, cork_query
 *  market-predict, and the JIT maker-order prepare can never disagree:
 *  1. recipe from an explicit address, or DEPRECATED mode sugar over the config hints;
 *  2. isRecipe — the only membership gate (no unverified path);
 *  3. source() decides the oracle family (ENUM TRAP: RecipeSource ≠ OracleMode ordering —
 *     oracleModeForSource does the inversion);
 *  4. oracle: explicit override → fixed-rate (keyed on the rate) → pair wrapper (live, else the
 *     simulated-deploy prediction);
 *  5. optionally the constraint via recipe.resolve — the staticcall gets the LIVE oracle only
 *     when one is deployed; a predicted/absent oracle is passed as address(0), which is what
 *     lets the liquidity recipe fall back to the anchorRate in additionalData (API parity). */
interface RecipeResolution {
  gate?: Envelope;
  recipe: `0x${string}`;
  source: RecipeSourceName;
  oracle: { address: `0x${string}` | null; deployed: boolean; deployable: boolean; mode: OracleModeName | null; rate: bigint | null; reason?: string };
  constraint?: ResolvedConstraint;
  warnings: Array<{ code: string; message: string }>;
}

async function resolveRecipeOracleConstraint(args: {
  client: RegistryClient;
  ctx: HandlerContext;
  chainId: ChainId;
  mr: { registry: `0x${string}`; recipes?: Record<string, `0x${string}`> | undefined };
  recipe?: `0x${string}` | undefined;
  mode?: string | undefined;
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  fixedRate?: bigint | undefined;
  rateOracle?: `0x${string}` | undefined;
  additionalData?: `0x${string}` | undefined;
  wantConstraint: boolean;
}): Promise<RecipeResolution> {
  const { client, ctx, chainId, mr } = args;
  const warnings: Array<{ code: string; message: string }> = [];
  const bad = (g: Envelope): RecipeResolution => ({ gate: g, recipe: ZERO_ADDR, source: "price", oracle: { address: null, deployed: false, deployable: false, mode: null, rate: null }, warnings });
  const reg = { address: mr.registry, abi: marketRegistryAbi } as const;
  // 1+2: the recipe address, and its membership.
  let recipe = args.recipe;
  if (!recipe) {
    if (args.mode === undefined) {
      return bad(unavailable(chainId, "missing_filter", "a recipe CONTRACT ADDRESS is required (recipes replaced mode strings in 2.1.0) — discover them with cork_query resource:\"registry-recipes\"", ctx));
    }
    const hinted = mr.recipes?.[args.mode];
    if (!hinted) {
      return bad(unavailable(chainId, "recipe_not_found", `recipe mode '${args.mode}' has no configured 2.1.0 recipe hint — recipes are CONTRACT ADDRESSES now; known mode hints: ${Object.keys(mr.recipes ?? {}).join(", ") || "none"}. Discover recipes with cork_query resource:"registry-recipes"`, ctx));
    }
    warnings.push({ code: "deprecation_notice", message: `mode is deprecated sugar: '${args.mode}' resolved to recipe ${hinted} via this tool's config hints — pass the recipe address directly; mode will be removed in a later release` });
    recipe = hinted;
  }
  const isRecipe = await client.readContract({ ...reg, functionName: "isRecipe", args: [recipe] });
  if (!isRecipe) {
    return bad(unavailable(chainId, "recipe_not_found", `${recipe} is not an approved recipe on this registry (isRecipe is the only membership gate) — a fill would revert RecipeNotRegistered. List recipes with cork_query resource:"registry-recipes"`, ctx));
  }
  // 3: the recipe's source decides the oracle family.
  const sourceOrdinal = (await client.readContract({ address: recipe, abi: recipeAbi, functionName: "source" })) as number;
  const source = RECIPE_SOURCE[sourceOrdinal];
  if (!source) return bad(unavailable(chainId, "chain_read_failed", `recipe ${recipe} reports unknown source ordinal ${sourceOrdinal}`, ctx));
  // 4: oracle resolution.
  let oracle: RecipeResolution["oracle"];
  if (args.rateOracle) {
    const code = await client.getCode({ address: args.rateOracle }).catch(() => undefined);
    const deployed = code !== undefined && code !== "0x";
    const rate = deployed ? ((await client.readContract({ address: args.rateOracle, abi: rateOracleAbi, functionName: "rate" }).catch(() => null)) as bigint | null) : null;
    oracle = { address: args.rateOracle, deployed, deployable: true, mode: null, rate };
  } else if (source === "fixed") {
    if (args.fixedRate === undefined) {
      oracle = { address: null, deployed: false, deployable: true, mode: null, rate: null, reason: "a FIXED recipe's oracle is keyed on the RATE — pass the rate (rateOverride) to predict it" };
    } else {
      const predicted = (await client.readContract({ ...reg, functionName: "predictFixedRateOracle", args: [args.fixedRate] })) as `0x${string}`;
      const code = await client.getCode({ address: predicted }).catch(() => undefined);
      const deployed = code !== undefined && code !== "0x";
      oracle = { address: predicted, deployed, deployable: true, mode: null, rate: deployed ? args.fixedRate : null };
    }
  } else {
    const modeName: OracleModeName = source;
    const wrapper = (await client.readContract({ ...reg, functionName: "lookupWrapper", args: [args.collateralAsset, args.referenceAsset, ORACLE_MODE[modeName]] })) as `0x${string}`;
    if (wrapper !== ZERO_ADDR) {
      const rate = (await client.readContract({ address: wrapper, abi: rateOracleAbi, functionName: "rate" }).catch(() => null)) as bigint | null;
      oracle = { address: wrapper, deployed: true, deployable: true, mode: modeName, rate };
    } else {
      try {
        const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [args.collateralAsset, args.referenceAsset, ORACLE_MODE[modeName]] });
        oracle = { address: sim.result as `0x${string}`, deployed: false, deployable: true, mode: modeName, rate: null };
      } catch (err) {
        oracle = { address: null, deployed: false, deployable: false, mode: modeName, rate: null, reason: revertReason(err) };
      }
    }
  }
  const base: RecipeResolution = { recipe, source, oracle, warnings };
  // 5: the constraint — recipe.resolve with the API's exact oracle-passing semantics.
  if (args.wantConstraint) {
    const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: args.collateralAsset, referenceAsset: args.referenceAsset, oracle, additionalData: args.additionalData });
    if ("gate" in c) return { ...base, gate: c.gate };
    base.constraint = c.constraint;
  }
  return base;
}

/** The recipe.resolve staticcall itself, shared by the resolution helper and the JIT prepare
 *  (which needs its coherence checks BETWEEN oracle resolution and constraint resolution). The
 *  call gets the LIVE oracle only when one is deployed; predicted/absent → address(0). */
async function staticResolveConstraint(
  client: RegistryClient,
  ctx: HandlerContext,
  chainId: ChainId,
  args: { recipe: `0x${string}`; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; oracle: RecipeResolution["oracle"]; additionalData?: `0x${string}` | undefined },
): Promise<{ constraint: ResolvedConstraint } | { gate: Envelope }> {
  const oracleForCall = args.oracle.deployed && args.oracle.address ? args.oracle.address : ZERO_ADDR;
  try {
    const c = (await client.readContract({ address: args.recipe, abi: recipeAbi, functionName: "resolve", args: [args.collateralAsset, args.referenceAsset, oracleForCall, args.additionalData ?? "0x"] })) as { rateMin: bigint; rateMax: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint };
    return { constraint: { rateMin: c.rateMin, rateMax: c.rateMax, rateChangePerDayMax: c.rateChangePerDayMax, rateChangeCapacityMax: c.rateChangeCapacityMax } };
  } catch (err) {
    return { gate: unavailable(chainId, "recipe_refused", `the recipe refused to resolve a constraint for this input: ${revertReason(err)}. Typical causes: the liquidity recipe needs additionalData = abi.encode(uint256 anchorRate) while the pair's oracle is not deployed; the fixed-rate recipe needs its FixedRateOracle DEPLOYED (cork_prepare_market deploy-fixed-oracle) and rejects any additionalData`, ctx) };
  }
}

/** market-predict: derive the market a JIT LOP fill would produce for (collateralAsset,
 *  referenceAsset, expiry, recipe [+args/rate]) BEFORE it exists — the recipe's oracle (+ live
 *  rate), the OFF-CHAIN-resolved constraint, pool id, cST/cPT tokens, and whether the pool
 *  already exists. Composes the shared recipe resolution + our verified computeMarketId + a
 *  state-override share simulation — the same derivation the adapter runs at fill time.
 *  Chain-native (no dependency on the read API); the pool id is computed LOCALLY. Like the HTTP
 *  endpoint, market/shares are null while the pair oracle is undeployed — without a live rate
 *  the identity would be an invention. */
async function handleQueryMarketPredict(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (!filters.collateralAsset || !filters.referenceAsset || filters.expiry === undefined || (filters.recipe === undefined && filters.mode === undefined)) {
    return unavailable(chainId, "missing_filter", "market-predict requires filters.collateralAsset, filters.referenceAsset (ORDER MATTERS: collateral first), filters.expiry (unix seconds), and filters.recipe (the approved recipe CONTRACT ADDRESS — discover with cork_query resource:\"registry-recipes\"; filters.mode survives as deprecated sugar). Optional: filters.args (recipe additionalData hex), filters.rate (FIXED recipes: the rateOverride), filters.rateOracle (explicit oracle)", ctx);
  }
  if (filters.collateralAsset.toLowerCase() === filters.referenceAsset.toLowerCase()) {
    // Well-formed inputs that violate a domain rule → envelope (exit 3), not a throw — same class
    // as rollover's invalid_order_terms. Only unparseable/format faults throw (exit 2).
    return unavailable(chainId, "invalid_pair", "collateralAsset and referenceAsset must differ — a market is a pair of distinct assets", ctx);
  }
  const r = await getRegistry(ctx, chainId);
  if (r.gate) return r.gate;
  const { mr, resolved, warnings } = r;
  const client = resolved.client;
  const rpc = rpcProvenance(input.format, resolved);
  const ca = filters.collateralAsset, ref = filters.referenceAsset, expiry = filters.expiry;
  const inputEcho = { collateralAsset: ca, referenceAsset: ref, expiry, ...(filters.recipe ? { recipe: filters.recipe } : {}), ...(filters.mode ? { mode: filters.mode } : {}) };
  try {
    const bindingWarn = await registryBindingMismatch(client, chainId, mr);
    if (bindingWarn) {
      return envelope({ state: "conflict", data: { resource: input.resource, chainId, registry: mr.registry, adapter: mr.adapter }, chainId, source: "chain", warnings: [...warnings, bindingWarn], ...rpc, ctx });
    }
    const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe: filters.recipe, mode: filters.mode, collateralAsset: ca, referenceAsset: ref, fixedRate: filters.rate, rateOracle: filters.rateOracle, additionalData: filters.args, wantConstraint: true });
    warnings.push(...res.warnings);
    if (res.gate) return res.gate;
    const { recipe, source, oracle, constraint } = res;
    const oracleEcho = { address: oracle.address, deployed: oracle.deployed, deployable: oracle.deployable, ...(oracle.mode ? { mode: oracle.mode } : {}), ...(oracle.rate !== null ? { rate: oracle.rate } : {}), ...(oracle.reason ? { reason: oracle.reason } : {}) };
    // Identity needs an oracle ADDRESS, not a deployed oracle: the pool id's only oracle-derived
    // input is the address (already predicted via the simulated deploy — the same one the fill
    // will run), and the constraint can resolve from the recipe's anchor fallback. Nothing has to
    // be deployed first — the fill deploys the oracle inside the transaction that needs it. This
    // deliberately EXCEEDS today's HTTP endpoint, which still nulls market/shares whenever the
    // oracle has no code and forces agents to deploy the wrapper just to learn the share
    // addresses (the walkthrough calls that behavior out as a caveat).
    if (oracle.address === null) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, input: inputEcho, recipe, source, oracle: oracleEcho, ...(constraint ? { constraint: { ...constraint, scale: "ABSOLUTE rates, 1e18 = 1.0" } } : {}), market: null, shares: null }, chainId, source: "chain", warnings: [...warnings, { code: "oracle_not_deployable", message: `this pair cannot get a ${source} oracle as-registered (${oracle.reason ?? "unregistered asset / missing source or conversion path"}) — a JIT fill would revert; nothing further can be predicted` }], ...rpc, ctx });
    }
    if (oracle.deployed && oracle.rate === 0n) return unavailable(chainId, "chain_read_failed", "the rate oracle reports a ZERO rate (RateUnavailable) — a fill creating this market would revert and the identity cannot be derived", ctx);
    // Identity: constraint + oracle → Market struct → LOCAL poolId (verified computeMarketId).
    if (!constraint) return unavailable(chainId, "recipe_refused", "the recipe did not resolve a constraint — the market identity cannot be derived", ctx);
    let derived: ReturnType<typeof deriveJitMarket>;
    try {
      derived = deriveJitMarket({ collateralAsset: ca, referenceAsset: ref, expiryTimestamp: expiry, constraint, oracle: oracle.address });
    } catch (err) {
      return localComputeFailed(chainId, err, warnings, ctx);
    }
    // cST / cPT — pinned when the pool exists, else predicted via the state-override simulation.
    // With an UNDEPLOYED oracle the simulation prepends the same permissionless deploy the fill
    // performs, so the pool creates in-memory and the share addresses come back real.
    const { dep } = await getDep(ctx, chainId);
    let shares: PredictSharesResult = { exists: false, status: "unavailable" };
    if (dep?.poolManager && mr.controller && mr.adapter) {
      const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      if (!oracle.deployed) {
        preCalls.push({ to: mr.registry, data: source === "fixed" && filters.rate !== undefined ? buildDeployFixedRateOracleCall(filters.rate) : buildDeployOracleCall(ca, ref, oracle.mode ?? "price") });
      }
      shares = await predictShares(client, { adapter: mr.adapter, controller: mr.controller, poolManager: dep.poolManager, market: derived.market, poolId: derived.poolId, preCalls });
    }
    const extra: Array<{ code: string; message: string }> = [];
    if (shares.status === "unavailable") extra.push({ code: "share_prediction_unavailable", message: "could not predict the pool's cST/cPT (eth_simulateV1/state overrides unsupported, or config missing) — the pool id, oracle, and constraint above are still valid" });
    if (!shares.exists && !oracle.deployed) {
      extra.push({ code: "oracle_not_deployed", message: "the oracle is not deployed and does not need to be: the fill deploys it (permissionless, idempotent) at this PREDICTED address inside the same transaction, and the pool id's only oracle-derived input is that address. The identity above is stable unless the pair's registered sources change before the fill (a re-registration shifts the predicted address → OrderNotForPool)" });
    } else if (!shares.exists) {
      extra.push({ code: "rate_drift_notice", message: "the pool does not exist yet, so this prediction is conditioned on TODAY's oracle rate and drifts stepwise until pinned. In 2.1.0 the pinning moment is EARLIER than pool creation: an order that CARRIES this constraint fixes the pool id and share addresses at signing — sign, and this identity holds however far the rate moves (staleness then guards via recipe.verify, not a moving id)" });
    }
    // T6: a prediction can be internally consistent yet describe an UNCREATABLE market — say so.
    const nowSecs = nowSecondsOf(ctx);
    if (!shares.exists && expiry <= nowSecs) {
      extra.push({ code: "would_revert", message: `expiry ${expiry} is not in the future (now ${nowSecs}) — createNewPool requires a future expiry, so a JIT fill for this market would revert; the identity below is for a market that cannot be created` });
    }
    if (constraint.rateMin <= 0n || constraint.rateMin >= constraint.rateMax) {
      extra.push({ code: "would_revert", message: `the resolved constraint violates createNewPool's requirements (needs 0 < rateMin < rateMax; rateMin=${constraint.rateMin}, rateMax=${constraint.rateMax}) — a JIT fill for this recipe would revert InvalidParams` });
    }
    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        chainId,
        input: inputEcho,
        recipe,
        source,
        oracle: oracleEcho,
        market: { poolId: derived.poolId, exists: shares.exists, scale: "the constraint is ABSOLUTE rates, 1e18 = 1.0", constraint },
        shares: shares.cst || shares.cpt ? { corkSwapToken: shares.cst ?? null, corkPrincipalToken: shares.cpt ?? null, source: shares.status } : null,
      },
      chainId,
      source: "chain",
      warnings: [...warnings, ...extra],
      ...rpc,
      ctx,
    });
  } catch (err) {
    return chainReadFailed(chainId, err, warnings, ctx, resolved);
  }
}

/** cork_prepare_market: unsigned oracle-infrastructure txs against the 2.1.0 registry —
 *  deploy-wrapper = MarketRegistry.deploy(ca, ref, mode) (mode-keyed: one pair can hold a PRICE
 *  and a NAV wrapper at different addresses); deploy-fixed-oracle =
 *  MarketRegistry.deployFixedRateOracle(rate) (keyed on the RATE, no pair). Both are
 *  permissionless + idempotent on-chain; the pre-flight read is best-effort disclosure. */
async function handlePrepareMarket(
  input: { chainId: ChainId; clientRequestId: string; action: { type: "deploy-wrapper"; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; mode?: "price" | "nav" } | { type: "deploy-fixed-oracle"; rate: string }; format: "concise" | "full" },
  ctx: HandlerContext,
): Promise<Envelope> {
  const chainId = input.chainId;
  const { marketRegistry: mr, warning } = await resolveMarketRegistry(chainId);
  if (!mr) {
    return unavailable(chainId, "unknown_deployment", `no MarketRegistry configured for chainId ${chainId} — the registry is live on Arbitrum One (42161)`, ctx);
  }
  const warnings: Array<{ code: string; message: string }> = warning ? [warning] : [];
  const a = input.action;
  const resolved = await getRpc(ctx, chainId);
  if (resolved) warnings.push(...rpcWarn(resolved));
  const reg = { address: mr.registry, abi: marketRegistryAbi } as const;

  if (a.type === "deploy-fixed-oracle") {
    const rate = BigInt(a.rate);
    if (rate === 0n) return unavailable(chainId, "invalid_order_terms", "a zero fixed rate cannot have an oracle — the FixedRateOracle constructor reverts on 0; sending this tx would revert", ctx);
    const calldata = buildDeployFixedRateOracleCall(rate);
    let status: Record<string, unknown> = {};
    if (resolved) {
      try {
        const predicted = await resolved.client.readContract({ ...reg, functionName: "predictFixedRateOracle", args: [rate] });
        const code = await resolved.client.getCode({ address: predicted }).catch(() => undefined);
        const deployed = code !== undefined && code !== "0x";
        status = { oracle: { address: predicted, deployed } };
        if (deployed) warnings.push({ code: "oracle_already_deployed", message: `the fixed-rate oracle for rate ${rate} already exists at ${predicted} (CREATE2-salted by the rate: one oracle per rate per chain) — the tx is a safe no-op (deploy is idempotent)` });
      } catch (err) {
        warnings.push({ code: "chain_read_failed", message: `the predictFixedRateOracle pre-check failed (${revertReason(err)}) — the calldata is exact regardless` });
      }
    } else {
      warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the deployability pre-check was skipped; the calldata is exact regardless" });
    }
    return envelope({
      state: "ok",
      data: { kind: "deploy-fixed-oracle", to: mr.registry, calldata, value: "0", rate, scale: "rate is ABSOLUTE, 1e18 = 1.0", ...status, clientRequestId: input.clientRequestId },
      chainId,
      source: resolved ? "chain" : "config",
      warnings,
      ctx,
    });
  }

  const modeName: OracleModeName = a.mode ?? "price";
  const modeNote = a.mode === undefined ? { modeNote: "no mode given — defaulted to 'price'; oracles are MODE-KEYED in 2.1.0 (one pair can hold a price AND a nav wrapper at different addresses), pass mode:'nav' when you mean nav" } : {};
  const calldata = buildDeployOracleCall(a.collateralAsset, a.referenceAsset, modeName);

  // Best-effort status read (calldata building is pure; the tx is safe either way).
  let status: Record<string, unknown> = {};
  if (resolved) {
    try {
      const wrapper = await resolved.client.readContract({ ...reg, functionName: "lookupWrapper", args: [a.collateralAsset, a.referenceAsset, ORACLE_MODE[modeName]] });
      if (wrapper !== ZERO_ADDR) {
        // Same oracle:{address,deployed} shape as cork_query registry-oracle / market-predict.
        status = { oracle: { address: wrapper, deployed: true } };
        warnings.push({ code: "oracle_already_deployed", message: `this pair's ${modeName} oracle already exists at ${wrapper} — the tx is a safe no-op (deploy is idempotent and returns the recorded address)` });
      } else {
        const sim = await resolved.client.simulateContract({ ...reg, functionName: "deploy", args: [a.collateralAsset, a.referenceAsset, ORACLE_MODE[modeName]] });
        status = { oracle: { address: sim.result, deployed: false } };
      }
    } catch (err) {
      warnings.push({ code: "oracle_not_deployable", message: `the deploy simulation reverted (${revertReason(err)}) — typically an unregistered asset, a missing source for this mode, or no conversion path; sending this tx would revert. Check cork_query registry-assets / registry-oracle` });
    }
  } else {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the deployability pre-check was skipped; the calldata is exact regardless" });
  }
  return envelope({
    state: "ok",
    data: { kind: "deploy-wrapper", to: mr.registry, calldata, value: "0", collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, mode: modeName, ...modeNote, ...status, clientRequestId: input.clientRequestId },
    chainId,
    source: resolved ? "chain" : "config",
    warnings,
    ctx,
  });
}

async function handlePrepareOrders(input: PrepareOrdersInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const action = input.action;

  if (action.type === "finalize-maker-order") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const p = action.prepared;
    if (p.clientRequestId !== input.clientRequestId || p.typedData.domain.chainId !== chainId || !isAddressEqual(p.lop, lop) || !isAddressEqual(p.typedData.domain.verifyingContract, lop)) {
      return envelope({
        state: "conflict",
        data: null,
        chainId,
        source: "config",
        warnings: [{ code: "prepared_context_mismatch", message: "prepared order clientRequestId / chainId / verifying contract does not match this finalization request" }],
        ctx,
      });
    }
    const m = p.typedData.message;
    try {
      const finalized = await finalizeMakerOrder({
        chainId,
        lop,
        order: { salt: BigInt(m.salt), maker: m.maker, receiver: m.receiver, makerAsset: m.makerAsset, takerAsset: m.takerAsset, makingAmount: BigInt(m.makingAmount), takingAmount: BigInt(m.takingAmount), makerTraits: BigInt(m.makerTraits) },
        claimedOrderHash: p.orderHash,
        signature: action.signature,
        extension: p.extension,
      });
      const submitInput = {
        chainId,
        clientRequestId: input.clientRequestId,
        action: {
          type: "lop-order" as const,
          order: { salt: finalized.order.salt.toString(), maker: finalized.order.maker, receiver: finalized.order.receiver, makerAsset: finalized.order.makerAsset, takerAsset: finalized.order.takerAsset, makingAmount: finalized.order.makingAmount.toString(), takingAmount: finalized.order.takingAmount.toString(), makerTraits: finalized.order.makerTraits.toString() },
          signature: finalized.signature,
          extension: finalized.extension,
          side: action.listing.side,
          premium: action.listing.premium,
          expiry: action.listing.expiry,
          nonce: action.listing.nonce,
          allowsPartialFills: action.listing.allowsPartialFills,
          makerAccountType: "EOA" as const,
          makerPermit2: "0x" as const,
          ...(action.listing.quoteRef ? { quoteRef: action.listing.quoteRef } : {}),
        },
        format: input.format,
      };
      // The gate-facing artifact is content-addressed so an independent policy gate can pin
      // exactly what it admitted before submit.
      const artifact = { kind: "signed-maker-order", orderHash: finalized.orderHash, recoveredSigner: finalized.recoveredSigner, signature: finalized.signature, extension: finalized.extension, submitInput };
      return envelope({
        state: "ok",
        data: { ...artifact, signedArtifactDigest: verificationDigest(artifact), callerSigned: true, helperSigned: false },
        chainId,
        source: "config",
        warnings: [{ code: "caller_signed_artifact", message: "signature verified and recovered, not created [K1]; pass submitInput verbatim to cork_submit after your independent policy gate admits this artifact" }],
        ctx,
      });
    } catch (err) {
      return envelope({
        state: "conflict",
        data: null,
        chainId,
        source: "config",
        warnings: [{ code: "signature_or_reconstruction_mismatch", message: err instanceof Error ? err.message : "maker order finalization failed" }],
        ctx,
      });
    }
  }

  if (action.type === "maker-order") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const nowSecs = nowSecondsOf(ctx);

    // ── optional JIT market block (2.1.0): the order names a RECIPE CONTRACT and carries the
    // OFF-CHAIN-resolved constraint — filled from one recipe.resolve call here, so the three
    // coupled fields (recipe, constraint, additionalData) are guaranteed to agree. Pool id and
    // share addresses are PINNED at signing; on-chain staleness protection is recipe.verify. ──
    let extension = action.extension;
    const warnings: Array<{ code: string; message: string }> = [];
    let jitData: Record<string, unknown> | undefined;
    if (action.jitMarket) {
      if (action.extension !== undefined && action.extension !== "0x") {
        throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "extension"], message: "extension and jitMarket are mutually exclusive — jitMarket BUILDS the extension" }]);
      }
      const jm = action.jitMarket;
      // Value-domain checks shared by both generations AND both hook sides (envelope, exit 3 —
      // not format throws): one gate, so the boundary rules cannot drift between paths.
      const swapFee = BigInt(jm.swapFeePercentage);
      const unwindFee = BigInt(jm.unwindSwapFeePercentage);
      const expiryTimestamp = BigInt(jm.expiryTimestamp);
      const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs);
      if (valueGate) return valueGate;
      const FIVE_YEARS = 5n * 31_557_600n;
      if (expiryTimestamp > nowSecs + FIVE_YEARS) {
        warnings.push({ code: "expiry_far_future", message: `jitMarket.expiryTimestamp ${expiryTimestamp} is more than 5 years out — cPT principal stays locked until expiry, and the chain enforces NO upper bound; double-check this is intended` });
      }

      // DEPRECATED generation: mode-string extraData against the old adapter, behind the gate.
      if (jm.legacy) {
        const leg = await prepareJitLegacy({ chainId, ctx, lop, jm, makerAsset: action.makerAsset, takerAsset: action.takerAsset });
        if (leg.gate) return leg.gate;
        extension = leg.extension;
        jitData = leg.jitData;
        warnings.push(...leg.warnings);
      } else {
        const { marketRegistry: mr, warning: mrWarn } = await resolveMarketRegistry(chainId);
        if (!mr?.adapter) {
          return unavailable(chainId, "unknown_deployment", `no JIT CorkLimitOrderAdapter configured for chainId ${chainId} — JIT market orders are live on Arbitrum One (42161)`, ctx);
        }
        if (mrWarn) warnings.push(mrWarn);
        // Recipe: explicit address, or DEPRECATED mode sugar over the config hints (config-only,
        // so the sugar also works offline).
        let recipe = jm.recipe;
        if (!recipe) {
          if (jm.mode === undefined) {
            throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "jitMarket", "recipe"], message: "jitMarket needs `recipe` (the approved IMarketRecipe CONTRACT ADDRESS — discover with cork_query resource:\"registry-recipes\"); `mode` survives only as deprecated sugar" }]);
          }
          const hinted = mr.recipes?.[jm.mode];
          if (!hinted) {
            return unavailable(chainId, "recipe_not_found", `recipe mode '${jm.mode}' has no configured 2.1.0 recipe hint — recipes are CONTRACT ADDRESSES now (jitMarket.recipe); known mode hints: ${Object.keys(mr.recipes ?? {}).join(", ") || "none"}`, ctx);
          }
          warnings.push({ code: "deprecation_notice", message: `jitMarket.mode is deprecated sugar: '${jm.mode}' resolved to recipe ${hinted} via this tool's config hints — pass jitMarket.recipe directly; mode will be removed in a later release` });
          recipe = hinted;
        }
        const rateOverride = BigInt(jm.rateOverride ?? "0");
        const additionalData = (jm.additionalData ?? "0x") as `0x${string}`;
        let constraint: ResolvedConstraint | undefined = jm.constraint
          ? { rateMin: BigInt(jm.constraint.rateMin), rateMax: BigInt(jm.constraint.rateMax), rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax), rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax) }
          : undefined;
        jitData = { adapter: mr.adapter, hook: "preInteraction (maker-side)", recipe, enableJitMint: jm.enableJitMint };

        // Chain pre-flights + constraint resolution; every gap is disclosed, never guessed.
        const resolved = await getRpc(ctx, chainId);
        if (!resolved) {
          if (!constraint) {
            return unavailable(chainId, "requires_rpc", "jitMarket has no explicit constraint and no RPC resolved to derive one — the constraint comes from recipe.resolve and is PART OF THE SIGNED ORDER. Either set CORK_RPC_URL, or pass jitMarket.constraint (from cork_compute resolve-recipe) for offline byte-building", ctx);
          }
          warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — JIT pre-flights (adapter bindings, roles, recipe membership, source/rateOverride coherence, oracle, verify, cST side-match) were SKIPPED; the extension is built from the caller-supplied constraint but unverified" });
        } else {
          const client = resolved.client;
          try {
            // Adapter is volatile config: re-verify its bindings + role grants on every prepare.
            const [boundLop, boundRegistry, boundController] = await Promise.all([
              client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
              client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "MARKET_REGISTRY" }),
              client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "CONTROLLER" }),
            ]);
            if (boundLop.toLowerCase() !== lop.toLowerCase() || boundRegistry.toLowerCase() !== mr.registry.toLowerCase()) {
              return envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: "the configured JIT adapter's on-chain bindings do not match this tool's LOP/registry config — a stale/previous-generation address (the old registry answers 2.1.0 calls with misdecoded garbage); refresh cork-defaults.json before signing anything" }], ctx });
            }
            const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter);
            if (!adapterRoles.granted) {
              warnings.push({ code: "roles_not_granted", message: `the adapter is missing controller roles (POOL_CREATOR: ${adapterRoles.hasCreator}, CONFIGURATOR: ${adapterRoles.hasConfigurator}) — a fill through it will revert until both are granted (a governance action, not a code change); the order is signable but not yet fillable` });
            }
            const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, fixedRate: rateOverride > 0n ? rateOverride : undefined, additionalData, wantConstraint: false });
            warnings.push(...res.warnings);
            if (res.gate) return res.gate;
            const { source, oracle } = res;
            // rateOverride ↔ source coherence — checked BEFORE constraint resolution so the
            // caller gets the real rule, not a downstream recipe revert: the fill REJECTS a
            // non-zero override on a price/nav recipe (UnexpectedRateOverride), and a fixed
            // fill deploys FixedRateOracle(rateOverride), whose constructor reverts on 0.
            if (source === "fixed" && rateOverride === 0n) {
              return unavailable(chainId, "invalid_order_terms", `recipe ${recipe} is a FIXED-rate recipe: the order must carry rateOverride (the rate its FixedRateOracle is deployed at) — zero reverts the fill in the oracle constructor`, ctx);
            }
            if (source !== "fixed" && rateOverride !== 0n) {
              return unavailable(chainId, "invalid_order_terms", `recipe ${recipe} reads a ${source} oracle: rateOverride must be 0 — a non-zero value is REJECTED by the fill (UnexpectedRateOverride), not ignored`, ctx);
            }
            if (!constraint) {
              const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, oracle, additionalData });
              if ("gate" in c) return c.gate;
              constraint = c.constraint;
            }
            if (oracle.address === null) {
              return unavailable(chainId, "oracle_not_deployable", `the recipe's oracle cannot be resolved (${oracle.reason ?? "pair not deployable as-registered"}) — a fill would revert; check cork_query registry-assets / registry-oracle`, ctx);
            }
            // Verify pre-flight — the exact staticcall the fill runs (step 4). Only meaningful
            // against a DEPLOYED oracle: the liquidity recipe checks the LIVE rate sits inside
            // the window, so a predicted oracle can't answer yet (the fill deploys it first).
            if (oracle.deployed) {
              const ok = await client.readContract({ address: recipe, abi: recipeAbi, functionName: "verify", args: [jm.collateralAsset, jm.referenceAsset, oracle.address, { ...constraint }, additionalData] }).catch(() => null);
              if (ok === false) {
                warnings.push({ code: "would_revert", message: "recipe.verify REJECTS this constraint against the live oracle right now — the fill would revert RecipeRejectedConstraint (the constraint is stale, or was never one this recipe would produce). Re-resolve it (cork_compute resolve-recipe) and rebuild" });
              } else if (ok === null) {
                warnings.push({ code: "chain_read_failed", message: "the recipe.verify pre-flight read failed — the fill's constraint check could not be previewed" });
              }
            } else {
              warnings.push({ code: "oracle_not_deployed", message: `the recipe's oracle is not deployed yet (predicted ${oracle.address}) — the fill deploys it automatically, then recipe.verify re-checks the carried constraint against the LIVE rate. The pool id below assumes the predicted oracle address; re-registering the pair's sources before the fill would shift it and revert OrderNotForPool` });
            }
            const derived = deriveJitMarket({ collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, constraint, oracle: oracle.address });
            jitData = { ...jitData, source, oracle: { address: oracle.address, deployed: oracle.deployed, ...(oracle.rate !== null ? { rate: oracle.rate } : {}) }, derivedPoolId: derived.poolId, constraint, identity: "PINNED at signing: the constraint is carried in the order, so this pool id and the predicted share addresses hold however far the rate moves (2.1.0)" };
            warnings.push({ code: "constraint_window_notice", message: "staleness is now guarded by recipe.verify at fill time, not a moving pool id: if the live rate walks outside the carried constraint's window, fills revert RecipeRejectedConstraint until you re-resolve and sign a fresh order" });

            // Predicted cST: direct read when the pool exists; otherwise the state-override
            // simulation (role granted in-memory — works before AND after the governance grant).
            // When the oracle is not deployed, the simulation prepends the SAME permissionless
            // deploy the fill performs, so the pool actually creates in-memory.
            const { dep: jitDep } = await getDep(ctx, chainId);
            const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
            if (!oracle.deployed) {
              preCalls.push({ to: mr.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });
            }
            const pred = await predictShares(client, {
              adapter: mr.adapter,
              controller: boundController,
              poolManager: jitDep!.poolManager,
              market: derived.market,
              poolId: derived.poolId,
              unwindSwapFeePercentage: unwindFee,
              swapFeePercentage: swapFee,
              preCalls,
            });
            const cst = pred.cst;
            if (pred.status === "unavailable") {
              warnings.push({ code: "share_prediction_unavailable", message: "could not predict the new pool's cST address (eth_simulateV1/state overrides unsupported or simulation failed) — VERIFY yourself that one order side is the derived pool's cST, or the fill reverts OrderNotForPool; the ERC-2612 permit must also be signed over that cST" });
            }
            if (cst) {
              jitData = { ...jitData, predictedCorkSwapToken: cst, permitNote: "for a NEW pool, sign an ERC-2612 permit over this cST (owner = maker, spender = the LOP, value >= the cST amount) and pass it in jitMarket.permits — a fresh token has no prior allowance for the LOP's pull" };
              const cstLc = cst.toLowerCase();
              if (action.makerAsset.toLowerCase() !== cstLc && action.takerAsset.toLowerCase() !== cstLc) {
                warnings.push({ code: "jit_side_mismatch", message: `NEITHER order side is the derived pool's cST ${cst} — the fill WILL revert OrderNotForPool. Set makerAsset (selling coverage) or takerAsset (buying coverage) to the predicted cST` });
                await diagnoseStaleSidePrediction(client, [["makerAsset", action.makerAsset], ["takerAsset", action.takerAsset]], derived.poolId, warnings, "Re-run market-predict and set the order side to the FRESH predicted cST before signing.");
              }
            }
          } catch (err) {
            if (!constraint) {
              return unavailable(chainId, "chain_read_failed", `the JIT pre-flight reads failed (${revertReason(err)}) and no explicit constraint was supplied — the constraint comes from recipe.resolve and is PART OF THE SIGNED ORDER, so the extension cannot be built. Retry, or pass jitMarket.constraint from cork_compute resolve-recipe`, ctx);
            }
            warnings.push({ code: "chain_read_failed", message: `JIT pre-flight reads failed (${revertReason(err)}) — the extension is built from the caller-supplied constraint but unverified` });
          }
        }
        const permits: PermitParams[] = (jm.permits ?? []).map((p) => ({ token: p.token, value: BigInt(p.value), deadline: BigInt(p.deadline), v: p.v, r: p.r, s: p.s }));
        extension = buildJitExtension(
          mr.adapter,
          encodeJitExtraData(
            { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint: constraint!, additionalData, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint },
            permits,
          ),
        );
      }
    }

    // ── optional Cork-native decaying-premium auction (fusion plan F2): the deployed Fusion
    // settlement rides as a pure AMOUNT GETTER (no postInteraction → fills stay permissionless);
    // the signed takingAmount is the FLOOR and the price decays down to it. Composes with the
    // JIT extension above: one blob, one salt binding. Pure local byte-building — no RPC. ──
    let fusionData: Record<string, unknown> | undefined;
    if (action.auction) {
      if (action.extension !== undefined && action.extension !== "0x") {
        throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "extension"], message: "extension and auction are mutually exclusive — auction BUILDS the amount-getter extension fields" }]);
      }
      const au = action.auction;
      const startTime = au.startTime !== undefined ? BigInt(au.startTime) : nowSecs;
      const auction = {
        gasBumpEstimate: 0n,
        gasPriceEstimate: 0n,
        startTime,
        duration: BigInt(au.durationSeconds),
        initialRateBump: BigInt(au.initialRateBump),
        points: (au.points ?? []).map((p) => ({ rateBump: BigInt(p.rateBump), timeDelta: BigInt(p.timeDelta) })),
      };
      let amountData: ReturnType<typeof buildAuctionAmountData>;
      try {
        amountData = buildAuctionAmountData(chainId, auction);
      } catch (err) {
        // Well-formed values breaking a curve/width rule (over-wide bump, non-decaying points,
        // no settlement for the chain) → envelope, exit 3, with the encoder's own teaching.
        return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "auction encoding failed", ctx);
      }
      const jitPre = extension !== undefined && extension !== "0x" ? decodeExtensionFields(extension).preInteractionData : "0x";
      extension = encodeExtensionFields({
        makingAmountData: amountData.makingAmountData,
        takingAmountData: amountData.takingAmountData,
        ...(jitPre !== "0x" ? { preInteractionData: jitPre } : {}),
      });
      const bumpNow = fusionRateBump(auction, nowSecs, null);
      const taking = BigInt(action.takingAmount);
      const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
      fusionData = {
        settlement: amountData.settlement,
        role: "amount getter ONLY — no postInteraction, so any taker fills at the decayed price through the plain LOP fill path (no resolver, no whitelist)",
        auction: { startTime: String(startTime), durationSeconds: String(auction.duration), initialRateBump: String(auction.initialRateBump), points: auction.points.map((p) => ({ rateBump: String(p.rateBump), timeDelta: String(p.timeDelta) })), scale: "rate bump base 1e7 = +100% above the signed floor" },
        phase: nowSecs < startTime ? "pre-start" : nowSecs >= startTime + auction.duration ? "floor" : "decaying",
        takerPaysCeiling: String(ceil(taking * (FUSION_BASE_POINTS + auction.initialRateBump), FUSION_BASE_POINTS)),
        takerPaysNow: String(fusionTakerPays(BigInt(action.makingAmount), taking, BigInt(action.makingAmount), 0n, bumpNow.effective)),
        floorTakingAmount: String(taking),
      };
      warnings.push({ code: "decaying_price_notice", message: `the taker price DECAYS from +${auction.initialRateBump} (base 1e7) above the signed takingAmount down to the signed floor over ${auction.duration}s from ${startTime} — the signed takingAmount is the WORST case for the maker, not the expected price. The venue book lists a static premium (a decaying listing convention is an open venue question): list it honestly, and takers should re-price with cork_compute dutch-auction-price + simulate before filling` });
    }

    let built: ReturnType<typeof buildMakerOrder>;
    try {
      built = buildMakerOrder({
        chainId,
        lop,
        maker: input.account,
        makerAsset: action.makerAsset,
        takerAsset: action.takerAsset,
        makingAmount: BigInt(action.makingAmount),
        takingAmount: BigInt(action.takingAmount),
        clientRequestId: input.clientRequestId,
        ...(action.expirySeconds !== undefined ? { expiry: nowSecs + BigInt(action.expirySeconds) } : {}),
        allowPartialFills: action.allowsPartialFills,
        usePermit2: action.usePermit2,
        ...(extension !== undefined ? { extension } : {}),
      });
    } catch (err) {
      // Well-formed values that violate an order-construction domain rule (malformed extension
      // shape, a trait slot overflow) → envelope, not an internal error.
      return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "maker order construction failed", ctx);
    }
    return envelope({
      state: "ok",
      data: {
        kind: "maker-order",
        lop,
        typedData: { domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.order },
        orderHash: built.orderHash,
        extension: built.extension,
        // The venue listing must carry this exact value: cork_submit compares the listing's nonce
        // against what the signed makerTraits encode and refuses to relay a mismatch.
        nonce: built.nonce,
        ...(jitData ? { jit: jitData } : {}),
        ...(fusionData ? { fusion: fusionData } : {}),
        clientRequestId: input.clientRequestId,
      },
      chainId,
      source: jitData ? "chain" : "config",
      warnings,
      ctx,
    });
  }

  if (action.type === "cancel") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const cancel = buildCancelOrder(BigInt(action.makerTraits), action.orderHash);
    return envelope({ state: "ok", data: { kind: "cancel", to: lop, calldata: cancel.data, orderHash: action.orderHash }, chainId, source: "config", ctx });
  }

  if (action.type === "rollover-intent") {
    const { rollover, warning: rolloverWarn } = await resolveRollover(chainId);
    if (!rollover) {
      return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId} (rollover is live on Arbitrum One, 42161)`, ctx);
    }
    const warnings: Array<{ code: string; message: string }> = rolloverWarn ? [rolloverWarn] : [];

    // Settler-kind pre-flight: the mode gate is enforced ON-CHAIN (ExactSettler reverts
    // Settler__PartialFillsNotSupported on allowPartialFills:true and PartialSettler reverts
    // Settler__ExactFillsNotSupported on false), so a mismatched order is signable but unfillable.
    const settlerLc = action.settler.toLowerCase();
    const kind = settlerLc === rollover.exactSettler.toLowerCase() ? "EXACT" : settlerLc === rollover.partialSettler.toLowerCase() ? "PARTIAL" : undefined;
    if (kind === "EXACT" && action.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${action.settler} is the ExactSettler, which rejects allowPartialFills:true on-chain — use the PartialSettler ${rollover.partialSettler} or set allowPartialFills:false`, ctx);
    }
    if (kind === "PARTIAL" && !action.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${action.settler} is the PartialSettler, which rejects allowPartialFills:false on-chain — use the ExactSettler ${rollover.exactSettler} or set allowPartialFills:true`, ctx);
    }
    if (kind === undefined) {
      warnings.push({ code: "settler_not_recognized", message: `settler ${action.settler} is not a configured Cork settler for chainId ${chainId} (exact: ${rollover.exactSettler}, partial: ${rollover.partialSettler}) — the venue only admits factory-approved settlers` });
    }

    const openDeadline = BigInt(action.openDeadline);
    const fillDeadline = BigInt(action.fillDeadline);
    const orderSize = BigInt(action.orderSize);
    const nowSecs = nowSecondsOf(ctx);
    if (orderSize === 0n) return unavailable(chainId, "invalid_order_terms", "orderSize must be positive — the venue rejects non-positive sizes", ctx);
    if (openDeadline > fillDeadline) return unavailable(chainId, "invalid_order_terms", `openDeadline (${openDeadline}) must not exceed fillDeadline (${fillDeadline})`, ctx);
    if (fillDeadline <= nowSecs) return unavailable(chainId, "invalid_order_terms", `fillDeadline (${fillDeadline}) is not in the future (now ${nowSecs}) — the venue rejects past deadlines`, ctx);

    const built = buildRolloverIntent({
      chainId,
      user: input.account,
      settler: action.settler,
      rolloverContract: action.rolloverContract,
      srcCstToken: action.srcCstToken,
      dstCstToken: action.dstCstToken,
      premiumToken: action.premiumToken,
      srcPoolId: action.srcPoolId,
      dstPoolId: action.dstPoolId,
      orderSize,
      minPremiumPerShare: BigInt(action.minPremiumPerShare),
      openDeadline,
      fillDeadline,
      ...(action.minCaReceived !== undefined ? { minCaReceived: BigInt(action.minCaReceived) } : {}),
      ...(action.minSharesOut !== undefined ? { minSharesOut: BigInt(action.minSharesOut) } : {}),
      allowPartialFills: action.allowPartialFills,
      allowUnderfill: action.allowUnderfill,
      ...(action.premiumPaymentMode !== undefined ? { premiumPaymentMode: action.premiumPaymentMode } : {}),
      ...(action.fillerHint !== undefined ? { fillerHint: action.fillerHint } : {}),
      ...(action.exclusiveFiller !== undefined ? { exclusiveFiller: action.exclusiveFiller } : {}),
      ...(action.orderSalt !== undefined ? { orderSalt: BigInt(action.orderSalt) } : {}),
      ...(action.nonce !== undefined ? { nonce: BigInt(action.nonce) } : {}),
      clientRequestId: input.clientRequestId,
    });
    return envelope({
      state: "ok",
      data: {
        kind: "rollover-intent",
        settler: action.settler,
        ...(kind ? { settlerKind: kind } : {}),
        typedData: { domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.order },
        orderDigest: built.orderDigest,
        rolloverIntentHash: built.rolloverIntentHash,
        orderDataType: built.orderDataType,
        venuePost: built.venuePost,
        clientRequestId: input.clientRequestId,
      },
      chainId,
      source: "config",
      warnings,
      ctx,
    });
  }

  if (action.type === "taker-fill") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const deps = venueDepsOf(ctx);
    const wanted = action.orderHash.toLowerCase();
    try {
      // Locate the resting order in the venue book under a hard page bound; an exhausted bound
      // fails closed (no false "not found") rather than truncating silently.
      const book = await collectVenuePages(
        { pageSize: 100, maxPages: action.maxPages },
        (cursor) => getLopOrderbook(deps, { chainId, limit: 100, ...(cursor ? { cursor } : {}) }),
      );
      const row = book.items.find((item) => {
        const nested = item.order && typeof item.order === "object" && !Array.isArray(item.order) ? (item.order as Record<string, unknown>) : item;
        const h = nested.orderHash ?? nested.order_hash ?? item.orderHash ?? item.order_hash;
        return typeof h === "string" && h.toLowerCase() === wanted;
      });
      if (!row) {
        if (!book.complete) {
          return envelope({
            state: "conflict",
            data: { requestedOrderHash: action.orderHash, pagesFetched: book.pagesFetched, reason: book.reason, ...(book.nextCursor ? { nextCursor: book.nextCursor } : {}) },
            chainId,
            source: "service",
            warnings: [{ code: "pagination_incomplete", message: `the orderbook search was incomplete (${book.reason}); no absence claim or fill bytes were produced` }],
            ctx,
          });
        }
        return unavailable(chainId, "order_not_found", `no resting venue order found for ${action.orderHash} on chainId ${chainId}`, ctx);
      }
      const parsed = parseSignedLopOrder(row);
      if (!parsed.ok) return unavailable(chainId, "invalid_service_response", `venue returned a malformed signed order — ${parsed.error}`, ctx);
      const signed = parsed.value;
      // [K3] re-hash the venue's order locally; a row that does not hash to the requested order
      // (or disagrees with the venue's own claimed hash) yields NO fill bytes.
      const localOrderHash = hashLopOrder(chainId, lop, signed.order);
      if (localOrderHash.toLowerCase() !== wanted || (signed.venueOrderHash !== undefined && signed.venueOrderHash.toLowerCase() !== localOrderHash.toLowerCase())) {
        return envelope({
          state: "conflict",
          data: { requestedOrderHash: action.orderHash, localOrderHash, venueOrderHash: signed.venueOrderHash ?? null },
          chainId,
          source: "service",
          warnings: [{ code: "digest_mismatch", message: "the venue row does not hash to the requested order — no fill bytes were built" }],
          ctx,
        });
      }
      // A zero makingAmount is a malformed VENUE row (nothing fillable), not a caller mistake —
      // attribute it correctly instead of surfacing a divisor error as invalid_order_terms.
      if (signed.order.makingAmount === 0n) {
        return unavailable(chainId, "invalid_service_response", `venue returned a resting order with makingAmount 0 for ${action.orderHash} — a malformed row; no fill bytes were built`, ctx);
      }
      // Taker-side JIT: build the interaction bytes with the full pre-flight ladder.
      let interaction = action.interaction;
      let jitData: Record<string, unknown> | undefined;
      const jitWarnings: Array<{ code: string; message: string }> = [];
      if (action.jitMarket) {
        if (action.interaction !== undefined) {
          throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "interaction"], message: "interaction and jitMarket are mutually exclusive — jitMarket BUILDS the interaction" }]);
        }
        const built = await buildTakerJitInteraction({ ctx, chainId, lop, jm: action.jitMarket, taker: input.account, order: signed.order, orderExtension: signed.extension });
        if (built.gate) return built.gate;
        interaction = built.interaction;
        jitData = built.jit;
        jitWarnings.push(...built.warnings);
      }
      let fill: TakerFillResult;
      try {
        fill = buildTakerFill({
          order: signed.order,
          signature: signed.signature,
          makerAccountType: signed.makerAccountType,
          taker: input.account,
          extension: signed.extension,
          ...(action.receiver ? { receiver: action.receiver } : {}),
          ...(action.fillMakingAmount ? { fillMakingAmount: BigInt(action.fillMakingAmount) } : {}),
          ...(action.maximumTakingAmount ? { maximumTakingAmount: BigInt(action.maximumTakingAmount) } : {}),
          ...(interaction ? { interaction } : {}),
        });
      } catch (err) {
        return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "the resting order cannot be filled by this variant", ctx);
      }
      return envelope({
        state: "ok",
        data: {
          kind: "taker-fill",
          to: lop,
          calldata: fill.calldata,
          value: "0",
          from: input.account,
          orderHash: localOrderHash,
          makerAsset: signed.order.makerAsset,
          takerAsset: signed.order.takerAsset,
          fillFunction: fill.functionName,
          requiredMakingAmount: fill.requiredMakingAmount,
          requiredTakingAmount: fill.requiredTakingAmount,
          takerTraits: fill.takerTraits,
          ...(jitData ? { jit: jitData } : {}),
          simulationRequired: true,
          clientRequestId: input.clientRequestId,
        },
        chainId,
        source: "service",
        warnings: [...jitWarnings, { code: "unsigned_artifact", message: "unsigned fill calldata only — independently simulate it (cork_track simulate) and ensure the taker-asset allowance before signing or broadcasting" }],
        ctx,
      });
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  return unavailable(chainId, "phase_gated", `prepare_orders '${(action as { type: string }).type}' is not implemented`, ctx);
}

async function handleTrack(input: TrackInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const subj = input.subject;

  // simulate: dry-run FROZEN bytes via eth_call — executes nothing, signs nothing [K1]. Accepts
  // the artifact shapes our own prepare tools emit (bundler3+multicall, to+calldata/data) plus a
  // caller `from`/`account` (defaults to the artifact's own account field when present). A revert
  // is a SUCCESSFUL simulation whose answer is "this would revert" — ok + wouldRevert, never a
  // fabricated failure.
  if (input.mode === "simulate") {
    if (subj.kind !== "artifact") {
      return unavailable(chainId, "phase_gated", `track simulate dry-runs a FROZEN artifact's bytes — pass subject kind 'artifact' with the prepared result (to/bundler3 + data/multicall + from/account); subject kind '${subj.kind}' has nothing executable to simulate`, ctx);
    }
    const a = subj.artifact;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = a[k];
        if (typeof v === "string" && v.startsWith("0x")) return v;
      }
      return undefined;
    };
    const to = pick("to", "bundler3");
    const data = pick("data", "multicall", "calldata");
    const from = pick("from", "account", "sender");
    if (!to || !data) {
      return unavailable(chainId, "missing_filter", "simulate needs the artifact's target and bytes: include `to` (or `bundler3`) and `data` (or `multicall`/`calldata`); optionally `from`/`account` for sender-dependent paths (funding pulls, roles)", ctx);
    }
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", `simulate needs an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx);
    const rpc = rpcProvenance(input.format, resolved);
    const warnings: Array<{ code: string; message: string }> = [...rpcWarn(resolved)];
    if (!from) warnings.push({ code: "manual_funding", message: "no `from`/`account` in the artifact — simulated without a sender, so sender-dependent legs (transferFrom funding, role gates) are NOT exercised; pass the account for a faithful dry-run" });
    const valueStr = typeof a.value === "string" && /^[0-9]+$/.test(a.value) ? a.value : undefined;
    try {
      const call = {
        to: to as `0x${string}`,
        data: data as `0x${string}`,
        ...(from ? { account: from as `0x${string}` } : {}),
        ...(valueStr ? { value: BigInt(valueStr) } : {}),
        ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}),
      };
      const res = await resolved.client.call(call);
      let gas: bigint | undefined;
      try {
        gas = await resolved.client.estimateGas(call);
      } catch { /* estimate is best-effort garnish; the call already proved viability */ }
      return envelope({
        state: "ok",
        data: { mode: "simulate", wouldRevert: false, to, from: from ?? null, ...(res.data && res.data !== "0x" ? { returnData: res.data } : {}), ...(gas !== undefined ? { gasEstimate: gas } : {}), note: "eth_call dry-run at the current state — a later broadcast can still land differently (state/deadline drift)" },
        chainId,
        source: "chain",
        warnings,
        ...rpc,
        ctx,
      });
    } catch (err) {
      // Distinguish an execution REVERT (a real simulation answer) from a transport failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (isTransportError(err)) return chainReadFailed(chainId, err, warnings, ctx, resolved);
      const reason = msg.split("\n").find((l) => /revert|Error|Custom/i.test(l))?.trim() ?? msg.split("\n")[0];
      return envelope({
        state: "ok",
        data: { mode: "simulate", wouldRevert: true, to, from: from ?? null, revertReason: reason },
        chainId,
        source: "chain",
        warnings: [...warnings, { code: "would_revert", message: `the frozen bytes REVERT at the current state (${reason}) — do not sign/broadcast as-is; common causes: expired deadline, missing funding/allowance, pool state moved since prepare` }],
        ...rpc,
        ctx,
      });
    }
  }

  // artifact: recompute the content digest and reconcile against the caller's claim (pure).
  if (subj.kind === "artifact") {
    const digest = keccak256(stringToHex(JSON.stringify(jsonSafe(subj.artifact) ?? null)));
    const claimed = input.expect?.artifactDigest;
    if (claimed) {
      const match = digest.toLowerCase() === claimed.toLowerCase();
      return envelope({ state: match ? "ok" : "conflict", data: { verified: match, computedDigest: digest, claimedDigest: claimed }, chainId, source: "config", ...(match ? {} : { warnings: [{ code: "digest_mismatch", message: "recomputed artifact digest does not match the claimed digest" }] }), ctx });
    }
    return envelope({ state: "ok", data: { computedDigest: digest }, chainId, source: "config", ctx });
  }

  // chain-authoritative subjects need an RPC.
  const { dep, depWarn } = await getDep(ctx, chainId);
  if (subj.kind === "marketRef") {
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", "marketRef verification needs an RPC (none resolved — set CORK_RPC_URL)", ctx);
    const client = resolved.client;
    const rpc = rpcProvenance(input.format, resolved);
    try {
      const s = await readPoolState(client, { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter }, subj.poolId, ctx.atBlock);
      const idMatches = computeMarketId(s.market).toLowerCase() === subj.poolId.toLowerCase();
      return envelope({
        state: idMatches ? "ok" : "conflict",
        data: { verified: idMatches, poolId: s.poolId, marketIdRecomputed: computeMarketId(s.market), swapRate: s.onChainSwapRate, market: s.market },
        chainId,
        source: "chain",
        block: s.blockNumber,
        warnings: idMatches ? [...rpcWarn(resolved), ...depWarn] : [{ code: "marketid_mismatch", message: "on-chain market params do not hash to the requested poolId" }, ...rpcWarn(resolved), ...depWarn],
        ...rpc,
        ctx,
      });
    } catch (err) {
      return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...depWarn], ctx, resolved);
    }
  }

  if (subj.kind === "txHash") {
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", "txHash reconcile needs an RPC (none resolved — set CORK_RPC_URL)", ctx);
    const client = resolved.client;
    const rpc = rpcProvenance(input.format, resolved);
    try {
      const r = await client.getTransactionReceipt({ hash: subj.txHash });
      // Label known Cork lifecycle events in the receipt (settler rollover events + the JIT
      // adapter's market-creation/mint events) so an agent sees WHAT happened, not just a count.
      const labeled = r.logs
        .map((l) => {
          const name = (l.topics[0] && (SETTLER_EVENTS[l.topics[0]] ?? JIT_EVENTS[l.topics[0]])) || undefined;
          return name ? { event: name, address: l.address, ...(l.topics[1] ? { topic1: l.topics[1] } : {}) } : undefined;
        })
        .filter((x): x is NonNullable<typeof x> => x !== undefined);
      return envelope({ state: "ok", data: { txHash: subj.txHash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, logs: r.logs.length, ...(labeled.length ? { corkEvents: labeled } : {}) }, chainId, source: "chain", block: r.blockNumber, ...rpc, ctx });
    } catch (err) {
      // A missing receipt is a normal outcome (pending/unknown tx); anything else is a real
      // chain-read failure and must not masquerade as "not found".
      if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "TransactionReceiptNotFoundError") {
        return envelope({ state: "unavailable", data: { txHash: subj.txHash, found: false }, chainId, source: "chain", warnings: [{ code: "receipt_not_found", message: "no receipt for this txHash at the RPC (pending or unknown)" }], ctx });
      }
      return chainReadFailed(chainId, err, [], ctx, resolved);
    }
  }

  // orderHash / submissionRef: reconcile against the venue's lifecycle rows. Venue-reported
  // state — the independent chain-log verification leg [K7] lands in the next iteration; until
  // then a warning discloses that provenance honestly.
  if (subj.kind === "orderHash" || subj.kind === "submissionRef") {
    const ref = subj.kind === "orderHash" ? subj.orderHash : subj.submissionRef;
    const deps = venueDepsOf(ctx);
    const venueNote = { code: "venue_reported", message: "state is venue-reported (centralized) and was NOT independently chain-verified for this call — configure an RPC (status leg) and ENVIO_API_TOKEN or CORK_LOGS_RPC_URL (event-history leg) to enable [K7] verification" };
    try {
      if (/^0x[0-9a-fA-F]{64}$/.test(ref)) {
        // A 32-byte ref is a rollover orderDigest or a LOP orderHash — try both surfaces.
        const row = await getRolloverOrder(deps, ref.toLowerCase());
        if (row) {
          const order = (row.order ?? row) as Record<string, unknown>;
          const venueStatus = String(order.status ?? "");
          const digest = ref.toLowerCase() as `0x${string}`;

          // ── [K7] chain verification legs (best-effort; every gap is disclosed, never faked) ──
          const warnings: Array<{ code: string; message: string }> = [];
          let chainVerification: Record<string, unknown> | undefined;
          const { rollover } = await resolveRollover(chainId);
          const settlerAddr = typeof order.settler === "string" ? (order.settler as `0x${string}`) : undefined;
          const resolved = settlerAddr ? await getRpc(ctx, chainId) : null;
          if (settlerAddr && resolved) {
            try {
              const statusNum = (await resolved.client.readContract({
                address: settlerAddr,
                abi: settlerStatusAbi,
                functionName: "orderStatus",
                args: [digest],
              })) as number;
              const chainStatus = chainStatusName(statusNum);
              const consistent = venueChainConsistent(venueStatus, chainStatus);
              chainVerification = { leg: "orderStatus (settler view, live RPC)", settler: settlerAddr, chainStatus, venueStatus, consistent };
              if (!consistent) {
                // Chain outranks the venue: disagreement is an explicit conflict, with the
                // indexer's finality lag (~75 s on Arbitrum) noted for freshly-updated rows.
                return envelope({
                  state: "conflict",
                  data: { kind: "rollover-order", orderDigest: digest, venueStatus, chainStatus, order, chainVerification },
                  chainId,
                  source: "chain",
                  warnings: [{ code: "status_mismatch", message: `the venue reports '${venueStatus}' but the settler's orderStatus() returns '${chainStatus}' — chain outranks indexer [K7]; if the venue row updated within the indexer finality lag (~75s on Arbitrum) retry shortly` }],
                  ctx,
                });
              }
            } catch (err) {
              warnings.push({ code: "chain_read_failed", message: `orderStatus verification read failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — result is venue-reported only` });
            }
          } else {
            warnings.push(venueNote);
          }

          // Event-history leg via a logs-capable endpoint (HyperRPC preferred; token sent as a
          // Bearer header by fetchDigestLogs, never in the URL).
          const logsEndpoint = resolveLogsEndpoint(chainId, ctx.logsUrl);
          if (logsEndpoint && rollover) {
            try {
              const logs = await fetchDigestLogs({
                url: logsEndpoint.url,
                ...(logsEndpoint.bearerToken ? { bearerToken: logsEndpoint.bearerToken } : {}),
                addresses: [rollover.exactSettler, rollover.partialSettler],
                digest,
                fromBlock: rollover.seededAtBlock,
                ...(ctx.venueFetch || ctx.logsFetch ? { fetchImpl: ctx.logsFetch ?? ctx.venueFetch! } : {}),
              });
              chainVerification = { ...(chainVerification ?? {}), events: labelLogs(logs) };
            } catch (err) {
              warnings.push(
                err instanceof LogsRangeLimited
                  ? { code: "logs_range_limited", message: `the logs endpoint refused the historical range (${err.message}) — event history omitted; use HyperRPC (ENVIO_API_TOKEN) for full-range scans` }
                  : { code: "logs_unavailable", message: `event-history leg failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` },
              );
            }
          } else if (!logsEndpoint) {
            warnings.push({ code: "logs_unavailable", message: "no logs-capable endpoint configured (set ENVIO_API_TOKEN for HyperRPC, or CORK_LOGS_RPC_URL) — event history omitted; status leg above still applies when an RPC resolved" });
          }

          return envelope({
            state: "ok",
            data: {
              kind: "rollover-order",
              orderDigest: digest,
              lifecycle: order.status ?? null,
              order,
              fills: row.fills ?? [],
              slots: row.slots ?? [],
              ...(chainVerification ? { chainVerification } : {}),
            },
            chainId,
            source: chainVerification ? "chain" : "indexer",
            warnings,
            ctx,
          });
        }
        // ── LOP surface: fills + resting-book row, then the on-chain invalidator leg [K7] ──
        const hash = ref.toLowerCase();
        // Bounded traversals (F19): a single-page scan could falsely report "no fills" /
        // "not resting" / "not found" for anything beyond page 1.
        const fillsScan = await collectVenuePages({ pageSize: 100, maxPages: 10 }, (cursor) => getLopFills(deps, { chainId, orderHash: hash, ...(cursor ? { cursor } : {}), limit: 100 }));
        const fills = { items: fillsScan.items };
        // The orderbook endpoint has no orderHash filter — walk the book client-side to
        // recover the maker/makerTraits the invalidator views need.
        let bookRow: Record<string, unknown> | undefined;
        let bookComplete = true;
        try {
          const book = await collectVenuePages({ pageSize: 100, maxPages: 10 }, (cursor) => getLopOrderbook(deps, { chainId, ...(cursor ? { cursor } : {}), limit: 100 }));
          bookComplete = book.complete;
          bookRow = book.items.find((r) => {
            const o = r as Record<string, unknown>;
            const h = o.orderHash ?? o.order_hash ?? o.hash ?? (o.order as Record<string, unknown> | undefined)?.orderHash;
            return typeof h === "string" && h.toLowerCase() === hash;
          }) as Record<string, unknown> | undefined;
        } catch {
          bookComplete = false; // book scan is best-effort; fills/chain legs below still apply
        }
        if (fills.items.length > 0 || bookRow) {
          const warnings: Array<{ code: string; message: string }> = [];
          let chainVerification: Record<string, unknown> | undefined;
          // maker + makerTraits from the book row (resting) or the first fill row (historical).
          const src = (bookRow?.order as Record<string, unknown> | undefined) ?? bookRow ?? (fills.items[0] as Record<string, unknown> | undefined);
          const maker = typeof src?.maker === "string" ? (src.maker as `0x${string}`) : undefined;
          const traitsStr = src?.makerTraits ?? src?.maker_traits;
          const lop = LOP_ADDRESSES[chainId];
          const resolved = maker && lop ? await getRpc(ctx, chainId) : null;
          if (maker && lop && resolved && traitsStr !== undefined) {
            try {
              const plan = lopInvalidatorPlan(BigInt(String(traitsStr)));
              const onChain =
                plan.mode === "bit"
                  ? classifyBitInvalidator(
                      (await resolved.client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "bitInvalidatorForOrder", args: [maker, plan.slot] })) as bigint,
                      plan.mask,
                    )
                  : classifyRemainingRaw(
                      (await resolved.client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "rawRemainingInvalidatorForOrder", args: [maker, hash as `0x${string}`] })) as bigint,
                    );
              chainVerification = {
                leg: `LOP ${plan.mode}-invalidator (live RPC)`,
                lop,
                maker,
                onChainStatus: onChain.status,
                ...(onChain.remaining !== undefined ? { remainingMakingAmount: onChain.remaining } : {}),
                cancellable: onChain.status !== "filled-or-cancelled",
              };
              // Chain outranks the venue: a book-listed order the chain says is dead is a conflict.
              if (bookRow && onChain.status === "filled-or-cancelled") {
                return envelope({
                  state: "conflict",
                  data: { kind: "lop-order", orderHash: hash, venueStatus: "resting (orderbook row present)", chainStatus: onChain.status, order: bookRow, fills: fills.items, chainVerification },
                  chainId,
                  source: "chain",
                  warnings: [{ code: "status_mismatch", message: "the venue orderbook still lists this order but the LOP invalidator says it is filled or cancelled — chain outranks indexer [K7]; do not attempt a fill, and a cancel would revert" }],
                  ctx,
                });
              }
            } catch (err) {
              warnings.push({ code: "chain_read_failed", message: `LOP invalidator read failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — result is venue-reported only` });
            }
          } else if (maker && lop && traitsStr !== undefined) {
            warnings.push(venueNote);
          } else if (!lop) {
            warnings.push({ code: "no_lop", message: `no 1inch LOP deployment configured for chainId ${chainId} — invalidator leg skipped` });
          } else {
            warnings.push({ code: "venue_reported", message: "venue rows carry no maker/makerTraits for this order — the on-chain invalidator leg needs both; state is venue-reported only" });
          }
          if (!bookRow && !bookComplete) {
            warnings.push({ code: "pagination_incomplete", message: "the orderbook walk did not exhaust the book — `resting` is UNKNOWN, not false; the fills below are still valid evidence" });
          }
          return envelope({
            state: "ok",
            data: {
              kind: "lop-order",
              orderHash: hash,
              // An incomplete book walk that found nothing cannot honestly claim "not resting".
              resting: bookRow ? true : bookComplete ? false : null,
              ...(bookRow ? { order: bookRow } : {}),
              count: fills.items.length,
              fills: fills.items,
              ...(chainVerification ? { chainVerification } : {}),
            },
            chainId,
            source: chainVerification ? "chain" : "indexer",
            warnings,
            ctx,
          });
        }
        if (!fillsScan.complete || !bookComplete) {
          // Neither surface found it, but at least one scan stopped short — no absence claim.
          return envelope({
            state: "conflict",
            data: { requestedRef: ref, fillsScanComplete: fillsScan.complete, orderbookScanComplete: bookComplete },
            chainId,
            source: "service",
            warnings: [{ code: "pagination_incomplete", message: "the venue scans were incomplete, so 'not found' cannot be honestly claimed — retry, narrow the search, or raise maxPages" }],
            ctx,
          });
        }
        return unavailable(chainId, "order_not_found", `no rollover order, LOP orderbook row, or LOP fills known to the venue for ${ref} on chainId ${chainId} (a normal outcome for an unposted/unfilled order)`, ctx);
      }
      return unavailable(chainId, "order_not_found", `submissionRef '${ref}' is not a 32-byte order digest — RFQ ids (rfq_/ans_) reconcile via cork_query once the RFQ read surface is wired`, ctx);
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  // All five subject kinds are handled above; this is unreachable but keeps the return total.
  return unavailable(chainId, "needs_service", "track subject is not reconcilable in this iteration", ctx);
}

const U160 = (1n << 160n) - 1n;
const U40 = (1n << 40n) - 1n;
const LOP_NO_PARTIAL_FILLS_FLAG = 1n << 255n;

/**
 * Parse a decimal string (plain or scientific notation) into an EXACT 1e18-scaled bigint, or
 * null when it is not a finite decimal / not representable at 18 fractional digits. Scale
 * tripwires must compare integers, never floats: IEEE-754 breaks exact-threshold semantics
 * right at the boundaries the tripwires exist to police [C6].
 */
export function decimalToScaled(s: string): bigint | null {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const frac = m[3] ?? "";
  const digits = BigInt(m[2]! + frac);
  const pow = BigInt(m[4] ?? "0") - BigInt(frac.length) + 18n;
  if (pow >= 0n) {
    if (pow > 96n) return null; // absurd magnitude — treat as unparsable rather than compute 10^huge
    return sign * digits * 10n ** pow;
  }
  const div = 10n ** -pow;
  if (digits % div !== 0n) return null; // finer than 1e-18 — not exactly representable
  return (sign * digits) / div;
}

/** Canonical Uniswap Permit2 (same address on every chain). */
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

async function handleSubmit(input: SubmitInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const action = input.action;
  const deps = venueDepsOf(ctx);

  /** Shared POST-outcome mapping (201 created / 200 idempotent replay / 4xx per venue docs). */
  const mapPost = (res: VenuePostResult, okData: (body: Record<string, unknown>, replay: boolean) => Record<string, unknown>, okWarnings: Array<{ code: string; message: string }> = []): Envelope => {
    const body = (res.body ?? {}) as Record<string, unknown>;
    const msg = typeof body.message === "string" ? body.message : `HTTP ${res.httpStatus}`;
    if (res.httpStatus === 201 || res.httpStatus === 200) {
      return envelope({ state: "ok", data: okData(body, res.httpStatus === 200), chainId, source: "service", warnings: okWarnings, ctx });
    }
    if (res.httpStatus === 409) {
      return envelope({ state: "conflict", data: { venueResponse: body }, chainId, source: "service", warnings: [{ code: "venue_conflict", message: `venue 409: ${msg} (same id/digest already stored with a DIFFERENT payload — use a fresh clientRequestId for a genuinely new request [K2])` }], ctx });
    }
    if (res.httpStatus === 429) {
      return unavailable(chainId, "venue_rate_limited", `venue 429: ${msg} (per-user open-order caps / 100 req/min per IP)`, ctx);
    }
    if (res.httpStatus === 404 || res.httpStatus === 410 || res.httpStatus === 422) {
      return unavailable(chainId, "venue_rejected", `venue ${res.httpStatus}: ${msg}${res.httpStatus === 422 ? " (permanent for this RFQ — do not retry)" : ""}`, ctx);
    }
    if (res.httpStatus >= 500) {
      // A server-side failure is not a rejection of the payload — mark it retryable.
      return unavailable(chainId, "venue_unreachable", `venue server error ${res.httpStatus}: ${msg} — likely transient; retry with the SAME clientRequestId [K2]`, ctx);
    }
    return unavailable(chainId, "venue_rejected", `venue ${res.httpStatus}: ${msg}`, ctx);
  };

  try {
    if (action.type === "rollover-order") {
      const o = action.order;
      // Single-chain protocol: the routing fields must match the target chain (venue rejects too).
      if (o.originChainId !== String(chainId) || o.destinationChainId !== String(chainId)) {
        return unavailable(chainId, "invalid_order_terms", `originChainId/destinationChainId must equal chainId ${chainId} (single-chain rollover)`, ctx);
      }
      // [F14] Re-run the settler/deadline checks the prepare path enforces — a submit-only caller
      // must not be able to relay an order the prepare path would have refused to build.
      {
        const { rollover } = await resolveRollover(chainId);
        if (rollover) {
          const settlerLc = o.settler.toLowerCase();
          const kind = settlerLc === rollover.exactSettler.toLowerCase() ? "EXACT" : settlerLc === rollover.partialSettler.toLowerCase() ? "PARTIAL" : undefined;
          if (kind === "EXACT" && o.allowPartialFills) {
            return unavailable(chainId, "settler_mode_mismatch", `settler ${o.settler} is the ExactSettler, which rejects allowPartialFills:true on-chain — this signed order is unfillable; re-sign against the PartialSettler ${rollover.partialSettler} or with allowPartialFills:false`, ctx);
          }
          if (kind === "PARTIAL" && !o.allowPartialFills) {
            return unavailable(chainId, "settler_mode_mismatch", `settler ${o.settler} is the PartialSettler, which rejects allowPartialFills:false on-chain — this signed order is unfillable; re-sign against the ExactSettler ${rollover.exactSettler} or with allowPartialFills:true`, ctx);
          }
        }
        const openDeadline = BigInt(o.openDeadline);
        const fillDeadline = BigInt(o.fillDeadline);
        const nowSecs = nowSecondsOf(ctx);
        if (BigInt(o.orderSize) === 0n) return unavailable(chainId, "invalid_order_terms", "orderSize must be positive — the venue rejects non-positive sizes", ctx);
        if (openDeadline > fillDeadline) return unavailable(chainId, "invalid_order_terms", `openDeadline (${openDeadline}) must not exceed fillDeadline (${fillDeadline})`, ctx);
        if (fillDeadline <= nowSecs) return unavailable(chainId, "invalid_order_terms", `fillDeadline (${fillDeadline}) is not in the future (now ${nowSecs}) — the venue rejects past deadlines`, ctx);
      }
      if (o.rolloverParams.settler.toLowerCase() !== o.settler.toLowerCase() || o.rolloverParams.srcCstToken.toLowerCase() !== o.srcCstToken.toLowerCase() || o.rolloverParams.dstCstToken.toLowerCase() !== o.dstCstToken.toLowerCase()) {
        return unavailable(chainId, "invalid_order_terms", "rolloverParams (settler/srcCstToken/dstCstToken) must mirror OrderData exactly — the venue rejects mismatches", ctx);
      }
      if (action.intent.rolloverContract.toLowerCase() !== o.rolloverContract.toLowerCase()) {
        return unavailable(chainId, "invalid_order_terms", "intent.rolloverContract must equal order.rolloverContract", ctx);
      }
      // [K3] Recompute the zero-digest intent commitment; a payload whose hooks do not hash to
      // the signed rolloverIntentHash is NOT relayed — the venue would reject it, and relaying
      // would leak a broken payload.
      const intentStruct: RolloverIntentStruct = {
        rolloverContract: action.intent.rolloverContract,
        orderDigest: `0x${"00".repeat(32)}`,
        deadline: BigInt(action.intent.deadline),
        nonce: BigInt(action.intent.nonce),
        preRolloverHooks: action.intent.preRolloverHooks.map((h) => ({ target: h.target, value: BigInt(h.value), callData: h.callData, allowFailure: h.allowFailure, isDelegateCall: h.isDelegateCall })),
        midRolloverHooks: action.intent.midRolloverHooks.map((h) => ({ target: h.target, value: BigInt(h.value), callData: h.callData, allowFailure: h.allowFailure, isDelegateCall: h.isDelegateCall })),
        postRolloverHooks: action.intent.postRolloverHooks.map((h) => ({ target: h.target, value: BigInt(h.value), callData: h.callData, allowFailure: h.allowFailure, isDelegateCall: h.isDelegateCall })),
        premiumHooks: action.intent.premiumHooks.map((h) => ({ target: h.target, value: BigInt(h.value), callData: h.callData, allowFailure: h.allowFailure, isDelegateCall: h.isDelegateCall })),
      };
      const recomputedIntentHash = intentStructHash(intentStruct);
      if (recomputedIntentHash.toLowerCase() !== o.rolloverIntentHash.toLowerCase()) {
        return envelope({
          state: "conflict",
          data: { claimed: o.rolloverIntentHash, recomputed: recomputedIntentHash },
          chainId,
          source: "config",
          warnings: [{ code: "digest_mismatch", message: "intent does not hash to order.rolloverIntentHash (zero-digest EIP-712 struct hash) — the payload was NOT relayed; the intent or the signed order is inconsistent" }],
          ctx,
        });
      }
      // Recompute the ERC-7683 orderDigest locally so the venue's answer can be cross-checked.
      const orderStruct: OrderDataStruct = {
        user: o.user,
        settler: o.settler,
        fillerHint: o.fillerHint,
        exclusiveFiller: o.exclusiveFiller,
        srcCstToken: o.srcCstToken,
        dstCstToken: o.dstCstToken,
        premiumToken: o.premiumToken,
        rolloverContract: o.rolloverContract,
        originChainId: BigInt(o.originChainId),
        destinationChainId: BigInt(o.destinationChainId),
        openDeadline: BigInt(o.openDeadline),
        fillDeadline: BigInt(o.fillDeadline),
        orderSalt: BigInt(o.orderSalt),
        orderSize: BigInt(o.orderSize),
        minPremiumPerShare: BigInt(o.minPremiumPerShare),
        allowPartialFills: o.allowPartialFills,
        allowUnderfill: o.allowUnderfill,
        premiumPaymentMode: o.premiumPaymentMode,
        rolloverIntentHash: o.rolloverIntentHash,
        rolloverParams: {
          srcCstToken: o.rolloverParams.srcCstToken,
          dstCstToken: o.rolloverParams.dstCstToken,
          minCaReceived: BigInt(o.rolloverParams.minCaReceived),
          minSharesOut: BigInt(o.rolloverParams.minSharesOut),
          srcPoolId: o.rolloverParams.srcPoolId,
          dstPoolId: o.rolloverParams.dstPoolId,
          settler: o.rolloverParams.settler,
        },
      };
      const localDigest = computeOrderDigest(chainId, orderStruct);
      // [F14/K3] Recover the signature against the locally recomputed EIP-712 digest: a garbage-
      // or foreign-signed order must not relay (it would rest at the venue but never fill).
      try {
        const recovered = await recoverAddress({ hash: localDigest, signature: action.signature });
        if (!isAddressEqual(recovered, o.user)) {
          return envelope({
            state: "conflict",
            data: { orderDigest: localDigest, recoveredSigner: recovered, orderUser: o.user },
            chainId,
            source: "config",
            warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature recovers to ${recovered}, not order.user ${o.user} — NOT relayed; the order would rest at the venue but could never settle` }],
            ctx,
          });
        }
      } catch (err) {
        return envelope({
          state: "conflict",
          data: { orderDigest: localDigest },
          chainId,
          source: "config",
          warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature could not be recovered over the recomputed order digest (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — NOT relayed` }],
          ctx,
        });
      }
      const res = await postRolloverOrder(deps, {
        chainId,
        order: o,
        intent: action.intent,
        signature: action.signature,
        envelope: { orderDataType: ORDER_DATA_TYPEHASH },
      });
      const out = mapPost(res, (body, replay) => ({ kind: "rollover-order", accepted: true, replay, orderDigest: body.orderDigest ?? localDigest, localDigest }));
      // Venue digest disagreement is a conflict, not a success — surface it [K7].
      if (out.state === "ok") {
        const venueDigest = (out.data as { orderDigest?: unknown }).orderDigest;
        if (typeof venueDigest === "string" && venueDigest.toLowerCase() !== localDigest.toLowerCase()) {
          return envelope({
            state: "conflict",
            data: { venueDigest, localDigest },
            chainId,
            source: "service",
            warnings: [{ code: "digest_mismatch", message: "the venue computed a DIFFERENT orderDigest than the local EIP-712 recomputation — do not sign or rely on either until resolved" }],
            ctx,
          });
        }
      }
      return out;
    }

    if (action.type === "lop-order") {
      const lop = LOP_ADDRESSES[chainId];
      if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
      const orderMsg = {
        salt: BigInt(action.order.salt),
        maker: action.order.maker,
        receiver: action.order.receiver,
        makerAsset: action.order.makerAsset,
        takerAsset: action.order.takerAsset,
        makingAmount: BigInt(action.order.makingAmount),
        takingAmount: BigInt(action.order.takingAmount),
        makerTraits: BigInt(action.order.makerTraits),
      };
      // [K3] The orderHash sent to the venue is recomputed locally, never caller-supplied.
      const orderHash = hashTypedData({
        domain: lopDomain(chainId, lop),
        types: { Order: [
          { name: "salt", type: "uint256" },
          { name: "maker", type: "address" },
          { name: "receiver", type: "address" },
          { name: "makerAsset", type: "address" },
          { name: "takerAsset", type: "address" },
          { name: "makingAmount", type: "uint256" },
          { name: "takingAmount", type: "uint256" },
          { name: "makerTraits", type: "uint256" },
        ] },
        primaryType: "Order",
        message: orderMsg,
      });
      // [F3/K3] Derive the listing fields from the SIGNED makerTraits instead of trusting the
      // caller's duplicates: the venue book must never advertise an expiry / partial-fill policy /
      // nonce that contradicts what the signature enforces at fill.
      {
        const traits = orderMsg.makerTraits;
        const traitsExpiry = (traits >> 80n) & U40; // 0 = no expiry
        const traitsNonce = (traits >> 120n) & U40;
        const traitsAllowsPartial = (traits & LOP_NO_PARTIAL_FILLS_FLAG) === 0n;
        const mismatches: string[] = [];
        if (BigInt(action.expiry) !== traitsExpiry) mismatches.push(`expiry: listing says ${action.expiry}, the signed makerTraits encode ${traitsExpiry}`);
        if (BigInt(action.nonce) !== traitsNonce) mismatches.push(`nonce: listing says ${action.nonce}, the signed makerTraits encode ${traitsNonce}`);
        if (action.allowsPartialFills !== traitsAllowsPartial) mismatches.push(`allowsPartialFills: listing says ${action.allowsPartialFills}, the signed makerTraits say ${traitsAllowsPartial}`);
        if (mismatches.length > 0) {
          return envelope({
            state: "conflict",
            data: { orderHash, listing: { expiry: action.expiry, nonce: action.nonce, allowsPartialFills: action.allowsPartialFills }, fromMakerTraits: { expiry: traitsExpiry, nonce: traitsNonce, allowsPartialFills: traitsAllowsPartial } },
            chainId,
            source: "config",
            warnings: [{ code: "listing_traits_mismatch", message: `listing fields contradict the signed order's makerTraits (${mismatches.join("; ")}) — NOT relayed; takers acting on the listing would build fills that revert` }],
            ctx,
          });
        }
      }
      // [F3/K3] For an EOA maker, prove the signature is the maker's over THIS order before
      // relaying (ERC-1271 contract signatures cannot be checked locally; the venue/chain do).
      if (action.makerAccountType !== "ERC1271") {
        try {
          const recovered = await recoverAddress({ hash: orderHash, signature: action.signature });
          if (!isAddressEqual(recovered, orderMsg.maker)) {
            return envelope({
              state: "conflict",
              data: { orderHash, recoveredSigner: recovered, orderMaker: orderMsg.maker },
              chainId,
              source: "config",
              warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature recovers to ${recovered}, not the order maker ${orderMsg.maker} — NOT relayed; this order could rest on the book but never fill` }],
              ctx,
            });
          }
        } catch (err) {
          return envelope({
            state: "conflict",
            data: { orderHash },
            chainId,
            source: "config",
            warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature could not be recovered over the recomputed order hash (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — NOT relayed` }],
            ctx,
          });
        }
      }
      // Numbers-contract tripwires (RFQ doc §2.1): the book `premium` is a PERCENT number
      // (4.1 = 4.1%), RFQ premiums are FRACTION strings ("0.041"). A sub-0.1% premium is the
      // classic fraction-pasted-as-percent mistake — flagged, not blocked (par-priced cPT
      // orders can be legitimately tiny).
      const lopWarnings: Array<{ code: string; message: string }> = [];
      if (action.premium > 0 && action.premium < 0.1) {
        lopWarnings.push({ code: "premium_scale_suspect", message: `premium ${action.premium} is below 0.1% — if you meant a fraction ("${action.premium}" = ${action.premium * 100}%), the book field is the PERCENT number (RFQ §2.1); the venue rejects ~100x divergence when quote_ref is present` });
      }
      // quote_ref pre-flight [K3-style]: verify the cited option exists and the premium does not
      // contradict it (~100x divergence = a scale mistake the venue would reject at POST).
      // The comparison is EXACT integer arithmetic over the decimal strings — the earlier float
      // version let an exactly-100x divergence through (410 / (0.041*100) = 99.99999999999999).
      if (action.quoteRef) {
        const rfq = await getRfq(deps, action.quoteRef.rfqId);
        if (!rfq) return unavailable(chainId, "invalid_order_terms", `quote_ref cites unknown RFQ '${action.quoteRef.rfqId}'`, ctx);
        const answers = (rfq.answers ?? []) as Array<{ answer_id?: unknown; answer?: { options?: Array<Record<string, unknown>> } }>;
        const answer = answers.find((a) => String(a.answer_id) === action.quoteRef!.answerId);
        const option = answer?.answer?.options?.find((o) => String(o.option_id) === action.quoteRef!.optionId);
        if (!option) return unavailable(chainId, "invalid_order_terms", `quote_ref option '${action.quoteRef.optionId}' not found in answer '${action.quoteRef.answerId}' of RFQ '${action.quoteRef.rfqId}'`, ctx);
        const fractionScaled = option.premium_annualized === undefined ? null : decimalToScaled(String(option.premium_annualized));
        if (fractionScaled === null || fractionScaled <= 0n) {
          // A cited quote whose premium cannot be read means the cross-check CANNOT run — that is
          // a conflict, not a silent skip (the silent skip was exactly the guard's blind spot).
          return envelope({
            state: "conflict",
            data: { quoteRef: action.quoteRef, citedOptionPremiumAnnualized: option.premium_annualized ?? null },
            chainId,
            source: "service",
            warnings: [{ code: "quote_ref_unverifiable", message: `the cited RFQ option has no parsable positive premium_annualized (got ${JSON.stringify(option.premium_annualized)}) — the premium scale cross-check cannot run; NOT relayed. Cite a valid option or drop quoteRef` }],
            ctx,
          });
        }
        const declaredScaled = decimalToScaled(String(action.premium));
        const expectedPercentScaled = fractionScaled * 100n; // fraction -> percent
        // Exact thresholds, matched to the BOOK's own acceptance band: the venue rejects a
        // declared premium outside 10x/0.1x of the cited option (wide enough for an honest
        // re-price, narrow enough that a scale mistake cannot pass) — enforcing the same band
        // here fails the bad relay EARLY with teaching instead of a venue 4xx.
        if (declaredScaled !== null && (declaredScaled >= expectedPercentScaled * 10n || declaredScaled * 10n <= expectedPercentScaled)) {
          const expectedPercent = Number(option.premium_annualized) * 100;
          const high = declaredScaled >= expectedPercentScaled * 10n;
          return envelope({
            state: "conflict",
            data: { declaredPremiumPercent: action.premium, citedOptionFraction: option.premium_annualized, expectedPercent },
            chainId,
            source: "service",
            warnings: [{ code: "premium_scale_mismatch", message: `declared premium ${action.premium} diverges ${high ? ">=10" : "<=1/10"}x from the cited quote (${option.premium_annualized} fraction = ${expectedPercent}%) — outside the venue's own 10x acceptance band, so this would be rejected on relay; NOT relayed. Percent goes on the listing (3.6), fraction lives in the RFQ ("0.036")` }],
            ctx,
          });
        }
      }
      // Extension commitment pre-flight: what would revert InvalidExtension at fill is caught here.
      if (action.extension !== "0x") {
        const saltLow = BigInt(action.order.salt) & U160;
        const extLow = BigInt(keccak256(action.extension)) & U160;
        if (saltLow !== extLow) {
          return envelope({
            state: "conflict",
            data: { saltLow160: `0x${saltLow.toString(16)}`, extensionKeccakLow160: `0x${extLow.toString(16)}` },
            chainId,
            source: "config",
            warnings: [{ code: "extension_salt_mismatch", message: "salt's low 160 bits must equal keccak256(extension)'s low 160 bits — this order would revert InvalidExtension at fill; NOT relayed" }],
            ctx,
          });
        }
      }
      const res = await postLopOrder(deps, {
        salt: action.order.salt,
        maker: action.order.maker,
        receiver: action.order.receiver,
        makerAsset: action.order.makerAsset,
        takerAsset: action.order.takerAsset,
        makingAmount: action.order.makingAmount,
        takingAmount: action.order.takingAmount,
        makerTraits: action.order.makerTraits,
        extension: action.extension === "0x" ? "" : action.extension,
        orderHash,
        signature: action.signature,
        makerAccountType: action.makerAccountType,
        makerPermit2: action.makerPermit2,
        side: action.side,
        premium: action.premium,
        expiry: action.expiry,
        nonce: action.nonce,
        allowsPartialFills: action.allowsPartialFills,
        chainId,
        ...(action.quoteRef ? { quote_ref: { rfq_id: action.quoteRef.rfqId, answer_id: action.quoteRef.answerId, option_id: action.quoteRef.optionId } } : {}),
      });
      return mapPost(res, (body, replay) => ({ kind: "lop-order", accepted: true, replay, orderHash: body.orderHash ?? orderHash, localOrderHash: orderHash }), lopWarnings);
    }

    if (action.type === "rfq-open") {
      // [F6] Mirror the sibling rollover-intent validation: an inverted or already-past window
      // was previously relayed untouched and failed (or half-worked) only at the venue.
      const nowSecs = nowSecondsOf(ctx);
      if (action.expiryWindow.notBefore > action.expiryWindow.notAfter) {
        return unavailable(chainId, "invalid_order_terms", `expiryWindow is inverted: notBefore (${action.expiryWindow.notBefore}) is after notAfter (${action.expiryWindow.notAfter})`, ctx);
      }
      if (BigInt(action.expiryWindow.notAfter) <= nowSecs) {
        return unavailable(chainId, "invalid_order_terms", `expiryWindow.notAfter (${action.expiryWindow.notAfter}) is not in the future (now ${nowSecs}) — no pool expiry could ever satisfy this window`, ctx);
      }
      if (BigInt(action.validUntil) <= nowSecs) {
        return unavailable(chainId, "invalid_order_terms", `validUntil (${action.validUntil}) is not in the future (now ${nowSecs}) — the RFQ would be born expired`, ctx);
      }
      const res = await postRfq(deps, {
        schema_version: "1",
        request_id: input.clientRequestId,
        requester: action.requester,
        chain_id: chainId,
        reference_asset: action.referenceAsset,
        collateral_asset: action.collateralAsset,
        modes: action.modes,
        package_ids: action.packageIds,
        expiry_window: { not_before: action.expiryWindow.notBefore, not_after: action.expiryWindow.notAfter },
        ...(action.marketTemplate ? { market_template: action.marketTemplate } : {}),
        notional_assets: action.notionalAssets,
        valid_until: action.validUntil,
        signature: action.signature,
      });
      return mapPost(res, (body, replay) => ({ kind: "rfq-open", accepted: true, replay, rfqId: body.rfq_id ?? null, state: body.state ?? null }));
    }

    // rfq-answer — enforce the fraction contract on quoted options before relaying (§2.1: a
    // decimal STRING < 0.5; a wad or percent pasted here fails at this boundary, with teaching).
    if (action.status === "quoted") {
      for (const [i, o] of (action.options ?? []).entries()) {
        const p = o.premium_annualized;
        // The < 0.5 cap is decided ON THE STRING (first fractional digit >= 5), never via
        // Number(): a 17-digit "0.49999999999999999" rounds to exactly 0.5 in IEEE-754 and was
        // falsely rejected by the float form of this check [C6].
        if (p !== undefined && (typeof p !== "string" || !/^(0|0\.\d{1,18})$/.test(p) || /^0\.[5-9]/.test(p))) {
          return unavailable(chainId, "invalid_order_terms", `options[${i}].premium_annualized must be a decimal-string FRACTION < 0.5 ("0.041" = 4.1%) — got ${JSON.stringify(p)}; percent numbers (4.1) belong only on the legacy book field, wads (1e18-scaled) never appear on the RFQ surface`, ctx);
        }
      }
    }
    const res = await postRfqAnswer(deps, action.rfqId, {
      schema_version: "1",
      request_id: input.clientRequestId,
      underwriter: action.underwriter,
      status: action.status,
      ...(action.status === "quoted" ? { options: action.options ?? [] } : { reason_code: action.reasonCode ?? "PASS" }),
      signature: action.signature,
    });
    return mapPost(res, (body, replay) => ({ kind: "rfq-answer", accepted: true, replay, answerId: body.answer_id ?? null, rfqId: action.rfqId }));
  } catch (err) {
    return venueFailed(chainId, err, ctx);
  }
}

/** Validate + dispatch a tool call. Throws ToolInputError on schema failure. */
export async function runTool(name: string, rawInput: unknown, ctx: HandlerContext = {}): Promise<Envelope> {
  const def = toolByName(name);
  if (!def) throw new ToolInputError(name, `unknown tool: ${name}`);
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(name, parsed.error.issues, buildTeaching(name as ToolName, parsed.error.issues, rawInput));
  const chainIdOf = (x: unknown): ChainId => (x as { chainId?: ChainId }).chainId ?? 1;

  switch (name) {
    case "cork_capabilities": {
      const input = parsed.data as { topic?: string; search?: string };
      if (input.topic === "verify") {
        // Independently re-derive each deployed address from (deployer, salt, initCodeHash) [C10].
        const verifications = CREATE2_ATTESTATIONS.map((a) => ({
          name: a.name,
          ...verifyCreate2({ deployer: CREATE2_DEPLOYER, salt: a.salt, initCodeHash: a.initCodeHash, expected: a.expected }),
          salt: a.salt,
          initCodeHash: a.initCodeHash,
        }));
        const allMatch = verifications.every((v) => v.match);
        return envelope({
          state: allMatch ? "ok" : "conflict",
          data: { deployer: CREATE2_DEPLOYER, verifications },
          chainId: 1,
          source: "config",
          ...(allMatch ? {} : { warnings: [{ code: "create2_mismatch", message: "a deployed address did not reproduce from its salt+initCodeHash" }] }),
          ctx,
        });
      }
      const card = (t: (typeof REGISTRY)[number]) => ({ name: t.name, cli: `ch ${t.cliPath.join(" ")}`, phase: t.phase, maturity: MATURITY[t.name], description: t.description, annotations: t.annotations });

      // search: natural-language query -> ranked tools with the best-matching VARIANT (token
      // scoring over names/descriptions/example titles + per-variant hint phrases; search.ts).
      if (input.search) {
        const ranked = searchTools(input.search);
        const matches = ranked.map((r) => {
          const t = toolByName(r.name)!;
          const variantMaturity = r.variant ? MATURITY[r.name]?.variants?.[r.variant] : undefined;
          return {
            ...card(t as (typeof REGISTRY)[number]),
            ...(r.variant !== undefined ? { variant: r.variant } : {}),
            ...(variantMaturity !== undefined ? { variantMaturity } : {}),
            examples: TOOL_EXAMPLES[r.name],
            inputSchema: inputJsonSchema(r.name),
          };
        });
        return envelope({ state: "ok", data: { query: input.search, matches }, chainId: 1, source: "config", ctx });
      }

      // topic: a tool name (with or without cork_ prefix) or cli leaf -> that tool's full doc.
      if (input.topic) {
        const key = input.topic.toLowerCase();
        const t = REGISTRY.find((x) => x.name.toLowerCase() === key || x.name.toLowerCase() === `cork_${key}` || x.cliPath.join(" ").toLowerCase() === key || x.cliPath[x.cliPath.length - 1]?.toLowerCase() === key);
        if (!t) return unavailable(1, "unknown_topic", `no tool matches topic '${input.topic}'; try search or omit args for the full list`, ctx);
        return envelope({ state: "ok", data: { ...card(t), examples: TOOL_EXAMPLES[t.name], inputSchema: inputJsonSchema(t.name), output: "Envelope" }, chainId: 1, source: "config", ctx });
      }

      const data = REGISTRY.map(card);
      return envelope({ state: "ok", data: { tools: data, schemaVersion: SCHEMA_VERSION }, chainId: 1, source: "config", ctx });
    }
    case "cork_decode": {
      const input = parsed.data as DecodeInput;
      const chainId = input.chainId ?? 1;
      if (input.kind === "order") return handleDecodeOrder(input, chainId, ctx);
      if (input.kind === "event") return handleDecodeEvent(input, chainId, ctx);
      if (input.kind === "receipt") return handleDecodeReceipt(input, chainId, ctx);
      if (typeof input.data !== "string") {
        throw new ToolInputError(name, "calldata decode requires a hex string");
      }
      let legs;
      try {
        legs = decodeBundle(input.data as `0x${string}`);
      } catch (err) {
        // Malformed top-level bytes are invalid INPUT (exit 2, teachable) — not an internal error.
        throw new ToolInputError(name, [{ path: ["data"], message: err instanceof Error ? err.message : "calldata does not decode as a Bundler3 multicall" }]);
      }
      // Plain-English rendering alongside the structured legs: these bytes usually arrive from
      // somewhere else, and "what will this DO" is the question being asked of them.
      const adapter = (await getDep(ctx, chainId)).dep?.corkAdapter;
      // Summary before the leg dump: a reader scanning the prose output wants the intent first.
      return envelope({ state: "ok", data: { kind: "calldata", summary: summarizeBundle(legs, { adapter }), legs }, chainId, source: "config", ctx });
    }
    case "cork_compute":
      return handleCompute(parsed.data as ComputeInput, ctx);
    case "cork_prepare_phoenix": {
      const input = parsed.data as PreparePhoenixInput;
      const { dep, depWarn } = await getDep(ctx, input.chainId);
      if (!dep) return unavailable(input.chainId, "unknown_deployment", `no known Cork deployment for chainId ${input.chainId}`, ctx);
      const { corkAdapter, bundler3 } = dep;
      if (!corkAdapter || !bundler3) {
        return unavailable(input.chainId, "unknown_deployment", `tx-path contracts (corkAdapter/bundler3) are not configured for chainId ${input.chainId} (partial deployment — read tools still work); pass ctx.deployment to override`, ctx);
      }
      const nowSecs = nowSecondsOf(ctx);
      // deadlineAt (absolute) pins the bundle bytes across retries [K2]; deadlineSeconds
      // (relative, default) re-anchors to the clock on each call.
      const deadline = input.deadlineAt !== undefined ? BigInt(input.deadlineAt) : nowSecs + BigInt(input.deadlineSeconds);
      if (input.action.type === "authority-onboard" || input.action.type === "authority-revoke") {
        return handlePhoenixAuthority(input, depWarn, dep, ctx);
      }
      const actionLeg = buildPhoenixCall(input.action, corkAdapter, deadline);
      const warnings: Array<{ code: string; message: string }> = [...depWarn];
      // deadlineAt is validated for FORMAT only by the schema; a past moment builds fine and can
      // only revert on-chain — disclose it (the sibling deadlineSeconds is bounded-future) [F19].
      if (input.deadlineAt !== undefined && deadline <= nowSecs) {
        warnings.push({ code: "would_revert", message: `deadlineAt ${deadline} is not in the future (now ${nowSecs}) — the bundle would revert its deadline check on-chain; pin a future absolute deadline for byte-stable retries` });
      }
      let funding: Call[] = [];
      let sweepBack: Call[] = [];
      // Filled in whenever we read the pool, so the bundle summary can name tokens by their role.
      let tokenRoles: Record<string, string> | undefined;
      const roleMapOf = (t: { collateral: string; reference: string; cst: string; cpt: string }): Record<string, string> => ({
        [t.collateral.toLowerCase()]: "collateral",
        [t.reference.toLowerCase()]: "reference",
        [t.cst.toLowerCase()]: "cST",
        [t.cpt.toLowerCase()]: "cPT",
      });
      const mode = input.fundingMode as FundingMode;

      if (mode === "pre-funded") {
        // Caller guarantees tokens already sit in the adapter — nothing to fund. But when an
        // explicit RPC is configured, run the same pool-existence/expiry pre-flight the funded
        // path gets [F19]: 'pre-funded' must not silently skip guards the sibling mode enforces.
        const poolId = (input.action as { poolId?: `0x${string}` }).poolId;
        if (ctx.rpcUrl && poolId) {
          const resolved = await getRpc(ctx, input.chainId);
          if (resolved) {
            try {
              const tokens = await resolvePoolTokens(resolved.client, dep.poolManager, poolId, ctx.atBlock);
              const ZERO = "0x0000000000000000000000000000000000000000";
              if (tokens.collateral === ZERO || tokens.cst === ZERO || tokens.cpt === ZERO) {
                return unavailable(input.chainId, "pool_not_found", `pool ${poolId} does not exist on chainId ${input.chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
              }
              tokenRoles = roleMapOf(tokens);
              // 'pre-funded' gets the same guards as the funded path — it must not silently skip
              // checks its sibling enforces [F19].
              warnings.push(
                ...(await poolPreflightWarnings({
                  client: resolved.client,
                  poolManager: dep.poolManager,
                  whitelistManager: dep.whitelistManager,
                  corkAdapter,
                  poolId,
                  actionType: input.action.type,
                  account: input.account,
                  expiryTimestamp: tokens.expiryTimestamp,
                  nowSeconds: nowSecs,
                  atBlock: ctx.atBlock,
                })),
              );
            } catch {
              // best-effort — pre-funded byte-building stays offline-capable by design
            }
          }
        }
      } else if (!canAutoFund(input.action.type)) {
        warnings.push({ code: "manual_funding", message: `'${input.action.type}' has no auto-funding model in this iteration; fund the adapter manually or use fundingMode 'pre-funded'.` });
      } else if (!ctx.rpcUrl) {
        warnings.push({
          code: "funding_needs_rpc",
          message: `Funding leg for '${input.action.type}' needs an RPC to resolve pool token addresses; re-run with an RPC or use fundingMode 'pre-funded'. Bundle contains the action leg only.`,
        });
      } else {
        // Explicit RPC only (funding stays offline-by-default); routed through the resolver hook so
        // tests can stub the client, and guarded like every other chain read — a revert/transport
        // failure must map to an envelope, never escape raw (viem errors embed the RPC URL).
        const resolved = await getRpc(ctx, input.chainId);
        if (!resolved) return unavailable(input.chainId, "requires_rpc", "funding-leg resolution could not reach the configured RPC", ctx);
        const poolId = (input.action as { poolId: `0x${string}` }).poolId;
        let tokens;
        try {
          tokens = await resolvePoolTokens(resolved.client, dep.poolManager, poolId, ctx.atBlock);
        } catch (err) {
          return chainReadFailed(input.chainId, err, [], ctx, resolved);
        }
        // A nonexistent pool does NOT revert here — market() returns a zeroed struct. Refuse to
        // build funding legs against the zero address instead of emitting a plausible-looking
        // bundle that can only revert on-chain.
        const ZERO = "0x0000000000000000000000000000000000000000";
        if (tokens.collateral === ZERO || tokens.cst === ZERO || tokens.cpt === ZERO) {
          return unavailable(input.chainId, "pool_not_found", `pool ${poolId} does not exist on chainId ${input.chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
        }
        tokenRoles = roleMapOf(tokens);
        // Pre-flight guards [§5.4]: expiry, pause (global + per-pool bit), and whitelist. All
        // build-and-warn — a bundle that can only revert is still returned, clearly labelled.
        warnings.push(
          ...(await poolPreflightWarnings({
            client: resolved.client,
            poolManager: dep.poolManager,
            whitelistManager: dep.whitelistManager,
            corkAdapter,
            poolId,
            actionType: input.action.type,
            account: input.account,
            expiryTimestamp: tokens.expiryTimestamp,
            nowSeconds: nowSecondsOf(ctx),
            atBlock: ctx.atBlock,
          })),
        );
        // Sweep-back [F13]: auto-funding moves the caller's slippage CAP into the adapter, but the
        // pool consumes only the true amount. The delta is not just stranded — CoreAdapter's
        // erc20Transfer never checks receiver==initiator() and Bundler3.multicall is public, so
        // anyone can take it in a later block. Return it to the declared initiator in-bundle.
        const plan = fundingPlan(input.action, tokens, corkAdapter, mode, input.account);
        funding = plan.legs;
        sweepBack = plan.sweepLegs;
        if (plan.note) warnings.push({ code: "owner_managed_funding", message: plan.note });
        if (plan.sweepNote) warnings.push({ code: "sweep_back_skipped", message: plan.sweepNote });
        if (sweepBack.length) {
          warnings.push({
            code: "sweep_back",
            message: `this bundle ends with ${sweepBack.length} sweep-back leg(s) returning any unspent balance of ${plan.sweptTokens.join(", ")} to ${input.account}, because auto-funding moved a slippage CAP (not the exact amount) into the adapter. Each sweeps the adapter's FULL balance of that token (uint256.max sentinel), so it also returns any residual an earlier bundle abandoned there — that balance was already takeable by anyone. A zero residual is a no-op, not a revert.`,
          });
        }
      }

      const bundle = [...funding, actionLeg, ...sweepBack];
      const multicall = encodeMulticall(bundle);
      // What the caller is about to sign, in words. Token roles come from the pool read when we
      // did one, so amounts are attributed to "collateral"/"cST" rather than bare addresses.
      const summary = summarizeBundle(decodeBundle(multicall), { tokenRoles, account: input.account, adapter: corkAdapter });
      return envelope({
        state: "ok",
        data: { bundler3, corkAdapter, deadline, action: ACTION_MAP[input.action.type], fundingMode: mode, fundingLegs: funding.length, sweepBackLegs: sweepBack.length, summary, bundle, multicall, clientRequestId: input.clientRequestId },
        chainId: input.chainId,
        source: ctx.rpcUrl && funding.length ? "chain" : "config",
        warnings,
        ctx,
      });
    }
    case "cork_query":
      return handleQuery(parsed.data as QueryInput, ctx);
    case "cork_track":
      return handleTrack(parsed.data as TrackInput, ctx);
    case "cork_prepare_orders":
      return handlePrepareOrders(parsed.data as PrepareOrdersInput, ctx);
    case "cork_prepare_market":
      return handlePrepareMarket(parsed.data as Parameters<typeof handlePrepareMarket>[0], ctx);
    case "cork_submit":
      return handleSubmit(parsed.data as SubmitInput, ctx);
    default:
      return unavailable(chainIdOf(parsed.data), "phase_gated", `${name} is not implemented in this iteration`, ctx);
  }
}

export { computeMarketId };
export type { CorkActionParamMap };
