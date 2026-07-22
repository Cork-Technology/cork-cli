# cork-agents-kernel → cork-helper-cli: the six-verb mapping

**Audience:** the `CorkMcpInterfacePort` adapter swap in cork-agents-kernel.
**Problem:** the kernel's adapter targets the archived `cork-mcp` repo's 24-tool catalog
(`cork.phoenix.limitOrders.maker.prepare.v1` style). Those tool names do not exist on the live
server. The live server is **cork-helper-cli**: 9 tools, one result envelope, same custody split —
the server constructs and verifies, the caller signs and broadcasts [K1].
**Status of every mapping below:** verified against the live server on 2026-07-22 (tests +
live Arbitrum/venue reads), not inferred from docs.

## Connect

```bash
git clone https://github.com/Cork-Technology/cork-helper-cli && cd cork-helper-cli
mise trust && mise install && bun install
# stdio MCP server entrypoint (what CORK_MCP_COMMAND/ARGS should launch):
bun packages/mcp/src/bin.ts
```

Live chain reads work with no RPC config (built-in defaults + fallback for mainnet/Arbitrum);
set `CORK_RPC_URL` to pin your own node. Venue base override: `CORK_VENUE_URL`
(default `https://api-phoenix.cork.tech/v1`).

## The result envelope (every tool, uniform)

```
{ state: "ok" | "unavailable" | "conflict", data, warnings[], provenance, schemaVersion }
```

- `ok` → use `data`. `unavailable` → honestly not servable; `warnings[0].code` says why — do not
  retry the same call. `conflict` → the tool executed and found a mismatch (e.g. venue disagrees
  with chain); chain outranks indexer [K7].
- This replaces the old per-tool result shapes. Your registry-degraded gate maps cleanly:
  `unavailable`/`conflict` ⇒ "submit nothing this tick", same as your RFC-7807 `problem` handling.

## The six verbs

| Verb | Old (archived cork-mcp) | Live (cork-helper-cli) |
| --- | --- | --- |
| `create` | `cork.market.deploy.quote.v1` → `cork.market.deploy.prepare.v1` | `cork_query resource:"registry-oracle"` (deployed/deployable pre-check) → `cork_prepare_market` `deploy-wrapper` (oracle, permissionless + idempotent) → the **market itself is created by the fill**: `cork_prepare_orders` `maker-order` + `jitMarket` |
| `quote` | `…limitOrders.markets.list.v1` + `…orderbook.list.v1` | `cork_query resource:"limit-order-markets"` + `resource:"orderbook"` (still untrusted observations; venue-backed) |
| `order` | `maker.prepare.v1` → sign (MAIN) → `maker.finalize.v1` → `submit.v1` | `cork_prepare_orders` `maker-order` → sign (MAIN) → `cork_submit` `lop-order` — **no finalize step; see below** |
| `settle` | `…limitOrders.reconcile.v1` | `cork_track mode:"reconcile"` `subject:{kind:"orderHash"}` — venue lifecycle PLUS on-chain LOP invalidator read; disagreement is a `conflict`, chain wins |
| `roll` | `cancel.prepare.v1` + `maker.prepare.v1` → sign → finalize → submit | `cork_prepare_orders` `cancel` (predecessor calldata) + `maker-order` (successor) → sign → `cork_submit` `lop-order`. Cross-pool rollovers: `cork_prepare_orders` `rollover-intent` (ERC-7683 typed-data) → sign → `cork_submit` `rollover-order` |
| `exercise` | read `…paired-shares-in.reconcile.v1`; fire `prepare.v1` → sign (EXERCISE) → `finalize.v1` → broadcast | fire: `cork_prepare_phoenix` unwind action (e.g. `unwind-deposit`, `unwind-swap`, post-expiry `withdraw`/`redeem`) → **`cork_track mode:"simulate"` pre-fire check** → sign tx (EXERCISE) → broadcast yourself; read: `cork_track mode:"reconcile"` `subject:{kind:"txHash"}` |

### `order` in detail (the one real flow change)

`cork_prepare_orders` `maker-order` returns everything finalize used to assemble:

```
data: { kind: "maker-order", lop, typedData: {domain, types, primaryType, message},
        orderHash, extension, clientRequestId }
```

- The kernel signs `typedData` with MAIN (EIP-712, 1inch LOP v4 domain).
- Your adapter assembles the submit payload itself:
  `cork_submit action:{type:"lop-order", order:<typedData.message>, signature, extension?, side, premium, expiry, nonce, allowsPartialFills, quoteRef?}`.
- `cork_submit` independently **recomputes the orderHash and every commitment before relaying**
  [K3] — a tampered artifact is a `conflict`, never relayed. This is a server-side twin of your
  sign gate's `decode ≡ intent` law: you check before signing, we check again before relaying.
- For your sign gate's decode half: `cork_decode kind:"calldata"` reconstructs what any prepared
  bytes do from the bytes alone (recursively unwraps Bundler3 multicalls). Free second opinion;
  it never trusts a caller-supplied parse.

