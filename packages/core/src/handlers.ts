// One typed dispatch shared by the MCP server and the CLI (RFC: "MCP + CLI over one core").
// Pure/offline tools are fully implemented; chain-backed compute runs when an RPC + addresses
// are supplied, else returns an honest `unavailable` envelope; unimplemented phases return
// `unavailable` with a reason rather than a fabricated result [K1/K3].
import { createPublicClient, http, keccak256, stringToHex, type PublicClient } from "viem";
import {
  ComputeInput,
  DecodeInput,
  Envelope,
  inputJsonSchema,
  PrepareOrdersInput,
  PreparePhoenixInput,
  QueryInput,
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
import { resolveRpc as resolveRpcBuiltin, hostOf, type ResolvedRpc } from "./chain/rpc.ts";
import { erc20Abi, whitelistManagerAbi } from "./chain/abis.ts";
import { verifyCreate2 } from "./create2.ts";
import { buildCancelOrder, buildMakerOrder, LOP_ADDRESSES } from "./orders.ts";
import { CREATE2_ATTESTATIONS, CREATE2_DEPLOYER, deploymentFor, type CorkDeployment } from "./config.ts";

export class ToolInputError extends Error {
  constructor(
    public tool: string,
    public issues: unknown,
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
  resolveRpc?: (chainId: number, explicitUrl: string | undefined) => Promise<ResolvedRpc | null>;
}

/** Resolve a chain client via the ctx hook (default = built-in defaults + chainlist resolver). */
async function getRpc(ctx: HandlerContext, chainId: number): Promise<ResolvedRpc | null> {
  return (ctx.resolveRpc ?? resolveRpcBuiltin)(chainId, ctx.rpcUrl);
}

/** Transparency warning when chain reads fell back to a community RPC (not the configured default). */
function rpcWarn(r: ResolvedRpc): Array<{ code: string; message: string }> {
  return r.source === "chainlist"
    ? [{ code: "rpc_fallback", message: `configured default RPC was unreachable; used a public chainlist endpoint (${hostOf(r.url)}) for chain reads` }]
    : [];
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
  chainId: number;
  source: "chain" | "indexer" | "service" | "config";
  block?: bigint;
  warnings?: Array<{ code: string; message: string }>;
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
      chainId: args.chainId as never,
      fetchedAt: nowIso(args.ctx),
      digest,
      ...(args.block !== undefined ? { block: args.block.toString() } : {}),
    },
    schemaVersion: SCHEMA_VERSION,
  };
}

function unavailable(chainId: number, code: string, message: string, ctx: HandlerContext): Envelope {
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
    const dep = ctx.deployment ?? deploymentFor(chainId);
    const resolved = dep ? await getRpc(ctx, chainId) : null;
    if (!resolved || !dep) {
      return unavailable(chainId, "requires_rpc", `${p.kind} needs an RPC endpoint and a known deployment for chainId ${chainId}`, ctx);
    }
    const client = resolved.client;
    const w = rpcWarn(resolved);
    const addrs: CorkAddresses = { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter };
    const pinnedBlock = input.at?.block !== undefined ? BigInt(input.at.block) : ctx.atBlock;
    const s = await readPoolState(client, addrs, p.poolId, pinnedBlock);
    const swapRate = previewAdjustedRate({ market: s.market, state: s.constraintState, oracleRate: s.oracleRate, nowTs: s.blockTimestamp });

    if (p.kind === "cst-swap-rate") {
      const r = previewSwap(BigInt(p.collateralAssetsOut), { swapRate, swapFeePercentage: s.swapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals });
      return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r }, chainId, source: "chain", block: s.blockNumber, warnings: w, ctx });
    }
    if (p.kind === "unwind-rate") {
      const r = previewUnwindSwap(BigInt(p.collateralAssetsIn), { swapRate, unwindSwapFeePercentage: s.unwindSwapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals, issuedAt: s.issuedAt, expiryTimestamp: s.market.expiryTimestamp, nowTs: s.blockTimestamp });
      return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r }, chainId, source: "chain", block: s.blockNumber, warnings: w, ctx });
    }
    const floor = impairmentFloor({ market: s.market, state: s.constraintState, horizonSeconds: BigInt(p.horizonSeconds), tEval: s.blockTimestamp });
    return envelope({ state: "ok", data: { kind: p.kind, ...floor }, chainId, source: "chain", block: s.blockNumber, warnings: w, ctx });
  }

  return unavailable(chainId, "phase_gated", `compute kind '${p.kind}' is not implemented in this iteration`, ctx);
}

