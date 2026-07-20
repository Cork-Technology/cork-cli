---
title: "RFC 011 — Cork MCP Server + CLI (`cork`)"
type: rfc
status: draft
spec_source: manual (not discovery-validated; requirements baseline + empirical verification)
supersedes: RFC-010 (Cork Protocol MCP Server)
author: claude
date: 2026-07-16
verification_log: ../notes/verification-log.md
status_detail: reviewed (deep review-board gauntlet, 3 reviewers; 7 must-fix + 5 suggestions applied)
review_coverage: full
architectural_corrections:
  - "§5.2 impairment-floor formula: added refill-to-now term (DC-3/EF-1 CONFIRMED — was non-conservative)"
  - "§5.4 safeRedeem sentinel relabeled owner-based, matching contract + unwind-mint (DC-1)"
  - "§5.5 rollover-intent: added CorkSettler/1.0.0 domain binding + settler/token fields (DC-2, K4)"
  - "§5.4 added per-variant one-line descriptions to all 15 phoenix branches (GUO-1)"
  - "§5.2/§5.7 closed cork_compute.params + cork_track.subject as oneOf; §5 states filters as the deliberate open exception (GUO-3)"
  - "§3.1 added normative CLI-lane subsection + exit-code contract for the §14 parity gate (GUO-4)"
  - "§5 inlined 3 hot-variant examples; §5.0 fixed MarketId citation C10→C1; §6 envelope/lifecycle mapping; §7 date 2026→2025-11-03; §14 nonzero-fee unwind parity"
tags: [tooling, mcp, cli, phoenix, agent-ux]
baked_decisions:
  - "9-tool polymorphic MCP surface (6 verbs + 3 family prepares + cork_submit)"
  - "generic capability in CLI lane only; MCP registration list closed + Cork-typed"
  - "chain-over-indexer authority; explicit conflict states; no silent data-mode fallback"
  - "no custody; unsigned artifacts only; single service mutation = signed-order submit"
empirical_corrections:
  - "C1: all 13 CorkAdapter actions are buildable — the 6-buildable/7-unavailable split is dropped"
  - "C6: no Dutch auction in production today; Dutch = 1inch Fusion extension (spec'd, Phase 3)"
  - "C8: rollover premium is a fixed floor, not a time-decay curve"
  - "C11: MarketRegistry deploy(ca,ref) surface unverified — market deployment deferred to Phase 4"
---

# RFC 011 — Cork MCP Server + CLI (`cork`)

> Replaces RFC-010. RFC-010's security spine survives (no custody, untrusted re-presentation,
> closed write schemas, chain-authoritative reconciliation, honest maturity labels); its
> ~40-tool surface, default byte-envelopes, launch-blocking infrastructure, and unverified
> baked decisions do not. Every carried technical claim in this RFC is traced to
> `notes/verification-log.md` (C-codes below), verified against deployed Phoenix contracts on a
> mainnet fork, Sourcify, and `api-phoenix.cork.tech` before being stated as fact.

## 1. Summary

`cork` is one strictly-typed TypeScript core with three projections generated from a single
variant registry: a **CLI** (human noun-verb tree + script JSON contract) and an **MCP server**
(`cork mcp serve`) that exposes **9 closed, Cork-typed polymorphic tools** to agents. The server
prepares transaction bytes, typed-data requests, and labeled reads; it **never holds keys, signs,
confirms, or broadcasts**. The one service-side mutation is relaying a caller-signed limit order.

The 9 MCP tools are `cork_query`, `cork_compute`, `cork_decode`, `cork_prepare_phoenix`,
`cork_prepare_orders`, `cork_prepare_market`, `cork_track`, `cork_capabilities`, and the sole
side-effecting `cork_submit`. Variety lives *inside* each tool as discriminated unions with closed
enums — never a generic selector/calldata passthrough on the MCP surface. Generic escape hatches
(`eth_call`, arbitrary decode, `cast`/`gh`/`anvil` wrapping) exist **only in the CLI lane**.

The design is grounded in measured agent-tool-use research (deferred loading: 85% token cut,
49→74% tool-selection; three input examples: 72→90% parameter accuracy — C13) and in empirical
contract verification: the CorkAdapter's 13 Bundler3 actions (C1), the token-bucket impairment
floor whose worst case is provably *not* `minRate` (C7), the Fusion auction math for future
Dutch orders (C6), and the live `api-phoenix.cork.tech` query surface (C9).

## 2. Motivation & Problems

Agents (Claude and non-Claude hosts, plus external partners onboarding early) are the primary
consumers. Cork's on-chain surface is easy to misread as raw hex, and the highest-value state —
time-dependent impairment floors, auction prices — is not directly readable and must be computed
deterministically so an LLM never does the arithmetic. RFC-010 tried to serve this and produced
eight concrete failures (`notes/rfc010issues.md`), summarized as problems this RFC must solve:

| # | Problem (RFC-010) | This RFC |
|---|---|---|
| P1 | ~40 registered tools → context bloat + wrong-tool selection | 9 polymorphic tools; variants inside closed schemas (§5) |
| P2 | Redundant tools (submit ×2, revoke ×2, `market.verify` dup, `authority.inspect` as its own family) | merged: authority = query read; revoke/onboard = prepare variants; verify = `cork_track` (§5, §4) |
| P3 | base64 byte-envelope on every read = token tax | concise-by-default; `format:"full"` opt-in; provenance = source+digest+timestamp only (§6) |
| P4 | `foo.v1` version-suffixed tool names | version lives in the envelope, never the name (§6) |
| P5 | key ceremonies / quorums / transparency log / signing-gate service as launch blockers | principles kept as invariants; heavy mechanics moved to Deferred Hardening (§12) |
| P6 | unverified claims frozen as normative fact (incl. an unmerged-branch pin) | every carried claim verified (C1–C13) or marked OPEN (§15) |
| P7 | six product requirements missing (enrichment, time-dependent state, RFQ, tool search, data modes, GitHub config) | all six are first-class (§4 R2/R6, §7, §8, §5 `cork_capabilities`) |
| P8 | banned the generic escape hatch our own devs need | lane split: CLI generic, MCP closed (§3) |

## 3. Product Definition — two lanes over one core

One core library (`@corkprotocol/core`, importable) with two frontends generated from the same
variant registry, so the three projections cannot drift:

| Audience | Projection | Optimized for |
|---|---|---|
| Agents (MCP) | 9 polymorphic tools | context economy, closed schemas, self-correction |
| Humans (TTY) | noun-verb command tree + aliases + sticky context | memorability, discoverability |
| Scripts (CI) | same commands + `--json` + stable envelope + exit codes | parseability, safe retries |

**Absolute invariants (kernel — stated once, referenced everywhere):**

- **K1 No custody.** Never holds keys, signs, confirms Safe txs, or broadcasts. Outputs are
  unsigned bundles, EIP-712 typed-data requests, and calldata. The only service mutation
  (`cork_submit`) relays a caller-signed payload.
- **K2 Determinism.** Identical validated inputs + identical observed chain state ⇒ identical
  canonical outputs and executable bytes. The caller supplies `clientRequestId`; the **canonical
  artifact digest is derived, never random**, and keys idempotency (§9).
- **K3 Untrusted re-presentation.** Any caller-held artifact (a prepared bundle, an order hash)
  is re-validated / reconstructed before new executable bytes are returned; a digest without a key
  proves nothing.
- **K4 Closed write schemas.** Every byte-producing variant has an exact schema (closed enums; no
  arbitrary selector/target/calldata on the MCP surface).
- **K5 Enriched output.** Every result is labeled JSON with human/agent-readable field labels and
  a doc reference, versioned against config/deployment (§8).
- **K6 Context economy.** Concise by default; verbose evidence (raw upstream payloads,
  byte-level provenance) is `format:"full"` opt-in — never default (§6).
- **K7 Chain-over-indexer.** In reconciliation, chain evidence outranks indexer/service claims;
  disagreement is an explicit `conflict` state, never a silent pick (§10).

**Lane split (P8).** The **MCP registration list is closed and Cork-typed** — no
`eth_call`/raw-RPC/arbitrary-calldata tool is registered. The **CLI lane** MAY expose
`cork raw call|decode|rpc`, `cork cast -- <args>`, `cork gh -- <args>` (wrapped + enriched), and
`cork fork` (anvil orchestration). Wrapping existing CLIs is legitimate engineering, confined to
the lane a human developer drives.

### 3.1 CLI lane — normative surface (so §14's parity gate has a spec to test)

`notes/cork-cli-human-ux.md` is **normative** for the CLI projection; this subsection pins the
contract the drift-parity test (§14) consumes. All three projections are generated from the one
variant registry — a new variant appears in the MCP tool, the CLI subcommand, and the TS types in
the same release, so they cannot drift.

- **Command tree:** noun-verb, one level where possible (`cork markets ls`, `cork orderbook
  --market X`, `cork rate swap <pool> <amt>`, `cork tx unwind <args>`, `cork order make|fill|cancel`,
  `cork status <tx|order|artifact>`). Each subcommand is a curried invocation of one core primitive
  with the variant pre-bound. `cork call <tool> [json]` invokes any of the 9 tools with raw JSON.
