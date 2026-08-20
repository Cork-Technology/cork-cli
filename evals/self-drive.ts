// Keyless Layer-B self-drive: an in-session agent plays each task's tool calls; execution,
// trace semantics, and GRADING are the suite's own — runTool + stubContext + gradeTask — so a
// failure here is a suite defect (unwinnable task, over-tight regex, wrong expectation), never
// a harness approximation. NOT a model baseline: the sonnet gate exists so scores stay
// comparable across runs; this validates coherence only.
//
// Two modes on the SAME spec file (plays don't carry finalText until composed):
//   record — execute each task's calls, print the REAL envelope data so a final answer can be
//            composed from ground truth instead of guessed.
//   grade  — execute again (deterministic — same stub, same inputs) and grade with finalText.
import { readFileSync } from "node:fs";
import { runTool, ToolInputError } from "@cork/core";
import { gradeTask, type TraceCall } from "./run.ts";
import { TASKS } from "./tasks.ts";
import { stubContext } from "./stub.ts";

interface Play { id: string; calls: Array<{ tool: string; input: unknown }>; finalText?: string }

const mode = process.argv[2] as "record" | "grade";
const spec: Play[] = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
const byId = new Map(TASKS.map((t) => [t.id, t]));
let failures = 0;

for (const play of spec) {
  const task = byId.get(play.id);
  if (!task) { console.log(`NO-SUCH-TASK ${play.id}`); failures++; continue; }
  const ctx = stubContext();
  const trace: TraceCall[] = [];
  const digests: string[] = [];
  for (const c of play.calls) {
    const call: TraceCall = { tool: c.tool, input: c.input };
    try {
      const env = await runTool(c.tool, c.input, ctx);
      call.state = env.state;
      call.codes = env.warnings.map((w) => w.code);
      digests.push(mode === "record" ? `${c.tool} -> ${JSON.stringify(env)}` : `${c.tool} -> ${env.state}${call.codes.length ? "/" + call.codes.join("+") : ""} :: ${JSON.stringify(env.data).slice(0, 160)}`);
    } catch (err) {
      call.invalid = true;
      digests.push(`${c.tool} -> INVALID :: ${err instanceof ToolInputError ? JSON.stringify(err.issues).slice(0, 400) : String(err).slice(0, 400)}`);
    }
    trace.push(call);
  }
  if (mode === "record") {
    console.log(`\n=== ${play.id} ===`);
    for (const d of digests) console.log(d);
    continue;
  }
  const v = gradeTask(task, trace, play.finalText ?? "");
  const axes = `tool:${v.toolPick ? "y" : "N"} params:${v.paramsOk ? "y" : "N"} state:${v.statePass ? "y" : "N"} answer:${v.answerPass ? "y" : "N"} eff:${v.efficient ? "y" : "N"} safe:${v.safe ? "y" : "N"} steps:${v.stepsRan ? "y" : "N"}`;
  console.log(`${v.ok && v.efficient ? "PASS" : v.ok ? "PASS(over-budget)" : "FAIL"}  ${play.id}${task.heldOut ? " [held-out]" : ""}  ${axes}  calls:${trace.length}/${task.expect.maxCalls}`);
  if (!v.ok || !v.efficient) {
    failures += v.ok ? 0 : 1;
    for (const d of digests) console.log(`      ${d}`);
    if (!v.answerPass && task.expect.answer) console.log(`      answer-regex: ${task.expect.answer}\n      finalText: ${(play.finalText ?? "").slice(0, 300)}`);
    if (!v.paramsOk) console.log(`      expected params subset: ${JSON.stringify(task.expect.params)}`);
  }
}
if (mode === "grade") {
  const played = new Set(spec.map((p) => p.id));
  console.log(`\n${spec.length} played, ${failures} failed; not yet played: ${TASKS.filter((t) => !played.has(t.id)).length}`);
}
if (failures > 0) process.exit(1);
