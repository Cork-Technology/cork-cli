// Doc topics — guidance that is ABOUT USING the tool surface rather than about one tool. One
// constant feeds three surfaces with zero drift by construction: (a) `cork_capabilities`
// topic:"signing" (and aliases), (b) the MCP server `instructions` string (the summary,
// verbatim), and (c) the HTTP `/docs/signing` page (the body, verbatim). The first topic exists
// because a REMOTE deployment's clients receive UNSIGNED artifacts and must learn in-band how to
// complete them: the server never signs and never holds keys [K1], and there is deliberately no
// broadcast/relay tool (a public relay would be farmed) — clients broadcast through their own
// RPC endpoint after validating the signed bytes with cork_decode kind:"tx".

export interface DocTopic {
  name: string;
  /** Alternate lookup keys (case-insensitive, like the name). */
  aliases: readonly string[];
  /** ≤5 sentences; doubles verbatim as the MCP server `instructions` core. */
  summary: string;
  /** The full markdown doc served by the topic lookup (and the HTTP /docs page). */
  body: string;
  /** Space-separated phrases users and agents actually say — the search index for this topic. */
  searchText: string;
}

export const SIGNING_TOPIC_REFERENCE = 'cork_capabilities topic:"signing"' as const;

/** Referenced from the scale tripwires in handlers/submit.ts so a unit warning routes to the full
 *  table instead of only teaching inline (Anthropic tool-design guidance: an error message is a
 *  prompt-engineering surface — it should demonstrate the correct form, not just reject). */
export const UNITS_TOPIC_REFERENCE = 'cork_capabilities topic:"units"' as const;

/** Referenced from the reach/group teaching (private_order, allowedSender, the group key) so a
 *  refusal routes to the whole vocabulary — one term per concept — instead of re-teaching inline. */
export const ORDERS_TOPIC_REFERENCE = 'cork_capabilities topic:"orders"' as const;

/** The two-axis unit notation (precision prefix + dimension in braces, Reserve/ToB style with the
 *  Cork extensions the units topic declares) as MACHINE-READABLE values: emitted as `x-units` on
 *  every scaled schema field, valued with the SAME strings the topic table's Notation column uses,
 *  so the parity test can bind field ↔ table with string equality. Emission is an OpenAPI-style
 *  extension — generators drop unknown keys, so the unit stays MANDATORY in each description too
 *  (the extension is the diffable artifact, the prose is the guaranteed-delivery one). The two
 *  {%} wire forms (percent number vs fraction string) share a dimension and are told apart by the
 *  field's own JSON type, exactly as on the table. */
export const X_UNITS = {
  /** 1e18 = 1.0 — absolute rates (rateMin/rateMax/rate/rateOverride/swapRate). */
  wad: "D18{1}",
  /** 1e18 = 1% — the Cork fee family (`*Percentage` fields); 100x apart from wad, same shape. */
  pct18: "D18{%}",
  /** Percent-or-fraction dimension at wire precision: book premium (number, 4.1 = 4.1%) and RFQ
   *  premiums (fraction string, "0.041" = 4.1%). */
  percent: "{%}",
  /** 1e7 = +100% — the Fusion auction bump base. */
  bump7: "D7{%}",
  /** A token quantum: the token's own smallest unit; the token owns the precision. */
  qTok: "{qTok}",
  /** Premium-asset base units per one whole (1e18-quanta) cST share. */
  premiumPerShare: "{qPremiumTok/cST}",
} as const;


// ── Warning-code families — the machine-readable registry behind topic:"warnings" ─────────────
// The envelope's `warnings[].code` vocabulary is the tool surface's fastest-growing part
// (95 codes as of 2026-08-20). The registry teaches the FAMILY contract once — which envelope
// state a family rides, what a member means structurally — instead of re-documenting every code
// at every surface; per-code detail lives in each warning's own message, by design (a message is
// a prompt-engineering surface). Zero drift by construction, twice over: the warnings topic's
// table below is GENERATED from this constant, and packages/core/test/warning-registry.test.ts
// extracts every code literal the handlers emit and requires exact set-equality with this
// registry — an undocumented new code, or a dead registry entry, fails offline.

/** Which envelope state a family's codes ride: `ok` = informational on a served result;
 *  `unavailable` = the call was honestly not servable; `conflict` = the tool executed and found
 *  a disagreement (chain outranks indexer [K7]); `mixed` = the same code serves more than one
 *  state and its row says how. */
export type WarningEnvelopeClass = "ok" | "unavailable" | "conflict" | "mixed";

export interface WarningFamily {
  family: string;
  envelope: WarningEnvelopeClass;
  /** One-line family contract — what ANY member means for the caller's next move. */
  contract: string;
  codes: readonly string[];
}

