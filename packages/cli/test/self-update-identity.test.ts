// `ch self-update` supply-chain gates (audit SUPPLY-003 + SUPPLY-004, 2026-08-24).
//
// Provenance answers "did these bytes come from our workflow"; it does NOT answer "are these the
// bytes for the release I just resolved" — anyone who can write a release asset can serve a
// genuine-but-different one, and an OLDER release verifies exactly like a newer one. So:
//   * an automatically-resolved older tag is refused, and an explicit one needs --allow-downgrade;
//   * the tag is peeled to its commit, and the attestation is bound to that commit and ref;
//   * the STAGED binary must answer its own `version --json` with the version/commit/target we
//     resolved, offline and bounded, before the swap.
// The staged "binary" here is a REAL executable script, run as a real child process: the identity
// gate's whole job is to execute the artifact, so mocking that away would test nothing.
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTagCommit, verifyStagedIdentity } from "../src/self-update.ts";

const COMMIT = "a".repeat(40);
const TAG = "v9.9.9";

/** Write an executable shell script and return its path — a stand-in release artifact. */
function stagedBinary(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "staged-"));
  const path = join(dir, "ch");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const identityJson = (over: Record<string, string> = {}) =>
  JSON.stringify({ version: TAG, commit: COMMIT, target: "bun-linux-arm64", ...over });

