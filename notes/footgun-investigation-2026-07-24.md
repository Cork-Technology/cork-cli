# Numeric & API footgun investigation — 2026-07-24

Scope: cork-helper-cli (all packages), focused on inconsistent arithmetic, numeric/decimal
representations, implicit conversions, rounding, ambiguous APIs. Method: first-principles model →
systematic sweep (grep + cqs + ast reading) → Solidity port comparison (phoenix-private) →
empirical verification with Bun → triage against session 0160c502 (prior decisions consulted, not
deferred to). Model: Claude Fable 5.

## 1. First-principles model

The tool is a translation layer between four numeric dialects:

| Dialect | Where | Representation |
|---|---|---|
| EVM fixed-point | core math | bigint; WAD (1e18 = 1.0) for rates, PCT (1e18 = 1%) for fees/bands |
| Wire-safe strings | schemas / envelopes | `UintStr`/`TokenAmount`/`UnixSeconds` decimal strings |
| Venue JSON | api-phoenix | percent floats (4.1), fraction strings ("0.041"), unix-second ints |
| Human/agent intent | tool inputs | relative durations, human amounts, absolute moments |

Footguns cluster at dialect boundaries, and risk is highest where a crossing is **silent**
(no validation, no annotation), **inconsistent across sibling fields** (same quantity, different
dialect on the same tool surface), or **lossy** (float, bit-mask truncation). Ten classes observed:

- **C1 Same-quantity multi-dialect** — premium as percent-number vs fraction-string vs (never) wad;
  bands 1e18=1% vs rates 1e18=1.0; timestamps as UnixSeconds strings vs plain ints vs relative ints.
  The prior session records this scale trap self-inflicting *twice* on the author (band inversion).
- **C2 Silent truncation on bit-packing** — values masked into fixed-width trait fields without
  range validation.
- **C3 Domain extension of "bit-exact" ports** — bigint ports return values where Solidity reverts
  (underflow/div-by-zero), silently leaving the verified domain.
- **C4 Denormalized duplicates without cross-check** — listing fields that restate what the signed
  order's `makerTraits` already encodes, relayed unverified.
- **C5 Unbounded plausible-unit acceptance** — ms-precision timestamps, negative ints, absurd
  magnitudes pass schema because only the format (digits) is checked, not plausibility.
- **C6 Float guards protecting exact-arithmetic invariants** — scale tripwires implemented in
  IEEE-754 with exact-threshold semantics.
- **C7 Unlabeled output units** — responses mixing decimal systems with no scale annotations.
- **C8 Validation asymmetry across siblings** — one action of a tool validates deadlines strictly,
  its sibling actions validate nothing.
- **C9 Non-canonical digests** — keccak over key-order-sensitive JSON.
- **C10 Semantics hidden in hard-coded defaults** — behavior-changing trait bits not exposed or
  documented.

## 2. Confirmed findings

Severity: /10, blending likelihood × blast radius. "Confirmed-empirical" = reproduced by running
code; "confirmed-code" = established by direct source + reference-contract reading.

---

### F1 — Millisecond/absolute-timestamp acceptance: a ms-pasted `expiryTimestamp` creates a ~year-57,000 pool
**Severity 7/10 (High) · confirmed-code (chain-side requirement verified in CorkPoolManager.sol:103)**

- **What**: Every `UnixSeconds` field accepts any u64. `jitMarket.expiryTimestamp` gets **no**
  tool-side validation (not even "in the future"); the chain requires only
  `expiryTimestamp > block.timestamp` — no upper bound. `Date.now()` pasted as seconds
  (1753363200000) is "valid," in the future, and creates a pool expiring in **year ~57,530**.
  Rollover `openDeadline`/`fillDeadline` are checked for "future" only — a ms value **passes** that
  check. There is no ms-vs-seconds tripwire anywhere, while the analogous premium-scale mistake got
  two dedicated tripwires.
- **Why dangerous**: cPT principal is locked until expiry (`withdraw`/`redeem` are post-expiry
  only; pre-expiry exit needs matched cPT+cST pairs). A filled JIT order with a ms expiry mints an
  effectively perpetual market. The primary callers are LLM agents — the exact population MCP-Atlas
  measured at up to 45% parameter-format errors on financial servers, the stat this repo itself
  cites as motivation for `TokenAmount` teaching.
- **Affected**: makers/fillers of JIT orders (funds impact), RFQ openers, rollover users, any
  integrator generating timestamps in JS (`Date.now()` is ms).
- **Impact if unaddressed**: a single agent slip → signed, fillable order → permanent pool; funds
  consequences are real and irreversible once filled.
- **Remediation**:
  - Add a plausibility refine to the shared `UnixSeconds` primitive (one `$defs`, rides every
    field): reject > ~4e9 (year 2096) with "this looks like milliseconds — divide by 1000" teaching.
    If a >2096 timestamp is ever legitimate, make it a warn-not-block on prepare and a hard block on
    fields that create markets.
  - Handler check for `jitMarket.expiryTimestamp`: must be future (mirror the chain) and within a
    max tenor (warn above, e.g., 5y).
  - Test: schema round-trip that a ms timestamp fails with the teaching message.

---

### F2 — `expirySeconds` silently wraps modulo 2^40 into makerTraits; tool returns `ok` for an already-expired order
**Severity 6.5/10 (High) · confirmed-empirical**

- **What**: `buildMakerTraits` packs `(expiry & U40) << 80` (orders.ts:78) with no range check.
  Schema allows `expirySeconds` up to 9,007,199,254,740,991. Empirically:
  `expirySeconds = MAX_SAFE_INTEGER` → encoded expiry **2025-07-24 (in the past)**; a ms-relative
  value (1753363200000) → encoded expiry **year 22745**. Both return `ok` with a signable order.
- **Why dangerous**: past-wrapped expiry = order signed but permanently unfillable (silent failure
  discovered only at fill); far-future wrap = order that never expires when the maker believed it
  would. Nothing in the envelope hints at the wrap.
- **Affected**: makers via MCP/CLI; downstream TS consumers importing `buildMakerTraits` directly.
- **Remediation**: in `buildMakerTraits`, throw if `expiry > U40` or `nonce > U40` (teachable
  invalid-input); cap `expirySeconds` in schema (e.g. `.max(315_576_000)` = 10 years) with a
  description saying why; unit test at the boundary.

