# live-ab — headless-agent A/B evals against the real MCP wire surface

Complements the always-on stubbed suite (`evals/run.ts`, Layer B): that grades an SDK
agent against a stub chain; **this** spawns real `claude -p` sessions against the actual
stdio MCP server of one or two checkouts, so schema/description changes can be A/B'd on
the surface clients actually see. First used 2026-07-21 to validate the frontier-MCP
schema pass (result: old 9/10 selection + 9/10 params → new 10/10 + 10/10, zero
schema-invalid calls in ~40 runs; two TokenAmount teaching fixes fell out of observed
misses — see `notes/research/mcp-frontier-2026.md`).

## Requirements

- `claude` CLI on PATH with working auth (each task is a fresh headless session).
- Network for chain-backed tasks (t1/t7 hit real RPCs via the built-in defaults; the
  vnet-only demo pool intentionally yields `chain_read_failed` on real mainnet — agents
  are graded on call shape, and recovery from honest errors is part of the signal).
- Costs real tokens: 10 tasks × ~1–3 turns per labeled run. **sonnet-5 is the grader tier**
  (owner ruling 2026-07-28: evals always run on sonnet, never haiku).

## Usage

```sh
# current tree
bash evals/live-ab/run.sh new-sonnet "$(git rev-parse --show-toplevel)" claude-sonnet-5

# A/B against an older commit
git worktree add /tmp/ab-before <commit> && (cd /tmp/ab-before && bun install)
bash evals/live-ab/run.sh old-sonnet /tmp/ab-before claude-sonnet-5

python3 evals/live-ab/grade.py old-sonnet new-sonnet
```

Grades per task: `sel` (first cork tool call is the expected tool), `par` (some call to
that tool satisfies every `targets` `path=value` pin — exact values, so wrong-scale
amounts fail), `inv` (invalid_input teaching errors seen), `c` (cork call count),
`ans` (final-answer regex where a task defines one). Transcripts are stream-json under
`evals/live-ab/runs/<label>/` (gitignored).

Single runs are noisy (n=1 per cell): treat a flip as a lead, re-run the task 2–3×, and
read the transcript before concluding — the 2026-07 pass found one real schema defect
(base-unit rescaling) and one model-tier artifact (round-number ×1000 drops) this way.
Never tune descriptions against these tasks and the held-out Layer B set at once.
