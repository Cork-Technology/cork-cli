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
    when JSON parsing fails, object-ONLY fields reject non-JSON (`invalid_json`) — mutation-probed,
    positionals pinned by test. Every discriminated action/kind is
    ALSO a subcommand with the variant's fields flattened to flags and a variant-scoped
    --help/--explain (`ch prepare pool exercise --pool-id …`; English order works —
    positional-then-variant is shuffled, parent options after the variant merge back). The
    discriminator comes from the subcommand name (a blob cannot override it); a blob WITH a
    variant subcommand merges as the base (variant flags override); a mistyped action gets a
    levenshtein did-you-mean pre-parse. Amount fields (digits-only)
    take exact sugar on FLAGS only: `1000e18`/`1_000` expand via integer math, fractional
    remainders refused (`invalid_amount`); blobs stay wire-exact. `--chain-id` also takes network
    names (mainnet/ethereum/arbitrum/base/sepolia). Help displays kebab spellings. The 13 pool
    actions + `fill` are ALSO top-level verbs (`ch exercise …` = `ch prepare pool exercise …`;
    authority ops stay namespaced). On `ch query`,
    every KNOWN_FILTER_KEYS key is a first-class flag merging INTO `filters` (flags override the
    blob; a colliding key rides under an alias — `--oracle-mode` is `filters.mode`, bare `--mode`
    stays the data-backend selector). Resource
    shorthands (taxonomy-agreeing only): `rfq`→rfqs; `pool`/`pools` + `market-instance(s)` (a pool
    is an INSTANCE of a market)→cork-pool(s); `derive-pool`→derive-cork-pool; `trading-pair` +
    `orderbook-pairs`→trading-pairs; `limit-orders`→orderbook;
    `pool-migration-orders`/`extend-expiry-orders`→rollover-orders; `registered-*` +
    `market-recipes`→registry-*; `asset-pair-oracle`→registry-oracle (a status lookup, not a
    table). On `ch decode`, `limit-order`→`order`; on `ch compute`, `resolve-rate-constraint`→
    recipe-rate-constraint (VARIANT_ALIASES). PRE-RENAME values (`market(s)`/`derive-market`/
    `limit-order-markets`/`market-predict`/`deploy-wrapper`/`flows`/`resolve-recipe`) are
    deliberately NOT aliases anywhere — they get a renamed-to teaching error via RENAMED_VALUES in
    teaching.ts. All mutation-probed.
  - **Output** is prose by default, JSON on request: bare `--json`, `CORK_JSON=1`, or input passed
    as `--json '<object>'`. Renderer: `packages/cli/src/render.ts`.
  - `--explain` prints a plain-English contract ($refs resolved, variants unfolded) and exits; JSON
    schema via `--json` or `CORK_EXPLAIN_JSON=1` (`packages/cli/src/explain.ts`).
  - `--rpc-url <url>` overrides RPC resolution for chain-backed commands.
- Typecheck / test: `bun run typecheck` · `bun run test` (network suites self-skip) ·
  `bun run test:unit` (offline) · `bun run test:live` (vnet/live; needs `CORK_TEST_RPC` /
  `CORK_RPC_LIVE=1`) · `bun run test:mutation` (scripts/mutation-probes.ts: applies catalogued
  semantic mutants — struct/tuple order, enum ordinals, bit flags, hash inputs, rounding,
  comparators, storage-slot math — FAILS unless the offline suite kills every one; also fails on
  pattern rot. Surviving mutant: killer test, keep the probe) · `bun run test:prop` (pinned-seed
  fast-check under experiments/proptest — CI-gated private, loud-skipped in the public port).

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
returns exactly **9 tools**.

## The 9 tools — pick by intent

