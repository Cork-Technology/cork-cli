# Rollover venue build-out plan (+ HyperSync/HyperRPC roles)

**Status:** RATIFIED and IMPLEMENTED (RFC 011 §16; phases R0–R3 + the R4 order-surface shipped
2026-07-20 — rollover-intent build, venue datasource, [K7] verification legs, HyperSync mode,
extension orders, numbers-contract tripwires). Remaining: live activation once campaign pools +
first orders exist, and the open questions in §5.
**Date:** 2026-07-20
**Inputs:** `cork-knowledge/rfcs/rollover-venue-interface.md` (as-built, live on Arbitrum since
2026-07-20), `cork-knowledge/rfcs/agent-rfq-venue-interface.md` (as-built), the indexer event list
(Slack, from `cork-indexing-infra/src/contracts/`), `phoenix-private/config/arbitrum-staging.toml`,
`rollover-private` source (events + settler surfaces), plus this session's on-chain probes
(documented below — every address in §2 was verified with `eth_getCode`/`eth_call`/`eth_getLogs`
against Arbitrum One on 2026-07-20).

## 0. Owner decisions this note implements (2026-07-20)

1. **Rollover first**, RFQ+LOP second. Use the live Arbitrum addresses (staging-shadow profile).
2. **`cork_submit` expands to ALL venue writes** — every write is an off-chain HTTPS POST
   (LOP order, RFQ open, RFQ answer, rollover order). Nothing on-chain; [K1] intact (we relay
   caller-signed/caller-authored payloads, never sign).
3. **HyperRPC** (token-gated `eth_getLogs` endpoint) implements the `cork_track` verification leg;
   **HyperSync** (the query API / napi client) implements `full-decentralized` `cork_query`.
   Rationale: historical event logs are exactly what ordinary non-archive RPCs refuse to serve
   (empirically confirmed, §4.1).
4. Design note first; `rfc/011` amendment + CLAUDE.md/README refresh after review.

## 1. What the two venue docs unblock

Both venues are **as-built** on `api-phoenix.cork.tech/v1` — this is the `centralized` data mode
our envelope already models (`mode_unavailable` today). Mapping to our gated variants:

| Gated variant today | Backend now live |
|---|---|
| `cork_query` orderbook / fills / limit-order-markets | `GET /v1/limit-orders/{orderbook,fills,markets}`, `/v1/pools` |
| `cork_query` flows (rollover lifecycle) | `GET /v1/rollover/{orders,fills,contracts}` |
| `cork_submit` | `POST /v1/limit-orders`, `POST /v1/rollover/orders`, `POST /v1/rfqs`(+`/answers`) |
| `cork_track` reconcile orderHash / submissionRef | venue lifecycle (`PENDING→OPENED→PARTIALLY_FILLED→AWAITING_PREMIUM→SETTLED`; off-ramps `CLOSING/CANCELLED/EXPIRED`) + `/fills` |
| `cork_prepare_orders` rollover-intent | Pure/offline — CorkSettler EIP-712 domain + intent-hash commitment, addresses in §2 |

Structural facts that shape the design:

- **The solver gap is fundamental**: RFQs, RFQ answers, and signed-but-unfilled orders emit **no
  events**. The chain speaks only at open/fill/cancel. No amount of indexing decentralizes the
  pre-commitment feed; the venue is the only source of signed payloads (`source: API` rows).
  `source: CHAIN` rows (seen via `Open` first) have `payload: null` and are not solver-fillable.
- **One signature, hash-bound intent**: the holder signs `OrderData` under
  `{name:"CorkSettler", version:"1.0.0", chainId, verifyingContract: settler}`; the EIP-712 digest
  is the ERC-7683 `orderId` and the primary key everywhere. The `RolloverIntent` (hooks bundle) is
  bound via `OrderData.rolloverIntentHash` — recomputable locally, our [K3] posture applies.
- **Venue idempotency ≙ our K2**: `request_id` same-body replay → 200, different body → 409 —
  exactly our `clientRequestId` contract. `cork_submit` should pass `clientRequestId` through as
  the venue `request_id`.
- **The numbers contract** (RFQ doc §2.1): fraction strings (`"0.041"`), legacy percent numbers
  (`4.1`), wad uints, native token decimals coexist; the venue rejects ~100× divergence. This maps
  1:1 onto our teaching-error machinery — catch scale mistakes at build time with a
  "did you mean the fraction form?" suggestion (Phase R4).
