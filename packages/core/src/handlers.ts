// One typed dispatch shared by the MCP server and the CLI (RFC: "MCP + CLI over one core").
// Pure/offline tools are fully implemented; chain-backed compute runs when an RPC + addresses
// are supplied, else returns an honest `unavailable` envelope; unimplemented phases return
// `unavailable` with a reason rather than a fabricated result [K1/K3].
import { keccak256, stringToHex } from "viem";
import {
  Address,
  buildTeaching,
  type ChainId,
  MATURITY,
  searchTools,
  TOOL_EXAMPLES,
  type Teaching,
  type ToolName,
  ComputeInput,
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
  type PhoenixAction,
} from "@cork/schemas";
import { WAD, mulDiv } from "./math/fixed.ts";
import { impairmentFloor, previewAdjustedRate } from "./math/constraint.ts";
import { previewSwap, previewUnwindSwap } from "./math/preview.ts";
import { computeMarketId } from "./marketid.ts";
import { corkActionCall, type CorkActionParamMap } from "./bundle/actions.ts";
import { encodeMulticall, type Call } from "./bundle/bundler3.ts";
import { decodeBundle } from "./bundle/decode.ts";
import { canAutoFund, fundingPlan, type FundingMode } from "./bundle/funding.ts";
import { readPoolState, resolvePoolTokens, type CorkAddresses } from "./chain/reads.ts";
import { isTransportError, reportEndpointFailure, resolveRpc as resolveRpcBuiltin, hostOf, type ResolvedRpc } from "./chain/rpc.ts";
import { erc20Abi, whitelistManagerAbi } from "./chain/abis.ts";
import { verifyCreate2 } from "./create2.ts";
import { buildCancelOrder, buildMakerOrder, LOP_ADDRESSES } from "./orders.ts";
import { CREATE2_ATTESTATIONS, CREATE2_DEPLOYER, type CorkDeployment } from "./config.ts";
import { resolveConfig, resolveDeployment as resolveDeploymentBuiltin, resolveRollover } from "./config-remote.ts";
import { buildRolloverIntent, computeOrderDigest, intentStructHash, ORDER_DATA_TYPEHASH, type OrderDataStruct, type RolloverIntentStruct } from "./rollover.ts";
import { chainStatusName, fetchDigestLogs, labelLogs, LogsRangeLimited, resolveLogsEndpoint, settlerStatusAbi, venueChainConsistent } from "./rollover-verify.ts";
import { CLONE_DEPLOYED_TOPIC, decodeCloneRows, decodeLopFillRows, decodeMarketRows, decodeRolloverFillRows, loadHyperSync, LOP_FILLED_TOPIC, MARKET_CREATED_TOPIC, ROLLOVER_FILL_TOPICS, type HyperSyncSource } from "./datasources/hypersync.ts";
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
  postLopOrder,
  postRfq,
  postRfqAnswer,
  postRolloverOrder,
  venueBaseUrl,
  VenueHttpError,
  VenueUnreachable,
  type VenueDeps,
  type VenuePostResult,
} from "./datasources/venue.ts";
import { lopDomain } from "./orders.ts";
import { hashTypedData } from "viem";

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

/** Map a venue read failure to an honest envelope (transport vs HTTP-rejection distinguished). */
function venueFailed(chainId: ChainId, err: unknown, ctx: HandlerContext): Envelope {
  if (err instanceof VenueHttpError) {
    return unavailable(chainId, "venue_rejected", `venue returned HTTP ${err.status}: ${err.message}`, ctx);
  }
  if (err instanceof VenueUnreachable) {
    return unavailable(chainId, "venue_unreachable", `${err.message} — check connectivity or CORK_VENUE_URL`, ctx);
  }
  throw err;
}

