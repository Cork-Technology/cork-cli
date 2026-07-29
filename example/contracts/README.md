# Cork ForSelf example adapters

> **Example code. Cork authors these contracts as references; the integrator audits, vets,
> and deploys them under its own name and responsibility.** Cork deploys nothing into the
> user's trust path. See [`../../SYNTHESIS.md`](../../SYNTHESIS.md) § "Scope & Ownership"
> for why ownership sits this way: your users trust *you*, not Cork — so the contract they
> and their agent interact with must be yours.
>
> "Integrator-owned" is the trust anchor, not the safety property. The standard these
> contracts are written to is **receiver-forcing + custody-free + audited**.

## The problem these solve

A session-key policy that whitelists `(contract, selector)` pairs cannot see call
*parameters*. Two Cork-adjacent surfaces carry a destination in their parameters:

| Surface | The free parameter | What a caged agent could do |
|---|---|---|
| `CorkPoolManager` — all 13 asset-moving methods | trailing `address receiver` (plus `address owner` on the share-burning five) | pull the account's inputs, send the outputs anywhere |
| 1inch LOP v4 `fillOrderArgs` / `fillContractOrderArgs` | `takerTraits` bit 251 + the first 20 bytes of `args` (the fill `target`) — **and** the order's own `receiver`, chosen by whoever signed it | pay with the account's asset and deliver the bought asset elsewhere; or, by signing an order themselves, take the payment directly |

Both are invisible to a selector whitelist: one perfectly-allowed call drains value.

These adapters remove the destination parameter rather than trying to police it — and, on the
fill path, add the one constraint that removing a destination cannot provide on its own (see
guarantee 2). Whitelist the adapter's selectors; do **not** whitelist raw `CorkPoolManager` or
raw LOP.

## What is here

| Contract | Purpose |
|---|---|
| `src/CorkForSelfAdapter.sol` | **The one to deploy.** Combines both surfaces: one address to audit, whitelist, and approve. |
| `src/CorkPoolForSelfAdapter.sol` | Pool surface only, if you prefer separate deployments. |
| `src/CorkLopFillForSelfAdapter.sol` | LOP fill surface only. |
| `src/base/CorkPoolForSelfBase.sol` | 13 `*ForSelf` twins of the pool manager's receiver-bearing methods. |
| `src/base/CorkLopFillForSelfBase.sol` | `fillOrderForSelf` — one entrypoint for EOA and contract makers. |
| `src/base/ForSelfCommon.sol` | The pinned pool manager, shared pull/sweep helpers, reentrancy guard, deadline check. |
| `src/interfaces/*` | Minimal vendored interfaces for the pool manager and the limit-order protocol — this package has no dependency on Cork's or 1inch's repos. |
| `script/DeployForSelfAdapter.s.sol` | Deploys one **shared** adapter, with the live Arbitrum addresses built in and an optional CREATE2 salt. |

Only OpenZeppelin v5.4.0 (`IERC20`, `SafeERC20`, `ReentrancyGuard`) and forge-std are external,
both pinned as submodules.

## The guarantees

1. **The destination is not in the calldata.** Every pool call passes `receiver = msg.sender`
   (and `owner = msg.sender`); every fill writes `target = msg.sender` into `args` with
   takerTraits bit 251 forced on. There is no destination parameter to abuse.
   This rests on `msg.sender` being the account itself, which is verified against the
   deployed stack rather than assumed — see the execution-path tests below.
2. **Every fill is bound to a real Cork market.** Forcing the target closes only one of a
   fill's two legs. The other leg — the account's own money — is paid to the *order's*
   `receiver`, which the order's maker chooses. Without a second constraint a caged agent
   could simply sign its own order, sell one wei of a worthless token for the account's
   entire balance, and name itself as the receiver: nothing is misdirected, so
   target-forcing is silent. This wrapper therefore requires each fill to name a `poolId`
   and to trade that market's cST against its collateral asset, in one direction or the
   other, with both addresses read from the pinned pool manager rather than from the
   caller. A caged agent can only ever buy or sell genuine cover in a real market. **What
   remains is price risk** — see "What these adapters do NOT close".
   The check runs *after* the fill on purpose: a Cork order may create its market just in
   time, during the fill itself, so the market is unreadable beforehand. Checking after
   covers both plain and just-in-time orders with one rule and gives up nothing, because a
   failure reverts the whole transaction along with the payment.
3. **Custody-free.** Tokens are pulled, spent, and the entire remaining balance swept back
   to the caller in the same transaction. Approvals are granted for one call and zeroed
   immediately after. Nothing is left to steal between transactions.
4. **Taker interactions are structurally impossible.** The fill wrapper zeroes the
   `args` interaction-length bits (200–223). Upstream, that field names an arbitrary
   contract the protocol calls *mid-fill, after the maker asset moves and before the taker
   asset is pulled* — i.e. exactly while a wrapper holds a live allowance. It cannot be set
   through this wrapper.