- **Currying cascade (highest wins):** flag → env (`CORK_CHAIN`, `CORK_MODE`, `CORK_RPC_URL`,
  `CORK_FORMAT`) → sticky context (`cork use chain|market|mode`) → project `cork.toml` → user
  config → built-in defaults. `cork config where <key>` prints which layer supplied a value.
- **`--explain`** on any command prints the equivalent MCP tool-call JSON (the parity bridge; §14
  asserts `--explain` output equals the MCP call it prints).
- **Output:** human table on a TTY, **JSON when piped** (auto-detect; `--json`/`--table`
  override); `NO_COLOR` honored; missing required args prompt only on a TTY and otherwise
  hard-fail with a copy-pasteable corrected example (never hang CI).
- **Automation:** `--request-id` (surfaces `clientRequestId`), `--dry-run` (print what would be
  sent, exit 0), `--wait [--timeout]` (block until confirmed), `--output ndjson` for long lists.
- **Exit-code contract (the surface §14 parity-tests; renumbered 2026-07-20 to match the shipped
  implementation — this table is canonical, earlier drafts of this section are superseded):**
  `0` success · `1` unexpected/internal error (incl. transport failures that escape the envelope) ·
  `2` invalid input (schema rejection or malformed `--json`) · `3` unavailable (honest gating:
  requires_rpc / needs_* / phase_gated / chain_read_failed / pool_not_found) · `4` conflict
  (chain-vs-service disagreement, K7). Once a tool is dispatched, errors are structured JSON on
  stderr — one object per line, `{"error":{"code","tool",…}}` with the same closed codes as the
  MCP lane (§6): `invalid_json`, `invalid_input` (carries the validation issues), `internal_error`.
  CLI-usage errors from the command parser (unknown command, `--help`) remain human text. stdout
  stays pure data (the envelope) in every case.
- **Delivery:** the read/math CLI ships with Phase 1; write subcommands track their MCP phase
  (§11).

## 4. Requirements (deduplicated baseline + empirical corrections)

From `notes/cork-cli-mcp-requirements-v2.md`, each requirement stated once at its deepest layer.
Empirical corrections flagged **[C#]** with the verification-log code.

### R1 — Query (read any Cork resource) → `cork_query`
Markets/pools (full 8-field `Market` tuple + `MarketId`), pool whitelist status + whitelisted
addresses, flows/action history, limit-order markets/orderbook/fills, account state (balances,
classic + Permit2 allowances, nonce/invalidator state, Safe config), off-chain metadata
(governor/dev-set flags), protocol config (addresses, fees, rate bounds). Every list result
reports `{complete, pagesRead, cursor, ordering}` — the CLI's own envelope, **not** trusting
upstream completeness **[C9: api-phoenix `/pools/` pagination is weakly specified]**. "Authority
inspection" is a read, folded here (P2).

### R2 — Compute (deterministic math over verified state) → `cork_compute`
- CST-swap rate via `previewSwap`; unwind rate via `previewUnwindSwap` — on-chain views **[C3]**.
- Current price of a **Dutch-auction (1inch Fusion) order** — local decode + interpolation
  **[C6: no Dutch auction in prod today; Fusion is the mechanism; Phase 3]**.
- **Rollover premium floor** — a *fixed* `minPremiumPerShare`, not a time curve **[C8]**.
- **Max REF impairment vs matching cST** — the rate-limited floor over a horizon; **worst case ≠
  `minRate`** — local committed-descent model, no on-chain view exists **[C7, highest-value]**.
- **RFQ quote** (hybrid local+remote): per-market LLM-assessed config cached in a shared DB;
  50–100 pre-seeded tokens with precomputed risk metrics; inputs = market-type bucket, duration,
  token risk stats. Deferred to Phase 3+ pending the config pipeline.
- **Parity guarantee:** every off-chain reimplementation of contract math is property-tested
  against time-warped fork `eth_call`s in CI; prefer `eth_call` whenever a view exists (§14).

### R3 — Decode (bytes → labeled JSON) → `cork_decode`
Cork TX calldata (recursively unwraps Bundler3 `multicall` → per-leg ABI decode **[C2]**), limit
orders (decode/sort/filter, incl. makerTraits + Fusion extension **[C5, C6]**), protocol events,
receipts. CLI lane adds arbitrary calldata via 4byte/ABI resolution.

### R4 — Prepare (unsigned artifacts) → `cork_prepare_phoenix` / `_orders` / `_market`
- **Every CorkPoolAdapter action.** **[C1 CORRECTION]** All **13 `safe*` actions are buildable
  today** — the "6 buildable / 7 specified-but-unavailable" split is dropped. Each is an
  `onlyBundler3` action bounded by exact + `min*`/`max*` struct fields; residual handling is a
  bundle-composition concern (add a sweep leg), not an availability gate **[C2]**.
- **Token authority:** standing Permit2 onboarding (where policy allows), exact per-operation
  authorization, allowance revocation (`approve(spender,0)`) — one revoke operation, not two (P2).
- **Limit-order lifecycle (Phase 3):** maker construction + EIP-712 typed-data, taker fill,
  cancellation/invalidation against pinned 1inch LOP v4 **[C5]**; Fusion orders when live **[C6]**.
- **Market deployment (Phase 4):** wrap existing automation + permissionless
  `MarketRegistry.deploy(ca, ref)` — **surface unverified [C11: OPEN Q-REG]**; schema stubbed.
- **Safe support (phased):** message-signature vs tx-confirmation are distinct stages; one exact
  supported config first.

### R5 — Track (verify / simulate / reconcile) → `cork_track` (+ `cork_submit` for submission)
Verify a resource against deployed state before an action uses it; advisory simulation of frozen
bytes (fork or provider); reconcile caller receipts/order-hashes/submission refs into closed
lifecycle states with **K7** (chain outranks indexer; disagreement = `conflict`). Signed-order
submission (the single service mutation) with durable derived idempotency (§9, §10).

### R6 — Meta (discovery, enrichment, config) → `cork_capabilities` + `cork_config`(CLI) + kernel
Capability/maturity discovery (`specified | implemented | activated | healthy` with
machine-readable unavailability reasons); tool/variant search (keyword → exact tool + variant +
filled invocation template — satisfies the tool-search goal without registering 40 schemas);
addresses/config from GitHub (`cork-defaults.json`, phoenix `config/prod.toml`), cached with
TTL + provenance, CREATE2-verifiable, never hardcoded **[C10]**; enrichment tables versioned
against config/deployment.

### Cross-cutting engineering [CONV]
> **Runtime amendment (ratified 2026-07-20):** the implementation is **Bun-only** (`engines: bun>=1.3`).
> The sources use TypeScript parameter properties + `.ts` import specifiers, which Node's native
> type-stripping rejects — "Node LTS primary" below is superseded; a Node-runnable build would
> require an emit step and is deliberately not a v1 requirement.

TS strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); **one schema source**
(zod v4) → MCP schemas + CLI flags + TS types; viem/abitype at the typed boundary; optional
napi-rs/alloy addon for fork orchestration / embedded HyperSync / heavy math; HyperSync via the
Envio Node client (already napi-over-Rust — no in-house addon needed **[C12]**); Node LTS primary,
Bun-compatible; npx/binary distribution; anvil / Tenderly-vnet empirical test rig; `tsc --noEmit`
+ property tests + golden vectors in CI. MCP: pin the current stable protocol era; newer eras are
a compatibility task, not a dual normative requirement (P5 anti-pattern avoided).

## 5. Tool Surface — the 9 baseline tools (complete schemas)

All schemas are JSON-Schema-2020-12 (MCP 2025-11-25 default **[C13]**), generated from one zod v4
source. Shared conventions: the discriminator (`resource` / `kind` / `action.type`) is the FIRST
property; every enum value AND every `oneOf` branch carries a one-line `description`; every
polymorphic input closes over its discriminator with `oneOf` + `additionalProperties:false`
branches (`cork_compute.params` and `cork_track.subject` included — see §5.2/§5.7). The **one
deliberate open exception** is `cork_query.filters`: filters are numerous and resource-scoped, so
`filters` is an open object whose legal keys per resource are documented in `cork_capabilities`,
not closed at the schema — this exception is explicit, not accidental. bigints are decimal
strings; addresses/hex are `pattern` strings; `format:"concise"|"full"` (default concise) and
`chainId` appear on every tool.

**Examples & docs placement (reconciles K6 context-economy with §13 accuracy).** Deep per-variant
docs and the long-tail example set live behind `cork_capabilities` (progressive disclosure), NOT
in the registered schema. The **three hot-variant input examples §13 names — orderbook fetch
(`cork_query`), unwind prepare (`cork_prepare_phoenix`), dutch-auction price (`cork_compute`) —
ship inline** in their tool's registered schema as `examples`, because measured parameter accuracy
(72→90%, C13) matters most on exactly the complex first-call paths and the round-trip they would
otherwise cost lands on the write path. Everything beyond those three is on-demand via
`cork_capabilities`.

