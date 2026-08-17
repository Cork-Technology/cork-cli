# Use Cork from TypeScript — the `@cork/core` SDK guide

This guide gets you from zero to your first Cork call in a few minutes. You read live protocol
state, run bit-exact math, and build unsigned transactions — all from typed TypeScript.

One safety property shapes everything here: **the SDK never signs and never holds keys.** Every
prepare function returns unsigned bytes or typed-data. You sign with your own wallet and
broadcast through your own RPC. The one side-effecting call, `cork_submit`, only relays a
payload you already signed.

## What you get

- `@cork/core` — the SDK. Math, chain reads, order building, bundle encoding, and `runTool`:
  the same 9-tool contract that the Cork MCP server and the `ch` CLI ship.
- `@cork/schemas` — the zod schemas for every tool input and output. Useful on its own when you
  validate inputs before you send them anywhere.

The numbers are not approximations. Every math port is bit-exact against the deployed Solidity,
verified wei-for-wei on live chains. Trust the SDK's numbers over hand-derived ones.

## Requirements and install

You need Node ≥ 22 or Bun ≥ 1.3. The packages are ESM-only and ship their own types.

The packages are not on a public registry yet. Until they are, install from packed tarballs:

```sh
# in a clone of this repo:
cd packages/schemas && bun pm pack --destination /tmp/cork-pkgs
cd ../core        && bun pm pack --destination /tmp/cork-pkgs

# in your project:
npm install /tmp/cork-pkgs/cork-schemas-*.tgz /tmp/cork-pkgs/cork-core-*.tgz
```

`bun pm pack` rewrites the workspace versions, so the tarballs install cleanly with npm, pnpm,
or bun.

## Your first call

`runTool(name, input)` is the front door. It validates your input, runs the tool, and returns a
result envelope. Chain reads work with no configuration on Ethereum mainnet, Arbitrum One, and
Base — the SDK resolves a public RPC endpoint by itself.

```ts
import { runTool } from "@cork/core";

const result = await runTool("cork_query", {
  resource: "cork-pool",
  filters: { poolId: "0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05" },
});

if (result.state === "ok") {
  console.log(result.data);       // live pool state, with a `scales` block that labels every number
} else {
  console.log(result.state, result.warnings);  // the honest reason, never a fabricated answer
}
```

Not sure which tool you need? Ask the SDK itself:

```ts
await runTool("cork_capabilities", { search: "unwind" });   // keyword → tool + filled template
await runTool("cork_capabilities", { topic: "signing" });   // how to complete an unsigned artifact
await runTool("cork_capabilities", { topic: "units" });     // the scale table (1e18 = 1.0 vs 1e18 = 1%)
```

## Read the envelope before you trust the data

Every tool returns the same shape:

```ts
{ state, data, warnings, provenance, schemaVersion }
```

Check `state` first. There are three values, and each one means what it says:

| `state` | Meaning | What you do |
|---|---|---|
| `ok` | The call worked. | Use `data`. Read `warnings` — informational notes ride here too. |
| `unavailable` | The tool cannot serve this honestly. | Read `warnings[0].code` for the reason. Do not retry the same call. |
| `conflict` | The tool ran and found a mismatch. | Surface it. Something disagrees — often venue vs chain, and chain wins. |

<details>
<summary><b>Deeper: warnings, provenance, and scales</b></summary>

**Warnings are structured.** Each entry is `{ code, message }`. The code is stable and
branchable; the message is for people. The full code table lives in the repo `CLAUDE.md`. A few
you meet early:

- `requires_rpc` — no RPC endpoint resolved. Set `CORK_RPC_URL` or pass `ctx.rpcUrl`.
- `chain_read_failed` — the RPC answered but the read reverted. Usually the pool does not exist
  on that chain.
- `rpc_fallback` — informational: a public fallback endpoint served this read.

**Provenance tells you who answered.** `provenance.mode` is a connectivity pledge:
`lite-decentralized` = your RPC only; `hybrid` = venue rows, chain-verified; `full-decentralized`
= chain events, never the venue. `provenance.chainId` and `fetchedAt` are always present. Pass
`format: "full"` in any input to also get the RPC host that served the read.

