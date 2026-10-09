# Anatomy of a Cork just-in-time (JIT) order

This page gives the contract-level rules for an order whose fill creates a Cork market. It says
what the order carries, what the adapter does with it, and every way the fill can refuse. The
page is **chain-agnostic and address-free on purpose**, so a redeploy cannot make it stale. For
live addresses, read the chain: `ch query protocol-config` and `ch query registry-recipes`. For
the end-to-end demand-side walkthrough, see [zyfai-quickstart.md](zyfai-quickstart.md).

Audience: anyone who writes, fills, decodes or audits a JIT order outside the tool. The tool runs
every check below for you. It names each refusal with the warning code that the text gives.

---

## 1. The idea in one paragraph

Four choices name a Cork market in full: collateral asset, reference asset, expiry and recipe.
So a trade can create the market at the moment it needs it. A JIT order is a 1inch LOP v4 order
that carries the **CorkLimitOrderAdapter** as an interaction hook. When the order fills, the
adapter resolves the market's rate oracle and deploys it if necessary. It re-checks the rate
constraint that the order carries. It creates the pool if the pool does not exist. Where it
applies, it mints the cST and cPT **inside the fill**, funded by the served party's collateral.
One transaction does the market, the mint and the trade.

## 2. The hook payload (`extraData`)

Two layouts of the payload are live, one for each adapter generation. The tool's config declares
the wire that each generation speaks; the tool never guesses the wire from the bytes.
`ch query protocol-config` names each generation's `marketRegistry.wire`. `ch decode order`
labels a JIT order with the generation of the adapter it names (`jit.generation`, `jit.wire`).
The tool builds the layout of the generation that you select with `--generation <label>`. If you
name none, it builds the layout of the primary.

### 2a. The `flat` layout — Market Registry 0.3.x (`phoenix/v0.3-rc.1`)

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

Field order is load-bearing: the adapter ABI-decodes this exact layout. On the maker side, the
payload is `extension` field 6 (PreInteractionData): the adapter address followed by the encoded
bytes. The order salt commits to the extension. On the taker side, the same
`adapter ++ extraData` bytes ride in the fill's `args`. Their length is packed at takerTraits
bits 200–223.

### 2b. The `nested` layout — Market Registry 0.5.0 and 0.6.0 (`phoenix/v0.4-rc.1`, and `phoenix/v0.5`, the primary)

The two sets share this layout. They differ only in the permit row, which the set declares as
`marketRegistry.jitPermitWire`. `phoenix/v0.4-rc.1` (adapter 0.4.0, `0x3E01…B104`) carries
`(token, value, deadline, uint8 v, bytes32 r, bytes32 s)`. `phoenix/v0.5` (adapter 0.5.0,
`0x960C…0616`) carries `(token, value, deadline, bytes signature)`, and a contract wallet can sign
that row through ERC-1271. The rest of this section applies to both sets.

The nested adapter (0.4.0 and 0.5.0) wraps the market creator's own struct instead of flattening it:

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

`ResolvedConstraint` is unchanged. `PermitParams` is the set's permit row (see above):
`bytes signature` on `phoenix/v0.5`, `v`/`r`/`s` on `phoenix/v0.4-rc.1`. The SDK type carries one
`signature` either way and splits it for the v/r/s row. Three things moved with the layout:

- **The registry word is `extraData`.** The tool takes `extraData` on every jitMarket input. It
  still accepts `additionalData` as an alias, with an info `deprecation_notice`. If both are
  present and different, the tool refuses the input.
- **`oracleSalt` matters once per pair.** The registry deploys a pair's oracle wrapper with
  `deploy(ca, ref, mode, oracleSalt)`. The salt changes the wrapper's address. The registry uses
  the salt only when the wrapper does not exist yet. The tool sets the salt to zero by default.
  The tool refuses a non-zero salt against a `flat` adapter before it builds anything, because
  that struct has no salt member.
- **The fees are identity.** The 1.4.0-rc.1 pool manager's `Market` has ten fields. The two fee
  percentages joined the struct, so the pool id hashes them. Two orders that differ only in a fee
  name two different markets. The fee bound also changed: a fee must be strictly below 100%
  (`InvalidFees()` on the pool manager). This rule replaces the 8-field 5% cap. This set has no
  `MAX_FEE_PERCENTAGE` getter.

