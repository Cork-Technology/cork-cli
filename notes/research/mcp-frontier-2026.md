# Research Digest — Frontier MCP tool/schema design (as of 2026-07)

What is NEW versus the 2025 guidance already applied here (see
`notes/multipurposeagentictooldesign.md`). Produced by a 4-leaf parallel research pass
(spec / Anthropic guidance / community ergonomics / measured evals); citations inline.
Consumed by the 2026-07 schema-improvement pass in `packages/schemas`.

fast_path: parallel_leaves — sections + source list were caller-baked; sources: [web].

## Mcp Spec Changes 2026

- **2025-11-25 is current stable; a 2026-07-28 Release Candidate is published.** JSON Schema
  2020-12 became the official dialect in 2025-11-25 (SEP-1613); the RC (SEP-2106) explicitly
  legalizes ANY 2020-12 keyword in `inputSchema`/`outputSchema` — `examples`, `default`,
  `oneOf` discriminated unions, `$ref`/`$defs` — and loosens `structuredContent` to any JSON
  value. (modelcontextprotocol.io/specification/2025-11-25/changelog; …/draft/changelog)
- **SEP-1303 (landed 2025-11-25): input-validation failures SHOULD be tool execution errors
  (`isError: true` results), not protocol errors, explicitly for model self-correction** — a
  spec-level endorsement of this repo's teaching-error envelope. Keep it in-band.
- **No `tool_use_examples` field exists in the spec**; per-parameter JSON Schema `examples`
  keywords or namespaced `_meta` keys are the blessed paths. SEP-1382 (docs best practices)
  is dormant; SEP-1862 (tools/resolve) and SEP-1575 (tool version) are proposals only.
- **RC hygiene items**: `tools/list` SHOULD be deterministically ordered (prompt-cache hits) —
  the REGISTRY array already guarantees this; error codes `-32020..-32099` become
  spec-reserved; tasks move to an `io.modelcontextprotocol/tasks` extension; elicitation is
  being replaced by MRTR (`resultType: "input_required"`); the RC removes the `initialize`
  session (stateless per-request `_meta`) — a stdio server that treats every call
  independently (as this one does) migrates cleanly.
- `icons` (SEP-973, 2025-11-25) and top-level `title` (2025-06-18) are UI-only metadata.

## Anthropic Tool Design Guidance

