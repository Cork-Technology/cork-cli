# Canonical vnet test fixture — created 2026-07-16

Per product-owner direction ("canonical test environment = Tenderly virtual mainnet chainId 1,
pools you set up yourself using Tenderly impersonation"), a long-lived test pool now exists on
the shared vnet (`virtual.mainnet.us-east.rpc.tenderly.co/corkprotocol/euler-covered-vault/REDACTED-VNET`).

## The fixture

| Item | Value |
|---|---|
| poolId | `0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a` |
| collateralAsset | sUSDe `0x9D39A5DE30e57443BfF2A8307A4256c8797A3497` (18 dec) |
| referenceAsset | vbUSDC `0x53E82ABbb12638F09d9e624578ccB666217a765e` (6 dec) |
| expiry | 1798761600 (2027-01-01T00:00Z — ~5.5 months of vnet life) |
| rateMin / rateMax | 0.5e18 / 1.0e18 (round numbers on purpose) |
| rateChangePerDayMax | 1e15 (0.1%/day) |
| rateChangeCapacityMax | 7e15 (0.7% — exactly 7 days of refill) |
| rateOracle | **MockRateOracle** `0x14115b5fdab3afcd72cf03785041c720100edb0e` |
| swap + unwindSwap fee | 5e16 each (0.05%; on-chain unit 1e18 = 1%) |
| whitelist | disabled |
| cPT / cST | `0xc37d9aCe13C63806c6fA475aD507E94c70b6e110` / `0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69` |
| dev EOA (funded) | `0xC0FFEE0000000000000000000000000000000001` (10 ETH, ~90k sUSDe, ~1M vbUSDC, holds cST/cPT) |
| state | 10k sUSDe deposited; one 100-sUSDe swap executed → locked positions exist, unwind paths live |

**MockRateOracle** (`experiments/fork-harness/src/MockRateOracle.sol`): `rate()` returns a
settable WAD (currently 0.8e18); `setRate(uint256)` is **permissionless by design** (shared dev
convenience) — anyone on the team can simulate a depeg/recovery: e.g.
`cast send 0x14115b… "setRate(uint256)" 600000000000000000 --unlocked --from <any>` (or raw
`eth_sendTransaction`). This bypasses the frozen-Chainlink panic that breaks the real oracle
(`0x78FB…`) at vnet head.

## How it was created (recipe for more pools)

1. Deploy oracle: `eth_sendTransaction {from: <any addr>, data: creationBytecode+abi(initialRate)}`
   — the vnet accepts unsigned txs from any sender (auto-impersonation) and
   `tenderly_setBalance` / `tenderly_setErc20Balance` both work.
2. Create pool **through the controller** (fees + whitelist configured atomically):
   impersonate the **operational timelock** `0x7CcCcCCcCccCC1d856F2994A66fAa7011F1A89D9`
   (holds `POOL_CREATOR_ROLE` on DefaultCorkController) and call
   `createNewPool(((collateral,reference,expiry,rateMin,rateMax,perDay,capacity,oracle),unwindFee,swapFee,isWhitelistEnabled))`.
   (The July-3 vnet markets were instead created by impersonating the controller address
   calling PM directly — that path skips fee/whitelist config; ours is cleaner.)
3. Fund + `approve` + `deposit` + `swap` from the dev EOA to make all preview/unwind paths live.

## Verified read battery (all green, no oracle panic)

- `swapRate` = 800000000000000000 exactly.
- `previewSwap(100e18)` = (100.050025e18 cST, 125062532 vbUSDC, 5.0025e16 fee) — 0.05% gross-up
  and rate division both exact.
- `previewUnwindSwap(50e18)` = (49.975e18 cST out, 62468750 vbUSDC, 2.49998e16 fee) — note the
  unwind fee shows ~0.025% not 0.05% right after issuance; the time-decay normalization needs
  exact porting (flagged for the parity work, not a blocker).
- `constraints` = (0.8e18, <creation ts>, 7e15 = full bucket).

## Caveats

- Shared mutable state: anyone can move the oracle or trade the pool. Parity/CI tests should
  pin block numbers or re-read state at test start; treat the fixture as a *live sandbox*, not
  a frozen golden vector (golden vectors come from `forge test --fork-url` snapshots).
- The vnet clock runs ~6 days behind wall time and advances with activity.
- api-phoenix.cork.tech does NOT index this vnet (its chainId-1 data is real mainnet), so
  centralized-mode tools won't see the fixture — by design, use rpc/indexer modes against it.
