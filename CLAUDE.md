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
    plus flags named after the schema's own fields (`ch query registry-assets --chain-id 42161`).
    Flags override keys in a JSON blob. Spelling is normalised, so `--chainid`, `--chain-id` and
    `--chainId` are one flag; object-valued fields (`--filters`, `--params`) take a JSON string.
    Flag typing is schema-judged ($refs resolved): $ref'd string fields are plain flags
    (`--account 0x…`), union-typed fields accept a raw string when JSON parsing fails
    (`--data 0x…`), and object-ONLY fields reject non-JSON loud (`invalid_json`) — mutation-probed
    (`cli-*` probes), positionals pinned by test. Every discriminated action/kind is ALSO a
    subcommand with the variant's fields flattened to flags and a variant-scoped --help/--explain
    (`ch prepare pool exercise --pool-id … --cst-shares-in 1000e18`, `ch submit rfq-open …`,
    `ch track verify market-ref …` — English order works: a positional-then-variant spelling is
    shuffled internally, and options after the variant that the parent also declares are merged
    back). The discriminator always comes from the subcommand name (a blob cannot override it).
    Amount fields (digits-only pattern) take exact sugar on FLAGS only: `1000e18`/`1_000` expand
    via integer math; fractional remainders are refused (`invalid_amount`); blobs stay the exact
    wire form. `--chain-id` also takes network names (mainnet/ethereum/arbitrum/base/sepolia). Help
    displays kebab flag spellings (`--client-request-id`); an --action/--params blob given WITH a
    variant subcommand merges as the base (variant flags override, discriminator still injected);
    a mistyped action gets a levenshtein did-you-mean refusal pre-parse. The 13 pool actions +
    `fill` are ALSO top-level verbs (`ch exercise …` = `ch prepare pool exercise …`, `ch fill …`
    = `ch prepare order taker-fill …`; authority ops stay namespaced). On `ch query`, every
    KNOWN_FILTER_KEYS key is a first-class flag merging INTO `filters` (`--pool-id`, `--rfq-id`,
    `--status` …; flags override the same key in a `--filters` blob; a key colliding with a
    top-level field, i.e. `mode`, stays blob-only), and the resource accepts the singular `rfq`
    for `rfqs` plus the pre-rename `market-predict` for `derive-market` (blobs stay wire-exact;
    the old wire value gets a renamed-to teaching error via RENAMED_VALUES in teaching.ts). All mutation-probed (`cli-variant-*`, `cli-amount-*`, `cli-chain-name-wrong`,
    `cli-verb-*`, `cli-filter-flag*`, `cli-resource-alias-dropped`).
  - **Output** is prose by default, JSON on request: a bare `--json`, or `CORK_JSON=1`. Passing input
    as `--json '<object>'` also yields JSON, which is why every pre-existing scripted example works.
    Results/errors render via `packages/cli/src/render.ts`.
  - `--explain` prints a plain-English contract (description + per-parameter breakdown, `$ref`
    resolved, oneOf/anyOf variants unfolded) and exits; the JSON schema is opt-in via `--json` or
    `CORK_EXPLAIN_JSON=1`. Renderer: `packages/cli/src/explain.ts`.
  - `--rpc-url <url>` overrides RPC resolution for chain-backed commands.
- Typecheck / test: `bun run typecheck` · `bun run test` (network suites self-skip without env) ·
  `bun run test:unit` (offline only) · `bun run test:live` (vnet/live suites; need `CORK_TEST_RPC` / `CORK_RPC_LIVE=1`) ·
  `bun run test:mutation` (scripts/mutation-probes.ts: applies each catalogued semantic mutant to the
  bytes-critical core logic — struct/tuple field order, enum ordinals, bit flags, hash inputs,
  rounding directions, boundary comparators, storage-slot math — and FAILS unless the focused
  offline suite catches every one; also fails on pattern rot so probes can't silently stop aiming
  at moved code. When a mutant survives: write a killer test, keep the probe) ·
  `bun run test:prop` (pinned-seed fast-check harnesses under experiments/proptest — numeric-port
  revert-parity + Fusion pricing invariants; CI-gated in the private tree, loud-skipped in the
  public port which carries no experiments/. Assert only properties you can argue mathematically,
  and keep seeds pinned so a run is reproducible evidence)

## Install / verify as an MCP server

