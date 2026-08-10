# CLAUDE.md — cork-helper-cli

Cork Phoenix **MCP server + CLI over one typed core** (RFC 011). MCP and CLI are thin projections of
the same `runTool` dispatch over the same 9-tool registry — no logic forks between surfaces.

## Runtime (non-negotiable)

Run everything with **Bun**, never `node` (sources use TS parameter properties + `.ts` import
specifiers; Node's type-stripping rejects both). Bun 1.3 pinned in `mise.toml`.

- MCP server (stdio): `bun packages/mcp/src/bin.ts`
- CLI: invoked as **`ch`** (launcher `bin/ch`; put `bin/` on PATH). Long form:
  `bun packages/cli/src/bin.ts <command> …`
  - **Input**, three interchangeable forms: `--json '<object>'` (canonical wire shape, same as MCP) ·
    `--input '<object>'` (identical) · a positional for the first required scalar plus flags named
    after the schema's own fields (`ch query registry-assets --chain-id 42161`). Flags override keys
    in a JSON blob. Spelling normalised (`--chainid`/`--chain-id`/`--chainId` are one flag);
    object-valued fields (`--filters`, `--params`) take a JSON string. Flag typing is schema-judged
    ($refs resolved): $ref'd string fields are plain flags, union-typed fields accept a raw string
    when JSON parsing fails, object-ONLY fields reject non-JSON loud (`invalid_json`) —
    mutation-probed (`cli-*` probes), positionals pinned by test. Every discriminated action/kind is
    ALSO a subcommand with the variant's fields flattened to flags and a variant-scoped
    --help/--explain (`ch prepare pool exercise --pool-id … --cst-shares-in 1000e18` — English
    order works: positional-then-variant is shuffled internally; parent options after the variant
    merge back). The discriminator always comes from the subcommand name (a blob cannot override
    it); a blob given WITH a variant subcommand merges as the base (variant flags override); a
    mistyped action gets a levenshtein did-you-mean refusal pre-parse. Amount fields (digits-only)
    take exact sugar on FLAGS only: `1000e18`/`1_000` expand via integer math, fractional
    remainders refused (`invalid_amount`); blobs stay wire-exact. `--chain-id` also takes network
    names (mainnet/ethereum/arbitrum/base/sepolia). Help displays kebab spellings. The 13 pool
    actions + `fill` are ALSO top-level verbs (`ch exercise …` = `ch prepare pool exercise …`,
    `ch fill …` = `ch prepare order taker-fill …`; authority ops stay namespaced). On `ch query`,
    every KNOWN_FILTER_KEYS key is a first-class flag merging INTO `filters` (`--pool-id`,
    `--rfq-id`, `--status` …; flags override the blob; a colliding key rides under an alias —
    `--oracle-mode` is `filters.mode`, bare `--mode` stays the data-backend selector). Resource
    shorthands (taxonomy-agreeing only): `rfq`→rfqs; `pool`/`pools` + `market-instance(s)` (a pool
    is an INSTANCE of a market)→cork-pool(s); `derive-pool`→derive-cork-pool; `trading-pair` +
    `orderbook-pairs`→trading-pairs; `limit-orders`→orderbook;
    `pool-migration-orders`/`extend-expiry-orders`→rollover-orders; the `registered-*` family +
    `market-recipes`→registry-assets/-recipes/-denominations/-feeds; `asset-pair-oracle`→
    registry-oracle (a status lookup, not a table). On `ch decode`, `limit-order`→the `order` kind;
    on `ch compute`, `resolve-rate-constraint`→recipe-rate-constraint (VARIANT_ALIASES). PRE-RENAME
    values (`market`/`markets`/`derive-market`/`limit-order-markets`/`market-predict`/
    `deploy-wrapper`/`flows`/`resolve-recipe`) are deliberately NOT aliases anywhere — they fall
    through to the wire schema and get a renamed-to teaching error via RENAMED_VALUES in
    teaching.ts. All mutation-probed.
  - **Output** is prose by default, JSON on request: bare `--json`, `CORK_JSON=1`, or input passed
    as `--json '<object>'`. Renderer: `packages/cli/src/render.ts`.
  - `--explain` prints a plain-English contract ($refs resolved, variants unfolded) and exits; JSON
    schema via `--json` or `CORK_EXPLAIN_JSON=1` (`packages/cli/src/explain.ts`).
  - `--rpc-url <url>` overrides RPC resolution for chain-backed commands.
- Typecheck / test: `bun run typecheck` · `bun run test` (network suites self-skip) ·
  `bun run test:unit` (offline) · `bun run test:live` (vnet/live; needs `CORK_TEST_RPC` /
  `CORK_RPC_LIVE=1`) · `bun run test:mutation` (scripts/mutation-probes.ts: applies catalogued
  semantic mutants to bytes-critical core logic — struct/tuple field order, enum ordinals, bit
  flags, hash inputs, rounding, comparators, storage-slot math — FAILS unless the offline suite
  catches every one; also fails on pattern rot. Surviving mutant: write a killer test, keep the
  probe) · `bun run test:prop` (pinned-seed fast-check under experiments/proptest — CI-gated in the
  private tree, loud-skipped in the public port; assert only mathematically arguable properties).

## Install / verify as an MCP server

Repo: `github.com/Cork-Technology/cork-cli` — the **public tree**: this repo with `notes/`,
`experiments/`, `rfc/` filtered out and `CORK_DEFAULTS_URL` repointed; work lands here first and is
ported there. From the clone root:

```sh
mise trust && mise install
bun install
claude mcp add cork-defi -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"
claude mcp add cork-defi -e CORK_RPC_URL=<url> -- "$(mise which bun)" "$(pwd)/packages/mcp/src/bin.ts"  # override built-in RPCs
claude mcp list          # expect: cork-defi … ✔ Connected
```

Use the **absolute** `bun` path — the server subprocess may not inherit the shell `PATH`. The two
variants share one name (`claude mcp remove cork-defi` to switch). Never pair `-s project` with
`-e CORK_RPC_URL` — the RPC URL must not enter git. Health check: `cork_capabilities` with no args
returns exactly **9 tools**; anything else means the stdio server failed to launch.

## The 9 tools — pick by intent

| Tool | Use when | Phase |
|---|---|---|
| `cork_capabilities` | Discover/introspect: list tools, `search` by keyword, `topic` for docs, `topic:"verify"` re-derives deployed addresses via CREATE2. Doc topics resolve before tool names: `topic:"signing"` (aliases `execute`/`broadcast`/`sign-and-broadcast`) is the sign-and-broadcast guide — one constant (`DOC_TOPICS`, packages/schemas) feeds the MCP `instructions` string, the HTTP `/docs/signing` page, and `search` ranking. Start here when unsure. | 1 |
| `cork_query` | **State reads** (taxonomy: a cork-pool is ONE EXPIRY of a market — the family of pools over one (collateralAsset, referenceAsset) pair; a trading-pair is a tradable LOP pair listing). Live chain: cork-pool, account-state, pool-whitelist, protocol-config, the registry-assets/-oracle/-recipes/-denominations/-feeds 2.1.0 views (see MarketRegistry section; oracles mode-keyed price\|nav per pair PLUS fixed-rate keyed on `filters.rate`; denominations exact-bytes labels, labelHash the identity; feeds directed conversion edges with live answers), derive-cork-pool (derive ONE pool, expiry included, before it exists — recipe + off-chain constraint via recipe.resolve, LOCAL pool id, cST/cPT via state-override simulation, existence; needs `filters.collateralAsset+referenceAsset+expiry+recipe`; the derivation a JIT fill runs; identity PINNED once an order carrying the constraint is signed). Venue-backed (centralized): cork-pools, orderbook, fills, trading-pairs, flows (`filters.kind`), rfqs (default `state=open`; `filters.rfqId` for one record; `withAnswers` embeds answers). Event-derived: whitelisted-addresses (CURRENT membership replayed from WhitelistManager events over HyperSync, needs ENVIO token; `filters.poolId` scopes); cork-pools/fills/flows also serve `full-decentralized` (HyperSync) with a recent RPC event tail merged past the archive head (`data.liveTail`). Venue lists are **bounded traversals**: `data.pagination.{complete,pagesFetched,nextCursor,reason}`; partial = `ok`+`pagination_incomplete`, repeated cursor = `conflict`; `cursor`/`pageSize`/`maxPages` control it. | 1 |
| `cork_compute` | **Deterministic math** over verified state — swap/unwind rate, rollover premium floor, worst-case impairment floor, recipe-rate-constraint (a staticcall to `recipe.resolve` — THE step producing the constraint a JIT order carries and signs; needs recipe+ca+ref, optional args/rate/rateOracle; pre-2.1.0 band math survives behind `legacy:true` + the deprecation gate), dutch-auction-price (Fusion v3.1 current price, pure local from the order's own extension bytes [K3]; pin with `at.timestamp`; `baseFeeWei` omitted = upper bound). NOT raw reads, NOT byte-building. | 1 |
| `cork_decode` | Bytes → labeled JSON, five kinds: calldata (recursively unwraps Bundler3 multicall); **tx** (a SIGNED raw transaction — the validate-before-broadcast step: recovered signer, to/value/chainId/nonce/gas, target named against known Cork deployments, inner calldata decoded to labeled legs + summary; see `unknown_target`/`chainid_mismatch`); order (LOP v4 hex tuple or JSON fields → makerTraits breakdown + recomputed orderHash; supplied hash/extension cross-checked → `conflict` on mismatch; a Fusion auction extension gets a `fusion` label and a Cork JIT extension a `jit` label unpacking what a fill commits to — adapter, recipe + carried constraint, permit count; both can appear on a composed order); event (one log → named args against the source-verified ABI set; unverified layouts labeled raw); receipt (every log labeled). Reconstructs from bytes; never trusts a supplied parse [K3]. | 1 |
| `cork_prepare_phoenix` | Build an **unsigned** Bundler3 bundle for any of the 13 adapter actions (auto funding legs), plus authority-onboard/-revoke: an unsigned DIRECT ERC-20 approve tx (onboard amount omitted = unlimited; revoke zeroes) — owner-signed, not a bundle leg. Returns bytes for later signing, executes nothing [K1]. `forSelf: { adapter }` emits a DIRECT call to an integrator-deployed Cork ForSelf adapter (the *ForSelf twin, e.g. exercise → exerciseForSelf; Cork-Technology/cork-periphery): no Bundler3, no funding/sweep legs, receiver/owner must equal `account`, allowances to the adapter — for parameter-blind session-key wallets (the Zyfai shape; see `for_self_artifact`). Results carry `data.execution`. | 2 |
| `cork_prepare_orders` | Build **unsigned** signable artifacts: maker-order (incl. extension/JIT orders, and `auction` — a Cork-native DECAYING-PREMIUM order using the deployed Fusion settlement as a pure amount getter: no postInteraction, fills stay permissionless, the signed takingAmount is the floor; composes with jitMarket in one salt-bound extension) / cancel; **finalize-maker-order** (reconstruct exact bytes, verify the external signature — EOA via ecrecover, contract makers via the same ERC-1271 staticcall the fill performs — and emit a verbatim `cork_submit` artifact carrying `makerAccountType`; never signs); **taker-fill** (fetch + locally re-hash a resting venue order, emit canonical uint256-tuple fill calldata, unsigned; an AUCTION row is auto-detected and the default slippage cap becomes the curve's CEILING — a floor-based cap would revert TakingAmountTooHigh through the decay window — with current/ceiling/floor in `data.auction`; `interaction` packs a TAKER interaction — `adapter ++ extraData`, length at takerTraits bits 200-223 — how an underwriter lifts a BUY-cover order, the JIT adapter minting the cST between the maker asset moving and the taker asset being pulled; `forSelf: { adapter, poolId }` instead emits fillOrderForSelf — target structurally forced to the caller, taker interactions impossible, allowance to the ADAPTER — with a liveness pre-flight refusing dead rows [K7]); and the rollover ERC-7683 OrderData (CorkSettler domain, intent hash recomputed locally). All but finalize-maker-order carry `data.execution`. | 3 |
| `cork_track` | Verify a resource against chain, simulate frozen prepared bytes (eth_call dry-run: wouldRevert + reason BEFORE signing), or reconcile a receipt/order to a lifecycle state. Chain outranks indexer; disagreement → `conflict` [K7]. | 2 |
| `cork_prepare_market` | Unsigned oracle-infrastructure txs against the 2.1.0 registry: deploy-oracle = MarketRegistry.deploy(ca, ref, mode) (mode-keyed price\|nav, default price) and deploy-fixed-oracle = deployFixedRateOracle(rate) (keyed on the RATE, CREATE2-salted — the oracle a FIXED order's rateOverride produces). Both permissionless + idempotent; 42161 + 8453. Markets themselves are created JIT by LOP fills — maker-order + `jitMarket`. Results carry `data.execution`. | 4 |
| `cork_submit` | The **only** side-effecting tool: relays caller-signed/authored payloads to the venue — `rollover-order`, `lop-order`, `rfq-open`, `rfq-answer` (all off-chain POSTs). Commitments recomputed before relay [K3]; never signs [K1]. | 3 |

## Reading the result envelope

Every tool returns `{ state, data, warnings[], provenance, schemaVersion }` — over MCP as
`structuredContent`, advertised as `outputSchema`. **Check `state` before trusting `data`:**

- `ok` — use `data`.
- `unavailable` — honestly not servable; `warnings[0].code` says why (table below). **Do not retry
  the same call** and do not fabricate — report the reason. Exactly ONE variant remains gated by
  design: `cork_compute` rfq-quote (a pricing MODEL, deferred as a product decision; the auction
  maker-order is the modeled-quote-free alternative).
- `conflict` — the tool executed and found a mismatch (e.g. `digest_mismatch`); surface it, don't
  paper over it. On MCP, `conflict` is NOT an error result; `unavailable` is.

Warning codes:

| Code | Meaning / what to do |
|---|---|
| `requires_rpc` | No RPC resolved (offline, or a chain outside defaults+fallback like vnet 49222). Set `CORK_RPC_URL`. |
| `unknown_deployment` | No/partial deployment config for this chainId; an RPC won't fix it. |
| `chain_read_failed` | RPC answered but the read reverted — usually a pool absent on that chain; check the poolId/chainId pairing. |
| `pool_not_found` | prepare_phoenix funding: `market(poolId)` zeroed — no funding legs built. |
| `invalid_input` / `internal_error` | MCP-only error envelope (bad input / unexpected exception); CLI exit 2 / 1. |
| `needs_indexer` / `needs_service` | Backend not wired yet. |
| `phase_gated` | The gated rfq-quote kind; also dutch-auction-price on legacy Fusion layouts (only v3.1 implemented). |
| `missing_filter` | The resource needs `filters.poolId` / `filters.account`. |
| `mode_unavailable` | Requested data mode isn't wired — omit `mode` or use `lite-decentralized`. |
| `unknown_topic` / `no_lop` | Topic not found (message lists doc topics) / no 1inch LOP for the chain. |
| `unknown_target` | Info on ok decode tx: `to` isn't a known Cork deployment (expected for a token approve — the target is the TOKEN — otherwise identify before broadcasting), or no `to` (contract creation). |
| `chainid_mismatch` | conflict (decode tx): supplied chainId contradicts the tx's own — the signature commits to the tx's chainId. |
| `receipt_not_found` | txHash unknown/pending at the RPC — a normal outcome. |
| `rpc_fallback` | Info: a chainlist public endpoint served the read; on mid-call failover, earlier reads in the same result may be from the previous endpoint. |
| `funding_needs_rpc` / `manual_funding` / `owner_managed_funding` | Info on ok prepares: why funding legs were omitted. |
| `recipe_not_found` | The recipe ADDRESS isn't approved on the registry (`isRecipe` is the only gate), or a deprecated `mode` name has no configured hint. |
| `recipe_refused` | `recipe.resolve` reverted — message names the contract's own error (e.g. `MalformedAdditionalData`: the liquidity recipe needs `args = abi.encode(anchorRate)` while its oracle is undeployed). |
| `denomination_not_found` / `feed_not_found` | No such label (EXACT BYTES, case-sensitive) / no such DIRECTED base→quote feed. |
| `deprecated_gated` | unavailable: a deprecated feature invoked without the opt-in (`CORK_ENABLE_DEPRECATED=1`, CLI `--enable-deprecated`); nothing ran. |
| `deprecated` | Info on ok: a deprecated path DID run — its answers don't describe the current world. |
| `deprecation_notice` | Info on ok: still-supported sugar used (e.g. `mode` → recipe address); message teaches the new shape. |
| `constraint_window_notice` | Info on JIT prepares: staleness guards via `recipe.verify` at fill time — a live rate outside the carried window reverts fills `RecipeRejectedConstraint` until a fresh constraint is signed. |
| `decaying_price_notice` | Info on auction maker-orders AND taker-fills of auction rows: the taker price DECAYS from initialRateBump (base 1e7) above the signed takingAmount down to that floor — the maker's WORST case, not the expected price. Fill-side default cap is the curve ceiling. Takers re-price with dutch-auction-price + simulate before filling. |
| `oracle_already_deployed` / `oracle_not_deployable` | Info on prepare_market: the pair's oracle exists (safe idempotent no-op) / the deploy simulation reverted — message names the EXACT failure via `diagnoseOracleDeployFailure` (the registry's typed error, the unregistered leg, or the cross-generation CREATE2-collision class — observed on sUSDe/sUSDS@42161; such pairs host FIXED-recipe markets only). Same diagnosis on derive-cork-pool and the JIT gates. |
| `oracle_not_deployed` | Info on derive-cork-pool AND JIT prepares: the recipe's oracle isn't deployed — and doesn't need to be: identity derives against the PREDICTED oracle address (the fill runs the same permissionless deploy in-tx), the constraint resolves from the anchor fallback, the share simulation prepends the deploy. Caveat: a source re-registration before the fill shifts the address → OrderNotForPool. |
| `rate_drift_notice` | Info on derive-cork-pool while the pool doesn't exist: prediction conditioned on TODAY's oracle rate — but pinning happens at SIGNING; staleness then guards via `recipe.verify`. |
| `jit_side_mismatch` | JIT prepare: NEITHER order side is the derived pool's cST — the fill WILL revert; use the predicted cST from the result. |
| `stale_share_prediction` | The WHY, when knowable: the order side ALREADY hosts another pool's live share contract (nonce-based cST prediction consumed by an interleaving creation — shares deploy via plain CREATE, first-come-first-served). Re-sign against a fresh prediction. Silent without an RPC. |
| `roles_not_granted` / `adapter_binding_mismatch` | JIT adapter pre-flight: controller roles missing (signable but unfillable) / the adapter's on-chain bindings disagree with config (conflict — refresh cork-defaults.json). Also for a ForSelf adapter whose CORK()/LOP()/WHITELIST() views disagree with config — the caller would grant it an allowance, so no artifact is built. A reverting `WHITELIST()` is NOT a conflict (a legit pre-caller-gate deployment; the whitelist pre-flight adapts). |
| `would_revert` | Info on ok simulate: the frozen bytes revert at current state (reason included) — don't sign as-is. Also on auction taker-fill when the explicit cap sits BELOW the current decayed price (a resting-bid strategy if intended). |
| `share_prediction_unavailable` | JIT prepare: eth_simulateV1 unsupported — verify the order side + permit token yourself. |
| `band_parity_mismatch` | conflict (legacy recipe-rate-constraint): local applyBands port disagreed with the chain — trust the chain, report the bug. |
| `pool_expired` | Info: a pre-expiry action against an expired pool — builds but would revert; withdraw/withdraw-other/redeem are the post-expiry paths. |
| `sweep_back` | Info: sweep-back leg(s) return the unspent remainder of a funded **cap** to `account` — the adapter's FULL balance per token, so also residue an earlier bundle abandoned (already takeable by anyone). |
| `sweep_back_skipped` | Sweep warranted but the target would revert `erc20Transfer` (zero address, or the adapter itself) — the residual stays skimmable. Fix `account`. |
| `pool_paused` | Info: the bundle would revert `EnforcedPause()` — the GLOBAL pause or the pool's `getPausedBitMap` bit for this family (bit0 deposit/mint, bit1 swap/exercise/exercise-other, bit2 withdraw/withdraw-other/redeem, bit3 unwind-deposit/-mint, bit4 unwind-swap/-exercise/-other). |
| `not_whitelisted` | Info: a gated pool checks **two** addresses and this one fails — once per failing address (see whitelist note). forSelf is generation-aware: caller-gate adapters (cork-periphery, 2026-08-07+) check the ACCOUNT via `isWhitelisted(poolId, msg.sender)`; pre-gate adapters never accuse the account. Also on forSelf taker-fills (`CallerNotWhitelisted`). |
| `digest_mismatch` / `marketid_mismatch` / `create2_mismatch` | conflict: what failed verification. On submit rollover-order: the intent doesn't hash to its own `rolloverIntentHash`, or the venue computed a different orderDigest — not relayed. |
| `venue_rejected` / `venue_unreachable` / `venue_rate_limited` | Venue 4xx (status + message) / unreachable or 5xx (transient — retry; check `CORK_VENUE_URL`; after 3 transport failures the per-host breaker fails fast 30 s) / rate-limited (429 `Retry-After` surfaced). Idempotent GETs get ONE silent retry; POST relays never ([K2] retries are the caller's, keyed by clientRequestId). |
| `venue_conflict` | conflict: venue 409 — same id/digest, DIFFERENT payload. Fresh `clientRequestId` for a genuinely new request. |
| `order_not_found` | Digest unknown to the venue — normal for a never-posted order. Also taker-fill when the orderHash is absent from a COMPLETE book traversal. |
| `pagination_incomplete` | A bounded traversal didn't exhaust the set (`reason` + `nextCursor` to resume). On ok: honest partial evidence; on conflict: `cursor_repeated`, or an incomplete search that would otherwise claim "not found". |
| `unsigned_artifact` | Info on ok taker-fill: unsigned calldata — simulate and set the taker-asset allowance (LOP on the raw path, ADAPTER in forSelf) before signing. |
| `for_self_artifact` | Info on ok forSelf prepares: the artifact calls an INTEGRATOR-deployed ForSelf adapter — outputs structurally delivered to the calling account (no receiver parameter exists), custody-free, every allowance granted to the ADAPTER. Matrix in `data.forSelf.allowances`. |
| `caller_signed_artifact` | Info on ok finalize-maker-order: the signature was recovered/verified, not created [K1] — EOA via ecrecover; contract makers via the ERC-1271 staticcall the fill performs (needs an RPC; `submitInput.makerAccountType` carries the result). Pass `submitInput` verbatim to `cork_submit` after your policy gate admits `signedArtifactDigest`. |
| `signature_or_reconstruction_mismatch` / `prepared_context_mismatch` | conflict: the signature doesn't recover to the maker/user against the recomputed hash (finalize AND submit recover before relay [K3]) / reconstruction ≠ prepared hash, salt↔extension unbound, or the prepared clientRequestId·chainId·verifyingContract disagrees. Not relayable. |
| `invalid_service_response` | taker-fill: the venue row failed shape validation — no fill bytes built. |
| `rfq_not_found` | rfqId unknown to the venue — a normal outcome. |
| `asset_not_found` | registry-assets `filters.address`: not registry-approved on that chain. |
| `settler_mode_mismatch` | rollover-intent: the settler's mode gate makes the order unfillable (ExactSettler rejects partial fills; PartialSettler requires them). Message names the right settler. |
| `settler_not_recognized` / `invalid_order_terms` | Info: settler not a configured Cork settler (also dutch-auction-price on an unknown Fusion settlement — priced as v3.1, verify independently) / incoherent order terms; covers a JIT fee above the 5% cap and a non-Fusion order to dutch-auction-price (envelope, exit 3, not thrown). |
| `invalid_pair` | unavailable (derive-cork-pool): collateralAsset == referenceAsset (domain-rule envelope, exit 3). |
| `status_mismatch` | conflict: the venue's lifecycle disagrees with the chain — chain outranks indexer [K7]. Track reconcile (settler `orderStatus()`) and taker-fill's liveness pre-flight (a row the LOP invalidator says is filled-or-cancelled yields NO fill bytes). Best-effort without an RPC. |
| `venue_reported` / `logs_unavailable` / `logs_range_limited` | Track verification gaps: no RPC for the status leg / no logs endpoint (set `ENVIO_API_TOKEN` or `CORK_LOGS_RPC_URL`) / range refused. |
| `hypersync_unavailable` | full-decentralized: no HyperSync token, unsupported chain, or the napi client can't load. `ENVIO_HYPERSYNC_TOKEN` + `ENVIO_HYPERRPC_TOKEN`; `ENVIO_API_TOKEN` as shared fallback (interchangeable in practice). |
| `live_tail_merged` / `live_tail_unavailable` | Info on ok full-decentralized reads: recent events merged from a live RPC tail (`data.liveTail`) / the tail scan couldn't run — archive-only results. Non-fatal. |
| `premium_scale_suspect` / `premium_scale_mismatch` | Fraction-vs-percent tripwires ("0.041" vs 4.1): suspicious sub-0.1% premium (warned, relayed) / ≥10x divergence from the cited quote_ref, decided in EXACT integer arithmetic (conflict, NOT relayed). |
| `quote_ref_unverifiable` | conflict (submit lop-order): the cited RFQ option has no parsable positive premium — NOT relayed. |
| `listing_traits_mismatch` | conflict (submit lop-order): listing fields (expiry/nonce/allowsPartialFills) contradict the SIGNED makerTraits [K3] — NOT relayed. |
| `invalid_state` | A LOCAL computation/domain failure (C11), distinct from `chain_read_failed`. Also info on ok impairment-floor when the worst rate collapses to 0 (maxReferencePerCst null = unbounded). |
| `reserved_field_ignored` | Info: an accepted-but-reserved field was validated then ignored. `at.timestamp` is reserved for the BLOCK-anchored compute kinds; dutch-auction-price HONORS it. |
| `makingamount_exceeds_order` | Info on ok dutch-auction-price: requested `makingAmount` exceeds the order's own — the quote extrapolates an amount no fill can consume. |
| `expiry_far_future` | Info on JIT maker-orders: `jitMarket.expiryTimestamp` >5 years out — no on-chain upper bound, cPT locked until expiry; check intent. |

CLI exit codes mirror state: `0` ok · `2` invalid input · `3` unavailable · `4` conflict · `1`
unexpected. Only unparseable/format faults throw (exit 2); a well-formed input breaking a domain
rule (equal ca/ref, fee over the 5% cap) returns an `unavailable` envelope (exit 3).

Money/rate outputs are unit-labeled: cst-swap-rate/unwind-rate/impairment-floor carry a `scales`
block plus `collateralDecimals`/`referenceDecimals` — read the labels, don't assume 18 decimals.
`provenance.digest` / `signedArtifactDigest` are OPAQUE content tags: compare only digests produced
by this tool. Absolute-timestamp inputs are bounded to year 2100 — a `Date.now()` milliseconds
paste is rejected with teaching.

Field naming, uniform across every read: the share tokens are always `corkSwapToken` (cST) and
`corkPrincipalToken` (cPT); the pair's rate-oracle wrapper is one nested `oracle` object
(`.address`/`.deployed`/`.deployable`, plus `.rate` on derive-cork-pool) across registry-oracle,
derive-cork-pool, and prepare_market — the Market struct's `rateOracle` is that same contract;
`cork_query` echoes `resource`; chain-backed reads include `chainId` in `data` and
`provenance.chainId`.

Every tool takes optional `format`: `"concise"` (default) or `"full"` (adds `provenance.rpc =
{ source: explicit|default|chainlist, host }`). Every backed result states `provenance.mode`:
`"lite-decentralized"` (RPC chain reads), `"centralized"` (venue via api-phoenix, override
`CORK_VENUE_URL`), or `"full-decentralized"` (HyperSync). `cork_query mode` is honored explicitly,
never silently substituted: venue-only resources reject decentralized modes (resting orders/RFQs
emit no events — structural), chain resources reject `centralized`, the event-derived subset serves
`full-decentralized` with the live-tail merge. No field is accepted-but-reserved any more:
`cork_prepare_phoenix` `account` is load-bearing (recipient of the sweep-back residual) — set it to
the address that actually funds the bundle.

**Maker-order nonces are per-request.** Cork-built orders set `allowMultipleFills: false`, so they
live in the 1inch **bit** invalidator — keyed on `(maker, nonce)`, NOT orderHash. The nonce derives
from `clientRequestId` (40-bit slot: retries stay byte-identical [K2], distinct requests get
distinct bits). Two orders sharing a `clientRequestId` share one bit — filling or cancelling either
reverts the other `BitInvalidatedOrder` — so give every concurrently-live order its own id.
maker-order returns the derived `nonce`; the venue listing must carry that exact value or
`cork_submit` refuses with `listing_traits_mismatch`.

**`data.execution` — the completion pointer on every prepare result** (typed once in
`packages/schemas/src/doc-topics.ts`): `{ kind: "eth-transaction"|"eip712-typed-data", sign, then:
string[], reference: 'cork_capabilities topic:"signing"' }`. Family A: simulate → sign client-side
→ `cork_decode kind:"tx"` → `eth_sendRawTransaction` via YOUR OWN RPC → track txHash; Family B:
sign typed-data → finalize-maker-order → submit, or sign → submit rollover-order. There is
deliberately NO broadcast tool: clients broadcast through their own endpoint after validating the
signed bytes.

**Bundle summary.** `cork_prepare_phoenix` and `cork_decode` (calldata) both return `summary:
string[]` — one plain-English line per leg in execution order, so a signer can check intent before
signing. `uint256.max` reads as "the entire remaining balance"; addresses named where known; a Cork
leg names its `receiver`/`owner`, so a redirected payout is visible. `skipRevert` flags "MAY FAIL
SILENTLY"; non-zero `value` flagged; an undecodable leg is `UNREADABLE … Do not sign until you have
identified it`, never glossed. Renderer: `packages/core/src/bundle/summary.ts`.

**Prepare pre-flight guards.** Every chain-backed `cork_prepare_phoenix` call (funded and
`pre-funded`) runs one batched read of expiry, pause, and whitelist. All **build-and-warn** — bytes
still returned, clearly labelled — and each degrades to silence if its view is unavailable.
`packages/core/src/bundle/preflight.ts`.

**A gated pool checks TWO addresses, and they differ.** `CorkAdapter.onlyWhitelisted` checks
`initiator()` — *you* — while `CorkPoolManager._onlyWhitelisted` checks `_msgSender()`, which for a
bundled call is the **adapter** (no ERC-2771 forwarding anywhere). **Both** must be whitelisted —
checking only your own address (`pool-whitelist` with `filters.account`) can show a false green.
The pre-flight checks both and reports each separately. (`isWhitelisted` returns true for pools
with no whitelist enabled — ungated pools never warn.)

**Sweep-back legs [F13].** Auto-funding (`erc20-approve`/`permit2`) moves the caller's slippage
**cap** into the adapter for every `max*` input; the pool consumes only the true amount, and the
delta is takeable by anyone (`CoreAdapter.erc20Transfer` is `onlyBundler3` but never checks
`receiver == initiator()`; `Bundler3.multicall` is public). Every capped leg gets a matching
`erc20Transfer(token, account, uint256.max)` appended after the action leg — including the
burn-side caps (`withdraw`, `withdraw-other`, `unwind-deposit`). Exact inputs (`deposit`, `redeem`,
`unwind-swap`, `unwind-mint`) strand nothing, no sweep; `pre-funded` never sweeps. The result
reports `sweepBackLegs: n` alongside `fundingLegs: n`; a zero residual is a no-op.

Retry semantics [K2]: bundles default to a relative deadline (`deadlineSeconds`, re-anchors to the
clock — different bytes on retry); pass an absolute `deadlineAt` (unix seconds) for byte-identical
same-`clientRequestId` retries. `cork_query account-state` returns balances AND funding allowances
per pool token for both spenders (corkAdapter for `erc20-approve`, canonical Permit2 for `permit2`)
plus `permit2Internal` (amount + uint48 expiration; user, token, spender=adapter) — both layers
must be in place or the bundle reverts.

## RPC resolution (chain-backed tools work by default)

Chain reads pick an endpoint automatically: **explicit** (`CORK_RPC_URL` / `--rpc-url`;
`eth_chainId` verified once per process — a wrong-chain endpoint is refused as teachable invalid
input) → **built-in default** (committed endpoints for mainnet + Arbitrum, jittered backoff behind
per-endpoint circuit breakers) → **chainlist.org fallback** (chains 1/42161/8453/11155111: fetch
just-in-time, latency-probe, verify chainId, pick fastest; adds `rpc_fallback`). Chosen endpoint +
breaker state are cached in-process and on disk (`~/.cache/cork-helper-cli/`, override
`CORK_RPC_CACHE_FILE`; temp+rename atomic — safe across concurrent processes). Automatic clients
fail over **in-call**: a transport-class failure feeds the breaker, re-resolves once, retries, with
`ResolvedRpc` mutating in place so `rpc_fallback`/`provenance.rpc` disclose the endpoint that
actually served; explicit URLs never fail over. Kill-switch: `CORK_RPC_NO_FAILOVER=1`. Concurrent
resolutions are single-flighted. The breaker is ONE shared module (`packages/core/src/breaker.ts`,
mutation-probed) — the venue transport uses it per-host (3 transport failures → open 30 s), plus
one silent retry for idempotent venue GETs (never POSTs) and 429 `Retry-After` surfaced. The HTTP
server exposes `/readyz` — always 200, machine-readable degradation snapshot (endpoint HOSTS only,
never full URLs — the committed defaults embed tokens in their paths).

So cork-pool/account-state/pool-whitelist, swap/unwind/impairment compute, and track marketRef
**just work** on public chains. `requires_rpc` only when nothing resolves (offline, or the staging
vnet 49222, which needs an explicit `CORK_RPC_URL`). Pure/config tools never touch a chain:
capabilities, decode, protocol-config, rollover-premium-floor, prepare byte-building.
(prepare_phoenix funding-leg token resolution needs an *explicit* RPC — without one you get the
bundle plus `funding_needs_rpc` and `fundingLegs:0`. ForSelf prepares and the taker-fill
liveness/ERC-1271 checks DO use the default-resolved RPC: security reads run whenever any endpoint
resolves and disclose honestly when none does.)

Per-chain coverage: chainId 1 is **full** on its own stack. 42161 and 8453 both default to
**phoenix v1.3.0-rc.1 + market-registry 0.3.2** (2026-08-07, identical CREATE2 addresses,
generations ALIGNED: the 0.3.2 adapter's controller binds the v1.3 pool manager `0x02803B…7263`;
per-chain bundler3 read from the adapter's own `BUNDLER3()`). All five phoenix contracts + the
full registry stack on both chains — but **no pools exist on the v1.3 pool manager yet**
(cork-pool reads `chain_read_failed` until pools are created there), the adapter's POOL_CREATOR +
FEE_MANAGER grant is pending one Safe signature (prepares warn `roles_not_granted`), and pair
oracles are seeded on Base but mostly undeployed on 42161 (resolve needs the `additionalData`
anchor until a pair's wrapper deploys). The venue's EXISTING markets still live on the previous
Arbitrum stack, `deploymentProfiles["42161"]["arbitrum-v1.1"]` (old PM `0x4d0ab6…`; rollover still
binds THIS generation; share prediction stays correct across the split — `predictShares` follows
the CONTROLLER's own `CORK_POOL_MANAGER()` binding, mutation-probed). The pre-launch pair (old PM
`0xc2De…54AE`, 3 calibration pools) survives as `["arbitrum-legacy"]`. A real mainnet pool for
examples/tests: `0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05` (current
list: `api-phoenix.cork.tech/v1/pools/`). The vnet fixture pool `0xceeb…c16a` exists ONLY on the
vnet — chainId 1 without a vnet RPC yields `chain_read_failed`, by design.

**MarketRegistry 2.1.0-model, contracts release 0.3.2 (Arbitrum One + Base, identical
addresses).** The whole registry stack was redeployed 2026-08-07 against the v1.3.0-rc.1 pool
manager — every address changed (registry `0xF532…DC94`, adapter `0x1b75…c7CE`, factories, THREE
approved recipes — LiquidityPrice, LiquidityNav (NEW), FixedRate — verified on-chain on BOTH
chains; attestations in packages/core/src/config.ts). Base arrived seeded; 42161 is asset-seeded
but most pair wrappers are undeployed. The 0.3.2 controller splits fee authority into
FEE_MANAGER_ROLE — `readAdapterRoles` (market-registry.ts) detects the generation from the
controller's own `FEE_MANAGER_ROLE()` view (CONFIGURATOR on older controllers), one comparator
shared by all three call sites, mutation-probed. The PREVIOUS generation is dangerous precisely
because it still ANSWERS: 2.1.0-shaped calls against it decode into plausible nonsense. The guard:
`adapter.MARKET_REGISTRY()` must equal the configured
registry (best-effort+cached on reads, hard on prepares → `adapter_binding_mismatch`). The 2.1.0
model: recipes are approved CONTRACTS that resolve/verify their own constraints; the constraint is
derived OFF-CHAIN at signing (recipe-rate-constraint) and CARRIED in the order — pool id + share
addresses pinned at signing, no rate-driven identity drift; oracles are mode-keyed (price|nav) per
pair plus fixed-rate keyed on the rate. Scales: 1e18 = 1.0 except `_PERCENTAGE`-named recipe
constants and the two adapter fee fields (1e18 = 1%). The fill path is LIVE on the v1.1 generation
(roles granted 2026-08-04, not revoked — BOTH generations fillable in parallel); the pre-2.1.0
flow is preserved behind the deprecation gate: `marketRegistryLegacy` config + `legacy:true` +
`CORK_ENABLE_DEPRECATED=1` (CLI `--enable-deprecated`) — warning-code contract in
`packages/core/src/deprecation.ts`. Naming vs
release tag: "2.1.0" is the GENERATION name; the config's `contractsVersion` follows the free-form
contracts-RELEASE label the registry read API serves — "0.3.0" ~2026-08-06, then "0.3.2"
~2026-08-10 (each verified same-address same-behavior; the registry ADDRESS is the identity check,
and the live parity test asserts config==API without pinning a third copy, so the next relabel is one
config-field edit). ~2026-08-10 the read API also RETREATED its recipe notes (args + constants
nulled): our RECIPE_CATALOG teaching layer is a deliberate superset; parity asserts only what the
API still serves. The read API's sandbox (`https://zian-b.feat.cork.tech`, override
`CORK_MARKET_API`) is used ONLY in env-gated live parity tests + the main-push `live-smoke` CI job
(parity legs self-skip when unreachable) — never a committed runtime dependency; our chain-native
reads were verified wei-for-wei against it, with one deliberate difference: our share prediction
also works pre-oracle-deploy (the simulation prepends the same permissionless deploy the fill
performs; the HTTP endpoint returns market/shares null). The whole 2.1.0 fill path is proven
END-TO-END on an Arbitrum fork (experiments/fork-harness/test/JitOrderRoundTrip210.t.sol +
script/gen-jit-artifact-210.ts): tool-prepared order + embedded cST permit filled through the real
1inch LOP — oracle deployed in-fill, pool created at the derived id, created cST EXACTLY equal to
the tool's prediction — plus a negative control proving an out-of-window constraint reverts
RecipeRejectedConstraint.

## Invariants that constrain how you use the tools

- **Prepare ≠ sign ≠ submit** [K1]. `cork_prepare_*` return unsigned bytes/typed-data. Nothing is
  signed or broadcast except `cork_submit`, which only relays a payload the caller already signed.
- **Idempotency** [K2]. `cork_prepare_*` and `cork_submit` take a `clientRequestId` — reuse it when
  retrying the same request; fresh id for a genuinely new request. Artifacts are deterministic for
  identical inputs + observed state + clock; deadline/expiry fields are **wall-clock + duration**
  (owner ruling 2026-07-20), so bytes re-anchor on a later retry — pin `ctx.nowSeconds` (or
  `at.block` for reads) for bit-identical replay.
- **Never commit an RPC URL** — `CORK_RPC_URL` / `CORK_TEST_RPC` come from the environment only.
  The two built-in defaults in `chain/rpc.ts` are a deliberate committed exception (owner
  decision); don't add more.
- **Math is bit-exact and empirically verified** against live on-chain reads (wei-for-wei). Trust
  the tool's numbers over hand-derived ones.

## Address config: remote-first with a bundled fallback

Deployment addresses are NOT hardcoded in source. `cork-defaults.json` (repo root) is canonical;
`packages/core/src/config-remote.ts` resolves **remote-first**: fetch from GitHub raw (override
`CORK_DEFAULTS_URL`) → strict zod validation (tampered content rejected) → 1 h disk cache
(`~/.cache/cork-helper-cli/cork-defaults.json`, override `CORK_CONFIG_CACHE_FILE`). HTTP 404/410
(not published — a deliberate state) → bundled copy served silently; a transient failure → bundled
copy + a `config_fetch_failed` warning. Either outcome is negative-cached 10 min.
`CORK_CONFIG_NO_FETCH=1` skips fetching entirely (tests set it). Never hand-edit addresses in TS —
edit `cork-defaults.json`.

## Discoverability: examples, maturity, teaching errors

- **Worked examples**: `packages/schemas/src/examples.ts` (`TOOL_EXAMPLES`, all test-validated) —
  every tool description advertises one; capabilities search/topic return the full set. The demo
  poolId/account are the canonical fixtures; `experiments/fork-harness/script/DeployDemoPool.s.sol`
  deploys that pool on a Tenderly virtual mainnet via timelock impersonation (`--unlocked --sender
  0x7CcC…89D9`).
- **Maturity** (`MATURITY` map, same file): per-tool + per-variant `activated | implemented |
  specified` with a reason code — surfaced through `cork_capabilities`. Gated variants say so in
  the tool description.
- **Teaching errors** (`packages/schemas/src/teaching.ts`): schema failures return structured
  issues (`path`/`expected`/`received`), a levenshtein "did you mean …?", remediation text, and a
  corrected example that itself validates — MCP error envelope; CLI JSON on stderr.

## Evals gate the tool surface

`evals/README.md` is the contract. Layer A (always-on vitest): example/teaching/maturity tests plus
the **surface-drift gate** (`packages/mcp/test/surface-drift.test.ts`) — any change to advertised
names/descriptions/schemas fails CI until the fixture is deliberately regenerated
(`UPDATE_SURFACE=1`). Layer B (`bun run eval`, needs an Anthropic key; self-skips): a fresh agent
gets only the 9 tool definitions and ~20 tasks against a stubbed chain; graded on tool selection,
parameter accuracy, outcome state, efficiency, error recovery. **Never tune descriptions/examples
against the 5 held-out tasks.** Surface-change workflow: edit → run Layer B → regenerate the drift
fixture.

## Layout

`packages/schemas` (zod v4 source of truth + registry, examples/maturity/teaching) · `packages/core`
(math ports, chain reads, Bundler3 encode/decode, remote config, `runTool` dispatch — handlers
split per tool under `src/handlers/`) · `packages/mcp` (stdio server) · `packages/cli` (commander
projection) · `evals/` (agent-eval suite). Tests: `packages/core/test/` (unit +
`fork-parity`/`bundle-sim` vnet suites), `packages/mcp/test/` (integration + surface-drift gate),
`packages/schemas/test/`.
