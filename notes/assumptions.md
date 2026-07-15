# ASSUMPTION log

- ASSUMPTION(1): "CorkPoolAdapter" in the brief = `CorkAdapter` (contracts/periphery/CorkAdapter.sol,
  deployed at `0xCCcC…0407`, config key `cork_adapter`, frontend key `corkPoolAdapter`). All three
  names refer to the same contract.
- ASSUMPTION(2): the live-oracle panic (0x11) at vnet head is a vnet artifact (frozen Chainlink
  upstream vs advanced vnet clock), not a protocol bug — it works at historical mainnet blocks.
- ~~ASSUMPTION(3)~~ **CONFIRMED against source** (ConstraintRateAdapter.sol `_calculateRate`,
  read directly): `refillRatePerSeconds = mulDiv(perDayMax, 1e18, 86400)`; `creditsRefilled =
  mulDiv(elapsed, refillRatePerSeconds, 1e18)`; `creditsCapped = min(capacityMax, remaining +
  refilled)`; `consumed = min(|oracleRate − lastRate|, creditsCapped)`; move, clamp to
  [rateMin, rateMax], recompute actual consumption from the clamped move; `remaining =
  creditsCapped − actualConsumed`. Notable: **no state change at all when oracle == lastRate**
  (early return, timestamp untouched), and **clamping at rateMin refunds unused credits** — a
  pool sitting at the floor accrues a full bucket, so recovery can jump `capacityMax` upward in
  one commit. Matches all 9 fork tests including 1-wei artifacts.
- ASSUMPTION(4): `adjustedRate()` commits happen only via user actions on the PoolManager
  (swap/exercise paths), so real-world descent cadence is bounded by trading activity — the
  worst-case model (commit every refill interval) is conservative-correct for risk display.
- ASSUMPTION(5): chain 49222 ("virtual") is a long-lived Cork team Tenderly vnet used by their
  indexer/frontend for staging; the brief's vnet URL (chainId 1) is a separate euler-research vnet.
- ASSUMPTION(6): Arbitrum uses the same CREATE2 addresses as mainnet for the core contracts
  (api-phoenix data shows the same PM address on 42161; prod.toml has no [arbitrum] section —
  its config presumably lives elsewhere or post-dates the fetched commit).
- ASSUMPTION(7): api-phoenix.cork.tech is the "Centralized mode" backend the brief refers to
  (matches cork-indexing-api source in euler-research).
