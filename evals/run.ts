// Layer-B agent evals: a fresh agent given ONLY the 9 MCP tool definitions must complete the
// tasks in evals/tasks.ts. The loop is a plain Anthropic-SDK agentic loop dispatching to the
// in-process `runTool` with a stubbed chain (evals/stub.ts) — the LLM API is the only network.
// Grading is programmatic over the tool-call trace: tool selection, variant/parameter accuracy,
// outcome state, call efficiency, error-recovery, token cost. Run: `bun run eval`
// (auth is four-way, evals/auth-mode.ts: Claude Platform on AWS configured → AnthropicAws
// client, SigV4 via the AWS credential chain (CI: GitHub OIDC → assumed role, no stored
// secret) or ANTHROPIC_AWS_API_KEY as bearer; explicit key → keyed; no key but an
// ANTHROPIC_BASE_URL gateway → keyless and failures fail LOUD; none of it → self-skip green,
// the CI/fork contract).
//
// Env knobs: CORK_EVAL_MODEL (default claude-sonnet-5 — owner ruling 2026-07-28: evals ALWAYS run
// on sonnet, never haiku; haiku's raw-SDK loop has a params-as-string artifact that grades the
// model, not the tool surface),
// CORK_EVAL_TRIALS (default 1; use 3 for stable numbers), EVAL_HELD_OUT=1 (include the held-out
// set — do NOT tune descriptions against it), EVAL_GATE=1 (exit non-zero below thresholds),
// CORK_EVAL_ONLY=<task-id> (single task).
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import AnthropicAws from "@anthropic-ai/aws-sdk";
import { REGISTRY, inputJsonSchema, descriptionExample } from "@cork/schemas";
import { runTool, ToolInputError } from "@cork/core";
import { stubContext } from "./stub.ts";
import { TASKS, type EvalTask } from "./tasks.ts";
import { evalAuthMode } from "./auth-mode.ts";

// Pin config resolution to the tree under test. The stub answers MARKET_REGISTRY() from the
// LOCAL cork-defaults.json (evals/stub.ts), but an unpinned run resolves config REMOTE-FIRST
// (GitHub raw main + a 1h disk cache) — so any window where the working tree's defaults differ
// from pushed main (a registry redeploy mid-integration: exactly the 0.3.3 incident) re-creates
// the adapter_binding_mismatch eval rot the stub's config import was built to kill, via
// remote/bundled skew instead of a stale literal. Chain, venue, and HyperSync are already
// stubbed in ctx; config is process-env-scoped, so it is pinned here (as live-ab/run.sh does).
// `??=` keeps a deliberate override possible. Import-time on purpose: the pin must precede any
// runTool call however this module is driven, and the test observes it on import.
process.env.CORK_CONFIG_NO_FETCH ??= "1";

const MODEL = process.env.CORK_EVAL_MODEL ?? "claude-sonnet-5";
// A malformed TRIALS ("abc" → NaN, "" → 0) would run ZERO trials and — with the gate's n>0
// short-circuit — exit green having graded nothing: the same green-no-op class (C13) the
// CORK_EVAL_ONLY guard below exists for. Fail loud instead.
const TRIALS = Number(process.env.CORK_EVAL_TRIALS ?? 1);
if (!Number.isInteger(TRIALS) || TRIALS < 1) {
  console.error("CORK_EVAL_TRIALS must be a positive integer");
  process.exit(2);
}
const MAX_LOOP = 6;

export interface TraceCall {
  tool: string;
  input: unknown;
  state?: string | undefined;
  /** EVERY warning code on the envelope — `expect.code` matches ANY of them (a multi-warning
   *  result must not fail grading because the expected code landed second). */
  codes?: string[] | undefined;
  invalid?: boolean | undefined;
}
interface TaskResult {
  task: EvalTask;
  ok: boolean;
  toolPick: boolean;
  paramsOk: boolean;
  statePass: boolean;
  answerPass: boolean;
  efficient: boolean;
  recovered?: boolean | undefined;
  calls: number;
  tokens: number;
  finalText: string;
  trace: TraceCall[];
}

