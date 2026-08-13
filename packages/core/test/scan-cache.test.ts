// The incremental-cursor store, unit-tested directly: multi-process merge-on-write (the MCP
// server and CLI runs share one file — a memo-based read-modify-write would clobber sibling
// entries), the oversized-row-set cap, and corrupt-file recovery. Env manipulation uses indexed
// access: these are PUBLIC configuration names in test-only save/restore helpers.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readScanCache, SCAN_CACHE_MAX_ROWS, writeScanCache } from "../src/scan-cache.ts";

const VAR = "CORK_SCAN_CACHE_FILE";
const freshPath = (tag: string) => `${process.env["TMPDIR"] ?? "/tmp"}/cork-scan-unit-${tag}-${process.pid}-${Math.floor(performance.now() * 1e6)}.json`;

function withCache(tag: string, fn: (path: string) => void): void {
  const prev = process.env[VAR];
  const path = freshPath(tag);
  process.env[VAR] = path;
  try {
    fn(path);
  } finally {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
  }
}

describe("scan-cache", () => {
  it("merges from DISK at write: a sibling process's entry survives our write", () => {
    withCache("merge", (path) => {
      writeScanCache("scan-a", { watermark: 1, rows: [{ x: 1 }] });
      // A sibling process writes its own entry directly (our in-process memo knows nothing).
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown> };
      onDisk.entries["scan-b"] = { watermark: 2, rows: [] };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(onDisk));
      // Our next write must MERGE, not clobber the whole file with our stale view.
      writeScanCache("scan-c", { watermark: 3, rows: [] });
      const final = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { watermark: number }> };
      expect(Object.keys(final.entries).sort()).toEqual(["scan-a", "scan-b", "scan-c"]);
      expect(final.entries["scan-b"]!.watermark).toBe(2);
    });
  });

  it("an oversized row set is not persisted (full rescan beats a multi-hundred-MB cache file)", () => {
    withCache("cap", (path) => {
      writeScanCache("small", { watermark: 1, rows: [] });
      writeScanCache("huge", { watermark: 2, rows: Array.from({ length: SCAN_CACHE_MAX_ROWS + 1 }, (_, i) => ({ i })) });
      const final = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown> };
      expect(Object.keys(final.entries)).toEqual(["small"]);
      expect(readScanCache("huge")).toBeUndefined();
    });
  });

  it("a corrupt cache file reads as empty — the cache may never break a read", () => {
    withCache("corrupt", (path) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{not json");
      expect(readScanCache("anything")).toBeUndefined();
      // ...and writing over the corpse works.
      writeScanCache("fresh", { watermark: 7, rows: [] });
      expect(readScanCache("fresh")?.watermark).toBe(7);
    });
  });
});
