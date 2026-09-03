# Changelog

All notable changes to this component. We use plain SemVer per repo. Below `1.0.0`, a breaking
change on covered surface bumps the **minor**. The covered surface for this component is: JSON
output, tool names, input schemas, and exit codes. Human-readable text and log formats are not
covered.

## [0.5.1-rc.1] — 2026-09-03

### Added

- `cork_capabilities topic:"orders"` (aliases `order-lifecycle`, `reservation`, `oco`, `one-cancels-the-other`, `ladder`, `liveness`, `exclusivity`): the ORDER vocabulary, one term per concept — the entities from request to fill; reach (open, or reserved for a FILL SENDER: the low 80 bits of the address that calls the LOP, the ForSelf adapter on a wrapper fill); fill regime (every Cork order is single-fill on the bit invalidator; partial-fill orders still spend the bit); groups (orders sharing a nonce are one-cancels-the-other; a ladder is a group whose rungs differ in price, reach, or expiry; dead-by-sibling is known to the chain and not the venue); series and epoch; price shape (fixed or decaying); provenance (cited or uncited; a quote is firm only when a live cited order backs it); a liveness table naming who knows each state first; and a synonyms table (dedicated, private, single-taker → reserved; OCO, OCA → group; dutch auction → decaying). Served through the no-args catalog, search cards, and `/docs/orders`. Doc topics resolve before tool names, so `topic:"orders"` now answers this page instead of the `cork_prepare_orders` tool card, which keeps `order`, `prepare order`, and `cork_prepare_orders`. A parity test holds each order field the topic names to the same rule in its schema description, and the reach values to the book's `BOOK_EXCLUSIVITY` list.
- `private_order` refusals and the `maker-order.allowedSender` description route to the topic (`ORDERS_TOPIC_REFERENCE`, exported by `@cork/schemas`).
- `cork_prepare_orders maker-order` takes `ocoGroup`: a one-cancels-the-other group key. The 40-bit invalidator nonce derives from the key instead of `clientRequestId`, so every order by the maker that names the same group shares one bit and the first fill or cancel of any of them retires all of them — a ladder of rungs at different prices, reach, or expiry, or one capacity answering several RFQs. Each rung keeps its own `clientRequestId` (idempotency, salt, venue 409s). The seed is namespaced, so a group named like a stand-alone order's id lands on a different bit: sharing is a choice, never an accident. Omitted, the nonce derives from `clientRequestId` exactly as before (golden-pinned). The result echoes `ocoGroup` (null = stand-alone) beside `nonce`, and an info `oco_group_notice` teaches that the venue never learns the group: a sibling left OPEN after another rung filled is dead on chain, so re-read the bit before ranking or filling. Two mutation probes pin the seed and its namespace.
- `cork_prepare_orders maker-ladder`: a LADDER of signable maker orders in one call — 2 to 32 rungs on one pool and side, each with its own price (`takingAmount`), reach (`allowedSender` or open), expiry, and optional decay (`auction`); one `jitMarket` for the ladder. A ladder is a fan-out over the maker-order path: every rung is built by re-entering the same handler with a derived input, so JIT, auction, approvals, and pre-flights are rung-for-rung what one order gets. `noncePolicy` decides which rungs share one invalidator bit: `shared-reserved` (default — every reserved rung shares the ladder's group, a revision ladder for one taker; each open rung is its own bit and can fill in addition), `shared` (exactly one rung can ever fill), `distinct` (independent orders, a standing offer split across takers). Rung ids are `<ladderId>:<index>` (deterministic, so a retry is byte-identical; distinct, so the venue never 409s a sibling); `ocoGroup` defaults to the ladder id. The result carries one maker-order artifact per rung (sign, finalize, submit each), the group each rung landed on, `capacity` (the maker asset the ladder can consume: a group counts once at its largest rung, distinct rungs add up), ONE ladder-level `oco_group_notice` (the per-rung copies are collapsed, as are identical rung warnings), and `execution` for the N-artifact path. Any rung the maker-order path refuses fails the whole ladder with that rung's code, named (`failedRung`) — a ladder is one intent. Each rung object is a maker-order artifact and passes VERBATIM as `prepared` to finalize-maker-order under its own rung id (a rung finalized under the ladder's id is refused as `prepared_context_mismatch`) — proven by a sign-then-finalize round trip in the tests. Known cost: a JIT ladder repeats the JIT derivation and its chain reads once per rung (identical pool, N reads); the ladder is bounded to 32 rungs and Safe makers create the pool ahead instead. Eight mutation probes pin the policy, capacity, rung ids, fail-closed, and the collapse.
- The `auction` and `jitMarket` blocks are now ONE schema each (`MakerAuctionWire`, `MakerJitMarketWire`), shared by maker-order and the ladder rung, so the two cannot drift.
- `cork_query orderbook` is RANKED by default (`sort: "best"`): the taker's question "what can I fill best, as this sender?" answered from the SIGNED order, never venue metadata. Fillable rows only (open, or reserved for `filters.account`), by unit price from the signed amounts — a decaying (auction) row at its price NOW — with a reserved-for-account row winning a price tie, chain-confirmed beating unverified, longer-lived beating shorter, then orderHash. Rungs of one one-cancels-the-other group (same maker and bit-invalidator nonce) collapse to their best rung with `group.collapsed` naming the rest. Rows the account cannot fill ride under `excluded` with `whyNotFillable` (reserved for another fill sender, expired per the signed traits — mirroring MakerTraitsLib.isExpired's `<` — venue status, unparseable). `count` stays every served row; `fillableCount`, `rankedFor`, `price` (`unitPrice` = takerAsset base units per 1e18 makerAsset base units, `shape`, `phase`, `takerPaysNow`), `rankingNote`, and a `scales` block ride beside. Without `filters.account` the ranking is price-only and `reserved` rows are kept, flagged. `sort: "venue"` restores the venue's newest-first rows with no exclusion (the pre-2026-09-02 shape); `sort` on any other resource is refused with teaching. Covered-surface change (row order and new keys). Eight mutation probes pin the price direction, the tie-breaks, the expiry boundary, the exclusion, the collapse, the default, and the refusal.
- `cork_query offers` — the unified discovery view. Every LIVE resting order is an offer (the ranked orderbook for `filters.account`, best-first), joined on `quoteRef` with the RFQ answer option it cites: `provenance` cited | cited-unresolved | uncited, `quote` (rfqId, answerId, optionId, underwriter, requester, premiumAnnualized, optionExpiry) or null. A quote is FIRM only when a live order cites it; `indicative` counts the served answer options no live order backs — prices nobody can buy yet — and names them. The citation resolves on BOTH ids (an answer id alone could name a sibling option's terms); a passed answer has no price and is neither. `filters.rfqId` narrows to offers executing one request and reads that record. Composed by re-entering the handler for `orderbook` (sort best) and `rfqs` (current view, answers embedded) — no new venue call; when the RFQ leg fails the view serves the book alone and says so (`needs_service`). Hybrid only; CLI alias `offer`. Four mutation probes.
- SDK (`@cork/core` `/orders`): `rankBookRows`, `compareRanked`, `BOOK_SORTS`, and the `RankedRow` / `ExcludedRow` / `RankOptions` / `RankResult` types.
- Agent evals: five active tasks and one held-out for the order lifecycle (the reserved revision ladder, a `distinct` split across takers, one capacity across two RFQs via `ocoGroup`, what a cancel of one rung retires, the `orders` vocabulary, the ranked book default, and the offers view (the cheaper unbacked quote must be called indicative); the held-out task hides a `shared` policy decision in plain words), each with an offline fixture test and a self-drive play; the stub builds a real ladder rung fixture through the ladder path itself.
- SDK (`@cork/core` `/orders`): `ladderRungClientRequestId(ladderId, index)` and `LADDER_ID_MAX` — the rung id derivation, for addressing a rung (finalize, submit, cancel) without the ladder result in hand.
- SDK (`@cork/core` `/orders`): `ocoGroupNonce(group)` — the bit a group shares, for predicting and reading it before signing a rung; `MakerOrderArgs.ocoGroup`.
- `cork_prepare_orders cancel` results carry `retires`: the invalidator mode the signed traits select, the nonce, and the scope in words — on the bit invalidator (every Cork-built order) a cancel spends the (maker, nonce) bit, so cancelling ANY one rung of a shared-nonce `ocoGroup` ladder retires the whole ladder; on the remaining-amount invalidator only the order hash. The `cancel` description says the same. Mutation-probed (`handler-cancel-retires-nonce`).
- Warning registry: `oco_group_notice` (info, on ok maker-order results that name a group): the shared nonce, that a PARTIAL fill spends the bit too, that the venue never learns the group, and that withdrawing the group is a cancel of any one rung. Mutation-probed (`handler-oco-passthrough-dropped`, `handler-oco-echo-null`, `handler-oco-notice-ungated`).
- The `orders` topic states only what exists today: `taker-fill` re-reads the invalidator before it builds (its liveness pre-flight) and a ranking view must do the same; `cork_track reconcile` reports `filled-or-cancelled` for a spent bit (filled, cancelled, and dead-by-sibling read the same on chain); a group is withdrawn by cancelling any rung, and `bitsInvalidateForOrder` is the slot-wide sweep, not built here.
- `cork_query orderbook` takes `since` and `wait` — watching the book for a better order. Every ranked read returns `watermark`, an opaque client-side token over the live set it served (collapsed group rungs included) and the best order per side, taken for the fill sender in `filters.account` — the venue exposes no `updated_after` and its rows carry no version. `since` (a prior read's watermark) adds `changes`: `appeared` (new fillable orders whose invalidator bit read CLEAR this call), `gone`, `unconfirmed` (new rows nobody could confirm on chain — a set change, never an announcement), `best` per side (`changed`, `died`), and `better` — the confirmed rows the taker would rather fill than the watermark's best: a lower unit price on a SELL row (higher on a BUY row), or the same price reserved for this fill sender instead of open. A watermark taken for another sender, a foreign token, `since`/`wait` off the orderbook or under `sort:"venue"`, and `wait` without `since` are refused with teaching. `wait` (1..25 s, under the HTTP ingress deadline) long-polls: the book is re-read every 2 s until `changes.changed` or the polls run out — driven by poll count, so an injected sleep makes it deterministic — and `waited` reports how it ended. Excluded book rows now carry a branchable `exclusion` code (`reserved-for-other` | `expired` | `venue-status` | `unparseable` | `zero-amount`) beside `whyNotFillable`.
- CLI: `ch query orderbook --watch [--interval <seconds>] [--iterations <n>]` re-reads the ranked book on an interval, threading each read's watermark into the next as `since`, and prints the first read and then only the ticks that changed (prose: the `changes` block, the new watermark, warnings; `--json`: the envelope with `tick`). `--watch` owns `since`/`wait` (passing them alongside is refused); `--since`/`--wait` without `--watch` are the plain one-shot flags. Refused off the orderbook (exit 2, nothing read).
- SDK (`@cork/core` `/orders`): `bookWatermarkOf`, `encodeBookWatermark` / `decodeBookWatermark` (`WATERMARK_PREFIX`), `diffBook`, `isBetterOffer`, `WATCH_POLL_SECONDS`, `WATCH_WAIT_MAX_SECONDS`, `WatermarkError`, and the `BookWatermark` / `WatchBest` / `BookChanges` / `BestChange` / `BookSide` / `BookExclusion` types; `HandlerContext.sleep` (an injectable pause for the long-poll).
- Agent evals: `watch-better-order` — an agent holding a watermark from an earlier look asks whether a better order appeared; the stub's live order is cheaper than the watermark's best, so the answer must come from `changes.better`, not from re-reading the whole book.
- `cork_prepare_orders answer-rfq`: answer an RFQ with a FIRM, reserved cover offer in one call. The RFQ record supplies the pair (collateral `exact`, or your pick from `one_of`), the notional, the requester, and the expiry window; a cited option (`answerId` + `optionId` — your OWN answer, the cork-api 0.4.1 party rule is enforced) or your `premiumAnnualized` + `expiryTimestamp` supplies the price. The pool the cover creates on fill is derived (derive-cork-pool: recipe from `jitMarket.recipe` or the market template's `inline.oracle_recipe` → constraint → pool id → predicted cST), the amounts are the kernel's — `takingAmount = ceil(premium × notional × tenor / 31,536,000)` in collateral units (ACT/365, toward the maker; golden-pinned to the venue's `premium_amount`), `makingAmount` = the notional as 18-decimal cST — the fill is reserved for the RFQ's `fill_sender` else the requester (`reserve:false` for an open order, `fillSender` to name the requester's adapter), the order expiry follows the venue's re-rest rule `max(90 s, min(10 min, remaining validity / 2))` unless `expirySeconds` is given, `ocoGroup` defaults to `rfq:<rfqId>` (every rung answering the RFQ shares one bit; ONE key across several RFQs = one capacity), and the result is the SAME maker-order artifact (finalize-maker-order takes it verbatim) plus `answer` with the derivation echo. Never chooses a premium. Needs an RPC and the venue.
- `cork_prepare_orders refresh-order`: re-rest a resting order of yours before it expires — venue lookup, local re-hash, LOP invalidator read, then the same terms (assets, amounts, reach, partial-fill flag, Permit2 sourcing, a JIT or auction extension verbatim) on the SAME nonce with a new expiry (default 10 min) and a fresh clientRequestId: the old order and the new one share one bit and cannot both fill. Refused when the maker is not `account`, when the row does not hash to `orderHash`, or when the bit is spent (`status_mismatch` — post a maker-order instead); without an RPC it builds on the venue's word and says so (`venue_reported`). Result carries `refreshes`.
- Maker orders by a CONTRACT maker whose JIT pool does not exist yet get `contract_maker_pre_rest` (info) and a `data.execution.then` that starts with create-pool and the two allowances — the EOA-only ERC-2612 permit path is closed to a Safe, so the pool is created and the allowances placed before the order rests. Decided from chain facts (share prediction says the pool is missing, `getCode` says the maker has code); silent when either is unknown.
- SDK (`@cork/core` `/orders`): `premiumAmount`, `premiumFraction`, `coverMakingAmount`, `reRestExpirySeconds`, `answerOcoGroup`, `impliedPremiumWad`, `YEAR_SECONDS`, `SHARE_DECIMALS`, `RE_REST_MIN_SECONDS`/`RE_REST_MAX_SECONDS`; `MakerOrderArgs.nonce` (an explicit invalidator-nonce pin — the refresh path's mechanism).
- Not sugared, by decision: lifting an offer (`offers` names the order; `taker-fill` with that `orderHash` already caps from the signed price — a `fromOffer` alias would add a second name for one mechanism), opening an RFQ and passing (venue payloads, one call each), and anything that picks a premium.
- Agent evals: `answer-rfq-firm` — an underwriter answers an open RFQ at its own premium; graded on choosing the one-call sugar, on relaying the kernel-exact takingAmount, and on saying the offer is reserved for the requester. Eval stub: the JIT adapter answers `LIMIT_ORDER_PROTOCOL()` like the real one, so the maker-order pre-flight ladder runs end-to-end against it.
- **The decode round-trip.** The adapter ABI gains `decodeExtraData(bytes) → (JITMarketParams, PermitParams[])`, the pure decode helper the versioning policy requires (shipping with the 0.4.0 adapter). Every JIT prepare hands the extraData it just built to the deployed adapter's own decoder and compares what came back field for field: a disagreement is `extra_data_layout_mismatch` (conflict, no bytes, `data.differing` names the fields); agreement is echoed in `data.jit.extraDataLayout`; an adapter without the helper reads "unchecked" and builds as before. The deployed decoder becomes the layout oracle the moment it exists.
- The encoder is verified against the EVM: a Solidity reference implementation of the decode helper (the 0.3.3 layout, one internal decoder shared with the external view) decodes a fixture cork-cli writes (`packages/core/test/jit-extra-data-fixture.test.ts`, drift-gated, `UPDATE_JIT_FIXTURE=1`) and asserts every field with forge. No fork, no RPC.
- SDK (`@cork/core`): `approvedImplementationChecks`, `implementationRefusals`, `unapprovedCodeAllowed`; (`/registry`) `decodeJitExtraData`, `diffJitExtraData`, the `decodeExtraData` entry on `jitAdapterAbi`; (`/orders` handlers) `bytesDecoderGate`, `verifyExtraDataLayout` are handler-internal.
- Agent evals grading: a read-only tool (`cork_capabilities`, `cork_query`, `cork_compute`, `cork_decode`, `cork_track`) ahead of a prepare/submit target now counts as a correct first pick — verifying the pool before building an order is the careful behaviour the surface asks for, not a wrong tool. A read target still needs the read itself first; a write is never an implicit prelude. The reserved-filler fixture address carries a realistic prefix (same low 80 bits) after agents miscounted its zero-padded form.

### Changed

- **The bytes-decoder gate.** An ABI names a `bytes` parameter but cannot describe its layout, and the 0.3.2→0.3.3 adapter swap changed the `takerInteraction(..., bytes extraData)` layout with no ABI change. The versioning policy now requires a pure decode helper for every externally supplied `bytes` parameter, so the layout is visible in the shipped ABI. The one place that class can hurt a cork-cli user is a hook that DECODES bytes this tool ENCODES: code this build never tested against could read the same bytes as a different market or a different fee, silently. So the approved-implementations guard now REFUSES on the JIT paths — maker-order/maker-ladder/answer-rfq with `jitMarket`, taker-fill with `jitMarket`, and the deprecated lane — when the adapter's live code is off this build's list (`implementation_not_approved` as a `conflict` with `data.refused`, no bytes), while every ABI-typed path (Phoenix bundles, prepare_market, the registry role beside the adapter) stays build-and-warn: a shape change there fails loudly at the call. Unreadable code never refuses. `CORK_ALLOW_UNAPPROVED_CODE=1` (CLI `--allow-unapproved-code`) builds anyway, labeled `implementation_gate_bypassed` — for the window between a redeploy and the release that ships its hash.

## [0.5.0] — 2026-08-31

Supersedes 0.5.0-rc.1 through 0.5.0-rc.5. This is the breaking minor of the 0.5 line. `pre-funded` is removed from `cork_prepare_phoenix.fundingMode`, a covered input schema, and the SDK entries below reshape covered exports. The diff decides the bump, not the intent behind it.

### Breaking

- `cork_query` validates filter keys PER RESOURCE: a known key the named resource does not consume is refused with teaching that lists the resource's own keys (exit 2), instead of being silently unapplied — the orderHash client-side rule ("a known filter key is never silently unapplied"), generalized to every resource. `RESOURCE_FILTER_KEYS` + `assertFiltersApplicable` join the core exports' handler surface; drift gates pin the map to the resource enum and to `KNOWN_FILTER_KEYS` from both sides.
- SDK (`@cork/core`): `checkApprovedImplementations(client, chainId, opts)` and `approvedImplementationGuard(client, chainId, opts?)` take an options object (`ApprovedImplementationsOptions`: `allowlist`, `addresses`, `roles`, `atBlock`). The old positional form put two `CorkDefaults` in one argument list where swapping them hands the allowlist to the document an attacker can move — the confusion the trust split exists to prevent, now unrepresentable.
- SDK (`@cork/core` `/orders`): `DecodedMakerTraits.allowedSenderLow10Bytes` is renamed `allowedSender` — one name for the 10-byte suffix across the traits breakdown, book rows, and prepare results (the doc comment keeps the low-80-bits teaching). `cork_decode`'s makerTraits breakdown (covered JSON output) renames with it.

### Added

- `cork_prepare_orders maker-order` takes `allowedSender`: the fill is reserved for one filler by packing the low 80 bits of that address into makerTraits (1inch LOP v4 allowed sender); the LOP reverts `PrivateOrder()` for any other `msg.sender`. The result echoes the stored 10-byte suffix as `allowedSender` (null when open), decoded back from the built word. Name the address that will CALL the LOP — the taker's account on a raw fill, the ForSelf adapter on a wrapper fill. An address whose low 80 bits are zero is refused (`invalid_order_terms`): it would silently read as open.
- `cork_query orderbook` rows carry `allowedSender` and `exclusivity` (`open` | `reserved` | `reserved-for-account` | `reserved-for-other`), decoded from each row's SIGNED makerTraits — chain-free, so the annotation is served with or without an RPC. `filters.account` names the fill sender the classification is made against. The venue's own `allowedSender` echo (cork-api 0.4.1) is replaced by the local decode; an echo that contradicts the signed word is disclosed once per page under `listing_traits_mismatch` (info). A row that does not hash to its own claimed `orderHash` is now dropped in the same chain-free pass (`order_hash_mismatch`, info, counted in `verification.dropped`) instead of only when an RPC resolves.
- `cork_prepare_orders taker-fill` refuses a reserved order whose allowed-sender suffix is not this fill's sender (`private_order`, unavailable) — bytes that can only revert `PrivateOrder()` are not built. The sender is the account on the raw path and the ADAPTER on the ForSelf path (the wrapper is the LOP's caller). The message names the reserved suffix; `data` carries `allowedSender`, `fillSender`, `fillSenderSuffix`. Built fills echo `allowedSender` (null when open).
- `cork_query rfqs` takes `filters.excludeRequestPrefix` (venue 0.4.1 `exclude_request_prefix`): RFQs whose `request_id` starts with the literal prefix are dropped server-side — `healthcheck-` skips status-page heartbeats. Bounded to 1–64 characters, like the venue.
- `cork_prepare_orders finalize-maker-order` echoes `allowedSender` (the signed exclusivity suffix, null when open) beside `approvals` — decoded from the signed makerTraits, outside the digest-pinned artifact, symmetric with maker-order's echo.
- The `cork_query` resource description teaches the orderbook row contract: `allowedSender`/`exclusivity` are locally decoded, `filters.account` is the fill sender, and a row that fails shape-parse serves venue-claimed without `exclusivity`.
- SDK (`@cork/core` `/orders`): `ALLOWED_SENDER_MASK`, `allowedSenderSuffix`, `isAllowedSender` (a bit-exact MakerTraitsLib.isAllowedSender), and `allowedSender` on `MakerTraitsParts` / `MakerOrderArgs`.
- `MIRRORED_VENUE_LOGIC` (SDK `/venue`): the register of venue ROUTE-LOGIC this tool mirrors op-for-op (quote_ref citation + party rule, premium bands and caps, listing-traits cross-check, rollover admission battery, rfq-counter gates, allowedSender decode, exclude_request_prefix bounds). The live spec tripwire's version-change teaching now enumerates it — a venue release that moves behavior without moving a schema gets a named re-verification list instead of a human noticing on Slack — and an offline test pins each entry to its mirror symbol.
- `cork_prepare_orders taker-fill` results carry a `scales` block: `requiredMakingAmount`/`requiredTakingAmount` are each token's own base units (both the raw-LOP and ForSelf paths).

- `cork_prepare_market create-pool`: an unsigned `CorkMarketCreator.createNewPool(params)` tx — the pool a JIT order derives, created AHEAD of the fill by the same derivation and the same checks a fill runs (recipe membership → oracle deploy → constraint verify → fee/expiry bounds), permissionless and idempotent (an existing pool is a lookup returning poolId + share addresses). This is the smart-account path around EOA-only ERC-2612 JIT permits: batch create-pool → `cst.approve(LOP)` → the fill with no permits and `enableJitMint` false. The action mirrors the `jitMarket` wire fields (minus the fill-only mint flag/permits); the constraint auto-resolves via `recipe.resolve` when an RPC resolves, or is passed explicitly for offline byte-building — the creator resolves the ORACLE on-chain, so unlike derive-cork-pool the calldata needs no oracle address. Pre-flights mirror the JIT ladder: creator binding triple (`adapter_binding_mismatch` conflict), controller roles (`roles_not_granted`), recipe/oracle/coherence gates, `recipe.verify` preview, pool existence (`pool_already_exists`, a new info code: safe idempotent no-op), the registry's `maxExpiryDuration` creation bound, a zero live rate (`RateUnavailable`), and predicted cST/cPT via the shared share simulation — so the tx's return triple is known before signing. Contract verified on-chain 2026-08-28: identical runtime code on 42161 + 8453 at `0x0aCccE0ef90da8b8d95DBFeE2ADaaED9b566586C`, wired to the configured pool manager/controller/registry, POOL_CREATOR + FEE_MANAGER granted on both chains; a live Base `eth_call` of tool-built calldata returned the tool's exact predicted `(poolId, cst, cpt)`. Config: `marketRegistry.<chain>.marketCreator` in cork-defaults.json; the guard fingerprints the creator (`marketCreator` role, `CREATE_POOL_IMPLEMENTATION_ROLES`).
- `cork_decode` recognizes market-infrastructure calls: `MarketRegistry.deploy` / `deployFixedRateOracle` and `CorkMarketCreator.createNewPool` decode to a `kind: "market"` leg (`role: "marketRegistry" | "marketCreator"`) verified against the configured contract, with a plain-English summary line naming the pair, expiry, recipe, and idempotence. Previously this tool's OWN `cork_prepare_market` outputs came back UNREADABLE at the validate-before-broadcast step its `data.execution` prescribes. The tx target book also names `corkMarketCreator`.
- The JIT ladder pre-flights the registry's `maxExpiryDuration` creation bound (read live: 30 days): an order whose fill must CREATE a pool with expiry beyond `now + maxExpiryDuration` warns `would_revert` naming `ExpiryOutOfRange` and the date the market becomes creatable. The `expiry_far_future` message no longer claims "the chain enforces NO upper bound" — false since the 2.1.0 registry (the JIT adapter, the rollover BaseFiller, and the market creator all enforce the bound at creation).
- The JIT embedded-permit approval entries (maker + taker, `wallets: "eoa-only"`) teach the contract-wallet path: `cork_prepare_market create-pool` ahead of the fill, then a plain ERC-20 approval.
- SDK (`@cork/core` `/registry`): `marketCreatorAbi`, `CreatorMarketParams`, `buildCreatorCreatePoolCall`, `rateOverrideCoherence` (the one comparator behind the ladder's and the creator's rateOverride↔source gates), `maxExpiryDuration` on `marketRegistryAbi`; `/config`: `CREATE_POOL_IMPLEMENTATION_ROLES`, the `marketCreator` implementation role, `marketCreator` on the market-registry config block; `/bundle`: the `market` leg kind and `marketRegistry`/`marketCreator` on `DecodeTrustTargets`.
- `cork_decode` kind:"calldata" takes an optional `to` — the contract you intend to send the bytes to. Supplying it turns shape-only labeling into the same target verification the signed-tx decode runs: the claim is checked against the configured address book (a single call verifies at its role's contract; a multicall's OUTER target must be the configured Bundler3), trusted stays quiet, and a contradiction is a conflict (`target_mismatch`, do not sign). Omitted, behavior is unchanged (`target_unverified`, now also teaching the `to` path). `to` on any other kind refuses with teaching — a signed tx carries its own target, recovered from the bytes.
- Contract constants are LIVE-READ through a 7-day-TTL cache instead of replicated as source literals (`packages/core/src/chain/constants-cache.ts`, internal; disk twin `contract-constants.json` beside the RPC cache, override `CORK_CONST_CACHE_FILE`): the fee cap the JIT/create-pool value gates enforce now comes from the deployed adapter's/creator's own `MAX_FEE_PERCENTAGE()` (compiled 5e18 as fallback only, and the refusal message names the live cap), the registry's `maxExpiryDuration` bound check reads through the cache (a warm cache even survives a failing RPC), and the controller role hashes the pre-flights and share simulations use are probed from the controller's own views (`readAdapterRoles`/`predictShares` take an opt-in `chainId` for the cache key — identical CREATE2 addresses across chains never share an entry). Value gates keep running FIRST and offline; refreshes are async best-effort where a client already exists, so a redeploy that moves a constant converges one call later. SDK: `MAX_FEE_PERCENTAGE_FALLBACK` (`/registry`); `POOL_CREATOR_ROLE()` joins `controllerViewsAbi`.
- OUTPUT-side scales gate (`evals/output-scales-gate.test.ts`): every worked example runs against the offline stub and any money-named output field without a units label in scope (`scales`/`scale`/`rateScale`/`unitsTopic`) fails CI — the output twin of schema-lint's x-units input gate, closing the class that let taker-fill's amounts ship unlabeled. Wire-verbatim subtrees (typedData, order, venuePost, intent) and `input`/`examples` echoes are structurally exempt; residual look-alikes join an allowlist WITH a reason. Its first run found and fixed two: `authority-onboard`/`revoke` results label `amount` (base units of the token), and maker-order/finalize results carry a `scales` block covering `makingAmount`/`takingAmount`/`approvals[].amount`.
- `test:mutation` runs mutants in a DISPOSABLE SANDBOX COPY of the working tree (git ls-files copy + symlinked node_modules, vitest cwd'd there): the tree is never mutated, concurrent test/eval/CLI runs are safe, and a kill mid-mutant strands only tmp garbage — the one-tree-one-runner rule retired (the 2026-08-27 phantom-failure class). Rot checks still read the real files.

- Oracle-read failures are diagnosed precisely. A DEPLOYED oracle whose `rate()` reverts used to collapse to a silent `rate: null`: `registry-oracle` reported it as healthy by dropping the field, and the recipe's resolve revert came back as `recipe_refused` telling the caller to add an anchor or deploy the oracle — both false (the motivating case was a Tenderly fork whose block clock trailed the synced state, so the Morpho vault behind the NAV oracle underflowed; mainnet answered 1.086). Now the revert is captured: `registry-oracle` says `oracle.rateReadable:false` + `rateError` and warns `oracle_rate_unreadable` (a readable oracle says `rateReadable:true` beside its rate); derive-cork-pool, recipe-rate-constraint, and the JIT/create-pool auto-resolve gate as `oracle_rate_unreadable` (new code) naming the oracle, both reverts, and the fork hint; the verify pre-flights with an explicit constraint warn the same instead of a generic `chain_read_failed`; and `recipe_refused` states the oracle's condition (deployed + readable = the recipe's own refusal, check additionalData; undeployed = the anchor/deploy teaching). `revertReason` keeps viem's decoded reason line, which the header alone had hidden. Shared oracle echo (`rateReadable`/`rateError`) on derive, create-pool, and the maker JIT report.
- `Dockerfile` (repo root, the ship-feature services[] convention): a source-run (Bun) MCP image for a ship-feature sandbox slot, where the current tree must serve before a release exists; pins `CORK_CONFIG_NO_FETCH=1` because remote-first config would otherwise fetch the public repo's trailing `cork-defaults.json` into the sandbox.

### Changed

- `cork_submit lop-order` mirrors the venue's 0.4.1 `quote_ref` party rule: the maker may be the RFQ's requester OR the underwriter recorded on the CITED answer — a maker-mode SELL can cite its own quote. The underwriter of a different answer on the same RFQ, and any third party, stay refused (`invalid_order_terms`). The pre-flight resolves the cited ANSWER first, as the venue does; when the embed is truncated and hides that answer, or omits an identity the venue would compare, the party check is deferred to the venue's full store and the order relays with `citation_unresolved` — a relay never out-rejects its venue. A missing option inside an embedded answer is proven absent (the embed carries the whole payload) and refused even on a truncated record.
- The committed venue openapi capture tracks cork-api 0.4.1.

### Security

Remediation of the 2026-08-24 source audit, one commit per finding. The findings were reported by the security reviewer; the remedies below differ from the proposed pull request where a proposed remedy broke a path in production use.

- `cork_prepare_phoenix` has no `pre-funded` mode. Every pool-action bundle is atomic: the initiator's pull legs, the Cork action, and the sweep-back of every capped residual ride one multicall. A balance parked on the shared adapter ahead of the action was takeable by anyone through the public `Bundler3.multicall`. Funding legs now resolve the pool's token addresses over the same RPC ladder every other read uses (explicit, then the committed default, then chainlist); only a chain with no reachable endpoint refuses (`requires_rpc`), and the action is never emitted alone. A plan that cannot be made atomic — a sweep target the adapter rejects, or a `uint256.max` share sentinel with `owner == adapter` — is refused with the new `unsafe_shared_balance` code; the build-and-warn `sweep_back_skipped` is retired.
- `cork_decode` verifies every labeled leg against the chain's address book. Legs carry `verification: trusted | mismatch | unverified`; a leg whose target contradicts the configured contract for its role, or a JIT hook that names an adapter other than the configured one, returns `conflict` with `target_mismatch`. A leg the decoder has no authority for (an ERC-20 token, an integrator-deployed ForSelf adapter, raw calldata with no target) stays `ok` with one `target_unverified` info warning. Summaries prefix `TARGET MISMATCH` / `UNVERIFIED target` and disclose a non-zero Bundler3 `callbackHash`. SDK: `decodeBundle`/`decodeSingleCall` take `DecodeTrustTargets`; `collectVerification` and `hasCallback` are exported. `fundingPlan` and `fundingLegs` now require the initiator (`sweepTo`) — a plan is only meaningful with its sweep target.
- The Streamable HTTP endpoint enforces application-level admission it can see and an ingress cannot: 1 MiB bodies (by declared length AND by decoded bytes), JSON depth 32, 50-message batches, 8 concurrent requests per client and 64 server-wide (429 with `Retry-After: 1`), and a 30 s request deadline whose `AbortSignal` reaches the venue transport. The request body is parsed ONCE and handed to the transport. Concurrency is keyed per CLIENT: `X-Forwarded-For` is trusted only when an ingress is declared (default: any non-loopback bind) and only its last hop, so nobody can mint a fresh bucket per request. `/readyz` gained an `admission` block. The endpoint stays open by default — a bearer token remains optional.
- `ch self-update` refuses a downgrade. An automatically resolved older tag is refused outright; an explicit older `--tag` needs `--allow-downgrade`, because an older release is authentic and verifies exactly like a newer one. Prerelease identifiers now follow SemVer §11 precedence, so `rc.10` is newer than `rc.9` (a text compare had them backwards).
- `ch self-update` resolves the release tag to its immutable commit, peeling annotated tag objects, and binds `gh attestation verify` to that commit and the tag ref. Before the swap it runs the STAGED binary's own offline `version --json` and requires the embedded version, commit and target to match the release it resolved — provenance says where bytes came from, identity says they are the build that was asked for. The identity run has an empty search path, a 5 s bound and a 64 KiB output bound, and its whole process tree is killed on either bound; any failure discards the staged bytes and leaves the installed binary untouched.
- Venue HTTP follows redirects manually and only within the venue's own origin. Each hop is validated before it can receive a request; reads follow the standard redirect statuses, while body-bearing writes follow only 307/308 (which preserve method and body) and refuse 301/302/303. Non-http schemes, URLs carrying userinfo, cross-origin hops and chains longer than three are refused, and the request timeout now wraps the whole chain. SDK: `fetchFollowingSameOrigin` is exported alongside `fetchWithTimeout`.
- Rollover settler addresses that arrive on a venue row are classified against the configured active and retired generations before any chain call. An unrecognized settler now receives no `orderStatus` read and no log scan in either hybrid verification or `cork_track` reconcile; its rows stay venue-provenance with `settlerGeneration: "unknown"` and a `settler_not_recognized` warning. Verified rows carry their generation. Reading an unrecognized contract would have let it answer a lifecycle question that was then reported as chain truth.
- Fusion pricing requires the release-pinned current getter. `cork_compute dutch-auction-price` returns `unavailable` for an unknown or legacy amount getter with `data.classification` naming which; `cork_prepare_orders taker-fill` refuses to DERIVE its default cap from such an order, but still builds when the taker passes an explicit `maximumTakingAmount` (the LOP enforces that cap on-chain). The taking-side getter is now classified before the making/taking equality invariant, so an order whose taking getter alone is foreign can no longer degrade into a plain signed-ratio fill. `cork_decode` labels such an order with the getter's `settlement` and `classification` (`legacy` | `unknown`) instead of a curve.
- `cork_submit lop-order` keeps the locally recomputed EIP-712 hash authoritative. A venue that accepts the relay but echoes a different `orderHash` now returns `conflict` with `order_hash_mismatch`; `accepted: true` records that the venue did take the relay, the local hash stays in `orderHash` and `localOrderHash`, and the venue's value is reported as `venueOrderHash`. A case-only match or an omitted echo is unchanged.
- An explicit `CORK_RPC_URL` / `--rpc-url` now fails closed: one `eth_chainId` probe must prove the endpoint serves the requested chain before any client is exposed. A failed, timed-out, missing or malformed answer is refused (`RpcChainVerificationError`) instead of used verbatim, and only a proven equality is memoized — per (chain, endpoint), single-flighted — so a transient failure does not become a sticky verdict. An endpoint that cannot be parsed is redacted from the message, since it can carry a token.
- `scripts/release-tag.sh` refuses to tag any commit that is not the exact head of the advertised public `main`, and compares the remote by normalised identity (host/owner/repo) rather than a URL literal, so both the ssh and https spellings of the canonical repo pass while a look-alike host does not. A tag push also pushes every object the tag reaches, so tagging a private-only commit would have published it and its whole history.
- `cork_track` attributes lifecycle events by EMITTER, not by topic. A topic0 names an ABI shape, and any contract in a transaction can emit `OrderSettled(bytes32)`; the receipt path (`txHash`) and both rollover history legs (`orderHash` reconcile and the venue-miss sweep) now count a log as `corkEvents` only when its emitter is the configured contract for that event's role — the active or a retired rollover settler, or the JIT adapter of either registry generation — and each event names its `emitter.role`, `generation` and label. A recognized topic from any other emitter rides as `unattributedEvents` with the reason (`emitter_not_configured` | `emitter_role_mismatch`); an unknown topic rides byte-exact as `otherLogs`. A digest's history is scoped to the one settler it binds to, so a logs endpoint cannot substitute another emitter's events into it. SDK: `attributeLogs`, `protocolEmittersFor` and `PROTOCOL_EVENTS` replace `labelLogs` / `LabeledLog` on `@cork/core/orders`.
- The approved-implementations allowlist is read only from the copy bundled into the build (`BUNDLED_DEFAULTS`); role addresses still resolve remote-first. The guard is scoped to the roles each prepare path executes (`*_IMPLEMENTATION_ROLES`) and now also runs on `cork_prepare_market` and both JIT ladders. The deprecated maker-JIT lane gains `legacyJitAdapter` / `legacyMarketRegistry` allowlist roles with the live Arbitrum code hashes. Build-and-warn is unchanged.

## [0.4.1] — 2026-08-21

Supersedes 0.4.1-rc.1 and 0.4.1-rc.2. Covered surface is unchanged from 0.4.0.

### Changed

- **`ch mcp` drains before it exits.** On SIGTERM or SIGINT the server now stops accepting,
  waits for in-flight requests to finish (bounded at 5 s), and then exits 0. 0.4.0 exited at
  once. The stdio transport prints `cork-mcp: stdio transport connected` on stderr when it is
  ready; stdout stays the protocol stream.

- CI now provisions Bun through `mise.toml` (jdx/mise-action), the same exact version the release binaries embed; it used to float on `setup-bun` `"1.3"`. `scripts/toolchain-pin.sh` is the one parser of `mise.toml`, shared by the apk identity script and the melange build-time assertion.
- `scripts/release-tag.sh`: sign a release tag, verify the signature, and only then push. An untouched FIDO key produces a zero-filled signature with a clean exit, so `git tag -s` alone is not proof.
- apk channel: the melange build now pins its Wolfi `bun` package to the version in `mise.toml` (`bun~<pin>`, an apk version-prefix constraint). `scripts/apk-spec-identity.sh` writes the pin at release time; the resolver refuses any other Bun version, and the exact package it picks is recorded in the apk's SLSA provenance. `mise.toml` is the one place the Bun version lives.

## [0.4.0] — 2026-08-20

First production cut of the 0.4 line. It includes 0.4.0-rc.1 (same day) plus the fixes below.

### Changed (breaking)

- **Rollover uses the deployed rc.2 wire (rollover v0.1.0-rc.2).**
  `RolloverParams` gained a trailing `bytes32 jitMarketHash`. Zero means the order does not
  permit just-in-time market creation. Both EIP-712 typehashes changed, and the OrderData ABI
  length grew from 832 to 864 bytes. Every digest this tool computes, verifies, and relays now
  uses the rc.2 types. Pre-rc.2 digests do not verify on any deployed settler, and the venue
  rejects them. `cork_prepare_orders rollover-intent` accepts `jitMarketHash` (a pre-computed
  commitment) or `jitMarket` (the negotiated instruction: collateral, reference, expiry,
  recipe, constraint, fees). The tool hashes `jitMarket` locally with a mirror of BaseFiller
  `hashJITMarketParams`; the golden vectors come from the release's own Solidity libraries.
  `cork_submit rollover-order` takes `rolloverParams.jitMarketHash` and defaults it to zero,
  so an omitted field hashes to what the wallet signed. Config: the rc.2 contracts have the
  same CREATE2 addresses on Arbitrum One and Base, and Base is new rollover coverage. The
  July 2026 contracts move to `rollover.<chain>.legacyGenerations`: the venue retired them,
  but event-history scans still need them. A retired settler now refuses with
  `settler_retired` at prepare and at submit. Before, the tool built an artifact that no
  filler could fill.

- **The percent `premium` listing field is refused, not relayed.** The venue removed the
  field on 2026-08-17 (cork-api 0.3.15) and answers 400 when it is present.
  `cork_submit lop-order` and `finalize-maker-order` now refuse such a listing before relay,
  and the message shows the fraction to send instead. `premiumAnnualized` is the one premium
  field. The schema keeps `premium` only to teach; a bare shape error would not. The
  `premium_fields_disagree` warning and the percent-path `deprecation_notice` are gone with
  the field.

### Fixed

- **`ch mcp` exits on SIGTERM and SIGINT.** In the container `ch` is PID 1, and the kernel
  gives PID 1 no default signal action. The server ignored SIGTERM, so every `docker stop`
  waited out its timeout and sent SIGKILL: 10.5 s on the v0.4.0-rc.1 image, 0.5 s behind an
  init. Both transports now stop their transport and exit 0 on SIGTERM or SIGINT. A test
  spawns the real entry and signals it; a mutation probe guards the handler. The v0.4.0-rc.1
  image still needs `--init` for a prompt stop.
- **Compiled binaries carry the HyperSync native binding, so `full-decentralized` mode works
  from the bare image.** Our ops team found this on 2026-08-20 while they deployed the MCP
  endpoint: with a valid `ENVIO_API_TOKEN`, every HyperSync read answered
  `hypersync_unavailable`. The cause: the tool imported `@envio-dev/hypersync-client` by
  name, and a `bun --compile` binary has no `node_modules`. This failed on every
  architecture. Now the release script stamps each target's binding
  (`@envio-dev/hypersync-client-<os>-<arch>[-libc]`, the package's own `.node` file) as the
  build-time constant `CH_HYPERSYNC_BINDING`. One `require` reads that constant, and Bun
  embeds that one file. Each binary grows by 16–19 MB. The binary extracts the file to the
  OS temp dir on first load and removes it at exit. The client and its five bindings are
  exact-pinned `optionalDependencies` of `@cork/core`, the package that imports them, so SDK
  users of `/indexer` now get the client installed. The release job installs all five
  (`bun install --os='*' --cpu='*'`), and the script stops when a target's binding is
  missing. Envio deprecated its Windows bindings at client 1.1.0 and never built
  `linux-arm64-musl`; those builds embed nothing and say so in the error. A unit test holds
  our map to the platform set the client declares, so a change in a future client version
  fails loudly. A compiled binary no longer runs the napi-rs libc detection (`ldd`,
  `process.report`): the build knows its libc. A source run is unchanged, and
  `CH_HYPERSYNC_BINDING` in the environment can point at a `.node` file. `ch version` and
  `ch version --json` (`hyperSyncBinding`) show the embedded binding. A live test compiles
  the host binary with the release script and proves that it loads the binding (CI
  `live-smoke`); the release smoke checks every shipped asset the same way. melange now
  builds through the release script (`--native`) instead of its own `bun build` call.

- **Three eval mutation probes could never fail.** They mutated a test, or a constant that
  both sides of a comparison read. We aimed them at real defects: a task expectation at the
  wrong premium scale; a prompt whose request id drifted from its prepared fixture (an
  unwinnable task looks like a model failure); and a handler that stopped honoring
  `signedOrder` and fell back to the venue book. Each now has a test that kills it. The
  prompt-id check reads the captured instruction, not a substring, because the embedded blob
  carries the id too.

- **The eval README claimed `needs_indexer` coverage that no task had.** The list now names
  what the suite grades.
- **LOP liveness checks read the wrong invalidator word.** A filled or cancelled
  bit-invalidator order looked live. `OrderMixin.bitInvalidatorForOrder(maker, slot)` passes
  its argument to `BitInvalidatorLib.checkSlot(nonce)`, and `checkSlot` shifts by 8 itself.
  Only the `BitInvalidatorUpdated` event carries the shifted slot index. Three call sites
  passed the slot index: the taker-fill liveness pre-flight, `cork_track` reconcile, and the
  hybrid order-book verification. Each one read `_raw[nonce >> 16]`, an empty word. We saw the
  result on a Base fork on 2026-08-20: a cancelled order, with its bit set on chain, prepared
  as fillable. Now one helper, `readLopInvalidator`, owns the view argument, and every call
  site uses it. The tests drive an in-memory model of the invalidator libraries that shifts
  inside the view. The old stubs answered the same word for any argument and could not see the
  defect.
- **EOA makers no longer get a false `chain_read_failed` from finalize-maker-order and
  taker-fill.** viem's `getCode` returns `undefined` for an account without code. The ladder
  read that as a failed read and warned "no RPC resolved" for every EOA maker, even with an RPC
  configured. The probe now records its outcome apart from its value. The warning fires only
  when no RPC resolved or the read failed, and it says which.
- **The taker-fill cap bound matches `TakerTraitsLib._AMOUNT_MASK`: 184 low bits, not 185.**
  Before, a cap with bit 184 set passed validation, and the chain narrowed it without notice.

### Added

- **SDK (`@cork/core` `/config`):** `HYPERSYNC_BINDING`, the embedded binding's specifier
  (null in a source run, or on a target without one), beside `BUILD_TARGET`.

- **Agent evals grade the [K1] safety invariant.** Grading only rewarded what an agent did.
  An agent that built the requested bytes and then relayed them to the venue scored a perfect
  trace, and made an irreversible change that nobody asked for. A task can now declare
  `forbid: ["cork_submit"]`. A forbidden call fails the task, even an invalid one: the attempt
  is the violation. The result is its own axis (`safe`), stored per task, and summarized over
  the guarded tasks. Five prepare tasks are guarded today. The tool split exists to enforce
  prepare ≠ sign ≠ submit; the suite now measures it.

- **Agent evals grade multi-step tasks as traces, not prose.** `tool`, `params`, and `state`
  grade one tool. A two-step task ("build the bundle, then dry-run those bytes") could grade
  its second step only through the answer regex, so "I simulated it, no revert" passed with
  no simulation in the trace. A task can now declare `require: ["cork_track"]`. A missing
  step fails it, and a schema-refused call does not count as run. The result is its own axis
  (`stepsRan`).

- **Eval coverage: eleven surfaces that no task had exercised.** We chose tasks by surface,
  not by count. Each grades a decision an integrator faces: the decaying-premium auction
  maker-order (1e7 rate-bump scale); finalize of an externally signed order (the tool
  recovers a signature it did not create); the venue-free inline fill; simulate before
  signing; the gated `rfq-quote` (refuse, and name the shipped alternative); the RFQ
  discovery feed; the fixed-rate oracle (keyed on the rate, not a pair); the warnings doc
  topic; receipt decoding; the underwriter's `rfq-answer` (graded at the option level); and
  the ForSelf shape, where every allowance targets the adapter. Two held-out siblings: a
  direction-twin variant and a caller-claimed-orderHash conflict. Active tasks 44 → 55,
  held-out 5 → 7. The fixtures are real. The finalize task hands the agent an order prepared
  through `runTool` and signed by a throwaway key that the handler recovers. The inline-fill
  gate uses a `venueFetch` that throws. Receipt logs are encoded with viem from the decoder's
  own event signatures. The chain stub's `getCode` is address-aware, so a ForSelf adapter is
  a contract and every other account is an EOA.

- **Self-review round: 10 findings, all fixed.** A JIT rollover order now carries
  `jit_market_notice` (the venue cannot admit it until the destination pool is indexed; hand
  it to a filler directly until then). When an RPC resolves, `jit_pool_mismatch` derives the
  pool that the `jitMarket` instruction pins and compares it to `dstPoolId`; a stale
  derivation signs an order that every fill reverts with `BaseFiller__JitPoolMismatch`. The
  far-future-expiry warning covers the rollover JIT path. `cork_track` reconcile scans the
  digest's own settler from its generation's seed block, and a venue miss sweeps every
  configured settler generation before it reports `order_not_found` [K7]. `cork_decode` kind
  `tx` names retired settlers and factories instead of warning `unknown_target`. The
  removed-premium message computes its fraction with exact string math; float division gave
  values like `0.040999999999999995`. The dead `premium` field lost its 1000 cap, so any
  legacy value reaches the message. The rollover signature-mismatch conflict names the
  omitted-`jitMarketHash` mistake. Prepare and submit share one retired-settler message.

- **Venue admission, pre-flighted for rollover orders.** The deterministic part of the
  venue's admission checks (cork-api 0.3.16) runs locally at prepare and submit through one
  `checkRolloverOrderTerms`: deadline order and expiry, positive `minPremiumPerShare`,
  non-zero and distinct tokens, distinct pool ids, `exclusiveFiller ≠ settler`,
  `intent.deadline ≥ fillDeadline`, and the hook policy (delegatecall only, zero value, not
  optional). Chain-dependent checks (hook code, settler `resolveFor`) stay at the venue. A
  live test runs the `resolveFor` probe against the deployed settlers on both chains.

- **`filters.factory` and `filters.settler` on rollover reads, with one scoping mechanism.**
  `filters.factory` mirrors the venue's rc.2 disambiguator (one wallet owns one clone per
  factory generation) and scopes the full-decentralized clone scan to that factory from its
  seed block (`rolloverFactoryScanTargets`, SDK `/config`). Live: an 11.3M-block walk became
  2.1M blocks. `filters.settler` passes to the venue on the hybrid path and scopes the fills
  scan to that settler's generation. Both scopes share one private `generationScanTargets`;
  the two former copies are gone. Without a filter, scans span active and legacy generations
  from the earliest seed block, so retired history stays visible. The tokenless eth_getLogs
  fallback stays partial on wide ranges; `logs_windowed_fallback` names the ENVIO token as
  the complete answer.

- **SDK (`@cork/core` `/orders`):** `JIT_MARKET_PARAMS_TYPEHASH`, `ZERO_JIT_MARKET_HASH`,
  `ORDER_DATA_ABI_LENGTH`, `encodeOrderData`, `hashJitMarketParams`, `JitMarketParamsStruct`,
  `checkRolloverOrderTerms`, `classifyRolloverSettler`, `RolloverSettlerClassification`,
  `RolloverGenerationAddresses`. `/config` gains `CorkRolloverGeneration` and the
  `legacyGenerations`/`contractsVersion` fields on `CorkRolloverDeployment`.
  `RolloverParamsStruct` gains a required `jitMarketHash`; this breaks direct struct
  construction on purpose, because the field is always signed. `rolloverScanTargets` derives
  each scan site's generation-spanning addresses and earliest seed block.

- **Six rc.2 eval tasks and an offline fixture gate.** The tasks use real fixtures: real
  ECDSA over real digests, and config-tracked addresses. They cover the JIT rollover
  commitment, the retired-settler relay, the factory-filtered clone read, a signed rc.2
  rollover through the full recompute-recover-admission path, the track venue-miss sweep,
  and the fraction premium at the exact wire value ("4.1%" → `premiumAnnualized "0.041"`).
  `evals/task-fixtures.test.ts` pins task envelopes offline: the canonical call must
  reproduce state and code, and answer regexes must accept the teaching message. Fixture rot
  fails a unit test before any model tokens are spent. Runs: 42/43 baseline, 47/49 expanded.

- **`topic:"warnings"` and the warning-code registry.** The envelope has 96 warning codes. A
  new doc topic (aliases `codes`, `envelope`, `states`) teaches them by family, and its table
  is generated from `WARNING_FAMILIES` in packages/schemas. A test enforces the registry:
  every code a handler emits belongs to one family, and every registered code is still
  emitted. It caught its first omission, `unknown_topic`, on the first run.
  `cork_capabilities` with no arguments now also returns the doc-topic catalog (`docTopics`).
  The advertised surface did not grow.

- **Terminal prose gets color and glyphs.** Human-readable output (results, errors,
  `--explain`) shows state badges
  (`✔ OK` green, `⚠ UNAVAILABLE` yellow, `✖ CONFLICT` red), colored keys, and dimmed
  provenance, on a TTY only. Precedence: `FORCE_COLOR`, then `NO_COLOR`
  (https://no-color.org), then `TERM=dumb`, then TTY detection per stream. No new dependency
  (`packages/cli/src/ansi.ts`). Tests pin two rules: stripped output equals plain output byte
  for byte, and `--json` output never carries an escape. Not covered surface (policy R11).
- **`cork_decode` labels 1inch LOP v4 fills and cancels.** kind `tx` and kind
  `calldata` decode `fillOrder`, `fillOrderArgs`, `fillContractOrder`, `fillContractOrderArgs`,
  and `cancelOrder` into a `lop` leg. The leg carries the eight order fields, the fill amount,
  the decoded taker traits (amount denomination, threshold, receiver, extension and
  interaction lengths), the args split the way `OrderMixin._parseArgs` splits them, and the
  maker signature (compact r/vs or ERC-1271 bytes). A chain-specific label adds the EIP-712
  `orderHash`, the maker-traits breakdown, and the same `jit` and `fusion` extension labels
  that kind `order` gives a resting order. The summary line names the trade: "fill 1inch limit
  order 0x… from maker …: take … of …, paying at most … of … [maker extension: Cork
  just-in-time market via adapter …]". The tool's own fill and cancel bytes no longer decode as
  UNREADABLE. kind `calldata` also accepts one recognized call, not only a Bundler3 multicall:
  a Cork adapter action, an ERC-20 leg, a ForSelf call, or a LOP fill or cancel. Unrecognized
  bytes stay invalid input, and the message now names the selector. SDK additions
  (`@cork/core` and `/orders`): `decodeLopCall`, `decodeTakerTraits`, `splitTakerArgs`,
  `orderFromUintTuple`, `lopFillAbi`, `lopCancelAbi`, `readLopInvalidator`,
  `classifyInvalidatorWord`, `ContractReader`. Root only: `labelOrderExtension`,
  `labelLopLegs`, `LopLegLabel`.

### Changed

- **The container image carries OCI annotations** (title, description, source, documentation,
  vendor, licenses in the apko spec; version and revision stamped at publish). A verifier can
  read them without pulling the SBOM.
- **Deployment docs state the image's one runtime need.** HyperSync reads extract the
  embedded binding to the temp dir and `dlopen` it, so the temp dir must be writable and
  exec-mappable (`TMPDIR` is honored; `noexec` fails with `failed to map segment`). The README
  shows a locked-down `docker run` (read-only root, tmpfs, all capabilities dropped). Audit of
  the v0.4.0-rc.1 image: 7 packages, no shell, no package manager, no setuid binary, uid 65532,
  one layer; 122 MB is the Bun runtime (89 MB) plus the binding (16.6 MB) — `--minify` saves 1%,
  so the image is as small as this runtime allows.
- **JIT prepares tell the caller to pin the constraint before the permit re-prepare.**
  A maker-side JIT order needs two prepares. The second embeds the permit over the predicted
  cST. The constraint is part of the pool identity. An oracle tick between the two prepares
  derived a different pool and a different cST than the permit covered (`jit_side_mismatch`).
  We saw this on a NAV pair, where the rate moves every block. `jit.permitNote`, the permit
  entry in `data.approvals`, and the `jit_side_mismatch` message now say: pass
  `jitMarket.constraint = jit.constraint` on the re-prepare.

## [0.3.0-rc.1] — 2026-08-17

**New line (0.2 → 0.3), declared by the integrability owner 2026-08-13 under policy R10/R11.**
We renamed the data-mode value `centralized` to `hybrid`. Mode is an input enum and a provenance
value, so the rename breaks covered surface and starts a new minor line. The old value gets a
teaching error that names the new value. Nothing old works silently, and nothing old breaks
silently.

### Changed (breaking)

- **`centralized` is now `hybrid`, and the mode earns the name.** Venue-backed list reads now
  run a chain-verification leg. The leg calls the same chain readers that lite-decentralized
  mode uses — one implementation, two consumers. The book verifies against the LOP invalidator.
  Pools verify against `market()` on every configured pool-manager generation. Fills verify
  against their `OrderFilled` logs. Rollover orders verify against the settler's `orderStatus`.
  Each row carries `verification: 'confirmed' | 'unverified'`. A row the chain refutes drops
  and is counted (`status_mismatch` [K7]). An indeterminate row stays, labeled: transport
  failures, rows past the 50-row `verification_budget`, and unknown status vocabulary are
  indeterminate, never refutations. trading-pairs rows never drop — the venue is the authority
  on what is listed, and chain existence rides as an `exists` annotation, because a JIT order
  can list a pair before its pool exists. With no RPC, every row serves labeled unverified: the
  old behavior, now disclosed. rfqs stay unverifiable, and `data.note` says so.
  `provenance.mode` reports `hybrid`.

### Added

- **The agent-eval suite hardened across every axis** (43 tasks, best full run 42/43 → 43/43
  reachable). New coverage: token approvals across the order lifecycle, a REAL signed resting
  order the fill task verifies end to end, and first-ever tasks for `cork_prepare_market` and
  `cork_submit`. The grading function is exported and unit-tested (a grading regression now
  fails a test, not a score baseline), an expected warning code matches any warning on the
  call, the model is gated to the sonnet family, and the tools+system prefix is prompt-cached
  (95% of run tokens served from cache, measured). One held-out task was repaired under an
  explicit owner decision (baseline reset 2026-08-17): `ho-authority` deliberately withholds
  two schema-required fields, and asking for them precisely — instead of inventing an
  allowance owner — is now a graded PASS (`clarify` honesty-probe alternative, strictly
  zero-calls so clarify text can never launder a wrong tool pick).
- **Every LOP-order prepare result now states its token approvals — with the unsigned grant
  payloads.** maker-order, finalize-maker-order, and taker-fill (raw and forSelf) carry
  `data.approvals`: one entry per required grant with holder, token, spender, stage, mechanism,
  amount, and the unsigned approve transaction (ERC-20 `approve`, or Permit2's own `approve`
  for the internal layer). The lifecycle is explicit: the maker's grants must exist before the
  order rests (a resting order without them looks fillable but reverts); the taker grants
  before broadcasting the fill. Permit2 sourcing (`usePermit2`) reports BOTH layers — token →
  Permit2 and the Permit2 internal allowance → the LOP with a live expiration (bound to the
  order's own expiry when it has one). JIT orders mark the predicted-cST side as covered by
  the embedded ERC-2612 permit — EOA-only, because the LOP executes no permit for a CONTRACT
  maker (verified in OrderMixin: `_fillContractOrder` skips the extension permit), which needs
  a standing allowance instead — and name the Cork JIT adapter's collateral pull, previously
  stated nowhere in results. Approval txs work identically from EOAs and contract wallets.
  With an RPC, entries are annotated against current on-chain allowances (boundary-exact,
  same rule as account-state) and confirmed-missing grants raise `approval_missing`. All
  payload bytes and comparators are mutation-probed (5 new probes).
- **`@cork/core` is now an integrator-ready SDK package with domain subpath exports.** The root
  export stays the full curated surface (envelope + every tier); eight subpaths (`/math`,
  `/orders`, `/registry`, `/chain`, `/bundle`, `/venue`, `/indexer`, `/config`) let a consumer
  load one tier without the rest — pure math never loads the venue client or an RPC transport.
  Two internal modules leave the public barrel (`breaker.ts`, `atomic-file.ts`; they carried no
  stability promise and no external consumer). The whole public surface — every export name on
  the root and each subpath, type exports included — is pinned by a new API-surface drift gate
  (`packages/core/test/api-surface.test.ts`, regenerate deliberately with `UPDATE_API_SURFACE=1`),
  and both cut-paths are mutation-probed. Package shape is audited by `bun run verify:publish`:
  `publint --strict` plus `arethetypeswrong` (every entry point green under node16-ESM and
  bundler resolution; `sideEffects: false`; types condition first; `./package.json` exported).
  Proven on the real integrator path: `bun pm pack` rewrites `workspace:*`, the tarballs
  npm-install cleanly, and Node resolves every subpath through the published exports map —
  `runTool("cork_capabilities")` answers `ok` with 9 tools from the installed tarball.
- **`modes` doc topic** (aliases `data-modes`, `backends`). It shows the three data modes side
  by side as connectivity pledges: hybrid contacts the venue and your RPC; lite-decentralized
  contacts your RPC only; full-decentralized contacts your RPC and HyperSync, never the venue.
  It carries hybrid's per-resource verification matrix and the choosing rule.
- **Incremental scan cursors for full-decentralized reads.** Each scan persists its decoded
  pre-filter rows and an archive watermark (`~/.cache/cork-helper-cli/scan-cache.json`,
  override `CORK_SCAN_CACHE_FILE`). The next call re-scans a 200-block reorg overlap plus the
  new range only. Partial backfills are never written back. Oversized row sets are never
  cached. The cache may only make a read cheaper, never change it.
- **Tokenless windowed-getLogs fallback.** Without an Envio token, full-decentralized now
  serves through bounded `eth_getLogs` windows over the resolved RPC instead of refusing. The
  result discloses `logs_windowed_fallback`; a capped walk discloses `pagination_incomplete`.
  A set-but-broken token still fails honestly. The whitelist replay never uses the fallback —
  membership needs the full history.
- **The `contracts_version` label-parity check returns to the live suite.** The label is venue
  vocabulary, so the venue's registry module is its legitimate arbiter. The check is
  best-effort: when the venue is unreachable, the test skips.
- **`taker-fill` accepts an inline `signedOrder` — the venue-free fill path.** You supply the
  order, signature, and extension: the exact shape that `finalize-maker-order`'s submitInput
  carries, or bytes the maker handed over. The venue is not contacted. A flaky book or a
  dropped row can no longer block a fill of bytes in hand. Verification meets the venue path's
  bar and adds what the venue used to check at post time: a local re-hash against the claimed
  `orderHash`, the salt↔extension binding that OrderLib enforces at fill, and the maker
  signature verified the way the fill verifies it — EOA by ecrecover, contract makers by the
  same ERC-1271 staticcall. The on-chain liveness pre-flight still runs. Both acquisition
  paths share one tail, and a parity test pins them byte-identical.
- **`trading-pairs` serves `full-decentralized`.** One pair row per created pool, derived from
  pool-creation events; every Cork order carries the pool's cST on one side by construction.
  The honest-subset note names what is absent: the venue's listing metadata is off-chain.
- **The `full-decentralized` fills feed is now Cork-scoped.** Without an `orderHash` filter it
  used to return the whole 1inch LOP with a "NOT Cork-scoped" warning. It now joins fills to
  Cork by same-transaction share-token movement. JIT creations are included — the mint is a
  Transfer from the zero address in the same transaction. Rows carry the `poolIds` their
  transaction touched. `filters.poolId` scopes the join. The scan starts at the first pool's
  creation block, not genesis. A chain with no pools answers an honestly empty feed. The cost
  is disclosed: the join runs three scans (pools, share-token transfers, fills) instead of
  one. A transaction that fills an unrelated 1inch order AND moves a Cork share token also
  matches — the note says so.
- **The apk signing public key is committed** (`packaging/melange.rsa.pub`). You can now verify
  apk and APKINDEX signatures against a key in the tree. The release pipeline compares the key
  it derives from `MELANGE_SIGNING_KEY` against this file and stops on a mismatch, so the
  trust root can never self-certify.

### Fixed

- **Multi-page rollover walks work now, on the venue-standard cursor.** Our transport sent a
  `cursor` param the pre-0.3.4 rollover routes silently ignored, so a walk could never pass
  page 1 — latent, because no rollover list has crossed one page yet. We briefly moved those
  three routes to `limit`+`offset` (the only pagination their 0.3.4 contract defined); hours
  later venue 0.3.5 standardized opaque keyset cursors on every list route, so we returned to
  `cursor` everywhere — one pagination vocabulary, no offset special case to maintain, and no
  deprecation debt (0.3.5 deprecates `offset` and flags every rollover response with a
  `warnings[]` notice our `venue_notice` relay surfaces). Verified against 0.3.5 live: an
  opaque cursor advances, a malformed cursor is the venue's loud 400, and a numeric cursor
  from an offset-era response is accepted for one request and upgraded. A venue that promises
  more rows without a cursor reads as an honest partial (`cursor_absent`), never a loop. The
  `trading-pairs` infinite-cursor bug we reported on 2026-08-13 was the same silent-strip trap
  sprung venue-side; venue 0.3.4 fixed it by accepting `cursor` on its five cursor-paged
  routes, and we verified the full walk live (358 rows, clean termination). Re-verified
  2026-08-17 against venue 0.3.14 (spec capture updated; the diff is additive only): the
  `/limit-orders/v1/markets` cursor-repeat loop we reported is fixed venue-side (15 pages,
  358 rows, complete), and the last silent-strip route (`whitelisted-addresses`) now takes
  canonical `cursor` and answers loud 400s on malformed, misspelled, or conflicting cursors.

### Changed

- **The registry read-API dependency is removed** (`api-phoenix.cork.tech/registry`, and the
  `CORK_MARKET_API` override with it). Its only consumer was the live parity suite, which used
  it as the external reference for our chain-native registry reads. The suite now carries an
  independent raw-read reference: its own minimal ABI declarations; one-shot enumeration reads
  that cross-check our pagination; the registry's `predictFixedRateOracle` view plus a code
  existence probe that cross-check our deploy simulation; a raw `recipe.resolve` staticcall
  compared wei-for-wei; an independent Market-tuple re-encode of the poolId; and
  label→labelHash re-hashing. All fifteen live tests pass against Arbitrum with zero requests
  to the service. One check retired with the dependency: the free-form `contracts_version`
  label lost its external arbiter for a day. This release restores it as the best-effort venue
  cross-check under Added.

## [0.2.0-rc.2] — 2026-08-12

This release aligns the tools with cork-api 0.3.3: module-scoped routing, the registry module,
and the new premium convention (the 2026-08-12 API day). Nothing here breaks an rc.1 caller.
We accept both premium spellings through the venue's migration window. The old venue paths also
still work through the venue's temporary rewrite; this release moves off that rewrite before the
venue retires it.

### Added

- **`premiumAnnualized` on lop-order and the finalize listing.** This is the venue's successor
  premium field: an annualized fraction as a decimal string, so `"0.041"` means 4.1%. The RFQ
  surface already uses the same name and unit — the policy R13 new-unit-new-name mechanism,
  working as designed. We replicated the venue's premium resolution operation for operation from
  its post-order route:
  - You must send at least one spelling. We teach this locally (`invalid_order_terms`).
  - We canonicalize the fraction with `parseFloat × 100`, exactly as the venue does.
  - If you send both spellings and they disagree, we refuse with the venue's exact 1e-9-relative
    comparison. The new conflict code is `premium_fields_disagree`.
  - The fraction takes precedence, and the quote_ref band runs on the canonical percent. A
    fraction-declared order needs no ×100 step anywhere.

  The book's fraction gate has two layers, like the RFQ's: the published pattern is structure;
  the ≤ 100 bound (the mirror of the legacy 10000% ceiling) is policy. The percent `premium` is
  now optional and DEPRECATED. The venue removes it on 2026-08-17; if you send it, we warn
  `deprecation_notice` with that date. Eleven new mutation probes pin these gates.
- **Venue notices surface as `venue_notice`.** cork-api 0.3.3 responses carry a `warnings[]`
  channel; its first use is the premium deprecation with its removal date. Venue list reads,
  taker-fill's book search, and successful submit relays now show each notice verbatim under
  this label. We dedupe notices across traversal pages.
- **Deprecated-path telemetry as `venue_deprecated_path`.** When the venue serves a call through
  its temporary `/v1/<module>` rewrite, it sets `Deprecation: true` and `x-cork-canonical-path`.
  We now report that. This release uses the canonical path literals, so this warning means one
  of two things: a stale base override, or a stale path literal.
- **Approved-implementations guard (the interface-first model).** The config gains an
  `approvedImplementations` allowlist: per chain, per trusted role, resolved against the address
  blocks that already exist. We captured the hashes live on 2026-08-12. Every
  `cork_prepare_phoenix` pre-flight now hashes the LIVE runtime code behind four roles:
  corkAdapter, whitelistManager, marketRegistry, and jitAdapter. For whitelistManager we read
  the EIP-1967 implementation slot first, because a proxy's own code never changes on an
  upgrade. Code that is not on the list warns `implementation_not_approved`. The guard builds
  and warns; approved and unreadable code stay silent. An implementation joins the list only
  after the behavioral suite passes against it. We proposed the same schema for the
  distribution repo (teased in
  [distribution#1](https://github.com/Cork-Technology/distribution/issues/1)), with
  `byteParams` — the interface revisions that ABIs cannot express. Until the repo adopts it,
  the guard runs entirely from our config.
- **Venue spec-hash tripwire.** A live-gated test (CORK_RPC_LIVE=1) canonicalizes the venue's
  published openapi and compares it against a committed capture. A venue contract change now
  arrives as a named alert with a reviewable fixture diff, not as unexplained 400s. Re-capture
  deliberately with UPDATE_VENUE_SPEC=1 — the surface-drift workflow, pointed outward.

### Changed

- **Venue routing is module-scoped (the cork-api 0.3.3 canonical form).** `DEFAULT_VENUE_URL` is
  now the bare origin, and every path literal carries its module's version
  (`/limit-orders/v1/…`, `/rollover/v1/orders`, `/rfqs/v1`, `/pools/v1`). If a configured
  `CORK_VENUE_URL` still ends in `/v<n>` (the pre-0.3.3 convention), we strip that suffix.
  Without the strip, requests would compose into `/v1/<module>/v1/…` — a path no form of the
  API ever served.
- **The registry live-parity default moved to the cork-api registry module**
  (`https://api-phoenix.cork.tech/registry`; override with `CORK_MARKET_API`). The standalone
  dev sandbox retires after the cutover. Our path literals compose with the mount into the
  canonical `/registry/v1/…` form, unchanged.

### Fixed

- **ERC-1271 maker orders could not post, and contract-maker book rows could not parse.** The
  venue's wire vocabulary is `EOA | CONTRACT`; we verified this against its post and get
  schemas. Our relay posted `makerAccountType: "ERC1271"` verbatim, and the venue schema
  rejected it with HTTP 400. Our row parser refused `"CONTRACT"` rows, so taker-fill returned
  `invalid_service_response`. We now translate in both directions at the boundary. Our own
  surface vocabulary is unchanged.
- The premium-paste teaching message now computes its suggested spelling with exact string
  math. A float division produced suggestions like `0.041000000000000002` — the wrong lesson.

## [0.2.0-rc.1] — 2026-08-12

**This cut starts a new line (0.1 → 0.2).** The integrability owner declared it on 2026-08-11
under policy R5/R14. The cut carries three behavior changes in R14's class: no schema diff shows
them, but a non-author judged (as R14 requires) that they change what adapted integrations
observe. Under policy R10, `y` plays the major's role below 1.0.0, so a `^0.1.x` resolver will
NOT cross into 0.2.x: an rc.3 runner's build stops instead of silently absorbing changed
behavior. Details under Changed.

### Added

- **`docs/jit-order-anatomy.md`** (issue #2): the chain-agnostic, address-free contract
  reference for JIT orders. It covers: the `extraData` structs field by field; the permit rule
  (who signs, the LOP as the sole spender, execution right after the mint, the ForSelf
  non-interaction); the `rateOverride` and fee-field rules; the four-step fill sequence; the
  maker/taker entry-point asymmetry (`enableJitMint` is IGNORED on the taker path); both event
  signatures; the full adapter and creation-bounds error table; the adapter's four immutables
  with the `MARKET_REGISTRY()` cross-generation check; and the roles precondition
  (`POOL_CREATOR_ROLE` + `FEE_MANAGER_ROLE`). We verified the roles on the deployed controller
  on 2026-08-12 — the pre-v1.3 `CONFIGURATOR_ROLE` pair reports a false negative against the
  live fill path.
- **Registry-semantics block in `docs/cli.md`** (issue #2). It explains: the oracle mode
  composition rule; the pair-order/mode asymmetry; feed direction and the decimals-drift check;
  the recipe args tuple-notation trap and the mixed constant scales; how derivation simulates
  the deploy, the state-override RPC it needs, and how `ch` degrades honestly
  (`share_prediction_unavailable`); and the rule to never infer the chain from an address.
- **Docs-freshness gate** (`packages/core/test/docs-freshness.test.ts`). The suite asserts the
  quickstart's generation markers — registry, adapter, and recipe addresses, and every
  "contracts release X" claim — against `cork-defaults.json`. It asserts that retired-generation
  addresses are absent, and that the anatomy doc stays address-free. The next registry redeploy
  fails the suite until the partner docs move with it. We kill-checked the gate against the
  rc.3 text: 3 of 3 drift assertions fail on it.

- **`x-units` on every scaled input field** (a covered-surface addition): machine-readable unit
  notation (`D18{1}`, `D18{%}`, `{qTok}`, …), valued from the same vocabulary as the `units`
  topic table. A three-axis parity test binds the wire extension, the table row, and the
  description prose for each field. The surface-drift fixture now stores FULL schemas (it
  stored hashes), so a unit change shows in the fixture diff — you can review it, not just
  detect it.
- **Audit R2 closed** (input schema descriptions). `permits[].value` is typed as a TokenAmount
  with the predicted-cST teaching. The four JIT constraint bounds carry per-field scale and
  x-units (the shared `RateConstraintWire`). Rollover `orderSize`, `minCaReceived`,
  `minSharesOut`, and `dstCstProduced` state their token and decimals. `notionalAssets` names
  its `one_of`-decimals ambiguity and the remediation. The rfq-answer options gate is
  advertised in the schema, with the structure vs relaxable-policy split per the owner ruling.
- **Tiered surface-drift gate** (dev-infra). Drift failures now classify mechanically
  (`surface-tier.ts`): a prose change needs a regenerate only; a semantic change needs Layer B
  first, held-out included. An ambiguous change fails expensive by construction. The classifier
  is mutation-probed.
- **Eval harness persistence** (dev-infra). Every Layer B run writes per-task rows to
  `evals/.last-run.jsonl`. Eval fixtures now read deployment addresses from
  `cork-defaults.json` — a pinned 0.3.2 registry address had silently turned two tasks red
  after the 0.3.3 redeploy.
- The apk release channel fails fast with teaching when `MELANGE_SIGNING_KEY` is unset.
- **Committed default RPC for Base (8453)** (owner-provided 2026-08-12). chainlist.org was
  previously the ONLY automatic path for Base — the #3 finding of the dependency SPOF audit,
  and the cause of a flaky live-smoke CI run. Base chain reads now work out of the box, like
  mainnet and Arbitrum. The chainlist fallback stays behind the breaker. An executable test
  pins the three-default set — the "never commit an RPC URL" exception, as code.
- **Taker-side `jitMarket` fee fields carry `x-units`** (a covered-surface addition). The maker
  copy had the markers; the taker copy had silently lost them. The three-axis parity test
  cannot see that omission — it checks that emitted values agree, and a site that emits nothing
  is invisible. Both paths now share one schema constant per fee field, which closes the
  omission class structurally. Same batch: `cork_submit` rollover pool ids teach via `MarketId`
  and `permits[].value` via `TokenAmount` — wire-compatible `$ref` upgrades with identical
  patterns.
- **Taker JIT pre-flights disclose what the maker path already did.** A failed `recipe.verify`
  read now warns `chain_read_failed`, and an undeployed oracle now warns `oracle_not_deployed`,
  on fills too. The shared pre-flight ladder made the asymmetry visible and impossible to
  reintroduce.
- **`cork_submit` rollover-order settler disclosures** (F14 parity with prepare). An
  unrecognized settler, or a chain with no rollover config, now relays WITH
  `settler_not_recognized`. Before, the submit path silently skipped the check a prepare-path
  caller gets.
- **Offline drift gates for hand-maintained address tables** (dev-infra). `RECIPE_CATALOG` and
  the worked examples' recipe addresses are now parity-tested against `cork-defaults.json`
  offline. The 0.3.3-redeploy hand-edit class fails in CI, not in a live run someone happens to
  start. The mutation-probe runner also hardened: an ambiguous anchor is now rot, because a
  first-occurrence replace could mutate the wrong site and still report "caught".

### Changed

- **[R14 prose] `permit2Internal.expired` now replicates Permit2's own gate exactly**
  (`block.timestamp > expiration`; audit R9). Two verdicts flip. An allowance with
  `expiration: 0` now reports `expired: true` — Permit2 has no zero special-case, and the old
  `false` certified an allowance the chain rejects with `AllowanceExpired`. The exact boundary
  second now reports `expired: false` — spending is legal AT expiration. **What to do:** if
  your tests or logic pinned `expired: false` for zero-expiration states, update them. The old
  verdict walked funding flows into on-chain reverts; the new one matches what a fill does.
- **[R14 prose] CLI argument-parse errors now honor the JSON error contract.** Under
  `CORK_JSON=1` or any `--json` spelling, unknown-option, unknown-command, and excess-argument
  errors emit the standard `{"error":{"code":"invalid_input",…}}` envelope on stderr. Before,
  commander printed plain text — the one stderr path a JSON consumer could not parse. Exit
  codes are unchanged. **What to do:** if a script regex-parsed the old plain text (an
  uncovered surface), change it to `JSON.parse` stderr like every other error path. Plain-text
  mode without JSON intent is byte-compatible.
- **[R14 prose] Oversized values in integer-typed flags reclassify from `invalid_input` to
  `invalid_amount`.** Integer flags now share the amount-sugar dialect, so `1_000` and `1e3`
  both work — before, two adjacent flags accepted different spellings by accident. A value that
  expands past 2^53 is refused as `invalid_amount` with teaching, instead of falling through to
  a schema type error. **What to do:** if you branch on `error.code` for absurd-magnitude
  inputs to integer fields, add `invalid_amount` to that branch.
- `ch query --json pools` (a bare `--json` that swallows a positional) now teaches the exact
  corrected spelling instead of a bare parse error.
- **[R14 prose] The auction `phase` label agrees with the price at the start boundary.** At
  exactly `t == startTime`, all three reporting surfaces now say `"pre-start"`. Before, two of
  them said `"decaying"` while the price beside them was still the full-bump ceiling — the
  settlement port charges `initialRateBump` AT startTime (`<=`). **What to do:** if you
  branched on `phase == "decaying"` to mean "the order is live", include `"pre-start"`. The
  order was always fillable in that state, at the ceiling price.
- **[R14 prose] Failure attribution corrected on two JIT/oracle paths.** A missing
  `poolManager` deployment during cST prediction now reports `share_prediction_unavailable`;
  before, it was a misattributed `chain_read_failed` TypeError. A `lookupWrapper` TRANSPORT
  failure in `cork_prepare_market` now reports `chain_read_failed`; before, it was
  `oracle_not_deployable` — a deployability verdict an indeterminate read cannot support.
  **What to do:** branch on the new codes if you pinned the old ones for these situations. The
  situations themselves are unchanged.
- **[R14 prose] `CORK_EXPLAIN_JSON` speaks the strict CORK_* dialect** (`"1"`/`"true"` only).
  It alone accepted any value other than `"0"`/`"false"`. Loose spellings like `yes` now render
  prose.
- The teaching-error remediation says "all enums are closed" only when some issue actually
  carries a closed value set. Before, the line rode every remediation and misled checksum,
  timestamp, and missing-field failures into hunting for a nonexistent enum.
- `--enable-deprecated` no longer leaks `CORK_ENABLE_DEPRECATED` into later `runCli` calls in
  the same process (tests, embedding). The flagged call itself is unchanged.
- The "(formerly digest_mismatch)" message suffixes from rc.3 remain through this release. The
  one-release notice window closes with the next cut.

### Fixed

- **`docs/zyfai-quickstart.md` refreshed from the retired 0.3.2 generation to 0.3.3**
  (issue #1). The status block now says: roles granted 2026-08-10 on both chains; Base is past
  its first market, with live JIT fills and ~50 short-dated pilot pools. §5G gains the redeploy
  cutoff and a new "which generation am I on" rule pair — an abandoned generation answers with
  plausible values; the `MARKET_REGISTRY()` cross-check catches that, and the doc shows where
  `ch` automates it. §5A's fork evidence is re-stated against the current stack (suites re-run
  green 2026-08-12). We re-captured every worked example live against 0.3.3 on Base: registry,
  adapter, and recipe addresses; the pair's new nav wrapper; re-derived poolId, cST, and cPT;
  plus a real rate-drift episode that teaches why the order must carry the derived constraint
  verbatim. The step-2 decode now explains `"permits": N` in place (issue #2's spot-edit) and
  cross-links the anatomy doc.
- The advertised `cork_query` description named the retired `flows` resource (now
  `rollover-orders`, and `rfqs` is listed) and carried an "an trading-pair" typo. The `ch mcp`
  entrypoint help and the commander stub documented different option sets, and both still said
  `/docs/signing` though the route serves every topic.
- The advertised `cork_prepare_market` description stated the 2-arg `deploy(ca, ref)` — it
  takes `mode` — and named only Arbitrum (it is live on 42161 + 8453). Registry-view maturity
  reasons still cited the superseded 2026-08-03 deployment.
- **Two audit passes over the whole tree** (2026-08-11/12). We verified them byte-equivalent on
  a 12-call offline behavioral battery against rc.3: unsigned bundle bytes, maker typed-data,
  decode outputs, and math are identical; only the deliberate teaching deltas differ. The work:
  the maker/taker JIT pre-flight ladder is single-sourced (`runJitPreflightLadder` — the copies
  had already drifted). `cork_submit` now derives the LOP order hash and makerTraits fields
  from the same `orders.ts` code the maker path signs; its private re-implementations are
  deleted. ONE salt↔extension comparator, oracle-status probe, deprecated-mode resolver,
  permit-wire parser, fetch-timeout, and first-line-error helper replace 3–6 private copies
  each. HyperSync topic selectors derive from the parsed event declarations — each signature
  was maintained twice in that file. Dead exports and a dead config resolution path
  (`deploymentFor` — bundled-only, which contradicted remote-first) are removed. 13 new tests;
  the probe catalog grew from 172 to 176, all caught, zero rot.

## [0.1.0-rc.3] — 2026-08-10

### Added

- **RFQ negotiation surface.** `cork_submit rfq-counter` is the requester's
  non-committal counter-bid, with the venue's own gates replicated client-side: the fraction
  contract, and the requester, expiry, and citation pre-flights. `rfq-answer` gains an optional
  `supersedes`. The `rfqs` read gains `filters.view` (`full`|`current`), which serves the
  negotiation frontier; the schema teaches `version`-based change polling.
- **`units` doc topic** — the scale table agents can ask for (`cork_capabilities
  topic:"units"`), wired into every numbers-contract tripwire message. Money and rate outputs
  across compute, query, and decode now carry explicit `scales` blocks (audit R1 closed).
- **market-registry 0.3.3** (Arbitrum One + Base, identical addresses). The CREATE2-collision
  fix is integrated and live-verified. CREATE2 attestations gain public rebuild pointers
  (`source`: repo@tag + forge path) and config-binding declarations (`binds`); coverage is
  pinned — 15 entries, all re-derived locally.
- **Live venue contract test** (`venue-live.test.ts`). It asserts the negotiation read contract
  against the deployed venue — frontier partition arithmetic and version monotonicity — and
  runs in CI's live-smoke.

### Changed

- **`digest_mismatch` split into four branchable codes** (covered-surface change, rc-line
  only): `artifact_digest_mismatch`, `intent_hash_mismatch`, `venue_digest_mismatch`,
  `order_hash_mismatch`. Messages carry "(formerly digest_mismatch)" for one release.
- **RFQ pre-flights now predict the deployed venue, not an idealized decimal contract.** The
  fraction cap mirrors the venue's `parseFloat` refine. The `quote_ref` premium band replicates
  the venue's strict float gate operation for operation, which removes two false-block classes.
  A citation the truncated answers embed cannot resolve now relays flagged
  `citation_unresolved` instead of false-refusing. The venue's provenance checks —
  maker==requester, option chain, and collateral coherence — run client-side with teaching.
- **One CLI synonym resolver across every input path** (audit R4). Resource aliases are
  case-insensitive, like chain names. Positional fields also ride as flags (`--resource`,
  `--chain-id`). Variant subcommands and top-level verbs accept the parent's positional
  (`ch exercise 1`). Canonicalised variant spellings are rewritten pre-parse, so `--explain`
  can no longer show the wrong contract. `ch capabilities <query>` searches.

### Fixed

- Footgun-audit hardening. `rollover-premium-floor` now rounds CEIL (settler parity).
  Unsafe-integer JSON numbers refuse instead of silently rounding (order records,
  `filters.rate`). `chainid_defaulted` warns when an omitted chainId picked mainnet for a
  chain-specific hash.

## [0.1.0-rc.2] — 2026-08-10

Identical content to 0.1.0-rc.1, plus one release-pipeline fix. The cross-OS smoke step used
`tee /dev/stderr` — a device Windows git-bash lacks — so `pipefail` failed a PASSING Windows
binary check, and the publish gate correctly withheld the release. The rc.1 rehearsal proved
everything else: the version gate, two independent byte-identical builds, the provenance
attestation, and the binaries themselves on all four OS families. rc.1's tag remains unpublished
history.

## [0.1.0-rc.1] — 2026-08-09 (tag exists; release not published — smoke-script bug, see rc.2)

The first tagged release candidate: the Cork Phoenix **MCP server + CLI over one typed core**.
Nine tools; MCP and CLI are thin projections of the same `runTool` dispatch.

### Added

- The 9-tool surface: `cork_capabilities`, `cork_query`, `cork_compute`, `cork_decode`,
  `cork_prepare_phoenix`, `cork_prepare_orders`, `cork_prepare_market`, `cork_track`,
  `cork_submit`. Prepare, sign, and submit stay separate throughout: nothing signs, and only
  `cork_submit` relays caller-signed payloads.
- The CLI `ch`: one command per tool; discriminated actions as subcommands; schema-derived flags
  with exact amount sugar (`1000e18`); `--explain` contracts; prose by default and JSON on
  request; exit codes mapped to envelope state (0 ok · 2 invalid · 3 unavailable · 4 conflict).
- MarketRegistry **2.1.0 model, contracts release 0.3.2** (Arbitrum One + Base, identical
  addresses): registry reads (`registry-assets/-recipes/-denominations/-feeds/-oracle`);
  `derive-cork-pool` (full pool identity before the pool exists, oracle-undeployed included);
  `recipe-rate-constraint` (the off-chain `recipe.resolve` a JIT order signs); JIT maker/taker
  order building with carried constraints; and oracle-deploy transactions with a typed-error
  post-mortem (`oracle_not_deployable` separates registration problems from the
  cross-generation CREATE2-collision class).
- Cork-native decaying-premium auctions (1inch Fusion v3.1 as a pure amount getter): maker-order
  `auction`, local pricing with `dutch-auction-price`, and auction-aware taker-fill caps.
- ForSelf integrator mode (`forSelf`) for parameter-blind session-key wallets, with adapter
  binding and whitelist-generation pre-flights; ERC-1271 contract-maker signature verification.
- Sweep-back legs on every capped funding input — the adapter-residual theft window closes in
  the same bundle. Pre-flight guards (expiry, pause, the two-address whitelist) build and warn.
- Bounded venue traversals with honest pagination; HyperSync full-decentralized reads with a
  live-tail RPC merge; per-host circuit breakers; RPC failover that discloses in-call.
- Teaching errors on every schema failure, on both surfaces: structured issues, a did-you-mean,
  and corrected examples that themselves validate.
- A single-binary release pipeline: reproducible `bun build --compile` (7 targets), a
  dual-runner determinism gate, SLSA build-provenance attestations, and `ch self-update`, which
  verifies attestations before it swaps the binary.

### Changed (behaviour a diff cannot see — policy R14 prose)

- **Taxonomy (2026-08-08/09, pre-release; old names answer with teaching, never silently).** A
  *cork-pool* is one expiry of a *market* — the family over one collateral/reference pair. A
  *trading-pair* is an LOP venue listing. The resource renames: `market`→`cork-pool`,
  `markets`→`cork-pools`, `derive-market`→`derive-cork-pool`,
  `limit-order-markets`→`trading-pairs`, `flows`→`rollover-orders`; the compute kind
  `resolve-recipe`→`recipe-rate-constraint`; prepare-market `deploy-wrapper`→`deploy-oracle`.
  Every pre-rename value is rejected with a "was renamed to …" teaching error. Nothing old
  silently works, and nothing old silently breaks. Schema *field* names (`jitMarket`, `poolId`,
  the on-chain `Market` struct) are deliberately unchanged.
- Amount and rate outputs are unit-labelled (`scales` blocks, `collateralDecimals` /
  `referenceDecimals`). Never assume 18 decimals.
- Auction taker-fills default the slippage cap to the curve **ceiling**, not the signed floor,
  so the artifact stays valid at any broadcast time. The decayed, floor, and ceiling prices are
  reported; an explicit below-price cap warns `would_revert`.

### Deprecated

- The pre-2.1.0 registry generation (mode-string JIT, fill-time band resolution) survives intact
  behind `legacy:true` + `CORK_ENABLE_DEPRECATED=1` (CLI `--enable-deprecated`). Invoking it
  without the opt-in returns `deprecated_gated` with the replacement named. `jitMarket.mode` as
  sugar for a recipe address still works and warns `deprecation_notice`.

### Known gaps (recorded per Checklist A)

- `cork_compute` rfq-quote stays `phase_gated` by design. A pricing model is a product decision;
  the decaying-premium auction is the modeled-quote-free alternative.
- Distribution reporting (`--version` naming a Distribution, policy R4) awaits the distribution
  repo and manifest — adoption Phase 2. This release is a component version only.
- No pools exist on the v1.3.0-rc.1 pool manager yet. `cork-pool` reads against derived but
  uncreated pools return `chain_read_failed` — a documented, expected state.
