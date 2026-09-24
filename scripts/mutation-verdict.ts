// The verdict of one mutant, decided from vitest's JSON report — not from the exit code.
//
// Why: a non-zero vitest exit also happens when the suite FAILS TO LOAD (2026-09-23: on a
// Node-less host vitest ran on Bun, `import { z } from "zod"` came back undefined under vite-
// node's default interop, most files errored at load, and the exit-code rule counted every one
// of 600 mutants "caught" in nine minutes). "Caught" must mean a TEST RAN AND FAILED. A run in
// which no test executed, or in which only suites (files) errored without a single assertion
// failing, is INCONCLUSIVE — reported as such and failing the catalogue, never a kill.
//
// One exception keeps a legitimate kill: a suite error whose message names the MUTATED file is
// the mutant breaking its own module at load (a syntax- or import-level mutation), which the
// suite did detect; that counts as caught.
export interface VitestJsonReport {
  numTotalTests: number;
  numFailedTests: number;
  numFailedTestSuites: number;
  testResults: ReadonlyArray<{ name: string; status: string; message?: string }>;
}

export type Verdict = "caught" | "survived" | "inconclusive";

export function verdictOf(report: VitestJsonReport | undefined, exitCode: number, mutatedFile: string): { verdict: Verdict; reason: string } {
  if (!report) return { verdict: "inconclusive", reason: `vitest wrote no JSON report (exit ${String(exitCode)}) — the runner could not tell a kill from a broken run` };
  if (report.numFailedTests > 0) return { verdict: "caught", reason: `${String(report.numFailedTests)} test(s) failed` };
  const ownLoadFailure = report.testResults.find((f) => f.status === "failed" && (f.message ?? "").includes(mutatedFile));
  if (ownLoadFailure) return { verdict: "caught", reason: `the mutated module ${mutatedFile} failed to load: ${(ownLoadFailure.message ?? "").split("\n")[0]?.slice(0, 120) ?? ""}` };
  if (report.numTotalTests === 0) return { verdict: "inconclusive", reason: "no test executed — the suite failed to load (a runtime/interop fault, not a kill)" };
  if (exitCode !== 0 || report.numFailedTestSuites > 0) return { verdict: "inconclusive", reason: `${String(report.numFailedTestSuites)} suite(s) errored without a failing test (exit ${String(exitCode)})` };
  return { verdict: "survived", reason: `${String(report.numTotalTests)} test(s) ran, none failed` };
}

/** The baseline is green only when tests RAN and none failed; a load failure is red with its reason. */
export function baselineOk(report: VitestJsonReport | undefined, exitCode: number): { ok: boolean; reason: string } {
  if (!report) return { ok: false, reason: `vitest wrote no JSON report (exit ${String(exitCode)})` };
  if (report.numTotalTests === 0) return { ok: false, reason: "no test executed — the suite failed to load in the sandbox" };
  if (report.numFailedTests > 0 || report.numFailedTestSuites > 0 || exitCode !== 0) return { ok: false, reason: `${String(report.numFailedTests)} failing test(s), ${String(report.numFailedTestSuites)} errored suite(s), exit ${String(exitCode)}` };
  return { ok: true, reason: `${String(report.numTotalTests)} tests green` };
}
