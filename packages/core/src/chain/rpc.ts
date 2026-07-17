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
import { createPublicClient, http, type Chain, type PublicClient } from "viem";
import { arbitrum, base, mainnet, sepolia } from "viem/chains";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

interface Breaker {
  failures: number;
  openedAt: number | null;
}
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

/** Injectable side-effects — real ones by default; tests pass fakes for offline determinism. */
export interface RpcDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  probe: (url: string, timeoutMs: number) => Promise<ProbeResult>;
  fetchChainlist: (chainId: number) => Promise<string[]>;
  loadState: () => RpcState;
  saveState: (s: RpcState) => void;
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
    writeFileSync(path, JSON.stringify(s));
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

export function realDeps(): RpcDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    probe: realProbe,
    fetchChainlist: realFetchChainlist,
    loadState: realLoadState,
    saveState: realSaveState,
  };
}

// ── breaker helpers ─────────────────────────────────────────────────────────
function isOpen(st: RpcState, url: string, now: number, cfg: RpcConfig): boolean {
  const b = st.breaker[url];
  return b?.openedAt != null && now - b.openedAt < cfg.cooldownMs;
}
function recordSuccess(st: RpcState, url: string): void {
  st.breaker[url] = { failures: 0, openedAt: null };
}
function recordFailure(st: RpcState, url: string, cfg: RpcConfig, now: number): void {
  const b = st.breaker[url] ?? { failures: 0, openedAt: null };
  b.failures += 1;
  if (b.failures >= cfg.openThreshold) b.openedAt = now;
  st.breaker[url] = b;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Transport-class failure? (endpoint unreachable/timeout — walks viem's cause chain.) Contract
 * reverts deliberately do NOT count: they indicate a bad request, not a bad endpoint, and feeding
 * them to the breaker would punish healthy RPCs.
 */
export function isTransportError(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
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

/**
 * Resolve a working PublicClient for `chainId`. Returns null when no RPC can be resolved
 * (chain not eligible for fallback and no default/explicit URL, or every endpoint is down).
 */
export async function resolveRpc(
  chainId: number,
  explicitUrl: string | undefined,
  cfg: RpcConfig = DEFAULT_CONFIG,
  deps: RpcDeps = realDeps(),
): Promise<ResolvedRpc | null> {
  // 1. explicit URL wins verbatim — no probing, no fallback.
  if (explicitUrl) return { url: explicitUrl, client: mkClient(explicitUrl, chainId), source: "explicit" };

  const st = deps.loadState();
  const now = deps.now();

  // 2. a recently-chosen, still-trusted RPC (skips re-probing in steady state).
  const chosen = st.chosen[chainId];
  if (chosen && now - chosen.ts < cfg.chosenTtlMs && !isOpen(st, chosen.url, now, cfg)) {
    return { url: chosen.url, client: mkClient(chosen.url, chainId), source: chosen.source };
  }

  // 3. the committed default for this chain, retried with exponential backoff.
  const def = DEFAULT_RPCS[chainId];
  if (def && !isOpen(st, def, now, cfg)) {
    for (let i = 0; i < cfg.attempts; i++) {
      const r = await deps.probe(def, cfg.probeTimeoutMs);
      if (r.ok && r.chainId === chainId) {
        recordSuccess(st, def);
        st.chosen[chainId] = { url: def, source: "default", ts: now };
        deps.saveState(st);
        return { url: def, client: mkClient(def, chainId), source: "default" };
      }
      if (i < cfg.attempts - 1) await deps.sleep(cfg.baseDelayMs * 2 ** i);
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
      return { url: best.u, client: mkClient(best.u, chainId), source: "chainlist" };
    }
  }

  return null;
}
