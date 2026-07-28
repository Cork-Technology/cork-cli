# 1inch Fusion integration plan (dutch-auction-price and beyond)

Date: 2026-07-28. Status: **proposed** (owner review). Builds on
`notes/research/fusion-dutch-auction.md` (2026-07-16 byte-level research, re-verified today) and
the empirical spike `experiments/fusion-spike/` (run 2026-07-28 against live mainnet + Arbitrum).

The ask: `cork_compute dutch-auction-price` is one of the two remaining phase-gated variants
("out-of-scope external protocol; unblocks if/when a Fusion integration lands"). This note builds
the mental model of what a Fusion integration actually is, verifies the live surface empirically,
and lays out a phased plan — including which phases we should NOT build.

---

## 1. Mental model: Fusion is four separable layers

"Fusion" is not a protocol we integrate with as a unit. Decomposed against LOP v4 (which we
already ship end-to-end: maker orders, JIT extension, taker fills, cancels, invalidator reads):

| Layer | What it is | Where it lives | Coupling |
|---|---|---|---|
| **L1: auction math** | Pure function `price(auctionDetails, feeData, taker, basefee, timestamp)` — piecewise-linear rate bump (1e7 base), fee markup (1e5 base), asymmetric ceil/floor nesting | `SimpleSettlement` getters, deployed as PUBLIC `IAmountGetter` views | none — anyone may call/replicate |
| **L2: extension encoding** | LOP v4 extension fields `makingAmountData`/`takingAmountData` = 20-byte getter address ‖ extraData; salt low-160 binding | `ExtensionLib` — we already implement this byte layout for the JIT adapter | none — our code already does this |
| **L3: access control** | Resolver whitelist time-cascade, access-token gate, surplus fee, mainnet priority-fee cap | `postInteraction` of the SAME settlement contract — engaged **only** if the order's `postInteractionData` points at it | opt-in per order |
| **L4: order-flow network** | Quoter/relayer APIs (auth-gated), KYC'd staked resolvers, Trade Mode | 1inch infrastructure | 1inch's moat; requires their business rails |

**The load-bearing observation:** L1+L2 are permissionless and fully specified; L3 is opt-in *per
order* (an order that does not point its `postInteractionData` at the settlement is priced by L1
but gated by nobody); L4 is the only part that is genuinely "1inch's network". Pricing an existing
Fusion order needs L1+L2 knowledge only. Running our OWN dutch auctions needs L1+L2 only. Neither
needs L3/L4.

### Interaction with what we already ship

- The JIT market extension occupies `preInteractionData` (field 6). Auction getters occupy fields
  2–3. Post-interaction is field 7. **One extension can carry JIT creation AND auction pricing**;
  the single salt↔keccak(extension) binding covers both; makerTraits flags are independent
  (`PRE_INTERACTION_CALL` for JIT, no `POST_INTERACTION_CALL` unless L3 is wanted).
- `taker-fill` already builds canonical uint256-tuple fills and passes extension bytes verbatim —
  a fill of an auction-priced order is the same calldata, just with a time-dependent
  `maximumTakingAmount` that F0's math computes.
- `track` already reads LOP invalidators — remaining-amount state for partially-filled auction
  orders is already built.
- The still-gated `rfq-quote` wants a pricing MODEL. A decaying-premium auction converts "quote a
  premium" into "let time discover the premium" — L1 as product, no model required. That is the
  strategic reason this integration matters beyond observability.

---

## 2. Empirical ground truth (2026-07-28, `experiments/fusion-spike/`)

### 2.1 Repo/docs freshness (vs the 2026-07-16 research)

- `1inch/fusion-protocol` master = **v3.1.2**, pins `@1inch/limit-order-protocol-contract@4.3.2`.
  Unchanged since the research note; no v4 in sight. OpenZeppelin audited the refactor (2025).
