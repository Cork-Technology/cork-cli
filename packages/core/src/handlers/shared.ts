// Split from handlers.ts (2026-08-05): shared handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { keccak256, stringToHex } from "viem";
import { type ChainId, Envelope, SCHEMA_VERSION, type Teaching } from "@cork/schemas";
import { hostOf, isTransportError, reportEndpointFailure, type ResolvedRpc, RpcChainMismatchError } from "../chain/rpc.ts";
import { resolveRpc as resolveRpcBuiltin } from "../chain/rpc.ts";
import { resolveDeployment as resolveDeploymentBuiltin } from "../config-remote.ts";
import { type CorkDeployment } from "../config.ts";
import { type HyperSyncSource } from "../datasources/hypersync.ts";
import { type VenueDeps, VenueHttpError, VenueUnreachable } from "../datasources/venue.ts";
import { marketRegistryAbi, REGISTRY_DEPLOY_ERROR_NAMES } from "../market-registry.ts";

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

export function venueDepsOf(ctx: HandlerContext): VenueDeps {
  return { ...(ctx.venueFetch ? { fetch: ctx.venueFetch } : {}), ...(ctx.venueUrl ? { baseUrl: ctx.venueUrl } : {}) };
}

/** Map a venue read failure to an honest envelope (transport vs HTTP-rejection distinguished).
 *  5xx is a SERVER fault (likely transient — retry) and must not read as a permanent rejection. */
