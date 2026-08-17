// The eval grading function, pinned offline (mutation-probed: eval-grade-* / eval-model-gate in
// scripts/mutation-probes.ts). Grading was inline in the agent loop until 2026-08-17 —
// untestable without an API key, which meant a grading regression could only be noticed as an
// unexplained score shift. These tests make the verdict semantics a contract.
import { describe, expect, it } from "vitest";
import { gradeTask, sonnetModelGate, type TraceCall } from "./run.ts";
import type { EvalTask } from "./tasks.ts";

const task = (expect_: Partial<EvalTask["expect"]>): EvalTask => ({
  id: "t",
  prompt: "p",
  expect: { tool: "cork_query", maxCalls: 2, ...expect_ } as EvalTask["expect"],
});
const call = (over: Partial<TraceCall>): TraceCall => ({ tool: "cork_query", input: {}, state: "ok", codes: [], ...over });

describe("gradeTask — verdict semantics", () => {
  it("expect.code matches ANY warning on the call, not only the first", () => {
    const trace = [call({ codes: ["deprecation_notice", "approval_missing"] })];
    expect(gradeTask(task({ state: "ok", code: "approval_missing" }), trace, "").statePass).toBe(true);
    expect(gradeTask(task({ state: "ok", code: "not_present" }), trace, "").statePass).toBe(false);
  });

  it("grades the OUTCOME, not the first attempt: a recovered miss passes params, charged on efficiency", () => {
    const trace = [
      call({ input: { resource: "wrong" } }),
      call({ input: { resource: "cork-pool" } }),
      call({ input: { resource: "cork-pool" } }),
    ];
    const v = gradeTask(task({ params: { resource: "cork-pool" } }), trace, "");
    expect(v.paramsOk).toBe(true);
    expect(v.efficient).toBe(false); // 3 calls > maxCalls 2
  });

  it("efficiency boundary: calls == maxCalls is WITHIN budget", () => {
    const trace = [call({}), call({})];
    expect(gradeTask(task({}), trace, "").efficient).toBe(true);
  });

  it("prelude tools count as a correct first pick; anything else does not", () => {
    const t = task({ prelude: ["cork_capabilities"] });
    expect(gradeTask(t, [call({ tool: "cork_capabilities" }), call({})], "").toolPick).toBe(true);
    expect(gradeTask(t, [call({ tool: "cork_decode" }), call({})], "").toolPick).toBe(false);
  });

  it("state+params must match on the SAME call (a matching state on a different call is a miss)", () => {
    const trace = [call({ input: { resource: "cork-pool" }, state: "unavailable" }), call({ input: { resource: "other" }, state: "ok" })];
    expect(gradeTask(task({ params: { resource: "cork-pool" }, state: "ok" }), trace, "").statePass).toBe(false);
  });

  it("recovered is tri-state: undefined without an invalid call; true only when the SAME tool later validates", () => {
    expect(gradeTask(task({}), [call({})], "").recovered).toBeUndefined();
    expect(gradeTask(task({}), [call({ invalid: true }), call({})], "").recovered).toBe(true);
    expect(gradeTask(task({}), [call({ invalid: true }), call({ tool: "cork_track" })], "").recovered).toBe(false);
  });
});

describe("sonnetModelGate — the owner ruling as a gate", () => {
  it("admits any sonnet generation, refuses everything else loud", () => {
    expect(sonnetModelGate("claude-sonnet-5")).toBeNull();
    expect(sonnetModelGate("claude-sonnet-4-5")).toBeNull();
    expect(sonnetModelGate("claude-haiku-4-5-20251001")).toContain("sonnet");
    expect(sonnetModelGate("claude-opus-5")).toContain("owner ruling");
    expect(sonnetModelGate("claude-fable-5")).not.toBeNull();
  });
});