### 5.0 Shared `$defs` (referenced by all tools)

```json
{
  "$defs": {
    "Address": {"type":"string","pattern":"^0x[0-9a-fA-F]{40}$","description":"EVM address"},
    "Hex":     {"type":"string","pattern":"^0x[0-9a-fA-F]*$","description":"0x-prefixed hex"},
    "Bytes32": {"type":"string","pattern":"^0x[0-9a-fA-F]{64}$"},
    "MarketId":{"$ref":"#/$defs/Bytes32","description":"keccak256(abi.encode(Market)) — 8-field struct hash [C1]"},
    "Uint":    {"type":"string","pattern":"^[0-9]+$","description":"unsigned integer, decimal string (bigint on the wire)"},
    "ChainId": {"type":"integer","enum":[1,42161,8453,11155111,49222],"description":"1=mainnet,42161=arbitrum,8453=base (rollover staging),11155111=sepolia,49222=cork-virtual-staging"},
    "DataMode":{"type":"string","enum":["centralized","lite-decentralized","full-decentralized"],"description":"explicit; never silent-fallback [§7]"},
    "Format":  {"type":"string","enum":["concise","full"],"default":"concise"},
    "ClientRequestId":{"type":"string","minLength":8,"maxLength":128,"description":"caller-chosen idempotency key — reuse it when retrying the same request; deadlines are wall-clock + duration, so bytes re-anchor in time on a later retry [K2]"}
  }
}
```

### 5.1 `cork_query` (R1) — readOnlyHint:true

```json
{
  "name":"cork_query",
  "description":"Read any Cork resource (markets, whitelist, orderbook, fills, flows, account state, protocol config). Use for STATE READS. Do NOT use for derived math (rates, prices, impairment floor) — use cork_compute. Do NOT use to build transactions — use cork_prepare_*. Examples in cork_capabilities topic 'query'.",
  "annotations":{"readOnlyHint":true,"idempotentHint":true,"openWorldHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["resource"],
    "properties":{
      "resource":{"type":"string","enum":[
        "markets","market","pool-whitelist","whitelisted-addresses","flows",
        "limit-order-markets","orderbook","fills","account-state","protocol-config"],
        "description":"markets — list pools; market — one pool's full Market tuple + constraint state; pool-whitelist — isMarketWhitelistEnabled + status; whitelisted-addresses — per-account rows; flows — user action history; limit-order-markets — (chain,pool,makerAsset,takerAsset) rows; orderbook — open LOP orders; fills — executed trades; account-state — balances + classic & Permit2 allowances + nonce/invalidator + Safe config; protocol-config — addresses/fees/rate-bounds"},
      "chainId":{"$ref":"#/$defs/ChainId"},
      "mode":{"$ref":"#/$defs/DataMode"},
      "filters":{"type":"object","description":"resource-scoped; e.g. {poolId, expiryBefore, expiryAfter, poolWhitelistStatus, maker, taker, sinceBlock, sinceTimestamp}"},
      "cursor":{"type":"string"},
      "pageSize":{"type":"integer","minimum":1,"maximum":200,"default":25},
      "format":{"$ref":"#/$defs/Format"}
    },
    "examples":[
      {"resource":"orderbook","chainId":42161,"filters":{"poolId":"0xc0bafd4bb989adf53cd1c8a6e848afef922ab1b958281f91c0af70bc37f8dd1a"},"format":"concise"},
      {"resource":"fills","chainId":42161,"filters":{"poolId":"0xc0ba…","sinceTimestamp":"1752537600"}}
    ]
  }
}
```

### 5.2 `cork_compute` (R2) — readOnlyHint:true

```json
{
  "name":"cork_compute",
  "description":"Deterministic math over verified chain state: swap/unwind rates, Dutch-auction (Fusion) price, rollover premium floor, worst-case impairment floor over a horizon, RFQ quote. Use for DERIVED VALUES. Do NOT use for raw reads (cork_query) or byte-building (cork_prepare_*). Every result cites the state snapshot it was computed from.",
  "annotations":{"readOnlyHint":true,"idempotentHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["kind","params"],
    "properties":{
      "kind":{"type":"string","enum":[
        "cst-swap-rate","unwind-rate","dutch-auction-price","rollover-premium-floor","impairment-floor","rfq-quote"],
        "description":"cst-swap-rate — previewSwap(poolId,caOut)→(cstIn,refIn,fee) [C3]; unwind-rate — previewUnwindSwap incl. time-decay fee [C3]; dutch-auction-price — 1inch Fusion piecewise-linear rate bump at t [C6, Phase 3]; rollover-premium-floor — fixed minPremiumPerShare, NOT a decay curve [C8]; impairment-floor — worst reachable swapRate over horizon Δt via committed-descent, NOT minRate [C7]; rfq-quote — hybrid local+remote [Phase 3+]"},
      "params":{"type":"object","description":"closed per-kind (oneOf keyed by the sibling `kind`); a wrong/missing key fails at schema-validation, not runtime [mechanic §1: nothing stringly-typed]","oneOf":[
        {"title":"cst-swap-rate","additionalProperties":false,"required":["poolId","collateralAssetsOut"],"properties":{"poolId":{"$ref":"#/$defs/MarketId"},"collateralAssetsOut":{"$ref":"#/$defs/Uint"}}},
        {"title":"unwind-rate","additionalProperties":false,"required":["poolId","collateralAssetsIn"],"properties":{"poolId":{"$ref":"#/$defs/MarketId"},"collateralAssetsIn":{"$ref":"#/$defs/Uint"}}},
        {"title":"dutch-auction-price","additionalProperties":false,"required":["order"],"properties":{"order":{"type":"object","description":"LOP v4 order incl. Fusion extension"},"baseFeeWei":{"$ref":"#/$defs/Uint","description":"omit ⇒ upper-bound price (gas bump = 0)"}}},
        {"title":"rollover-premium-floor","additionalProperties":false,"required":["srcPoolId","dstPoolId","minPremiumPerShare","dstCstProduced"],"properties":{"srcPoolId":{"$ref":"#/$defs/MarketId"},"dstPoolId":{"$ref":"#/$defs/MarketId"},"minPremiumPerShare":{"$ref":"#/$defs/Uint"},"dstCstProduced":{"$ref":"#/$defs/Uint"}}},
        {"title":"impairment-floor","additionalProperties":false,"required":["poolId","horizonSeconds"],"properties":{"poolId":{"$ref":"#/$defs/MarketId"},"horizonSeconds":{"type":"integer","minimum":0}}},
        {"title":"rfq-quote","additionalProperties":false,"required":["marketTypeBucket","durationSeconds"],"properties":{"marketTypeBucket":{"type":"string"},"durationSeconds":{"type":"integer","minimum":0},"tokenRiskStats":{"type":"object"}}}
      ]},
      "chainId":{"$ref":"#/$defs/ChainId"},
      "at":{"type":"object","description":"optional pin: {block} or {timestamp}; default = latest observed","additionalProperties":false,"properties":{"block":{"$ref":"#/$defs/Uint"},"timestamp":{"$ref":"#/$defs/Uint"}}},
      "format":{"$ref":"#/$defs/Format"}
    },
    "examples":[
      {"kind":"impairment-floor","chainId":1,"params":{"poolId":"0xe855cf62e91b7a8690349d3834a36f07bb2ee2965d9db1d3bf1de2bd55ee6296","horizonSeconds":2592000}},
      {"kind":"dutch-auction-price","chainId":42161,"params":{"order":{"salt":"…","makerTraits":"…","extension":"0x2Ad5004c…"},"baseFeeWei":"0"}}
    ]
  }
}
```

> **Impairment-floor formula (normative, C7).** Read `(lastAdjustedRate, lastAdjustmentTimestamp,
> remainingCredits)` from permissionless `constraints(poolId)` and `(rateMin, rateChangePerDayMax,
> rateChangeCapacityMax)` from `market(poolId)`. `constraints()` returns `remainingCredits` as of
> `lastAdjustmentTimestamp`, NOT refilled to now — so **first advance the bucket to the evaluation
> instant `tEval`**, then apply the horizon `Δt` (measured from `tEval`):
> ```
> avail      = min(rateChangeCapacityMax,
>                  remainingCredits + rateChangePerDayMax·(tEval − lastAdjustmentTimestamp)/86400)
> worstRate  = max(rateMin, lastAdjustedRate − (avail + rateChangePerDayMax·Δt/86400))
> ```
> Max REF per 1e18 cST = `ceil(1e18 / worstRate)`. Omitting the `(tEval − lastAdjustmentTimestamp)`
> refill term understates reachable descent by up to one `rateChangeCapacityMax` (adjustments are
> sparse — ~2 commits / 40 days on mainnet, C7) and makes the bound optimistic in the dangerous
> direction. The on-chain `swapRate` preview can never show more than one bucket of movement, so
> this MUST be computed locally and MUST be labeled a *worst-case projection*, not a current quote.
> Parity CI (§14) pins this exact basis against the committed-descent fork harness.

