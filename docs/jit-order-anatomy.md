# Anatomy of a Cork just-in-time (JIT) order

This page gives the contract-level rules of an order whose fill creates a Cork market: what the
order carries, what the adapter does with it, and every way the fill can refuse. It is
**chain-agnostic and address-free on purpose**, so nothing here goes stale on a redeploy. For live
addresses, read the chain: `ch query protocol-config` and `ch query registry-recipes`. For the
end-to-end demand-side walkthrough, see [zyfai-quickstart.md](zyfai-quickstart.md).

Audience: anyone who writes, fills, decodes or audits a JIT order outside the tool. The tool runs
every check below for you and names each refusal with the warning code given in the text.

---

## 1. The idea in one paragraph

Four choices name a Cork market in full: collateral asset, reference asset, expiry and recipe.
So the market can be created at the moment a trade needs it. A JIT order is a 1inch LOP v4 order
that carries the **CorkLimitOrderAdapter** as an interaction hook. When the order fills, the
adapter resolves the market's rate oracle and deploys it if needed, re-checks the rate constraint
the order carries, creates the pool if it does not exist, and, where it applies, mints the cST and
cPT **inside the fill**, funded by the served party's collateral. One transaction does the
market, the mint and the trade.

## 2. The hook payload (`extraData`)

Two layouts of the payload are live, one per adapter generation. The tool's config declares the
wire each generation speaks. The tool never guesses it from the bytes. `ch query protocol-config`
names each generation's `marketRegistry.wire`, and `ch decode order` labels a JIT order with the
generation of the adapter it names (`jit.generation`, `jit.wire`). The tool builds the layout of
the generation you select with `--generation <label>`, the primary when you name none.

### 2a. The `flat` layout — Market Registry 0.3.x (`cork/v0.3`)

The adapter's parameters ride in the order extension as:

```solidity
extraData = abi.encode(JITMarketParams, PermitParams[])
```

```solidity
struct JITMarketParams {
    address collateralAsset;         // CA — pulled from the party served to fund the mint
    address referenceAsset;          // REF
    uint256 expiryTimestamp;         // unix seconds; must be in the future at creation
    address recipe;                  // the approved IMarketRecipe CONTRACT — required, never zero
    uint256 rateOverride;            // FIXED recipes only (see §5); 0 everywhere else
    ResolvedConstraint constraint;   // the four rate limits, resolved OFF-CHAIN at signing time
    bytes   additionalData;          // the recipe-specific bytes the constraint was derived from
    uint256 swapFeePercentage;       // 1e18 = 1% (NOT 1e18 = 1.0); max 5e18 — creation-only
    uint256 unwindSwapFeePercentage; // same scale, same cap — creation-only
    bool    enableJitMint;           // maker path only; the taker path IGNORES it (see §6)
}

struct ResolvedConstraint {          // ABSOLUTE rates: 1e18 = 1.0
    uint256 rateMin; uint256 rateMax;
    uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax;
}

struct PermitParams {                // ERC-2612 permits, executed right after the mint
    address token; uint256 value; uint256 deadline;
    uint8 v; bytes32 r; bytes32 s;
}
```

Field order is load-bearing — the adapter ABI-decodes this exact layout. Maker-side, the
payload is `extension` field 6 (PreInteractionData): the adapter address followed by the
encoded bytes, with the order salt committing to the extension. Taker-side, the same
`adapter ++ extraData` bytes ride in the fill's `args`, with their length packed at takerTraits
bits 200–223.

### 2b. The `nested` layout — Market Registry 0.5.0 (`cork/v0.4`, the primary)

The 0.5.0 adapter wraps the market creator's own struct instead of flattening it:

```solidity
extraData = abi.encode(JITMarketParams, PermitParams[])

struct JITMarketParams {
    MarketParams market;             // the creator's struct, verbatim — one shape for the order AND createNewPool
    bool         enableJitMint;      // maker path only; the taker path IGNORES it (see §6)
}

struct MarketParams {
    address collateralAsset;
    address referenceAsset;
    uint256 expiryTimestamp;
    address recipe;
    uint256 rateOverride;            // FIXED recipes only (§5); 0 everywhere else
    ResolvedConstraint constraint;   // the same four rate limits
    bytes   extraData;               // RENAMED from additionalData — the recipe-specific bytes
    bytes32 oracleSalt;              // NEW: mixed into the CREATE2 salt of the pair's FIRST oracle wrapper; zero is fine
    uint256 swapFeePercentage;       // 1e18 = 1%; on the 10-field pool manager these two are PART OF THE POOL ID
    uint256 unwindSwapFeePercentage;
}
```

