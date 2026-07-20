// Remote-first config sourcing [R6/§8]: deployment addresses are fetched from this repo's
// canonical GitHub `cork-defaults.json` (TTL-cached in memory + on disk), with the committed copy
// bundled in the distribution as the fallback. Never bare hardcodes: the single source of truth is
// the JSON file, remote copy preferred, and every result can say which one served it.
//
// Fetched content is UNTRUSTED until validated: it is parsed against strict zod schemas (checksummed
// addresses, closed shape) — a malformed or tampered remote file is treated as a fetch failure and
// the bundled fallback is used, with a warning.
import { z } from "zod";
import { Address } from "@cork/schemas";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import bundledDefaults from "../../../cork-defaults.json";
import type { CorkDeployment } from "./config.ts";

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

const DefaultsSchema = z.object({
  schemaVersion: z.literal(1),
  updated: z.string(),
  deployments: z.record(z.string(), DeploymentSchema),
  lopAddresses: z.record(z.string(), Address),
});
export type CorkDefaults = z.infer<typeof DefaultsSchema>;

export interface ResolvedConfig {
  defaults: CorkDefaults;
  /** Which copy served this process: fresh GitHub fetch, disk-cached fetch, or the bundled file. */
  source: "github" | "cache" | "bundled";
  /** Present exactly when the remote fetch was attempted and failed (or returned invalid data). */
  warning?: { code: string; message: string };
}

export interface ConfigDeps {
  now: () => number;
  fetchRemote: () => Promise<unknown>;
  loadCache: () => { fetchedAt: number; defaults: unknown } | null;
  saveCache: (fetchedAt: number, defaults: CorkDefaults) => void;
}

const TTL_MS = 3_600_000; // re-check GitHub at most hourly

function cachePath(): string {
  return process.env.CORK_CONFIG_CACHE_FILE ?? join(homedir(), ".cache", "cork-helper-cli", "cork-defaults.json");
}

async function realFetchRemote(): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(CORK_DEFAULTS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
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
        return JSON.parse(readFileSync(cachePath(), "utf8")) as { fetchedAt: number; defaults: unknown };
      } catch {
        return null;
      }
    },
    saveCache: (fetchedAt, defaults) => {
      try {
        mkdirSync(dirname(cachePath()), { recursive: true });
        writeFileSync(cachePath(), JSON.stringify({ fetchedAt, defaults }));
      } catch {
        /* best-effort; in-memory result still stands */
      }
    },
  };
}

export const FETCH_FAILED_WARNING = {
  code: "config_fetch_failed",
  message:
    "Could not fetch the latest cork-defaults.json from GitHub. If the repo is private, use an authenticated GitHub MCP server or `gh` CLI with a whitelisted account to check for updates — or rely on the fallback address file bundled with this distribution (now in use). Addresses may be stale if Cork has redeployed.",
} as const;

let memo: { at: number; resolved: ResolvedConfig } | null = null;

/** Parse+validate an untrusted defaults payload; throws on any shape/checksum violation. */
export function parseDefaults(raw: unknown): CorkDefaults {
  return DefaultsSchema.parse(raw);
}

const BUNDLED: CorkDefaults = parseDefaults(bundledDefaults);

/**
 * Resolve the effective defaults: fresh-enough disk cache → GitHub fetch (validated) → bundled
 * fallback with a warning. Memoized in-process for the TTL so the long-lived MCP server fetches
 * at most hourly and the CLI reuses the disk cache across runs.
 */
export async function resolveConfig(deps: ConfigDeps = realConfigDeps()): Promise<ResolvedConfig> {
  // Deliberate offline mode (used by the deterministic test suite): serve the bundled file and
  // do not attempt the network. No warning — nothing was attempted-and-failed.
  if (process.env.CORK_CONFIG_NO_FETCH) return { defaults: BUNDLED, source: "bundled" };
  const now = deps.now();
  if (memo && now - memo.at < TTL_MS) return memo.resolved;

  const cached = deps.loadCache();
  if (cached && now - cached.fetchedAt < TTL_MS) {
    try {
      const resolved: ResolvedConfig = { defaults: parseDefaults(cached.defaults), source: "cache" };
      memo = { at: now, resolved };
      return resolved;
    } catch {
      /* corrupt cache — fall through to a fresh fetch */
    }
  }

  try {
    const defaults = parseDefaults(await deps.fetchRemote());
    deps.saveCache(now, defaults);
    const resolved: ResolvedConfig = { defaults, source: "github" };
    memo = { at: now, resolved };
    return resolved;
  } catch {
    const resolved: ResolvedConfig = { defaults: BUNDLED, source: "bundled", warning: FETCH_FAILED_WARNING };
    memo = { at: now, resolved };
    return resolved;
  }
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