export const WARNING_FAMILIES: readonly WarningFamily[] = [
  {
    family: "availability",
    envelope: "mixed",
    contract:
      "the read's backing (RPC, config, deployment) is absent or degraded — unavailable when nothing could serve (requires_rpc, unknown_deployment, no_lop), info when a fallback served (rpc_fallback, config_fetch_failed) or the chain answered with a revert (chain_read_failed: usually a pool absent on that chain)",
    codes: ["requires_rpc", "unknown_deployment", "chain_read_failed", "rpc_fallback", "config_fetch_failed", "no_lop"],
  },
  {
    family: "gates",
    envelope: "unavailable",
    contract:
      "a deliberate gate refused the call before anything ran — a backend not wired (needs_indexer, needs_service, hypersync_unavailable), a phase or mode boundary (phase_gated, mode_unavailable), a missing required filter, or the deprecation gate; deprecated/deprecation_notice are the two INFO siblings that ride ok results when a legacy path DID run or sugar was translated",
    codes: ["needs_indexer", "needs_service", "phase_gated", "mode_unavailable", "hypersync_unavailable", "missing_filter", "deprecated_gated", "deprecated", "deprecation_notice"],
  },
  {
    family: "scan honesty",
    envelope: "ok",
    contract:
      "an event/log traversal served PARTIAL or fallback-grade evidence and says so precisely — never treat absence in a partial scan as absence in the world (pagination_incomplete escalates to conflict only on a self-contradicting venue cursor)",
    codes: ["logs_unavailable", "logs_range_limited", "logs_windowed_fallback", "live_tail_merged", "live_tail_unavailable", "pagination_incomplete", "verification_budget"],
  },
  {
    family: "venue transport",
    envelope: "mixed",
    contract:
      "the venue's own answer, classified: 4xx = venue_rejected (unavailable, do not retry unchanged), 5xx/unreachable = venue_unreachable (unavailable, retry same clientRequestId), 429 = venue_rate_limited, same-id-different-payload 409 = venue_conflict (conflict), in-band notices relayed verbatim as venue_notice / venue_deprecated_path (info); venue_reported and invalid_service_response mark venue-sourced data this tool could not independently verify or parse",
    codes: ["venue_rejected", "venue_unreachable", "venue_rate_limited", "venue_conflict", "venue_notice", "venue_deprecated_path", "venue_reported", "invalid_service_response"],
  },
  {
    family: "verification mismatch",
    envelope: "conflict",
    contract:
      "a local recomputation disagreed with a supplied or venue-claimed value [K3/K7] — the payload was NOT relayed / the row was not trusted; the code names WHICH verification failed so callers can branch (two also ride ok as INFO on an orderbook read: order_hash_mismatch counts rows dropped for not hashing to their own claimed orderHash, listing_traits_mismatch counts rows whose venue allowedSender echo contradicted the signed makerTraits — the served value is the local decode)",
    codes: [
      "artifact_digest_mismatch", "intent_hash_mismatch", "venue_digest_mismatch", "order_hash_mismatch",
      "marketid_mismatch", "create2_mismatch", "chainid_mismatch", "status_mismatch", "extension_salt_mismatch",
      "signature_or_reconstruction_mismatch", "prepared_context_mismatch", "listing_traits_mismatch",
      "band_parity_mismatch", "adapter_binding_mismatch", "premium_scale_mismatch", "target_mismatch",
    ],
  },
  {
    family: "honest absence",
    envelope: "mixed",
    contract:
      "the thing asked about does not exist where authority was consulted — a NORMAL outcome, not an error (order_not_found also rides ok as info when track's chain sweep reconstructs a venue-archived digest; unknown_target is decode's do-not-broadcast-unidentified caution)",
    codes: ["order_not_found", "receipt_not_found", "rfq_not_found", "pool_not_found", "asset_not_found", "recipe_not_found", "denomination_not_found", "feed_not_found", "unknown_target", "unknown_topic"],
  },
  {
    family: "domain terms",
    envelope: "unavailable",
    contract:
      "well-formed input breaking a domain rule the venue or chain would also reject — refused locally with the same complaint (exit 3, never exit 2); private_order is taker-fill's exclusivity refusal (the signed allowed-sender suffix is not this fill's sender — the LOP would revert PrivateOrder); settler_not_recognized and citation_unresolved are the two INFO siblings that relay with a caution instead",
    codes: ["invalid_order_terms", "invalid_pair", "invalid_state", "settler_mode_mismatch", "settler_retired", "settler_not_recognized", "quote_ref_unverifiable", "citation_unresolved", "recipe_refused", "unsafe_shared_balance", "private_order"],
  },
  {
    family: "jit & prediction",
    envelope: "ok",
    contract:
      "build-and-warn guards on predicted identity (pool id, oracle, shares, roles): the artifact IS returned; a member says which prediction is unverified, would revert at fill time, or needs re-signing — implementation_not_approved escalates the same posture to trusted-role code drift",
    codes: [
      "jit_market_notice", "jit_pool_mismatch", "jit_side_mismatch", "oracle_already_deployed", "pool_already_exists",
      "oracle_not_deployable", "oracle_not_deployed", "oracle_rate_unreadable", "stale_share_prediction", "share_prediction_unavailable",
      "rate_drift_notice", "constraint_window_notice", "oco_group_notice", "contract_maker_pre_rest", "expiry_far_future", "roles_not_granted", "implementation_not_approved",
    ],
  },
  {
    family: "bundle guards",
    envelope: "ok",
    contract:
      "prepare pre-flight findings on live pool/account state: the bundle IS returned, labelled (paused, expired, not whitelisted, sweep-back accounting, why funding legs were omitted) — degrading to silence when a view is unavailable",
    codes: ["pool_expired", "pool_paused", "not_whitelisted", "sweep_back", "funding_needs_rpc", "manual_funding", "owner_managed_funding"],
  },
  {
    family: "artifact life",
    envelope: "ok",
    contract:
      "what the served artifact IS and what must happen next: unsigned bytes to simulate+sign, a caller-signed artifact verified not created, a ForSelf allowance matrix, a decaying price, a confirmed-missing approval with its unsigned grant, a simulate verdict (would_revert), or a defaulted/ignored input the caller should know about",
    codes: ["unsigned_artifact", "caller_signed_artifact", "for_self_artifact", "would_revert", "decaying_price_notice", "approval_missing", "makingamount_exceeds_order", "chainid_defaulted", "reserved_field_ignored", "premium_scale_suspect", "target_unverified"],
  },
] as const;