function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => subsetMatch(v, (actual as Record<string, unknown>)[k]));
}

const TOOLS = REGISTRY.map((t) => ({
  name: t.name,
  description: t.description + descriptionExample(t.name),
  input_schema: inputJsonSchema(t.name) as Anthropic.Tool.InputSchema,
}));

/** Compact per-call cell: `tool→state/code+code`, `tool!` for schema-invalid. ONE renderer for
 *  the log row and the console FAIL line — the log-row test asserts they share a vocabulary,
 *  which was previously maintained by hand in two copies of this expression. */
function traceCell(c: TraceCall): string {
  return `${c.tool}${c.invalid ? "!" : `→${c.state ?? "?"}${c.codes?.length ? `/${c.codes.join("+")}` : ""}`}`;
}

/** The owner ruling (2026-07-28) as a GATE, not a default: evals run on a sonnet model, always.
 *  Any sonnet generation passes; anything else is refused loud — a haiku/opus run would grade
 *  the model, not the tool surface, and its numbers would poison every baseline comparison.
 *  Returns the refusal message, or null when the model is admissible. Exported for the test. */
export function sonnetModelGate(model: string): string | null {
  return /^claude-sonnet-/.test(model)
    ? null
    : `CORK_EVAL_MODEL must name a sonnet model (owner ruling 2026-07-28: evals ALWAYS run on sonnet) — got '${model}'`;
}

/** Programmatic verdict over the tool-call trace — extracted from the loop so it is unit-testable
 *  and mutation-probeable (evals/grading.test.ts; sdk probes eval-grade-*). */
export function gradeTask(task: EvalTask, trace: TraceCall[], finalText: string) {
  const e = task.expect;
  const first = trace[0];
  const toolPick = first?.tool === e.tool || (first !== undefined && (e.prelude?.includes(first.tool) ?? false));
  // Grade the OUTCOME, not the first attempt: some schema-valid call to the target tool must
  // have matched. A recovered miss (e.g. missing_filter then ok) passes here and is charged on
  // the `efficient` axis instead — that split is what the two axes claim to measure.
  const validCalls = trace.filter((c) => c.tool === e.tool && !c.invalid);
  const paramsOk = e.params ? validCalls.some((c) => subsetMatch(e.params, c.input)) : true;
  const statePass = e.state
    ? validCalls.some((c) => c.state === e.state && (e.code ? (c.codes?.includes(e.code) ?? false) : true) && (!e.params || subsetMatch(e.params, c.input)))
    : true;
  const answerPass = e.answer ? e.answer.test(finalText) : true;
  const efficient = trace.length <= e.maxCalls;
  // Error recovery: after an invalid call to a tool, did a later call to the SAME tool validate?
  const invalidIdx = trace.findIndex((c) => c.invalid);
  const recovered = invalidIdx === -1 ? undefined : trace.slice(invalidIdx + 1).some((c) => c.tool === trace[invalidIdx]!.tool && !c.invalid);
  return { ok: toolPick && paramsOk && statePass && answerPass, toolPick, paramsOk, statePass, answerPass, efficient, recovered };
}

/** One durable NDJSON row per run — everything the variance re-trial recipe and a post-hoc
 *  regression hunt need, WITHOUT the transcript bulk (trace tools + verdict bits + token cost).
 *  Exported for the unit test: the row must never silently lose a verdict field. */
export function evalLogRow(r: TaskResult, model: string) {
  return {
    id: r.task.id,
    heldOut: r.task.heldOut ?? false,
    model,
    ok: r.ok,
    toolPick: r.toolPick,
    paramsOk: r.paramsOk,
    statePass: r.statePass,
    answerPass: r.answerPass,
    efficient: r.efficient,
    ...(r.recovered !== undefined ? { recovered: r.recovered } : {}),
    calls: r.calls,
    tokens: r.tokens,
    trace: r.trace.map(traceCell),
    // 2000, not 400: a failed answer-regex must be diagnosable from the log alone. The 400-char
    // excerpt cut a graded answer mid-table (2026-08-17), leaving the miss unexplainable — the
    // same evidence-destruction class the log file itself exists to prevent.
    finalText: r.finalText.slice(0, 2000),
  };
}

