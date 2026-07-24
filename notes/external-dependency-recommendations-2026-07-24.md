# External-dependency recommendations — from the cork-helper-cli footgun audit

*2026-07-24. During the numeric/API footgun audit of **cork-helper-cli** we found several problems
that we cannot fully fix inside the CLI/MCP tool, because their root cause lives in a dependency we
consume: the on-chain contracts, the venue API, the market-registry API, the Envio indexer, or the
remote address file. This note is one section per dependency. For each: **the problem**, **why it
matters to us**, and **the longer-term fix we want**. Owners are guessed from CODEOWNERS / git
history / the investigation notes; wherever we are not sure we left `@owner-tbd` — please don't read
a guess into a blank.*

We have already shipped defensive workarounds in the tool for everything below (guards, warnings,
honest envelopes). These recommendations are about removing the root cause so the workarounds can
eventually retire — and so that **other** consumers of these dependencies, who don't have our
guards, are protected too.

---

## 1. phoenix-private (the Cork Phoenix contracts)

Likely owner: **@ziankork** (top committer on phoenix-private), with **@Pybast** — please confirm.

### 1a. The 5% fee cap is not enforced at pool creation

**Problem.** `MAX_ALLOWED_FEES` (5%) is checked only by the post-creation `updateSwapFeePercentage`
setters. `createNewPool` / `PoolLib.initialize` copy `swapFeePercentage` and
`unwindSwapFeePercentage` verbatim with no cap check. So a pool with a fee at or above 100% is
constructible.

**Why it matters to us.** Our preview math (`previewSwap` / `previewUnwindSwap`, surfaced through
`cork_compute`) computes `gross = mulDiv(desired, 100%, 100% − fee)`. At a fee of 100% the
denominator is zero; above 100% it goes negative and the fee/gross math silently produces a
**negative** amount. We just added guards so the tool refuses instead of serving a negative
"cost" in an `ok` envelope — but the guards are protecting against a pool the protocol should never
have allowed to exist. Any other integrator reading pool state and doing the same arithmetic (this
is the standard preview formula) hits the same negative-number trap.

**The fix we want.** Validate `swapFeePercentage <= MAX_ALLOWED_FEES` and
`unwindSwapFeePercentage <= MAX_ALLOWED_FEES` inside `createNewPool` (and `PoolLib.initialize`), the
same cap the setters already enforce. Then a fee-≥-100% pool is simply not creatable, and the whole
class of downstream negative-amount bugs disappears at the source.

### 1b. Pool expiry has no upper bound

**Problem.** `CorkPoolManager` requires only `expiryTimestamp > block.timestamp`. There is no upper
bound — a pool can be created that expires tens of thousands of years out.

**Why it matters to us.** cPT principal can only be fully redeemed *after* expiry (pre-expiry exit
needs matched cPT+cST pairs). A single unit slip — pasting a millisecond timestamp
(`Date.now()` is ms) where seconds are expected — creates an effectively immortal market that
permanently locks funds once an order against it is filled. Our primary users are LLM agents, the
exact population most prone to this seconds-vs-milliseconds mistake. We now reject ms-scale
timestamps at the tool boundary and require `jitMarket` expiries to be in the future with a
warning above ~5 years, but the chain itself would still accept a 55,000-year expiry from any other
path.

**The fix we want.** Add a sane maximum tenor at creation (e.g. `expiryTimestamp <= block.timestamp
+ MAX_TENOR`, with `MAX_TENOR` a governance parameter). This bounds the blast radius of a unit
mistake regardless of which integrator submits it.

### 1c. The adapter leaves the unused slippage cap behind (skimmable)

**Problem.** For exact-OUT actions (mint, swap, exercise, …) the caller funds the *slippage cap*
(`maxCollateralAssetsIn`, `maxCstSharesIn` + `maxReferenceAssetsIn`, etc.) into the adapter. The
adapter consumes what the action actually needs and **stops** — `CorkAdapter.safeSwap` (and its
siblings) has no line that returns the residual, and `CoreAdapter.erc20Transfer` (reachable through
the public `Bundler3.multicall`) has a full-balance sentinel (`uint256.max`) with no `initiator()` /
whitelist check on the recipient. So whenever consumption < cap — the normal case for *anyone* who
sets a slippage buffer — the leftover sits on the adapter and can be swept by any address in a later
transaction.