- Rollover admission preconditions the venue enforces (settler factory-approved; rollover contract
  is the signer's own clone; dst pool not expired; ≤5 open orders/user/chain) are all things
  `cork_prepare_orders` can **pre-flight locally or with one RPC read**, so we never build an
  order the venue will reject.

## 2. Verified Arbitrum addresses (all probed on-chain 2026-07-20)

**Two Phoenix deployments coexist on Arbitrum One.** The API's indexed pools
(`GET /v1/pools?chainId=42161` → 3 pools) live on the *production* PM we already ship
(`deployments["42161"]`). The `arbitrum-staging` shadow profile (deployment marker
`arbitrum-staging`, campaign `phoenix-rollover-2026q3-r1`, staging_shadow=true) is a second, full
deployment the rollover campaign runs against. Config consequence: `deployments["42161"]` stays
the default read path (API pools resolve there); the staging profile is stored under the new
`deploymentProfiles["42161"]["arbitrum-staging"]` key in `cork-defaults.json` — consumers opt in
by name.

| Contract | Address | Evidence |
|---|---|---|
| PM proxy (production, default) | `0xc2De56fb1C7a85250ce69C37B4773767C77954AE` | pre-existing; API pool rows point here; code ✓ |
| PM proxy (arbitrum-staging) | `0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2` | toml `deployed_cork_pool_manager_proxy`; code ✓ (80 B proxy) |
| ConstraintRateAdapter proxy (staging) | `0x248B24114D6e7df0b28AED21f7814cc0dBDB9120` | toml; code ✓ |
| CorkAdapter (staging) | `0xe9f364dfcc358DC745Ff7C54cb087AE2520F1bed` | toml; code ✓ (21,427 B) |
| Bundler3 (staging) | `0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13` | toml; code ✓ (1,547 B) |
| WhitelistManager proxy (staging) | `0xeC187bA7BBd4016d8db326ea1DFb3DD48d17Bd3A` | toml; code ✓ |
| **RolloverContractFactory** | `0xBBcC54c637c26b484A8c57b5695c04e09daCE13A` | **discovered from raw logs** — address-less `eth_getLogs` topic scan for `SettlerApproved(address)` (`topic0 0x7cc19254…`); emitter = factory; code ✓ (16,916 B) |
| **ExactSettler** | `0x983270AE48545665Cee4D7EF61C65fF3fdC8222D` | `SettlerApproved` @ block 484,973,917 tx `0x03363562…67a4`; code ✓ (21,481 B); **reverts** on the PartialSettler-only selector |
| **PartialSettler** | `0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a` | same seeding tx; code ✓ (23,359 B); **answers** `fillerSlotAccountingOf(bytes32,address,bytes32)` (`0x87c29f6d`) with zeroed slot accounting |
| Deployed clones | none yet | `RolloverContractDeployed` scan from seeding block → 0 events; `/v1/rollover/{orders,contracts}` both empty |

> **⚠️ CONFIRMED doc error (flag to raouf):** the rollover venue RFC's worked examples label
> settler `0x983270ae…` as `PARTIAL`. Three independent on-chain discriminators, each validated
> against the **pinned deployed source** (`rollover-private @ 032d3e5a` = PR #154, fetched from
> GitHub — the local clone was stale), prove the labels are inverted:
> 1. `fillerSlotAccountingOf(bytes32,address,bytes32)` (PartialSettler-only at 032d3e5a):
>    `0x8e9c…` answers it; `0x9832…` reverts.
> 2. `rolloverAccountingOf(bytes32)` return shape: `0x9832…` returns **5 words** =
>    `ExactRolloverAccounting{filler, settlementDestination, dstCstProduced, filledAt,
>    premiumFired}`; `0x8e9c…` returns **3 words** = `PartialOrderAccounting`.
> 3. `ExactSettler._validateMode` reverts `Settler__PartialFillsNotSupported` on
>    `allowPartialFills: true` — so the RFC's §3.1 worked example (partial-fills order,
>    settler `0x9832…`) is **unfillable on-chain as written**.
>
> Empirical truth: **ExactSettler = `0x9832…222D`, PartialSettler = `0x8e9c…366a`** (as recorded
> in our `cork-defaults.json`). Whether the venue's own seed table shares the doc's inversion is
> unobservable until the first order row exposes a `settlerKind` — a solver trusting the doc
> example would build reverting fills, so this is a high-signal correction.

Also in the toml but not yet consumed: DefaultCorkController `0xdCC0388c…6172`, SharesFactory
`0x074BA120…FFbC`, timelocks, and the full CREATE2 salt set (constraint/wlm/pm/adapter/controller/
shares_factory salts) — these enable extending `cork_capabilities topic:"verify"` CREATE2
attestation to the staging profile later.