| Tool | Use when | Phase |
|---|---|---|
| `cork_capabilities` | Discover/introspect: list tools, `search` by keyword, `topic` for docs, `topic:"verify"` re-derives deployed addresses via CREATE2. Doc topics resolve before tool names, by name OR alias: `topic:"signing"` (`execute`/`broadcast`/`sign-and-broadcast`) is the sign-and-broadcast guide; `topic:"units"` (`scales`/`decimals`/`wad`/`fixed-point`) is the scale table — ten conventions, unit OWNER per row, a "5% is written" exemplar, the three collisions (1e18=1.0 vs 1e18=1%; `premium`'s four meanings; rateMin/rateMax absolute vs legacy bands), in two-axis Reserve/ToB notation (`D18{1}` vs `D18{%}`) beside each field's own description wording; the premium scale tripwires route to it. One constant (`DOC_TOPICS`, packages/schemas) feeds the MCP `instructions` string and every `/docs/<topic-or-alias>` page via `findDocTopic`; a parity test fails if the table and a field's description disagree. Start here when unsure. | 1 |
| `cork_query` | **State reads** (taxonomy: a cork-pool is ONE EXPIRY of a market — the pool family over one (collateralAsset, referenceAsset) pair; a trading-pair is a tradable LOP listing). Live chain: cork-pool, account-state, pool-whitelist, protocol-config, the registry-assets/-oracle/-recipes/-denominations/-feeds 2.1.0 views (see MarketRegistry section; oracles mode-keyed price\|nav per pair PLUS fixed-rate keyed on `filters.rate`), derive-cork-pool (derive ONE pool before it exists — recipe + off-chain constraint via recipe.resolve, LOCAL pool id, cST/cPT via state-override simulation, existence; needs `filters.collateralAsset+referenceAsset+expiry+recipe`; the derivation a JIT fill runs; identity PINNED once an order carrying the constraint is signed). Venue-backed (centralized): cork-pools, orderbook, fills, trading-pairs, flows (`filters.kind`), rfqs (default `state=open`; `filters.rfqId`; `withAnswers`; `filters.view` 'current' = the negotiation frontier — one current answer per underwriter + the requester's counter; monotonic `version` = cheap change-polling). Event-derived: whitelisted-addresses (replayed from WhitelistManager events over HyperSync, needs ENVIO token; `filters.poolId` scopes); cork-pools/fills/flows also serve `full-decentralized` (HyperSync) with a live RPC tail merged past the archive head (`data.liveTail`). Venue lists are **bounded traversals** (`data.pagination`; partial = `ok`+`pagination_incomplete`, repeated cursor = `conflict`; `cursor`/`pageSize`/`maxPages` control it). | 1 |
| `cork_compute` | **Deterministic math** over verified state — swap/unwind rate, rollover premium floor, worst-case impairment floor, recipe-rate-constraint (a staticcall to `recipe.resolve` — THE step producing the constraint a JIT order carries and signs; needs recipe+ca+ref; pre-2.1.0 band math behind `legacy:true` + the gate), dutch-auction-price (Fusion v3.1 current price, pure local from the order's own extension bytes [K3]; pin with `at.timestamp`; `baseFeeWei` omitted = upper bound). NOT raw reads, NOT byte-building. | 1 |
| `cork_decode` | Bytes → labeled JSON, five kinds: calldata (recursively unwraps Bundler3 multicall); **tx** (a SIGNED raw transaction — the validate-before-broadcast step: recovered signer, to/value/chainId/nonce/gas, target named against known Cork deployments, inner legs + summary); order (LOP v4 hex tuple or JSON → makerTraits breakdown + recomputed orderHash; supplied hash/extension cross-checked → `conflict`; a Fusion extension gets a `fusion` label, a Cork JIT extension a `jit` label unpacking adapter/recipe/carried constraint/permit count; both can appear on a composed order); event (one log → named args against the source-verified ABI set; unverified layouts labeled raw); receipt (every log labeled). Reconstructs from bytes; never trusts a supplied parse [K3]. | 1 |
| `cork_prepare_phoenix` | Build an **unsigned** Bundler3 bundle for any of the 13 adapter actions (auto funding legs), plus authority-onboard/-revoke: an unsigned DIRECT ERC-20 approve tx (onboard amount omitted = unlimited; revoke zeroes) — owner-signed, not a bundle leg. Returns bytes, executes nothing [K1]. `forSelf: { adapter }` emits a DIRECT call to an integrator-deployed Cork ForSelf adapter (the *ForSelf twin, e.g. exercise → exerciseForSelf; cork-periphery): no Bundler3, no funding/sweep legs, receiver/owner must equal `account`, allowances to the adapter — for parameter-blind session-key wallets (the Zyfai shape; see `for_self_artifact`). Results carry `data.execution`. | 2 |
| `cork_prepare_orders` | Build **unsigned** signable artifacts: maker-order (incl. extension/JIT orders, and `auction` — a Cork-native DECAYING-PREMIUM order using the deployed Fusion settlement as a pure amount getter: no postInteraction, fills stay permissionless, the signed takingAmount is the floor; composes with jitMarket in one salt-bound extension) / cancel; **finalize-maker-order** (reconstruct exact bytes, verify the external signature — EOA ecrecover or the ERC-1271 staticcall the fill performs — emit a verbatim `cork_submit` artifact with `makerAccountType`; never signs); **taker-fill** (fetch + re-hash a resting venue order, emit canonical uint256-tuple fill calldata, unsigned; an AUCTION row is auto-detected — the default cap becomes the curve's CEILING (a floor cap would revert mid-decay), current/ceiling/floor in `data.auction`; `interaction` packs a TAKER interaction — `adapter ++ extraData`, length at takerTraits bits 200-223 — how an underwriter lifts a BUY-cover order (JIT cST mint mid-fill); `forSelf: { adapter, poolId }` emits fillOrderForSelf — target forced to the caller, taker interactions impossible, allowance to the ADAPTER — with a liveness pre-flight refusing dead rows [K7]); and the rollover ERC-7683 OrderData (CorkSettler domain, intent hash recomputed). All but finalize-maker-order carry `data.execution`. | 3 |
| `cork_track` | Verify a resource against chain, simulate frozen prepared bytes (eth_call dry-run: wouldRevert + reason BEFORE signing), or reconcile a receipt/order to a lifecycle state. Chain outranks indexer; disagreement → `conflict` [K7]. | 2 |
| `cork_prepare_market` | Unsigned oracle-infrastructure txs against the 2.1.0 registry: deploy-oracle = MarketRegistry.deploy(ca, ref, mode) (price\|nav, default price) and deploy-fixed-oracle = deployFixedRateOracle(rate) (CREATE2-salted on the RATE — the oracle a FIXED order's rateOverride produces). Both permissionless + idempotent; 42161 + 8453. Markets are created JIT by LOP fills (maker-order + `jitMarket`). Results carry `data.execution`. | 4 |
| `cork_submit` | The **only** side-effecting tool: relays caller-signed/authored payloads to the venue — `rollover-order`, `lop-order`, `rfq-open`, `rfq-answer` (REVISIONS — newest per underwriter wins; optional `supersedes`), `rfq-counter` (requester's non-committal counter-bid; fraction-string premium < 0.5 — the venue's parseFloat contract replicated exactly; `optionRef` pre-flighted, incl. requester + expiry) — all off-chain POSTs. Commitments recomputed before relay [K3]; never signs [K1]. | 3 |

## Reading the result envelope

Every tool returns `{ state, data, warnings[], provenance, schemaVersion }` — over MCP as
`structuredContent`, advertised as `outputSchema`. **Check `state` before trusting `data`:**

- `ok` — use `data`.
- `unavailable` — honestly not servable; `warnings[0].code` says why. **Do not retry the same
  call** or fabricate — report the reason. ONE variant stays gated by design: `cork_compute`
  rfq-quote (a pricing MODEL, deferred; the auction maker-order is the alternative).
- `conflict` — the tool executed and found a mismatch (e.g. `digest_mismatch`); surface it, don't
  paper over it. On MCP, `conflict` is NOT an error result; `unavailable` is.

Warning codes:

| Code | Meaning / what to do |
|---|---|
| `requires_rpc` | No RPC resolved (offline, or a chain outside defaults+fallback like vnet 49222). Set `CORK_RPC_URL`. |
| `unknown_deployment` | No/partial deployment config for this chainId; an RPC won't fix it. |
| `chain_read_failed` | RPC answered but the read reverted — usually a pool absent on that chain. |
| `pool_not_found` | prepare_phoenix funding: `market(poolId)` zeroed — no funding legs built. |
| `invalid_input` / `internal_error` | MCP-only error envelope (bad input / unexpected exception); CLI exit 2 / 1. |
| `needs_indexer` / `needs_service` | Backend not wired yet. |
| `phase_gated` | The gated rfq-quote kind; also dutch-auction-price on legacy Fusion layouts (only v3.1 implemented). |
| `missing_filter` | Resource needs `filters.poolId` / `filters.account`. |
| `mode_unavailable` | Requested data mode isn't wired — omit `mode` or use `lite-decentralized`. |
| `unknown_topic` / `no_lop` | Topic not found (message lists doc topics) / no 1inch LOP for the chain. |
| `unknown_target` | Info on ok decode tx: `to` isn't a known Cork deployment (expected for a token approve; otherwise identify before broadcasting), or no `to` (contract creation). |
| `chainid_mismatch` | conflict (decode tx): supplied chainId contradicts the tx's own — the signature commits to the tx's chainId. |
| `receipt_not_found` | txHash unknown/pending — a normal outcome. |
| `chainid_defaulted` | Info on decode order / dutch-auction-price when chainId was omitted: defaulted to 1, and the EIP-712 orderHash (+ Fusion settlement classification) is CHAIN-SPECIFIC — pass chainId for a non-mainnet order. |
| `rpc_fallback` | Info: a chainlist endpoint served the read; on mid-call failover, earlier reads in the result may be from the previous endpoint. |
| `funding_needs_rpc` / `manual_funding` / `owner_managed_funding` | Info on ok prepares: why funding legs were omitted. |
| `recipe_not_found` | The recipe ADDRESS isn't approved on the registry (`isRecipe` is the only gate), or a deprecated `mode` name has no configured hint. |
| `recipe_refused` | `recipe.resolve` reverted — message names the contract's error (e.g. the liquidity recipe needs `args = abi.encode(anchorRate)` while its oracle is undeployed). |
| `denomination_not_found` / `feed_not_found` | No such label (EXACT BYTES, case-sensitive) / no such DIRECTED base→quote feed. |
| `deprecated_gated` | unavailable: a deprecated feature without the opt-in (`CORK_ENABLE_DEPRECATED=1`, CLI `--enable-deprecated`); nothing ran. |
| `deprecated` | Info on ok: a deprecated path DID run — its answers don't describe the current world. |
| `deprecation_notice` | Info on ok: still-supported sugar used (e.g. `mode` → recipe address); message teaches the new shape. |
| `constraint_window_notice` | Info on JIT prepares: staleness guards via `recipe.verify` at fill time — a rate outside the carried window reverts fills `RecipeRejectedConstraint` until a fresh one is signed. |
| `decaying_price_notice` | Info on auction maker-orders and auction taker-fills: the price DECAYS from initialRateBump (base 1e7) above the signed takingAmount to that floor — the maker's WORST case. Fill-side default cap is the curve ceiling; re-price with dutch-auction-price + simulate. |
| `oracle_already_deployed` / `oracle_not_deployable` | Info on prepare_market: the pair's oracle exists (safe idempotent no-op) / the deploy simulation reverted — message names the exact failure via `diagnoseOracleDeployFailure` (registry typed error, unregistered leg, or the cross-generation CREATE2 collision — observed on sUSDe/sUSDS@42161; FIXED-recipe markets only there). Same diagnosis on derive-cork-pool and the JIT gates. |
| `oracle_not_deployed` | Info on derive-cork-pool AND JIT prepares: the oracle isn't deployed — and needn't be: identity derives against the PREDICTED oracle address (the fill deploys it in-tx), the constraint resolves from the anchor fallback, the share simulation prepends the deploy. A source re-registration before the fill shifts the address → OrderNotForPool. |
| `rate_drift_notice` | Info on derive-cork-pool while the pool doesn't exist: prediction conditioned on TODAY's oracle rate — but pinning happens at SIGNING; staleness then guards via `recipe.verify`. |
| `jit_side_mismatch` | JIT prepare: NEITHER order side is the derived pool's cST — the fill WILL revert; use the predicted cST from the result. |
| `stale_share_prediction` | The WHY: the order side ALREADY hosts another pool's live share contract (nonce-based cST prediction consumed by an interleaving creation). Re-sign against a fresh prediction. Silent without an RPC. |
| `roles_not_granted` / `adapter_binding_mismatch` | JIT adapter pre-flight: controller roles missing (signable but unfillable) / on-chain bindings disagree with config (conflict — refresh cork-defaults.json). Also for a ForSelf adapter whose CORK()/LOP()/WHITELIST() views disagree with config — no artifact built. A reverting `WHITELIST()` is NOT a conflict (a pre-caller-gate deployment; the pre-flight adapts). |
| `would_revert` | Info on ok simulate: the frozen bytes revert at current state (reason included) — don't sign as-is. Also on auction taker-fill when the cap is below the current decayed price (a resting-bid if intended). |
| `share_prediction_unavailable` | JIT prepare: eth_simulateV1 unsupported — verify the order side + permit token yourself. |
| `band_parity_mismatch` | conflict (legacy recipe-rate-constraint): local applyBands port disagreed with the chain — trust the chain, report the bug. |
| `pool_expired` | Info: a pre-expiry action against an expired pool — builds but would revert; withdraw/withdraw-other/redeem are post-expiry. |
| `sweep_back` | Info: sweep-back leg(s) return the unspent remainder of a funded **cap** to `account` — the adapter's FULL balance per token, so also residue an earlier bundle abandoned (already takeable by anyone). |
| `sweep_back_skipped` | Sweep warranted but the target would revert `erc20Transfer` (zero address, or the adapter itself) — the residual stays skimmable. Fix `account`. |
| `pool_paused` | Info: the bundle would revert `EnforcedPause()` — the GLOBAL pause or the pool's `getPausedBitMap` bit (bit0 deposit/mint, bit1 swap/exercise*, bit2 withdraw*/redeem, bit3 unwind-deposit/-mint, bit4 unwind-swap/-exercise*). |
| `not_whitelisted` | Info: a gated pool checks **two** addresses and this one fails — once per failing address (see whitelist note). forSelf is generation-aware: caller-gate adapters (2026-08-07+) check the ACCOUNT via `isWhitelisted(poolId, msg.sender)`; pre-gate adapters never accuse the account. Also on forSelf taker-fills (`CallerNotWhitelisted`). |
| `artifact_digest_mismatch` / `intent_hash_mismatch` / `venue_digest_mismatch` / `order_hash_mismatch` / `marketid_mismatch` / `create2_mismatch` | conflict: WHICH verification failed, branchable by code (split from the overloaded `digest_mismatch` 2026-08-10; messages carry "formerly digest_mismatch" one release). Track artifact digest / submit rollover: intent doesn't hash to its own `rolloverIntentHash` (not relayed) / venue echoed a different orderDigest / decode order + taker-fill: supplied or venue orderHash ≠ local recomputation. |
| `venue_rejected` / `venue_unreachable` / `venue_rate_limited` | Venue 4xx / unreachable or 5xx (transient — retry; check `CORK_VENUE_URL`; 3 failures → per-host breaker, 30 s) / 429 (`Retry-After` surfaced). Idempotent GETs get ONE silent retry; POSTs never ([K2] retries are the caller's). |
| `venue_conflict` | conflict: venue 409 — same id/digest, DIFFERENT payload. Fresh `clientRequestId` for a genuinely new request. |
| `order_not_found` | Digest unknown to the venue — normal for a never-posted order. Also taker-fill when the orderHash is absent from a COMPLETE book traversal. |
| `pagination_incomplete` | A bounded traversal didn't exhaust the set (`reason` + `nextCursor` to resume). On ok: honest partial evidence; on conflict: `cursor_repeated`, or an incomplete search that would otherwise claim "not found". |
| `unsigned_artifact` | Info on ok taker-fill: unsigned calldata — simulate and set the taker-asset allowance (LOP on the raw path, ADAPTER in forSelf) before signing. |
| `for_self_artifact` | Info on ok forSelf prepares: the artifact calls an INTEGRATOR-deployed ForSelf adapter — outputs structurally delivered to the calling account (no receiver parameter), custody-free, every allowance to the ADAPTER. Matrix in `data.forSelf.allowances`. |
| `caller_signed_artifact` | Info on ok finalize-maker-order: the signature was recovered/verified, not created [K1] — EOA ecrecover; contract makers via the fill's ERC-1271 staticcall (needs an RPC; `makerAccountType` carries the result). Pass `submitInput` verbatim to `cork_submit` after your policy gate admits `signedArtifactDigest`. |
| `signature_or_reconstruction_mismatch` / `prepared_context_mismatch` | conflict: the signature doesn't recover to the maker/user against the recomputed hash (finalize AND submit recover before relay [K3]) / reconstruction ≠ prepared hash, salt↔extension unbound, or the prepared clientRequestId·chainId·verifyingContract disagrees. Not relayable. |
| `invalid_service_response` | taker-fill: the venue row failed shape validation — no fill bytes. |
| `rfq_not_found` | rfqId unknown to the venue — normal. |
| `asset_not_found` | registry-assets `filters.address`: not registry-approved on that chain. |
| `settler_mode_mismatch` | rollover-intent: the settler's mode gate makes the order unfillable (ExactSettler rejects partial fills; PartialSettler requires them); message names the right one. |
| `settler_not_recognized` / `invalid_order_terms` | Info: settler not a configured Cork settler (also dutch-auction-price on an unknown Fusion settlement — priced as v3.1, verify) / incoherent order terms; covers a JIT fee over the 5% cap and a non-Fusion order to dutch-auction-price (envelope, exit 3). |
| `invalid_pair` | unavailable (derive-cork-pool): collateralAsset == referenceAsset (domain-rule envelope, exit 3). |
| `status_mismatch` | conflict: venue lifecycle disagrees with the chain — chain outranks indexer [K7]. Track reconcile (settler `orderStatus()`) and taker-fill's liveness pre-flight (a row the LOP invalidator says is dead yields NO fill bytes). Best-effort without an RPC. |
| `venue_reported` / `logs_unavailable` / `logs_range_limited` | Track verification gaps: no RPC for the status leg / no logs endpoint (set `ENVIO_API_TOKEN` or `CORK_LOGS_RPC_URL`) / range refused. |
| `hypersync_unavailable` | full-decentralized: no HyperSync token, unsupported chain, or the napi client can't load. `ENVIO_HYPERSYNC_TOKEN` + `ENVIO_HYPERRPC_TOKEN`; `ENVIO_API_TOKEN` as shared fallback (interchangeable in practice). |
| `live_tail_merged` / `live_tail_unavailable` | Info on ok full-decentralized reads: recent events merged from a live RPC tail (`data.liveTail`) / the tail scan couldn't run — archive-only results. Non-fatal. |
| `premium_scale_suspect` / `premium_scale_mismatch` | Fraction-vs-percent tripwires ("0.041" vs 4.1): suspicious sub-0.1% premium (warned, relayed) / declared premium outside the cited quote_ref's 10x band (conflict, NOT relayed) — the venue's STRICT float gate replicated op-for-op (parseFloat, ×100, ratio >10 or <0.1, both premiums >0): the pre-flight lands exactly where the venue lands, ulps included. |
| `quote_ref_unverifiable` | conflict (submit lop-order): the cited RFQ option has no parsable positive premium — NOT relayed (deliberately STRICTER than the venue, which silently skips its band there). |
| `citation_unresolved` | Info on ok submit (quoteRef/optionRef): the cited answer is beyond the RFQ's TRUNCATED answers embed — absence unproven (superseded answers stay citable), so relayed; the venue checks its full store, and the lop premium cross-check defers to its gate. |
| `listing_traits_mismatch` | conflict (submit lop-order): listing fields (expiry/nonce/allowsPartialFills) contradict the SIGNED makerTraits [K3] — NOT relayed. |
| `invalid_state` | A LOCAL computation/domain failure (C11), distinct from `chain_read_failed`. Also info on ok impairment-floor when the worst rate collapses to 0 (maxReferencePerCst null). |
| `reserved_field_ignored` | Info: a reserved field was validated then ignored — `at.timestamp` is reserved for BLOCK-anchored compute kinds; dutch-auction-price HONORS it. |
| `makingamount_exceeds_order` | Info on ok dutch-auction-price: requested `makingAmount` exceeds the order's own — the quote extrapolates an amount no fill can consume. |
| `expiry_far_future` | Info on JIT maker-orders: `jitMarket.expiryTimestamp` >5 years out — no on-chain upper bound, cPT locked until expiry; check intent. |

CLI exit codes mirror state: `0` ok · `2` invalid input · `3` unavailable · `4` conflict · `1`
unexpected. Only unparseable/format faults throw (exit 2); a well-formed input breaking a domain
rule (equal ca/ref, fee over the 5% cap) returns an `unavailable` envelope (exit 3).

Money/rate outputs are unit-labeled: the three chain compute kinds + cork-pool/account-state reads +
track marketRef carry a `scales` block (chain-pair reads add `collateralDecimals`/`referenceDecimals`);
decode JIT/Fusion labels, dutch-auction-price, and registry `oracle.rateScale` label their raw fields
too — read the labels, don't assume 18 decimals. The `scales` pointer key is `unitsTopic` (never
`reference` — that's a token role).
`provenance.digest` / `signedArtifactDigest` are OPAQUE content tags: compare only digests produced
by this tool. Absolute-timestamp inputs are bounded to year 2100 (a `Date.now()` ms paste is
rejected with teaching).

Field naming, uniform across reads: share tokens are always `corkSwapToken` (cST) and
`corkPrincipalToken` (cPT); the pair's rate-oracle wrapper is one nested `oracle` object
(`.address`/`.deployed`/`.deployable`, `.rate` on derive) across registry-oracle, derive-cork-pool,
prepare_market — the Market struct's `rateOracle` is that same contract; `cork_query` echoes
`resource`; chain-backed reads carry `chainId` in `data` and `provenance.chainId`.

Every tool takes optional `format`: `"concise"` (default) or `"full"` (adds `provenance.rpc =
{ source, host }`). Every backed result states `provenance.mode`: `"lite-decentralized"` (RPC),
`"centralized"` (venue via api-phoenix, override `CORK_VENUE_URL`), `"full-decentralized"`
(HyperSync). `cork_query mode` is honored explicitly, never substituted: venue-only resources
reject decentralized modes (resting orders emit no events), chain resources
reject `centralized`, the event-derived subset serves `full-decentralized` with the live-tail
merge. `cork_prepare_phoenix` `account` is load-bearing (sweep-back recipient) — set it to the
address that actually funds the bundle.

**Maker-order nonces are per-request.** Cork-built orders set `allowMultipleFills: false`, so they
live in the 1inch **bit** invalidator — keyed on `(maker, nonce)`, NOT orderHash. The nonce derives
from `clientRequestId` (40-bit slot: retries stay byte-identical [K2], distinct requests get
distinct bits). Orders sharing an id share one bit — filling or cancelling either reverts the
other `BitInvalidatedOrder` — so give every concurrently-live order its own id. maker-order
returns the derived `nonce`; the venue listing must carry it exactly or submit refuses
`listing_traits_mismatch`.

**`data.execution` — the completion pointer on every prepare result** (typed once in
`packages/schemas/src/doc-topics.ts`): kind (eth-transaction | eip712-typed-data), sign method,
ordered `then` steps, reference `cork_capabilities topic:"signing"`. Family A: simulate → sign
client-side → decode kind:"tx" → `eth_sendRawTransaction` via YOUR OWN RPC → track txHash; Family
B: sign typed-data → finalize-maker-order → submit (or sign → submit rollover-order). There is
deliberately NO broadcast tool.

**Bundle summary.** `cork_prepare_phoenix` and `cork_decode` (calldata) both return `summary:
string[]` — one plain-English line per leg in execution order, so a signer can check intent before
signing. `uint256.max` reads as "the entire remaining balance"; a Cork leg names its
`receiver`/`owner` (a redirected payout is visible); `skipRevert` flags "MAY FAIL SILENTLY";
non-zero `value` flagged; an undecodable leg is `UNREADABLE … Do not sign until you have
identified it`. Renderer: `packages/core/src/bundle/summary.ts`.

**Prepare pre-flight guards.** Every chain-backed `cork_prepare_phoenix` call (funded or
`pre-funded`) runs one batched read of expiry, pause, whitelist — all **build-and-warn** (bytes
still returned, labelled), each degrading to silence if its view is unavailable.
`packages/core/src/bundle/preflight.ts`.

**A gated pool checks TWO addresses.** `CorkAdapter.onlyWhitelisted` checks `initiator()` — *you*
— while `CorkPoolManager._onlyWhitelisted` checks `_msgSender()`, which for a bundled call is the
**adapter** (no ERC-2771 anywhere). **Both** must be whitelisted — checking only your own address
can show a false green. The pre-flight checks both, reports each separately; ungated pools never
warn.

**Sweep-back legs [F13].** Auto-funding (`erc20-approve`/`permit2`) moves the caller's slippage
**cap** into the adapter for every `max*` input; the pool consumes only the true amount, and the
delta is takeable by anyone (`erc20Transfer` is `onlyBundler3` but never checks
`receiver == initiator()`; `Bundler3.multicall` is public). Every capped leg gets
`erc20Transfer(token, account, uint256.max)` appended after the action leg — including the
burn-side caps (withdraw, withdraw-other, unwind-deposit). Exact inputs strand nothing, no sweep;
`pre-funded` never sweeps. The result reports `sweepBackLegs: n`; a zero residual is a no-op.

Retry semantics [K2]: bundles default to a relative deadline (`deadlineSeconds`, re-anchors —
different bytes on retry); pass an absolute `deadlineAt` for byte-identical retries.
`account-state` returns balances AND funding allowances per pool token for both spenders
(corkAdapter for `erc20-approve`, canonical Permit2 for `permit2`) plus `permit2Internal` (user,
token, spender=adapter) — both layers must be in place or the bundle reverts.

## RPC resolution (chain-backed tools work by default)

Chain reads pick an endpoint automatically: **explicit** (`CORK_RPC_URL` / `--rpc-url`;
`eth_chainId` verified once per process — a wrong-chain endpoint is refused as invalid input) → **built-in default** (committed mainnet + Arbitrum endpoints, jittered backoff behind
per-endpoint breakers) → **chainlist.org fallback** (chains 1/42161/8453/11155111:
latency-probe, verify chainId, pick fastest; adds `rpc_fallback`). Endpoint + breaker state are
cached in-process and on disk (`~/.cache/cork-helper-cli/`, override `CORK_RPC_CACHE_FILE`;
temp+rename atomic). Automatic clients fail over **in-call** (a transport failure feeds the
breaker, re-resolves once, retries; `provenance.rpc` discloses the endpoint that actually served);
explicit URLs never fail over. Kill-switch: `CORK_RPC_NO_FAILOVER=1`. Concurrent resolutions are
single-flighted. The breaker is ONE shared module (`packages/core/src/breaker.ts`,
mutation-probed) — the venue transport uses it per-host (3 failures → open 30 s), plus one silent
retry for idempotent venue GETs (never POSTs). The HTTP server exposes `/readyz` — always 200,
degradation snapshot (endpoint HOSTS only — the committed default URLs embed tokens).

So cork-pool/account-state/pool-whitelist, swap/unwind/impairment compute, and track marketRef
**just work** on public chains. `requires_rpc` only when nothing resolves (offline, or the staging
vnet 49222, which needs an explicit `CORK_RPC_URL`). Pure/config tools never touch a chain:
capabilities, decode, protocol-config, rollover-premium-floor, prepare byte-building.
(prepare_phoenix funding-leg token resolution needs an *explicit* RPC — without one: bundle +
`funding_needs_rpc`, `fundingLegs:0`. ForSelf prepares and the taker-fill
liveness/ERC-1271 checks DO use the default-resolved RPC — security reads run whenever any
endpoint resolves.)

Per-chain coverage: chainId 1 is **full** on its own stack. 42161 and 8453 both default to
**phoenix v1.3.0-rc.1 + market-registry 0.3.3** (2026-08-10, identical CREATE2 addresses; the
adapter's controller binds the v1.3 pool manager `0x02803B…7263`; per-chain bundler3 read
from the adapter's own `BUNDLER3()`). All five phoenix contracts + the full registry stack on both
chains — but **no pools exist on the v1.3 pool manager yet**
(cork-pool reads `chain_read_failed` there). The adapter's POOL_CREATOR + FEE_MANAGER roles are
GRANTED on BOTH chains (verified 2026-08-10 — the `roles_not_granted` era is over); the residual
42161 gap is RECIPE APPROVAL: isRecipe is false ×3 there (true ×3 on Base), so 42161 JIT
resolution answers `recipe_not_found` until Zian's approvals land; pair-oracle resolve still
takes the `additionalData` anchor until a pair's wrapper deploys. The venue's EXISTING markets live on the previous Arbitrum
stack, `deploymentProfiles["42161"]["arbitrum-v1.1"]` (old PM `0x4d0ab6…`; rollover binds THIS
generation; share prediction stays correct — `predictShares` follows the CONTROLLER's own
`CORK_POOL_MANAGER()` binding, mutation-probed). The pre-launch pair (old PM
`0xc2De…54AE`, 3 calibration pools) survives as `["arbitrum-legacy"]`. A real mainnet pool for
examples/tests: `0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05` (current
list: `api-phoenix.cork.tech/v1/pools/`). The vnet fixture pool `0xceeb…c16a` exists ONLY on the
vnet — chainId 1 without a vnet RPC yields `chain_read_failed`, by design.

**MarketRegistry 2.1.0-model, contracts release 0.3.3 (Arbitrum One + Base, identical
addresses).** Redeployed 2026-08-10 with the CREATE2-collision fix: the wrapper key doubles as
the CREATE2 salt and is now keccak256(abi.encode(**registryAddress**, ca, ref, caSource,
refSource)) — every registry derives its own salt space, so the sUSDe/sUSDS@42161 brick cannot
recur (verified live: the pair simulates DEPLOYABLE on the new registry, still reverts on the
old). Every address changed again (registry `0xa78d…11F1`, adapter `0x8902…374f`, factories,
THREE recipes — LiquidityPrice, LiquidityNav, FixedRate; attestations re-derived from the 0.3.3
broadcast records in packages/core/src/config.ts; the 0.3.2 set `0xF532…DC94` is superseded, git
history keeps its record). Predicted wrapper addresses come from simulateContract(registry.deploy)
— on-chain, never a local salt port — so the salt change needed no math changes. The controller splits fee authority
into FEE_MANAGER_ROLE — `readAdapterRoles` (market-registry.ts) detects the generation from the
controller's own `FEE_MANAGER_ROLE()` view (CONFIGURATOR on older controllers), one shared
comparator, mutation-probed. The PREVIOUS generation is dangerous precisely
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
label the registry read API serves ("0.3.0" ~2026-08-06, "0.3.2" ~2026-08-10 — the registry
ADDRESS is the identity check; the live parity test asserts config==API, so the next relabel is
one config-field edit). ~2026-08-10 the read API also RETREATED its recipe notes: our
RECIPE_CATALOG teaching layer is a deliberate superset; parity asserts only what the API still
serves. The read API sandbox (`https://zian-b.feat.cork.tech`, override `CORK_MARKET_API`) is used
ONLY in env-gated live parity tests + the `live-smoke` CI job (self-skips when unreachable) —
never a runtime dependency; our chain-native reads were verified wei-for-wei against it, one
deliberate difference: share prediction also works pre-oracle-deploy (the simulation prepends the
permissionless deploy; the HTTP endpoint nulls shares). The whole 2.1.0 fill path is proven
END-TO-END on an Arbitrum fork (experiments/fork-harness/test/JitOrderRoundTrip210.t.sol):
tool-prepared order + embedded cST permit filled through the real 1inch LOP — oracle deployed
in-fill, pool created at the derived id, cST exactly equal to the prediction — plus a negative
control proving an out-of-window constraint reverts RecipeRejectedConstraint.

## Invariants that constrain how you use the tools

- **Prepare ≠ sign ≠ submit** [K1]. `cork_prepare_*` return unsigned bytes/typed-data. Nothing is
  signed or broadcast except `cork_submit`, which only relays a payload the caller already signed.
- **Idempotency** [K2]. `cork_prepare_*` and `cork_submit` take a `clientRequestId` — reuse for
  retries, fresh for genuinely new requests. Artifacts are deterministic for
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
(not published) → bundled copy served silently; a transient failure → bundled copy + a
`config_fetch_failed` warning. Either outcome is negative-cached 10 min. `CORK_CONFIG_NO_FETCH=1`
skips fetching (tests set it). Never hand-edit addresses in TS —
edit `cork-defaults.json`.

## Discoverability: examples, maturity, teaching errors

- **Worked examples**: `packages/schemas/src/examples.ts` (`TOOL_EXAMPLES`, all test-validated) —
  every tool description advertises one; capabilities search/topic return the full set. The demo
  poolId/account are the canonical fixtures; `experiments/fork-harness/script/DeployDemoPool.s.sol`
  deploys that pool on a Tenderly virtual mainnet (`--unlocked --sender 0x7CcC…89D9`).
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
parameters, outcome, efficiency, recovery. **Never tune descriptions/examples
against the 5 held-out tasks.** Surface-change workflow: edit → run Layer B → regenerate the drift
fixture.

## Layout

`packages/schemas` (zod v4 source of truth + registry, examples/maturity/teaching) · `packages/core`
(math ports, chain reads, Bundler3 encode/decode, remote config, `runTool` dispatch — handlers
split per tool under `src/handlers/`) · `packages/mcp` (stdio server) · `packages/cli` (commander
projection) · `evals/` (agent-eval suite). Tests: `packages/core/test/` (unit +
`fork-parity`/`bundle-sim` vnet suites), `packages/mcp/test/` (integration + surface-drift gate),
`packages/schemas/test/`.
