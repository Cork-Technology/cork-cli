#!/usr/bin/env node
// Compile @cork/schemas, @cork/core, @cork/mcp to Node-runnable dist artifacts so the MCP server
// can be consumed as an installed package (Demand Agent runs @cork/mcp/dist/packages/mcp/src/bin.js).
//
// Idiomatic emit: `rewriteRelativeImportExtensions` (TS 5.7) makes tsc write `.js` import specifiers
// directly in both .js and .d.ts — no regex post-processing. JSON imports carry a source-level
// `with { type: "json" }` attribute, so the emitted ESM runs under Node without patching. Bare
// cross-package specifiers (@cork/core) are left untouched and resolve via node_modules on install.
import { cp, glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = resolve(root, "dist");
const packages = ["schemas", "core", "mcp"];

async function clean() {
  await rm(staging, { force: true, recursive: true });
  await Promise.all(packages.map((name) => rm(resolve(root, "packages", name, "dist"), { force: true, recursive: true })));
}

await clean();
if (process.argv.includes("--clean-only")) process.exit(0);

const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
const compiled = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8", stdio: "pipe" });
if (compiled.status !== 0) {
  process.stderr.write(compiled.stdout);
  process.stderr.write(compiled.stderr);
  process.exit(compiled.status ?? 1);
}

// rewriteRelativeImportExtensions rewrites .ts→.js in the .js emit, but NOT in .d.ts specifiers
// (TS 5.9). Declarations must reference the emitted .js siblings so an external TS consumer can
// resolve them — so fix up relative .ts specifiers in .d.ts only. Narrow by construction: it
// touches ONLY `from "<relative>.ts"` / `import("<relative>.ts")`, never .json or bare specifiers.
const TS_SPECIFIER = /((?:from\s+|import\()\s*["'])(\.\.?\/[^"']+)\.ts(["'])/gu;
for await (const rel of glob("**/*.d.ts", { cwd: staging })) {
  const path = resolve(staging, rel);
  const before = await readFile(path, "utf8");
  const after = before.replace(TS_SPECIFIER, "$1$2.js$3");
  if (after !== before) await writeFile(path, after);
}

// Give each package a self-contained dist subtree so it publishes independently; core also carries
// the bundled defaults its relative JSON import resolves to (../../../cork-defaults.json).
for (const name of packages) {
  const source = resolve(staging, "packages", name);
  const dest = resolve(root, "packages", name, "dist", "packages", name);
  await mkdir(dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true });
  if (name === "core") {
    await cp(resolve(root, "cork-defaults.json"), resolve(root, "packages", name, "dist", "cork-defaults.json"));
  }
}

process.stdout.write("Built @cork/schemas, @cork/core, and @cork/mcp distributables.\n");