### 2.1 Verification appendix (all probes 2026-07-20, Arbitrum One)

The most plausible — now essentially proven — setup: **the rollover stack is a self-contained
vertical on the staging-shadow Phoenix deployment**, disjoint from the production deployment that
hosts today's API pools.

| Claim | Evidence |
|---|---|
| Settlers sign under `CorkSettler / 1.0.0 / chainId 42161 / verifyingContract = settler` | `eip712Domain()` (ERC-5267) called on **both** settlers returns exactly that (fields `0x0f`, name `CorkSettler`, version `1.0.0`) — the venue doc's signing model is **correct** |
| Both settlers are factory-approved | `factory.approvedSettlers(settler)` → `true` for both |
| **Settlers are hard-bound to the STAGING PM** | `CORK_POOL_MANAGER()` (public immutable) on both settlers → `0x4d0a…23d2`; `ROLLOVER_CONTRACT_FACTORY()` → `0xBBcC…E13A`. Rollover src/dst pools are therefore staging-PM pools — **Q-ROLLOVER-PM answered**, and `deploymentProfiles` is required plumbing for every rollover pre-flight/compute, not an archive |
| Factory identity | Sourcify **runtime match** verified 2026-07-17; ABI = `CorkRolloverContractFactory` (`approveSettler`, `deployRolloverContract`, `predictRolloverContractOf`, `RolloverContractDeployed`, …). Clone impl: `ROLLOVER_CONTRACT_IMPLEMENTATION()` → `0xf55855e17514262b91f8a3b4d35688972dee9050`. Settlers are NOT Sourcify-verified (worth asking the team to publish) |
| Staging toml is faithful | ERC-1967 impl slots: staging PM → `0x4a6d1352…` and staging CRA → `0x5ca7f1be…`, both equal to the toml's `deployed_*_impl`. Production PM runs a **different** impl (`0xd31f0996…7a854481d905d7003496d176b9ba882a`) — staging is a separate, newer release, not a re-registration |
| Staging bundler3 = Morpho Bundler3 | runtime bytecode **byte-identical** to mainnet `0x6566…0245` (1,547 bytes, same keccak) — our existing Bundler3 encoder/decoder works unchanged on the staging profile |
| Pre-launch state | `MarketCreated` scan: staging PM **0 pools** (signature validated: the same topic0 on production PM returns exactly the API's 3 pools at blocks 482755505/482756502/482793932); factory `RolloverContractDeployed` **0 clones**; venue `/orders` + `/contracts` empty |
| Slack event list plausible | `MarketCreated(bytes32,address,address,uint256,address,address,address)` topic0 `0x0dac57f1…` reproduces the production PM's pool set exactly |

Consequence of the 0-pools state: the venue's POST admission ("both cSTs are known, pool ids
match" against *indexed* metadata) cannot pass for any rollover order until campaign pools exist
on the staging PM **and the indexer watches the staging PM address**. `/v1/pools?chainId=42161`
currently returns only production-PM pools, so indexer coverage of the staging PM is
unconfirmed — new open question Q-STAGING-INDEXED below.

## 3. Build phases (rollover-first)

### R0 — offline rollover surface (no backend dependency; buildable now)

- **`cork_prepare_orders` `rollover-intent` un-gate**: build the unsigned `OrderData` typed-data
  under the CorkSettler domain, with the settler resolved from `rollover` config by
  `settlerKind: "EXACT" | "PARTIAL"` (or explicit address override). Compute
  `rolloverIntentHash` locally from the caller's intent (hooks default empty) — never accept a
  caller-supplied hash without recomputing [K3]. Validate the venue's admission rules at build
  time: `rolloverParams` mirrors `OrderData`, deadlines ordered and future, size positive,
  origin==destination==chainId (single-chain), premiumPaymentMode ∈ {0,1}.
- **`cork_decode` order variant** for rollover payloads: given `{order, intent, signature?}`,
  re-derive the intent hash + orderDigest and label mismatches (`digest_mismatch` conflict).
- **`cork_compute rollover-premium-floor`** already ships (pure) — wire the worked example to real
  Arbitrum terms once a live order exists.
- Config: `cork-defaults.json` `rollover` + `deploymentProfiles` keys (**landed with this note**),
  `resolveRollover(chainId)` accessor in `config-remote.ts`.
- Note: prepare/decode need **no RPC**; optional pre-flight reads (dst pool not expired, clone
  exists via `factory` read) follow the funding-legs pattern — explicit RPC only, informational
  warning when skipped.

### R1 — centralized venue wiring (`api-phoenix.cork.tech/v1`)

One HTTP datasource module (`packages/core/src/datasources/venue.ts`), zod-validated responses
(untrusted input discipline, same as config-remote), `provenance.mode: "centralized"` +
`provenance.venue: {host}` on `format:"full"`.

- **`cork_query`**: `resource:"flows"` → rollover orders/fills/contracts (filters: `poolId`,
  `account`→user/owner, `orderDigest`, `fillable`, `status[]`); `resource:"orderbook"`/`"fills"`/
  `"limit-order-markets"` → the LOP book (unblocks `needs_indexer`).
- **`cork_submit`**: discriminated actions `rollover-order` | `lop-order` | `rfq-open` |
  `rfq-answer`, all off-chain POSTs, `clientRequestId` → venue `request_id`/idempotent replay
  handling (200 vs 201 vs 409 surfaced distinctly; 429 cap → `unavailable` with the cap explained).
- **`cork_track` reconcile** `subject: orderHash` → venue lifecycle row + fills; `submissionRef` →
  the POST outcome. (Chain verification comes in R2 — until then provenance honestly says the
  state is venue-reported.)
- Mode semantics: these variants **require** `mode:"centralized"` or default to it per-resource
  where no chain path exists; requesting `full-decentralized` before R3 stays `mode_unavailable`.

### R2 — HyperRPC verification leg in `cork_track` [K7]

Reconstruct rollover lifecycle **from raw logs** and diff against the venue's claim; disagreement
→ `state:"conflict"` (chain outranks indexer). Event set (from `rollover-private`, matching the
indexer's own specs):

| Lifecycle fact | Event (emitter) |
|---|---|
| Order opened on-chain | `Open(bytes32 orderId, ResolvedCrossChainOrder)` (settler, ERC-7683) |
| Fill leg (cST moved, CA delivered) | `RolloverLegSettled` / `RolloverLegSettledWithSubFiller` (rollover clone) |
| Premium paid | `PremiumFired` (clone); `PremiumRefunded` (filler) |
| Terminal states | `OrderSettled(bytes32)` / `OrderCancelled(bytes32)` (settler); `DefaulterResidualReclaimed` |
| Hook phases | `HookPhaseExecuted`, `IntentPhaseFired(+WithSubFiller)` (clone) |
| Clone + trust config | `RolloverContractDeployed(user, clone)`, `TrustConfigQueued/Applied/Canceled`, `SettlerApproved/Revoked` (factory) |

Implementation: HyperRPC is a **plain JSON-RPC URL** (`https://42161.rpc.hypersync.xyz/<token>`)
serving the read-only subset (`eth_getLogs`, blocks, receipts — **no `eth_call`**), so it slots
into the existing `resolveRpc` machinery as a *logs-capable* endpoint class rather than a new
client: add a `resolveLogsRpc(chainId)` that prefers `CORK_LOGS_RPC_URL` → HyperRPC when
`ENVIO_API_TOKEN` is set → the chain's regular resolved RPC with a **bounded** range (recent-only;
see §4.1). Backfill window starts at `rollover.seededAtBlock`.

Freshness rule: the indexer lags finality (~300 blocks / ~75 s on Arbitrum) — a venue row younger
than a freshness window (default 5 min, block-timestamp-anchored) may legitimately trail the
chain; report `warnings:[{code:"indexer_lag"}]` instead of `conflict` inside the window.

### R3 — HyperSync `full-decentralized` `cork_query`

`@envio-dev/hypersync-client` (napi-over-Rust) as a second datasource for **bulk historical**
queries only (fills/flows backfills, clone discovery, market discovery via `MarketCreated`);
live state stays on RPC exactly as RFC 011's mode table specifies [C12]. Gate on a **Bun-napi
spike** first (`experiments/hypersync-spike/`): confirm the client loads under Bun 1.3 and can
stream one settler event range; record `archive_height`/`rollback_guard` reorg semantics.
`provenance.mode: "full-decentralized"`, provenance carries the HyperSync archive height.

### R4 — RFQ+LOP completion (second venue, after rollover ships)

`cork_prepare_orders` gains `quote_ref` + `extension` on maker-order (deploy-on-fill/JIT orders;
salt low-160-bits must equal `keccak(extension)` low bits — pre-flight the same check the venue
runs); numbers-contract teaching (fraction/percent/wad tripwires with corrected examples); RFQ
open/answer submit actions (already covered by decision #2); `rfq-quote` compute stays ours
(the venue is transport-only and never interprets economics).

Cross-cutting: eval tasks per phase (Layer B tasks for rollover-intent build, venue-gated
outcomes, conflict detection), MATURITY map updates (`specified` → `implemented` → `activated`
as each lands), surface-drift fixture regeneration, worked examples using the §2 addresses.

## 4. HyperSync / HyperRPC — empirical facts (probed 2026-07-20)

### 4.1 Why ordinary RPC isn't enough (proven today)

- `publicnode` (Arbitrum): a 2.5M-block `eth_getLogs` range → rejected: *"Archive requests
  require a personal token"*. Non-archive public RPCs refuse historical log ranges.
- `drpc.org` free tier: *"ranges over 10000 blocks are not supported"* → a seeding-to-head
  backfill would need ~100+ paginated calls, against rate limits.
- `arb1.arbitrum.io/rpc` **did** serve a full-range address-less topic scan (that's how the
  factory was discovered) — but this is undocumented generosity, not a contract; unusable as the
  designed-for path.
- **HyperRPC tokenless is dead**: `https://42161.rpc.hypersync.xyz` without a token returns
  `{"error":"Your token is malformed…"}` — outright rejection, not rate-limiting (docs still say
  "rate limited"; reality is stricter). URL shape: `https://{chainId}.rpc.hypersync.xyz/<token>`.
  Pricing $4/M calls, $1/mo minimum. Method subset: `eth_getLogs`, blocks, txs, receipts,
  `trace_block` (select chains). **No `eth_call`** → cannot serve any `readContract` path.

Consequence: `ENVIO_API_TOKEN` is a **required** user-supplied env for R2/R3 (never committed —
same discipline as RPC URLs); without it, those variants return `unavailable` with a teaching
message pointing at `https://app.envio.dev/api-tokens`, and `cork_track` falls back to
venue-reported state with honest provenance.

### 4.2 Division of labor (decision #3)

| Concern | Tool | Why |
|---|---|---|
| Track-verify leg (R2): targeted lifecycle reconstruction for ONE order/digest | **HyperRPC** | Plain JSON-RPC — reuses our transport, breaker, and caching; a handful of `eth_getLogs` calls per reconcile; no new native dependency |
| Bulk historical query (R3): fills/flows backfills, clone/market discovery, account history | **HyperSync** | Purpose-built columnar scans, wide filters, `archive_height`/`rollback_guard`; the napi client is the supported surface |
| Live state (rates, balances, market structs) | regular RPC | HyperRPC/HyperSync have no `eth_call`; unchanged `lite-decentralized` path |
| Pre-commitment order flow (RFQs, answers, unfilled signed orders) | **venue only** | Emits no events — not indexable by anyone, by design |

## 5. Open questions

- **Q-SETTLER-KIND** *(RESOLVED on-chain, §2.1)*: ExactSettler = `0x9832…`, PartialSettler =
  `0x8e9c…` — the venue RFC's example labels are inverted. Remaining sub-question: does the
  venue's seed table share the doc's inversion? Unobservable until the first order row carries a
  `settlerKind`; report the doc error to raouf either way.
- **Q-ROLLOVER-PM** *(RESOLVED, §2.1)*: settlers are immutably bound to the staging PM
  `0x4d0a…23d2`; rollover pools are staging-PM pools by construction.
- **Q-STAGING-INDEXED** *(new)*: does `cork-indexing-infra` watch the staging PM on Arbitrum?
  `/v1/pools?chainId=42161` shows only production-PM pools today (staging PM has 0 pools, so
  this proves nothing yet) — if it doesn't, the venue's pool sanity-check will reject every
  rollover order once campaign pools exist. Ask raouf, or observe once the first staging pool
  deploys.
- **Q-VNET-ROLLOVER**: rollover is Arbitrum-only; our Tenderly vnet is a mainnet fork — no
  rollover test fixture exists. Options: Arbitrum vnet, or impersonated deploy of the rollover
  stack on the existing vnet (heavier than the demo-pool script).
- **Q-ENVIO-TIER**: which Envio tier/token does the team already hold (cork-indexing-infra runs
  HyperSync in prod) — can we share a token for CI, or do users bring their own only?
- **Q-RFQ-SIG**: RFQ writes are unsigned-verified in the pilot ("include real signatures from day
  one") — `cork_submit rfq-open/rfq-answer` should require a signature field anyway so enabling
  venue-side verification changes nothing for us.