/** Resolve a chain client via the ctx hook (default = built-in defaults + chainlist resolver). */
async function getRpc(ctx: HandlerContext, chainId: ChainId): Promise<ResolvedRpc | null> {
  return (ctx.resolveRpc ?? resolveRpcBuiltin)(chainId, ctx.rpcUrl);
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

/** Recursively convert bigint → decimal string so envelopes are JSON-safe. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

function nowIso(ctx: HandlerContext): string {
  const secs = ctx.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
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
      throw new Error(`phoenix action not buildable in phase 1: ${(p as { type: string }).type}`);
  }
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
    try {
      const s = await readPoolState(client, addrs, p.poolId, pinnedBlock);
      const swapRate = previewAdjustedRate({ market: s.market, state: s.constraintState, oracleRate: s.oracleRate, nowTs: s.blockTimestamp });

      if (p.kind === "cst-swap-rate") {
        const r = previewSwap(BigInt(p.collateralAssetsOut), { swapRate, swapFeePercentage: s.swapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals });
        return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r }, chainId, source: "chain", block: s.blockNumber, warnings: w, ...rpc, ctx });
      }
      if (p.kind === "unwind-rate") {
        const r = previewUnwindSwap(BigInt(p.collateralAssetsIn), { swapRate, unwindSwapFeePercentage: s.unwindSwapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals, issuedAt: s.issuedAt, expiryTimestamp: s.market.expiryTimestamp, nowTs: s.blockTimestamp });
        return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r }, chainId, source: "chain", block: s.blockNumber, warnings: w, ...rpc, ctx });
      }
      const floor = impairmentFloor({ market: s.market, state: s.constraintState, horizonSeconds: BigInt(p.horizonSeconds), tEval: s.blockTimestamp });
      return envelope({ state: "ok", data: { kind: p.kind, ...floor }, chainId, source: "chain", block: s.blockNumber, warnings: w, ...rpc, ctx });
    } catch (err) {
      return chainReadFailed(chainId, err, w, ctx, resolved);
    }
  }

  return unavailable(chainId, "phase_gated", `compute kind '${p.kind}' is not implemented in this iteration`, ctx);
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
}

function parseQueryFilters(raw: Record<string, unknown> | undefined): QueryFilters {
  const out: QueryFilters = {};
  const fail = (key: string, message: string): never => {
    throw new ToolInputError("cork_query", [{ path: ["filters", key], message }]);
  };
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
  return out;
}

/** Venue-backed resources (centralized mode) vs live-chain resources (lite-decentralized). */
const VENUE_RESOURCES = new Set(["markets", "orderbook", "fills", "limit-order-markets", "flows"]);

/**
 * full-decentralized [C12]: the event-derived subset over HyperSync. Structural honesty:
 * resting orders / RFQs emit no events — those resources are venue-only in EVERY mode.
 */
async function handleQueryHyperSync(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  const kind = filters.kind ?? "orders";
  const structural =
    input.resource === "orderbook" || input.resource === "limit-order-markets"
      ? `'${input.resource}' cannot be served in full-decentralized mode: resting orders live only at the venue (signed-but-unfilled orders emit no events, by design)`
      : input.resource === "flows" && kind === "orders"
        ? "flows kind='orders' cannot be served in full-decentralized mode: pre-commitment rollover orders emit no events; use kind='fills' or kind='contracts', or centralized mode for the order feed"
        : null;
  if (structural) return unavailable(chainId, "mode_unavailable", structural, ctx);

  const load = ctx.hyperSync ? { source: ctx.hyperSync } : await loadHyperSync(chainId, process.env.ENVIO_API_TOKEN);
  if ("error" in load) return unavailable(chainId, "hypersync_unavailable", load.error, ctx);
  const hs = load.source;

  try {
    let items: Array<Record<string, unknown>>;
    let archiveHeight: number | undefined;
    if (input.resource === "markets") {
      // Scan every configured Phoenix PM on this chain (primary deployment + named profiles).
      const cfg = await resolveConfig();
      const pms = new Set<string>();
      const primary = cfg.defaults.deployments[String(chainId)];
      if (primary) pms.add(primary.poolManager);
      for (const profile of Object.values(cfg.defaults.deploymentProfiles?.[String(chainId)] ?? {})) pms.add(profile.poolManager);
      if (pms.size === 0) return unavailable(chainId, "unknown_deployment", `no Cork deployment configured for chainId ${chainId}`, ctx);
      const r = await hs.queryLogs({ fromBlock: 0, address: [...pms], topics: [[MARKET_CREATED_TOPIC]] });
      archiveHeight = r.archiveHeight;
      items = decodeMarketRows(r.logs);
      if (filters.poolId) items = items.filter((m) => String(m.poolId).toLowerCase() === filters.poolId!.toLowerCase());
    } else if (input.resource === "fills") {
      const lop = LOP_ADDRESSES[chainId];
      if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
      const r = await hs.queryLogs({ fromBlock: 0, address: [lop], topics: [[LOP_FILLED_TOPIC]] });
      archiveHeight = r.archiveHeight;
      items = decodeLopFillRows(r.logs);
      if (filters.orderHash) items = items.filter((f) => String(f.orderHash).toLowerCase() === filters.orderHash!.toLowerCase());
    } else {
      // flows kind=fills|contracts — needs the rollover deployment (settlers/factory + seed block).
      const { rollover } = await resolveRollover(chainId);
      if (!rollover) return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId}`, ctx);
      if (kind === "fills") {
        const topics: Array<string[] | null> = [ROLLOVER_FILL_TOPICS];
        if (filters.orderDigest) topics.push([filters.orderDigest]);
        const r = await hs.queryLogs({ fromBlock: rollover.seededAtBlock, address: [rollover.exactSettler, rollover.partialSettler], topics });
        archiveHeight = r.archiveHeight;
        items = decodeRolloverFillRows(r.logs);
        if (filters.filler) items = items.filter((f) => String(f.filler).toLowerCase() === filters.filler!.toLowerCase());
      } else {
        const r = await hs.queryLogs({ fromBlock: rollover.seededAtBlock, address: [rollover.factory], topics: [[CLONE_DEPLOYED_TOPIC]] });
        archiveHeight = r.archiveHeight;
        items = decodeCloneRows(r.logs);
        if (filters.account) items = items.filter((c) => String(c.owner).toLowerCase() === filters.account!.toLowerCase());
      }
    }
    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        ...(input.resource === "flows" ? { kind } : {}),
        count: items.length,
        items,
        ...(archiveHeight !== undefined ? { archiveHeight } : {}),
      },
      chainId,
      source: "chain",
      mode: "full-decentralized",
      ctx,
    });
  } catch (err) {
    return unavailable(chainId, "hypersync_unavailable", `HyperSync query failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, ctx);
  }
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
    try {
      let list: import("./datasources/venue.ts").VenueList;
      if (input.resource === "markets") {
        list = await getPools(deps, chainId);
        if (filters.poolId) list = { ...list, items: list.items.filter((r) => String(r.poolId).toLowerCase() === filters.poolId!.toLowerCase()) };
      } else if (input.resource === "orderbook") {
        list = await getLopOrderbook(deps, { chainId, ...(filters.poolId ? { poolId: filters.poolId } : {}), ...(filters.side ? { side: filters.side } : {}), ...(filters.status ? { status: filters.status } : {}) });
      } else if (input.resource === "fills") {
        list = await getLopFills(deps, { chainId, ...(filters.orderHash ? { orderHash: filters.orderHash } : {}) });
      } else if (input.resource === "limit-order-markets") {
        list = await getLopMarkets(deps, chainId);
      } else {
        // flows = the rollover venue; filters.kind picks the feed (orders default).
        const kind = filters.kind ?? "orders";
        if (kind === "orders") {
          if (filters.orderDigest) {
            const row = await getRolloverOrder(deps, filters.orderDigest);
            if (!row) return unavailable(chainId, "order_not_found", `rollover order ${filters.orderDigest} is unknown to the venue (a normal outcome for a never-posted digest)`, ctx);
            list = { items: [row] };
          } else {
            list = await getRolloverOrders(deps, { chainId, ...(filters.account ? { user: filters.account.toLowerCase() } : {}), ...(filters.poolId ? { poolId: filters.poolId } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.fillable !== undefined ? { fillable: filters.fillable } : {}), ...(filters.source ? { source: filters.source } : {}) });
          }
        } else if (kind === "fills") {
          list = await getRolloverFills(deps, { chainId, ...(filters.orderDigest ? { orderDigest: filters.orderDigest } : {}), ...(filters.filler ? { filler: filters.filler.toLowerCase() } : {}) });
        } else {
          list = await getRolloverContracts(deps, { chainId, ...(filters.account ? { owner: filters.account.toLowerCase() } : {}), ...(filters.address ? { address: filters.address.toLowerCase() } : {}) });
        }
      }
      return envelope({
        state: "ok",
        data: {
          resource: input.resource,
          ...(input.resource === "flows" ? { kind: filters.kind ?? "orders" } : {}),
          count: list.items.length,
          items: list.items,
          ...(list.hasMore !== undefined ? { hasMore: list.hasMore } : {}),
          ...(list.nextCursor != null ? { nextCursor: list.nextCursor } : {}),
          ...(input.format === "full" ? { venue: venueBaseUrl(ctx.venueUrl) } : {}),
        },
        chainId,
        source: "indexer",
        ctx,
      });
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  // Data mode is explicit, never a silent fallback [R1/§7]: chain resources serve only
  // lite-decentralized (RPC). Requesting an unwired mode fails loudly instead of being ignored.
  if (input.mode !== undefined && input.mode !== "lite-decentralized") {
    return unavailable(chainId, "mode_unavailable", `data mode '${input.mode}' is not available for cork_query('${input.resource}') (a live chain read); omit mode or use 'lite-decentralized'`, ctx);
  }
  const { dep, depWarn } = await getDep(ctx, chainId);

  // protocol-config is pure config (no RPC needed).
  if (input.resource === "protocol-config") {
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known deployment for chainId ${chainId}`, ctx);
    return envelope({ state: "ok", data: { chainId, deployment: dep, create2Deployer: CREATE2_DEPLOYER }, chainId, source: "config", warnings: depWarn, ctx });
  }

  const chainResources = new Set(["market", "account-state", "pool-whitelist"]);
  if (!chainResources.has(input.resource)) {
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
          poolId: s.poolId,
          market: s.market,
          constraintState: s.constraintState,
          swapRate: s.onChainSwapRate,
          oracleRate: s.oracleRate,
          swapFeePercentage: s.swapFeePercentage,
          unwindSwapFeePercentage: s.unwindSwapFeePercentage,
          collateralDecimals: s.collateralDecimals,
          referenceDecimals: s.referenceDecimals,
          cstToken: s.cstToken,
          cptToken: s.cptToken,
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
      const bal = (token: `0x${string}`) =>
        client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [filters.account!], ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}) });
      const [collateral, reference, cst, cpt] = await Promise.all([bal(tokens.collateral), bal(tokens.reference), bal(tokens.cst), bal(tokens.cpt)]);
      return envelope({ state: "ok", data: { poolId: filters.poolId, account: filters.account, balances: { collateral, reference, cst, cpt }, tokens }, chainId, source: "chain", warnings: w, ...rpc, ctx });
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
    return envelope({ state: "ok", data: { poolId: filters.poolId, account: filters.account, isWhitelisted }, chainId, source: "chain", warnings: w, ...rpc, ctx });
  } catch (err) {
    return chainReadFailed(chainId, err, w, ctx, resolved);
  }
}

async function handlePrepareOrders(input: PrepareOrdersInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const action = input.action;

  if (action.type === "maker-order") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const nowSecs = ctx.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
    const built = buildMakerOrder({
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
      ...(action.extension !== undefined ? { extension: action.extension } : {}),
    });
    return envelope({
      state: "ok",
      data: {
        kind: "maker-order",
        lop,
        typedData: { domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.order },
        orderHash: built.orderHash,
        extension: built.extension,
        clientRequestId: input.clientRequestId,
      },
      chainId,
      source: "config",
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
    const nowSecs = ctx.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
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

  // taker-fill needs the resting order from the orderbook, which is not wired in this iteration.
  return unavailable(chainId, "needs_service", `prepare_orders '${action.type}' requires the orderbook service not wired in this iteration`, ctx);
}

async function handleTrack(input: TrackInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const subj = input.subject;

  // simulate (dry-running frozen bytes against a fork) is a distinct capability that is not
  // implemented yet — gate it explicitly instead of silently behaving like verify [K1].
  if (input.mode === "simulate") {
    return unavailable(chainId, "phase_gated", "track mode 'simulate' (dry-run of frozen bytes) is not implemented in this iteration; use mode 'verify' or 'reconcile'", ctx);
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
      return envelope({ state: "ok", data: { txHash: subj.txHash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, logs: r.logs.length }, chainId, source: "chain", block: r.blockNumber, ...rpc, ctx });
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

          // Event-history leg via a logs-capable endpoint (HyperRPC preferred).
          const logsUrl = resolveLogsEndpoint(chainId, ctx.logsUrl);
          if (logsUrl && rollover) {
            try {
              const logs = await fetchDigestLogs({
                url: logsUrl,
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
          } else if (!logsUrl) {
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
        const fills = await getLopFills(deps, { chainId, orderHash: ref.toLowerCase() });
        if (fills.items.length > 0) {
          return envelope({
            state: "ok",
            data: { kind: "lop-fills", orderHash: ref.toLowerCase(), count: fills.items.length, fills: fills.items },
            chainId,
            source: "indexer",
            warnings: [venueNote],
            ctx,
          });
        }
        return unavailable(chainId, "order_not_found", `no rollover order or LOP fills known to the venue for ${ref} on chainId ${chainId} (a normal outcome for an unposted/unfilled order)`, ctx);
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
    return unavailable(chainId, "venue_rejected", `venue ${res.httpStatus}: ${msg}`, ctx);
  };

  try {
    if (action.type === "rollover-order") {
      const o = action.order;
      // Single-chain protocol: the routing fields must match the target chain (venue rejects too).
      if (o.originChainId !== String(chainId) || o.destinationChainId !== String(chainId)) {
        return unavailable(chainId, "invalid_order_terms", `originChainId/destinationChainId must equal chainId ${chainId} (single-chain rollover)`, ctx);
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
      if (action.quoteRef) {
        const rfq = await getRfq(deps, action.quoteRef.rfqId);
        if (!rfq) return unavailable(chainId, "invalid_order_terms", `quote_ref cites unknown RFQ '${action.quoteRef.rfqId}'`, ctx);
        const answers = (rfq.answers ?? []) as Array<{ answer_id?: unknown; answer?: { options?: Array<Record<string, unknown>> } }>;
        const answer = answers.find((a) => String(a.answer_id) === action.quoteRef!.answerId);
        const option = answer?.answer?.options?.find((o) => String(o.option_id) === action.quoteRef!.optionId);
        if (!option) return unavailable(chainId, "invalid_order_terms", `quote_ref option '${action.quoteRef.optionId}' not found in answer '${action.quoteRef.answerId}' of RFQ '${action.quoteRef.rfqId}'`, ctx);
        const fraction = Number(option.premium_annualized);
        if (Number.isFinite(fraction) && fraction > 0) {
          const expectedPercent = fraction * 100;
          const ratio = action.premium / expectedPercent;
          if (ratio >= 100 || ratio <= 0.01) {
            return envelope({
              state: "conflict",
              data: { declaredPremiumPercent: action.premium, citedOptionFraction: option.premium_annualized, expectedPercent },
              chainId,
              source: "service",
              warnings: [{ code: "premium_scale_mismatch", message: `declared premium ${action.premium} diverges ~${ratio >= 100 ? Math.round(ratio) : `1/${Math.round(1 / ratio)}`}x from the cited quote (${option.premium_annualized} fraction = ${expectedPercent}%) — a scale mistake; NOT relayed (the venue rejects the same way)` }],
              ctx,
            });
          }
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
        if (p !== undefined && (typeof p !== "string" || !/^(0|0\.\d{1,18})$/.test(p) || Number(p) >= 0.5)) {
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
      if (input.kind !== "calldata") {
        return unavailable(chainId, "phase_gated", `decode kind '${input.kind}' is not implemented in this iteration`, ctx);
      }
      if (typeof input.data !== "string") {
        throw new ToolInputError(name, "calldata decode requires a hex string");
      }
      const legs = decodeBundle(input.data as `0x${string}`);
      return envelope({ state: "ok", data: { kind: "calldata", legs }, chainId, source: "config", ctx });
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
      const nowSecs = ctx.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
      const deadline = nowSecs + BigInt(input.deadlineSeconds);
      if (input.action.type === "authority-onboard" || input.action.type === "authority-revoke") {
        return unavailable(input.chainId, "phase_gated", `token-authority op '${input.action.type}' is not built in this iteration`, ctx);
      }
      const actionLeg = buildPhoenixCall(input.action, corkAdapter, deadline);
      const warnings: Array<{ code: string; message: string }> = [...depWarn];
      let funding: Call[] = [];
      const mode = input.fundingMode as FundingMode;

      if (mode === "pre-funded") {
        // caller guarantees tokens already sit in the adapter — nothing to fund.
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
        const plan = fundingPlan(input.action, tokens, corkAdapter, mode);
        funding = plan.legs;
        if (plan.note) warnings.push({ code: "owner_managed_funding", message: plan.note });
      }

      const bundle = [...funding, actionLeg];
      const multicall = encodeMulticall(bundle);
      return envelope({
        state: "ok",
        data: { bundler3, corkAdapter, deadline, action: ACTION_MAP[input.action.type], fundingMode: mode, fundingLegs: funding.length, bundle, multicall, clientRequestId: input.clientRequestId },
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
    case "cork_submit":
      return handleSubmit(parsed.data as SubmitInput, ctx);
    default:
      return unavailable(chainIdOf(parsed.data), "phase_gated", `${name} is not implemented in this iteration`, ctx);
  }
}

export { computeMarketId };
export type { CorkActionParamMap };