### 5.3 `cork_decode` (R3) — readOnlyHint:true

```json
{
  "name":"cork_decode",
  "description":"Decode bytes to labeled JSON: Cork calldata (recursively unwraps Bundler3 multicall into per-leg actions), a limit order (LOP v4 struct + makerTraits + Fusion extension if present), a protocol event, or a receipt. Use to explain what a blob DOES. Reconstructs, never trusts a caller-supplied parse [K3].",
  "annotations":{"readOnlyHint":true,"idempotentHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["kind","data"],
    "properties":{
      "kind":{"type":"string","enum":["calldata","order","event","receipt"],
        "description":"calldata — hex tx input (Bundler3 multicall aware); order — LOP v4 order struct or its encoded form; event — a log (topics+data); receipt — a tx hash or receipt object to classify"},
      "data":{"description":"hex string (calldata/event) or object (order/receipt)","oneOf":[{"$ref":"#/$defs/Hex"},{"type":"object"}]},
      "chainId":{"$ref":"#/$defs/ChainId"},
      "format":{"$ref":"#/$defs/Format"}
    }
  }
}
```

### 5.4 `cork_prepare_phoenix` (R4 adapter actions + token authority) — readOnlyHint:true (builds bytes, executes nothing)

The `action` discriminated union spans all 13 `safe*` actions **[C1]** plus 2 authority variants.
Every variant produces a full Bundler3 bundle (fund → action → optional sweep) **[C2]** with a
human summary and pre-flight guards (whitelist, paused bitmap, expiry, deadline).

> **Normative note (union size).** This union is **15 variants**, exceeding the ≤8-variant
> guideline in requirements §3 (that guideline predated the C1 finding of 13 real actions). Per the
> growth rule, a 3-way sub-split — `_phoenix_mint` {mint,deposit,unwindDeposit,unwindMint},
> `_phoenix_coverage` {swap,exercise,exerciseOther,unwindSwap,unwindExercise,unwindExerciseOther},
> `_phoenix_settle` {withdraw,withdrawOther,redeem} + authority — is a **registered eval candidate**
> (§13). It ships only if it beats the single-family baseline in the agent-eval suite; until then
> `cork_prepare_phoenix` stays one family tool.

> **Per-variant descriptions (normative — codegen injects each into its `oneOf` branch's
> `description`; mechanic §2.1).** Bare contract-function titles do not let an agent pick among 5
> unwind / 3 exercise variants; each branch below carries this one-liner:
>
> | action.type | one-line description (populates the branch `description`) |
> |---|---|
> | `mint` | exact cPT+cST shares out; CA pulled ≤ maxCollateralAssetsIn; **pre-expiry** |
> | `deposit` | exact CA in → cPT+cST shares ≥ minCptAndCstSharesOut; **pre-expiry** |
> | `unwind-deposit` | burn cPT+cST for exact CA out (≤ maxCptAndCstSharesIn burned); **pre-expiry** |
> | `unwind-mint` | burn exact cPT+cST for CA ≥ min; uint256.max = owner min(cPT,cST); **pre-expiry** |
> | `withdraw` | burn cPT for exact CA + pro-rata REF; **post-expiry** |
> | `withdraw-other` | burn cPT for exact REF + pro-rata CA; **post-expiry** |
> | `redeem` | burn cPT for pro-rata CA+REF; uint256.max = owner cPT; **post-expiry** |
> | `swap` | receive exact CA out; spend cST ≤ max + REF ≤ max (coverage payout, exact-out); **pre-expiry** |
> | `exercise` | lock exact cST in; CA ≥ min; REF cost ≤ max; **pre-expiry** |
> | `exercise-other` | spend exact REF in; CA ≥ min; cST locked ≤ max; **pre-expiry** |
> | `unwind-swap` | deposit CA in → unlock cST ≥ min + REF ≥ min (reverse of swap); **pre-expiry** |
> | `unwind-exercise` | unlock exact cST out; CA cost ≤ max; REF ≥ min; **pre-expiry** |
> | `unwind-exercise-other` | unlock exact REF out; CA cost ≤ max; cST ≥ min; **pre-expiry** |
> | `authority-onboard` | Permit2 standing/scoped approval for (token, spender) |
> | `authority-revoke` | set (token, spender) approval to 0 |

