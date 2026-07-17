# CLAUDE.md — cork-helper-cli

Cork Phoenix **MCP server + CLI over one typed core** (RFC 011). MCP and CLI are thin projections of
the same `runTool` dispatch over the same 9-tool registry — no logic forks between surfaces.

## Runtime (non-negotiable)

Run everything with **Bun**, never `node`. The `.ts` sources use TypeScript parameter properties and
`.ts` import specifiers; Node's native type-stripping rejects both (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
Bun 1.3 is pinned in `mise.toml`.

- MCP server (stdio): `bun packages/mcp/src/bin.ts`
- CLI: invoked as **`ch`** (launcher `bin/ch`; put `bin/` on PATH). `ch <command> [--json '<input>'] [--rpc-url <url>] [--explain]`. Long form without PATH setup: `bun packages/cli/src/bin.ts <command> …`
- Typecheck / test: `bun run typecheck` · `bun run test` (network suites self-skip without env) ·
  `bun run test:unit` (offline only) · `bun run test:live` (vnet/live suites; need `CORK_TEST_RPC` / `CORK_RPC_LIVE=1`)

## Install / verify as an MCP server

```sh
mise trust && mise install                                                               # fresh checkout: trust mise.toml + install pinned Bun
bun install                                                                              # from repo root, once
claude mcp add cork-defi -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"        # config-only + pure math
claude mcp add cork-defi -e CORK_RPC_URL=<url> -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"  # override built-in RPCs
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

Every tool returns `{ state, data, warnings[], provenance, schemaVersion }` — over MCP this arrives
as `structuredContent`, and every tool advertises this envelope as its `outputSchema`. **Check
`state` before trusting `data`:**

- `ok` — use `data`.
- `unavailable` — honestly not servable right now; `warnings[0].code` says why (table below). **Do not
  retry the same call** and do not fabricate the answer — report the reason. Backend-gated variants
  (orderbook/fills/flows, order submission, taker-fill, rollover-intent, dutch-auction-price,
  rfq-quote, market deployment, decode order/event/receipt, track simulate) stay `unavailable` by design.
- `conflict` — the tool executed and found a mismatch (e.g. `digest_mismatch`, `marketid_mismatch`);
  surface it, don't paper over it. On MCP, `conflict` is NOT an error result; `unavailable` is.

Warning codes you will encounter:

| Code | Meaning / what to do |
|---|---|
| `requires_rpc` | No RPC resolved (offline, or a chain outside defaults+fallback like vnet 49222). Set `CORK_RPC_URL`. |
| `unknown_deployment` | No (or partial) Cork deployment config for this chainId — e.g. tx-path building or pool-whitelist on Arbitrum. Not fixable by adding an RPC. |
| `chain_read_failed` | The RPC answered but the read reverted/failed — most often a pool that doesn't exist on that chain (e.g. a vnet-only fixture pool queried against real mainnet). Check the poolId/chainId pairing. |
| `needs_indexer` / `needs_service` | Backend (indexer / orderbook / rollover service) not wired yet. |
| `phase_gated` | Variant not implemented in this iteration (incl. `cork_submit`, `track mode:"simulate"`). |
| `missing_filter` | The resource needs `filters.poolId` / `filters.account`. |
| `unknown_topic` / `no_lop` | Capabilities topic not found / no 1inch LOP deployment for the chain. |
| `receipt_not_found` | txHash unknown/pending at the RPC (a normal outcome, not a failure). |
| `rpc_fallback` | Informational on `ok`: the default RPC was down, a chainlist public endpoint served the read. |
| `funding_needs_rpc` / `manual_funding` / `owner_managed_funding` | Informational on `ok` prepare results: why funding legs were omitted. |
| `digest_mismatch` / `marketid_mismatch` / `create2_mismatch` | On `conflict`: what failed verification. |

CLI exit codes mirror state for scripting: `0` ok · `2` invalid input (schema or malformed
`filters.*`) · `3` unavailable · `4` conflict · `1` unexpected error.

Every tool's input takes an optional `format`: `"concise"` (default) or `"full"`. `"full"` adds
`provenance.rpc = { source: explicit|default|chainlist, host }` on chain-backed reads — use it when
you need to know which endpoint served the data. Some schema fields are accepted but reserved for
later phases (`cork_query` `mode`/`cursor`/`pageSize`, `cork_compute` `at.timestamp`,
`cork_prepare_phoenix` `account`) — passing them is harmless; don't expect them to change behavior.

## RPC resolution (chain-backed tools work by default)

Chain reads pick an endpoint automatically: **explicit** (`CORK_RPC_URL` / `--rpc-url`, used verbatim)
→ **built-in default** (committed endpoints for mainnet + Arbitrum, retried with backoff behind a
per-endpoint circuit breaker) → **chainlist.org fallback** (public chains 1/42161/8453/11155111:
fetch candidates just-in-time, latency-probe, verify chainId, pick fastest). Chosen endpoint + breaker
state are cached in-process and on disk (`~/.cache/cork-helper-cli/`, override `CORK_RPC_CACHE_FILE`).
A chainlist fallback adds an `rpc_fallback` warning to the envelope.

So `cork_query` market/account-state/pool-whitelist, `cork_compute` cst-swap-rate/unwind-rate/
impairment-floor, and `cork_track` marketRef **just work** on public chains — no RPC setup. They only
return `requires_rpc` when nothing resolves (offline, or an ineligible chain like the staging vnet
49222, which needs an explicit `CORK_RPC_URL`). Set `CORK_RPC_URL` to override with a private/faster
node. Pure/config tools never touch a chain: `cork_capabilities`, `cork_decode`, `cork_query
resource:"protocol-config"`, `cork_compute kind:"rollover-premium-floor"`, `cork_prepare_*` byte-building.
(`cork_prepare_phoenix` funding-leg token resolution still needs an *explicit* RPC — offline by default,
so without one you get the bundle plus a `funding_needs_rpc` warning and `fundingLegs:0`.)

Per-chain deployment coverage (`config.ts DEPLOYMENTS`): chainId 1 is **full** (all 5 contracts;
prepare + all reads). chainId 42161 is **partial, read-path only** — poolManager + constraintAdapter
were empirically derived (API + debug_traceCall calibrated against mainnet) so market/account-state/
compute/track reads work, but corkAdapter/bundler3/whitelistManager are unknown → prepare_phoenix and
pool-whitelist return `unknown_deployment` there. A real mainnet pool for examples/tests:
`0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05` (current list:
`api-phoenix.cork.tech/v1/pools/`). The vnet fixture pool `0xceeb…c16a` exists ONLY on the vnet —
querying it on chainId 1 without a vnet RPC yields `chain_read_failed`, by design.

## Invariants that constrain how you use the tools

- **Prepare ≠ sign ≠ submit** [K1]. `cork_prepare_*` return unsigned bytes/typed-data. Nothing is
  signed or broadcast except `cork_submit`, which only relays a payload the caller already signed.
- **Idempotency** [K2]. `cork_prepare_*` and `cork_submit` take a `clientRequestId` — reuse the same id
  to make a retry idempotent; use a fresh id for a genuinely new request.
- **Never commit an RPC URL** — `CORK_RPC_URL` / `CORK_TEST_RPC` come from the environment only. The
  two built-in default endpoints (mainnet/Arbitrum, in `chain/rpc.ts`) are a deliberate committed
  exception (owner decision); don't add more committed endpoints.
- **Math is bit-exact and empirically verified** against live on-chain reads (wei-for-wei). Trust the
  tool's numbers over hand-derived ones.

## Layout

`packages/schemas` (zod v4 source of truth + registry) · `packages/core` (math ports, chain reads,
Bundler3 encode/decode, `runTool` dispatch) · `packages/mcp` (stdio server) · `packages/cli` (commander
projection). Tests: `packages/core/test/` (unit + `fork-parity`/`bundle-sim` vnet suites).