5. **Permit2 sourcing is off.** Bit 252 is cleared; the taker asset is always pulled by a
   plain, per-call ERC-20 allowance.
6. **Both protocols are pinned at deployment** as immutables. Deliberately *not* the
   pass-the-protocol-as-argument shape used elsewhere in the `*ForSelf` idiom: under a
   parameter-blind policy, a caller-supplied protocol address would let a caged agent point
   the adapter at a contract of their choosing and walk off with everything the account has
   approved. Fixed callees keep the approval targets auditable constants.
7. **Slippage and deadline on every entrypoint**, since the pool manager itself has neither.
8. **Derived amounts are capped, never previewed.** Where the pool computes an input amount
   in-call (the rate can move within the same transaction), the adapter pulls the caller's
   stated maximum and refunds the remainder. Preview-then-pull would be a race.

## Allowance matrix

Every spender is the adapter. The adapter's own approvals to the pool manager and to the
LOP are transient and zeroed within the call.

| Flow | Account approves the adapter on |
|---|---|
| `depositForSelf`, `mintForSelf`, `unwindSwapForSelf`, `unwindExerciseForSelf`, `unwindExerciseOtherForSelf` | collateral asset |
| `swapForSelf`, `exerciseForSelf`, `exerciseOtherForSelf` | **cST and** reference asset |
| `unwindDepositForSelf`, `unwindMintForSelf` | **cPT and cST** |
| `redeemForSelf`, `withdrawForSelf`, `withdrawOtherForSelf` | cPT |
| `fillOrderForSelf` | the order's taker asset |

The cST row is easy to miss: the pool manager moves cST out of *its caller's* balance
through a gated no-allowance transfer, so the adapter must physically hold the cST at call
time — which means pulling it from the account first.

The share-burning flows (`unwind*`, `redeem`, `withdraw*`) are zero-custody pass-throughs:
the pool manager burns straight from the account by spending the account's allowance **to
the adapter**. No share token ever touches the adapter.

## The third surface: cST/cPT token movement

The research corpus identified a third exposure — raw `transfer`/`approve` on the cST/cPT
share tokens — and concluded **no adapter can close it**: a caller-chosen destination *is*
the ERC-20 semantics. It is closed by policy configuration, not code:

- **Never whitelist raw `transfer`/`approve` on the share tokens by bare selector.** Use the
  executor's ERC-20 recipient/spender allowlist.
- With these adapters deployed, the adapter is the only spender the account ever approves,
  and every destination is hardwired — so an approve-spender allowlist covers the surface.
- Note cST/cPT are **per-market**: every new pool mints new token addresses. A static token
  allowlist needs an entry per market; plan the operational process for that.

## Deploying

```sh
forge script script/DeployForSelfAdapter.s.sol --rpc-url "$ARBITRUM_RPC_URL" --broadcast --verify
```

The script refuses to broadcast unless both targets carry code and the pool manager answers
a real pool-manager call — the constructor arguments are immutable for the life of the
deployment, so a typo is permanent. Run it without `--broadcast` first for a dry run;
`CORK_POOL_MANAGER`, `CORK_LOP` and `CORK_CREATE2_SALT` override the defaults.

The pool manager is a constructor argument to the fill surface too: it is the trusted source
for which token pair belongs to which market, which is what binds a fill to a real market.

Arbitrum One (chain id 42161) at the time of writing:

| | |
|---|---|
| `CorkPoolManager` | `0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2` |
| 1inch LOP v4 | `0x111111125421cA6dc452d289314280a0f8842A65` |
| `WhitelistManager` | `0xeC187bA7BBd4016d8db326ea1DFb3DD48d17Bd3A` |

Verify these against the live deployment before deploying — Cork publishes the current set,
and the addresses above are a snapshot, not a promise.

The package compiles with solc 0.8.30 targeting the **Cancun** EVM, which Arbitrum One has
supported since ArbOS 20 (March 2024). If you deploy to a chain that predates Cancun, lower
`evm_version` in `foundry.toml` and re-run the suite. CREATE2 is optional; use it if you
want address parity across chains, as with your existing adapter proxy.

**Shared deployment is what this package ships**, matching your existing adapter-proxy shape:
one address for every account, one thing to audit, one spender to authorise.
`script/DeployForSelfAdapter.s.sol` deploys exactly that. It is safe for every custody
property above. But the adapter is the identity each *upstream* access check sees, so a
shared instance collapses two of them — know these before you rely on either:

- **Market whitelisting.** If a Cork market has its whitelist enabled, the *adapter's*
  address must be whitelisted — the pool manager checks its direct caller. Whitelisting a
  shared adapter therefore makes that market reachable by **anyone on chain**, not just your
  accounts. Whitelisting is off in the pilot, so this is a decision for later, not now.
