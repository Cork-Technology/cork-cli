# Verification spike — CLI wiring decision (board findings #1, #4, #5, #6) — 2026-07-16

Scratchpad: session `dx-smoke/` (zod 4.4.3, trpc-cli 0.15.1, @modelcontextprotocol/sdk 1.29.0,
commander 15, viem 2.55.2; node v24.16.0 primary, bun 1.3.14). Wall time: **~5 minutes of
authoring+runs** (298s clock) — the board budgeted half a day. All four checks **PASS**;
strict tsc (strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes) exit 0 over all
spike files. **The CLI wiring decision is ratified with evidence: registry-first + trpc-cli.**

## 1. Two-direction render test (board #1 — the load-bearing exit claim) — PASS, better than claimed

Files: `registry.ts` (97 lines) — framework-agnostic registry: `defineTool` + 2 real commands
(`rates floor` with the committed-descent math, `markets get` fixture), zero CLI-framework
imports, zero framework meta keys; wire-typed inputs per G2.

| Direction | File | Lines | Feature coverage |
|---|---|---|---|
| registry → trpc-cli | `cli-trpc.ts` | **25** | nested noun-verb commands, positionals, kebab flags with constraints in help, defaults, `--json` mode, validation |
| registry → bare commander (the EXIT) | `cli-commander.ts` | **88** | full parity: nested commands, positionals, kebab flags, number coercion, defaults, `--json` whole-input, zod validation, help — plus a *structured JSON error envelope* (better than trpc-cli's text errors) |

- Identical outputs from both renderers on identical invocations (flags and `--json`), math
  verified against the fork-experiment numbers (0.8e18 − 7e15 − 64×1e15 = 0.729e18 ✓).
- **The exit is hours, not days** — the "re-renders in days" claim was conservative; the memo's
  risk calculus holds with margin. The 88-line shim is a checked-in, working exit proof.
- **Architectural bonus that supersedes board fix #2:** `positional`/`alias` meta need NOT live
  in registry schemas at all — the trpc projection *injects* `.meta({positional:true})` when
  building the router (registry declares `positional: ["poolId"]` as plain data). Registry
  schemas stay framework-clean ⇒ the G5 leak (CLI meta keys in exported MCP JSON Schema)
  is eliminated structurally, no strip step needed. The confinement invariant is now literally
  true: *all* trpc-cli-specific vocabulary lives in the 25-line projection.

## 2. `--json` agent-path probe (board #4) — PASS with two catches

- **Catch 1: `--json` is opt-in** — `createCli({jsonInput: "auto"})`; without it the flag does
  not exist. (Also confirmed the 0.x churn risk is real: this option was previously
  `--input [json]` + boolean config; booleans now throw with a migration hint.) → wiring config
  must set it; add to the decision record.
- Valid input: exit 0, clean JSON on stdout only. ✓
- Invalid input: exit 1, stdout **empty**, ALL zod issues aggregated on stderr with field paths
  (`✖ … → at poolId`) — human text, not JSON. **Catch 2:** for machine-parseable errors on
  stdout, our output envelope must catch validation itself (the commander exit shim already
  demonstrates the JSON error envelope pattern — port it into the real wiring).
- Malformed JSON: exit 1, helpful commander-level error with quoting hint + usage. ✓

## 3. `registerTool` with zod v4 on MCP SDK v1 (1.29.0) (board #6) — PASS natively

`mcp-check.ts` (57 lines): full in-memory client↔server roundtrip.
- `registerTool(name, {inputSchema: def.input.shape}, handler)` accepts the **zod v4** raw
  shape as-is; `listTools` returns a complete, correct JSON Schema (pattern/description/
  default/min/max/required all present).
- Note: v1 SDK emits **draft-07** (`$schema: http://json-schema.org/draft-07/schema#`), not
  2020-12 — fine for current clients; revisit at SDK v2 migration (~2026-07-28).
- Valid call → `structuredContent` verbatim. Invalid call → the **SDK itself** pre-validates
  and returns MCP error -32602 with the full structured zod issue list in the tool result —
  exactly the "validation errors as tool results" behavior that lets models self-correct.
- ⇒ The "MCP side is settled" premise is now verified fact on the shipping SDK, not inference.

## 4. Cold-start measurement (board #5) — PASS; numeric budget set

12 runs each (2 warmup discarded), median/min, node 24.16 with native TS type-stripping,
11-command stub router:

| Variant | median | min |
|---|---|---|
| node startup floor (`node -e 0`) | 33ms | 31ms |
| zod-only baseline (11 command modules) | 110ms | 105ms |
| trpc-cli thin `--help` | 129ms | 127ms |
| trpc-cli thin invoke | 125ms | 123ms |
| trpc-cli + one hoisted `import "viem"` | 200ms | 194ms |

- **Framework overhead ≈ 15ms** (125 vs 110) — negligible; **zod itself dominates** (+77ms over
  node floor) and is common to ALL candidates, so lazy-loading of command modules (stricli's
  edge) buys almost nothing at this command count.
- One hoisted heavy import costs **+75ms** — the "dynamic imports inside handlers" discipline
  is worth keeping but a violation is a 200ms invocation, not a catastrophe.
- **Numeric flip trigger (replaces "becomes a measured problem"):** re-open the wiring choice
  if p50 end-to-end invocation overhead (excluding RPC time) exceeds **400ms** on a dev-class
  machine; baseline recorded here is 125ms.

## Decision record updates

1. **Decision RATIFIED:** schema-first registry + trpc-cli wiring (`jsonInput: "auto"`),
   commander exit shim proven at 88 lines / hours-not-days.
2. Confinement invariant, final form: *registry schemas carry zero framework vocabulary;
   CLI meta (`positional`) is injected by the 25-line trpc projection; MCP consumes registry
   schemas directly (verified clean of CLI keys).*
3. Output envelope owns validation-error rendering (JSON errors on stdout for agents);
   trpc-cli's stderr text remains as fallback UX for humans.
4. stricli adapter cost figure: reconciled moot — the runner-up path is now priced by the
   *measured* 88-line commander shim rather than estimates (and stricli's lazy-loading edge is
   worth ~0 at measured module costs).
5. Flip triggers, now all fireable: trpc-cli quiet ≥6 months; p50 invocation overhead >400ms;
   team adopts Effect wholesale.
