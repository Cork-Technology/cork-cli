---
mode: standard
reviewer_count: 2
review_status: complete
degradation_events: []
---

# Review Board Report — CLI Wiring Layer Decision

**Artifact:** rfc (decision memo) — CLI wiring layer for the Cork CLI/MCP server (trpc-cli vs stricli vs hand-rolled)
**Mode:** Standard (2 reviewers: Domain Correctness, Evidence & Feasibility; reciprocal cross-review; no adjudication triggered)
**Verdict:** Do not proceed *yet* — ratification gated on ~half a day of verification spike work; the direction itself was not challenged

## Executive Summary

**Synthesis thesis (explains 4 of 6 findings):** the memo's real decision — schema-first registry with the CLI library demoted to swappable wiring — is sound and neither reviewer challenged it. But the *safety case* that licenses picking the riskiest-maintenance candidate (trpc-cli: solo maintainer, 0.x) rests on claims the evidence never tested, and in one place mildly contradicts: the smoke test authored its command **trpc-cli-natively**, never as a registry module behind a projection, so the "re-renders onto another router in days" exit was not demonstrated — and the agent-facing `--json` path (the top-weighted differentiator) plus the "MCP SDK v1 accepts zod v4" premise were also taken on documentation.

**Highest-leverage change:** one bounded spike (~half a day) that authors 1–2 commands as plain registry modules and renders them BOTH directions — a ~30-line projection onto trpc-cli AND a bare commander shim — recording line counts and hours. This converts the entire risk argument from rhetoric to fact, prices the "why not just hand-roll?" question with numbers, and if the exit really is "days," the decision becomes robust even if trpc-cli dies.

**Safe to ignore:** the 12-candidate survey and eliminations (well-sourced), the wire-typed-boundary decision (G2-backed), the adopter-pattern claim. No reviewer proposed switching the recommendation to stricli or hand-rolled — the findings are about making the recommendation's evidence honest, not reversing it.

Lens: none (method: heuristic — ambiguous-lens-selection, tied score 2) · Cite rate: n/a

## Strengths to Protect

