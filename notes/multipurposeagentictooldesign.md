# Designing Multipurpose MCP Tools That Agents Actually Use Well

> **2026-07 update:** the frontier has moved since this guide was written — see
> `notes/research/mcp-frontier-2026.md` for what changed (MCP 2025-11-25 / 2026-07-28 RC,
> `$defs` dedup now spec-legal, per-value enum semantics, measured parameter-format ROI for
> DeFi servers, Claude Code's ~10K-token defer threshold) and which items were applied to
> `packages/schemas` in the 2026-07 schema pass.

Research-backed design guide for Cork's polymorphic tool surface (companion to
`cork-cli-mcp-requirements-v2.md` §5; expands it into concrete mechanics). The question it
answers: **how does one generic tool stay as easy to use as a dozen specialized ones,
even for a narrow task like "fetch fills for market X since block Y"?**

## Executive summary

The research is unusually well-quantified, and it strengthens the case for consolidating
our surface to a small set of polymorphic tools (settled at 9: six verbs plus three
family-scoped prepare tools — see requirements §3). The headline numbers, all from Anthropic's published
measurements: deferring tool definitions and loading them on demand produced an **85%
token reduction and a 49%→74% tool-selection accuracy jump** on large tool libraries;
progressive disclosure in code-execution mode cut context from 150k to 2k tokens
(**98.7%**); and — most relevant to the worry that generic tools can't serve specialized
use-cases — adding just **three concrete input examples to a complex tool's definition
lifted parameter-handling accuracy from 72% to 90%**. Examples, not more tools, are the
single biggest lever for making a generic tool handle narrow tasks well.

This guide distills that into eleven mechanics (§2). The load-bearing ones:

- **Discriminated unions where every enum value gets a one-line description**, with the
  discriminator placed first in the schema so it anchors the agent's generation.
- **A fixed description template whose crucial element is the "when NOT to use this —
  use `cork_compute` instead" pointer.** That cross-reference is what kills wrong-tool
  selection between sibling tools.
- **Shipped input examples** per tool, plus one per hot variant.
- **`cork_capabilities` as the searchable manual**: deep docs for ~20 variants load on
  demand instead of sitting in registered schemas. This is Anthropic's Tool Search
  pattern applied at the variant level — and it's also how our tool-search product goal
  (Goal 4) gets satisfied for free.
- **Errors that return a corrected example invocation**, so the agent's next call
  succeeds without a documentation lookup.
- **Eval-gating**: ~20 realistic tasks run by a fresh agent in CI; tool descriptions are
  treated as code that only changes when the evals prove it helped.

§3 walks a concrete specialized task ("fetch fills since yesterday") through the generic
surface — it resolves in one round-trip with only two tool schemas in context, which is
the bar the 40-tool design could not meet. And because the MCP server is a thin adapter
over an importable core library, we get a free second lane for agents that operate in
code-execution mode (§2.9).

## 1. What the research says

The evidence base has converged on a few load-bearing findings:

- **Consolidation beats proliferation — with a floor.** Anthropic's tool-writing
  guidance is explicit: "tools can consolidate functionality, handling potentially
  multiple discrete operations under the hood," with pagination, filtering, and sensible
  defaults, rather than one tool per endpoint. But the same guidance demands
  fully-described parameters and unambiguous purpose — the consolidation is only safe
  because the schema stays rich.
- **Context is the scarce resource.** Anthropic measured an **85% token reduction** from
  deferring tool definitions and loading on demand, with tool-selection accuracy on a
  large library improving from 49%→74% (Opus 4) and 79.5%→88.1% (Opus 4.5). Their MCP
  code-execution work reports a 150k→2k token reduction (98.7%) by letting agents
  discover tool definitions progressively instead of front-loading them.
- **Examples move the needle more than prose.** Adding 3 concrete input examples
  (minimal / partial / full parameters) to complex tool definitions improved parameter-
  handling accuracy from **72% to 90%** in Anthropic's measurements. For a polymorphic
  tool, examples are how specialized use-cases stay one-shot-learnable.
