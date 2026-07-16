# Human & Script UX for the Cork CLI

How the polymorphic core (9 tools: six verbs + three family-scoped prepares) presents to humans and automation scripts. Companion to
`cork-cli-mcp-requirements-v2.md` (§3) and `multipurpose-agentic-tool-design.md`.

## 0. The core idea: three projections of one core

The 9 MCP tools (`query/compute/decode/prepare_phoenix/prepare_orders/prepare_market/track/capabilities/submit`) are the **agent
projection** of the core — optimized for context windows and schema-driven generation.
Humans should never type a discriminated union, and scripts should never parse a table.
So the CLI ships **three projections of the same core and the same schema registry**:

| Audience | Projection | Optimized for |
|---|---|---|
| Agents (MCP) | 9 polymorphic tools | context economy, closed schemas |
| Humans (TTY) | noun-verb command tree + aliases + context | memorability, few keystrokes, discoverability |
| Scripts (pipes/CI) | same commands with `--json`, stable envelope, exit-code contract | parseability, determinism, safe retries |

Because every subcommand is *generated from the same variant registry* that generates the
MCP schemas, the human tree can be rich (30+ subcommands) without any of the agent-side
context cost — subcommands are free for humans, tools are not free for agents. No drift
is possible: a new variant appears in all three projections in the same release.

## 1. The human command tree: noun-verb aliases over the polymorphic core

