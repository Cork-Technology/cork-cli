# Cork Helper CLI / MCP — Consolidated Requirements v2

Status: requirements baseline for the revised RFC. Supersedes both the original meeting
notes and RFC-010's tool surface. Provenance tags: **[MTG]** meeting notes, **[RFC]**
distilled from the prior RFC draft (treat any contract/API specifics as *claims requiring
empirical verification*, not facts), **[CONV]** decisions made in design conversation.

## 1. Product definition

One strictly-typed core with two frontends:

- **`cork` CLI** — replaces Foundry `cast`, GitHub CLI, and Etherscan-style interaction
  for the Cork domain. The CLI lane MAY include generic escape hatches (raw `eth_call`,
  arbitrary calldata decode, raw RPC) and MAY invoke other CLI tools (e.g. `cast`, `gh`,
  `anvil`) as subprocesses and decode/enrich their responses — wrapping is a legitimate
  implementation strategy, not a design failure. [CONV]
- **MCP server** (`cork mcp serve`; stdio locally, streamable HTTP hosted) — exposes ONLY
  the closed, Cork-typed polymorphic tools in §3. No generic contract-call or raw-RPC
  tool is registered on the MCP surface. [CONV]

Absolute invariants (kept from prior work, re-justified from first principles):

- **No custody:** never holds keys, never signs, never confirms Safe transactions, never
  broadcasts. Outputs are unsigned artifacts, typed-data requests, and calldata. The one
  service mutation (signed-order submission) transmits a caller-signed payload.
- **Determinism:** identical validated inputs + identical observed state ⇒ identical
  canonical outputs and executable bytes. Idempotency identifiers are derived, never
  random.
- **Untrusted re-presentation:** any caller-held artifact is re-validated/reconstructed
  before new executable bytes are returned; digests without keys prove nothing.
- **Closed write schemas:** every byte-producing variant has an exact schema (closed
  enums, no arbitrary selector/target/calldata passthrough on the MCP surface).
- **Enriched output:** every result is labeled JSON with human/agent-readable field
  labels and doc/wiki references. [MTG]
- **Context economy:** responses are compact by default; verbose evidence (raw upstream
  payloads, byte-level provenance) is opt-in via a response-format parameter, never the
  default. [CONV]

## 2. Requirements inventory (deduplicated)

Each requirement appears exactly once, at its deepest common layer. Duplicates that were
merged are noted.

### R1 — Query (read any Cork resource)

Resources: markets/pools (incl. the full market tuple), pool whitelist status +
whitelisted addresses, flows/action history, limit-order markets, orderbook, fills,
account state (balances, classic + Permit2 allowances, nonce/invalidator state, Safe
configuration), off-chain metadata (governor/dev-team-set flags), protocol config
(addresses, fees, rate bounds). [MTG Goals 1–2] [RFC queries + authority.inspect —
merged: "authority inspection" is just a read.]

Data modes per resource where meaningful: `centralized` (shared cached DB on cork.tech
infra), `lite-decentralized` (public RPCs, chainlist-seeded), `full-decentralized`
(embedded HyperSync indexer for bulk historical: market discovery, order/fill backfills).
Mode is explicit input or explicit config — never a silent fallback; results state which
mode+source produced them. [MTG] [CONV: HyperSync = bulk historical only; live state and
previews stay on RPC.]

Every list result reports completeness, pages read, cursor, ordering. [RFC — keep;
genuinely useful to agents.]

### R2 — Compute (deterministic math over verified state)

- CST-swap rate via on-chain preview; unwind rate via on-chain preview. [MTG]
- Current price of Dutch-auction limit orders; current price of Dutch-auction rollover
  orders (time-dependent, computed off-chain). [MTG]
- Max REF impairment when paired with matching CST: the rate-limited floor moves with
  time; worst case is NOT `minRate`. [MTG]
- RFQ quote (hybrid local+remote): per-market config assessed by LLM offline and cached
  in a public shared DB; 50–100 pre-seeded tokens with precomputed risk metrics; inputs =
  market-type bucket, duration, token risk stats. [MTG Goal 3]
- Parity guarantee: off-chain reimplementations of contract math MUST be property-tested
  against time-warped fork `eth_call`s in CI; prefer `eth_call` whenever a view function
  exists. [CONV]

Merged duplicates: meeting-note "preview fetching" (Goal 1) and "time-dependent state"
(Goal 2) and RFC "preview reads" are all R2 — same primitive: *deterministic derived
value bound to verified state + timestamp*.

### R3 — Decode (bytes → labeled JSON)

