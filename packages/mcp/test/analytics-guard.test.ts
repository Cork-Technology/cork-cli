// The lint guard for tracking (the repo's equivalent of a `no-restricted-imports` rule — it has no
// ESLint; its gates are tests). It holds the analytics code shape:
//   - NO PostHog SDK anywhere: not in a manifest, not in the lockfile, not imported by any source.
//     The CLI (`ch`, public mirror cork-cli) ships no telemetry; the hosted server reaches PostHog
//     through the tracking files in packages/mcp/src/lib/ (the core analytics.ts,
//     scrub.ts, telemetry-env.ts, log-export.ts, analytics-catalog.ts; the event transport
//     posthog-http.ts; the MCP layer
//     mcp-analytics.ts) over the public ingestion endpoints.
//   - Only the hosted HTTP path loads them, through lib/mcp-analytics.ts alone:
//     packages/mcp/src/http.ts and the `--http` branch of packages/cli/src/bin.ts. The other
//     tracking files are imported only by each other.
//   - http.ts (which constructs the per-request analytics hooks) is reached only by that same
//     `--http` branch and by the package index (packages/mcp/src/index.ts, `@cork/mcp`), which no
//     shipped source imports.
//   - The stdio MCP bundle does not contain it at all; the `ch` bundle contains no SDK.
//   - packages/mcp/test/analytics-runtime.test.ts runs the real binary with every analytics
//     setting present and observes that only `ch mcp --http` sends.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SDK = /(^|["'/])(posthog-node|posthog-js|posthog-react-native|@posthog\/[a-z-]+)(["'/]|$)/u;
const LIB = "packages/mcp/src/lib";
const TRACKING_FILES = ["analytics.ts", "analytics-catalog.ts", "telemetry-env.ts", "log-export.ts", "scrub.ts", "posthog-http.ts", "mcp-analytics.ts"].map((f) => `${LIB}/${f}`);
const ENTRY = `${LIB}/mcp-analytics.ts`;
const ALLOWED_IMPORTERS = ["packages/cli/src/bin.ts", "packages/mcp/src/http.ts"];
/** The one file that names the ingestion host: the env contract's default. */
const HOST_FILE = `${LIB}/telemetry-env.ts`;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js|mjs|cjs)$/u.test(name)) out.push(p);
  }
  return out;
}

const SOURCE_DIRS = ["packages/schemas/src", "packages/core/src", "packages/mcp/src", "packages/cli/src", "scripts", "evals", "bin"];
const sources = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d))).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }));
const specifiers = (text: string): string[] => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gmu)].map((m) => m[1]!);
/** The repo path a relative specifier names (`.js` read as the `.ts` source), or the bare specifier. */
const target = (from: string, spec: string): string => {
  if (!spec.startsWith(".")) return spec;
  const p = relative(ROOT, join(ROOT, dirname(from), spec)).replace(/\.js$/u, ".ts");
  return /\.[cm]?[jt]s$/u.test(p) ? p : `${p}.ts`;
};

describe("no PostHog SDK can reach the CLI", () => {
  it("no package manifest declares a PostHog package, and the lockfile carries none", () => {
    const manifests = ["package.json", ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/package.json`)];
    for (const m of manifests) {
      const pkg = JSON.parse(readFileSync(join(ROOT, m), "utf8")) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const name of Object.keys(pkg[field] ?? {})) expect(SDK.test(`"${name}"`), `${m} ${field} declares ${name}`).toBe(false);
      }
    }
    expect(readFileSync(join(ROOT, "bun.lock"), "utf8")).not.toMatch(/"(posthog-node|posthog-js|@posthog\/[a-z-]+)"/u);
  });

  it("no source imports a PostHog package", () => {
    const offenders = sources.flatMap((s) => specifiers(s.text).filter((spec) => SDK.test(`"${spec}"`)).map((spec) => `${s.path} → ${spec}`));
    expect(offenders).toEqual([]);
  });

  it("only the hosted HTTP path imports the tracking files, and only through lib/mcp-analytics.ts", () => {
    const outside = sources.filter((s) => !TRACKING_FILES.includes(s.path));
    const importers = (file: string) => outside.filter((s) => specifiers(s.text).some((spec) => target(s.path, spec) === file)).map((s) => s.path).sort();
    expect(importers(ENTRY)).toEqual(ALLOWED_IMPORTERS);
    for (const f of TRACKING_FILES.filter((f) => f !== ENTRY)) expect(importers(f), f).toEqual([]);
  });

  it("only the hosted entry reaches http.ts, directly or through the @cork/mcp index", () => {
    const importersOf = (wanted: (t: string) => boolean): string[] => sources.filter((s) => specifiers(s.text).some((spec) => wanted(target(s.path, spec)))).map((s) => s.path).sort();
    expect(importersOf((t) => t === "packages/mcp/src/http.ts")).toEqual(["packages/cli/src/bin.ts", "packages/mcp/src/index.ts"]);
    expect(importersOf((t) => t === "packages/mcp/src/index.ts" || t === "@cork/mcp" || t.startsWith("@cork/mcp/"))).toEqual([]);
  });

  it("only the env contract (lib/telemetry-env.ts) names a PostHog ingestion host", () => {
    const naming = sources.filter((s) => /posthog\.com/iu.test(s.text)).map((s) => s.path);
    expect(naming).toEqual([HOST_FILE]);
  });

  it("bundles: the stdio MCP server contains no analytics code; the ch binary contains no SDK", () => {
    const out = mkdtempSync(join(tmpdir(), "cork-analytics-guard-"));
    try {
      const build = (entry: string, dir: string): string => {
        const res = spawnSync("bun", ["build", entry, "--target=bun", "--outdir", join(out, dir)], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
        expect(res.status, res.stderr).toBe(0);
        return readdirSync(join(out, dir)).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, dir, f), "utf8")).join("\n");
      };
      const stdio = build("packages/mcp/src/bin.ts", "stdio");
      for (const marker of ["$mcp_tool_call", "/i/v1/logs", "posthog"]) expect(stdio.includes(marker), `stdio bundle contains ${marker}`).toBe(false);
      const ch = build("packages/cli/src/bin.ts", "ch");
      expect(ch).not.toMatch(/posthog-node|posthog-js|@posthog\//u);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