```json
{
  "name":"cork_prepare_phoenix",
  "description":"Build an unsigned Bundler3 bundle for a Cork Phoenix adapter action (mint/deposit, swap/exercise coverage, unwind, withdraw/redeem) or a token-authority operation (Permit2 onboard, allowance revoke). Returns bytes intended for LATER signing — executes nothing [K1]. Use cork_prepare_orders for limit orders, cork_prepare_market for deployment. Deterministic for identical inputs + observed state; the deadline is wall-clock + deadlineSeconds [K2].",
  "annotations":{"readOnlyHint":true,"idempotentHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["action","account","chainId","clientRequestId"],
    "properties":{
      "chainId":{"$ref":"#/$defs/ChainId"},
      "account":{"$ref":"#/$defs/Address","description":"bundle initiator; MUST be whitelisted for poolId when the pool's whitelist is enabled"},
      "clientRequestId":{"$ref":"#/$defs/ClientRequestId"},
      "fundingMode":{"type":"string","enum":["permit2","erc20-approve","pre-funded"],"default":"permit2","description":"how input tokens reach the adapter before the action leg [C2]"},
      "deadlineSeconds":{"type":"integer","minimum":1,"maximum":86400,"default":1800,"description":"relative deadline baked into the action struct"},
      "format":{"$ref":"#/$defs/Format"},
      "action":{
        "type":"object","description":"discriminated on action.type",
        "oneOf":[
          {"title":"safeMint","additionalProperties":false,"required":["type","poolId","cptAndCstSharesOut","receiver","maxCollateralAssetsIn"],"properties":{"type":{"const":"mint"},"poolId":{"$ref":"#/$defs/MarketId"},"cptAndCstSharesOut":{"$ref":"#/$defs/Uint"},"receiver":{"$ref":"#/$defs/Address"},"maxCollateralAssetsIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeDeposit","additionalProperties":false,"required":["type","poolId","collateralAssetsIn","receiver","minCptAndCstSharesOut"],"properties":{"type":{"const":"deposit"},"poolId":{"$ref":"#/$defs/MarketId"},"collateralAssetsIn":{"$ref":"#/$defs/Uint"},"receiver":{"$ref":"#/$defs/Address"},"minCptAndCstSharesOut":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeUnwindDeposit","additionalProperties":false,"required":["type","poolId","collateralAssetsOut","owner","receiver","maxCptAndCstSharesIn"],"properties":{"type":{"const":"unwind-deposit"},"poolId":{"$ref":"#/$defs/MarketId"},"collateralAssetsOut":{"$ref":"#/$defs/Uint"},"owner":{"$ref":"#/$defs/Address"},"receiver":{"$ref":"#/$defs/Address"},"maxCptAndCstSharesIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeUnwindMint","additionalProperties":false,"required":["type","poolId","cptAndCstSharesIn","owner","receiver","minCollateralAssetsOut"],"properties":{"type":{"const":"unwind-mint"},"poolId":{"$ref":"#/$defs/MarketId"},"cptAndCstSharesIn":{"$ref":"#/$defs/Uint","description":"type(uint256).max sentinel = owner min(cPT,cST) balance/allowance [C1]"},"owner":{"$ref":"#/$defs/Address"},"receiver":{"$ref":"#/$defs/Address"},"minCollateralAssetsOut":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeWithdraw (post-expiry)","additionalProperties":false,"required":["type","poolId","collateralAssetsOut","owner","receiver","maxCptSharesIn"],"properties":{"type":{"const":"withdraw"},"poolId":{"$ref":"#/$defs/MarketId"},"collateralAssetsOut":{"$ref":"#/$defs/Uint"},"owner":{"$ref":"#/$defs/Address"},"receiver":{"$ref":"#/$defs/Address"},"maxCptSharesIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeWithdrawOther (post-expiry)","additionalProperties":false,"required":["type","poolId","referenceAssetsOut","owner","receiver","maxCptSharesIn"],"properties":{"type":{"const":"withdraw-other"},"poolId":{"$ref":"#/$defs/MarketId"},"referenceAssetsOut":{"$ref":"#/$defs/Uint"},"owner":{"$ref":"#/$defs/Address"},"receiver":{"$ref":"#/$defs/Address"},"maxCptSharesIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeRedeem (post-expiry)","additionalProperties":false,"required":["type","poolId","cptSharesIn","owner","receiver","minReferenceAssetsOut","minCollateralAssetsOut"],"properties":{"type":{"const":"redeem"},"poolId":{"$ref":"#/$defs/MarketId"},"cptSharesIn":{"$ref":"#/$defs/Uint","description":"type(uint256).max sentinel = owner cPT balance (owner==adapter) or owner→adapter allowance (CorkAdapter.sol:331-335) — same resolution as unwind-mint [C1/DC-1]"},"owner":{"$ref":"#/$defs/Address"},"receiver":{"$ref":"#/$defs/Address"},"minReferenceAssetsOut":{"$ref":"#/$defs/Uint"},"minCollateralAssetsOut":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeSwap","additionalProperties":false,"required":["type","poolId","collateralAssetsOut","receiver","maxCstSharesIn","maxReferenceAssetsIn"],"properties":{"type":{"const":"swap"},"poolId":{"$ref":"#/$defs/MarketId"},"collateralAssetsOut":{"$ref":"#/$defs/Uint"},"receiver":{"$ref":"#/$defs/Address"},"maxCstSharesIn":{"$ref":"#/$defs/Uint"},"maxReferenceAssetsIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeExercise","additionalProperties":false,"required":["type","poolId","cstSharesIn","receiver","minCollateralAssetsOut","maxReferenceAssetsIn"],"properties":{"type":{"const":"exercise"},"poolId":{"$ref":"#/$defs/MarketId"},"cstSharesIn":{"$ref":"#/$defs/Uint"},"receiver":{"$ref":"#/$defs/Address"},"minCollateralAssetsOut":{"$ref":"#/$defs/Uint"},"maxReferenceAssetsIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeExerciseOther","additionalProperties":false,"required":["type","poolId","referenceAssetsIn","receiver","minCollateralAssetsOut","maxCstSharesIn"],"properties":{"type":{"const":"exercise-other"},"poolId":{"$ref":"#/$defs/MarketId"},"referenceAssetsIn":{"$ref":"#/$defs/Uint"},"receiver":{"$ref":"#/$defs/Address"},"minCollateralAssetsOut":{"$ref":"#/$defs/Uint"},"maxCstSharesIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeUnwindSwap","additionalProperties":false,"required":["type","poolId","collateralAssetsIn","receiver","minReferenceAssetsOut","minCstSharesOut"],"properties":{"type":{"const":"unwind-swap"},"poolId":{"$ref":"#/$defs/MarketId"},"collateralAssetsIn":{"$ref":"#/$defs/Uint","description":"uint256.max sentinel = adapter CA balance"},"receiver":{"$ref":"#/$defs/Address"},"minReferenceAssetsOut":{"$ref":"#/$defs/Uint"},"minCstSharesOut":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeUnwindExercise","additionalProperties":false,"required":["type","poolId","cstSharesOut","receiver","minReferenceAssetsOut","maxCollateralAssetsIn"],"properties":{"type":{"const":"unwind-exercise"},"poolId":{"$ref":"#/$defs/MarketId"},"cstSharesOut":{"$ref":"#/$defs/Uint"},"receiver":{"$ref":"#/$defs/Address"},"minReferenceAssetsOut":{"$ref":"#/$defs/Uint"},"maxCollateralAssetsIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"safeUnwindExerciseOther","additionalProperties":false,"required":["type","poolId","referenceAssetsOut","receiver","minCstSharesOut","maxCollateralAssetsIn"],"properties":{"type":{"const":"unwind-exercise-other"},"poolId":{"$ref":"#/$defs/MarketId"},"referenceAssetsOut":{"$ref":"#/$defs/Uint"},"receiver":{"$ref":"#/$defs/Address"},"minCstSharesOut":{"$ref":"#/$defs/Uint"},"maxCollateralAssetsIn":{"$ref":"#/$defs/Uint"}}},
          {"title":"authority-onboard (Permit2)","additionalProperties":false,"required":["type","token","spender"],"properties":{"type":{"const":"authority-onboard"},"token":{"$ref":"#/$defs/Address"},"spender":{"$ref":"#/$defs/Address"},"amount":{"$ref":"#/$defs/Uint","description":"omit for max standing allowance where policy allows"}}},
          {"title":"authority-revoke","additionalProperties":false,"required":["type","token","spender"],"properties":{"type":{"const":"authority-revoke"},"token":{"$ref":"#/$defs/Address"},"spender":{"$ref":"#/$defs/Address"},"description":"sets approval to 0 — single revoke op (P2)"}}
        ]
      }
    },
    "examples":[
      {"chainId":1,"account":"0xC0FFEE0000000000000000000000000000000001","clientRequestId":"unwind-2026-07-16-001","fundingMode":"permit2","action":{"type":"unwind-swap","poolId":"0xe855cf62e91b7a8690349d3834a36f07bb2ee2965d9db1d3bf1de2bd55ee6296","collateralAssetsIn":"1000000000000000000","receiver":"0xC0FFEE0000000000000000000000000000000001","minReferenceAssetsOut":"0","minCstSharesOut":"0"}}
    ]
  }
}
```

### 5.5 `cork_prepare_orders` (R4 limit-order lifecycle — Phase 3) — readOnlyHint:true

```json
{
  "name":"cork_prepare_orders",
  "description":"Build unsigned limit-order lifecycle artifacts. maker-order/taker-fill/cancel sign under the 1inch LOP v4 EIP-712 domain {name:'1inch Aggregation Router',version:'6',verifyingContract:LOP}. rollover-intent is a DIFFERENT protocol: ERC-7683 signed under the CorkSettler domain {name:'CorkSettler',version:'1.0.0',verifyingContract:<settler>} [C8] — its variant carries the settler binding explicitly. Returns typed-data for LATER signing [K1]. Submission is cork_submit. Pricing is cork_compute.",
  "annotations":{"readOnlyHint":true,"idempotentHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["action","account","chainId","clientRequestId"],
    "properties":{
      "chainId":{"$ref":"#/$defs/ChainId"},
      "account":{"$ref":"#/$defs/Address"},
      "clientRequestId":{"$ref":"#/$defs/ClientRequestId"},
      "format":{"$ref":"#/$defs/Format"},
      "action":{"type":"object","description":"discriminated on action.type","oneOf":[
        {"title":"maker-order","additionalProperties":false,"required":["type","poolId","side","makerAsset","takerAsset","makingAmount","takingAmount"],"properties":{"type":{"const":"maker-order"},"poolId":{"$ref":"#/$defs/MarketId"},"side":{"type":"string","enum":["BUY","SELL"],"description":"BUY = offer CA for cork token; SELL = offer cPT/cST for CA [C5]"},"makerAsset":{"$ref":"#/$defs/Address"},"takerAsset":{"$ref":"#/$defs/Address"},"makingAmount":{"$ref":"#/$defs/Uint"},"takingAmount":{"$ref":"#/$defs/Uint"},"expirySeconds":{"type":"integer","minimum":1},"allowsPartialFills":{"type":"boolean","default":true},"usePermit2":{"type":"boolean","default":false}}},
        {"title":"taker-fill","additionalProperties":false,"required":["type","orderHash"],"properties":{"type":{"const":"taker-fill"},"orderHash":{"$ref":"#/$defs/Bytes32"},"fillMakingAmount":{"$ref":"#/$defs/Uint"}}},
        {"title":"cancel","additionalProperties":false,"required":["type","orderHash","makerTraits"],"properties":{"type":{"const":"cancel"},"orderHash":{"$ref":"#/$defs/Bytes32"},"makerTraits":{"$ref":"#/$defs/Uint"}}},
        {"title":"rollover-intent (ERC-7683, CorkSettler domain — NOT LOP)","additionalProperties":false,"required":["type","settler","rolloverContract","srcPoolId","dstPoolId","srcCstToken","dstCstToken","premiumToken","orderSize","minPremiumPerShare","openDeadline","fillDeadline"],"properties":{"type":{"const":"rollover-intent"},"settler":{"$ref":"#/$defs/Address","description":"EIP-712 verifyingContract for the CorkSettler/1.0.0 domain [C8]"},"rolloverContract":{"$ref":"#/$defs/Address"},"srcPoolId":{"$ref":"#/$defs/MarketId"},"dstPoolId":{"$ref":"#/$defs/MarketId"},"srcCstToken":{"$ref":"#/$defs/Address"},"dstCstToken":{"$ref":"#/$defs/Address"},"premiumToken":{"$ref":"#/$defs/Address"},"orderSize":{"$ref":"#/$defs/Uint"},"minPremiumPerShare":{"$ref":"#/$defs/Uint","description":"fixed floor, raw premium-token units per 1e18 dstCST; premium settled = ceil(dstCstProduced·minPremiumPerShare/1e18) [C8]"},"openDeadline":{"$ref":"#/$defs/Uint"},"fillDeadline":{"$ref":"#/$defs/Uint"},"minCaReceived":{"$ref":"#/$defs/Uint"},"minSharesOut":{"$ref":"#/$defs/Uint"},"allowPartialFills":{"type":"boolean","default":false},"premiumPaymentMode":{"type":"integer","enum":[0,1],"description":"0=atomic-only, 1=atomic-or-separate"}}}
      ]}
    }
  }
}
```

### 5.6 `cork_prepare_market` (R4 deployment — Phase 4, schema stubbed) — readOnlyHint:true

