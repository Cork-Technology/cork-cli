// The four scripts the RELEASE and its REHEARSAL share, so that a green rehearsal has run the
// release's own commands: apk-melange-build.sh (the build command line), apk-slice.sh (merge,
// sign one index, cut the slice), apk-image-spec.sh (where the image's apk comes from, its exact
// version, its release annotations), apk-rehearsal-spec.sh (fetch a branch, not a tag).
//
// The spec scripts run with the real yq against the real specs (self-skip without yq, as
// apk-spec-identity.test.ts does). melange is a recording stand-in: the suite must not need the
// build toolchain, and what these tests pin is the command line the scripts hand it.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = (name: string) => join(root, "scripts", name);
const hasYq = spawnSync("yq", ["--version"]).status === 0;
const hasGit = spawnSync("git", ["--version"]).status === 0;
const REV = "fdb139a89974a16c1156c9cf7865e91d3d3625e0";
const PAGES_REPO = "https://cork-technology.github.io/cork-cli/apk";
const PAGES_KEY = "https://cork-technology.github.io/cork-cli/melange.rsa.pub";
const WOLFI_REPO = "https://packages.wolfi.dev/os";
const WOLFI_KEY = "https://packages.wolfi.dev/os/wolfi-signing.rsa.pub";

function sh(file: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("sh", [file, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const yqJson = (file: string) => JSON.parse(spawnSync("yq", ["-o=json", ".", file], { encoding: "utf8" }).stdout);

/** A working directory shaped like the publish job's: the real apko spec, the committed key, two incoming slices. */
function imageDir(opts: { slices?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "apk-image-spec-"));
  mkdirSync(join(dir, "packaging"));
  copyFileSync(join(root, "packaging/cork-cli.apko.yaml"), join(dir, "packaging/cork-cli.apko.yaml"));
  copyFileSync(join(root, "packaging/melange.rsa.pub"), join(dir, "packaging/melange.rsa.pub"));
  if (opts.slices !== false) {
    for (const arch of ["x86_64", "aarch64"]) {
      mkdirSync(join(dir, "incoming", arch, "slice"), { recursive: true });
      writeFileSync(join(dir, "incoming", arch, "slice", "APKINDEX.tar.gz"), `index-${arch}`);
      writeFileSync(join(dir, "incoming", arch, "slice", "cork-cli-0.6.1_rc3-r0.apk"), `apk-${arch}`);
      writeFileSync(join(dir, "incoming", arch, `rehearsal-${arch}.rsa.pub`), `pub-${arch}`);
    }
  }
  return dir;
}
const spec = (dir: string) => join(dir, "packaging/cork-cli.apko.yaml");

describe.skipIf(!hasYq)("apk-image-spec.sh — the image's package source, version pin and annotations", () => {
  it("pages: keeps the published channel and its key, pins the exact version, stamps version and revision", () => {
    const dir = imageDir();
    const before = yqJson(spec(dir));
    const r = sh(script("apk-image-spec.sh"), ["pages", "0.6.1", "v0.6.1", REV], dir);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const after = yqJson(spec(dir));
    expect(after.contents.repositories).toEqual([WOLFI_REPO, PAGES_REPO]);
    expect(after.contents.keyring).toEqual([WOLFI_KEY, PAGES_KEY]);
    expect(after.contents.packages).toEqual(["wolfi-baselayout", "ca-certificates-bundle", "cork-cli=0.6.1-r0"]);
    expect(after.annotations["org.opencontainers.image.version"]).toBe("v0.6.1");
    expect(after.annotations["org.opencontainers.image.revision"]).toBe(REV);
    // Nothing else in the spec moved.
    const strip = (s: any) => ({ ...s, contents: { ...s.contents, packages: null }, annotations: { ...s.annotations, "org.opencontainers.image.version": null, "org.opencontainers.image.revision": null } });
    expect(strip(after)).toEqual(strip(before));
    expect(existsSync(join(dir, "local"))).toBe(false);
  });

  it("local, the release's candidate call: composes from ./local with the committed key in the published key's place", () => {
    const dir = imageDir();
    const r = sh(script("apk-image-spec.sh"), ["local", "0.6.1_rc3", "v0.6.1-rc.3", REV, "packaging/melange.rsa.pub"], dir);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const after = yqJson(spec(dir));
    expect(after.contents.repositories).toEqual([WOLFI_REPO, "./local"]);
    expect(after.contents.keyring).toEqual([WOLFI_KEY, "./packaging/melange.rsa.pub"]);
    expect(after.contents.packages).toEqual(["wolfi-baselayout", "ca-certificates-bundle", "cork-cli=0.6.1_rc3-r0"]);
    expect(after.annotations["org.opencontainers.image.version"]).toBe("v0.6.1-rc.3");
    expect(after.annotations["org.opencontainers.image.revision"]).toBe(REV);
    // Each slice became a per-arch local repository, files and all.
    for (const arch of ["x86_64", "aarch64"]) {
      expect(readdirSync(join(dir, "local", arch)).sort()).toEqual(["APKINDEX.tar.gz", "cork-cli-0.6.1_rc3-r0.apk"]);
      expect(readFileSync(join(dir, "local", arch, "APKINDEX.tar.gz"), "utf8")).toBe(`index-${arch}`);
    }
  });

  it("local, the rehearsal's call: one throwaway key per slice, each in the keyring, in order", () => {
    const dir = imageDir();
    const r = sh(script("apk-image-spec.sh"), ["local", "0.0.0_rc0", "v0.0.0-rc.0", REV, "incoming/x86_64/rehearsal-x86_64.rsa.pub", "incoming/aarch64/rehearsal-aarch64.rsa.pub"], dir);
    expect(r.status).toBe(0);
    const after = yqJson(spec(dir));
    expect(after.contents.keyring).toEqual([WOLFI_KEY, "./incoming/x86_64/rehearsal-x86_64.rsa.pub", "./incoming/aarch64/rehearsal-aarch64.rsa.pub"]);
    expect(after.contents.keyring).not.toContain(PAGES_KEY);
    expect(after.contents.packages).toContain("cork-cli=0.0.0_rc0-r0");
  });

  it("keeps an absolute or already-relative key path as given", () => {
    const dir = imageDir();
    const abs = join(dir, "packaging/melange.rsa.pub");
    const r = sh(script("apk-image-spec.sh"), ["local", "1.0.0", "v1.0.0", REV, abs, "./packaging/melange.rsa.pub"], dir);
    expect(r.status).toBe(0);
    expect(yqJson(spec(dir)).contents.keyring).toEqual([WOLFI_KEY, abs, "./packaging/melange.rsa.pub"]);
  });

  it("refuses bad input before it changes the spec", () => {
    const cases: [string[], number, string][] = [
      [["pages", "0.6.1", "v0.6.1", "abc123"], 2, "revision must be a 40-hex commit"],
      [["pages", "0.6.1", "v0.6.1", "G".repeat(40)], 2, "revision must be a 40-hex commit"],
      [["pages", "0.6.1", "v0.6.1", REV, "packaging/melange.rsa.pub"], 2, "pages takes no public key"],
      [["local", "0.6.1", "v0.6.1", REV], 2, "local needs at least one public key file"],
      [["cloud", "0.6.1", "v0.6.1", REV], 2, "unknown mode"],
      [["local", "0.6.1", "v0.6.1", REV, "packaging/absent.pub"], 1, "public key file is missing or empty"],
    ];
    for (const [args, status, message] of cases) {
      const dir = imageDir();
      const before = readFileSync(spec(dir), "utf8");
      const r = sh(script("apk-image-spec.sh"), args, dir);
      expect(r.status, args.join(" ")).toBe(status);
      expect(r.err, args.join(" ")).toContain(message);
      // A refusal leaves the spec byte for byte as it was, and creates no local repository.
      expect(readFileSync(spec(dir), "utf8"), args.join(" ")).toBe(before);
      expect(existsSync(join(dir, "local")), args.join(" ")).toBe(false);
    }
  });

  it("local: refuses a slice without a signed index", () => {
    const dir = imageDir({ slices: false });
    const r = sh(script("apk-image-spec.sh"), ["local", "0.6.1", "v0.6.1", REV, "packaging/melange.rsa.pub"], dir);
    expect(r.status).toBe(1);
    expect(r.err).toContain("incoming/x86_64/slice has no signed index");
    expect(readFileSync(spec(dir), "utf8")).toBe(readFileSync(join(root, "packaging/cork-cli.apko.yaml"), "utf8"));
  });

  it("refuses a spec that lost the line it replaces, instead of building from the wrong place", () => {
    // A spec whose Pages repository line is gone would leave `local` with nothing to swap: the
    // image would silently compose from whatever repositories remain.
    const dir = imageDir();
    spawnSync("yq", ["-i", `.contents.repositories = ["${WOLFI_REPO}"]`, spec(dir)]);
    const r = sh(script("apk-image-spec.sh"), ["local", "0.6.1", "v0.6.1", REV, "packaging/melange.rsa.pub"], dir);
    expect(r.status).toBe(1);
    expect(r.err).toContain("does not name ./local exactly once");
    // And a spec without the cork-cli package cannot be pinned.
    const dir2 = imageDir();
    spawnSync("yq", ["-i", `.contents.packages = ["wolfi-baselayout"]`, spec(dir2)]);
    const r2 = sh(script("apk-image-spec.sh"), ["pages", "0.6.1", "v0.6.1", REV], dir2);
    expect(r2.status).toBe(1);
    expect(r2.err).toContain("was not pinned to 0.6.1-r0");
  });
});

describe.skipIf(!hasYq)("apk-rehearsal-spec.sh — a branch at a pinned commit, in place of a tag", () => {
  const COMMIT = "71a21dd2b318b64be8606bd9bff07ba10ef0063c";
  function melangeSpec(identity: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "apk-rehearsal-spec-"));
    const file = join(dir, "melange.yaml");
    copyFileSync(join(root, "packaging/melange.yaml"), file);
    if (identity) {
      const r = sh(script("apk-spec-identity.sh"), [file, "v0.0.0-rc.0", "0.0.0_rc0", COMMIT], root);
      if (r.status !== 0) throw new Error(r.err);
    }
    return file;
  }

  it("after the identity script: the tag is gone, the branch is set, the commit pin and everything else stay", () => {
    const file = melangeSpec(true);
    const before = yqJson(file);
    const r = sh(script("apk-rehearsal-spec.sh"), [file, "main"], root);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const after = yqJson(file);
    expect(after.pipeline[0]).toEqual({ uses: "git-checkout", with: { repository: "https://github.com/Cork-Technology/cork-cli", "expected-commit": COMMIT, branch: "main" } });
    expect(before.pipeline[0].with.tag).toBeDefined();
    // The identity the build compiles with is untouched: only the checkout step differs.
    expect(after.pipeline.slice(1)).toEqual(before.pipeline.slice(1));
    expect(after.package).toEqual(before.package);
    expect(after.vars).toEqual({ commit: COMMIT, tag: "v0.0.0-rc.0" });
    expect(after.environment).toEqual(before.environment);
  });

  it("refuses a spec the identity script has not written: no commit pin, no rehearsal", () => {
    const file = melangeSpec(false);
    const before = readFileSync(file, "utf8");
    const r = sh(script("apk-rehearsal-spec.sh"), [file, "main"], root);
    expect(r.status).toBe(1);
    expect(r.err).toContain("carries no commit pin");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses what is not a branch name", () => {
    for (const bad of ["", "main; rm -rf /", "a b", "$(id)"]) {
      const file = melangeSpec(true);
      const before = readFileSync(file, "utf8");
      const r = sh(script("apk-rehearsal-spec.sh"), [file, bad], root);
      expect(r.status, bad).not.toBe(0);
      expect(readFileSync(file, "utf8"), bad).toBe(before);
    }
  });
});