- **Private orders.** An order restricted with `allowedSender` is compared against the LOP's
  `msg.sender`, which is the adapter. Naming a shared adapter as the allowed sender makes the
  order fillable by anyone — do **not** rely on `allowedSender` through a shared deployment.

Neither blocks the pilot: market whitelisting is off, and the pilot's orders are public
rather than `allowedSender`-restricted. If either becomes load-bearing later, deploy one
adapter per account and add `address immutable OWNER` with a `require(msg.sender == OWNER)`
— that restores both at no ongoing cost, and the script's CREATE2 salt already gives you
deterministic per-account addresses.

## What these adapters do NOT close

They bound **where** value goes, not **whether** an action is a good idea. That distinction is the
whole scope of receiver-forcing, and it should shape the rest of your policy:

- **Price is not bounded, and that is the sharp edge.** The fill wrapper forces the destination and
  restricts the pair to a real market, but a caged agent still chooses the counterparty, the amounts,
  and therefore the price — including by signing its own order and selling the account real cST at a
  ruinous rate. The account is never *drained to an attacker's address*, but it can be *traded into a
  bad position*, and past some price the difference stops mattering. **The allowance you grant is the
  only hard cap on that**, which is why the point below is not boilerplate.
- **`poolId` stays caller-chosen.** A compromised key can deposit into any market the pool manager
  knows, including a bad one. Constraining *which* markets are acceptable is a policy-layer or
  off-chain risk-check job; no adapter can do it.
- **Allowance size is your lever.** These adapters can only move what the account has approved to them.
  An unlimited standing allowance means a compromised agent can push the entire balance through a valid
  flow at any time. Prefer just-in-time or capped allowances over unlimited ones.
- **Donations are not protected.** `_sweep` returns the adapter's whole balance to the caller, so tokens
  sent to the adapter out-of-band become a gift to the next caller. That is deliberate — it keeps the
  custody-free invariant simple — but do not treat the adapter as a holding account. The concrete
  version of this: a maker who names the adapter as their order's `receiver` pays into the adapter and
  the next sweep hands it to the taker. Makers must never name the adapter as receiver.

## Known limitations — read before audit

- **Fee-on-transfer and rebasing collateral are unsupported.** The pool manager credits its
  accounting before the transfer lands, so a fee-charging token silently over-credits and
  the shortfall surfaces as a revert on someone else's exit. Not adapter-specific; do not
  use such assets as collateral.
- **ETH-denominated fills are unsupported.** `fillOrderForSelf` is non-payable (the
  contract-maker variant is non-payable upstream anyway).
- **Private orders** (`allowedSender`) are not usable as a privacy or exclusivity mechanism through a
  shared adapter — see "Shared vs per-account" above.
- **Maker pre/post-interactions still run.** They are part of what the maker signed; the
  reentrancy guard protects the adapter, not the maker's intentions.
- **`unwindMintForSelf` floors the burn** to a multiple of the market's minimum shares; dust
  below that stays with the caller.
- Pool pause bitmaps and the pre/post-expiry split are enforced upstream and surface as
  reverts: `redeem`/`withdraw*` are post-expiry only, everything else pre-expiry.
- **Whether an order survives a partial fill is the maker's choice, not yours.** The protocol
  falls back to its single-use "bit invalidator" whenever the maker forbids partial fills
  (traits bit 255) *or* forbids multiple fills (bit 254) — and then one fill of any size
  consumes the entire order, remainder included. Live Cork venue orders on Arbitrum were
  observed allowing both, so they do refill; do not generalise from that. Read the maker's
  traits before sizing a fill.

## Audit checklist

1. Destination hardwiring: `msg.sender` at every pool call site and in the fill's `args`.
2. The takerTraits sanitization mask — which bits are preserved, forced, cleared, rewritten.
3. Approve/zero pairing on every path; sweep-to-caller after every custody-touching flow.
4. Cap-pull-and-refund on the derived-amount legs; the slippage assertion on each return.
5. Immutability of both protocol addresses.
6. The four pull patterns against the allowance matrix above.
7. Reentrancy: `nonReentrant` on all 14 entrypoints (the LOP has no guard of its own), sharing one
   guard across both surfaces in the combined contract.
8. The market binding in `_requireOrderIsForPool` — the only thing standing between a caged agent and
   an arbitrary transfer out of the account — including *why* it runs after the fill rather than
   before, and that a failure there reverts the payment along with everything else.
