#!/usr/bin/env bun
// Compile the single-executable release binaries (CLI + MCP in one: `ch`, `ch mcp`).
//
//   bun scripts/compile-binaries.mjs --version v0.1.0 [--commit <sha>] [--targets a,b] [--outdir dist] [--native]
//
// Invariants this script owns:
//  - FIXED asset names: bun embeds the --outfile basename as the binary's bunfs virtual path,
//    so the name is part of the reproducible digest. Independent rebuilders must use the same
//    names — which is exactly what running this same script gives them.
//  - Version/commit/target stamped via --define on process.env.CH_BUILD_* (packages/core/src/version.ts).
//  - The target's HyperSync napi binding EMBEDDED via --define on process.env.CH_HYPERSYNC_BINDING
//    (hyperSyncBindingForTarget below; packages/core/src/datasources/hypersync.ts consumes it).
//    Cross-compiling therefore needs every platform's binding on disk:
//    `bun install --frozen-lockfile --os='*' --cpu='*'` — a missing one fails the build loudly.
//  - checksums.txt in sha256sum format beside the binaries (self-update's fallback verification).
//  - `--native` (one target): no `--target=` flag, so the host bun builds for itself — how the
//    melange apk is built on wolfi with wolfi's own bun, while still getting this script's
//    define set. The asset name still comes from the named target.
//
// Runs under Bun (spawns its own runtime for `bun build`).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RELEASE_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
];

/** Must stay in lockstep with assetForTarget in packages/cli/src/self-update.ts (unit-tested). */
export function assetForTarget(target) {
  const m = /^bun-(linux|darwin|windows)-([a-z0-9-]+)$/.exec(target);
  if (!m) return null;
  const [, os, arch] = m;
  return `ch-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/**
 * The HyperSync napi binding a compiled target carries, as the platform package's `.node`
 * specifier — or null where the pinned client has no binding: Envio deprecated Windows at client
 * 1.1.0 (the 1.0.0 win32 bindings are an older Rust client, not pairable) and has never built
 * linux-arm64-musl. The binary then answers full-decentralized reads with a target-specific
 * reason. release.test.ts holds this map to the client's OWN declared platform set, so an Envio
 * platform change on upgrade is loud, not a silent null.
 *
 * Why a build-time CONSTANT and not per-target branches in source: Bun resolves `require()`
 * specifiers BEFORE dead-code elimination (verified on 1.3.14 — a dead branch naming an
 * uninstalled package fails the build), so the one require in hypersync.ts takes this constant
 * and Bun embeds exactly that file (+16–19 MB per binary; extracted to the OS temp dir and
 * dlopen'd on first load). The packages are @cork/core optionalDependencies, exact-pinned.
 */
export function hyperSyncBindingForTarget(target) {
  const m = /^bun-(linux|darwin|windows)-(x64|arm64)(-musl)?$/.exec(target);
  if (!m) return null;
  const [, os, arch, musl] = m;
  let slug = null;
  if (os === "darwin") slug = `darwin-${arch}`;
  else if (os === "linux") slug = musl ? (arch === "x64" ? "linux-x64-musl" : null) : `linux-${arch}-gnu`;
  return slug ? `@envio-dev/hypersync-client-${slug}/hypersync-client.${slug}.node` : null;
}

/** The `--define` pairs a target is compiled with: build identity plus the embedded binding. */
export function compileDefines({ version, commit, target }) {
  const binding = hyperSyncBindingForTarget(target);
  return [
    "--define", `process.env.CH_BUILD_VERSION=${JSON.stringify(version)}`,
    "--define", `process.env.CH_BUILD_COMMIT=${JSON.stringify(commit)}`,
    "--define", `process.env.CH_BUILD_TARGET=${JSON.stringify(target)}`,
    // A JS expression: the quoted specifier, or the literal `undefined` so the guarded require
    // in hypersync.ts is inert on a target without a binding.
    "--define", `process.env.CH_HYPERSYNC_BINDING=${binding ? JSON.stringify(binding) : "undefined"}`,
  ];
}

function parseArgs(argv) {
  const out = { targets: RELEASE_TARGETS, outdir: "dist", commit: "unknown", native: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") out.version = argv[++i];
    else if (a === "--commit") out.commit = argv[++i];
    else if (a === "--targets") out.targets = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--outdir") out.outdir = argv[++i];
    else if (a === "--native") out.native = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.version || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(out.version)) {
    throw new Error(`--version is required and must look like v1.2.3[-rc.N] (got: ${out.version ?? "<absent>"})`);
  }
  if (out.native && out.targets.length !== 1) {
    throw new Error(`--native builds for the host with the host bun and takes exactly one --targets value (the host's); got ${out.targets.length}`);
  }
  return out;
}

const isMain = import.meta.main ?? process.argv[1]?.endsWith("compile-binaries.mjs");
if (isMain) {
  const { version, commit, targets, outdir, native } = parseArgs(process.argv.slice(2));
  mkdirSync(outdir, { recursive: true });
  const sums = [];
  // Bindings resolve from @cork/core, the package that declares them (isolated linker: they are
  // NOT hoisted to the workspace root).
  const coreDir = join(process.cwd(), "packages/core");
  for (const target of targets) {
    const asset = assetForTarget(target);
    if (!asset) throw new Error(`unrecognized target: ${target}`);
    const binding = hyperSyncBindingForTarget(target);
    if (binding) {
      try {
        Bun.resolveSync(binding, coreDir);
      } catch {
        throw new Error(`${binding} is not installed, so the ${target} binary cannot embed its HyperSync binding — run: bun install --frozen-lockfile --os='*' --cpu='*'`);
      }
    }
    const outfile = join(outdir, asset);
    const args = [
      "build",
      "--compile",
      ...(native ? [] : [`--target=${target}`]),
      // spawnSync passes args verbatim (no shell), so each define VALUE is the bare JS
      // expression — the extra shell quoting seen in docs examples must NOT be added here.
      ...compileDefines({ version, commit, target }),
      "packages/cli/src/bin.ts",
      "--outfile", outfile,
    ];
    console.log(`compiling ${asset} (${target})`);
    const res = spawnSync("bun", args, { stdio: "inherit" });
    if (res.status !== 0) throw new Error(`bun build failed for ${target}`);
    const digest = createHash("sha256").update(readFileSync(outfile)).digest("hex");
    sums.push(`${digest}  ${asset}`);
  }
  writeFileSync(join(outdir, "checksums.txt"), `${sums.join("\n")}\n`);
  console.log(`\n${sums.join("\n")}\nwrote ${join(outdir, "checksums.txt")}`);
}