/** A recording melange: `build` makes <out>/<arch>/ with an apk, `index` writes the index where it runs. */
function fakeMelange(dir: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "melange.log");
  writeFileSync(join(bin, "melange"), [
    "#!/bin/sh",
    `{ printf 'cwd=%s\\n' "$(pwd)"; printf 'epoch=%s\\n' "\${SOURCE_DATE_EPOCH:-unset}"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; printf -- '--\\n'; } >> "${log}"`,
    'case "$1" in',
    '  build) out=""; arch=""; prev=""; for a in "$@"; do [ "$prev" = --out-dir ] && out="$a"; [ "$prev" = --arch ] && arch="$a"; prev="$a"; done',
    '         mkdir -p "$out/$arch" && echo built > "$out/$arch/cork-cli-9.9.9-r0.apk" ;;',
    '  index) echo "signed-index" > APKINDEX.tar.gz ;;',
    "esac",
    "",
  ].join("\n"));
  chmodSync(join(bin, "melange"), 0o755);
  return {
    path: `${bin}:${process.env.PATH ?? ""}`,
    calls: () => readFileSync(log, "utf8").split("--\n").filter(Boolean).map((c) => {
      const lines = c.trimEnd().split("\n");
      const get = (k: string) => lines.filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));
      return { cwd: get("cwd")[0]!, epoch: get("epoch")[0]!, args: get("arg") };
    }),
  };
}

