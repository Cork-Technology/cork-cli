// A kill is a TEST THAT RAN AND FAILED. Pinned so an exit code alone can never fake "caught" again.
import { describe, expect, it } from "vitest";
import { baselineOk, verdictOf, type VitestJsonReport } from "./mutation-verdict.ts";

const rep = (o: Partial<VitestJsonReport>): VitestJsonReport => ({ numTotalTests: 0, numFailedTests: 0, numFailedTestSuites: 0, testResults: [], ...o });
const FILE = "packages/core/src/generations.ts";

describe("verdictOf", () => {
  it("caught: at least one test ran and failed", () => {
    expect(verdictOf(rep({ numTotalTests: 40, numFailedTests: 1 }), 1, FILE).verdict).toBe("caught");
  });
  it("survived: tests ran, none failed, clean exit", () => {
    expect(verdictOf(rep({ numTotalTests: 40 }), 0, FILE).verdict).toBe("survived");
  });
  it("INCONCLUSIVE, never caught: no test executed (the 2026-09-23 Node-less-host shape — every file errored at load, exit 1)", () => {
    const r = verdictOf(rep({ numTotalTests: 0, numFailedTestSuites: 12, testResults: [{ name: "a.test.ts", status: "failed", message: "TypeError: Cannot read properties of undefined (reading 'object')" }] }), 1, FILE);
    expect(r.verdict).toBe("inconclusive");
    expect(r.reason).toContain("no test executed");
  });
  it("INCONCLUSIVE: suites errored on something OTHER than the mutated module while no test failed", () => {
    const r = verdictOf(rep({ numTotalTests: 3, numFailedTestSuites: 1, testResults: [{ name: "b.test.ts", status: "failed", message: "Failed to resolve import zod" }] }), 1, FILE);
    expect(r.verdict).toBe("inconclusive");
  });
  it("caught: the MUTATED module itself failed to load (the suite detected the mutant at import)", () => {
    const r = verdictOf(rep({ numTotalTests: 0, numFailedTestSuites: 1, testResults: [{ name: "gen.test.ts", status: "failed", message: `SyntaxError in ${FILE}: unexpected token` }] }), 1, FILE);
    expect(r.verdict).toBe("caught");
  });
  it("INCONCLUSIVE: no report at all", () => {
    expect(verdictOf(undefined, 1, FILE).verdict).toBe("inconclusive");
  });
});

describe("baselineOk", () => {
  it("green only when tests RAN and none failed", () => {
    expect(baselineOk(rep({ numTotalTests: 100 }), 0).ok).toBe(true);
    expect(baselineOk(rep({ numTotalTests: 0 }), 0).ok).toBe(false); // exit 0 with nothing run is still red
    expect(baselineOk(rep({ numTotalTests: 100, numFailedTests: 1 }), 1).ok).toBe(false);
    expect(baselineOk(undefined, 0).ok).toBe(false);
  });
});
