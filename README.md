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
