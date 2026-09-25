// Remote-first config sourcing [R6/§8]: deployment addresses are fetched from this repo's
// canonical GitHub `config.default.json` at the binary's release tag (TTL-cached in memory + on disk), with the committed
// copy bundled in the distribution as the fallback. Never bare hardcodes: the single source of
// truth is the JSON file, remote copy preferred, and every result can say which one served it.
//
// SCHEMA 2 (cork-cli 0.6, 2026-09-22): the document records GENERATIONS per chain — a set of
// contract generations, one primary (generations.ts has the model). `cork-defaults.json`
// (schema 1) is FROZEN for the 0.5 line and is neither read nor written by this build: a
// v1-shaped file whose primary moved would send 0.5.x binaries to a generation whose wire they
// do not speak, so the two lines keep two files, and the v1 file keeps its current primary
// addresses forever (config-remote.test pins that it still parses under the v1 schema).
//
// Fetched content is UNTRUSTED until validated: it is parsed against strict zod schemas (checksummed
// addresses, closed shape) — a malformed or tampered remote file is treated as a fetch failure and
// the bundled fallback is used, with a warning.
//
// Noise policy (owner direction 2026-07-20): HTTP 404/410 means the file is NOT PUBLISHED at the
// canonical URL (private repo, or the commit not pushed yet) — a deliberate state, not a transient
// failure — so the bundled copy is served SILENTLY. Only transient failures (network, 5xx,
// tampered/invalid content) warn, with a one-line message. Either negative outcome is cached on
// disk for 10 minutes so fresh CLI processes don't re-attempt the fetch on every invocation.
import { z } from "zod";
import { Address } from "@cork/schemas";
import { readFileSync, mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-file.ts";
import { fetchWithTimeout } from "./fetch-timeout.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import bundledDefaults from "../../../config.default.json" with { type: "json" };
import { BUILD_VERSION } from "./version.ts";
import type { CorkDeployment } from "./config.ts";
import {
  ChainGenerationsSchema,
  generationsOf,
  type GenerationLabel,
  type GenerationRef,
  type GenerationRefusal,
  type MarketRegistryBlock,
  type MarketRegistryWire,
  type PhoenixWire,
  type ResolvedGeneration,
  type RolloverGenerationEntry,
  type RolloverWire,
  rolloverGenerationsOf,
  selectGeneration,
} from "./generations.ts";
import { rolloverGenerations, type RolloverGeneration } from "./rollover.ts";

/** The repository a released binary fetches its defaults from. */
export const CORK_DEFAULTS_REPO = "https://raw.githubusercontent.com/Cork-Technology/cork-cli";

/** The defaults file a binary reads: `config.default.json` at ITS OWN RELEASE TAG (2026-09-25
 *  owner ruling). A release tag is immutable, so the file a binary resolves `generation` against
 *  never changes under it — the day the keys of the main-branch file were renamed, the released
 *  0.6.0 (which fetched main by name) stopped accepting its documented generation names. A
 *  source run (`BUILD_VERSION` "dev") reads main. The `CORK_DEFAULTS_URL` env var overrides both.
 *  `cork-defaults.v2.json` on main stays frozen for the 0.6.0 binary; `cork-defaults.json` (schema
 *  1) for 0.5.x. */
export function corkDefaultsUrlFor(version: string): string {
  const ref = version === "dev" || version === "" ? "main" : `v${version}`;
  return `${CORK_DEFAULTS_REPO}/${ref}/config.default.json`;
}
export const CORK_DEFAULTS_URL = corkDefaultsUrlFor(BUILD_VERSION);

/** A generation's market-registry block as consumers receive it (the block plus its wire). */
export type CorkMarketRegistry = MarketRegistryBlock;

/** One rollover generation as the config records it, normalized (rollover.ts's flattening
 *  shape — label, status, primary and wire always present). */
export type CorkRolloverGeneration = RolloverGeneration;

/** The rollover record `resolveRollover` serves: the SELECTED generation's block as the top-level
 *  fields (the shape every pre-0.6 consumer reads — factory, settlers, settlerDomain, seed) plus
 *  `generations`, the chain's ONE flattened rollover list (primary first, other live blocks,
 *  retired blocks). `rolloverGenerations(dep)` in rollover.ts returns that list. */
export type CorkRolloverDeployment = RolloverGenerationEntry & { generations: RolloverGenerationEntry[] };

/** Event-scan targets across EVERY generation of a rollover deployment: retired settlers'
 *  fills and retired factories' clones stay on-chain, so history reads span every generation's
 *  addresses from the earliest seed block. One derivation for every scan site (query's
 *  full-decentralized feeds, track's digest event-history leg). */
/** ONE generation-scoping mechanism for every rollover event scan (the digest and factory
 *  wrappers below are its two vocabularies — an earlier near-verbatim copy per wrapper meant a
 *  matching-rule change had to land twice). Given an address and which addresses each
 *  generation owns: a configured owner scopes the scan to that address from ITS generation's
 *  seed block (a full-span scan re-opens the multi-million-block range that trips ordinary
 *  endpoints and starves the windowed no-token fallback); no address = the full generation
 *  span; an address the config does not know scans verbatim across the full window. */
function generationScanTargets(
  dep: CorkRolloverDeployment,
  address: string | undefined,
  addressesOf: (g: { factory: string; exactSettler: string; partialSettler: string }) => string[],
  fullAddresses: `0x${string}`[],
): { addresses: `0x${string}`[]; fromBlock: number } {
  const full = rolloverScanTargets(dep);
  if (!address) return { addresses: fullAddresses, fromBlock: full.fromBlock };
  const lc = address.toLowerCase();
  for (const g of rolloverGenerations(dep)) {
    if (addressesOf(g).some((a) => a.toLowerCase() === lc)) {
      return { addresses: [address as `0x${string}`], fromBlock: g.seededAtBlock };
    }
  }
  return { addresses: [address as `0x${string}`], fromBlock: full.fromBlock };
}

/** Scan targets for ONE digest's event history: a digest binds to exactly one settler (the
 *  EIP-712 domain's verifyingContract). */
export function rolloverDigestScanTargets(
  dep: CorkRolloverDeployment,
  settler?: string,
): { addresses: `0x${string}`[]; fromBlock: number } {
  return generationScanTargets(dep, settler, (g) => [g.exactSettler, g.partialSettler], rolloverScanTargets(dep).settlers);
}

/** Scan targets for the CLONE feed: a clone binds to exactly one factory (observed live: the
 *  unscoped 20-window walk stopped ~10M blocks short of the rc.2 clone it was asked for). */
export function rolloverFactoryScanTargets(
  dep: CorkRolloverDeployment,
  factory?: string,
): { addresses: `0x${string}`[]; fromBlock: number } {
  return generationScanTargets(dep, factory, (g) => [g.factory], rolloverScanTargets(dep).factories);
}

export function rolloverScanTargets(dep: CorkRolloverDeployment): {
  settlers: `0x${string}`[];
  factories: `0x${string}`[];
  fromBlock: number;
} {
  const generations = rolloverGenerations(dep);
  return {
    settlers: generations.flatMap((g) => [g.exactSettler as `0x${string}`, g.partialSettler as `0x${string}`]),
    factories: generations.map((g) => g.factory as `0x${string}`),
    fromBlock: Math.min(...generations.map((g) => g.seededAtBlock)),
  };
}

const DefaultsSchema = z.object({
  schemaVersion: z.literal(2),
  updated: z.string(),
  lopAddresses: z.record(z.string(), Address),
  // 1inch Fusion settlement reference set — classification data for pricing/decode, never a call
  // target we choose (the active settlement is decoded from the order's own extension bytes).
  fusionSettlements: z
    .record(z.string(), z.object({ current: Address, legacy: z.array(Address).default([]) }).strip())
    .optional(),
  // Per chain: the primary label and every generation set (generations.ts). Everything an
  // address read answers — deployment, market registry, rollover, ForSelf, classification —
  // derives from this one block; there is no separate deployments/marketRegistry/rollover/
  // deploymentProfiles/marketRegistryLegacy record any more (those were schema 1's five
  // vocabularies for the same fact).
  generations: z.record(z.string(), ChainGenerationsSchema),
  // Approved-implementations allowlist (interface-first model, mirrored in the distribution-repo
  // proposal): per chain, per ROLE (resolved against the generation blocks — addresses are
  // never duplicated here), the runtime-codehash set admitted by the behavioral suite — the
  // UNION over every generation's code, because every generation's code is approved. Optional:
  // an older bundled copy without it simply skips the guard.
  approvedImplementations: z
    .record(
      z.string(),
      z.record(
        z.string(),
        z
          .object({
            proxy: z.literal("eip1967").optional(),
            approved: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/u)),
          })
          .strip(),
      ),
    )
    .optional(),
});
export type CorkDefaults = z.infer<typeof DefaultsSchema>;