**Numbers carry labels.** Money and rate outputs include a `scales` block. Read it. Not every
value is 18-decimals, and two conventions coexist on-chain (1e18 = 1.0 for rates, 1e18 = 1% for
fees). The `units` doc topic has the full table.

**Digests are opaque.** Compare `provenance.digest` only against digests from this SDK. Do not
parse them.
</details>

## Import only what you need

The root import gives you everything. Eight subpaths give you one tier each — pure math never
loads the venue client or an RPC transport:

```ts
import { runTool } from "@cork/core";                       // everything + the envelope
import { computeMarketId } from "@cork/core/math";          // pure math only, zero IO
import { buildMakerOrder } from "@cork/core/orders";        // order primitives only
```

| Subpath | What it holds |
|---|---|
| `@cork/core/math` | Bit-exact math ports, `MarketId` hashing, CREATE2 derivation. Zero IO. |
| `@cork/core/orders` | 1inch LOP v4 orders, Fusion auction pricing, rollover EIP-712, ForSelf builders. |
| `@cork/core/registry` | MarketRegistry reads, recipe constraints, JIT market derivation. |
| `@cork/core/chain` | ABIs, pool state reads, event decoding, RPC resolution. |
| `@cork/core/bundle` | Bundler3 action encoders, decode, funding legs, the signer summary. |
| `@cork/core/venue` | The typed venue (api-phoenix) client with cursor pagination. |
| `@cork/core/indexer` | HyperSync event-archive access for full-decentralized reads. |
| `@cork/core/config` | Deployment config, CREATE2 attestations, implementation guards. |

<details>
<summary><b>Deeper: a pure-math example with no network at all</b></summary>

The math tier works offline, in any runtime. Here is the pool identity hash — the same
derivation the contracts run:

```ts
import { computeMarketId, type Market } from "@cork/core/math";

const market: Market = {
  collateralAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  referenceAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
  expiryTimestamp: 1_900_000_000n,
  rateMin: 900_000_000_000_000_000n,          // 0.90 — rates use 1e18 = 1.0
  rateMax: 1_100_000_000_000_000_000n,        // 1.10
  rateChangePerDayMax: 10_000_000_000_000_000n,
  rateChangeCapacityMax: 100_000_000_000_000_000n,
  rateOracle: "0x0000000000000000000000000000000000000000",
};

const poolId = computeMarketId(market);       // `0x…` — bit-exact vs the chain
```

Amounts and rates are `bigint` in base units throughout. The SDK never uses floating point for
money.
</details>

## Recipe: prepare, simulate, sign, send

This is the full life of an on-chain action. The SDK does steps 1–3 and 5. Your wallet does
step 4. Your RPC does step 6.

```ts
import { runTool } from "@cork/core";

// 1. Prepare — returns an UNSIGNED Bundler3 bundle plus a plain-English summary.
const prep = await runTool("cork_prepare_phoenix", {
  chainId: 1,
  account: "0xYourAddress…",
  clientRequestId: "my-deposit-0001",          // idempotency key — reuse it on retries
  fundingMode: "erc20-approve",
  action: {
    type: "deposit",
    poolId: "0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05",
    collateralAssetsIn: "10000000000000000000",   // 10 tokens, base units, string
    receiver: "0xYourAddress…",
    minCptAndCstSharesOut: "1",
  },
});

// 2. Read the summary — one line per leg, in execution order. Show it to whoever signs.
console.log(prep.data.summary);

// 3. Dry-run the frozen bytes BEFORE anyone signs.
const sim = await runTool("cork_track", {
  mode: "simulate",
  subject: { kind: "artifact", artifact: prep.data },
});
// `would_revert` in sim.warnings means: do not sign as-is.

// 4. Sign client-side with YOUR wallet (eth_signTransaction). The SDK is not involved.

// 5. Decode the SIGNED bytes as a last check: recovered signer, named target, labeled legs.
const check = await runTool("cork_decode", { kind: "tx", data: signedRawTx });

// 6. Broadcast through your own RPC (eth_sendRawTransaction), then reconcile:
await runTool("cork_track", { mode: "reconcile", subject: { kind: "txHash", txHash } });
```

