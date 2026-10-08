// Doc topics — guidance that is ABOUT USING the tool surface rather than about one tool. One
// constant feeds three surfaces with zero drift by construction: (a) `cork_capabilities`
// topic:"signing" (and aliases), (b) the MCP server `instructions` string (the summary,
// verbatim), and (c) the HTTP `/docs/signing` page (the body, verbatim). The first topic exists
// because a REMOTE deployment's clients receive UNSIGNED artifacts and must learn in-band how to
// complete them: the server never signs and never holds keys, and there is deliberately no
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
 *  a disagreement (chain outranks indexer); `mixed` = the same code serves more than one
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
      "the read's backing (RPC, config, deployment) is absent or degraded — unavailable when nothing could serve (requires_rpc, unknown_deployment, no_lop; api_key_missing: an RFQ write chose auth {method:'apiKey'} and no key resolved — env var, then the profile's credential_process, then the key stored for that venue host; nothing sent) or the caller's own deadline/cancellation ended the call before the venue answered (request_aborted: nothing relayed, no venue failure recorded), info when a fallback served (rpc_fallback, config_fetch_failed) or the chain answered with a revert (chain_read_failed: usually a pool absent on that chain)",
    codes: ["requires_rpc", "unknown_deployment", "chain_read_failed", "rpc_fallback", "config_fetch_failed", "config_override_active", "config_override_invalid", "no_lop", "request_aborted", "api_key_missing"],
  },
  {
    family: "gates",
    envelope: "unavailable",
    contract:
      "a deliberate gate refused the call before anything ran — a backend not wired (needs_indexer, needs_service, hypersync_unavailable), a phase or mode boundary (phase_gated, mode_unavailable), a missing required filter, the deprecation gate, or the generation gate (generation_unknown: the `generation` label names no configured set on this chain — the message lists them; generation_read_only: the named set is kept for reads, decode and attribution only, so a prepare refuses); deprecated/deprecation_notice are the two INFO siblings that ride ok results when a legacy path DID run or sugar was translated",
    codes: ["needs_indexer", "needs_service", "phase_gated", "mode_unavailable", "hypersync_unavailable", "missing_filter", "deprecated_gated", "deprecated", "deprecation_notice", "generation_unknown", "generation_read_only"],
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
      "a local recomputation disagreed with a supplied or venue-claimed value — the payload was NOT relayed / the row was not trusted; the code names WHICH verification failed so callers can branch (two also ride ok as INFO on an orderbook read: order_hash_mismatch counts rows dropped for not hashing to their own claimed orderHash, listing_traits_mismatch counts rows whose venue allowedSender echo contradicted the signed makerTraits — the served value is the local decode)",
    codes: [
      "artifact_digest_mismatch", "intent_hash_mismatch", "venue_digest_mismatch", "order_hash_mismatch",
      "marketid_mismatch", "create2_mismatch", "chainid_mismatch", "status_mismatch", "extension_salt_mismatch",
      "signature_or_reconstruction_mismatch", "prepared_context_mismatch", "listing_traits_mismatch",
      "band_parity_mismatch", "adapter_binding_mismatch", "premium_scale_mismatch", "target_mismatch", "extra_data_layout_mismatch", "jit_market_hash_mismatch",
    ],
  },
  {
    family: "honest absence",
    envelope: "mixed",
    contract:
      "the thing asked about does not exist where authority was consulted — a NORMAL outcome, not an error (order_not_found also rides ok as info when track's chain sweep reconstructs a venue-archived digest; unknown_target is decode's do-not-broadcast-unidentified caution)",
    codes: ["order_not_found", "receipt_not_found", "rfq_not_found", "pool_not_found", "asset_not_found", "recipe_not_found", "denomination_not_found", "feed_not_found", "unknown_target", "foreign_extension_target", "unknown_topic"],
  },
  {
    family: "domain terms",
    envelope: "unavailable",
    contract:
      "well-formed input breaking a domain rule the venue or chain would also reject — refused locally with the same complaint (exit 3, never exit 2); private_order is taker-fill's exclusivity refusal (the signed allowed-sender suffix is not this fill's sender — the LOP would revert PrivateOrder); settler_not_recognized and citation_unresolved are the two INFO siblings that relay with a caution instead; fee_view_mismatch is INFO on an ok pool read of a 10-field manager whose market() tuple (the identity) and swapFee/unwindSwapFee views disagree — a chain fact to branch on, the tuple is what the result carries",
    codes: ["invalid_order_terms", "invalid_pair", "invalid_state", "settler_mode_mismatch", "settler_retired", "settler_not_recognized", "quote_ref_unverifiable", "citation_unresolved", "recipe_refused", "unsafe_shared_balance", "private_order", "fee_view_mismatch"],
  },
  {
    family: "jit & prediction",
    envelope: "ok",
    contract:
      "build-and-warn guards on predicted identity (pool id, oracle, shares, roles): the artifact IS returned; a member says which prediction is unverified, would revert at fill time, or needs re-signing — implementation_not_approved escalates the same posture to trusted-role code drift",
    codes: [
      "jit_market_notice", "jit_pool_mismatch", "jit_side_mismatch", "oracle_already_deployed", "pool_already_exists",
      "oracle_not_deployable", "oracle_not_deployed", "oracle_rate_unreadable", "stale_share_prediction", "share_prediction_unavailable",
      "rate_drift_notice", "constraint_window_notice", "oco_group_notice", "contract_maker_pre_rest", "expiry_far_future", "roles_not_granted", "implementation_not_approved", "implementation_gate_bypassed", "maker_not_ready",
      "recipe_generation_notice", "rollover_contract_exists", "premium_cap_estimated", "cover_mode_mismatch", "reference_loss_unreported", "fixed_rate_in_the_money",
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
      "what the served artifact IS and what must happen next: unsigned bytes to simulate+sign, a caller-signed artifact verified not created, a ForSelf allowance matrix, a decaying price, a confirmed-missing approval with its unsigned grant, a simulate verdict (would_revert), a slot sweep's reach (cancel_sweep_notice: which resting orders one bitsInvalidateForOrder retires, and that the venue keeps listing them until a chain read drops them), or a defaulted/ignored input the caller should know about",
    codes: ["cancel_sweep_notice", "unsigned_artifact", "caller_signed_artifact", "for_self_artifact", "would_revert", "decaying_price_notice", "approval_missing", "makingamount_exceeds_order", "chainid_defaulted", "reserved_field_ignored", "premium_scale_suspect", "target_unverified", "fill_sender_unknown", "envelope_unwrapped", "delegatecall_in_envelope"],
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
never broadcasts on-chain transactions. Each prepare result carries a \`data.execution\`
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
- \`cork_submit\` relays only — it recomputes every commitment locally before relaying and
  never signs.

## Signing from the \`ch\` CLI with a keystore

This server never signs. The \`ch\` CLI can, for a human at a terminal: \`ch wallet new|import\`
stores a key as a password-protected keystore (the standard v3 JSON format) in
\`~/.config/cork-helper-cli/keystores/\` only (\`CORK_KEYSTORE_DIR\` moves it; no other tool's
keystore folder is read). \`ch sign --account <name>\` signs a prepare result's typed data, or a
COMPLETE transaction (nonce, gas and fees filled in from your own RPC), and prints the signature;
\`ch submit rfq-open|rfq-answer|rfq-counter --account <name>\` prepares the RFQ write, signs it and
submits it in one command. Before every signature the CLI shows what will be signed and asks
yes/no; only then does it ask for the password. The password is read from the terminal only —
never from an environment variable, a file or piped input — so an agent with shell access cannot
sign. Nothing is broadcast: send a signed transaction through your own RPC as in Family A.

## Security norms

- Read the bundle \`summary\` (prepare results and \`cork_decode\`) before signing — it is the
  plain-English statement of what the bytes do, leg by leg.
- Allowance prerequisites: every LOP-order prepare result (maker-order, finalize-maker-order,
  taker-fill) carries \`data.approvals\` — one entry per required grant with holder, token,
  spender, stage, and the UNSIGNED approve tx payload; entries confirmed missing on-chain
  raise \`approval_missing\`. The lifecycle in one line: the MAKER's grants (maker asset → the
  LOP; or, with Permit2 sourcing, BOTH layers: token → Permit2 AND the Permit2 internal
  allowance → the LOP with a live expiration) must exist BEFORE the order rests — a resting
  order without them looks fillable but reverts; the TAKER grants the taker asset → the LOP
  before broadcasting the fill. JIT orders differ: the cST side is covered by an ERC-2612
  permit embedded in the extension (pass it as \`signature\` bytes; on the flat 0.3.x wire EOA
  makers/takers only, ECDSA; on the nested wire, JIT adapter 0.5.0+, a CONTRACT wallet can sign
  it too, checked with ERC-1271 — or create the pool first and place a standing allowance), and
  a JIT MINT additionally pulls collateral into the Cork JIT adapter under its own allowance. Approval txs work identically
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
      "Three data modes, each a CONNECTIVITY PLEDGE about which external parties a call may contact, forming a trust ladder. hybrid (the default for list resources; renamed from 'centralized' 2026-08-13): the venue DISCOVERS rows and the chain CONFIRMS them best-effort — rows carry verification:'confirmed'|'unverified', rows the chain definitively refutes are DROPPED with a status_mismatch warning, and with no RPC every row serves labeled 'unverified'. lite-decentralized (the default for chain-state resources): direct RPC point reads, YOUR RPC only, nothing else contacted. full-decentralized: chain event ENUMERATION over HyperSync (needs ENVIO_API_TOKEN), never the venue — the only mode that can make completeness/absence claims. Omit mode to get each resource's natural backend; hints prove presence, never absence.",
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

- orderbook — each row's order is re-hashed locally, its extension checked against the
  salt/makerTraits the way OrderLib.isValidExtension does at fill, its signature ecrecovered
  (a contract maker's is put to its own isValidSignature staticcall), and its 1inch invalidator
  read: a filled-or-cancelled order is dropped (the venue has listed dead rows before — observed
  live 2026-08-06), a row whose maker never signed it is dropped, a row whose extension bytes
  are not the ones it committed to is dropped chain-free, and a row that does not hash to its
  own claimed orderHash is dropped. \`confirmed\` = the maker signed it AND its bit is unspent;
  \`makerSignature\` says which check settled the signature (eoa-verified | erc1271-verified |
  unverified — nobody could ask a non-recovering maker).
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
claims. When indexer and chain disagree, chain wins — everywhere.`,
    searchText:
      "data mode modes backend backends hybrid centralized lite-decentralized full-decentralized venue verified verification trust pledge which mode should i use rpc only hypersync envio token offline degradation unverified confirmed dropped rows chain outranks venue absence completeness",
  },
  units: {
    name: "units",
    aliases: ["scales", "decimals", "wad", "fixed-point"],
    summary:
      "Ten scale conventions meet on this surface and only some are WAD, because the unit belongs to whoever owns the value: a token owns its decimals (amounts are NEVER rescaled), a deployed contract owns its fixed-point base (Cork fee fields are 1e18 = 1%, not 1.0), the venue owns its wire format (premiums are fraction strings like \"0.041\" on the RFQ and, since cork-api 0.3.3, the book's premiumAnnualized; the book's legacy percent-number `premium` was removed 2026-08-17), and 1inch owns the Fusion bases (rate bump 1e7, fees 1e5, discounts 1e2, gasPriceEstimate 1000-per-gwei). Every scaled field states its own scale in its schema description — read the label, never assume 18 decimals; money and rate OUTPUTS additionally carry a `scales` block plus the pair's collateralDecimals/referenceDecimals. Three collisions cause most real mistakes: 1e18 = 1.0 and 1e18 = 1% are identically shaped, `premium` means four different things across the book/RFQ/rollover/auction surfaces, and rateMin/rateMax are absolute rates under the 2.1.0 model but percentage bands on the gated legacy path. Compare and convert in exact integer arithmetic over the decimal strings — never floats — for your OWN conversions; guards that predict a venue verdict instead replicate the venue's own arithmetic exactly. Call cork_capabilities topic:\"units\" for the full table with a worked exemplar per scale.",
    body: `# Numeric units and scales

Ten scale conventions live on this surface — the table below is exhaustive, counting the
token-decimals baseline and the per-share hybrid as scales of their own. Every row's scale is
inherited from whoever owns the value — Cork's own deployed
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
| \`D18{%}\` | 1e18 = 1% | \`5000000000000000000\` | swapFeePercentage, unwindSwapFeePercentage (the bound follows the pool manager's wire: cap 5e18 = 5% inclusive on an 8-field manager; strictly below 100e18 = 100% on a 10-field manager, where the two fees are also PART OF THE POOL ID — two markets that differ only in a fee are two pools), recipe constants named \`*_PERCENTAGE\` | Cork contracts (pool manager + recipes) |
| \`{%}\` percent number | PERCENT number, not a fraction | \`5\` (JSON number, 0..1000) | \`premium\` on the orderbook listing (cork_submit lop-order and the finalize listing block) — REMOVED by the venue 2026-08-17; the field survives in this tool's schema only to refuse with teaching. Its successor is the fraction-string premiumAnnualized in the next row | cork-api ≤0.3.14 (the legacy book scale) |
| \`{%}\` fraction string | fraction STRINGS | \`"0.05"\` | RFQ answer \`options[].premium_annualized\`, the counter's premiumAnnualized — AND, since cork-api 0.3.3, the BOOK listing's premiumAnnualized (same name, same convention, per-surface bounds: RFQ pattern \`^(0\|0\\.[0-9]{1,18})$\` with the < 0.5 cap; book pattern \`^\\d{1,3}(\\.\\d{1,18})?$\` with a ≤ 100 cap mirroring the legacy 10000% ceiling — the patterns are structure, both caps are relaxable POLICY) | the venue — scale SCHEMA-GATED at write on every surface; quote ECONOMICS stored verbatim. PINNED forever by the versioning rule (a unit never changes in place) — a WAD variant would be a NEW field name |
| \`D7{%}\` | base 1e7 = +100% | \`500000\` | initialRateBump, points[].rateBump — the decaying auction curve | 1inch Fusion v3.1 (signed into the extension bytes) |
| \`D5{%}\` | 1e5 base | \`5000\` | integratorFee, resolverFee (uint16, decoded from Fusion extraData) | 1inch Fusion FeeTaker |
| \`D2{%}\` | 1e2 base | \`5\` | whitelistDiscountNumerator, surplusFeePercent (uint8) | 1inch Fusion FeeTaker |
| \`D3{gwei}\` | 1000 = 1 gwei | \`5000\` = 5 gwei | gasPriceEstimate (uint32, auction gas-bump term — a DECODE OUTPUT, not an input) | 1inch Fusion auction extraData |
| \`{qTok}\` token quantum | the token's own smallest unit (base units) | \`2500000000000000000\` = 2.5 @18dp; \`1000000000\` = 1000 USDC @6dp | every amount: makingAmount, collateralAssetsIn, orderSize, every min*/max* bound | the token itself, via \`decimals()\` |
| \`{qPremiumTok/cST}\` | base units of the premium asset per 1e18 share | \`12000000000000000\` = 0.012/share @18dp; \`12000\` @6dp | minPremiumPerShare, and a rollover RFQ's \`premium_per_share\` / counter \`premiumPerShare\` (the same number: a quote's price IS the order's floor) — premium-asset base units per one WHOLE (1e18-quanta) cST share; no D-prefix: the 1e18 in the formula is the share's own decimals, not a fixed-point scaling of the ratio | Cork rollover contract (\`floor = shares * value / 1e18\`) |

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
book's field \`premiumAnnualized\` shares the RFQ's name and fraction convention — the versioning
rule working as designed, a new unit arriving as a new name — and with the percent field
gone the live collision is down to three.

**3 — rateMin/rateMax across generations.** Under the 2.1.0 model these four constraint values are
ABSOLUTE rates at \`D18{1}\`. On the pre-2.1.0 path the same names carried PERCENTAGE bands. The
legacy path is gated (\`legacy: true\` plus CORK_ENABLE_DEPRECATED=1) and every result is labelled,
but the hazard is that the old generation still ANSWERS: 2.1.0-shaped calls against it decode into
plausible nonsense rather than failing.

**The fee bound is a wire fact, not a constant.** Both fee fields stay \`D18{%}\` on every
generation, but WHAT bounds them follows the pool manager's wire (\`cork_capabilities
topic:"generations"\`): an 8-field manager (mainnet, \`phoenix/v0.3-rc.1\`, the older Arbitrum
eras) caps each fee at 5e18 inclusive through \`MAX_FEE_PERCENTAGE\`; a 10-field manager
(\`phoenix/v0.4-rc.1\`, the primary) has NO such getter and reverts \`InvalidFees()\` at or above
100e18 — and folds both fees into the \`Market\` struct, so they are part of the pool id.
\`derive-cork-pool\` takes them as filters (default 0) for that reason; a fee that changes the
identity is a different market, not a parameter of the same one.

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
- **The field name IS the convention marker (the versioning rule).** A field's unit never changes
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
      "One vocabulary for a 1inch LOP v4 order across this surface, the venue, and trading agents, read from the SIGNED order rather than venue metadata. Reach: open, or reserved for one FILL SENDER via allowedSender (the low 80 bits of the address that CALLS the LOP — the ForSelf adapter, not the account, on a wrapper fill; any other caller reverts PrivateOrder()). Fill regime: every Cork order is single-fill on the 1inch BIT invalidator keyed on (maker, nonce), so the first fill of any size spends the whole order, and partial-fill orders still spend the bit. Group: orders sharing one nonce are one-cancels-the-other (a ladder is a group whose rungs differ in price, reach, or expiry); a rung whose sibling filled is dead-by-sibling, which the chain knows and the venue does not, so a rung is re-read from the invalidator before it is filled, and any view that ranks orders must do the same. Price shape is fixed or decaying (auction), provenance is cited (quoteRef) or uncited, and a quote is firm only when a live cited order backs it. Call cork_capabilities topic:\"orders\" for the entity, liveness, and synonym tables.",
    body: `# Orders — reach, fill regime, groups, price shape, provenance, liveness

One vocabulary for a 1inch LOP v4 order as this surface, the venue, and trading agents use it. One term
per concept; the synonyms table at the end maps every other word you will meet onto it. Everything
below is read from the SIGNED order (makerTraits, extension, amounts), never from venue metadata —
the venue discovers rows, the signature and the chain decide what they mean. This page is the VOCABULARY; the tool that builds and fills orders is documented at topic:\"prepare order\".

## The entities, in the order they happen

| term | what it is | where it lives |
|---|---|---|
| **request** (RFQ) | a hedger asks for cover: pair, notional, expiry window, validity | venue (\`cork_query rfqs\`) |
| **answer** | an underwriter's reply on a request: quoted options, or a pass with a reason code | venue |
| **quote** | one priced option inside an answer; a price, not a commitment | venue |
| **counter** | the requester's non-committal bid on the request; an **echo** is a counter at exactly a quoted price naming that option (an agent convention, not a venue rule) | venue |
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
knows, the venue does not — the row keeps reading OPEN until a status sync, so \`taker-fill\` re-reads the LOP invalidator before it builds (its liveness pre-flight), and any view that ranks or announces orders must do the same.

## The underwriter's moves, as one call each (cork_prepare_orders)

- \`answer-rfq\` — answer an RFQ with a firm, reserved cover offer: the RFQ record supplies the pair, the notional, the requester and the expiry window; your \`premiumAnnualized\` + \`expiryTimestamp\`, or an option of YOUR own earlier answer (\`answerId\` + \`optionId\`, re-quoted: the new answer supersedes it), supplies the price; the amounts follow the ACT/365 rule — takingAmount = premium × notional × tenor / 365 days in collateral units, rounded toward the maker; makingAmount = notional as 18-decimal cST; the maker side is the cST of the pool the cover creates on fill (derive-cork-pool). \`reserve\` (default true) reserves the fill for \`fillSender\` or the RFQ's declared fill_sender; when neither exists the order is OPEN and \`fill_sender_unknown\` says why (the requester account may not be the LOP caller — a reservation is never guessed); \`ocoGroup\` defaults to 'rfq:<rfqId>', and passing ONE key across several RFQs answers them all with one capacity. The order expiry follows the venue's re-rest rule. Under the venue's RFQ v2 the quote CARRIES the signed order: \`answer.quotedOption\` is the answer option built from the same numbers (fresh_until = the order's expiry), so the answer is posted first (rfq-write → cork_submit rfq-answer, which hold each option to its order and prove the order signature) and the order goes to the book after it, citing it — the venue refuses a quote whose order already rests there. The tool never chooses a premium.
- \`refresh-order\` — re-rest a resting order of yours before it expires: the same terms on the SAME nonce (one bit — the old order and the new one cannot both fill) with a new expiry; refused when the bit is already spent (a refresh of a dead order could never fill — post a maker-order).
- Lifting the best offer is not a sugar: \`offers\` (or the ranked \`orderbook\`) names the order, and \`taker-fill\` with that \`orderHash\` sets the cap from the signed price (the ceiling for a decaying row) — two calls, no derived cap to trust.

## Watching for a better order

The venue has no push and no \`updated_after\`, so monitoring is client-side polling with a WATERMARK. Every ranked \`orderbook\` read returns \`watermark\`: an opaque token over the live set it served (collapsed group rungs included) and the best order per side, taken for the fill sender in \`filters.account\`.
- \`since\` (the prior read's watermark) adds \`changes\`: \`appeared\` names new fillable orders whose invalidator bit read CLEAR this call, \`gone\` the orders no longer served, \`best\` per side (\`changed\`, \`died\`), and \`better\` the confirmed rows the taker would rather fill than the watermark's best. Verify before announce: a new row nobody could confirm on chain rides under \`unconfirmed\` — a set change, not an announcement.
- "Better" is a lower unit price on a SELL row (higher on a BUY row, where the maker pays), or the same price reserved for this fill sender instead of open — an order nobody can race.
- \`wait\` long-polls: re-read the book every 2 s until \`changes.changed\` or the seconds run out (max 25, under the HTTP ingress deadline); \`waited\` says how it ended. The CLI's \`ch query orderbook --watch [--interval s] [--iterations n]\` loops this, printing the first read and then only the ticks that changed.
- A watermark is per fill sender: reach and exclusion differ per sender, so a token taken for another account is refused.
Sharing a nonce is a CHOICE made through \`ocoGroup\` on maker-order (the nonce derives from the group key under the \`oco-group:\` namespace, a prefix no clientRequestId may carry — so a group seed and an id seed are never the same string; what remains is the 40-bit truncation any two seeds share, birthday-rare, disclosed on every maker-order); without one, each request derives its own nonce from its idempotency key (distinct requests, distinct bits; retries, identical bytes).
Because the rungs share one bit, cancelling ANY rung (\`cancel\`, scope \`order\`) retires the whole group. \`cancel\` with scope \`slot\` builds \`bitsInvalidateForOrder(makerTraits, mask)\` instead: one transaction that spends the rung's bit AND the bit of every other resting order of yours in the same 256-bit slot word (nonce >> 8), read from the venue book by maker; the result lists every order the sweep retires (\`retires.orders\`, relation \`shared-bit\` for a group sibling, \`same-slot\` for a different nonce in the word). Honest sizing: nonces here derive from keccak seeds, so two independent orders share a slot in about one pair in 2^32 — the sweep retires more than a plain cancel only when nonces were pinned to one slot (SDK \`nonce\`) or chosen by another tool, and the result says when it found no sibling. The venue does not index cancels: a swept row stays OPEN on the book until a chain read drops it.

## Series and epoch: mass cancel

A maker with many independent orders can stamp them with a \`series\` and require the maker's
current **epoch** (flag 250, \`needCheckEpochManager\`): bumping the epoch (\`increaseEpoch\`) retires
every order of that series at once. Orders retired this way are **dead-by-epoch** — like
dead-by-sibling, invisible to the venue until it re-syncs. This surface decodes \`series\` and
labels the flag on every order and cancel it decodes (the summary of a cancel names the series an
epoch bump would also retire); it does not yet prepare the bump.

## Price shape: fixed or decaying

A **fixed** order names its price once: \`takingAmount / makingAmount\`.
A **decaying** order (\`auction\` — a DECAYING-PREMIUM order in the schema's words) uses the 1inch Fusion settlement as a pure amount getter: the price starts at a
ceiling (\`initialRateBump\` above the signed \`takingAmount\`) and decays to that floor; the signed
\`takingAmount\` is the maker's WORST case, and a fill's default cap is the curve's ceiling. Rank a
decaying row at its price NOW (\`dutch-auction-price\`), and label it as moving.

## Provenance: cited or uncited

A **cited** order names the quote it executes (\`quoteRef\`: the RFQ answer option this order executes). The venue
accepts the citation from the request's requester or from the underwriter of the cited answer;
anyone else is refused. Under RFQ v2 an option CARRIES its order, so the underwriter's cited order
must be that exact order (the venue re-hashes the stored one). An **uncited** order stands alone. A quote is **firm** when a live cited
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

The invalidator bit says only SPENT: filled, cancelled, and dead-by-sibling read the same on chain. \`cork_track reconcile\` reads the bit and the fills feed and reports \`filled-or-cancelled\` for a spent bit (with this order's fills, if any) while the venue still lists the row OPEN — that disagreement is \`status_mismatch\` (conflict), chain outranking venue. Telling cancelled from dead-by-sibling needs the sibling's own fill or cancel event.

## Synonyms — say the left column

| use this | you will also see | note |
|---|---|---|
| reserved | dedicated, private, single-taker, allowed-sender order, \`PrivateOrder\` | trading agents say dedicated; 1inch says allowed sender |
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
  generations: {
    name: "generations",
    aliases: ["generation", "wires", "primary"],
    summary:
      "A chain hosts a SET of contract generations, one of them primary: a generation is the set of Cork contracts deployed to work together (a phoenix pool-manager stack, a market-registry stack, a rollover stack, a reference ForSelf adapter) plus the WIRE each block speaks — the config declares the wire, the code implements it and refuses one it does not know. A prepare targets the primary unless the optional `generation` label on every chain-backed input selects another active set; a read, prepare or compute keyed on a poolId follows the generation the POOL lives on, resolved from the chain, and every such result carries `data.generation` and `provenance.generation`. `protocol-config` lists a chain's generations with each block's addresses and wire. Call cork_capabilities topic:\"generations\" for the labels, the statuses, the resolution rules and the wire table.",
    body: `# Generations — which contracts a call talks to, and how the tool decides

Cork redeploys. A redeploy does not retire the previous contracts: their pools stay readable, their
orders keep filling, their settlers keep settling. So a chain hosts a SET of contract generations,
and the tool needs one answer to three questions — which set a PREPARE should target, which set a
POOL lives on, and which set an ADDRESS seen in bytes or logs belongs to. One record answers all
three: the generation.

## What a generation is

A generation is the set of contracts that were deployed to work together, plus the wire shapes
they speak:

- \`phoenix\` — the pool-manager stack (poolManager, constraintAdapter, corkAdapter, bundler3,
  whitelistManager, controller). Wire: \`8-field\` or \`10-field\` (the width of the \`Market\` struct).
- \`marketRegistry\` — the registry, the JIT adapter, the market creator, the recipes. Wire:
  \`legacy\` | \`flat\` | \`nested\`.
- \`rollover\` — the ERC-7683 factory and its two settlers (plus the BaseFiller). Wire: \`rc.1\` |
  \`rc.2\` | \`0.2\`.
- \`forSelf\` — the reference CorkForSelfAdapter of that set.

The config (\`cork-defaults.v2.json\`, schema 2) DECLARES each block's wire; the code IMPLEMENTS the
wires it knows and refuses a declared wire it does not (\`phase_gated\`) — it never guesses a layout
from bytes. A block can be absent (mainnet has only a phoenix block).

## Labels and statuses

Labels are the Distribution's names where one exists and the tool's own for the eras before it:

| Chain | Label | Status | Contents |
|---|---|---|---|
| 1 | \`mainnet\` (primary) | active | the original chain-1 stack (8-field) |
| 42161, 8453 | \`phoenix/v0.4-rc.1\` (**primary**) | active | phoenix 1.4.0-rc.1 (10-field), market-registry 0.5.0 (nested), rollover 0.2.0 (0.2), cork-periphery 0.2.0-rc.1 |
| 42161, 8453 | \`phoenix/v0.3-rc.1\` | active | phoenix v1.3.0-rc.1 (8-field), market-registry 0.3.3 (flat), rollover v0.1.0-rc.2 (rc.2) |
| 42161 | \`arbitrum-v1.1\` | active | the previous production stack, where the venue's existing markets live (8-field; a pre-2.1.0 registry behind the deprecation gate; the retired July 2026 rollover set, rc.1) |
| 42161 | \`arbitrum-legacy\` | read-only | the pre-launch calibration pools (8-field) |

\`active\` = readable AND preparable (name it with \`generation\` when it is not the primary).
\`read-only\` = reads, decode, attribution and classification only; a pre-expiry prepare against it
refuses \`generation_read_only\` (the post-expiry settles — withdraw, withdraw-other, redeem — still
build). The rollover block keeps its own \`retired\` date: venue admission is a rollover fact.
Identical addresses across Arbitrum and Base in every Distribution set; bundler3 is per chain.

## How a call picks a generation

1. **A prepare** targets the primary. The optional \`generation: "<label>"\` on every chain-backed
   input (query, compute, prepare_phoenix, prepare_orders, prepare_market, track) selects another
   set. An unknown label refuses \`generation_unknown\` and lists the chain's labels.
2. **Anything keyed on a poolId** — cork-pool, account-state, pool-whitelist, the three chain
   compute kinds, track marketRef, the 13 pool actions and their ForSelf twins — resolves the
   generation FROM THE CHAIN: one batched \`shares(poolId)\` read across every generation's pool
   manager; the manager that knows the pool wins. \`generation\` narrows the search to one set.
   No manager knows it: \`pool_not_found\`, naming every manager asked. A bundle for a pool on an
   older set targets THAT set's adapter, bundler and whitelist manager. The result carries
   \`data.generation\` (\`{ label, status, distribution? }\`) and \`provenance.generation\`.
3. **An address** seen in calldata, a log, or a venue row (an adapter, a settler, a factory, a pool
   manager) is classified by one function into \`{ label, status, role }\` — decode labels
   (\`jit.generation\`, \`jit.wire\`), event attribution, settler classification and the book's row
   verification all read it. Decode picks the layout from the adapter's generation FIRST and never
   trial-decodes; nested bytes at a flat adapter get no label.
4. **A rollover intent** takes its jitMarket wire from the SETTLER's generation.

\`protocol-config\` reports the selected generation and the chain's full list with every block's
addresses and wire.

## The wire table

| Wire | Block | What differs |
|---|---|---|
| \`8-field\` | phoenix | \`Market\` has 8 fields; the fees live OUTSIDE the pool id; \`MarketCreated\` has 7 arguments; each fee is capped at 5% inclusive (\`MAX_FEE_PERCENTAGE\`) |
| \`10-field\` | phoenix | the two fee percentages are INSIDE \`Market\` and therefore part of the pool id; \`MarketCreated\` has 9 arguments (a different topic); the bound is strictly below 100% (\`InvalidFees()\`); no \`MAX_FEE_PERCENTAGE\` getter |
| \`legacy\` | marketRegistry | pre-2.1.0: mode strings, the constraint derived at fill time; reachable only with \`legacy: true\` and CORK_ENABLE_DEPRECATED=1 |
| \`flat\` | marketRegistry | 0.3.x: a flat JITMarketParams with \`additionalData\`; \`verify\` takes 5 arguments; \`deploy(ca, ref, mode)\`; the JIT adapter holds the controller roles and emits \`JITMarketCreated\` |
| \`nested\` | marketRegistry | 0.5.0: \`(MarketParams market, bool enableJitMint)\` with \`extraData\` (the new name; \`additionalData\` is accepted as an alias) and \`oracleSalt\` (default zero; consumed only by a pair's FIRST oracle deploy); \`verify\` takes 7 arguments (pool expiry + a \`creating\` flag); \`deploy(ca, ref, mode, oracleSalt)\`; the CorkMarketCreator ships inside the registry package and holds the controller role; the adapter binds \`MARKET_CREATOR\`, the creator binds \`MARKET_REGISTRY\`; denominations are address units; the creator emits \`MarketCreated\` |
| \`rc.1\` | rollover | the retired July 2026 OrderData (no \`jitMarketHash\`); refuses a jitMarket |
| \`rc.2\` | rollover | \`RolloverParams.jitMarketHash\`; the JITMarketParams typehash without a salt |
| \`0.2\` | rollover | \`bytes32 oracleSalt\` after \`additionalData\` in JITMarketParams — a different typehash; OrderData and RolloverParams identical to rc.2 |

A non-zero \`oracleSalt\` against a flat, legacy or rc.2 target is refused and names the generation.
The rollover typed-data output keeps the struct's own \`additionalData\` member: the signer sees what
the contract hashes.

## Attestations and trust

\`cork_capabilities topic:"verify"\` re-derives every attested address from (deployer, salt,
initCodeHash); each attestation names the generation it binds. The \`mainnet\` and
\`phoenix/v0.3-rc.1\` sets are attested. The \`phoenix/v0.4-rc.1\` set has NO CREATE2 attestation:
the Distribution component records carry no salt, initCodeHash or deployer, and nothing is
fabricated. Its trust anchor is instead the approved-implementations allowlist — the live code
hash of every role in every generation, captured on chain and cross-checked against the
Distribution records, compiled into this build and never read from the remote config
(\`implementation_not_approved\` when the code behind an address is not on the list).

## Why the config schema changed

\`cork-defaults.json\` (schema 1) is frozen for the 0.5 line. A schema-1 file whose primary moved
would send a 0.5.x binary to a generation whose wire it does not speak — and an 8-field decode of a
10-field \`market()\` return succeeds silently with a wrong pool id. Two files, two lines; older
binaries keep the addresses they understand.`,
    searchText:
      "generation generations which contracts primary set label phoenix/v0.4-rc.1 phoenix/v0.3-rc.1 arbitrum-v1.1 wire wires 8-field 10-field flat nested legacy rc.2 0.2 which registry which adapter which pool manager is this pool on old pool older generation redeploy retired read-only active pool_not_found generation_unknown generation_read_only select generation oracleSalt extraData additionalData market creator distribution",
  },
  cover: {
    name: "cover",
    aliases: ["cover-types", "cover-kinds", "impairment", "downside", "liquidity-cover", "fixed-rate", "duration-risk", "credit-risk", "duration-risk-cover", "credit-risk-cover", "impairment-cover"],
    summary:
      "WHICH cover a cST is, is decided by the market's RECIPE — never by the RFQ `modes`, which name what a requester accepts and nothing on chain reads. Liquidity (duration-risk) cover, from the liquidity recipes, follows the oracle's rate: it is an exit, and it pays nothing for a loss in the reference. Impairment (credit-risk) cover, from the impairment recipe, holds the rate in a band around the rate at creation: a loss beyond the band, the worst-case deductible, is covered. Fixed-rate cover freezes the rate: every loss below it is covered, and it is requestable through an RFQ since venue 0.4.4 (mode `fixed_rate`). Measured on a fork with a real 10% loss in the reference: liquidity paid 0, impairment 9.83%, fixed-rate 10.00%. rfq-open returns `data.cover` with the recipe's own constraint and warns `cover_mode_mismatch` or `fixed_rate_in_the_money` when the request works against itself.",
    body: `# Which cover are you buying — the recipe decides

A Cork pool lets the cST holder swap the reference asset for collateral at the pool's RATE. What
that is worth after a loss in the reference depends on one thing: how far the pool's rate may
follow the rate oracle down. The market's RECIPE fixes that at creation, so the recipe is the
cover. The RFQ \`modes\` name the alternatives a requester accepts: the venue stores them and
nothing on chain reads them.

| Cover | Recipe (\`cork_query registry-recipes\`) | Rate behaviour | A loss in the reference | RFQ mode |
|---|---|---|---|---|
| **Liquidity (duration-risk) cover** (an exit) | the liquidity recipes: \`liquidity\` (price source), \`nav\` (nav source) | window 1 wei .. 2x the anchor, may move a whole anchor a day: the rate FOLLOWS the oracle | NOT covered: the rate falls with the reference, you hand in more reference for the same collateral | \`liquidity_only\` |
| **Impairment (credit-risk) cover** (downside, with a deductible) | \`impairment\` (ApySpreadImpairmentRecipe) | window = anchor ± apySpread × duration / 365 d; moves one day of the spread per day, seven days of it in a burst: the rate is HELD | covered beyond the part of the band the rate has given up; the whole band is the worst-case deductible | \`liquidity_impairment\` |
| **Fixed-rate cover** (downside, frozen) | \`fixed\` (FixedRateRecipe) | an immutable FixedRateOracle; window rate .. rate + 1 wei, both rate-change allowances zero: the rate never moves | covered in full below the frozen rate; later yield of the reference is not tracked | \`fixed_rate\` (venue 0.4.4) |

Names, not numbers: some Cork documents number these as modes, and the numbering is not the
same across documents. Say **liquidity (duration-risk) cover**, **impairment (credit-risk)
cover**, **fixed-rate cover**. Duration risk: you cannot sell or redeem the reference at its
book value in time. Credit risk: the reference loses value.

## Measured (Base fork, the phoenix/v0.4-rc.1 contracts, 2026-10-01)

Three pools over USDC / baseUSD with the same expiry; only the recipe differs. The fixed pool
froze the oracle's rate at creation. The reference vault takes a real 10% loss (its own
accounting, not a mocked oracle). One hour later the holder exercises 100 cST on each:

| | Reference handed in | Its value after the loss | Collateral received | Payout of the cover |
|---|---|---|---|---|
| Liquidity cover | 101.835 baseUSD | 100.000 USDC | 100.000 USDC | **0.000 USDC** |
| Impairment cover (10%/yr, 14.4 days: a 0.394% band) | 91.828 baseUSD | 90.173 USDC | 100.000 USDC | **9.827 USDC** |
| Fixed-rate cover (frozen at the rate at creation) | 91.652 baseUSD | 90.001 USDC | 100.000 USDC | **9.999 USDC** |

The band is the WORST-case deductible, not the deductible on every day. The impairment pool's
rate walks toward its floor at one day of the spread per day. One hour after the loss it had
given up only the burst capacity (0.19% of the anchor), so the payout was 9.827 and not
10 less the whole band. Wait until the rate reaches the floor and the payout is the loss less
the whole band.

## A loss the share price does not report

A pool whose recipe reads a NAV oracle swaps at the vault's REPORTED share price. So "a loss"
in the table means a loss the share price reports. Some vaults keep losses out of it.
MetaMorpho v1.1 adds realized bad debt to a \`lostAssets\` counter and reports total assets as
real assets plus that counter, so its share price never falls on bad debt. This is accrual
accounting kept apart from cash accounting: the vault records the loss and does not charge it
to its shareholders.

The counter is not the hole. It never decreases. Anyone may cover a loss by supplying assets
on behalf of \`address(1)\`: those shares cannot be redeemed, so their backing belongs to
every other holder. The open shortfall is the counter less the value of those shares, floored
at zero. On Base (2026-10-01) two registered references use this accounting. YCSUSDC records
131.38 USDC lost; its owner covered that the next day, the shares of \`address(1)\` are
worth 140.55 USDC, and the open shortfall is 0. sparkUSDC records 0.

While a shortfall is open, a NAV-read pool's rate does not move on it, in a liquidity pool and
in an impairment pool alike. The holder still swaps at the reported price while the pool has
collateral. The cPT side receives shares backed by less than that price, so the UNDERWRITER
carries the open shortfall, and no rate window prices it. In the vault itself an open
shortfall falls on the last holders to redeem: the early ones leave at the reported price. So
it shows first as a risk of a run (duration risk) and then as a loss (credit risk).

This reading applies to NAV-sourced recipes only. A price-sourced pool reads a market price and
a fixed-rate pool reads no feed. \`rfq-open\` and \`answer-rfq\` ask the recipe for its source;
for a NAV source they read \`lostAssets()\` and the shares of \`address(1)\` at one block and
warn \`reference_loss_unreported\` to the side reading the result: the message says if a
shortfall is open, covered, or absent, or if the cover could not be read. A vault whose
\`lostAssets()\` call reverts has no such view: the tool stays silent, and that vault is not
thereby proven to report every loss, because each vault family books losses its own way. Any
other failure of the read is listed as not read (\`data.cover.notRead\` on rfq-open,
\`answer.notRead\` on answer-rfq), so an outage is not mistaken for a clean vault.

## The recipe states its own rules: ask it

The limits of a recipe differ per generation. The phoenix/v0.4-rc.1 impairment recipe caps the
spread at 100% a year and the duration at the registry's 30-day pool lifetime; the
phoenix/v0.3-rc.1 one declares no such constants. This tool does not restate those limits. With
an RPC and one collateral, \`rfq-open\` makes the two calls the fill that creates the pool makes:

- \`recipe.resolve\` for the request. The answer is \`data.cover.resolved\`: the oracle and the
  four rate limits a pool created now is born with. When the recipe refuses, the warning
  \`recipe_refused\` carries the recipe's own error name, and an underwriter that derives the
  pool from the same template fails the same way.
- \`recipe.verify\` for the pool expiry the block names (it needs a deployed oracle). This is the
  call that takes the expiry. On phoenix/v0.4-rc.1 the impairment recipe answers false when
  \`duration_seconds\` exceeds the pool's remaining life, and the fill that creates the pool then
  reverts \`RecipeRejectedConstraint\` (measured on the live recipe: a duration equal to the
  remaining life passes, one hour more does not). The warning is \`would_revert\`, with that
  cause named when it applies. \`DurationTooLong\` is a different refusal: \`resolve\` raises it
  for a duration beyond the registry's pool lifetime.

A failure of the endpoint is not a refusal of the recipe. An RPC that fails, or that cannot
simulate, is listed in \`data.cover.notRead\` with the reason; so is a recipe that no configured
generation names (nothing is asked about it). The kind of cover comes from the configured recipe
hint, so it is known without an RPC.

## Ask for impairment (credit-risk) cover (\`cork_submit rfq-open\`)

1. Read the impairment recipe of the generation you trade: \`cork_query registry-recipes\`
   (hint name \`impairment\`; each recipe describes its own parameters and constants).
2. Choose the band. \`band = apySpread × duration / 365 d\`. The band is your worst-case
   deductible. \`duration\` must fit inside the pool's remaining life at the fill that creates
   the pool, with room for the time to fill: rfq-open asks \`recipe.verify\` and warns
   \`would_revert\` when it does not.
3. Open the RFQ with \`modes: ["liquidity_impairment"]\` and an inline template naming the
   impairment recipe and a \`cork-inline-impairment/1\` block: \`schema\`, \`anchor_rate\`,
   \`expiry\`, \`swap_fee_wad\`, \`unwind_swap_fee_wad\`, \`duration_seconds\`,
   \`apy_spread_percentage\` (1e18 = 1%, so 10% a year is 10000000000000000000).
4. Read \`data.cover\`: the kind, the band, and \`resolved.constraint.rateMin\`, the worst rate
   you would ever swap at (1e18 = 1.0). A deployed oracle's rate is the anchor; a carried
   \`anchor_rate\` is then ignored.
5. Read the answers (\`cork_query rfqs\` with the rfqId). A \`pass\` means no underwriter quotes
   that recipe for the pair yet: raise it with Cork. Supply is the underwriter's decision, not
   the venue's.

## Ask for fixed-rate cover (\`cork_submit rfq-open\`, venue 0.4.4)

1. Read the fixed recipe of the generation you trade (\`cork_query registry-recipes\`, hint
   name \`fixed\`) and the reference's rate today (\`cork_query registry-oracle\` for the pair).
2. Choose the frozen rate: one reference swaps for that much collateral for the pool's whole
   life (ABSOLUTE, 1e18 = 1.0). At today's rate you lock in today's value. BELOW today's rate
   the gap is your deductible. ABOVE today's rate the cover pays the gap at once, with no loss
   at all: the result warns \`fixed_rate_in_the_money\`, and an underwriter prices that gap as
   a certain payout or passes.
3. Open the RFQ with \`modes: ["fixed_rate"]\` and an INLINE template naming the fixed recipe
   and a \`cork-inline-fixed/1\` block: \`schema\`, \`rate_override\` (a decimal string, no
   leading zero), \`expiry\`, \`swap_fee_wad\`, \`unwind_swap_fee_wad\`. The venue refuses a
   fixed-rate request without a valid \`rate_override\`, and so does this tool before relay.
4. Read \`data.cover\`: \`fixed\` gives the rate, the reference's rate today, the position
   (\`below\` | \`at\` | \`above\`) and the gap; \`resolved.constraint\` is the recipe's own
   window (rate .. rate + 1 wei, zero allowances).

Know these before you ask:

- The rate is part of pool identity. Each rate has its own FixedRateOracle, so another rate is
  another pool. An answer option carries its own template and may propose another rate;
  \`answer-rfq\` then says so as a counter-proposal. A cited option brings its own rate: one
  that names no rate is refused, until the underwriter passes \`jitMarket.rateOverride\` or
  asks for your rate by name with \`useRequestedRate\`.
- The fixed recipe takes no recipe bytes. The rate rides in the order as \`rateOverride\`; the
  fill deploys the oracle if it does not exist yet.
- A fixed rate does not track the reference's yield after creation. A reference that earns 5%
  a year moves 5% a year above a rate frozen today.
- A \`rate_override\` on a liquidity or an impairment recipe is not carried: a fill with a
  non-zero rate on such a recipe reverts \`UnexpectedRateOverride\`. The venue does not check
  this; rfq-open warns.
- The venue admits uint256's maximum as a rate; the recipe HELPER overflows on it (resolve computes
  rate + 1: Panic 0x11), so the helper resolves 1 .. MAX − 1 and every resolving path — rfq-open's
  reading, derive-cork-pool, answer-rfq — refuses \`recipe_refused\` and says so. The pool itself is
  creatable: create-pool with the explicit constraint [MAX − 1, MAX] and rateOverride MAX passes the
  creator (fork-simulated 2026-10-07); [MAX, MAX] reverts InvalidParams.

## Which cover a quote delivers, and which cover a fill buys

A label is not a cover. answer-rfq reads the recipe the order's JIT block names and reports
\`answer.cover\` (kind, mode, the request's modes, \`agrees\`); a mode the request did not ask for
is \`cover_mode_mismatch\` (info — the option still builds). cork_submit rfq-answer reads each
option's template recipe against the option's \`mode\` label and against the request's modes: a
\`fixed_rate\` label on a NAV template, or a mode the request did not name, is
\`cover_mode_mismatch\` (info — relayed as asked). A fill of a cited order through the venue book
(taker-fill by orderHash) reads the order's JIT block — the recipe it names, else the limits it
carries — against the cited RFQ's modes and the cited option's label, and reports
\`data.cover\`; a cover the request did not ask for is \`cover_mode_mismatch\` (info — the bytes
build; the requester accepts or refuses the counter-proposal). An order without a JIT block
fills on an existing pool, whose cover is not in its bytes: \`data.cover.delivered.kind\` is null
and the note says to read the pool.

## One request, one cover

A request carries ONE market template, so it describes ONE alternative. Naming two modes with
one template asks an underwriter to price a cover the template does not build: rfq-open warns
\`cover_mode_mismatch\` and still relays (an RFQ binds nobody). Open one request per cover.
The first form of this trap: a request that names \`liquidity_impairment\` with a LIQUIDITY
recipe is priced as downside cover while the pool it creates is exit-only.

## Read which cover you already hold

The Market struct does not store the recipe; the four rate limits are the chain's own answer.
\`cork_query cork-pool\` returns \`data.cover\`: both rate-change allowances at zero is
fixed-rate cover; else a \`rateMin\` of at most 1 wei is liquidity cover; anything else is a
band (impairment cover). \`cork_compute impairment-floor\` returns the worst rate over a
horizon and the most reference one cST can ever cost.
`,
    searchText:
      "cover kind type liquidity duration-risk duration risk impairment credit-risk credit risk fixed-rate downside protection exit deductible band lostAssets unreported loss bad debt MetaMorpho which cover am I buying mode 1 mode 2 liquidity_only liquidity_impairment recipe decides NAV loss payoff what does my cST pay apy spread duration rate floor fixed_rate rate_override frozen rate in the money moneyness cork-inline-fixed/1 how do I ask for fixed-rate cover notRead resolved constraint",
  },
  migration: {
    name: "migration",
    aliases: ["migrate", "move-funds", "previous-generation"],
    summary:
      "Moving funds from a pool on the previous generation to a pool on the current one is ONE workflow that spans two generations, and needs no second selector: every pool-scoped call follows the POOL's generation from the chain. Start with `cork_query account-state` WITHOUT filters.poolId — the account's positions across every generation. Exit each old pool with the pool-scoped action for its expiry state (unwind-deposit/unwind-mint before expiry; withdraw/redeem/withdraw-other after), enter a pool on the primary (deposit/mint; create-pool first when the pool does not exist; or a rollover-intent src→dst for a cST holder), and verify with cork_track. The `generation` input takes the aliases `previous` and `primary` beside labels; results always carry the resolved label.",
    body: `# Migrating funds between generations

Cork redeploys. The previous generation's pools keep working, so a migration is not forced — but
new markets are created on the PRIMARY generation, and a holder who wants to be there moves funds
themselves. This tool supports the previous AND the current generation at the same time: every
pool-scoped read, compute and prepare resolves the generation the POOL lives on from the chain
(\`shares(poolId)\` on every configured pool manager) and builds against THAT set's adapter. An
exit from an old pool and an entry into a new one are therefore two ordinary calls; no
"dual mode" switch re-routes bytes.

## The aliases on the \`generation\` input

Every chain-backed input takes \`generation\`. Besides a label (\`phoenix/v0.4-rc.1\`,
\`phoenix/v0.3-rc.1\`, \`arbitrum-v1.1\`) it takes two ALIASES:

- \`primary\` — the same as omitting it: the chain's newest Distribution set.
- \`previous\` — the newest ACTIVE non-primary generation that carries the contracts the call
  needs: a pool/phoenix call needs a pool manager, a registry call a market registry, a settler
  call a rollover block. On Arbitrum and Base today that is \`phoenix/v0.3-rc.1\` for all three.
  A chain with a single generation (mainnet) refuses \`previous\` as \`generation_unknown\`.

\`all\` is NOT a selector: a prepare builds one artifact and a registry read answers for one
registry, so it is refused with teaching. The one read that spans every generation is the
positions read below, which needs no selector (and accepts \`all\` as "no narrowing").

Aliases resolve to a LABEL in one place, before any contract is looked up, and every result
carries the label in \`data.generation\` / \`provenance.generation\` — never the alias — so the
provenance of a prepared artifact is exact.

## The recipe

1. **Read your positions.** \`cork_query\` resource \`account-state\` with \`filters.account\` and
   NO \`filters.poolId\`: the tool takes every pool each generation's pool manager created — by
   default from the chain over YOUR RPC alone (the pool-creation event scan, decoded per emitter
   wire; complete in one request on an endpoint that serves address-filtered ranges);
   \`mode: "full-decentralized"\` uses HyperSync; \`mode: "hybrid"\` takes the venue's pool list
   (balances still from your RPC) — the opt-in for an endpoint that caps eth_getLogs so hard the
   walk cannot finish (disclosed as pagination_incomplete). It then sweeps the account's cST and
   cPT balances and returns \`positions[]\` — one row per pool with a non-zero balance, each with
   its \`generation\`, \`poolId\`, \`expiryTimestamp\`, \`expired\`, share tokens and balances — plus
   \`byGeneration[]\` subtotals and \`generations[]\`. \`generation: "previous"\` narrows the sweep to
   the previous set. This result carries no \`provenance.generation\` (it spans generations).
   CLI: \`ch query account-state --chain-id 42161 --account <a>\`.

2. **Exit each old pool** with the pool-scoped \`cork_prepare_phoenix\` action for its expiry state
   — the tool resolves the pool's generation and targets THAT adapter; you pass the poolId only:
   - before expiry: \`unwind-deposit\` (exact collateral out, burns cPT+cST pairs) or
     \`unwind-mint\` (exact pairs in);
   - after expiry: \`withdraw\` (exact collateral out, cPT only), \`redeem\` (exact cPT in, pro-rata
     reference + collateral) or \`withdraw-other\` (exact reference out).
   A cST-only position (cover you bought) is exercised or unwound through \`exercise\` /
   \`unwind-swap\`, not migrated as principal. Simulate first (\`cork_track\` mode \`simulate\`), sign,
   broadcast through your own RPC (topic:"signing").

3. **Enter the new pool** on the primary:
   - \`deposit\` / \`mint\` with the new pool's poolId (a \`cork-pools\` read or \`derive-cork-pool\`
     names it);
   - if the pool does not exist yet, \`cork_prepare_market\` \`create-pool\` first (permissionless,
     idempotent — the same derivation a JIT fill runs), then deposit;
   - a cST holder rolling cover to a successor expiry signs a \`rollover-intent\` (src pool → dst
     pool; the settler's generation sets the wire) and relays it with \`cork_submit\`.

4. **Verify.** \`cork_track\` mode \`reconcile\` with each txHash, then the positions read again: the
   old rows are gone, the new row carries the primary's label.

## Ask for a rollover price first: rollover RFQs

A cST holder who does not know what a roll is worth can ask for a price (venue RFQ v2, kind
\`rollover\`). Every write is signed: build it with \`cork_prepare_orders\` \`rfq-write\`, sign the
typed data, relay it with \`cork_submit\` (topic:"signing").

1. **Ask.** \`cork_submit\` \`rfq-open\` with \`kind: "rollover"\`, \`source {poolId, shares}\` (the
   pool your position is in, and how many shares; the pool must exist and not be expired) and
   \`premiumToken\` (\`{exact}\` or \`{one_of}\`: the tokens you accept the premium in). A rollover
   RFQ carries no modes, packages or notional.
2. **Quote.** An underwriter answers with \`rfq-answer\` options of \`{option_id, chain_id,
   destination, premium_token, premium_per_share, shares_max, fresh_until}\`. The destination is
   an existing live pool that is not the source (\`{pool_id}\`) or a market the filler creates at
   fill time (\`{jitMarket}\`, written like every jitMarket input). \`premium_per_share\` is raw
   premium-token units per 1e18 destination shares, exactly the order's \`minPremiumPerShare\`.
   A just-in-time quote's result names \`jitMarketHash\`, the commitment your order must sign.
   A quote carries no order: you sign the rollover order, not the underwriter.
3. **Counter** (optional). \`rfq-counter\` with \`premiumPerShare\` and a \`premiumToken\` you accept.
4. **Accept.** \`cork_prepare_orders\` \`rollover-intent\` with \`quoteRef {rfqId, answerId,
   optionId}\`: the RFQ is read, every term you leave out comes from the quote (source pool,
   destination, premium token, premium per share, and the smaller of shares_max and your
   source.shares), and the order is held to the venue's rules — you are the requester, a premium
   per share at least the quoted one, no more shares than quoted, and for a just-in-time quote
   the quoted market hash (sign on a 0.2 settler; for that quote pass \`dstPoolId\` when the pool
   it derives to cannot be computed here). Relay with \`cork_submit\` \`rollover-order\` and the
   same \`quoteRef\`, which the venue records.
5. **Watch.** \`cork_query\` \`rfqs\` with \`filters.rfqId\` marks a rollover quote \`firm\` when a live
   rollover order (fillable, confirmed by its settler) cites it; \`rollover-orders\` takes
   \`filters.rfqId\` for the orders that accepted one RFQ.

## Two standing facts (2026-09-22)

- The primary's Market Registry (0.5.0) holds **registered assets since 2026-09-23** (the owner's
  four Safe transactions executed on both chains: 14 assets on Base, 17 on Arbitrum, with address-keyed
  denominations and USD conversion feeds). A market on the primary can be created by any JIT fill or
  \`create-pool\`; the nested fill path was rehearsed against a fork of that LIVE state the same day
  (no owner impersonation) and passed. Read the current rows with \`registry-assets\`.
- The \`phoenix/v0.4-rc.1\` set has **no CREATE2 attestation** (the Distribution records carry no
  salt or init-code hash). Its trust anchor is the approved-implementations allowlist compiled
  into this build: a prepare against code that is not on the list warns
  \`implementation_not_approved\`.`,
    searchText:
      "migration migrate move funds move my funds previous generation old pool new pool old generation current generation both generations at the same time withdraw from old deposit into new list my positions what do I hold where positions across generations account-state without poolId generation previous generation primary generation all exit old pool enter new pool rollover to new generation upgrade to new contracts rollover rfq rollover quote price to roll premium per share accept a quote quoteRef",
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
over it, chain outranks indexer.

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

/** Family B, answer-rfq (venue RFQ v2): the quote CARRIES its signed order, so the answer is
 *  posted first and the order goes to the book after it, citing it. */
export function executionAnswerRfq(supersedes = false): ExecutionBlock {
  return executionTypedData([
    "sign the order typed-data client-side as the underwriter (eth_signTypedData_v4, LOP v4 domain)",
    "cork_prepare_orders finalize-maker-order (recovers + verifies the signature) — keep its submitInput",
    `cork_prepare_orders rfq-write with request {type:'rfq-answer', rfqId, underwriter, status:'quoted', options:[answer.quotedOption plus order_signature = your signature]${supersedes ? ", supersedes: answer.supersedes" : ""}} — checks each order against its option, returns the CorkRfqWrite typed data`,
    "sign that typed-data, then cork_submit rfq-answer with the same request plus auth {method:'signature', signature} and the SAME clientRequestId as the rfq-write — the result carries answerId",
    "cork_submit lop-order with finalize's submitInput plus quoteRef {rfqId, answerId, optionId: answer.quotedOption.option_id} — the venue checks the book order is the exact order the answer quotes",
    "before the order expires, re-quote with cork_prepare_orders refresh-order (same terms, same bit, new expiry): it supersedes the answer with the new order before re-resting it",
  ]);
}

/** Family B, refresh-order: the re-rested order is completed like the one it replaces — and an
 *  order that executes an RFQ v2 quote first supersedes that quote with the new order. */
export function executionRefreshOrder(requote = false): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, LOP v4 domain)",
    "cork_prepare_orders finalize-maker-order (the listing carries the SAME nonce as the order it refreshes)",
    ...(requote
      ? [
          "cork_prepare_orders rfq-write with request {type:'rfq-answer', rfqId: requote.rfqId, underwriter, status:'quoted', supersedes: requote.supersedes, options:[requote.option plus order_signature = your signature]}, sign it, then cork_submit rfq-answer with auth and the same clientRequestId — the result carries the new answerId",
          "cork_submit lop-order with finalize's submitInput plus quoteRef {rfqId, answerId: the NEW answerId, optionId} — the venue takes, under a citation, only the exact order that answer carries; the old row may keep reading OPEN — it shares this order's bit, so whichever fills first retires the other",
        ]
      : ["cork_submit lop-order (pass submitInput verbatim); the old row may keep reading OPEN at the venue — it shares this order's bit, so whichever fills first retires the other"]),
  ]);
}

/** Family B, a maker-order whose maker is a CONTRACT and whose JIT pool does not exist yet, with
 *  no permit it can use (flat wire: ECDSA-only permits; nested wire: none carried yet): the pool
 *  is created and the allowances placed BEFORE the order rests (the CorkMarketCreator, batched by
 *  the smart account). */
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