describe.skipIf(!hasGit)("apk-melange-build.sh — the one spelling of the build command", () => {
  /** A git repository with one commit at a known time, a spec and a key: what the job's workspace is. */
  function workspace() {
    const dir = mkdtempSync(join(tmpdir(), "apk-melange-build-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T16:48:02Z", GIT_COMMITTER_DATE: "2026-10-01T16:48:02Z" } });
    git("init", "-q", ".");
    mkdirSync(join(dir, "packaging"));
    writeFileSync(join(dir, "packaging/melange.yaml"), "package: {}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    writeFileSync(join(dir, "key.rsa"), "KEY");
    return dir;
  }

  it("builds with the bubblewrap runner, provenance on, the commit's clock, and nothing else", () => {
    const dir = workspace();
    const m = fakeMelange(dir);
    const r = sh(script("apk-melange-build.sh"), ["aarch64", "key.rsa"], dir, { PATH: m.path });
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(m.calls()).toEqual([{
      cwd: dir,
      epoch: String(Date.parse("2026-10-01T16:48:02Z") / 1000),
      args: ["build", "packaging/melange.yaml", "--runner", "bubblewrap", "--arch", "aarch64", "--signing-key", "key.rsa", "--generate-provenance", "--out-dir", "packages"],
    }]);
    expect(r.out).toContain("cork-cli-9.9.9-r0.apk");
  });

  it("passes the architecture, the key, the output directory and the spec it was given", () => {
    const dir = workspace();
    writeFileSync(join(dir, "other.yaml"), "package: {}\n");
    const m = fakeMelange(dir);
    const r = sh(script("apk-melange-build.sh"), ["x86_64", "key.rsa", "out", "other.yaml"], dir, { PATH: m.path });
    expect(r.status).toBe(0);
    expect(m.calls()[0]!.args).toEqual(["build", "other.yaml", "--runner", "bubblewrap", "--arch", "x86_64", "--signing-key", "key.rsa", "--generate-provenance", "--out-dir", "out"]);
  });

  it("refuses an unmapped architecture and a missing or empty key, before melange runs", () => {
    const dir = workspace();
    const m = fakeMelange(dir);
    writeFileSync(join(dir, "empty.rsa"), "");
    for (const [args, status, message] of [
      [["riscv64", "key.rsa"], 2, "unmapped arch"],
      [["aarch64", "absent.rsa"], 1, "signing key file is missing or empty"],
      [["aarch64", "empty.rsa"], 1, "signing key file is missing or empty"],
    ] as const) {
      const r = sh(script("apk-melange-build.sh"), [...args], dir, { PATH: m.path });
      expect(r.status, args.join(" ")).toBe(status);
      expect(r.err, args.join(" ")).toContain(message);
    }
    expect(existsSync(join(dir, "melange.log"))).toBe(false);
  });

  it("fails when melange fails", () => {
    const dir = workspace();
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/melange"), "#!/bin/sh\necho 'build failed' >&2\nexit 7\n");
    chmodSync(join(dir, "bin/melange"), 0o755);
    const r = sh(script("apk-melange-build.sh"), ["aarch64", "key.rsa"], dir, { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` });
    expect(r.status).toBe(7);
  });

  it("stops when git answers with NOTHING and no error: an empty clock is not a clock", () => {
    // The failure that once shipped (run 32225918023): the command substitution produced an
    // empty value and the step went on. A git that prints nothing and exits 0 is that case.
    const dir = workspace();
    const m = fakeMelange(dir);
    writeFileSync(join(dir, "bin/git"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin/git"), 0o755);
    const r = sh(script("apk-melange-build.sh"), ["aarch64", "key.rsa"], dir, { PATH: m.path });
    expect(r.status).toBe(1);
    expect(r.err).toContain("could not read the commit's timestamp for SOURCE_DATE_EPOCH");
    expect(existsSync(join(dir, "melange.log"))).toBe(false);
  });

  it("stops when the commit's time cannot be read (not a repository): no build without the clock", () => {
    const dir = mkdtempSync(join(tmpdir(), "apk-melange-norepo-"));
    writeFileSync(join(dir, "key.rsa"), "KEY");
    const m = fakeMelange(dir);
    const r = sh(script("apk-melange-build.sh"), ["aarch64", "key.rsa"], dir, { PATH: m.path, GIT_CEILING_DIRECTORIES: dir });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(dir, "melange.log"))).toBe(false);
  });
});

describe("apk-slice.sh — merge, one signed index, the slice", () => {
  /** A workspace after the build: packages/<arch> holds the new apk and its provenance. */
  function built(arch = "aarch64") {
    const dir = mkdtempSync(join(tmpdir(), "apk-slice-"));
    mkdirSync(join(dir, "packages", arch), { recursive: true });
    writeFileSync(join(dir, "packages", arch, "cork-cli-0.6.1-r0.apk"), "NEW-APK");
    writeFileSync(join(dir, "packages", arch, "cork-cli-0.6.1-r0.attest.tar.gz"), "NEW-PROVENANCE");
    writeFileSync(join(dir, "packages", arch, "APKINDEX.tar.gz"), "melange-build's own local index — not what the slice carries");
    writeFileSync(join(dir, "key.rsa"), "KEY");
    return dir;
  }

  it("an empty channel (a candidate, the rehearsal): the slice is the apk, its provenance and the signed index", () => {
    const dir = built();
    mkdirSync(join(dir, "site/apk/aarch64"), { recursive: true });
    const m = fakeMelange(dir);
    const r = sh(script("apk-slice.sh"), ["aarch64", "key.rsa", "none"], dir, { PATH: m.path });
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(readdirSync(join(dir, "slice")).sort()).toEqual(["APKINDEX.tar.gz", "cork-cli-0.6.1-r0.apk", "cork-cli-0.6.1-r0.attest.tar.gz"]);
    // The index in the slice is the one signed HERE, over the channel directory.
    expect(readFileSync(join(dir, "slice/APKINDEX.tar.gz"), "utf8")).toBe("signed-index\n");
    expect(readFileSync(join(dir, "slice-base.sha"), "utf8")).toBe("none\n");
    // melange index ran inside the channel directory, with an ABSOLUTE key path.
    expect(m.calls()).toEqual([{ cwd: join(dir, "site/apk/aarch64"), epoch: "unset", args: ["index", "-o", "APKINDEX.tar.gz", "--signing-key", join(dir, "key.rsa"), "./cork-cli-0.6.1-r0.apk"] }]);
    expect(r.out).toContain("slice for aarch64: 2 added file(s) + signed index, indexed against gh-pages none");
  });

  it("a published channel (production): the index covers every apk, the slice carries only what was added", () => {
    const dir = built("x86_64");
    const channel = join(dir, "site/apk/x86_64");
    mkdirSync(channel, { recursive: true });
    writeFileSync(join(channel, "cork-cli-0.6.0-r0.apk"), "OLD-APK");
    writeFileSync(join(channel, "cork-cli-0.6.0-r0.attest.tar.gz"), "OLD-PROVENANCE");
    const m = fakeMelange(dir);
    const base = "9".repeat(40);
    const r = sh(script("apk-slice.sh"), ["x86_64", join(dir, "key.rsa"), base], dir, { PATH: m.path });
    expect(r.status).toBe(0);
    expect(m.calls()[0]!.args).toEqual(["index", "-o", "APKINDEX.tar.gz", "--signing-key", join(dir, "key.rsa"), "./cork-cli-0.6.0-r0.apk", "./cork-cli-0.6.1-r0.apk"]);
    expect(readdirSync(join(dir, "slice")).sort()).toEqual(["APKINDEX.tar.gz", "cork-cli-0.6.1-r0.apk", "cork-cli-0.6.1-r0.attest.tar.gz"]);
    expect(readFileSync(join(dir, "slice-base.sha"), "utf8")).toBe(`${base}\n`);
  });

  it("a re-run over identical bytes adds nothing: the slice is the index alone", () => {
    const dir = built();
    const channel = join(dir, "site/apk/aarch64");
    mkdirSync(channel, { recursive: true });
    writeFileSync(join(channel, "cork-cli-0.6.1-r0.apk"), "NEW-APK");
    writeFileSync(join(channel, "cork-cli-0.6.1-r0.attest.tar.gz"), "NEW-PROVENANCE");
    const m = fakeMelange(dir);
    const r = sh(script("apk-slice.sh"), ["aarch64", "key.rsa", "none"], dir, { PATH: m.path });
    expect(r.status).toBe(0);
    expect(readdirSync(join(dir, "slice"))).toEqual(["APKINDEX.tar.gz"]);
  });

  it("different bytes under a published name REFUSE: no index is signed and no slice is cut", () => {
    const dir = built();
    const channel = join(dir, "site/apk/aarch64");
    mkdirSync(channel, { recursive: true });
    writeFileSync(join(channel, "cork-cli-0.6.1-r0.apk"), "PUBLISHED-DIFFERENT-BYTES");
    const m = fakeMelange(dir);
    const r = sh(script("apk-slice.sh"), ["aarch64", "key.rsa", "none"], dir, { PATH: m.path });
    expect(r.status).not.toBe(0);
    expect(existsSync(join(dir, "melange.log"))).toBe(false);
    expect(existsSync(join(dir, "slice"))).toBe(false);
    expect(readFileSync(join(channel, "cork-cli-0.6.1-r0.apk"), "utf8")).toBe("PUBLISHED-DIFFERENT-BYTES");
  });

  it("an old slice directory never leaks into a new slice", () => {
    const dir = built();
    mkdirSync(join(dir, "site/apk/aarch64"), { recursive: true });
    mkdirSync(join(dir, "slice"));
    writeFileSync(join(dir, "slice/stale.apk"), "STALE");
    const m = fakeMelange(dir);
    expect(sh(script("apk-slice.sh"), ["aarch64", "key.rsa", "none"], dir, { PATH: m.path }).status).toBe(0);
    expect(readdirSync(join(dir, "slice"))).not.toContain("stale.apk");
  });

  it("refuses a missing or empty key before it merges anything", () => {
    const dir = built();
    mkdirSync(join(dir, "site/apk/aarch64"), { recursive: true });
    const m = fakeMelange(dir);
    const r = sh(script("apk-slice.sh"), ["aarch64", "absent.rsa", "none"], dir, { PATH: m.path });
    expect(r.status).toBe(1);
    expect(r.err).toContain("signing key file is missing or empty");
    expect(readdirSync(join(dir, "site/apk/aarch64"))).toEqual([]);
  });
});
