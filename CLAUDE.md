# CLAUDE.md — cork-helper-cli

Cork Phoenix **MCP server + CLI over one typed core** (RFC 011). MCP and CLI are thin projections of
the same `runTool` dispatch over the same 9-tool registry — no logic forks between surfaces.

## Runtime (non-negotiable)

Run everything with **Bun**, never `node`. The `.ts` sources use TypeScript parameter properties and
`.ts` import specifiers; Node's native type-stripping rejects both (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
Bun 1.3 is pinned in `mise.toml`.

- MCP server (stdio): `bun packages/mcp/src/bin.ts`
- CLI: invoked as **`ch`** (launcher `bin/ch`; put `bin/` on PATH). Long form without PATH setup:
  `bun packages/cli/src/bin.ts <command> …`
  - **Input**, three interchangeable forms: `--json '<object>'` (canonical wire shape, same as MCP) ·
    `--input '<object>'` (identical, unambiguous name) · a positional for the first required scalar
    plus flags named after the schema's own fields (`ch query registry-assets --chainid 42161`).
    Flags override keys in a JSON blob. Spelling is normalised, so `--chainid`, `--chain-id` and
    `--chainId` are one flag; object-valued fields (`--filters`, `--params`) take a JSON string.
  - **Output** is prose by default, JSON on request: a bare `--json`, or `CH_JSON=1`. Passing input as
    `--json '<object>'` also yields JSON, which is why every pre-existing scripted example still works.
  - `--explain` prints the tool's contract — prose by default, JSON Schema under `--json`.
  - `--rpc-url <url>` overrides RPC resolution for chain-backed commands.
- Typecheck / test: `bun run typecheck` · `bun run test` (network suites self-skip without env) ·
  `bun run test:unit` (offline only) · `bun run test:live` (vnet/live suites; need `CORK_TEST_RPC` / `CORK_RPC_LIVE=1`)

## Install / verify as an MCP server

