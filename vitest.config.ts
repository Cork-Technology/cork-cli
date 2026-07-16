import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@cork/schemas": r("packages/schemas/src/index.ts"),
      "@cork/core": r("packages/core/src/index.ts"),
      "@cork/mcp": r("packages/mcp/src/index.ts"),
      "@cork/cli": r("packages/cli/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