**Why it matters to us.** This is the standard Morpho-style adapter invariant ("adapters must end
every transaction holding zero balance"), and it is violated in the common case, not an edge case.
We verified all three legs against the source (funding funds the cap; the adapter does not refund;
the sweep is unguarded). We are proposing a tool-side workaround (append an `erc20Transfer(token,
initiator, uint256.max)` sweep-back leg per capped token) — but that only protects bundles our tool
builds, and it changes fund-moving output, so we're holding it for review. The real fix is in the
adapter.

**The fix we want.** Make the adapter enforce the zero-residual invariant itself: refund any unused
funded amount to the initiator at the end of each action (or require the sweep-back as part of the
canonical action), and gate `erc20Transfer`'s full-balance path so only the initiator can be the
recipient. Then no integrator — ours or anyone's — can accidentally donate their slippage buffer.

---

## 2. api-phoenix (the venue API)

Likely owner: **@owner-tbd** (the api-phoenix service is not one of the repos in this workspace —
please route to whoever owns the venue backend; possibly the same team as market-registry-api).

### 2a. The venue serves malformed / zero-amount order rows

**Problem.** The orderbook/fills endpoints can return rows with a `makingAmount` of `"0"` (the
`Uint` shape permits it) or otherwise malformed signed orders.

**Why it matters to us.** `cork_prepare_orders taker-fill` reads a resting order from the venue and
builds fill calldata. A zero `makingAmount` made our ceil-division throw a `RangeError` that we were
attributing to the *caller* (`invalid_order_terms`) rather than to the venue. We've now reclassified
it as `invalid_service_response` and refuse to build fill bytes — but the venue is still handing out
rows that can't be filled.

**The fix we want.** Validate order rows on the way *in* to the venue (reject zero/malformed
amounts at POST time) and never serve a row that fails its own shape/signature check. A resting
order the venue lists should always be one a taker can actually fill.

### 2b. The dual-scale premium contract is a standing footgun

**Problem.** The same economic quantity — an annualized premium — is expressed on two scales across
the venue's own surfaces: the legacy order-book `premium` field is a **percent number** (`4.1` means
4.1%), while RFQ quote options carry `premium_annualized` as a **fraction string** (`"0.041"` means
the same 4.1%). A 100× ambiguity, inside one API.

**Why it matters to us.** This ambiguity is the single most error-prone boundary in the whole
integration; we maintain scale "tripwires" specifically to catch a fraction pasted into the percent
field (and vice-versa) before relaying, and we had to move that comparison to exact integer
arithmetic because the exactly-100× case was slipping through floating-point rounding. Every new
consumer of the venue has to rediscover this convention and build their own guard.

**The fix we want.** Converge on **one** premium representation across every venue surface (we'd
suggest the fraction string, since it's unambiguous about scale and arbitrary-precision), and
deprecate the other with a versioned field. A single scale removes the class instead of asking
every client to police it.

---

## 3. market-registry-api (the MarketRegistry stack)

Likely owner: **@owner-tbd** (the market-registry-api service repo isn't in this workspace; the JIT
adapter / registry work is referenced in our notes but the service owner is unconfirmed — please
route).

**Problem.** `MarketRegistry.applyBands` resolves a recipe's percentage bands against a rate into
absolute constraints, and the JIT fill path then feeds those resolved constraints into
`createNewPool`. But `createNewPool` requires `0 < rateMin < rateMax`, and there is nothing that
guarantees a recipe's resolved bands satisfy that — e.g. a recipe with a `rateMin` band of exactly
100% resolves to `rateMin = 0`, which `createNewPool` rejects.

**Why it matters to us.** `cork_query market-predict` and the JIT `maker-order` prepare path both
derive a market identity from the registry recipe. We can (and now do) warn when the resolved bands
would fail `createNewPool` — but from the tool's side this looks like a market that has a valid pool
id, valid oracle, and valid cST/cPT, yet whose fill will revert `InvalidParams`. That's a confusing
state to hand an agent: everything looks derivable, but the order can never fill.

**The fix we want.** Guarantee at the registry level that any recipe which can be looked up resolves
(for any legal oracle rate) to bands satisfying `createNewPool`'s invariants — either by validating
recipes at registration time (reject a band set that can resolve to `rateMin = 0` or `rateMin >=
rateMax`), or by having `applyBands` clamp into the valid domain. Then "the recipe resolved" and
"the pool is creatable" are the same statement.

---

## 4. Envio HyperSync (the full-decentralized indexer)

Likely owner: **@owner-tbd** — this is Envio's hosted product, not a Cork repo. The relevant
decision (which chains/deployments we point HyperSync at, and whether the staging PM is indexed) is
ours to make with Envio; route to whoever owns the indexing integration (git history on
**cork-indexing-api** points to **@raouf2ouf**, worth a check).

### 4a. Pagination / silent truncation

**Problem.** HyperSync answers are paged: each response carries a `nextBlock` resume cursor. Our
`queryLogs` wrapper was issuing a single request and discarding `nextBlock`, so any scan larger than
one page was silently truncated with no way to even detect it.

**Why it matters to us.** The `full-decentralized` mode of `cork_query` (markets, fills, rollover
flows) presented counts as complete evidence when they might be a single page of a much larger set.
We've fixed our side (loop on `nextBlock` under a page bound, emit `pagination_incomplete` when the
bound is hit) — this section is a note that the underlying data source is inherently paged and
indexer lag is real, so any consumer must treat a single call as partial.