9. Error names are deliberately distinct from the protocols' where both can surface in one trace.
   A fill runs Cork's JIT adapter inside it (via the order extension's pre-interaction), and that
   adapter raises `OrderNotForPool()` on rate drift — so the market-binding failure here is
   `OrderAssetsNotInMarket(makerAsset, takerAsset)` instead, and carries the offending pair. Cork's
   `DeadlineExceeded` is declared but never raised in core, and its `ZeroAddress` only fires in
   market creation, which this adapter never calls; those names are therefore safe to share.
10. **Do not add ERC-1271 to this contract.** If the adapter could validate signatures, an order naming
   the adapter itself as maker would let the protocol spend the adapter's transient allowance. Today
   that is rejected only because `isValidSignature` does not exist here.

## Building — check out the `lib/` submodules first

`lib/forge-std` (v1.10.0) and `lib/openzeppelin-contracts` (v5.4.0) are **pinned git submodules**,
not vendored files. A fresh clone leaves those directories empty until you fetch them, and `forge
build` / `forge test` will fail with missing-import errors until you do.

```sh
# cloning fresh — pull the submodules in one step:
git clone --recurse-submodules <repo-url>

# already cloned (or pulled a commit that moved a pin) — initialise/refresh them:
git submodule update --init --recursive

# then build/test as usual (run from this directory):
forge build
```

Each submodule is pinned to an exact commit (the versions above); `git submodule status` shows the
pinned SHA per path. To move a pin: `cd lib/<name>`, `git checkout <new-tag>`, then `git add
lib/<name>` and commit the updated gitlink.

## Tests

38 tests. Most run against the **live** Arbitrum One deployment on a fork — real pool, real
protocol, real orders signed in-test:

```sh
forge test --fork-url "$ARBITRUM_RPC_URL"
```

No RPC endpoint is committed; every suite asserts it is running on chain id 42161.
`forge lint` is clean across `src/` and `test/`; the one `block-timestamp` finding is
suppressed at the deadline check with its justification inline. Coverage
spans all three pool groups (happy path, slippage, deadline, cap refunds, and a
custody-free assertion after every call), both fill branches, partial fills, and the
adversarial cases: hostile takerTraits bits are inert, a forged extension cannot redirect, a
caller cannot inject a mid-fill interaction, and a **properly signed** self-dealing order —
one the protocol itself is perfectly willing to execute — is stopped by the market binding
with the account's balance untouched.

The two exceptions are `test/JitOrdering.t.sol`, which uses mocks and needs no fork. They pin the
one property a live market cannot demonstrate: that the market binding is checked *after* the fill,
so an order whose market is created during that same fill is accepted, while one whose market never
appears still reverts and unwinds the payment. Mocks are used there by necessity — as of 2026-07-28
no JIT adapter exists for the live deployment (the only one deployed is bound to the pre-launch pool
manager, and every order in the live book carries an empty extension), so there is nothing to fill
against. What those tests cover is this wrapper's ordering, which is the part Cork owns.

### Verified against the deployed Zyfai account

`test/ZyfaiExecutionPath.t.sol` runs the adapters through the **real** Zyfai stack on Base, at
a block just after two reference transactions whose traces show the production path end to
end: executor module → `SmartSessionEmissary.verifyExecution` → `Safe.executeFromExecutor` →
Safe singleton → Safe7579 → `GuardedExecutor.executeGuardedBatch` →
`TargetRegistry.whitelist(target, selector)` and `whitelistedTargets(spender)` → back through
the account to the protocol. Those traces also show the pattern these adapters copy: an
`approve` whose spender is a `*ForSelf` proxy, then `redeemVaultForSelf` (`0xd9baa570`) and
`depositVaultForSelf` (`0x1c78885e`) on that proxy.

Three things are settled there rather than argued:

- **`msg.sender` at the target is the account.** A probe driven through the account's own
  `executeFromExecutor`, entered by the installed executor module, records the Safe as its
  caller. Everything in this package follows from that; had it been the module or the Safe7579
  adapter, every `receiver = msg.sender` would deliver to the wrong address.
- **The impersonation is faithful, not invented.** Safe7579 rejects `executeFromExecutor` from
  anything that is not an installed executor, so the call succeeding *is* the proof that the
  module is genuinely installed on that account.
- **A full ForSelf fill works through that path**: the account authorises the adapter and makes
  the call, the bought asset lands on the account, the adapter ends holding nothing, and the
  allowance is fully consumed.

Cork is not deployed on Base, so the protocols there are mocks; what is real is everything that
decides `msg.sender`. Run it with:

```sh
forge test --match-contract ZyfaiExecutionPath --fork-url <base-rpc> --fork-block-number 48984400
```

It self-selects on chain id and is inert in the Arbitrum suite.

`test/ForkBase.sol` pins the fixture pool. Pools expire — if the suite starts failing on
expiry, replace `POOL_ID` with a current pool from `api-phoenix.cork.tech/v1/pools/` (any
live, unexpired market works; the tests read the assets and decimals off-chain from the
pool itself).