export const DOC_TOPICS: Record<string, DocTopic> = {
  signing: {
    name: "signing",
    aliases: ["execute", "broadcast", "sign-and-broadcast"],
    summary:
      "Every cork_prepare_* result is UNSIGNED — this server never signs and never holds keys. Sign artifacts client-side with your own wallet: unsigned Ethereum transactions via eth_signTransaction, EIP-712 typed-data via eth_signTypedData_v4. Broadcast on-chain transactions yourself through your own RPC endpoint (chainlist.org lists free public ones per chain) — there is no server-side broadcast tool, by design. cork_submit only relays venue payloads you already signed. Call cork_capabilities topic:\"signing\" for the exact per-artifact completion path.",
    body: `# Signing and executing prepared artifacts

Every \`cork_prepare_*\` result is **UNSIGNED**. This server never signs, never holds keys, and
never broadcasts on-chain transactions [K1]. Each prepare result carries a \`data.execution\`
block naming its exact completion path; the two artifact families are:

## Family A — unsigned Ethereum transactions

Producers: \`cork_prepare_phoenix\` (Bundler3 bundles and the authority-onboard/revoke approve
txs), \`cork_prepare_market\` (both actions), \`cork_prepare_orders\` taker-fill and cancel.
The result carries \`{to, data|calldata|multicall, value, chainId}\`.

1. **Simulate first** — \`cork_track\` mode:"simulate" dry-runs the frozen bytes and answers
   \`wouldRevert\` (with the revert reason) BEFORE anyone signs. Simulate-first is the norm, not
   optional.
2. **Sign client-side** with any wallet that speaks \`eth_signTransaction\` — cast, viem, ethers,
   a Safe, Fireblocks. The server plays no part in this step.
3. **Validate the SIGNED bytes** with \`cork_decode kind:"tx"\` before anything leaves your
   machine: confirm the recovered signer is your account, \`to\` is the contract you expect (the
   decode names known Cork deployment addresses and warns plainly on unknown targets), the
   chainId matches, and the inner leg \`summary\` reads as the action you intended.
4. **Broadcast through your own RPC endpoint** — construct the raw JSON-RPC call yourself:

   \`\`\`
   POST https://<your-rpc-endpoint>
   {"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x<signed bytes>"]}
   \`\`\`

   The result is the transaction hash. Endpoint selection: chainlist.org lists free public
   endpoints per chainId; run an \`eth_chainId\` sanity check first (the same discipline this
   server's own resolver applies — wrong-chain endpoints are refused). Re-submitting identical
   signed bytes to a second endpoint is safe (same hash, same tx). Public endpoints are
   best-effort — prefer your own node for anything latency- or reliability-sensitive.
5. **Reconcile** with \`cork_track\` subject kind:"txHash" — \`receipt_not_found\` is a normal
   pending outcome, not a failure.

## Family B — EIP-712 typed-data

Producers: \`cork_prepare_orders\` maker-order (1inch LOP v4 domain) and rollover-intent
(CorkSettler domain). The result carries the full \`typedData\` (domain/types/primaryType/message).

- Sign with \`eth_signTypedData_v4\` over the returned domain and message, client-side.
- **Maker orders** then go through \`cork_prepare_orders\` finalize-maker-order (signature
  recovery + exact-bytes reconstruction check); its \`submitInput\` passes VERBATIM to
  \`cork_submit\` lop-order.
- **Rollover intents** go straight to \`cork_submit\` rollover-order.
- \`cork_submit\` relays only — it recomputes every commitment locally before relaying [K3] and
  never signs [K1].

## Security norms

- Read the bundle \`summary\` (prepare results and \`cork_decode\`) before signing — it is the
  plain-English statement of what the bytes do, leg by leg.
- Allowance prerequisites: every LOP-order prepare result (maker-order, finalize-maker-order,
  taker-fill) carries \`data.approvals\` — one entry per required grant with holder, token,
  spender, stage, and the UNSIGNED approve tx payload [K1]; entries confirmed missing on-chain
  raise \`approval_missing\`. The lifecycle in one line: the MAKER's grants (maker asset → the
  LOP; or, with Permit2 sourcing, BOTH layers: token → Permit2 AND the Permit2 internal
  allowance → the LOP with a live expiration) must exist BEFORE the order rests — a resting
  order without them looks fillable but reverts; the TAKER grants the taker asset → the LOP
  before broadcasting the fill. JIT orders differ: the cST side is covered by an ERC-2612
  permit embedded in the extension (EOA makers/takers only — the LOP executes NO permit for a
  CONTRACT maker, which needs a standing allowance instead), and a JIT MINT additionally pulls
  collateral into the Cork JIT adapter under its own allowance. Approval txs work identically
  from EOAs and contract wallets (a contract wallet executes the same payload through its own
  flow). \`cork_query\` resource:"account-state" shows current allowances for pool tokens;
  \`cork_prepare_phoenix\` authority-onboard builds an approve tx for any token/spender/amount.
  ForSelf-mode artifacts (\`forSelf\` on \`cork_prepare_phoenix\` / taker-fill — for
  parameter-blind session-key wallets) invert this: every allowance is granted to the
  INTEGRATOR-DEPLOYED ForSelf adapter itself, never to the LOP or pool manager, and outputs
  are structurally delivered to the calling account.
- The server reads chains through its own server-side RPC configuration; there is no per-call
  RPC override on the tool surface, and broadcasting is always client-side.`,
    searchText:
      "sign signing execute broadcast send raw transaction eth_sendRawTransaction eth_signTransaction eth_signTypedData_v4 wallet client-side signature unsigned artifact next steps complete finish submit on-chain typed data how do i execute this prepared bundle",
  },
  modes: {
    name: "modes",
    aliases: ["data-modes", "backends", "hybrid", "data-mode"],
    summary:
      "Three data modes, each a CONNECTIVITY PLEDGE about which external parties a call may contact, forming a trust ladder. hybrid (the default for list resources; renamed from 'centralized' 2026-08-13): the venue DISCOVERS rows and the chain CONFIRMS them best-effort — rows carry verification:'confirmed'|'unverified', rows the chain definitively refutes are DROPPED with a status_mismatch warning [K7], and with no RPC every row serves labeled 'unverified'. lite-decentralized (the default for chain-state resources): direct RPC point reads, YOUR RPC only, nothing else contacted. full-decentralized: chain event ENUMERATION over HyperSync (needs ENVIO_API_TOKEN), never the venue — the only mode that can make completeness/absence claims. Omit mode to get each resource's natural backend; hints prove presence, never absence.",
    body: `# Data modes — the side-by-side

A mode name is a CONNECTIVITY PLEDGE: it states which external parties the call may contact.
Merges may add trust inside a pledge; they never add parties to one. That is why verification
merged INTO the venue mode (strictly more trust for its users) and why lite-decentralized will
never gain a venue call (its users chose it for the venue's absence).

| | hybrid (default for lists) | lite-decentralized | full-decentralized |
|---|---|---|---|
| Question shape | enumeration: "what exists / what happened?" | point state: "what is X, which I can name?" | enumeration WITHOUT the venue (audit, absence claims) |
| Discovery | the venue (api-phoenix) | none — caller names the identifier | chain events (HyperSync archive + live RPC tail) |
| Truth | chain point-reads confirm each consequential row | the chain directly | the chain directly |
| Parties contacted | venue + your RPC | your RPC only | your RPC + HyperSync, never the venue |
| Needs | nothing (committed default RPCs) | nothing | ENVIO_HYPERSYNC_TOKEN (or ENVIO_API_TOKEN) |
| Venue down | lists unavailable | unaffected | unaffected |
| RPC down | venue rows serve, every one labeled verification:'unverified' | unavailable | HyperSync backfill only (no live tail) |
| Can claim absence? | NO — hints prove presence, never absence | n/a | YES (complete scans; partial scans disclose pagination_incomplete) |

## hybrid's per-resource verification matrix

Every verification leg calls the SAME chain-read code lite-decentralized serves — one
implementation, two consumers. The split rule: a row the chain DEFINITIVELY refutes is DROPPED
(counted in data.verification.dropped + a status_mismatch warning); an INDETERMINATE row
(transport failure, page beyond the verification budget, unparseable row, vocabulary neither
side knows) is KEPT, labeled verification:'unverified'.

- orderbook — each row's order is re-hashed locally [K3] and its 1inch invalidator read: a
  filled-or-cancelled order is dropped (the venue has listed dead rows before — observed live
  2026-08-06); a row that does not hash to its own claimed orderHash is dropped.
- cork-pools — market(poolId) across EVERY configured pool-manager generation: a pool no PM
  knows is dropped.
- trading-pairs — NEVER dropped: the venue is the authority on what is LISTED, and a JIT order
  legitimately lists a pair whose pool is created at fill time; chain existence rides as an
  exists annotation instead.
- fills — the OrderFilled log is confirmed at the row's claimed block (clustered getLogs, a few
  bounded range reads per page): a missing log drops the row.
- rollover-orders kind=orders — the settler's own orderStatus view arbitrates the claimed
  lifecycle; a contradiction drops the row; unknown status vocabulary (either side) is
  indeterminate, kept as 'unverified'.
- rfqs (and rollover fills/contracts rows) — no per-row on-chain footprint here: rows serve
  venue-claimed with a note; reconcile a specific rollover digest with cork_track.

Budget: pages up to 50 rows verify fully; larger pages verify the newest 50 and label the rest
'unverified' with a verification_budget warning — lower pageSize for full coverage.

## Choosing

Default (omit mode): state resources answer over your RPC alone; list resources answer hybrid.
Reach for lite-decentralized as an explicit RPC-only pledge; reach for full-decentralized when
you must NOT trust the venue's selection of rows (auditing what it omitted) or need absence
claims. When indexer and chain disagree, chain wins — everywhere [K7].`,
    searchText:
      "data mode modes backend backends hybrid centralized lite-decentralized full-decentralized venue verified verification trust pledge which mode should i use rpc only hypersync envio token offline degradation unverified confirmed dropped rows chain outranks venue absence completeness",
  },
  units: {
    name: "units",
    aliases: ["scales", "decimals", "wad", "fixed-point"],
    summary:
      "Ten scale conventions meet on this surface and only some are WAD, because the unit belongs to whoever owns the value: a token owns its decimals (amounts are NEVER rescaled), a deployed contract owns its fixed-point base (Cork fee fields are 1e18 = 1%, not 1.0), the venue owns its wire format (premiums are fraction strings like \"0.041\" on the RFQ and, since cork-api 0.3.3, the book's premiumAnnualized; the book's legacy percent-number `premium` was removed 2026-08-17), and 1inch owns the Fusion bases (rate bump 1e7, fees 1e5, discounts 1e2, gasPriceEstimate 1000-per-gwei). Every scaled field states its own scale in its schema description — read the label, never assume 18 decimals; money and rate OUTPUTS additionally carry a `scales` block plus the pair's collateralDecimals/referenceDecimals. Three collisions cause most real mistakes: 1e18 = 1.0 and 1e18 = 1% are identically shaped, `premium` means four different things across the book/RFQ/rollover/auction surfaces, and rateMin/rateMax are absolute rates under the 2.1.0 model but percentage bands on the gated legacy path. Compare and convert in exact integer arithmetic over the decimal strings — never floats — for your OWN conversions; guards that predict a venue verdict instead replicate the venue's own arithmetic exactly. Call cork_capabilities topic:\"units\" for the full table with a worked exemplar per scale.",
    body: `# Numeric units and scales

Ten scale conventions live on this surface — the table below is exhaustive. (The footgun audit
counted eight: it excluded the token-decimals baseline and the per-share hybrid, which this table
includes.) Every row's scale is inherited from whoever owns the value — Cork's own deployed
contracts included; this tool surface mints no scale of its own. The operating rule has two
halves:

**WAD (1e18 = 1.0) is mandatory for fields Cork mints, and forbidden for fields Cork mirrors.**
A token owns its decimals, a deployed contract owns its fixed-point base, the venue owns its wire
format. Rescaling a mirrored value inserts a conversion where the unit was already derivable — and
once two hops both convert, nothing downstream can tell which hop was wrong.

## Notation

Scales are written on two axes, in the style of the Reserve Protocol / Trail of Bits dimensional
convention: a precision prefix (\`D18\`) plus a dimension in braces (\`{1}\` dimensionless,
\`{qTok}\` a token quantum — the smallest indivisible unit). Two pieces are CORK EXTENSIONS of
that style, not part of the published convention: \`{%}\` as a dimension, and precision prefixes
beyond D18/D27 (\`D7\`, \`D5\`, \`D3\`, \`D2\`). \`D18{%}\` could equally be written \`D20{1}\` —
treating percent as a dimension is a deliberate choice, made so the field-name rule
(\`*Percentage\` ⇒ \`{%}\`) stays visible in the notation. The two axes matter because the
surface's worst collision is two fields at the SAME precision with DIFFERENT dimensions:
\`rateMax\` is \`D18{1}\` and \`swapFeePercentage\` is \`D18{%}\`, a hundredfold apart.

## What 5% looks like in every scale that could hold it

Each row gives the two-axis notation AND the plain form used in the field's own schema description —
they are the same claim, so a field description and this table can be checked against each other
(and are, by a parity test).

| Notation | Schema description says | 5% is written | Fields | Unit owner |
|---|---|---|---|---|
| \`D18{1}\` (WAD) | 1e18 = 1.0 | \`50000000000000000\` | rateMin, rateMax, rateChangePerDayMax, rateChangeCapacityMax (the four constraint values a JIT order carries and signs), rate, rateOverride, swapRate, worstRate | Cork contracts (MarketRegistry + recipes) |
| \`D18{%}\` | 1e18 = 1% | \`5000000000000000000\` | swapFeePercentage, unwindSwapFeePercentage (cap 5e18 = 5%), recipe constants named \`*_PERCENTAGE\` | Cork contracts (pool manager + recipes) |
| \`{%}\` percent number | PERCENT number, not a fraction | \`5\` (JSON number, 0..1000) | \`premium\` on the orderbook listing (cork_submit lop-order and the finalize listing block) — REMOVED by the venue 2026-08-17; the field survives in this tool's schema only to refuse with teaching. Its successor is the fraction-string premiumAnnualized in the next row | cork-api ≤0.3.14 (the legacy book scale) |
| \`{%}\` fraction string | fraction STRINGS | \`"0.05"\` | RFQ answer \`options[].premium_annualized\`, the counter's premiumAnnualized — AND, since cork-api 0.3.3, the BOOK listing's premiumAnnualized (same name, same convention, per-surface bounds: RFQ pattern \`^(0\|0\\.[0-9]{1,18})$\` with the < 0.5 cap; book pattern \`^\\d{1,3}(\\.\\d{1,18})?$\` with a ≤ 100 cap mirroring the legacy 10000% ceiling — the patterns are structure, both caps are relaxable POLICY) | the venue — scale SCHEMA-GATED at write on every surface; quote ECONOMICS stored verbatim. PINNED forever by R13 — a WAD variant would be a NEW field name |
| \`D7{%}\` | base 1e7 = +100% | \`500000\` | initialRateBump, points[].rateBump — the decaying auction curve | 1inch Fusion v3.1 (signed into the extension bytes) |
| \`D5{%}\` | 1e5 base | \`5000\` | integratorFee, resolverFee (uint16, decoded from Fusion extraData) | 1inch Fusion FeeTaker |
| \`D2{%}\` | 1e2 base | \`5\` | whitelistDiscountNumerator, surplusFeePercent (uint8) | 1inch Fusion FeeTaker |
| \`D3{gwei}\` | 1000 = 1 gwei | \`5000\` = 5 gwei | gasPriceEstimate (uint32, auction gas-bump term — a DECODE OUTPUT, not an input) | 1inch Fusion auction extraData |
| \`{qTok}\` token quantum | the token's own smallest unit (base units) | \`2500000000000000000\` = 2.5 @18dp; \`1000000000\` = 1000 USDC @6dp | every amount: makingAmount, collateralAssetsIn, orderSize, every min*/max* bound | the token itself, via \`decimals()\` |
| \`{qPremiumTok/cST}\` | base units of the premium asset per 1e18 share | \`12000000000000000\` = 0.012/share @18dp; \`12000\` @6dp | minPremiumPerShare — premium-asset base units per one WHOLE (1e18-quanta) cST share; no D-prefix: the 1e18 in the formula is the share's own decimals, not a fixed-point scaling of the ratio | Cork rollover contract (\`floor = shares * value / 1e18\`) |

## The three collisions

**1 — eighteen zeros, two meanings.** \`rateMax = 1.0\` and \`swapFeePercentage = 1%\` are both
\`1000000000000000000\`. Nothing in the digits resolves this; only the field name does. The rule:
any field whose name ends \`Percentage\`, and any recipe constant ending \`_PERCENTAGE\`, is the
\`D18{%}\` family — everything else documented "1e18 = 1.0" is \`D18{1}\`.

**2 — \`premium\` means four different things.** Book listing \`4.1\` (percent number — REMOVED
by the venue 2026-08-17; the schema field survives only to refuse with teaching) · RFQ option
\`"0.041"\` (fraction string) · rollover \`minPremiumPerShare\` \`12000000000000000\` (base units
per 1e18 share) · auction \`initialRateBump\` \`500000\` (1e7 above the signed floor). Confirm
which surface you are on before writing the number. The book and the RFQ have CONVERGED: the
book's field \`premiumAnnualized\` shares the RFQ's name and fraction convention — the R13
mechanism working as designed, a new unit arriving as a new name — and with the percent field
gone the live collision is down to three.

**3 — rateMin/rateMax across generations.** Under the 2.1.0 model these four constraint values are
ABSOLUTE rates at \`D18{1}\`. On the pre-2.1.0 path the same names carried PERCENTAGE bands. The
legacy path is gated (\`legacy: true\` plus CORK_ENABLE_DEPRECATED=1) and every result is labelled,
but the hazard is that the old generation still ANSWERS: 2.1.0-shaped calls against it decode into
plausible nonsense rather than failing.

## Converting safely

- **Strings on the wire, integers in the math — with one deliberate exception.** Your OWN
  conversions and economics use exact integer arithmetic over the decimal strings; floats have
  already cost this surface one guard (an exactly-100x divergence slipped through because
  \`410 / (0.041 * 100)\` evaluates to \`99.99999999999999\`). But a guard whose job is to PREDICT a
  venue's verdict replicates the venue's own arithmetic exactly — the premium acceptance band runs
  the venue's \`Number.parseFloat\` contract, float and all, because a predictor more exact than
  the thing it predicts gives wrong predictions. Each side of a boundary uses the arithmetic of
  the contract it enforces.
- **Mind the silent laundering window.** Between 2^53 and 1e21 a JSON *number* parses to a rounded
  float that still stringifies without an exponent, so a corrupted value looks pristine downstream.
  That window covers roughly 0.01 to 1000 tokens at 18 decimals — most real trades.
- **The field name IS the convention marker (versioning rule R13).** A field's unit never changes
  in place — a new unit means a NEW field name. So a name, once learned, holds for every record
  that will ever exist under it (\`premium_annualized\` is a fraction-string in the first record
  and the last), and history reads never need per-record convention stamps. Corollary: when a
  bound moves (the RFQ < 0.5 cap is pilot POLICY, not structure), the shape and name stay put.
- **Never rescale an amount.** A raw base-unit integer passes through verbatim; convert human input
  by the token's own decimals and keep the whole-number part.
- **Read the output labels.** cst-swap-rate, unwind-rate, impairment-floor, the cork-pool and
  account-state reads, and track marketRef all return a \`scales\` block (the chain-pair reads also
  carry the pair's decimals); decoded JIT/Fusion order labels and dutch-auction-price label their
  raw fields too, and registry-oracle/derive report \`oracle.rateScale\` beside the rate. Do not
  assume 18.
- **Timestamps are absolute unix SECONDS**, bounded to year 2100 — a millisecond value
  (\`Date.now()\`) is rejected with teaching rather than accepted as an immortal deadline.`,
    searchText:
      "units unit scale scales scaling decimals decimal precision wad 1e18 fixed point ray percent percentage fraction basis points bps what scale is this field is this wad how many decimals do i multiply by 1e18 premium percent or fraction rate bump base 1e7 token amount base units smallest unit convert amount 18 decimals usdc 6 decimals off by 100 scale mismatch",
  },
  orders: {
    name: "orders",
    aliases: ["order-lifecycle", "reservation", "oco", "one-cancels-the-other", "ladder", "liveness", "exclusivity"],
    summary:
      "One vocabulary for a 1inch LOP v4 order across this surface, the venue, and the kernel, read from the SIGNED order rather than venue metadata. Reach: open, or reserved for one FILL SENDER via allowedSender (the low 80 bits of the address that CALLS the LOP — the ForSelf adapter, not the account, on a wrapper fill; any other caller reverts PrivateOrder()). Fill regime: every Cork order is single-fill on the 1inch BIT invalidator keyed on (maker, nonce), so the first fill of any size spends the whole order, and partial-fill orders still spend the bit. Group: orders sharing one nonce are one-cancels-the-other (a ladder is a group whose rungs differ in price, reach, or expiry); a rung whose sibling filled is dead-by-sibling, which the chain knows and the venue does not, so a rung is re-read from the invalidator before it is filled, and any view that ranks orders must do the same. Price shape is fixed or decaying (auction), provenance is cited (quoteRef) or uncited, and a quote is firm only when a live cited order backs it. Call cork_capabilities topic:\"orders\" for the entity, liveness, and synonym tables.",
    body: `# Orders — reach, fill regime, groups, price shape, provenance, liveness

One vocabulary for a 1inch LOP v4 order as this surface, the venue, and the kernel use it. One term
per concept; the synonyms table at the end maps every other word you will meet onto it. Everything
below is read from the SIGNED order (makerTraits, extension, amounts), never from venue metadata —
the venue discovers rows, the signature and the chain decide what they mean [K3, K7]. This page is the VOCABULARY; the tool that builds and fills orders is documented at topic:\"prepare order\".

## The entities, in the order they happen

| term | what it is | where it lives |
|---|---|---|
| **request** (RFQ) | a hedger asks for cover: pair, notional, expiry window, validity | venue (\`cork_query rfqs\`) |
| **answer** | an underwriter's reply on a request: quoted options, or a pass with a reason code | venue |
| **quote** | one priced option inside an answer; a price, not a commitment | venue |
| **counter** | the requester's non-committal bid on the request; an **echo** is a counter at exactly a quoted price naming that option (a kernel convention, not a venue rule) | venue |
| **order** | a signed 1inch LOP v4 maker order: the only authenticated statement of price on this surface | signed bytes; listed by the venue book |
| **offer** | an order somebody can actually buy: a live order, or a quote a live order cites. A quote with no live order behind it is a price nobody can buy | derived |
| **fill** | an on-chain execution of an order by a taker | chain (\`cork_query fills\`) |

## Reach: open or reserved

An order is **open** (any taker) or **reserved** (one taker).
Reservation is \`allowedSender\`: the LOW 80 BITS — the last 10 bytes — of one address, packed into makerTraits; at fill time the LOP compares those bits with \`msg.sender\` and reverts \`PrivateOrder()\` on any other caller.
So the value names the **fill sender** — the address that CALLS the LOP — never the beneficiary: the
taker's own account on a raw fill, but the ForSelf ADAPTER when the taker fills through one (the
adapter is the LOP's caller there). A reservation for an account that fills through an adapter locks
that account out. Book rows carry \`exclusivity\`, classified against \`filters.account\` as the fill
sender: \`open\`, \`reserved\` (no account given), \`reserved-for-account\`, \`reserved-for-other\`. A
\`taker-fill\` whose sender does not match refuses with \`private_order\` — bytes that can only revert
are not built.
\`cork_query orderbook\` ranks by default (\`sort\` best): fillable rows only, by unit price from the signed amounts, and a reserved-for-account row wins a price tie; rows you cannot fill ride in \`excluded\` with \`whyNotFillable\`, and \`sort\` venue restores the venue's own order.

## Fill regime: single-fill or multi-fill

1inch remembers a spent order in one of two ways, chosen per order by the maker:

- **single-fill (bit invalidator)** — the order carries a 40-bit \`nonce\`; filling or cancelling it
  flips one bit keyed on \`(maker, nonce)\`. The contract never records WHICH order spent the bit.
  The first fill of ANY size spends it: post 100, get 1 filled, and the remaining 99 are dead.
  Every Cork-built order is single-fill (\`allowMultipleFills\` is off).
- **multi-fill (remaining invalidator)** — keyed on the order hash, tracks the remaining amount,
  allows many partial fills. Not used by this surface today.

\`allowsPartialFills\` does NOT change the regime: the LOP condition is an OR, so a partial-fill, single-fill order still lives on the BIT invalidator, and one partial fill retires the remainder.

## Groups: one nonce, one-cancels-the-other

Orders by one maker that share a \`nonce\` share one bit. The first fill or cancel of any of them
retires all of them: a **group** (one-cancels-the-other). A **ladder** is a group whose rungs differ
in price, reach, or expiry: a *revision ladder* re-quotes one request at better prices on one nonce
(the taker takes the best, the rest die); an *exclusive-then-open* ladder pairs a reserved best rung
with an open worse rung. A rung that dies because a sibling filled is **dead-by-sibling**: the chain
knows, the venue does not — the row keeps reading OPEN until a status sync, so \`taker-fill\` re-reads the LOP invalidator before it builds (its liveness pre-flight), and any view that ranks or announces orders must do the same [K7].

## The underwriter's moves, as one call each (cork_prepare_orders)

- \`answer-rfq\` — answer an RFQ with a firm, reserved cover offer: the RFQ record supplies the pair, the notional, the requester and the expiry window; a cited option (\`answerId\` + \`optionId\`, YOUR own answer) or your \`premiumAnnualized\` + \`expiryTimestamp\` supplies the price; the amounts are the kernel's — takingAmount = premium × notional × tenor / 365 days in collateral units, rounded toward the maker; makingAmount = notional as 18-decimal cST; the maker side is the cST of the pool the cover creates on fill (derive-cork-pool). \`reserve\` (default true) reserves the fill for the RFQ's fill_sender, else the requester; \`ocoGroup\` defaults to 'rfq:<rfqId>', and passing ONE key across several RFQs answers them all with one capacity. The order expiry follows the venue's re-rest rule. The tool never chooses a premium.
- \`refresh-order\` — re-rest a resting order of yours before it expires: the same terms on the SAME nonce (one bit — the old order and the new one cannot both fill) with a new expiry; refused when the bit is already spent (a refresh of a dead order could never fill — post a maker-order).
- Lifting the best offer is not a sugar: \`offers\` (or the ranked \`orderbook\`) names the order, and \`taker-fill\` with that \`orderHash\` sets the cap from the signed price (the ceiling for a decaying row) — two calls, no derived cap to trust.

## Watching for a better order

The venue has no push and no \`updated_after\`, so monitoring is client-side polling with a WATERMARK. Every ranked \`orderbook\` read returns \`watermark\`: an opaque token over the live set it served (collapsed group rungs included) and the best order per side, taken for the fill sender in \`filters.account\`.
- \`since\` (the prior read's watermark) adds \`changes\`: \`appeared\` names new fillable orders whose invalidator bit read CLEAR this call, \`gone\` the orders no longer served, \`best\` per side (\`changed\`, \`died\`), and \`better\` the confirmed rows the taker would rather fill than the watermark's best. Verify before announce: a new row nobody could confirm on chain rides under \`unconfirmed\` — a set change, not an announcement.
- "Better" is a lower unit price on a SELL row (higher on a BUY row, where the maker pays), or the same price reserved for this fill sender instead of open — an order nobody can race.
- \`wait\` long-polls: re-read the book every 2 s until \`changes.changed\` or the seconds run out (max 25, under the HTTP ingress deadline); \`waited\` says how it ended. The CLI's \`ch query orderbook --watch [--interval s] [--iterations n]\` loops this, printing the first read and then only the ticks that changed.
- A watermark is per fill sender: reach and exclusion differ per sender, so a token taken for another account is refused.
Sharing a nonce is a CHOICE made through \`ocoGroup\` on maker-order (the nonce derives from the group key, namespaced so a group can never collide with a stand-alone order by accident); without one, each request derives its own nonce from its idempotency key (distinct requests, distinct bits; retries, identical bytes [K2]).
Because the rungs share one bit, cancelling ANY rung (\`cancel\`) retires the whole group; \`bitsInvalidateForOrder(makerTraits, mask)\` additionally spends other bits of the same 256-bit slot word in one transaction — a sweep across orders whose nonces share a slot, not built here.

## Series and epoch: mass cancel

A maker with many independent orders can stamp them with a \`series\` and require the maker's
current **epoch** (flag 250, \`needCheckEpochManager\`): bumping the epoch (\`increaseEpoch\`) retires
every order of that series at once. Orders retired this way are **dead-by-epoch** — like
dead-by-sibling, invisible to the venue until it re-syncs. This surface decodes \`series\`; it does
not yet prepare the bump.

## Price shape: fixed or decaying

A **fixed** order names its price once: \`takingAmount / makingAmount\`.
A **decaying** order (\`auction\` — a DECAYING-PREMIUM order in the schema's words) uses the 1inch Fusion settlement as a pure amount getter: the price starts at a
ceiling (\`initialRateBump\` above the signed \`takingAmount\`) and decays to that floor; the signed
\`takingAmount\` is the maker's WORST case, and a fill's default cap is the curve's ceiling. Rank a
decaying row at its price NOW (\`dutch-auction-price\`), and label it as moving.

## Provenance: cited or uncited

A **cited** order names the quote it executes (\`quoteRef\`: the RFQ answer option this order executes). The venue
accepts the citation from the request's requester or from the underwriter of the cited answer;
anyone else is refused. An **uncited** order stands alone. A quote is **firm** when a live cited
order backs it, **indicative** otherwise — \`cork_query offers\` lists the live orders (cited or not) and counts the indicative quotes.

## Liveness: the states an order can be in, and who knows

| state | meaning | who knows first | how this surface learns it |
|---|---|---|---|
| live | signed, unexpired, bit clear | chain | invalidator read (\`readLopInvalidator\`) |
| filled | the bit was spent by THIS order's fill | chain, then venue | fills feed + invalidator |
| cancelled | the maker spent the bit | chain, then venue | invalidator; the venue after sync |
| expired | past the makerTraits expiry | both, from the clock | the signed expiry |
| dead-by-sibling | a group sibling filled or was cancelled | chain only | invalidator; the venue row still says OPEN |
| dead-by-epoch | the maker bumped the series epoch | chain only | epoch read; the venue row still says OPEN |

The invalidator bit says only SPENT: filled, cancelled, and dead-by-sibling read the same on chain. \`cork_track reconcile\` reads the bit and the fills feed and reports \`filled-or-cancelled\` for a spent bit (with this order's fills, if any) while the venue still lists the row OPEN — that disagreement is \`status_mismatch\` (conflict), chain outranking venue [K7]. Telling cancelled from dead-by-sibling needs the sibling's own fill or cancel event.

## Synonyms — say the left column

| use this | you will also see | note |
|---|---|---|
| reserved | dedicated, private, single-taker, allowed-sender order, \`PrivateOrder\` | the board and the kernel say dedicated; 1inch says allowed sender |
| open | public, unreserved, any-taker | |
| fill sender | taker, \`msg.sender\`, caller | the beneficiary may differ (adapter fills) |
| group | OCO, OCA, one-cancels-the-other, shared nonce, bracket | the mechanism is the nonce bit |
| ladder | price ladder, quote ladder, rungs, revision ladder | a group with a purpose |
| single-fill | bit invalidator, all-or-nothing, fill-or-kill (loosely) | partial fills still spend the bit |
| decaying | auction, dutch auction, Fusion order, time-decay | the settlement is only an amount getter here |
| cited | quote-linked, executing a quote, \`quoteRef\` | |
| firm quote | quote with an order, executable quote, answer with offer | an indicative quote is the opposite |
| dead-by-sibling | invalidated, orphaned rung, stale row | invisible to the venue |
`,
    searchText:
      "reserved order dedicated order private order single taker allowed sender allowedSender who can fill this order reserve for one taker fill sender msg.sender adapter PrivateOrder one cancels the other oco oca ladder rung group shared nonce bit invalidator partial fill single fill multiple fills all or nothing epoch series mass cancel decaying price auction dutch cited quote quoteRef firm quote indicative offer resting live dead order sibling liveness expired cancelled filled order lifecycle exclusivity watch monitor poll long-poll watermark since wait better order appeared gone changes notify",
  },
  warnings: {
    name: "warnings",
    aliases: ["warning-codes", "codes", "envelope", "states"],
    summary:
      "Every result is { state, data, warnings[], provenance }: check state before trusting data. ok = use data (warnings are labels, not errors); unavailable = honestly not servable, warnings[0].code says why — do not retry unchanged; conflict = the tool executed and found a disagreement, and chain outranks indexer. The ~95 warning codes are branchable contracts grouped into ten families; per-code detail lives in each warning's own message.",
    body: `# The envelope and its warning families

Every tool returns \`{ state, data, warnings[], provenance, schemaVersion }\`. **Check \`state\`
before trusting \`data\`:** \`ok\` = use data, and any warnings are LABELS on a served result;
\`unavailable\` = honestly not servable (do not retry the same call unchanged — \`warnings[0].code\`
says why); \`conflict\` = the tool executed and found a disagreement — surface it, never paper
over it, chain outranks indexer [K7].

\`warnings[].code\` is a BRANCHABLE CONTRACT: codes are stable identifiers, messages are teaching
prose. Branch on the code; read the message for the fix (each message names concrete values and
the corrected form — per-code documentation lives THERE, not in this table).

| family | rides on | any member means |
|---|---|---|
${WARNING_FAMILIES.map((f) => `| ${f.family} | ${f.envelope} | ${f.contract} — codes: ${f.codes.map((c) => `\`${c}\``).join(", ")} |`).join("\n")}

Two codes live OUTSIDE the envelope, at the MCP error layer: \`invalid_input\` (schema-invalid
call — the teaching names the path, the expected shape, and a corrected example that itself
validates) and \`internal_error\` (unexpected exception). On the CLI these are exit 2 and exit 1;
envelope states map to exit 0 (ok), 3 (unavailable), 4 (conflict).

The registry behind this table is a single constant (\`WARNING_FAMILIES\`, packages/schemas);
this table is generated from it, and a test extracts every code the handlers emit and requires
exact set-equality — an undocumented code, or a documented-but-never-emitted one, fails offline.`,
    searchText:
      "warning warnings code codes envelope state states ok unavailable conflict error handling branch on warning code what does this warning mean retry do not retry mismatch not found gated info label exit code families",
  },
};

