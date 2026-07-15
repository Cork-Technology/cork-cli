# Cork Contracts — Domain Model & Contract-Surface Reference

Research digest for the Cork CLI/MCP design. Extracted from local repos on 2026-07-15.
All claims cited `path:line`. Uncertainty flagged `ASSUMPTION(n)` / `QUESTION(n)` (§12).

Source repos (read-only):

| Repo | What it is |
|---|---|
| `/Users/work/Projects/euler-research/phoenix-private` | **Cork Phoenix** core contracts (CorkPoolManager, CorkAdapter, ConstraintRateAdapter, WhitelistManager, SharesFactory, DefaultCorkController). THE canonical source. |
| `/Users/work/Projects/euler-research/rollover-private` | **Cork Rollover** — ERC-7683 settler-based cross-term cST rollover (NOT 1inch-LOP based). |
| `/Users/work/Projects/euler-research/limit-order-protocol`, `limit-order-sdk` | 1inch LOP v4 contracts + TS SDK (upstream, vendored for reference). |
| `/Users/work/Projects/euler-research/cork-indexing-api` | Cork's **centralized API** (Fastify + Postgres/Kysely) — the "Centralized mode" schema. Live at `https://api-phoenix.cork.tech` (OpenAPI at `/docs/json`). |
| `/Users/work/Projects/euler-research/covered-vault` | Consumer integration (Euler Covered Vault): `CorkMarketAdapter`, `lob-orderbook` TS package (1inch order building/signing), indexer. |
| `/Users/work/Projects/euler-research/knowledge/pre-discovery/` | Verified digests: `phoenix-digest.md` (line-cited Phoenix walkthrough), `cst-guarantee-spec.md` (1:1 backing invariant). |
| `/Users/work/Projects/cork-knowledge` | Cork org knowledge base (decisions/rfcs/research) — org process docs, not contract source. |
| `/Users/work/Projects/phoenix-private-rollover-misnamed` | README title `rollover-phoenix-private` — an **older/alternate Rollover codebase** (contracts/ with `erc6909`, `fillers`, `settlers` dirs; different architecture than `rollover-private/src`). Treat as historical; `rollover-private` is current. |

