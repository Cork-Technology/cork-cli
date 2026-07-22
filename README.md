# cork-helper-cli

TypeScript monorepo implementing the Cork Phoenix **MCP server + CLI over one typed core**
(RFC 011). This first iteration ships the Phase-1 read/math core, the Bundler3 bundle
builder/decoder, and the MCP + CLI projections — all grounded empirically against the live
Tenderly virtual-mainnet fixture pool (bit-exact, wei-for-wei).

## Packages

| Package | What it is |
|---|---|
| `@cork/schemas` | zod v4 single source of truth: hex-typed primitives, the 9-tool registry, `z.toJSONSchema` projection to MCP input schemas. |
| `@cork/core` | Deterministic bit-exact ports of on-chain math (`MathHelper`, `TransferHelper`, `ConstraintRateAdapter._calculateRate`, `PoolLib.preview*`), the committed-descent impairment floor, `MarketId`/CREATE2 derivation, chain reads (viem), the Bundler3 encoder/recursive decoder, and the shared tool dispatch (`runTool`). |
| `@cork/mcp` | MCP server projecting the registry via the low-level `Server` API (advertises JSON Schema directly; avoids the SDK's bundled-zod coupling). Stdio entry `packages/mcp/src/bin.ts` (package bin `cork-mcp`), launched by your MCP client under Bun — see "Use it with Claude Code" below. |
| `@cork/cli` | commander projection of the same registry — one command per tool at its `cliPath`, with `--json`, `--explain`, and state-mapped exit codes. Binary: `ch` (launcher at `bin/ch`). |

## Use it with Claude Code (MCP)

The MCP server exposes all 9 Cork tools to Claude Code (or any MCP client) over stdio. Claude
can then read protocol state, run the bit-exact math, and build unsigned bundles/orders for you —
without ever signing or broadcasting anything.

### 1. Prerequisites

The server and CLI are TypeScript run directly by **[Bun](https://bun.sh)** (Node's native
type-stripping can't run this code — it uses TypeScript parameter properties). Bun 1.3 is pinned in
`mise.toml`, so from the repo root:

```sh
mise trust        # trust this repo's mise.toml — one-time, REQUIRED on a fresh checkout
mise install      # installs the pinned Bun (or: curl -fsSL https://bun.sh/install | bash)
bun install       # install deps + link the workspace packages
```

(Skip `mise trust`/`mise install` if you already have Bun 1.3+ on your `PATH` by other means — then
just `bun install`.)

### 2. Install into Claude Code

Register the server with `claude mcp add`, pointing it at `packages/mcp/src/bin.ts`. **Pick one** of
the two variants below — they're alternatives sharing the name `cork-defi`, not additive (adding a
name that already exists errors; `claude mcp remove cork-defi` first if you want to switch). Run
from the repo root so `$(pwd)` resolves:

```sh
# A) recommended — works out of the box, including live chain reads on public chains
claude mcp add cork-defi -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"

# B) optional — pin your own RPC endpoint (a private/faster node, or a chain with no built-in default
#    such as the staging vnet). This OVERRIDES the built-in defaults:
claude mcp add cork-defi -e CORK_RPC_URL=https://your-rpc-endpoint -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"
```

Chain-backed tools work **without any RPC setup**: the server ships with built-in default endpoints for
Ethereum mainnet and Arbitrum, and just-in-time fetches a fast public RPC from chainlist.org (with a
circuit breaker + retry/backoff) if a default is unreachable — see "How RPC endpoints are resolved"
below. Variant B is only for overriding that.

**Why the absolute `bun` path.** Claude Code launches the server as a subprocess that may not inherit
your shell's `PATH` (notably the desktop app), so a bare `bun` can fail with "command not found."
`"$(mise which bun)"` resolves to the real binary at `add` time (use `"$(which bun)"` if you
installed Bun without mise). If the server won't connect, this is the first thing to check —
`claude mcp get cork-defi` shows the exact command it will run.

By default this registers the server **locally** (just you, just this project; stored in your user
config outside the repo). `-s user` makes it available in every project. **Avoid `-s project` with the
`-e CORK_RPC_URL=…` variant:** project scope writes a *committed* `.mcp.json`, and this repo's rule is
that the RPC endpoint value never enters git. Share via `-s project` using variant A only, and let
each teammate configure their own endpoint locally. To uninstall: `claude mcp remove cork-defi`.

### 3. Check it's working

```sh
claude mcp list                 # cork-defi should show "✔ Connected"
claude mcp get cork-defi     # shows the command, args, and any env you set
```

Then, inside a Claude Code session, ask it to introspect the server:

> **You:** Using the cork-defi MCP, call cork_capabilities and tell me how many tools there are and their names.

A healthy install answers **9 tools**: `cork_query`, `cork_compute`, `cork_decode`,
`cork_capabilities`, `cork_prepare_phoenix`, `cork_prepare_orders`, `cork_prepare_market`,
`cork_track`, `cork_submit`. If Claude says it can't see the tools, the server didn't connect —
re-check step 1 (Bun installed, `bun install` run) and that the path in step 2 is absolute.

### 4. Things to ask Claude

These work with **no RPC** (config-only or pure math):

> - "Ask cork-defi what tools relate to *bundles*." *(searches the manual)*
> - "Use cork-defi to compute the rollover premium floor for 1000e18 dstCST produced at a min premium of 0.02e18 per share." *(pure, exact math)*
> - "Get the Cork protocol config — I want the deployed CorkAdapter and Bundler3 addresses."
> - "Build an unsigned Cork swap bundle: 100 sUSDe out of pool `0xd16e…cf05`, receiver `0xc0ffee…0001`, max 101e18 cST in and 130e18 reference in." *(returns bytes only — nothing is signed)*
> - "Decode this Bundler3 calldata for me: `0x374f435d…`"

These read **live chain state** — they work out of the box (built-in mainnet/Arbitrum RPCs +
chainlist fallback); pass your own RPC (variant B, or `--rpc-url` on the CLI) only to override.
`0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05` is a real mainnet pool
(sUSDe-vbUSDC); list current pools at `api-phoenix.cork.tech/v1/pools/`:

> - "Read the live state of Cork market `0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05`."
> - "What's the current cST swap rate for 1e18 collateral out of that pool?"
> - "Is address `0xc0ffee…0001` whitelisted on that pool?"

Arbitrum (chainId 42161) is a **full** deployment like mainnet (announced 2026-07-22, bindings
verified on-chain): reads, bundle building, orders, and the MarketRegistry resources
(registry-assets / registry-oracle / registry-recipes, plus `cork_prepare_market` oracle deploys)
all work there.

The venue-backed surfaces (orderbook, fills, rollover order feed via `flows`, the RFQ discovery
feed via `rfqs`, and submission of orders / RFQ opens / RFQ answers) are served from
`api-phoenix.cork.tech` and labeled `provenance.mode: "centralized"`; rollover orders are buildable
offline (`prepare orders`, CorkSettler EIP-712) and reconciles are chain-verified against the
settler's `orderStatus()` when an RPC resolves. A few variants are still honestly gated (state
`unavailable` with a reason code) rather than fabricated — the whitelisted-addresses enumeration,
taker-fill, dutch-auction-price / rfq-quote pricing, and `cork_decode` order/event/receipt. Reading
a pool that doesn't exist on the queried chain returns `unavailable` with `chain_read_failed` (not
a crash). That's expected; it's not a broken install.