/** Resolve a doc topic by name or alias, case-insensitively. */
export function findDocTopic(key: string): DocTopic | undefined {
  const k = key.toLowerCase();
  return Object.values(DOC_TOPICS).find((t) => t.name === k || t.aliases.some((a) => a.toLowerCase() === k));
}

// ── data.execution block — the per-result pointer every prepare result carries ──────────────
// Typed once here (an output convention, like `summary`) so the three emitting handlers cannot
// drift: the block names the artifact family, the client-side signing method, and the ordered
// next steps with exact tool names.

export interface ExecutionBlock {
  kind: "eth-transaction" | "eip712-typed-data";
  sign: "eth_signTransaction" | "eth_signTypedData_v4";
  /** Ordered next steps naming exact tools. */
  then: string[];
  reference: typeof SIGNING_TOPIC_REFERENCE;
}

/** Family A: an unsigned Ethereum transaction (bundle, approve, deploy, fill, cancel). */
export function executionEthTransaction(): ExecutionBlock {
  return {
    kind: "eth-transaction",
    sign: "eth_signTransaction",
    then: [
      "cork_track simulate (wouldRevert before signing)",
      "sign client-side with your own wallet",
      "cork_decode kind:'tx' (validate the signed bytes: signer, to, chainId, legs)",
      "eth_sendRawTransaction via your own RPC endpoint (chainlist.org lists public ones)",
      "cork_track txHash (reconcile; receipt_not_found = still pending)",
    ],
    reference: SIGNING_TOPIC_REFERENCE,
  };
}

