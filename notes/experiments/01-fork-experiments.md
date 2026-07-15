# Empirical fork experiments — 2026-07-15 (unattended session)

Harness: `experiments/fork-harness/` (Foundry tests, run via podman image
`ghcr.io/foundry-rs/foundry:latest` because host `forge` is glibc-broken on this musl box —
`cast`/`anvil` fine, matches euler-research README warning). Fork source: the Tenderly vnet
from the brief (`virtual.mainnet.us-east...REDACTED-VNET`), used as a **read-only fork origin**
for in-process `forge test --fork-url` — no shared vnet state was mutated (all mutations
happen inside forge's local fork copy).

Run command:
```bash
cd experiments/fork-harness
podman run --rm -v "$PWD:$PWD" -w "$PWD" --entrypoint forge ghcr.io/foundry-rs/foundry:latest \
  test --fork-url https://virtual.mainnet.us-east.rpc.tenderly.co/corkprotocol/euler-covered-vault/REDACTED-VNET -vv
```
All 9 tests pass (ImpairmentFloor 5, DescentToFloor 3, UnwindLifecycle 1).

## 0. Environment constraints discovered (matters for how we test the product later)

- **This sandbox blocks loopback TCP dialing** — a locally spawned `anvil` binds but nothing can
  connect (tried background task, same-invocation `&`, IPC via long path → `sun_path` limit; IPC
  socket on shared FS never appears because backgrounded daemons get isolated mounts).
  ⇒ anvil-as-server is unusable here; **`forge test --fork-url` (in-process revm fork) is the
  workable harness** — and it's exactly the §5.5 parity-CI shape anyway.
- Host `forge` broken (`__res_init`/`fcntl64` relocation) — musl vs glibc; podman foundry image works.
- Public RPC reality check: `publicnode` OK for head reads but **rejects historical `eth_getLogs`
  ("Archive requests require a personal token")**; `llamarpc` was down (521). Free-RPC fallback
  logic is a real requirement for Lite-Decentralized mode, not gold-plating.
- The Tenderly vnet: chainId **0x1**, head block 25,434,152, head timestamp 1,783,633,403
  (≈2026-07-09; behind real mainnet ~25.54M). **Archive reads of pre-fork mainnet history work**
  (state + logs), so it doubles as a free archive node for Cork-era mainnet blocks.
- The Cork "virtual" testnet with chainId **49222** (in api-phoenix + cork-indexing-api
  `CHAIN_NAME_TO_ID = {mainnet:1, virtual:49222, sepolia:...}`) is a *different* vnet than the
  brief's URL (which reports chainId 1). QUESTION(3) — see questions.md.

## 1. Market discovery (Goal 1 / Full-Decentralized mode)

- **No on-chain market enumeration exists** on CorkPoolManager (`market(id)`, `getId(params)`,
  `assets`, `shares`, `swapRate` only) ⇒ decentralized discovery MUST scan `MarketCreated` logs.
  Confirms the HyperSync/backfill design need.
- `MarketCreated` scan on the vnet from block 24134627 found **4 markets**:
  - 24274824: `0xd16e34…` (sUSDe/vbUSDC JAN2026, mainnet-real) and `0xab4988…` (APR2026, mainnet-real)
    — both also in api-phoenix `/v1/pools/`.
  - 25432676 / 25432738 (**post-fork, vnet-only**): `0xe855cf62…` exp 1790674475 (≈2026-09-28),
    `0x9d4fd700…` exp 1790853539 — live/unexpired in vnet time; used as experiment targets.
- **`MarketCreated` does NOT carry the rate-constraint params** (topics: poolId, referenceAsset,
  collateralAsset; data: expiry, rateOracle, principalToken, swapToken) — but MarketId =
  keccak256(abi.encode(full 8-field Market struct)). ⇒ an indexer must call `market(poolId)`
  once per discovered pool to get rateMin/rateMax/perDay/capacity (then can *verify* the id by
  re-hashing — nice integrity check the CLI can do for free).
- API cross-check: `api-phoenix.cork.tech/v1/pools/` shows chainId 1 (2 pools, both expired),
  42161 Arbitrum (3 pools, **all expired 2026-07-12** — 3 days before this session), 49222
  virtual (live pools incl. absurd expiries 2533/7606 — test artifacts). **There is currently no
  live unexpired pool on a public chain.**

## 2. ConstraintRateAdapter mechanics (the "impairment floor" — highest-value target)

Setup: vnet-only live pool `0xe855cf62…` (sUSDe/vbUSDC, rateMin=0.7607122926e18,
rateMax=0.8223561283e18, rateChangePerDayMax=6.849e14 (~0.0685%/day),
rateChangeCapacityMax=4.7945e15 (~0.48%), oracle `0x78FB…`). Oracle mocked via `vm.mockCall`
to 0.5e18 (catastrophic crash, far below rateMin). `previewAdjustedRate` called under
`vm.prank(poolManager)` because it is **`onlyCorkPoolManager`** (permissionless callers get
revert `0x940f5f69`) — the public read path is `PoolManager.swapRate(poolId)`, verified
**bit-identical** to `previewAdjustedRate`.

Observed mechanics (all empirical, 9/9 tests green):

1. **Token bucket in absolute rate units.** `constraints(poolId)` returns
   `(lastAdjustedRate, lastAdjustmentTimestamp, remainingCredits)`. Credits refill linearly at
   `rateChangePerDayMax` per day since `lastAdjustmentTimestamp`, **capped at
   `rateChangeCapacityMax`**; each committed adjustment (`adjustedRate()`, state-changing) moves
   the stored rate toward the clamped oracle rate by at most the available bucket and consumes
   credits equal to the actual |movement| — **symmetric: upward moves consume credits too**
   (empirically: recovery move of +1 day-refill right after a drain, credits stayed 0).
2. **A single commit can spend the whole accumulated bucket at once** — perDayMax limits refill
   speed, NOT per-transaction movement. (Bucket was full after ~8.5 idle days; first post-crash
   commit moved the rate by exactly capacityMax = 4.7945e15 in one call.)
3. **`previewAdjustedRate` includes time-accrued refill** (view, uses `block.timestamp`):
   after a drain, previews at +1d/+3d/+7d/+21d showed movement of exactly 1/3/~7 days of refill,
   capped at capacityMax from ~7d on (capacity/perDay = 4.7945e15/6.849e14 = 7.0 days).
4. ⇒ **The on-chain preview can NEVER show more than one bucket (~0.48%) of movement, no matter
   the horizon.** The true worst-case floor over horizon T requires modeling *repeated commits*:
   `worstRate(T) ≈ max(rateMin, lastAdjustedRate − remainingCredits(now) − perDayMax·T)`.
   Empirically (daily commit cadence after crash): day 1 = full bucket, days 2..63 = exactly
   perDayMax each (−1 wei rounding: `moved = 684899999999999`), **rateMin reached on day 64,
   stable day 65**. This is precisely why "worst case ≠ minRate" and why Goal 2's local
   deterministic math must model the committed-descent path, not call the preview.
5. **1-wei rounding artifacts** exist (per-second integer division of perDay/86400) — parity
   tests for a local reimplementation must assert exact equality including these (bit-parity is
   achievable: the math is deterministic integer arithmetic).
6. **Real mainnet trajectory** (APR2026 pool, archive reads at 8 blocks over its life):
   lastAdjustedRate 0.82172→0.82160→0.81814; credits 4.7945e15→4.7919e15→1.3323e15; consumed
   credits exactly equal |Δrate| each time. Adjustments are sparse in practice (2 commits over
   ~40 days) — consistent with commit-on-user-action (swap/exercise triggers `adjustedRate`).

## 3. Swap / preview semantics

- Swap executes at the **constraint-limited** rate, not the raw oracle rate: with oracle mocked
  to 0.8e18 but bucket only allowing descent to 0.803293e18, `swap(10e18 CA out)` charged
  refIn = 10/0.803293 = 12.448759 vbUSDC (6-dec) + cstIn = exactly 10e18 (CST amount ≡ CA amount,
  both 18-dec). `deposit(100e18)` minted exactly 100e18 cST+cPT (1:1). Fees were 0 on the vnet
  pool (mainnet pools had exerciseFee=repurchaseFee=0.05 [in 1e18=1% units per docs]).
- **`previewSwap`/`previewUnwindSwap` succeed on an EMPTY pool** (assets 0,0) — no liquidity/
  fill-ability check in previews. The CLI must not present a preview as proof of executability
  (check `assets()`, paused bitmap, expiry separately).
- `previewUnwindSwap` over warped time (fee=0 pool): refOut converged 6.224379→6.25 vbUSDC per
  5e18 CA over ~7 days — that's the *rate-refill convergence* to oracle, NOT the unwind fee decay.
  The time-decaying unwind fee (linear in time-to-maturity, from `PoolShare.issuedAt()`;
  MathHelper) could not be observed empirically because this pool's fees are 0 — verify on a
  nonzero-fee pool later (source-level formula extracted in research/cork-contracts-domain.md).
- Preview zeros-vs-revert: source says paused/expired previews return **zeros** (not revert);
  empty-pool previews *succeed with real numbers*; uninitialized markets revert. The enrichment
  layer must label zero-previews with the reason (paused? expired?) by reading
  `getPausedBitMap` + `market().expiryTimestamp`.

## 4. Whitelist semantics

- `WhitelistManager.isMarketWhitelistEnabled(poolId)`: **true** for mainnet JAN2026 pool,
  **false** for the vnet-only pools.
- **PoolManager enforces the whitelist itself when enabled** (not just the adapter):
  `deposit` staticcall from a random address at a whitelisted-era block reverts with custom
  error `0x6abe01f1` (args: account, poolId — a NotWhitelisted-style error). With whitelist
  disabled, PM-level deposit/swap are fully permissionless (lifecycle test executed them
  directly, no Bundler3 needed).
- ⇒ TX-prep tools must surface whitelist status *before* preparing bundles; a prepared TX for a
  non-whitelisted initiator is guaranteed-revert. (`/v1/pools/whitelisted-addresses` exposes the
  lists centrally; on-chain check: `isWhitelisted(poolId, account)`.)

## 5. Real calldata decode (Goal 2, `cork decode`)

Real mainnet swap-era tx `0xd236b725…` (found via `PoolSwap` logs on the vnet, blocks
24274824–24350000):
- `to` = **Bundler3** `0x6566…0245`, selector `0x374f435d` = `multicall((address,bytes,uint256,bool,bytes32)[])`.
- Bundle decoded (Sourcify ABI, keyless `GET sourcify.dev/server/v2/contract/1/<addr>?fields=abi`):
  1. CorkAdapter `permit2TransferFromWithPermit(((address,uint256),uint256,uint256),bytes,address,uint256)`
     (`0x4b987c69`) — permit-pull **cST** `0x997f…` 0.5e18 into the adapter;
  2. same — permit-pull **vbUSDC** 608485 (0.608485, 6-dec);
  3. CorkAdapter `safeExercise((bytes32,uint256,address,uint256,uint256,uint256))` (`0x2e010d8a`)
     — poolId JAN2026, cstSharesIn 0.5e18, receiver = EOA, minCollateralAssetsOut ≈ 0.49957e18,
     maxReferenceAssetsIn 608485, deadline.
- Every user-facing Cork action is a **Bundler3 bundle** (adapter functions are `onlyBundler3`).
  ⇒ `cork tx prepare` must emit full bundles (funding step + action + optional sweep);
  `cork decode` must recursively unwrap multicall → per-call ABI decode → param labeling.
  Selector resolution needs ABI-driven keccak with tuple expansion (done here in ~15 lines of
  python; trivial in viem/alloy).

## 6. Oracle quirk on the vnet (shared-state caveat)

- The live rate oracle `0x78FB…` **panics (0x11 arithmetic) at vnet head state** — but works at
  historical mainnet blocks and presumably on real mainnet. Likely frozen upstream Chainlink
  feed data vs advanced vnet timestamp (a stale-feed subtraction). Not investigated deeper
  (vnet artifact, not protocol behavior) — but it means: (a) experiments must `vm.mockCall` the
  oracle at head, (b) the CLI's error enrichment should map oracle panics to a labeled
  "oracle failure" rather than a generic revert. ASSUMPTION(2) in assumptions.md.