async function handleQuery(input: QueryInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const dep = ctx.deployment ?? deploymentFor(chainId);
  const filters = (input.filters ?? {}) as { poolId?: `0x${string}`; account?: `0x${string}` };

  // protocol-config is pure config (no RPC needed).
  if (input.resource === "protocol-config") {
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known deployment for chainId ${chainId}`, ctx);
    return envelope({ state: "ok", data: { chainId, deployment: dep, create2Deployer: CREATE2_DEPLOYER }, chainId, source: "config", ctx });
  }

  const chainResources = new Set(["market", "account-state", "pool-whitelist"]);
  if (!chainResources.has(input.resource)) {
    return unavailable(chainId, "needs_indexer", `cork_query('${input.resource}') requires an indexer/service backend not wired in this iteration`, ctx);
  }
  const resolved = dep ? await getRpc(ctx, chainId) : null;
  if (!resolved || !dep) {
    return unavailable(chainId, "requires_rpc", `cork_query('${input.resource}') needs an RPC endpoint and a known deployment for chainId ${chainId}`, ctx);
  }
  if (!filters.poolId) return unavailable(chainId, "missing_filter", `cork_query('${input.resource}') requires filters.poolId`, ctx);

  const client = resolved.client;
  const w = rpcWarn(resolved);
  const addrs: CorkAddresses = { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter };

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
      ctx,
    });
  }

  if (input.resource === "account-state") {
    if (!filters.account) return unavailable(chainId, "missing_filter", "account-state requires filters.account", ctx);
    const tokens = await resolvePoolTokens(client, dep.poolManager, filters.poolId, ctx.atBlock);
    const bal = (token: `0x${string}`) =>
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [filters.account!], ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}) });
    const [collateral, reference, cst, cpt] = await Promise.all([bal(tokens.collateral), bal(tokens.reference), bal(tokens.cst), bal(tokens.cpt)]);
    return envelope({ state: "ok", data: { poolId: filters.poolId, account: filters.account, balances: { collateral, reference, cst, cpt }, tokens }, chainId, source: "chain", warnings: w, ctx });
  }

  // pool-whitelist
  if (!filters.account) return unavailable(chainId, "missing_filter", "pool-whitelist requires filters.account", ctx);
  const isWhitelisted = await client.readContract({
    address: dep.whitelistManager,
    abi: whitelistManagerAbi,
    functionName: "isWhitelisted",
    args: [filters.poolId, filters.account],
    ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}),
  });
  return envelope({ state: "ok", data: { poolId: filters.poolId, account: filters.account, isWhitelisted }, chainId, source: "chain", warnings: w, ctx });
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
    });
    return envelope({
      state: "ok",
      data: {
        kind: "maker-order",
        lop,
        typedData: { domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.order },
        orderHash: built.orderHash,
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

  // taker-fill needs the resting order from the orderbook; rollover-intent needs the CorkSettler
  // ERC-7683 domain (rollover PR #161) — neither backend is wired in this iteration.
  return unavailable(chainId, "needs_service", `prepare_orders '${action.type}' requires the orderbook/rollover service not wired in this iteration`, ctx);
}

async function handleTrack(input: TrackInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const subj = input.subject;

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
  const dep = ctx.deployment ?? deploymentFor(chainId);
  if (subj.kind === "marketRef") {
    const resolved = dep ? await getRpc(ctx, chainId) : null;
    if (!resolved || !dep) return unavailable(chainId, "requires_rpc", "marketRef verification needs an RPC + known deployment", ctx);
    const client = resolved.client;
    const s = await readPoolState(client, { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter }, subj.poolId, ctx.atBlock);
    const idMatches = computeMarketId(s.market).toLowerCase() === subj.poolId.toLowerCase();
    return envelope({
      state: idMatches ? "ok" : "conflict",
      data: { verified: idMatches, poolId: s.poolId, marketIdRecomputed: computeMarketId(s.market), swapRate: s.onChainSwapRate, market: s.market },
      chainId,
      source: "chain",
      block: s.blockNumber,
      warnings: idMatches ? rpcWarn(resolved) : [{ code: "marketid_mismatch", message: "on-chain market params do not hash to the requested poolId" }, ...rpcWarn(resolved)],
      ctx,
    });
  }

  if (subj.kind === "txHash") {
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", "txHash reconcile needs an RPC", ctx);
    const client = resolved.client;
    try {
      const r = await client.getTransactionReceipt({ hash: subj.txHash });
      return envelope({ state: "ok", data: { txHash: subj.txHash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, logs: r.logs.length }, chainId, source: "chain", block: r.blockNumber, ctx });
    } catch {
      return envelope({ state: "unavailable", data: { txHash: subj.txHash, found: false }, chainId, source: "chain", warnings: [{ code: "receipt_not_found", message: "no receipt for this txHash at the RPC (pending or unknown)" }], ctx });
    }
  }

  // orderHash / submissionRef need the LOP/orderbook service.
  return unavailable(chainId, "needs_service", `track subject '${subj.kind}' requires the orderbook/LOP service not wired in this iteration`, ctx);
}

/** Validate + dispatch a tool call. Throws ToolInputError on schema failure. */
export async function runTool(name: string, rawInput: unknown, ctx: HandlerContext = {}): Promise<Envelope> {
  const def = toolByName(name);
  if (!def) throw new ToolInputError(name, `unknown tool: ${name}`);
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(name, parsed.error.issues);
  const chainIdOf = (x: unknown): number => (x as { chainId?: number }).chainId ?? 1;

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
      const card = (t: (typeof REGISTRY)[number]) => ({ name: t.name, cli: `ch ${t.cliPath.join(" ")}`, phase: t.phase, description: t.description, annotations: t.annotations });

      // search: keyword -> matching tools (name/cli/description), with the filled input schema.
      if (input.search) {
        const q = input.search.toLowerCase();
        const matches = REGISTRY.filter((t) => `${t.name} ${t.cliPath.join(" ")} ${t.description}`.toLowerCase().includes(q));
        return envelope({ state: "ok", data: { query: input.search, matches: matches.map((t) => ({ ...card(t), inputSchema: inputJsonSchema(t.name) })) }, chainId: 1, source: "config", ctx });
      }

      // topic: a tool name (with or without cork_ prefix) or cli leaf -> that tool's full doc.
      if (input.topic) {
        const key = input.topic.toLowerCase();
        const t = REGISTRY.find((x) => x.name.toLowerCase() === key || x.name.toLowerCase() === `cork_${key}` || x.cliPath.join(" ").toLowerCase() === key || x.cliPath[x.cliPath.length - 1]?.toLowerCase() === key);
        if (!t) return unavailable(1, "unknown_topic", `no tool matches topic '${input.topic}'; try search or omit args for the full list`, ctx);
        return envelope({ state: "ok", data: { ...card(t), inputSchema: inputJsonSchema(t.name), output: "Envelope" }, chainId: 1, source: "config", ctx });
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
      const dep = ctx.deployment ?? deploymentFor(input.chainId);
      if (!dep) return unavailable(input.chainId, "unknown_deployment", `no known Cork deployment for chainId ${input.chainId}`, ctx);
      const nowSecs = ctx.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
      const deadline = nowSecs + BigInt(input.deadlineSeconds);
      if (input.action.type === "authority-onboard" || input.action.type === "authority-revoke") {
        return unavailable(input.chainId, "phase_gated", `token-authority op '${input.action.type}' is not built in this iteration`, ctx);
      }
      const actionLeg = buildPhoenixCall(input.action, dep.corkAdapter, deadline);
      const warnings: Array<{ code: string; message: string }> = [];
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
        const client = createPublicClient({ transport: http(ctx.rpcUrl) });
        const poolId = (input.action as { poolId: `0x${string}` }).poolId;
        const tokens = await resolvePoolTokens(client as unknown as PublicClient, dep.poolManager, poolId, ctx.atBlock);
        const plan = fundingPlan(input.action, tokens, dep.corkAdapter, mode);
        funding = plan.legs;
        if (plan.note) warnings.push({ code: "owner_managed_funding", message: plan.note });
      }

      const bundle = [...funding, actionLeg];
      const multicall = encodeMulticall(bundle);
      return envelope({
        state: "ok",
        data: { bundler3: dep.bundler3, corkAdapter: dep.corkAdapter, deadline, action: ACTION_MAP[input.action.type], fundingMode: mode, fundingLegs: funding.length, bundle, multicall, clientRequestId: input.clientRequestId },
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
    default:
      return unavailable(chainIdOf(parsed.data), "phase_gated", `${name} is not implemented in this iteration`, ctx);
  }
}

export { computeMarketId };
export type { CorkActionParamMap };
