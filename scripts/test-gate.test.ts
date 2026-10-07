// The CI tests step, end to end: `scripts/test-gate.ts` drives a REAL vitest run over small
// fixture projects (this repo's node_modules symlinked in) and must be red for every way a run
// can lie — a failing test, a file that throws at import, a run in which no test executed, an
// empty discovery — and green only when every discovered file reported and nothing failed.
// Nothing is mocked: each case is a real vitest process judged from its real JSON report.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE = resolve(import.meta.dirname, "test-gate.ts");
const NODE_MODULES = resolve(import.meta.dirname, "..", "node_modules");
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A vitest project under tmp: a config including `t/**` and the given test files. */
function project(files: Record<string, string>, include = '"t/**/*.test.ts"'): string {
  const root = mkdtempSync(join(tmpdir(), "cork-test-gate-fixture-"));
  roots.push(root);
  symlinkSync(NODE_MODULES, join(root, "node_modules"));
  writeFileSync(join(root, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: [${include}] } });\n`);
  mkdirSync(join(root, "t"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "t", name), body);
  return root;
}

const PASSING = 'import { it, expect } from "vitest";\nit("adds", () => { expect(1 + 1).toBe(2); });\n';
const SKIPPED = 'import { describe, it } from "vitest";\ndescribe.skip("net", () => { it("x", () => {}); });\n';
const FAILING = 'import { it, expect } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n';
const LOAD_ERROR = 'throw new Error("boom at load");\n';

function gate(cwd: string, ...filters: string[]): { status: number | null; out: string } {
  const r = spawnSync("bun", [GATE, ...filters], { cwd, encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("scripts/test-gate.ts — the fail-closed tests step", () => {
  it("GREEN: every discovered file reports (a self-skipping file included), tests ran, exit 0", () => {
    const r = gate(project({ "a.test.ts": PASSING, "b.test.ts": PASSING, "skipped.test.ts": SKIPPED }));
    expect(r.out).toContain("test-gate: GREEN — 2 tests ran across 3 files, every discovered file reported, none failed");
    expect(r.status).toBe(0);
  });

  it("RED: a failing test, naming the file", () => {
    const r = gate(project({ "a.test.ts": PASSING, "bad.test.ts": FAILING }));
    expect(r.out).toContain("test-gate: RED — 1 failing test(s); 1 file(s) failed");
    expect(r.out).toMatch(/failed {3}\S+\/t\/bad\.test\.ts/);
    expect(r.status).toBe(1);
  });

  it("RED: a file that throws at import (no failing test, a failed file)", () => {
    const r = gate(project({ "a.test.ts": PASSING, "load.test.ts": LOAD_ERROR }));
    expect(r.out).toContain("test-gate: RED —");
    expect(r.out).toContain("errored without a failing test");
    expect(r.out).toMatch(/failed {3}\S+\/t\/load\.test\.ts/);
    expect(r.status).toBe(1);
  });

  it("RED: every file reports but no test executed (an all-skipped suite exits 0 — the exit code would have passed it)", () => {
    const r = gate(project({ "skipped.test.ts": SKIPPED, "also-skipped.test.ts": SKIPPED }));
    expect(r.out).toContain("test-gate: RED — no test executed across the discovered files (2 known, all skipped)");
    expect(r.status).toBe(1);
  });

  it("RED: vitest discovers no files — an empty run is never green", () => {
    const r = gate(project({ "a.test.ts": PASSING }, '"nothing/**/*.test.ts"'));
    expect(r.out).toContain("test-gate: RED —");
    expect(r.out).toMatch(/discovered no test files|no JSON report/);
    expect(r.status).toBe(1);
  });

  it("filters narrow BOTH the discovery and the run — a filtered run is judged against the filtered set, not against everything", () => {
    const r = gate(project({ "a.test.ts": PASSING, "bad.test.ts": FAILING }), "t/a.test.ts");
    expect(r.out).toContain("test-gate: GREEN — 1 tests ran across 1 files, every discovered file reported, none failed");
    expect(r.status).toBe(0);
  });
});
