// Task-set hygiene: structural invariants that make a task GRADE what it claims to grade.
// These are cheap and offline, and they close a specific silent-failure class: an expectation
// that can never fire. `forbid: ["cork_sumbit"]` (typo) never matches a call, so the safety
// axis reports green forever; a duplicate id makes CORK_EVAL_ONLY ambiguous and double-counts
// a task in the summary. Neither shows up as a failure — they show up as false confidence.
import { describe, expect, it } from "vitest";
import { REGISTRY } from "@cork/schemas";
import { TASKS } from "./tasks.ts";

const TOOL_NAMES = new Set(REGISTRY.map((t) => t.name));

describe("eval task set hygiene", () => {
  it("task ids are unique (a duplicate breaks CORK_EVAL_ONLY and double-counts the summary)", () => {
    const ids = TASKS.map((t) => t.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("every tool named by an expectation EXISTS — a typo would make the axis silently inert", () => {
    for (const t of TASKS) {
      const named = [t.expect.tool, ...(t.expect.prelude ?? []), ...(t.expect.forbid ?? []), ...(t.expect.require ?? [])];
      for (const name of named) {
        expect(TOOL_NAMES, `task '${t.id}' names an unknown tool '${name}'`).toContain(name);
      }
    }
  });

  it("no task both requires a step and accepts a zero-call clarification (self-contradictory)", () => {
    // The clarify short-circuit passes on ZERO calls; a required step cannot have run then.
    // Declaring both would make one of the two unreachable, silently.
    for (const t of TASKS) {
      expect(!(t.expect.clarify && (t.expect.require?.length ?? 0) > 0), `task '${t.id}'`).toBe(true);
    }
  });

  it("a forbidden tool is never also the graded tool or a prelude (that task could never pass)", () => {
    for (const t of TASKS) {
      const forbidden = new Set(t.expect.forbid ?? []);
      expect(forbidden.has(t.expect.tool), `task '${t.id}' forbids its own graded tool`).toBe(false);
      for (const p of t.expect.prelude ?? []) {
        expect(forbidden.has(p), `task '${t.id}' forbids its own prelude tool '${p}'`).toBe(false);
      }
    }
  });

  it("every task has a positive call budget and a non-empty prompt", () => {
    for (const t of TASKS) {
      expect(t.expect.maxCalls, `task '${t.id}'`).toBeGreaterThan(0);
      expect(t.prompt.trim().length, `task '${t.id}'`).toBeGreaterThan(0);
    }
  });
});
