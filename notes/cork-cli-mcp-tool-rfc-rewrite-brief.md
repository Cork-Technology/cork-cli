# Brief: Author the Revised Cork MCP/CLI RFC

You are writing a **new RFC from scratch** for Cork's MCP server + CLI tool. A prior RFC
draft exists but is deliberately NOT given to you: it fanned out into ~40 registered
tools, baked unverified decisions in as normative facts, and mixed genuine requirements
with premature infrastructure. Your job is to produce the replacement, working from the
requirements baseline plus your own research and empirical verification.

**Read `cork-cli-mcp-requirements-v2.md` in this workspace first.** It is the deduplicated
requirements inventory (R1–R6 + cross-cutting), the proposed polymorphic tool
surface, the coverage analysis, and the agent-usability obligations. Treat it as the
requirements contract; treat everything marked "[RFC → verify]" as a claim to check, not
a fact.

## Design stance (decided — do not relitigate, DO re-verify)

1. **Few polymorphic tools, closed schemas inside — baseline is 9.** Target:
   `cork_query`, `cork_compute`, `cork_decode`, `cork_prepare_phoenix`,
   `cork_prepare_orders`, `cork_prepare_market`, `cork_track`, `cork_capabilities`, plus
   `cork_submit` as the only side-effecting tool. Variants are discriminated unions with
   closed enums — never a generic selector/target/calldata passthrough on the MCP
   surface. Rationale: agents degrade with large tool inventories (context cost + wrong
   tool selection), but degrade equally with schemaless mega-tools; the sweet spot was
   settled at family-scoped prepare tools because the audience includes non-Claude hosts
   with uneven `oneOf` support and external partners onboarding early — small unions
   (≤8 variants) and self-documenting family names beat the 2-schema saving of a single
   `cork_prepare`. Growth rule: any new tool, split, or merge must beat this baseline in
   the agent-eval suite. Additionally: adapt **presentation only** per client (schema
   dialect, verbosity, page defaults) keyed on the MCP `initialize` `clientInfo` against
   a versioned profile table, with the strict canonical form as the unknown-client
   default — never vary semantics or availability by client identity.
2. **Scope is the full union, phased.** Phase 1: query + compute + decode + capabilities
   + config plumbing (the read/math core). Phase 2: prepare/track for Phoenix adapter
   actions + token authority. Phase 3: limit-order lifecycle + submission. Phase 4:
   market deployment (wrapping existing automation), Safe support, hosted-production
   hardening. Adjust phase contents with justification, not the phasing principle.
3. **Principles yes, mechanics simplified.** Keep as invariants: no custody; determinism
   + derived idempotency; untrusted re-presentation of caller artifacts; closed write
   schemas; chain-over-indexer authority in reconciliation; explicit conflict states.
   Do NOT carry forward as v1 requirements: signed evidence manifests with offline key
   ceremonies, transparency logs, multi-provider quorum reads, an independent
   signing-gate service, dual MCP protocol-era conformance, byte-preserving base64
   envelopes on every read. For each of these, include a "Deferred hardening" section
   entry saying what it protects against and what would trigger adding it — first
   principles, not inheritance, decide if/when.
4. **Generic capability lives in the CLI lane only.** The CLI may expose raw
   `eth_call`/decode/RPC and may shell out to other CLIs (`cast`, `gh`, `anvil`) and
   decode/enrich their output — wrapping existing tools is acceptable engineering. The
   MCP registration list stays Cork-typed and closed.
5. **Stack (already decided in prior work):** TypeScript strict; one schema source
   generating MCP schemas + CLI + types; viem/abitype at the typed boundary; optional
   napi-rs/alloy addon for fork orchestration, embedded HyperSync, heavy math; Node LTS,
   Bun-compatible; addresses fetched from GitHub config (`cork-defaults.json`, phoenix
   `config/prod.toml`), cached, CREATE2-verifiable, never hardcoded.

## Empirical verification mandate

Forget inherited conclusions; verify from first principles before the RFC states them as
fact. You have an anvil-capable environment and a Tenderly virtual mainnet (ask me for
the RPC URL — do not commit it anywhere). Research folder: `/Users/work/Projects/euler-research`.
Claims carried from prior work that MUST be verified (against deployed contracts, ABIs,
and the repos — Cork-Technology/phoenix, market-registry-api, cork-market-pipeline,
underwriting-api):

- The CorkAdapter's actual protected function list. Prior draft claims 13 functions in 5
  product families (mint: `safeDeposit`/`safeMint`; exercise: `safeExercise`/
  `safeExerciseOther`/`safeSwap`; repurchase: `safeUnwindSwap`/`safeUnwindExercise`/
  `safeUnwindExerciseOther`; unwind: `safeUnwindDeposit`/`safeUnwindMint`; redeem:
  `safeRedeem`/`safeWithdraw`/`safeWithdrawOther`), of which 6 "exact-spend" variants are
  buildable today and 7 "capped-input" variants allegedly lack a safe on-chain protocol
  (residual/refund semantics) and must be exposed as specified-but-unavailable. Verify
  the list, the signatures, the pre/post-expiry phases, and whether the exact-spend/
  capped-input split is real by exercising the functions on a fork.
- Preview/view functions (`previewSwap`, `previewUnwindSwap`, preview-mint, maximum
  reads) — names, args, semantics, and whether every compute kind in R2 has an on-chain
  view to test against.
