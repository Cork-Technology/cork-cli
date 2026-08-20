// Port private commits to the public tree (cork-helper-cli → cork-cli) as a PURE FUNCTION of the
// private tree — no patches, so no context fragility. Born from three real failures of the ad-hoc
// procedure (2026-08-09/10): a rev-list over disjoint histories replayed the whole private log; a
// patch whose context brushed a sanctioned strip line failed atomically and an EMPTY commit was
// pushed with a message claiming content it lacked; and the shell's error handling silently kept
// going. This script replaces all of that with:
//
//   publicTree(commit) = privateTree(commit)  minus EXCLUDED paths  with REPOINTS substituted
//
// Guarantees, each enforced (not assumed):
//   - Every REPOINTS anchor must be found in exactly its private or public form — a reworded
//     private line fails LOUDLY (drift detection) instead of silently un-repointing the port.
//   - The fidelity gate runs BEFORE anything is reported: the ported tree may differ from the
//     private commit (outside EXCLUDED) by exactly the REPOINTS lines — nothing else.
//   - Commits whose transform equals the running parent tree (excluded-only commits) are skipped.
//   - New `notes/`-reference lines entering public files are surfaced as a warning (bootstrap
//     rule: strip or keep deliberately, never unknowingly).
//   - This script NEVER pushes and NEVER moves refs; it prints verified commit SHAs and the exact
//     push command. Signing (-S, one key touch per commit) is opt-in via --sign.
//
//   bun scripts/port-to-public.ts [--base cork-cli/main] [--sign] <commit>...
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Paths that exist only in the private tree. Prefix match on repo-relative paths. */
export const EXCLUDED_PREFIXES = ["notes/", "experiments/", "rfc/", "misc/", "slack-drafts"] as const;
export const EXCLUDED_FILES = [".DS_Store"] as const;

/** The sanctioned private→public line substitutions. `from` must appear (or `to` already —
 *  idempotence) in each listed file, or the port fails loudly: a reworded private line means
 *  this table needs a deliberate update, not a silent pass-through. */
export const REPOINTS: ReadonlyArray<{ file: string; from: string; to: string }> = [
  {
    file: ".github/workflows/apk-repo.yml",
    from: "# apk-repository + OCI-image channel (notes/single-binary-release-plan.md, stages 1-2).",
    to: "# apk-repository + OCI-image channel.",
  },
  {
    file: ".github/workflows/build-binaries.yml",
    from: "# Reusable single-binary build (notes/single-binary-release-plan.md). Holding the build steps in",
    to: "# Reusable single-binary build. Holding the build steps in",
  },
  {
    file: ".github/workflows/release.yml",
    from: "# Tag-driven single-binary release (notes/single-binary-release-plan.md).",
    to: "# Tag-driven single-binary release.",
  },
  {
    file: "mise.toml",
    from: "# the Bun version is part of the reproducible-build statement (notes/single-binary-release-plan.md).",
    to: "# the Bun version is part of the reproducible-build statement.",
  },
  {
    file: "packages/core/src/config-remote.ts",
    from: '  "https://raw.githubusercontent.com/Cork-Technology/cork-helper-cli/main/cork-defaults.json";',
    to: '  "https://raw.githubusercontent.com/Cork-Technology/cork-cli/main/cork-defaults.json";',
  },
  {
    file: "packaging/VERIFY.md",
    from: "4. Sign off the **LICENSE** (Apache-2.0 analysis in notes/single-binary-release-plan.md).",
    to: "4. Sign off the **LICENSE** (Apache-2.0).",
  },
  {
    file: "packaging/melange.yaml",
    from: "# (notes/single-binary-release-plan.md). Built per release tag by .github/workflows/apk-repo.yml:",
    to: "#. Built per release tag by .github/workflows/apk-repo.yml:",
  },
  {
    file: "scripts/compile-binaries.mjs",
    from: "// Invariants this script owns (notes/single-binary-release-plan.md):",
    to: "// Invariants this script owns:",
  },
];