/** A fetch that answers a fixed URL→body map and records what was asked. */
function githubStub(routes: Record<string, unknown>, asked: string[] = []): typeof fetch {
  return (async (url: string) => {
    asked.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    const body = routes[key];
    return body instanceof Response ? body.clone() : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("resolveTagCommit: a tag names an immutable commit", () => {
  it("a lightweight tag resolves in one call", async () => {
    const asked: string[] = [];
    const out = await resolveTagCommit(TAG, githubStub({ "/git/ref/tags/": { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: COMMIT } } }, asked));
    expect(out).toEqual({ commit: COMMIT, sourceRef: `refs/tags/${TAG}` });
    expect(asked).toHaveLength(1);
  });

  it("an ANNOTATED tag is peeled to the commit behind its tag object", async () => {
    const tagObject = "b".repeat(40);
    const out = await resolveTagCommit(TAG, githubStub({
      "/git/ref/tags/": { ref: `refs/tags/${TAG}`, object: { type: "tag", sha: tagObject } },
      [`/git/tags/${tagObject}`]: { object: { type: "commit", sha: COMMIT } },
    }));
    expect(out).toEqual({ commit: COMMIT, sourceRef: `refs/tags/${TAG}` });
  });

  it("refuses a peel cycle rather than spinning", async () => {
    const self = "c".repeat(40);
    const out = await resolveTagCommit(TAG, githubStub({
      "/git/ref/tags/": { ref: `refs/tags/${TAG}`, object: { type: "tag", sha: self } },
      "/git/tags/": { object: { type: "tag", sha: self } }, // points at itself, forever
    }));
    expect(out).toMatchObject({ error: expect.stringContaining("annotated-tag hops") });
  });

  it("refuses an answer for a DIFFERENT ref, a malformed object, and a non-commit terminal object", async () => {
    const wrongRef = await resolveTagCommit(TAG, githubStub({ "/git/ref/tags/": { ref: "refs/tags/v0.0.1", object: { type: "commit", sha: COMMIT } } }));
    expect(wrongRef).toMatchObject({ error: expect.stringContaining("answered for ref") });
    const malformed = await resolveTagCommit(TAG, githubStub({ "/git/ref/tags/": { ref: `refs/tags/${TAG}`, object: { type: "commit", sha: "not-a-sha" } } }));
    expect(malformed).toMatchObject({ error: expect.stringContaining("malformed ref object") });
    const blob = await resolveTagCommit(TAG, githubStub({ "/git/ref/tags/": { ref: `refs/tags/${TAG}`, object: { type: "blob", sha: COMMIT } } }));
    expect(blob).toMatchObject({ error: expect.stringContaining("does not resolve to a commit") });
  });

  it("reports a transport failure instead of throwing", async () => {
    const out = await resolveTagCommit(TAG, (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch);
    expect(out).toMatchObject({ error: expect.stringContaining("connection refused") });
  });
});

describe("verifyStagedIdentity: the artifact must BE the build we resolved", () => {
  const expected = { version: TAG, commit: COMMIT, target: "bun-linux-arm64" };

  it("accepts a staged binary whose own version --json matches", async () => {
    const bin = stagedBinary(`echo '${identityJson()}'`);
    expect(await verifyStagedIdentity(bin, expected)).toEqual({ ok: true });
  });

  it.each([
    ["version", identityJson({ version: "v9.9.8" })],
    ["commit", identityJson({ commit: "d".repeat(40) })],
    ["target", identityJson({ target: "bun-darwin-arm64" })],
  ])("refuses a genuine-looking artifact whose %s differs", async (field, json) => {
    const bin = stagedBinary(`echo '${json}'`);
    const out = await verifyStagedIdentity(bin, expected);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining(field) });
  });

  it("refuses a non-zero exit, and quotes the first stderr line", async () => {
    const bin = stagedBinary('echo "boom: not a ch binary" >&2\nexit 3');
    expect(await verifyStagedIdentity(bin, expected)).toMatchObject({ ok: false, error: expect.stringContaining("boom: not a ch binary") });
  });

  it("refuses output that is not JSON, and JSON that is not an object", async () => {
    expect(await verifyStagedIdentity(stagedBinary("echo hello"), expected)).toMatchObject({ ok: false, error: expect.stringContaining("with JSON") });
    expect(await verifyStagedIdentity(stagedBinary("echo '[]'"), expected)).toMatchObject({ ok: false, error: expect.stringContaining("with an object") });
  });

  it("runs the artifact with an EMPTY search path, so it cannot reach any helper on the machine", async () => {
    // The staged bytes are untrusted until this very check passes; letting them shell out to
    // whatever is installed would hand an attacker a foothold before the artifact is even
    // accepted. `sleep` is on every machine and is NOT reachable here.
    const bin = stagedBinary("sleep 1\nexit 7");
    // The shell's own first stderr line is the evidence: `sleep` exists on every machine and
    // could not be found from inside the identity run.
    expect(await verifyStagedIdentity(bin, expected)).toMatchObject({ ok: false, error: expect.stringContaining("sleep: not found") });
  });

  it("kills a staged binary that hangs, and its CHILDREN with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-hang-"));
    const marker = join(dir, "child.pid");
    // Builtins only — the identity run has no PATH (above). A descendant that outlives a naive
    // kill would keep burning the operator's machine after the update was refused.
    const bin = stagedBinary(`( echo $$ > ${marker}; while :; do :; done ) &\nwhile :; do :; done`);
    const started = Date.now();
    const out = await verifyStagedIdentity(bin, expected, 300);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("within 300ms") });
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((r) => setTimeout(r, 300));
    const childPid = Number(readFileSync(marker, "utf8").trim());
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    expect(() => process.kill(childPid, 0), "the descendant must be dead, not orphaned").toThrow();
  });

  it("refuses a staged binary that floods stdout instead of answering", async () => {
    const bin = stagedBinary("i=0\nwhile [ $i -lt 2000 ]; do printf '%0100d' $i; i=$((i+1)); done");
    expect(await verifyStagedIdentity(bin, expected, 5_000)).toMatchObject({ ok: false, error: expect.stringContaining("64 KiB") });
  });

  it("reports a missing artifact instead of throwing", async () => {
    expect(await verifyStagedIdentity(join(tmpdir(), "definitely-not-here-ch"), expected)).toMatchObject({ ok: false, error: expect.stringContaining("could not be run") });
  });
});
