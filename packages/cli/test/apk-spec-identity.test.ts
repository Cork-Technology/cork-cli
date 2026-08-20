// The apk build learns its release identity from scripts/apk-spec-identity.sh. The v0.4.0-rc.1
// apk build failed because the spec compiled with "v" + the apk version spelling (v0.4.0_rc1),
// which compile-binaries.mjs rejects (run 32416116529). These tests run the real script, with
// the real yq, against the current spec and the pre-fix spec captured from that tag.
// Self-skips when yq is not on PATH (the CI runners and the apk job have it).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(root, "scripts/apk-spec-identity.sh");
const currentSpec = join(root, "packaging/melange.yaml");
const preFixSpec = fileURLToPath(new URL("./fixtures/melange-prefix-v0.4.0-rc.1.yaml", import.meta.url));
const hasYq = spawnSync("yq", ["--version"]).status === 0;
const COMMIT = "ebce323212af8e8a9f127ba1a002c3d0bbfb23af";

function run(spec: string, tag: string, apkver: string, commit = COMMIT) {
  const dir = mkdtempSync(join(tmpdir(), "apk-spec-"));
  const copy = join(dir, "melange.yaml");
  copyFileSync(spec, copy);
  const r = spawnSync("sh", [script, copy, tag, apkver, commit], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, text: readFileSync(copy, "utf8") };
}

const compileLines = (text: string) => text.split("\n").filter((l) => l.includes("compile-binaries.mjs") || l.includes("--version "));

describe.skipIf(!hasYq)("apk-spec-identity.sh — the compile step always reads the git tag", () => {
  for (const [name, spec] of [["current spec", currentSpec], ["pre-fix spec (v0.4.0-rc.1)", preFixSpec]] as const) {
    it(`${name}: a release candidate compiles with the tag, is named with the apk spelling`, () => {
      const r = run(spec, "v9.9.9-rc.3", "9.9.9_rc3");
      expect(r.status, r.stderr).toBe(0);
      expect(r.text).toMatch(/^  version: 9\.9\.9_rc3$/m); // the apk NAME keeps apk grammar
      expect(r.text).toMatch(/^  tag: v9\.9\.9-rc\.3$/m); // vars.tag
      expect(r.text).toMatch(/expected-commit: ebce323212af8e8a9f127ba1a002c3d0bbfb23af/);
      expect(r.text).not.toContain("v0.4.0_rc1");
      expect(r.text).not.toMatch(/--version "v\$\{\{package\.version\}\}"/);
      // Whatever the spec's vintage, the checkout names the tag (directly or via vars.tag).
      expect(r.text).toMatch(/tag: (v9\.9\.9-rc\.3|\$\{\{vars\.tag\}\})\n\s+expected-commit/);
    });

    it(`${name}: a stable tag takes the same path`, () => {
      const r = run(spec, "v1.2.3", "1.2.3");
      expect(r.status, r.stderr).toBe(0);
      expect(r.text).toMatch(/^  version: 1\.2\.3$/m);
      expect(r.text).toMatch(/^  tag: v1\.2\.3$/m);
    });
  }

  it("the pre-fix spec's compile line is rewritten to the literal tag", () => {
    const r = run(preFixSpec, "v0.4.0-rc.1", "0.4.0_rc1");
    expect(r.status, r.stderr).toBe(0);
    expect(compileLines(r.text).some((l) => l.includes('--version "v0.4.0-rc.1"'))).toBe(true);
  });

  it("the current spec's compile line reads vars.tag and is left alone", () => {
    const r = run(currentSpec, "v0.4.0-rc.1", "0.4.0_rc1");
    expect(r.status, r.stderr).toBe(0);
    expect(compileLines(r.text).some((l) => l.includes('--version "${{vars.tag}}"'))).toBe(true);
  });

  it("refuses a spec whose compile step still passes something other than the tag", () => {
    // A spec that spells the version a third way: neither vars.tag nor the old literal.
    const dir = mkdtempSync(join(tmpdir(), "apk-spec-"));
    const rogue = join(dir, "melange.yaml");
    const text = readFileSync(currentSpec, "utf8").replace('--version "${{vars.tag}}"', '--version "v${{package.version}}-x"');
    expect(text).not.toBe(readFileSync(currentSpec, "utf8"));
    writeFileSync(rogue, text);
    const r = spawnSync("sh", [script, rogue, "v9.9.9-rc.3", "9.9.9_rc3", COMMIT], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not read the tag/);
  });

  it("refuses a malformed tag or commit before touching the spec", () => {
    expect(run(currentSpec, "0.4.0-rc.1", "0.4.0_rc1").status).toBe(2);
    expect(run(currentSpec, "v0.4.0-rc.1", "0.4.0_rc1", "abc").status).toBe(2);
  });
});