export interface ResolvedConfig {
  defaults: CorkDefaults;
  /** Which copy served this process: fresh GitHub fetch, disk-cached fetch, or the bundled file. */
  source: "github" | "cache" | "bundled";
  /** Present exactly when a TRANSIENT fetch failure was hit (network/5xx/invalid content). A 404
   *  ("not published") serves the bundled copy silently — see the noise policy above. */
  warning?: { code: string; message: string };
}

/** Outcome of one remote attempt: content, or "the file is not published there" (404/410). */
export type RemoteFetchResult = { kind: "ok"; data: unknown } | { kind: "absent" };

/** On-disk cache entry: a successful fetch (`defaults`) or a recent negative outcome (`failure`).
 *  `failedAt` marks a refresh attempt that failed TRANSIENTLY while good `defaults` were already
 *  stored — the good copy is kept (never overwritten by a failure marker, F16) and served stale
 *  until the failure back-off elapses. */
export interface StoredCache {
  fetchedAt: number;
  defaults?: unknown;
  failure?: "absent" | "error";
  failedAt?: number;
}

export interface ConfigDeps {
  now: () => number;
  fetchRemote: () => Promise<RemoteFetchResult>;
  loadCache: () => StoredCache | null;
  saveCache: (entry: StoredCache) => void;
}

