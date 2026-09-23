// Per-test-FILE isolation of the scan-cursor cache (2026-09-23).
//
// The cache is keyed by CORK_SCAN_CACHE_FILE. One path for the whole vitest run (the previous
// `test.env` setting, evaluated ONCE in the main process) meant every test file in every worker
// shared one file — and every stub world caches rows under the SAME scan identity (the real pool
// manager addresses from cork-defaults), so a read in one file inherited rows another file's
// fixtures had cached: the positions sweep answered 6 pools where its stub holds 2, the moment it
// shared cork-pools' cursor. A setup file runs inside each worker for each test file, so the path
// can carry the test file's identity. Tests needing per-TEST isolation still re-point the
// variable themselves (hypersync.test.ts does).
//
// scan-cache.ts is additionally a NO-OP under vitest when the variable is unset (the constants
// cache's rule), so a run without this setup file never touches ~/.cache either.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect } from "vitest";

beforeAll(() => {
  const file = expect.getState().testPath ?? "unknown";
  const tag = createHash("sha256").update(file).digest("hex").slice(0, 12);
  process.env["CORK_SCAN_CACHE_FILE"] = join(tmpdir(), `cork-scan-cache-vitest-${String(process.pid)}-${tag}.json`);
});
