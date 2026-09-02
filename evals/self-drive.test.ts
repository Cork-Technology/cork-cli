// The offline WINNABILITY gate for the eval task set: every task has a built-in play, and every
// play grades PASS through the suite's own execution and grader (runTool + stubContext +
// gradeTask). Before this, a task could be unwinnable for every agent — an expectation nobody
// can satisfy, an answer regex that rejects the true answer, a fixture that drifted — and the
// only place it showed was a lower Layer-B score, read as a model weakness (the venue-orderbook
// regression sat there for five weeks). Now it fails here, offline, before any model tokens are
// spent. This asserts coherence of the SUITE, not model performance: the plays are canonical
// calls with ground-truth answers, not transcripts.
import { describe, expect, it } from "vitest";
import { gradeTask } from "./run.ts";
import { TASKS } from "./tasks.ts";
import { PLAYS, playTask } from "./self-drive-plays.ts";

describe("eval self-drive: every task is winnable offline", () => {
  const byId = new Map(PLAYS.map((p) => [p.id, p]));

  it("every task has exactly one built-in play, and every play names a task (no orphans either way)", () => {
    const taskIds = TASKS.map((t) => t.id);
    const playIds = PLAYS.map((p) => p.id);
    expect(playIds.length).toBe(new Set(playIds).size);
    expect([...taskIds].sort()).toEqual([...playIds].sort());
  });

  for (const task of TASKS) {
    it(`${task.id}${task.heldOut ? " [held-out]" : ""}: the canonical play passes every graded axis within budget`, async () => {
      const play = byId.get(task.id);
      expect(play, `no play for task '${task.id}' — add one to self-drive-plays.ts`).toBeDefined();
      const { trace, digests } = await playTask(play!, "grade");
      const v = gradeTask(task, trace, play!.finalText ?? "");
      const why = `\n${digests.join("\n")}\naxes: tool:${v.toolPick} params:${v.paramsOk} state:${v.statePass} answer:${v.answerPass} safe:${v.safe} steps:${v.stepsRan} efficient:${v.efficient}`;
      expect(v.ok, why).toBe(true);
      expect(v.efficient, `over budget: ${trace.length} calls > ${task.expect.maxCalls}${why}`).toBe(true);
    });
  }
});
