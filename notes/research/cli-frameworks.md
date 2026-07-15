# CLI framework evaluation for `cork`

Date: 2026-07-15. Researched for a strictly-typed TypeScript CLI that doubles as an MCP server
(`cork mcp serve`), noun-verb subcommand tree (markets/orders/rates/tx/decode/meta/rfq/search/mcp),
JSON-first output for agents, zod at the boundary, Node LTS + Bun, npm/npx distribution.

**Hard requirements recap:**
- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` must be clean.
- The dream: ONE schema definition → CLI flags/validation + MCP tool `inputSchema` + TS types.
- Machine-readable JSON is the primary output; human-pretty is secondary.

**Key ecosystem fact discovered up front:** the official MCP TypeScript SDK v2 (targeting the
2026-07-28 spec, stable expected late July 2026) accepts **Standard Schema** for tool
input/output schemas — zod v4 works natively (`registerTool({ inputSchema: z.object({...}) })`),
with a fallback shim for zod 4.0–4.1. Zod v4 also ships built-in `z.toJSONSchema()`. So the MCP
half of the "one schema" dream is already solved by zod v4 itself; the only open question is
**which CLI layer can consume the same zod schemas**.

---

## Candidates

### 1. oclif (`@oclif/core` v4.11.14, 2026-07-02, ~6.8M dl/wk)

- **(a) Type inference:** Class-based commands; `const {flags, args} = await this.parse(MyCmd)`
  infers types from the static `flags`/`args` definitions. Inference is decent but flows through
  class statics and generics; noticeably more ceremony than the functional frameworks. No casts
  needed in the happy path.
- **(b) Zod interop:** None native. Flags are oclif's own `Flags.string()/integer()/custom()`
  builders. You can put a zod `parse` inside a custom flag's `parse` fn, but there is no
  schema→flags derivation. Double definition guaranteed.
- **(c) Subcommands / lazy loading:** Best-in-class. File-per-command convention + generated
  `oclif.manifest.json` means only the invoked command module is loaded. Deep noun-verb trees
  (`topic:command` or spaced topics) are its home turf (Salesforce CLI, Heroku CLI).
- **(d) `--json` discipline:** The only framework with a first-class story: set
  `static enableJsonFlag = true` and the return value of `run()` is printed as JSON, all other
  output suppressed, errors emitted as JSON too (`this.jsonEnabled()`). This is exactly the
  discipline cork wants — but it's the only part of oclif we'd want.
- **(e) Maintenance:** Excellent. Salesforce-backed, weekly releases, v4 line active July 2026.
  Bus factor low risk.
- **(f) exactOptionalPropertyTypes:** Works, but oclif's own types are the loosest of the strict
  candidates; historical issues with flag default/`undefined` interplay. Not a blocker.
- **(g) Weight:** Heavy. 18 runtime deps in core (ejs, minimatch, semver, ansis, …) plus a plugin
  ecosystem (`@oclif/plugin-help`, `plugin-autocomplete`, `plugin-not-found`). Largest install
  footprint of all candidates. npx cold start is the worst here.
- **(h) Help/completions:** Excellent help; completions via official plugin (bash/zsh/pwsh).
- **Verdict:** Built for exactly this shape of CLI, but heavy, zod-blind, and class-y. You'd be
  fighting it to keep one-schema.

### 2. clipanion (v4.0.0-rc.4, published 2024-09; last stable 3.2.1 from 2023-06)

- **(a)** Class-based with `Option.String()` property builders; inference is good.
- **(b)** Validation via **typanion**, not zod. No zod derivation.
- **(c)** No built-in lazy loading; all command classes are registered up front.
- **(d)** No JSON output helpers.
- **(e) MAINTENANCE RED FLAG:** repo untouched since **2024-09-06** (22 months as of today);
  `latest` npm tag has pointed at a **release candidate** (4.0.0-rc.4) that entire time; last
  stable is from mid-2023. 4.4M dl/wk is inertia from Yarn. Effectively dormant single-maintainer
  (arcanis) project whose maintainer's attention is on Yarn itself.
- **(f)** OK under strict settings (Yarn compiles strict), but the class-property pattern hides
  optionality behind `Option.String({required: false})` → `string | undefined` fields.
- **(g)** 1 dep (typanion). Light.
- **(h)** Rich help (HTML-ish formatting); no shell completions built in.
- **Verdict:** Eliminate on maintenance alone.

### 3. cmd-ts (v0.15.0, 2026-02-12, ~236k dl/wk)

- **(a)** Functional combinators with a `Type<From, To>` decode abstraction; handler receives
  precisely inferred types. The nicest pure-inference design of the older generation.
- **(b)** The `Type` abstraction means you can wrap a zod schema per-argument in ~5 lines
  (`from: async (s) => schema.parse(s)`), but there is no object-schema→flags derivation.
- **(c)** `subcommands({...})` nests fine; no lazy loading — everything imports eagerly.
- **(d)** No JSON output helpers.
- **(e) MAINTENANCE RED FLAG (moderate):** single maintainer (Schniz), 54 open issues, release
  cadence roughly one minor per year (0.14 → 0.15 gap), repo last pushed 2026-04. Alive but
  clearly in low-energy maintenance mode. Docs site half-finished for years.
- **(f)** Optionality typed as `T | undefined`; fine under exactOptionalPropertyTypes in our
  testing of its published types, but the async `Type` chain can produce awkward `unknown` edges.
- **(g)** 4 deps (chalk, debug, didyoumean, strip-ansi) — chalk in a parser is a smell.
- **(h)** Good help; no completions.
- **Verdict:** Pleasant API, but risk-adjacent on maintenance and gives us neither lazy loading
  nor schema derivation. Pass.

### 4. stricli (`@stricli/core` v1.2.9, 2026-07-02, ~515k dl/wk)

- **(a) Type inference:** "Form follows function" — you declare the flags **interface** and the
  framework's conditional types force the parser spec to match it. Handler receives exactly the
  declared type, `this`-bound to an injectable context (great for testing). No casts.
- **(b) Zod interop:** Per-flag only. `kind: "parsed"` flags take any `(input: string) => T`
  function and the docs **explicitly recommend zod/typanion** as parsers. But flags are defined
  flag-by-flag; no `z.object()` → flags derivation exists (no open issue asking for it either).
  A ~100-line `zodObjectToStricliFlags` adapter is feasible (zod v4 exposes enough introspection)
  but it's ours to write and type-check.
- **(c) Subcommands / lazy loading:** First-class. `buildCommand({ loader: () => import('./impl') })`
  loads only the requested command's implementation; route maps nest arbitrarily. Help text renders
  without loading impls. Exactly right for a big noun-verb tree and npx cold starts.
- **(d) `--json`:** Nothing built in; you own stdout. Neutral (we'd standardize our own envelope).
- **(e) Maintenance:** Healthy. Bloomberg OSS, releases through July 2026, ~1.1k stars, used for
  Bloomberg-internal CLIs (institutional incentive to maintain). Bus factor: effectively one
  primary engineer (Michael Molisani) but with corporate backing. 515k dl/wk and growing.
- **(f) exactOptionalPropertyTypes:** The strongest story of any candidate — strict mode is a
  documented **requirement** (`strictNullChecks` off is unsupported), and optional flags are
  type-gated: a flag may only be `optional: true` when the target property is `undefined`-capable.
  Designed by people who run maximal-strict tsconfigs.
- **(g)** **Zero runtime dependencies.** Smallest total footprint of the "real framework" tier.
- **(h)** Auto help + **built-in shell autocomplete** (`@stricli/auto-complete`), enum flags feed
  completions automatically.
- **Verdict:** Best pure CLI engineering in the field. Its one gap is the one we care most
  about: no schema-object derivation, so the MCP `inputSchema` and the CLI flags are two
  definitions unless we write the adapter.

### 5. citty (unjs, v0.2.2, 2026-04-01, ~23.8M dl/wk)

- **(a)** Declarative `defineCommand({args: {...}})`. Inference improved in 2025 (enum unions,
  `T | undefined` optionals) but has a documented history of weak types (`string | boolean`
  unions, issues #148/#180) and is still v0.2.x.
- **(b)** No zod/standard-schema support; its own arg spec.
- **(c)** Lazy subcommands supported (`subCommands: { foo: () => import('./foo') }`) — good.
- **(d)** No JSON helpers.
- **(e)** unjs-backed, huge downloads via nuxi/nitro, but 62 open issues and low maintenance
  priority relative to other unjs packages; long gaps between minors. Not dead, not loved.
- **(f)** Improved but historically the weakest strictness of the bunch; would need auditing
  under exactOptionalPropertyTypes.
- **(g)** Zero deps. Tiny.
- **(h)** Usage/help auto-render; no completions.
- **Verdict:** Fine for a nuxt-flavored quick tool; under-typed and under-specified for a
  strictness-first flagship CLI.

### 6. commander (+ zod manually) (v15.0.0, 2026-05-29, ~348M dl/wk)

- **(a)** `program.opts()` is untyped by default; the official companion
  `@commander-js/extra-typings` recovers inference from builder-chain string literals — decent,
  but the types are inferred from flag *strings* (`'--foo <value>'`), which is clever and brittle.
- **(b)** Manual: define zod schema, parse `opts()` through it in every action. Double definition
  unless you write your own zod→commander generator — which is literally what trpc-cli is (see
  below), so hand-pairing commander+zod yourself is strictly dominated by either trpc-cli or the
  no-framework path.
- **(c)** Subcommands fine; lazy loading only via the old stand-alone-executable convention or
  manual dynamic import inside actions.
- **(d)** No JSON discipline helpers.
- **(e)** Bulletproof maintenance; the safest dependency in the JS ecosystem.
- **(f)** OK; the untyped core is the issue, not strictness flags.
- **(g)** Zero deps.
- **(h)** Excellent help; no built-in completions.
- **Verdict:** Great substrate, wrong altitude on its own.

### 7. brocli (`@drizzle-team/brocli` v0.12.0, 2026-04-07, ~10.4M dl/wk)

Confirmed: **drizzle-kit's CLI is built on brocli** (that's where the downloads come from).
- **(a)** Builder options (`string().required()`, `boolean()`, `positional()`); handler params
  inferred; `TypeOf` utility for external handlers. Good inference, small surface.
- **(b)** No zod/standard-schema interop; its own mini validation chain (`.enum() .min() .int()`).
- **(c)** Nested `subcommands` supported (with the quirk that a command can't mix subcommands and
  positionals); **no lazy loading**.
- **(d)** No JSON output helpers; does have `commandsInfo()` introspection ("docs generation API")
  — structured command metadata, but not JSON Schema.
- **(e)** Built by and for the Drizzle team; releases when drizzle-kit needs them (last: Apr 2026);
  still 0.x; tiny issue tracker. Healthy-by-association but roadmap is "whatever drizzle-kit
  needs" — features you need that drizzle-kit doesn't will sit.
- **(f)** Fine under strict settings in spot checks; small enough type surface to audit fully.
- **(g)** Zero deps.
- **(h)** Custom-themeable help; no completions.
- **Verdict:** Solid, boring, zod-blind. If we wanted a brocli-shaped thing with zod, we'd write
  the no-framework version instead.

### 8. trpc-cli (mmkal, v0.15.1, 2026-06-19, ~147k dl/wk)

The only candidate that actually delivers the one-schema dream **today**.
- **(a) Type inference:** Full tRPC inference — the procedure handler receives the zod schema's
  output type exactly, including transforms/refinements. No casts anywhere. (Also works with
  oRPC, and ships a built-in dependency-free "norpc" procedure builder, so adopting it does NOT
  require running a tRPC server.)
- **(b) Zod interop — the headline:** CLI positionals and `--options` are **derived from the
  procedure's zod input schema** via JSON Schema. **Zod v4 supported now**, including
  `z.string().meta({positional: true})`, `meta({alias: ...})` for short flags, descriptions →
  help text, defaults shown in help. Also accepts arktype, valibot, effect Schema, and TypeBox
  (vendored `Type.Script`) — anything JSON-Schema-convertible. Nested objects fall back to JSON
  input rather than being unrepresentable.
- **(c) Subcommands:** Nested routers → nested commands, arbitrarily deep — matches the
  markets/orders/rates/... tree naturally. **Lazy loading is the weak spot:** the whole router is
  imported at startup. Mitigation: keep command modules thin and dynamic-import heavy deps (viem,
  ABIs) inside handlers; parsing itself is commander (fast).
- **(d) JSON / agent-first — the second headline:** `jsonInput: 'auto'` gives every command a
  `--json '<complete input>'` alternative to flags — the README explicitly calls out
  machine-generated invocations ("an LLM calling your CLI") as the use case; the payload still
  runs through the zod schema. Procedures whose inputs can't map to flags automatically become
  `--json`-only instead of being dropped. Return values go through a pluggable logger (default
  `console.info`; a yaml-table logger exists) — a strict `--json`-output envelope is ~20 lines of
  our own wrapper. `cli.toJSON()` dumps the full command/option tree for docs.
- **MCP synergy:** the same router feeds MCP directly — either loop over procedures and call
  `server.registerTool(name, {inputSchema: proc.inputSchema}, handler)` (SDK v2 takes zod v4
  natively), or use community adapters (`trpc-mcp`, `trpc-to-mcp` which exposes
  `extractToolsFromProcedures` + `createMcpServer`). One definition → CLI + MCP + types, verified
  to exist end-to-end today.
- **(e) Maintenance — the main risk:** single maintainer (mmkal, prolific and responsive; repo
  pushed 2026-07-13), 147k dl/wk and rising, but **0.x with documented breaking changes between
  minors** (e.g. `--input` → `--json` rename, `jsonInput` boolean → enum). Bus factor 1, no
  corporate backing.
- **(f) exactOptionalPropertyTypes:** inference is zod's own (`.optional()` → `prop?: T |
  undefined`), which is clean under exactOptionalPropertyTypes in zod v4. trpc-cli itself
  publishes strict types; low risk, verify in the spike.
- **(g)** Exactly one hard dep: **commander**. tRPC/oRPC/zod are optional peers; omelette
  (completions) optional.
- **(h)** Help auto-generated from schemas (descriptions, defaults, enums); shell completions via
  optional omelette peer (bash/zsh; clunkier than stricli's but present).
- **Verdict:** Highest fit-to-requirements; the risk is concentrated in maintenance, and the
  blast radius is small because command definitions are just zod-typed procedures (see
  "exit strategy" below).

### 9. gunshi (kazupon, v0.37.0, published 2026-07-15, ~46k dl/wk)

- Declarative typed args (via `args-tokens`), **lazy-loading subcommands**, plugin system with
  official `@gunshi/plugin-completion`, i18n, "agent-aware" env detection (`gunshi/agent`), zero
  deps. Very active (released today), maintained by kazupon (vue-i18n maintainer).
- No zod/standard-schema derivation; its own arg spec. Pre-1.0 with fast-moving APIs (0.27→0.37
  in months); essentially bus factor 1; small adoption.
- **Verdict:** The most interesting newcomer — watch it — but too young and zod-blind for a
  flagship.

### 10. @effect/cli (v0.76.0, 2026-07-13, ~210k dl/wk)

- Superb feature set: composable `Command`/`Options`/`Args`, built-in `--wizard` interactive mode,
  built-in `--completions bash|zsh|fish|sh`, env-var fallbacks, typed errors. Very active, backed
  by Effectful Technologies.
- **But:** schemas are **Effect Schema**, not zod; handlers are `Effect<...>` values; you buy the
  whole Effect runtime, generators, layers. For a zod-centric codebase this means either running
  two schema libraries (CLI in Effect Schema, MCP in zod — the exact opposite of one-schema) or
  migrating the whole boundary to Effect Schema (Standard Schema helps at the MCP edge, since SDK
  v2 accepts any Standard Schema — Effect Schema qualifies — but the team then writes Effect
  everywhere). Perpetually 0.x by policy tied to effect core.
- **Verdict:** Only correct if the team wants Effect as an application framework. For cork's
  stated zod-at-the-boundary design, the buy-in is not justified.

### 11. zodest (v0.3.2, 2025-04-18, ~20 dl/wk)

Dead on arrival: 20 downloads/week, no release in 15 months. Eliminate.

---

## What the big CLIs actually use (mid-2026)

| CLI | Framework | Note |
|---|---|---|
| drizzle-kit | **brocli** (their own) | rolled their own after outgrowing commander |
| wrangler (Cloudflare) | **yargs** + internal `CommandRegistry` abstraction | effectively a hand-rolled typed registry over a legacy parser |
| vercel | **vercel/arg** (their own micro-parser) + hand-rolled command table | no framework |
| supabase | Go + cobra | N/A to JS comparison |
| yarn | clipanion (their own) | the framework is dormant outside yarn |
| Salesforce/Heroku | oclif (their own) | the origin story |
| MCP server ecosystem | mostly commander or yargs + zod schemas passed to `registerTool` | SDK v2 = Standard Schema/zod v4 native |

Pattern worth naming: **every large production CLI either wrote its own framework or wrapped a
dumb parser in its own typed registry.** Frameworks get outgrown at scale; schema-first
registries survive.

## The no-framework option: hand-rolled router + zod

Since `cork mcp serve` already requires a registry of `{name, description, zodSchema, handler}`
per tool, the CLI could be a thin projection of that same registry:

- **What you write (~300–500 lines, once):** argv walker for the noun-verb tree with dynamic
  `import()` per command dir; a zod-v4→flags mapper (introspect `z.object` shape → `--kebab-case`
  flags, enums, defaults, arrays) or skip flags entirely for complex inputs and standardize
  `--json '<input>'` (agents, the primary consumers, prefer this anyway — same conclusion
  trpc-cli reached); help text rendered from the zod JSON Schema (`z.toJSONSchema()` is built
  in); a strict output envelope `{ok, data} | {ok:false, error}` printed as JSON by default.
- **What you give up:** shell completions, `did you mean`, edge-case argv handling
  (`--flag=value`, `--`, negation, variadic quirks), and someone else maintaining all of that.
- **Cost/benefit:** genuinely viable here — better than for most CLIs — because (1) the schema
  registry must exist anyway for MCP, (2) agents-first means `--json` input/output carries most
  traffic, and human flag ergonomics are secondary, (3) zero framework risk under
  exactOptionalPropertyTypes since every line is ours. The catch: trpc-cli **is** this pattern,
  productized, with the argv edge cases already handled by commander underneath. Hand-rolling is
  the fallback if trpc-cli's maintenance fails, not the starting point.

---

## Comparison table

| | typed handler input | zod→flags derivation | zod v4 | subcmd tree | lazy load | --json discipline | help | completions | deps | maintenance (2026-07) | strict-TS risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **trpc-cli** | ✅ exact (tRPC infer) | ✅ **derived from schema** | ✅ | ✅ nested routers | ⚠️ router eager; lazy-import inside handlers | ✅ `--json` input for agents; output via pluggable logger | ✅ from schema | ⚠️ via omelette peer | 1 (commander) | ⚠️ active; solo maintainer, 0.x breaking changes | low |
| **stricli** | ✅ exact (type-first) | ❌ per-flag parse fn (zod usable per flag) | n/a | ✅ route maps | ✅ **loader/import()** | ❌ BYO | ✅ | ✅ built-in | **0** | ✅ Bloomberg, active | **lowest** (strict required by design) |
| **oclif** | ✅ good | ❌ | n/a | ✅ topics | ✅ manifest | ✅ **enableJsonFlag** | ✅ | ✅ plugin | 18+ | ✅ Salesforce | low-med |
| **brocli** | ✅ good | ❌ | n/a | ✅ (no pos.+sub mix) | ❌ | ❌ | ✅ themeable | ❌ | 0 | ⚠️ drizzle-driven roadmap, 0.x | low |
| **gunshi** | ✅ good | ❌ | n/a | ✅ | ✅ | ❌ | ✅ pluggable | ✅ plugin | 0 | ⚠️ very active, solo, pre-1.0 | med (young) |
| **citty** | ⚠️ improved, historically weak | ❌ | n/a | ✅ | ✅ | ❌ | ✅ | ❌ | 0 | ⚠️ low priority in unjs | med |
| **commander+zod** | ⚠️ via extra-typings | ❌ manual pairing | manual | ✅ | ⚠️ manual | ❌ | ✅ | ❌ | 0 | ✅ bulletproof | low |
| **@effect/cli** | ✅ excellent | ❌ (Effect Schema, not zod) | ❌ | ✅ | ✅ | ⚠️ via Effect | ✅ | ✅ built-in | Effect runtime | ✅ active, 0.x forever | low but wrong schema lib |
| **cmd-ts** | ✅ good | ❌ (Type wrapper per arg) | n/a | ✅ | ❌ | ❌ | ✅ | ❌ | 4 (chalk…) | 🚩 slow solo maintenance | med |
| **clipanion** | ✅ good | ❌ (typanion) | n/a | ✅ | ❌ | ❌ | ✅ | ❌ | 1 | 🚩 **dormant since 2024-09; latest = 2yr-old RC** | med |
| **zodest** | — | ✅ (in theory) | ❌ | — | — | — | — | — | — | 🚩 **dead** (20 dl/wk) | — |
| **hand-rolled + zod v4** | ✅ exact (ours) | ✅ ours (`z.toJSONSchema`) | ✅ | ✅ ours | ✅ trivial | ✅ ours | ⚠️ ours to render | ❌ | 0 | you | none |

## Recommendation

**Adopt trpc-cli (v0.15.x) — but architect the codebase as a schema-first procedure registry, not
as "a trpc-cli app".**

Rationale:
1. It is the only maintained option where the zod schema **is** the CLI definition — flags,
   positionals, validation, help text, and handler types all derive from `z.object(...)` inputs,
   with zod v4 + `.meta()` support today. Every other framework requires defining inputs twice.
2. The same router projects onto MCP with near-zero glue: SDK v2 takes zod v4 Standard Schemas
   directly, and `trpc-to-mcp`/`trpc-mcp` (or a 30-line manual loop over procedures) already do
   this. `cork mcp serve` and `cork markets list` share one source of truth.
3. Its `jsonInput: 'auto'` (`--json '<whole input>'`) is purpose-built for LLM/agent callers —
   cork's primary consumers — and still validates through the schema.
4. tRPC-style inference means handlers get exact types with zero casts, and it holds up under
   exactOptionalPropertyTypes because the types are zod's own.
5. The dependency surface is one battle-tested package (commander) plus zod, which we have anyway.
   No tRPC server needed (built-in "norpc" builder, or oRPC).

**Risk management (this is load-bearing):** trpc-cli is a solo-maintainer 0.x project. Contain it:
pin the version; keep every command as a plain `{path, description, zod input, handler}` module in
`src/commands/**` with trpc-cli wiring confined to a single `src/cli.ts`; own the output envelope
(custom logger printing `{ok, data}` JSON; human-pretty behind `--pretty`). If the project stalls,
the exit is mechanical: the registry re-renders onto commander directly or onto a ~400-line
hand-rolled router (the MCP side doesn't change at all). Estimated migration cost if forced:
days, not weeks.

**Runner-up: stricli.** The best-engineered CLI framework of the field — zero deps, lazy loading
per command, built-in completions, and the only framework that *requires* strict TypeScript by
design. Choose it if human-operator UX and decade-scale stability outweigh the one-schema
requirement, and accept writing (and owning) a `zodObject → stricli flags` adapter plus a
schema/flag duplication risk wherever the adapter can't express something.

**What would change the decision:**
- trpc-cli goes quiet for 6+ months or zod-v4 mapping bugs accumulate → move to the hand-rolled
  registry (preferred over stricli at that point, since the registry already exists) or stricli +
  our adapter.
- Startup time under npx becomes a measured problem (large ABI/viem graph loaded eagerly by the
  router) and handler-level dynamic imports don't fix it → stricli's `loader:` model wins.
- The team decides to adopt Effect wholesale (fibers, layers, typed errors across the codebase) →
  @effect/cli becomes the right answer and Effect Schema replaces zod at the boundary.
- Gunshi reaches 1.0 with a Standard Schema args story → re-evaluate; it's the most promising
  newcomer.
- CLI grows a large interactive/human surface (prompts, tables, spinners, plugins) → oclif's
  batteries start paying for their weight.

**Explicit maintenance red flags recorded:** clipanion (dormant 22 months, `latest` = stale RC),
cmd-ts (solo, ~annual releases, 54 open issues), zodest (dead), citty (low unjs priority, still
0.2.x), brocli (roadmap subordinated to drizzle-kit), trpc-cli & gunshi (healthy activity but bus
factor 1, 0.x breaking changes).

---

### Sources (checked 2026-07-15)

- npm registry + download API for all packages (versions/dates/deps cited inline above)
- GitHub repo metadata: bloomberg/stricli, arcanis/clipanion, Schniz/cmd-ts, drizzle-team/brocli,
  unjs/citty, mmkal/trpc-cli, kazupon/gunshi, oclif/core
- [trpc-cli README](https://github.com/mmkal/trpc-cli) (zod v4, `--json` input, completions, toJSON)
- [Stricli docs](https://bloomberg.github.io/stricli/) (flags kinds, loader lazy-loading, strict-TS requirement) and [intro blog](https://bloomberg.github.io/stricli/blog/intro)
- [brocli README](https://github.com/drizzle-team/brocli); [drizzle-kit uses brocli (DeepWiki)](https://deepwiki.com/drizzle-team/drizzle-orm/3-drizzle-kit-(cli))
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — Standard Schema / zod v4 in v2; [PR #816](https://github.com/modelcontextprotocol/typescript-sdk/pull/816), [issue #925](https://github.com/modelcontextprotocol/typescript-sdk/issues/925)
- [trpc-mcp](https://github.com/Jacse/trpc-mcp), [trpc-to-mcp](https://github.com/iboughtbed/trpc-to-mcp)
- [Wrangler CLI uses yargs (DeepWiki)](https://deepwiki.com/cloudflare/workers-sdk/2-wrangler-cli); [vercel/arg](https://github.com/vercel/arg) + [vercel CLI command system (DeepWiki)](https://deepwiki.com/vercel/vercel/3-cli-system)
- [gunshi docs](https://gunshi.dev) / [kazupon/gunshi](https://github.com/kazupon/gunshi)
- [@effect/cli docs](https://effect-ts.github.io/effect/docs/cli) (wizard, completions, Schema integration)
- [citty typing issues #148](https://github.com/unjs/citty/issues/148), [#180](https://github.com/unjs/citty/issues/180)