### CLI: `ch` (no MCP client needed)

The same tools run straight from a shell — handy for scripts and quick checks. The command is `ch`,
a small launcher at `bin/ch` that runs the CLI under the repo-pinned Bun and works from any directory.

From a fresh checkout:

```sh
# 1. one-time setup (same as Prerequisites above)
mise trust && mise install && bun install

# 2. put the launcher on your PATH (this shell; or add to your shell profile)
export PATH="$(pwd)/bin:$PATH"
# or symlink it into a dir already on PATH:  ln -s "$(pwd)/bin/ch" ~/.local/bin/ch

# 3. test it — a healthy install prints an "ok" envelope listing the 9 tools
ch capabilities

ch query --json '{"resource":"protocol-config"}'
ch compute --json '{"params":{"kind":"rollover-premium-floor","dstCstProduced":"1000000000000000000000","minPremiumPerShare":"20000000000000000"}}'
ch compute --explain     # print a tool's contract (JSON schema) without running it
```

`ch capabilities` returning `"state": "ok"` with 9 tools means the CLI is wired correctly. Prefer not
to touch `PATH`? The launcher runs the same either way — `./bin/ch capabilities` — and the long form
works without the launcher at all: `bun packages/cli/src/bin.ts capabilities`.

Every tool accepts an optional `"format"` in its JSON input — `"concise"` (the default, shown above)
or `"full"` for the verbose envelope. Exit codes map the envelope state so scripts can branch: `0` ok
· `2` invalid input · `3` unavailable · `4` conflict · `1` unexpected error. Chain-backed commands
resolve an RPC automatically (see below); pass `--rpc-url <url>` (or set `CORK_RPC_URL`) to override.

