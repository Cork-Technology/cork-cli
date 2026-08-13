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
- Allowance prerequisites: a taker-fill needs the taker-asset allowance to the LOP;
  permit2-funded bundles need BOTH Permit2 layers in place (\`cork_query\`
  resource:"account-state" shows both). ForSelf-mode artifacts (\`forSelf\` on
  \`cork_prepare_phoenix\` / taker-fill — for parameter-blind session-key wallets) invert
  this: every allowance is granted to the INTEGRATOR-DEPLOYED ForSelf adapter itself, never
  to the LOP or pool manager, and outputs are structurally delivered to the calling account.
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
      "Ten scale conventions meet on this surface and only some are WAD, because the unit belongs to whoever owns the value: a token owns its decimals (amounts are NEVER rescaled), a deployed contract owns its fixed-point base (Cork fee fields are 1e18 = 1%, not 1.0), the venue owns its wire format (premiums are fraction strings like \"0.041\" on the RFQ and, since cork-api 0.3.3, the book's premiumAnnualized; the book's legacy percent-number `premium` is removed 2026-08-17), and 1inch owns the Fusion bases (rate bump 1e7, fees 1e5, discounts 1e2, gasPriceEstimate 1000-per-gwei). Every scaled field states its own scale in its schema description — read the label, never assume 18 decimals; money and rate OUTPUTS additionally carry a `scales` block plus the pair's collateralDecimals/referenceDecimals. Three collisions cause most real mistakes: 1e18 = 1.0 and 1e18 = 1% are identically shaped, `premium` means four different things across the book/RFQ/rollover/auction surfaces, and rateMin/rateMax are absolute rates under the 2.1.0 model but percentage bands on the gated legacy path. Compare and convert in exact integer arithmetic over the decimal strings — never floats — for your OWN conversions; guards that predict a venue verdict instead replicate the venue's own arithmetic exactly. Call cork_capabilities topic:\"units\" for the full table with a worked exemplar per scale.",
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
| \`{%}\` percent number | PERCENT number, not a fraction | \`5\` (JSON number, 0..1000) | \`premium\` on the orderbook listing (cork_submit lop-order and the finalize listing block) — DEPRECATED: the venue removes it 2026-08-17; its successor is the fraction-string premiumAnnualized in the next row | cork-api ≤0.3.2 (the legacy book scale) |
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

**2 — \`premium\` means four different things.** Book listing \`4.1\` (percent number — DEPRECATED,
venue-removed 2026-08-17) · RFQ option \`"0.041"\` (fraction string) · rollover
\`minPremiumPerShare\` \`12000000000000000\` (base units per 1e18 share) · auction
\`initialRateBump\` \`500000\` (1e7 above the signed floor). Confirm which surface you are on before
writing the number. The book and the RFQ have CONVERGED (cork-api 0.3.3): the book's successor
field \`premiumAnnualized\` shares the RFQ's name and fraction convention — the R13 mechanism
working as designed, a new unit arriving as a new name — so this collision shrinks to three once
the percent field is gone.

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

/** Family B, rollover-intent path. */
export function executionRolloverIntent(): ExecutionBlock {
  return executionTypedData([
    "sign the typed-data client-side (eth_signTypedData_v4, CorkSettler domain)",
    "cork_submit rollover-order (relays the caller-signed order; never signs)",
  ]);
}
