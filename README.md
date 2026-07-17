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
| `@cork/mcp` | MCP server projecting the registry via the low-level `Server` API (advertises JSON Schema directly; avoids the SDK's bundled-zod coupling). Binary: `cork-mcp` (stdio). |
| `@cork/cli` | commander projection of the same registry — one command per tool at its `cliPath`, with `--json`, `--explain`, and state-mapped exit codes. Binary: `cork`. |

## Use it with Claude Code (MCP)

The MCP server exposes all 9 Cork tools to Claude Code (or any MCP client) over stdio. Claude
can then read protocol state, run the bit-exact math, and build unsigned bundles/orders for you —
without ever signing or broadcasting anything.

### 1. Prerequisites

The server and CLI are TypeScript run directly by **[Bun](https://bun.sh)** (Node's native
type-stripping can't run this code — it uses TypeScript parameter properties). Bun 1.3 is pinned in
`mise.toml`, so from the repo root:

```sh
mise install      # installs the pinned Bun (or: curl -fsSL https://bun.sh/install | bash)
bun install       # link the workspace packages
```

### 2. Install into Claude Code

Register the server with `claude mcp add`, pointing it at `packages/mcp/src/bin.ts`. **Pick one** of
the two variants below — they're alternatives sharing the name `cork-phoenix`, not additive (adding a
name that already exists errors; `claude mcp remove cork-phoenix` first if you want to switch). Run
from the repo root so `$(pwd)` resolves:

```sh
# A) state reads + math that don't touch a chain (capabilities, decode, config, pure compute)
claude mcp add cork-phoenix -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"

# B) also enable chain-backed reads (live markets, swap rates, whitelist) by passing an RPC endpoint:
claude mcp add cork-phoenix -e CORK_RPC_URL=https://your-rpc-endpoint -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"
```

**Why the absolute `bun` path.** Claude Code launches the server as a subprocess that may not inherit
your shell's `PATH` (notably the desktop app), so a bare `bun` can fail with "command not found."
`"$(mise which bun)"` resolves to the real binary at `add` time (use `"$(which bun)"` if you
installed Bun without mise). If the server won't connect, this is the first thing to check —
`claude mcp get cork-phoenix` shows the exact command it will run.

By default this registers the server **locally** (just you, just this project; stored in your user
config outside the repo). `-s user` makes it available in every project. **Avoid `-s project` with the
`-e CORK_RPC_URL=…` variant:** project scope writes a *committed* `.mcp.json`, and this repo's rule is
that the RPC endpoint value never enters git. Share via `-s project` using variant A only, and let
each teammate configure their own endpoint locally. To uninstall: `claude mcp remove cork-phoenix`.

### 3. Check it's working

```sh
claude mcp list                 # cork-phoenix should show "✔ Connected"
claude mcp get cork-phoenix     # shows the command, args, and any env you set
```

Then, inside a Claude Code session, ask it to introspect the server:

> **You:** Using the cork-phoenix MCP, call cork_capabilities and tell me how many tools there are and their names.

A healthy install answers **9 tools**: `cork_query`, `cork_compute`, `cork_decode`,
`cork_capabilities`, `cork_prepare_phoenix`, `cork_prepare_orders`, `cork_prepare_market`,
`cork_track`, `cork_submit`. If Claude says it can't see the tools, the server didn't connect —
re-check step 1 (Bun installed, `bun install` run) and that the path in step 2 is absolute.

### 4. Things to ask Claude

These work with **no RPC** (config-only or pure math):

> - "Ask cork-phoenix what tools relate to *bundles*." *(searches the manual)*
> - "Use cork-phoenix to compute the rollover premium floor for 1000e18 dstCST produced at a min premium of 0.02e18 per share." *(pure, exact math)*
> - "Get the Cork protocol config — I want the deployed CorkAdapter and Bundler3 addresses."
> - "Build an unsigned Cork swap bundle: 100 sUSDe out of pool `0xceeb…c16a`, receiver `0xc0ffee…0001`, max 101e18 cST in and 130e18 reference in." *(returns bytes only — nothing is signed)*
> - "Decode this Bundler3 calldata for me: `0x374f435d…`"

These need an **RPC** (installed via the `-e CORK_RPC_URL=…` variant above):

> - "Read the live state of Cork market `0xceeb…c16a`."
> - "What's the current cST swap rate for 100e18 collateral out of that pool?"
> - "Is address `0xc0ffee…0001` whitelisted on that pool?"

Some variants are honestly **not implemented yet** and will tell you so (state `unavailable` with a
reason) rather than inventing an answer — e.g. the orderbook/fills feeds (need the indexer),
order submission, and market deployment. That's expected; it's not a broken install.

### CLI (no MCP client needed)

The same tools run straight from a shell — handy for scripts and quick checks:

```sh
bun packages/cli/src/bin.ts capabilities
bun packages/cli/src/bin.ts query --json '{"resource":"protocol-config"}'
bun packages/cli/src/bin.ts compute --json '{"params":{"kind":"rollover-premium-floor","dstCstProduced":"1000000000000000000000","minPremiumPerShare":"20000000000000000"}}'
bun packages/cli/src/bin.ts compute --explain     # print a tool's contract (JSON schema) without running it
```

Every tool accepts an optional `"format"` in its JSON input — `"concise"` (the default, shown above)
or `"full"` for the verbose envelope. Exit codes map the envelope state so scripts can branch: `0` ok
· `2` invalid input · `3` unavailable · `4` conflict · `1` unexpected error. Chain-backed commands
take `--rpc-url <url>` (or read `CORK_RPC_URL` from the environment).

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
bun run test               # vitest; fork-parity self-skips unless CORK_TEST_RPC is set

# Empirical fork-parity vs the live vnet fixture (never commit the RPC URL):
CORK_TEST_RPC="https://virtual.mainnet…/REDACTED-VNET" bun run test
```

`CORK_TEST_RPC` / `CORK_RPC_URL` are read from the environment and must never be committed;
without them the chain-backed tests skip and chain-backed compute returns `unavailable`.

## Status

Implemented + tested:

- **cork_capabilities** — tool list, `search`, `topic` docs, and `topic: "verify"` (re-derives
  deployed addresses via CREATE2 from prod.toml salt + Sourcify init-code hash).
- **cork_decode** — Bundler3 calldata, recursively, incl. non-Cork legs (erc20/permit2/GeneralAdapter1).
- **cork_compute** — rollover-premium-floor (pure); cst-swap-rate / unwind-rate / impairment-floor
  (chain-backed, block-pinnable).
- **cork_prepare_phoenix** — all 13 adapter actions; auto-built funding legs
  (erc20-approve / permit2 / pre-funded) for value-in actions and owner==adapter share-burn actions.
  deposit / swap / unwind-swap / exercise bundles are proven to **execute** against the live vnet.
- **cork_prepare_orders** — 1inch order maker-order EIP-712 typed data + cancel calldata; the order
  hash is proven equal to on-chain `hashOrder`.
- **cork_query** — market / account-state / protocol-config / pool-whitelist via chain reads.
- **cork_track** — artifact digest reconcile + marketRef (MarketId re-hash) + txHash receipt.

Honestly gated (`unavailable` with a reason, never faked): indexer/service resources of `cork_query`
(orderbook/fills/flows), `cork_track` orderHash/submissionRef, `cork_prepare_orders` taker-fill /
rollover-intent, `cork_compute` dutch-auction-price / rfq-quote, `cork_prepare_market` (Q-REG), and
`cork_submit` — each pending its Phase 2–4 backend.
