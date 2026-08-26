// scripts/release-tag.sh must never push a tag whose signature does not verify. An ssh-sk (FIDO)
// key that is not touched makes the middleware return a zero-filled signature with a clean exit
// (observed three times on 2026-08-21), so "git tag -s succeeded" proves nothing — only
// `git tag -v` does. These tests use real git, a real throwaway ssh-ed25519 signing key, and a
// real bare remote, inside an isolated git config (no user or system config is read).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(root, "scripts/release-tag.sh");
const hasKeygen = spawnSync("ssh-keygen", ["-?"], { encoding: "utf8" }).status !== null;

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A throwaway signing world: a fresh ed25519 signer, a trusted (or empty) signer list, one repo, one bare remote. */
function world(opts: { trusted: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "release-tag-"));
  const signer = join(dir, "signer");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signer, "-C", "tester"]);
  const pub = readFileSync(`${signer}.pub`, "utf8").trim();
  const signers = join(dir, "signers");
  writeFileSync(signers, opts.trusted ? `tester ${pub}\n` : "");
  const config = join(dir, "gitconfig");
  writeFileSync(
    config,
    `[user]\n\tname = tester\n\temail = tester@example.invalid\n\tsigningkey = ${signer}\n[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tallowedSignersFile = ${signers}\n[init]\n\tdefaultBranch = main\n`,
  );
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  sh("git", ["init", "-q", "--bare", remote], dir, env);
  sh("git", ["init", "-q", repo], dir, env);
  writeFileSync(join(repo, "f"), "x\n");
  sh("git", ["add", "f"], repo, env);
  sh("git", ["commit", "-q", "-m", "init"], repo, env);
  sh("git", ["remote", "add", "cork-cli", remote], repo, env);
  // The script compares the remote by IDENTITY against CORK_RELEASE_REPO; a temp-dir bare repo
  // has none, so the tests declare the throwaway remote's own normalised identity as canonical.
  const canonical = remote.toLowerCase().replace(/\.git$/, "");
  const head = sh("git", ["rev-parse", "HEAD"], repo, env);
  // Public main must exist and advertise the candidate: pushing a tag pushes every object it
  // reaches, so the script refuses any commit that is not already the published head.
  sh("git", ["push", "-q", "cork-cli", "HEAD:refs/heads/main"], repo, env);
  const run = (args: string[], envOver: NodeJS.ProcessEnv = {}) =>
    spawnSync("sh", [script, ...args], { cwd: repo, env: { ...env, CORK_RELEASE_REPO: canonical, ...envOver }, encoding: "utf8" });
  const remoteTags = () => sh("git", ["ls-remote", "--tags", remote], repo, env);
  const localTags = () => sh("git", ["tag", "-l"], repo, env);
  return { run, head, remoteTags, localTags, repo, env, remote, canonical };
}

describe.skipIf(!hasKeygen)("release-tag.sh — sign, VERIFY, then push", () => {
  it("a verifiable signature: the tag is pushed to the remote", () => {
    const w = world({ trusted: true });
    const r = w.run(["v1.2.3", w.head, "cork-cli", "v1.2.3 — test"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("signature verified");
    expect(w.remoteTags()).toContain("refs/tags/v1.2.3");
    expect(sh("git", ["tag", "-v", "v1.2.3"], w.repo, w.env)).toBeDefined(); // exit 0 = Good
  });

  it("a signature nobody vouches for: tag deleted locally, NOTHING pushed", () => {
    const w = world({ trusted: false }); // well-formed signature, no principal in the signer list
    const r = w.run(["v1.2.3", w.head]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did NOT verify");
    expect(w.localTags()).toBe("");
    expect(w.remoteTags()).toBe("");
  });

  it("refuses a candidate that is not the head of public main — a tag push publishes every object it reaches", () => {
    const w = world({ trusted: true });
    // A commit that exists only in this clone: exactly what porting to public main handles first.
    writeFileSync(join(w.repo, "unpublished"), "local work\n");
    sh("git", ["add", "unpublished"], w.repo, w.env);
    sh("git", ["commit", "-q", "-m", "local work"], w.repo, w.env);
    const localOnly = sh("git", ["rev-parse", "HEAD"], w.repo, w.env);
    const r = w.run(["v1.2.3", localOnly]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not the head of public main");
    expect(r.stderr).toContain(w.head); // names the head it DID find
    expect(w.localTags()).toBe(""); // refused BEFORE signing
    expect(w.remoteTags()).toBe("");
    // An ANCESTOR is refused too: only the advertised head is publishable.
    expect(w.run(["v1.2.3", `${w.head}^`]).status).toBe(2);
  });

  it("accepts the same repo spelled as an ssh remote, and refuses a look-alike host", () => {
    const w = world({ trusted: true });
    // scp-style URL for the SAME path: one identity once normalised, so the check passes and the
    // run proceeds to the fetch (which cannot reach the invalid host — that is the assertion:
    // the URL SPELLING was accepted).
    sh("git", ["remote", "set-url", "cork-cli", `git@example.invalid:${w.canonical}.git`], w.repo, w.env);
    const ssh = w.run(["v1.2.3", w.head], { CORK_RELEASE_REPO: `example.invalid/${w.canonical}` });
    expect(ssh.stderr).not.toContain("not the canonical public repo");
    expect(ssh.stderr).toContain("could not fetch");
    expect(w.localTags()).toBe("");

    sh("git", ["remote", "set-url", "cork-cli", w.remote], w.repo, w.env);
    const impostor = w.run(["v1.2.3", w.head], { CORK_RELEASE_REPO: "github.com/cork-technology/cork-cli" });
    expect(impostor.status).toBe(2);
    expect(impostor.stderr).toContain("not the canonical public repo");
    expect(w.localTags()).toBe("");
    expect(w.remoteTags()).toBe("");
  });

  it("compares the PUSH url — that is the one that publishes objects", () => {
    const w = world({ trusted: true });
    sh("git", ["config", "remote.cork-cli.pushurl", "https://evil.example/cork-technology/cork-cli.git"], w.repo, w.env);
    const r = w.run(["v1.2.3", w.head]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("evil.example/cork-technology/cork-cli");
    expect(w.localTags()).toBe("");
  });

  it("refuses a non-v tag, an unknown commit, and an existing tag before signing anything", () => {
    const w = world({ trusted: true });
    expect(w.run(["1.2.3", w.head]).status).toBe(2);
    expect(w.run(["v1.2.3", "deadbeef"]).status).toBe(2);
    sh("git", ["tag", "v9.9.9", w.head], w.repo, w.env);
    const r = w.run(["v9.9.9", w.head]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("already exists");
    expect(w.remoteTags()).toBe("");
  });
});