Every prepare result carries `data.execution`: the artifact kind, the sign method, and the
ordered next steps. When in doubt, follow it.

<details>
<summary><b>Deeper: the order path (EIP-712 typed-data)</b></summary>

Limit orders and rollover intents follow the second family. You sign typed-data instead of a
transaction, and the venue receives the result:

1. `cork_prepare_orders` with `action.type: "maker-order"` → unsigned EIP-712 typed-data.
2. Sign it client-side (`eth_signTypedData_v4`).
3. `cork_prepare_orders` with `action.type: "finalize-maker-order"` → the SDK verifies your
   signature against a local reconstruction. It never signs. The result carries a
   `submitInput`.
4. `cork_submit` with that `submitInput`, verbatim → the venue lists your order.

One rule saves you a bad day: **give every concurrently-live order its own `clientRequestId`.**
The order nonce derives from it. Orders that share an id share one invalidator bit, so filling
one kills the other.
</details>

<details>
<summary><b>Deeper: determinism and retries</b></summary>

`runTool` takes an optional third argument, the handler context:

```ts
await runTool(name, input, {
  nowSeconds: 1_800_000_000n,   // pin the clock — deadlines become reproducible
  atBlock: 20_000_000n,         // pin chain reads to one block
  rpcUrl: "https://…",          // explicit endpoint; skips resolution
});
```

Two rules govern retries:

- **Reuse the same `clientRequestId` when you retry the same request.** Use a fresh id for a
  genuinely new request.
- Deadline fields are wall-clock plus duration, so a retry re-anchors in time and produces
  different bytes. For byte-identical retries, pass an absolute `deadlineAt` (bundles) or pin
  `nowSeconds`.
</details>

<details>
<summary><b>Deeper: RPC endpoints and environment variables</b></summary>

Chain reads resolve an endpoint in this order: explicit (`ctx.rpcUrl` or `CORK_RPC_URL`) →
committed defaults (mainnet, Arbitrum One, Base) → chainlist.org fallback. Failures trip a
per-endpoint circuit breaker and fail over in-call. `provenance.rpc` (with `format: "full"`)
discloses which endpoint served you.

You only need configuration for: a private node, a chain outside the defaults (for example a
staging vnet), or the event-archive tier (`ENVIO_HYPERSYNC_TOKEN` for full-decentralized
reads). Everything else works out of the box.

One rule: never commit an RPC URL. Pass endpoints through the environment.
</details>

<details>
<summary><b>Deeper: validate inputs early with @cork/schemas</b></summary>

`runTool` validates for you and returns structured teaching errors on bad input — each issue
carries a path, the expectation, a "did you mean …?", and a corrected example. If you want to
validate earlier (for example at your own API boundary), use the schemas directly:

```ts
import { toolByName } from "@cork/schemas";

const tool = toolByName("cork_query");
const parsed = tool.input.safeParse(userInput);   // zod v4 — same schema the SDK enforces
```

Bad input surfaces as a thrown `ToolInputError` (exported from `@cork/core`). Everything else
— including domain failures — comes back inside the envelope, never as an exception.
</details>

## What we promise about stability

The public surface — every export on the root and each subpath, type exports included — is
pinned by a drift gate in CI (`packages/core/test/api-surface.test.ts`). Nothing appears or
disappears by accident. Below 1.0.0, a breaking change on covered surface bumps the minor
version and lands in the changelog. The internal modules the barrel excludes carry no promise —
if you cannot import it, do not depend on it.

## When something goes wrong

Read the envelope first: `state`, then `warnings[0].code`. The code is the diagnosis. If the
message names a fix (most do), try that. If a read looks wrong, ask for `format: "full"` and
check which endpoint and mode served it. And if you find a number the chain disagrees with, we
want to know — the math is verified wei-for-wei, and we treat any deviation as a bug.