function git(repo: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function isExcluded(path: string): boolean {
  if (EXCLUDED_FILES.some((f) => path === f || path.endsWith(`/${f}`))) return true;
  return EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
}

/** Build the public tree for one private commit inside a throwaway index. */
export function transformTree(repo: string, privateCommit: string, indexFile: string): { tree: string; warnings: string[] } {
  const warnings: string[] = [];
  const env = { GIT_INDEX_FILE: indexFile };
  git(repo, ["read-tree", `${privateCommit}^{tree}`], { env });

  // Drop the private-only paths.
  const listed = git(repo, ["ls-files"], { env }).split("\n").filter(Boolean);
  const toDrop = listed.filter(isExcluded);
  if (toDrop.length > 0) {
    git(repo, ["update-index", "--force-remove", "--stdin"], { env, input: toDrop.join("\n") + "\n" });
  }

  // Apply the repoint substitutions, loudly.
  for (const r of REPOINTS) {
    let content: string;
    try {
      content = git(repo, ["show", `${privateCommit}:${r.file}`]);
    } catch {
      throw new Error(`repoint file ${r.file} is missing from ${privateCommit} — if it was renamed or deleted deliberately, update REPOINTS first`);
    }
    if (content.includes(r.to) && !content.includes(r.from)) continue; // already public form (idempotence)
    if (!content.includes(r.from)) {
      throw new Error(`repoint anchor not found in ${r.file} at ${privateCommit}:\n  expected: ${r.from}\nThe private line was reworded — update REPOINTS deliberately, then re-run`);
    }
    const replaced = content.replace(r.from, r.to);
    const blob = git(repo, ["hash-object", "-w", "--stdin"], { input: replaced }).trim();
    git(repo, ["update-index", "--cacheinfo", `100644,${blob},${r.file}`], { env });
  }

  const tree = git(repo, ["write-tree"], { env }).trim();

  // Fidelity gate: outside EXCLUDED, the ported tree differs from the private commit by exactly
  // the REPOINTS lines. Anything else is a transform bug — fail before anyone can push it.
  const diff = git(repo, ["diff", "--name-only", `${privateCommit}^{tree}`, tree]).split("\n").filter(Boolean);
  const unexpected = diff.filter((p) => !isExcluded(p) && !REPOINTS.some((r) => r.file === p));
  if (unexpected.length > 0) {
    throw new Error(`fidelity gate: ported tree differs from ${privateCommit} outside the sanctioned set:\n  ${unexpected.join("\n  ")}`);
  }
  for (const r of REPOINTS) {
    if (!diff.includes(r.file)) continue; // untouched relative to private (already-public content)
    const fileDiff = git(repo, ["diff", `${privateCommit}^{tree}`, tree, "--", r.file]);
    const changed = fileDiff.split("\n").filter((l) => /^[-+][^-+]/.test(l));
    const expected = new Set([`-${r.from}`, `+${r.to}`]);
    const extra = changed.filter((l) => !expected.has(l));
    if (extra.length > 0) {
      throw new Error(`fidelity gate: ${r.file} changed beyond its sanctioned repoint line:\n  ${extra.join("\n  ")}`);
    }
  }
  return { tree, warnings };
}

/** Warn on NEW notes/-reference lines entering the public tree (vs the public parent). */
function noteLeakWarnings(repo: string, parentTree: string, tree: string): string[] {
  const diff = git(repo, ["diff", parentTree, tree]);
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++") && l.includes("notes/"));
  return added.length > 0 ? [`new notes/-reference line(s) entering the public tree — keep deliberately or strip:\n  ${added.join("\n  ")}`] : [];
}

/** Release policy G8 (cork-knowledge policies/releases/github-release-process.md): no AI
 *  co-author trailer on a public commit. A private commit may still carry one (older tooling
 *  added it); the port drops those lines so the public history complies mechanically. Human
 *  co-authors are kept. */
export const AI_COAUTHOR_TRAILER = /^co-authored-by:\s*.*\b(claude|anthropic|copilot|chatgpt|openai|gemini|cursor)\b.*$/i;
export function stripAiTrailers(message: string): string {
  const lines = message.split("\n").filter((l) => !AI_COAUTHOR_TRAILER.test(l.trim()));
  // Collapse the blank run a removed trailer block leaves at the end; keep one final newline.
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

export function portCommits(repo: string, commits: string[], base: string, sign: boolean): { head: string; ported: Array<{ from: string; to: string }>; skipped: string[] } {
  const indexFile = join(mkdtempSync(join(tmpdir(), "port-index-")), "index");
  try {
    let parent = git(repo, ["rev-parse", base]).trim();
    const ported: Array<{ from: string; to: string }> = [];
    const skipped: string[] = [];
    for (const c of commits) {
      const commit = git(repo, ["rev-parse", c]).trim();
      const { tree } = transformTree(repo, commit, indexFile);
      const parentTree = git(repo, ["rev-parse", `${parent}^{tree}`]).trim();
      if (tree === parentTree) {
        skipped.push(commit);
        continue;
      }
      for (const w of noteLeakWarnings(repo, parentTree, tree)) console.warn(`WARN ${commit.slice(0, 7)}: ${w}`);
      const fmt = (f: string) => git(repo, ["log", "-1", `--format=${f}`, commit]).trim();
      const message = stripAiTrailers(git(repo, ["log", "-1", "--format=%B", commit]));
      const newCommit = git(repo, ["commit-tree", tree, "-p", parent, ...(sign ? ["-S"] : [])], {
        input: message,
        env: {
          GIT_AUTHOR_NAME: fmt("%an"),
          GIT_AUTHOR_EMAIL: fmt("%ae"),
          GIT_AUTHOR_DATE: fmt("%aI"),
          GIT_COMMITTER_NAME: fmt("%cn"),
          GIT_COMMITTER_EMAIL: fmt("%ce"),
          GIT_COMMITTER_DATE: fmt("%cI"),
        },
      }).trim();
      if (sign) {
        const sig = git(repo, ["log", "--show-signature", "-1", newCommit]);
        if (!sig.includes('Good "git" signature')) {
          throw new Error(`signature on ${newCommit} did not verify as Good — refusing to continue (the FIDO middleware returns zero-filled signatures with a clean exit when untouched)`);
        }
      }
      ported.push({ from: commit, to: newCommit });
      parent = newCommit;
    }
    return { head: parent, ported, skipped };
  } finally {
    rmSync(join(indexFile, ".."), { recursive: true, force: true });
  }
}

const isMain = process.argv[1]?.endsWith("port-to-public.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const sign = args.includes("--sign");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx !== -1 ? args[baseIdx + 1]! : "cork-cli/main";
  const commits = args.filter((a, i) => !a.startsWith("--") && i !== baseIdx + 1);
  if (commits.length === 0) {
    console.error("usage: bun scripts/port-to-public.ts [--base cork-cli/main] [--sign] <commit>...");
    process.exit(1);
  }
  try {
    const { head, ported, skipped } = portCommits(process.cwd(), commits, base, sign);
    for (const p of ported) console.log(`ported ${p.from.slice(0, 7)} -> ${p.to}`);
    for (const s of skipped) console.log(`skipped ${s.slice(0, 7)} (excluded-only)`);
    console.log(`\nverified head: ${head}`);
    console.log(`push with:  git push cork-cli ${head}:refs/heads/main`);
  } catch (err) {
    console.error(`PORT FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
