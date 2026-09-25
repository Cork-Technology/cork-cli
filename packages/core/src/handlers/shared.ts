// Split from handlers.ts (2026-08-05): shared handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { keccak256, stringToHex } from "viem";
import { type ChainId, Envelope, SCHEMA_VERSION, type Teaching } from "@cork/schemas";
import { hostOf, isTransportError, reportEndpointFailure, type ResolvedRpc, RpcChainMismatchError, RpcChainVerificationError } from "../chain/rpc.ts";
import { resolveRpc as resolveRpcBuiltin } from "../chain/rpc.ts";
import { resolveDeployment as resolveDeploymentBuiltin, resolveGenerations, resolveMarketRegistry, type CorkMarketRegistry } from "../config-remote.ts";
import { type CorkDeployment } from "../config.ts";
import { type GenerationBlockKind, type GenerationRef, type GenerationRefusal, IMPLEMENTED_MARKET_REGISTRY_WIRES, isGenerationAlias, renamedGenerationLabel, type MarketRegistryWire, type PhoenixWire, type PoolGenerationClient, type PoolGenerationResolution, resolveGenerationAlias, resolvePoolGeneration } from "../generations.ts";
import { type HyperSyncSource } from "../datasources/hypersync.ts";
import { VenueAborted, type VenueDeps, VenueHttpError, VenueUnreachable } from "../datasources/venue.ts";
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
  /** Address overrides; defaults to the built-in deployment for the chainId (the SDK override —
   *  wins over `generation`). */
  deployment?: CorkDeployment;
  /** Select a non-primary GENERATION by label (generations.ts) for every chain-backed read and
   *  prepare in this call; omitted = the chain's primary. An unknown label refuses
   *  `generation_unknown` (listing the chain's labels); a read-only set refuses a PREPARE with
   *  `generation_read_only`. */
  generation?: string;
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
  /**
   * Cancellation for this call's outbound work. The HTTP projection sets it from the request's
   * deadline, so a caller who walks away (or exceeds the budget) stops the venue traffic their
   * request started rather than leaving it to finish into a response nobody will read.
   * Propagated to the VENUE transport (`VenueDeps.signal`), which composes it with its own
   * per-call timeout, refuses to start a call once aborted, and reports an abort as
   * `request_aborted` rather than a venue failure; the long-poll sleep resolves early on it.
   * RPC and HyperSync clients keep their own per-call timeouts and are NOT wired to it.
   */
  signal?: AbortSignal;
  /**
   * Sleep between long-poll reads (`cork_query orderbook` with `wait`). Defaults to a real timer
   * that resolves early on `signal`; tests inject an instant sleep so a poll loop is driven by its
   * poll COUNT, never by the wall clock.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The default `HandlerContext.sleep`: a timer that resolves early when `signal` aborts. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function venueDepsOf(ctx: HandlerContext): VenueDeps {
  return {
    ...(ctx.venueFetch ? { fetch: ctx.venueFetch } : {}),
    ...(ctx.venueUrl ? { baseUrl: ctx.venueUrl } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
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
  if (err instanceof VenueAborted) {
    // "not started" is definitive (no bytes left this process); "cancelled mid-flight" is not —
    // a relay may have reached the venue before the abort, and only the venue's own idempotency
    // (a replay on the same clientRequestId, a 409 on a different payload) can say.
    return unavailable(chainId, "request_aborted", `${err.message} — the caller's deadline or cancellation ended this request, and no venue failure was recorded (the venue did nothing wrong). ${err.message.includes("not started") ? "Nothing was sent." : "A call cancelled mid-flight MAY have reached the venue."} Retry with the same clientRequestId if the work is still wanted [K2]: a relay the venue already took answers as a replay, never as a second order`, ctx);
  }
  throw err;
}

/** Resolve a chain client via the ctx hook (default = built-in defaults + chainlist resolver).
 *  A wrong-chain EXPLICIT endpoint (F21) surfaces as teachable invalid input, not a raw throw. */
