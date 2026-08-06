// RPC endpoint resolution with committed defaults, a per-endpoint circuit breaker (retry + backoff),
// and a just-in-time chainlist.org fallback that picks the best-performing public RPC.
//
// Precedence: an explicit URL (CORK_RPC_URL / --rpc-url) always wins and is used verbatim — no
// probing, no fallback (your config, your call). Otherwise: a committed default for the chain →
// retried with backoff; if it stays down (breaker opens), fall back to chainlist for eligible public
// chains, latency-probing candidates and verifying each reports the right chainId before use.
//
// State (breaker + chosen RPC + candidate lists) is memoized in-process AND persisted to a small
// on-disk cache with TTLs, so the long-lived MCP server and repeated short-lived CLI runs both skip
// re-probing in steady state. All network/fs/clock access is injectable so the logic unit-tests
// offline.
import { createPublicClient, custom, http, type Chain, type PublicClient } from "viem";
import { arbitrum, base, mainnet, sepolia } from "viem/chains";
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "../atomic-file.ts";
import { breakerOnFailure, breakerOnSuccess, breakerOpen, breakerRemainingMs, type BreakerEntry } from "../breaker.ts";

export interface ResolvedRpc {
  url: string;
  client: PublicClient;
  source: "explicit" | "default" | "chainlist";
}

// Committed defaults. NOTE: these Tenderly gateway URLs embed access tokens and are intentionally
// committed (owner decision 2026-07-17) — unlike CORK_RPC_URL/CORK_TEST_RPC, which stay env-only.
export const DEFAULT_RPCS: Readonly<Record<number, string>> = {
  1: "https://mainnet.gateway.tenderly.co/680LWYrzQFiGUyJKWf05oo",
  42161: "https://arbitrum.gateway.tenderly.co/5xUnQJ7Qylkv7D0wQfSynT",
};

// Chains eligible for the chainlist.org fallback (real public networks). The private staging vnet
// (49222) is not on chainlist, so it stays explicit-RPC-only.
export const FALLBACK_CHAINS: ReadonlySet<number> = new Set([1, 42161, 8453, 11155111]);

export interface RpcConfig {
  attempts: number; // probe attempts against the preferred default before giving up
  baseDelayMs: number; // exponential backoff base (attempt i waits baseDelayMs * 2^i)
  openThreshold: number; // consecutive failures that trip the breaker open
  cooldownMs: number; // how long the breaker stays open before a half-open retry
  probeTimeoutMs: number;
  chosenTtlMs: number; // how long a chosen RPC is trusted before re-validation
  candidateTtlMs: number; // how long a fetched chainlist candidate list is cached
  maxProbe: number; // max chainlist candidates probed in parallel
}

export const DEFAULT_CONFIG: RpcConfig = {
  attempts: 3,
  baseDelayMs: 250,
  openThreshold: 3,
  cooldownMs: 30_000,
  probeTimeoutMs: 4_000,
  chosenTtlMs: 600_000, // 10 min
  candidateTtlMs: 3_600_000, // 1 h
  maxProbe: 10,
};

type Breaker = BreakerEntry;
interface Chosen {
  url: string;
  source: "default" | "chainlist";
  ts: number;
}
interface Candidates {
  urls: string[];
  ts: number;
}
export interface RpcState {
  version: 1;
  breaker: Record<string, Breaker>;
  chosen: Record<number, Chosen>;
  candidates: Record<number, Candidates>;
}

export interface ProbeResult {
  ok: boolean;
  chainId?: number;
  latencyMs: number;
}

/** A bare EIP-1193 request function — the unit the failover client composes over. */
export type TransportRequest = (args: { method: string; params?: unknown }) => Promise<unknown>;

/** Injectable side-effects — real ones by default; tests pass fakes for offline determinism. */
export interface RpcDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  probe: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  fetchChainlist: (chainId: number) => Promise<string[]>;
  loadState: () => RpcState;
  saveState: (s: RpcState) => void;
  /** Uniform [0,1) source for backoff jitter; defaults to Math.random. Tests pin it (0.5 = the
   *  un-jittered delay, so pre-jitter assertions carry over unchanged). */
  random?: () => number;
  /** Build the raw transport for a URL (default: viem http). Tests inject fakes so the failover
   *  client's request path runs offline. */
  request?: (url: string, chainId: number | undefined) => TransportRequest;
}

