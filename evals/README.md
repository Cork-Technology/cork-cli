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
| **Surface-drift gate**: advertised MCP surface (names, descriptions incl. inline examples, FULL input/output schemas, annotations) must match the committed fixture | `packages/mcp/test/surface-drift.test.ts` + `fixtures/tool-surface.json` |
| Description token budget < 3000 (approx) across all 9 tools | same file |

A drift-gate failure means the surface changed, and the gate is TIERED — the failure message names
the tier, decided MECHANICALLY by `packages/mcp/src/surface-tier.ts` (owner-approved 2026-08-11;
never a judgment call, because "it's just wording" is precisely how semantic drift ships):

- **prose** — every difference is a rewording of an EXISTING description-carrying string
  (schema/tool `description`, server `instructions`) that preserves its sentence count.
  Regenerate the fixture; **no eval run required**.
- **semantic** — anything else: keys added/removed, names, types, enums, patterns, `x-units`,
  sentence counts, array sizes. Full workflow: run Layer B (include the held-out set,
  `EVAL_HELD_OUT=1`), and if the numbers hold, regenerate.

Ambiguity fails EXPENSIVE by construction (the sentence counter's approximations only ever
misclassify prose→semantic). Rationale for keeping the cheap tier narrow: a "redundant" full run
once exposed rotted eval fixtures nobody was looking for. The classifier itself is
mutation-probed (`surface-tier-*`). To regenerate after either tier:

```sh
UPDATE_SURFACE=1 bunx vitest run packages/mcp/test/surface-drift.test.ts
```

## Layer B — LLM agent evals (`bun run eval`)

A fresh agent is given ONLY the 9 tool definitions (as an MCP client would see them) and must
complete realistic tasks. The loop is a plain Anthropic-SDK agentic loop (`evals/run.ts`)
dispatching to the in-process `runTool` with a stubbed chain (`evals/stub.ts`, serving the
canonical demo-pool fixture) — **the LLM API is the only network dependency**; runs are
deterministic on the tool side and identical between machines. That claim is load-bearing and
pinned: `run.ts` sets `CORK_CONFIG_NO_FETCH` at import so the tools read the SAME local
`cork-defaults.json` the stub answers `MARKET_REGISTRY()` from — unpinned, a working tree whose
defaults differ from pushed main (a registry redeploy mid-integration) turns eval tasks red with
`adapter_binding_mismatch` (the 0.3.3 incident, in remote/bundled-skew form).

Grading is programmatic over the tool-call **trace**, not the free text:

- **tool selection** — first tool called matches the expected tool (or a task-declared prelude
  tool: a prompt that legitimately invites a discovery/state-check hop lists those tools)
- **parameter accuracy** — deep-subset match on discriminators + key params
- **outcome/state** — expected envelope `state`; a task's expected warning `code` matches ANY
  warning on the call, not just the first (multi-warning results must not fail on ordering)
- **answer** — regex over the agent's final text, where the task has a checkable fact
- **efficiency** — trace length within the task's call budget
- **error recovery** — after an invalid call, did a later call to the same tool validate?
  (this is the metric the teaching-error work exists to move)

The grading function is exported (`gradeTask`) and pinned offline by `evals/grading.test.ts` +
mutation probes — a grading regression fails a unit test, not a score baseline. The model is
gated to the sonnet family (`sonnetModelGate`, owner ruling 2026-07-28); the tools+system prefix
is prompt-cached (one breakpoint), and the summary reports the cache hit rate alongside total
tokens (which still count all context processed, so run totals stay comparable).

### Task set (`evals/tasks.ts`)

35+ active tasks spanning reads, compute, prepare (bundles, maker orders, fills of a REAL
signed resting order, market-oracle txs), token-approval reporting, submit (the one
side-effecting tool), decode/track, discovery, and *gated* outcomes (the agent must report
`needs_indexer` / `phase_gated` / `mode_unavailable` / `chain_read_failed` honestly instead of
inventing data), plus **5 held-out tasks**.

**Held-out rule: never tune tool descriptions, examples, or teaching text against the held-out
set.** It exists to catch description overfitting. Run it occasionally (`EVAL_HELD_OUT=1`) and
expect scores close to the active set; a gap means the active set has leaked into the surface.

### Running

```sh
bun run eval                                   # ANTHROPIC_API_KEY/AUTH_TOKEN recommended; else ambient auth (e.g. ANTHROPIC_BASE_URL gateway) — fails loud, never skips
CORK_EVAL_MODEL=claude-opus-4-8 bun run eval   # heavier tier (default: claude-sonnet-5 — owner ruling 2026-07-28: never haiku)
CORK_EVAL_TRIALS=3 bun run eval                # stable numbers
EVAL_HELD_OUT=1 bun run eval                   # include held-out set
CORK_EVAL_ONLY=read-market bun run eval        # single task
EVAL_GATE=1 EVAL_GATE_THRESHOLD=0.8 bun run eval  # CI gate: exit 1 below threshold
```

Without credentials the runner self-skips (prints why, exits 0), so `bun run eval` is safe in any
environment.