The creator (`CorkMarketCreator`, shipped inside the registry package since 0.5.0) exposes
`createNewPool(MarketParams) → (poolId, cst, cpt)` over the same struct. So an order's market
block and the ahead-of-fill creation call (`ch prepare market create-pool`) have one shape.
`recipe.verify` also grew: `verify(ca, ref, oracle, expiryTimestamp, creating, constraint,
extraData)`. The pool expiry and a `creating` flag ride in. Thus a recipe can apply one rule to a
fill that would create the market, and a different rule to a fill that only mints on it.

**Where the three linked fields come from.** `recipe`, `constraint`, and `extraData`
(`additionalData` on the flat layout) must agree. The constraint is what *that* recipe derives
from *that* payload. Fill all three from one `ch compute recipe-rate-constraint` call, and they
cannot disagree. That call is a staticcall to `recipe.resolve`, the same derivation that the fill
re-checks. Independent derivation of the three fields is how orders become permanently
unfillable.

**Identity is pinned at signing.** The pool id is the hash of the market struct, and the four
constraint values are part of it. So when someone signs an order that carries them, the pool id
and the CREATE2-predicted cST/cPT addresses become fixed. They stay fixed however far the live
rate moves afterwards. Instead, `recipe.verify` guards against staleness at fill time (§4,
step 4). Before anyone signs, a fresh resolve can give a *different* constraint whenever the
oracle rate has moved, and so a different market. The tool refuses an order whose sides do not
match its own derivation (`jit_side_mismatch`).

## 3. The permit rule

A pool's share tokens do not exist until the pool exists. Nobody can approve a token that has no
code. So nothing can grant the LOP its allowance over a just-minted cST in advance. The ERC-2612
permit bridges this gap. The share-token addresses are predictable, so the served party signs a
permit **against the predicted address**. The order carries the permit, and the adapter executes
it the moment the token is real.

The rule, in full:

- **Who signs:** the party that the hook serves: the maker on the maker path, the taker on the
  taker path. The counterparty never signs a permit and never needs to.
- **The spender is always the limit order protocol.** The permit exists so that the LOP can pull
  the newborn token during the same fill. No other spender is ever correct.
- **When it executes:** immediately after the JIT mint, inside the fill. One failed permit
  reverts the entire fill: market creation, mint and trade unwind together.
- **An empty `PermitParams[]` is valid.** An order that does not mint (existing market,
  `enableJitMint: false`) needs no permit. Pre-held inventory under a standing approval needs
  none either.
- **Who can sign depends on the set's permit row** (`marketRegistry.jitPermitWire`).
  - `phoenix/v0.5` (the primary, adapter 0.5.0) takes one `bytes signature`. The tool passes it
    verbatim. A contract wallet (a Safe) can sign through ERC-1271.
  - `phoenix/v0.4-rc.1` (adapter 0.4.0) takes `v`, `r`, `s`: a private-key signature only. The
    tool splits a 65-byte `signature` (r‖s‖v) and refuses any other length. On this set a
    contract that needs the newborn-token allowance must `approve` mid-transaction instead, and
    only a contract *taker* can do that.