/** Family B: EIP-712 typed-data. `then` differs per artifact (maker-order vs rollover-intent). */
export function executionTypedData(then: string[]): ExecutionBlock {
  return { kind: "eip712-typed-data", sign: "eth_signTypedData_v4", then, reference: SIGNING_TOPIC_REFERENCE };
}

/** Family B, maker-order path. */
export function executionMakerOrder(): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, LOP v4 domain)",
    "cork_prepare_orders finalize-maker-order (recovers + verifies the signature)",
    "cork_submit lop-order (pass submitInput verbatim)",
  ]);
}

/** Family B, answer-rfq: one maker order that executes an RFQ answer — completed like one, then re-rested. */
export function executionAnswerRfq(): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, LOP v4 domain)",
    "cork_prepare_orders finalize-maker-order (recovers + verifies the signature; the listing carries quoteRef when the answer cites an option)",
    "cork_submit lop-order (pass submitInput verbatim — the venue cross-checks premiumAnnualized against the cited option)",
    "before the order expires, re-rest it with cork_prepare_orders refresh-order (same terms, same bit, new expiry) until it is lifted or the RFQ lapses",
  ]);
}

/** Family B, refresh-order: the re-rested order is completed like the one it replaces. */
export function executionRefreshOrder(): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, LOP v4 domain)",
    "cork_prepare_orders finalize-maker-order (the listing carries the SAME nonce as the order it refreshes)",
    "cork_submit lop-order (pass submitInput verbatim); the old row may keep reading OPEN at the venue — it shares this order's bit, so whichever fills first retires the other",
  ]);
}

