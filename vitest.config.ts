import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Array form, most-specific first: the subpath regex must win before the bare "@cork/core"
    // entry can prefix-match "@cork/core/math" into ".../index.ts/math".
    alias: [
      { find: /^@cork\/core\/(.+)$/u, replacement: r("packages/core/src/exports") + "/$1.ts" },
      { find: "@cork/schemas", replacement: r("packages/schemas/src/index.ts") },
      { find: "@cork/core", replacement: r("packages/core/src/index.ts") },
      { find: "@cork/mcp", replacement: r("packages/mcp/src/index.ts") },
      { find: "@cork/cli", replacement: r("packages/cli/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/*.test.ts", "evals/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Unit tests must be deterministic offline: serve the bundled cork-defaults.json without
    // attempting the GitHub fetch (config-remote.ts honors this). The scan-cursor cache is
    // pointed at a per-TEST-FILE scratch path by vitest.setup.ts (a single per-run path, set
    // here, was shared by every file and every worker and let one file's stub rows leak into
    // another's read — 2026-09-23); scan-cache.ts is a no-op under vitest when unset, so the
    // USER's real ~/.cache state is never touched either way. Tests needing per-test isolation
    // re-point the variable again themselves.
    env: { CORK_CONFIG_NO_FETCH: "1" },
    setupFiles: ["./vitest.setup.ts"],
  },
});
