# cork-cli

One tool for Cork Phoenix, three ways to use it: an **MCP server** for AI agents, a **CLI** for
people and scripts, and a **TypeScript SDK** for integrators. All three are projections of the
same typed core (RFC 011), so they share one contract: 9 tools that read protocol state, run
bit-exact math, decode bytes, and build **unsigned** transactions and orders.

One safety property shapes everything: **these tools never sign and never hold keys.** You sign
with your own wallet and broadcast through your own RPC. The one side-effecting tool,
`cork_submit`, only relays a payload you already signed.

The math is not an approximation. Every port is verified wei-for-wei against live on-chain
reads on Ethereum mainnet and Arbitrum One.

## Install

You need one file: the `ch` binary. It contains the CLI **and** the MCP server (`ch mcp`).
No runtime, no clone, no package manager.

1. Open the [Releases page](https://github.com/Cork-Technology/cork-cli/releases) and download
   the asset for your platform:

   | Platform | Asset |
   |---|---|
   | Linux x86-64 | `ch-linux-x64` (glibc) · `ch-linux-x64-musl` (Alpine) |
   | Linux ARM64 | `ch-linux-arm64` (glibc) · `ch-linux-arm64-musl` (Alpine) |
   | macOS Apple Silicon | `ch-darwin-arm64` |
   | macOS Intel | `ch-darwin-x64` |
   | Windows x86-64 | `ch-windows-x64.exe` |

2. Make it executable and put it on your `PATH`:

   ```sh
   chmod +x ch-linux-x64
   mv ch-linux-x64 ~/.local/bin/ch      # any directory on your PATH works
   ```

3. Check it. A healthy install lists **9 tools**:

   ```sh
   ch capabilities
   ```

Later, update in place with `ch self-update`. It resolves the newest release, verifies its
provenance, runs the staged binary's own `version --json` to confirm it is that build, and only
then swaps atomically. It never installs an older release unless you pass `--allow-downgrade`.

<details>
<summary><b>Verify a download before you trust it</b></summary>

Releases are immutable, and every asset carries a GitHub build attestation. Two independent
builds must produce byte-identical binaries before a release can publish. Verify any asset with
the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify ch-linux-x64 \
  --repo Cork-Technology/cork-cli \
  --signer-workflow Cork-Technology/cork-cli/.github/workflows/build-binaries.yml
```

This proves the exact bytes came from this repository's build workflow at a specific tag.
</details>

<details>
<summary><b>Alpine Linux: install from the apk repository</b></summary>

Alpine users can install and update through the signed package channel instead. The signing
key is served already; the package index goes live with the **first production (non-rc)
release** — until then step 2's `apk update` reports the repository as unavailable.

```sh
# 1. trust the signing key (the same key is committed as packaging/melange.rsa.pub)
wget -O /etc/apk/keys/melange.rsa.pub https://cork-technology.github.io/cork-cli/melange.rsa.pub

# 2. add the repository and install
echo "https://cork-technology.github.io/cork-cli/apk" >> /etc/apk/repositories
apk update && apk add cork-cli
```

`apk upgrade cork-cli` then tracks new releases. Published apks are immutable.
</details>

<details>
<summary><b>Run it from the container image (Docker or Podman)</b></summary>

Every release also publishes a minimal Wolfi image with the same `ch` binary, for
`linux/amd64` and `linux/arm64`. It runs as a non-root user and its entrypoint is `ch`, so
the image takes the same arguments as the binary. Pick the tag from the
[package page](https://github.com/Cork-Technology/cork-cli/pkgs/container/cork-cli); `latest`
appears with the first production (non-rc) release.

```sh
docker pull ghcr.io/cork-technology/cork-cli:v0.4.0
docker run --rm ghcr.io/cork-technology/cork-cli:v0.4.0 capabilities     # lists 9 tools
```

The image caches RPC and config state under `/home/nonroot/.cache`. Mount a volume there to
keep it between runs:

```sh
docker run --rm -v cork-cache:/home/nonroot/.cache ghcr.io/cork-technology/cork-cli:v0.4.0 query protocol-config
```

The image has no shell, no package manager, and no setuid binary, and it runs as uid 65532.
Run it locked down. It needs one thing: a **writable, exec-mappable temp dir**. HyperSync
reads (`full-decentralized` mode) extract the embedded native binding there on first load and
`dlopen` it, and remove it at exit. A `noexec` temp dir fails with `failed to map segment`;
`TMPDIR` is honored. Docker's `--read-only` mounts no tmpfs by itself, so pass one:

```sh
# ENVIO_API_TOKEN is passed through from your shell, never written on the command line.
docker run --rm --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m --tmpfs /home/nonroot:rw,nosuid,nodev,size=64m \
  --cap-drop=ALL --security-opt=no-new-privileges --user 65532 \
  -e ENVIO_API_TOKEN ghcr.io/cork-technology/cork-cli:v0.4.0 \
  query whitelisted-addresses --chain-id 42161 --mode full-decentralized
```

`ch` is PID 1 in the container and handles SIGTERM itself, so `docker stop` is immediate. The
v0.4.0-rc.1 image predates that handler: give it `--init` for a prompt stop.

Verify the image the same way as a binary — by digest, against this repository's workflow:

```sh
docker buildx imagetools inspect ghcr.io/cork-technology/cork-cli:v0.4.0 --format '{{.Manifest.Digest}}'
gh attestation verify oci://ghcr.io/cork-technology/cork-cli@sha256:<digest> --repo Cork-Technology/cork-cli
```

The image is composed from the signed apk channel above, so an image and an `apk add` install
carry the same package bytes.
</details>

<details>
<summary><b>No binary for your platform, or you want the source?</b></summary>

The repository runs directly from source under Bun — see [Develop](#develop-run-from-source)
below. Everything in this README works the same way from a checkout.
</details>

## Use it with Claude Code (MCP)

The MCP server exposes all 9 Cork tools to Claude Code (or any MCP client) over stdio. Claude
can then read protocol state, run the bit-exact math, and build unsigned bundles and orders for
you — without ever signing or broadcasting anything.

### 1. Register the server

Register `ch mcp` with `claude mcp add`. **Pick one** of the two variants — they are
alternatives that share the name `cork-defi`, not additive (`claude mcp remove cork-defi` first
if you want to switch):

```sh
# A) recommended — works out of the box, including live chain reads on public chains
claude mcp add cork-defi -- "$(which ch)" mcp

# B) optional — pin your own RPC endpoint (a private/faster node, or a chain with no built-in
#    default such as the staging vnet). This OVERRIDES the built-in defaults:
claude mcp add cork-defi -e CORK_RPC_URL=https://your-rpc-endpoint -- "$(which ch)" mcp
```

Chain-backed tools work **without any RPC setup**: the server ships with built-in default
endpoints for Ethereum mainnet, Arbitrum, and Base, and fetches a fast public RPC from
chainlist.org (with a circuit breaker and retry/backoff) if a default is unreachable — see
"How RPC endpoints are resolved" below. Variant B only overrides that.

**Why `"$(which ch)"` and not plain `ch`.** Claude Code launches the server as a subprocess
that may not inherit your shell's `PATH` (notably the desktop app), so a bare `ch` can fail
with "command not found". `"$(which ch)"` resolves to the absolute path at `add` time. If the
server won't connect, check this first — `claude mcp get cork-defi` shows the exact command it
runs.

By default this registers the server **locally** (just you, just this project). `-s user` makes
it available in every project. **Avoid `-s project` with the `-e CORK_RPC_URL=…` variant:**
project scope writes a *committed* `.mcp.json`, and the RPC endpoint value must never enter
git. Share via `-s project` with variant A only; let each teammate set their own endpoint
locally.

<details>
<summary><b>Run the MCP server from the container instead of a local binary</b></summary>

The server speaks MCP over stdio, so `docker run -i` (interactive stdin, no `-t`) is the whole
transport. Register the container as the server command:

```sh
# A) built-in RPC defaults
claude mcp add cork-defi -- "$(which docker)" run -i --rm ghcr.io/cork-technology/cork-cli:v0.4.0 mcp

# B) your own RPC endpoint — pass it to the container, not to claude
claude mcp add cork-defi -- "$(which docker)" run -i --rm -e CORK_RPC_URL=https://your-rpc-endpoint ghcr.io/cork-technology/cork-cli:v0.4.0 mcp
```

`"$(which docker)"` for the same reason as `"$(which ch)"` above: the subprocess may not see
your `PATH`. Podman works the same way (`"$(which podman)"`). The `-s project` warning applies
unchanged — variant B puts the endpoint in the command line, so never commit it.
</details>

### 2. Check it works

```sh
claude mcp list             # cork-defi should show "✔ Connected"
claude mcp get cork-defi    # shows the command, args, and any env you set
```

Then, inside a Claude Code session, ask:

> **You:** Using the cork-defi MCP, call cork_capabilities and tell me how many tools there are
> and their names.

A healthy install answers **9 tools**: `cork_query`, `cork_compute`, `cork_decode`,
`cork_capabilities`, `cork_prepare_phoenix`, `cork_prepare_orders`, `cork_prepare_market`,
`cork_track`, `cork_submit`.

### 3. Things to ask Claude

These work with **no RPC** (config-only or pure math):

> - "Ask cork-defi what tools relate to *bundles*." *(searches the manual)*
> - "Use cork-defi to compute the rollover premium floor for 1000e18 dstCST produced at a min premium of 0.02e18 per share." *(pure, exact math)*
> - "Get the Cork protocol config — I want the deployed CorkAdapter and Bundler3 addresses."
> - "Build an unsigned Cork swap bundle: 100 sUSDe out of pool `0xd16e…cf05`, receiver `0xc0ffee…0001`, max 101e18 cST in and 130e18 reference in." *(returns bytes only — nothing is signed)*
> - "Decode this Bundler3 calldata for me: `0x374f435d…`"

These read **live chain state** and work out of the box.
`0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05` is a real mainnet pool
(sUSDe-vbUSDC); list current pools at `api-phoenix.cork.tech/v1/pools/`:

> - "Read the live state of Cork market `0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05`."
> - "What's the current cST swap rate for 1e18 collateral out of that pool?"
> - "Is address `0xc0ffee…0001` whitelisted on that pool?"

Arbitrum (chainId 42161) is a **full** deployment like mainnet: reads, bundle building, orders,
and the MarketRegistry 2.1.0 resources (registry-assets / registry-oracle / registry-recipes /
registry-denominations / registry-feeds / derive-cork-pool, plus `cork_prepare_market` oracle
deploys) all work there. `derive-cork-pool` predicts the pool a JIT LOP fill would create — the
recipe's oracle, the off-chain-resolved constraint, pool id, and cST/cPT tokens — before
anything is deployed or signed.

Reading a pool that does not exist on the queried chain returns `unavailable` with
`chain_read_failed`, not a crash. That is expected; it is not a broken install.

<details>
<summary><b>Remote / HTTP transport (<code>ch mcp --http</code>) and the server env contract</b></summary>

The same server also speaks **Streamable HTTP** — the shape a hosted deployment serves:

```sh
ch mcp --http                # serves on :8080 — endpoint /mcp, health /healthz, docs /docs/signing
ch mcp --http --port 9090    # custom port
# in a container: bind all interfaces and publish the port — /healthz and /readyz answer 200,
# GET /mcp answers 405 by design (Streamable HTTP is POST):
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/cork-technology/cork-cli:v0.4.0 mcp --http --host 0.0.0.0

# connect a client to a running HTTP deployment:
claude mcp add --transport http cork-defi http://localhost:8080/mcp
# with bearer auth (deployments that set CORK_MCP_TOKEN):
claude mcp add --transport http cork-defi https://your-deployment/mcp --header "Authorization: Bearer <token>"
```

All env is read server-side at process start; clients cannot override any of it per call. That
is deliberate: server reads run on the server's own RPC configuration, and signing/broadcasting
are always client-side (see `cork_capabilities topic:"signing"`).

| Env | Effect |
|---|---|
| `CORK_MCP_TOKEN` | When set, `/mcp` requires `Authorization: Bearer <token>`; unset = open (put auth/rate-limits at your ingress). Never logged. |
| `CORK_RPC_URL` | Explicit RPC endpoint override for chain reads (else built-in defaults + chainlist fallback). |
| `ENVIO_API_TOKEN` / `ENVIO_HYPERSYNC_TOKEN` / `ENVIO_HYPERRPC_TOKEN` | HyperSync/HyperRPC access for the event-derived reads (`full-decentralized` mode, whitelisted-addresses, order-history legs). Release binaries, the apk, and the container image embed the HyperSync native binding for their target (Envio deprecated its Windows bindings at client 1.1.0 and never built linux-arm64-musl — those builds say so); `ch version` shows which binding a binary carries. |
| `CORK_VENUE_URL` | Override the venue API base (default api-phoenix.cork.tech). |
| `CORK_DEFAULTS_URL` / `CORK_CONFIG_CACHE_FILE` / `CORK_RPC_CACHE_FILE` | Address-config fetch/cache knobs (see "Address config" in CLAUDE.md). |

`GET /docs/signing` serves the sign-and-broadcast guide as markdown — the same constant that
backs `cork_capabilities topic:"signing"` and the server's `initialize` instructions, so the
three surfaces cannot drift.

The hosted deployment runs in a Phala Confidential VM; [`packaging/VERIFY.md`](packaging/VERIFY.md)
is the end-to-end recipe to prove — without trusting Cork — that an endpoint runs exactly the
attested image built from the tagged source.
</details>

## Use the CLI (`ch`)

The same 9 tools run straight from a shell — handy for scripts and quick checks:

```sh
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

<details>
<summary><b>The same commands through the container</b></summary>

A shell alias makes the image behave like an installed `ch`:

```sh
alias ch='docker run --rm -v cork-cache:/home/nonroot/.cache ghcr.io/cork-technology/cork-cli:v0.4.0'
ch query registry-assets --chain-id 42161
```

Flags, positionals, `--json`, and `--rpc-url` work as documented. Environment variables such
as `CORK_RPC_URL` or `ENVIO_API_TOKEN` go to the container with `-e NAME=value`.
</details>

**Full command reference:** [`docs/cli.md`](docs/cli.md) — every command with a one-liner,
grouped by workflow.

**Output is prose by default and JSON on request.** A person at a terminal gets a readable
summary; ask for the wire format with a bare `--json`, or set `CORK_JSON=1` to make JSON the
default in a shell. Supplying input *as* `--json '<object>'` also returns JSON — handing the
tool the wire shape is itself a machine-readable intent — so scripts that pass the wire shape
keep working unchanged.

**Prose is colored on a terminal, plain everywhere else.** SGR styling follows the usual
conventions — off when the stream is piped, [`NO_COLOR`](https://no-color.org) disables,
`FORCE_COLOR=1` forces (e.g. in CI logs), `TERM=dumb` disables — implemented in-tree with
zero dependencies. Color never changes a character: stripping the escapes yields the exact
plain output, and JSON output never carries them.

**Exit codes map the envelope state** so scripts can branch: `0` ok · `2` invalid input · `3`
unavailable · `4` conflict · `1` unexpected error. Chain-backed commands resolve an RPC
automatically (see below); pass `--rpc-url <url>` (or set `CORK_RPC_URL`) to override.

<details>
<summary><b>Input forms, flag spelling, and amount sugar</b></summary>

Input has three interchangeable forms. `--json '<object>'` is canonical and identical to what
the MCP server receives; `--input '<object>'` is the same thing under a name that cannot be
confused with the output flag; or pass subcommands/positionals plus flags named after the
tool's own schema fields — usually what you want by hand. Every discriminated action/kind is
its own subcommand (`ch prepare pool exercise …`, `ch submit rfq-open …`,
`ch track verify market-ref …`) with a variant-scoped `--help`/`--explain`:

```sh
ch query cork-pool --chain-id 1 --pool-id 0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05
```

Flags win over keys in a JSON blob, so a saved blob can be reused with one value overridden.
Flag spelling is forgiving — `--chainid`, `--chain-id` and `--chainId` are the same flag (help
displays the kebab form). Object-valued fields (`--filters`, `--for-self`) take a JSON string;
union-typed fields accept a raw string too (`ch decode tx --data 0x…` — no quoting gymnastics).
Amount fields accept exact human sugar: `1000e18` and `1_000000` expand by integer arithmetic
(a fractional remainder like `1.23e1` is refused with teaching, and sugar applies to flags only
— JSON blobs stay the exact wire form). `--chain-id` also takes network names (`arbitrum`,
`mainnet`, `base`, `sepolia`), and a mistyped action name gets a did-you-mean refusal.
</details>

<details>
<summary><b>Vocabulary: canonical names, synonyms, and retired names</b></summary>

The taxonomy in one line: a **cork-pool** is one expiry of a **market** (the family of pools
over one collateral/reference pair — an *instance* of it, not an AMM pool); a **trading-pair**
is a pair listed for trading on the LOP venue book; the **orderbook** holds that pair's resting
orders; **rollover-orders** are orders whose execution migrates a position to a successor pool.
Accepted synonyms agree with the taxonomy; retired names never silently work — they answer
with their replacement:

| Canonical | Accepted synonyms | Retired names (teach their replacement) |
|---|---|---|
| `cork-pool` / `cork-pools` | `pool`/`pools`, `market-instance`/`market-instances` | `market`, `markets` |
| `derive-cork-pool` | `derive-pool` | `derive-market`, `market-predict` |
| `trading-pairs` | `trading-pair`, `orderbook-pairs` | `limit-order-markets` |
| `orderbook` | `limit-orders` | — |
| `rollover-orders` | `pool-migration-orders`, `extend-expiry-orders` | `flows` |
| `registry-assets` / `-recipes` / `-denominations` / `-feeds` | `registered-*` family, `market-recipes` | — |
| `registry-oracle` | `asset-pair-oracle` | — |
| `rfqs` | `rfq` | — |
| `compute recipe-rate-constraint` | `resolve-rate-constraint` | `resolve-recipe` |
| `decode order` | `decode limit-order` | — |
| `prepare market deploy-oracle` | — | `deploy-wrapper` |
</details>

## Use as a library (TypeScript SDK)

**Getting started guide: [docs/sdk.md](docs/sdk.md)** — first call, the result envelope, the
prepare → simulate → sign → send recipe, and the stability promise.

`@cork/schemas` and `@cork/core` are publish-ready library packages (ESM-only, Node ≥ 22 / Bun,
`sideEffects: false`, types shipped). Until they land on a registry, install from a packed
tarball: `bun pm pack` in each package directory rewrites `workspace:*` to real versions, and
the tarballs npm-install cleanly.

The root export is the full SDK; domain subpaths let you load only the tier you need — a
consumer of the pure math never loads the venue client or an RPC transport:

```ts
// The envelope: the exact same 9-tool contract the MCP server and CLI ship,
// same result envelope ({ state, data, warnings, provenance }), same gates.
import { runTool } from "@cork/core";
const result = await runTool("cork_query", { resource: "cork-pool", filters: { poolId } });
if (result.state === "ok") console.log(result.data);

// Pure, zero-IO math: bit-exact ports, MarketId hashing, CREATE2 derivation.
import { computeMarketId, previewSwap } from "@cork/core/math";

// Order primitives: LOP v4 build/hash/verify, Fusion auctions, rollover EIP-712.
import { buildMakerOrder, hashLopOrder } from "@cork/core/orders";
```

| Subpath | Tier |
|---|---|
| `@cork/core` | Everything below, plus the `runTool` envelope (the covered 9-tool contract). |
| `@cork/core/math` | Pure zero-IO: bit-exact math ports, `MarketId`, CREATE2. |
| `@cork/core/orders` | LOP v4 orders, Fusion auction pricing, rollover ERC-7683, ForSelf builders. |
| `@cork/core/registry` | MarketRegistry 2.1.0 reads, JIT derivation, recipe constraints. |
| `@cork/core/chain` | ABIs, pool/registry state reads, event decode, RPC resolution. |
| `@cork/core/bundle` | Bundler3 action encoders, decode, funding + sweep legs, signer summary. |
| `@cork/core/venue` | The typed venue (api-phoenix) client with cursor pagination. |
| `@cork/core/indexer` | HyperSync/HyperRPC event-archive access for full-decentralized reads. |
| `@cork/core/config` | Deployment config, CREATE2 attestations, implementation + TEE guards. |

The public surface — every export name on the root and each subpath, type exports included — is
pinned by a drift gate (`packages/core/test/api-surface.test.ts`): an accidental addition or
removal fails CI until the fixture is regenerated deliberately. Package shape is audited on
every `bun run verify:publish` with `publint --strict` and `arethetypeswrong` (all entry points
resolve green under node16-ESM and bundler resolution).

## Packages

The monorepo behind the binary:

| Package | What it is |
|---|---|
| `@cork/schemas` | zod v4 single source of truth: hex-typed primitives, the 9-tool registry, `z.toJSONSchema` projection to MCP input schemas. |
| `@cork/core` | Deterministic bit-exact ports of on-chain math (`MathHelper`, `TransferHelper`, `ConstraintRateAdapter._calculateRate`, `PoolLib.preview*`), the committed-descent impairment floor, `MarketId`/CREATE2 derivation, chain reads (viem), the Bundler3 encoder/recursive decoder, and the shared tool dispatch (`runTool`). |
| `@cork/mcp` | MCP server projecting the registry via the low-level `Server` API (advertises JSON Schema directly; avoids the SDK's bundled-zod coupling). Stdio entry `packages/mcp/src/bin.ts` (package bin `cork-mcp`). |
| `@cork/cli` | commander projection of the same registry — one command per tool at its `cliPath`. The `ch` binary compiles this package (plus the embedded MCP server) into one file. |

## How RPC endpoints are resolved

Chain-backed reads pick an endpoint in this order, so the tools "just work" on public chains
while staying overridable:

1. **Explicit** — `CORK_RPC_URL` (env) or `--rpc-url` (CLI). Used verbatim, no probing, no
   fallback.
2. **Built-in default** — a committed endpoint for the chain (Ethereum mainnet, Arbitrum,
   Base). Tried with retries + exponential backoff; a per-endpoint **circuit breaker** stops
   hammering one that's down.
3. **chainlist.org fallback** — for public chains (mainnet, Arbitrum, Base, Sepolia), the tool
   fetches candidate public RPCs just-in-time, latency-probes them in parallel, **verifies each
   reports the right chainId**, and uses the fastest healthy one. The private staging vnet
   (49222) is not on chainlist, so it needs an explicit RPC.

The chosen endpoint and breaker state are cached in-process and on disk
(`~/.cache/cork-helper-cli/`, override with `CORK_RPC_CACHE_FILE`) so repeated calls skip
re-probing. When a read falls back to a community RPC, the result envelope carries an
`rpc_fallback` warning naming the host.

> Note: the built-in default endpoints embed access tokens and are committed intentionally
> (owner decision). This is a deliberate exception to the "never commit an RPC URL" rule, which
> still applies to `CORK_RPC_URL` / `CORK_TEST_RPC` — those stay environment-only.

## Design invariants (RFC 011)

- **One typed core.** MCP, CLI, and SDK are thin projections of the same `runTool` dispatch and
  the same registry — no logic forks between surfaces.
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
- **Release binaries** are double-built: two independent CI builds must be byte-identical, and
  every asset carries a GitHub attestation you can verify (see Install).
- **The container image** is built from the signed apk channel, and its digest carries the same
  GitHub attestation (`gh attestation verify oci://…`, see Install).

## Develop (run from source)

The sources are TypeScript run directly by **[Bun](https://bun.sh)** (Node's native
type-stripping can't run this code — it uses TypeScript parameter properties). Bun 1.3 is
pinned in `mise.toml`.

```sh
git clone git@github.com:Cork-Technology/cork-cli.git
cd cork-cli

mise trust && mise install    # provisions the pinned Bun (install mise: https://mise.jdx.dev)
bun install                   # deps + workspace links

# the CLI from source — bin/ch runs it under the pinned Bun from any directory:
export PATH="$(pwd)/bin:$PATH"
ch capabilities

# the MCP server from source (absolute paths — the subprocess may not inherit your PATH):
claude mcp add cork-defi -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"
```

Prefer not to use mise? Install Bun 1.3+ directly (`curl -fsSL https://bun.sh/install | bash`),
skip the `mise` commands, and run `bun install`.

```sh
bun run typecheck          # tsc --noEmit, strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes)
bun run test               # everything; network-gated suites self-skip without their env vars
bun run test:unit          # offline-only (excludes fork-parity / bundle-sim / rpc-live / hyperrpc-live)
bun run test:live          # just the network-gated suites (each self-skips without its env var)
bun run test:mutation      # semantic mutants vs the offline suite — every one must be caught
bun run verify:publish     # build + package-layout gate + publint --strict + attw

# Empirical fork-parity vs the live vnet fixture (never commit this RPC URL):
CORK_TEST_RPC="https://virtual.mainnet…/REDACTED-VNET" bun run test:live

# Live RPC-resolver smoke (default + chainlist fallback, real network):
CORK_RPC_LIVE=1 CORK_RPC_CACHE_FILE=/tmp/rpc-state.json bun run test:live

# Agent evals (programmatically graded tool-surface quality; needs an API key OR ambient
# gateway auth — fails loud rather than skipping):
bun run eval               # see evals/README.md for grading, env knobs, held-out rule
```

`CORK_TEST_RPC` (vnet fixture) and `CORK_RPC_URL` (endpoint override) are read from the
environment and must never be committed. Without `CORK_TEST_RPC` the fork-parity/bundle-sim
suites self-skip; chain-backed tools still run at request time via the built-in default RPCs +
chainlist fallback.

## Status

Implemented + tested:

- **cork_capabilities** — tool list, `search`, `topic` docs, and `topic: "verify"` (re-derives
  deployed addresses via CREATE2 from prod.toml salt + Sourcify init-code hash).
- **cork_decode** — Bundler3 calldata, recursively, incl. non-Cork legs (erc20/permit2/GeneralAdapter1),
  plus a plain-English `summary` of what those legs do; also LOP orders, single logs, and whole receipts.
- **cork_compute** — rollover-premium-floor (pure); cst-swap-rate / unwind-rate / impairment-floor
  (chain-backed, block-pinnable); recipe-rate-constraint (2.1.0: the `recipe.resolve` staticcall — the step
  that produces the constraint a JIT order carries and signs).
- **cork_prepare_phoenix** — all 13 adapter actions on mainnet **and** Arbitrum; auto-built funding
  legs (erc20-approve / permit2 — always in the same transaction as the action; there is no
  pre-funded mode) for value-in actions and owner==adapter share-burn
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
- **cork_query** — chain reads (cork-pool — one expiry of a market / account-state incl. balances +
  funding allowances for both spenders / pool-whitelist / protocol-config / registry-assets /
  registry-oracle / registry-recipes / registry-denominations / registry-feeds / derive-cork-pool —
  predict a pool's oracle, pool id, constraint, and cST/cPT before it exists); venue-discovered,
  chain-verified reads labeled `provenance.mode: "hybrid"` (cork-pools, orderbook, fills,
  trading-pairs — the LOP pair listings, rollover-orders, rfqs — incl. single-RFQ lookup via
  `filters.rfqId`); an event-derived subset (cork-pools, trading-pairs, fills, rollover
  fills/contracts) also serves `full-decentralized` mode over HyperSync, never the venue.
- **cork_track** — verify (artifact digest, marketRef MarketId re-hash), simulate (eth_call dry-run
  on frozen bytes: `wouldRevert` + reason BEFORE signing), reconcile (txHash receipt, orderHash /
  submissionRef lifecycle vs the settler's on-chain `orderStatus()` — chain outranks indexer [K7]).
- **cork_submit** — the one side-effecting tool: relays caller-signed/authored payloads to the venue
  (`rollover-order`, `lop-order`, `rfq-open`, `rfq-answer`, `rfq-counter`), recomputing commitments
  before relay [K3].

Deliberately gated (`unavailable` with a reason, never faked): only `cork_compute` rfq-quote — a
pricing model deferred by product decision (a Fusion-style decaying-premium order is the
modeled-quote-free alternative). Everything else advertised above is activated, including
`cork_query` whitelisted-addresses enumeration, `cork_compute` dutch-auction-price (pure-local
Fusion v3.1 pricing), `cork_decode` order/event/receipt, `cork_prepare_orders` taker-fill +
finalize-maker-order, and the `cork_prepare_phoenix` authority-onboard / authority-revoke ops.

Roadmap: `account-state` nonce/invalidator state, and Safe support — the latter phased by design
(message-signature and transaction-confirmation are distinct problems, and these tools never
confirm a Safe transaction).
