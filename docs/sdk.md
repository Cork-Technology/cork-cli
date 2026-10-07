# Use Cork from TypeScript: the `@cork/core` SDK guide

This guide takes you from zero to your first Cork call in a few minutes. You read live protocol
state, run bit-exact math and build unsigned transactions, all from typed TypeScript.

One safety property shapes everything here: **the SDK never signs or holds wallet private keys.**
Every prepare returns unsigned bytes or typed data. You sign with your own wallet and broadcast
through your own RPC. `cork_submit` relays caller-signed or API-key-authenticated venue payloads;
it does not broadcast on-chain transactions.

Make one trade-off on purpose before you import anything. A library runs in-process, with your
backend's full authority. The `ch` binary runs behind an OS process boundary you can sandbox. If
your posture needs that boundary, use the binary, or run this SDK in its own worker process.
[sdk-roadmap.md](sdk-roadmap.md) weighs the two.

## What you get

- `@cork/core`: the SDK. Math, chain reads, order building, bundle encoding, and `runTool`, the
  same 9-tool contract that the Cork MCP server and the `ch` CLI ship.
- `@cork/schemas`: the zod schemas for every tool input and output. Useful on its own when you
  validate inputs before you send them anywhere.

The numbers are not approximations. Every math port is bit-exact against the deployed Solidity,
verified wei-for-wei on live chains. Trust the SDK's numbers over hand-derived ones.

## Requirements and install

You need Node 22 or later, or Bun 1.3 or later. The packages are ESM-only and ship their own types.

The packages are not on a public registry. A release ships three attested tarballs beside the
binaries: schemas, core and the optional MCP server package. Choose the **intended repository**:
private candidates live in `Cork-Technology/cork-cli-private`; approved public releases live in
`Cork-Technology/cork-cli`. This preparation PR has not published v0.7.0-rc.1.

Download an already-published tag and verify every archive against its repository, builder,
tag and approved source commit. Never put a private credential in a package URL or lockfile.

```sh
REPO=Cork-Technology/cork-cli-private # use Cork-Technology/cork-cli for a public release
: "${TAG:?Set the published release tag}"
: "${SOURCE_COMMIT:?Set its approved 40-character source commit}"
export GH_HOST=github.com GH_DEBUG=
case "$REPO" in
  Cork-Technology/cork-cli-private)
    : "${CORK_GITHUB_TOKEN:?Explicit repository/attestation read access is required}"
    export GH_TOKEN="$CORK_GITHUB_TOKEN" ;;
  Cork-Technology/cork-cli) ;;
  *) echo 'Unknown release repository' >&2; exit 1 ;;
esac
gh release download "$TAG" --repo "$REPO" --pattern 'cork-*.tgz'
for asset in cork-*.tgz; do
  gh attestation verify "$asset" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/build-binaries.yml" \
    --source-ref "refs/tags/$TAG" --source-digest "$SOURCE_COMMIT"
done
```

Merge dependencies **and overrides** into your consumer's package.json. This example is for
0.7.0-rc.1 after publication; use the archive version of the tag you actually downloaded.
The overrides keep transitive Cork dependencies on those same verified archives rather than
trying unpublished npm versions. MCP is optional: omit both of its entries if you need only core.

```json
{
  "dependencies": {
    "@cork/schemas": "file:./cork-schemas-0.7.0-rc.1.tgz",
    "@cork/core": "file:./cork-core-0.7.0-rc.1.tgz",
    "@cork/mcp": "file:./cork-mcp-0.7.0-rc.1.tgz"
  },
  "overrides": {
    "@cork/schemas": "file:./cork-schemas-0.7.0-rc.1.tgz",
    "@cork/core": "file:./cork-core-0.7.0-rc.1.tgz",
    "@cork/mcp": "file:./cork-mcp-0.7.0-rc.1.tgz"
  }
}
```

```sh
bun install --ignore-scripts
```

Other, third-party dependencies still come from their registries. Review the lockfile's archive
integrities on each upgrade. For private remote config and release reads, set CORK_GITHUB_TOKEN
in the SDK process environment; this is separate from CORK_RFQ_API_KEY for venue authentication.

Working from a clone? Build and validate with the repository's pinned Bun before packing:

```sh
mise exec -- bun install --frozen-lockfile --os='*' --cpu='*'
mise exec -- bun run verify:publish # local build/layout/type checks, not publication
SDK_DIR="$(mktemp -d)"
for package in schemas core mcp; do
  (cd "packages/$package" && mise exec -- bun pm pack --quiet --destination "$SDK_DIR")
done
printf 'Local archives: %s\n' "$SDK_DIR"
```

Copy those local archives into your consumer and use the dependency/override recipe above.
Locally packed bytes are not attested release assets; the release's independent-build checksum
comparison and provenance gates must prove release reproducibility separately.

Why tarballs and not npm? [sdk-roadmap.md](sdk-roadmap.md) explains the distribution posture, the
verification chain, and when the npm stage arrives.

## Your first call

`runTool(name, input)` is the front door. It validates your input, runs the tool and returns a
result envelope. Chain reads work with no configuration on Ethereum mainnet, Arbitrum One and
Base. The SDK resolves a public RPC endpoint by itself.

```ts
import { runTool } from "@cork/core";

const result = await runTool("cork_query", {
  resource: "cork-pool",
  filters: { poolId: "0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05" },
});

if (result.state === "ok") {
  console.log(result.data);                    // live pool state; `scales` labels every number
} else {
  console.log(result.state, result.warnings);  // the honest reason, never a made-up answer
}
```

Not sure which tool you need? Ask the SDK:

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

Check `state` first. It has three values, and each means what it says.

| `state` | Meaning | What you do |
|---|---|---|
| `ok` | The call worked. | Use `data`. Read `warnings` too; informational notes ride there. |
| `unavailable` | The tool cannot serve this honestly. | Read `warnings[0].code` for the reason. Do not retry the same call. |
| `conflict` | The tool ran and found a mismatch. | Surface it. Two sources disagree, often the venue and the chain, and the chain wins. |

<details>
<summary><b>Deeper: warnings, provenance and scales</b></summary>

**Warnings are structured.** Each entry is `{ code, message }`. The code is stable and you can
branch on it. The message is for people. Codes you meet early:

- `requires_rpc`: no RPC endpoint resolved. Set `CORK_RPC_URL` or pass `ctx.rpcUrl`.
- `pool_not_found`: no configured pool manager on that chain knows the pool.
- `chain_read_failed`: the RPC answered but the read reverted.
- `rpc_fallback`: informational. A public fallback endpoint served this read.

**Provenance tells you who answered.** `provenance.mode` is a connectivity pledge:
`lite-decentralized` means your RPC only; `hybrid` means venue rows, chain-verified;
`full-decentralized` means chain events, never the venue. `provenance.chainId`, `fetchedAt` and,
on a chain-backed read, `generation` are always present. Pass `format: "full"` in any input to
also get the RPC host that served the read.

**Numbers carry labels.** Money and rate outputs include a `scales` block. Read it. Not every value
has 18 decimals, and two conventions coexist on-chain: 1e18 = 1.0 for rates, 1e18 = 1% for fees.
The `units` topic has the full table.

**Digests are opaque.** Compare `provenance.digest` only with digests from this SDK. Do not parse
them.
</details>

## Import only what you need

The root import gives you everything. Eight subpaths give you one tier each, so pure math never
loads the venue client or an RPC transport:

```ts
import { runTool } from "@cork/core";                       // everything, with the envelope
import { computeMarketId } from "@cork/core/math";          // pure math, zero IO
import { buildMakerOrder } from "@cork/core/orders";        // order primitives only
```

| Subpath | What it holds |
|---|---|
| `@cork/core/math` | Bit-exact math ports, pool id hashing, CREATE2 derivation. Zero IO. |
| `@cork/core/orders` | 1inch LOP v4 orders, Fusion auction pricing, rollover EIP-712, ForSelf builders. |
| `@cork/core/registry` | Market Registry ABIs and both wires, recipe constraints, JIT market derivation, the create-pool and deploy-oracle builders. |
| `@cork/core/chain` | ABIs, pool state reads, event decoding, RPC resolution. |
| `@cork/core/bundle` | Bundler3 action encoders, decode, funding legs, the signer summary. |
| `@cork/core/venue` | The typed venue (api-phoenix) client with cursor pagination. |
| `@cork/core/indexer` | HyperSync event-archive access for full-decentralized reads. |
| `@cork/core/config` | Deployment config and the generation model: `generationsOf`, `selectGeneration`, `classifyAddress`, `resolvePoolGeneration`. CREATE2 attestations and the approved-implementations list. |