---

### F3 — `cork_submit lop-order` relays venue-listing fields that can contradict the signed order; makerTraits is parsed but never cross-checked
**Severity 6/10 (Medium-High) · confirmed-code**

- **What**: The handler recomputes the orderHash and enforces salt↔extension binding [K3], but
  relays `expiry`, `nonce`, `allowsPartialFills` (and `premium`) verbatim (handlers.ts:1986-1989).
  All three are already encoded in `makerTraits` bits (expiry bits 80–120, nonce 120–160,
  NO_PARTIAL_FILLS bit 255) which the handler parses as bigint two lines earlier. Neither submit
  path recovers the signature against the maker either (recovery exists only in
  finalize-maker-order, orders.ts:210).
- **Why dangerous**: the venue book can advertise "live until T, partial-fillable" for an order
  whose signed traits say otherwise; takers build fills that revert, or resting orders silently die
  earlier/later than listed. This is exactly the class [K3] exists to prevent — the tool's own
  stated principle ("commitments recomputed locally, never trusted") is applied to the hash but not
  to the listing metadata.
- **Affected**: takers consuming the venue book; makers whose listings misrepresent their orders;
  the venue's data quality.
- **Remediation**: derive `expiry`/`nonce`/`allowsPartialFills` from `makerTraits` and return
  `conflict` on mismatch (same pattern as `extension_salt_mismatch`); optionally recover the
  signature and conflict on non-maker signer (or document explicitly that the venue does this).
  Add a fixture test with a contradicting listing.

---

### F4 — `allowsPartialFills: true` orders are killed by their first partial fill (hard-coded `allowMultipleFills: false`), undocumented
**Severity 5/10 (Medium) · confirmed-code (orders.ts:155, corroborated by the code's own invalidator comment at orders.ts:330-333)**

- **What**: `buildMakerOrder` hard-codes `allowMultipleFills: false`. In 1inch v4 semantics,
  partial-allowed + multiple-disallowed = bit-invalidator order: **one fill of any size, then the
  remainder is dead**. The schema describes `allowsPartialFills` (default true) with no mention of
  this; `allowMultipleFills` is not exposed.
- **Why dangerous**: a maker posting 100 units expecting the book to serve many takers gets 1 unit
  filled and 99 unfillable — surprising liquidity loss, no error anywhere (the venue may even keep
  listing it; on-chain status reads "filled-or-cancelled").
- **Affected**: makers; market-making integrators sizing resting liquidity.
- **Remediation**: document the one-fill semantics in the `allowsPartialFills` description; decide
  deliberately whether partial orders should set ALLOW_MULTIPLE_FILLS (remaining-invalidator) —
  if yes, expose or flip the default; test that a partial fill's leftover behaves as documented.

---

### F5 — Premium "numbers contract" guard gaps: unbounded/negative premiums relayed; exact-100× divergence not blocked (float); 0.5-edge false rejection; missing-quote silently skips the check
**Severity 5/10 (Medium) · confirmed-empirical (edges) + confirmed-code (bounds)**

- **What** (four gaps in one dialect boundary):
  1. `premium: z.number()` has **no bounds** (tools.ts:358, 530): negative premiums and 4.1e18
     ("wad pasted as percent") pass schema; tripwire tests only `>0 && <0.1`, so both relay with
     zero warnings.
  2. The quoteRef block `ratio >= 100` is float math: declared premium **exactly 100×** the cited
     quote yields `ratio = 99.99999999999999` → **not blocked** (verified by run).
  3. rfq-answer's `Number(p) >= 0.5` cap: `"0.49999999999999999"` (regex-legal, 17 dp) parses to
     exactly 0.5 → **falsely rejected** despite being semantically < 0.5 (verified by run).
  4. If the cited option lacks a finite positive `premium_annualized`, the cross-check silently
     skips (`Number.isFinite` guard) and the order relays unchecked.
- **Why dangerous**: the tripwires are the *only* local defense on a boundary the venue itself
  defines with two scales; each gap is a path where the defense silently doesn't fire (or
  misfires). The prior session confirms the thresholds were "chosen in-session without recorded
  adversarial analysis."
- **Affected**: quoters/underwriters and coverage buyers submitting via MCP; anyone whose venue
  rejection surfaces as a less-teachable error than the local tripwire would give.
- **Remediation**: `premium: z.number().positive().max(1000)` (or venue cap); compare scales in
  exact arithmetic (parse the fraction string into scaled bigints; `declared*1e4 >= fraction*1e6*100`
  style) or at minimum widen thresholds (`>= 99.5`); treat a quoteRef whose option has no parsable
  premium as `conflict`, not silence; do the 0.5 cap on the string (`"0.5"` prefix compare) or
  scaled bigint. Property-test the thresholds at boundaries.

---

### F6 — `rfq-open` validates nothing (negative/inverted windows relayed) and uses a third timestamp dialect on the same tool
**Severity 4.5/10 (Medium) · confirmed-code**

- **What**: `rollover-intent` validates orderSize > 0, openDeadline ≤ fillDeadline, fillDeadline in
  the future. `rfq-open` — same tool, sibling action — relays `expiryWindow.notBefore/notAfter` and
  `validUntil` with **no checks**; the schema even allows **negative** values
  (`minimum: -9007199254740991`) and types them as plain JS ints while rollover deadlines are
  `UnixSeconds` strings and maker expiry is a *relative* int. Three timestamp dialects across one
  tool; `prepare_phoenix` `deadlineAt` similarly gets no past-check.
- **Why dangerous**: an inverted or already-expired RFQ window is accepted locally and fails (or
  worse, half-works) at the venue; the dialect inconsistency is precisely what pushes agents into
  F1/F2-class unit mistakes.
- **Affected**: coverage buyers opening RFQs; agents that learn the string-timestamp convention
  from one action and apply it to another.
- **Remediation**: mirror the rollover-intent checks (notBefore ≤ notAfter, validUntil future,
  nonnegative bounds); long-term, migrate all absolute timestamps to the `UnixSeconds` primitive
  (additive: accept both during deprecation); add a surface test that every absolute-timestamp
  field either uses `UnixSeconds` or documents why not.

