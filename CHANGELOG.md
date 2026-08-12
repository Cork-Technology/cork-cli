# Changelog

All notable changes to this component. Versioning follows the
[Versioning and Distribution Policy](https://github.com/Cork-Technology/cork-knowledge/blob/main/policies/versioning-and-release.md):
plain SemVer per repo; below `1.0.0`, a breaking change on covered surface bumps the **minor**
(policy R10). Covered surface for this component (policy R11): JSON output, tool names and input
schemas, and exit codes — human-readable text and log formats are not covered.

## [0.2.0-rc.1] — unreleased

**New line (0.1 → 0.2), declared by the integrability owner under policy R5/R14** (2026-08-11):
this cut carries three behavior changes in R14's class — visible to no schema diff, judged (by a
non-author, as R14 requires) to change what adapted integrations observe. Per R10, `y` plays the
major's role below 1.0.0, and at `^0.1.x` a resolver will NOT cross into 0.2.x: an rc.3 runner's
build stops instead of silently absorbing changed behavior. Details under Changed.

### Added

- **`docs/jit-order-anatomy.md`** (issue #2): the chain-agnostic, address-free contract reference
  for JIT orders — the `extraData` structs field by field, the permit rule (who signs, the LOP
  as sole spender, execution right after the mint, the ForSelf non-interaction), `rateOverride`
  and fee-field rules, the four-step fill sequence, the maker/taker entry-point asymmetry
  (`enableJitMint` IGNORED on the taker path), both event signatures, the full adapter +
  creation-bounds error table, the adapter's four immutables with the `MARKET_REGISTRY()`
  cross-generation check, and the on-chain-verified roles precondition (`POOL_CREATOR_ROLE` +
  `FEE_MANAGER_ROLE` — the pre-v1.3 `CONFIGURATOR_ROLE` pair reports a false negative against
  the live fill path; verified on the deployed controller 2026-08-12).
- **Registry-semantics block in `docs/cli.md`** (issue #2): oracle mode composition rule,
  pair-order/mode asymmetry, feed direction + decimals-drift check, recipe args tuple-notation
  trap and mixed constant scales, derivation-simulates-deploy with the state-override RPC
  requirement and `ch`'s honest degradation (`share_prediction_unavailable`), and the
  never-infer-chain-from-address rule.
- **Docs-freshness gate** (`packages/core/test/docs-freshness.test.ts`): the quickstart's
  generation markers (registry/adapter/recipe addresses, every "contracts release X" claim) are
  now asserted against `cork-defaults.json`, retired-generation addresses are asserted absent,
  and the anatomy doc is asserted address-free — the next registry redeploy fails the suite
  until the partner docs move with it (kill-checked against the rc.3 text: 3/3 drift assertions
  fail on it).

### Fixed

- **`docs/zyfai-quickstart.md` refreshed from the retired 0.3.2 generation to 0.3.3**
  (issue #1): status block (roles granted 2026-08-10 on both chains; Base post-first-market with
  live JIT fills and ~50 short-dated pilot pools), §5G's redeploy cutoff + a new
  "which generation am I on" rule pair (abandoned generations answer with plausible values; the
  `MARKET_REGISTRY()` cross-check and where `ch` automates it), §5A's fork evidence re-stated
  against the current stack (suites re-run green 2026-08-12), and every worked example
  re-captured live against 0.3.3 on Base — registry/adapter/recipe addresses, the pair's new
  nav wrapper, re-derived poolId/cST/cPT, plus a real rate-drift episode teaching why the
  derived constraint must be carried verbatim into the order. The step-2 decode now explains
  `"permits": N` in place (issue #2's spot-edit) and cross-links the anatomy doc.

- **`x-units` on every scaled input field** (covered-surface addition): machine-readable unit
  notation (`D18{1}`, `D18{%}`, `{qTok}`, …) valued from the same vocabulary as the `units`
  topic table; a three-axis parity test binds the wire extension, the table row, and the
  description prose per field. The surface-drift fixture now stores FULL schemas (was hashes),
  so unit changes are reviewable in the fixture diff, not just detectable.
- **Audit R2 closed** (input schema descriptions): `permits[].value` typed as a TokenAmount with
  the predicted-cST teaching; the four JIT constraint bounds carry PER-FIELD scale + x-units
  (shared `RateConstraintWire`); rollover `orderSize`/`minCaReceived`/`minSharesOut` and
  `dstCstProduced` state their token and decimals; `notionalAssets` names its `one_of`-decimals
  ambiguity with the remediation; the rfq-answer options gate is advertised in the schema
  (structure vs relaxable-policy split per the COR-35 ruling).
- **Tiered surface-drift gate** (dev-infra): drift failures classify mechanically
  (`surface-tier.ts`) into prose (regenerate only) vs semantic (Layer B first, held-out
  included); ambiguity fails expensive by construction; classifier mutation-probed.
- **Eval harness persistence** (dev-infra): every Layer B run writes per-task rows to
  `evals/.last-run.jsonl`; eval fixtures read deployment addresses from `cork-defaults.json`
  (a pinned 0.3.2 registry address had silently turned two tasks red after the 0.3.3 redeploy).
- apk release channel fails fast with teaching when `MELANGE_SIGNING_KEY` is unset.
- **Committed default RPC for Base (8453)** (owner-provided 2026-08-12): chainlist.org was
  previously the ONLY automatic path for Base — the #3 finding of the dependency SPOF audit,
  and the cause of a flaky live-smoke CI run. Base chain reads now work out of the box like
  mainnet and Arbitrum; the chainlist fallback remains behind the breaker. The three-default
  set is pinned by an executable test (the "never commit an RPC URL" exception, as code).
- **Taker-side `jitMarket` fee fields carry `x-units`** (covered-surface addition): the maker
  copy had the markers, the taker copy had silently lost them — an omission the three-axis
  parity test cannot see (it checks that emitted values agree; a site emitting nothing is
  invisible). Both paths now share one schema constant per fee field, so the omission class is
  structurally closed. Same batch: `cork_submit` rollover pool ids teach via `MarketId` and
  `permits[].value` via `TokenAmount` (wire-compatible `$ref` upgrades — identical patterns).
- **Taker JIT pre-flights disclose what the maker path already did**: a failed `recipe.verify`
  read (`chain_read_failed`) and an undeployed oracle (`oracle_not_deployed`) now warn on fills
  too — the shared pre-flight ladder made the asymmetry visible and impossible to reintroduce.
- **`cork_submit` rollover-order settler disclosures** (F14 parity with prepare): an
  unrecognized settler, or a chain with no rollover config, now relays WITH
  `settler_not_recognized` instead of silently skipping the check a prepare-path caller gets.
- **Offline drift gates for hand-maintained address tables** (dev-infra): `RECIPE_CATALOG` and
  the worked examples' recipe addresses are now parity-tested against `cork-defaults.json`
  offline — the 0.3.3-redeploy hand-edit class fails in CI, not in a live run someone happens
  to start. The mutation-probe runner also hardened: an ambiguous anchor is rot (a
  first-occurrence replace could mutate the wrong site and still report "caught").

### Changed

- **[R14 prose] `permit2Internal.expired` now replicates Permit2's own gate exactly**
  (`block.timestamp > expiration`; audit R9). Two observable flips: an allowance with
  `expiration: 0` now reports `expired: true` (Permit2 has no zero special-case — the old
  `false` certified an allowance the chain would reject with `AllowanceExpired`), and the exact
  boundary second now reports `expired: false` (spending is legal AT expiration). **What to do:**
  if your tests or logic pinned `expired: false` for zero-expiration states, update them — the
  old verdict walked funding flows into on-chain reverts; the new one matches what a fill will
  actually do.
- **[R14 prose] CLI argument-parse errors now honor the JSON error contract.** Under
  `CORK_JSON=1` or any `--json` spelling, unknown-option/unknown-command/excess-argument errors
  emit the standard `{"error":{"code":"invalid_input",…}}` envelope on stderr instead of
  commander's plain text (the one stderr path a JSON consumer could not parse). Exit codes are
  unchanged. **What to do:** a script that regex-parsed the old plain text (an uncovered
  surface) should `JSON.parse` stderr like every other error path; plain-text mode without JSON
  intent is byte-compatible.
- **[R14 prose] Oversized values in integer-typed flags reclassify** `invalid_input` →
  `invalid_amount`: integer flags now share the amount-sugar dialect (`1_000` and `1e3` both
  work — previously two adjacent flags accepted different spellings by accident), and a value
  expanding past 2^53 is refused as `invalid_amount` with teaching instead of falling through
  to a schema type error. **What to do:** if you branch on `error.code` for absurd-magnitude
  inputs to integer fields, add `invalid_amount` to that branch.
- `ch query --json pools` (a bare `--json` swallowing a positional) now teaches the exact
  corrected spelling instead of a bare parse error.
- **[R14 prose] The auction `phase` label agrees with the price at the start boundary**: at
  exactly `t == startTime` all three reporting surfaces now say `"pre-start"` (two of them said
  `"decaying"` while the price beside them was still the full-bump ceiling — the settlement
  port charges `initialRateBump` AT startTime, `<=`). **What to do:** if you branched on
  `phase == "decaying"` to mean "the order is live", include `"pre-start"` — the order was
  always fillable in that state, at the ceiling price.
- **[R14 prose] Failure attribution corrected on two JIT/oracle paths**: a missing
  `poolManager` deployment during cST prediction now reports `share_prediction_unavailable`
  (was a misattributed `chain_read_failed` TypeError), and a `lookupWrapper` TRANSPORT failure
  in `cork_prepare_market` now reports `chain_read_failed` (was `oracle_not_deployable` — a
  deployability verdict an indeterminate read cannot support). **What to do:** branch on the
  new codes if you pinned the old ones for these situations; the situations themselves are
  unchanged.
- **[R14 prose] `CORK_EXPLAIN_JSON` speaks the strict CORK_* dialect** (`"1"`/`"true"` only):
  it alone accepted any non-`"0"`/`"false"` value. Loose spellings like `yes` now render prose.
- Teaching-error remediation says "all enums are closed" only when some issue actually carries
  a closed value set — it used to ride every remediation, misleading checksum/timestamp/missing-
  field failures into hunting for a nonexistent enum.
- `--enable-deprecated` no longer leaks `CORK_ENABLE_DEPRECATED` into later `runCli` calls in
  the same process (tests, embedding); the flagged call itself is unchanged.
- The "(formerly digest_mismatch)" message suffixes from rc.3 remain through this release; the
  one-release notice window closes with the next cut.

### Fixed

- Advertised `cork_query` description named the retired `flows` resource (now
  `rollover-orders`, and `rfqs` is listed) and carried an "an trading-pair" typo; `ch mcp`
  entrypoint help and the commander stub documented different option sets and both still said
  `/docs/signing` though the route serves every topic.
- Advertised `cork_prepare_market` description stated the 2-arg `deploy(ca, ref)` (it takes
  `mode`) and named only Arbitrum (live on 42161 + 8453); registry-view maturity reasons still
  cited the superseded 2026-08-03 deployment.
- **Two audit passes over the whole tree** (2026-08-11/12), verified byte-equivalent on a
  12-call offline behavioral battery against rc.3 (unsigned bundle bytes, maker typed-data,
  decode outputs, and math identical; only the deliberate teaching deltas differ): the
  maker/taker JIT pre-flight ladder single-sourced (`runJitPreflightLadder` — the copies had
  already drifted); `cork_submit` now derives the LOP order hash and makerTraits fields from
  the same `orders.ts` code the maker path signs (its private re-implementations deleted); ONE
  salt↔extension comparator, oracle-status probe, deprecated-mode resolver, permit-wire
  parser, fetch-timeout, and first-line-error helper replace 3–6 private copies each;
  HyperSync topic selectors derive from the parsed event declarations (each signature was
  maintained twice in that file); dead exports and a dead config resolution path
  (`deploymentFor` — bundled-only, contradicting remote-first) removed. 13 new tests; probe
  catalog grew 172 → 176, all caught, zero rot.

## [0.1.0-rc.3] — 2026-08-10

### Added

- **RFQ negotiation surface** (venue a2b03bd): `cork_submit rfq-counter` — the requester's
  non-committal counter-bid, with the venue's own gates replicated client-side (fraction
  contract, requester/expiry/citation pre-flights); optional `supersedes` on `rfq-answer`;
  `filters.view` (`full`|`current`) on the `rfqs` read serving the negotiation frontier, with
  `version`-based change polling taught in the schema.
- **`units` doc topic** — the scale table agents can ask for (`cork_capabilities
  topic:"units"`), wired into every numbers-contract tripwire message; money/rate outputs across
  compute, query, and decode now carry explicit `scales` blocks (audit R1 closed).
- **market-registry 0.3.3** (Arbitrum One + Base, identical addresses): the CREATE2-collision
  fix integrated and live-verified; CREATE2 attestations extended with public rebuild pointers
  (`source`: repo@tag + forge path) and config-binding declarations (`binds`), coverage pinned —
  15 entries, all re-derived locally.
- **Live venue contract test** (`venue-live.test.ts`): the negotiation read contract asserted
  against the deployed venue (frontier partition arithmetic, version monotonicity), wired into
  CI's live-smoke.

### Changed

- **`digest_mismatch` split into four branchable codes** (covered-surface change, rc-line only:
  `artifact_digest_mismatch`, `intent_hash_mismatch`, `venue_digest_mismatch`,
  `order_hash_mismatch`); messages carry "(formerly digest_mismatch)" for one release.
- **RFQ pre-flights now predict the deployed venue, not an idealized decimal contract**: the
  fraction cap mirrors the venue's `parseFloat` refine; the `quote_ref` premium band replicates
  the venue's strict float gate operation-for-operation (eliminating two false-block classes);
  citations unresolvable on a truncated answers embed relay flagged `citation_unresolved`
  instead of false-refusing; the venue's provenance checks (maker==requester, option chain and
  collateral coherence) run client-side with teaching.
- **One CLI synonym resolver across every input path** (audit R4): resource aliases are
  case-insensitive like chain names; positional fields also ride as flags (`--resource`,
  `--chain-id`); variant subcommands and top-level verbs accept the parent's positional
  (`ch exercise 1`); canonicalised variant spellings are rewritten pre-parse so `--explain`
  can no longer show the wrong contract; `ch capabilities <query>` searches.

### Fixed

- Footgun-audit hardening: `rollover-premium-floor` rounds CEIL (settler parity);
  unsafe-integer JSON numbers refuse instead of silently rounding (order records,
  `filters.rate`); `chainid_defaulted` warns when an omitted chainId picked mainnet for
  chain-specific hashes.

## [0.1.0-rc.2] — 2026-08-10

Identical content to 0.1.0-rc.1 plus one release-pipeline fix: the cross-OS smoke step used
`tee /dev/stderr`, a device Windows git-bash lacks, so `pipefail` failed a PASSING Windows
binary check and the publish gate (correctly) withheld the release. The rc.1 rehearsal proved
everything else: version-gate, two independent byte-identical builds, provenance attestation,
and the binaries themselves on all four OS families. rc.1's tag remains unpublished history.

## [0.1.0-rc.1] — 2026-08-09 (tag exists; release not published — smoke-script bug, see rc.2)

First tagged release candidate: the Cork Phoenix **MCP server + CLI over one typed core**
(9 tools; MCP and CLI are thin projections of the same `runTool` dispatch).

### Added

- The 9-tool surface: `cork_capabilities`, `cork_query`, `cork_compute`, `cork_decode`,
  `cork_prepare_phoenix`, `cork_prepare_orders`, `cork_prepare_market`, `cork_track`,
  `cork_submit` — prepare/sign/submit separation throughout (nothing signs; only `cork_submit`
  relays caller-signed payloads).
- CLI `ch`: one command per tool, discriminated actions as subcommands, schema-derived flags with
  exact amount sugar (`1000e18`), `--explain` contracts, prose-by-default / JSON-on-request
  output, exit codes mapped to envelope state (0 ok · 2 invalid · 3 unavailable · 4 conflict).
- MarketRegistry **2.1.0 model, contracts release 0.3.2** (Arbitrum One + Base, identical
  addresses): registry reads (`registry-assets/-recipes/-denominations/-feeds/-oracle`),
  `derive-cork-pool` (full pre-existence pool identity, oracle-undeployed included),
  `recipe-rate-constraint` (the off-chain `recipe.resolve` a JIT order signs), JIT maker/taker
  order building with carried constraints, and oracle-deploy transactions with a typed-error
  post-mortem (`oracle_not_deployable` diagnoses registration problems vs the cross-generation
  CREATE2-collision class).
- Cork-native decaying-premium auctions (1inch Fusion v3.1 as a pure amount getter):
  maker-order `auction`, `dutch-auction-price` local pricing, auction-aware taker-fill caps.
- ForSelf integrator mode (`forSelf`) for parameter-blind session-key wallets, with adapter
  binding + whitelist-generation pre-flights; ERC-1271 contract-maker signature verification.
- Sweep-back legs on every capped funding input (the adapter-residual theft window is closed in
  the same bundle); pre-flight guards (expiry / pause / two-address whitelist) as build-and-warn.
- Bounded venue traversals with honest pagination, HyperSync full-decentralized reads with a
  live-tail RPC merge, per-host circuit breakers, RPC failover with in-call disclosure.
- Teaching errors (structured issues + did-you-mean + corrected examples that themselves
  validate) on every schema failure, on both surfaces.
- Single-binary release pipeline: reproducible `bun build --compile` (7 targets), dual-runner
  determinism gate, SLSA build-provenance attestations, `ch self-update` verifying attestations
  before swapping.

### Changed (behaviour a diff cannot see — policy R14 prose)

- **Taxonomy (2026-08-08/09, pre-release — old names answer with teaching, never silently):**
  a *cork-pool* is one expiry of a *market* (the family over one collateral/reference pair);
  a *trading-pair* is an LOP venue listing. Resource renames: `market`→`cork-pool`,
  `markets`→`cork-pools`, `derive-market`→`derive-cork-pool`,
  `limit-order-markets`→`trading-pairs`, `flows`→`rollover-orders`; compute kind
  `resolve-recipe`→`recipe-rate-constraint`; prepare-market `deploy-wrapper`→`deploy-oracle`.
  Every pre-rename value is rejected with a `was renamed to …` teaching error — nothing old
  silently works, and nothing old silently breaks either. Schema *field* names (`jitMarket`,
  `poolId`, the on-chain `Market` struct) are deliberately unchanged.
- Amount/rate outputs are unit-labelled (`scales` blocks, `collateralDecimals` /
  `referenceDecimals`); never assume 18 decimals.
- Auction taker-fills default the slippage cap to the curve **ceiling** (not the signed floor),
  so the artifact stays valid at any broadcast time; the decayed/floor/ceiling prices are
  reported and an explicit below-price cap warns `would_revert`.

### Deprecated

- The pre-2.1.0 registry generation (mode-string JIT, fill-time band resolution) survives intact
  behind `legacy:true` + `CORK_ENABLE_DEPRECATED=1` (CLI `--enable-deprecated`); invoking it
  without the opt-in returns `deprecated_gated` with the replacement named. `jitMarket.mode` as
  sugar for a recipe address still works and warns `deprecation_notice`.

### Known gaps (recorded per Checklist A)

- `cork_compute` rfq-quote stays `phase_gated` by design (a pricing model is a product decision;
  the decaying-premium auction is the modeled-quote-free alternative).
- Distribution reporting (`--version` naming a Distribution, policy R4) awaits the distribution
  repo/manifest — adoption Phase 2. This release is a component version only.
- No pools exist on the v1.3.0-rc.1 pool manager yet; `cork-pool` reads against derived-but-
  uncreated pools return `chain_read_failed` (documented expected state).
