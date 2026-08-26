// `ch self-update` — explicit, verified, atomic. This tool prepares bytes people sign, so a
// binary replacement is a supply-chain event: nothing is swapped in until the downloaded bytes
// pass verification, and there is deliberately NO unprompted/background variant.
//
// Verification ladder (strongest available wins, and the output names which ran):
//   1. `gh attestation verify` — cryptographic build provenance (GitHub Sigstore): proves the
//      bytes were built by the release workflow of the canonical repo, at a specific commit.
//   2. sha256 against the release's checksums.txt — integrity only (the checksums file is an
//      immutable release asset fetched over TLS), honestly labelled as the weaker check.
// Both paths then run the STAGED binary's own offline `version --json` and require its embedded
// version, commit and target to match the release we resolved, before the swap (audit
// SUPPLY-004): provenance says "this artifact came from our workflow", identity says "and it is
// the build we just asked for" — anyone who can write a release asset can otherwise serve a
// genuine-but-different one. The tag is peeled to its commit first, so the attestation binds to
// the source the release claims, not merely to the repository.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
const GITHUB_HEADERS = { accept: "application/vnd.github+json", "user-agent": "ch-self-update" } as const;
/** An annotated tag points at a tag object; peel until a commit. Bounded so a cycle cannot spin. */
const MAX_TAG_PEELS = 5;
/** How long the staged binary gets to answer `version --json` before it is killed and discarded. */
const IDENTITY_TIMEOUT_MS = 5_000;
/** …and how much it may write. A staged artifact that streams is not answering the question. */
const MAX_IDENTITY_BYTES = 64 * 1024;

type GitObject = { type: string; sha: string };

async function githubJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  try {
    const value: unknown = await res.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { error: "malformed JSON" };
  } catch {
    return { error: "malformed JSON" };
  }
}

function gitObject(value: unknown): GitObject | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  return typeof o.type === "string" && typeof o.sha === "string" && /^[0-9a-f]{40}$/.test(o.sha) ? { type: o.type, sha: o.sha } : null;
}

/** Resolve a release tag to the IMMUTABLE commit it names, peeling annotated tag objects. */
export async function resolveTagCommit(tag: string, fetchImpl: typeof fetch): Promise<{ commit: string; sourceRef: string } | { error: string }> {
  const sourceRef = `refs/tags/${tag}`;
  const ref = await githubJson(`https://api.github.com/repos/${RELEASE_REPO}/git/ref/tags/${encodeURIComponent(tag)}`, fetchImpl);
  if ("error" in ref) return { error: `could not resolve tag ${tag} (${ref.error})` };
  if (ref.ref !== sourceRef) return { error: `could not resolve tag ${tag}: GitHub answered for ref ${String(ref.ref)}` };
  let object = gitObject(ref.object);
  if (!object) return { error: `could not resolve tag ${tag}: malformed ref object` };
  for (let peels = 0; object.type === "tag"; peels++) {
    if (peels >= MAX_TAG_PEELS) return { error: `could not resolve tag ${tag}: more than ${MAX_TAG_PEELS} annotated-tag hops` };
    const annotated = await githubJson(`https://api.github.com/repos/${RELEASE_REPO}/git/tags/${object.sha}`, fetchImpl);
    if ("error" in annotated) return { error: `could not peel tag ${tag} (${annotated.error})` };
    object = gitObject(annotated.object);
    if (!object) return { error: `could not peel tag ${tag}: malformed tag object` };
  }
  if (object.type !== "commit") return { error: `tag ${tag} does not resolve to a commit (got ${object.type})` };
  return { commit: object.sha, sourceRef };
}

/** Environment for the staged binary's identity run: an empty search path so it cannot reach any
 *  helper, no proxy, no update notifier. Windows needs a few vars just to start a process. */
function identityEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "", CI: "1", CORK_NO_UPDATE_NOTIFIER: "1", NO_PROXY: "*", no_proxy: "*" };
  for (const name of ["SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP"] as const) {
    const v = process.env[name];
    if (v) env[name] = v;
  }
  return env;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", timeout: 5_000 });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the whole group: a staged binary may have spawned children
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone between the bound and the kill */
    }
  }
}

/** Run the STAGED binary's own `version --json` offline and require it to be the build we
 *  resolved. Bounded in time and output; the process tree is killed on either bound. */
