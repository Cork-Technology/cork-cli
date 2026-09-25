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
    // CORK_CONFIG_NO_OVERRIDE: the private tree carries its own `config.json` at the repo root (the
    // operator override, config-override.ts); the hermetic suite must never read it — override
    // tests inject `loadOverride` through ConfigDeps.
    env: { CORK_CONFIG_NO_FETCH: "1", CORK_CONFIG_NO_OVERRIDE: "1" },
    setupFiles: ["./vitest.setup.ts"],
    // The suite must run where only Bun is installed. With no `node` on PATH, vitest itself runs
    // on Bun, and Bun answers `"__esModule" in <ESM namespace>` with true (Node: false) although
    // no such property exists. vite-node's default interop reads that as "CJS module" and
    // replaces an external module with its `default` export — zod's default is its inner
    // namespace, so `import { z } from "zod"` came back undefined and most files failed to load
    // (2026-09-23: a Node-less host ran the whole mutation catalogue in 9 minutes, every
    // load failure counted "caught"). The suite needs none of that interop (green on Bun AND
    // Node with it off); if a CJS-only dependency imported by NAME ever reads undefined in a
    // test, import its default export instead. No vitest before 5 fixes this on Bun (3.2.7,
    // 4.0.18, 4.1.11 all fail; 5.0.1 passes).
    deps: { interopDefault: false },
  },
});