Mainnet deployment (verified `phoenix-private/config/prod.toml:134-185`, matches the task's addresses):

| Contract | Address |
|---|---|
| CorkPoolManager impl | `0x1cCccCccCcCf9A60Fe57cd7CEf504d1DaaA78244` |
| **CorkPoolManager proxy** (aka corkPool, UUPS) | `0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC` |
| **CorkAdapter** (aka "CorkPoolAdapter") | `0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407` |
| ConstraintRateAdapter proxy | `0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A` (impl `0x1CcCCccCCcca9Cc3446B235af1C4cb8E2B01236E`) |
| WhitelistManager proxy | `0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE` (impl `0x1CcCccccCcCbf45E2516caeE86cef63da120CDAD`) |
| DefaultCorkController | `0xcCcCcCccCccbC06627F8aad7aAF13fe3a457f779` |
| SharesFactory | `0xcCCCccCCCcCc1782617fe14A386AC910a20D4324` |
| Bundler3 (Morpho) | `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` (`prod.toml:139`) |
| Treasury | `0x111ffffccccc50c23257b6decf37722a2cfed39b` (`prod.toml:144`) |
| Timelocks (upgrade/ctrl-admin/operational) | `0x7CcCCCccCcc0b4c00d01f321035b8e4523eF8448` / `0x7CccCCccccCCe566CdAFFA9EF2CB245Ad5575c3b` / `0x7CcCcCCcCccCC1d856F2994A66fAa7011F1A89D9` |
| 1inch LOP v4 | `0x111111125421cA6dc452d289314280a0f8842A65` (canonical; used as EIP-712 `verifyingContract` in `cork-indexing-api` and `covered-vault/app/packages/lob-orderbook`) |

`history_last_deployment_block = 24238826` (`prod.toml:185`). Sepolia has the same CREATE2
addresses (`prod.toml:60-113`). Same addresses are deterministic cross-chain (Safe Singleton
Factory `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`, `prod.toml:143`).

One live mainnet market config found: `config/markets/prod/vbUSDC-sUSDe-01.toml`
(base vbUSDC 6-dec, quote sUSDe 18-dec, Morpho oracle `0x5D3159ba95dCdE02451a31fE68B08fB650b00458`,
WrapperRateConsumer `0x78FB656D01141E3AC2073c9372C8b3e636f49d01`, `deployment_block = 24264153`).

---

## 1. GLOSSARY (as defined by code)

Grounded in `phoenix-private/contracts/` and confirmed by `knowledge/pre-discovery/phoenix-digest.md:68-88`.

| Term | Code definition | Cite |
|---|---|---|
| **Market / Pool** | One instance of the `Market` struct held by the singleton `CorkPoolManager`; "pool" and "market" are used interchangeably (`poolId` param typed `MarketId`). | `contracts/interfaces/IPoolManager.sol:33-42` |
| **MarketId (poolId)** | `bytes32` = `keccak256(abi.encode(Market))` — deterministic hash of the full 8-field struct. | `IPoolManager.sol:28-30`, `getId` `:866-880` |
| **Market struct** | `{collateralAsset, referenceAsset, expiryTimestamp, rateMin, rateMax, rateChangePerDayMax, rateChangeCapacityMax, rateOracle}`. | `IPoolManager.sol:33-42` |
| **Collateral Asset (CA)** | ERC-20 deposited to mint shares; the asset coverage pays out in. Native decimals ≤ 18. | `IPoolManager.sol:34` |
| **REF asset (Reference Asset)** | ERC-20 priced against CA by `rateOracle`; paid IN (together with cST) on exercise/swap. Decimals ≤ 18. | `IPoolManager.sol:35` |
| **cST / CST (Cork Swap Token)** | 18-dec ERC-20 **coverage leg** (protection buyer). Exercise = lock cST + REF → receive CA. NOT burned on exercise — locked into pool liquidity. | `State.sol:42-46` (`Shares.swap`); digest `phoenix-digest.md:17-29` |
| **cPT (Cork Principal Token)** | 18-dec ERC-20 **principal/underwriter leg**. After expiry, redeems pro-rata CA+REF remaining in the pool. | `State.sol:44`; `IPoolManager.sol:448-469` |
| **shares** | The (cPT, cST) pair minted 1:1 per deposit; both are `PoolShare` ERC20Burnable+Permit deployed by `SharesFactory`. `shares(poolId)` returns `(principalToken, swapToken)`. | `IPoolManager.sol:851-856`; `core/assets/PoolShare.sol`, `SharesFactory.sol` |
| **deposit / mint** | CA in → equal cPT+cST out (deposit = exact-CA-in, mint = exact-shares-out with ceil CA). Pre-expiry only. | `IPoolManager.sol:158-287` |
| **unwindDeposit / unwindMint** | Burn equal cPT+cST → CA back. Pre-expiry only. | `IPoolManager.sol:204-334` |
| **exercise / swap** | The coverage payout: lock cST + pay REF (`REF = cST/rate`) → receive CA (≈1 CA per 1e18 cST, minus flat fee). `swap` = exact-CA-out variant, `exercise` = exact-cST-in, `exerciseOther` = exact-REF-in. Pre-expiry only. cST+REF are **locked, not burned**. | `IPoolManager.sol:499-611, 720-774`; lock semantics `:512-515` |
| **unwind (unwindSwap / unwindExercise)** | Reverse of swap/exercise: deposit CA (+time-decay fee) → unlock previously-locked cST + REF. `unwindSwap` = exact-CA-in; `unwindExercise` = exact-cST-out; `*Other` = exact-REF-out. Pre-expiry only. | `IPoolManager.sol:613-718, 776-824` |
| **withdraw / redeem** | Post-expiry-only (redeem) / pre-expiry (withdraw docs say "not expired" revert — see QUESTION(6)): burn cPT → pro-rata CA + REF. First redeem triggers one-time **liquidity separation** archiving pool balances. | `IPoolManager.sol:336-497` |
| **impairment** | Not a Solidity term. In the CLI's sense: the REF-side cost of exercising — `referenceAssetsIn = ceil(cstSharesIn / swapRate)` — worsens as `swapRate` falls. The **rate-limited floor** of `swapRate` over a time horizon (§4) bounds the max impairment. | `libraries/PoolLib.sol:174-177`; §4 below |
| **swapRate** | Current adjusted REF→CA exchange rate, 1e18-scaled (`0.8e18` ⇒ 1 REF = 0.8 CA). Formula: `nCA = nREF × rate`, `nCST = nREF × rate`. Always read through ConstraintRateAdapter, never the raw oracle. | `IPoolManager.sol:830-842`; `PoolLib.sol:734-749` |
| **rollover** | NOT in Phoenix. Separate `rollover-private` protocol: a cPT holder moves a cST position from an expiring source pool to a destination pool via signed ERC-7683 orders; a **filler** supplies source cST and pays a **premium** to claim produced destination cST. | `rollover-private/README.md:1-30`; §5.3 |
| **pool balances** | `Balances{collateralAsset{_address,locked}, swapTokenBalance, referenceAssetBalance}` — locked CA, locked cST, locked REF accumulators. | `State.sol:48-83` |
| **pauseBitMap** | Per-market uint16: bit0 Deposit, bit1 Swap, bit2 Withdrawal, bit3 UnwindDeposit, bit4 UnwindSwap. | `State.sol:54-67`; `PoolLib.sol:791-809` |

Key invariant (verified in `knowledge/pre-discovery/cst-guarantee-spec.md:44-75`): **every circulating
cST is backed 1:1 by locked CA**; CA leaves the pool only by removing a matching cST from
circulation (unwind-pair burn, or exercise lock). cST is worthless at/after expiry
(`block.timestamp >= expiryTimestamp` is already expired; exercise reverts at exactly `t == expiry`).

Units summary:
- **Shares (cPT/cST): always 18 decimals.** CA/REF amounts: native token decimals (≤18).
- **swapRate: 1e18 = 1.0** (REF→CA).
- **Fees: 1e18 = 1%** (denominator `100e18`); hard max `5e18` = 5% (`PoolLib.sol:44-46 MAX_ALLOWED_FEES = 5 ether`).

---

## 2. CorkAdapter ("CorkPoolAdapter") — full external surface

Contract: `phoenix-private/contracts/periphery/CorkAdapter.sol` (BUSL-1.1, `^0.8.30`).
Interface + param structs: `contracts/interfaces/ICorkAdapter.sol`.
Inheritance: `Ownable, GeneralAdapter (→ GeneralAdapter1 → CoreAdapter), ICorkAdapter` (`CorkAdapter.sol:39`).

**Execution model (critical for TX prep):** every action is `onlyBundler3` — the adapter is a
Morpho **Bundler3** module; users never call it directly. A user TX is
`Bundler3.multicall(Call[] bundle)` where each `Call` targets the adapter with one of the
encoded actions below. Input tokens must be **transferred to the adapter first** (earlier in the
bundle, e.g. via `erc20TransferFrom` / `permit2TransferFromWithPermit`), and every Cork action is
gated `onlyWhitelisted(params.poolId)` on the **bundle initiator**:
`WHITELIST_MANAGER.isWhitelisted(poolId, initiator())` (`CorkAdapter.sol:73-76`). The adapter
force-approves CORK and resets approval to 0 after each call (e.g. `:105,110`).

State: `CORK` (IPoolManager) and `WHITELIST_MANAGER`, set once via
`initialize(ensOwner, bundler3, cork, whitelistManager)` `onlyOwner` (`CorkAdapter.sol:52-67`).

### 2.1 The 13 Cork actions (ALL state-changing; all `onlyBundler3 onlyWhitelisted(poolId)`)

Each takes a single struct param (structs in `ICorkAdapter.sol:39-183`). All have `deadline`
(`require(block.timestamp <= deadline, DeadlineExceeded())`) and balance-snapshot slippage checks
that revert `ErrorsLib.SlippageExceeded()`.

| # | Function (selector arg = struct) | Struct fields | Semantics / wraps |
|---|---|---|---|
| 1 | `safeMint(SafeMintParams)` (`CorkAdapter.sol:83`) | `poolId, cptAndCstSharesOut, receiver, maxCollateralAssetsIn, deadline` | `CORK.mint` — exact shares out, CA pulled from adapter balance, checks `actualCollateralIn <= max`, both share deltas ≥ requested. |
| 2 | `safeDeposit(SafeDepositParams)` (`:127`) | `poolId, collateralAssetsIn, receiver, minCptAndCstSharesOut, deadline` | `CORK.deposit` — exact CA in, shares out ≥ min. |
| 3 | `safeUnwindDeposit(SafeUnwindDepositParams)` (`:171`) | `poolId, collateralAssetsOut, owner, receiver, maxCptAndCstSharesIn, deadline` | `CORK.unwindDeposit` — exact CA out, burn ≤ max cPT+cST from `owner`. `owner` MUST be adapter or bundle initiator (`:179`). |
| 4 | `safeUnwindMint(SafeUnwindMintParams)` (`:216`) | `poolId, cptAndCstSharesIn (uint.max ⇒ owner bal/allowance min of cPT,cST), owner, receiver, minCollateralAssetsOut, deadline` | `CORK.unwindMint` — exact shares burned, CA out ≥ min. Sentinel `type(uint256).max` resolves to min(cPT,cST) balance (owner==adapter) or allowance (`:238-247`). |
| 5 | `safeWithdraw(SafeWithdrawParams)` (`:269`) | `poolId, collateralAssetsOut, owner, receiver, maxCptSharesIn, deadline` | `CORK.withdraw` — exact CA out + proportional REF, burn ≤ max cPT. |
| 6 | `safeWithdrawOther(SafeWithdrawOtherParams)` (`:287`) | `poolId, referenceAssetsOut, owner, receiver, maxCptSharesIn, deadline` | `CORK.withdrawOther` — exact REF out + proportional CA. |
| 7 | `safeRedeem(SafeRedeemParams)` (`:309`) | `poolId, cptSharesIn (uint.max sentinel), owner, receiver, minReferenceAssetsOut, minCollateralAssetsOut, deadline` | `CORK.redeem` — post-expiry cPT → pro-rata CA+REF. |
| 8 | `safeUnwindSwap(SafeUnwindSwapParams)` (`:357`) | `poolId, collateralAssetsIn (uint.max ⇒ adapter CA balance), receiver, minReferenceAssetsOut, minCstSharesOut, deadline` | `CORK.unwindSwap` — CA in → unlock cST + REF. |
| 9 | `safeSwap(SafeSwapParams)` (`:406`) | `poolId, collateralAssetsOut, receiver, maxCstSharesIn, maxReferenceAssetsIn, deadline` | `CORK.swap` — exact CA out; spends adapter's cST + REF ≤ maxes. |
| 10 | `safeExercise(SafeExerciseParams)` (`:450`) | `poolId, cstSharesIn, receiver, minCollateralAssetsOut, maxReferenceAssetsIn, deadline` | `CORK.exercise` — exact cST locked; REF cost ≤ max; CA out ≥ min. |
| 11 | `safeExerciseOther(SafeExerciseOtherParams)` (`:468`) | `poolId, referenceAssetsIn, receiver, minCollateralAssetsOut, maxCstSharesIn, deadline` | `CORK.exerciseOther` — exact REF spent; cST locked ≤ max. |
| 12 | `safeUnwindExercise(SafeUnwindExerciseParams)` (`:490`) | `poolId, cstSharesOut, receiver, minReferenceAssetsOut, maxCollateralAssetsIn, deadline` | `CORK.unwindExercise` — exact cST unlocked; CA cost ≤ max; REF out ≥ min. |
| 13 | `safeUnwindExerciseOther(SafeUnwindExerciseOtherParams)` (`:511`) | `poolId, referenceAssetsOut, receiver, minCstSharesOut, maxCollateralAssetsIn, deadline` | `CORK.unwindExerciseOther` — exact REF unlocked; cST out ≥ min. |

Adapter errors: `InvalidInitialization`, `DeadlineExceeded` (`ICorkAdapter.sol:33-37`) plus
bundler `ErrorsLib`: `ZeroAddress, ZeroShares, ZeroAmount, SlippageExceeded, UnexpectedOwner,
UnauthorizedSender` (thrown by the whitelist modifier). The adapter emits **no events of its own**
— index the CorkPoolManager events (§9).

### 2.2 Inherited generic bundle actions (also part of the adapter's calldata surface)

- `permit2TransferFromWithPermit(ISignatureTransfer.PermitTransferFrom permit, bytes signature, address receiver, uint256 amount)` — Permit2 signature-transfer from initiator; `uint.max` = initiator balance (`periphery/GeneralAdapter.sol:50-70`).
- From vendored Morpho `GeneralAdapter1` (`periphery/bundler3/adapters/GeneralAdapter1.sol`): `erc4626Mint/Deposit/Withdraw/Redeem(vault, …, sharePriceE27 bound, receiver[, owner])` (`:39-135`), `permit2TransferFrom(token, receiver, amount)` (`:138`), `erc20TransferFrom(token, receiver, amount)` (`:156`).
- From `CoreAdapter` (`periphery/bundler3/adapters/CoreAdapter.sol`): `nativeTransfer(receiver, amount)` (`:47`), `erc20Transfer(token, receiver, amount)` (`:62`).

A complete "prepare TX" feature therefore = build a Bundler3 `multicall` bundle:
`[fund adapter (erc20TransferFrom or permit2…)] → [safeX action] → [optional sweep erc20Transfer back]`.

### 2.3 CorkPoolManager (the wrapped manager) — full `IPoolManager` surface

File: `contracts/interfaces/IPoolManager.sol` (983 lines, exhaustive NatSpec); impl
`contracts/core/CorkPoolManager.sol` (1502 lines; UUPS, ReentrancyGuard, AccessControl,
Extsload). Markets identified by `MarketId` (bytes32) everywhere.

**State-changing (user):** `deposit, mint, unwindDeposit, unwindMint, withdraw, withdrawOther,
redeem, exercise, exerciseOther, unwindExercise, unwindExerciseOther, swap, unwindSwap`
(signatures at `IPoolManager.sol:171, 266, 221, 309, 366, 388, 467, 531, 556, 643, 664, 744, 796`).
Direct calls work too (adapter is a convenience/safety wrapper), but **whitelist is enforced in
the manager as well** (digest `phoenix-digest.md:159-161`) and callers must handle approvals.

**State-changing (admin/controller):** `createNewPool(Market)`, `setPausedBitMap(marketId,uint16)`,
`setAllPaused(bool)`, `setTreasuryAddress`, `setSharesFactory`,
`updateSwapFeePercentage(poolId,fee)`, `updateUnwindSwapFeePercentage(poolId,fee)`
(`IPoolManager.sol:902-981`). Driven through `DefaultCorkController`
(`contracts/interfaces/IDefaultCorkController.sol:50-163`: pause/unpause per-action helpers,
whitelist management passthroughs, `createNewPool`).

**Views (per pool):**
- previews: `previewDeposit, previewMint, previewUnwindDeposit, previewUnwindMint, previewWithdraw, previewWithdrawOther, previewRedeem, previewExercise, previewExerciseOther, previewUnwindExercise, previewUnwindExerciseOther, previewSwap, previewUnwindSwap` (§3).
- maxes: `maxDeposit, maxMint, maxUnwindDeposit, maxUnwindMint, maxWithdraw, maxWithdrawOther, maxRedeem, maxExercise, maxExerciseOther, maxUnwindExercise, maxUnwindExerciseOther, maxSwap, maxUnwindSwap`. NOTE: `maxUnwindExercise/maxUnwindExerciseOther/maxUnwindSwap` ignore the caller's balance (pool-side limits only, `IPoolManager.sol:702-718, 816-824`).
- info: `swapRate(poolId)` (`:830-842`), `assets(poolId) → (collateralAssets, referenceAssets)` (`:844-849`), `shares(poolId) → (principalToken, swapToken)` (`:851-856`), `market(poolId) → Market` (`:858-864`), `getId(Market) → MarketId` (`:866-880`), `swapFee(poolId)`, `unwindSwapFee(poolId)` (`:886-900`), `getPausedBitMap(marketId)` (`:951-958`).
- raw storage: `extsload(bytes32)`, `extsload(bytes32,uint256)`, `extsload(bytes32[])` (`core/Extsload.sol:13-45`) — useful for batched low-level reads.

**Important preview semantics:** previews return **zeros** (not revert) when the action is paused
or the market expired (e.g. `PoolLib.sol:225-227, 264-267`); they revert `NotInitialized` only for
unknown markets. The CLI must distinguish "0 = disabled" from a real quote.

---

## 3. previewSwap / previewUnwindSwap — exact math

Both live in `contracts/libraries/PoolLib.sol` (library `PoolLibrary`), called from
`CorkPoolManager.previewSwap` (`core/CorkPoolManager.sol:680-689`) and `previewUnwindSwap`
(`:903-910`). Both are `view`, and both are **time-dependent** twice over: (a) via
`ConstraintRateAdapter.previewAdjustedRate` (credit refill grows with `block.timestamp`, §4) and
(b) `previewUnwindSwap` additionally via the time-decay unwind fee.

### 3.1 `previewSwap(poolId, collateralAssetsOut) → (cstSharesIn, referenceAssetsIn, fee)`

`PoolLib.sol:219-248`:

```solidity
if (collateralAssetsOut == 0) return (0, 0, 0);
if (_isSwapPaused(self)) return (0, 0, 0);
if (_isExpired(self)) return (0, 0, 0);

uint256 exchangeRate = _getLatestApplicableRate(poolId, constraintRateAdapter); // previewAdjustedRate

// gross = ceil(out * 100e18 / (100e18 - swapFeePercentage))   [fee: 1e18 = 1%]
uint256 grossCollateralAssets =
    MathHelper.calculateGrossAmountBeforeFee(collateralAssetsOut, self.pool.swapFeePercentage);

cstSharesIn = TransferHelper.tokenNativeDecimalsToFixed(grossCollateralAssets, self.collateralDecimals); // scale CA→18dec
fee = grossCollateralAssets - collateralAssetsOut;                                // fee in CA, to treasury

uint256 referenceAssetsInFixed = MathHelper.calculateDepositAmountWithSwapRate(cstSharesIn, exchangeRate, true);
    // = ceil(cstSharesIn * 1e18 / rate)                        [MathHelper.sol:56-63]
referenceAssetsIn = TransferHelper.fixedToTokenNativeDecimalsWithCeilDiv(referenceAssetsInFixed, self.referenceDecimals);
```

Units: `collateralAssetsOut`/`fee` CA-native decimals; `cstSharesIn` 18-dec; `referenceAssetsIn`
REF-native decimals; rate 1e18. Effective **CST-swap rate**: to get `X` CA you lock
`toFixed(ceil(X/(1-f)))` cST and pay `ceil(cST/rate)` REF.

### 3.2 `previewUnwindSwap(poolId, collateralAssetsIn) → (cstSharesOut, referenceAssetsOut, fee)`

`PoolLib.sol:258-287`:

```solidity
if (collateralAssetsIn == 0) return (0, 0, 0);
if (_isUnwindSwapPaused(self)) return (0, 0, 0);
if (_isExpired(self)) return (0, 0, 0);

// Time-decay fee taken off the CA input BEFORE conversion:
fee = MathHelper.calculateTimeDecayFee(
    PoolShare(self.shares.swap).issuedAt(),   // start = cST deployment time
    self.info.expiryTimestamp,                 // end
    block.timestamp,                           // current
    collateralAssetsIn,
    self.pool.unwindSwapFeePercentage);

collateralAssetsIn = collateralAssetsIn - fee;
collateralAssetsIn = TransferHelper.tokenNativeDecimalsToFixed(collateralAssetsIn, self.collateralDecimals);

referenceAssetsOut = MathHelper.calculateDepositAmountWithSwapRate(
    collateralAssetsIn, _getLatestApplicableRate(poolId, constraintRateAdapter), false);
    // = floor(netCA_fixed * 1e18 / rate)
referenceAssetsOut = TransferHelper.fixedToTokenNativeDecimals(referenceAssetsOut, self.referenceDecimals);
cstSharesOut = collateralAssetsIn;             // 1:1 in 18-dec after fee
```

Time-decay fee (`MathHelper.sol:89-149`): `t = computeT(issuedAt, expiry, now)` — linear **1→0**
normalized time-to-maturity; `feeFactor = ceil(baseFee·t/1e18)`;
`fee = ceil(amount·feeFactor/100e18)`. So the **unwind fee decays linearly to zero at expiry**.
Inverse form for exact-out flows: `calculateGrossAmountWithTimeDecayFee` `gross =
ceil(net·100e18/(100e18−feeFactor))` (`MathHelper.sol:109-126`).

Related exercise-family previews (same file): `previewExercise` `:162-180`
(`refIn = ceil(cst/rate)`, `caOut = toNative(cst) − ceil(caOut·fee%)`), `previewExerciseOther`
`:190-209` (`cst = floor(ref_fixed·rate/1e18)`), `previewUnwindExercise` `:297-326`,
`previewUnwindExerciseOther` `:336-365`. Fee helpers: `calculatePercentageFee = ceil(amount·fee1e18/100e18)`
(`MathHelper.sol:48-50`).

**Local re-implementation is fully specified** by: `market(poolId)` (rate constraints, expiry),
`swapFee/unwindSwapFee`, `PoolShare(swapToken).issuedAt()`, token decimals, and the constraint
state (§4) + `rateOracle.rate()`.

---

## 4. ConstraintRateAdapter — the rate limiter (highest-value item)

Files: `contracts/core/ConstraintRateAdapter.sol` (249 lines) + `contracts/interfaces/IConstraintRateAdapter.sol`.
Singleton UUPS proxy shared by all markets; per-market state keyed by `MarketId`.

### 4.1 State & entrypoints

```solidity
struct ConstraintState {                       // IConstraintRateAdapter.sol:34-38
    uint256 _lastAdjustedRate;
    uint256 _lastAdjustmentTimestamp;
    uint256 _remainingCredits;
}
```

- `bootstrap(poolId)` — `onlyCorkPoolManager`, called at pool creation (`PoolLib.initialize:57-65`): fetches `rate = IComposableRateOracle(pool.rateOracle).rate()`, requires `rateMin ≤ rate ≤ rateMax`, sets `lastAdjustedRate = rate`, `lastAdjustmentTimestamp = now`, `remainingCredits = rateChangeCapacityMax` (`ConstraintRateAdapter.sol:96-108`).
- `adjustedRate(poolId)` — **mutating**, `onlyCorkPoolManager`; every real swap/exercise/unwind calls it (`PoolLib._getLatestApplicableRateAndUpdate:743-749`). Persists new `lastAdjustedRate`, `remainingCredits`, and updates `lastAdjustmentTimestamp` **only if the rate actually changed** (`:111-137`).
- `previewAdjustedRate(poolId)` — `view`, **also `onlyCorkPoolManager`** (`:150`) — ⚠ a CLI **cannot call it directly**; read it via `CorkPoolManager.swapRate(poolId)` / previews, or recompute locally (below).
- `constraints(poolId) → (lastAdjustedRate, lastAdjustmentTimestamp, remainingCredits)` — `view`, **permissionless** (`:172-175`). This + `market(poolId)` + `rateOracle.rate()` = everything needed for local computation.
- `CORK_POOL_MANAGER()` view; `setOnceCorkPoolManager` admin-once (`:85-89`).

Errors (from `IErrors`): `NotCorkPoolManager, InvalidRate, ZeroAddress, AlreadySet, InvalidAddress`.
No events are emitted by this contract — constraint state must be read via `constraints()` or recomputed.

### 4.2 The exact math (`_calculateRate`, `ConstraintRateAdapter.sol:196-246`) — quoted verbatim

```solidity
int256 rateChangeIncoming = int256(params.newRate) - int256(params.lastAdjustedRate);
if (rateChangeIncoming == 0) return (params.lastAdjustedRate, params.remainingCredits, false);
updated = true;

// Keep full precision by multiplying with 1e18.
uint256 refillRatePerSeconds = Math.mulDiv(params.rateChangePerDayMax, 1e18, 1 days);

uint256 creditsRefilled =
    Math.mulDiv(params.currentTimestamp - params.lastAdjustmentTimestamp, refillRatePerSeconds, 1e18);

uint256 creditsCapped = params.rateChangeCapacityMax < params.remainingCredits + creditsRefilled
    ? params.rateChangeCapacityMax
    : params.remainingCredits + creditsRefilled;

uint256 rateChangeIncomingAbs =
    rateChangeIncoming > 0 ? uint256(rateChangeIncoming) : uint256(-rateChangeIncoming);
uint256 creditsConsumed = rateChangeIncomingAbs < creditsCapped ? rateChangeIncomingAbs : creditsCapped;

// First calculation, may go below/above the min/max rate.
rate = rateChangeIncoming > 0
    ? params.lastAdjustedRate + creditsConsumed
    : params.lastAdjustedRate - creditsConsumed;

// Clamp rate to min/max bounds.
if (rate < params.rateMin) rate = params.rateMin;
else if (rate > params.rateMax) rate = params.rateMax;

// Calculate actual credits consumed based on the actual rate change.
uint256 actualRateChange =
    rate > params.lastAdjustedRate ? rate - params.lastAdjustedRate : params.lastAdjustedRate - rate;
uint256 actualCreditsConsumed = actualRateChange;

remainingCreditsResult = creditsCapped - actualCreditsConsumed;
```

In words — a **token-bucket rate limiter in rate units** (credits are denominated in absolute
1e18-rate units, not %):

1. Bucket refills continuously at `rateChangePerDayMax` per 24h since the **last actual rate change**
   (`lastAdjustmentTimestamp` doesn't advance on no-change calls, `:133-134`).
2. Bucket is capped at `rateChangeCapacityMax` at any instant.
3. A single adjustment moves the rate toward the oracle by at most the bucket content
   (`creditsConsumed = min(|Δoracle|, creditsCapped)`).
4. Result clamped to `[rateMin, rateMax]`; credits are only charged for the **actual** movement
   (so hitting the clamp doesn't burn extra credits).
5. Bucket after the call = `creditsCapped − actualRateChange`.

### 4.3 Why "worst case ≠ minRate" — the time-boxed floor

For a horizon `Δt` from "now" (state `L = lastAdjustedRate`, `C = remainingCredits`,
`T0 = lastAdjustmentTimestamp`, params `R = rateChangePerDayMax`, `K = rateChangeCapacityMax`):

- **Single adversarial move at time t:** the rate can drop at most
  `min(K, C + R·(t−T0)/86400)`, i.e.
  `worstRate_single(t) = max(rateMin, L − min(K, C + R·(t−T0)/86400))`.
- **Sequence of moves (drain-as-it-refills):** `K` caps only the *instantaneous* bucket, not the
  cumulative descent — repeated adjustments can consume credits as they refill, so over `Δt` the
  cumulative drop is bounded by `C + R·Δt/86400` (refill accrues from each change):
  `worstRate(t) = max(rateMin, L − (C + R·(t−T0)/86400))`.

So the **max-REF-impairment floor is a moving, credit-limited bound**: for short horizons the
reachable floor sits *above* `rateMin` (the limiter hasn't had time to walk the rate down), and it
converges to `rateMin` only after `Δt ≥ 86400·(L − rateMin − C)/R` seconds. Conversely, the same
bound applies upward toward `rateMax`. Max REF cost per cST at horizon `t` (exercise leg) is
`ceil(1e18/worstRate(t))` REF per 1e18 cST (`PoolLib.sol:174-177`), i.e. the "max REF impairment
vs matching cST" the CLI must compute locally = f(lastAdjustedRate, remainingCredits,
lastAdjustmentTimestamp, rateChangePerDayMax, rateChangeCapacityMax, rateMin, horizon) — **not**
simply `f(rateMin)`.

Two subtleties for a faithful local model:
- The oracle itself is an input: the adjusted rate only moves toward `rateOracle.rate()`; the
  bound above is adversarial (oracle jumps to ≤ rateMin instantly).
- `previewAdjustedRate` at time `t` (no state write) equals the single-move formula with the
  *current* oracle value substituted for the adversarial one; on-chain quotes therefore already
  include refill-since-last-trade.

Oracle interface: `IComposableRateOracle.rate() → uint256` 1e18 REF→CA
(`contracts/interfaces/IRateOracle.sol`); production oracles are Morpho-oracle-backed
`WrapperRateConsumer` (`contracts/periphery/WrapperRateConsumer.sol`,
`config/markets/prod/vbUSDC-sUSDe-01.toml`).

---

## 5. Limit orders & rollover orders

### 5.1 Cork LOB V1 = plain 1inch LOP v4 orders (off-chain book, on-chain settlement)

Evidence: `cork-indexing-api/src/modules/limit-orders/*` and
`covered-vault/app/packages/lob-orderbook/src/order.ts` + `scripts/seed-lob-orders.mjs:1-24`
("sign N cST-SELL limit orders … 1inch LOP v4, EIP-712, canonical LOP … POST them to a Cork LOB V1
orderbook").

- **Order struct** = canonical LOP v4 `Order`: `salt, maker, receiver, makerAsset, takerAsset,
  makingAmount, takingAmount, makerTraits` — EIP-712 domain `{name: "1inch Aggregation Router",
  version: "6", chainId, verifyingContract: LOP}` (`post-order.ts:208-238`; typehash string at
  `lob-orderbook/src/order.ts:38`).
- **Sides**: BUY = maker offers **CA** for cork token; SELL = maker offers **cPT or cST** for CA.
  The API validates the pair against `dim_cork_pools_metadata` (collateral vs principal/swap
  address) (`post-order.ts:147-205`). A "limit-order market" = `(chainId, poolId, makerAsset,
  takerAsset)` row (`db/schema.ts:351-359 LimitOrderMarkets`).
- **makerTraits decoding** (used by API + SDK): `expiry = (traits >> 80) & MASK40`,
  `nonce = (traits >> 120) & MASK40`, `series = (traits >> 160) & MASK40`,
  `allowsPartialFills = bit255 == 0` (NO_PARTIAL_FILLS), `allowMultipleFills = bit254`,
  `HAS_EXTENSION`, `USE_PERMIT2` bits; low 80 bits = allowedSender tail
  (`post-order.ts:453-462`; `lob-orderbook/src/order.ts:108-118`).
- **No extension / no Dutch auction in Cork orders.** Orders are fixed-price; the only
  "extension-ish" payload is `makerPermit2` stored separately and "passed at fill time"
  (`post-order.schema.ts:46-48`). The server computes the EIP-712 hash of the bare struct and
  rejects mismatches (`post-order.ts:241-253`) — an order carrying a real LOP extension would need
  its hash committed in `salt`'s low bits, which this flow doesn't do. 1inch *does* ship a
  `DutchAuctionCalculator` extension (`limit-order-protocol/contracts/extensions/DutchAuctionCalculator.sol:15-59`:
  `extraData = (startTime<<128|endTime, takingAmountStart, takingAmountEnd)`, linear
  interpolation in `getMakingAmount/getTakingAmount`) — available if Cork ever adopts it, but
  **no Cork usage found**. See DISCREPANCY(1).
- **Signature/fill semantics**: EOA makers → EIP-2098 compact `(r, vs)` with
  `fillOrder/fillOrderArgs`; CONTRACT makers (ERC-1271) → full bytes with `fillContractOrder*`
  (`lob-orderbook/src/order.ts:246-247, 303-305`; API verifies ERC-1271 `isValidSignature`
  `post-order.ts:296-320`). Cancellation: on-chain `cancelOrder(makerTraits, orderHash)` → emits
  `OrderCancelled`, or bit-invalidator → `BitInvalidatorUpdated`.
- **Discovery**: off-chain via the centralized API (`POST /limit-orders`,
  `GET /limit-orders/orderbook|fills|markets` — `src/modules/limit-orders/`); on-chain only fills/cancels
  are observable (§9). Orderbook statuses: `OPEN, PARTIALLY_FILLED, FILLED, CANCELLED, EXPIRED`
  (`get-orderbook.ts:20-31`); DB row carries `remaining_making_amount`, `premium` (metadata %,
  0–10000), `maker_account_type`, `maker_permit2` (`db/schema.ts:361-392`).
- Coordinator-supplied fact: **live limit-order markets run on Arbitrum (chainId 42161)** via the
  same canonical LOP v4 address; the centralized API is `https://api-phoenix.cork.tech`
  (OpenAPI `/docs/json`), POST body = the LOP v4 order struct shape above. (Consistent with the
  multi-chain `chainId` fields everywhere in the API.) See QUESTION(2) re: which pools.

### 5.2 1inch LOP v4 events (for fill tracking)

`limit-order-protocol/contracts/interfaces/IOrderMixin.sol:50-73`:

```solidity
event OrderFilled(bytes32 orderHash, uint256 remainingAmount);        // NO indexed params!
event OrderCancelled(bytes32 orderHash);
event BitInvalidatorUpdated(address indexed maker, uint256 slotIndex, uint256 slotValue);
```

⚠ `OrderFilled` has **no indexed topics** — HyperSync/log filters must select on
`address = LOP && topic0 = keccak(OrderFilled(bytes32,uint256))` and match `orderHash` in data;
taker/amounts must be recovered from the tx (the API's `limit_order_fills` table stores
`taker, making_amount, taking_amount, is_partial_fill` — derived off-chain, `db/schema.ts:336-349`).

### 5.3 Rollover orders (`rollover-private`) — ERC-7683, NOT LOP

`rollover-private/README.md:1-30`: a cPT holder signs an ERC-7683 `GaslessCrossChainOrder`
whose `orderData` is `RolloverTypes.OrderData` (`src/types/RolloverTypes.sol:83-160`):
parties (`user, settler, fillerHint, exclusiveFiller`), tokens (`srcCstToken, dstCstToken,
premiumToken, rolloverContract`), routing (both chain ids must equal `block.chainid`),
deadlines (`openDeadline, fillDeadline, orderSalt`), economics (`orderSize`,
**`minPremiumPerShare`** — raw premium-token units per 1e18 dstCST, settled as
`ceil(dstCstProduced × minPremiumPerShare / 1e18)`), flags (`allowPartialFills, allowUnderfill,
premiumPaymentMode` 0=atomic-only, 1=atomic-or-separate), and the intent binding
(`rolloverIntentHash`, `RolloverParams{srcCstToken, dstCstToken, minCaReceived, minSharesOut,
srcPoolId, dstPoolId, settler}`). EIP-712 domain `CorkSettler/1.0.0`; ERC-1271 supported.

Lifecycle: `open/openFor` → `fill(..., ROLLOVER)` (filler pushes srcCST; rollover contract runs
Phoenix `unwindMint` on the source pool then `deposit` on the destination pool under an
ERC-7484-attested hook plan) → `fill(..., PREMIUM)` (premium routed; dstCST residual released)
→ or `reclaim` if premium never arrives ("welcher"). Statuses:
`None, Opened, Settled, Expired, Cancelled, Closing` (`RolloverTypes.sol:16-23`).

**Pricing over time: there is none on-chain.** `minPremiumPerShare` is a **fixed floor** for the
order's life; no decay/auction curve exists in `rollover-private/src` (grep for auction/decay:
only a doc comment hit). Time-dependence enters a rollover's *economics* only through Phoenix
itself (source-pool unwind time-decay fee → 0 at expiry, and constraint-rate movement). See
DISCREPANCY(2).

---

## 6. WhitelistManager

File: `contracts/core/WhitelistManager.sol` (UUPS proxy; role `CORK_CONTROLLER_ROLE =
keccak256("CORK_CONTROLLER_ROLE")` held by `DefaultCorkController`).

Resolution logic (`WhitelistManager.sol:109-119`):

```solidity
function isWhitelisted(MarketId marketId, address account) external view returns (bool) {
    if (!state.marketWhitelistEnabled[marketId]) return true;   // whitelist OFF ⇒ everyone allowed
    if (state.globalWhitelist[account]) return true;
    if (state.marketWhitelist[marketId][account]) return true;
    return false;
}
```

Views: `isMarketWhitelistEnabled(marketId)`, `isGlobalWhitelisted(account)`,
`isMarketWhitelisted(marketId, account)`, `isWhitelisted(marketId, account)`,
`CORK_POOL_MANAGER()` (`:89-119`).

Setters (all `onlyRole(CORK_CONTROLLER_ROLE)`): `addToGlobalWhitelist(address[])`,
`removeFromGlobalWhitelist`, `addToMarketWhitelist(marketId, address[])`,
`removeFromMarketWhitelist`, `disableMarketWhitelist(marketId)`,
`activateMarketWhitelist(marketId)` — **activation only allowed BEFORE the market is initialized**
(`require(market.referenceAsset == 0 && market.collateralAsset == 0)`, `:190-196`), i.e. the
whitelist flag is effectively decided pre-launch and can later only be disabled.

Events (`contracts/interfaces/IWhitelistManager.sol:38-53`):
`GlobalWhitelistAdded/Removed(address indexed account)`,
`MarketWhitelistAdded/Removed(MarketId indexed poolId, address account)`,
`MarketWhitelistDisabled/Enabled(MarketId indexed poolId)`.

**`poolWhitelistStatus`** is the *centralized-API* name for `isMarketWhitelistEnabled`: a
`"enabled" | "disabled"` filter/field on `GET /pools`
(`cork-indexing-api/src/modules/pools/schemas/get-pools.schema.ts:106-109`,
`routes/get-pools.ts:518-611`; backing column `dim_cork_pools.is_whitelist_enabled`
`db/schema.ts:120`; per-account rows in `fact_pool_whitelist_accounts` `:287-298`). On-chain
equivalents for the Full-Decentralized mode: call `isMarketWhitelistEnabled` + index the six
events above.

---

## 7. ABIs & artifacts (local availability)

- **`phoenix-private` has NO `out/` directory** (never built here; `foundry.toml:4` says `out = "out"`, prod profile `out-production`:22). Do NOT run forge here. The **interfaces are clean, self-contained Solidity** — `contracts/interfaces/{IPoolManager,ICorkAdapter,IConstraintRateAdapter,IWhitelistManager,IErrors,IRateOracle,ISharesFactory,IPoolShare,IDefaultCorkController,IExtsload}.sol` — importable for `sol!`/abitype after resolving the `contracts/` self-remapping (`remappings.txt`). For the CLI, best options: (a) hand-derive human-readable viem ABIs from these interfaces (they are exhaustive and NatSpec'd), or (b) fetch the verified ABI from Etherscan for impl `0x1cCc…8244` / adapter `0xCCcC…0407`.
- **`rollover-private/out/`** — full forge artifacts for the rollover system (e.g. `out/CorkCellar.sol`, `out/CorkCellarFactory.sol`, settlers, modules). Its `out/IPoolManager.sol/IPoolManager.json` is a **minimal vendored Phoenix interface (only `deposit, market, shares, unwindMint`)** — NOT a full Phoenix ABI (verified: compilationTarget `src/interfaces/external/phoenix/IPoolManager.sol`).
- **`covered-vault/contracts/out/`** — forge artifacts incl. `CorkMarketAdapter.sol/`, `ICorkPoolManager.sol/` (again a partial consumer interface with `previewSwap` etc., `contracts/src/CorkMarketAdapter.sol:53-60`).
- **1inch**: `limit-order-protocol/contracts/` full source (v4, solc 0.8.30 for extensions); TS order building/signing already implemented in `covered-vault/app/packages/lob-orderbook/src/{order,orderbook,seed}.ts` (encode/decode makerTraits, EIP-2098 split, POST client) — directly reusable. `limit-order-sdk` = upstream `@1inch/limit-order-sdk`.
- Top-level `/Users/work/Projects/euler-research/out` contains only 3 entries (CanonicalAddresses/DeployChecks/build-info) — not useful.

**Bottom line:** no complete compiled Phoenix ABI exists locally; generate from
`phoenix-private/contracts/interfaces/*.sol` (authoritative, matches deployed impl per config) or
Etherscan. ASSUMPTION(3).

---

## 8. Centralized-mode API schema (cork-indexing-api)

Base `https://api-phoenix.cork.tech`. Routes (all under `src/modules/`):
- `GET /pools` (filters: `poolWhitelistStatus`, `expiryBefore/After`, `poolId`, `rateOracleAddress`, block/timestamp ranges), `GET /pools/whitelisted-addresses`
- `GET /whitelists`
- `POST /limit-orders` (full server-side verification: makerTraits↔fields consistency, pair↔pool match, EIP-712 hash recompute, EOA ecrecover or ERC-1271), `GET /limit-orders/orderbook`, `GET /limit-orders/fills`, `GET /limit-orders/markets`
- `GET /flows` (user action history)

DB shapes worth mirroring in CLI types (`src/db/schema.ts`): `dim_cork_pools_metadata`
(poolId, collateral/reference/principal/swap addresses, expiry, rate_oracle, deployment block)
`:137-152`; `dim_cork_pools` (pause flags, `is_whitelist_enabled`, fee percentages, TVL deltas)
`:91-135`; `limit_orders` `:361-392`; `limit_order_fills` `:336-349`; `limit_order_markets`
`:351-359`; `fact_pool_whitelist_accounts` `:287-298`; `v_markets_overview` (fees/volume/coverage
aggregates) `:563-592`. The API dims also track `dim_constraint_adapters`, `dim_oracles`
(oracle price snapshots) `:174-182`.

---

## 9. Events to index (HyperSync Full-Decentralized mode)

### CorkPoolManager proxy `0xccCC…B9eC` (`IPoolManager.sol:54-152`)

| Event | Signature | Use |
|---|---|---|
| `MarketCreated` | `(MarketId indexed poolId, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken)` (`:107-120`) | **Market discovery** (gives share token addresses; note `rateMin/rateMax/rateChange*` are NOT in the event — recover the full `Market` via `market(poolId)` call). |
| `PoolModifyLiquidity` | `(MarketId indexed poolId, address indexed sender, address indexed owner, uint256 amount0, uint256 amount1, bool isRemove)` (`:62-69`) | deposits/mints/unwinds/withdraws (amount0 = CA, amount1 = REF). |
| `PoolSwap` | `(MarketId indexed poolId, address indexed sender, address indexed owner, uint256 amount0, uint256 amount1, uint256 lpFeeAmount0, uint256 lpFeeAmount1, bool isUnwind)` (`:71-89`) | swap/exercise (`isUnwind=false`) and unwindSwap/unwindExercise (`true`). |
| `PoolFee` | `(MarketId indexed poolId, address indexed sender, uint256 devFeeAmountInCollateralAsset, uint256 devFeeAmountInReferenceAsset, bool isUnwind)` (`:91-103`) | protocol fee tracking. |
| `MarketActionPausedUpdate` | `(MarketId indexed marketId, uint16 pausedAction)` (`:122-133`) | pause-bitmap changes (bit0 dep, 1 swap, 2 withdraw, 3 unwindDep, 4 unwindSwap). |
| `SwapFeePercentageUpdated` / `UnwindSwapFeePercentageUpdated` | `(MarketId indexed poolId, uint256 indexed …fee)` (`:135-144`) | fee state for local quoting. |
| `TreasurySet(address)` / `SharesFactorySet(address)` | (`:146-152`) | admin telemetry. |

### WhitelistManager proxy `0xcCcc…b0eE` (`IWhitelistManager.sol:38-53`)
`GlobalWhitelistAdded/Removed(address indexed)`, `MarketWhitelistAdded/Removed(MarketId indexed, address)`,
`MarketWhitelistDisabled/Enabled(MarketId indexed)` → materialize `poolWhitelistStatus` + per-account whitelist.

### 1inch LOP v4 `0x1111…2A65`
`OrderFilled(bytes32 orderHash, uint256 remainingAmount)` (**no indexed params** — filter by
address+topic0, match orderHash in data), `OrderCancelled(bytes32 orderHash)`,
`BitInvalidatorUpdated(address indexed maker, uint256 slotIndex, uint256 slotValue)`
(`IOrderMixin.sol:50-73`). Chain scope: mainnet + **Arbitrum 42161** (live LOB markets).

### ConstraintRateAdapter
Emits **nothing**. Rate/credit state changes are only observable via `constraints(poolId)` calls
or by re-deriving from `PoolSwap`-bearing blocks. For time-series of the adjusted rate, sample
`CorkPoolManager.swapRate(poolId)` (view) — or shadow-compute (§4.3).

Also useful: `dim_oracles`-style sampling of `Market.rateOracle.rate()`; ERC-20 `Transfer` on
each market's cPT/cST (addresses from `MarketCreated`) for position tracking.

---

## 10. Consumer integration example (covered-vault)

`covered-vault/contracts/src/CorkMarketAdapter.sol:53-60, 103, 235-240` — pins one
`(POOL_MANAGER, MARKET_ID)` pair, re-exposes `previewSwap(collateralAssetsOut)` and market
views through a minimal `ICorkPoolManager` interface; the Euler-side stack (oracles, liquidator,
`RolloverKeeper`) consumes those quotes. Confirms: integrators identify markets by `MarketId`
and quote via `previewSwap` exactly as the CLI will.

---

## 11. Governance / roles (context for decode + admin telemetry)

- Owner/upgrade: TimelockUpgrade (5d delay per `prod.toml:180 timelock_delay_upgrade = 432000`), controller-admin 24h, operational 6h (`prod.toml:177-182`).
- `DefaultCorkController` (`contracts/interfaces/IDefaultCorkController.sol:50-163`) is the only authorized caller of manager admin fns + whitelist mutations; has granular pause/unpause per action.
- Manager-level global pause `setAllPaused` (admin role, `IPoolManager.sol:960-966`); pauses are immediate on-chain (timelock delay is at the proposer level).

---

## 12. DISCREPANCIES & GAPS

1. **DISCREPANCY(1) — "Dutch-auction limit-order prices":** No Dutch auction exists in Cork's
   limit-order stack. Cork LOB V1 orders are fixed-price plain LOP v4 structs with **no
   extension** (server hash check over the bare struct, `post-order.ts:241-253`; permit2 blob
   stored out-of-band). 1inch's `DutchAuctionCalculator` extension exists upstream
   (`limit-order-protocol/contracts/extensions/DutchAuctionCalculator.sol`) and its math is
   documented in §5.1 in case Cork adopts it (e.g. via Fusion-style orders), but the CLI should
   not assume time-varying limit-order prices today. QUESTION(1): does the production frontend
   ever set `HAS_EXTENSION`/`USE_PERMIT2` maker-traits bits? (decode makerTraits of live orders
   from `api-phoenix.cork.tech` to confirm.)
2. **DISCREPANCY(2) — "rollover-order prices over time":** rollover premium is a **fixed floor**
   (`minPremiumPerShare`, `RolloverTypes.sol:104-109`) with no on-chain decay curve. The only
   time-varying components are Phoenix-side (unwind time-decay fee → 0 at expiry;
   constraint-rate drift). QUESTION(2): is there an off-chain filler-auction layer (e.g. the
   frontend re-posting orders with stepped premiums) that motivated the "prices over time"
   requirement? Also QUESTION(2b): which pools/assets back the **Arbitrum** LOB markets, given
   `phoenix-private/config/prod.toml` only defines sepolia + mainnet deployments — older Cork V1
   (PSM/DS) markets or an unlisted Phoenix deployment?
3. **ASSUMPTION(3) — ABI provenance:** no compiled full Phoenix ABI exists locally; the CLI will
   generate ABIs from `phoenix-private/contracts/interfaces/*.sol` assuming they match the
   deployed impl `0x1cCc…8244`. Verify against Etherscan-verified source before shipping decode.
4. **Gap — `previewAdjustedRate` is `onlyCorkPoolManager`** (`ConstraintRateAdapter.sol:150`):
   a CLI cannot read it directly; use `CorkPoolManager.swapRate(poolId)` or local recompute from
   permissionless `constraints(poolId)` + `market(poolId)` + `rateOracle.rate()`.
5. **Gap — previews return 0 instead of reverting** when paused/expired (`PoolLib.sol:225-227,
   264-267`): the CLI must check `getPausedBitMap` + expiry before interpreting a 0 quote.
6. **QUESTION(6) — `withdraw` NatSpec contradiction:** `IPoolManager.sol:349-351` says withdraw
   "Works only on active markets (before expiry)" yet `@custom:reverts If market is not expired`
   (`:364`), and `_previewWithdraw` requires expired (`PoolLib.sol:688 if (!_isExpired) return
   (0,0,0)`). Code says **withdraw family is post-expiry** (like redeem); the "before expiry"
   doc-line is stale. Trust the code path.
7. **QUESTION(7) — `MarketCreated` omits rate-constraint params**, so pure-event market discovery
   can't reconstruct `MarketId` preimage; a `market(poolId)` call per discovered pool is required
   (or extsload).
8. **QUESTION(8) — exercise-family pauses:** exercise/swap gate on bit1, unwind-swap family on
   bit4 (`PoolLib.sol:795-809`); `MarketActionPausedUpdate` is the only pause event — global
   `setAllPaused` uses OZ `Paused/Unpaused` events from PausableUpgradeable
   (ASSUMPTION — verify topic0 against deployed impl).
9. **Note — naming:** the deployed "corkPoolAdapter" is contract `CorkAdapter`;
   "corkPoolManager/corkPool" is `CorkPoolManager`; task naming maps 1:1.
10. **Note — `phoenix-private-rollover-misnamed`** is an earlier rollover architecture
    (`erc6909/fillers/settlers` layout, README "rollover-phoenix-private"); do not use as source
    of truth — `rollover-private` supersedes it.
