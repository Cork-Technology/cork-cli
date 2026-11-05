// scripts/release-tag.sh must never push a tag whose signature does not verify. An ssh-sk (FIDO)
// key that is not touched makes the middleware return a zero-filled signature with a clean exit
// (observed three times on 2026-08-21), so "git tag -s succeeded" proves nothing — only
// `git tag -v` does. These tests use real git, a real throwaway ssh-ed25519 signing key, and a
// real bare remote, inside an isolated git config (no user or system config is read).
// Only the external remote-identity lookup is adapted to advertise the canonical public URL;
// actual branch fetches, signing, verification and pushes still use the owned local bare repo.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  sh("git", ["init", "-q", "--bare", remote], dir, env);
  sh("git", ["init", "-q", repo], dir, env);
  writeFileSync(join(repo, "f"), "x\n");
  sh("git", ["add", "f"], repo, env);
  sh("git", ["commit", "-q", "-m", "init"], repo, env);
  sh("git", ["remote", "add", "cork-cli", remote], repo, env);
  const head = sh("git", ["rev-parse", "HEAD"], repo, env);
  // Public main must exist and advertise the candidate: pushing a tag pushes every object it
  // reaches, so the script refuses any commit that is not already the published head.
  sh("git", ["push", "-q", "cork-cli", "HEAD:refs/heads/main"], repo, env);
  const realGit = sh("sh", ["-c", "command -v git"], dir, env);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const adapter = join(bin, "git");
  writeFileSync(adapter, '#!/bin/sh\nif [ "$1 $2 $3" = "remote get-url --push" ]; then\n  value="$("$FIXTURE_GIT" "$@")" || exit 2\n  if [ "$value" = "$FIXTURE_LOCAL_REMOTE" ]; then printf "%s\\n" "$FIXTURE_PUBLIC_URL"; else printf "%s\\n" "$value"; fi\n  exit 0\nfi\nexec "$FIXTURE_GIT" "$@"\n');
  chmodSync(adapter, 0o755);
  const runEnv: NodeJS.ProcessEnv = { ...env, PATH: `${bin}:${env.PATH}`, FIXTURE_GIT: realGit, FIXTURE_LOCAL_REMOTE: remote, FIXTURE_PUBLIC_URL: "https://github.com/Cork-Technology/cork-cli.git" };
  const run = (args: string[], envOver: NodeJS.ProcessEnv = {}) =>
    spawnSync("sh", [script, ...args], { cwd: repo, env: { ...runEnv, ...envOver }, encoding: "utf8" });
  const remoteTags = () => sh("git", ["ls-remote", "--tags", remote], repo, env);
  const localTags = () => sh("git", ["tag", "-l"], repo, env);
  return { run, head, remoteTags, localTags, repo, env, remote };
}

describe.skipIf(!hasKeygen)("release-tag.sh — sign, VERIFY, then push", () => {
  it("a verifiable signature: the tag is pushed to the remote", () => {
    const w = world({ trusted: true });
    const r = w.run(["v1.2.3", w.head, "cork-cli", "v1.2.3 — test"]);
    expect(r.status, r.stderr).toBe(0);
    expect(w.remoteTags()).toContain("refs/tags/v1.2.3");
    expect(sh("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], w.remote, w.env)).toBe(w.head);
  });

  it("publishes an RC from its release branch even when main has a different head", () => {
    const w = world({ trusted: true });
    writeFileSync(join(w.repo, "candidate"), "RC work\n");
    sh("git", ["add", "candidate"], w.repo, w.env);
    sh("git", ["commit", "-q", "-m", "candidate"], w.repo, w.env);
    const candidate = sh("git", ["rev-parse", "HEAD"], w.repo, w.env);
    sh("git", ["push", "-q", "cork-cli", "HEAD:refs/heads/release/v1.2.3"], w.repo, w.env);
    const r = w.run(["v1.2.3-rc.1", candidate]);
    expect(r.status, r.stderr).toBe(0);
    expect(sh("git", ["rev-parse", "refs/tags/v1.2.3-rc.1^{commit}"], w.remote, w.env)).toBe(candidate);
    expect(sh("git", ["rev-parse", "refs/heads/main"], w.remote, w.env)).toBe(w.head);
  });

  it("refuses an RC if only main advertises the candidate", () => {
    const w = world({ trusted: true });
    expect(w.run(["v1.2.3-rc.1", w.head]).status).toBe(2);
    expect(w.localTags()).toBe("");
    expect(w.remoteTags()).toBe("");
  });

  it("refuses an RC candidate that is not its release branch head", () => {
    const w = world({ trusted: true });
    sh("git", ["push", "-q", "cork-cli", "HEAD:refs/heads/release/v1.2.3"], w.repo, w.env);
    writeFileSync(join(w.repo, "candidate"), "unpublished RC work\n");
    sh("git", ["add", "candidate"], w.repo, w.env);
    sh("git", ["commit", "-q", "-m", "unpublished candidate"], w.repo, w.env);
    const candidate = sh("git", ["rev-parse", "HEAD"], w.repo, w.env);
    expect(w.run(["v1.2.3-rc.1", candidate]).status).toBe(2);
    expect(w.run(["v1.2.4-rc.1", w.head]).status).toBe(2);
    expect(w.localTags()).toBe("");
    expect(w.remoteTags()).toBe("");
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
    const ssh = w.run(["v1.2.3", w.head], { FIXTURE_PUBLIC_URL: "git@github.com:Cork-Technology/cork-cli.git" });
    expect(ssh.status, ssh.stderr).toBe(0);
    expect(w.remoteTags()).toContain("refs/tags/v1.2.3");

    const other = world({ trusted: true });
    sh("git", ["remote", "set-url", "cork-cli", "https://evil.example/Cork-Technology/cork-cli.git"], other.repo, other.env);
    const impostor = other.run(["v1.2.3", other.head]);
    expect(impostor.status).toBe(2);
    expect(other.localTags()).toBe("");
    expect(other.remoteTags()).toBe("");
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