---

### F7 — `cork_compute` cst-swap-rate/unwind-rate outputs mix three unit systems with no annotations
**Severity 4/10 (Medium) · confirmed-code**

- **What**: one flat response contains `swapRate` (WAD), `cstSharesIn`/`cstSharesOut` (always
  18-dec), `referenceAssetsIn/Out` (reference-token native decimals), `fee` (collateral native
  decimals). Nothing in the response labels any of this, and the token decimals aren't echoed
  (they exist only via a separate `cork_query market` call). `resolve-recipe` already solved this
  for itself with a `scales` block — the convention just wasn't propagated.
- **Why dangerous**: with an 18/18 pool everything coincidentally aligns, so integrations get
  built and tested "correct" — then break by 10^12 on the first 6-dec reference asset (vbUSDC is
  already a canonical example asset in this repo). Silent wrong-magnitude answers are the worst
  failure mode for a tool whose selling point is bit-exact math.
- **Affected**: every consumer of compute results (agents sizing swaps, dashboards, risk calcs).
- **Remediation**: add `scales`/`units` metadata + `collateralDecimals`/`referenceDecimals` echo to
  compute responses (additive, no break); consider unit-suffixed field names for any new fields.

---

### F8 — "Bit-exact" math ports silently extend the Solidity domain (revert-parity gaps)
**Severity 3.5/10 (Low-Medium) · confirmed-empirical**

- **What**: where the contracts revert, the ports return values: `computeT(current < start)`
  returns t = 1.1e18 > WAD (Solidity: underflow revert) making `calculateTimeDecayFee` produce a
  **5.5% fee from a 5% base** (verified by run); `creditsRefilled` clamps negative elapsed to 0
  (contract reverts); `mulDiv`/`ceilDiv` accept negatives with JS truncation semantics that break
  the "ceil" postcondition; degenerate-but-reachable chain states (worstRate = 0 when rateMin = 0
  band = 100%, swapRate = 0) hit division-by-zero throws that escape as `internal_error` exit 1
  instead of a teachable envelope.
- **Why dangerous**: not reachable through current handlers (same-block reads guarantee
  timestamp ordering), but `packages/core` is an exported library; a downstream consumer calling
  preview math with slightly-off inputs gets confidently wrong numbers where the chain would
  refuse. The "bit-exact port" claim implicitly promises revert-parity it doesn't have.
- **Affected**: downstream TS consumers of `@cork` core math; future handler paths (e.g. a later
  `at.timestamp` implementation could desync nowTs from issuedAt and make this reachable).
- **Remediation**: add explicit precondition guards (throw on `current < start`, `end <= start`,
  negative inputs, zero denominators with domain-specific messages); document the verified domain;
  add adversarial unit tests for each guard.

---

### F9 — `minPremiumPerShare` is a rate typed as `TokenAmount`, whose description actively misleads
**Severity 3/10 (Low) · confirmed-code**

- **What**: the premium floor is `dstCstProduced × minPremiumPerShare / 1e18` — so the field is
  "premium-token base units per 1 whole (1e18) cST share." It's typed/described as a plain
  `TokenAmount` ("token amount in the token's own smallest unit"), which is wrong twice: it doesn't
  say *which* token, and it doesn't say it's per-share. For a 6-dec premium token the correct value
  looks nothing like the description's examples suggest.
- **Affected**: rollover makers; the compute kind's callers.
- **Remediation**: dedicated description: "premium floor RATE: premiumToken base units per 1e18
  dstCst shares (e.g. 0.012 sUSDe/share → '12000000000000000'; 0.012 USDC/share → '12000')."

---

### F10 — Assorted representation leaks: `blockNumber` as JS number, unit-less `staleness`, unbounded `Number(secs)`
**Severity 2.5/10 (Low) · confirmed-code**

- **What**: `hypersync.ts:87` and `rollover-verify.ts:156` emit `blockNumber: Number(...)` directly
  (the only chain integers bypassing the strings-on-the-wire convention; >2^53 loses precision —
  theoretical for block numbers, but convention-breaking); `staleness: z.number()` has no `.int()`
  and no unit in name or description; `nowIso` does `Number(secs) * 1000` on an unbounded bigint.
- **Remediation**: stringify blockNumbers (or document the exception); name/describe staleness
  units; clamp/validate nowSeconds.

---

### F11 — Envelope digests are keccak over key-order-sensitive JSON
**Severity 2/10 (Low) · confirmed-empirical**

