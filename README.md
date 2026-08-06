# cork-cli

TypeScript monorepo implementing the Cork Phoenix **MCP server + CLI over one typed core**
(RFC 011). All 9 tools are live across phases 1–4 — state reads, bit-exact math, byte decode,
and unsigned preparation of Bundler3 bundles / 1inch orders / market-oracle txs, plus
verify-simulate-reconcile and caller-signed venue submission. Activated on Ethereum mainnet
**and** Arbitrum One, grounded empirically (bit-exact, wei-for-wei) against live on-chain reads
and the Tenderly virtual-mainnet fixture pool.

## Packages

| Package | What it is |
|---|---|
| `@cork/schemas` | zod v4 single source of truth: hex-typed primitives, the 9-tool registry, `z.toJSONSchema` projection to MCP input schemas. |
| `@cork/core` | Deterministic bit-exact ports of on-chain math (`MathHelper`, `TransferHelper`, `ConstraintRateAdapter._calculateRate`, `PoolLib.preview*`), the committed-descent impairment floor, `MarketId`/CREATE2 derivation, chain reads (viem), the Bundler3 encoder/recursive decoder, and the shared tool dispatch (`runTool`). |
| `@cork/mcp` | MCP server projecting the registry via the low-level `Server` API (advertises JSON Schema directly; avoids the SDK's bundled-zod coupling). Stdio entry `packages/mcp/src/bin.ts` (package bin `cork-mcp`), launched by your MCP client under Bun — see "Use it with Claude Code" below. |
| `@cork/cli` | commander projection of the same registry — one command per tool at its `cliPath`. Input as the wire JSON or as schema-derived flags; output as prose for people and JSON on request; `--explain` for a tool's contract; state-mapped exit codes. Binary: `ch` (launcher at `bin/ch`). |

## Use it with Claude Code (MCP)

The MCP server exposes all 9 Cork tools to Claude Code (or any MCP client) over stdio. Claude
can then read protocol state, run the bit-exact math, and build unsigned bundles/orders for you —
without ever signing or broadcasting anything.

### 1. Prerequisites

Clone the repo (hosted at `github.com/Cork-Technology/cork-cli`), then set up the runtime:

```sh
git clone git@github.com:Cork-Technology/cork-cli.git
cd cork-cli
```

The server and CLI are TypeScript run directly by **[Bun](https://bun.sh)** (Node's native
type-stripping can't run this code — it uses TypeScript parameter properties). Bun 1.3 is pinned in
`mise.toml`.

**Install [mise](https://mise.jdx.dev)** — the tool-version manager that provisions the pinned Bun —
if you don't already have it:

```sh
curl https://mise.run | sh          # installs mise into ~/.local/bin

# activate it in your shell (pick the line for your shell), then reopen the terminal:
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc   # bash
echo 'eval "$(~/.local/bin/mise activate zsh)"'  >> ~/.zshrc    # zsh

# macOS Homebrew alternative:
brew install mise
```

Other installers (apt, dnf, pacman, scoop, winget, …) are listed at
<https://mise.jdx.dev/getting-started.html>. Verify with `mise --version`.

Then, from the repo root:

```sh
mise trust        # trust this repo's mise.toml — one-time, REQUIRED on a fresh checkout
mise install      # installs the pinned Bun
bun install       # install deps + link the workspace packages
```

Prefer not to use mise? Install Bun 1.3+ directly (`curl -fsSL https://bun.sh/install | bash`), skip
the two `mise` commands, and just run `bun install`.

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

### Remote / HTTP transport (`ch mcp --http`)

The same server also speaks **Streamable HTTP** — the shape a hosted deployment serves:

```sh
ch mcp --http                # serves on :8080 — endpoint /mcp, health /healthz, docs /docs/signing
ch mcp --http --port 9090    # custom port

# connect a client to a running HTTP deployment:
claude mcp add --transport http cork-defi http://localhost:8080/mcp
# with bearer auth (deployments that set CORK_MCP_TOKEN):
claude mcp add --transport http cork-defi https://your-deployment/mcp --header "Authorization: Bearer <token>"
```

**Server env contract** (all read server-side at process start; clients cannot override any of
these per-call — that is deliberate: server reads run on the server's own RPC configuration, and
signing/broadcasting are always client-side, see `cork_capabilities topic:"signing"`):

| Env | Effect |
|---|---|
| `CORK_MCP_TOKEN` | When set, the `/mcp` endpoint requires `Authorization: Bearer <token>`; unset = open (put auth/rate-limits at your ingress). Never logged. |
| `CORK_RPC_URL` | Explicit RPC endpoint override for chain reads (else built-in defaults + chainlist fallback). |
| `ENVIO_API_TOKEN` / `ENVIO_HYPERSYNC_TOKEN` / `ENVIO_HYPERRPC_TOKEN` | HyperSync/HyperRPC access for the event-derived reads (`full-decentralized` mode, whitelisted-addresses, order-history legs). |
| `CORK_VENUE_URL` | Override the venue API base (default api-phoenix.cork.tech/v1). |
| `CORK_DEFAULTS_URL` / `CORK_CONFIG_CACHE_FILE` / `CORK_RPC_CACHE_FILE` | Address-config fetch/cache knobs (see "Address config" in CLAUDE.md). |

`GET /docs/signing` serves the sign-and-broadcast guide as markdown — the same constant that backs
`cork_capabilities topic:"signing"` and the server's `initialize` instructions, so the three
surfaces cannot drift.

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

Arbitrum (chainId 42161) is a **full** deployment like mainnet (bindings verified on-chain): reads,
bundle building, orders, and the MarketRegistry 2.1.0 resources
(registry-assets / registry-oracle / registry-recipes / registry-denominations / registry-feeds /
market-predict, plus `cork_prepare_market` oracle deploys) all work there. `market-predict` derives
the market a JIT LOP fill would create — the recipe's oracle, the off-chain-resolved constraint,
pool id, and cST/cPT tokens — before anything is deployed or signed; the identity is pinned the
moment an order carrying that constraint is signed.

The venue-backed surfaces (orderbook, fills, rollover order feed via `flows`, the RFQ discovery
feed via `rfqs`, and submission of orders / RFQ opens / RFQ answers) are served from
`api-phoenix.cork.tech` and labeled `provenance.mode: "centralized"`; rollover orders are buildable
offline (`prepare orders`, CorkSettler EIP-712) and reconciles are chain-verified against the
settler's `orderStatus()` when an RPC resolves. Exactly one variant is deliberately gated (state
`unavailable` with a reason code) rather than fabricated — `cork_compute` rfq-quote, a pricing
model deferred by product decision. Everything else is activated, including whitelisted-addresses
enumeration, dutch-auction-price, `cork_decode` order/event/receipt, and `cork_prepare_orders`
taker-fill / finalize-maker-order. Reading a pool that doesn't exist on the queried chain returns
`unavailable` with `chain_read_failed` (not a crash). That's expected; it's not a broken install.

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

# 3. test it — a healthy install lists the 9 tools
ch capabilities

# reads: a positional for the resource, flags named after the schema's own fields
ch query protocol-config
ch query registry-assets --chain-id 42161

# actions are subcommands, their fields are flags, amounts take exact sugar (1000e18, 1_000):
ch compute rollover-premium-floor --dst-cst-produced 1000e18 --min-premium-per-share 12e15
ch prepare pool exercise --chain-id 42161 --pool-id 0x… --cst-shares-in 1000e18 \
  --receiver 0x… --min-collateral-assets-out 95e16 --max-reference-assets-in 1_000000

# the pool actions + fill are also top-level verbs — the same command, flatter:
ch exercise --chain-id 42161 --pool-id 0x… --cst-shares-in 1000e18 --receiver 0x… \
  --min-collateral-assets-out 95e16 --max-reference-assets-in 1_000000
ch fill --chain-id 42161 --order-hash 0x… --account 0x…

# on ch query, known filter keys are first-class flags (and `rfq` reads the rfqs feed):
ch query orderbook --chain-id 42161 --pool-id 0x…
ch query rfq --chain-id 42161 --rfq-id rfq_…

# the same fields can ride in one JSON blob (flags override blob keys); bare --json = JSON output
ch query protocol-config --input '{"chainId":42161}' --json

ch compute --explain                # every parameter, unions unfolded
ch compute cst-swap-rate --explain  # scoped to one variant
ch compute --explain --json         # the same contract as JSON Schema
```

`ch capabilities` listing 9 tools means the CLI is wired correctly. Prefer not to touch `PATH`? The
launcher runs the same either way — `./bin/ch capabilities` — and the long form works without the
launcher at all: `bun packages/cli/src/bin.ts capabilities`.

**Output is prose by default and JSON on request.** A person at a terminal gets a readable summary;
ask for the wire format with a bare `--json`, or set `CORK_JSON=1` to make JSON the default for every
command in a shell. Supplying input *as* `--json '<object>'` also returns JSON — handing the tool the
wire shape is itself a machine-readable intent — so scripts that pass the wire shape keep working
unchanged.

**Input has three interchangeable forms.** `--json '<object>'` is canonical and identical to what the
MCP server receives; `--input '<object>'` is the same thing under a name that cannot be confused with
the output flag; or pass subcommands/positionals plus flags named after the tool's own schema fields,
which is usually what you want by hand — every discriminated action/kind is its own subcommand
(`ch prepare pool exercise …`, `ch submit rfq-open …`, `ch track verify market-ref …` — `pool` and
`order` are canonical; the internal `phoenix`/`orders` spellings remain as aliases) with a
variant-scoped `--help`/`--explain`:

```sh
ch query market --chain-id 1 --pool-id 0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05
```

Flags win over keys in a JSON blob, so a saved blob can be reused with one value overridden. Flag
spelling is forgiving — `--chainid`, `--chain-id` and `--chainId` are the same flag (help displays
the kebab form). Object-valued fields (`--filters`, `--for-self`) take a JSON string; union-typed
fields accept a raw string too (`ch decode tx --data 0x…` — no quoting gymnastics). Amount fields
accept exact human sugar: `1000e18` and `1_000000` expand by integer arithmetic (a fractional
remainder like `1.23e1` is refused with teaching, and sugar applies to flags only — JSON blobs stay
the exact wire form). `--chain-id` also takes network names (`arbitrum`, `mainnet`, `base`,
`sepolia`), and a mistyped action name gets a did-you-mean refusal.

Every tool accepts an optional `"format"` — `"concise"` (the default) or `"full"` for the verbose
envelope. Exit codes map the envelope state so scripts can branch: `0` ok · `2` invalid input · `3`
unavailable · `4` conflict · `1` unexpected error. Chain-backed commands resolve an RPC automatically
(see below); pass `--rpc-url <url>` (or set `CORK_RPC_URL`) to override.

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
bun run test:unit          # offline-only (excludes fork-parity / bundle-sim / rpc-live / hyperrpc-live)
bun run test:live          # just the network-gated suites (each self-skips without its env var)

# Empirical fork-parity vs the live vnet fixture (never commit this RPC URL):
CORK_TEST_RPC="https://virtual.mainnet…/REDACTED-VNET" bun run test:live

# Live RPC-resolver smoke (default + chainlist fallback, real network):
CORK_RPC_LIVE=1 CORK_RPC_CACHE_FILE=/tmp/rpc-state.json bun run test:live

# Agent evals (programmatically graded tool-surface quality; needs an API key OR ambient
# gateway auth, e.g. ANTHROPIC_BASE_URL — fails loud rather than skipping):
bun run eval               # see evals/README.md for grading, env knobs, held-out rule
```

`CORK_TEST_RPC` (vnet fixture) and `CORK_RPC_URL` (endpoint override) are read from the environment
and must never be committed. Without `CORK_TEST_RPC` the fork-parity/bundle-sim suites self-skip;
chain-backed tools still run at request time via the built-in default RPCs + chainlist fallback.

## Status

Implemented + tested:

- **cork_capabilities** — tool list, `search`, `topic` docs, and `topic: "verify"` (re-derives
  deployed addresses via CREATE2 from prod.toml salt + Sourcify init-code hash).
- **cork_decode** — Bundler3 calldata, recursively, incl. non-Cork legs (erc20/permit2/GeneralAdapter1),
  plus a plain-English `summary` of what those legs do; also LOP orders, single logs, and whole receipts.
- **cork_compute** — rollover-premium-floor (pure); cst-swap-rate / unwind-rate / impairment-floor
  (chain-backed, block-pinnable); resolve-recipe (2.1.0: the `recipe.resolve` staticcall — the step
  that produces the constraint a JIT order carries and signs).
- **cork_prepare_phoenix** — all 13 adapter actions on mainnet **and** Arbitrum; auto-built funding
  legs (erc20-approve / permit2 / pre-funded) for value-in actions and owner==adapter share-burn
  actions; **sweep-back legs** that return the unspent remainder of any funded slippage cap to
  `account`, so it is not left on the adapter where anyone can take it; **pre-flight guards** for
  expiry, pause (the global breaker and the per-pool bit for this action), and whitelist (which
  checks *two* addresses — see below); a plain-English `summary` of what the bundle will do; and the
  authority-onboard / authority-revoke ops. deposit / swap / unwind-swap / exercise bundles are
  proven to **execute** against the live vnet.

  Note the whitelist asymmetry: a gated pool checks the bundle's `initiator()` (you, via the
  adapter's own modifier) **and** `msg.sender` (the *adapter*, via the pool manager). Both must be
  whitelisted, so checking only your own address can read as a false green.
- **cork_prepare_orders** — 1inch maker-order EIP-712 typed data (incl. extension orders and
  JIT-market orders with adapter pre-flight checks) + cancel calldata, order hash proven equal to
  on-chain `hashOrder`; rollover-intent ERC-7683 OrderData (CorkSettler domain, intent hash
  recomputed locally, settler-mode gate checked). Orders live in the 1inch **bit** invalidator,
  which keys on `(maker, nonce)` rather than order hash, so the nonce is derived per
  `clientRequestId`: give each order you want live at the same time its own id, or they share a bit
  and filling one invalidates the others.
- **cork_prepare_market** — unsigned `MarketRegistry.deploy(ca, ref, mode)` oracle-wrapper txs and
  `deployFixedRateOracle(rate)` fixed-rate oracle txs (permissionless, idempotent; Arbitrum).
- **cork_query** — chain reads (market / account-state incl. balances + funding allowances for both
  spenders / pool-whitelist / protocol-config / registry-assets / registry-oracle /
  registry-recipes / registry-denominations / registry-feeds / market-predict — predict a market's
  oracle, pool id, constraint, and cST/cPT before it exists); venue-backed reads (markets,
  orderbook, fills, limit-order-markets, flows, rfqs — incl. single-RFQ lookup via
  `filters.rfqId`); an event-derived subset (markets, fills, flows) also serves
  `full-decentralized` mode over HyperSync.
- **cork_track** — verify (artifact digest, marketRef MarketId re-hash), simulate (eth_call dry-run
  on frozen bytes: `wouldRevert` + reason BEFORE signing), reconcile (txHash receipt, orderHash /
  submissionRef lifecycle vs the settler's on-chain `orderStatus()` — chain outranks indexer [K7]).
- **cork_submit** — the one side-effecting tool: relays caller-signed/authored payloads to the venue
  (`rollover-order`, `lop-order`, `rfq-open`, `rfq-answer`), recomputing commitments before relay [K3].

Deliberately gated (`unavailable` with a reason, never faked): only `cork_compute` rfq-quote — a
pricing model deferred by product decision (a Fusion-style decaying-premium order is the
modeled-quote-free alternative). Everything else advertised above is activated, including
`cork_query` whitelisted-addresses enumeration, `cork_compute` dutch-auction-price (pure-local
Fusion v3.1 pricing), `cork_decode` order/event/receipt, `cork_prepare_orders` taker-fill +
finalize-maker-order, and the `cork_prepare_phoenix` authority-onboard / authority-revoke ops. No
schema field is accepted-but-reserved any more — `cork_prepare_phoenix` `account` became the
sweep-back recipient (`cork_compute` `at.timestamp` is honored by dutch-auction-price, reserved only
for the block-anchored kinds).

Roadmap: `account-state` nonce/invalidator state, and Safe support — the latter phased by design
(message-signature and transaction-confirmation are distinct problems, and these tools never confirm
a Safe transaction).
