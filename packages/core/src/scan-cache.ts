// Incremental cursors for full-decentralized event scans: HyperSync history is append-only, so
// re-scanning it from genesis on every call wastes quota and latency. This cache stores each
// scan's DECODED-but-UNFILTERED rows plus a block watermark (the archive height the backfill
// completed at); the next call scans only (watermark - REORG_OVERLAP, head] and merges. Rows are
// cached PRE-postFilter deliberately — filters and join maps vary per call (filters.poolId, the
// fills join's txPools closure), so filtering must run fresh every time.
//
// Reorg safety: the overlap window is re-scanned every call, and cached rows inside it are
// REPLACED by the fresh scan (a boundary reorg's orphaned rows age out instead of persisting).
// Honesty bounds: a partial backfill (page-capped) is never written back, and a scan whose row
// set exceeds SCAN_CACHE_MAX_ROWS is not cached at all (full rescan each call, exactly as
// before) — the cache may only ever make a read cheaper, never change what it returns.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-file.ts";

export const SCAN_REORG_OVERLAP = 200;
export const SCAN_CACHE_MAX_ROWS = 20_000;

export interface ScanCacheEntry {
  watermark: number;
  rows: Array<Record<string, unknown>>;
}

interface ScanCacheFile {
  entries: Record<string, ScanCacheEntry>;
}

function cachePath(): string {
  return process.env.CORK_SCAN_CACHE_FILE ?? join(homedir(), ".cache", "cork-helper-cli", "scan-cache.json");
}

// Memoized per path — tests point CORK_SCAN_CACHE_FILE at temp files and must not see each
// other's state.
let memo: { path: string; file: ScanCacheFile } | undefined;

function loadFile(): ScanCacheFile {
  const path = cachePath();
  if (memo?.path === path) return memo.file;
  let file: ScanCacheFile = { entries: {} };
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && "entries" in parsed && typeof (parsed as ScanCacheFile).entries === "object") {
        // Keep only entries of THIS row-shape schema: an older decoder's cursors are never
        // served (the identity would not match) and would otherwise accumulate ≤20k decoded
        // rows each for as long as the file lives. Pruned on load, so the next write drops them.
        const entries = (parsed as ScanCacheFile).entries ?? {};
        file = { entries: Object.fromEntries(Object.entries(entries).filter(([id]) => id.startsWith(`v${String(SCAN_CACHE_SCHEMA)}:`))) };
      }
    }
  } catch {
    /* corrupt or unreadable cache — start fresh; the cache may never break a read */
  }
  memo = { path, file };
  return file;
}

/** The ROW-SHAPE version of every cached scan, part of every identity. Bump it whenever a
 *  decoder's output changes for the same (address, topics) — the cache stores DECODED rows, so a
 *  cursor written by an older decoder would otherwise serve rows in the old shape forever (the
 *  identity below would still match) and the reorg overlap re-decodes only the tail.
 *  2 (0.6, 2026-09-22): MarketCreated rows gained `wire` / `generation` / the 10-field fees and the
 *  scan asks for both MarketCreated topics; every 0.5.x entry (schema 1, 7-arg only) is ignored —
 *  and DROPPED at load (`loadFile`), so a stale cursor's ≤20k decoded rows do not sit in the file
 *  forever (review C6). */
export const SCAN_CACHE_SCHEMA = 2;

/** Stable identity for one scan: the row-shape schema plus the spec fields that define WHAT is
 *  being scanned. A changed address set / topic set / floor is a different scan and must not
 *  inherit another's rows; a changed decoder (SCAN_CACHE_SCHEMA) is a different scan too. */
export function scanCacheId(a: { chainId: number; name: string; fromBlock: number; address: readonly string[]; topics: ReadonlyArray<readonly string[] | null> }): string {
  const addr = [...a.address].map((x) => x.toLowerCase()).sort().join(",");
  const topics = a.topics.map((t) => (t === null ? "*" : [...t].map((x) => x.toLowerCase()).sort().join("|"))).join(";");
  return `v${String(SCAN_CACHE_SCHEMA)}:${String(a.chainId)}:${a.name}:${String(a.fromBlock)}:${addr}:${topics}`;
}

export function readScanCache(id: string): ScanCacheEntry | undefined {
  const entry = loadFile().entries[id];
  if (!entry || !Number.isFinite(entry.watermark) || !Array.isArray(entry.rows)) return undefined;
  return entry;
}

export function writeScanCache(id: string, entry: ScanCacheEntry): void {
  if (entry.rows.length > SCAN_CACHE_MAX_ROWS) return; // too big to be worth persisting — see header
  // Merge from DISK, not from the in-process memo: the long-lived MCP server and any number of
  // CLI runs share this file, and a memo-based read-modify-write would clobber every entry a
  // sibling process wrote since our last read (last-writer-wins on the WHOLE file). Re-reading
  // narrows the race to concurrent same-entry writers, where either value is a valid cursor.
  memo = undefined;
  const file = loadFile();
  file.entries[id] = entry;
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(file));
  } catch {
    /* cache write failure is never a read failure */
  }
}
