// A suite is green only when EVERY discovered file reported and nothing failed. Pinned against
// the 2026-10-07 shape (one file ran, exit 0, no summary) so an exit code can never pass the
// tests step again. File statuses as vitest 3.2.7's JSON reporter emits them (measured):
// all-skipped file → passed; failing test → failed; throw at import → failed + numFailedTestSuites.
import { describe, expect, it } from "vitest";
import type { VitestJsonReport } from "./mutation-verdict.ts";
import { suiteVerdict } from "./suite-verdict.ts";

const FILES = Array.from({ length: 106 }, (_, i) => `/ci/packages/core/test/f${String(i)}.test.ts`);
const results = (files: readonly string[], status = "passed"): VitestJsonReport["testResults"] => files.map((name) => ({ name, status }));
// numPassedTests defaults to total − failed (every known test ran), as vitest reports a run with
// nothing skipped; tests about skipping set it explicitly.
const rep = (o: Partial<VitestJsonReport>): VitestJsonReport => ({ numTotalTests: 0, numFailedTests: 0, numFailedTestSuites: 0, testResults: [], ...o, numPassedTests: o.numPassedTests ?? (o.numTotalTests ?? 0) - (o.numFailedTests ?? 0) });

describe("suiteVerdict", () => {
  it("RED: the 2026-10-07 run — one file of 106 reported, 100 tests green, exit 0 (run 37622917869)", () => {
    const v = suiteVerdict(rep({ numTotalTests: 100, testResults: results([FILES[0]!]) }), 0, FILES);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("105 of 106 discovered test file(s) have NO result");
    expect(v.reason).toContain("exit 0");
    expect(v.missing).toHaveLength(105);
    expect(v.missing).not.toContain(FILES[0]);
    expect(v.failedFiles).toEqual([]);
  });

  it("GREEN: every discovered file reported, tests ran, none failed, exit 0", () => {
    const v = suiteVerdict(rep({ numTotalTests: 2379, testResults: results(FILES) }), 0, FILES);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("2379 tests ran across 106 files, every discovered file reported, none failed");
    expect(v.missing).toEqual([]);
    expect(v.unexpected).toEqual([]);
  });

  it("GREEN with files whose tests all skip (status passed, counted in numTotalTests but not in numPassedTests) — the network suites' self-skip", () => {
    const v = suiteVerdict(rep({ numTotalTests: 60, numPassedTests: 10, testResults: results(FILES) }), 0, FILES);
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("10 tests ran");
  });

  it("RED: every test skipped — vitest exits 0 and numTotalTests is non-zero, but nothing RAN", () => {
    const v = suiteVerdict(rep({ numTotalTests: 60, numPassedTests: 0, testResults: results(FILES) }), 0, FILES);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("no test executed across the discovered files (60 known, all skipped)");
  });

  it("a report without numPassedTests (an older shape) is judged on the total", () => {
    const old: VitestJsonReport = { numTotalTests: 5, numFailedTests: 0, numFailedTestSuites: 0, testResults: results(FILES) };
    expect(suiteVerdict(old, 0, FILES).ok).toBe(true);
    expect(suiteVerdict({ ...old, numTotalTests: 0 }, 0, FILES).ok).toBe(false);
  });

  it("RED: a failing test, even when every file reported", () => {
    const r = rep({ numTotalTests: 2379, numFailedTests: 1, testResults: [...results(FILES.slice(1)), { name: FILES[0]!, status: "failed" }] });
    const v = suiteVerdict(r, 1, FILES);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("1 failing test(s); 1 file(s) failed");
    expect(v.failedFiles).toEqual([FILES[0]]);
  });

  it("RED: a file that errored at load — no failing TEST, but a failed file and numFailedTestSuites", () => {
    const r = rep({ numTotalTests: 2000, numFailedTestSuites: 1, testResults: [...results(FILES.slice(1)), { name: FILES[0]!, status: "failed", message: "boom at load" }] });
    const v = suiteVerdict(r, 1, FILES);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("errored without a failing test");
    expect(v.failedFiles).toEqual([FILES[0]]);
  });

  it("RED: a failed file status alone (numFailedTestSuites 0) still fails — the file list is judged, not only the counters", () => {
    const r = rep({ numTotalTests: 2000, testResults: [...results(FILES.slice(1)), { name: FILES[0]!, status: "failed" }] });
    expect(suiteVerdict(r, 0, FILES).ok).toBe(false);
  });

  it("RED: no test executed although every file reported", () => {
    const v = suiteVerdict(rep({ numTotalTests: 0, testResults: results(FILES) }), 0, FILES);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("no test executed");
  });

  it("RED: green files but a non-zero exit (an error outside any test)", () => {
    const v = suiteVerdict(rep({ numTotalTests: 5, testResults: results(FILES) }), 1, FILES);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("exited 1");
  });

  it("RED: a report naming a file vitest did not discover — the report is not this run's", () => {
    const v = suiteVerdict(rep({ numTotalTests: 5, testResults: results([...FILES, "/ci/other/stray.test.ts"]) }), 0, FILES);
    expect(v.ok).toBe(false);
    expect(v.unexpected).toEqual(["/ci/other/stray.test.ts"]);
  });

  it("RED: no report, and RED: nothing discovered — an empty run is never green", () => {
    expect(suiteVerdict(undefined, 0, FILES).ok).toBe(false);
    expect(suiteVerdict(undefined, 0, FILES).reason).toContain("no JSON report");
    expect(suiteVerdict(rep({ numTotalTests: 0 }), 0, []).ok).toBe(false);
    expect(suiteVerdict(rep({ numTotalTests: 0 }), 0, []).reason).toContain("discovered no test files");
  });

  it("the missing check comes first: a truncated run with a failing test is reported as truncated (the bigger lie)", () => {
    const r = rep({ numTotalTests: 3, numFailedTests: 1, testResults: [{ name: FILES[0]!, status: "failed" }] });
    expect(suiteVerdict(r, 1, FILES).reason).toContain("NO result");
  });
});
