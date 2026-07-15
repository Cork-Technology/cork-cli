# Research: "Schema once, three consumers" + MCP tool granularity (mid-2026)

Date: 2026-07-15. Scope: §5.3 (one schema → MCP inputSchema/outputSchema, CLI flags, TS types) and
§5.4 + Goal 4 (tool-surface shape and discovery for `cork mcp serve`).

---

## Question A — one schema, three consumers

### A.1 State of the art: the schema-library landscape

**Zod v4 (recommended core).**
- First-party JSON Schema conversion via `z.toJSONSchema()` — no external converter needed
  ([zod.dev/json-schema](https://zod.dev/json-schema), [zod.dev/v4](https://zod.dev/v4)).
  Options that matter for us:
  - `target`: `"draft-2020-12"` (default) / `"draft-07"` / `"draft-04"` / `"openapi-3.0"`.
    MCP 2025-11-25 standardized on **JSON Schema 2020-12 as the default dialect**, so the default
    target is exactly right ([2025-11-25 changelog](https://modelcontextprotocol.info/specification/2025-11-25/changelog/)).
  - `io: "input" | "output"` — which side of a transform/codec to represent. Load-bearing for
    bigint-as-string (below).
  - `unrepresentable: "throw" (default) | "any"` — `z.bigint()`, `z.date()`, `z.transform()`
    have no JSON Schema analog and **throw by default**; keep the throw so CI catches leaks.
  - `override(ctx)` — escape hatch to patch the emitted JSON Schema per node.
  - `cycles: "ref"`, `reused: "inline" | "ref"` (`"ref"` extracts shared sub-schemas into `$defs`,
    which shrinks repeated Address/Hex definitions in big tool schemas).
- Metadata: `.meta({ title, description, examples, ... })` registers in `z.globalRegistry`; **all
  metadata fields are copied into the JSON Schema output**
  ([zod.dev/metadata](https://zod.dev/metadata)). `.describe()` survives conversion too.
- **Codecs (`z.codec`)** — bidirectional decode/encode pairs, the canonical answer for
  string↔bigint: `z.codec(z.string().regex(/^-?\d+$/), z.bigint(), { decode: BigInt, encode: String })`
  ([zod.dev/codecs](https://zod.dev/codecs), [Introducing Zod Codecs](https://colinhacks.com/essays/introducing-zod-codecs)).
  `z.toJSONSchema(s, { io: "input" })` emits the string side.
- Zod **v4.2+ implements "Standard JSON Schema"** (`~standard.jsonSchema.input()/.output()`), the
  interface the MCP TS SDK v2 consumes directly
  ([standardschema.dev/json-schema](https://standardschema.dev/json-schema)).
- `z.fromJSONSchema()` exists but is experimental ([zod#5233](https://github.com/colinhacks/zod/issues/5233)).

**zod-to-json-schema: dead.** As of Nov 2025 the package is **no longer actively maintained**
because zod v4 does it natively; worse, v3.25.x with zod v4 schemas **silently fails**
([npm zod-to-json-schema](https://www.npmjs.com/package/zod-to-json-schema),
[repo](https://github.com/StefanTerdell/zod-to-json-schema)). Do not depend on it, directly or
transitively (audit: old trpc-cli versions bundled it for zod v3).

**MCP TypeScript SDK — v1 vs v2 (decision-relevant).**
- The SDK is mid-transition: **v1.x** (`@modelcontextprotocol/sdk`) is stable; **v2**
  (`@modelcontextprotocol/server`, `/client`, `/core`) is in beta implementing the **2026-07-28
  protocol revision, with stable release expected 2026-07-28** — i.e. ~2 weeks from now
  ([typescript-sdk repo](https://github.com/modelcontextprotocol/typescript-sdk)).
- v2 `registerTool(name, config, handler)`: `inputSchema` / `outputSchema` / prompt `argsSchema`
  accept **any Standard Schema that exposes JSON Schema** — zod v4 and ArkType as-is, Valibot via
  `@valibot/to-json-schema`; raw JSON Schema via `fromJsonSchema<T>(document)`
  ([docs/advanced/schema-libraries.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/schema-libraries.md)).
  From one schema the SDK derives (a) the advertised JSON Schema, (b) pre-handler argument
  validation (invalid args come back as `isError: true` tool results, per 2025-11-25 guidance),
  (c) the handler's inferred TS argument types
  ([docs/servers/tools.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md)).
- `outputSchema` + `structuredContent`: SDK validates `structuredContent` against `outputSchema`
  before the result leaves the server and advertises the derived JSON Schema in `tools/list`.
  If you return `structuredContent` you must declare `outputSchema`.
- v1 raw-shape style (`inputSchema: { name: z.string() }`) is **deprecated** in v2; pass a full
  schema object. A codemod (`npx @modelcontextprotocol/codemod@beta v1-to-v2 .`) handles most of a
  future migration ([upgrade guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)).
- **Recommendation: start on v2 beta now** (greenfield, stable lands this month); it removes the
  whole "which zod does the SDK accept" problem via Standard Schema.

**Effect/Schema.** Strong tech (bidirectional decode/encode was its headline advantage — now
matched by zod codecs; annotations; `JSONSchema.make`), and trpc supports it via
`Schema.standardSchemaV1` (effect ≥3.14.2). But it drags the whole Effect runtime idiom into every
boundary type, and its JSON Schema output needs annotation discipline to match MCP expectations.
For a CLI whose contributors are viem/zod-native, the buy-in is not justified
([effect schema-vs-zod](https://github.com/Effect-TS/effect/blob/main/packages/effect/schema-vs-zod.md)).
**Pass**, unless the codebase later adopts Effect wholesale.

**ArkType.** v2.1.28+ implements Standard JSON Schema directly; works as-is in the v2 SDK and in
trpc-cli. Terse string DSL, excellent perf. But some ArkType features don't convert cleanly to
JSON Schema/CLI args ([arktype#1379](https://github.com/arktypeio/arktype/issues/1379)), and the
zod ecosystem (ox/abitype, examples, agent familiarity) is deeper. **Viable alternate, not the pick.**

**TypeBox.** JSON-Schema-native (a TypeBox schema *is* a JSON Schema) — conceptually the cleanest
fit for an MCP server, and fastest with Ajv
([Zod vs TypeBox 2026](https://www.pkgpulse.com/guides/zod-vs-typebox-2026)). But upstream TypeBox
**refuses to implement `~standard`** on separation-of-concerns grounds
([typebox#1152](https://github.com/sinclairzx81/typebox/discussions/1152)); trpc-cli vendors a
wrapped builder (`trpc-cli/typebox`) to bolt it on. No codec/transform story for bigint/branded
types at the TS level. **Pass** — we want decode-to-rich-types (bigint, branded hex) at the
boundary, which is zod's strength.

### A.2 Schema → CLI flags: prior art

**trpc-cli** ([github.com/mmkal/trpc-cli](https://github.com/mmkal/trpc-cli)) is the most complete
prior art for exactly this mapping (router of procedures → subcommands, schema → flags), and it is
validator-agnostic via JSON Schema (zod v3/v4, ArkType, Valibot, effect, vendored TypeBox). Its
mapping rules are a good spec even if we don't adopt the library:
- Nested routers → dot-separated subcommands (`mycli search byId --id 123`).
- `z.object` → `--kebab-case` flags; camelCase accepted too. Booleans: presence = true;
  `.default(true)` + `.meta({negatable: true})` → `--no-foo`.
- Positionals: tuple inputs, or `z.string().meta({ positional: true })` (zod v4 `.meta()`).
- Aliases: `z.boolean().meta({ alias: 'f' })`.
- **Nested objects do NOT become dotted flags** — `z.object({foo: z.object({bar: z.number()})})`
  is supplied as `--foo '{"bar": 1}'` (JSON string).
- `jsonInput: 'auto'` adds a `--json <json>` option carrying the *entire* input as one JSON blob,
  which the README explicitly recommends for **machine-generated invocations (LLMs calling your
  CLI)** — serializing one JSON blob is more reliable than building argv. Procedures whose inputs
  can't map cleanly to flags fall back to `--json`-only automatically.
- Has an experimental **standalone mode** (no `@trpc/server` dependency) — you can use trpc-cli as
  a pure schema→CLI engine.
- Caveat: still 0.x, API may shift; older versions pulled `zod-to-json-schema` (fine for zod v4
  path where native conversion is used, but verify the dependency graph).

Others considered: **brocli** (Drizzle team) uses its own option builders, not zod — schemas would
be defined twice, defeating the purpose. `zodest`/`zodcli`-class libraries are small/unmaintained.
Nothing found that generates a CLI *and* an MCP server from one definition — that composition is
ours to write (thin adapters; see sketch).

**Design choice for cork:** keep tool inputs **flat (one level of object nesting max)** so flags
stay `--pool 0x… --amount-in 100`, and always support `--json` as the machine path. Flat inputs
are also what Anthropic's tool guidance favors for agents (unambiguous names over deep structure).

### A.3 The hard cases: bigint, 0x-hex, JSON Schema fidelity

- **bigint-as-string.** JSON Schema cannot represent bigint (`z.bigint()` is "unrepresentable" and
  throws in `toJSONSchema`). Canonical pattern: a **codec** whose wire side is a
  pattern-constrained string and whose TS side is `bigint`; emit JSON Schema with `io: "input"`.
  Same codec's `encode` serializes bigints back to strings for `structuredContent` (which must be
  JSON-safe — `JSON.stringify` throws on bigint). CLI synergy: argv is already strings, so the
  decode path is identical for both consumers.
- **0x-hex / Address branded types.** viem's `Address`/`Hex` are template-literal types
  (`` `0x${string}` ``). Two options:
  1. `abitype/zod` ships `Address`, `Abi`, etc. — but it is **deprecated in favor of `ox/zod`**
     (`import { z } from 'ox/zod'`, ox = wevm's Ethereum standard library underlying viem)
     ([abitype.dev/api/zod](https://abitype.dev/api/zod), [oxlib.sh](https://oxlib.sh/)). Verify
     ox/zod's zod-v4 peer range before adopting; it gives checksummed-address validation for free.
  2. Self-owned: `z.string().regex(/^0x[0-9a-fA-F]{40}$/)` typed as `` z.ZodType<`0x${string}`> ``
     (assertion or `.transform`). Regex → JSON Schema `pattern`, so **fidelity is perfect** on the
     wire; the brand lives only in TS. Avoid `z.templateLiteral` for this — regex + meta is clearer
     and converts predictably.
- **Transforms and `io`.** Anything using `.transform()`/codec must be converted with
  `io: "input"` for inputSchemas. The v2 SDK consumes `~standard.jsonSchema.input()` for input
  validation/advertising — but **verify with a snapshot test** that every advertised schema
  contains no `{}` blobs (set `unrepresentable: "throw"` in your own conversion tests).
- **Output side.** For `outputSchema`, declare the *serialized* shape (strings for amounts) and
  encode before returning. Simplest rule: **outputs are plain wire-schemas (no codecs)**; only
  inputs decode to rich types. This avoids the io-direction ambiguity entirely on outputs.

### A.4 Recommended concrete pattern (code sketch)

One registry of tool definitions; three thin adapters (MCP, CLI, direct TS API).

```ts
// src/schema/primitives.ts ─ shared branded/codec primitives
import * as z from "zod"; // zod v4.2+

export const Address = z.string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .meta({ title: "Address", description: "EVM address, 0x-prefixed" })
  // brand at the type level only; wire stays a plain pattern-string
  .transform((s) => s as import("viem").Address);

export const Hex = z.string()
  .regex(/^0x[0-9a-fA-F]*$/)
  .meta({ description: "0x-prefixed hex bytes" })
  .transform((s) => s as import("viem").Hex);

/** bigint on the TS side, decimal string on the wire / argv */
export const BigIntStr = z.codec(
  z.string().regex(/^-?\d+$/).meta({ description: "integer as decimal string (wei etc.)" }),
  z.bigint(),
  { decode: (s) => BigInt(s), encode: (b) => b.toString() },
);

// src/tools/registry.ts ─ single source of truth
export interface ToolDef<In extends z.ZodType, Out extends z.ZodType> {
  name: `cork_${string}`;             // SEP-986: snake_case, prefixed
  description: string;                // one terse sentence; deep docs live in cork_help
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean };
  input: In;                          // z.object, flat-ish (≤1 nesting level)
  output: Out;                        // wire-shape only: no codecs/transforms here
  run(args: z.output<In>): Promise<z.input<Out>>;
}

export const dutchAuctionPrice = defineTool({
  name: "cork_price_dutch_auction",
  description: "Deterministic Dutch-auction price at a timestamp for a Cork pool.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    pool: Address,
    timestamp: z.number().int().meta({ description: "unix seconds" }),
  }),
  output: z.object({ price: z.string().meta({ description: "price, 18-dec fixed as decimal string" }) }),
  run: async ({ pool, timestamp }) => ({ price: computePrice(pool, timestamp).toString() }),
});

// src/adapters/mcp.ts ─ MCP TS SDK v2: zod schemas pass straight through
import { McpServer } from "@modelcontextprotocol/server";
for (const t of allTools) {
  server.registerTool(t.name, {
    description: t.description,
    annotations: t.annotations,
    inputSchema: t.input,     // SDK derives JSON Schema, validates, infers handler types
    outputSchema: t.output,
  }, async (args) => {
    const out = await t.run(args);
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  });
}

// src/adapters/cli.ts ─ flags from the same schema
// Option 1: trpc-cli standalone mode (subcommands, flags, help, completions for free).
// Option 2 (own ~150 LoC): flatten z.object properties → kebab-case flags via the schema's
// JSON Schema (z.toJSONSchema(t.input, { io: "input" })), coerce argv strings through
// t.input.parse (codecs make argv-string → bigint free), and ALWAYS accept
//   cork tx prepare --json '{"...entire input..."}'
// as the machine path (mirrors trpc-cli's jsonInput: 'auto').
```

**Known limitations to document in the repo:**
1. Nested objects/unions don't flag-ify cleanly — keep inputs flat; discriminated unions get the
   `--json` path on the CLI (agents don't care; humans get subcommands instead, e.g.
   `cork tx prepare <action>` selects the union branch before flag parsing).
2. `z.toJSONSchema` on transforms requires `io:"input"`; outputs must stay codec-free or be
   encoded pre-return. Snapshot-test every advertised JSON Schema.
3. bigint precision: never let a `number` carry wei; enforce `BigIntStr` in review/lint
   (ast-grep rule for `z.number()` adjacent to amount-ish names is cheap insurance).
4. `ox/zod` version alignment with zod v4 must be verified at adoption time (abitype/zod is
   deprecated).
5. trpc-cli is 0.x — if used, pin it and wrap its API behind our own `defineTool`.

---

## Question B — MCP tool granularity + discovery (mid-2026)

### B.1 What the spec provides

- **2025-06-18**: `tools/list` with cursor **pagination**; `listChanged` capability +
  `notifications/tools/list_changed`; tool `annotations` (readOnlyHint, destructiveHint,
  idempotentHint, openWorldHint); `outputSchema`/`structuredContent`; titles
  ([spec: server/tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).
- **2025-11-25**: JSON Schema 2020-12 default dialect; icons metadata; **tool-name format
  guidance (SEP-986)** — 1–64 chars, `[A-Za-z0-9_./-]`, no spaces; validation errors as tool
  execution errors (so models self-correct); experimental tasks for long-running ops; tool calling
  in sampling ([changelog](https://modelcontextprotocol.info/specification/2025-11-25/changelog/),
  [SEP-986](https://modelcontextprotocol.io/seps/986-specify-format-for-tool-names)).
- **2026-07-28** (the revision SDK v2 targets, stable this month): notably reworks subscriptions
  (`subscriptions/listen` streams). Nothing found that changes tool-granularity calculus.
- The spec has **no server-side tool search primitive** — filtering/search is a client concern.
  Pagination exists but several clients ignore `nextCursor`
  ([codex#28858](https://github.com/openai/codex/issues/28858)) — keep the surface small enough
  that one page suffices.

### B.2 Anthropic guidance + platform developments (the big shift)

- **"Writing tools for agents"** ([anthropic.com/engineering/writing-tools-for-agents](https://www.anthropic.com/engineering/writing-tools-for-agents)):
  fewer, thoughtful, consolidated tools ("more tools don't always lead to better outcomes");
  namespace by service/resource (prefix or suffix — test both); `response_format: "concise" |
  "detailed"` enum (concise ≈ ⅓ tokens); pagination/truncation with sensible defaults; treat
  descriptions as onboarding docs; unambiguous param names (`user_id` not `user`); evaluate with
  agentic loops.
- **Tool Search Tool** (Claude Developer Platform, Nov 2025): `tool_search_tool_regex_20251119` /
  `_bm25_20251119` + `defer_loading: true` per tool — deferred tools aren't in context until
  discovered; ~85% token reduction, accuracy *improved* on MCP-heavy evals (Opus 4: 49%→74%)
  ([advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
  [tool-search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- **Claude Code auto-enables MCP tool search when MCP tool definitions exceed ~10% of context**
  (`ENABLE_TOOL_SEARCH=auto:N` tunable), enabled by default for all users in 2026
  ([code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp),
  [claude-code#18298](https://github.com/anthropics/claude-code/issues/18298)).
  ⇒ **A bespoke keyword `cork_search_tools` tool is NOT warranted.** Native, client-side search
  (BM25/regex over names+descriptions) already handles it — the leverage is now in making
  names/descriptions *searchable* (include keywords like "dutch auction", "limit order",
  "calldata" in descriptions).
- **Code execution with MCP / programmatic tool calling**
  ([anthropic.com/engineering/code-execution-with-mcp](https://www.anthropic.com/engineering/code-execution-with-mcp)):
  clients increasingly present MCP servers as code APIs and call them from a sandbox (98.7% token
  reduction case study). Implications for cork: **strict `outputSchema` on every tool** (typed
  results compose in code), deterministic/idempotent reads, and consistent parameter naming across
  tools — the things that make generated glue code reliable.

### B.3 How large real servers shape their surface

- **GitHub MCP server** (~40+ tools): `--toolsets` flag to enable functional groups
  (context/repos/issues/actions/…), `--read-only` mode, and `--dynamic-toolsets` where the server
  starts with ~4 meta-tools (list/enable toolsets) and grows via `listChanged`
  ([github/github-mcp-server](https://github.com/github/github-mcp-server),
  [server-configuration.md](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)).
  Rationale stated in-repo: too many tools cause tool confusion; enabling only needed toolsets
  helps tool choice and context size.
- **Playwright MCP**: capability gating — core ~20 tools by default; `--caps=vision,pdf,devtools,
  testing,tracing` opt-in unlocks up to 70+ ([playwright.dev/mcp/capabilities](https://playwright.dev/mcp/capabilities)).
- Both use **static opt-in groups (server flags)** as the primary lever and dynamic registration
  as a secondary/experimental one. Dynamic `listChanged` is well supported in SDK v2 (handles from
  `registerTool` auto-notify on `enable/disable/update/remove` —
  [docs/servers/notifications.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md))
  but client re-fetch behavior is uneven; don't build the UX around it.

### B.4 One-tool-per-contract-action vs parameterized

For a CorkPoolAdapter with N actions, three options:

| shape | context cost | agent ergonomics | verdict |
|---|---|---|---|
| N tools (`cork_tx_prepare_swap`, `_deposit`, …) | high (N descriptions + N schemas) | best per-call schema fidelity | only worth it if N ≤ ~5 |
| 1 tool, `action` enum + union input | minimal | needs good per-branch docs; JSON Schema `anyOf` w/ discriminator is fine for Claude-class models in 2026 | **recommended** for prepare/decode |
| 1 tool, `action` + loose `params: object` | minimal | loses validation + self-correction | avoid |

Anthropic's consolidation guidance (`schedule_event` over `list_users`+`list_events`+`create_event`)
plus tool-search dynamics favor the middle row: `cork_tx_prepare` with
`input: z.discriminatedUnion("action", [SwapInput, DepositInput, …])` — each branch fully typed,
JSON Schema advertises the discriminated `anyOf`, validation errors name the offending branch
(2025-11-25: validation errors return as tool results, so the model self-corrects). Pair it with
`cork_help` for deep per-action docs so the union's description stays terse.

### B.5 Resources / resource templates vs tools

Resources are the spec-pure home for read-only data (config, market metadata) and resource
templates for parameterized reads (`cork://market/{id}`). In practice, mid-2026, client support is
still uneven (application-driven; Claude Code exposes resources via @-mentions but agents rarely
pull them autonomously; several hosts ignore them entirely). **Keep tools as the primary interface
for everything agents need; optionally mirror `cork_config_get` and market lists as resources**
for hosts that surface them. Don't move anything *only* to resources.

### B.6 Recommended tool surface for cork (~11 tools)

Naming: SEP-986-compliant `cork_<domain>_<verb>` snake_case; every read tool
`annotations: { readOnlyHint: true }` (all cork tools are reads/pure — say so; hosts can
auto-approve); every tool has `outputSchema`; list-ish tools take
`response_format: "concise" | "detailed"` (default concise) and `limit` with a small default.

| tool | notes |
|---|---|
| `cork_markets_list` | filters + pagination + response_format |
| `cork_market_get` | one market, detailed (rates, auction state, floors) |
| `cork_orders_list` | limit orders; filters by market/owner/status |
| `cork_math_auction_price` | deterministic Dutch-auction price (pure) |
| `cork_math_impairment_floor` | rate-limited impairment floor (pure) |
| `cork_tx_prepare` | **action-discriminated union** over every CorkPoolAdapter action → `{to, data, value}` hex |
| `cork_tx_decode` | calldata → structured `{action, params}` (inverse of prepare) |
| `cork_rfq_quote` | request quote |
| `cork_config_get` | addresses/chains/deployments |
| `cork_help` | `topic`/`action` param → deep docs (units, decimals, action semantics, examples). Keeps every other description to 1–2 sentences. |
| `cork_status` | (optional) chain/RPC health; cheap first call for agents |

Context-budget tactics, in priority order:
1. Terse descriptions (≤2 sentences) + keyword-rich for BM25/regex tool search; deep docs in
   `cork_help` and in per-parameter `.meta({description})`.
2. `$defs`-deduped schemas (`reused: "ref"`), flat inputs, no redundant enums repeated per tool.
3. Concise-by-default outputs with `response_format` escape hatch; hard caps + `nextCursor`-style
   pagination inside tool results.
4. Optional `--toolsets markets,tx,rfq` server flag (GitHub/Playwright pattern) so embedders can
   trim the surface; dynamic `listChanged` only as a later nicety.
5. No bespoke tool-search tool — native client tool search (Claude Code auto ≥10% context) covers it.

At ~11 tools with tight schemas, cork sits comfortably under every client's confusion threshold;
the granularity lever (toolsets/dynamic) is designed-in but not needed on day one.

---

## Source index

- Zod v4: https://zod.dev/v4 · https://zod.dev/json-schema · https://zod.dev/metadata · https://zod.dev/codecs · https://colinhacks.com/essays/introducing-zod-codecs
- zod-to-json-schema EOL: https://www.npmjs.com/package/zod-to-json-schema · https://github.com/StefanTerdell/zod-to-json-schema
- Standard (JSON) Schema: https://standardschema.dev/json-schema
- MCP TS SDK: https://github.com/modelcontextprotocol/typescript-sdk · docs/servers/tools.md · docs/advanced/schema-libraries.md · docs/servers/notifications.md · docs/migration/upgrade-to-v2.md · https://ts.sdk.modelcontextprotocol.io/v2/
- MCP spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools · https://modelcontextprotocol.info/specification/2025-11-25/changelog/ · https://modelcontextprotocol.io/seps/986-specify-format-for-tool-names
- Anthropic: https://www.anthropic.com/engineering/writing-tools-for-agents · https://www.anthropic.com/engineering/advanced-tool-use · https://www.anthropic.com/engineering/code-execution-with-mcp · https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool · https://code.claude.com/docs/en/mcp
- Large servers: https://github.com/github/github-mcp-server (+ docs/server-configuration.md) · https://playwright.dev/mcp/capabilities · https://github.com/microsoft/playwright-mcp
- CLI prior art: https://github.com/mmkal/trpc-cli (README: flags mapping, jsonInput, standalone, typebox vendoring)
- EVM types: https://abitype.dev/api/zod (deprecated → ox/zod) · https://oxlib.sh/
- Client gaps: https://github.com/openai/codex/issues/28858 (pagination) · https://github.com/anthropics/claude-code/issues/18298 (tool-search threshold)
