# CLAUDE.md — cork-helper-cli

Cork Phoenix **MCP server + CLI over one typed core** (RFC 011). MCP and CLI are thin projections of
the same `runTool` dispatch over the same 9-tool registry — no logic forks between surfaces.

## Runtime (non-negotiable)

Run everything with **Bun**, never `node`. The `.ts` sources use TypeScript parameter properties and
`.ts` import specifiers; Node's native type-stripping rejects both (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
Bun 1.3 is pinned in `mise.toml`.

- MCP server (stdio): `bun packages/mcp/src/bin.ts`
- CLI: `bun packages/cli/src/bin.ts <command> [--json '<input>'] [--rpc-url <url>] [--explain]`
- Typecheck / test: `bun run typecheck` · `bun run test` (fork-parity self-skips unless `CORK_TEST_RPC` is set)

## Install / verify as an MCP server

```sh
bun install                                                                              # from repo root, once
claude mcp add cork-defi -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"        # config-only + pure math
claude mcp add cork-defi -e CORK_RPC_URL=<url> -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"  # + chain reads
claude mcp list          # expect: cork-defi … ✔ Connected
```

Use the **absolute** `bun` path (`"$(mise which bun)"`, or `"$(which bun)"` without mise): the server
is spawned as a subprocess that may not inherit the shell `PATH`, so a bare `bun` can fail "command
not found." The two variants share one name — re-adding errors; `claude mcp remove cork-defi` to
switch. Never pair `-s project` (writes a committed `.mcp.json`) with `-e CORK_RPC_URL` — the RPC
endpoint value must not enter git.

Health check: call `cork_capabilities` with no args — a good install returns exactly **9 tools**. If
tools aren't visible, the stdio server failed to launch (Bun missing, `bun install` not run, bare
`bun` not on the spawn PATH, or a non-absolute script path in the `add` command).

## The 9 tools — pick by intent

| Tool | Use when | Phase |
|---|---|---|
| `cork_capabilities` | Discover/introspect: list tools, `search` by keyword, `topic` for docs, `topic:"verify"` re-derives deployed addresses via CREATE2. Start here when unsure. | 1 |
| `cork_query` | **State reads** — markets, account-state, whitelist, protocol-config (and indexer feeds when available). NOT derived math, NOT tx building. | 1 |
| `cork_compute` | **Deterministic math** over verified state — swap/unwind rate, rollover premium floor, worst-case impairment floor. NOT raw reads, NOT byte-building. | 1 |
| `cork_decode` | Bytes → labeled JSON. Recursively unwraps Bundler3 multicall. Reconstructs from bytes; never trusts a supplied parse [K3]. | 1 |
| `cork_prepare_phoenix` | Build an **unsigned** Bundler3 bundle for any of the 13 adapter actions (+ token-authority ops). Auto-adds funding legs. Returns bytes for later signing — executes nothing [K1]. | 2 |
| `cork_prepare_orders` | Build **unsigned** 1inch limit-order typed-data (maker-order / cancel) for later signing. | 3 |
| `cork_track` | Verify a resource against chain, simulate frozen bytes, or reconcile a receipt/order to a lifecycle state. Chain outranks indexer; disagreement → `conflict` [K7]. | 2 |
| `cork_prepare_market` | Market-deployment artifacts. **Provisional/gated** [Q-REG]. | 4 |
| `cork_submit` | The **only** side-effecting tool: relays a caller-signed order to the orderbook service. Transmits an already-signed payload; never signs [K1]. | 3 |

## Reading the result envelope

Every tool returns `{ state, data, warnings[], provenance, schemaVersion }`. **Check `state` before
trusting `data`:**

- `ok` — use `data`.
- `unavailable` — the variant is honestly not implemented / a dependency is missing. `warnings[0].code`
  tells you why: `requires_rpc` (install with `-e CORK_RPC_URL`), `needs_indexer`, `needs_service`,
  `phase_gated`, `unknown_topic`. **Do not retry the same call** and do not fabricate the answer —
  report the reason. Backend-gated variants (orderbook/fills/flows, order submission, taker-fill,
  rollover-intent, dutch-auction-price, rfq-quote, market deployment) stay `unavailable` by design.
- `conflict` — a verification mismatch (e.g. `digest_mismatch`); surface it, don't paper over it.

CLI exit codes mirror state for scripting: `0` ok · `2` invalid input · `3` unavailable · `4` conflict
· `1` unexpected error.

Every tool's input takes an optional `format`: `"concise"` (default) or `"full"` (verbose envelope) —
omit it unless you need the fuller shape.

## When you need an RPC

Config-only / pure (no RPC): `cork_capabilities`, `cork_decode`, `cork_query resource:"protocol-config"`,
`cork_compute kind:"rollover-premium-floor"`, and `cork_prepare_*` byte-building (note:
`cork_prepare_phoenix` funding legs need an RPC to resolve token addresses — without it you get the
bundle plus a `funding_needs_rpc` warning and `fundingLegs:0`).

Chain-backed (need `CORK_RPC_URL`): `cork_query` market / account-state / pool-whitelist,
`cork_compute` cst-swap-rate / unwind-rate / impairment-floor, `cork_track` marketRef. These return
`unavailable` + `requires_rpc` when no RPC is configured.

## Invariants that constrain how you use the tools

- **Prepare ≠ sign ≠ submit** [K1]. `cork_prepare_*` return unsigned bytes/typed-data. Nothing is
  signed or broadcast except `cork_submit`, which only relays a payload the caller already signed.
- **Idempotency** [K2]. `cork_prepare_*` and `cork_submit` take a `clientRequestId` — reuse the same id
  to make a retry idempotent; use a fresh id for a genuinely new request.
- **Never commit an RPC URL.** `CORK_RPC_URL` / `CORK_TEST_RPC` come from the environment only.
- **Math is bit-exact and empirically verified** against live on-chain reads (wei-for-wei). Trust the
  tool's numbers over hand-derived ones.

## Layout

`packages/schemas` (zod v4 source of truth + registry) · `packages/core` (math ports, chain reads,
Bundler3 encode/decode, `runTool` dispatch) · `packages/mcp` (stdio server) · `packages/cli` (commander
projection). Tests: `packages/core/test/` (unit + `fork-parity`/`bundle-sim` vnet suites).