function emptyState(): RpcState {
  return { version: 1, breaker: {}, chosen: {}, candidates: {} };
}

/** Known viem chain objects — attaching one types the client and enables multicall3 batching. */
const CHAINS: Readonly<Record<number, Chain>> = { 1: mainnet, 42161: arbitrum, 8453: base, 11155111: sepolia };

/**
 * Build a typed PublicClient. When the chain is known, viem's multicall batching collapses the
 * per-block read fan-out (e.g. readPoolState's 10 reads) into aggregate3 calls; unknown chains
 * (like the 49222 staging vnet) get a plain client with per-call reads.
 */
export function mkClient(url: string, chainId?: number): PublicClient {
  const chain = chainId !== undefined ? CHAINS[chainId] : undefined;
  if (chain) {
    return createPublicClient({ chain, batch: { multicall: true }, transport: http(url) }) as PublicClient;
  }
  return createPublicClient({ transport: http(url) });
}

// ── real dependency implementations ─────────────────────────────────────────
function cacheFile(): string {
  return process.env.CORK_RPC_CACHE_FILE ?? join(homedir(), ".cache", "cork-helper-cli", "rpc-state.json");
}

// Memoized per cache path — if CORK_RPC_CACHE_FILE changes mid-process, reload from the new path
// instead of serving the old snapshot (and never write a stale snapshot to the new location).
// Concurrent writers (a long-lived MCP server + CLI runs) are last-writer-wins by design.
let memState: { path: string; state: RpcState } | null = null;
function realLoadState(): RpcState {
  const path = cacheFile();
  if (memState?.path === path) return memState.state;
  let state: RpcState;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as RpcState;
    state = raw && raw.version === 1 ? { ...emptyState(), ...raw } : emptyState();
  } catch {
    state = emptyState();
  }
  memState = { path, state };
  return state;
}
function realSaveState(s: RpcState): void {
  const path = cacheFile();
  memState = { path, state: s };
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(s));
  } catch {
    /* disk cache is best-effort; in-memory memoization still holds within the process */
  }
}


