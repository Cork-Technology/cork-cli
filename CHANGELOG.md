# Changelog

All notable changes to this component. Versioning follows the
[Versioning and Distribution Policy](https://github.com/Cork-Technology/cork-knowledge/blob/main/policies/versioning-and-release.md):
plain SemVer per repo; below `1.0.0`, a breaking change on covered surface bumps the **minor**
(policy R10). Covered surface for this component (policy R11): JSON output, tool names and input
schemas, and exit codes — human-readable text and log formats are not covered.

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
