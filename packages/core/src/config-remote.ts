// Remote-first config sourcing [R6/§8]: deployment addresses are fetched from this repo's
// canonical GitHub `cork-defaults.json` (TTL-cached in memory + on disk), with the committed copy
// bundled in the distribution as the fallback. Never bare hardcodes: the single source of truth is
// the JSON file, remote copy preferred, and every result can say which one served it.
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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import bundledDefaults from "../../../cork-defaults.json";
import type { CorkDeployment } from "./config.ts";

/** Canonical source of the latest defaults; the `CORK_DEFAULTS_URL` env var overrides it. */
export const CORK_DEFAULTS_URL =
  "https://raw.githubusercontent.com/Cork-Technology/cork-helper-cli/main/cork-defaults.json";

const DeploymentSchema = z
  .object({
    poolManager: Address,
    constraintAdapter: Address,
    corkAdapter: Address.optional(),
    bundler3: Address.optional(),
    whitelistManager: Address.optional(),
  })
  .strip();

// Rollover venue contracts (rollover-private): the factory that self-deploys per-user clones and
// the two ERC-7683 settlers. `settlerDomain` is the EIP-712 domain OrderData is signed under
// (verifyingContract = the settler). `seededAtBlock` = the SettlerApproved seeding block — the
// backfill start for event reconstruction (the factory itself deploys at most a few blocks earlier).
const RolloverDeploymentSchema = z
  .object({
    factory: Address,
    exactSettler: Address,
    partialSettler: Address,
    settlerDomain: z.object({ name: z.string(), version: z.string() }).strip(),
    seededAtBlock: z.number().int().nonnegative(),
  })
  .strip();
export type CorkRolloverDeployment = z.infer<typeof RolloverDeploymentSchema>;

const DefaultsSchema = z.object({
  schemaVersion: z.literal(1),
  updated: z.string(),
  deployments: z.record(z.string(), DeploymentSchema),
  lopAddresses: z.record(z.string(), Address),
  // Named alternate Phoenix deployments on a chain that already has a primary entry (e.g. the
  // Arbitrum "arbitrum-staging" shadow deployment the 2026Q3 rollover campaign runs against).
  // Consumers must opt in by profile name; `deployments` stays the default read path.
  deploymentProfiles: z.record(z.string(), z.record(z.string(), DeploymentSchema)).optional(),
  rollover: z.record(z.string(), RolloverDeploymentSchema).optional(),
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

/** On-disk cache entry: a successful fetch (`defaults`) or a recent negative outcome (`failure`). */
export interface StoredCache {
  fetchedAt: number;
  defaults?: unknown;
  failure?: "absent" | "error";
}

export interface ConfigDeps {
  now: () => number;
  fetchRemote: () => Promise<RemoteFetchResult>;
  loadCache: () => StoredCache | null;
  saveCache: (entry: StoredCache) => void;
}

const TTL_MS = 3_600_000; // success: re-check GitHub at most hourly
const FAILURE_TTL_MS = 600_000; // negative outcome: don't re-attempt for 10 min (shared across CLI processes via disk)

function cachePath(): string {
  return process.env.CORK_CONFIG_CACHE_FILE ?? join(homedir(), ".cache", "cork-helper-cli", "cork-defaults.json");
}

async function realFetchRemote(): Promise<RemoteFetchResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(process.env.CORK_DEFAULTS_URL ?? CORK_DEFAULTS_URL, { signal: ctrl.signal });
    if (res.status === 404 || res.status === 410) return { kind: "absent" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { kind: "ok", data: await res.json() };
  } finally {
    clearTimeout(t);
  }
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
        writeFileSync(cachePath(), JSON.stringify(entry));
      } catch {
        /* best-effort; in-memory result still stands */
      }
    },
  };
}

export const FETCH_FAILED_WARNING = {
  code: "config_fetch_failed",
  message:
    "could not fetch the latest cork-defaults.json from GitHub — serving the bundled copy; addresses may be stale if Cork has redeployed (private repo? check for updates with an authenticated `gh`/GitHub MCP)",
} as const;

let memo: { at: number; ttl: number; resolved: ResolvedConfig } | null = null;

/** Parse+validate an untrusted defaults payload; throws on any shape/checksum violation. */
export function parseDefaults(raw: unknown): CorkDefaults {
  return DefaultsSchema.parse(raw);
}

const BUNDLED: CorkDefaults = parseDefaults(bundledDefaults);

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
  if (cached && now - cached.fetchedAt < (cached.failure ? FAILURE_TTL_MS : TTL_MS)) {
    if (cached.failure) return remember(fromFailure(cached.failure), FAILURE_TTL_MS);
    try {
      return remember({ defaults: parseDefaults(cached.defaults), source: "cache" }, TTL_MS);
    } catch {
      /* corrupt cache — fall through to a fresh fetch */
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
  deps.saveCache({ fetchedAt: now, failure });
  return remember(fromFailure(failure), FAILURE_TTL_MS);
}

/** Test hook: clear the in-process memo. */
export function resetConfigMemo(): void {
  memo = null;
}

/** Deployment lookup over the resolved defaults (remote-first, bundled fallback). */
export async function resolveDeployment(
  chainId: number,
  deps?: ConfigDeps,
): Promise<{ deployment: CorkDeployment | undefined; source: ResolvedConfig["source"]; warning?: { code: string; message: string } }> {
  const cfg = await resolveConfig(deps);
  const deployment = cfg.defaults.deployments[String(chainId)] as CorkDeployment | undefined;
  return { deployment, source: cfg.source, ...(cfg.warning ? { warning: cfg.warning } : {}) };
}

/** Rollover venue contracts for a chain (undefined where the rollover protocol isn't deployed). */
export async function resolveRollover(
  chainId: number,
  deps?: ConfigDeps,
): Promise<{ rollover: CorkRolloverDeployment | undefined; source: ResolvedConfig["source"]; warning?: { code: string; message: string } }> {
  const cfg = await resolveConfig(deps);
  const rollover = cfg.defaults.rollover?.[String(chainId)];
  return { rollover, source: cfg.source, ...(cfg.warning ? { warning: cfg.warning } : {}) };
}