## How RPC endpoints are resolved

Chain-backed reads pick an endpoint in this order, so the tools "just work" on public chains while
staying overridable:

1. **Explicit** — `CORK_RPC_URL` (env) or `--rpc-url` (CLI). Used verbatim, no probing, no fallback.
2. **Built-in default** — a committed endpoint for the chain (Ethereum mainnet, Arbitrum). Tried with
   retries + exponential backoff; a per-endpoint **circuit breaker** stops hammering one that's down.
3. **chainlist.org fallback** — for public chains (mainnet, Arbitrum, Base, Sepolia), the tool fetches
   candidate public RPCs just-in-time, latency-probes them in parallel, **verifies each reports the
   right chainId**, and uses the fastest healthy one. The private staging vnet (49222) is not on
   chainlist, so it needs an explicit RPC.

The chosen endpoint and breaker state are cached in-process and on disk (`~/.cache/cork-helper-cli/`,
override with `CORK_RPC_CACHE_FILE`) so repeated calls skip re-probing. When a read falls back to a
community RPC, the result envelope carries an `rpc_fallback` warning naming the host.

> Note: the two built-in default endpoints embed access tokens and are committed intentionally
> (owner decision). This is a deliberate exception to the "never commit an RPC URL" rule, which still
> applies to `CORK_RPC_URL` / `CORK_TEST_RPC` — those stay environment-only.

## Design invariants (RFC 011)

- **One typed core.** MCP and CLI are thin projections of the same `runTool` dispatch and the
  same registry — no logic forks between surfaces.
- **Prepare ≠ sign ≠ submit** [K1]. Preparation returns unsigned bytes; nothing is signed or
  broadcast by these tools. The one side-effecting tool (`cork_submit`) only relays a
  caller-signed payload.
- **Reconstruct, never trust a supplied parse** [K3]. `cork_decode` re-derives Cork calldata
  (recursively unwrapping Bundler3 multicall/reenter) from bytes; unknown legs are surfaced
  raw, never silently dropped.
- **Honest phase-gating.** Unimplemented tool variants return an `unavailable` envelope with a
  reason code — never a fabricated result.
- **Bit-exact math.** Every Solidity operation is ported with matching floor/ceil rounding and
  verified against independently-computed golden vectors **and** live on-chain reads.

## Verification (empirical, not asserted)

- **Golden vectors** are derived independently of the TS implementation: Foundry unit-test
  literals (`computeT`, `calculateTimeDecayFee`), Python integer arithmetic (`_calculateRate`
  refill, impairment floor), and `cast`/`foundry` (`MarketId` keccak, CREATE2, CorkAdapter
  action + Bundler3 multicall byte-parity).
- **Fork parity** (`packages/core/test/fork-parity.test.ts`) reproduces on-chain `swapRate`,
  `previewSwap`, `previewUnwindSwap`, and `MarketId` **wei-for-wei** against the live vnet
  fixture pool, and checks the full `runTool` handler stack too. All reads are pinned to one
  block so the permissionlessly-mutable test oracle cannot race the comparison.
- The committed-descent impairment floor is proven **≤ a brute-force adversary simulation**
  across a horizon matrix (conservative-safe: the floor is never optimistic).

## Develop

```sh
bun install
bun run typecheck          # tsc --noEmit, strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes)
bun run test               # everything; network-gated suites self-skip without their env vars
bun run test:unit          # offline-only (excludes fork-parity / bundle-sim / rpc-live)
bun run test:live          # just the network-gated suites (each self-skips without its env var)

# Empirical fork-parity vs the live vnet fixture (never commit this RPC URL):
CORK_TEST_RPC="https://virtual.mainnet…/REDACTED-VNET" bun run test:live

# Live RPC-resolver smoke (default + chainlist fallback, real network):
CORK_RPC_LIVE=1 CORK_RPC_CACHE_FILE=/tmp/rpc-state.json bun run test:live

# Agent evals (LLM-graded tool-surface quality; self-skips without a key):
bun run eval               # see evals/README.md for grading, env knobs, held-out rule
```

