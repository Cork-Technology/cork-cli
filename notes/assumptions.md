# ASSUMPTION log

- ASSUMPTION(1): "CorkPoolAdapter" in the brief = `CorkAdapter` (contracts/periphery/CorkAdapter.sol,
  deployed at `0xCCcC…0407`, config key `cork_adapter`, frontend key `corkPoolAdapter`). All three
  names refer to the same contract.
- ASSUMPTION(2): the live-oracle panic (0x11) at vnet head is a vnet artifact (frozen Chainlink
  upstream vs advanced vnet clock), not a protocol bug — it works at historical mainnet blocks.
- ASSUMPTION(3): the credit-bucket refill uses per-second linear accrual `perDayMax * elapsed / 86400`
  (matches observed 1-wei rounding); exact integer order-of-operations to be confirmed against
  ConstraintRateAdapter.sol before shipping parity math (source quoted in
  research/cork-contracts-domain.md — verified there, kept as assumption until the TS/Rust port
  passes bit-parity CI).
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
