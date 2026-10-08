// The fail-closed test step for CI: run the vitest suite through its programmatic API and judge
// the run from the JSON report against the file set vitest discovered — never from the exit code.
//
//   bun scripts/test-gate.ts [vitest filters…]      # what CI's "Tests" step runs (`bun run test:ci`)
//
// Why not `vitest run` and its exit code (the previous step): on 2026-10-07 vitest on Bun printed
// one file and exited 0 after 3 s with no summary; 105 files never ran and the step passed.
// Two things change here, each sufficient on its own:
//   1. the verdict (scripts/suite-verdict.ts) requires EVERY discovered file to carry a result,
//      so a run that stops early is red whatever the exit code;
//   2. the run is driven through `createVitest` → `globTestSpecifications` → `start` → `close`,
//      each awaited, instead of the CLI entry whose process exit raced its own workers.
// The default reporter still streams to the console, so the CI log reads as before; the JSON
// reporter writes the report the verdict reads. Nothing here is specific to CI: the gate runs
// anywhere `bun run test` does.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVitest } from "vitest/node";
import type { VitestJsonReport } from "./mutation-verdict.ts";
import { suiteVerdict } from "./suite-verdict.ts";

const filters = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "cork-test-gate-"));
const reportPath = join(dir, "report.json");
let exitCode = 1;
let report: VitestJsonReport | undefined;
let expected: string[] = [];
try {
  // `run: true` = no watch; reporters: the console one for humans, the JSON one for the verdict.
  const vitest = await createVitest("test", { run: true, reporters: ["default", "json"], outputFile: { json: reportPath } });
  try {
    // The file set is taken BEFORE the run from vitest's own glob — the authority on what this
    // run must execute; a report that covers fewer files is a run that stopped early.
    expected = (await vitest.globTestSpecifications(filters)).map((s) => s.moduleId);
    await vitest.start(filters);
    exitCode = process.exitCode === undefined ? 0 : Number(process.exitCode);
  } finally {
    await vitest.close();
  }
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJsonReport;
  } catch {
    report = undefined;
  }
} catch (err) {
  // A failed start (config error, no files) leaves `report` undefined: the verdict is red and
  // says so; the cause rides on stderr.
  console.error(`test-gate: vitest did not complete — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const verdict = suiteVerdict(report, exitCode, expected);
const detail = [
  ...verdict.missing.slice(0, 20).map((f) => `  missing  ${f}`),
  ...(verdict.missing.length > 20 ? [`  … and ${String(verdict.missing.length - 20)} more missing`] : []),
  ...verdict.unexpected.slice(0, 20).map((f) => `  unexpected ${f}`),
  ...verdict.failedFiles.slice(0, 20).map((f) => `  failed   ${f}`),
];
console.log(`\ntest-gate: ${verdict.ok ? "GREEN" : "RED"} — ${verdict.reason}`);
for (const line of detail) console.log(line);
process.exit(verdict.ok ? 0 : 1);