`CORK_TEST_RPC` (vnet fixture) and `CORK_RPC_URL` (endpoint override) are read from the environment
and must never be committed. Without `CORK_TEST_RPC` the fork-parity/bundle-sim suites self-skip;
chain-backed tools still run at request time via the built-in default RPCs + chainlist fallback.

## Status

Implemented + tested:

- **cork_capabilities** — tool list, `search`, `topic` docs, and `topic: "verify"` (re-derives
  deployed addresses via CREATE2 from prod.toml salt + Sourcify init-code hash).
- **cork_decode** — Bundler3 calldata, recursively, incl. non-Cork legs (erc20/permit2/GeneralAdapter1).
- **cork_compute** — rollover-premium-floor (pure); cst-swap-rate / unwind-rate / impairment-floor
  (chain-backed, block-pinnable); resolve-recipe (MarketRegistry band resolution, bit-parity
  self-checked against the chain view).
- **cork_prepare_phoenix** — all 13 adapter actions on mainnet **and** Arbitrum; auto-built funding
  legs (erc20-approve / permit2 / pre-funded) for value-in actions and owner==adapter share-burn
  actions; expired-pool tripwire (`pool_expired`). deposit / swap / unwind-swap / exercise bundles
  are proven to **execute** against the live vnet.
- **cork_prepare_orders** — 1inch maker-order EIP-712 typed data (incl. extension orders and
  JIT-market orders with adapter pre-flight checks) + cancel calldata, order hash proven equal to
  on-chain `hashOrder`; rollover-intent ERC-7683 OrderData (CorkSettler domain, intent hash
  recomputed locally, settler-mode gate checked).
- **cork_prepare_market** — unsigned `MarketRegistry.deploy(ca, ref)` oracle-wrapper txs
  (permissionless, idempotent; Arbitrum). Q-REG closed 2026-07-22.
- **cork_query** — chain reads (market / account-state incl. balances + funding allowances for both
  spenders / pool-whitelist / protocol-config / registry-assets / registry-oracle /
  registry-recipes); venue-backed reads (markets, orderbook, fills, limit-order-markets, flows,
  rfqs — incl. single-RFQ lookup via `filters.rfqId`); an event-derived subset (markets, fills,
  flows) also serves `full-decentralized` mode over HyperSync.
- **cork_track** — verify (artifact digest, marketRef MarketId re-hash), simulate (eth_call dry-run
  on frozen bytes: `wouldRevert` + reason BEFORE signing), reconcile (txHash receipt, orderHash /
  submissionRef lifecycle vs the settler's on-chain `orderStatus()` — chain outranks indexer [K7]).
- **cork_submit** — the one side-effecting tool: relays caller-signed/authored payloads to the venue
  (`rollover-order`, `lop-order`, `rfq-open`, `rfq-answer`), recomputing commitments before relay [K3].

Honestly gated (`unavailable` with a reason, never faked): `cork_query` whitelisted-addresses
enumeration, `cork_prepare_orders` taker-fill, `cork_compute` dutch-auction-price (needs a live
Fusion order) / rfq-quote (pricing-signal shape pending), and `cork_decode` order/event/receipt.
Some schema fields are accepted but reserved for later phases (`cork_query` `cursor`/`pageSize`,
`cork_compute` `at.timestamp`, `cork_prepare_phoenix` `account`).

Known gaps, sequenced deliberately (tracked, not forgotten): per-enum-value / per-union-branch
descriptions inside the registered JSON schemas (RFC §5.4's table); remaining prepare pre-flight
guards (whitelist / pause checks — expiry and JIT adapter-binding checks shipped), sweep legs, and
a human summary on bundles (RFC §5.4); `account-state` nonce/invalidator and Safe config;
venue-side pagination passthrough (`cursor`/`pageSize`) once the venue's cursor fix deploys; and
distribution/packaging beyond the in-repo launchers.