- `@1inch/fusion-sdk` **2.4.11 published 2026-07-27** (yesterday) — actively maintained;
  `AuctionCalculator.calcRateBump(time, baseFee)` remains the reference implementation.
  `@1inch/limit-order-sdk` 5.3.1 (local clone available).

### 2.2 Live deployments (eth_getCode / owner() / artifact ABI, both chains)

| Contract | Mainnet (1) | Arbitrum (42161) |
|---|---|---|
| **Settlement v3.1 `0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5`** | live, 7,769 B (`Settlement` — adds priority-fee cap) | live, 7,648 B (`SimpleSettlement`) — same CREATE3 address, **different bytecode by design** |
| v3.1 `owner()` | `0x9F8102b1bB05785BaD2874f2C7B1aaea4c6D976a` | `0x0f6E3fB5D73AFd2e594AC4b962E57E603E650875` — both transferred from the deploy-arg owner `0x56E448…6dcF` |
| Settlement v2 `0xfb2809A5314473E1165f6B58018E20ed8F07B840` | live, 5,639 B | live, 5,565 B |
| Settlement v1 `0xA88800CD213dA5Ae406ce248380802BD53b47647` | live (LOP v3 era) | **NO CODE** — corrects the research note's "same address" claim for v1/Arbitrum |
| Access token `0xAccE550000863572B867E661647CD7D97b72C507` | live | live |
| `0xf4F4D19c3ae690c412460A5948757180642364bf` (search hit) | live, 3,936 B | no code — not in `deployments/`; legacy/unrelated, do not use |

Constructor args from `deployments/{mainnet,arbitrum}` artifacts: `(LOP 0x1111…2A65, accessToken
0xAccE…C507, WETH-per-chain, owner)` — settlement is bound to the same router our LOP stack uses.

### 2.3 The selector trap, again

The deployed getter ABI (from `deployments/arbitrum/SimpleSettlement.json`) declares the Order
tuple as **all `uint256`** (`type Address is uint256`): `getTakingAmount((uint256×8),bytes,bytes32,
address,uint256,uint256,bytes)` → selector `0xd7ff8a80`. An address-typed tuple produces a
different selector and an **empty revert** (no fallback). Identical failure class to the
`fillOrderArgs` finding (`0xf497df75`, 2026-07-23 fork round-trip). Every future 1inch-adjacent
call site must use the uint256-tuple form.

### 2.4 Parity: local math vs deployed getters — **10/10 wei-exact**

`probe.ts` ports the full v3.1 pricing chain (~60 lines: rate-bump interpolation → 1e5 fee markup
with whitelist discount → 1e7 bump, exact ceil/floor nesting) and asserts against `eth_call` on
the LIVE settlement at a pinned block, on **both chains**, both directions (taker-pays ceil chain,
maker-gives floor chain), five vectors: mid-auction interpolation, fees + whitelisted-taker
discount (200→150 via 75/100), gas-bump coupling, pre-start (bump pinned at initial), post-finish
(bump 0). All PASS to the wei.

### 2.5 `eth_call` executes with `block.basefee = 0` on public nodes

Proven by `basefee-check.ts`: `gasPriceEstimate=1` (which would zero the bump if basefee>0)
returns the un-bumped price on both chains. Consequences: (a) the gas-bump term cannot be
parity-tested via public `eth_call` — F0's acceptance uses an anvil fork with basefee control
(existing podman cork-anvil recipe); (b) any future RPC "verification leg" for auction prices must
inject basefee explicitly; (c) the schema's existing `baseFeeWei` input is the right design —
deterministic, mirrors `AuctionCalculator.calcRateBump(time, baseFee)`, and `baseFeeWei` omitted ⇒
gas bump skipped ⇒ **upper-bound price** (safe direction for a taker).

---

## 3. Requirements this must satisfy (from RFC 011 / CLAUDE.md invariants)

- **K1**: pricing and building only — never sign/broadcast. All phases below are unsigned-bytes or
  pure math.