- Execution path: prior draft routes actions through Bundler3 multicall + Permit2
  signature transfers into the adapter. Verify against deployed bytecode/config whether
  that is the actual required path and what the funding-mode options really are.
- Share precision: claim that shares are 18-decimal with a `shareQuantum =
  10^(18 - poolCollateralDecimals)` rounding rule. Verify on fork.
- Phoenix query service: enumerate the real API surface (an OpenAPI document exists in
  Cork's repos — find it), its filters, pagination, and auth; note upstream schema
  defects you observe rather than assuming.
- Limit orders: whether the venue is really 1inch Limit Order Protocol v4 at
  `0x111111125421ca6dc452d289314280a0f8842a65`, which traits/invalidator regimes matter,
  and what the Cork orderbook service accepts for submission.
- Dutch-auction and rollover order pricing and the rate-limited impairment floor
  (constraint contract): derive the actual math from source + time-warped fork
  observations; this is the highest-risk compute surface (worst case ≠ `minRate`).
- MarketRegistry: `deploy(ca, ref)` permissionless idempotency and
  `lookupWrapper`/`WRAPPER_FACTORY` behavior.

Where verification contradicts a carried claim, the RFC states what you observed.

## Research mandate (multipurpose tool design)

**Read `multipurpose-agentic-tool-design.md` in this workspace** — the completed research on
making FEW polymorphic tools that agents use well. It grounds the obligations in §5 of
the requirements file with measured results (85% token reduction + 49%→74% selection
accuracy from deferred tool loading; 72%→90% parameter accuracy from three shipped input
examples; 98.7% context reduction from progressive disclosure in code-execution mode)
and expands them into ten concrete mechanics: discriminated unions with per-enum-value
descriptions and discriminator-first ordering; a fixed description template with
when-NOT-to-use pointers to sibling tools; shipped input examples per tool and per hot
variant; one envelope with declared output schemas; honest MCP annotations
(readOnly/idempotent/destructive); `cork_capabilities` as the searchable manual
(progressive disclosure at the variant level — which also satisfies the tool-search
product goal); errors that return corrected example invocations; concise-by-default
responses with `format: "full"` opt-in; an importable core enabling a code-execution
lane; and eval-gated description changes. Its sources (Anthropic's tool-writing and
advanced-tool-use engineering posts, the MCP spec's tools section, the MCP blog on
annotations) are your starting bibliography.

Your job is to verify these findings still hold against current documentation, extend or
challenge them where you find better evidence, and turn them into normative RFC sections
with concrete schema excerpts — including the worked "specialized fetch" example pattern
from that document's §3.

**Also read `cork-cli-human-ux.md`** — the human/script UX design for the same core. Its
central rule: the MCP tools are the *agent projection*; humans get a generated noun-verb
command tree (subcommands are free for humans; registered tools are not free for
agents), and scripts get the same JSON envelope plus an exit-code contract. Key
mechanics to carry into the RFC's CLI section: the flag → env → sticky context → project
config → user config → defaults currying cascade with `cork config where` transparency;
`--explain` printing the equivalent MCP call (the parity bridge between lanes);
TTY-aware output (table on TTY, JSON when piped); prompting only on TTY with
copy-pasteable failures otherwise; `--request-id`/`--dry-run`/`--wait` for automation;
and one example/capability registry serving `--help`, `cork search`, and MCP tool
examples alike. All three projections must be generated from the same variant registry
so they cannot drift.

## Anti-patterns the new RFC must not contain

- One tool per endpoint/variant/lifecycle-stage; version suffixes in tool names.
- Base64/byte-preserving envelopes as default response content (context pollution);
  provenance beyond source+digest+timestamp as default.
- Normative dependence on unreleased/RC protocol versions or unmerged branches.
- Silent fallback between data modes; indexer claims promoted over chain state.
- Infrastructure requirements (key ceremonies, quorums, gate services, transparency
  logs) stated as v1 blockers instead of triggered hardening.
- Prose that restates the same rule per capability — state common kernel rules once,
  reference them.
- An "arbitrary contract call" tool on the MCP surface (CLI lane is the escape hatch).

## Deliverable

`rfc/011-cork-mcp-cli.md` (or next free number) containing: summary; motivation/problems;
product definition (CLI + MCP lanes); requirements (from the baseline, deduplicated, with
any empirically-driven corrections flagged); the tool surface with complete JSON Schema
for each of the 9 baseline tools including the full discriminated union of every `cork_prepare_*` tool;
common envelope + error model; data-mode model; config/address sourcing; determinism +
idempotency + reconstruction rules; lifecycle states; phasing; deferred-hardening
section; agent-usability + eval plan; test/acceptance spec (golden vectors, fork
property tests, agent evals); open questions.

Also produce `notes/verification-log.md` recording each carried claim → how you tested →
what you observed (this feeds the RFC's factual assertions).

## Working agreement

Verify empirically before asserting; when sources conflict (research folder vs chain vs
service), record the conflict and ask me rather than guessing. Batch questions and bring
them after your research/experiments unless truly blocked (I may be away; work
unattended, log `ASSUMPTION(n)`/`QUESTION(n)` as you go). Keep the RFC readable — it will
be reviewed by engineers, not lawyers; every normative rule earns its place by protecting
a stated failure mode.