export async function getRpc(ctx: HandlerContext, chainId: ChainId): Promise<ResolvedRpc | null> {
  try {
    return await (ctx.resolveRpc ?? resolveRpcBuiltin)(chainId, ctx.rpcUrl);
  } catch (err) {
    // Both failures are about the endpoint the caller explicitly configured, so both surface as
    // teachable input errors naming `rpcUrl` rather than degrading to "no RPC resolved" — which
    // would tell an operator who HAS set CORK_RPC_URL to go and set it (audit MCP-NET-002).
    // A mismatch is proven wrong-chain; a verification failure is an absence of proof and the
    // message says so, so a retry after connectivity returns is the obvious next move.
    if (err instanceof RpcChainMismatchError || err instanceof RpcChainVerificationError) {
      throw new ToolInputError("rpc-resolution", [{ path: ["rpcUrl"], message: err.message }]);
    }
    throw err;
  }
}

/**
 * Resolve the deployment for a chain: ctx override -> remote-first defaults (GitHub-fetched,
 * TTL-cached, bundled fallback) of the generation `ctx.generation` selects (the primary when
 * omitted). Returns any config-sourcing warning to append to the envelope, the generation
 * reference the block came from, and — when the label was refused — the typed `refusal`
 * (also pushed into `depWarn` so a caller that only forwards the warnings still names the
 * cause) beside an undefined `dep`. `purpose: "prepare"` applies the read-only gate.
 */
/** Resolve a `generation` ALIAS (primary | previous | all) to the label it names on this chain
 *  for a call that needs `needs` block kinds — the migration aliases (2026-09-22) resolve ONCE,
 *  before any block lookup, so getDep / getPoolDep / getMarketRegistry all speak labels below
 *  and every result carries the label. A non-alias passes through; a refusal is the typed
 *  `generation_unknown` the caller already routes (`generationRefusal` throws it as input). */
export async function resolveGenerationLabel(
  chainId: number,
  label: string | undefined,
  needs: readonly GenerationBlockKind[],
  purpose: "read" | "prepare",
): Promise<{ label: string | undefined; refusal?: GenerationRefusal }> {
  // A plain current label needs no chain lookup; an alias or a RENAMED label (an old spelling
  // from 0.6.0) resolves through the one resolver so the result carries today's label.
  if (label === undefined || (!isGenerationAlias(label) && renamedGenerationLabel(label) === undefined)) return { label };
  const { generations } = await resolveGenerations(chainId);
  const a = resolveGenerationAlias(generations, label, needs, purpose);
  return a.ok ? { label: a.label } : { label, refusal: a.refusal };
}

export async function getDep(
  ctx: HandlerContext,
  chainId: number,
  opts: { purpose?: "read" | "prepare"; /** Override the label (a registry path passes the generation its `mr` came from, so dep and mr are ONE set). */ generation?: string } = {},
): Promise<{ dep: CorkDeployment | undefined; depWarn: Array<{ code: string; message: string }>; generation?: GenerationRef & { wire?: PhoenixWire }; refusal?: GenerationRefusal }> {
  if (ctx.deployment) return { dep: ctx.deployment, depWarn: [] };
  const aliased = await resolveGenerationLabel(chainId, opts.generation ?? ctx.generation, ["phoenix"], opts.purpose ?? "read");
  if (aliased.refusal) return { dep: undefined, depWarn: [aliased.refusal], refusal: aliased.refusal };
  const r = await resolveDeploymentBuiltin(chainId, undefined, aliased.label);
  const depWarn = [...r.warnings];
  if (r.refusal) return { dep: undefined, depWarn: [...depWarn, r.refusal], refusal: r.refusal };
  if (opts.purpose === "prepare" && r.generation && r.generation.status !== "active") {
    const refusal: GenerationRefusal = {
      code: "generation_read_only",
      message: `generation '${r.generation.label}' is read-only: its contracts are kept for reads, decode and attribution, but no new bytes are built against them — omit \`generation\` to target the primary, or name another active generation`,
    };
    return { dep: undefined, depWarn: [...depWarn, refusal], generation: r.generation, refusal };
  }
  return { dep: r.deployment, depWarn, ...(r.generation ? { generation: r.generation } : {}) };
}

/** The compact `{ label, status, distribution? }` every result carries — ONE projection so a
 *  ref that grew a `wire` (getDep's) or a `primary` flag never leaks extra keys into data/provenance. */
export function generationRefOf(g: { label: string; status: GenerationRef["status"]; distribution?: string | undefined }): GenerationRef {
  return { label: g.label, status: g.status, ...(g.distribution !== undefined ? { distribution: g.distribution } : {}) };
}