async function realProbe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: timeoutMs }) });
  const start = Date.now();
  try {
    const chainId = await client.getChainId();
    return { ok: true, chainId, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/**
 * Filter+order chainlist candidates (pure — unit-tested offline): keep plain https URLs (no
 * templated keys, no websockets), privacy-preserving (`tracking:"none"`) endpoints first.
 */
export function filterChainlistRpcs(rpc: Array<{ url: string; tracking?: string }>): string[] {
  const usable = (u: string) => /^https:\/\//i.test(u) && !u.includes("${") && !/API_KEY|YOUR_/i.test(u);
  const noTrack = rpc.filter((r) => usable(r.url) && r.tracking === "none").map((r) => r.url);
  const rest = rpc.filter((r) => usable(r.url) && r.tracking !== "none").map((r) => r.url);
  return [...new Set([...noTrack, ...rest])]; // dedupe, privacy-preserving endpoints first
}

async function realFetchChainlist(chainId: number): Promise<string[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch("https://chainlist.org/rpcs.json", { signal: ctrl.signal });
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{ chainId: number; rpc: Array<{ url: string; tracking?: string }> }>;
    const c = arr.find((x) => x.chainId === chainId);
    return c?.rpc ? filterChainlistRpcs(c.rpc) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** The real transport for the failover client: viem's http transport, instantiated per URL with
 *  the known chain attached (same construction mkClient performs, minus the client shell). */
function realTransportRequest(url: string, chainId: number | undefined): TransportRequest {
  const chain = chainId !== undefined ? CHAINS[chainId] : undefined;
  const t = http(url)(chain ? { chain } : {});
  return (args) => t.request(args as Parameters<typeof t.request>[0]);
}

export function realDeps(): RpcDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    probe: realProbe,
    fetchChainlist: realFetchChainlist,
    loadState: realLoadState,
    saveState: realSaveState,
    random: Math.random,
    request: realTransportRequest,
  };
}

// ── breaker helpers — thin views over the shared state machine (breaker.ts), keyed by URL in the
//    persisted RpcState. The comparators live in ONE place so the venue breaker cannot drift. ────
function isOpen(st: RpcState, url: string, now: number, cfg: RpcConfig): boolean {
  return breakerOpen(st.breaker[url], now, cfg);
}
function recordSuccess(st: RpcState, url: string): void {
  st.breaker[url] = breakerOnSuccess();
}
function recordFailure(st: RpcState, url: string, cfg: RpcConfig, now: number): void {
  st.breaker[url] = breakerOnFailure(st.breaker[url], now, cfg);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Transport-class failure? (endpoint unreachable/timeout — walks viem's cause chain by error
 * NAME, so no viem class imports are needed.) Contract reverts deliberately do NOT count: they
 * indicate a bad request, not a bad endpoint, and feeding them to the breaker would punish
 * healthy RPCs. This split decides ATTRIBUTION everywhere a read doubles as a verdict: a revert
 * is a DEFINITIVE on-chain answer (the same call in a fill would revert too → conflict), while a
 * transport failure is indeterminate (→ disclose, don't accuse). THE single implementation —
 * handlers/shared.ts re-exports it as `isTransportFailure`; duplicated classifications would
 * drift and defeat first-occurrence mutation probes.
 */
export function isTransportError(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const name = (e as { name?: string }).name;
    if (name === "HttpRequestError" || name === "TimeoutError" || name === "WebSocketRequestError" || name === "SocketClosedError") return true;
  }
  return false;
}

/**
 * Feed a real read failure back into the breaker so a chosen endpoint that goes bad mid-TTL is
 * dropped instead of being served until chosenTtlMs expires. Call only for transport-class errors.
 */
export function reportEndpointFailure(chainId: number, url: string, cfg: RpcConfig = DEFAULT_CONFIG, deps: RpcDeps = realDeps()): void {
  const st = deps.loadState();
  recordFailure(st, url, cfg, deps.now());
  if (st.chosen[chainId]?.url === url) delete st.chosen[chainId];
  deps.saveState(st);
}

/** An explicitly configured RPC that answers eth_chainId with the WRONG chain (F21): every read
 *  through it would be wrong-chain data stamped with the requested chainId. */
export class RpcChainMismatchError extends Error {
  constructor(url: string, expected: number, got: number) {
    super(`explicit RPC endpoint (${hostOf(url)}) reports chainId ${got}, but chainId ${expected} was requested — every read through it would be wrong-chain data wearing the requested chain's label. Fix CORK_RPC_URL/--rpc-url, or pass the chainId that endpoint actually serves`);
    this.name = "RpcChainMismatchError";
  }
}

// eth_chainId verification results for explicit endpoints, memoized per process (one probe per
// endpoint, not per call). The default/chainlist paths already verify inside their probes.
const explicitVerified = new Map<string, number>();

/** Test hook: forget explicit-endpoint verification results. */
export function resetExplicitVerification(): void {
  explicitVerified.clear();
}

// In-flight automatic resolutions, keyed by chainId. Deduplicates the cold-start stampede AND the
// half-open stampede in the long-lived HTTP server: N concurrent requests share ONE probe pass
// (the first caller's cfg/deps drive it) instead of each probing up to maxProbe candidates. The
// explicit-URL path bypasses this (verbatim use, one memoized verification — nothing to stampede).
const inflight = new Map<number, Promise<ResolvedRpc | null>>();

/** Test hook: forget in-flight resolutions (pair with resetExplicitVerification in setups). */
export function resetRpcInflight(): void {
  inflight.clear();
}

/**
 * Resolve a working PublicClient for `chainId`. Returns null when no RPC can be resolved
 * (chain not eligible for fallback and no default/explicit URL, or every endpoint is down).
 * Automatic (default/chainlist) clients fail over IN-CALL: a transport-class request failure
 * feeds the breaker, re-resolves once, and retries the request — see mkFailoverResolved.
 */
export async function resolveRpc(
  chainId: number,
  explicitUrl: string | undefined,
  cfg: RpcConfig = DEFAULT_CONFIG,
  deps: RpcDeps = realDeps(),
): Promise<ResolvedRpc | null> {
  // 1. explicit URL wins — no fallback, but its chainId IS verified (F21): the hand-configured
  //    path was the only one skipping the check every automatic path performs. An endpoint that
  //    doesn't answer the probe is still used verbatim (your config, your call — reads will fail
  //    loudly on their own); an endpoint that answers with the WRONG chain is refused.
  if (explicitUrl) {
    let known = explicitVerified.get(explicitUrl);
    if (known === undefined) {
      const r = await deps.probe(explicitUrl, cfg.probeTimeoutMs).catch(() => null);
      if (r?.ok && r.chainId !== undefined) {
        explicitVerified.set(explicitUrl, r.chainId);
        known = r.chainId;
      }
    }
    if (known !== undefined && known !== chainId) throw new RpcChainMismatchError(explicitUrl, chainId, known);
    return { url: explicitUrl, client: mkClient(explicitUrl, chainId), source: "explicit" };
  }

  const existing = inflight.get(chainId);
  if (existing) return existing;
  const flight = resolveAuto(chainId, cfg, deps).finally(() => inflight.delete(chainId));
  inflight.set(chainId, flight);
  return flight;
}

/** The automatic (default → chainlist) resolution pass. Every hit returns a failover-wrapped
 *  client so an endpoint dying mid-call heals within the same tool call. */
async function resolveAuto(chainId: number, cfg: RpcConfig, deps: RpcDeps): Promise<ResolvedRpc | null> {
  const st = deps.loadState();
  const now = deps.now();

  // 2. a recently-chosen, still-trusted RPC (skips re-probing in steady state).
  const chosen = st.chosen[chainId];
  if (chosen && now - chosen.ts < cfg.chosenTtlMs && !isOpen(st, chosen.url, now, cfg)) {
    return mkFailoverResolved(chainId, chosen.url, chosen.source, cfg, deps);
  }

  // 3. the committed default for this chain, retried with jittered exponential backoff (the
  //    jitter decorrelates concurrent retriers in the hosted server; random()=0.5 is the
  //    un-jittered midpoint).
  const def = DEFAULT_RPCS[chainId];
  if (def && !isOpen(st, def, now, cfg)) {
    for (let i = 0; i < cfg.attempts; i++) {
      const r = await deps.probe(def, cfg.probeTimeoutMs);
      if (r.ok && r.chainId === chainId) {
        recordSuccess(st, def);
        st.chosen[chainId] = { url: def, source: "default", ts: now };
        deps.saveState(st);
        return mkFailoverResolved(chainId, def, "default", cfg, deps);
      }
      if (i < cfg.attempts - 1) await deps.sleep(cfg.baseDelayMs * 2 ** i * (0.5 + (deps.random ?? Math.random)()));
    }
    recordFailure(st, def, cfg, now); // may trip the breaker open
    deps.saveState(st);
  }

  // 4. chainlist.org fallback for eligible public chains: fetch (cached) candidates, probe in
  //    parallel, drop chainId mismatches, pick the lowest-latency healthy endpoint.
  if (FALLBACK_CHAINS.has(chainId)) {
    let cand = st.candidates[chainId];
    if (!cand || now - cand.ts >= cfg.candidateTtlMs) {
      const urls = await deps.fetchChainlist(chainId);
      if (urls.length) {
        cand = { urls, ts: now };
        st.candidates[chainId] = cand;
        deps.saveState(st);
      }
    }
    const urls = (cand?.urls ?? []).filter((u) => !isOpen(st, u, now, cfg)).slice(0, cfg.maxProbe);
    const probed = await Promise.all(
      urls.map(async (u) => ({ u, r: await deps.probe(u, cfg.probeTimeoutMs).catch(() => ({ ok: false, latencyMs: Number.POSITIVE_INFINITY }) as ProbeResult) })),
    );
    const healthy = probed.filter((p) => p.r.ok && p.r.chainId === chainId).sort((a, b) => a.r.latencyMs - b.r.latencyMs);
    for (const p of probed) if (!(p.r.ok && p.r.chainId === chainId)) recordFailure(st, p.u, cfg, now);
    const best = healthy[0];
    if (best) {
      recordSuccess(st, best.u);
      st.chosen[chainId] = { url: best.u, source: "chainlist", ts: now };
      deps.saveState(st);
      return mkFailoverResolved(chainId, best.u, "chainlist", cfg, deps);
    }
  }

  return null;
}

/**
 * A ResolvedRpc whose client fails over IN-CALL (same-call failover): on a transport-class
 * request failure it feeds the breaker, re-resolves once (attempts:1 — the endpoint just failed
 * a REAL request, one more probe is evidence enough), and retries the request through whatever
 * resolves — at most one retry per request, so latency stays bounded and a still-dead world
 * propagates the original error. The `url`/`source` fields MUTATE on switch so that rpcWarn /
 * rpcProvenance built at envelope-construction time disclose the endpoint that actually served
 * (handlers evaluate them after reads complete). Explicit endpoints never get this wrapper:
 * no-fallback is their contract. All reads here are idempotent (this server never broadcasts —
 * there is no eth_sendRawTransaction path), so retrying a request is always safe.
 */
function mkFailoverResolved(chainId: number, url: string, source: "default" | "chainlist", cfg: RpcConfig, deps: RpcDeps): ResolvedRpc {
  const requestFor = deps.request ?? realTransportRequest;
  const resolved = { url, source } as ResolvedRpc & { source: "default" | "chainlist" };
  let inner = requestFor(url, chainId);
  const provider = {
    request: async (args: { method: string; params?: unknown }): Promise<unknown> => {
      try {
        return await inner(args);
      } catch (err) {
        if (!isTransportError(err)) throw err;
        reportEndpointFailure(chainId, resolved.url, cfg, deps);
        const next = await resolveRpc(chainId, undefined, { ...cfg, attempts: 1 }, deps).catch(() => null);
        if (!next) throw err;
        if (next.url !== resolved.url) {
          resolved.url = next.url;
          if (next.source !== "explicit") resolved.source = next.source;
          inner = requestFor(next.url, chainId);
        }
        return inner(args); // the single retry; a second transport failure propagates as-is
      }
    },
  };
  const chain = CHAINS[chainId];
  resolved.client = chain
    ? (createPublicClient({ chain, batch: { multicall: true }, transport: custom(provider, { retryCount: 0 }) }) as PublicClient)
    : createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
  return resolved;
}

/** Host-only snapshot of resolver health for the /readyz diagnostics surface. HOSTS ONLY by
 *  construction: committed default URLs embed access tokens in their PATH, so full URLs must
 *  never leave this module through a diagnostics channel. */
export function rpcDiagnostics(cfg: RpcConfig = DEFAULT_CONFIG, deps: RpcDeps = realDeps()): {
  chosen: Record<string, { host: string; source: "default" | "chainlist"; ageMs: number }>;
  breakers: Array<{ host: string; failures: number; open: boolean; remainingCooldownMs: number }>;
} {
  const st = deps.loadState();
  const now = deps.now();
  return {
    chosen: Object.fromEntries(Object.entries(st.chosen).map(([cid, c]) => [cid, { host: hostOf(c.url), source: c.source, ageMs: Math.max(0, now - c.ts) }])),
    breakers: Object.entries(st.breaker)
      .filter(([, b]) => b.failures > 0 || b.openedAt != null)
      .map(([u, b]) => ({ host: hostOf(u), failures: b.failures, open: breakerOpen(b, now, cfg), remainingCooldownMs: breakerRemainingMs(b, now, cfg) })),
  };
}
