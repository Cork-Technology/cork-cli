import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const repo = "Cork-Technology/cork-cli-private";
const hasYq = spawnSync("yq", ["--version"]).status === 0;
const dirs: string[] = [];
function workspace() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "private-apk-")));
  dirs.push(dir);
  mkdirSync(join(dir, "packaging"));
  copyFileSync(join(root, "packaging/melange.yaml"), join(dir, "packaging/melange.yaml"));
  copyFileSync(join(root, "mise.toml"), join(dir, "mise.toml"));
  writeFileSync(join(dir, "tracked.txt"), "pinned source\n");
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "tag.forceSignAnnotated=false", ...args], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "."); git("add", "."); git("commit", "-qm", "isolated fixture"); git("tag", "v0.0.0-rc.0");
  const commit = git("rev-parse", "HEAD");
  // These MUST NOT enter melange's seeded source. The checkout auth header lives in .git.
  git("config", "http.https://github.com/.extraheader", "AUTHORIZATION: bearer fixture-checkout-token");
  writeFileSync(join(dir, "key.rsa"), "signing-key-not-source");
  writeFileSync(join(dir, "untracked-secret"), "fixture-untracked-token");
  const run = (name: string, args: string[], extra: Record<string, string> = {}) => spawnSync("sh", [join(root, "scripts", name), ...args], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_REPOSITORY: repo, ...extra } });
  const identity = run("apk-spec-identity.sh", ["packaging/melange.yaml", "v0.0.0-rc.0", "0.0.0_rc0", commit, "mise.toml"]);
  if (identity.status !== 0) throw new Error(identity.stderr);
  mkdirSync(join(dir, "bin"));
  // Observe the actual source/spec passed to the external build boundary, not source wiring.
  writeFileSync(join(dir, "bin/melange"), `#!/bin/sh
set -eu
spec="$2"; shift 2
source_dir=''; out=''; arch=''
printf '%s\\n' "$@" > build.argv
while [ $# -gt 0 ]; do
  case "$1" in --source-dir) source_dir="$2";; --out-dir) out="$2";; --arch) arch="$2";; esac
  shift
done
test -f "$source_dir/tracked.txt"
test ! -e "$source_dir/.git"
test ! -e "$source_dir/key.rsa"
test ! -e "$source_dir/untracked-secret"
test -z "\${GH_TOKEN:-}"
cp "$spec" observed-spec.yaml
cp "$source_dir/tracked.txt" observed-source.txt
mkdir -p "$out/$arch"
printf built > "$out/$arch/cork-cli-0.0.0_rc0-r0.apk"
`);
  chmodSync(join(dir, "bin/melange"), 0o755);
  return { dir, commit, run: (name: string, args: string[], extra: Record<string, string> = {}) => run(name, args, { PATH: `${join(dir, "bin")}:${process.env.PATH}`, ...extra }) };
}

import { afterAll } from "vitest";
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!hasYq)("private packaging source and image behavior", () => {
  it("builds from exactly the authenticated checkout commit, without sandbox credentials or untracked bytes", () => {
    const w = workspace();
    const r = w.run("apk-melange-build.sh", ["aarch64", "key.rsa"], { GH_TOKEN: "fixture-owner-read-token" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(w.dir, "observed-source.txt"), "utf8")).toBe("pinned source\n");
    const argv = readFileSync(join(w.dir, "build.argv"), "utf8");
    expect(argv).toContain(`--git-repo-url\nhttps://github.com/${repo}\n--git-commit\n${w.commit}\n`);
    expect(argv).toContain("--generate-provenance");
    const spec = readFileSync(join(w.dir, "observed-spec.yaml"), "utf8");
    expect(spec).not.toContain("uses: git-checkout");
    expect(spec).toContain(`repo: ${repo}`);
    expect(spec).toContain('--repo "${{vars.repo}}"');
    for (const secret of ["fixture-checkout-token", "fixture-untracked-token", "fixture-owner-read-token", "signing-key-not-source"]) {
      expect(argv + spec + r.stdout + r.stderr).not.toContain(secret);
    }
  });
  it("refuses a mismatched source commit or repository before invoking melange", () => {
    for (const field of ["commit", "repo"]) {
      const w = workspace();
      const value = field === "commit" ? "a".repeat(40) : "Cork-Technology/cork-cli";
      spawnSync("yq", ["-i", `.vars.${field} = "${value}"`, "packaging/melange.yaml"], { cwd: w.dir });
      const r = w.run("apk-melange-build.sh", ["aarch64", "key.rsa"]);
      expect(r.status).not.toBe(0);
      expect(existsSync(join(w.dir, "build.argv"))).toBe(false);
    }
  });
  it("stamps private image provenance, retaining Wolfi and the committed package signing key", () => {
    const w = workspace();
    copyFileSync(join(root, "packaging/cork-cli.apko.yaml"), join(w.dir, "packaging/cork-cli.apko.yaml"));
    copyFileSync(join(root, "packaging/melange.rsa.pub"), join(w.dir, "packaging/melange.rsa.pub"));
    for (const arch of ["x86_64", "aarch64"]) {
      mkdirSync(join(w.dir, "incoming", arch, "slice"), { recursive: true });
      writeFileSync(join(w.dir, "incoming", arch, "slice", "APKINDEX.tar.gz"), "fixture-index");
    }
    const r = w.run("apk-image-spec.sh", ["local", "0.0.0_rc0", "v0.0.0-rc.0", w.commit, "packaging/melange.rsa.pub"]);
    expect(r.status, r.stderr).toBe(0);
    const output = spawnSync("yq", ["-o=json", ".", "packaging/cork-cli.apko.yaml"], { cwd: w.dir, encoding: "utf8" });
    const spec = JSON.parse(output.stdout);
    expect(spec.annotations["org.opencontainers.image.source"]).toBe(`https://github.com/${repo}`);
    expect(spec.annotations["org.opencontainers.image.revision"]).toBe(w.commit);
    expect(spec.contents.repositories).toEqual(["https://packages.wolfi.dev/os", "./local"]);
    expect(spec.contents.keyring).toEqual(["https://packages.wolfi.dev/os/wolfi-signing.rsa.pub", "./packaging/melange.rsa.pub"]);
  });
  it("refuses private Pages and stable image channels without mutating the image spec", () => {
    const w = workspace();
    const path = join(w.dir, "packaging/cork-cli.apko.yaml");
    copyFileSync(join(root, "packaging/cork-cli.apko.yaml"), path);
    const before = readFileSync(path, "utf8");
    for (const args of [["pages", "0.7.0_rc1", "v0.7.0-rc.1", w.commit], ["local", "0.7.0", "v0.7.0", w.commit, "packaging/melange.rsa.pub"]]) {
      expect(w.run("apk-image-spec.sh", args).status).not.toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });
});