/** The `data.generation` block of a pool-scoped result: the ref, or nothing when the call ran
 *  under a ctx.deployment override (no generation model applies). */
export function generationData(g: GenerationRef | undefined): { generation?: GenerationRef } {
  return g ? { generation: generationRefOf(g) } : {};
}

export type PoolDepResolution = {
  dep: CorkDeployment | undefined;
  depWarn: Array<{ code: string; message: string }>;
  /** The generation the pool LIVES on (plus its wire) — undefined under a ctx.deployment override. */
  generation?: GenerationRef & { wire: PhoenixWire };
  /** The pool's share tokens as the resolver read them (`shares(poolId)` on the winning manager). */
  shares?: { corkPrincipalToken: `0x${string}`; corkSwapToken: `0x${string}` };
  /** A finished envelope when the pool could not be placed: `pool_not_found` naming every manager
   *  asked with its label, `generation_read_only` on a pre-expiry prepare against a read-only set,
   *  `unknown_deployment` when no generation has a pool manager. `generation_unknown` THROWS
   *  (ToolInputError — an invalid-input-class teaching, the label is the caller's own field). */
  refusal?: Envelope;
};

/**
 * Resolve the deployment for a POOL: which generation's pool manager knows `poolId` — ONE batched
 * `shares(poolId)` read across every configured manager on the chain (generations.ts
 * `resolvePoolGeneration`), narrowed to one set when the caller names `generation`. This is the
 * pool-scoped twin of `getDep`: getDep answers "which set does a NEW thing target" (the primary,
 * or the named set); this answers "which set does THIS pool live on" — a different question for
 * every pool the venue serves today (the 176 arbitrum-v1.1 pools live on 0x4d0a…, not on the
 * primary 10-field manager), and reading them through the primary's addresses builds bundles for
 * the wrong adapter and re-hashes ids on the wrong wire.
 *
 * `purpose: "prepare"` refuses a read-only generation (`generation_read_only`); the caller passes
 * `"read"` for reads AND for post-expiry settles (withdraw / withdraw-other / redeem), which the
 * design keeps buildable on a read-only set — the pool's cPT is still someone's money.
 * A ctx.deployment override short-circuits exactly like getDep (the SDK caller pinned addresses;
 * no generation is reported). A no-RPC caller never reaches this — it keeps getDep's behaviour.
 */
export async function getPoolDep(
  ctx: HandlerContext,
  chainId: ChainId,
  resolved: ResolvedRpc,
  poolId: `0x${string}`,
  opts: { purpose?: "read" | "prepare"; generation?: string; tool: string },
): Promise<PoolDepResolution> {
  if (ctx.deployment) return { dep: ctx.deployment, depWarn: [] };
  const { generations, warnings } = await resolveGenerations(chainId);
  const depWarn = [...warnings];
  // The alias resolves against the purpose HERE (a prepare's `all` teaching differs from a
  // read's); the resolver below then sees a label only.
  const aliased = resolveGenerationAlias(generations, opts.generation ?? ctx.generation, ["phoenix"], opts.purpose ?? "read");
  if (!aliased.ok) throw new ToolInputError(opts.tool, [{ path: ["generation"], message: aliased.refusal.message }]);
  const label = aliased.label;
  if (generations.length === 0) {
    return { dep: undefined, depWarn, refusal: unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx) };
  }
  const client: PoolGenerationClient = resolved.client;
  const r: PoolGenerationResolution = await resolvePoolGeneration(client, generations, poolId, label, ctx.atBlock);
  if (!r.found) {
    if (r.code === "generation_unknown") throw new ToolInputError(opts.tool, [{ path: ["generation"], message: r.message }]);
    // "Every manager answered zero" is the pool's absence; "NO manager answered" is the chain
    // failing to answer — the second keeps its chain_read_failed envelope (and its transport
    // breaker feed, from the ORIGINAL error), never a pool_not_found the caller would act on.
    if (r.code === "pool_not_found" && r.causes !== undefined && r.causes.length === r.asked.length) {
      return { dep: undefined, depWarn, refusal: chainReadFailed(chainId, r.causes[0], [{ code: "pool_not_found", message: `no pool manager could be read for pool ${poolId}: ${r.message}` }, ...depWarn], ctx, resolved) };
    }
    return { dep: undefined, depWarn, refusal: unavailable(chainId, r.code, r.message, ctx) };
  }
  const g = r.generation;
  const ref: GenerationRef & { wire: PhoenixWire } = { label: g.label, status: g.status, ...(g.distribution !== undefined ? { distribution: g.distribution } : {}), wire: g.phoenix!.wire };
  const shares = { corkPrincipalToken: r.corkPrincipalToken, corkSwapToken: r.corkSwapToken };
  if (opts.purpose === "prepare" && g.status !== "active") {
    const refusal = envelope({
      state: "unavailable",
      data: null,
      chainId,
      source: "config",
      warnings: [
        ...depWarn,
        {
          code: "generation_read_only",
          message: `pool ${poolId} lives on generation '${g.label}', which is read-only: its contracts are kept for reads, decode and attribution, and only the post-expiry settles (withdraw, withdraw-other, redeem) still build against them — no new pre-expiry bytes. Enter a pool on an active generation instead (protocol-config lists them)`,
        },
      ],
      generation: ref,
      ctx,
    });
    return { dep: undefined, depWarn, generation: ref, shares, refusal };
  }
  return { dep: g.phoenix, depWarn, generation: ref, shares };
}