`ResolvedConstraint` and `PermitParams` are unchanged. Three things moved with the layout:

- **The registry word is `extraData`.** The tool takes `extraData` on every jitMarket input and
  still accepts `additionalData` as an alias (an info `deprecation_notice`; both present and
  different is refused).
- **`oracleSalt` matters once per pair.** The registry deploys a pair's oracle wrapper with
  `deploy(ca, ref, mode, oracleSalt)`; the salt changes the wrapper's address and is consumed only
  when the wrapper does not exist yet. The tool defaults it to zero. A non-zero salt against a
  `flat` adapter is refused before anything is built — that struct has no salt member.
- **The fees are identity.** The 1.4.0-rc.1 pool manager's `Market` has ten fields: the two fee
  percentages joined the struct, so they are hashed into the pool id. Two orders that differ only
  in a fee name two different markets. The fee bound also changed: strictly below 100%
  (`InvalidFees()` on the pool manager) instead of the 8-field 5% cap; no `MAX_FEE_PERCENTAGE`
  getter exists on this set.

The creator (`CorkMarketCreator`, shipped inside the registry package since 0.5.0) exposes
`createNewPool(MarketParams) → (poolId, cst, cpt)` over the same struct, so an order's market
block and the ahead-of-fill creation call (`ch prepare market create-pool`) are one shape.
`recipe.verify` also grew: `verify(ca, ref, oracle, expiryTimestamp, creating, constraint,
extraData)` — the pool expiry and a `creating` flag ride in, so a recipe can apply a different
rule to a fill that would create the market than to one that only mints on it.

**Where the three linked fields come from.** `recipe`, `constraint`, and `extraData`
(`additionalData` on the flat layout) must agree — the constraint is whatever *that* recipe derives from *that* payload. Fill all three
from one `ch compute recipe-rate-constraint` call (a staticcall to `recipe.resolve`, the same
derivation the fill re-checks) and they cannot disagree. Deriving them independently is how
orders end up permanently unfillable.

**Identity is pinned at signing.** The pool id is the hash of the market struct, and the four
constraint values are part of it — so the moment an order carrying them is signed, the pool id
and the CREATE2-predicted cST/cPT addresses are fixed, however far the live rate moves
afterwards. Staleness is guarded at fill time instead, by `recipe.verify` (§4, step 4). Until
something is signed, a fresh resolve can produce a *different* constraint — and therefore a
different market — whenever the oracle rate has moved; the tool refuses an order whose sides
don't match its own derivation (`jit_side_mismatch`).

## 3. The permit rule

A pool's share tokens do not exist until the pool does, and a token with no code cannot be
approved — so nothing can grant the LOP its allowance over a just-minted cST in advance. The
bridge is the ERC-2612 permit: the share-token addresses are predictable, so the served party
signs a permit **against the predicted address**, the order carries it, and the adapter
executes it the moment the token is real.

The rule, in full:

- **Who signs:** the party being served by the hook — the maker on the maker path, the taker
  on the taker path. The counterparty never signs a permit and never needs to.
- **The spender is always the limit order protocol.** The permit exists so the LOP can pull the
  newborn token during the same fill; no other spender is ever correct.
- **When it executes:** immediately after the JIT mint, inside the fill. One failed permit
  reverts the entire fill — market creation, mint, and trade unwind together.
- **An empty `PermitParams[]` is valid** — an order that doesn't mint (existing market,
  `enableJitMint: false`) needs no permit, and pre-held inventory covered by a standing
  approval doesn't either.
- **Strict ECDSA.** The share tokens' `permit` recovers a private-key signature; a contract
  account (a Safe) cannot produce one. A contract that needs the newborn-token allowance must
  be positioned to `approve` mid-transaction instead — which only a contract *taker* can do.