```json
{
  "name":"cork_prepare_market",
  "description":"Build unsigned market-deployment artifacts by wrapping Cork's existing automation and the permissionless MarketRegistry. STATUS: Phase 4, schema PROVISIONAL — MarketRegistry.deploy(ca,ref) surface unverified [C11 / Open Q-REG]. cork_capabilities reports this tool 'specified', not 'activated'.",
  "annotations":{"readOnlyHint":true,"idempotentHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["action","chainId","clientRequestId"],
    "properties":{
      "chainId":{"$ref":"#/$defs/ChainId"},
      "clientRequestId":{"$ref":"#/$defs/ClientRequestId"},
      "format":{"$ref":"#/$defs/Format"},
      "action":{"type":"object","oneOf":[
        {"title":"deploy-wrapper (PROVISIONAL)","additionalProperties":false,"required":["type","collateralAsset","referenceAsset"],"properties":{"type":{"const":"deploy-wrapper"},"collateralAsset":{"$ref":"#/$defs/Address"},"referenceAsset":{"$ref":"#/$defs/Address"}}}
      ]}
    }
  }
}
```

### 5.7 `cork_track` (R5 verify/simulate/reconcile) — readOnlyHint:true

```json
{
  "name":"cork_track",
  "description":"Verify a resource against deployed state before use, simulate frozen bytes (advisory), or reconcile a caller-supplied receipt/orderHash/submission-ref into a closed lifecycle state. Chain evidence outranks any indexer/service claim; disagreement returns state 'conflict', never a silent pick [K7]. Re-validates caller artifacts [K3].",
  "annotations":{"readOnlyHint":true,"idempotentHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["mode","subject"],
    "properties":{
      "mode":{"type":"string","enum":["verify","simulate","reconcile"],"description":"verify — resource matches deployed state; simulate — advisory fork/provider run of a prepared bundle; reconcile — map a receipt/order/ref to a lifecycle state (§10)"},
      "subject":{"type":"object","description":"closed oneOf on subject shape","oneOf":[
        {"title":"artifact","additionalProperties":false,"required":["artifact"],"properties":{"artifact":{"type":"object","description":"a prepared bundle to verify/simulate/reconstruct [K3]"}}},
        {"title":"txHash","additionalProperties":false,"required":["txHash"],"properties":{"txHash":{"$ref":"#/$defs/Bytes32"}}},
        {"title":"orderHash","additionalProperties":false,"required":["orderHash"],"properties":{"orderHash":{"$ref":"#/$defs/Bytes32"}}},
        {"title":"marketRef","additionalProperties":false,"required":["poolId"],"properties":{"poolId":{"$ref":"#/$defs/MarketId"}}},
        {"title":"submissionRef","additionalProperties":false,"required":["submissionRef"],"properties":{"submissionRef":{"type":"string"}}}
      ]},
      "expect":{"type":"object","description":"optional expected {artifactDigest} for K3 re-validation"},
      "chainId":{"$ref":"#/$defs/ChainId"},
      "format":{"$ref":"#/$defs/Format"}
    }
  }
}
```

### 5.8 `cork_capabilities` (R6 discovery/search/manual) — readOnlyHint:true

```json
{
  "name":"cork_capabilities",
  "description":"The searchable manual + maturity map. No args → maturity of every tool/variant (specified|implemented|activated|healthy) with machine-readable unavailability reasons. topic → full field docs, preconditions, error codes, example round-trip for one variant. search → keyword to exact tool + variant + a FILLED invocation template. This is progressive disclosure: deep docs load on demand instead of bloating registered schemas [C13].",
  "annotations":{"readOnlyHint":true,"idempotentHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "properties":{
      "topic":{"type":"string","description":"e.g. 'prepare/unwind-swap', 'compute/impairment-floor'"},
      "search":{"type":"string","description":"e.g. 'current price of a dutch auction order'"}
    }
  }
}
```

### 5.9 `cork_submit` (R5 submission — the ONLY side-effecting tool) — Phase 3

```json
{
  "name":"cork_submit",
  "description":"Relay a CALLER-SIGNED limit order to the Cork orderbook service. This is the only tool with an external side effect. It transmits an already-signed payload — it never signs [K1]. Idempotent by clientRequestId: safe to auto-retry [K2]. Not for on-chain broadcast (the CLI/wallet does that).",
  "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  "inputSchema":{
    "type":"object","additionalProperties":false,
    "required":["signedOrder","signature","chainId","clientRequestId"],
    "properties":{
      "signedOrder":{"type":"object","description":"the LOP v4 order struct (+ Cork metadata) exactly as hashed"},
      "signature":{"$ref":"#/$defs/Hex","description":"EIP-2098 compact (EOA) or full bytes (ERC-1271)"},
      "chainId":{"$ref":"#/$defs/ChainId"},
      "clientRequestId":{"$ref":"#/$defs/ClientRequestId"}
    }
  }
}
```

**Amendment 2026-07-20 (ratified, owner decision):** `cork_submit` expands from LOP-only to **all
off-chain venue writes** — a discriminated `action` union of `lop-order`, `rfq-open`, `rfq-answer`,
and `rollover-order`, each an HTTPS POST to the as-built venue (§7 amendment). Every variant
relays a caller-authored (and, where the venue verifies it, caller-signed) payload — [K1] intact:
the tool never signs and never broadcasts on-chain. `clientRequestId` maps onto the venue's
`request_id` idempotency (same-body replay → 200, different body → 409), preserving [K2] on the
wire. The concrete input schema lands with the Phase-3 implementation and is eval-gated per §13/§14
(surface-drift fixture + Layer B before regeneration); design detail in
`notes/rollover-venue-plan.md` §3 (R1).

**Client-adaptive presentation (not semantics).** On `initialize`, the server reads `clientInfo`
against a versioned profile table and MAY adapt **presentation only**: schema dialect (strict
`oneOf` canonical; a pre-flattened rendering only for profiled weak-`oneOf` clients),
description/example verbosity, and default page sizes. One canonical surface, one validation
behavior, one eval suite; unknown clients get the strict canonical default. Semantics and
availability NEVER vary by client identity.

**CLI-only (never MCP-registered):** `cork raw call|decode|rpc`, `cork cast -- <args>`,
`cork gh -- <args>`, `cork fork`.

## 6. Common Envelope + Error Model

Every tool returns the same envelope; `outputSchema`/`structuredContent` are declared per tool.
Version lives here, never in the tool name (P4).

```json
{
  "state":"ok|conflict|unavailable",
  "data": {},
  "warnings":[{"code":"string","message":"string"}],
  "provenance":{"source":"chain|indexer|service|config","mode":"centralized|lite-decentralized|full-decentralized","chainId":1,"block":"Uint?","fetchedAt":"iso8601","digest":"Bytes32?","staleness":"seconds?"},
  "schemaVersion":"011.1"
}
```

Provenance is **source + digest + timestamp only** by default (K6/P3); raw upstream payloads and
byte-level evidence are returned only under `format:"full"`.

**Envelope `state` vs lifecycle state (§10).** The transport `state` is 3-valued: `ok` |
`conflict` | `unavailable`. The 6-value reconcile lifecycle (§10) lives in `data.lifecycleState`.
Mapping: `envelope.state = "conflict"` iff `data.lifecycleState == "conflict"`; `"unavailable"`
for a mode/prerequisite failure; else `"ok"`. Every tool declares an `outputSchema` over this
envelope; the `cork_track` reconcile `outputSchema` sets `data.lifecycleState` to one of
`prepared|pending|accepted|rejected|conflict|ambiguous`.

**Error model.** Closed codes; every validation error returns `{code, path, expected, actual,
remediation, example}` — including, for variant-selection mistakes, a *corrected example
invocation* so the agent's next call succeeds without a doc lookup (C13). Representative codes:
`UNKNOWN_VARIANT`, `UNKNOWN_FILTER`, `NOT_WHITELISTED`, `MARKET_PAUSED`, `MARKET_EXPIRED`,
`PREVIEW_ZERO_DISABLED` (0-quote from a paused/expired market, C3), `ORACLE_FAILURE`,
`ARTIFACT_DIGEST_MISMATCH` (K3), `MODE_UNAVAILABLE_NO_ARCHIVE` (Lite mode, no token, C12/D9),
`SUBMISSION_AMBIGUOUS`. Error verbosity is budgeted like success verbosity — terse codes waste a
round-trip; walls of text waste context.

## 7. Data-Mode Model