- **Response format control matters.** A `concise` vs `detailed` response toggle cuts
  typical result tokens to roughly one-third while preserving task success.
- **Annotations are a risk vocabulary, not security.** MCP's `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint` let hosts skip confirmations for
  reads, warn on destructive calls, and retry idempotent ones — but they are hints, and
  actual enforcement stays server-side.
- **Eval-driven iteration is the method.** Every guide lands on the same loop: write
  realistic tasks, run a fresh agent with only the tool list, measure, rewrite
  descriptions/schemas, re-measure against held-out tasks.

## 2. The blueprint: eleven mechanics for Cork's 9-tool surface

### 2.1 Discriminated unions, described at every node

Every polymorphic input uses a closed discriminator (`resource`, `kind`, `action.type`)
with a JSON Schema `oneOf` branch per variant. Three rules make this learnable:

- every enum **value** carries a one-line description ("`fills` — executed trades for a
  limit-order market; filter by market, maker, taker, block/time range");
- every branch's fields are exact and closed (`additionalProperties: false`), so a wrong
  guess fails validation instead of silently misbehaving;
- the discriminator is the FIRST property in the schema, so it anchors the agent's
  generation.

### 2.2 Tool descriptions with a fixed template

Every tool uses the same description structure: *what it does* (1 sentence) →
*when to use / when NOT to use, naming the sibling to use instead* → *the variant list
with one-liners* → *2–3 worked examples* → *error behavior in one line*. The
"when-NOT-to-use pointer" is what prevents the classic polymorphic failure of agents
picking `cork_query` when they need `cork_compute`.

### 2.3 Input examples in the tool definition

Ship `tool_use_examples` (or equivalent inline examples) per tool: one minimal, one
typical, one fully-parameterized — plus one per *hot* variant (orderbook fetch, unwind
prepare, dutch-auction price). This is the single highest-leverage lever the research
identifies for specialized use-cases of generic tools.

### 2.4 One envelope, output schemas declared

All tools return the same envelope (`state`, `data`, `warnings`, `provenance`,
`schemaVersion`) and declare MCP `outputSchema` with `structuredContent` so hosts and
agents parse results reliably. Version lives in the envelope — never in the tool name.

### 2.5 Annotations set honestly

`cork_query`/`cork_compute`/`cork_decode`/`cork_track`/`cork_capabilities`:
`readOnlyHint: true`. The three `cork_prepare_*` tools: read-only in effect (they
construct bytes, execute nothing) — annotate read-only but say in the description that
outputs are *intended* for later signing. `cork_submit`: `readOnlyHint: false`, `destructiveHint: false` (additive),
`idempotentHint: true` (true by construction via `clientRequestId`) — this is what lets
hosts safely auto-retry submissions.

### 2.6 `cork_capabilities` as the searchable manual (progressive disclosure)

The deep documentation for ~20 prepare variants and ~10 query resources does NOT live in
the registered schemas. It lives behind `cork_capabilities`, which supports:

- `search: "current price of a dutch auction order"` → returns the exact tool, variant,
  a **filled invocation template**, and the doc reference;
- `topic: "prepare/unwind"` → full field-level docs, preconditions, error codes, example
  round-trip for that one variant;
- no args → maturity map (specified/implemented/activated/healthy).

This mirrors Anthropic's Tool Search pattern at the *variant* level: the registered
surface stays ~9 cheap schemas, and detail loads on demand only when a task needs it.
Where the host itself supports deferred tool loading, the same index can back it.

### 2.11 Client-adaptive presentation (never semantics)

The MCP `initialize` handshake carries `clientInfo` (name, version); the transport adds
a user-agent. Keyed on a small versioned client-profile table, the server may adapt
**presentation only**: schema dialect (strict `oneOf` is canonical; a pre-flattened
rendering for clients profiled as mishandling unions), description/example verbosity,
and default page sizes. Constraints that keep this safe: one canonical surface and one
validation behavior for all clients; unknown clients get the strict canonical default;
`clientInfo` identifies the host app, not the model, and is self-reported — treat it as
progressive enhancement, never a correctness dependency; and semantics/availability
never vary by client, or evals, docs, and support fragment per host.

### 2.7 Errors that teach

Closed error codes, and every validation error returns: the failing path, expected vs
actual, `remediation` text, and — for variant-selection mistakes — a *corrected example
invocation* ("`kind: "swap-rate"` is not a value; did you mean `cst-swap-rate`?
Example: {...}"). Target: an agent's next call after any error succeeds. Budget error
verbosity like success verbosity — terse codes waste a round-trip, walls of text waste
context.

### 2.8 Concise by default, complete on request

`format: "concise" | "full"` on every read (concise default), small default page sizes,
explicit `complete`/cursor reporting, and field-selection where results are wide. Raw
upstream payloads and byte-level provenance are `full`-only. This is where the prior
RFC's always-on base64 envelope gets inverted.

### 2.9 A code-mode lane, for free

Because the MCP server is a thin adapter over `@corkprotocol/core`, agents operating in
code-execution mode (writing TS against a filesystem of APIs rather than making tool
calls — Anthropic's MCP code-execution pattern) can import the same typed functions
directly, filter big datasets in-sandbox, and only surface summaries. Design rule: keep
the core importable and the tool layer stateless so both lanes stay identical.

### 2.10 Eval-gated descriptions

Maintain ~20 realistic agent tasks ("find whether pool X is whitelisted", "price this
rollover order right now", "prepare an unwind for 1000 shares and tell me what I must
sign", "did my submission land?"). CI runs a fresh agent with only the tool list;
measure task success, wrong-tool picks, wrong-variant picks, and tokens consumed.
Tool descriptions and schemas change only through this loop, against a held-out set —
descriptions are code.

## 3. Worked example: the specialized-fetch case

Task: *"fetch fills for the wstETH market since yesterday."* How the generic surface
serves it at spec level:

1. Agent sees 9 tools. `cork_query`'s description lists `fills` among ten resources with
   a one-liner. That alone usually suffices:

```json
{ "resource": "fills",
  "filters": { "poolId": "0x…", "since": "2026-07-15T00:00:00Z" },
  "format": "concise" }
```

2. If unsure, one call to `cork_capabilities` with
   `search: "executed trades history"` returns the filled template above plus the note
   that `since` accepts timestamp or block, and that `mode: "full-decentralized"` serves
   this from the embedded indexer.
3. The result envelope reports `complete: false, nextCursor: …` — the schema description
   already told the agent what to do with it.
4. A mistyped filter returns
   `{code: "UNKNOWN_FILTER", path: "filters.makerAddr", remediation: "use `maker`", example: {…}}` —
   recovery without documentation lookup.

Two tool schemas in context, one round-trip in the common case. That's the bar the
40-tool design could not meet.

## 4. Anti-patterns (the mirror image)

Free-text command strings instead of discriminated unions; enum values without
descriptions; one giant description paragraph instead of the template; examples only in
external docs; version-suffixed names; verbose-by-default results; error codes without
remediation; schema changes that aren't additive within a version; and shipping without
agent evals.

## Sources

- [Writing effective tools for agents (Anthropic guidance, MCP tutorial mirror)](https://modelcontextprotocol.info/docs/tutorials/writing-effective-tools/)
- [Advanced tool use: Tool Search, Programmatic Tool Calling, Tool Use Examples (Anthropic)](https://www.anthropic.com/engineering/advanced-tool-use)
- [Code execution with MCP: progressive disclosure, 98.7% token reduction (Anthropic)](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP spec — Tools, output schemas, structured content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Tool annotations as risk vocabulary (MCP blog)](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- [MCP context bloat: tool search / code mode / progressive disclosure](https://mcp.directory/blog/mcp-context-bloat-fix-2026-tool-search-code-mode-progressive-disclosure)