**Interaction with `fillOrderForSelf` (the ForSelf adapter route):** none, by design. The
order-carried permit belongs to the *maker* and still names the LOP as spender; the ForSelf
caller's own taker-asset approval goes to the ForSelf adapter, which grants the LOP a
transient per-fill allowance itself. The two allowance systems never touch. (The ForSelf route
structurally cannot host the *taker-side* mint — it zeroes the taker-interaction bits — so
through it, JIT orders are fillable exactly when the mint is on the maker's side.)

## 4. What happens during a fill

Four checks, in order, then the work:

1. **Membership.** `isRecipe(recipe)` must be true on the adapter's pinned registry. There is
   no unverified path and no zero-address special case. Refusal: `RecipeNotRegistered`.
2. **Kind.** The adapter reads `recipe.source()` — `price`, `nav`, or `fixed` — to learn which
   oracle family the market needs.
3. **Oracle.** A fixed recipe gets `deployFixedRateOracle(rateOverride)`; a price/nav recipe
   gets `deploy(ca, ref, mode)` (flat) or `deploy(ca, ref, mode, oracleSalt)` (nested). Both
   registry calls are permissionless and idempotent —
   deploying an oracle that exists just returns it — so a missing oracle is never a reason a
   fill fails. Every path yields a real, non-zero oracle.
4. **Verification.** `recipe.verify(...)` re-checks the carried constraint against the live
   rate (five arguments on the flat wire; seven on the nested wire, with the pool expiry and a
   `creating` flag). `false` means the constraint is stale — or was never one this recipe would produce —
   and the fill reverts `RecipeRejectedConstraint` until a fresh constraint is signed.

Then the pool id is derived from the market struct, the pool is created if it does not exist
(whitelist **disabled**, not configurable — a gated pool would refuse the adapter's own mint),
and the mint runs if it applies (§6).

## 5. `rateOverride` — fixed recipes only, rejected elsewhere

A fixed-rate market's rate is not a fact about the two assets, so there is no pair feed to
wrap; the **order names the rate** and the registry deploys (or reuses — CREATE2-salted on the
rate) a `FixedRateOracle` for it. For `price` and `nav` recipes the field must be zero, and a
non-zero value is **rejected (`UnexpectedRateOverride`), not ignored**: a silently ignored
number in a signed payload would leave a trail claiming the order chose the rate when nothing
read it. Zero on a fixed recipe also reverts — a fixed oracle at rate zero is meaningless.

## 6. The two entry points, and the `enableJitMint` asymmetry

Both entry points reject any caller that is not the limit order protocol
(`OnlyLimitOrderProtocol`) — the adapter cannot be driven directly.

- **`preInteraction` — the maker path.** Runs before the maker asset moves. Always ensures the
  market exists; whether it *mints* follows `enableJitMint`. Flag off: the maker must already
  hold the Cork tokens it is selling. Flag on: they are minted just in time, funded by the
  maker's own collateral (the maker approves the adapter for CA), and the maker's permit lets
  the LOP pull them.
- **`takerInteraction` — the taker path.** Runs mid-fill, after the maker asset moves and
  before the taker asset is pulled. It **ignores `enableJitMint` and always mints** — attaching
  the hook to the taker side *is* the opt-in, so a separate flag would be redundant. Read
  consequence: `enableJitMint: false` decoded from a resting BUY order does **not** mean "this
  lift won't mint"; the taker's own interaction decides that.

## 7. Events

| Event | Signature | Meaning |
|---|---|---|
| `JITMarketCreated` (flat adapter) | `JITMarketCreated(bytes32,address,address,address,uint256,address)` | The fill created a market that did not exist: pool id, rate oracle, the pair, the expiry, and the **recipe contract address**. (The pre-2.1.0 generation's event carried a `string` mode in the last slot instead — the two have different topic0s.) |
| `MarketCreated` (creator, nested) | `MarketCreated(bytes32,address,address,address,uint256,address,uint256,uint256,address)` | The 0.5.0 adapter emits no `JITMarketCreated`. Creation is announced by the **creator**: pool id, rate oracle, the pair, the expiry, the recipe, both fees, and the indexed `caller` (the adapter on a fill). |
| `MarketCreated` (pool manager) | 7 arguments on an 8-field manager; 9 on a 10-field one (the two fees appended) | Two different topic0s. A scanner keyed on the 8-field form sees nothing on a 10-field manager. Decode each log with the ABI of its emitter's wire, never by guessing from the topic. |
| `JITMinted` | `JITMinted(bytes32,address,uint256,uint256)` | Cork tokens were minted during the fill (both adapter generations, same layout). |

`ch track` reconciles fills without touching these directly; the signatures are here for
integrators wiring their own log-based reconciliation.

## 8. The full refusal table

Adapter errors (raised inside the fill):

| Error | Cause |
|---|---|
| `OnlyLimitOrderProtocol` | The hook was called by anything other than the configured LOP |
| `RecipeNotRegistered` | The order's `recipe` is not approved on the registry (raised by the registry) |
| `UnexpectedRateOverride` | Non-zero `rateOverride` on a recipe that does not read one |
| `RecipeRejectedConstraint` | `recipe.verify` returned false — the carried constraint is stale or foreign |
| `OrderNotForPool` | Neither order side is the derived market's share token |
| `RateUnavailable` | The rate oracle reported zero at the moment the fill would **create** the pool |
| `MintUnavailable` | The pool cannot mint — paused or expired |
| `MintAmountDrift` | The mint spent a different collateral amount than quoted |
| `ZeroAddress` | A constructor argument was zero (deploy-time only) |

Creation-bounds errors (raised by the registry/controller when the fill would *create* the
market, added in the 0.3.x line):

| Error | Cause |
|---|---|
| `ExpiryOutOfRange` | The market would live longer than the registry's `maxExpiryDuration` (inclusive bound; 30 days at deployment, governance-movable) |
| `SwapFeeOutOfRange` | 8-field pool manager (`cork/v0.3`): a fee field above the 5% cap (`5e18` on the 1e18-=-1% scale) |
| `InvalidFees` | 10-field pool manager (`cork/v0.4`): a fee field at or above 100% (`100e18`); there is no `MAX_FEE_PERCENTAGE` getter on this set |
| `InvalidRate` | 10-field pool manager: the oracle's live rate falls outside the carried constraint at creation — the lesson of the first nested rehearsal: an anchor of 1.0 on an undeployed NAV pair whose vault rate is 1.09 builds a market the fill rejects |

The tool's pre-flights surface most of these before anything is signed: `recipe_not_found`,
`recipe_refused`, `jit_side_mismatch`, `constraint_window_notice`, and `invalid_order_terms`
(fees over cap) map onto this table, and `ch track simulate` dry-runs the exact frozen bytes.

## 9. The adapter itself — what an auditor leans on

Stateless and custody-free: no owner, no admin functions, no upgrade path, no persistent
storage (the reentrancy guard uses transient storage), and it never holds tokens beyond the
fill transaction. Its deployment parameters are immutables, readable on chain — flat adapter:
`LIMIT_ORDER_PROTOCOL`, `POOL_MANAGER`, `CONTROLLER`, `MARKET_REGISTRY`; nested adapter:
`LIMIT_ORDER_PROTOCOL`, `POOL_MANAGER`, `MARKET_CREATOR`, and the creator in turn exposes
`CONTROLLER`, `MARKET_REGISTRY`, `POOL_MANAGER`.

**The one check that rules out the previous-generation hazard:** confirm the adapter binds the
registry your integration pins (the Distribution manifest / `ch query protocol-config`) — on the
flat adapter `MARKET_REGISTRY()`, on the nested adapter the chain `MARKET_CREATOR()` →
`creator.MARKET_REGISTRY()`, with one `POOL_MANAGER` end to end. Abandoned generations of both contracts remain live and **answer
current-shaped calls with plausible-looking values instead of reverting** — an address
"working" proves nothing about it being current. `ch` runs this guard on every order prepare
and refuses a mismatch (`adapter_binding_mismatch`); run it manually when you build calls in
your own stack or deploy periphery (e.g. a ForSelf adapter) from copied constructor addresses.

**Roles precondition.** Fills work only once governance has granted the creating contract its
roles on the Cork controller (the deploy script deliberately cannot grant them). WHO holds them
depends on the generation:

| Generation | Role holder | Roles |
|---|---|---|
| `cork/v0.3` (flat, v1.3 controller) | the adapter | `POOL_CREATOR_ROLE` + `FEE_MANAGER_ROLE` |
| `cork/v0.4` (nested, 1.4.0-rc.1 controller) | the **creator** — the adapter holds no role | `POOL_CREATOR_ROLE` only; the 1.4.0 controller has no `FEE_MANAGER_ROLE` |

| Role | Hash |
|---|---|
| `POOL_CREATOR_ROLE` | `0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52` |
| `FEE_MANAGER_ROLE` (v1.3 only) | `0x6c0757dc3e6b28b2580c03fd9e96c274acf4f99d91fbec9b418fa1d70604ff1c` |

Confirm with `hasRole(hash, holder)` on the controller — order prepares disclose missing grants
as `roles_not_granted`, probing the holder the target generation names. Generation notes: the
v1.3 controller split fee authority out of the older `CONFIGURATOR_ROLE` into
`FEE_MANAGER_ROLE`; **on the v1.3 stack the adapter holds `FEE_MANAGER_ROLE` and does *not*
hold `CONFIGURATOR_ROLE`** (verified on-chain 2026-08-12), so a monitor checking the old pair
reports a false negative against a live fill path. Pre-v1.3 controllers have no
`FEE_MANAGER_ROLE()` getter at all, and the 1.4.0 controller dropped it again — a probe of that
getter is one way to tell the three controller generations apart; the roles moved from the
adapter to the creator with 0.5.0 (verified live 2026-09-22: the creator has `POOL_CREATOR_ROLE`,
the adapter does not).
