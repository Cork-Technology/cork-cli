# Changelog

All notable changes to this component. We use plain SemVer per repo. Below `1.0.0`, a breaking
change on covered surface bumps the **minor**. The covered surface for this component is: JSON
output, tool names, input schemas, and exit codes. Human-readable text and log formats are not
covered.

## [Unreleased]

### Changed

- **The JIT adapter of the primary generation moved to CorkLimitOrderAdapter 0.5.0.** The `phoenix/v0.4-rc.1` set on Arbitrum One and Base now names `0x960Cd94B31121806b1b0Ff02230D189Ad0310616` (market-registry PR #65, commit `77ce65f`, version() `0.5.0`, verified live on both chains on 2026-10-07). It replaces `0x3E01C558fc0854e92e6ef2a84c19D6Bf9D82B104` (0.4.0), which stays deployed. The nested wire's permit row is now `(address token, uint256 value, uint256 deadline, bytes signature)` in place of `v`, `r`, `s`, so a 0.4.0 payload with a permit no longer decodes on the new adapter, and the reverse. The flat (0.3.x) wire does not change: its bytes are identical to the previous build.
- **A contract wallet can sign a JIT permit on the nested wire.** The share token checks the permit with ECDSA for an EOA and ERC-1271 for a contract (for example a Safe). `data.approvals` marks the nested-wire permit `wallets: "eoa+contract"` (flat stays `eoa-only`). `contract_maker_pre_rest` on the nested wire names both paths (sign the permit through ERC-1271, or create the pool first), and a maker-order that already carries a permit over the predicted cST no longer gets the create-pool-first execution. The maker-readiness classifier no longer reports `contract-maker-unborn-cst` for a nested-wire JIT permit. The flat wire keeps the ECDSA-only rule.
- **Allowlist.** The approved-implementations `jitAdapter` list gains `0x24a11fba…225d` (the 0.5.0 runtime code, the same on both chains) and drops `0x2fe70bac…d35a` (0.4.0): this build encodes only the 0.5.0 permit row, so it must not build JIT bytes for the 0.4.0 adapter, even from a stale remote config.

### Added

- **`signature` on every JIT permit input** (`jitMarket.permits[]` on maker-order and taker-fill): the permit signature as bytes, the canonical form. `v`, `r`, `s` stay accepted and are normalized to `r‖s‖v`. Pass one form: both, neither, or a partial `v`/`r`/`s` is refused as invalid input. On the flat wire a signature that is not 65 bytes is refused with teaching, because that adapter takes ECDSA only.
- **SDK:** `PermitParams` now carries `signature` in place of `v`, `r`, `s` (the API-surface fixture is regenerated). New exports `permitSignatureOfVrs`, `splitPermitSignature`, `permitOfFlatRow` and the type `FlatPermitRow`. `encodeJitExtraData("flat", …)` throws on a non-65-byte signature.

## [0.7.0-rc.1] — preparation, not yet published

A breaking candidate of the 0.7 line: RFQ v1 inputs are removed, RFQ writes require explicit authorization, and `rfq-open` requires a kind. Below 1.0 these covered-schema breaks require a minor bump, not a 0.6 patch. This public candidate does not publish a tag, Release, package, image, or hosted MCP deployment. Independent exposure/review and compatibility approval, removal notice and usage evidence, and release signing prerequisites remain release gates.

Production `https://api-phoenix.cork.tech/v1/meta` reports cork-api 0.4.5 at `4fb7eb3` on 2026-10-07, including the full-answer proof fix. The committed OpenAPI capture is refreshed from production. The API still serves v1 alongside v2; **this CLI/MCP/SDK RFQ surface serves v2 only**, with no v1 compatibility shim. See [the migration guide](docs/cli.md#12-migrate-from-06-to-07) before upgrading.

Public-port preparation also preserves executable release-script modes and handles the actual SDK Git repository URLs and current release-graph validator, including historical spellings. Cache-isolation tests cover either build channel. The public candidate remains unpublished and subject to independent review and release approval.
The SDK installation guide now selects the public release repository by default and no longer includes private-preparation instructions. Archive verification still binds every download to its repository, signing workflow, release tag and approved source commit.
Release candidates now tag only the advertised head of their public `release/vX.Y.Z` branch; final versions still tag public `main`. CI and release-toolchain rehearsals run on both main and release branches. Push the transformed candidate to `release/v0.7.0`, wait for its checks, then run `sh scripts/release-tag.sh v0.7.0-rc.1 <public-commit> cork-cli`. The script refuses missing branches and mismatched heads before signing.

### Release exceptions

The release owner accepted the following exceptions for this opt-in candidate on 2026-10-07. They do not authorize production promotion, API-v1 retirement or automatic upgrades. Follow-up owner: Filip Malachowicz.

1. **Author-only review (R17/G15):** independent release review and review-mirror approval were skipped by the release owner. This candidate is **unreviewed**, not peer-reviewed. Obtain a non-author review before stable promotion.
2. **Pending removal notice and usage evidence (R16):** the Telegram notification and usage read were deferred by the release owner for this opt-in RC. Record the posted notice, recipient coverage and usage read before retiring any existing integration path. Existing releases and API-v1 routes are not retired by this cut.
3. **Existing main-branch layout (G6):** candidate commits were already merged into main under the former workflow. The release owner requested the branch-workflow correction be pushed to main without a PR; that history is retained. RC tags now require release/vX.Y.Z. Restore the stable-main convention when promoting the first stable release.

### Breaking

- **RFQ v1 is removed from the CLI, MCP and SDK.** Every RFQ read and write from this client goes to `/rfqs/v2`. A version 2 read does not show RFQs that were opened on version 1; the venue still serves its v1 API separately. Bodies carry `schema_version: "2"`, and every address is lowercased, because the venue hashes the lowercased body.
- **Every RFQ write is proven.** `cork_submit` `rfq-open`, `rfq-answer` and `rfq-counter` take `auth`: `{ method: "signature", signature }` or `{ method: "apiKey" }`. The old free `signature` field is refused with a teaching error that shows the new shape. With a signature, `cork_submit` rebuilds the body, recomputes its hash and recovers the signer before anything is sent: a normal wallet first, then a contract wallet's `isValidSignature`. A signature that proves another signer is `signature_or_reconstruction_mismatch` and is not relayed. With `apiKey`, the key comes from the environment or the credentials file (see Added), rides the `x-cork-api-key` header only, and never appears in a result.
- **`rfq-open` requires `kind`:** `new_position` or `rollover`, with no default, as on the venue. Answers and counters take the RFQ's own kind from the venue; a different `kind` is refused before anything is built.
- **A quoted answer carries its signed order.** On a `new_position` RFQ, every quoted option carries the full 1inch `order` and the underwriter's `order_signature`. The order's maker must be the underwriter, and no two options may share an order. Before relay the tool re-hashes each order, verifies its signature, and checks that the option's collateral, capacity, freshness and premium agree with the order, because the order signatures do not cover those option fields. The top-level signature does: the venue verifies it on these answers from cork-api PR #113 onward; older 0.4.5 builds did not. `fresh_until` equals the order's expiry.
- **The answer goes first, then the book.** The venue refuses an order that already rests on the book or is quoted on another open RFQ. `answer-rfq` therefore no longer needs an earlier answer: it builds the order and the answer option together, in `answer.quotedOption`. The steps are: sign the order, `finalize-maker-order`, `rfq-write`, sign, `cork_submit rfq-answer`, then `cork_submit lop-order` citing `quoteRef`. Passing `answerId` and `optionId` now means "quote my own earlier option again"; the new answer replaces it with `supersedes`. `refresh-order` on a cited row returns `requote`: the replacement answer that carries the new order.

### Deprecated

No new deprecation is introduced in this candidate. The existing `additionalData` input alias for `extraData` still emits `deprecation_notice`; the rollover typed-data struct's canonical `additionalData` member is not deprecated. RFQ v1 inputs and the free RFQ `signature` field are removed, not retained as deprecated compatibility paths. Removal-notice and usage approval remains a human release gate.

### Added

- **RFQ API keys, kept the AWS CLI way.** `auth { method: "apiKey" }` reads the key from `CORK_RFQ_API_KEY`, else the profile's `credential_process`, else the key stored for the venue host in `~/.config/cork-helper-cli/credentials` (override `CORK_CREDENTIALS_FILE`). A stored key belongs to one venue host, so a staging key never reaches production. The file is written with mode 600 and refused when other users can read it. New CLI commands: `ch auth set-key` (hidden prompt or pipe, never argv), `ch auth list` (keys masked to the last four characters), `ch auth remove`, `ch auth status`; `--profile` on every tool command, `CORK_PROFILE` in the environment. No key resolves → `api_key_missing`, nothing sent. The HTTP MCP endpoint refuses `apiKey`: a shared server's keys belong to its operator.
- **Sign from the CLI with a password-protected keystore.** `ch wallet new|import|list|address|remove` keeps keys in the standard v3 encrypted format, in `~/.config/cork-helper-cli/keystores/` only (`CORK_KEYSTORE_DIR` moves it; no other tool's folder is read), owner-only and refused when others can read it. `ch sign --account <name>` signs a prepare result's typed data or a complete transaction and prints the signature; it never broadcasts. `ch submit rfq-open|rfq-answer|rfq-counter --account <name>` prepares, signs and submits an RFQ write in one command. Before every signature the CLI shows what will be signed and asks yes or no, then asks for the password — from the terminal only, never from an environment variable, a file or a pipe. The MCP server still never signs: a test fails if any MCP or core code reaches the signing modules.

- `cork_prepare_orders rfq-write`: the exact body the venue will hash, its `bodyHash`, the `CorkRfqWrite` typed data (domain `Cork RFQ`, version `1`, no verifying contract), and the address that must sign. Signing stays with the caller [K1].
- Rollover RFQs. `rfq-open` with `kind: "rollover"` asks for a rollover of `source { poolId, shares }`, paid in `premiumToken`. An answer option names a `destination`: an existing pool, or a `jitMarket` (the result echoes its `jitMarketHash` on the `0.2` wire and the pool it derives). A counter is priced in `premiumPerShare`. Fields of the other kind are refused with teaching. `premiumPerShare` is raw premium-token units per 1e18 destination shares, the order's `minPremiumPerShare`.
- Accepting a rollover quote. `rollover-intent` takes `quoteRef { rfqId, answerId, optionId }`, fills every term the caller left out from the quoted option, and refuses an explicit term that breaks the venue's quote rules. `cork_submit rollover-order` checks the same rules and relays `quoteRef`.
- Reads. `cork_query rfqs` takes `filters.rfqKind` (CLI `--rfq-kind`; `--kind` already selects the flows feed). Rows carry `kind`, and options carry the venue's `order_hash` and `jit_market_hash`. A `new_position` option is firm when a live book row cites it OR is its own order (the same `order_hash`). A rollover option is firm when a fillable rollover order that its settler confirms cites it. `rollover-orders` takes `filters.rfqId`. `offers` reads `new_position` RFQs only.
- SDK: `@cork/core/venue` exports the RFQ v2 signing (`canonicalJson`, `rfqWriteBodyHash`, `rfqWriteTypedData`) and body builders (`planRfqWrite` and the per-operation builders), held to the venue's published signing vectors.
- `MIRRORED_VENUE_LOGIC` gains the version 2 rules: unique package ids, one distinct underwriter-made order per quoted option, the underwriter's exact-order rule on `lop-order`, and the rollover open, answer, counter and quote-reference rules.
- Repository-bound private release preparation: authenticated GitHub config/release/asset reads, repository-scoped caches, and the repository identity in `ch version --json`. Private self-update requires valid artifact attestations with no checksum-only provenance fallback. Public porting retains the public channel.
- Private publication destinations and admission: the private component image has a separate GHCR namespace, private visibility and platform entitlement are checked before a cut, and private cuts remain release candidates only. No private stable Pages/latest/hosted-deployment path is enabled. The full binary/SDK, signing, reproducibility, smoke and image-digest assurance chain is retained.

### Added

- **`answer-rfq`: `useRequestedRate`.** A fixed-rate answer can now ask for the frozen rate of the request by name: `useRequestedRate: true` builds at the RFQ's own `rate_override`, the same as passing that rate as `jitMarket.rateOverride`. It is the way to cite an option that names no rate without retyping the request's. When the cited option names another rate, the order still builds and the difference is named. The two parameters are mutually exclusive. The flag is refused when the RFQ names no rate, and when the recipe reads an oracle. The default is `false`; an uncited answer builds at the RFQ's rate already.

### Fixed

- Repository test, typecheck and package-validation entrypoints explicitly run under Bun, including ordinary CI script invocations. Private updater subprocess tests resolve Bun before restricting PATH, preserving the no-verifier refusal checks on Node-equipped runners.
- Private asset redirects use explicit host membership, refuse inherited-property host names before a download request, and strip credentials on approved CDN redirects.
- Release publication now reads back the actual Release and requires its immutable flag and intended tag/status. A failed readback reports that publication has already occurred and needs reconciliation before a retry.
- SDK installation guidance covers private authenticated downloads and both channels' transitive dependencies with explicit overrides. The guide builds before local packing and does not equate local archives with attested release assets.

- **Document the RFQ failure contract.** `rfq-open` accepts one to three unique modes. Four or more modes fail locally at the schema boundary with exit **2**, empty stdout and `invalid_input` on stderr; duplicates within the length bound fail domain preflight with exit **3** and an `invalid_order_terms` result on stdout. Neither is a `venue_rejected` response. The CLI guide explains successful `rfq-open` results carrying `recipe_generation_notice` or `cover_mode_mismatch`, and that warnings alone do not mean preparation failed. Runtime behavior is unchanged; compatibility/versioning-policy disposition remains a human review decision.
- **`answer-rfq`: a cited fixed-rate option brings its own rate.** A cited option whose template carried no admissible `rate_override` was built at the REQUEST's rate, without a word: the order cited a quote and created a pool that quote never named. It is now refused; `jitMarket.rateOverride` still builds at a rate of your own. An explicit rate that differs from the cited option's rate is now named too (the venue checks the cited premium, not the rate); the order still builds.
- **`taker-fill`: an expired order is named.** A fill of an order whose signed expiry has passed built bytes with no word about the expiry; the fill reverts `OrderExpired()`. The result now carries a `would_revert` notice that names the expiry, read from the signed bytes with no chain. The bytes are still built: this host's clock is not the chain's.
- **`rollover-fill`: the holder's signature is verified.** The fill passed the holder's signature to the settler unchecked, so a payload with a wrong signature built bytes that can only revert. The signature is now checked the way the settler checks it: ecrecover, then the holder's own `isValidSignature` for a contract account. A refuted signature is a `conflict` with no bytes, as `cork_submit rollover-order` and the LOP `taker-fill` already do. A holder that nobody could ask (no RPC, a failed read) is built and labeled: the new field `data.holderSignature` is `eoa-verified`, `erc1271-verified` or `unverified`.
- **`taker-fill` with `jitMarket`: the fee rule follows the generation.** The taker-side gate used the compiled 5% cap on every generation, so a fee above 5% on the 10-field primary was refused as fact. It now uses the target generation's rule, as the maker side and `create-pool` do.
- **`cork_decode`: market-infrastructure calls of every generation.** `cork_prepare_market` builds `deploy-oracle`, `deploy-fixed-oracle` and `create-pool` for any active generation. `cork_decode` knew the registry and the creator of the primary generation only, so the tool's own bytes for `phoenix/v0.3-rc.1` decoded as `target_mismatch`, "do not sign", and a signed transaction to that registry as `unknown_target`. The registry and the creator of every configured generation are now trusted, and the leg carries the generation label, as Cork adapters already did. A contract of no generation is still a mismatch.
- **`cork_submit lop-order`: an order without an expiry can be relayed.** The listing says `expiry: 0` for an order whose signed traits carry no expiry, and the relay posted that 0. The venue's schema refuses 0, and its route refuses any `expiry` field beside no-expiry traits, so every such order got HTTP 400. The relay now leaves the field out. Our own listing field is unchanged: 0 still means no expiry.
- **`cork_submit lop-order`: the quote_ref party rule now runs on the venue's real answer rows.** The rule read the underwriter at row level. The venue's full view, the one this relay reads, serves it inside the answer payload. So the local rule never ran: a rival's citation was not refused before relay, and every underwriter that cited its own answer got `citation_unresolved`. One reader now serves every place that needs an answer's underwriter (`cork_submit`, `answer-rfq`, the `offers` join).
- **`answer-rfq`: a `jitMarket` object that names no fee keeps the template's fees.** The two fee fields of the answer's `jitMarket` block had a schema default of "0". Any `jitMarket` object, even `{}` or one that carries only `permits`, arrived with fees "0", and they overrode the fees of the request's or the cited option's template. On a 10-field generation the fees are part of the pool id, so the order created another pool than the one the request describes, and `answer.inline` still showed the template's fees. The two fields now have no default: absent means the template's fee, else 0. An explicit fee still wins, "0" included. The permit re-prepare flow was affected, because it always passes `jitMarket`.
- **`answer-rfq`: terms that a cited answer takes from the request are named.** A cited option that carries a template id, or an inline template without a recipe or a block, states no recipe or block that the tool can read. The order then takes them from the request's template. A new `invalid_order_terms` notice says which terms, and how to state your own. Warnings about a borrowed block now name the RFQ as its owner; they said "the cited option's". The order still builds.
- **`rollover-intent`: a slippage floor left out is named.** `minCaReceived` and `minSharesOut` are optional and were signed as 0 without a word, so a filler could complete the roll at whatever rate the two pools gave at fill time. The prepare now says which floor is not set and that it is signed as zero (`invalid_order_terms`, info); a stated floor is silent.
- **`maker-ladder`: the venue's open-order cap is named before signing.** The venue rests at most five open orders of one maker on one asset pair and refuses the next with HTTP 400; a ladder of more rungs signed exposure the venue would never rest, and a shared bit does not reduce the count (the venue never learns a group). A ladder beyond five rungs is told so (`invalid_order_terms`, info). The cap rides `MIRRORED_VENUE_LOGIC` as `VENUE_OPEN_ORDERS_PER_POOL`.
- **`answer-rfq`: the cited option's collateral.** On a request that accepts several collateral tokens, a cited answer now takes the cited option's `collateral_asset` when the caller names none. An order that builds with another collateral than its cited option gets a notice before the signature: the venue refuses such an order, and `cork_submit` refuses it before relay.
- **`answer-rfq`: a cited fixed-rate option brings its own rate.** A cited option whose template carried no admissible `rate_override` was built at the REQUEST's rate, without a word: the order cited a quote and created a pool that quote never named. It is now refused; `jitMarket.rateOverride` still builds at a rate of your own, and `useRequestedRate` builds at the request's rate when you ask for it. An explicit rate that differs from the cited option's rate is now named too (the venue checks the cited premium, not the rate); the order still builds.
- **`rfq-open`: a request that names `fixed_rate` is no longer told to remove its `rate_override`.** The venue requires the rate on every such request, whatever recipe the template names; in a mixed-mode request it is the fixed-rate alternative's. The advice stays for a request that does not name `fixed_rate`.
- **Release pipeline: the GitHub Release is published last.** The apk and image build now runs before the publish job, so every channel the Release body names exists before the Release is public. The hosted-deployment job moved to its own workflow and runs after the Release; its failure leaves a complete release. Each release has one more asset, `image.txt`: the image reference with its digest. The release attestation covers assets and the tag, so it now binds the image digest to the tag too. A second effect: the reviewer of the `release` environment approves before anything is public.
- **Release pipeline: every push to main rehearses the apk and image build.** The rehearsal uses the release's own scripts and command lines, a throwaway signing key, and pushes nothing. It differs from a release build in three ways only: the key, a branch checkout at a pinned commit in place of a tag, and an image built to a file. `actionlint` also reads every workflow on each push, so a wrong `needs`, input or output of a reusable workflow fails on main and not in a release.
- **Release pipeline: the apk and image build no longer fails on an aged base-image pin.** The v0.6.1-rc.3 run published the GitHub Release and then failed at the toolchain install. The job container was pinned to a six-week-old `wolfi-base` image. That image holds its base packages at their build versions, and Wolfi's repository had moved on. The pin is now current, the build asks for the versioned `openssl-4.0` CLI, and three things keep the pin young: a `release-toolchain` workflow runs every install line of the release workflow in the pinned image on each push and every Monday; the Monday run fails when the image is more than 30 days old; `sh scripts/bump-wolfi-pin.sh` moves the pin and proves the new digest against the content the registry serves. No shipped artifact changes.

## [0.6.1-rc.3] — 2026-10-01

A patch candidate of the 0.6 line. It aligns the tool with venue cork-api 0.4.4, which adds fixed-rate cover as a third RFQ mode, and it makes the tool say which cover a request buys. The recipe decides the cover; the tool now asks the recipe on chain instead of restating its rules, and it reports an endpoint failure as a read that did not happen, not as a refusal. The covered surface gains one enum value (`fixed_rate`) and additive fields; nothing is removed. A binary older than this one refuses the new mode as invalid input.

### Added

- FIXED-RATE cover through an RFQ (venue cork-api 0.4.4). `cork_submit rfq-open` accepts the mode `fixed_rate`, and `modes` now takes one to three unique modes. A fixed-rate request names the fixed recipe in an inline template and carries the frozen rate in `marketTemplate.inline.oracle_params.rate_override`: a decimal string on the absolute scale (1e18 = 1.0), with no leading zero. The inline block has a name, `cork-inline-fixed/1`: `schema`, `rate_override`, `expiry`, `swap_fee_wad`, `unwind_swap_fee_wad`. The tool mirrors the venue's rule and refuses before relay, as `invalid_order_terms`, what the venue refuses: a `fixed_rate` request without an inline template, without `rate_override`, or with a value that is not a positive decimal uint256 string; a repeated mode; and an `rfq-answer` option whose mode is `fixed_rate` and whose own template carries no valid rate. We sent every rate vector of the venue's own test suite to the real venue and to the tool: both refuse the same eleven and accept the same two. Both rules are registered in `MIRRORED_VENUE_LOGIC`. A binary older than this one refuses the `fixed_rate` mode as invalid input, so upgrade to ask for or to answer fixed-rate cover.
- `cork_submit rfq-open` tells a fixed-rate requester where the frozen rate sits. With an RPC, `data.cover.fixed` carries the rate, the reference's rate today (from the pair's deployed NAV or price oracle), the position (`below`, `at`, `above`) and the gap as a percentage of the reference's rate. Below, the gap is the deductible. Above, the cover pays the gap at once, with no loss at all: the new warning `fixed_rate_in_the_money` says so, and says that an underwriter prices that gap as a certain payout or passes. The request is still relayed, because an RFQ binds nobody.
- `cork_prepare_orders answer-rfq` answers a fixed-rate request. The tool asks the recipe for its source. For a fixed recipe, the request's `rate_override` (or the cited option's, or `jitMarket.rateOverride`) becomes the order's `rateOverride`, and no recipe bytes ride, because the fixed recipe refuses every payload. `answer.fixed` echoes the rate, where it came from, and its position against the reference's rate. The underwriter gets `fixed_rate_in_the_money` when the rate is above the reference's rate: it would be out of pocket from the first block. Another rate than the request's builds, with a warning that it is another oracle and another pool. A fixed recipe with no rate anywhere is refused. A template rate with a recipe that reads an oracle is not carried, with a warning, and an explicit `jitMarket.rateOverride` on such a recipe is refused: that fill reverts `UnexpectedRateOverride`. A `source()` read that fails in transport refuses the answer as `chain_read_failed`; the tool does not build on a guess. `answer.notRead` lists what the tool could not read from the chain.
- The fixed recipe now resolves before its oracle exists. The deployed fixed recipe refuses `resolve` until the FixedRateOracle for the rate has code, so `derive-cork-pool`, `create-pool`, the JIT prepares and `rfq-open` could not derive a fixed pool for a new rate. They now run one simulation that deploys the oracle and then resolves, the same two steps the fill runs, and report the recipe's own answer: the rate to the rate plus 1 wei, with both rate-change allowances zero. A deploy that would revert is `oracle_not_deployable`, a refusal of the recipe is `recipe_refused` with the recipe's error name (`UnexpectedExtraData`, the overflow at uint256's maximum), and an endpoint that cannot simulate is `chain_read_failed` with the deploy-first way out.
- `cork_submit rfq-open` says WHICH cover the request buys. The market's recipe decides that, never the RFQ `modes`: the modes name the alternatives a requester accepts, and nothing on chain reads them. The result carries `data.cover`: the kind (`liquidity`, `impairment`, `fixed-rate`, or `unknown` for a template id), its name, the recipe and its generation, and whether the request names exactly the one mode of that cover. A request carries one template, so it describes one cover: a mode that names another cover is `cover_mode_mismatch`, relayed. A block written for another cover, a rate on a recipe that takes none, an impairment block that is missing or partial, and an inline expiry outside the request's own window are `invalid_order_terms`, relayed.
- `data.cover.resolved`: the recipe's OWN answer for the request. With an RPC and one collateral, `rfq-open` makes the two calls the fill that creates the pool makes. `recipe.resolve` gives the oracle and the four rate limits a pool created now is born with; when the recipe refuses, the warning `recipe_refused` carries the recipe's error name. `recipe.verify` is then asked with the pool expiry the block names: a rejection or a revert is `would_revert`. The tool restates no recipe limit: the limits differ per generation (the phoenix/v0.4-rc.1 impairment recipe caps the spread and the duration; the phoenix/v0.3-rc.1 one declares no such constants). A failure of the endpoint is not a refusal of the recipe: `data.cover.notRead` lists what the tool could not read from the chain and why, so a result without a warning is not mistaken for a clean one.
- The duration of an impairment window against the life of its pool. Measured on the live phoenix/v0.4-rc.1 recipe at one block: when the pool is created, `recipe.verify` answers false for a duration above the pool's remaining life, accepts a duration equal to it, and the fill then reverts `RecipeRejectedConstraint`. `rfq-open` and `answer-rfq` name that cause beside the recipe's verdict, because the verdict carries no reason. `answer-rfq` judges the duration the order carries: explicit `jitMarket.extraData` bytes win over the block.
- A request and its answer now read a template the same way. A block written for another cover lends no bytes to the recipe on either side, and both sides name the same contradiction (`invalid_order_terms`).
- `cork_query cork-pool` returns `data.cover`: the cover of a live pool, read from the limits the pool was created with. Both rate-change allowances at zero is fixed-rate cover; else a floor of at most 1 wei is liquidity cover; else the pool holds a band (impairment cover).
- `cork_capabilities topic:"cover"` (aliases `cover-types`, `impairment`, `downside`, `liquidity-cover`, `fixed-rate`): the cover table, how to ask for impairment cover and for fixed-rate cover, how to read the cover of a live pool, and the measurement behind the table. On a Base fork against the phoenix/v0.4-rc.1 contracts, three pools over USDC and baseUSD with the same expiry took a real 10% loss in the reference vault. Per 100 cST the liquidity cover paid 0.000 USDC, the impairment cover (10% a year over 14.4 days, a 0.394% band) 9.827 USDC one hour after the loss, and the fixed-rate cover 9.999 USDC (`experiments/fork-harness/script/cover-types-rehearsal.ts`). The band is the worst-case deductible: the rate walks to its floor at one day of the spread per day.
- The cover kinds have names to say, in the tool and the docs: **liquidity (duration-risk) cover**, **impairment (credit-risk) cover**, **fixed-rate cover**. Duration risk: you cannot sell or redeem the reference at its book value in time. Credit risk: the reference loses value. `data.cover.label` carries the name; the `cover` topic also answers to `duration-risk`, `credit-risk`, `duration-risk-cover`, `credit-risk-cover` and `impairment-cover`.
- `reference_loss_unreported`: for a NAV-sourced recipe, `cork_submit rfq-open` and `cork_prepare_orders answer-rfq` read the reference vault's `lostAssets()` when an RPC resolves, and warn when it answers. A MetaMorpho v1.1 vault adds realized bad debt to that counter and reports total assets as real assets plus it, so its share price, which the NAV rate oracle reads, never falls on bad debt. The counter never decreases, and a loss can be covered by a supply on behalf of `address(1)`, so the tool also reads the value of the shares that `address(1)` holds and reports the open shortfall: the counter less that value, floored at zero. All reads are taken at one block. The warning is worded for the side that reads it and says if a shortfall is open, covered, absent, or if the cover could not be read. A price-sourced pool and a fixed-rate pool do not read that share price, so they get no such warning. A vault whose `lostAssets()` call reverts has no such view: the tool stays silent, and that vault is not thereby proven to report every loss. Any other failure of the read is listed as not read, so an outage does not look like a clean vault. Read live on Base 2026-10-01: YCSUSDC counter 131.38 USDC, covered by 140.55 USDC, open shortfall 0.
- The partner quickstart teaches the cover choice: step 1b is "pick the cover, and with it the recipe", with the table, the three measured payouts, the impairment policy and the fixed-rate policy with its request block. The sentence that called the liquidity policy rate-limited against a flash crash is corrected: at one whole anchor of movement a day the rate follows the oracle.
- SDK, additive. `/orders`: `readRfqCover`, `coverKindOfRecipeName`, `coverKindOfConstraint`, `impairmentBandPercentage`, `inlineBlockWarnings`, `fixedRateMoneyness`, `fixedRateInTheMoneyWarning`, `fixedRateOverrideViolation`, `fixedRateOverrideOfTemplate`, `inlineOfTemplate`, `oracleParamsOf`, `recipeAddressOfTemplate`, `withFixedRateLiveRate`, `withResolvedConstraint`, `COVER_KINDS`, `COVER_LABELS`, `COVER_PROTECTION`, `RFQ_MODE_COVER`, `COVER_RFQ_MODE`, `INLINE_SCHEMA_COVER`, `INLINE_FIXED_SCHEMA`, and the types `CoverKind`, `CoverReading`, `InlineRecipe`, `InlineFixedParams`. `/chain`: `readUnreportedLoss` (it returns `read`, `absent` or `unread`), `unreportedLossState`, `unreportedLossShare`, `referenceLossReading`, `unreportedLossWarning`, `navLossAbi`, `isContractRevert`, `firstLine`, and the types `UnreportedLoss`, `UnreportedLossRead`. `/registry`: `simulateLegFailure`, `impairmentDurationOfArgs`. `@cork/schemas`: `RFQ_MODES`, `RfqMode`.

### Changed

- The `recipe.verify` pre-flight of the JIT prepares and of `create-pool` says what a failure is. A REVERT of `recipe.verify` is now `would_revert` with the recipe's error name. Before, the tool reported it as `chain_read_failed` ("the pre-flight read failed"), the same as a transport failure, and the artifact looked fillable. A transport failure stays `chain_read_failed`.
- A fixed-rate artifact carries no floating-rate notice. `constraint_window_notice` and the pair-oracle wording of `oracle_not_deployed` (salt, registered sources, live rate) do not apply to a FixedRateOracle, which is keyed on the rate alone. The fixed wording says so.
- `bun scripts/mutation-probes.ts --rot` checks every probe anchor against the source in seconds, without a test run.

### Fixed

- The config-branch workflow's existing-branch path (the second and every later publication to `config/<line>`) failed on its first run: the GraphQL `createCommitOnBranch` variables were passed through `gh api -F` as a string, so the v0.6.1-rc.2 release run stopped before publishing. The path now updates the file through the REST contents endpoint, conditioned on the blob the invariant check read, the same API family the first-publication (orphan) path uses. The rc.1 release had only exercised the orphan path.
- The registry ABI declared the fixed recipe's `UnexpectedExtraData` error without its `uint256 length` argument, so that refusal decoded as an unknown selector. It now decodes by name.

## [0.6.1-rc.2] — 2026-10-01

A patch candidate of the 0.6 line, built from the the 2026-10-01 integration triage triage and the Zyfai integration pass. It adds the filler side of a rollover (the fill, the clone deploy, the intent hooks the maker side never produced), smart-account envelope unwrapping in decode, a ForSelf adapter verifier in track, the grant list on every pool action, and the rfq-open pre-flights. Every new path is fork-proven or live-verified and mutation-checked. The covered surface grows additively (new variants, new fields, new SDK exports); nothing is removed or renamed.

### Added

- `cork_decode` unwraps SMART-ACCOUNT ENVELOPES (`bundle/envelopes.ts`): a contract wallet's transaction wraps the call it means, and the decoder now peels it one layer at a time — ERC-4337 `handleOps` (EntryPoint v0.6 `UserOperation`, v0.7 and v0.8 `PackedUserOperation`), Safe4337Module `executeUserOp`, Safe `execTransaction`, Safe `MultiSend`, ERC-7579 `execute`/`executeFromExecutor` (single, batch, delegatecall; the "try" exec type marks `skipRevert`), an ERC-7579 executor module's `executeGuardedBatch(Execution[])`, and Rhinestone `IntentExecutor.executeSinglechainOps` with its multichain and gas-refund variants. Each inner call re-enters the decoder, so a Cork leg three wallets deep is verified against the address book like a bare one, and a look-alike adapter inside an envelope is still a `target_mismatch` conflict. Every layout is pinned from the deployed contracts' own sources. A new leg kind `envelope` carries the scheme, the layout version, the account and the inner legs; one `envelope_unwrapped` info names every layer outermost first; `delegatecall_in_envelope` names every inner leg run as a delegatecall (the leg carries `delegatecall: true` and the summary prefixes it). A byte-verified singleton target (EntryPoint v0.6/v0.7, the Safe MultiSend deployments, Safe4337Module 0.3.0, the Rhinestone IntentExecutor — code read identical on mainnet, Arbitrum and Base, re-read by `envelopes-live.test.ts`) is `trusted` and named in `toLabel`; EntryPoint v0.8, whose code differs per chain, is recognized but not trusted; a wallet's own contract is `unverified` by construction and never a `target_unverified` finding — a signed tx whose `to` is the wallet is told so instead of accused. Found on a live Zyfai fill on Base (Safe 1.4.1 → Rhinestone intent → Zyfai's executor module → approve + `fillOrderForSelf`), now a test fixture. Decode stays chain-free.
- `cork_decode` trusts each generation's REFERENCE ForSelf adapter (the Distribution record's `forSelf.adapter`): a call to it is `trusted` and labeled with the generation, and a signed tx to it names it in `toLabel`. An integrator-deployed adapter stays `unverified`; the hint points at `cork_track verify` to check its bindings on chain. SDK: `DecodeTrustTargets.forSelfAdapters`; `/bundle` exports the envelope module (`unwrapEnvelope`, the pinned ABIs, `ENVELOPE_SINGLETONS`).
- `cork_track verify` subject kind `forSelfAdapter`: reads an adapter's `CORK()`, `LOP()` and `WHITELIST()` on chain and classifies it against every configured generation — `data.generation` from the pool manager it pins, `reference` when it is that generation's Distribution-record adapter (else an integrator's, whose code is the integrator's to audit), `surface` combined or pool-only, `callerGate`. A pool manager no generation configures, a wrong LOP or a wrong whitelist manager is `adapter_binding_mismatch`; an empty account is a conflict; a transport failure is `chain_read_failed`, never a verdict. Verified live on Base against Zyfai's v0.4 adapter and the reference adapter.
- `cork_prepare_phoenix` returns `data.approvals`, the same grant list the order prepares carry: the initiator's pulls to the cork adapter (one ERC-20 grant in erc20-approve mode, Permit2's two layers in permit2 mode) and, on a burn-side action with an `owner` that is not the adapter, the OWNER's ERC-20 grant to the cork adapter — the spender the 0.6.1 hint named; an allowance to the pool manager is never spent. Every entry carries the unsigned approve tx and is annotated with the live allowance; a confirmed-missing grant warns `approval_missing`. SDK: `fundingApprovals` (`/bundle`); `ApprovalRequirement.role` gains `initiator` and `owner`, `spenderRole` gains `Cork adapter`, `stage` gains `before-bundle`.
- `cork_prepare_orders rollover-fill`: the FILLER's side of a roll, unsigned — `BaseFiller.execute(FillerJob)` (or `executeWithMarket` when the order commits to a just-in-time destination market) for a resting rollover order, from the venue row by `orderDigest` or from an inline `signedOrder` (the venue-free path: the exact `venuePost` shape `rollover-intent` returns plus the holder's signature). The order digest and the intent digest are recomputed locally and a row that does not hash to its claim is `order_hash_mismatch` [K3]; the settler is classified by generation (a retired one refuses `settler_retired`, an unconfigured one `settler_not_recognized`); the fill deadline, the settler's mode gate, an `exclusiveFiller` without a `fillerAuthSig` (`private_order`) and an exact-size settler asked for a partial amount all refuse before any bytes. `fillerSrcCst` defaults to the remaining size; `premiumCap` defaults to ceil(fillerSrcCst × minPremiumPerShare / 1e18), disclosed as `premium_cap_estimated` (exact at a 1:1 destination mint; BaseFiller refunds the unspent part). With an RPC the pre-flight reads the settler's `orderStatus` (a terminal state is `status_mismatch`), verifies the holder's clone against the factory, and annotates the two allowances the filler grants to BaseFiller — src cST for the fill amount and the premium token for the cap — under `data.approvals` (`approval_missing` when confirmed absent). A JIT instruction is hashed and held to the order's `jitMarketHash` (`jit_market_hash_mismatch`). Proven end to end on a Base fork against the phoenix/v0.4-rc.1 contracts (`experiments/fork-harness/script/rollover-fill-rehearsal.ts`): the holder's src cPT and the filler's src cST consumed, dst cPT and dst cST received, the premium paid exactly the estimated cap, the settler reporting Settled.
- `cork_prepare_orders rollover-fill` — a RESERVED order (`exclusiveFiller` set) is gated the way the settler gates it: `settler.fill`'s caller is BaseFiller, never the account, so the direct-caller pass applies only to a reservation for BaseFiller itself; every other reservation, the account's own included, needs the exclusive filler's `FillerAuth(orderDigest, destination = the account, subFiller = bytes32(account))` signature under the settler's CorkSettler/1.0.0 domain. The refusal (`private_order`) returns the exact typed data to sign (`data.fillerAuthTypedData`) and its digest; a supplied `fillerAuthSig` is verified as SignatureChecker does — ecrecover first, the filler's own `isValidSignature` when it has code — and a refuted one is a `signature_or_reconstruction_mismatch` conflict with no bytes; `data.fillerAuth` carries the verdict. SDK (`/orders`): `FILLER_AUTH_TYPES`, `fillerAuthTypedData`, `hashFillerAuth`, `subFillerOf`. Found by the review pass against the rollover source (LibFillerAuth.isAuthorised).
- `cork_prepare_orders rollover-fill` — `fillerSrcCst` defaults to the venue row's `remainingSize` (string or number); on a PartialSettler order with no remaining-size source (the inline path, or a row without one — the settler exposes no consumed-size view) the default is the ORDER size and an `invalid_order_terms` info says so. A passed `openDeadline` is disclosed as `would_revert` chain-free (the chain read still refuses once the settler reports the order as None). A refusal keeps the disclosures gathered before it (an `additionalData` alias teaching, a transport note).
- `cork_prepare_orders rollover-intent` `standardHooks` — on a partial-fill order the pull module runs with its clamp (the hooks are signed before any fill size is known, so every fill re-pulls `orderSize` against a shrinking balance and the clone sweeps the unburned surplus back to the holder); `owner_managed_funding` then teaches the STANDING allowance the holder must keep (a one-time allowance of exactly `orderSize` is spent by the first fill and the next one reverts `OwnerTokenPullModule__NothingPullable`). An exact order pulls exactly, as before.
- `cork_decode kind:"tx"` — a tx whose `to` is a non-singleton envelope is described by what that address IS: a Safe's `execTransaction` / 4337 module / an ERC-7579 account's `execute` is "the smart account itself — confirm it is YOUR wallet"; an integrator's executor module, a MultiSend or an EntryPoint outside the byte-verified singletons is "wallet infrastructure at an address nobody here has verified — NOT the signer's account", never an invitation to approve someone else's contract. `decodeSingleCall`/`decodeBundle` with a vouched `trust.forSelf` report a ForSelf call at any other unlisted address as a `mismatch` naming the vouched adapter (the reference list still wins).
- `cork_prepare_orders deploy-rollover-contract`: the unsigned `CorkRolloverContractFactory.deployRolloverContract()` tx that creates a holder's rollover clone (one per owner per factory generation, CREATE2), with `predictedRolloverContract` from the factory's own prediction and `existingRolloverContract` when the owner already has one (`rollover_contract_exists`: the tx would revert; name the existing clone instead). On the fork the clone landed at the predicted address.
- `cork_prepare_orders rollover-intent` carries INTENT HOOKS, the part of a roll order the builder never produced — without them no order it built could complete on chain, because the clone has nothing to pull the holder's src cPT with and nothing to return the dst cPT. `standardHooks: { srcCptToken, dstCptToken }` composes the settler generation's two canonical modules (OwnerTokenPullModule pulls `orderSize` of src cPT into the clone, PostRolloverDstCptTransferModule sends the minted dst cPT to the account; both delegatecall, zero value, non-optional — the live Base intents' exact selectors); `hooks` takes explicit calls through the venue's shape battery. The hooks are hashed into `rolloverIntentHash` and ride the `venuePost.intent`; `data.intentHooks` counts them per phase; `owner_managed_funding` tells the holder to approve the CLONE for src cPT. No hooks at all is warned (`invalid_order_terms`, info), never silently signed. Config: a rollover block may declare `modules` (`cork-defaults.v2.json`, both chains' phoenix/v0.4-rc.1 sets; a generation without them refuses `standardHooks` as `unknown_deployment`). SDK (`/orders`): the BaseFiller/factory/module ABIs, `parseRolloverPayload`, `fillerJobOf`, `encodeBaseFillerExecute`, `encodeBaseFillerExecuteWithMarket`, `decodeBaseFillerCall`, `encodeDeployRolloverContract`, `requiredPremium`, `standardRolloverHooks`.

- `cork_submit rfq-open` pre-flights the venue's expiry-window rule locally: `notBefore` must be strictly before `notAfter` (the venue returns a 400 on equality), refused as `invalid_order_terms` with the one-exact-expiry recipe (`notBefore = expiry − 1`) instead of a raw venue rejection; registered in `MIRRORED_VENUE_LOGIC`. It also classifies the inline template's `oracle_recipe` by generation, chain-free from the configured recipe hints: `recipe_generation_notice` names the generation the cover is created on and, for a previous generation's recipe, warns that an underwriter quoting the primary alone passes silently and that only an adapter bound to that generation can trade the cover; an address no generation hints at is `recipe_not_found` as information. All three relay.

### Fixed

- The live registry parity suite (`rpc-live.test.ts`, CORK_RPC_LIVE=1) gains an independent NESTED-wire reference against the primary 0.5.0 registry on Arbitrum — ABI re-declared from the deployed contract's verified source, 4-argument `deploy` with the zero salt, address-unit denominations, 3-tuple feeds, and the 10-field pool id re-encoded with the fees inside. The flat reference stays pinned to `phoenix/v0.3-rc.1`.
- Share prediction (`derive-cork-pool`, `create-pool`, the JIT prepares) grants the simulating account a balance in the same state override that grants it the creator role. The account is the role holder, a contract with no ETH, and an endpoint that validates the sender's balance in `eth_simulateV1` (anvil does) refused the whole dry-run as a transport failure — `share_prediction_unavailable` on every fresh pool of the fork rehearsal. The prediction is now balance-independent on every endpoint.

## [0.6.1-rc.1] — 2026-09-28

A patch candidate of the 0.6 line. It fixes two defects that a dry run of v0.6.0 found against live chain state, and it moves the address fetch to the line's config branch. The covered surface is unchanged, apart from additive SDK exports.

### Changed

- A released binary reads its addresses from its line's config branch (policy R5c). From 0.6.1, the binary fetches `cork-defaults.v2.json` from `config/0.6`, a branch that holds only that file, instead of from `main`. The branch is the escape hatch for an address change: a compatible change pushed there reaches every installed 0.6 binary within the hour, without an upgrade. A source run still reads `main`, and `CORK_DEFAULTS_URL` still overrides both. The release workflow is the one writer of the branch (`config-branch.yml`, called before publish). It refuses a file that drops a set key a 0.6 binary resolves against. A frozen-keys test holds the tree and, in the live suite, the public refs to the same keys. `cork-defaults.v2.json` on `main` stays frozen for 0.6.0, which predates the branch.
- The CLI reference, the SDK guide, the SDK roadmap, the JIT order anatomy and the Zyfai quickstart are rewritten for completeness and flow.

### Added

- SDK (`/config`): `releaseLineOf`, `corkDefaultsUrlFor` and `CORK_DEFAULTS_REPO`. `releaseLineOf` reads the tag spelling the release pipeline stamps (`v0.6.1-rc.1`) as well as a bare version.
- A local configuration override, `config.json`: an OPERATOR layer that wins over `cork-defaults.v2.json` at whole-set granularity — a set under `generations.<chainId>.sets` replaces or adds the set with that key (complete sets only), `primary` moves a chain's primary, `only` keeps just the listed set keys (a partner pinning the sets it has integrated), `lopAddresses`/`fusionSettlements` entries replace per chain; `approvedImplementations` is never overridable and its presence refuses the file. Read from `CORK_CONFIG_FILE`, then `~/.config/cork-helper-cli/config.json`, then the source tree's root; `CORK_CONFIG_NO_OVERRIDE=1` disables it. Every result an override actually shaped warns `config_override_active` naming the file and the change (a file that changes nothing is disclosed in `protocol-config` only); a present file that fails the schema or would leave a chain invalid is refused whole (`config_override_invalid`) and the default serves alone. `cork_query protocol-config` shows the layers under `data.config`. Internal deployment sets (staging, dark-launch) live only in the private override, never in the public default. SDK (`/config`): `mergeConfig`, `parseOverride`, `loadOverrideFrom`, `overrideCandidatePaths`, `applyOverride`, `ConfigOverrideSchema`; resolver results carry `warnings[]` and `configOverride`.

### Fixed

- An EIP-7702 delegated EOA can make orders. Such an account carries code (the `0xef0100 ++ delegate` designator) but signs with its key, and the 1inch LOP's `fillOrder` verifies the maker by ECDSA recovery alone. The maker-signature check behind `finalize-maker-order`, `taker-fill` and `refresh-order` branched on code first, so it refused the valid signature (`signature_or_reconstruction_mismatch`) and would have routed the fill to `fillContractOrder`, which reverts `BadSignature` when the delegate does not implement ERC-1271. ecrecover now decides first; only a signature that does not recover to the maker goes to the ERC-1271 check, so a Safe is verified exactly as before. Proven on a Base fork: the order the tool refused filled through `fillOrder`, and `fillContractOrder` reverted.
- `cork_decode` trusts every configured generation's Cork adapter, not only the primary's. A bundle built for a pool on an older generation runs at THAT generation's adapter (every pool the venue serves today lives on `phoenix/v0.3-rc.1`), and the decode accused it of a `target_mismatch` against `phoenix/v0.4-rc.1`'s adapter — a false "do not sign" on every live bundle. Found by the anvil smoke of the 0.6 docs. A matched leg carries `generation` (the adapter's label); the primary's adapter stays unlabeled; a look-alike still conflicts naming the primary's adapter. SDK: `DecodeTrustTargets.corkAdapters` (labeled list) beside `corkAdapter`.
- The `owner_managed_funding` note on burn-side bundles (`withdraw`, `withdraw-other`, `redeem`, `unwind-deposit`, `unwind-mint` with `owner` ≠ adapter) named the wrong spender. The pool burns the shares from `owner` with the ADAPTER as caller, so the allowance the owner needs is to the cork adapter; an allowance to the pool manager is never spent. Verified on a Base fork: without it the bundle reverts `ERC20InsufficientAllowance` naming the adapter. The note now names the adapter address.

## [0.6.0] — 2026-09-24

This release adds the Distribution `phoenix/v0.4-rc.1` contract set: Phoenix 1.4.0-rc.1, Market Registry 0.5.0, Rollover 0.2.0 and cork-periphery 0.2.0-rc.1, on Arbitrum One and Base. It keeps every older set. A chain now hosts a SET of contract generations, one of them primary. Prepares target the primary. Reads, decode and event attribution follow the generation a pool or contract belongs to. Nothing here retires an address.

The primary on both chains is `phoenix/v0.4-rc.1`. The previous set (`phoenix/v0.3-rc.1`: Phoenix v1.3.0-rc.1, Market Registry 0.3.3, Rollover v0.1.0-rc.2) stays active. The older Arbitrum eras stay configured (`arbitrum-v1.1` active, `arbitrum-legacy` read-only). Mainnet is one generation. Every pool the venue serves today lives on an older pool manager than the 10-field primary, so a pool-scoped read or bundle now resolves the pool's generation from the chain instead of assuming the primary.

### Breaking

- `cork-defaults.v2.json` (schema 2) replaces `cork-defaults.json` as the address surface this version reads and fetches. Per chain it records `{ primary, sets: { <label>: generation } }`; each generation carries its `phoenix`, `marketRegistry`, `rollover` and `forSelf` blocks, and each block declares the WIRE it speaks (`8-field` | `10-field`, `legacy` | `flat` | `nested`, `rc.1` | `rc.2` | `0.2`). The config declares a wire; the code implements it; a declared wire the code does not know is refused, never guessed. The schema-1 file is frozen for the 0.5 line: a schema-1 file whose primary moved would send a 0.5.x binary to a generation whose wire it does not speak, and an 8-field decode of a 10-field `market()` return succeeds silently with a wrong pool id.
- Every jitMarket input (`maker-order`, `maker-ladder`, `taker-fill`, `answer-rfq`, `rollover-intent`) and `create-pool` name the recipe bytes `extraData`. `additionalData` is accepted as an alias with a `deprecation_notice`; both present and different refuse. `cork_compute recipe-rate-constraint` keeps `args`.
- `oracleSalt` (bytes32, default zero) joins every jitMarket input, `create-pool` and `deploy-oracle`. It is mixed into the CREATE2 salt of a pair's FIRST oracle wrapper only. A non-zero salt against a `flat` or `legacy` generation refuses and names the generation.
- `derive-cork-pool` takes `swapFeePercentage`, `unwindSwapFeePercentage` (digit strings, default `0`) and `oracleSalt` as filters. On a `10-field` generation the two fees are part of the pool id.
- `registry-denominations` on the `nested` wire lists address units (`{ unit, symbol, name }`) and takes `filters.address`; `filters.label` refuses there. `registry-feeds` rows carry `feedDecimals` only on the `flat` wire.
- The fee rule follows the pool manager's wire: at most 5% on `8-field`; strictly below 100% on `10-field` (Phoenix `InvalidFees()`; the new set has no `MAX_FEE_PERCENTAGE` getter). The teaching names the rule per wire.
- A pool no configured pool manager knows is `pool_not_found` (unavailable) naming every manager asked with its generation label. Before, that read was the ambiguous `chain_read_failed`. A chain that answered nothing stays `chain_read_failed`. The held-out eval task `ho-nonexistent-pool` expects the new code; its prompt and answer regex are unchanged.
- The scan cache identity carries a row-shape schema (`SCAN_CACHE_SCHEMA` 2). 0.5.x cursors are ignored: a cursor that asked only the 7-argument `MarketCreated` topic on a 10-field manager would stay empty forever.
- Decode `jit` labels carry `generation` (the chain label) and `wire`; the literal `"2.1.0"` and `"legacy (pre-2.1.0)"` generation strings are gone.
- SDK (`@cork/core`): `readAdapterRoles` → `readRoleHolder` (the role holder is the adapter on `flat`, the creator on `nested`); `computeMarketId(market, wire)` takes the wire and refuses a market whose shape contradicts it; `hashJitMarketParams(p, wire)` takes the rollover wire; `resolveDeployment`, `resolveRollover`, `resolveMarketRegistry` take an optional `generation` label and return `generation: { label, status, wire }`; `resolveMarketRegistryLegacy`, `CorkMarketRegistryLegacy` and `LEGACY_JIT_IMPLEMENTATION_ROLES` are removed (the legacy lane is the generation whose registry wire is `legacy`); `Market` is `Market8 | Market10`; `resolvePoolTokens` takes `{ poolManager, wire }` instead of a bare address; `CorkAddresses` requires `wire`; `decodeMarketRows` takes an optional emitter table; `PoolStateRead.market` is `Market8 | Market10` beside `wire`; `RolloverGenerationAddresses` is removed.

### Added

- **A resting order whose extension names a contract nobody here has read is refused, not filled** (owner requirement 2026-09-23). Every call target a LOP v4 extension carries — the two amount getters, the maker's pre- and post-interaction hooks — is classified against the chain's configured generations (the role must be `jitAdapter`, not mere address-book membership) and the release-pinned Fusion settlement (`extensionTargets`, `packages/core/src/extension-targets.ts`). An unknown HOOK: `taker-fill` refuses with `foreign_extension_target` and no bytes, on the raw and the ForSelf path alike, whatever cap the caller set — no cap bounds what a hook does inside the taker's transaction; the ranked `orderbook` excludes the row as `foreign-hook` naming the address (served, disclosed, never ranked); `cork_decode kind:order` lists every target under `targets` and the foreign ones under `foreignTargets`. An unknown GETTER keeps the 2026-08-26 rule: the derived cap is refused, an explicit cap builds with a warning, because the LOP enforces that cap on-chain. Addresses are classified by their bytes whatever case the venue used (a checksum-invalid spelling is not "no target"). Eleven tests, five caught probes.
- **Six eval tasks close the coverage gaps named 2026-09-23**: a prepare under `generation: previous` (the result must name the label), a venue-free `full-decentralized` pool list (the pledge must be stated), a CHAINED derive-then-prepare flow graded with `require`, and three refusals the stub can refute — a finalize with a tampered signature (`signature_or_reconstruction_mismatch`), a listing nonce contradicting the signed traits (`listing_traits_mismatch`), and the foreign-hook fill above. Each has an offline fixture mirror and a canonical self-drive play; the winnability gate holds every task to one play.

- `generation` — an optional input on every chain-backed tool (`cork_query`, `cork_compute`, `cork_prepare_phoenix`, `cork_prepare_orders`, `cork_prepare_market`, `cork_track`). Omitted, a prepare targets the primary. A read-only generation refuses a prepare (`generation_read_only`); an unknown label refuses and lists the chain's labels (`generation_unknown`). `protocol-config` reports the selected generation and the chain's full list with every block's addresses and wire. `cork_capabilities topic:"generations"` (aliases `generation`, `wires`, `primary`) is the doc topic: what a generation is, the labels and statuses, how a prepare picks one, how a pool read resolves one, and the wire table.
- **Migration: the previous and the current generation at the same time.** `generation` takes the aliases `previous` (the newest active non-primary generation that carries the contracts the call needs — a pool manager, a market registry, a rollover settler) and `primary` (the same as omitting it). Aliases resolve to a label in one place and every result carries the label, never the alias. `all` is refused with teaching (a prepare builds one artifact); a chain with a single generation refuses `previous` as `generation_unknown`.
- **`cork_query account-state` without `filters.poolId`** returns the account's positions across every generation with a pool manager: the pool list is enumerated from the chain over YOUR RPC by default (the `MarketCreated` scan, decoded per emitter wire — complete in one request on both built-in endpoints), from HyperSync under `mode: "full-decentralized"`, or from the venue's `/pools/v1` rows under `mode: "hybrid"` (walked at the caller's `pageSize`/`maxPages` like `cork-pools`, each row attributed to the generation its pool manager belongs to, the venue's expiry accepted ONLY as a strict ISO-8601 date-time with an explicit zone and canonicalised — the opt-in for an endpoint that caps `eth_getLogs` too hard for the walk to finish), one balance sweep reads cST and cPT per pool over YOUR RPC, and the result keeps the pools with a non-zero balance — `positions[]` (generation, poolId, poolManager, expiryTimestamp, expired, assets, share tokens, balances), `byGeneration[]` (pool count and exact 18-decimal share totals per generation asked), `generations[]`, `scanned`. `generation` narrows the sweep (label or alias; `all` = no narrowing). This result carries no `provenance.generation`; the single-pool read is unchanged. CLI: `ch query account-state --account <a>` prints a positions table.
- `cork_capabilities topic:"migration"` (aliases `migrate`, `move-funds`, `previous-generation`): the recipe — positions read, pool-scoped exit per expiry state, entry on the primary (`deposit`/`mint`, `create-pool` first, or `rollover-intent`), `cork_track` verification — the aliases, and the two standing facts about the new set.
- SDK (`@cork/core`, root and `/config`): `GENERATION_ALIASES`, `GENERATION_BLOCK_KINDS`, `GenerationAlias`, `GenerationBlockKind`, `isGenerationAlias`, `resolveGenerationAlias(list, label, needs, purpose)`; `selectGeneration` takes an optional fourth argument `needs` (the block kinds the call requires — steers `previous`). Additive.
- **Pool-scoped results follow the POOL's generation.** `cork_query` cork-pool / account-state / pool-whitelist, the three chain `cork_compute` kinds, `cork_track` marketRef, the 13 `cork_prepare_phoenix` actions and the ForSelf twins resolve the pool's generation from the chain — one batched `shares(poolId)` read across every configured pool manager — and carry it as `data.generation` (`{ label, status, distribution? }`) and `provenance.generation` (a new optional field on the envelope schema). The bundle for a pool on an older set targets THAT set's adapter, bundler and whitelist manager. `generation` in the input narrows the search to one set. A pre-expiry `cork_prepare_phoenix` action on a pool that lives on a read-only set refuses `generation_read_only`; the three post-expiry settles (withdraw, withdraw-other, redeem) still build.
- **10-field reads.** cork-pool and track marketRef decode the widened `market()` tuple on a 10-field manager (`data.wire`), take the fees FROM the tuple (the identity) and compare them with the `swapFee`/`unwindSwapFee` views — a disagreement is an `invalid_state` warning naming both values. The `scales.market` label says when the fees ride inside the struct. marketRef re-hashes on the pool's wire.
- The `nested` Market Registry wire (0.5.0): `abi.encode((MarketParams market, bool enableJitMint), PermitParams[])` with `extraData` and `oracleSalt` inside `MarketParams`; `verify(ca, ref, oracle, expiryTimestamp, creating, constraint, extraData)`; `deploy(ca, ref, mode, oracleSalt)`; `CorkMarketCreator.createNewPool(MarketParams)` from the registry package; the 10-field controller `createNewPool((Market, isWhitelistEnabled))`; the binding chain `adapter.MARKET_CREATOR → creator.MARKET_REGISTRY`, one `POOL_MANAGER` end to end; roles read on the creator. The `flat` wire (0.3.x) is byte-identical to 0.5.1. Golden vectors come from the chain: the deployed adapter's own `encodeExtraData` bytes are reproduced byte for byte and decoded back, `pm.getId` for the 10-field identity, and the creator, verify, deploy and controller selectors with their word layouts. A Solidity mirror of the nested decoder reads the same fixture; flat bytes revert in it.
- The Rollover `0.2` wire: `JITMarketParams` gains `bytes32 oracleSalt` after `additionalData`; the typehash changes; `rc.2` stays byte-identical. The `rollover-intent` prepare takes the wire from the SETTLER's generation, binds that generation's registry and fee rule, derives the destination pool with the 10-field identity under `0.2`, and echoes `jitMarketWire`. The chain-captured `hashJITMarketParams` golden is reproduced, and a Solidity mirror of BaseFiller 0.2 agrees. `rc.1` (the retired July 2026 set) refuses a jitMarket: it predates `jitMarketHash`.
- **Both MarketCreated shapes in every pool-creation scan.** Event decoding knows the 7-argument `MarketCreated` of an `8-field` pool manager, the 9-argument one of a `10-field` manager, and the creator's `MarketCreated`. full-decentralized cork-pools / trading-pairs / the fills join ask for both pool-manager topics and decode each log with the ABI of its EMITTER's declared wire — never by topic guessing; rows carry `wire`, `generation` and, on 10-field, the two fees. The hybrid existence probe reads each manager through its own `market()` ABI. Emitter attribution lists a topic only for generations whose wires speak it.
- **Emitter roles.** `baseFiller` (the rollover BaseFiller's three-argument `JITMarketCreated`; `rollover.baseFiller` in the config, a `classifyAddress` role), `factory` (`RolloverContractDeployed`), `whitelistManager` (the six whitelist events), and the 7-argument `MarketCreated` for 8-field pool managers — a manager is evidence only for its own wire's topic. Every Cork topic in the verified event set now has an emitter role, and a test holds the parity.
- Decode classifies a JIT hook target by its generation FIRST and decodes on that generation's wire; it never trial-decodes. Nested bytes at a flat adapter get no label.
- `cork_capabilities topic:"units"` gains the 10-field fee rows: the two fee fields are part of the pool id there, and the bound is strictly below 100% instead of the 8-field 5% cap.
- SDK: `generations.ts` (`generationsOf`, `primaryOf`, `selectGeneration`, `classifyAddress`, `resolvePoolGeneration`, `rolloverGenerationsOf`, `marketRegistryForWire`, the wire enums and block schemas), the nested ABIs and codec table (`WIRES`, `wireCodec`), `readRoleHolder`, `deriveRolloverJitPool`, `JIT_MARKET_PARAMS_TYPEHASHES`, `Market8`/`Market10`/`assertMarketWire`/`isMarket10`, `ZERO_ORACLE_SALT`, `PoolManagerRef`, `FeeDisagreement`, `feeDisagreementWarnings`, `poolManagerMarket10Abi`, `marketAbiFor`, `MARKET_CREATED_10_TOPIC`, `MARKET_CREATED_TOPICS`, `MarketEmitter`, `BASE_FILLER_JIT_MARKET_CREATED_TOPIC`, `POST_EXPIRY_ACTIONS`, the two new `MarketCreated` topics.

The rollover config can name more than one ACTIVE generation. On 2026-09-11 the venue (cork-indexing-api 0.4.2) started to admit every non-archived rollover factory, and the Distribution 0.4-rc.1 candidate set (factory `0x99A5C47CbF062D4E6665afAF32aE6496F9f93F65`, ExactSettler `0x0F2Ce7a5b817865ebFf50c58439B9A27E38f452E`, PartialSettler `0x5E19Be0743fE521d8BF85b5A558356675499bE9e`, the same addresses on Arbitrum and Base) went live beside rc.2. The old model knew one active set and a list of retired sets, so it called the new settlers unknown: prepares built with a warning, the book left their rows unverified, decode labeled a tx to them `unknown_target`, and no scan read their history. Each factory approves only its own settlers, so the old mode-mismatch teaching also named the wrong partner for a settler outside the primary set. In the generation model those settlers are the `phoenix/v0.4-rc.1` rollover block (wire `0.2`).

- **One flattening for every rollover consumer.** `rolloverGenerationsOf` turns a chain's generations into an ordered list (the primary's rollover block, other active blocks, retired blocks), each with a `label`, a `status` and a `primary` flag. Classification, the event-history scan targets, the emitter table, the decode target labels and the settler teachings all read that list. Nothing consults the primary fields on their own any more.
- **Rollover rows name the generation.** Hybrid `rollover-orders` rows, track's `chainVerification` (status leg, logs leg and the venue-miss sweep) and the rollover-intent result carry `settlerGenerationLabel` (respectively `settlerGeneration`) beside the active/retired flag. Decode names a settler outside the primary set with its standing and label, for example `exactSettler (active phoenix/v0.3-rc.1 generation)`.
- **The settler teachings list every active generation.** `settler_not_recognized` and `settler_retired` name every active ExactSettler or PartialSettler with its label, the primary one marked. `settler_mode_mismatch` names the SAME generation's partner, never the primary's.

### Fixed

- **One boundary parser for every venue timestamp** (`venueInstant`, `@cork/schemas`): a venue instant is admitted in exactly two unambiguous shapes — integer unix seconds (what every RFQ field serves: `valid_until`, `received_at`, `fresh_until`, option `expiry`) or strict ISO-8601 with an explicit zone (what `/pools/v1` serves) — and emitted as one canonical pair, `YYYY-MM-DDTHH:MM:SSZ` plus decimal seconds, so two rows naming one instant compare equal whatever their source. Refused: zone-less date-times (`Date.parse` reads them as local time), date-only and space-separated forms, natural language, fractional or negative numbers, and any value past the year-2100 bound (a 13-digit millisecond value lands there). The positions sweep, `answer-rfq` (`valid_until`, the cited option's expiry) and `rfqs --watch` (`received_at`, `fresh_until`) read through it.
- **A range-capped RPC no longer kills the positions sweep.** An endpoint that refuses `eth_getLogs` even at the 1,000-block floor throws a typed `LogRangeCapError` (on the `/indexer` SDK surface). On an AUTOMATIC endpoint (built-in default or chainlist) the sweep reports it to the breaker, re-resolves once and re-runs the walk, disclosing `rpc_fallback` with both hosts — the recovery a transport failure already gets; on an EXPLICIT endpoint (`--rpc-url` / `CORK_RPC_URL`, the operator's own choice) it fails loudly as `chain_read_failed` naming the host and the floor, never swapped behind the operator's back. Live probe 2026-09-23: of the chainlist fallbacks reachable for Arbitrum and Base, one accepts the full span, one 2,000,000 blocks, one 10,000, one 1,000, and several refuse every range or time out.

- **Every position row carries `expiry`** — the pool's expiry as strict ISO-8601 UTC at second precision (`YYYY-MM-DDTHH:MM:SSZ`) beside `expiryTimestamp` (unix seconds). Both sources land on the one spelling: the chain's integer seconds and the venue's ISO strings. The venue boundary accepts only an unambiguous ISO date-time (a `T` separator, seconds, an explicit `Z` or `±HH:MM`; the calendar round-trip checked, a sub-second fraction dropped) — a zone-less date, a date-only string, a bare digit string (seconds or milliseconds is undecidable) and natural-language forms are refused and counted in the `invalid_service_response` disclosure. The CLI table shows the ISO column.

- **The tokenless `eth_getLogs` fallback asks for the whole remaining range first** and adapts: a refused range shrinks 5× (floor 1,000 blocks — the strictest public cap we know), the refused size is remembered as a ceiling and growth stays below half of it. The fixed 50,000-block window it replaces walked 1,000,000 blocks per call from block 0 and answered `pools: 0, complete: false` on both chains; both built-in endpoints answer an address-filtered query over the full chain in about 1.5 s. `WINDOWED_RPC_WINDOW_BLOCKS` is replaced by `WINDOWED_RPC_MIN_WINDOW_BLOCKS` on the `/indexer` SDK surface.
- A `rollover-intent` whose settler belongs to no configured generation refuses `invalid_order_terms` when it carries a JIT commitment (`jitMarket` or a non-zero `jitMarketHash`). Before, the commitment was hashed on the primary's wire — a guess no filler on another wire can reproduce. A plain order keeps the `settler_not_recognized` path.
- The pool id width comes only from the settler generation's declared `phoenix.wire`. A generation that declares no phoenix block refuses `unknown_deployment`. Before, two sites inferred the width from the registry or rollover wire.
- One JIT extension decoder, `decodeJitExtensionFor`: the hook adapter is classified first and the bytes decode on that generation's wire. An adapter no generation vouches for yields no label and a maker-readiness verdict of `unknown`. The two trial-decode ladders are gone.
- `decodeMarketRows` requires the emitter table; a log from an unlisted address is dropped, never decoded on a default width.
- `generation_unknown` is invalid input on every path and suggests the nearest label. `generation_read_only` stays an `unavailable` envelope. Both carry `provenance.generation`.
- One `resolveJitBytesInput` handles the `extraData` / `additionalData` alias for the registry jitMarket, `create-pool` and the rollover jitMarket: the alias alone is accepted with a `deprecation_notice`; both present and different refuse.
- `protocol-config` carries `provenance.generation` and the same compact `data.generation` as every other result; the extras moved under `data.selected`.
- One status vocabulary: emitters and rollover rows carry `generation: { label, status }`; the `settlerGenerationLabel` twin and the `legacyJitAdapter` role name are gone.
- `readPoolState` reads `market()` through the one ABI chooser, `marketAbiFor(wire)`; one `deriveJitMarket({ wire })` derives every JIT pool id.
- A 10-field `market()` tuple whose fees disagree with the `swapFee` / `unwindSwapFee` views warns `fee_view_mismatch`, its own code.
- The scan cache prunes entries written under an older schema on load; they no longer grow the file forever.
- The inline templates `cork-inline-liquidity/1` and `cork-inline-impairment/1` accept an optional `oracle_salt`; an explicit `jitMarket.oracleSalt` wins.
- `cork-defaults.json` (schema 1) is byte-frozen at its v0.5.1 contents and its digest is pinned by a test.

- Registry-bound prepares never emit one wire's bytes at another wire's adapter: the selected generation's declared wire drives the codec, and a generation whose wire this build does not implement refuses `phase_gated`.
- `share_prediction_unavailable` names the simulated revert (for example `InvalidRate`, `RecipeRejectedConstraint`) instead of a generic transport guess.
- Pool-scoped reads and bundles for a pool on an older pool manager no longer route through the primary's addresses. Before this release every pool the venue serves read as absent (`chain_read_failed`) once the primary moved.

### Deprecated

- `additionalData` on every jitMarket input and on `create-pool`. It is an alias of `extraData` (the market-registry 0.5.0 word) and answers with `deprecation_notice`; both present and different refuse. Pass `extraData`.
- `mode` names (`liquidity`, `nav`, `fixed`, `impairment`) on recipe inputs and the pre-2.1.0 registry flow (`legacy: true`, `CORK_ENABLE_DEPRECATED=1`) stay deprecated as in 0.5.1. The legacy lane is now the generation whose registry wire is `legacy`.
- Schema 1 `cork-defaults.json` is frozen at its 0.5.1 contents for 0.5.x binaries. This version reads and fetches `cork-defaults.v2.json` only.

### Verified

- Nested fill rehearsal on a Base fork (`experiments/fork-harness/script/nested-fill-rehearsal.ts`, private tree): a tool-built order fills through the real 1inch LOP against the phoenix/v0.4-rc.1 set — the adapter decodes the bytes field for field, the fill deploys the NAV oracle with the order's salt, creates the 10-field pool at the predicted id with the fees as identity, and mints the predicted cST. The Market Registry 0.5.0 holds no assets on either chain yet; the rehearsal registers the pair as the registry owner, a fork-only step. Two lessons from the first runs: address-keyed denominations need a USD path before an asset row is accepted, and an undeployed NAV pair's anchor must be the live vault rate or the fill reverts.
- 67 new mutation probes (generation ordering and selection, the 10-field id width, salt and nesting positions, verify argument order, the fee rule per wire, the role holder per wire, the binding chain, alias precedence, decode dispatch, the rollover typehash per wire, pool-generation resolution, fee-from-tuple, the MarketCreated ABI per wire, the scan identity bump), all caught; 580 probes in the catalog, none rotted.

## [0.5.1] — 2026-09-22

Supersedes 0.5.1-rc.1 through 0.5.1-rc.7. This is the last release for the current generation of on-chain contracts (market-registry 0.3.3, phoenix v1.3.0-rc.1, rollover v0.1.0-rc.2 on Arbitrum One and Base). The Distribution 0.4 contract set is not in this release. Orders that name its rollover settlers read `settler_not_recognized`.

This release adds the order lifecycle for the RFQ market: a ranked book, a book watch, one-cancels-the-other groups, ladders, a one-call RFQ answer, and the offers view. It authenticates every venue row before it ranks, announces, or fills it. It decodes the maker's side of a resting order and excludes what cannot deliver. It integrates the fourth recipe. It works one external review (Daybreak Blue, eleven findings, none high) and one incident (2026-09-11, a structurally unfillable order ranked first). No input schema, tool name, or exit code is removed. Row order on `cork_query orderbook` changes: it is ranked by default.

### Breaking

- `cork_query orderbook` returns ranked rows by default (`sort: "best"`). The venue's newest-first order is `sort: "venue"`. Rows and pages carry new keys. Scripts that assumed venue order must pass `sort: "venue"` or read `rank`.
- `cork_query` refuses a filter key the read shape does not apply. Before, `rfqs` with `rfqId` accepted `state`, `account`, `underwriter`, `excludeRequestPrefix`, `withAnswers` and `referenceAsset` and ignored them; `rollover-orders` accepted a key from another `kind`'s feed and ignored it. Both now refuse with teaching. An unfiltered answer must never pass for a filtered one. (Audit DB-006.)
- `ch mcp --http` no longer trusts `X-Forwarded-For` for a non-loopback bind. Trust is explicit: `--trust-forwarded-for`, or `CORK_MCP_TRUST_FORWARDED_FOR=1`. Set it only behind an ingress you control. Without it, every caller behind a proxy shares one per-client slot set. `/readyz` reports the posture under `subsystems.admission.trustForwardedFor`. The hosted compose file sets the flag. (Audit DB-002.)
- A `clientRequestId` may not start with `oco-group:`. The schema and `buildMakerOrder` refuse it. That prefix is the group nonce seed, so a group seed and an id seed are never the same string. No existing nonce changes. (Audit RC1-NONCE-001.)

### Added

**The order vocabulary and the ranked book.**

- `cork_capabilities topic:"orders"` (aliases `order-lifecycle`, `reservation`, `oco`, `one-cancels-the-other`, `ladder`, `liveness`, `exclusivity`): one term per concept. Reach: open, or reserved for a FILL SENDER — the low 80 bits of the address that calls the LOP, the ForSelf adapter on a wrapper fill. Fill regime: every Cork order is single-fill on the bit invalidator; a partial fill still spends the bit. Groups: orders that share a nonce are one-cancels-the-other; a ladder is a group with a purpose; the venue never learns a group. Price shape: fixed or decaying. Provenance: cited or uncited; a quote is firm only when a live cited order backs it. A liveness table names who knows each state first. A synonyms table maps dedicated, private and single-taker to reserved, and OCO and OCA to group. A parity test holds every field rule to its schema description. `private_order` refusals route here.
- `cork_query orderbook` is RANKED by default. Fillable rows only — open, or reserved for `filters.account` — by unit price from the SIGNED amounts; a decaying row at its price now. Ties: reserved-for-account wins, chain-confirmed beats unverified, longer-lived beats shorter, then orderHash. Rungs of one group collapse to their best rung with `group.collapsed`. Rows the account cannot fill ride under `excluded` with `whyNotFillable` and a branchable `exclusion` (`reserved-for-other`, `expired`, `venue-status`, `unparseable`, `zero-amount`, `maker-not-ready`). Expiry mirrors `MakerTraitsLib.isExpired` (`<`). `count` stays every served row; `fillableCount`, `rankedFor`, `price` (`unitPrice` = takerAsset base units per 1e18 makerAsset base units, `shape`, `phase`, `takerPaysNow`), `rankingNote` and a `scales` block ride beside. Without `filters.account` the ranking is price-only and reserved rows are kept and flagged. `sort` on another resource is refused.
- `cork_query orderbook` takes `since` and `wait`. Every ranked read returns `watermark`, a client-side token over the live set and the best per side, taken for the fill sender. `since` adds `changes`: `appeared` (confirmed only), `gone`, `unconfirmed`, `best` per side (`changed`, `died`), and `better` — confirmed rows the taker would rather fill: a lower unit price on SELL, a higher one on BUY, or the same price reserved for this sender instead of open. `wait` (1..25 s) long-polls at a 2 s cadence, poll-count driven, and `waited` says how it ended. A non-ok read inside the poll ends the poll and is returned as-is; a venue 429 keeps its `Retry-After` and is never re-hit. A watermark for another sender, a foreign token, `since` or `wait` off the orderbook or under `sort:"venue"`, and `wait` without `since` are refused.
- `ch query orderbook --watch [--interval <s>] [--iterations <n>]` loops the ranked read and prints the first read, then only the ticks that changed.
- `ch query rfqs --watch` re-reads the RFQ feed with answers and prints a tick when an RFQ appears or goes, its `version` moves, or the alert set moves. `data.changes.unbacked` names every requester counter that accepts a quoted option no live order cites — the signature of an accepted quote nobody rested. `backedNow` names the RFQs a citing order later backed.

**Groups, ladders, and the one-call answer.**

- `cork_prepare_orders maker-order` takes `ocoGroup`. The 40-bit invalidator nonce derives from the group key instead of `clientRequestId`, so every order by the maker that names the group shares one bit, and the first fill or cancel of any of them retires all of them. Each rung keeps its own `clientRequestId`. The result echoes `ocoGroup` and `nonce`. An info `oco_group_notice` teaches that the venue never learns the group: a sibling left open after another rung filled is dead on chain, so re-read the bit before ranking or filling.
- `cork_prepare_orders maker-ladder`: 2 to 32 rungs on one pool and side in one call, each with its own price, reach, expiry and optional decay, one `jitMarket` for the ladder. Every rung re-enters the maker-order path. `noncePolicy`: `shared-reserved` (default — reserved rungs share the group, each open rung is its own bit), `shared` (one rung can ever fill), `distinct` (independent orders). Rung ids are `<ladderId>:<index>`; `ocoGroup` defaults to the ladder id. The result carries one artifact per rung, the group each rung landed on, `capacity`, one collapsed `oco_group_notice`, and `execution`. A rung the maker-order path refuses fails the whole ladder and names `failedRung`. Each rung passes verbatim to finalize-maker-order under its own id. A JIT ladder repeats the JIT derivation once per rung.
- `cork_prepare_orders cancel` results carry `retires`: the invalidator mode the signed traits select, the nonce, and the scope. On the bit invalidator a cancel of any one rung retires the whole shared-nonce ladder.
- `cork_prepare_orders answer-rfq`: the underwriter's every-RFQ sequence as one call. The RFQ record supplies the pair, the notional, the requester and the expiry window. A cited option (`answerId` + `optionId`, your own answer — the cork-api 0.4.1 party rule) or your `premiumAnnualized` + `expiryTimestamp` supplies the price. The pool the cover creates is derived (recipe → constraint → pool id → predicted cST), the constraint is pinned into the order, and the amounts are the kernel's: `takingAmount = ceil(premium × notional × tenor / 31,536,000)` in collateral units, `makingAmount` = the notional as 18-decimal cST. The order expiry follows the venue's re-rest rule `max(90 s, min(10 min, remaining / 2))`. `ocoGroup` defaults to `rfq:<rfqId>`. The result is the maker-order artifact plus `answer`. It never chooses a premium.
- answer-rfq reserves for `fillSender` or the RFQ's declared `fill_sender`. Otherwise it builds an OPEN order and warns `fill_sender_unknown`: the LOP compares `allowedSender` with the address that CALLS it, and a requester behind a ForSelf adapter is not that caller. `data.answer.reach` says `reserved` or `open`.
- answer-rfq reads the requester's inline template, `market_template.inline.oracle_params`. The venue stores that block verbatim and never interprets it, so the schema name inside it is the contract between requester and underwriter. `cork-inline-liquidity/1` = `{schema, anchor_rate, expiry, swap_fee_wad, unwind_swap_fee_wad}`: the anchor rides as `additionalData`, the fees fill the JIT block, an expiry that differs from the answer's is `invalid_order_terms` (info, a different pool). `cork-inline-impairment/1` adds `duration_seconds` and `apy_spread_percentage` (1e18 = 1%) for the impairment recipe; its payload is the recipe's three words or nothing — a partial block warns `invalid_order_terms` naming the missing word and never encodes a zero. `duration_seconds` more than a day off the answer's tenor is disclosed. Explicit `jitMarket` fields win over the block. `answer.inline` echoes what was read, `complete`, and `anchorHonored`. Verified live: every current recipe anchors on the LIVE oracle rate while the oracle is deployed and honours the carried anchor only while it is undeployed; a differing live rate is `rate_drift_notice`.
- `cork_prepare_orders refresh-order`: re-rest a resting order of yours on the SAME nonce with a new expiry (default 10 min) and a fresh `clientRequestId`. The old order and the new one share one bit. Refused when the maker is not `account`, when the row does not hash to `orderHash`, or when the bit is spent (`status_mismatch`).
- A maker-order by a CONTRACT maker whose JIT pool does not exist yet gets `contract_maker_pre_rest` (info) and a `data.execution.then` that starts with create-pool and the allowances. The EOA-only ERC-2612 permit path is closed to a contract account.

**The offers view and the probe walk.**

- `cork_query offers`: every LIVE resting order (the ranked book for `filters.account`) joined on `quoteRef` with the RFQ answer option it cites. `provenance` is cited, cited-unresolved, or uncited; `quote` carries the option. A quote is FIRM only when a live order cites it; `indicative` counts and names the served options no live order backs. The citation resolves on both ids. `filters.rfqId` narrows to one request. When the RFQ leg fails, the view serves the book alone and says so (`needs_service`). CLI alias `offer`.
- `cork_query rfqs` rows read with answers carry `firm` on every answer and option, from the same join, plus `firmQuotes` and `indicativeQuotes` per RFQ.
- With `filters.account` and an RPC, the offers view probe-fills each side FROM THE TOP with the REAL fill calldata (threshold 0, so an auction row probes at its live price) until at least two rows prove maker-side deliverable, or the budget runs out. `fillSimulation` on each probed row: `fillable`, `maker-ready` (reverts only on the taker-asset pull — grant the allowance and it fills), `would-revert` (named LOP/Cork error or raw selector), `unknown` (transport, never a verdict). Both green verdicts count as proven: a sender without the taker allowance reads `maker-ready` on every healthy row. `data.probing` reports per side what was probed, proved, and why the walk stopped. Failing probed rows warn `would_revert`; a walk stopped by transport warns `chain_read_failed`. `probeBudget` (1..25, default 6, `CORK_PROBE_BUDGET` moves the default) bounds the walk per side and is refused off offers. The watch tick probes only its announced best. Only a row whose maker signature the verifier settled is probed.

**Maker readiness.**

- Every hybrid book read decodes the MAKER's side of each row in one batched read per distinct (maker, makerAsset, sourcing, JIT context). A code-less makerAsset with no creating JIT hook is `silent-noop`: the LOP's transfer helper counts a call to a code-less address as success, so such a fill "succeeds" and delivers nothing — and it simulates green. With a hook but no covering permit, `unborn-cst-no-permit`; with a permit but a CONTRACT maker, `contract-maker-unborn-cst` — the 2026-09-11 incident. A token with code is judged on allowance (plain, or both Permit2 layers with expiry), the two ERC-2612 hatches (both die with a contract maker), balance, and the mint's collateral funding (only zero is provable). A transport failure is never a verdict. Rows carry `makerReadiness`; a page with proven-not-ready rows warns `maker_not_ready` once. The ranked view excludes a PROVEN not-ready row with `exclusion: "maker-not-ready"` and the evidence under `whyNotFillable`; `unknown` rows keep ranking. Every reason is fixable without re-signing.
- taker-fill pre-flights the maker's side. The fill still builds. A structural gap warns `maker_not_ready`, a fund gap warns `would_revert`, `data.makerReadiness` carries the verdict, and `data.approvals` lists the maker-side grants too.

**The fourth recipe.**

- `ApySpreadImpairmentRecipe` (market-registry 0.4.0, `0x7340BfbEdF3657a7bBCe0dD2b4ab205754cc9eCA` on both chains) is integrated. Its window is the anchor ± `apySpread × duration / 365 days`; one day of the spread per day; seven days of capacity. Verified live: approved on the current registry on Base and Arbitrum, `REGISTRY()` binds the configured registry, `resolve()` is wei-exact against the chain-verified band rounding, and `BandTooWide` decodes by name from the deployed bytecode. A tool-built impairment order filled through the real 1inch LOP on a Base fork: pool at the predicted id, cST at the predicted address, kernel-exact premium. What shipped: the catalog entry (`SECONDS_PER_YEAR`, `CAPACITY_DAYS`, the args teaching), `encodeImpairmentArgs` (the 96-byte `abi.encode(anchorRate 1e18=1.0, durationSeconds, apySpreadPercentage 1e18=1%)`), the recipe's seven typed errors on the recipe ABI so `recipe_refused` names them, the `mode: "impairment"` sugar hint, and the refusal teaching. The 0.4.0 release moved no registry or adapter address.
- `cork_compute recipe-rate-constraint` takes `argsUints`: the recipe's additionalData as decimal uint256 words, ABI-encoded by the tool (`encodeUintWords`). Mutually exclusive with `args`. An MCP agent cannot call the SDK's encoders; hand-built hex was what it was being graded on.

**Verification and safety.**

- A venue row is discovery, not authority (audit DB-004). Every path that acts on a venue row runs the extension rule exactly as `OrderLib.isValidExtension` decides it at fill, and the maker signature: ecrecover for an EOA, the maker's own `isValidSignature` for a contract maker. Both live in one module. On the book, `confirmed` means the maker signed the row AND its bit is unspent. Rows carry `makerSignature` (`eoa-verified`, `erc1271-verified`, `unverified`). A refuted signature drops the row under `status_mismatch`; an extension the order never committed to drops chain-free under `signature_or_reconstruction_mismatch`; a row that does not hash to its own `orderHash` drops chain-free under `order_hash_mismatch`. Bytes ecrecover cannot read — the 85-byte Safe7579 `validator ++ sig` included — are never dropped chain-free; they go to the code probe and the ERC-1271 leg. A maker nobody could ask stays `unverified`. `status_mismatch` counts the chain's drops alone; `verification.dropped` counts the total. The venue taker-fill branch and refresh-order run the same rule. Fill artifacts echo the verdict's `makerAccountType`, never the venue's claim.
- The HTTP deadline is end-to-end (audit DB-001). The admission signal rides into every venue fetch. An abort surfaces as `request_aborted`, never feeds the breaker, and is never retried. The caller gets its 504 the moment the deadline elapses. The slot is released when the cancelled work settles.
- `cork_decode` kind:"calldata" without `to` on a Bundler3 multicall emits `target_unverified` naming the OUTER target (audit DB-003).
- create-pool compares the creator's bound CONTROLLER with the configured one; a difference is `adapter_binding_mismatch` (audit DB-005).
- A transport failure is never an oracle or recipe verdict (audit DB-007). `oracle.rateReadFailure` says `revert` or `transport`; a transport failure is `chain_read_failed` everywhere.
- The bytes-decoder gate. The approved-implementations guard REFUSES on the JIT paths when the adapter's live code is off this build's list (`implementation_not_approved` as a conflict, no bytes): a hook that decodes bytes this tool encodes could read them as a different market. ABI-typed paths stay build-and-warn. `CORK_ALLOW_UNAPPROVED_CODE=1` builds anyway, labeled `implementation_gate_bypassed`.
- The decode round-trip. Every JIT prepare with an RPC and a 0.4.0+ adapter hands its extraData to the deployed adapter's `decodeExtraData` and compares field for field; a disagreement is `extra_data_layout_mismatch`. An offline build, a helper-less adapter, or a transport failure reports `unchecked`. The encoder is also verified against a Solidity reference decoder with forge.
- `cork_query rfqs` takes `filters.underwriter` (only RFQs that underwriter answered, server-side). The venue OpenAPI tripwire runs in the public `live-smoke` job.

### Fixed

- answer-rfq refused every real RFQ. The venue serves an RFQ as an envelope: row facts beside `request`, the requester's body stored verbatim. This tool's fixtures served the body flat, so no offline test could see the gap. One flatten now runs at the boundary (`normalizeRfqRow`). The eval stub serves the real nested envelope.
- A gated answer-rfq derive dropped every warning gathered before it. The reason still rides first; the earlier warnings now follow it.

### Changed

- The `marketTemplate` description on rfq-open names `oracle_params` as required on an inline template and spells out both blocks. Sending `{}` is refused by the venue.
- The answer-rfq `jitMarket` description states that `additionalData` is derived from the RFQ's inline block when omitted.
- The Zyfai quickstart says the carried anchor pins the pool only while the pair's oracle is undeployed, and shows the fourth recipe.
- Agent evals grade a read-only tool ahead of a prepare or submit target as a correct first pick. Ten new tasks cover the order lifecycle, the offers view, the watch, the RFQ answer, and the impairment recipe. The venue-row fixtures carry real maker signatures.

### Corrected

- The 0.5.0 notes said every JIT prepare hands its extraData to the deployed decoder. The round-trip runs only with an RPC and an adapter that exposes the helper.
- The 0.5.0 notes said `RESOURCE_FILTER_KEYS`, `assertFiltersApplicable`, `fetchWithTimeout` and `fetchFollowingSameOrigin` are SDK exports. They are internal by design.

### Deprecated

- `mode` names (`liquidity`, `nav`, `fixed`, `impairment`) on recipe inputs. They map to a configured recipe address with `deprecation_notice`. Pass the recipe CONTRACT ADDRESS.
- The pre-2.1.0 registry flow (`legacy: true`, `CORK_ENABLE_DEPRECATED=1`). It answers with `deprecated`.
- The "formerly digest_mismatch" wording on the split conflict codes is removed. The codes (`artifact_digest_mismatch`, `intent_hash_mismatch`, `venue_digest_mismatch`, `order_hash_mismatch`, `marketid_mismatch`, `create2_mismatch`) have carried one release.

### SDK (`@cork/core`)

- `/orders`: `rankBookRows`, `compareRanked`, `BOOK_SORTS`, the `RankedRow`/`ExcludedRow`/`RankOptions`/`RankResult` types; `bookWatermarkOf`, `encodeBookWatermark`, `decodeBookWatermark`, `WATERMARK_PREFIX`, `diffBook`, `isBetterOffer`, `WATCH_POLL_SECONDS`, `WATCH_WAIT_MAX_SECONDS`, `WatermarkError`, the `BookWatermark`/`WatchBest`/`BookChanges`/`BestChange`/`BookSide`/`BookExclusion` types; `ocoGroupNonce`, `ladderRungClientRequestId`, `LADDER_ID_MAX`, `MakerOrderArgs.ocoGroup`, `MakerOrderArgs.nonce`; `premiumAmount`, `premiumFraction`, `coverMakingAmount`, `reRestExpirySeconds`, `answerOcoGroup`, `impliedPremiumWad`, `YEAR_SECONDS`, `SHARE_DECIMALS`, `RE_REST_MIN_SECONDS`, `RE_REST_MAX_SECONDS`; `INLINE_LIQUIDITY_SCHEMA`, `INLINE_IMPAIRMENT_SCHEMA`, `INLINE_TEMPLATE_SCHEMAS`, `InlineTemplateParams`, `InlineLiquidityParams`, `InlineImpairmentParams`, `inlineParamsOfTemplate`, `inlineAdditionalData`, `encodeAnchorArgs`.
- `/registry`: `decodeJitExtraData`, `diffJitExtraData`, `decodeExtraData` on `jitAdapterAbi`; `encodeImpairmentArgs`, `encodeUintWords`; the impairment entry in `RECIPE_CATALOG`; the recipe's errors on `recipeAbi`.
- `/venue`: `VenueAborted`, `VenueDeps.signal`, `normalizeRfqRow`.
- root: `approvedImplementationChecks`, `implementationRefusals`, `unapprovedCodeAllowed`; `HandlerContext.sleep`.
- `@cork/schemas`: `ORDERS_TOPIC_REFERENCE`, `OCO_GROUP_NONCE_NAMESPACE`.
- Warning registry: `oco_group_notice`, `fill_sender_unknown`, `request_aborted`, `maker_not_ready`, `contract_maker_pre_rest`.

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
