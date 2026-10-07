// The verdict of a WHOLE test run, decided from vitest's JSON report against the set of files the
// run was supposed to execute — never from the exit code or the console.
//
// Why: on 2026-10-07 the CI step `bun run test` (vitest on Bun) printed the banner, ONE file
// (packages/core/test/venue.test.ts, 100 tests, 588 ms), no summary, and exited 0 after 3 s
// (cork-cli-private run 37622917869). The step passed. Every other file of the suite never ran.
// An exit code says "nothing I ran failed"; it cannot say "I ran everything". So the gate holds the
// report to the file set vitest itself discovered before the run: every discovered file must have
// a result, no test may fail, no file may error at load, and at least one test must have run.
// The same rule hardens the mutation baseline (scripts/mutation-probes.ts), whose "green" used to
// mean only "some tests ran and none failed".
//
// What a file status means in vitest's JSON reporter (measured on 3.2.7): a file whose tests all
// skip (describe.skip) is `passed`; a file with a failing test is `failed`; a file that throws at
// import is `failed` with the error as `message` and contributes to numFailedTestSuites. And
// `numTotalTests` COUNTS SKIPPED tests, so "tests ran" is passed + failed, never the total: a
// suite in which every test is skipped exits 0 and must still be red.
import type { VitestJsonReport } from "./mutation-verdict.ts";

export interface SuiteVerdict {
  ok: boolean;
  /** One sentence, for the log line. */
  reason: string;
  /** Discovered files with no result in the report — the 2026-10-07 shape, 105 of 106. */
  missing: string[];
  /** Files in the report that were not discovered — a report from another run, or a glob drift. */
  unexpected: string[];
  /** Files whose result is `failed` (a failing test, or an error at load). */
  failedFiles: string[];
}

/** Tests that actually EXECUTED: passed + failed. vitest's numTotalTests includes skipped
 *  (pending) tests; a report from before the counter existed is judged on the total. */
export function executedTests(report: VitestJsonReport): number {
  return report.numPassedTests === undefined ? report.numTotalTests : report.numPassedTests + report.numFailedTests;
}

/** Judge a run. `expectedFiles` are the absolute paths vitest discovered for this run (its own
 *  glob, taken BEFORE the run); the report's `testResults[].name` are absolute paths too. */
export function suiteVerdict(report: VitestJsonReport | undefined, exitCode: number, expectedFiles: readonly string[]): SuiteVerdict {
  const none = { missing: [] as string[], unexpected: [] as string[], failedFiles: [] as string[] };
  if (!report) return { ok: false, reason: `vitest wrote no JSON report (exit ${String(exitCode)}) — nothing can be judged, so nothing passed`, ...none };
  if (expectedFiles.length === 0) return { ok: false, reason: "vitest discovered no test files — an empty run cannot be green (check the include globs and the working directory)", ...none };
  const expected = new Set(expectedFiles);
  const reported = new Set(report.testResults.map((f) => f.name));
  const missing = expectedFiles.filter((f) => !reported.has(f));
  const unexpected = [...reported].filter((f) => !expected.has(f));
  const failedFiles = report.testResults.filter((f) => f.status === "failed").map((f) => f.name);
  const verdict = { missing, unexpected, failedFiles };
  if (missing.length > 0) {
    return { ok: false, reason: `${String(missing.length)} of ${String(expectedFiles.length)} discovered test file(s) have NO result — vitest stopped before running them (exit ${String(exitCode)}, ${String(report.numTotalTests)} test(s) ran)`, ...verdict };
  }
  if (unexpected.length > 0) {
    return { ok: false, reason: `${String(unexpected.length)} reported file(s) were not discovered for this run — the report does not describe this run`, ...verdict };
  }
  if (report.numFailedTests > 0) return { ok: false, reason: `${String(report.numFailedTests)} failing test(s); ${String(failedFiles.length)} file(s) failed`, ...verdict };
  if (report.numFailedTestSuites > 0 || failedFiles.length > 0) {
    return { ok: false, reason: `${String(Math.max(report.numFailedTestSuites, failedFiles.length))} file(s) errored without a failing test (an error at load or in a hook)`, ...verdict };
  }
  const ran = executedTests(report);
  if (ran === 0) return { ok: false, reason: `no test executed across the discovered files (${String(report.numTotalTests)} known, all skipped)`, ...verdict };
  if (exitCode !== 0) return { ok: false, reason: `every file has a green result but vitest exited ${String(exitCode)} — an unhandled error or a teardown failure outside any test`, ...verdict };
  return { ok: true, reason: `${String(ran)} tests ran across ${String(expectedFiles.length)} files, every discovered file reported, none failed`, ...verdict };
}