- **What**: `provenance.digest` and `signedArtifactDigest` hash `JSON.stringify(jsonSafe(data))`;
  identical data with different key insertion order digests differently (verified). Fine for
  self-comparison; fragile the moment a third party recomputes a digest from the JSON they
  received (their serializer's key order must match exactly). Prior session also flagged (and left)
  `digest_mismatch` being overloaded across four distinct comparison types.
- **Remediation**: document "opaque — compare only digests produced by this tool," or canonicalize
  (sorted keys) with a schemaVersion bump; split `digest_mismatch` into per-surface codes.

---

### F12 — Accepted-but-reserved fields still silently no-op
**Severity 2/10 (Low) · confirmed-code, previously raised in session 0160c502**

- **What**: `cork_compute at.timestamp` and `cork_prepare_phoenix account` validate and are then
  ignored. A caller pinning `at.timestamp` for replay gets clock-anchored results with `state: ok`
  and no signal. Documented in CLAUDE.md, but the envelope itself says nothing.
- **Remediation**: emit a `reserved_field_ignored` warning when present — cheap, self-describing,
  consistent with the disclosure philosophy everywhere else.

## 3. Empirical evidence log

Run: `bun scratchpad/verify3.ts` (imports repo sources directly), 2026-07-24:

```
A1 max-int expirySeconds: intended=9007201008104191 encoded=1753363199 wrapped=true encodedDate=2025-07-24T13:19:59.000Z past=true
A2 ms-as-expirySeconds:  intended=1755116563200 encoded=655604935424 wrapped=true encodedDate=+022745-04-18 past=false
B1 computeT(current<start): t=1100000000000000000 t>WAD=true
B2 fee(current<start)=55000000000000000 fee(at-start)=49950000000000000 inflated=true
C1 Number(0.4999999999999999)>=0.5: false
C2 Number(0.49999999999999999)>=0.5: true (value=0.5)
C4 exact-100x ratio=99.99999999999999 blocked(>=100)=false
D1 key-order-sensitive-digest: differ=true
```

Chain-side: `CorkPoolManager.sol:103` — `require(poolParams.expiryTimestamp > block.timestamp)` is
the ONLY expiry validation (no upper bound). Port parity: MathHelper.sol / TransferHelper.sol /
ConstraintRateAdapter.sol re-read line-by-line against fixed.ts / mathhelper.ts / constraint.ts —
value-parity holds on the shared domain; divergences are exactly the revert-parity gaps in F8.

## 4. What is *not* a footgun (verified clean)

- All core swap/fee/rate/impairment math is bigint with explicit floor/ceil matching OZ/contract
  rounding; fork-parity tests pin it wei-for-wei.
- `jsonSafe` is a single serialization funnel; no domain value reaches envelopes as a JS float
  (except the venue-defined `premium`, F5, and the F10 blockNumbers).
- Venue rows: amounts parsed via regex-validated strings → BigInt; untrusted-input discipline [K3]
  is genuinely applied to hashes/orders.
- Decimals are read live from ERC-20s (no hardcoded 18); `TokenAmount` pass-through teaching
  addresses the rescaling failure class observed in prior evals.
- taker-fill partial ratio uses exact ceil bigint math; 185-bit threshold cap checked.
- `applyBandsLocal` is parity-self-checked against on-chain `applyBands` on every call — the right
  pattern (this is the class-eliminating design F5/F3 should copy).

## 5. Class-elimination program (beyond individual fixes)

1. **Derive, don't duplicate** (kills C4/F3): any field restating signed-payload content is
   computed from the payload, or cross-checked with `conflict` on mismatch.
2. **Plausibility refinements on shared time/amount primitives** (kills C5/F1, halves F2): one
   zod refine on `UnixSeconds` (ms-detector, sane-horizon) rides every field for free — the same
   leverage argument the repo already used for `TokenAmount` teaching.
3. **Validate before bit-packing** (kills C2/F2): every `& mask` on user-derived input becomes
   range-check-then-pack.
4. **Exact-arithmetic guards** (kills C6/F5-edges): scale tripwires compare scaled integers, never
   floats, when the compared quantities originate as strings.
5. **Units on every money/rate output** (kills C7/F7/F9): adopt the `scales` block as a required
   convention for any response mixing decimal systems; schema-lint new numeric outputs.
6. **Revert-parity guards on ports** (kills C3/F8): precondition throws documented as part of
   "bit-exact."
7. **Schema lint test** (enforces the dialect model): a test that fails when a new `z.number()`
   carries domain semantics (timestamp/amount/rate/premium) outside an allowlist, and when an
   absolute-timestamp field doesn't use `UnixSeconds`. This turns the whole taxonomy into CI.

## 6. Triage notes vs session 0160c502

Consulted, not deferred to. Items that session raised and parked, now re-opened here: suspect-vs-
mismatch tripwire gaps (F5 — the session called the thresholds heuristic and unanalyzed; the edges
are now demonstrated), `digest_mismatch` overload (F11), accepted-but-reserved fields (F12).
Decisions that session got right and this investigation confirms: bigint-strings-on-the-wire,
chain-preferred reads, `deadlineAt` for byte-stable retries, parity self-check on band resolution.
No prior decision was found to be the *root cause* of a new finding; the root cause pattern is
that protections were built bespoke per-field (premium got tripwires, bands got parity checks)
rather than onto the shared primitives, so every field added since starts unprotected — that is
the single most valuable structural change (item 7 above).

---

# Second pass (exhaustive) — 2026-07-24, added in response to "are these the only ones?"

The first pass deep-read ~60% of the surface. This pass covered the remaining files (bundle/*,
rollover*, hypersync, config-remote, chain/rpc, cli/*, mcp/*, teaching/registry/search) via two
parallel audits plus fresh empirical tests. It roughly **doubled** the finding count. Answer to the
question: the original 12 were NOT exhaustive. Newly confirmed (F13+):

### F13 — Exact-OUT funding legs move the slippage *cap*, not the consumed amount; no sweep-back
**Severity 6.5/10 (High) · funding-side confirmed by reading funding.ts:28-46; refund/skim consequence relies on CorkAdapter.sol trace (verify before acting)**
`FUNDING_TABLE` funds `mint→maxCollateralAssetsIn`, `swap→maxCstSharesIn+maxReferenceAssetsIn`,
etc. — the user-set caps. If actual consumption < cap (normal for any slippage buffer), the delta
is left on the adapter and `fundingPlan` builds no return leg. Per the auditor's read of
CorkAdapter.sol the adapter never refunds, and Bundler3.multicall is public with a full-balance
sentinel, so the residual is skimmable next block. A maker setting a 2× cap silently donates the
slack. **Fix:** append `erc20Transfer(token, initiator, uint256.max)` sweep-back leg per capped
token; first, empirically confirm the adapter's non-refund behavior on a fork.

### F14 — `cork_submit rollover-order` never recovers the signature, and skips the settler/deadline checks its own prepare path performs
**Severity 6.5/10 (High) · confirmed-code (handlers.ts:1801-1892; only recovery is orders.ts:210)**
The rollover-order twin of F3, but worse: the signature is never recovered against `o.user` at all
(the digest is computed and in hand). It also re-checks neither settler-mode nor
settler-recognition nor `openDeadline ≤ fillDeadline`/future-ness — all of which the
prepare `rollover-intent` path enforces. A garbage- or foreign-signed order, or one bound to the
wrong settler, relays clean. **Fix:** recover the signature and conflict on non-`user` signer;
re-run the settler/deadline checks before relay.

### F15 — HyperSync (full-decentralized) reads are single-page and silently truncate; the LOP fills scan is unscoped to Cork
**Severity 6/10 (Medium-High) · confirmed-code (hypersync.ts:76-93 drops `nextBlock`; handlers.ts:576)**
`queryLogs` calls the client once and the interface discards HyperSync's `nextBlock` resume cursor,
so completeness can't even be detected — while the venue path has meticulous
`pagination_incomplete` machinery. A mainnet `OrderFilled` scan from block 0 (line 576) over the
1inch LOP — a very high-volume address — near-certainly truncates, and because it filters only by
address+topic (orderHash is non-indexed) it returns *all* 1inch fills, not just Cork's. Counts are
presented as complete evidence. **Fix:** loop on `nextBlock` (or emit a truncation warning
mirroring the venue path); post-filter by Cork order hashes.

### F16 — config-remote: a transient fetch failure *after* TTL expiry overwrites a good disk cache with a failure marker and regresses to the bundled copy
**Severity 5.5/10 (Medium) · confirmed-code (config-remote.ts:211)**
When the cached defaults are past the 1 h TTL and a refetch fails transiently, line 211 saves
`{failure}` — deleting the stored good defaults — and serves BUNDLED. A 10-minute blip can silently
roll addresses back to whatever shipped in the install, including un-learning a documented-volatile
`marketRegistry.adapter` redeploy → unsigned tx built against a stale target. **Fix:** serve the
expired-but-present good cache before the bundled copy; never overwrite good defaults with a failure
marker.

### F17 — `cork_decode` aborts the entire decode if any one nested leg is malformed; recursion is unbounded
**Severity 4.5/10 (Medium) · confirmed-code (bundle/decode.ts:31-42)**
A leg whose selector matches but whose body is truncated throws uncaught → the whole decode fails
(`internal_error`/exit 1) and every other leg is hidden — directly contradicting the file's own
header ("a decoder that silently hides legs is a footgun"). Unbounded nested-bundle recursion on
untrusted calldata can also blow the stack into the same misclassification. **Fix:** degrade a
bad leg to `kind:"unknown"`; cap recursion depth.

### F18 — `account-state` "permit2 allowance" reports the ERC-20→Permit2 approval, not the Permit2-internal allowance (spender=adapter, uint48 expiry) that actually gates funding
**Severity 4/10 (Medium) · confirmed-code (handlers.ts:826-847; no Permit2-contract allowance read anywhere)**
The permit2 funding leg needs `Permit2.allowance(owner, token, adapter)` unexpired — never queried.
A user seeing a large `permit2` value reasonably concludes the bundle will fund; it can still revert
on zero/expired Permit2 allowance. Necessary-vs-sufficient not disclosed. **Fix:** read the
Permit2 allowance (amount+expiration) or relabel and document the gap.

### F19 — Validation/reserved-path asymmetries that let clean `ok` hide unusable results
**Severity 4/10 (Medium, aggregate) · confirmed-code**
Several siblings return `ok` where a peer validates: `prepare_phoenix` pool-existence/expiry guards
run only on the auto-funding path — `pre-funded` (or no-RPC) deposits against a nonexistent/expired
pool return clean `ok` (handlers.ts:2133-2175); `deadlineAt` accepts past timestamps with no
warning though `deadlineSeconds` is bounded future (2124); `market-predict` predicts an unmintable
market for a past/zero expiry with no warning (509-512); track reconcile scans only page 1 of the
orderbook/fills → false `resting:false`/`order_not_found` (1678-1683, no `collectVenuePages`).
**Fix:** hoist pool/deadline/expiry checks out of mode-specific branches; paginate the reconcile
scan; warn on past `deadlineAt`.

### F20 — MCP surface: `isError` inverts severity for integrators; error-envelope provenance is hardcoded `chainId: 1`
**Severity 3.5/10 (Low-Medium) · confirmed-code (server.ts:60, 79)**
`isError = state==="unavailable"` matches the docs, but many MCP clients treat `isError:true` as a
hard failure and ignore `structuredContent` — so a routine `receipt_not_found` (unavailable) reads
as an error while a serious `digest_mismatch` (conflict) reads as success unless the client inspects
`state`. Separately, the error envelope stamps `provenance.chainId: 1` regardless of the requested
chain, misleading a client that branches on it. **Fix:** document the state-not-isError contract
prominently; thread the real chainId into the error envelope.

### F21 — Explicit `--rpc-url`/`CORK_RPC_URL` is used with no chainId verification (the default & chainlist paths verify)
**Severity 3.5/10 (Low-Medium) · confirmed-code (chain/rpc.ts:254 vs 270/298)**
Point a hand-set RPC at the wrong chain and every read returns wrong-chain data stamped with the
requested chainId — the one path a user configures by hand is the only one without the guard.
**Fix:** `eth_chainId`-verify explicit endpoints too (or warn on mismatch).

### F22 — CLI `--json` numeric fields lose integer precision in `JSON.parse` before zod sees them
**Severity 3/10 (Low) · confirmed-empirical**
Amount fields are strings (safe — a number is rejected teachably). But genuinely numeric schema
fields (`expirySeconds`, `validUntil`, `notBefore/notAfter`, `horizonSeconds`) are parsed by
`JSON.parse` first: `2500000000000000001` silently becomes `...000` before validation
(reproduced). A rounded value landing ≤2^53−1 is accepted with no signal. Compounds F1/F5 (those
fields should be strings anyway). **Fix:** make integer-domain fields `UnixSeconds`/`UintStr`
strings; or reject `number` inputs that exceed 2^53 pre-parse.

### Minor (confirmed, low stakes)
`chainStatusName` maps unknown enum values → "None", which can fabricate or mask a `status_mismatch`
(rollover-verify.ts:58); registry list reads hard-truncate at 500 assets/100 recipes with no
`pagination_incomplete` warning, and the truncated mode list can mislabel a real mode as unknown
(handlers.ts:897,904); 5xx venue responses map to `venue_rejected` (reads as permanent) rather than
retryable; teaching's "corrected example" is always the tool's first example regardless of which
variant failed (teaching.ts:97) — copying it changes action/resource; commander v12 silently ignores
excess positional args; `process.exit` after an async stdout write may truncate a large piped
envelope (hypothesis, runtime-dependent); config `parseDefaults` validates shape/checksum, not
authenticity — a shape-preserving tamper of the remote (or `CORK_DEFAULTS_URL`) swaps every address
and validates, despite comments implying tamper-rejection.

### Coverage statement
After two passes, deep-read coverage is ~95% of `src`. Not exhaustively verified: the *deployed-
contract* half of F13 (adapter non-refund / Bundler3 skim) — traced from Solidity, not fork-executed;
concurrency/caching races beyond the noted memo issue; and anything requiring live-chain or live-venue
execution (both self-skip offline). No fuzzing or property-based testing was performed — recommended
as the durable follow-up for the scale/rounding classes.

---

# Third pass (empirical deepening) — 2026-07-24, Fable 5

This pass executed the follow-ups the second pass recommended: a **property-based harness over the
numeric core** (fast-check, `experiments/proptest/core.proptest.ts`, 18 properties / ~86k
assertions), a **Solidity differential revert-domain harness** run in the Foundry container
(`experiments/fork-harness/test/RevertDomainParity.t.sol`, 11 tests incl. 256-run fuzz over the real
OZ `Math`), **static analysis via podman** (semgrep custom numeric rules), and a **fresh structural
sweep** (parallel sub-agent, independently re-verified). Method note: every divergence below was
reproduced by running code on BOTH sides — the TS port (bun) and the Solidity ground truth (forge in
`ghcr.io/foundry-rs/foundry`). Reachability was decided by reading `CorkPoolManager.createNewPool` /
`PoolLib.initialize` / `ConstraintRateAdapter._calculateRate` line-by-line (phoenix-private @9e4b345).

## Headline outcomes

1. **F8 and F6 are no longer "traced" — they are differentially proven.** For every input where the
   TS port returns a value, the Solidity reference *reverts*: `computeT(current<start)` → t up to
   113518×WAD (Sol underflow-reverts); `calculateGrossAmountBeforeFee(fee>100%)` → **silent negative**
   (Sol underflow-reverts); `fee==100%` → div-by-zero throw (Sol reverts); `mulDiv` quotient >uint256
   → returned (Sol reverts); `ceilDiv(-1,3)=1` overshooting true ceil 0. All 11 Solidity `expectRevert`
   vectors pass; all TS divergences logged (evidence block below).
2. **F13 is now confirmed by source on all three legs** (was "adapter half traced, not executed"):
   the tool funds the slippage **cap** (`funding.ts:31-34,107`); `CorkAdapter.safeSwap` (line 406-447)
   consumes ≤ cap and has **no sweep-back**; the residual is skimmable by anyone via public
   `Bundler3.multicall` → `CoreAdapter.erc20Transfer` (line 62), which has a `uint256.max` full-balance
   sentinel and no `initiator()`/whitelist check on `receiver`. This is the standard Morpho
   "adapters must end each tx with zero balance" invariant, violated whenever consumption < cap — the
   normal case for any slippage buffer, not an edge.
3. **New upstream contract gap that makes F6/T2 reachable:** `createNewPool`/`PoolLib.initialize`
   copy `swapFeePercentage`/`unwindSwapFeePercentage` **verbatim with no `MAX_ALLOWED_FEES` check** —
   that 5% cap is enforced ONLY by the post-creation `updateSwapFeePercentage` setters. So a pool with
   fee ≥ 100% is creatable, and the compute tool would then serve a `state:ok` quote with a **negative**
   `referenceAssetsIn`/`cstSharesIn`/`fee`. Flag to the protocol team (phoenix-private), independent of
   the tool fix.
4. **A new structural class, C11 (exception-provenance collapse):** local math/domain/encoding throws
   caught inside chain-read `try/catch` blocks all surface as `chain_read_failed` — whose canonical
   guidance ("pool doesn't exist / check poolId-chainId") is actively misleading when the real cause is
   a zero worst-rate, an out-of-range band, or an ABI range error. Local bugs are indistinguishable
   from RPC faults in the envelope.

## New / upgraded findings

### T1 — Revert-parity differentially proven (upgrades F8 to confirmed-empirical both-sides)
**Severity 3.5/10 (Low-Medium, library-only) · confirmed-empirical (bun + forge)**
The `packages/core` math ports return values across the whole region where the Solidity reference
reverts. Not reachable through current handlers (same-block reads keep timestamps ordered; amounts are
bounded), but `@cork/core` is an exported library and the "bit-exact port" claim implicitly promises a
revert-parity it does not have. **Remediation:** precondition guards documented as part of "bit-exact"
(throw on `current<start`, `end<=start`, negative `mulDiv`/`ceilDiv` operands, quotient>uint256), OR a
one-line fix at the primitive — see class-elimination item 9.

### T2 — Negative-denominator silent garbage in the fee/gross family (sharpens F6/F8; adds upstream reachability)
**Severity 4/10 (Medium) · confirmed-empirical (both sides) + upstream contract gap confirmed-code**
`calculateGrossAmountBeforeFee`/`calculateGrossAmountWithTimeDecayFee` compute `mulDiv(x, PCT_DENOM,
PCT_DENOM − fee, "ceil")`. `mulDiv` rejects only `d === 0n`, never `d < 0n`, so a fee > 100% flips the
denominator negative and returns a **negative** amount with no throw; a fee == 100% throws div-by-zero
(→ caught → mislabeled `chain_read_failed`, class C11). These feed `previewSwap` → `cork_compute
cst-swap-rate`/`unwind-rate`, which would serialize the negative into an `ok` envelope. On-chain the
fee is normally ≤ 5%, BUT (headline #3) `createNewPool` does not validate the fee at creation, so a
fee ≥ 100% pool is constructible. **Remediation:** reject `d < 0n` in `mulDiv` (kills the whole family
at the primitive); add a fee-sanity guard (`fee < PCT_DENOM`) before the preview; upstream: validate
`swapFeePercentage <= MAX_ALLOWED_FEES` in `createNewPool`.

### T3 — `taker-fill` never validates `fillMakingAmount` against the resting order (new, reachable)
**Severity 4/10 (Medium) · confirmed-empirical (independent probe + code read, orders.ts:274-325)**
`buildTakerFill` sets `making = fillMakingAmount ?? order.makingAmount` with no clamp. Two consequences:
- **Overfill:** `fillMakingAmount:1000` against a 100-making/7-taking order returns
  `requiredMakingAmount:"1000"`, `requiredTakingAmount:"70"` and a `takerTraits` threshold cap of 70 —
  but 1inch clamps the fill to the 100 remaining, so the real cost is 7. The tool's reported amounts
  are **10× wrong** and the slippage cap is **10× too loose** (reproduced).
- **Partial-of-no-partial:** `fillMakingAmount:50` of an order whose `makerTraits` has NO_PARTIAL_FILLS
  (bit 255) set builds a clean `fillOrder` (reproduced) that reverts on-chain. The file already has
  `lopInvalidatorPlan` (orders.ts:348) that reads exactly this bit, but `buildTakerFill` never consults
  it.
Reached via `cork_prepare_orders taker-fill`; only mitigated by the `unsigned_artifact` "simulate
first" warning (which does not fix the wrong reported amounts an integrator would display).
**Remediation:** clamp `fillMakingAmount ≤ order.makingAmount` (or `conflict`); read the NO_PARTIAL_FILLS
bit and reject a partial fill of a non-partial order (same "derive from the signed payload, don't
trust the sibling" principle as F3).

### T4 — impairment-floor div-by-zero at `worstRate=0`, mislabeled `chain_read_failed` (new site, class C11)
**Severity 3.5/10 (Low-Medium) · confirmed-empirical (bun) · reachability library/recipe-path**
`impairmentFloor` computes `mulDiv(WAD, WAD, worstRate, "ceil")`; when `rateMin=0` and descent ≥
`lastAdjustedRate`, `worstRate=0` → throw → caught at handlers.ts:335 → `chain_read_failed`. UNREACHABLE
via the compute handler (`createNewPool` enforces `rateMin > 0`, line 110), but `applyBandsLocal` permits
a `rateMin` band of exactly 100% → resolved `rateMin=0` (reproduced), so the JIT-recipe/library path can
construct it. The crash happens **exactly when the true answer is "impairment can be total, maxRef/cST is
unbounded"** — the most important risk signal is replaced by a misleading pool-doesn't-exist error.
**Remediation:** guard `worstRate === 0n` and return the meaningful result (floor 0, unbounded ref-per-cST)
instead of dividing; do not route local math throws through `chainReadFailed` (class item 8).

### T5 — Exception-provenance collapse: local throws surface as `chain_read_failed` (new structural class C11)
**Severity 3/10 (Low-Medium, aggregate) · confirmed-code**
`applyBandsLocal`'s own `rateMin>100%` guard throw (market-registry.ts:79) escapes resolve-recipe's
catch (handlers.ts:395); `computeMarketId` ABI range errors escape market-predict's catch
(handlers.ts:1016); the impairment div-by-zero (T4) escapes handlers.ts:335 — all three land as
`chain_read_failed`. A caller cannot tell a local-port bug or a domain-rule violation from an RPC/pool
failure. **Remediation:** wrap ONLY the RPC calls in the chain try/catch; let local math/domain throws
produce their own envelope (`would_revert`/`invalid_state`/a domain code), never `chain_read_failed`.

### T6 — `market-predict` derives identities for impossible markets (new surfaces, F1/F19 class)
**Severity 2.5/10 (Low) · confirmed-code + confirmed-empirical (band resolution)**
Two under-validations on one read: (a) `filters.expiry` is parsed by a bare `/^\d+$/` + `BigInt(v)`
with **no u64 bound** (unlike the `UnixSeconds` primitive every other expiry field uses) — a
year-58-billion value derives a `state:ok` pool identity; > uint256 throws in `encodeAbiParameters` →
mislabeled per C11. (b) the handler never checks the resolved bands satisfy `createNewPool`
(`rateMin > 0`, `rateMin < rateMax`), so a recipe with a 100% `rateMin` band yields an `ok` prediction
(poolId + cST/cPT) for a market whose JIT fill reverts `InvalidParams`. **Remediation:** route
`filters.expiry` through `UnixSeconds` (F1 plausibility refine rides it); warn when resolved bands
would fail `createNewPool`.

### T7 — `maker-order` accepts a caller `extension` of any length (new, F2-adjacent)
**Severity 2/10 (Low) · confirmed-empirical (independent probe)**
The `extension` input is a bare `Hex`; a 1-byte `"0x01"` builds a fully signable order (HAS_EXTENSION
set, salt bound to keccak of the garbage, interaction flags derived from a misread offsets word) that
signs fine and reverts/misparses at fill. No minimum-32-byte / offset-header sanity guard.
**Remediation:** validate the extension length/offset-header before binding the salt and setting the
flag (or document that malformed extensions are the caller's responsibility and won't be caught).

### T8 — venue `makingAmount:"0"` + `fillMakingAmount` → `BigInt` RangeError mislabeled caller error
**Severity 2/10 (Low) · confirmed-empirical**
The venue `Uint` regex permits `"0"`; the taker-fill ceil-div then throws `RangeError: 0 is an invalid
divisor value`, surfaced as `invalid_order_terms` (the caller's fault) with the raw message — the
correct code for a malformed venue row is `invalid_service_response`. Handled (no crash), wrong
attribution. **Remediation:** treat a zero `makingAmount` in a venue row as `invalid_service_response`.

### T9 — `ceilDiv` overshoots true ceil for negative numerators (sharpens F8)
**Severity 1.5/10 (Low, library-only) · confirmed-empirical**
`ceilDiv(-1, 3) = 1` where the true ceil is `0` — the `(a-1)/b+1` form doesn't just truncate, it
returns a value ABOVE the correct ceiling for negative numerators. Library-only (handlers never pass
negatives). Folds into the T1 precondition-guard remediation.

### T10 — `calculateRate` no-change early-return is unclamped (documents the model)
**Severity 1.5/10 (Low, library-only) · confirmed-empirical + confirmed-code (faithful to Sol:205)**
When `newRate == lastAdjustedRate`, both the Solidity `_calculateRate` and the TS port return
`lastAdjustedRate` **without clamping to [rateMin, rateMax]**. `previewAdjustedRate` therefore returns
an out-of-band rate iff fed an out-of-band `lastAdjustedRate`. In-band is a **precondition** (chain
state guarantees it: bootstrap + clamp), not a postcondition — so it's a library-caller footgun, not a
port bug. Documented to prevent a future "invariant" being assumed of the exported function.

## Empirical evidence log (third pass)

TS port (`bun test core.proptest.ts`, 18 pass / 0 fail):
```
P1 mulDiv overflow-gap: TS returns 1.37e155 where Sol reverts (quotient > uint256)
P2b ceilDiv(-5,3)=-1  ceilDiv(-1,3)=1 (true ceil 0 — overshoot)
P4b computeT>WAD: t up to 1.0000011e18 .. 1.135e23 for current<start (Sol reverts)
P4c computeT(100,50,100)=0 (end<start silently 0; Sol reverts)
P5b time-decay fee inflated: 5.5e16 vs 4.995e16 base (5.5% from 5% base)
P6 fee==100%: throw div-by-zero ; fee==101%: ok -1.0e23 (silent negative)
P6b bigBase(200%): fee=-2002.. assetIn=-1002.. (silent negative)
P7b calculateRate out-of-band no-change early-return: rate=0 (rateMin=1) updated=false
P8b impairmentFloor worstRate->0: THROW div-by-zero (mislabeled chain_read_failed)
```
Solidity ground truth (`forge test RevertDomainParity`, 11 pass, incl. 256-run fuzz): every
`expectRevert` above holds; `testFuzz_computeT_valid_in_range`, `testFuzz_gross_valid`,
`testFuzz_timeDecayFee_le_baseFee` confirm the valid-domain invariants (t∈[0,WAD], gross≥desired,
fee≤full-base). Contract reachability reads: `CorkPoolManager.sol:110` (`rateMin>0` enforced —
T4 unreachable via handler), `PoolLib.sol:57-64` (`initialize` copies fees unvalidated — T2 reachable),
`CorkAdapter.sol:406-447` + `CoreAdapter.sol:62` (F13 no-refund + skim, all legs).

Static analysis (semgrep 1.170.1, custom numeric rules, podman): 10 findings, **all mapping to
existing F-numbers** (F2 bit-mask, F5 premium `z.number()`, F6/F8 subtractive denominators — flagged
ERROR, F10 `Number()` on chain/staleness). No net-new instance surfaced by the automated pass — a
completeness signal that the manual taxonomy captured every structural pattern the tool detects.

## Areas cleared this pass (no net-new footguns)
- **`BigInt(...)` coercion class — CLEAN.** Every `BigInt(userField)` receives a regex-validated digit
  string (`UintStr`/`TokenAmount`/`Uint64Str`/`UnixSeconds`, `^[0-9]+$`) or an `.int()`-bounded number;
  it can never throw on a float/non-integer. The one exception is `market-predict filters.expiry`
  (T6a), which bypasses the primitive.
- **`Number(...)` class — CLEAN beyond F5/F10.** All 32 sites are either covered (F5 premium float,
  F10 blockNumber/nowIso) or safe (small chainId map keys, 32-bit ABI offset extraction).
- **Rounding directions — no wrong-party rounding.** previewSwap/exercise ceil the user-pays leg and
  floor the user-receives leg (fork-parity-tested vs the Solidity ports); taker-fill partial ceils;
  premium-floor floors (conservative). Verified across the preview family.
- **rpc / reads / venue / hypersync / bundle / create2 / config / schemas** — swept beyond their
  existing findings; no new numeric hazards (breaker/TTL math is plain ms; decimals flow through
  bigint `pow10`; venue rows are zod-normalized; sentinel checks are exact uint256-max).

## Taxonomy extension
- **C11 Exception-provenance collapse** — a local (math/domain/encoding) throw caught by a chain-read
  `try/catch` is relabeled as a chain/RPC failure, hiding local bugs behind network-fault guidance.
  Instances: T4, T5, T8, plus the F6 fee==100% path.

## Class-elimination program (additions to items 1-7)
8. **Separate local-throw handling from chain-read catches** (kills C11): wrap ONLY the awaited RPC
   calls; let domain/math/encoding throws produce their own teachable envelope (`would_revert`,
   `invalid_state`, a domain code), never `chain_read_failed`.
9. **Guard the primitive, not each call site** (kills the C3/C6 negative-denominator family): make
   `mulDiv`/`ceilDiv` reject `d < 0n` and quotient > uint256, and `computeT` reject `current<start` /
   `end<=start`. One change immunizes the whole fee/gross/preview family and makes "bit-exact" mean
   revert-parity.
10. **Derive-and-clamp on every "amounts from a signed order" path** (kills the T3/F3 class): taker-fill
    and any consumer of a signed order clamp against the order's own encoded limits (makerTraits bits,
    remaining amount) and `conflict` on violation, instead of trusting or recomputing the sibling value.

## Reachability summary (third-pass findings)
| Finding | Reachable via a tool handler? | Evidence |
|---|---|---|
| T3 taker-fill overfill / partial-of-no-partial | **Yes** (`cork_prepare_orders taker-fill`) | probe + code |
| T2 negative fee-denominator | Only with a fee≥100% pool (contract permits at creation) | both-sides + upstream read |
| T4 impairment div-by-zero | No via handler (`rateMin>0` at creation); yes via library/recipe | bun + chain read |
| T5 exception-provenance collapse | **Yes** (resolve-recipe / market-predict / impairment) | code |
| T6 market-predict impossible-market | **Yes** (`cork_query market-predict`) | code + band repro |
| T7 short extension | **Yes** (`cork_prepare_orders maker-order`) | probe |
| T8 venue makingAmount 0 | **Yes** (malformed venue row) | probe |
| T1/T9/T10 port domain/rounding | Library-only | both-sides |

## Coverage statement (third pass)
The numeric core is now exhausted by three independent instruments that converge: a property harness
(TS), a differential revert-domain harness (Solidity, in-container), and an automated static pass
(semgrep) — the last surfaced zero net-new structural instances. F8/F6/F13 are upgraded from
"traced" to differentially/source proven. The still-unexecuted item is a **live-fork skim PoC for
F13** (the source across all three legs makes the outcome certain; a PoC would only restamp
"confirmed-empirical"). Everything requiring live-chain/live-venue execution still self-skips offline.
Highest-value remaining fixes, in order: T3 (reachable, wrong amounts), the C11 relabeling (T4/T5/T8),
item-9 primitive guard (T1/T2/T9), and the upstream `createNewPool` fee-validation gap.
