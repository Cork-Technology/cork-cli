// SDK API-surface drift gate — the library twin of the MCP tool-surface gate
// (packages/mcp/test/surface-drift.test.ts). The published @cork/core surface is every export
// name reachable from the root barrel and each subpath barrel. That surface is a versioning
// contract once the package is on a registry: an accidental removal breaks integrators, and an
// accidental addition silently widens what the next release must keep supporting. So the whole
// surface — value AND type exports, extracted with the TypeScript compiler API, not runtime
// Object.keys (which cannot see `export type`) — is snapshotted to a committed fixture. Any
// diff fails CI until the fixture is regenerated deliberately.
//
// Regenerate after an intentional change:
//   UPDATE_API_SURFACE=1 bunx vitest run packages/core/test/api-surface.test.ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const FIXTURE = join(import.meta.dirname, "fixtures", "api-surface.json");

/** Subpath → source entry file. This list, package.json's exports map, the files on disk under
 *  src/exports/, and the fixture must all agree — the parity tests below pin every pairing. */
const ENTRIES: Record<string, string> = {
  ".": "src/index.ts",
  "./bundle": "src/exports/bundle.ts",
  "./chain": "src/exports/chain.ts",
  "./config": "src/exports/config.ts",
  "./indexer": "src/exports/indexer.ts",
  "./math": "src/exports/math.ts",
  "./orders": "src/exports/orders.ts",
  "./registry": "src/exports/registry.ts",
  "./venue": "src/exports/venue.ts",
};

interface SurfaceExport {
  name: string;
  /** "value", "type", or "value+type" (e.g. a class, or a const + same-named type). */
  kind: string;
}
type Surface = Record<string, SurfaceExport[]>;

function extractSurface(): Surface {
  const configFile = ts.readConfigFile(join(repoRoot, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const roots = Object.values(ENTRIES).map((p) => join(packageRoot, p));
  const program = ts.createProgram(roots, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  const surface: Surface = {};
  for (const [subpath, rel] of Object.entries(ENTRIES)) {
    const sourceFile = program.getSourceFile(join(packageRoot, rel));
    if (!sourceFile) throw new Error(`entry not in program: ${rel}`);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`entry has no module symbol (no exports?): ${rel}`);
    surface[subpath] = checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => {
        const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const isValue = (resolved.flags & ts.SymbolFlags.Value) !== 0;
        const isType = (resolved.flags & ts.SymbolFlags.Type) !== 0;
        return { name: symbol.name, kind: isValue && isType ? "value+type" : isValue ? "value" : "type" };
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  return surface;
}

// One program build (~seconds) shared across the tests in this file.
let memo: Surface | undefined;
const currentSurface = () => (memo ??= extractSurface());

describe("exports-map parity (offline — kills a package.json drift without a build)", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports: Record<string, string | Record<string, string>>;
  };

  it("package.json exports keys are exactly the entry list (+ ./package.json)", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([...Object.keys(ENTRIES), "./package.json"].sort());
  });

  it("every subpath's dist paths point at the compiled twin of its source entry", () => {
    for (const [subpath, rel] of Object.entries(ENTRIES)) {
      const entry = manifest.exports[subpath];
      expect(entry, subpath).toBeTypeOf("object");
      const conditions = entry as Record<string, string>;
      const base = `./dist/packages/core/${rel.slice(0, -3)}`; // strip .ts
      expect(Object.keys(conditions)[0], `${subpath}: the types condition must come first`).toBe("types");
      expect(conditions.types).toBe(`${base}.d.ts`);
      expect(conditions.import).toBe(`${base}.js`);
      expect(conditions.default).toBe(`${base}.js`);
    }
  });

  it("every barrel file under src/exports/ is a declared subpath (no orphan tiers)", () => {
    const onDisk = readdirSync(join(packageRoot, "src/exports")).filter((f) => f.endsWith(".ts"));
    const declared = Object.values(ENTRIES)
      .filter((p) => p.startsWith("src/exports/"))
      .map((p) => p.slice("src/exports/".length));
    expect(onDisk.sort()).toEqual(declared.sort());
  });
});

describe("API-surface drift gate", () => {
  it("public surface matches the committed fixture (or UPDATE_API_SURFACE=1 to regenerate)", () => {
    const surface = currentSurface();

    if (process.env.UPDATE_API_SURFACE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(surface, null, 2) + "\n");
      expect(Object.keys(surface)).toEqual(Object.keys(ENTRIES));
      return; // fixture (re)generated deliberately — record and pass
    }

    const committed = JSON.parse(readFileSync(FIXTURE, "utf8")) as Surface;
    const deltas: string[] = [];
    for (const subpath of new Set([...Object.keys(committed), ...Object.keys(surface)])) {
      const before = new Map((committed[subpath] ?? []).map((e) => [e.name, e.kind]));
      const after = new Map((surface[subpath] ?? []).map((e) => [e.name, e.kind]));
      for (const [name, kind] of after) {
        if (!before.has(name)) deltas.push(`+ ${subpath} ${name} (${kind})`);
        else if (before.get(name) !== kind) deltas.push(`~ ${subpath} ${name} (${before.get(name)} → ${kind})`);
      }
      for (const name of before.keys()) if (!after.has(name)) deltas.push(`- ${subpath} ${name}`);
    }
    const guidance =
      `The public @cork/core API surface changed (${deltas.length} delta${deltas.length === 1 ? "" : "s"}): ` +
      `${deltas.slice(0, 15).join("; ")}${deltas.length > 15 ? "; …" : ""}. ` +
      `A removal or kind change breaks published consumers (minor bump below 1.0.0, policy R10); an addition widens the covered surface. ` +
      `If intentional, note it in CHANGELOG.md and regenerate: UPDATE_API_SURFACE=1 bunx vitest run packages/core/test/api-surface.test.ts`;
    expect(surface, guidance).toEqual(committed);
  });

  it("internal machinery stays off every public entry", () => {
    // The modules deliberately cut from the barrel (index.ts header). If one of these names
    // reappears, an internal module leaked back into the public surface.
    const internalNames = ["breakerOnFailure", "breakerOpen", "atomicWriteFileSync"];
    for (const [subpath, exports] of Object.entries(currentSurface())) {
      const names = new Set(exports.map((e) => e.name));
      for (const internal of internalNames) {
        expect(names.has(internal), `${internal} leaked onto ${subpath}`).toBe(false);
      }
    }
  });

  it("the root is a superset of every tier (fat-root contract)", () => {
    const surface = currentSurface();
    const root = new Set((surface["."] ?? []).map((e) => e.name));
    for (const [subpath, exports] of Object.entries(surface)) {
      if (subpath === ".") continue;
      for (const e of exports) {
        expect(root.has(e.name), `${subpath} exports ${e.name} but the root barrel does not`).toBe(true);
      }
    }
  });

  it("the envelope is importable from the root", () => {
    const root = new Set((currentSurface()["."] ?? []).map((e) => e.name));
    for (const name of ["runTool", "ToolInputError", "HandlerContext", "BUILD_VERSION"]) {
      expect(root.has(name), `root barrel lost ${name}`).toBe(true);
    }
  });
});
