# Agent evaluation suite

Two layers gate the tool surface, per Anthropic's tool-evaluation guidance: deterministic checks
run in CI on every change; LLM agent evals run on demand when the surface (names, descriptions,
schemas, examples) changes.

## Layer A — deterministic, always-on (vitest)

| Check | Where |
|---|---|
| Every worked example validates against its tool's input schema | `packages/schemas/test/examples.test.ts` |
| Teaching errors: typo → "did you mean …?", remediation example itself validates | `packages/schemas/test/examples.test.ts` |
| Maturity map covers all 9 tools; `specified` variants carry a reason code | `packages/schemas/test/examples.test.ts` |
| **Surface-drift gate**: advertised MCP surface (names, descriptions incl. inline examples, input/output schema hashes, annotations) must match the committed fixture | `packages/mcp/test/surface-drift.test.ts` + `fixtures/tool-surface.json` |
| Description token budget < 3000 (approx) across all 9 tools | same file |

A drift-gate failure means the surface changed. That is exactly what Layer B exists to measure, so
the workflow is: change surface → run Layer B → if numbers hold, regenerate the fixture:

```sh
UPDATE_SURFACE=1 bunx vitest run packages/mcp/test/surface-drift.test.ts
```

## Layer B — LLM agent evals (`bun run eval`)

A fresh agent is given ONLY the 9 tool definitions (as an MCP client would see them) and must
complete realistic tasks. The loop is a plain Anthropic-SDK agentic loop (`evals/run.ts`)
dispatching to the in-process `runTool` with a stubbed chain (`evals/stub.ts`, serving the
canonical demo-pool fixture) — **the LLM API is the only network dependency**; runs are
deterministic on the tool side and identical between machines.

Grading is programmatic over the tool-call **trace**, not the free text:

- **tool selection** — first tool called matches the expected tool
- **parameter accuracy** — deep-subset match on discriminators + key params
- **outcome/state** — expected envelope `state` (and `warnings[0].code` for gated paths)
- **answer** — regex over the agent's final text, where the task has a checkable fact
- **efficiency** — trace length within the task's call budget
- **error recovery** — after an invalid call, did a later call to the same tool validate?
  (this is the metric the teaching-error work exists to move)

### Task set (`evals/tasks.ts`)

~20 active tasks spanning reads, compute, prepare, decode/track, discovery, and *gated* outcomes
(the agent must report `needs_indexer` / `phase_gated` / `mode_unavailable` / `chain_read_failed`
honestly instead of inventing data), plus **5 held-out tasks**.

**Held-out rule: never tune tool descriptions, examples, or teaching text against the held-out
set.** It exists to catch description overfitting. Run it occasionally (`EVAL_HELD_OUT=1`) and
expect scores close to the active set; a gap means the active set has leaked into the surface.

### Running

```sh
bun run eval                                   # needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN
CORK_EVAL_MODEL=claude-opus-4-8 bun run eval   # heavier tier (default: claude-sonnet-5 — owner ruling 2026-07-28: never haiku)
CORK_EVAL_TRIALS=3 bun run eval                # stable numbers
EVAL_HELD_OUT=1 bun run eval                   # include held-out set
CORK_EVAL_ONLY=read-market bun run eval        # single task
EVAL_GATE=1 EVAL_GATE_THRESHOLD=0.8 bun run eval  # CI gate: exit 1 below threshold
```

Without credentials the runner self-skips (prints why, exits 0), so `bun run eval` is safe in any
environment.