Repo: `github.com/Cork-Technology/cork-cli` — the **public tree**, which is this repo with `notes/`,
`experiments/` and `rfc/` filtered out and `CORK_DEFAULTS_URL` repointed; work lands here first and
is ported there. `git clone git@github.com:Cork-Technology/cork-cli.git`,
then from the repo root:

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
| `cork_capabilities` | Discover/introspect: list tools, `search` by keyword, `topic` for docs, `topic:"verify"` re-derives deployed addresses via CREATE2. **Doc topics** resolve before tool names: `topic:"signing"` (aliases `execute`/`broadcast`/`sign-and-broadcast`) is the sign-and-broadcast guide for prepared artifacts — the same constant (`DOC_TOPICS` in packages/schemas) feeds the MCP server `instructions` string and the HTTP `/docs/signing` page, so the three surfaces cannot drift. Doc topics also rank in `search` ("sign", "broadcast" surface the topic card). Start here when unsure. | 1 |
| `cork_query` | **State reads** — live chain: market, account-state, pool-whitelist, protocol-config, registry-assets/registry-oracle/registry-recipes/registry-denominations/registry-feeds (MarketRegistry 2.1.0 views, 42161: assets carry two named source slots priceSource/navSource + token self-description; recipes are approved CONTRACT ADDRESSES that self-report source/description/live constants — no modes, no bands; oracles are mode-keyed price|nav per pair PLUS fixed-rate oracles keyed on `filters.rate`; denominations are exact-bytes labels where labelHash is the identity; feeds are directed conversion edges with live answers), derive-market (derive a market that may not exist yet — recipe + off-chain-resolved constraint via recipe.resolve, LOCAL pool id, cST/cPT via state-override simulation, and pool existence; needs `filters.collateralAsset+referenceAsset+expiry+recipe` [mode = deprecated sugar; optional args/rate/rateOracle]; the derivation a JIT LOP fill runs, chain-native, 42161; identity is PINNED once an order carrying the constraint is signed). Venue-backed (centralized): markets, orderbook, fills, limit-order-markets, flows (rollover orders/fills/contracts via `filters.kind`), rfqs (RFQ discovery feed, default `state=open`; `filters.rfqId` for one record with all answers; `withAnswers` embeds answers in the list). Event-derived: whitelisted-addresses (CURRENT whitelist membership replayed from WhitelistManager events over HyperSync, needs ENVIO token; rows live-view verified when an RPC resolves; `filters.poolId` scopes to one pool, global rows ride along); the markets/fills/flows subset also serves `full-decentralized` mode (HyperSync) — those reads then merge a recent RPC event tail (blocks past HyperSync's archive head, scanned over the regular resolved RPC with the same address/topics) so time-sensitive results reflect chain head, not just the indexer; the merge is disclosed via a `data.liveTail` block and a `live_tail_merged`/`live_tail_unavailable` warning. Venue lists are **bounded traversals**: `data.pagination.{complete,pagesFetched,nextCursor,reason}`; a partial read is `ok`+`pagination_incomplete` (evidence, not the full set), a repeated venue cursor is `conflict`. `cursor`/`pageSize`/`maxPages` control it. | 1 |
| `cork_compute` | **Deterministic math** over verified state — swap/unwind rate, rollover premium floor, worst-case impairment floor, resolve-recipe (2.1.0: a staticcall to `recipe.resolve` — THE step that produces the constraint a JIT order carries and signs; needs recipe+ca+ref, optional args/rate/rateOracle; the pre-2.1.0 percentage-band math survives behind `legacy:true` + the deprecation gate), dutch-auction-price (1inch Fusion v3.1 current price, pure local from the order's own extension bytes [K3]; pin with `at.timestamp`, `baseFeeWei` omitted = upper bound). NOT raw reads, NOT byte-building. | 1 |
| `cork_decode` | Bytes → labeled JSON, all five kinds live: calldata (recursively unwraps Bundler3 multicall), **tx** (a SIGNED raw transaction, legacy RLP or typed envelope — the validate-before-broadcast step: recovered signer, to/value/chainId/nonce/gas, the target named against known Cork deployment addresses with a plain `unknown_target` warning otherwise, and the inner calldata decoded to the same labeled legs + summary as calldata; a supplied chainId contradicting the tx's own is a `conflict` `chainid_mismatch` — the signature commits to the tx's chainId), order (LOP v4 hex tuple or JSON fields → makerTraits breakdown + recomputed orderHash; supplied hash/extension cross-checked → `conflict` on mismatch; a Fusion auction extension gets a `fusion` label and a Cork JIT extension gets a `jit` label unpacking what a fill commits to (NOT exclusive: a composed auction+JIT order shows both) — adapter, recipe + carried constraint on 2.1.0, mode string on the legacy generation, permit count — so a taker can inspect a venue row before signing anything), event (one log → named args against the source-verified ABI set; unverified layouts labeled raw), receipt (every log labeled). Reconstructs from bytes; never trusts a supplied parse [K3]. | 1 |
| `cork_prepare_phoenix` | Build an **unsigned** Bundler3 bundle for any of the 13 adapter actions. Auto-adds funding legs. Also the token-authority ops: authority-onboard/authority-revoke build an unsigned DIRECT ERC-20 approve tx (onboard amount omitted = unlimited; revoke zeroes it) — owner-signed, not a bundle leg. Returns bytes for later signing — executes nothing [K1]. `forSelf: { adapter }` emits the action as a DIRECT call to an integrator-deployed Cork ForSelf adapter instead (the *ForSelf twin, e.g. exercise → exerciseForSelf — Cork-Technology/cork-periphery): no Bundler3, no funding/sweep legs, receiver/owner must equal `account`, allowances go to the adapter (`for_self_artifact` discloses the matrix); for parameter-blind session-key wallets (the Zyfai shape). Every result carries `data.execution` (see envelope conventions). | 2 |
| `cork_prepare_orders` | Build **unsigned** signable artifacts: 1inch maker-order (incl. extension/JIT orders, and `auction` — a Cork-native DECAYING-PREMIUM order using the deployed Fusion settlement as a pure amount getter: no postInteraction, fills stay permissionless, the signed takingAmount is the floor; composes with jitMarket in one salt-bound extension) / cancel; **finalize-maker-order** (reconstruct exact bytes, then verify the external signature — EOA via ecrecover, CONTRACT makers (ERC-1271, e.g. a Zyfai Safe) via the same isValidSignature staticcall the fill performs — and emit a verbatim `cork_submit` artifact carrying `makerAccountType`; never signs); **taker-fill** (fetch + locally re-hash a resting venue order, emit canonical uint256-tuple fill calldata, unsigned; an AUCTION-priced resting order is auto-detected and the default slippage cap becomes the curve's CEILING — a floor-based cap would revert TakingAmountTooHigh for the whole decay window — with current/ceiling/floor prices reported in `data.auction`; `interaction` packs a TAKER interaction — `adapter ++ extraData`, length at takerTraits bits 200-223 — which is how an underwriter lifts a BUY-cover order, the JIT adapter's takerInteraction minting the cST after the maker asset moves and before the taker asset is pulled; `forSelf: { adapter, poolId }` instead emits the fill as a call to an integrator-deployed ForSelf adapter's fillOrderForSelf — target structurally forced to the caller, taker interactions impossible, allowance to the ADAPTER — with a chain liveness pre-flight that refuses rows whose LOP invalidator says filled-or-cancelled, `status_mismatch` [K7]); and the rollover ERC-7683 OrderData (CorkSettler domain, intent hash recomputed locally). maker-order/taker-fill/cancel/rollover-intent results carry `data.execution` (finalize-maker-order does not — it already emits a relayable artifact + `caller_signed_artifact`). | 3 |
| `cork_track` | Verify a resource against chain, simulate frozen prepared bytes (eth_call dry-run: wouldRevert + reason BEFORE signing), or reconcile a receipt/order to a lifecycle state. Chain outranks indexer; disagreement → `conflict` [K7]. | 2 |
| `cork_prepare_market` | Unsigned oracle-infrastructure txs against the 2.1.0 registry: deploy-oracle = MarketRegistry.deploy(ca, ref, mode) (mode-keyed price|nav, default price) and deploy-fixed-oracle = deployFixedRateOracle(rate) (keyed on the RATE, CREATE2-salted — the oracle a FIXED order's rateOverride produces). Both permissionless + idempotent; Arbitrum. Both results carry `data.execution`. Markets themselves are created JIT by LOP fills — `cork_prepare_orders` maker-order + `jitMarket`. | 4 |
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
  SHIPPED 2026-08-05 as `cork_prepare_orders` maker-order `auction`; notes/fusion-integration-plan.md). dutch-auction-price was activated 2026-07-28 (pure local
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
| `unknown_topic` / `no_lop` | Capabilities topic not found (neither a tool nor a doc topic — the message lists the doc topics) / no 1inch LOP deployment for the chain. |
| `unknown_target` | Informational on `ok` decode kind:"tx": the signed tx's `to` is not a known Cork deployment contract on that chain (expected for a token approve — the target is the TOKEN — otherwise identify before broadcasting), or the tx has no `to` at all (contract creation, which no Cork prepare path produces). |
| `chainid_mismatch` | On `conflict` (decode kind:"tx"): the supplied chainId contradicts the transaction's own — the signature commits to the tx's chainId, so those bytes cannot land on the requested chain. |
| `receipt_not_found` | txHash unknown/pending at the RPC (a normal outcome, not a failure). |
| `rpc_fallback` | Informational on `ok`: the default RPC was down, a chainlist public endpoint served the read. When the endpoint died MID-CALL and the failover client switched, the message says so and warns that reads earlier in the same result may have been served by the previous endpoint (possibly at a different block height) — emitted even when the heal landed back on the default tier. |
| `funding_needs_rpc` / `manual_funding` / `owner_managed_funding` | Informational on `ok` prepare results: why funding legs were omitted. |
| `recipe_not_found` | 2.1.0: the given recipe ADDRESS is not approved on the registry (`isRecipe` is the only membership gate), or a deprecated `mode` name has no configured recipe hint — the message teaches the address-based path. On the gated legacy path: the old registry's mode string is unknown. |
| `recipe_refused` | The recipe's `resolve` staticcall reverted for this input — the message names the contract's own error (e.g. `MalformedAdditionalData`: the liquidity recipe needs `args = abi.encode(anchorRate)` while its oracle is undeployed; `RateOracleNotDeployed`: the fixed-rate recipe needs its oracle deployed first). |
| `denomination_not_found` / `feed_not_found` | registry-denominations/-feeds single lookups: no such label (labels are EXACT BYTES, case-sensitive) / no such directed base→quote feed (direction matters). |
| `deprecated_gated` | On `unavailable`: a DEPRECATED feature (e.g. the pre-2.1.0 registry generation via `legacy:true`) was invoked without the opt-in — nothing ran; the message names the replacement and the unlock (`CORK_ENABLE_DEPRECATED=1`, CLI `--enable-deprecated`). |
| `deprecated` | Informational on `ok`: the opt-in is set and a deprecated path DID run — its answers do not describe the current world. |
| `deprecation_notice` | Informational on `ok`: still-supported convenience sugar was used (e.g. `mode` mapped to a configured recipe address) — it will be removed later; the message teaches the new shape. |
| `constraint_window_notice` | Informational on JIT prepares (2.1.0): staleness is guarded by `recipe.verify` at fill time, not a moving pool id — a live rate outside the carried constraint's window reverts fills `RecipeRejectedConstraint` until a fresh constraint is resolved and signed. |
| `decaying_price_notice` | Informational on `ok` maker-order + `auction` prepares AND taker-fills of auction-priced resting orders: the taker price DECAYS from initialRateBump (base 1e7) above the signed takingAmount down to that signed floor over the auction window — the floor is the maker's WORST case, not the expected price. On the fill side the default cap is the curve ceiling (artifact valid at any broadcast time); an explicit cap below the current decayed price additionally warns `would_revert` (a resting-bid strategy if intended). The venue's static-premium listing convention for decaying orders is an open question; takers re-price with `cork_compute dutch-auction-price` + simulate before filling. |
| `oracle_already_deployed` / `oracle_not_deployable` | Informational on prepare_market: the pair's oracle exists (tx is a safe idempotent no-op) / the deploy simulation reverted (unregistered asset or missing feed — sending would revert). `oracle_not_deployable` is also returned by `cork_query derive-market` (ok, oracle-only) when the pair can't get an oracle. |
| `oracle_not_deployed` | Informational on derive-market AND JIT prepares: the recipe's oracle is not deployed — and does not need to be. The identity is derived against the PREDICTED oracle address (the fill runs the same permissionless deploy inside its own transaction), the constraint resolves from the recipe's anchor fallback, and the share simulation prepends that deploy — so derive-market returns the FULL identity where the HTTP endpoint still nulls market/shares. Caveat: a source re-registration before the fill shifts the predicted address → OrderNotForPool. |
| `rate_drift_notice` | Informational on `cork_query derive-market` while the pool doesn't exist: the prediction is conditioned on TODAY's oracle rate and drifts stepwise — but in 2.1.0 the pinning moment is SIGNING, not pool creation: an order carrying the constraint fixes the identity, and staleness then guards via `recipe.verify`. (On the gated legacy path the old fill-time-drift semantics still apply.) |
| `jit_side_mismatch` | JIT prepare: NEITHER order side is the derived pool's cST — the fill WILL revert; set maker/takerAsset to the predicted cST in the result. |
| `stale_share_prediction` | Decorates a `jit_side_mismatch` with the WHY, when knowable: the order side ALREADY hosts another pool's live share contract — a nonce-based cST prediction consumed by an interleaving pool creation (cST/cPT deploy via plain CREATE, first-come-first-served; fork-proven 2026-08-04 on the venue's first new-generation batch). The order can never fill; re-sign against a fresh prediction. Best-effort — degrades silently without an RPC. |
| `roles_not_granted` / `adapter_binding_mismatch` | JIT adapter pre-flight: controller roles missing (signable but unfillable) / the volatile adapter address's on-chain bindings disagree with config (conflict — refresh cork-defaults.json). `adapter_binding_mismatch` is ALSO raised for a caller-supplied ForSelf adapter whose CORK()/LOP() views disagree with the chain's deployment config (or don't answer at all), or whose `WHITELIST()` view (caller-gate generation, 2026-08-07+) names a different WhitelistManager than config — the caller is about to grant that address an allowance, so no artifact is built. A reverting `WHITELIST()` is NOT a conflict: it identifies a legitimate pre-caller-gate deployment, and the whitelist pre-flight adapts its subjects/wording to the detected generation. |
| `would_revert` | Informational on `ok` simulate results: the frozen bytes revert at current state (reason included) — do not sign/broadcast as-is. Also on taker-fill of an auction order when the caller's explicit cap sits BELOW the current decayed price: the fill reverts until the price decays under the cap (a resting-bid strategy if intended). |
| `share_prediction_unavailable` | JIT prepare: eth_simulateV1 unsupported — predicted cST unknown; verify the order side + permit token yourself. |
| `band_parity_mismatch` | On `conflict` (legacy resolve-recipe only — the band math left the 2.1.0 public surface): local applyBands port disagreed with the chain view — trust the chain, report the bug. |
| `pool_expired` | Informational on `ok` prepare_phoenix results: a pre-expiry action (deposit/swap/…) against an expired pool — the bundle builds but would revert on-chain; withdraw/withdraw-other/redeem are the post-expiry paths. |
| `sweep_back` | Informational on `ok` prepare_phoenix results: the bundle ends with sweep-back leg(s) returning the unspent remainder of a funded **cap** to `account` (see Sweep-back legs below). Names the swept tokens. Each sweeps the adapter's FULL balance of that token, so it also returns any residual an earlier bundle abandoned there — which was already takeable by anyone. |
| `sweep_back_skipped` | Informational on `ok` prepare_phoenix results: a sweep was warranted but not built because the target would revert `erc20Transfer` (the zero address, or the adapter itself). Funding legs are still built — the residual stays on the adapter and is skimmable. Fix `account`. |
| `pool_paused` | Informational on `ok` prepare_phoenix results: the action is paused and the bundle would revert `EnforcedPause()`. Either the CorkPoolManager's GLOBAL pause (blocks every action on every pool) or the pool's own `getPausedBitMap` bit for this action's family (bit0 deposit/mint, bit1 swap/exercise/exercise-other, bit2 withdraw/withdraw-other/redeem, bit3 unwind-deposit/unwind-mint, bit4 unwind-swap/unwind-exercise/-other). Both can fire at once. |
| `not_whitelisted` | Informational on `ok` prepare_phoenix results: a gated pool checks **two** addresses and this one fails. Emitted once per failing address — see the whitelist note below. Generation-aware on the forSelf route: caller-gate adapters (cork-periphery, 2026-08-07+) enforce `isWhitelisted(poolId, msg.sender)` themselves, so the ACCOUNT is checked and the shared-adapter blast-radius caveat is dropped (one whitelist add per calling Safe + one for the adapter); pre-gate adapters keep the old wording and never accuse the account (nothing on-chain checks it). Also on forSelf taker-fills when the caller-gate adapter's post-fill check would revert `CallerNotWhitelisted`. |
| `digest_mismatch` / `marketid_mismatch` / `create2_mismatch` | On `conflict`: what failed verification. For `cork_submit rollover-order`, `digest_mismatch` means the payload's intent does not hash to its own `rolloverIntentHash` (not relayed) or the venue computed a different orderDigest. |
| `venue_rejected` / `venue_unreachable` / `venue_rate_limited` | The venue (api-phoenix) refused (4xx; HTTP status + message) / couldn't be reached OR answered 5xx (transient — retry; check `CORK_VENUE_URL`); after 3 consecutive transport failures the per-host breaker fails fast for 30 s and the message names the remaining cooldown / rate-limited (per-user open-order caps; the venue's 429 `Retry-After` is surfaced as "retry after Ns" when sent). Idempotent venue GETs get ONE silent transport retry; POST relays never do ([K2] retries are the caller's, keyed by clientRequestId). |
| `venue_conflict` | On `conflict`: venue 409 — same id/digest already stored with a DIFFERENT payload. Use a fresh `clientRequestId` for a genuinely new request. |
| `order_not_found` | Reconcile/lookup: the digest is unknown to the venue — a normal outcome for a never-posted order. Also `cork_prepare_orders` taker-fill when the orderHash is absent from a COMPLETE orderbook traversal. |
| `pagination_incomplete` | A bounded traversal did not exhaust the set — venue lists (`reason`: `metadata_absent`/`cursor_absent`/`max_pages`, with a `nextCursor` to resume), HyperSync scans that hit the page bound, registry getAssets/getRecipes truncation, and track-reconcile book/fills walks. On `ok` it's honest partial evidence; on `conflict` it's `cursor_repeated` (venue self-contradiction) or an incomplete search that would otherwise claim "not found" (taker-fill, reconcile). |
| `unsigned_artifact` | Informational on `ok` taker-fill: unsigned fill calldata only — simulate (`cork_track` simulate) and set the taker-asset allowance before signing/broadcasting (to the LOP on the raw path, to the ADAPTER in forSelf mode). |
| `for_self_artifact` | Informational on `ok` forSelf-mode prepares (`cork_prepare_phoenix` + `forSelf`, taker-fill + `forSelf`): the artifact calls an INTEGRATOR-deployed Cork ForSelf adapter — outputs are structurally delivered to the calling account (no receiver parameter exists), the adapter is custody-free (pulls, spends, sweeps back in one tx), and every allowance is granted to the ADAPTER itself. Carries the per-action allowance matrix in `data.forSelf.allowances`. |
| `caller_signed_artifact` | Informational on `ok` finalize-maker-order: the signature was recovered/verified, not created [K1] — EOA makers via ecrecover; CONTRACT makers (a Safe, the Zyfai shape) via the same ERC-1271 `isValidSignature` staticcall the fill performs (needs an RPC; code detection decides the path, and `submitInput.makerAccountType` carries the result). Pass `submitInput` verbatim to `cork_submit` after your policy gate admits the `signedArtifactDigest`. |
| `signature_or_reconstruction_mismatch` / `prepared_context_mismatch` | On `conflict`: the signature doesn't recover to the order's maker/user against the locally recomputed hash — raised by finalize-maker-order AND by `cork_submit` lop-order (EOA makers) and rollover-order, which now recover every signature before relaying [K3] / the reconstruction doesn't match the prepared hash / salt↔extension unbound — OR the prepared clientRequestId·chainId·verifyingContract disagrees with the request. Not relayable. |
| `invalid_service_response` | taker-fill: the venue row for the requested order failed shape validation (malformed signed order) — no fill bytes built. |
| `rfq_not_found` | `cork_query rfqs` with `filters.rfqId`: the id is unknown to the venue — a normal outcome for a never-posted or mistyped id. |
| `asset_not_found` | `cork_query registry-assets` with `filters.address`: the address is not a registry-approved asset on that chain. |
| `settler_mode_mismatch` | rollover-intent: the chosen settler's on-chain mode gate would make the order unfillable (ExactSettler rejects `allowPartialFills:true`; PartialSettler requires it). The message names the right settler. |
| `settler_not_recognized` / `invalid_order_terms` | Informational: settler isn't a configured Cork settler — also used by dutch-auction-price when the Fusion settlement decoded from the extension isn't in the known set (priced as v3.1, verify independently) / order terms are incoherent (venue would reject). `invalid_order_terms` also covers a JIT maker-order fee above the 5% cap and a structurally-non-Fusion order handed to dutch-auction-price (well-formed values that break a protocol rule → envelope, exit 3, not thrown). |
| `invalid_pair` | On `unavailable` (`cork_query derive-market`): collateralAsset and referenceAsset are equal — a market is a pair of distinct assets. A domain-rule violation returned as an envelope (exit 3), not a thrown schema error. |
| `status_mismatch` | On `conflict`: the venue's lifecycle disagrees with the chain — chain outranks indexer [K7]. Track reconcile (settler `orderStatus()`), and taker-fill's liveness pre-flight: a venue row whose on-chain LOP invalidator already reads filled-or-cancelled yields NO fill bytes (observed live 2026-08-06 — the book listed only dead sell rows). Best-effort: no RPC or a failed read builds as before. |
| `venue_reported` / `logs_unavailable` / `logs_range_limited` | Track verification gaps, disclosed: no RPC for the status leg / no logs endpoint (set `ENVIO_API_TOKEN` or `CORK_LOGS_RPC_URL`) / the logs endpoint refused the historical range. |
| `hypersync_unavailable` | full-decentralized mode: no HyperSync token, unsupported chain, or the napi client can't load on this host. Envio env vars: `ENVIO_HYPERSYNC_TOKEN` (query API) and `ENVIO_HYPERRPC_TOKEN` (logs RPC) with `ENVIO_API_TOKEN` as shared fallback for both — tokens verified interchangeable across products in practice, so one shared token also works. |
| `live_tail_merged` | Informational on `ok` (full-decentralized reads): recent events beyond HyperSync's archive head were merged from a live RPC tail — the count reflects chain head. The merged span is in `data.liveTail` (`fromBlock`/`headBlock`/`merged`). |
| `live_tail_unavailable` | Informational on `ok` (full-decentralized reads): the live-tail RPC scan couldn't run (no RPC resolved, or the endpoint refused the block range) — results reflect the HyperSync archive only; blocks after its head may be missing. Non-fatal; the backfill still stands. |
| `premium_scale_suspect` / `premium_scale_mismatch` | Numbers-contract tripwires (fraction "0.041" vs percent 4.1): suspicious sub-0.1% premium (warned, relayed) / >=10x divergence from the cited quote_ref — the BOOK's own acceptance band (wide enough for an honest re-price, narrow enough that a scale mistake cannot pass), decided in EXACT integer arithmetic (conflict, NOT relayed; enforcing the venue's band locally fails the bad relay early with teaching). |
| `quote_ref_unverifiable` | On `conflict` (`cork_submit lop-order`): the cited RFQ option has no parsable positive premium, so the scale cross-check cannot run — NOT relayed (cite a valid option or drop quoteRef). |
| `listing_traits_mismatch` | On `conflict` (`cork_submit lop-order`): the venue-listing fields (expiry/nonce/allowsPartialFills) contradict what the SIGNED makerTraits encode — derived from the signature, never trusted [K3]; NOT relayed. |
| `invalid_state` | A LOCAL computation/domain failure (C11), distinct from `chain_read_failed`: the on-chain state or derived values violate a domain rule the port enforces (e.g. a 100% rateMin band). Also informational on `ok` impairment-floor when the worst rate collapses to 0 (maxReferencePerCst null = unbounded). |
| `reserved_field_ignored` | Informational on `ok`: an accepted-but-reserved field was validated and then ignored — results are NOT pinned by it. `cork_compute at.timestamp` is reserved for the BLOCK-anchored kinds only; dutch-auction-price HONORS it (a decaying price is clock-anchored). |
| `makingamount_exceeds_order` | Informational on `ok` (`cork_compute` dutch-auction-price): the requested `makingAmount` is larger than the order's own `makingAmount`, so the quoted `takerPays` is a linear extrapolation of an amount no fill can consume (1inch clamps every fill to the remaining size). Quote at most the order's makingAmount for a realizable cost. |
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
re-serialized JSON. Absolute-timestamp inputs (`UnixSeconds` fields and derive-market
`filters.expiry`) are bounded to year 2100 — a `Date.now()` milliseconds paste is rejected with
teaching instead of creating a far-future deadline.

Field-naming conventions, uniform across every read: the two share tokens are always
`corkSwapToken` (cST) and `corkPrincipalToken` (cPT) everywhere; the pair's rate-oracle wrapper is
reported under one nested `oracle` object (`.address`/`.deployed`/`.deployable`, plus `.rate` on
derive-market) by `registry-oracle`, `derive-market`, and `cork_prepare_market` alike — the Market
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
`full-decentralized` — with a best-effort **live-tail RPC merge** for freshness: after the HyperSync
backfill, blocks past its archive head are scanned over the regular resolved RPC and merged, so a
lagging indexer doesn't hide recent events (gated on a complete backfill; degrades to a
`live_tail_unavailable` warning, never a failed read). `cork_query` `cursor`/`pageSize`/`maxPages`
are now honored (bounded venue traversal). No schema field is accepted-but-reserved any more:
`cork_prepare_phoenix` `account` became load-bearing with the sweep-back legs (it is the recipient
of the returned residual), so set it to the address that actually funds the bundle. (`cork_compute`
`at.timestamp` is honored by dutch-auction-price and reserved only for the block-anchored kinds.)

**Maker-order nonces are per-request, and that matters.** Cork-built orders set
`allowMultipleFills: false`, so they always live in the 1inch **bit** invalidator — and
`BitInvalidatorLib.checkAndInvalidate` keys on `(maker, nonce)`, **not** on orderHash. The nonce is
therefore derived from `clientRequestId` (40-bit slot, so retries stay byte-identical [K2] while
distinct requests get distinct bits). Two orders sharing a `clientRequestId` would share one
invalidator bit, and filling or cancelling either would revert the other with `BitInvalidatedOrder`
— so give every order you want live at the same time its own id. `cork_prepare_orders maker-order`
returns the derived `nonce`; the venue listing must carry that exact value or `cork_submit` refuses
to relay with `listing_traits_mismatch`.

**`data.execution` — the completion pointer on every prepare result.** Every unsigned artifact
names its own path to execution (typed once in `packages/schemas/src/doc-topics.ts`):
`{ kind: "eth-transaction"|"eip712-typed-data", sign: "eth_signTransaction"|"eth_signTypedData_v4",
then: string[], reference: 'cork_capabilities topic:"signing"' }` — `then` is the ordered next
steps with exact tool names (Family A: simulate → sign client-side → `cork_decode kind:"tx"` →
`eth_sendRawTransaction` via YOUR OWN RPC → track txHash; Family B: sign typed-data →
finalize-maker-order → submit, or sign → submit rollover-order). Emitters: prepare_phoenix (all
13 actions + authority ops), prepare_orders (maker-order, taker-fill, cancel, rollover-intent —
NOT finalize-maker-order), prepare_market (both). There is deliberately NO broadcast tool: clients
broadcast through their own endpoint after validating the signed bytes with decode kind:"tx".

**Bundle summary.** `cork_prepare_phoenix` and `cork_decode` (kind `calldata`) both return
`summary: string[]` — one numbered plain-English line per leg, in execution order, so a signer can
check intent against the bytes *before* signing. Funding, action, and sweep legs each get a line;
the `uint256.max` sentinel reads as "the entire remaining balance" rather than a 78-digit number;
addresses are named where known (`you`, `the adapter`, and token roles on the prepare path, which
has read the pool). A Cork leg names its `receiver`/`owner`, so a redirected payout is visible
rather than buried. Legs that would change what signing means are flagged inline — `skipRevert`
("MAY FAIL SILENTLY") and any non-zero `value`. An undecodable leg is labelled `UNREADABLE … Do not
sign until you have identified it`, never glossed. Renderer: `packages/core/src/bundle/summary.ts`.

**Prepare pre-flight guards.** Every chain-backed `cork_prepare_phoenix` call (both the funded path
and `pre-funded`) runs one batched read of the conditions that make a well-formed bundle revert:
expiry, pause, and whitelist. All are **build-and-warn** — the bytes are still returned, clearly
labelled — and each degrades to silence if its view is unavailable, so byte-building never becomes a
hard error. Guard logic lives in `packages/core/src/bundle/preflight.ts`.

**A gated pool checks TWO addresses, and they differ.** `CorkAdapter`'s own `onlyWhitelisted`
modifier checks `initiator()` — *you* — while `CorkPoolManager._onlyWhitelisted` checks
`_msgSender()`, which for a bundled call is the **adapter**, not you (there is no ERC-2771 forwarding
anywhere in the contracts, so `_msgSender()` is plain `msg.sender`). **Both** must be whitelisted for
a bundle to execute. This is why checking only your own address — the natural reading of `cork_query
pool-whitelist` with `filters.account` — can show a false green: a whitelisted user still cannot
reach a gated pool through Bundler3 until the adapter itself is whitelisted. The pre-flight checks
both and reports each failure separately. (`isWhitelisted` returns true for pools with no whitelist
enabled, so an ungated pool never warns.)

**Sweep-back legs [F13].** Auto-funding (`erc20-approve`/`permit2`) moves the caller's slippage
**cap** into the adapter for every `max*` input, but the pool consumes only the true amount. The
delta isn't merely stranded — `CoreAdapter.erc20Transfer` is `onlyBundler3` yet never checks
`receiver == initiator()`, and `Bundler3.multicall` is public, so anyone can take it in a later
block. Every capped leg therefore gets a matching `erc20Transfer(token, account, uint256.max)`
appended **after** the action leg, returning the remainder to `account`. This covers the burn-side
caps (`withdraw`, `withdraw-other`, `unwind-deposit`) as well as the exact-OUT value-in ones. Exact
inputs (`deposit`, `redeem`, `unwind-swap`, `unwind-mint`) strand nothing and get no sweep;
`pre-funded` never sweeps, because the caller owns that balance. The result reports
`sweepBackLegs: n` alongside `fundingLegs: n`, and a zero residual is a no-op rather than a revert.

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
→ **built-in default** (committed endpoints for mainnet + Arbitrum, retried with jittered backoff
behind a per-endpoint circuit breaker) → **chainlist.org fallback** (public chains 1/42161/8453/11155111:
fetch candidates just-in-time, latency-probe, verify chainId, pick fastest). Chosen endpoint + breaker
state are cached in-process and on disk (`~/.cache/cork-helper-cli/`, override `CORK_RPC_CACHE_FILE`;
writes are temp+rename atomic — the MCP server and concurrent CLI runs share the file safely).
A chainlist fallback adds an `rpc_fallback` warning to the envelope. Resilience internals (2026-08-06):
automatic (default/chainlist) clients fail over **in-call** — a transport-class read failure feeds the
breaker, re-resolves once (`attempts:1`), and retries the request on whatever resolves, with the
`ResolvedRpc` mutating in place so `rpc_fallback`/`provenance.rpc` (evaluated at envelope construction)
disclose the endpoint that actually served; explicit URLs never fail over (your config, your call).
Deployment kill-switch: `CORK_RPC_NO_FAILOVER=1` disables the in-call failover wrapper (plain
clients, everything else stays on) — an env flip on the CVM beats an image rebuild if the wrapper
ever misbehaves. Concurrent automatic resolutions for one chain are single-flighted (one probe pass). The breaker state
machine itself is ONE shared module (`packages/core/src/breaker.ts`, mutation-probed) — the venue
transport uses the same machine per-host (3 transport failures → open 30 s → fail fast with the
cooldown named in the `venue_unreachable` message), plus one silent immediate retry for idempotent
venue GETs (never POSTs — relays retry only under the caller's [K2] idempotency) and 429 `Retry-After`
surfaced in `venue_rate_limited` messages. The HTTP server exposes `/readyz` — a 200 always
(pure tools need no upstream), machine-readable degradation snapshot (RPC breakers, venue transport,
config source; endpoint HOSTS only, never full URLs — the committed defaults embed tokens in their
paths) for ingress/monitoring to alert on.

So `cork_query` market/account-state/pool-whitelist, `cork_compute` cst-swap-rate/unwind-rate/
impairment-floor, and `cork_track` marketRef **just work** on public chains — no RPC setup. They only
return `requires_rpc` when nothing resolves (offline, or an ineligible chain like the staging vnet
49222, which needs an explicit `CORK_RPC_URL`). Set `CORK_RPC_URL` to override with a private/faster
node. Pure/config tools never touch a chain: `cork_capabilities`, `cork_decode`, `cork_query
resource:"protocol-config"`, `cork_compute kind:"rollover-premium-floor"`, `cork_prepare_*` byte-building.
(`cork_prepare_phoenix` funding-leg token resolution still needs an *explicit* RPC — offline by default,
so without one you get the bundle plus a `funding_needs_rpc` warning and `fundingLegs:0`.
ForSelf-mode prepares and the taker-fill liveness/ERC-1271 checks DO use the default-resolved RPC:
adapter-binding verification and chain-vs-venue liveness are security reads, so they run whenever
any endpoint resolves and disclose honestly when none does.)

Per-chain deployment coverage: chainId 1 and chainId 42161 are both **full** (all 5 contracts;
prepare + all reads). The 42161 set was announced 2026-07-22 and its bindings verified on-chain
(adapter `CORK()` = poolManager, adapter `BUNDLER3()` = bundler3, both settlers'
`CORK_POOL_MANAGER()` = poolManager). chainId 8453 (Base) is **partial** as of 2026-08-07: the
phoenix LIVE SHADOW stack (pool manager `0x02803B…7263`, constraintAdapter, corkAdapter
`0xfa8A…72AD`, whitelistManager — identical CREATE2 addresses on 42161, mirrored there as
`deploymentProfiles["42161"]["arbitrum-shadow"]`) — chain-verified against Filip's shadow-release
bundle and adopted into `cork-defaults.json` by explicit override of the "shadow addresses stay
out of config" thread ruling (Heri, 2026-08-07). No bundler3/registry/rollover on 8453 yet, so
bundle-funded prepares stay gated there; no pools exist on the Base pool manager yet, so market
reads honestly return `chain_read_failed` until the first JIT fill creates one. The pre-launch
Arbitrum pair (old PM `0xc2De…54AE` with 3
non-API-listed calibration pools) survives as `deploymentProfiles["42161"]["arbitrum-legacy"]`. A real mainnet pool for examples/tests:
`0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05` (current list:
`api-phoenix.cork.tech/v1/pools/`). The vnet fixture pool `0xceeb…c16a` exists ONLY on the vnet —
querying it on chainId 1 without a vnet RPC yields `chain_read_failed`, by design.

**MarketRegistry 2.1.0 (Arbitrum One only; Base has NO registry — only the phoenix shadow stack,
see per-chain coverage above).** The whole registry stack
was redeployed from scratch 2026-07-31 under a new CREATE2 salt — **every address changed**
(registry `0x47C3…752D`, adapter `0x2307…d65B`, wrapper + fixed-rate + aggregator-adapter
factories, two approved recipes, curator Safe; all verified on-chain 2026-08-03). The previous
generation is still live and is dangerous precisely because it still ANSWERS: 2.1.0-shaped calls
against it decode into plausible nonsense (empirically: `getRecipes` returns ABI offsets as
"addresses" with total=640, no revert). The tool's guard is the INTEGRATOR-sanctioned one —
`adapter.MARKET_REGISTRY()` must equal the configured registry (checked best-effort+cached on
reads, hard on prepares → `adapter_binding_mismatch` conflict). The 2.1.0 model: recipes are
approved CONTRACTS that resolve/verify their own constraints; the constraint is derived
OFF-CHAIN at signing (cork_compute resolve-recipe) and CARRIED in the order, so pool id + share
addresses are pinned at signing (no more rate-driven identity drift); oracles are mode-keyed
(price|nav) per pair plus fixed-rate oracles keyed on the rate. Scales: everything is 1e18 = 1.0
except `_PERCENTAGE`-named recipe constants and the two adapter fee fields (1e18 = 1%). The fill
path is LIVE: POOL_CREATOR_ROLE + CONFIGURATOR_ROLE were granted to the adapter on the controller
2026-08-04 (verified block 491025419; the `roles_not_granted` pre-flight now stays silent — the
gate logic lives in `readAdapterRoles` in market-registry.ts, one comparator shared by all three
call sites, mutation-probed). The OLD adapter's roles were NOT revoked, so BOTH generations are
fillable in parallel; the pre-2.1.0 flow is preserved intact behind the general
deprecation gate: `marketRegistryLegacy` config + `legacy:true` inputs + `CORK_ENABLE_DEPRECATED=1`
(CLI `--enable-deprecated`) — see `packages/core/src/deprecation.ts` for the warning-code
contract (`deprecated_gated`/`deprecated`/`deprecation_notice`). Naming vs release tag: "2.1.0"
is the GENERATION name (this prose, the architecture); the config's `contractsVersion` follows the
free-form contracts-RELEASE label the registry read API serves — relabeled to "0.3.0" ~2026-08-06
(verified full-parity same-behavior; the registry ADDRESS is the identity check, there is no
on-chain version getter to arbitrate, cf. Base's "unreleased-base-test"). The read API's sandbox
(`https://zian-b.feat.cork.tech`, override `CORK_MARKET_API`) is used ONLY in env-gated live
parity tests — never a committed runtime dependency (plus the main-push `live-smoke` CI job, whose
parity legs self-skip when the sandbox is unreachable); our reads are chain-native and were verified
wei-for-wei against it (resolve, oracles, predict), with one deliberate capability difference:
our share prediction also works pre-oracle-deploy (the simulation prepends the same permissionless
deploy the fill performs, where the HTTP endpoint returns market/shares null). The whole 2.1.0 fill
path is proven END-TO-END on an Arbitrum fork (experiments/fork-harness/test/JitOrderRoundTrip210.t.sol
+ script/gen-jit-artifact-210.ts): tool-prepared order + embedded cST permit filled through the real
1inch LOP — oracle deployed in-fill, pool created at the derived id, created cST EXACTLY equal to the
tool's prediction, JITMarketCreated decoded against our frozen layout, roleMemberSlot validated by
vm.store on the real controller — plus a negative control proving a signed out-of-window constraint
reverts RecipeRejectedConstraint.

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
(math ports, chain reads, Bundler3 encode/decode, remote config, `runTool` dispatch —
handlers split per tool under `src/handlers/`, `handlers.ts` is the thin dispatch + public re-exports) · `packages/mcp`
(stdio server) · `packages/cli` (commander projection) · `evals/` (agent-eval suite). Tests:
`packages/core/test/` (unit + `fork-parity`/`bundle-sim` vnet suites), `packages/mcp/test/`
(integration + surface-drift gate), `packages/schemas/test/`.