- **`input_examples` is now a first-class documented tool-definition field** (~3 examples,
  deliberately varying which optional params appear; each must validate; ~20–200 tokens
  each). Doc-stated priority: descriptions first, examples second.
  (platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- **Description floor raised: 3–4+ sentences per tool** — what it does, when to use / when
  NOT to, what each parameter means, caveats / what it does NOT return.
- **2026 best-practice list validates this repo's shape**: consolidate related ops under one
  tool with an action param; namespace tool names by service prefix (`cork_*`) — "especially
  important when using tool search"; return high-signal fields and semantic stable IDs.
- **`strict: true` tool use is GA** (grammar-constrained; requires `additionalProperties:
  false`; numeric min/max and string min/maxLength are NOT supported in strict schemas;
  budgets ≈ ≤20 strict tools / ≤24 optional params / ≤16 union params per request). Cork's
  wire schemas keep validation constraints (the zod handler is the real gate) — strict-mode
  clients would need a stripped rendering; noted, not adopted.
- **Claude Code auto-defers a server behind Tool Search when its combined MCP tool text
  exceeds ~10K tokens** (`defer_loading: true`); regex/BM25 retrieval then only sees
  name/description/param-name text. Staying under the threshold — or keyword-rich text —
  is load-bearing. Measured pre-pass: this server advertised ~13K tokens (52 KB).
- **Programmatic tool calling GA'd** but Anthropic's own numbers show it is cost-neutral to
  negative at 1–2 calls/turn — skip `allowed_callers` for a 9-tool server.

## Community Schema Ergonomics

- **Tool-count cliff ≈ 20; 9 tools is safe — the risk at small N shifts to per-tool schema
  depth and near-duplicate variants.** GitHub cut Copilot 40→13 tools and *gained* accuracy.
- **Top-level `oneOf`/`anyOf`/`allOf` in `inputSchema` is rejected by the Claude API** (400);
  unions must stay nested under a property (`action`, `params`) — this repo already complies;
  never "simplify" to a top-level union. Do not hand `z.discriminatedUnion` to the SDK's
  `registerTool` (emits an empty schema, typescript-sdk#1643) — this repo pre-converts.
- **`$defs`/`$ref` dedup is safe for Claude/OpenAI and token-cheaper**; only legacy-Gemini
  paths need inlining, and SEP-2106 legalizes it. Inlining everything tripled one measured
  schema (1.5 KB → 5.5 KB).
- **`title` is display plumbing — models see name/description/inputSchema only.** Spend
  tokens on first-sentence decision rules, not titles.
- **Enum ergonomics**: enums are "the single most effective way to prevent invalid tool
  calls"; for per-value semantics put value meanings in the property `description` (the
  `chainId` `1=mainnet,…` pattern) — preferred over `oneOf`+`const` for plain choices.
- **Pagination de-facto contract** (when `cursor`/`pageSize` activate): opaque `cursor` in;
  `next_cursor`/`has_more`/`total_count` out; teaching error (never page 1) on a bad cursor.
- **Errors are prompting**: actionable next-step text ("set CORK_RPC_URL", "use a fresh
  clientRequestId") is the highest-leverage error property. Already largely done here.

## Measured Evals Schema Shapes

- **MCP-Atlas (arXiv:2602.00933): financial servers are worst-in-class on parameter syntax
  (up to 45% errors) precisely on strict formats** — dates, scoped symbols. Cork's decimal-
  string wei amounts and unix-second deadlines are exactly this class ⇒ unit/scale/format
  annotations on every parameter are the highest-measured-ROI schema edit. Also: "no tools
  called" is the dominant failure (36%) ⇒ descriptions should lead with activation intent.
- **"MCP Tool Descriptions Are Smelly!" (arXiv:2602.14878): 97% of surveyed tools exhibit
  description smells; fixing them = +5.9pp task success (median).** Component ablation:
  when-to-use and limitations matter most; the *Examples* component was statistically
  droppable — keep ONE inline example, don't multiply (qualifies Anthropic's 2025 72→90%
  figure, which was about parameter accuracy specifically).
- **Near-twin names are hard distractors** (arXiv:2605.24660) — the 15 phoenix action
  variants (`withdraw` vs `redeem` vs `unwind-*`) need one-line disambiguation each.
- **BFCL v4: JSON is the best-measured documentation format** — keep JSON Schema, no XML.
- **Error-recovery averages only ~60%** (MCP-Atlas) — teaching errors target the largest
  recoverable gap; recovery rate is already a Layer-B eval metric here.
- **Benchmark caveat (arXiv:2607.02577): public MCP benchmark deltas <5pp are noise**
  (18.5% evaluator misalignment; ~20pp rerun swings) — trust the in-repo Layer B eval.

## Applied (2026-07 pass)

Measured net effect (full `tools/list` payload, before → after): 53,814B → 58,770B
(**+9.2%**, ~13.5K → ~14.7K tokens). The `$defs` dedup only offset part of the added
semantics (phoenix −5%, submit −1%; every read tool grew). Regression harness: 103-case
validation corpus + 12 offline handler envelopes diffed against the pre-pass tree — zero
verdict diffs, all prepared artifacts byte-identical; only the capabilities surface-report
calls differ (intentionally). Layer B agent evals are the outstanding gate (CI-only).

**Live A/B eval (2026-07-21, headless `claude -p` sessions against each tree's real MCP
server; 10 tasks targeting the changed surface; haiku-4.5 as the sensitive grader tier,
sonnet-5 spot-checks):** old schema 9/10 selection + 9/10 params; new schema 10/10 + 10/10.
No degradation on any task. Two measured wins: the near-twin post-expiry task went from
5-call exploration (old; one rep even *recommended the wrong variant*, redeem instead of
withdraw-other) to 1 direct correct call, and the wrong-scale amount class (old sent 1e18
for "1000 cST") resolved. Zero schema-invalid tool calls in ~40 runs. Two fix-loop
iterations landed from observed misses: TokenAmount pass-through clause (raw base-unit
integers are not rescaled) and a whole-number scaling example (1000 → '1000'+18 zeros).
Residual: haiku occasionally drops the ×1000 on round-number scaling — identical on the
old schema and deterministic-correct on sonnet-5, i.e. model-tier arithmetic noise, not
schema-addressable. Harness: `/tmp/cork-pipeline/research/mcp26a/harness/ab/`.

1. `$defs`/`$ref` dedup via `.meta({id})` primitives + `z.toJSONSchema(…, { reused: "ref" })`.
2. `TokenAmount` / `UnixSeconds` registered primitives so unit/scale/format semantics ride
   every amount/deadline field at ~zero marginal wire cost.
3. Per-value enum semantics in property descriptions (resource, mode, fundingMode, kind…).
4. One-line disambiguation description per union branch (phoenix 15, compute 6, orders,
   submit, track subjects).
5. Top-level `title` emitted (UI-only, cheap); deterministic `tools/list` re-verified.
6. Deliberately NOT adopted: strict-mode schema stripping, `allowed_callers`/PTC, icons,
   multiplying inline examples, top-level strictObject (jsonschema.test.ts pins top-level
   leniency as a forward-compat decision).
