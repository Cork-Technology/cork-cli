// One typed dispatch shared by the MCP server and the CLI (RFC: "MCP + CLI over one core").
// Pure/offline tools are fully implemented; chain-backed compute runs when an RPC + addresses
// are supplied, else returns an honest `unavailable` envelope; unimplemented phases return
// `unavailable` with a reason rather than a fabricated result [K1/K3].
import { createPublicClient, http, keccak256, stringToHex, type PublicClient } from "viem";
import {
  ComputeInput,
  DecodeInput,
  Envelope,
  PreparePhoenixInput,
  QueryInput,
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
import { canAutoFund, fundingLegs, type FundingMode } from "./bundle/funding.ts";
import { readPoolState, resolvePoolTokens, type CorkAddresses } from "./chain/reads.ts";
import { verifyCreate2 } from "./create2.ts";
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
    if (!ctx.rpcUrl || !dep) {
      return unavailable(chainId, "requires_rpc", `${p.kind} needs an RPC endpoint and a known deployment for chainId ${chainId}`, ctx);
    }
    const client = createPublicClient({ transport: http(ctx.rpcUrl) });
    const addrs: CorkAddresses = { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter };
    const pinnedBlock = input.at?.block !== undefined ? BigInt(input.at.block) : ctx.atBlock;
    const s = await readPoolState(client as unknown as PublicClient, addrs, p.poolId, pinnedBlock);
    const swapRate = previewAdjustedRate({ market: s.market, state: s.constraintState, oracleRate: s.oracleRate, nowTs: s.blockTimestamp });

    if (p.kind === "cst-swap-rate") {
      const r = previewSwap(BigInt(p.collateralAssetsOut), { swapRate, swapFeePercentage: s.swapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals });
      return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r }, chainId, source: "chain", block: s.blockNumber, ctx });
    }
    if (p.kind === "unwind-rate") {
      const r = previewUnwindSwap(BigInt(p.collateralAssetsIn), { swapRate, unwindSwapFeePercentage: s.unwindSwapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals, issuedAt: s.issuedAt, expiryTimestamp: s.market.expiryTimestamp, nowTs: s.blockTimestamp });
      return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r }, chainId, source: "chain", block: s.blockNumber, ctx });
    }
    const floor = impairmentFloor({ market: s.market, state: s.constraintState, horizonSeconds: BigInt(p.horizonSeconds), tEval: s.blockTimestamp });
    return envelope({ state: "ok", data: { kind: p.kind, ...floor }, chainId, source: "chain", block: s.blockNumber, ctx });
  }

  return unavailable(chainId, "phase_gated", `compute kind '${p.kind}' is not implemented in this iteration`, ctx);
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
      const data = REGISTRY.map((t) => ({ name: t.name, cli: `cork ${t.cliPath.join(" ")}`, phase: t.phase, description: t.description, annotations: t.annotations }));
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
        warnings.push({
          code: "manual_funding",
          message: `'${input.action.type}' burns shares from its \`owner\`; share funding/owner handling is caller-managed (set \`owner\` and pre-position shares). No funding leg was auto-built.`,
        });
      } else if (!ctx.rpcUrl) {
        warnings.push({
          code: "funding_needs_rpc",
          message: `Funding leg for '${input.action.type}' needs an RPC to resolve pool token addresses; re-run with an RPC or use fundingMode 'pre-funded'. Bundle contains the action leg only.`,
        });
      } else {
        const client = createPublicClient({ transport: http(ctx.rpcUrl) });
        const poolId = (input.action as { poolId: `0x${string}` }).poolId;
        const tokens = await resolvePoolTokens(client as unknown as PublicClient, dep.poolManager, poolId, ctx.atBlock);
        funding = fundingLegs(input.action, tokens, dep.corkAdapter, mode);
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
    case "cork_query": {
      const input = parsed.data as QueryInput;
      return unavailable(chainIdOf(input), "phase_gated", `cork_query('${input.resource}') requires a data-source backend not wired in this iteration`, ctx);
    }
    default:
      return unavailable(chainIdOf(parsed.data), "phase_gated", `${name} is not implemented in this iteration`, ctx);
  }
}

export { computeMarketId };
export type { CorkActionParamMap };
