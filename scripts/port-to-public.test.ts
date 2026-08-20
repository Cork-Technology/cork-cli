// Fixture tests for the private→public port transform — REAL git repos in a tmpdir, no mocks.
// Each case replays a failure mode the ad-hoc procedure actually hit (2026-08-09/10) or a gate
// the transform must enforce. Mutation probes aim at the exclusion list and the anchor gate.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXCLUDED_PREFIXES, isExcluded, portCommits, REPOINTS, stripAiTrailers, transformTree } from "./port-to-public.ts";

let repo: string;

function git(args: string[], opts: { input?: string } = {}): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", ...(opts.input !== undefined ? { input: opts.input } : {}) });
}

function write(rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function commitAll(msg: string): string {
  git(["add", "-A"]);
  git(["commit", "--no-gpg-sign", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]).trim();
}

/** Every repoint file in its PRIVATE form, with a neighbor line above the anchor (the adjacency
 *  that broke the patch-based port), plus private-only trees and a normal source file. */
function seedPrivateBaseline(): void {
  for (const r of REPOINTS) write(r.file, `neighbor line above\n${r.from}\nbody of ${r.file}\n`);
  write("notes/secret-plan.md", "private notes\n");
  write("experiments/lab.txt", "private experiment\n");
  write("rfc/001.md", "private rfc\n");
  write("src/app.ts", "export const x = 1;\n");
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "port-fixture-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "fixture"]);
  git(["config", "user.email", "fixture@test"]);
  git(["config", "commit.gpgsign", "false"]);
  seedPrivateBaseline();
  commitAll("private baseline");
  // Bootstrap the public lineage the way the real one exists: transform of the baseline.
  const idx = join(repo, ".git", "port-test-index");
  const { tree } = transformTree(repo, "HEAD", idx);
  const pub = git(["commit-tree", tree, "-m", "public baseline"]).trim();
  git(["branch", "public", pub]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("port-to-public: the transform is a pure function of the private tree", () => {
  it("bootstrap: drops every excluded path and applies all repoints", () => {
    const tree = git(["rev-parse", "public^{tree}"]).trim();
    const files = git(["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);
    expect(files.some(isExcluded)).toBe(false);
    expect(files).toContain("src/app.ts");
    for (const r of REPOINTS) {
      const content = git(["show", `${tree}:${r.file}`]);
      expect(content).toContain(r.to);
      expect(content).not.toContain(r.from);
    }
  });

  it("ports an edit ADJACENT to a repoint anchor (the patch-context failure that shipped an empty commit)", () => {
    write(".github/workflows/apk-repo.yml", `neighbor line above EDITED\n${REPOINTS[0]!.from}\nbody of ${REPOINTS[0]!.file}\n`);
    const c = commitAll("edit next to the strip line");
    const { head, ported, skipped } = portCommits(repo, [c], "public", false);
    expect(ported).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    const content = git(["show", `${head}:.github/workflows/apk-repo.yml`]);
    expect(content).toContain("neighbor line above EDITED"); // the edit survived
    expect(content).toContain(REPOINTS[0]!.to); // the repoint held
    expect(content).not.toContain(REPOINTS[0]!.from);
    // The ported commit is NON-EMPTY relative to its parent — the exact regression that pushed.
    expect(git(["diff", "--name-only", `${head}^`, head]).trim()).not.toBe("");
    git(["branch", "-f", "public", head]);
  });

  it("preserves author/committer identity and dates on the ported commit", () => {
    const priv = git(["log", "-1", "--format=%an|%ae|%aI|%cI", "main"]).trim();
    const pub = git(["log", "-1", "--format=%an|%ae|%aI|%cI", "public"]).trim();
    expect(pub).toBe(priv);
  });

  it("drops an AI co-author trailer from the ported message, keeps human trailers (policy G8)", () => {
    write("README.md", "public readme, revised for the trailer case\n");
    const c = commitAll("feat: something\n\nbody line\n\nCo-authored-by: Pat Human <pat@example.test>\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>");
    const { head } = portCommits(repo, [c], "public", false);
    const msg = git(["log", "-1", "--format=%B", head]);
    expect(msg).toContain("Co-authored-by: Pat Human <pat@example.test>");
    expect(msg).not.toMatch(/claude|anthropic/i);
    expect(msg.trimEnd().endsWith("Co-authored-by: Pat Human <pat@example.test>")).toBe(true);
    git(["branch", "-f", "public", head]);
  });

  it("stripAiTrailers is a pure function: no trailer → message unchanged, trailing blank run collapsed", () => {
    expect(stripAiTrailers("subject\n\nbody\n")).toBe("subject\n\nbody\n");
    expect(stripAiTrailers("subject\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")).toBe("subject\n");
    expect(stripAiTrailers("subject\n\nCo-authored-by: Dev <d@x.test>\nCo-authored-by: GitHub Copilot <copilot@github.com>\n")).toBe("subject\n\nCo-authored-by: Dev <d@x.test>\n");
  });

  it("skips an excluded-only commit instead of minting an empty one", () => {
    write("notes/secret-plan.md", "private notes, revised\n");
    const c = commitAll("notes-only change");
    const { ported, skipped, head } = portCommits(repo, [c], "public", false);
    expect(ported).toHaveLength(0);
    expect(skipped).toEqual([c]);
    expect(head).toBe(git(["rev-parse", "public"]).trim());
  });

  it("fails LOUDLY when a repoint anchor was reworded (drift detection, not silent un-repointing)", () => {
    write("mise.toml", "neighbor line above\n# the Bun version is REWORDED beyond recognition.\nbody of mise.toml\n");
    const c = commitAll("reword the anchor");
    expect(() => portCommits(repo, [c], "public", false)).toThrow(/repoint anchor not found in mise\.toml/);
    // Restore for later cases.
    write("mise.toml", `neighbor line above\n${REPOINTS.find((r) => r.file === "mise.toml")!.from}\nbody of mise.toml\n`);
    commitAll("restore the anchor");
  });

  it("fails LOUDLY when a repoint file disappears from the private tree", () => {
    git(["rm", "-q", "packaging/VERIFY.md"]);
    const c = commitAll("delete a repoint file");
    expect(() => portCommits(repo, [c], "public", false)).toThrow(/repoint file packaging\/VERIFY\.md is missing/);
    write("packaging/VERIFY.md", `neighbor line above\n${REPOINTS.find((r) => r.file === "packaging/VERIFY.md")!.from}\nbody of packaging/VERIFY.md\n`);
    commitAll("restore the file");
  });

  it("ports a multi-commit batch in order, chaining parents", () => {
    write("src/app.ts", "export const x = 2;\n");
    const c1 = commitAll("bump x");
    write("src/app.ts", "export const x = 3;\n");
    const c2 = commitAll("bump x again");
    const { ported, head } = portCommits(repo, [c1, c2], "public", false);
    expect(ported).toHaveLength(2);
    expect(git(["rev-parse", `${head}^`]).trim()).toBe(ported[0]!.to);
    expect(git(["show", `${head}:src/app.ts`])).toContain("x = 3");
    git(["branch", "-f", "public", head]);
  });

  it("the exclusion predicate covers every private-only tree", () => {
    for (const p of EXCLUDED_PREFIXES) expect(isExcluded(`${p}anything.txt`)).toBe(true);
    expect(isExcluded(".DS_Store")).toBe(true);
    expect(isExcluded("packages/.DS_Store")).toBe(true);
    expect(isExcluded("src/app.ts")).toBe(false);
    expect(isExcluded("packages/core/src/index.ts")).toBe(false);
  });
});