Cork TX calldata; limit orders (decode/sort/filter); protocol events; receipts. CLI lane
additionally: arbitrary calldata via 4byte/ABI resolution. [MTG Goal 2] [RFC embeds
decoding inside reconciliation — split out: agents need decode without a lifecycle.]

### R4 — Prepare (unsigned artifacts for every supported action)

- Every CorkPoolAdapter action. [MTG Goal 1] The prior draft claims 13 protected
  functions — 6 exact-spend variants available (mint×2, repurchase collateral-in,
  unwind×2, redeem principal-in) and 7 capped-input variants deliberately unavailable
  pending protocol work. **Verify the real function list and availability empirically
  from the deployed contracts/ABI before freezing this taxonomy.** [RFC → verify]
- Token authority: standing Permit2 onboarding where policy allows, exact per-operation
  authorization, allowance revocation (`approve(spender, 0)`). [RFC — merged: the two
  separate revocation tools in the prior draft are one operation.]
- Limit-order lifecycle (phase 2+): maker order construction + typed-data, taker fill
  construction, cancellation/invalidation, against the pinned 1inch deployment; verify
  version/address/traits empirically. [RFC → verify]
- Market deployment (phase 3): wrap the EXISTING underwriting/pipeline automation and
  permissionless `MarketRegistry.deploy(ca, ref)`; never reimplement economics. [RFC]
- Safe support (phased): message-signature vs transaction-confirmation are distinct
  stages; start with one exact supported configuration. [RFC — principle kept, exact
  config re-derived at implementation time.]

### R5 — Track (verify / simulate / reconcile)

- Verify a market/resource against deployed state before it's used for an action.
- Advisory simulation of frozen bytes (fork or provider simulation).
- Reconcile caller-supplied receipts/order-hashes/submission refs into closed lifecycle
  states; chain evidence outranks indexer/service claims; disagreement = explicit
  `conflict`, never silent preference. [RFC — keep; this is the best part of the draft.]
- Signed-order submission with durable idempotency (the single service mutation; state
  machine: pending/accepted/rejected/ambiguous, bounded retries, proved-absence rule —
  simplify mechanics, keep semantics). [RFC]

### R6 — Meta (discovery, enrichment, config)

- Capability + maturity discovery: specified / implemented / activated / healthy, with
  machine-readable unavailability reasons. [RFC — keep, collapse into one tool.]
- Tool search / help: keyword → exact tool + variant + invocation template, so agents
  find specialized behavior without loading every schema. [MTG Goal 4]
- Addresses/config fetched from canonical GitHub sources (cork-helper-cli
  `cork-defaults.json`, phoenix `config/prod.toml`), cached with TTL + provenance,
  CREATE2-verifiable, never hardcoded. [CONV]
- Enrichment tables (labels, doc refs) versioned against config/deployments. [MTG]

### Cross-cutting engineering requirements [CONV]

TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) with one
schema source (zod or equivalent) generating MCP tool schemas + CLI flags + TS types;
viem/abitype at the typed boundary; napi-rs/alloy addon where fork-, indexer-, or
math-shaped; HyperSync via Envio client; Node LTS primary, Bun-compatible; npx/binary
distribution; anvil/Tenderly-vnet empirical test rig; `tsc --noEmit` + property tests +
golden vectors in CI. MCP: pin the current stable protocol era; track newer eras as a
compatibility task, not a dual normative requirement.

## 3. Proposed MCP tool surface (6 + 3)

Decision (after weighing 7 vs 9 vs risk-tier splits against a mixed-host audience —
Claude-family, other frontier hosts, in-house agents — and an external-partner
onboarding timeline): **9 tools — six verbs plus three family-scoped prepare tools.**
Family splitting keeps every discriminated union ≤8 variants (renders acceptably even on
hosts with weak `oneOf` support), makes agent transcripts self-documenting during
partner debugging, and gives hosts per-family permissioning. Any future merge or split
must beat this baseline in the agent-eval suite (eval-gated growth).