const TTL_MS = 3_600_000; // success: re-check GitHub at most hourly
const FAILURE_TTL_MS = 600_000; // negative outcome: don't re-attempt for 10 min (shared across CLI processes via disk)

// The document caches under its own file name: a 0.5.x binary sharing the cache dir keeps its
// v1 copy at `cork-defaults.json`, a 0.6.0 binary its `cork-defaults.v2.json`, and neither line
// can serve another's shape or keys.
function cachePath(): string {
  return process.env.CORK_CONFIG_CACHE_FILE ?? join(homedir(), ".cache", "cork-helper-cli", "config.default.json");
}

async function realFetchRemote(): Promise<RemoteFetchResult> {
  const res = await fetchWithTimeout(process.env.CORK_DEFAULTS_URL ?? CORK_DEFAULTS_URL, {}, 8_000);
  if (res.status === 404 || res.status === 410) return { kind: "absent" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { kind: "ok", data: await res.json() };
}

export function realConfigDeps(): ConfigDeps {
  return {
    now: () => Date.now(),
    fetchRemote: realFetchRemote,
    loadCache: () => {
      try {
        return JSON.parse(readFileSync(cachePath(), "utf8")) as StoredCache;
      } catch {
        return null;
      }
    },
    saveCache: (entry) => {
      try {
        mkdirSync(dirname(cachePath()), { recursive: true });
        atomicWriteFileSync(cachePath(), JSON.stringify(entry));
      } catch {
        /* best-effort; in-memory result still stands */
      }
    },
  };
}

export const STALE_CACHE_WARNING = {
  code: "config_fetch_failed",
  message:
    "could not refresh config.default.json from GitHub — serving the last successfully fetched copy (may be up to a refresh cycle stale); will retry after the failure back-off",
} as const;

export const FETCH_FAILED_WARNING = {
  code: "config_fetch_failed",
  message:
    "could not fetch the latest config.default.json from GitHub — serving the bundled copy; addresses may be stale if Cork has redeployed (private repo? check for updates with an authenticated `gh`/GitHub MCP)",
} as const;

let memo: { at: number; ttl: number; resolved: ResolvedConfig } | null = null;

/** Parse+validate an untrusted defaults payload; throws on any shape/checksum violation. A
 *  schema-1 document is rejected here too: the 0.6 line reads only v2, by design. */
export function parseDefaults(raw: unknown): CorkDefaults {
  return DefaultsSchema.parse(raw);
}

/** The defaults bundled into THIS build, parsed once. Address resolution stays remote-first
 *  (resolveConfig below); this is the copy that is authenticated by the release itself, so it
 *  is the only acceptable source for the approved-implementations allowlist — a document that
 *  could name a fresh address must never also be the one that admits the code behind it. */
export const BUNDLED_DEFAULTS: CorkDefaults = parseDefaults(bundledDefaults);
const BUNDLED = BUNDLED_DEFAULTS;

/** Bundled fallback for a negative outcome: "absent" is silent by policy, "error" warns. */
function fromFailure(failure: "absent" | "error"): ResolvedConfig {
  return failure === "error"
    ? { defaults: BUNDLED, source: "bundled", warning: FETCH_FAILED_WARNING }
    : { defaults: BUNDLED, source: "bundled" };
}

/**
 * Resolve the effective defaults: fresh-enough disk cache (positive OR negative) → GitHub fetch
 * (validated) → bundled fallback (silent when the file is simply not published; one-line warning
 * on a transient failure). Memoized in-process so the long-lived MCP server fetches at most hourly
 * (10 min after a negative outcome); the disk cache gives short-lived CLI processes the same pacing.
 */
export async function resolveConfig(deps: ConfigDeps = realConfigDeps()): Promise<ResolvedConfig> {
  // Deliberate offline mode (used by the deterministic test suite): serve the bundled file and
  // do not attempt the network. No warning — nothing was attempted-and-failed.
  if (process.env.CORK_CONFIG_NO_FETCH) return { defaults: BUNDLED, source: "bundled" };
  const now = deps.now();
  if (memo && now - memo.at < memo.ttl) return memo.resolved;

  const remember = (resolved: ResolvedConfig, ttl: number): ResolvedConfig => {
    memo = { at: now, ttl, resolved };
    return resolved;
  };

  const cached = deps.loadCache();
  // Parse any stored GOOD defaults up front: they are the fallback of record for transient
  // refresh failures (F16 — a 10-minute network blip must never roll addresses back to the
  // bundled copy when a fresher fetched copy is on disk).
  let staleGood: CorkDefaults | null = null;
  if (cached?.defaults !== undefined) {
    try {
      staleGood = parseDefaults(cached.defaults);
    } catch {
      /* corrupt cache — treat as absent */
    }
  }
  if (cached && staleGood === null && cached.failure && now - cached.fetchedAt < FAILURE_TTL_MS) {
    return remember(fromFailure(cached.failure), FAILURE_TTL_MS);
  }
  if (cached && staleGood !== null) {
    if (now - cached.fetchedAt < TTL_MS) {
      return remember({ defaults: staleGood, source: "cache" }, TTL_MS);
    }
    // Expired, but a refresh failed recently: keep serving the last GOOD copy during the back-off.
    if (cached.failedAt !== undefined && now - cached.failedAt < FAILURE_TTL_MS) {
      return remember({ defaults: staleGood, source: "cache", warning: STALE_CACHE_WARNING }, FAILURE_TTL_MS);
    }
  }

  let failure: "absent" | "error";
  try {
    const r = await deps.fetchRemote();
    if (r.kind === "ok") {
      const defaults = parseDefaults(r.data); // throws on tampered/invalid content → "error" below
      deps.saveCache({ fetchedAt: now, defaults });
      return remember({ defaults, source: "github" }, TTL_MS);
    }
    failure = "absent";
  } catch {
    failure = "error";
  }
  if (failure === "error" && staleGood !== null && cached) {
    // Transient failure with a good copy on disk: keep the good copy (mark the failed attempt),
    // serve it stale with a warning. Never overwrite fetched-good defaults with a failure marker.
    deps.saveCache({ ...cached, failedAt: now });
    return remember({ defaults: staleGood, source: "cache", warning: STALE_CACHE_WARNING }, FAILURE_TTL_MS);
  }
  deps.saveCache({ fetchedAt: now, failure });
  return remember(fromFailure(failure), FAILURE_TTL_MS);
}

/** Test hook: clear the in-process memo. */
export function resetConfigMemo(): void {
  memo = null;
}

/** Snapshot of the last in-process config resolution for the /readyz diagnostics surface —
 *  which copy is serving (github/cache/bundled), how old the resolution is, and whether it
 *  carried a fetch-failure warning. Null before the first resolution (or after a memo reset). */
export function configDiagnostics(now: number = Date.now()): { source: ResolvedConfig["source"]; ageMs: number; ttlMs: number; degraded: boolean } | null {
  if (process.env.CORK_CONFIG_NO_FETCH) return { source: "bundled", ageMs: 0, ttlMs: 0, degraded: false };
  if (!memo) return null;
  return { source: memo.resolved.source, ageMs: Math.max(0, now - memo.at), ttlMs: memo.ttl, degraded: memo.resolved.warning !== undefined };
}

// ── Generation-aware resolvers ──────────────────────────────────────────────────────────────────
// Every resolver below keeps its pre-0.6 name and return shape (callers destructure `deployment`
// / `rollover` / `marketRegistry` + `source` + `warning`) and ADDS: an optional `generation`
// label argument (omitted = the chain's primary), a `generation` reference on the result naming
// the set that answered, and — when the label was refused — `refusal` beside an undefined block
// (`generation_unknown` lists the chain's labels; `generation_read_only` is the prepare gate a
// handler applies through `selectGeneration(..., "prepare")`).

/** The shared tail of every resolver result. */
interface ResolverProvenance {
  source: ResolvedConfig["source"];
  warning?: { code: string; message: string };
  refusal?: GenerationRefusal;
}

function provenanceOf(cfg: ResolvedConfig): ResolverProvenance {
  return { source: cfg.source, ...(cfg.warning ? { warning: cfg.warning } : {}) };
}

const refOf = (g: ResolvedGeneration): GenerationRef => ({ label: g.label, status: g.status, ...(g.distribution !== undefined ? { distribution: g.distribution } : {}) });

/** The chain's generations (resolution order) over the resolved defaults (remote-first). */
export async function resolveGenerations(
  chainId: number,
  deps?: ConfigDeps,
): Promise<{ generations: ResolvedGeneration[]; primary: ResolvedGeneration | undefined } & ResolverProvenance> {
  const cfg = await resolveConfig(deps);
  const generations = generationsOf(cfg.defaults, chainId);
  return { generations, primary: generations.find((g) => g.primary), ...provenanceOf(cfg) };
}

/** Deployment lookup over the resolved defaults (remote-first, bundled fallback): the phoenix
 *  block of the selected generation (the primary when `generation` is omitted). */
export async function resolveDeployment(
  chainId: number,
  deps?: ConfigDeps,
  generation?: GenerationLabel,
): Promise<{ deployment: CorkDeployment | undefined; generation?: GenerationRef & { wire?: PhoenixWire } } & ResolverProvenance> {
  const cfg = await resolveConfig(deps);
  const list = generationsOf(cfg.defaults, chainId);
  if (list.length === 0) return { deployment: undefined, ...provenanceOf(cfg) };
  const sel = selectGeneration(list, generation, "read", ["phoenix"]);
  if (!sel.ok) return { deployment: undefined, refusal: sel.refusal, ...provenanceOf(cfg) };
  const g = sel.generation;
  return {
    deployment: g.phoenix,
    generation: { ...refOf(g), ...(g.phoenix ? { wire: g.phoenix.wire } : {}) },
    ...provenanceOf(cfg),
  };
}

/** Rollover venue contracts for a chain (undefined where the selected generation carries no
 *  rollover block — chain 1 today). The record's top-level fields are the SELECTED generation's
 *  block; `generations` is the chain's whole flattened list, so consumers that classify a
 *  settler against every generation keep working unchanged. */
export async function resolveRollover(
  chainId: number,
  deps?: ConfigDeps,
  generation?: GenerationLabel,
): Promise<{ rollover: CorkRolloverDeployment | undefined; generation?: GenerationRef & { wire?: RolloverWire } } & ResolverProvenance> {
  const cfg = await resolveConfig(deps);
  const list = generationsOf(cfg.defaults, chainId);
  if (list.length === 0) return { rollover: undefined, ...provenanceOf(cfg) };
  const sel = selectGeneration(list, generation, "read", ["rollover"]);
  if (!sel.ok) return { rollover: undefined, refusal: sel.refusal, ...provenanceOf(cfg) };
  const g = sel.generation;
  const generations = rolloverGenerationsOf(list);
  const own = generations.find((r) => r.label === g.label);
  if (!own) return { rollover: undefined, generation: refOf(g), ...provenanceOf(cfg) };
  return { rollover: { ...own, generations }, generation: { ...refOf(g), wire: own.wire }, ...provenanceOf(cfg) };
}

/** The MarketRegistry stack of the selected generation (registry / adapter / creator / factories
 *  / recipe hints + its wire), or undefined where that generation carries none (chain 1). The
 *  DEPRECATED pre-2.1.0 lane is the generation whose block declares `wire: "legacy"` — callers
 *  find it with `marketRegistryForWire(generations, "legacy")` (generations.ts) after passing
 *  the deprecation gate; `resolveMarketRegistryLegacy` no longer exists. */
export async function resolveMarketRegistry(
  chainId: number,
  deps?: ConfigDeps,
  generation?: GenerationLabel,
): Promise<{ marketRegistry: CorkMarketRegistry | undefined; generation?: GenerationRef & { wire?: MarketRegistryWire } } & ResolverProvenance> {
  const cfg = await resolveConfig(deps);
  const list = generationsOf(cfg.defaults, chainId);
  if (list.length === 0) return { marketRegistry: undefined, ...provenanceOf(cfg) };
  const sel = selectGeneration(list, generation, "read", ["marketRegistry"]);
  if (!sel.ok) return { marketRegistry: undefined, refusal: sel.refusal, ...provenanceOf(cfg) };
  const g = sel.generation;
  return {
    marketRegistry: g.marketRegistry,
    generation: { ...refOf(g), ...(g.marketRegistry ? { wire: g.marketRegistry.wire } : {}) },
    ...provenanceOf(cfg),
  };
}
