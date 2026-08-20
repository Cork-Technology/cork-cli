# Changelog

All notable changes to this component. Versioning follows the
[Versioning and Distribution Policy](https://github.com/Cork-Technology/cork-knowledge/blob/main/policies/versioning-and-release.md).
We use plain SemVer per repo. Below `1.0.0`, a breaking change on covered surface bumps the
**minor** (policy R10). The covered surface for this component is: JSON output, tool names, input
schemas, and exit codes (policy R11). Human-readable text and log formats are not covered.

## [Unreleased]

## [0.4.0-rc.1] — 2026-08-20

### Changed (breaking)

- **Rollover uses the deployed rc.2 wire (rollover-private v0.1.0-rc.2 @ 5af1048e).**
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

- **Terminal prose gets color and glyphs.** Human-readable output shows state badges
  (`✔ OK` green, `⚠ UNAVAILABLE` yellow, `✖ CONFLICT` red), colored keys, and dimmed
  provenance, on a TTY only. Precedence: `FORCE_COLOR`, then `NO_COLOR`
  (https://no-color.org), then `TERM=dumb`, then TTY detection per stream. No new dependency
  (`packages/cli/src/ansi.ts`). Tests pin two rules: stripped output equals plain output byte
  for byte, and JSON never carries an escape. Not covered surface (policy R11).

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
  zian-b sandbox retires after the cutover. Our path literals compose with the mount into the
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
  advertised in the schema, with the structure vs relaxable-policy split per the COR-35 ruling.
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

- **RFQ negotiation surface** (venue a2b03bd). `cork_submit rfq-counter` is the requester's
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