**Interaction with `fillOrderForSelf` (the ForSelf adapter route):** none, by design. The
order-carried permit belongs to the *maker* and still names the LOP as spender. The ForSelf
caller approves its taker asset to the ForSelf adapter, and that adapter grants the LOP a
transient allowance for each fill. The two allowance systems never touch. (The ForSelf route
zeroes the taker-interaction bits, so by structure it cannot host the *taker-side* mint. Through
it, a JIT order is fillable exactly when the mint is on the maker's side.)

## 4. What happens during a fill

Four checks, in order, then the work:

1. **Membership.** `isRecipe(recipe)` must be true on the adapter's pinned registry. No
   unverified path and no zero-address special case exist. Refusal: `RecipeNotRegistered`.
2. **Kind.** The adapter reads `recipe.source()` (`price`, `nav`, or `fixed`) to learn which
   oracle family the market needs.
3. **Oracle.** A fixed recipe gets `deployFixedRateOracle(rateOverride)`. A price/nav recipe
   gets `deploy(ca, ref, mode)` (flat) or `deploy(ca, ref, mode, oracleSalt)` (nested). Both
   registry calls are permissionless and idempotent: a deploy of an existing oracle just returns
   it. So a missing oracle is never a reason for a fill to fail. Every path yields a real,
   non-zero oracle.
4. **Verification.** `recipe.verify(...)` re-checks the carried constraint against the live
   rate. It takes five arguments on the flat wire and seven on the nested wire; the extra two
   are the pool expiry and a `creating` flag. `false` means the constraint is stale, or this
   recipe would never produce it. The fill then reverts `RecipeRejectedConstraint` until someone
   signs a fresh constraint.

Then the adapter derives the pool id from the market struct. It creates the pool if the pool does
not exist, with the whitelist **disabled** (not configurable: a gated pool would refuse the
adapter's own mint). Last, the mint runs if it applies (§6).

## 5. `rateOverride` — fixed recipes only, rejected elsewhere

A fixed-rate market's rate is not a fact about the two assets, so no pair feed exists to wrap.
Instead, the **order names the rate**. The registry deploys a `FixedRateOracle` for it, or reuses
one (CREATE2-salted on the rate). For `price` and `nav` recipes the field must be zero. The fill
**rejects a non-zero value (`UnexpectedRateOverride`); it does not ignore it**. A silently
ignored number in a signed payload would leave a trail that claims the order chose the rate,
when nothing read it. Zero on a fixed recipe also reverts, because a fixed oracle at rate zero
has no meaning.

## 6. The two entry points, and the `enableJitMint` asymmetry

Both entry points reject any caller that is not the limit order protocol
(`OnlyLimitOrderProtocol`). Nobody can drive the adapter directly.

- **`preInteraction` — the maker path.** Runs before the maker asset moves. It always makes sure
  the market exists. `enableJitMint` decides whether it also *mints*. Flag off: the maker must
  already hold the Cork tokens it sells. Flag on: the adapter mints them just in time from the
  maker's own collateral (the maker approves the adapter for CA). The maker's permit then lets
  the LOP pull them.
- **`takerInteraction` — the taker path.** Runs mid-fill, after the maker asset moves and before
  the LOP pulls the taker asset. It **ignores `enableJitMint` and always mints**. Attaching the
  hook to the taker side *is* the opt-in, so a separate flag would be redundant. For a reader,
  this means: `enableJitMint: false` in a resting BUY order does **not** mean "this lift won't
  mint". The taker's own interaction decides that.

## 7. Events

| Event | Signature | Meaning |
|---|---|---|
| `JITMarketCreated` (flat adapter) | `JITMarketCreated(bytes32,address,address,address,uint256,address)` | The fill created a market that did not exist. The event gives the pool id, rate oracle, the pair, the expiry, and the **recipe contract address**. (The pre-2.1.0 generation's event carried a `string` mode in the last slot instead; the two events have different topic0s.) |
| `MarketCreated` (creator, nested) | `MarketCreated(bytes32,address,address,address,uint256,address,uint256,uint256,address)` | The nested adapter emits no `JITMarketCreated`. The **creator** announces creation instead: pool id, rate oracle, the pair, the expiry, the recipe, both fees, and the indexed `caller` (the adapter on a fill). |
| `MarketCreated` (pool manager) | 7 arguments on an 8-field manager; 9 on a 10-field one (the two fees appended) | The two forms have different topic0s. A scanner keyed on the 8-field form sees nothing on a 10-field manager. Decode each log with the ABI of its emitter's wire. Never guess from the topic. |
| `JITMinted` | `JITMinted(bytes32,address,uint256,uint256)` | The fill minted Cork tokens (both adapter generations, same layout). |

`ch track` reconciles fills without reading these events directly. The signatures are here for
integrators who wire their own log-based reconciliation.

## 8. The full refusal table

Adapter errors (raised inside the fill):

| Error | Cause |
|---|---|
| `OnlyLimitOrderProtocol` | A caller other than the configured LOP called the hook |
| `RecipeNotRegistered` | The order's `recipe` is not approved on the registry (raised by the registry) |
| `UnexpectedRateOverride` | Non-zero `rateOverride` on a recipe that does not read one |
| `RecipeRejectedConstraint` | `recipe.verify` returned false: the carried constraint is stale or foreign |
| `OrderNotForPool` | Neither order side is the derived market's share token |
| `RateUnavailable` | The rate oracle reported zero at the moment the fill would **create** the pool |
| `MintUnavailable` | The pool cannot mint: it is paused or expired |
| `MintAmountDrift` | The mint spent a different collateral amount than quoted |
| `ZeroAddress` | A constructor argument was zero (deploy-time only) |

Creation-bounds errors. The contracts that create the market raise them, only when the fill would
*create* it:

| Error | Cause |
|---|---|
| `ExpiryOutOfRange` | The market would live longer than the registry's `maxExpiryDuration` (inclusive bound; 30 days at deployment, governance-movable) |
| `SwapFeeOutOfRange` | 8-field pool manager (`phoenix/v0.3-rc.1`): a fee field above the 5% cap (`5e18` on the 1e18-=-1% scale) |
| `InvalidFees` | 10-field pool manager (`phoenix/v0.5` and `phoenix/v0.4-rc.1`): a fee field at or above 100% (`100e18`); there is no `MAX_FEE_PERCENTAGE` getter on this set |
| `InvalidRate` | 10-field pool manager: the oracle's live rate falls outside the carried constraint at creation. Example: an anchor of 1.0 on an undeployed NAV pair whose vault rate is 1.09 builds a market that the fill rejects |

The tool's pre-flights surface most of these before anyone signs. `recipe_not_found`,
`recipe_refused`, `jit_side_mismatch`, `constraint_window_notice`, and `invalid_order_terms`
(fees over cap) map onto this table. `ch track simulate` dry-runs the exact frozen bytes.

## 9. The adapter itself — what an auditor leans on

Stateless and custody-free: no owner, no admin functions, no upgrade path, no persistent storage
(the reentrancy guard uses transient storage). The adapter never holds tokens beyond the fill
transaction. Its deployment parameters are immutables that you can read on chain. Flat adapter:
`LIMIT_ORDER_PROTOCOL`, `POOL_MANAGER`, `CONTROLLER`, `MARKET_REGISTRY`. Nested adapter:
`LIMIT_ORDER_PROTOCOL`, `POOL_MANAGER`, `MARKET_CREATOR`; the creator in turn exposes
`CONTROLLER`, `MARKET_REGISTRY`, `POOL_MANAGER`.

**The one check that rules out the previous-generation hazard:** confirm that the adapter binds
the registry your integration pins (the Distribution manifest / `ch query protocol-config`). On
the flat adapter, read `MARKET_REGISTRY()`. On the nested adapter, read the chain
`MARKET_CREATOR()` → `creator.MARKET_REGISTRY()`, with one `POOL_MANAGER` end to end. Abandoned
generations of both contracts stay live. They **answer current-shaped calls with
plausible-looking values instead of reverting**. So an address that "works" proves nothing about
whether it is current. `ch` runs this guard on every order prepare and refuses a mismatch
(`adapter_binding_mismatch`). Run it yourself when you build calls in your own stack, or when you
deploy periphery (e.g. a ForSelf adapter) from copied constructor addresses.

**Roles precondition.** Fills work only after governance grants the creating contract its roles
on the Cork controller. The deploy script deliberately cannot grant them. The role holder depends
on the generation:

| Generation | Role holder | Roles |
|---|---|---|
| `phoenix/v0.3-rc.1` (flat, v1.3 controller) | the adapter | `POOL_CREATOR_ROLE` + `FEE_MANAGER_ROLE` |
| `phoenix/v0.5` and `phoenix/v0.4-rc.1` (nested, 1.4.0-rc.1 controller) | the **creator** — the adapter holds no role | `POOL_CREATOR_ROLE` only; the 1.4.0 controller has no `FEE_MANAGER_ROLE` |

| Role | Hash |
|---|---|
| `POOL_CREATOR_ROLE` | `0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52` |
| `FEE_MANAGER_ROLE` (v1.3 only) | `0x6c0757dc3e6b28b2580c03fd9e96c274acf4f99d91fbec9b418fa1d70604ff1c` |

Confirm with `hasRole(hash, holder)` on the controller. Order prepares report missing grants as
`roles_not_granted`; they probe the holder that the target generation names. Generation notes:
the v1.3 controller split fee authority out of the older `CONFIGURATOR_ROLE` into
`FEE_MANAGER_ROLE`. **On the v1.3 stack the adapter holds `FEE_MANAGER_ROLE` and does *not* hold
`CONFIGURATOR_ROLE`** (verified on-chain 2026-08-12). So a monitor that checks the old pair
reports a false negative against a live fill path. Pre-v1.3 controllers have no
`FEE_MANAGER_ROLE()` getter at all, and the 1.4.0 controller dropped it again. A probe of that
getter is one way to tell the three controller generations apart. With 0.5.0 the roles moved from
the adapter to the creator (verified live 2026-09-22: the creator has `POOL_CREATOR_ROLE`, the
adapter does not).
