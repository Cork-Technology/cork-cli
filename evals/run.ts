// Layer-B agent evals: a fresh agent given ONLY the 9 MCP tool definitions must complete the
// tasks in evals/tasks.ts. The loop is a plain Anthropic-SDK agentic loop dispatching to the
// in-process `runTool` with a stubbed chain (evals/stub.ts) — the LLM API is the only network.
// Grading is programmatic over the tool-call trace: tool selection, variant/parameter accuracy,
// outcome state, call efficiency, error-recovery, token cost. Run: `bun run eval`
// (ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN recommended; without one, auth is expected from the
// environment — e.g. an ANTHROPIC_BASE_URL gateway — and the run fails loud, never skips).
//
// Env knobs: CORK_EVAL_MODEL (default claude-sonnet-5 — owner ruling 2026-07-28: evals ALWAYS run
// on sonnet, never haiku; haiku's raw-SDK loop has a params-as-string artifact that grades the
// model, not the tool surface),
// CORK_EVAL_TRIALS (default 1; use 3 for stable numbers), EVAL_HELD_OUT=1 (include the held-out
// set — do NOT tune descriptions against it), EVAL_GATE=1 (exit non-zero below thresholds),
// CORK_EVAL_ONLY=<task-id> (single task).
import Anthropic from "@anthropic-ai/sdk";
import { REGISTRY, inputJsonSchema, descriptionExample } from "@cork/schemas";
import { runTool, ToolInputError } from "@cork/core";
import { stubContext } from "./stub.ts";
import { TASKS, type EvalTask } from "./tasks.ts";

const MODEL = process.env.CORK_EVAL_MODEL ?? "claude-sonnet-5";
const TRIALS = Number(process.env.CORK_EVAL_TRIALS ?? 1);
const MAX_LOOP = 6;

interface TraceCall {
  tool: string;
  input: unknown;
  state?: string | undefined;
  code?: string | undefined;
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
        call.code = envelope.warnings[0]?.code;
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

  const e = task.expect;
  const first = trace[0];
  const toolPick = first?.tool === e.tool || (first !== undefined && (e.prelude?.includes(first.tool) ?? false));
  // Grade the OUTCOME, not the first attempt: some schema-valid call to the target tool must
  // have matched. A recovered miss (e.g. missing_filter then ok) passes here and is charged on
  // the `efficient` axis instead — that split is what the two axes claim to measure.
  const validCalls = trace.filter((c) => c.tool === e.tool && !c.invalid);
  const paramsOk = e.params ? validCalls.some((c) => subsetMatch(e.params, c.input)) : true;
  const statePass = e.state
    ? validCalls.some((c) => c.state === e.state && (e.code ? c.code === e.code : true) && (!e.params || subsetMatch(e.params, c.input)))
    : true;
  const answerPass = e.answer ? e.answer.test(finalText) : true;
  const efficient = trace.length <= e.maxCalls;
  // Error recovery: after an invalid call to a tool, did a later call to the SAME tool validate?
  const invalidIdx = trace.findIndex((c) => c.invalid);
  const recovered = invalidIdx === -1 ? undefined : trace.slice(invalidIdx + 1).some((c) => c.tool === trace[invalidIdx]!.tool && !c.invalid);

  return { task, ok: toolPick && paramsOk && statePass && answerPass, toolPick, paramsOk, statePass, answerPass, efficient, recovered, calls: trace.length, tokens, finalText, trace };
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`;
}

async function main() {
  // Credentials are RECOMMENDED, not required: there are many ways to reach the Claude API now
  // (gateway/base-URL auth, ambient session plumbing, cloud-provider bindings). Without an
  // explicit key we omit the auth headers — the SDK's documented escape hatch — and let
  // whatever ANTHROPIC_BASE_URL points at supply auth; a genuinely unauthenticated setup
  // fails on the first request with the provider's own error instead of silently skipping.
  const hasExplicitCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasExplicitCreds) {
    console.log("agent evals: no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN — proceeding via ambient auth (gateway/base-URL). Setting a key explicitly is recommended for reproducible runs.");
  }
  const client = new Anthropic(hasExplicitCreds ? {} : { defaultHeaders: { "X-Api-Key": null, "Authorization": null } });
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
      if (!r.ok) console.log(`      trace: ${r.trace.map((c) => `${c.tool}${c.invalid ? "!" : `→${c.state ?? "?"}${c.code ? `/${c.code}` : ""}`}`).join(" , ")}\n      answer: ${r.finalText.slice(0, 160)}`);
    }
  }

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

  if (process.env.EVAL_GATE && n > 0 && success / n < Number(process.env.EVAL_GATE_THRESHOLD ?? 0.8)) {
    console.error(`\nEVAL GATE FAILED: success ${pct(success, n)} < threshold`);
    process.exit(1);
  }
}

await main();