/**
 * Resolve the market-registry block a registry-bound path (JIT ladder, registry-* reads,
 * derive-cork-pool, create-pool, deploy-oracle) builds against: `ctx.generation` when the caller
 * named one, else the chain's PRIMARY — whose declared wire selects the codec (market-registry.ts
 * `wireCodec`). A generation whose wire this build does not implement is refused `phase_gated`
 * — a typed refusal, never bytes the deployed adapter cannot decode; the primary's wire is
 * implemented by construction (flat and nested both are), and a primary declaring a wire this
 * build has never heard of is a config newer than the binary — the same refusal names the
 * implemented set. `generation` rides along so the caller's `getDep(ctx, chainId, { generation })`
 * and its implementation-guard scope address the SAME set; `phoenixWire` is that generation's
 * pool-manager width — the pool-id derivation and the fee rule follow it, not the registry wire.
 */
export async function getMarketRegistry(
  ctx: HandlerContext,
  chainId: number,
  purpose: "read" | "prepare" = "read",
): Promise<{ mr: CorkMarketRegistry | undefined; mrWarn: Array<{ code: string; message: string }>; generation?: GenerationRef & { wire?: MarketRegistryWire }; phoenixWire?: PhoenixWire; refusal?: GenerationRefusal | { code: "phase_gated"; message: string } }> {
  const { generations, warning } = await resolveGenerations(chainId);
  const mrWarn = warning ? [warning] : [];
  const aliased = resolveGenerationAlias(generations, ctx.generation, ["marketRegistry"], purpose);
  if (!aliased.ok) return { mr: undefined, mrWarn: [...mrWarn, aliased.refusal], refusal: aliased.refusal };
  const label = aliased.label;
  const r = await resolveMarketRegistry(chainId, undefined, label);
  const phoenixWire = r.generation ? generations.find((g) => g.label === r.generation!.label)?.phoenix?.wire : undefined;
  if (r.refusal) return { mr: undefined, mrWarn: [...mrWarn, r.refusal], refusal: r.refusal };
  if (r.marketRegistry && !IMPLEMENTED_MARKET_REGISTRY_WIRES.includes(r.marketRegistry.wire)) {
    const refusal = {
      code: "phase_gated" as const,
      message: r.marketRegistry.wire === "legacy"
        ? `generation '${r.generation?.label}' carries the pre-2.1.0 (legacy-wire) registry — it is served only through the deprecated lane (jitMarket.legacy / filters.legacy / params.legacy with CORK_ENABLE_DEPRECATED=1), not by selecting the generation`
        : `generation '${r.generation?.label}' carries a '${r.marketRegistry.wire}'-wire MarketRegistry (${r.marketRegistry.contractsVersion ?? "unversioned"}) that this build does not encode yet — its JIT extraData, verify and deploy shapes differ from the ${IMPLEMENTED_MARKET_REGISTRY_WIRES.join("/")} wire this build implements, so no bytes are built; target a generation on an implemented wire (${generations.filter((g) => g.marketRegistry && IMPLEMENTED_MARKET_REGISTRY_WIRES.includes(g.marketRegistry.wire)).map((g) => g.label).join(", ") || "none on this chain"}) or update to a build that implements '${r.marketRegistry.wire}'`,
    };
    return { mr: undefined, mrWarn: [...mrWarn, refusal], refusal, ...(r.generation ? { generation: r.generation } : {}) };
  }
  return { mr: r.marketRegistry, mrWarn, ...(r.generation ? { generation: r.generation } : {}), ...(phoenixWire ? { phoenixWire } : {}) };
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
  mode?: "lite-decentralized" | "hybrid" | "full-decentralized";
  /** The generation the result was read from / built against → `provenance.generation`. Handlers
   *  that resolve a pool's generation from the chain pass the resolver's ref here (and mirror it in
   *  `data.generation`), so a reader can tell WHICH manager answered without re-deriving it. */
  generation?: GenerationRef;
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
      // lite-decentralized; venue-backed reads/writes (api-phoenix) = hybrid (venue-discovered,
      // chain-verified best-effort; renamed from "centralized" 2026-08-13).
      // full-decentralized (HyperSync) is passed explicitly by its handler.
      ...(args.mode
        ? { mode: args.mode }
        : {
            ...(args.source === "chain" ? { mode: "lite-decentralized" as const } : {}),
            ...(args.source === "indexer" || args.source === "service" ? { mode: "hybrid" as const } : {}),
          }),
      chainId: args.chainId,
      fetchedAt: nowIso(args.ctx),
      digest,
      ...(args.block !== undefined ? { block: args.block.toString() } : {}),
      ...(args.rpc !== undefined ? { rpc: args.rpc } : {}),
      ...(args.generation !== undefined ? { generation: generationRefOf(args.generation) } : {}),
    },
    schemaVersion: SCHEMA_VERSION,
  };
}