<details>
<summary><b>Deeper: a pure-math example with no network at all</b></summary>

The math tier works offline in any runtime. Here is the pool identity hash, the same derivation the
contracts run:

```ts
import { computeMarketId, type Market8, type Market10 } from "@cork/core/math";

// An 8-field market: the phoenix/v0.3-rc.1 pool manager and mainnet. The fees live outside the id.
const market8: Market8 = {
  collateralAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  referenceAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
  expiryTimestamp: 1_900_000_000n,
  rateMin: 900_000_000_000_000_000n,          // 0.90; rates use 1e18 = 1.0
  rateMax: 1_100_000_000_000_000_000n,        // 1.10
  rateChangePerDayMax: 10_000_000_000_000_000n,
  rateChangeCapacityMax: 100_000_000_000_000_000n,
  rateOracle: "0x0000000000000000000000000000000000000000",
};
const poolId8 = computeMarketId(market8, "8-field");

// A 10-field market: the phoenix/v0.4-rc.1 pool manager, the primary on Arbitrum and Base.
// The two fees are part of the struct AND the id. Two markets that differ only in a fee are two pools.
const market10: Market10 = {
  ...market8,
  swapFeePercentage: 1_000_000_000_000_000_000n,        // 1%; fees use 1e18 = 1%
  unwindSwapFeePercentage: 500_000_000_000_000_000n,    // 0.5%
};
const poolId10 = computeMarketId(market10, "10-field");
```

`Market` is the union `Market8 | Market10`. `computeMarketId` takes the wire explicitly and refuses
a market whose shape contradicts it. Why explicit: viem decodes a 10-field `market()` return through
an 8-field ABI without error, so the wire is never inferred from the fields. The wire comes from the
pool's generation. `generationsOf(defaults, chainId)` lists a chain's generations, primary first,
each block with its `wire`. `resolvePoolGeneration(client, list, poolId)` finds the generation a pool
lives on with one batched `shares(poolId)` read. `resolveDeployment`, `resolveRollover` and
`resolveMarketRegistry` take an optional generation label and return `generation: { label, status,
wire }`. `runTool` does all of this for you: every chain-backed input takes an optional
`generation`, a pool-scoped read follows the pool's generation, and every such result carries
`data.generation` and `provenance.generation`.

Amounts and rates are `bigint` in base units throughout. The SDK never uses floating point for
money.
</details>

## Recipe: prepare, simulate, sign, send

This is the full life of an on-chain action. The SDK does steps 1 to 3 and step 5. Your wallet
does step 4. Your RPC does step 6.

```ts
import { runTool } from "@cork/core";

// 1. Prepare. Returns an UNSIGNED Bundler3 bundle plus a plain-English summary.
const prep = await runTool("cork_prepare_phoenix", {
  chainId: 8453,
  account: "0xYourAddress…",
  clientRequestId: "my-deposit-0001",          // idempotency key; reuse it on retries
  fundingMode: "erc20-approve",
  action: {
    type: "deposit",
    poolId: "0x…",                             // the pool decides its own generation
    collateralAssetsIn: "1000000",             // base units as a string (here 1 USDC)
    receiver: "0xYourAddress…",
    minCptAndCstSharesOut: "1",
  },
});

// 2. Read the summary: one line per leg, in execution order. Show it to whoever signs.
console.log(prep.data.summary);

// 3. Dry-run the frozen bytes BEFORE anyone signs.
const sim = await runTool("cork_track", {
  chainId: 8453,
  mode: "simulate",
  subject: { kind: "artifact", artifact: prep.data },
});
// `would_revert` in sim.warnings means: do not sign as-is.

// 4. Sign client-side with YOUR wallet (eth_signTransaction). The SDK is not involved.

// 5. Decode the SIGNED bytes as a last check: recovered signer, named target, labeled legs.
const check = await runTool("cork_decode", { kind: "tx", data: signedRawTx });

// 6. Broadcast through your own RPC (eth_sendRawTransaction), then reconcile.
await runTool("cork_track", { chainId: 8453, mode: "reconcile", subject: { kind: "txHash", txHash } });
```