export function venueFailed(chainId: ChainId, err: unknown, ctx: HandlerContext): Envelope {
  if (err instanceof VenueHttpError) {
    if (err.status >= 500) {
      return unavailable(chainId, "venue_unreachable", `venue server error HTTP ${err.status}: ${err.message} — likely transient; retry (or check CORK_VENUE_URL)`, ctx);
    }
    if (err.status === 429) {
      return unavailable(chainId, "venue_rate_limited", `venue 429: ${err.message}${err.retryAfterSeconds !== undefined ? ` — retry after ${err.retryAfterSeconds}s` : ""} (per-user open-order caps / 100 req/min per IP)`, ctx);
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
export async function getRpc(ctx: HandlerContext, chainId: ChainId): Promise<ResolvedRpc | null> {
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
export async function getDep(ctx: HandlerContext, chainId: number): Promise<{ dep: CorkDeployment | undefined; depWarn: Array<{ code: string; message: string }> }> {
  if (ctx.deployment) return { dep: ctx.deployment, depWarn: [] };
  const r = await resolveDeploymentBuiltin(chainId);
  return { dep: r.deployment, depWarn: r.warning ? [r.warning] : [] };
}

/** Transparency warning when chain reads fell back to a community RPC (not the configured default). */
export function rpcWarn(r: ResolvedRpc): Array<{ code: string; message: string }> {
  // A mid-call switch is disclosed even when the heal landed back on the default tier: reads
  // earlier in the same result may have been served by the previous endpoint, and two nodes can
  // sit at different block heights — the caller deserves to know the result may mix moments.
  const midCall = r.failedOverInCall
    ? ` — the endpoint failed MID-CALL and reads failed over to ${hostOf(r.url)}; reads earlier in this result may have been served by the previous endpoint (possibly at a different block height)`
    : "";
  if (r.failedOverInCall && r.source !== "chainlist") {
    return [{ code: "rpc_fallback", message: `the resolved RPC endpoint failed during this call${midCall}` }];
  }
  return r.source === "chainlist"
    ? [{ code: "rpc_fallback", message: `configured default RPC was unreachable; used a public chainlist endpoint (${hostOf(r.url)}) for chain reads${midCall}` }]
    : [];
}

/** provenance.rpc payload for format:"full" — which endpoint tier/host served the chain read. */
export function rpcProvenance(format: "concise" | "full", r: ResolvedRpc): { rpc?: { source: "explicit" | "default" | "chainlist"; host: string } } {
  return format === "full" ? { rpc: { source: r.source, host: hostOf(r.url) } } : {};
}

/**
 * Map a failed chain read (contract revert, missing pool, transport error) to an honest
 * `unavailable` envelope instead of letting the raw exception escape runTool — the envelope +
 * exit-code contract must hold even when the chain disagrees with the request.
 */
export function chainReadFailed(chainId: ChainId, err: unknown, extra: Array<{ code: string; message: string }>, ctx: HandlerContext, endpoint?: ResolvedRpc): Envelope {
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
export function localComputeFailed(chainId: ChainId, err: unknown, extra: Array<{ code: string; message: string }>, ctx: HandlerContext): Envelope {
  const cause = firstLine(err);
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
export function nowSecondsOf(ctx: HandlerContext): bigint {
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

export function envelope(args: {
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

export function unavailable(chainId: ChainId, code: string, message: string, ctx: HandlerContext): Envelope {
  return envelope({ state: "unavailable", data: null, chainId, source: "config", warnings: [{ code, message }], ctx });
}

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/** Canonical Uniswap Permit2 (same address on every chain) — a pure chain constant, housed here
 *  so read handlers don't import an address from the side-effecting submit module. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** First line of an unknown error's message — the one spelling of the repeated
 *  `err instanceof Error ? err.message.split("\n")[0] : String(err)` idiom. */
export function firstLine(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? String(err)) : String(err);
}

/** A nonexistent pool does NOT revert — market() returns a zeroed struct. ONE predicate + ONE
 *  refusal envelope for every surface that must not build against the zero address (phoenix
 *  funded + pre-funded, forSelf); three private copies of both used to exist. */
export function poolMissing(tokens: { collateral: string; cst: string; cpt: string }): boolean {
  return tokens.collateral === ZERO_ADDR || tokens.cst === ZERO_ADDR || tokens.cpt === ZERO_ADDR;
}
export function poolNotFound(chainId: ChainId, poolId: string, ctx: HandlerContext): Envelope {
  return unavailable(chainId, "pool_not_found", `pool ${poolId} does not exist on chainId ${chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
}

/** deadlineAt (absolute) pins the bytes across retries [K2]; deadlineSeconds (relative, the
 *  default) re-anchors to the clock on each call. deadlineAt is validated for FORMAT only by
 *  the schema — a past moment builds fine and can only revert on-chain, so it is disclosed as
 *  would_revert, naming the component that reverts [F19]. One resolver for the three surfaces
 *  that take the pair (phoenix bundles, forSelf pool calls, forSelf fills). */
export function resolveDeadline(
  input: { deadlineAt?: string | undefined; deadlineSeconds: number },
  nowSecs: bigint,
  revertsAs: string,
): { deadline: bigint; warning?: { code: string; message: string } } {
  const deadline = input.deadlineAt !== undefined ? BigInt(input.deadlineAt) : nowSecs + BigInt(input.deadlineSeconds);
  if (input.deadlineAt !== undefined && deadline <= nowSecs) {
    return { deadline, warning: { code: "would_revert", message: `deadlineAt ${deadline} is not in the future (now ${nowSecs}) — ${revertsAs}; pin a future absolute deadline for byte-stable retries` } };
  }
  return { deadline };
}

/** One line naming a revert, PREFERRING the decoded custom error over viem's generic
 *  shortMessage. viem formats a decoded revert as
 *      The contract function "deploy" reverted.
 *      Error: NavModeWithoutNavSource(address ca, address ref)
 *      (0x211C…, 0xdDb4…)
 *  — the old first-match-wins scan returned the generic first line and threw the decoded
 *  name away (which mattered from 0.3.2 on: marketRegistryAbi declares the registry's typed
 *  errors precisely so they surface here). The args line directly under "Error:" rides
 *  along when present. Falls back to the generic line for undecodable/empty reverts. */
export function revertReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const lines = err.message.split("\n");
  const errorAt = lines.findIndex((l) => l.includes("Error:"));
  if (errorAt >= 0) {
    const args = lines[errorAt + 1]?.trim().startsWith("(") ? ` ${lines[errorAt + 1]?.trim()}` : "";
    return `${lines[errorAt]?.trim()}${args}`;
  }
  return (lines.find((l) => l.includes("reverted")) ?? lines[0] ?? err.message).trim();
}

/** Names a reverted MarketRegistry.deploy simulation precisely, instead of the one-size
 *  "unregistered asset / missing source / no conversion path" guess.
 *
 *  The registry's own failure classes revert with TYPED errors (declared on
 *  marketRegistryAbi, so viem decodes them into the message): MissingSource,
 *  NavModeWithoutNavSource, NoConversionPathToUsd, UnregisteredDenomination,
 *  SourceTypeMismatch, EntryNotFound. A revert naming NONE of those is the other class,
 *  observed live 2026-08-07 on sUSDe/sUSDS@42161: the wrapper factory's underlying
 *  MorphoChainlinkOracleV2 CREATE2 lands on an address a PREVIOUS registry generation
 *  already populated — the salt is keccak(ca, ref, caSource, refSource) with no
 *  generation domain separation, both generations use the same canonical Morpho factory,
 *  and the factory has no reuse path — so the raw create collision bubbles EMPTY revert
 *  data. The two are told apart by re-reading the pair's registration: a fully-registered
 *  pair whose deploy reverts without a named error is the collision, not a registration
 *  problem. Degrades to the generic text when the follow-up reads fail.
 *
 *  FIXED UPSTREAM in market-registry 0.3.3 (2026-08-10): the wrapper key/salt is now
 *  keccak256(abi.encode(registryAddress, ca, ref, caSource, refSource)) — every registry
 *  derives its own salt space, so the collision class cannot recur on 0.3.3+ registries
 *  (verified live: the original sUSDe/sUSDS pair simulates deployable on the new registry).
 *  The branch stays: legacy:true reads and foreign pre-0.3.3 registries still hit it. */
export async function diagnoseOracleDeployFailure(
  client: ResolvedRpc["client"],
  registry: `0x${string}`,
  collateralAsset: `0x${string}`,
  referenceAsset: `0x${string}`,
  mode: string,
  err: unknown,
): Promise<string> {
  const reason = revertReason(err);
  if (REGISTRY_DEPLOY_ERROR_NAMES.some((name) => reason.includes(name))) {
    return `${reason} — a registration problem; check cork_query registry-assets / registry-denominations / registry-feeds`;
  }
  const registered = await Promise.all(
    [collateralAsset, referenceAsset].map(async (addr) => {
      try {
        return (await client.readContract({ address: registry, abi: marketRegistryAbi, functionName: "isAsset", args: [addr] })) === true;
      } catch {
        return null;
      }
    }),
  );
  if (registered.every((found) => found === true)) {
    return (
      `${reason} — but BOTH assets are registered and the revert names no registry error: this is the CREATE2-collision class, not a registration problem. ` +
      `A previous registry generation already created this pair's identical underlying Morpho oracle (same canonical factory, same pair-derived salt), and the wrapper factory has no reuse path, ` +
      `so this registry cannot deploy the pair's ${mode} wrapper. Market-registry 0.3.3+ fixes the class (the wrapper salt is keyed on the registry address); this registry appears to be an older generation — on it the pair can host FIXED-recipe markets only (deploy-fixed-oracle + rateOverride)`
    );
  }
  const missing = [collateralAsset, referenceAsset].filter((_, i) => registered[i] === false);
  if (missing.length > 0) {
    return `${reason} — unregistered asset${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}; check cork_query registry-assets`;
  }
  return `${reason} — typically an unregistered asset, a missing source for this mode, or no conversion path; check cork_query registry-assets / registry-oracle`;
}

/** True when a failed chain call died in TRANSPORT (HTTP/timeout/socket) rather than in the
 *  contract — the ATTRIBUTION split (revert = definitive on-chain answer; transport =
 *  indeterminate). ONE comparator on purpose: this is chain/rpc.ts's `isTransportError` under
 *  the name the handlers grew up with. (Until 2026-08-06 this was a duplicated implementation —
 *  exactly the drift its own comment warned against.) */
export { isTransportError as isTransportFailure } from "../chain/rpc.ts";
