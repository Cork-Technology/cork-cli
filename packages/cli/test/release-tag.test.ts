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
  const head = sh("git", ["rev-parse", "HEAD"], repo, env);
  const run = (args: string[]) => spawnSync("sh", [script, ...args], { cwd: repo, env, encoding: "utf8" });
  const remoteTags = () => sh("git", ["ls-remote", "--tags", remote], repo, env);
  const localTags = () => sh("git", ["tag", "-l"], repo, env);
  return { run, head, remoteTags, localTags, repo, env };
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