/** Family B, a maker-order whose maker is a CONTRACT and whose JIT pool does not exist yet: the
 *  EOA-only ERC-2612 permit path is closed, so the pool is created and the allowances placed
 *  BEFORE the order rests (cork-periphery CorkMarketCreator, batched by the smart account). */
export function executionMakerOrderContractMaker(): ExecutionBlock {
  return executionTypedData([
    "cork_prepare_market create-pool with this order's jitMarket legs (collateral, reference, expiry, recipe, constraint) — the pool the order derives, created ahead of the fill; simulate, then execute from the maker account",
    "grant the two allowances from the maker account: the cST (predictedCorkSwapToken) → the LOP for makingAmount, and — with enableJitMint — the collateral → the JIT adapter (data.approvals holds the unsigned grants)",
    "sign the typed-data client-side (the account's EIP-1271 signing path; the fill verifies with isValidSignature)",
    "cork_prepare_orders finalize-maker-order (ERC-1271 staticcall — needs an RPC)",
    "cork_submit lop-order (pass submitInput verbatim)",
  ]);
}

/** Family B, maker-ladder: N typed-data artifacts, each completed like one maker order. */
export function executionMakerLadder(): ExecutionBlock {
  return executionTypedData([
    "sign EACH rung's typedData client-side (eth_signTypedData_v4, LOP v4 domain) — one signature per rung",
    "cork_prepare_orders finalize-maker-order per rung (its own clientRequestId; the listing carries that rung's nonce)",
    "cork_submit lop-order per rung (pass each submitInput verbatim); order of posting does not matter — grouped rungs share one bit either way",
  ]);
}

/** Family B, rollover-intent path. */
export function executionRolloverIntent(): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, CorkSettler domain)",
    "cork_submit rollover-order (relays the caller-signed order; never signs)",
  ]);
}