- **K3**: reconstruct from bytes. The price lives in the EXTENSION, not in any caller-supplied
  parse: decode `makingAmountData` ourselves, verify the salt low-160 binding, cross-check
  `takingAmountData == makingAmountData` (fusion-sdk's own invariant), classify the settlement
  address against the known set.
- **Bit-exact math, empirically verified** — §2.4 already satisfies the wei-for-wei bar for the
  core; acceptance re-runs it in CI-able form (golden vectors offline + gated live parity).
- **Determinism/pinning**: price is `f(extension, taker, basefee, timestamp)`. `ctx.nowSeconds`
  pins the clock; `at.timestamp` (currently accepted-but-reserved) becomes REAL for this kind —
  it is the one compute input that is time-based rather than block-based.
- **Honest envelopes**: unknown settlement address ⇒ decode as v3-shape but warn unverified; v2
  (`0xfb2809…`) ⇒ classified and refused with its own reason until/unless the v2 parser is worth
  building (the v2 book has been superseded since May 2025 — likely never); v1 ⇒ recognized,
  refused (LOP v3, out of scope). `scales` block on every money/rate output (1e7 rate-bump base,
  1e5 fee base, native token decimals echoed).
- **No new tools** — everything lands inside existing variants (`compute dutch-auction-price`,
  `decode order`, `prepare_orders maker-order`, `prepare_orders taker-fill`).

---

## 4. The plan, phased

### F0 — activate `cork_compute dutch-auction-price` (pure local; ~1 session)

Un-gates the variant for its honest purpose: price any LOP-v4 Fusion order, deterministically,
offline.

- `packages/core/src/fusion.ts`: extension→auction decode (v3.1 layout §3 of the research note) +
  the pricing chain — the probe's implementation graduates into source, with the same names the
  contracts use.
- Input (existing schema shape, tightened semantics): `order` = the 8 struct fields **plus
  `extension` bytes** (same record convention as `decode order`); optional `baseFeeWei` (omitted ⇒
  gas bump skipped ⇒ upper bound, disclosed); optional `taker` (whitelist-discounted vs
  access-token price — compute both when absent); `at.timestamp` honored (falls back to
  `ctx.nowSeconds`), flipping that field out of "reserved" for this kind only.
- Output: current `takerPays`/`makerGives` for the requested amount (default: full order), current
  rateBump + auction phase (`pre-start` / `decaying` / `floor`), the decoded auction curve
  (start, duration, initial bump, points), fee split, fillability gates (makerTraits expiry,
  `resolvingStartTime` cascade window, mainnet priority-fee-cap notice), `scales` block.
  Cross-checks on conflicts: salt↔extension mismatch ⇒ `extension_salt_mismatch`;
  `takingAmountData != makingAmountData` ⇒ decode conflict.
- **Acceptance**: (a) offline golden vectors generated independently from `@1inch/fusion-sdk`
  2.4.11 `AuctionCalculator` (devDependency of a test only — runtime stays dependency-light);
  (b) live parity suite = probe vectors as a gated test (`CORK_RPC_LIVE=1`, both chains);
  (c) anvil-fork vector with a forced basefee for the gas-bump term; (d) MATURITY flip with an
  honest reason + worked example + teaching + surface-drift regen; (e) maturity probe removed —
  after F0, **rfq-quote is the last `specified` variant in the map**.

### F1 — observability composition (small, mostly wiring)

- `cork_decode order`: when the record/tuple carries an extension whose `makingAmountData[0:20]`
  is a known settlement, label it (`fusion: {version, settlement, auction summary}`) — reuses
  `fusion.ts` decode wholesale.
- Optional executable-quote leg: given an orderHash + RPC, join F0's price with the existing LOP
  invalidator reads (remaining amount) — "what would filling this order cost right now",
  disclosed as two legs (pure price + chain remaining).

### F2 — Cork-native decaying-premium orders (strategic; needs an owner/product decision)

The synthesis: reuse the **deployed, audited** settlement getter as a plain amount-getter for
Cork's own venue orders — L1+L2 without L3/L4.

- `prepare_orders maker-order` gains an optional `auction` block (start/duration/initialBump/
  points): build `makingAmountData`/`takingAmountData` = `0x2Ad5…1Ef5 ‖ auctionDetails ‖ zeroed
  fee section ‖ empty whitelist`, NO postInteraction pointing at the settlement ⇒ **any taker can
  fill at the decayed price through the existing plain LOP fill path**. §2.4 already proved the
  getters answer standalone with exactly this shape (zero fees, empty whitelist) — the risky
  assumption is pre-verified.
- Composes with `jitMarket` (different extension fields, one salt binding) — a JIT-created
  coverage market whose first fill price decays until a taker accepts.
- `taker-fill` computes the current price via F0 math to set an honest `maximumTakingAmount`
  (plus a "quote decays; simulate before broadcast" disclosure).
- **Why this matters**: it answers the rfq-quote gate without a pricing model — the auction
  discovers the premium. RFQ answers could carry auction parameters instead of a point premium.
- **Open questions for the owner (blocking F2, not F0/F1):**
  - Q-FUSION-VENUE: the venue book lists a static `premium` percent; a decaying order needs a
    listing convention (initial? floor? computed-current?) and possibly venue-side support.
  - Q-FUSION-GETTER-PIN: rely on 1inch's deployed getter (zero new contracts, but its owner is a
    1inch multisig and future protocol fee changes are theirs) vs. deploying Cork's own minimal
    ~40-line auction getter (full control, CREATE2-attestable in cork-defaults, one small audit).
    Recommendation: start on the deployed getter (it is immutable code; ownership only matters
    for L3 features we don't use), revisit if Cork auctions become core flow.

### F3 — full Fusion network participation: **deliberately not planned**

Joining L4 means quoter/relayer API auth, KYC'd staked resolvers, and resolver appetite to price
cST — an exotic token with no external liquidity model. No resolver will quote it; Cork's flow
would strand. The only plausible L4 use is treasury swaps of mainstream assets, which is a
different product and should be a separate proposal if ever wanted. The `dutch-auction-price`
gate reason after F0 should therefore change from "unblocks if a Fusion integration lands" to
simply *activated* — because the integration that makes sense (L1+L2) will have landed.

---

## 5. Risks & pinned gotchas

1. **Selector trap** (§2.3) — uint256 tuple everywhere; regression-tested by the parity suite.
2. **`eth_call` basefee=0** (§2.5) — never "verify" a gas-bumped price via plain eth_call.
3. **Version drift**: classify by settlement address, never assume layout; unknown address =
   decode-with-warning, v2/v1 = honest refusal. fusion-protocol master is stable at 3.1.x with an
   OZ-audited refactor; watch the `deployments/` dir on release tags.
4. **Encoding bounds**: point `timeDelta` is uint16 (≤ ~18.2 h per segment), `rateBump` uint24
   (≤ +167.77%), duration uint24 (≤ ~194 days) — ample for coverage premiums; enforce at build
   time in F2 with teaching errors.
5. **Partial fills don't move the unit price** — remaining-size is chain state (invalidator), the
   curve is not; keep the two legs separately labeled.
6. **fusion-sdk as devDependency only** — golden-vector generation, never runtime (Bun-only repo,
   dependency-light CLI; the math is ~60 proven lines).

## 6. Artifacts

- `experiments/fusion-spike/probe.ts` — deployment verification + 10/10 parity (rerunnable).
- `experiments/fusion-spike/basefee-check.ts` — the eth_call basefee=0 proof.
- `experiments/fusion-spike/debug-revert.ts` — the selector-trap bisection trail.
- Research note: `notes/research/fusion-dutch-auction.md` (byte layouts; one correction: v1
  settlement is NOT on Arbitrum).