**The fix we want (from us, coordinated with Envio).** Confirm the archive-height / indexer-lag
behavior we should expect per chain, and agree a page size / range strategy that reliably reaches
tip. This is mostly an integration-hardening item on our side, but it depends on Envio's documented
paging/lag guarantees.

### 4b. Is the staging PM indexed?

**Problem.** We don't have confirmation that the staging pool-manager deployment (and the staging
settlers/factory) are indexed by the HyperSync endpoints we'd query.

**Why it matters to us.** If they aren't, `full-decentralized` reads against staging return an empty
"complete" set that looks like "no activity" rather than "not indexed here" — a silent gap.

**The fix we want.** Confirm which deployments each HyperSync endpoint covers, and if staging is not
covered, either add it or have the tool refuse `full-decentralized` for staging explicitly (so the
gap is disclosed, not silent).

---

## 5. cork-defaults.json (the remote address file)

Likely owner: **@heri16** (top committer on cork-knowledge and a committer on cork-indexing-api;
owns the cork-helper-cli repo where `cork-defaults.json` lives) — please confirm this is the right
person to own publishing it.

**Problem.** `config-remote.ts` fetches the canonical address file from
`raw.githubusercontent.com/Cork-Technology/cork-helper-cli/main/cork-defaults.json`. That URL
currently returns **404** (the repo is private / the path isn't published), so every process falls
back to the **bundled** copy that shipped with the install. The 404 is treated as a deliberate
"not published" state and served silently.

**Why it matters to us.** Running on the bundled fallback means addresses are only as fresh as the
last release. The `marketRegistry.adapter` address is explicitly documented as **volatile** (it
redeploys), so a bundled copy can silently point unsigned transactions at a stale adapter. We've
also hardened the failure path so a transient fetch error no longer overwrites a good disk cache —
but none of that helps while the canonical URL is a 404 and there's nothing fresh to fetch.

Separately: our validation checks the file's **shape** (strict zod schema, checksummed addresses),
not its **authenticity**. A shape-preserving tamper of the remote (or of `CORK_DEFAULTS_URL`) would
swap every address and still validate.

**The fix we want.**
1. **Publish** `cork-defaults.json` at a stable, fetchable canonical URL (public raw path, or a
   dedicated endpoint) so the remote-first path actually works and the volatile adapter address
   stays current.
2. **SHA-pin / sign it.** Publish a content hash (or sign the file) so consumers can verify
   authenticity, not just shape — closing the shape-preserving-tamper gap. We can then verify the
   pin in `config-remote.ts`.

---

## Summary table

| # | Dependency | Problem | Fix we want | Owner |
|---|---|---|---|---|
| 1a | phoenix-private | 5% fee cap not enforced at pool creation | cap-check in `createNewPool` | @ziankork? |
| 1b | phoenix-private | expiry has no upper bound | max-tenor at creation | @ziankork? |
| 1c | phoenix-private | adapter leaves/allows-skim of unused funded cap | refund residual + gate the sweep recipient | @ziankork? |
| 2a | api-phoenix | serves malformed / zero-amount rows | validate on POST; never serve unfillable rows | @owner-tbd |
| 2b | api-phoenix | dual-scale premium (percent vs fraction) | converge on one scale | @owner-tbd |
| 3 | market-registry-api | resolved bands can fail `createNewPool` | validate recipes / clamp `applyBands` | @owner-tbd |
| 4a | Envio HyperSync | pagination / silent truncation | documented paging + lag guarantees | @owner-tbd (@raouf2ouf?) |
| 4b | Envio HyperSync | staging PM indexed? | confirm coverage or disclose the gap | @owner-tbd |
| 5 | cork-defaults.json | canonical URL 404s → bundled fallback; shape-only validation | publish + SHA-pin/sign | @heri16? |