export function unavailable(chainId: ChainId, code: string, message: string, ctx: HandlerContext): Envelope {
  return envelope({ state: "unavailable", data: null, chainId, source: "config", warnings: [{ code, message }], ctx });
}

/** The ONE exit for a generation refusal from getDep / getMarketRegistry. `generation_unknown`
 *  THROWS ToolInputError naming the `generation` field: the label is the caller's OWN input, so
 *  it is invalid-input-class (exit 2) on EVERY path — getPoolDep already threw it, and until
 *  2026-09-22 this helper answered the same typo with an `unavailable` envelope (exit 3): two
 *  exit codes for one fact (review B1). `generation_read_only` (and any other code) stays an
 *  `unavailable` envelope PLUS `provenance.generation` naming the set the call resolved to, so a
 *  refused prepare and an accepted one describe the same generation in the same place — the
 *  caller never rebuilds this by hand (six handlers dropped the label before this helper
 *  existed; the killer test for `getdep-readonly-prepare-gate-dropped` found the gap). */
export function generationRefusal(chainId: ChainId, refusal: { code: string; message: string }, generation: GenerationRef | undefined, ctx: HandlerContext, tool: string): Envelope {
  if (refusal.code === "generation_unknown") throw new ToolInputError(tool, [{ path: ["generation"], message: refusal.message }]);
  return envelope({ state: "unavailable", data: null, chainId, source: "config", warnings: [{ code: refusal.code, message: refusal.message }], ...(generation ? { generation: generationRefOf(generation) } : {}), ctx });
}

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/** Canonical Uniswap Permit2 — single-sourced from the PUBLIC order-approvals module (part of
 *  the SDK surface via the orders tier) and re-exported here for the handlers that predate it. */
export { PERMIT2_ADDRESS } from "../order-approvals.ts";

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
  const at = lines.findIndex((l) => l.includes("reverted"));
  const head = (at >= 0 ? lines[at] : (lines[0] ?? err.message))!.trim();
  // viem prints the decoded reason on the NEXT line ("reverted with the following reason:\n<why>")
  // — the header alone hid the very thing a caller needs (a bare "reverted with the
  // following reason:" where the reason was Panic 0x11).
  const next = at >= 0 ? (lines[at + 1] ?? "").trim() : "";
  return head.endsWith(":") && next ? `${head} ${next}` : head;
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
