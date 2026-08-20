// The per-task NDJSON log exists because stdout is routinely piped/truncated — a `| tail` on the
// launch command destroyed the per-task evidence of a 31/33 run (2026-08-10) while the summary
// survived, leaving the two misses unidentifiable and the variance re-trial recipe (which needs
// task ids) unusable. These tests pin the row contract: every verdict bit the summary aggregates
// must survive into the durable row, and importing the runner must never fire an eval.
import { describe, expect, it } from "vitest";
import { evalLogRow } from "./run.ts";

const baseResult = {
  task: { id: "verify-pool", heldOut: false } as never,
  ok: false,
  toolPick: true,
  paramsOk: true,
  statePass: false,
  answerPass: true,
  efficient: false,
  safe: false,
  stepsRan: true,
  calls: 3,
  tokens: 81234,
  finalText: "x".repeat(3000),
  trace: [
    { tool: "cork_track", invalid: false, state: "conflict", codes: ["marketid_mismatch", "venue_reported"] },
    { tool: "cork_query", invalid: true },
  ],
} as never as Parameters<typeof evalLogRow>[0];

describe("eval per-task log row", () => {
  it("carries every verdict bit the summary aggregates — a miss must be reconstructible from the log alone", () => {
    const row = evalLogRow(baseResult, "claude-sonnet-5");
    // The exact fields the summary percentages are computed from, plus the id the re-trial
    // recipe needs (CORK_EVAL_ONLY=<id>): if any of these vanish from the row, a truncated
    // stdout again becomes the only record.
    expect(row).toMatchObject({
      id: "verify-pool",
      model: "claude-sonnet-5",
      ok: false,
      toolPick: true,
      paramsOk: true,
      statePass: false,
      answerPass: true,
      efficient: false,
      safe: false,
      stepsRan: true,
      calls: 3,
      tokens: 81234,
      cacheReadTokens: 0, // absent on the input → defaulted, never undefined (NDJSON contract)
    });
    // Trace rows render the same compact form the console FAIL line uses — one vocabulary
    // (every warning code rides, `+`-joined: expect.code grades against ANY of them).
    expect(row.trace).toEqual(["cork_track→conflict/marketid_mismatch+venue_reported", "cork_query!"]);
    // Bounded answer excerpt: enough to diagnose a failed answer-regex from the log alone
    // (400 cut a graded answer mid-table, 2026-08-17), never the transcript bulk.
    expect(row.finalText.length).toBe(2000);
    // recovered is tri-state (undefined = no invalid-call happened): absent, not null/false.
    expect("recovered" in row).toBe(false);
  });

  it("preserves recovered when the run had an invalid-call recovery", () => {
    const row = evalLogRow({ ...(baseResult as object), recovered: true } as never, "m");
    expect((row as { recovered?: boolean }).recovered).toBe(true);
  });

  it("the row is JSON-round-trippable (NDJSON contract — no bigints/undefined leak through)", () => {
    const row = evalLogRow(baseResult, "m");
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });
});