Follow the gh/stripe/kubectl convention (noun then verb), one level deep where possible
([clig.dev](https://clig.dev/): consistent subcommand grammar, human-first defaults).
Each subcommand is a **curried invocation** of one core primitive with the variant
pre-bound:

| Human command | Core invocation |
|---|---|
| `cork markets [ls]` | query{resource: markets} |
| `cork orderbook --market X` | query{resource: orderbook} |
| `cork fills --market X --since 1d` | query{resource: fills} |
| `cork whitelist <pool>` | query{resource: pool-whitelist} |
| `cork balance [account]` | query{resource: account-state} |
| `cork rate swap\|unwind <pool> <amount>` | compute{kind: cst-swap-rate \| unwind-rate} |
| `cork price auction\|rollover <order>` | compute{kind: dutch-auction-price \| rollover-price} |
| `cork floor <pool>` | compute{kind: impairment-floor} |
| `cork rfq <params>` | compute{kind: rfq-quote} |
| `cork decode <calldata\|order\|tx>` | decode{kind: auto-detected} |
| `cork tx mint\|unwind\|redeem\|repurchase <args>` | prepare{action.type: …} |
| `cork order make\|fill\|cancel <args>` | prepare{action.type: limit-order-…} |
| `cork order submit <artifact>` | submit{…} |
| `cork approve\|revoke <token>` | prepare{action.type: authority-…} |
| `cork status <tx\|order\|artifact>` | track{subject: …} |
| `cork search "<keywords>"` / `cork help <topic>` | capabilities{search \| topic} |

Two bridging affordances make the projections teach each other:

- **`--explain`** on any command prints the equivalent MCP tool-call JSON (and the
  equivalent `curl`/library call). Humans learn the agent surface for free; parity
  between lanes becomes trivially testable.
- **`cork call <tool> [json]`** invokes any of the 9 tools directly with raw JSON — the
  power-user/debugging path and the parity test harness.

## 2. Good defaults and the configuration cascade

Every parameter resolves through an explicit precedence chain (highest wins), and
`cork config where <key>` shows exactly which layer supplied a value:

1. command-line flag
2. environment variable (`CORK_CHAIN`, `CORK_MODE`, `CORK_RPC_URL`, `CORK_FORMAT`…)
3. sticky context (see §3)
4. project config (`cork.toml` in repo root — committed, shared by the team)
5. user config (`~/.config/cork/config.toml`)
6. built-in defaults (chain=mainnet, mode=lite-decentralized, format=auto, page size small)

Default behaviors that matter ([clig.dev](https://clig.dev/) throughout): output is a
human table when stdout is a TTY and **JSON when piped** (format auto-detection, with
`--json`/`--table` overrides); color honors `NO_COLOR` and disappears when piped; missing
*required* args prompt interactively on a TTY and **hard-fail with a copy-pasteable
corrected example** when not (never hang a CI job on a prompt); every error is the same
closed code + remediation the MCP lane returns; `--help` on every node includes 2–3 real
examples drawn from the same example registry that ships as MCP tool-use examples —
one source of examples serving humans and agents.

## 3. Currying mechanisms (explicitly)

"Currying" for a CLI = binding some arguments now so later invocations are short. Four
layers, in increasing stickiness:

1. **Inline scoping** — global flags accepted before the subcommand:
   `cork -c sepolia -m centralized orderbook --market X`.
2. **Sticky context** (kubectl-context style): `cork use chain mainnet`,
   `cork use market wstETH`, `cork use mode full-decentralized`; `cork use` shows the
   active context; `cork use --clear` resets. After `cork use market wstETH`, plain
   `cork orderbook` and `cork fills --since 1d` just work. Context is per-shell
   (env-backed) or per-project (written to `cork.toml`), never silently global.
3. **User-defined aliases with placeholders** (git/gh-alias style):
   `cork alias set sell-side 'orderbook --market $1 --side sell --json'` → `cork
   sell-side wstETH`. Aliases expand before parsing, print their expansion under
   `--explain`, and are shareable via the project config.
4. **Generated shell completions** (`cork completion zsh|bash|fish`) driven by the same
   schema registry — enum values, market names (cached), and flags complete; this is the
   cheapest discoverability win a CLI can ship.

Plus one interactive layer: **`cork repl`** — a session that holds context, keeps the
last result addressable (`$_`), and offers fuzzy search over variants. Optional, but
cheap because it's the same core; skip a full TUI until demand proves it.

## 4. The script/automation contract

Scripts are the third audience and get their own normative contract:

- **Stable JSON envelope** — identical to the MCP result envelope (`state`, `data`,
  `warnings`, `provenance`, `schemaVersion`). One schema documented once.
- **Exit-code contract**: `0` success · `1` invalid input · `2` unavailable/prerequisite
  · `3` conflict (chain-vs-service disagreement) · `4` transport/upstream failure.
  Distinct codes for the states scripts branch on.
- **Errors as JSON on stderr** with the same closed codes as the MCP lane; stdout stays
  pure data.
- **Determinism & idempotency**: `--request-id <id>` surfaces `clientRequestId`, so
  retrying a failed `cork order submit` in CI is byte-safe; list output ordering is
  documented and stable.
- **Streaming**: `--output ndjson` for long lists (one JSON object per line — jq- and
  xargs-friendly); explicit cursors; `--all` exists but with a hard safety cap and a
  printed warning.
- **`--dry-run`** on `submit` (and anything side-effecting) prints exactly what would be
  sent, then exits 0.
- **`--wait [--timeout]`** on `track` for the "block until confirmed" CI idiom.
- **No update nags, no telemetry prompts, no interactive anything** when stdout or stdin
  is not a TTY.

## 5. Discoverability loop

The same capability index that backs the agent's `cork_capabilities` backs the human's:
`cork search "dutch auction price"` returns the command, a filled example, and the doc
link; unknown subcommands get "did you mean" suggestions computed over the alias table
too; `cork docs [topic]` opens the versioned wiki page matching the installed release.
One index, three audiences.

## 6. What we deliberately do NOT do

- No verb-noun/noun-verb mixing (`cork list-markets` and `cork markets ls` both existing
  breeds doc rot) — nouns first, one blessed spelling, aliases for the rest.
- No hidden state mutations from context — `cork use` changes are always echoed, and
  every command's effective parameters are visible via `--explain`.
- No interactive prompts in pipes, no color codes in JSON, no mixing data and
  diagnostics on stdout.
- No bespoke output schema per subcommand — the envelope is the envelope.

## Sources

- [Command Line Interface Guidelines (clig.dev)](https://clig.dev/) — human-first design,
  machine output when piped, subcommand consistency, prompting rules
- [kubectl usage conventions & contexts](https://kubernetes.io/docs/reference/kubectl/)
  and [kubectl-aliases (generated alias families)](https://github.com/ahmetb/kubectl-aliases)
- [UX patterns for CLI tools (Lucas F. Costa)](https://lucasfcosta.com/2022/06/01/ux-patterns-cli-tools.html)
- [PatternFly CLI handbook](https://www.patternfly.org/developer-resources/cli-handbook/)
- [Writing CLI tools that AI agents actually want to use](https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no)
  — convergence of script-UX and agent-UX requirements