Three explicit modes; `mode` is an input or config value, **never a silent fallback** (K7; every
response's `provenance.mode`+`source` states which produced it):

| Mode | Backend | Serves | Live state |
|---|---|---|---|
| `centralized` | `api-phoenix.cork.tech` (keyless reads) [C9] | pools, whitelist, orderbook, fills, flows | may lag chain; `staleness` reported |
| `lite-decentralized` | public RPCs (chainlist-seeded) | live reads + previews | archive `getLogs` **fails honestly** without a token (`MODE_UNAVAILABLE_NO_ARCHIVE`, C12/D9) |
| `full-decentralized` | embedded Envio HyperSync (bulk historical) + RPC (live) [C12] | market discovery, order/fill backfills | HyperSync is backfill-only (no `eth_call`); a HyperSync API token has been required since 2025-11-03 — a soft-centralization point disclosed to the caller |

Backfills start at block **24134627** (first core deploy), not the config's
`history_last_deployment_block` (24238826 = last) (D3/C10).

**Amendment 2026-07-20 (ratified; see §16 and `notes/rollover-venue-plan.md`):** the
`centralized` backend is now concrete and as-built — `api-phoenix.cork.tech/v1` serves
`/v1/limit-orders/{orderbook,fills,markets}`, `/v1/rfqs`, and `/v1/rollover/{orders,fills,contracts}`
(live on Arbitrum since 2026-07-20). Within decentralized modes the division of labor is:
**HyperRPC** (token-gated read-only JSON-RPC, `https://{chainId}.rpc.hypersync.xyz/<token>`) serves
the targeted `eth_getLogs` reconstruction inside `cork_track` reconcile [K7]; **HyperSync** (query
API, napi client) serves bulk-historical `cork_query` in `full-decentralized` mode. Empirical
constraints (probed 2026-07-20): tokenless HyperRPC is **hard-rejected** (not merely
rate-limited); neither surface has `eth_call`, so live state stays on ordinary RPC; ordinary
public RPCs refuse historical log ranges (archive-gated or ≤10k-block-capped), which is precisely
the gap these fill. Structural limit disclosed to callers: **RFQs, RFQ answers, and
signed-but-unfilled orders emit no events** — the pre-commitment feed is venue-only and no data
mode can decentralize it.

## 8. Config / Address Sourcing (C10)

Addresses/config are **fetched from GitHub, cached with TTL + provenance, CREATE2-verifiable,
never hardcoded**. Canonical sources: `cork-defaults.json` (this project) and phoenix
`config/prod.toml` (per-chain `[chain.address]` + `[chain.bytes32]` salts; `expected_*` vs
`deployed_*`). ABIs come from `phoenix-private/contracts/interfaces/*.sol` or Sourcify (all core
contracts full-match verified, keyless) — the docs-claimed npm `@cork-technology/phoenix` does not
exist (D5). `cork config`/`cork_capabilities` expose `--verify`: recompute CREATE2 from salt +
Safe Singleton Factory (`0x914d7Fec…43d7`), confirm `extcodehash`, and triangulate
config↔frontend↔Sourcify — verified reproducing `0xCCcC…0407` exactly (C10). Fetch pins to a
commit SHA; runtime `refresh` diffs and surfaces mismatches (never auto-resolves). Offline
snapshot works with zero github.com access (honest caveat for Full-Decentralized mode).

## 9. Determinism, Idempotency, Reconstruction (K2, K3)

> **Deadline-basis ruling (2026-07-20, amends the paragraph below):** the deadline basis is the
> **wall clock at call time** — `deadline = now + deadlineSeconds` (and order `expiry = now +
> expirySeconds`), with the duration defaulted or caller-specified. So "byte-identical" holds for
> identical inputs + identical observed state **+ the same clock**; a later retry with the same
> `clientRequestId` legitimately re-anchors its deadline in time. Callers needing bit-identical
> replay pin the clock (`ctx.nowSeconds`) or the block (`at.block`). A derived deadline-basis
> (per-request-id anchoring) and the mismatch-surfacing digest store are NOT implemented and are
> not v1 requirements.

- **Determinism.** Given identical validated inputs, identical observed chain state, and the same
  clock, a byte-producing tool returns identical canonical outputs and executable bytes. Local math
  (§5.2) is deterministic integer arithmetic matched bit-for-bit against fork `eth_call`s in CI (§14).
- **Derived idempotency.** `clientRequestId` (caller-chosen) keys idempotency for `cork_prepare_*`
  and `cork_submit`: it deterministically derives order salts (and, in Phase 3, keys service-side
  submission dedup). The canonical artifact digest = `keccak256` over the canonicalized envelope
  data. Two calls with the same `clientRequestId`, the same resolved inputs, and the same clock
  return byte-identical artifacts (see the ruling above for the clock term).
- **Reconstruction / untrusted re-presentation.** When a caller hands back a stored artifact (e.g.
  to `cork_track`/`cork_submit`), the server **re-derives** it from first principles and compares
  digests before returning new executable bytes or accepting a submission (`ARTIFACT_DIGEST_MISMATCH`
  on divergence). A digest without a signature proves nothing.

## 10. Lifecycle States (K7)

`cork_track reconcile` maps a subject to one closed state; chain evidence outranks indexer/service:

- **prepared** — bytes built, unsigned, unbroadcast.
- **pending** — broadcast/submitted, not yet observed final.
- **accepted** — observed on chain (tx mined + effect confirmed) OR orderbook-accepted (for submit).
- **rejected** — reverted on chain OR orderbook-rejected with a reason.
- **conflict** — chain and indexer/service disagree; both observations returned, no pick (K7).
- **ambiguous** — submission outcome indeterminate after bounded retries; the proved-absence rule
  (no matching fill/cancel event within N confirmations) resolves it to `rejected`, else stays
  `ambiguous` for human decision.

Limit orders additionally carry the LOP status projection `OPEN | PARTIALLY_FILLED | FILLED |
CANCELLED | EXPIRED` from `remainingMakingAmount` + invalidator state (C5).

## 11. Phasing

- **Phase 1 (read/math core):** `cork_query`, `cork_compute` (rates, impairment-floor),
  `cork_decode`, `cork_capabilities`, config/address plumbing (§8), envelope + data modes. No
  writes. Ships against mainnet + the vnet fixture.
- **Phase 2 (Phoenix actions):** `cork_prepare_phoenix` (all 13 + authority), `cork_track`
  verify/simulate. Token authority. Bundler3 bundle builder byte-verified against captured txs.
- **Phase 3 (orders + submission):** `cork_prepare_orders`, `cork_submit`, `cork_compute`
  dutch-auction-price (Fusion) + rollover-premium-floor + rfq-quote. `cork_track` reconcile +
  submission state machine. *Amendment 2026-07-20: Phase 3 executes **rollover-first** in
  sub-phases R0–R4 (ratified plan: `notes/rollover-venue-plan.md` §3) — R0 offline
  rollover-intent typed-data (CorkSettler domain, local `rolloverIntentHash` recompute [K3]);
  R1 centralized venue datasource (query flows/orderbook + the expanded `cork_submit`, §5.9
  amendment); R2 HyperRPC verification leg in `cork_track` [K7] with an `indexer_lag` freshness
  window (~75 s Arbitrum finality); R3 HyperSync `full-decentralized` query (gated on a Bun/napi
  spike); R4 RFQ+LOP completion (`quote_ref` + `extension` on maker-order, numbers-contract
  teaching errors).*
- **Phase 4 (deployment + Safe + hosted hardening):** `cork_prepare_market` (once Q-REG resolves),
  Safe support (one exact config first), hosted-production hardening from §12 as triggered.

## 12. Deferred Hardening (first principles decide if/when — not inherited from RFC-010)

Each entry: what it protects against → the trigger that would justify building it. None is a v1
blocker (P5).

| Mechanism | Protects against | Trigger to add |
|---|---|---|
| Signed evidence manifests + offline key ceremony | Tampered deployment config feeding wrong addresses | A hosted multi-tenant deployment serving addresses to third parties who cannot self-verify CREATE2 |
| Transparency log (append-only) | Silent config/enrichment rewrites | First external partner contractually needs an audit trail of what the server served |
| Multi-provider quorum reads | A single RPC lying about state | A `conflict` (K7) traced to provider dishonesty, not indexer lag, in production |
| Independent signing-gate service | Compromised server minting malicious bytes | Hosted mode gains any path where the server's output is auto-signed by an unattended keeper |
| Dual MCP protocol-era conformance | Client stuck on an old era | A real client on the prior era after the current era ships (compatibility task, not dual normative) |
| Byte-preserving base64 read envelopes | Losing exact upstream bytes for dispute | A specific call site provably needs byte-level evidence (then it's `format:"full"`, not default) |
| Credential-revocation SLA (30s cross-node) | Leaked hosted credential staying live | Hosted gateway with per-tenant credentials in production |

## 13. Agent-Usability + Eval Plan (C13)

Normative mechanics (from `multipurpose-agentic-tool-design.md`, re-confirmed against MCP
2025-11-25): discriminated unions with per-enum-value descriptions and discriminator-first
ordering; the fixed description template with a **when-NOT-to-use pointer** to the correct sibling
(the single biggest lever against wrong-tool selection); shipped input examples per tool + per hot
variant (orderbook fetch, unwind prepare, dutch-auction price); one envelope with declared output
schemas; honest annotations; `cork_capabilities` as the searchable manual (progressive
disclosure); errors that return a corrected example; concise-by-default + `format:"full"`; an
importable core enabling a code-execution lane; and **eval-gated** description/schema changes.

**Worked specialized-fetch example (the bar RFC-010's 40 tools could not meet).** Task: "fetch
fills for the wstETH market since yesterday." The agent sees 9 tools; `cork_query`'s description
lists `fills`. One round-trip, two schemas in context:
`cork_query { resource:"fills", filters:{poolId:"0x…", since:"2026-07-15T00:00:00Z"}, format:"concise" }`.
If unsure, one `cork_capabilities { search:"executed trades history" }` returns that filled
template. A mistyped filter returns `{code:"UNKNOWN_FILTER", path:"filters.makerAddr",
remediation:"use `maker`", example:{…}}`.

**Eval suite (CI-gated).** ~20 realistic tasks run by a fresh agent given ONLY the tool list;
measure task success, wrong-tool picks, wrong-variant picks, tokens consumed. Baseline gates:
success ≥ 0.9, wrong-tool ≤ 0.1, on the tasks {find whether pool X is whitelisted; price a Dutch
auction now; prepare an unwind for 1000 shares and say what must be signed; did my submission
land?; compute the 30-day worst-case impairment floor}. **Growth rule:** any new tool, split, or
merge (incl. the §5.4 3-way `cork_prepare_phoenix` sub-split) ships only if it beats this 9-tool
baseline on the held-out set. Descriptions are code — they change only through this loop.

## 14. Test / Acceptance Spec

- **Golden vectors:** canonical (input → output) pairs per compute kind and per prepare variant,
  including the ±1-wei rounding artifacts (C4/C7); byte-equality of a built Bundler3 bundle against
  the captured real mainnet exercise tx (C2).
- **Fork property tests (parity, R2):** every local math reimplementation property-tested against
  time-warped anvil/vnet-fork `eth_call`s — `cst-swap-rate`/`unwind-rate` vs `previewSwap`/
  `previewUnwindSwap`; `impairment-floor` committed-descent vs repeated `adjustedRate` commits
  (the 9-test harness in `experiments/fork-harness` is the seed, C7); Fusion price vs
  `@1inch/fusion-sdk` AuctionCalculator (C6). Test env = Tenderly vnet chainId 1 with a
  self-created fixture pool (permissionless MockRateOracle) per owner direction.
  **The `unwind-rate` parity fixture MUST set a nonzero `unwindSwapFeePercentage`** (impersonate
  the controller on the fork) and assert bit-exact time-decay-fee parity across warped time — the
  seed harness ran fee=0 pools only (experiments §3/§7), so the fee-decay ceil-rounding path is
  otherwise never fork-checked; unwind-rate acceptance is scoped to this fixture or deferred.
- **Schema/CLI/MCP parity:** one zod source → snapshot of generated MCP `inputSchema`, CLI
  `--help`, and TS types; `--explain` output equals the MCP call it prints (the lane bridge).
- **Agent evals:** §13 suite, CI-gated with the stated baselines.
- **Acceptance:** Phase 1 accepted when the read/math core passes golden + fork-parity + agent
  evals against mainnet and the vnet fixture; later phases gate on their own vectors.

## 15. Open Questions

- **Q-REG (C11, blocking Phase 4):** MarketRegistry real surface — `deploy(ca,ref)` idempotency,
  `lookupWrapper`, `WRAPPER_FACTORY` — pending `market-registry-api`. `cork_prepare_market` stays
  provisional until confirmed.
- **Q-ROLL (C8)** *(largely RESOLVED 2026-07-20)*: the off-chain half is the **rollover venue**
  (`cork-knowledge/rfcs/rollover-venue-interface.md`, as-built): signed orders POST to
  `api-phoenix.cork.tech/v1/rollover`, solvers poll `?fillable=true`, the indexer merges on-chain
  lifecycle into the same rows. On-chain premium remains a fixed floor (`minPremiumPerShare`);
  there is no price walk — a new premium means a new signed order. Remaining sub-questions moved
  to §16.
- **Q-FUSION-LIVE (C6):** when/where does Cork ship Fusion Dutch orders to production? The
  decode/price path is spec'd but no live Fusion order was observable.
- **Q-CHAIN (C5/C9):** canonical production chain for limit orders (mainnet vs Arbitrum vs the
  49222 staging vnet) → governs default `chainId` and default market visibility.
- **Q-WITHDRAW (D8):** `withdraw` NatSpec says pre-expiry but the code path is post-expiry — confirm
  intended semantics before freezing the enrichment label (RFC currently follows the code:
  withdraw family is post-expiry).
- **Q-RFQ (R2):** the RFQ config pipeline (per-market LLM-assessed config, 50–100 pre-seeded token
  risk metrics) is undefined in any repo/API seen — needs the owner's intended inputs before
  `rfq-quote` internals can be frozen.

## 16. Amendment (2026-07-20, ratified) — Rollover venue, verified Arbitrum deployment, HyperSync/HyperRPC

Working design doc: `notes/rollover-venue-plan.md` (build phases R0–R4, event tables, full
verification appendix). Inputs: the as-built venue interfaces in `cork-knowledge`
(`rollover-venue-interface.md`, `agent-rfq-venue-interface.md`), the indexer's registered event
specs, `phoenix-private/config/arbitrum-staging.toml`, and `rollover-private @ 032d3e5a` (the
commit the deployment pins — fetched from GitHub; local clones may be stale). Every address below
was verified on-chain on 2026-07-20 (`eth_getCode`, ERC-5267 `eip712Domain()`, ERC-1967 impl
slots, factory getters, event scans); evidence table in the note's §2.1.

### 16.1 Verified topology (normative for Phase-3 implementation)

- **Two Phoenix deployments coexist on Arbitrum One.** The production deployment
  (`deployments["42161"]`, PM `0xc2De…54AE`) hosts all pools the venue currently indexes. The
  **arbitrum-staging shadow deployment** (campaign `phoenix-rollover-2026q3-r1`) is a complete,
  separate release — different PM implementation, full contract set including CorkAdapter and a
  Bundler3 byte-identical to mainnet's. Config models this as
  `deploymentProfiles["42161"]["arbitrum-staging"]` in `cork-defaults.json`; consumers opt in by
  profile name and `deployments` stays the default read path.
- **The rollover stack is hard-bound to the staging deployment.** Both settlers expose
  `CORK_POOL_MANAGER()` = the staging PM and `ROLLOVER_CONTRACT_FACTORY()` =
  `0xBBcC54c637c26b484A8c57b5695c04e09daCE13A` as immutables — rollover src/dst pools are
  staging-PM pools by construction. Rollover pre-flights and computes MUST resolve the staging
  profile, not the default deployment.
- **Settler identities (empirical — the venue doc's example labels are inverted):**
  ExactSettler `0x983270AE48545665Cee4D7EF61C65fF3fdC8222D`, PartialSettler
  `0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a`. Proven three ways against pinned source
  (partial-only selector, 5-vs-3-word `rolloverAccountingOf` return shapes, and
  `ExactSettler._validateMode` reverting on `allowPartialFills:true` — which makes the venue
  doc's own worked example unfillable as written). Reported upstream as a doc erratum; re-verify
  the venue's `settlerKind` column against chain when the first order row exists [K7].
- **Signing model confirmed:** both settlers answer ERC-5267 with
  `CorkSettler / 1.0.0 / chainId 42161 / verifyingContract = settler`. `cork_prepare_orders`
  `rollover-intent` builds against this domain and recomputes `rolloverIntentHash` locally [K3].
- **Pre-launch state at ratification:** staging PM has 0 pools, factory has 0 clones, venue
  rollover feeds are empty.

### 16.2 Config (§8 addendum)

`cork-defaults.json` gains two keys (already landed, zod-validated, remote-first per §8):
`deploymentProfiles` (named alternate Phoenix deployments per chain) and `rollover` (per chain:
`factory`, `exactSettler`, `partialSettler`, `settlerDomain`, `seededAtBlock` = 484973917, the
`SettlerApproved` seeding block that anchors event backfills). The staging profile's CREATE2
salts exist in `arbitrum-staging.toml` for extending `topic:"verify"` attestation later.

### 16.3 Open questions (delta to §15)

- **Q-SETTLER-KIND** *(resolved on-chain; doc erratum reported)* — residual: does the venue's
  seed table share the doc's inversion? Observable from the first order row's `settlerKind`.
- **Q-STAGING-INDEXED** *(new)*: does `cork-indexing-infra` watch the staging PM on Arbitrum?
  The venue's POST admission checks pools against *indexed* metadata, so if not, every rollover
  order is rejected once campaign pools exist. Self-answers when the first staging pool deploys.
- **Q-CHAIN** *(narrowed)*: rollover is **Arbitrum One only** (settler binding). The LOP/RFQ
  default-chain question remains open.
- **Q-ENVIO-TIER** *(new)*: token provisioning for HyperRPC/HyperSync (user-supplied
  `ENVIO_API_TOKEN`, never committed) — is there a team token CI can use?
