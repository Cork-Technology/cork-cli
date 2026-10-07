// gh-CLI-style passive update notice. The hot path NEVER fetches: it reads a small cache file
// and, when the cache is stale, spawns a detached refresh of itself (`ch __update-check`) whose
// result is shown on a LATER run. Zero added latency; one network touch per 24 h at most.
//
// The notice is deliberately hard to trigger: stderr only, TTY only, suppressed for JSON output,
// CI, MCP mode, self-update itself, dev builds, and CORK_NO_UPDATE_NOTIFIER=1 — this tool's
// stdout may be a protocol stream or a piped envelope, and neither may ever be polluted.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareVersions } from "@cork/core";
import { envFlag } from "./env.ts";

import { BUILD_REPO, latestReleaseTag, channelCacheKey, type ReleaseRepo } from "../../core/src/release-channel.ts";
export const RELEASE_REPO = BUILD_REPO;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCache {
  scope?: string; // repository-bound; unscoped/other-channel entries are never served
  checkedAt?: string; // last refresh attempt (success OR failure — failures back off too)
  latest?: string; // latest release tag seen
  notifiedAt?: string; // last time a notice was printed
}

function updateCachePath(env: Record<string, string | undefined> = process.env): string {
  return env["CORK_UPDATE_CACHE_FILE"] ?? join(homedir(), ".cache", "cork-helper-cli", RELEASE_REPO.split("/")[1]!, "update-check.json");
}

/** Pure decision: what to do this run. Everything impure is injected so tests can cover the gates. */
export function updateDecision(opts: {
  currentVersion: string;
  argv: readonly string[];
  env: Record<string, string | undefined>;
  stderrIsTTY: boolean;
  cache: UpdateCache | null;
  nowMs: number;
}): { notice: string | null; refresh: boolean; cacheUpdate: UpdateCache | null } {
  const { currentVersion, argv, env, stderrIsTTY, cache, nowMs } = opts;
  const silent =
    !stderrIsTTY ||
    currentVersion === "dev" ||
    envFlag(env, "CORK_NO_UPDATE_NOTIFIER") ||
    env["CI"] !== undefined ||
    envFlag(env, "CORK_JSON") ||
    argv.includes("--json") ||
    argv[0] === "mcp" ||
    argv[0] === "self-update" ||
    argv[0] === "__update-check";
  if (silent) return { notice: null, refresh: false, cacheUpdate: null };

  const checkedAt = cache?.checkedAt ? Date.parse(cache.checkedAt) : Number.NaN;
  const refresh = !Number.isFinite(checkedAt) || nowMs - checkedAt > CHECK_INTERVAL_MS;

  let notice: string | null = null;
  let cacheUpdate: UpdateCache | null = null;
  if (cache?.latest && compareVersions(cache.latest, currentVersion) > 0) {
    const notifiedAt = cache.notifiedAt ? Date.parse(cache.notifiedAt) : Number.NaN;
    if (!Number.isFinite(notifiedAt) || nowMs - notifiedAt > NOTIFY_INTERVAL_MS) {
      notice = `\nch ${cache.latest} is available (you have ${currentVersion}) — run \`ch self-update\`, or see https://github.com/${RELEASE_REPO}/releases\n`;
      cacheUpdate = { ...cache, notifiedAt: new Date(nowMs).toISOString() };
    }
  }
  return { notice, refresh, cacheUpdate };
}

function readUpdateCache(path: string, repo: ReleaseRepo = RELEASE_REPO): UpdateCache | null {
  try {
    const cache = JSON.parse(readFileSync(path, "utf8")) as UpdateCache;
    return cache.scope === channelCacheKey(repo, "releases/latest") ? cache : null;
  } catch {
    return null;
  }
}

function writeUpdateCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache)}\n`);
  } catch {
    // a cache we cannot write just means we check again next run
  }
}

/** The `__update-check` body: one bounded fetch of the latest release tag, cached win or lose. */
export async function refreshUpdateCache(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  repo: ReleaseRepo = RELEASE_REPO,
): Promise<void> {
  const path = updateCachePath(env);
  const prior = readUpdateCache(path, repo) ?? {};
  const next: UpdateCache = { ...prior, scope: channelCacheKey(repo, "releases/latest"), checkedAt: new Date().toISOString() };
  try {
    next.latest = await latestReleaseTag(repo, env, fetchImpl);
  } catch {
    // failure is cached via checkedAt so we back off a full interval rather than hammering
  }
  writeUpdateCache(path, next);
}

/**
 * Orchestrate the whole notify path for one CLI run. Failure-proof by construction: every fs/spawn
 * problem degrades to doing nothing.
 */
export function maybeNotifyUpdates(argv: readonly string[], currentVersion: string): void {
  try {
    const path = updateCachePath();
    const decision = updateDecision({
      currentVersion,
      argv,
      env: process.env,
      stderrIsTTY: process.stderr.isTTY === true,
      cache: readUpdateCache(path),
      nowMs: Date.now(),
    });
    if (decision.notice) process.stderr.write(decision.notice);
    if (decision.cacheUpdate) writeUpdateCache(path, decision.cacheUpdate);
    if (decision.refresh) spawnDetachedRefresh();
  } catch {
    // never let update plumbing affect the command the user actually ran
  }
}

function spawnDetachedRefresh(): void {
  // Re-invoke ourselves with the hidden refresh command. In a compiled binary argv[1] is the
  // embedded bunfs virtual path (not spawnable), so the binary is executed directly; in a
  // source run the script path must be forwarded to bun.
  const script = process.argv[1] ?? "";
  const compiled = script.startsWith("/$bunfs/") || script.startsWith("B:\\~BUN\\") || script === "";
  const args = compiled ? ["__update-check"] : [script, "__update-check"];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
}