```sh
mise trust && mise install                                                               # fresh checkout: trust mise.toml + install pinned Bun
bun install                                                                              # from repo root, once
claude mcp add cork-defi -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"        # recommended (incl. live chain reads via built-in RPCs)
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
| `cork_query` | **State reads** — live chain: market, account-state, pool-whitelist, protocol-config, registry-assets/registry-oracle/registry-recipes (MarketRegistry views, 42161), market-predict (derive a market that may not exist yet — predicted oracle+live rate, LOCAL pool id, parity-checked resolved bands, cST/cPT via eth_simulateV1, and pool existence; needs `filters.collateralAsset+referenceAsset+expiry+mode`; the derivation a JIT LOP fill runs, chain-native, 42161). Venue-backed (centralized): markets, orderbook, fills, limit-order-markets, flows (rollover orders/fills/contracts via `filters.kind`), rfqs (RFQ discovery feed, default `state=open`; `filters.rfqId` for one record with all answers; `withAnswers` embeds answers in the list). Event-derived: whitelisted-addresses (CURRENT whitelist membership replayed from WhitelistManager events over HyperSync, needs ENVIO token; rows live-view verified when an RPC resolves; `filters.poolId` scopes to one pool, global rows ride along); the markets/fills/flows subset also serves `full-decentralized` mode (HyperSync). Venue lists are **bounded traversals**: `data.pagination.{complete,pagesFetched,nextCursor,reason}`; a partial read is `ok`+`pagination_incomplete` (evidence, not the full set), a repeated venue cursor is `conflict`. `cursor`/`pageSize`/`maxPages` control it. | 1 |
| `cork_compute` | **Deterministic math** over verified state — swap/unwind rate, rollover premium floor, worst-case impairment floor, resolve-recipe (registry band resolution, bit-parity self-checked on-chain), dutch-auction-price (1inch Fusion v3.1 current price, pure local from the order's own extension bytes [K3]; pin with `at.timestamp`, `baseFeeWei` omitted = upper bound). NOT raw reads, NOT byte-building. | 1 |
| `cork_decode` | Bytes → labeled JSON, all four kinds live: calldata (recursively unwraps Bundler3 multicall), order (LOP v4 hex tuple or JSON fields → makerTraits breakdown + recomputed orderHash; supplied hash/extension cross-checked → `conflict` on mismatch), event (one log → named args against the source-verified ABI set; unverified layouts labeled raw), receipt (every log labeled). Reconstructs from bytes; never trusts a supplied parse [K3]. | 1 |
| `cork_prepare_phoenix` | Build an **unsigned** Bundler3 bundle for any of the 13 adapter actions. Auto-adds funding legs. Also the token-authority ops: authority-onboard/authority-revoke build an unsigned DIRECT ERC-20 approve tx (onboard amount omitted = unlimited; revoke zeroes it) — owner-signed, not a bundle leg. Returns bytes for later signing — executes nothing [K1]. | 2 |
| `cork_prepare_orders` | Build **unsigned** signable artifacts: 1inch maker-order (incl. extension/JIT orders) / cancel; **finalize-maker-order** (recover the external signer, reconstruct exact bytes, emit a verbatim `cork_submit` artifact — never signs); **taker-fill** (fetch + locally re-hash a resting venue order, emit canonical uint256-tuple fill calldata, unsigned); and the rollover ERC-7683 OrderData (CorkSettler domain, intent hash recomputed locally). | 3 |
| `cork_track` | Verify a resource against chain, simulate frozen prepared bytes (eth_call dry-run: wouldRevert + reason BEFORE signing), or reconcile a receipt/order to a lifecycle state. Chain outranks indexer; disagreement → `conflict` [K7]. | 2 |
| `cork_prepare_market` | Unsigned MarketRegistry.deploy(ca, ref) tx (permissionless, idempotent oracle deploy; Arbitrum). Q-REG closed 2026-07-22. Markets themselves are created JIT by LOP fills — `cork_prepare_orders` maker-order + `jitMarket`. | 4 |
| `cork_submit` | The **only** side-effecting tool: relays caller-signed/authored payloads to the venue — actions `rollover-order`, `lop-order`, `rfq-open`, `rfq-answer` (all off-chain POSTs). Commitments recomputed before relay [K3]; never signs [K1]. | 3 |

## Reading the result envelope

Every tool returns `{ state, data, warnings[], provenance, schemaVersion }` — over MCP this arrives
as `structuredContent`, and every tool advertises this envelope as its `outputSchema`. **Check
`state` before trusting `data`:**

- `ok` — use `data`.
- `unavailable` — honestly not servable right now; `warnings[0].code` says why (table below). **Do not
  retry the same call** and do not fabricate the answer — report the reason. Exactly ONE variant
  remains gated by design: `cork_compute` rfq-quote (a pricing MODEL, deliberately deferred as a
  product decision; a Fusion-style decaying-premium order is the modeled-quote-free alternative —
  notes/fusion-integration-plan.md). dutch-auction-price was activated 2026-07-28 (pure local
  Fusion v3.1 pricing, wei-exact vs the deployed settlement getters); whitelisted-addresses,
  decode order/event/receipt, and the prepare_phoenix authority ops were activated 2026-07-27.
- `conflict` — the tool executed and found a mismatch (e.g. `digest_mismatch`, `marketid_mismatch`);
  surface it, don't paper over it. On MCP, `conflict` is NOT an error result; `unavailable` is.

Warning codes you will encounter:

| Code | Meaning / what to do |
|---|---|
| `requires_rpc` | No RPC resolved (offline, or a chain outside defaults+fallback like vnet 49222). Set `CORK_RPC_URL`. |
| `unknown_deployment` | No (or partial) Cork deployment config for this chainId — e.g. tx-path building or pool-whitelist on Arbitrum. Not fixable by adding an RPC. |
| `chain_read_failed` | The RPC answered but the read reverted/failed — most often a pool that doesn't exist on that chain (e.g. a vnet-only fixture pool queried against real mainnet). Check the poolId/chainId pairing. |
| `pool_not_found` | prepare_phoenix funding: `market(poolId)` returned a zeroed struct — the pool doesn't exist on that chain, so no funding legs are built. |
| `invalid_input` / `internal_error` | MCP-only, in the error envelope when a call fails before/outside a handler (bad input, unexpected exception). CLI equivalents are exit 2 / exit 1. |
| `needs_indexer` / `needs_service` | Backend (indexer / orderbook / rollover service) not wired yet. |
| `phase_gated` | The one deliberately-gated `cork_compute` kind (rfq-quote: pricing model deferred — the message names the blocker and unblock condition). Also returned by dutch-auction-price for LEGACY Fusion layouts (v2/v1, superseded May 2025 — only v3.1 is implemented). |
| `missing_filter` | The resource needs `filters.poolId` / `filters.account`. |
| `mode_unavailable` | An explicitly requested data mode (`centralized`/`full-decentralized`) isn't wired yet — omit `mode` or use `lite-decentralized`. |
| `unknown_topic` / `no_lop` | Capabilities topic not found / no 1inch LOP deployment for the chain. |
| `receipt_not_found` | txHash unknown/pending at the RPC (a normal outcome, not a failure). |
| `rpc_fallback` | Informational on `ok`: the default RPC was down, a chainlist public endpoint served the read. |
| `funding_needs_rpc` / `manual_funding` / `owner_managed_funding` | Informational on `ok` prepare results: why funding legs were omitted. |
| `recipe_not_found` | Registry recipe mode unknown — modes are EXACT case-sensitive strings; the message lists the live modes. |
| `oracle_already_deployed` / `oracle_not_deployable` | Informational on prepare_market: the pair's oracle exists (tx is a safe idempotent no-op) / the deploy simulation reverted (unregistered asset or missing feed — sending would revert). `oracle_not_deployable` is also returned by `cork_query market-predict` (ok, oracle-only) when the pair can't get an oracle. |
| `oracle_not_deployed` | Informational on `cork_query market-predict`: the pair's oracle is deployable but not yet deployed — without a live rate the pool id and cST/cPT can't be derived; only the predicted oracle address is returned. Deploy it first (`cork_prepare_market deploy-wrapper`), then re-run. |
| `rate_drift_notice` | Informational on JIT prepares AND `cork_query market-predict` when the pool doesn't exist yet: market identity follows the LIVE oracle rate; the derived pool id / cST / cPT are rate-conditioned and drift stepwise until the pool is created (then pinned). A drifted rate reverts a fill OrderNotForPool (deliberate staleness guard). |
| `jit_side_mismatch` | JIT prepare: NEITHER order side is the derived pool's cST — the fill WILL revert; set maker/takerAsset to the predicted cST in the result. |
| `roles_not_granted` / `adapter_binding_mismatch` | JIT adapter pre-flight: controller roles missing (signable but unfillable) / the volatile adapter address's on-chain bindings disagree with config (conflict — refresh cork-defaults.json). |
| `would_revert` | Informational on `ok` simulate results: the frozen bytes revert at current state (reason included) — do not sign/broadcast as-is. |
| `share_prediction_unavailable` | JIT prepare: eth_simulateV1 unsupported — predicted cST unknown; verify the order side + permit token yourself. |
| `band_parity_mismatch` | On `conflict` (resolve-recipe): local applyBands port disagreed with the chain view — trust the chain, report the bug. |
| `pool_expired` | Informational on `ok` prepare_phoenix results: a pre-expiry action (deposit/swap/…) against an expired pool — the bundle builds but would revert on-chain; withdraw/withdraw-other/redeem are the post-expiry paths. |
| `digest_mismatch` / `marketid_mismatch` / `create2_mismatch` | On `conflict`: what failed verification. For `cork_submit rollover-order`, `digest_mismatch` means the payload's intent does not hash to its own `rolloverIntentHash` (not relayed) or the venue computed a different orderDigest. |
| `venue_rejected` / `venue_unreachable` / `venue_rate_limited` | The venue (api-phoenix) refused (4xx; HTTP status + message) / couldn't be reached OR answered 5xx (transient — retry; check `CORK_VENUE_URL`) / rate-limited (per-user open-order caps). |
| `venue_conflict` | On `conflict`: venue 409 — same id/digest already stored with a DIFFERENT payload. Use a fresh `clientRequestId` for a genuinely new request. |
| `order_not_found` | Reconcile/lookup: the digest is unknown to the venue — a normal outcome for a never-posted order. Also `cork_prepare_orders` taker-fill when the orderHash is absent from a COMPLETE orderbook traversal. |
| `pagination_incomplete` | A bounded traversal did not exhaust the set — venue lists (`reason`: `metadata_absent`/`cursor_absent`/`max_pages`, with a `nextCursor` to resume), HyperSync scans that hit the page bound, registry getAssets/getRecipes truncation, and track-reconcile book/fills walks. On `ok` it's honest partial evidence; on `conflict` it's `cursor_repeated` (venue self-contradiction) or an incomplete search that would otherwise claim "not found" (taker-fill, reconcile). |
| `unsigned_artifact` | Informational on `ok` taker-fill: unsigned fill calldata only — simulate (`cork_track` simulate) and set the taker-asset allowance before signing/broadcasting. |
| `caller_signed_artifact` | Informational on `ok` finalize-maker-order: the signature was recovered/verified, not created [K1]; pass `submitInput` verbatim to `cork_submit` after your policy gate admits the `signedArtifactDigest`. |
| `signature_or_reconstruction_mismatch` / `prepared_context_mismatch` | On `conflict`: the signature doesn't recover to the order's maker/user against the locally recomputed hash — raised by finalize-maker-order AND by `cork_submit` lop-order (EOA makers) and rollover-order, which now recover every signature before relaying [K3] / the reconstruction doesn't match the prepared hash / salt↔extension unbound — OR the prepared clientRequestId·chainId·verifyingContract disagrees with the request. Not relayable. |
| `invalid_service_response` | taker-fill: the venue row for the requested order failed shape validation (malformed signed order) — no fill bytes built. |
| `rfq_not_found` | `cork_query rfqs` with `filters.rfqId`: the id is unknown to the venue — a normal outcome for a never-posted or mistyped id. |
| `asset_not_found` | `cork_query registry-assets` with `filters.address`: the address is not a registry-approved asset on that chain. |
| `settler_mode_mismatch` | rollover-intent: the chosen settler's on-chain mode gate would make the order unfillable (ExactSettler rejects `allowPartialFills:true`; PartialSettler requires it). The message names the right settler. |
| `settler_not_recognized` / `invalid_order_terms` | Informational: settler isn't a configured Cork settler — also used by dutch-auction-price when the Fusion settlement decoded from the extension isn't in the known set (priced as v3.1, verify independently) / order terms are incoherent (venue would reject). `invalid_order_terms` also covers a JIT maker-order fee above the 5% cap and a structurally-non-Fusion order handed to dutch-auction-price (well-formed values that break a protocol rule → envelope, exit 3, not thrown). |
| `invalid_pair` | On `unavailable` (`cork_query market-predict`): collateralAsset and referenceAsset are equal — a market is a pair of distinct assets. A domain-rule violation returned as an envelope (exit 3), not a thrown schema error. |
| `status_mismatch` | On `conflict` (track reconcile): the venue's lifecycle disagrees with the settler's on-chain `orderStatus()` — chain outranks indexer [K7]. |
| `venue_reported` / `logs_unavailable` / `logs_range_limited` | Track verification gaps, disclosed: no RPC for the status leg / no logs endpoint (set `ENVIO_API_TOKEN` or `CORK_LOGS_RPC_URL`) / the logs endpoint refused the historical range. |
| `hypersync_unavailable` | full-decentralized mode: no HyperSync token, unsupported chain, or the napi client can't load on this host. Envio env vars: `ENVIO_HYPERSYNC_TOKEN` (query API) and `ENVIO_HYPERRPC_TOKEN` (logs RPC) with `ENVIO_API_TOKEN` as shared fallback for both — tokens verified interchangeable across products in practice, so one shared token also works. |
| `premium_scale_suspect` / `premium_scale_mismatch` | Numbers-contract tripwires (fraction "0.041" vs percent 4.1): suspicious sub-0.1% premium (warned, relayed) / >=100x divergence from the cited quote_ref, decided in EXACT integer arithmetic (conflict, NOT relayed). |
| `quote_ref_unverifiable` | On `conflict` (`cork_submit lop-order`): the cited RFQ option has no parsable positive premium, so the scale cross-check cannot run — NOT relayed (cite a valid option or drop quoteRef). |
| `listing_traits_mismatch` | On `conflict` (`cork_submit lop-order`): the venue-listing fields (expiry/nonce/allowsPartialFills) contradict what the SIGNED makerTraits encode — derived from the signature, never trusted [K3]; NOT relayed. |
| `invalid_state` | A LOCAL computation/domain failure (C11), distinct from `chain_read_failed`: the on-chain state or derived values violate a domain rule the port enforces (e.g. a 100% rateMin band). Also informational on `ok` impairment-floor when the worst rate collapses to 0 (maxReferencePerCst null = unbounded). |
| `reserved_field_ignored` | Informational on `ok`: an accepted-but-reserved field was validated and then ignored — results are NOT pinned by it. `cork_compute at.timestamp` is reserved for the BLOCK-anchored kinds only; dutch-auction-price HONORS it (a decaying price is clock-anchored). |
| `expiry_far_future` | Informational on JIT maker-order prepares: `jitMarket.expiryTimestamp` is >5 years out — the chain enforces NO upper bound and cPT principal stays locked until expiry; double-check intent. |

CLI exit codes mirror state for scripting: `0` ok · `2` invalid input (schema or malformed
`filters.*`) · `3` unavailable · `4` conflict · `1` unexpected error. Validation split: only
unparseable/format faults throw (exit 2); a well-formed input that breaks a domain rule (equal
ca/ref, a fee over the 5% cap, incoherent order terms) returns an `unavailable` envelope (exit 3).

Money/rate outputs are unit-labeled: `cork_compute` cst-swap-rate/unwind-rate/impairment-floor
responses carry a `scales` block plus `collateralDecimals`/`referenceDecimals` (mirroring
resolve-recipe's convention) — read the labels, don't assume 18 decimals. Envelope
`provenance.digest` / `signedArtifactDigest` are OPAQUE content tags (keccak over key-order-
sensitive JSON): compare only digests produced by this tool; don't recompute them from
re-serialized JSON. Absolute-timestamp inputs (`UnixSeconds` fields and market-predict
`filters.expiry`) are bounded to year 2100 — a `Date.now()` milliseconds paste is rejected with
teaching instead of creating a far-future deadline.

Field-naming conventions, uniform across every read: the two share tokens are always
`corkSwapToken` (cST) and `corkPrincipalToken` (cPT) everywhere; the pair's rate-oracle wrapper is
reported under one nested `oracle` object (`.address`/`.deployed`/`.deployable`, plus `.rate` on
market-predict) by `registry-oracle`, `market-predict`, and `cork_prepare_market` alike — the Market
struct's `rateOracle` field is that same contract; `cork_query` always echoes `resource`; every
chain-backed read includes `chainId` in `data` next to its on-chain values (also in
`provenance.chainId`). Provenance is single-chain for now; a per-chain map is planned for later
cross-chain reads.

Every tool's input takes an optional `format`: `"concise"` (default) or `"full"`. `"full"` adds
`provenance.rpc = { source: explicit|default|chainlist, host }` on chain-backed reads. Every backed
result states its data mode: `provenance.mode = "lite-decentralized"` (RPC chain reads),
`"centralized"` (venue-backed reads/writes via api-phoenix, override base with `CORK_VENUE_URL`), or
`"full-decentralized"` (HyperSync event scans, needs `ENVIO_API_TOKEN`). `cork_query mode` is honored
explicitly, never silently substituted: venue-only resources reject decentralized modes (resting
orders/RFQs emit no events — structural, not a phase gap), chain resources reject `centralized`,
and the event-derived subset (markets, fills, flows kind=fills|contracts) serves
`full-decentralized`. `cork_query` `cursor`/`pageSize`/`maxPages` are now honored (bounded venue
traversal). Some schema fields remain accepted-but-reserved (`cork_compute` `at.timestamp`,
`cork_prepare_phoenix` `account`) — passing them is harmless; don't expect them to change behavior.

Retry semantics [K2]: prepare bundles default to a relative deadline (`deadlineSeconds`, re-anchors
to the clock, so a later retry produces different bytes); pass an absolute `deadlineAt` (unix
seconds) to make same-`clientRequestId` retries **byte-identical**. `cork_query
resource:"account-state"` returns balances AND funding allowances per pool token for both spenders
(corkAdapter for `erc20-approve` mode, canonical Permit2 for `permit2` mode) — plus
`permit2Internal` (amount + uint48 expiration), the Permit2-INTERNAL (user, token, spender=adapter)
allowance the permit2 funding leg actually consumes: both layers must be in place or the bundle
reverts.

## RPC resolution (chain-backed tools work by default)

Chain reads pick an endpoint automatically: **explicit** (`CORK_RPC_URL` / `--rpc-url`; its
`eth_chainId` is verified once per process — an endpoint answering with the WRONG chain is refused
as teachable invalid input; an unreachable one is still used verbatim)
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

Per-chain deployment coverage: chainId 1 and chainId 42161 are both **full** (all 5 contracts;
prepare + all reads). The 42161 set was announced 2026-07-22 and its bindings verified on-chain
(adapter `CORK()` = poolManager, adapter `BUNDLER3()` = bundler3, both settlers'
`CORK_POOL_MANAGER()` = poolManager). The pre-launch Arbitrum pair (old PM `0xc2De…54AE` with 3
non-API-listed calibration pools) survives as `deploymentProfiles["42161"]["arbitrum-legacy"]`. A real mainnet pool for examples/tests:
`0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05` (current list:
`api-phoenix.cork.tech/v1/pools/`). The vnet fixture pool `0xceeb…c16a` exists ONLY on the vnet —
querying it on chainId 1 without a vnet RPC yields `chain_read_failed`, by design.

## Invariants that constrain how you use the tools

- **Prepare ≠ sign ≠ submit** [K1]. `cork_prepare_*` return unsigned bytes/typed-data. Nothing is
  signed or broadcast except `cork_submit`, which only relays a payload the caller already signed.
- **Idempotency** [K2]. `cork_prepare_*` and `cork_submit` take a `clientRequestId` — reuse the same id
  when retrying the same request; use a fresh id for a genuinely new request. Prepared artifacts are
  deterministic for identical inputs + observed state + clock; deadline/expiry fields are
  **wall-clock + duration** (owner ruling 2026-07-20), so bytes re-anchor in time on a later retry —
  pin `ctx.nowSeconds` (or `at.block` for reads) when you need bit-identical replay.
- **Never commit an RPC URL** — `CORK_RPC_URL` / `CORK_TEST_RPC` come from the environment only. The
  two built-in default endpoints (mainnet/Arbitrum, in `chain/rpc.ts`) are a deliberate committed
  exception (owner decision); don't add more committed endpoints.
- **Math is bit-exact and empirically verified** against live on-chain reads (wei-for-wei). Trust the
  tool's numbers over hand-derived ones.

## Address config: remote-first with a bundled fallback

Deployment addresses are NOT hardcoded in source. `cork-defaults.json` (repo root) is the canonical
address file; `packages/core/src/config-remote.ts` resolves it **remote-first**: fetch the latest
from the GitHub repo (raw.githubusercontent.com, override `CORK_DEFAULTS_URL`) → validate with a
strict zod schema (tampered/unexpected content is rejected) → cache to disk with a 1 h TTL
(`~/.cache/cork-helper-cli/cork-defaults.json`, override `CORK_CONFIG_CACHE_FILE`). Fallback
semantics distinguish two negative outcomes: **HTTP 404/410** means the file is not published at
the canonical URL (private repo / commit not pushed) — a deliberate state, so the **bundled copy is
served silently**; a **transient failure** (network, 5xx, invalid content) serves the bundled copy
with a one-line `config_fetch_failed` warning ("addresses may be stale…"). Either negative outcome
is negative-cached on disk for 10 min, so fresh CLI processes don't re-attempt the fetch on every
invocation. `CORK_CONFIG_NO_FETCH=1` skips fetching entirely (tests set this via
`vitest.config.ts`). Never hand-edit addresses in TS — edit `cork-defaults.json`.

## Discoverability: examples, maturity, teaching errors

- **Worked examples** live in `packages/schemas/src/examples.ts` (`TOOL_EXAMPLES`, all validated by
  tests) — every tool description advertises one inline, and `cork_capabilities` search/topic return
  the full set. The demo poolId/account there are the canonical fixture values; the Foundry script
  `experiments/fork-harness/script/DeployDemoPool.s.sol` deploys that pool on a Tenderly virtual
  mainnet via timelock impersonation (`--unlocked --sender 0x7CcC…89D9`).
- **Maturity** (`MATURITY` map, same file): per-tool + per-variant `activated | implemented |
  specified` with a reason code — surfaced through `cork_capabilities`, matching its "maturity map"
  contract. Gated variants say so in the tool description.
- **Teaching errors** (`packages/schemas/src/teaching.ts`): schema failures return structured
  issues (`path`/`expected`/`received`), a levenshtein "did you mean …?" suggestion, remediation
  text, and a corrected example that itself validates — on MCP in the error envelope, on CLI as
  JSON on stderr.

## Evals gate the tool surface

`evals/README.md` is the contract. Layer A (always-on vitest): example/teaching/maturity tests plus
the **surface-drift gate** (`packages/mcp/test/surface-drift.test.ts`) — any change to advertised
names/descriptions/schemas fails CI until the fixture is deliberately regenerated
(`UPDATE_SURFACE=1`). Layer B (`bun run eval`, needs an Anthropic key; self-skips otherwise): a
fresh agent gets only the 9 tool definitions and must complete ~20 tasks against a stubbed chain;
graded programmatically on tool selection, parameter accuracy, outcome state, efficiency, and
error recovery. **Never tune descriptions/examples against the 5 held-out tasks.** Workflow for a
surface change: edit → run Layer B → regenerate the drift fixture.

## Layout

`packages/schemas` (zod v4 source of truth + registry, examples/maturity/teaching) · `packages/core`
(math ports, chain reads, Bundler3 encode/decode, remote config, `runTool` dispatch) · `packages/mcp`
(stdio server) · `packages/cli` (commander projection) · `evals/` (agent-eval suite). Tests:
`packages/core/test/` (unit + `fork-parity`/`bundle-sim` vnet suites), `packages/mcp/test/`
(integration + surface-drift gate), `packages/schemas/test/`.
