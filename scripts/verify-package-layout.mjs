#!/usr/bin/env node
// CI gate for the compiled packages: assert each @cork/* package publishes a Node-runnable,
// dist-only layout with declarations and no raw TypeScript leakage. Run after build-packages.mjs.
import { access, glob, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["schemas", "core", "mcp"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const name of names) {
  const packageRoot = resolve(root, "packages", name);
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  assert(manifest.name === `@cork/${name}`, `${name}: package identity drifted`);
  assert(manifest.private === false, `${name}: package is still private (cannot publish)`);
  assert(manifest.publishConfig?.access === "restricted", `${name}: publication must be restricted`);
  assert(Array.isArray(manifest.files) && manifest.files.length === 1 && manifest.files[0] === "dist", `${name}: files allowlist must be exactly ["dist"]`);
  assert(String(manifest.main).startsWith("./dist/"), `${name}: main must resolve from dist`);
  assert(String(manifest.types).startsWith("./dist/"), `${name}: types must resolve from dist`);
  assert(String(manifest.exports?.["."]?.import).startsWith("./dist/"), `${name}: import export must resolve from dist`);
  assert(String(manifest.exports?.["."]?.types).startsWith("./dist/"), `${name}: type export must resolve from dist`);
  await access(resolve(packageRoot, manifest.main));
  await access(resolve(packageRoot, manifest.types));

  const files = [];
  for await (const file of glob("dist/**/*", { cwd: packageRoot })) files.push(file);
  assert(files.some((f) => f.endsWith(".js")), `${name}: no compiled JavaScript emitted`);
  assert(files.some((f) => f.endsWith(".d.ts")), `${name}: no declarations emitted`);
  assert(!files.some((f) => extname(f) === ".ts" && !f.endsWith(".d.ts")), `${name}: raw TypeScript leaked into dist`);
  // rewriteRelativeImportExtensions must have rewritten every relative .ts specifier to .js.
  for (const file of files.filter((f) => f.endsWith(".d.ts"))) {
    const declaration = await readFile(resolve(packageRoot, file), "utf8");
    assert(!/from\s+["']\.\.?\/[^"']+\.ts["']/u.test(declaration), `${name}: ${file} retains a source-only .ts import specifier`);
  }
}

const mcp = JSON.parse(await readFile(resolve(root, "packages/mcp/package.json"), "utf8"));
assert(String(mcp.bin?.["cork-mcp"]).startsWith("./dist/"), "mcp: cork-mcp bin must resolve from dist");
await access(resolve(root, "packages/mcp", mcp.bin["cork-mcp"]));
await access(resolve(root, "packages/core/dist/cork-defaults.json"));

process.stdout.write("Verified compiled package layouts (dist-only, declarations present, no raw .ts).\n");
