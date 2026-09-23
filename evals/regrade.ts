// Re-grade a recorded run (an NDJSON log written by run.ts, CORK_EVAL_LOG) with the CURRENT
// graders. Why this exists: a grader-only change (a widened answer regex, the markdown-stripped
// view, a RegExp params expectation, `clarify`) must not cost a 75-minute model run to measure —
// the rows hold everything the grader reads: the final text, every call's input, and each call's
// tool / state / codes as the trace cell. The prompt and the tool surface are untouched by such
// a change, so re-grading the recorded evidence IS the measurement. Rows whose verdict changes
// are listed; nothing is rewritten.
//
//   bun evals/regrade.ts <log.jsonl>
import { readFileSync } from "node:fs";
import { TASKS } from "./tasks.ts";
import { gradeTask, type TraceCall } from "./run.ts";

/** Inverse of run.ts traceCell: `tool→state/code+code` | `tool!`. */
export function parseTraceCell(cell: string, input: unknown): TraceCall {
  if (cell.endsWith("!")) return { tool: cell.slice(0, -1), input, invalid: true };
  const arrow = cell.indexOf("→");
  const tool = arrow === -1 ? cell : cell.slice(0, arrow);
  const rest = arrow === -1 ? "" : cell.slice(arrow + 1);
  const slash = rest.indexOf("/");
  const state = slash === -1 ? rest : rest.slice(0, slash);
  const codes = slash === -1 ? [] : rest.slice(slash + 1).split("+").filter(Boolean);
  return { tool, input, state: state === "?" ? undefined : state, codes };
}

// Guarded like run.ts: importing this module (the test pins parseTraceCell) must run nothing —
// vitest workers are Node, where import.meta.main is undefined, so the guard is falsy there.
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun evals/regrade.ts <log.jsonl>");
    process.exit(2);
  }
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; ok: boolean; trace: string[]; inputs?: unknown[]; finalText: string });
  /** Rows written before 2026-09-23 hold only the first 2000 characters of the answer. A PASS on
   *  such a row is sound (the match lies inside the recorded text); a FAIL on the answer axis is
   *  INCONCLUSIVE, never a miss — the regex may have matched past the cap in the original run. */
  const LEGACY_CAP = 2000;
  let pass = 0;
  let inconclusive = 0;
  const changed: string[] = [];
  for (const row of rows) {
    const task = TASKS.find((t) => t.id === row.id);
    if (!task) {
      console.error(`no task ${row.id} in the current suite — skipped`);
      continue;
    }
    const trace = row.trace.map((cell, i) => parseTraceCell(cell, row.inputs?.[i] ?? null));
    const g = gradeTask(task, trace, row.finalText);
    const capped = row.finalText.length === LEGACY_CAP;
    if (g.ok) pass += 1;
    else if (!g.answerPass && capped) inconclusive += 1;
    if (g.ok !== row.ok) changed.push(`${!g.ok && !g.answerPass && capped ? "[INCONCLUSIVE: answer truncated at the legacy 2000-char cap] " : ""}` + `${row.id}: recorded ${row.ok ? "PASS" : "FAIL"} → now ${g.ok ? "PASS" : "FAIL"} (tool:${g.toolPick ? "✓" : "✗"} params:${g.paramsOk ? "✓" : "✗"} state:${g.statePass ? "✓" : "✗"} answer:${g.answerPass ? "✓" : "✗"})`);
  }
  console.log(`re-graded ${rows.length} rows with the current graders: ${pass} PASS / ${rows.length - pass - inconclusive} FAIL / ${inconclusive} inconclusive (answer truncated at the legacy cap)`);
  for (const c of changed) console.log(`  ${c}`);
}