async function runTask(client: Anthropic, task: EvalTask): Promise<TaskResult> {
  const ctx = stubContext();
  const trace: TraceCall[] = [];
  let tokens = 0;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task.prompt }];
  let finalText = "";

  for (let i = 0; i < MAX_LOOP; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system:
        "You operate the Cork Phoenix tool server. Use the tools to answer precisely; report gated/unavailable outcomes honestly instead of inventing data. Answer concisely when done.",
      tools: TOOLS,
      messages,
    });
    tokens += response.usage.input_tokens + response.usage.output_tokens;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    finalText = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const call: TraceCall = { tool: tu.name, input: tu.input };
      try {
        const envelope = await runTool(tu.name, tu.input, ctx);
        call.state = envelope.state;
        call.codes = envelope.warnings.map((w) => w.code);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(envelope), is_error: envelope.state === "unavailable" });
      } catch (err) {
        call.invalid = true;
        const teaching = err instanceof ToolInputError ? (err.teaching ?? err.issues) : String(err);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error: "invalid_input", teaching }), is_error: true });
      }
      trace.push(call);
    }
    messages.push({ role: "user", content: results });
  }

  return { task, ...gradeTask(task, trace, finalText), calls: trace.length, tokens, finalText, trace };
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`;
}

async function main() {
  // Auth is a four-way decision (evals/auth-mode.ts): Claude Platform on AWS config runs the
  // AnthropicAws client (SigV4/bearer, fails LOUD if half-configured); an explicit key runs
  // keyed; a configured ANTHROPIC_BASE_URL gateway runs keyless and fails LOUD if its auth is
  // broken; NOTHING configured self-skips green — the documented CI/fork contract (a missing
  // repo secret must not paint main red; exactly that regression shipped 2026-08-10).
  const modelRefusal = sonnetModelGate(MODEL);
  if (modelRefusal) {
    console.error(modelRefusal);
    process.exit(2);
  }
  const mode = evalAuthMode(process.env);
  if (mode === "skip") {
    console.log("agent evals: skipped — no Claude-on-AWS config (ANTHROPIC_AWS_WORKSPACE_ID), no explicit key/token, and no ANTHROPIC_BASE_URL gateway. Wire OIDC + the AWS repo variables (or a key) to enable the eval gate.");
    return;
  }
  if (mode === "ambient") {
    console.log("agent evals: no explicit key — proceeding via the configured ANTHROPIC_BASE_URL gateway (auth failures fail loud). Setting a key explicitly is recommended for reproducible runs.");
  }
  if (mode === "aws") {
    console.log("agent evals: Claude Platform on AWS configured — AnthropicAws client (SigV4 via the AWS credential chain, or ANTHROPIC_AWS_API_KEY as bearer). A half-configured setup fails loud here, never skips.");
  }
  // AnthropicAws extends the base client with the same messages surface — only construction
  // differs; the agentic loop below is client-class-agnostic.
  const client = mode === "aws" ? new AnthropicAws() : new Anthropic(mode === "keyed" ? {} : { defaultHeaders: { "X-Api-Key": null, "Authorization": null } });
  const only = process.env.CORK_EVAL_ONLY;
  const onlySet = only ? new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const tasks = TASKS.filter((t) => (onlySet ? onlySet.has(t.id) : process.env.EVAL_HELD_OUT ? true : !t.heldOut));
  // A filter that matches nothing must FAIL, not report an empty run: under EVAL_GATE the n>0
  // short-circuit below would otherwise pass a zero-task run — a green no-op (class C13), the
  // same failure mode as bun test's bare-filename filter and vitest's -t with no match.
  if (onlySet && tasks.length === 0) {
    console.error(`CORK_EVAL_ONLY matched no tasks (${[...onlySet].join(", ")}) — valid ids are in evals/tasks.ts`);
    process.exit(2);
  }

  const results: TaskResult[] = [];
  for (const task of tasks) {
    for (let trial = 0; trial < TRIALS; trial++) {
      const r = await runTask(client, task);
      results.push(r);
      const flag = r.ok ? "PASS" : "FAIL";
      console.log(
        `${flag}  ${task.id}${task.heldOut ? " [held-out]" : ""}${TRIALS > 1 ? ` t${trial}` : ""}  tool:${r.toolPick ? "✓" : "✗"} params:${r.paramsOk ? "✓" : "✗"} state:${r.statePass ? "✓" : "✗"} answer:${r.answerPass ? "✓" : "✗"} calls:${r.calls}${r.efficient ? "" : "(over)"} tokens:${r.tokens}${r.recovered !== undefined ? ` recovered:${r.recovered ? "✓" : "✗"}` : ""}`,
      );
      if (!r.ok) console.log(`      trace: ${r.trace.map(traceCell).join(" , ")}\n      answer: ${r.finalText.slice(0, 160)}`);
    }
  }

  // Persist per-task rows BEFORE the summary prints: stdout is routinely piped/truncated (a
  // `| tail` on the launch command silently destroyed the per-task evidence of a 31/33 run,
  // 2026-08-10 — the summary survived, the identity of the two misses did not). The log file is
  // the durable record the variance re-trial recipe needs (CORK_EVAL_ONLY=<id> needs the id).
  const logPath = process.env.CORK_EVAL_LOG ?? "evals/.last-run.jsonl";
  writeFileSync(logPath, results.map((r) => JSON.stringify(evalLogRow(r, MODEL))).join("\n") + "\n");
  console.log(`per-task log: ${logPath}`);

  const n = results.length;
  const success = results.filter((r) => r.ok).length;
  const invalids = results.filter((r) => r.recovered !== undefined);
  console.log(`\n== ${MODEL} · ${n} runs (${tasks.length} tasks × ${TRIALS}) ==`);
  console.log(`task success:      ${pct(success, n)}  (${success}/${n})`);
  console.log(`tool selection:    ${pct(results.filter((r) => r.toolPick).length, n)}`);
  console.log(`parameter acc.:    ${pct(results.filter((r) => r.paramsOk).length, n)}`);
  console.log(`outcome/state:     ${pct(results.filter((r) => r.statePass).length, n)}`);
  console.log(`within call budget:${pct(results.filter((r) => r.efficient).length, n)}`);
  console.log(`error recovery:    ${invalids.length ? pct(invalids.filter((r) => r.recovered).length, invalids.length) : "n/a (no invalid calls)"}`);
  console.log(`total tokens:      ${results.reduce((s, r) => s + r.tokens, 0)}`);

  if (process.env.EVAL_GATE) {
    // A zero-run gate is a FAILURE, not a pass (C13); a NaN threshold would silently disable
    // the comparison, so it is rejected the same way.
    const threshold = Number(process.env.EVAL_GATE_THRESHOLD ?? 0.8);
    if (n === 0 || !Number.isFinite(threshold)) {
      console.error(`\nEVAL GATE FAILED: ${n === 0 ? "zero runs graded" : `threshold '${process.env.EVAL_GATE_THRESHOLD}' is not a number`}`);
      process.exit(1);
    }
    if (success / n < threshold) {
      console.error(`\nEVAL GATE FAILED: success ${pct(success, n)} < threshold`);
      process.exit(1);
    }
  }
}

// Guarded so the module is importable (the log-row unit test imports evalLogRow; vitest workers
// are Node, where import.meta.main is undefined — falsy — and the eval must not fire on import).
if (import.meta.main) await main();