### `exercise` in detail

- `cork_prepare_phoenix` returns an **unsigned Bundler3 bundle** (`to`, `multicall` calldata) —
  a plain transaction for your EXERCISE key + broadcaster, not typed-data. No finalize.
- **`cork_track mode:"simulate"`** eth_call-dry-runs the frozen bytes before you sign:
  `subject:{kind:"artifact", artifact:{bundler3, multicall, account}}` → `wouldRevert` + revert
  reason + gas estimate. This is the pre-fire check your sentinel wants: a `FIRING` attempt that
  would revert is knowable *before* the key moves.
- **`deadlineAt` (absolute unix seconds)** on any prepare makes same-`clientRequestId` retries
  **byte-identical** — your verify-before-retry-on-restart law holds across process restarts.
  (Default is a relative deadline that re-anchors to the clock on retry.)

## The kernel-extension RFQ/registry tools

Your `KERNEL_EXTENSION_TOOLS` names now all have live homes — the whole
`FLOW=rfq` loop can run over one MCP transport (`DATA_SOURCE=mcp` semantics), keeping the
exercise sentinel armed instead of the `http` backend that disarms it:

| Kernel-extension tool | Live call |
| --- | --- |
| `cork.phoenix.rfqs.list.v1` | `cork_query resource:"rfqs"` — server default `state:"open"`, newest first; `filters:{state, account (requester), referenceAsset, withAnswers}` |
| `cork.phoenix.rfqs.get.v1` | `cork_query resource:"rfqs" filters:{rfqId:"rfq_…"}` — full record, all answers, `answer_count`, `truncated` |
| `cork.phoenix.rfqs.create.v1` | `cork_submit action:{type:"rfq-open", …}` (your `clientRequestId` becomes the venue `request_id` — idempotent [K2]) |
| `cork.phoenix.rfqs.answer.v1` | `cork_submit action:{type:"rfq-answer", …}` (priced options or a typed pass; premium scale tripwires guard the 0.041-vs-4.1% class of bug) |
| `cork.registry.assets.list.v1` | `cork_query resource:"registry-assets" chainId:42161` |
| `cork.registry.assets.get.v1` | `cork_query resource:"registry-assets" filters:{address:"0x…"}` (natural-key lookup) |
| `cork.registry.oracles.get.v1` | `cork_query resource:"registry-oracle" filters:{collateralAsset, referenceAsset}` — order matters, collateral first; answers deployed / deployable / why-not |
| `cork.registry.recipes.list.v1` | `cork_query resource:"registry-recipes"` (bands are percentages, 1e18 = 1%) |
| `cork.registry.recipes.get.v1` | `cork_query resource:"registry-recipes" filters:{mode:"…"}` (modes are exact case-sensitive strings; a miss lists the live ones) |
| `…recipes/{mode}/{rate}` (resolve) | `cork_compute params:{kind:"resolve-recipe", mode, rate}` — or omit `rate` and pass the pair to resolve at the **live oracle rate**; the local band math is parity-checked against the contract's `applyBands` on every call |
| `cork.registry.health.v1` | not needed: registry reads here are **direct chain views** (no sandbox API in the path), so there is no `degraded` registry state to gate on. Cheapest liveness probe if you want one: `cork_query resource:"registry-recipes"`. |

Two upstream corrections your README carries: the registry is **multi-chain and live on
Arbitrum One (42161)** (not single-registry-on-Base), and the adapter's controller roles ARE
granted on-chain — the JIT fill path works today.

## Signer-purpose mapping (`KernelCallerOwnedSigner`)

| Purpose | Old surface | Live surface | Key |
| --- | --- | --- | --- |
| `"limit-order"` | maker.prepare artifact digest | `maker-order` / `rollover-intent` EIP-712 `typedData` | MAIN |
| `"permit2"` | permit legs in prepare | `cork_prepare_phoenix fundingMode:"permit2"` legs (also `jitMarket.permits[]`) | MAIN |
| `"paired-shares-unwind"` | unwind prepare/finalize | `cork_prepare_phoenix` unwind bundle = a plain tx to sign + broadcast | EXERCISE |

`KernelCallerOwnedBroadcaster` is unchanged in spirit: this server never signs, never
broadcasts, never holds keys — every side effect except the off-chain venue POSTs is yours.

## Discovery, teaching, and what is deliberately absent

- `cork_capabilities` with no args = the full maturity map (which variants are live vs gated);
  `search:"…"`/`topic:"…"` return filled invocation templates. Wire your adapter's unknown-tool
  fallback to it.
- Schema mistakes come back as structured teaching errors (path/expected/received + a corrected
  example that validates) — safe to surface directly to a retry loop.
- Gated by design (returns `unavailable` with a reason, never fabricates): `taker-fill` prepare,
  `dutch-auction-price`, `rfq-quote` pricing, `whitelisted-addresses`. RFQ **pricing** is waiting
  on the underwriting model; RFQ **transport** (list/get/open/answer) is fully live.
