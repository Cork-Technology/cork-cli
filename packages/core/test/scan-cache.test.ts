// The incremental-cursor store, unit-tested directly: multi-process merge-on-write (the MCP
// server and CLI runs share one file — a memo-based read-modify-write would clobber sibling
// entries), the oversized-row-set cap, and corrupt-file recovery. Env manipulation uses indexed
// access: these are PUBLIC configuration names in test-only save/restore helpers.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readScanCache, SCAN_CACHE_MAX_ROWS, SCAN_CACHE_SCHEMA, writeScanCache } from "../src/scan-cache.ts";

// The home directory is OWNED by the test through a module mock, not by mutating HOME: Bun's
// os.homedir() does not follow a runtime HOME change (Node's does), so on a Node-less host — where
// vitest itself runs under Bun — the HOME redirect was silently ignored, the gate test passed
// vacuously, and the gate-dropped mutants survived while writing into the developer's REAL
// ~/.cache (mutation run on 4f7099d, 2026-09-23). The mock holds on either runtime.
const home = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const homedir = (): string => home.dir ?? os.homedir();
  return { ...os, default: { ...os, homedir }, homedir };
});

/** Keys carry the row-shape schema prefix, as `scanCacheId` writes them — a key without it is a
 *  stale-schema entry and is pruned at load (review C6). */
const k = (name: string) => `v${String(SCAN_CACHE_SCHEMA)}:${name}`;

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
  it("is a NO-OP under vitest when CORK_SCAN_CACHE_FILE is unset (the constants cache's rule): the DEFAULT file under the home directory is neither read nor written by a bare test run", () => {
    // Redirect the home directory to a scratch dir (the node:os mock above) so the "default" file
    // is one this test owns, seed it with an entry, and prove the gate: a read does not see the
    // seed, a write does not change the file.
    const prevVar = process.env[VAR];
    const scratchHome = `${process.env["TMPDIR"] ?? "/tmp"}/cork-scan-home-${process.pid}-${Math.floor(performance.now() * 1e6)}`;
    const defaultFile = `${scratchHome}/.cache/cork-helper-cli/scan-cache.json`;
    mkdirSync(dirname(defaultFile), { recursive: true });
    const seeded = JSON.stringify({ entries: { [k("seeded")]: { watermark: 7, rows: [{ seed: true }] } } });
    writeFileSync(defaultFile, seeded);
    delete process.env[VAR];
    home.dir = scratchHome;
    try {
      expect(process.env["VITEST"]).toBeDefined(); // the gate's precondition holds in this worker
      expect(readScanCache(k("seeded"))).toBeUndefined(); // gated read: the seed is invisible
      writeScanCache(k("gated"), { watermark: 5, rows: [{ x: 1 }] });
      expect(readFileSync(defaultFile, "utf8")).toBe(seeded); // gated write: the file is untouched
    } finally {
      if (prevVar !== undefined) process.env[VAR] = prevVar;
      home.dir = undefined;
    }
    // Opted in, the same write round-trips.
    withCache("gate-optin", () => {
      writeScanCache(k("gated"), { watermark: 5, rows: [{ x: 1 }] });
      expect(readScanCache(k("gated"))).toEqual({ watermark: 5, rows: [{ x: 1 }] });
    });
  });
  it("merges from DISK at write: a sibling process's entry survives our write", () => {
    withCache("merge", (path) => {
      writeScanCache(k("scan-a"), { watermark: 1, rows: [{ x: 1 }] });
      // A sibling process writes its own entry directly (our in-process memo knows nothing).
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, unknown> };
      onDisk.entries[k("scan-b")] = { watermark: 2, rows: [] };
      // A sibling from an OLDER build (no schema prefix) sits beside it — pruned at our next load.
      onDisk.entries["scan-stale"] = { watermark: 9, rows: [{ old: true }] };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(onDisk));
      // Our next write must MERGE, not clobber the whole file with our stale view.
      writeScanCache(k("scan-c"), { watermark: 3, rows: [] });
      const final = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { watermark: number }> };
      expect(Object.keys(final.entries).sort()).toEqual([k("scan-a"), k("scan-b"), k("scan-c")].sort());
      expect(final.entries[k("scan-b")]!.watermark).toBe(2);
      expect(final.entries["scan-stale"]).toBeUndefined();
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