export async function verifyStagedIdentity(
  path: string,
  expected: { version: string; commit: string; target: string },
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let tooMuchOutput = false;
  const child = spawn(path, ["version", "--json"], { detached: process.platform !== "win32", env: identityEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const append = (cur: string, chunk: Buffer): string => {
    const next = cur + chunk.toString("utf8");
    if (Buffer.byteLength(next) > MAX_IDENTITY_BYTES) {
      tooMuchOutput = true;
      killTree(child.pid);
      return next.slice(0, MAX_IDENTITY_BYTES);
    }
    return next;
  };
  child.stdout.on("data", (c: Buffer) => {
    stdout = append(stdout, c);
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr = append(stderr, c);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, timeoutMs);
  let code: number | null;
  try {
    [code] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: `the staged binary could not be run (${(err as Error).message})` };
  }
  clearTimeout(timer);
  if (timedOut) return { ok: false, error: `the staged binary did not answer version --json within ${timeoutMs}ms` };
  if (tooMuchOutput) return { ok: false, error: "the staged binary wrote more than 64 KiB answering version --json" };
  if (code !== 0) return { ok: false, error: `the staged binary exited ${code ?? "on a signal"} for version --json${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "the staged binary did not answer version --json with JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "the staged binary did not answer version --json with an object" };
  }
  const identity = parsed as Record<string, unknown>;
  for (const field of ["version", "commit", "target"] as const) {
    if (identity[field] !== expected[field]) {
      return { ok: false, error: `the staged binary reports ${field} ${String(identity[field])}, not the ${expected[field]} we resolved` };
    }
  }
  return { ok: true };
}

/** Delete the staged bytes and report why nothing changed. */
function discard(tmp: string, error: string): SelfUpdateResult {
  rmSync(tmp, { force: true });
  return { code: 1, out: "", err: `${error} — the downloaded bytes were discarded, nothing was changed.\n` };
}

export async function runSelfUpdate(
  opts: { tag?: string; dryRun?: boolean; allowDowngrade?: boolean },
  fetchImpl: typeof fetch = fetch,
  deps: { identityTimeoutMs?: number } = {},
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
    const latest = await githubJson(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, fetchImpl);
    if ("error" in latest) return { code: 1, out: "", err: `could not resolve the latest release (${latest.error})\n` };
    tag = typeof latest.tag_name === "string" ? latest.tag_name : undefined;
    if (!tag) return { code: 1, out: "", err: "GitHub API returned no tag for the latest release\n" };
  }
  const order = compareVersions(tag, BUILD_VERSION);
  if (order === 0) {
    return { code: 0, out: `already up to date (${BUILD_VERSION})\n`, err: "" };
  }
  // A downgrade is a supply-chain event in its own right: an OLDER release is authentic, so
  // every verification below passes, while re-introducing whatever was fixed since (audit
  // SUPPLY-003). Automatic resolution must never do it; an operator who means it says so.
  if (order < 0 && opts.allowDowngrade !== true) {
    return {
      code: 1,
      out: "",
      err:
        `refusing to downgrade ${BUILD_VERSION} -> ${tag}: an older release verifies exactly like a newer one, so nothing downstream would catch it. `
        + "Re-run with --allow-downgrade if you mean to roll back deliberately.\n",
    };
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

  // The tag names a commit; resolve it BEFORE downloading so the attestation can be bound to
  // the source the release claims rather than to the repository at large.
  const resolution = await resolveTagCommit(tag, fetchImpl);
  if ("error" in resolution) return { code: 1, out: "", err: `${resolution.error}\n` };

  // Download beside the current binary so the final rename is atomic (same filesystem).
  const assetUrl = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${asset}`;
  const tmp = join(dir, `.ch-update-${process.pid}`);
  let dl: Response;
  try {
    dl = await fetchImpl(assetUrl, { signal: AbortSignal.timeout(300_000) });
  } catch (err) {
    return { code: 1, out: "", err: `download failed for ${assetUrl} (${(err as Error).message})\n` };
  }
  if (!dl.ok) return { code: 1, out: "", err: `download failed (${dl.status}) for ${assetUrl}\n` };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await dl.arrayBuffer());
  } catch (err) {
    return { code: 1, out: "", err: `download failed for ${assetUrl} (${(err as Error).message})\n` };
  }
  rmSync(tmp, { force: true }); // a leftover from an interrupted run must not be swapped in
  writeFileSync(tmp, bytes);

  // Verify BEFORE swap.
  let verification: string;
  const gh = spawnSync("gh", ["--version"], { stdio: "ignore" });
  if (gh.status === 0) {
    const v = spawnSync(
      "gh",
      [
        "attestation",
        "verify",
        tmp,
        "--repo",
        RELEASE_REPO,
        "--signer-workflow",
        SIGNER_WORKFLOW,
        // Bind to the SOURCE this release claims, not merely to the repo: without these an
        // attestation for any commit of any workflow run in the repo would satisfy the check.
        "--source-digest",
        resolution.commit,
        "--source-ref",
        resolution.sourceRef,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (v.status !== 0) {
      return discard(tmp, `ATTESTATION VERIFICATION FAILED for ${asset}@${tag}\n${(v.stderr || v.stdout || "").trim()}`);
    }
    verification = "GitHub build-provenance attestation (repo + workflow, bound to the peeled tag commit and ref)";
  } else {
    const sumsRes = await fetchImpl(`https://github.com/${RELEASE_REPO}/releases/download/${tag}/checksums.txt`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!sumsRes.ok) {
      return discard(tmp, `could not fetch checksums.txt for ${tag} (${sumsRes.status}) and \`gh\` is not installed — refusing to update unverified bytes`);
    }
    const expected = parseChecksums(await sumsRes.text()).get(asset);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!expected || expected !== actual) {
      return discard(tmp, `CHECKSUM MISMATCH for ${asset}@${tag} (expected ${expected ?? "<absent>"}, got ${actual})`);
    }
    verification = "sha256 vs release checksums.txt (integrity only — install `gh` for cryptographic provenance verification)";
  }

  chmodSync(tmp, 0o755);
  // Provenance proved where the bytes came FROM; identity proves they are the build we asked
  // for. Run the staged binary's own offline `version --json` and compare (audit SUPPLY-004).
  const identity = await verifyStagedIdentity(tmp, { version: tag, commit: resolution.commit, target: BUILD_TARGET }, deps.identityTimeoutMs);
  if (!identity.ok) return discard(tmp, identity.error);
  verification += `; staged identity matched ${tag}@${resolution.commit} (${BUILD_TARGET})`;

  // Atomic swap: the rename dance also works on Windows for a running executable.
  const old = `${binPath}.old`;
  rmSync(old, { force: true });
  try {
    renameSync(binPath, old);
  } catch (e) {
    // First rename failed — the binary is untouched, but the verified download must not linger.
    rmSync(tmp, { force: true });
    return { code: 1, out: "", err: `swap failed (${(e as Error).message}) — binary untouched\n` };
  }
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
