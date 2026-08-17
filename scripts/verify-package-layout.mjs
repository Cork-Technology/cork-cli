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
  await access(resolve(packageRoot, manifest.main));
  await access(resolve(packageRoot, manifest.types));

  // Every exports entry — root AND subpaths — must be a conditions object whose types/import/
  // default all resolve from dist ON DISK. This is the only gate that can catch a subpath whose
  // dist twin was never emitted: tests resolve barrels from source via aliases, so an installed
  // consumer would be the first to hit ERR_PACKAGE_PATH_NOT_EXPORTED without this check.
  assert(manifest.exports?.["."], `${name}: exports must declare "."`);
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    if (subpath === "./package.json") {
      assert(entry === "./package.json", `${name}: ./package.json export must be the manifest itself`);
      continue;
    }
    assert(typeof entry === "object" && entry !== null, `${name}: exports["${subpath}"] must be a conditions object`);
    assert(Object.keys(entry)[0] === "types", `${name}: exports["${subpath}"] must list its types condition FIRST (TS reads conditions in order)`);
    for (const condition of ["types", "import", "default"]) {
      const target = entry[condition];
      assert(String(target).startsWith("./dist/"), `${name}: exports["${subpath}"].${condition} must resolve from dist`);
      await access(resolve(packageRoot, target));
    }
  }

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