- **Registry-first architecture as the actual decision**, framework demoted to a projection — matches the adopter evidence (drizzle-kit, wrangler, vercel all converged on typed registries). Fixes must not re-elevate the library choice.
- **Explicit disconfirming flip triggers** in the draft position — rare discipline; keep (and make them fireable, see #5).
- **Evidence hygiene**: gotchas G1–G5 recorded against the *recommended* option; risks stated more prominently than wins.
- **Wire-typed boundary schemas** (G2 resolution: codecs internal-only) — deliberate, coherent; stands.

## Design Observations

Both reviewers independently converged on the same structural theme: reversibility is asserted, not demonstrated, and every load-bearing claim that was actually smoke-tested held up while every claim taken on documentation is where the findings cluster. The panel's confidence in the *direction* was unanimous; the dispute is entirely about verification debt. Cross-review produced zero challenges and unanimous Confirmed status on all six findings — unusually strong consensus.

## Recommended Changes

| # | Direction | Change | Where | Why | Consensus | Severity | Complexity |
|---|-----------|--------|-------|-----|-----------|----------|------------|
| 1 | Add (spike task) | Author 1–2 commands as plain registry modules; render both directions (→trpc-cli ~30-line projection AND →bare commander shim); record lines + hours. Fallback if skipped: reword memo "estimated days — not yet demonstrated" | dx-smoke scratchpad + memo L67–71 | The exit claim is the sole mitigation making a bus-factor-1/0.x dep acceptable; smoke test authored trpc-cli-natively — mild counter-evidence | Confirmed (EXTEND+CONFIRM, solution Improved via counter) | **High** | neutral |
| 2 | Change | Reword confinement invariant: "wiring *logic* confined to src/cli.ts; registry schemas may carry wiring-agnostic CLI meta keys (positional/alias) as plain data; registry→MCP projection strips CLI-only meta keys (G5)" | memo constraints + architecture draft | `.meta()` keys live in every schema and leak into MCP JSON Schema (G5-verified) — a live breach of the no-drift constraint as stated | Confirmed | Medium | neutral |
| 3 | Change | Reconcile the stricli-adapter figure: research said ~100 lines (mapping only); memo says 300–500 (incl. coercion+error mapping+help). Name the delta; note adapter is *largely* a subset of the router's scope (plus stricli API tracking), so B's owned-code cost ≠ C's | memo option B/C | Unexplained 3–5x drift corrupts exactly the B-vs-C comparison the board was asked to stress-test | Confirmed (found independently by both) | Medium | reduces |
| 4 | Add (spike task, ~30 min) | Invoke the smoke command via `--json` with valid AND invalid input; record stdout/stderr/exit-code shapes (commander usage errors vs zod validation errors) | dx-smoke scratchpad | Agents are the PRIMARY consumer; the `--json` surface was never exercised and already had one breaking rename (`--input`→`--json`) | Confirmed | Medium | neutral |
| 5 | Add (spike task, ~1 h) + Change | hyperfine a stub router (~11 thin modules), with and without one deliberately hoisted heavy import (viem); write a numeric budget into the flip trigger ("flip consideration if p50 invocation overhead > X ms") | dx-smoke + memo flip triggers | "npx startup becomes a measured problem" is unfalsifiable; eager router load is a per-invocation tax on agents and the one axis structurally favoring stricli | Confirmed | Medium | neutral |
| 6 | Add (spike task, 10 lines) | Actually call `registerTool` with a zod v4 schema on MCP SDK 1.29.0; mark the premise verified or add the v1-shim constraint to the decision record | dx-smoke scratchpad + memo L9–10 | "MCP SDK accepts zod v4 directly" was declared settled from JSON-Schema inspection only; the memo's own citations (PR #816/issue #925) imply v4 support arrives in SDK **v2** | Confirmed (peer-escalated Low→Medium with new evidence) | Medium | neutral |

## Analysis

### #1: Exit strategy unverified — the load-bearing claim
**High** | evidence-gap: unverified-exit-strategy | Confirmed | Confidence: 90
Both reviewers found this independently (EF at High, DC at Medium); cross-review converged on High after EF's added evidence: the smoke test used trpc-cli's native `t.procedure` builder — no registry module, no projection was ever built — and G2/G3 show the builder already reshaped one registry-wide design decision. The claim "re-renders in days" is the *only* thing making a solo-maintainer 0.x dependency acceptable; it must be demonstrated, not estimated. Solution status: **Improved** — the two-direction render test (adoption projection + exit shim) was proposed as a counter by DC and independently endorsed by EF; ~60–90 minutes.

### #2: Confinement invariant overstated; G5 leak not carried into the decision
**Medium** | boundary-integrity | Confirmed | Confidence: 88
`.meta({positional, alias})` vocabulary necessarily lives inside every registry schema (data-level coupling that survives any wiring swap) and leaks verbatim into exported MCP JSON Schema unless stripped (G5, empirically verified). The fix is a rewording plus one transform at the existing registry→MCP projection point — it converts G5 from tribal knowledge into a stated invariant.

### #3: stricli adapter cost figure contradicts cited research
**Medium** | evidence-consistency | Confirmed (independent convergence) | Confidence: 90–95
Verbatim contradiction; both reviewers flagged it with identical severity and near-identical solutions. Phrasing caution from cross-review: the adapter is "largely" (not strictly) a subset of the router's scope, because it additionally tracks stricli's evolving API — a maintenance cost option C never pays.

### #4: Primary consumer path (--json) untested
**Medium** | proxy-evidence | Confirmed | Confidence: 85
The smoke test verified the human flags path; the agent path — the reason A ranks first — rests on README claims for the least-stable part of a 0.x API. The extension also surfaces machine-parseable *error* shapes, which the memo's "output envelope is ours anyway" reasoning does not cover.

### #5: Cold-start constraint unmeasured; flip trigger inert
**Medium** | evidence-gap: unmeasured-constraint | Confirmed (merged dc-4 + ef-3) | Confidence: 85
No baseline, no budget, undefined trigger — on the one axis that structurally favors the runner-up. DC's addition: "dynamic imports inside handlers" is an unenforced discipline (nothing fails when someone hoists a viem import). The optional top-level-import lint stays optional — adopt only if the measured differential is material.

### #6: "MCP SDK accepts zod v4" — settled premise on proxy evidence
**Medium** (peer-escalated from Low) | proxy-evidence: settled-premise | Confirmed | Confidence: 70 (capped at Medium by floor)
Only `z.toJSONSchema()` output was inspected; no `registerTool` call on the shipping v1 SDK was recorded, and the research's own citations suggest native zod-v4 acceptance lands in v2. If false, the "one schema feeds MCP directly" synergy needs a shim — a real constraint that belongs in the decision record either way.

## Supplementary Findings

- **Domain Correctness**: dc-4's optional top-level-import lint check — deferred; adopt only if #5's measurement shows a material differential [COMPLEXITY GATED].
- **Evidence & Feasibility**: memo scoping nit — "consumers (2) and (3) are already settled" should carry the G1 re-check date (MCP SDK v2 stable ~2026-07-28) even after #6 is verified.

---
FIX PHASE DECISION
  mode: standard
  fix_mode: none
  trigger_phrases_matched: none
  false_positive_guard_hit: false
  ambiguous: false
  gate_result: skip
  reason: user invocation contained no fix-mode trigger phrases