| # | Tool | Covers | Input shape (sketch) |
|---|---|---|---|
| 1 | `cork_query` | R1 | `{resource: enum, filters?: per-resource object, mode?: enum, cursor?, format?: "concise"\|"full"}` |
| 2 | `cork_compute` | R2 | `{kind: enum(cst-swap-rate, unwind-rate, dutch-auction-price, rollover-price, impairment-floor, rfq-quote), params: per-kind object, at?: block\|timestamp}` |
| 3 | `cork_decode` | R3 | `{kind: enum(calldata, order, event, receipt), data: hex\|object}` |
| 4 | `cork_prepare_phoenix` | R4 (adapter actions + token authority) | `{action: union of Phoenix variants + onboard/revoke, clientRequestId, account, chainId}` |
| 5 | `cork_prepare_orders` | R4 (limit-order lifecycle) | `{action: union of maker/taker/cancel/revoke variants, clientRequestId, account, chainId}` |
| 6 | `cork_prepare_market` | R4 (market deployment) | `{action: union of deployment steps, clientRequestId, chainId}` |
| 7 | `cork_track` | R5 (except submission) | `{subject: artifact\|txHash\|orderHash\|marketRef, expect?: artifactDigest}` |
| 8 | `cork_capabilities` | R6 | `{topic?: string, search?: string}` → maturity, variant docs, invocation templates |
| 9 | `cork_submit` | R5 submission | kept separate: it is the only side-effecting call; permission systems and humans must be able to gate it by tool identity |

**Client-adaptive presentation (not semantics).** The server reads `clientInfo` from the
MCP `initialize` handshake (plus the transport user-agent) against a small versioned
client-profile table. Adaptation is limited to presentation: schema dialect (strict
`oneOf` is canonical; a pre-flattened rendering only for clients profiled as mishandling
unions), description/example verbosity, and default page sizes. One canonical surface,
one validation behavior, one eval suite for everyone; unknown clients get the strict
canonical default. Tool semantics and availability NEVER vary by client identity.

CLI-only (never MCP-registered): `cork raw call/decode/rpc`, `cork cast -- <args>`,
`cork gh -- <args>` (wrapped + enriched), `cork fork` (anvil orchestration).

## 4. Coverage evaluation

Every capability in the prior draft's ~40-tool surface maps: 7 service reads +
authority.inspect + market.verify(read half) → `cork_query`; all preview/pricing →
`cork_compute`; 6+7 action variants × prepare/finalize → `cork_prepare_phoenix`
(finalize is a `stage` field / second call with the prepared artifact, same tool); the
limit-order lifecycle → `cork_prepare_orders`; deployment → `cork_prepare_market`; every
per-capability simulate/reconcile + market.verify(action half) → `cork_track`; both
revocation tools + onboarding → `cork_prepare_phoenix`/`cork_prepare_orders` authority
variants; capabilities → `cork_capabilities`; submission → `cork_submit`. Meeting-note
goals not present in the prior draft (Dutch auction, impairment floor, RFQ, tool search,
data modes, enrichment, GitHub config) land in `cork_compute`, `cork_capabilities`, and
cross-cutting R6.

Honest costs of consolidation, with mitigations:

1. **Write-permission granularity** — largely resolved by the family split (hosts can
   allow Phoenix prepares but not order prepares by tool name); prepare remains
   non-side-effecting by design (returns bytes, never executes), `cork_submit` stays the
   single gateable mutation, and hosted scopes can additionally filter by `action.type`.
2. **Schema size** — family splitting caps each union at ≤8 variants; variant
   descriptions are one-liners; deep docs live behind `cork_capabilities`. Re-merge or
   further splits only on eval evidence.
3. **Variant discoverability** — mitigated by `cork_capabilities` search returning
   exact invocation templates, and by closed enums (agents see every legal `type`).

## 5. How agents learn multipurpose tools (design obligations)

These are requirements, not suggestions, because a polymorphic surface lives or dies by
them:

1. **Discriminated unions with closed enums** — every polymorphic input has a `type` or
   `kind` discriminator; JSON Schema `oneOf` branches carry exact per-variant fields;
   nothing is stringly-typed.
2. **Descriptions written for agents** — each tool description states purpose, when to
   use it, when NOT to (pointing to the right sibling), and 2–3 worked examples inline.
   Each enum value gets a one-line description.
3. **Progressive disclosure** — `cork_capabilities` is the manual: keyword search returns
   the exact tool + variant + filled example. This satisfies tool-search (R6) without
   registering 40 schemas.
4. **Errors that teach** — closed error codes with `remediation` and, where possible, a
   corrected example invocation. An agent's next call after an error should usually
   succeed.
5. **Output discipline** — declare MCP output schemas / structured content; concise by
   default with `format: "full"` opt-in; small default page sizes; stable envelope
   across all tools (same state/warning/provenance fields everywhere, version inside the
   payload — NEVER in the tool name).
6. **Determinism surfaced** — `clientRequestId` semantics documented in the tool
   description so agents know retries are safe.
7. **Eval-gated** — maintain an agent-eval suite: a fresh agent given only the tool list
   must complete representative tasks (fetch orderbook, price a Dutch auction, prepare an
   unwind, reconcile a receipt) at target success rates; tool descriptions are iterated
   against these evals like any other code.
