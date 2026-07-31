// `ch self-update` — explicit, verified, atomic. This tool prepares bytes people sign, so a
// binary replacement is a supply-chain event: nothing is swapped in until the downloaded bytes
// pass verification, and there is deliberately NO unprompted/background variant.
//
// Verification ladder (strongest available wins, and the output names which ran):
//   1. `gh attestation verify` — cryptographic build provenance (GitHub Sigstore): proves the
//      bytes were built by the release workflow of the canonical repo, at a specific commit.
//   2. sha256 against the release's checksums.txt — integrity only (the checksums file is an
//      immutable release asset fetched over TLS), honestly labelled as the weaker check.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILD_TARGET, BUILD_VERSION, compareVersions } from "@cork/core";
import { RELEASE_REPO } from "./update-notify.ts";

/** Release asset name for a bun compile target ("bun-linux-x64" → "ch-linux-x64"). */
export function assetForTarget(target: string): string | null {
  const m = /^bun-(linux|darwin|windows)-([a-z0-9-]+)$/.exec(target);
  if (!m) return null;
  const [, os, arch] = m;
  return `ch-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/** Parse a `sha256sum`-format checksums.txt into name → hex digest. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) out.set(m[2]!.trim(), m[1]!);
  }
  return out;
}

export interface SelfUpdateResult {
  code: number;
  out: string;
  err: string;
}

const SIGNER_WORKFLOW = `${RELEASE_REPO}/.github/workflows/build-binaries.yml`;

export async function runSelfUpdate(
  opts: { tag?: string; dryRun?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<SelfUpdateResult> {
  if (BUILD_TARGET === "" || BUILD_VERSION === "dev") {
    return {
      code: 1,
      out: "",
      err:
        "self-update only applies to a compiled release binary — this is a source run (update with `git pull`), " +
        `or an unstamped build. Releases: https://github.com/${RELEASE_REPO}/releases\n`,
    };
  }
  const asset = assetForTarget(BUILD_TARGET);
  if (!asset) {
    return { code: 1, out: "", err: `unrecognized build target "${BUILD_TARGET}" — cannot pick a release asset\n` };
  }

  // Resolve the target release.
  let tag = opts.tag;
  if (!tag) {
    const res = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ch-self-update" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { code: 1, out: "", err: `could not resolve the latest release (GitHub API ${res.status})\n` };
    tag = ((await res.json()) as { tag_name?: string }).tag_name;
    if (!tag) return { code: 1, out: "", err: "GitHub API returned no tag for the latest release\n" };
  }
  if (compareVersions(tag, BUILD_VERSION) === 0) {
    return { code: 0, out: `already up to date (${BUILD_VERSION})\n`, err: "" };
  }

  const binPath = process.execPath;
  const dir = dirname(binPath);
  try {
    accessSync(dir, constants.W_OK);
    accessSync(binPath, constants.W_OK);
  } catch {
    return {
      code: 1,
      out: "",
      err:
        `cannot write ${binPath} — this install location is not writable (package-manager managed?). ` +
        "Update through the tool that installed ch (mise/apk/container tag), or re-run with sufficient permissions.\n",
    };
  }
  if (opts.dryRun) {
    return { code: 0, out: `would update ${BUILD_VERSION} -> ${tag} (asset ${asset}, install path ${binPath})\n`, err: "" };
  }

  // Download beside the current binary so the final rename is atomic (same filesystem).
  const assetUrl = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${asset}`;
  const tmp = join(dir, `.ch-update-${process.pid}`);
  const dl = await fetchImpl(assetUrl, { signal: AbortSignal.timeout(300_000) });
  if (!dl.ok) return { code: 1, out: "", err: `download failed (${dl.status}) for ${assetUrl}\n` };
  const bytes = new Uint8Array(await dl.arrayBuffer());
  writeFileSync(tmp, bytes);

  // Verify BEFORE swap.
  let verification: string;
  const gh = spawnSync("gh", ["--version"], { stdio: "ignore" });
  if (gh.status === 0) {
    const v = spawnSync(
      "gh",
      ["attestation", "verify", tmp, "--repo", RELEASE_REPO, "--signer-workflow", SIGNER_WORKFLOW],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (v.status !== 0) {
      rmSync(tmp, { force: true });
      return {
        code: 1,
        out: "",
        err: `ATTESTATION VERIFICATION FAILED for ${asset}@${tag} — the downloaded bytes were discarded, nothing was changed.\n${(v.stderr || v.stdout || "").trim()}\n`,
      };
    }
    verification = "GitHub build-provenance attestation (gh attestation verify)";
  } else {
    const sumsRes = await fetchImpl(`https://github.com/${RELEASE_REPO}/releases/download/${tag}/checksums.txt`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!sumsRes.ok) {
      rmSync(tmp, { force: true });
      return { code: 1, out: "", err: `could not fetch checksums.txt for ${tag} (${sumsRes.status}) and \`gh\` is not installed — refusing to update unverified bytes\n` };
    }
    const expected = parseChecksums(await sumsRes.text()).get(asset);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!expected || expected !== actual) {
      rmSync(tmp, { force: true });
      return {
        code: 1,
        out: "",
        err: `CHECKSUM MISMATCH for ${asset}@${tag} (expected ${expected ?? "<absent>"}, got ${actual}) — the downloaded bytes were discarded, nothing was changed.\n`,
      };
    }
    verification = "sha256 vs release checksums.txt (integrity only — install `gh` for cryptographic provenance verification)";
  }

  // Atomic swap: the rename dance also works on Windows for a running executable.
  chmodSync(tmp, 0o755);
  const old = `${binPath}.old`;
  rmSync(old, { force: true });
  renameSync(binPath, old);
  try {
    renameSync(tmp, binPath);
  } catch (e) {
    renameSync(old, binPath); // restore; leave nothing half-swapped
    rmSync(tmp, { force: true });
    return { code: 1, out: "", err: `swap failed (${(e as Error).message}) — previous binary restored\n` };
  }
  try {
    rmSync(old, { force: true }); // on Windows the running image may be locked; harmless leftover
  } catch {
    /* ignore */
  }

  return {
    code: 0,
    out: `updated ${BUILD_VERSION} -> ${tag}\n  binary    ${binPath}\n  verified  ${verification}\n`,
    err: "",
  };
}