Every prepare result carries `data.execution`: the artifact kind, the sign method and the ordered
next steps. When in doubt, follow it.

<details>
<summary><b>Deeper: the order path (EIP-712 typed data)</b></summary>

Limit orders and rollover intents follow the second family. You sign typed data instead of a
transaction, and the venue receives the result.

1. `cork_prepare_orders` with `action.type: "maker-order"` returns unsigned EIP-712 typed data.
2. Sign it client-side (`eth_signTypedData_v4`).
3. `cork_prepare_orders` with `action.type: "finalize-maker-order"` verifies your signature against
   a local reconstruction. It never signs. The result carries a `submitInput`.
4. `cork_submit` with that `submitInput`, verbatim. The venue lists your order.

One rule saves you a bad day: **give every concurrently live order its own `clientRequestId`.**
The order nonce derives from it. Orders that share an id share one invalidator bit, so filling one
kills the other. To share a bit on purpose, name an `ocoGroup`.
</details>

<details>
<summary><b>Deeper: determinism and retries</b></summary>

`runTool` takes an optional third argument, the handler context:

```ts
await runTool(name, input, {
  nowSeconds: 1_800_000_000n,   // pin the clock; deadlines become reproducible
  atBlock: 20_000_000n,         // pin chain reads to one block
  rpcUrl: "https://…",          // explicit endpoint; skips resolution
  generation: "previous",       // the default generation for this call
});
```

Two rules govern retries. Reuse the same `clientRequestId` when you retry the same request, and use
a fresh id for a new one. Deadline fields are wall-clock plus duration, so a retry re-anchors in
time and produces different bytes. For byte-identical retries, pass an absolute `deadlineAt` on
bundles, or pin `nowSeconds`.
</details>

<details>
<summary><b>Deeper: RPC endpoints and environment variables</b></summary>

Chain reads resolve an endpoint in this order: explicit (`ctx.rpcUrl` or `CORK_RPC_URL`), then the
committed defaults (mainnet, Arbitrum One, Base), then the chainlist.org fallback. An explicit
endpoint must prove it serves the requested chain, or the call refuses. Failures trip a
per-endpoint circuit breaker and fail over during the call. `provenance.rpc`, with
`format: "full"`, discloses which endpoint served you.

You need configuration only for a private node, a chain outside the defaults (a staging vnet, for
example), or the event-archive tier (`ENVIO_HYPERSYNC_TOKEN` for full-decentralized reads).
Everything else works out of the box.

One rule: never commit an RPC URL. Pass endpoints through the environment.
</details>

<details>
<summary><b>Deeper: validate inputs early with @cork/schemas</b></summary>

`runTool` validates for you and returns structured teaching errors on bad input. Each issue carries
a path, the expectation, a "did you mean" suggestion and a corrected example. To validate earlier,
for example at your own API boundary, use the schemas directly:

```ts
import { toolByName } from "@cork/schemas";

const tool = toolByName("cork_query");
const parsed = tool.input.safeParse(userInput);   // zod v4, the same schema the SDK enforces
```

Bad input surfaces as a thrown `ToolInputError`, exported from `@cork/core`. Everything else,
domain failures included, comes back inside the envelope, never as an exception.
</details>

## What we promise about stability

The public surface, every export on the root and on each subpath, type exports included, is pinned
by a drift gate in CI (`packages/core/test/api-surface.test.ts`). Nothing appears or disappears by
accident. Below 1.0.0, a breaking change on covered surface bumps the minor version and lands in
the changelog. The internal modules the barrels exclude carry no promise. If you cannot import it,
do not depend on it.

## When something goes wrong

Read the envelope first: `state`, then `warnings[0].code`. The code is the diagnosis. If the
message names a fix, and most do, try that. If a read looks wrong, ask for `format: "full"` and
check which endpoint and mode served it. And if you find a number the chain disagrees with, tell
us. The math is verified wei-for-wei, and we treat any deviation as a bug.
