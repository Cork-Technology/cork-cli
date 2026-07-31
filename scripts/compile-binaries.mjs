#!/usr/bin/env bun
// Compile the single-executable release binaries (CLI + MCP in one: `ch`, `ch mcp`).
//
//   bun scripts/compile-binaries.mjs --version v0.1.0 [--commit <sha>] [--targets a,b] [--outdir dist]
//
// Invariants this script owns:
//  - FIXED asset names: bun embeds the --outfile basename as the binary's bunfs virtual path,
//    so the name is part of the reproducible digest. Independent rebuilders must use the same
//    names — which is exactly what running this same script gives them.
//  - Version/commit/target stamped via --define on process.env.CH_BUILD_* (packages/core/src/version.ts).
//  - checksums.txt in sha256sum format beside the binaries (self-update's fallback verification).
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

function parseArgs(argv) {
  const out = { targets: RELEASE_TARGETS, outdir: "dist", commit: "unknown" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") out.version = argv[++i];
    else if (a === "--commit") out.commit = argv[++i];
    else if (a === "--targets") out.targets = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--outdir") out.outdir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.version || !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(out.version)) {
    throw new Error(`--version is required and must look like v1.2.3[-rc.N] (got: ${out.version ?? "<absent>"})`);
  }
  return out;
}

const isMain = import.meta.main ?? process.argv[1]?.endsWith("compile-binaries.mjs");
if (isMain) {
  const { version, commit, targets, outdir } = parseArgs(process.argv.slice(2));
  mkdirSync(outdir, { recursive: true });
  const sums = [];
  for (const target of targets) {
    const asset = assetForTarget(target);
    if (!asset) throw new Error(`unrecognized target: ${target}`);
    const outfile = join(outdir, asset);
    const args = [
      "build",
      "--compile",
      `--target=${target}`,
      // spawnSync passes args verbatim (no shell), so the define VALUE is the bare JS string
      // literal — the extra shell quoting seen in docs examples must NOT be added here.
      "--define", `process.env.CH_BUILD_VERSION=${JSON.stringify(version)}`,
      "--define", `process.env.CH_BUILD_COMMIT=${JSON.stringify(commit)}`,
      "--define", `process.env.CH_BUILD_TARGET=${JSON.stringify(target)}`,
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
