# GitHub config sources — phoenix prod.toml + depeg-frontend (fetched 2026-07-15)

Both fetched via authenticated GitHub MCP gateway (works for private repos; phoenix itself is
also public — see cork-public-hypersync.md).

## phoenix `config/prod.toml` (fetched at repo HEAD 40d9b17, file SHA 4c3fe45)

- Sections: `[sepolia]`, `[mainnet]` — **no Arbitrum section** despite live Arbitrum pools
  (same addresses via CREATE2) → Q4.
- Mainnet `[mainnet.address]` deployed set (all `deployed_* == expected_*` — no drift today):
  - cork_adapter `0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407` (= frontend `corkPoolAdapter`)
  - cork_pool_manager_proxy `0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC` (= frontend `corkPool`)
    / impl `0x1cCccCccCcCf9A60Fe57cd7CEf504d1DaaA78244`
  - constraint_rate_adapter proxy `0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A`
    / impl `0x1CcCCccCCcca9Cc3446B235af1C4cb8E2B01236E`
  - whitelist_manager proxy `0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE`
    / impl `0x1CcCccccCcCbf45E2516caeE86cef63da120CDAD`
  - default_cork_controller `0xcCcCcCccCccbC06627F8aad7aAF13fe3a457f779`
  - shares_factory `0xcCCCccCCCcCc1782617fe14A386AC910a20D4324`
  - timelocks: upgrade `0x7CcC…8448` (delay 432000s=5d — comment in file says 48h, ANOTHER
    stale-comment discrepancy), controller_admin `0x7Ccc…5c3b` (24h), operational `0x7CcC…89D9` (6h)
  - bundler3 (Morpho) `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245`; create2_deployer (Safe
    Singleton Factory) `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`; treasury `0x111fff…d39b`;
    multisigs upgrade/controller/operational `0x0005afec…`, `0x1115afec…`, `0x2225afec…`;
    pauser `0x22813ead…`
- `[mainnet.uint]`: history_deployment_count=2, history_last_deployment_block=24238826
  (⚠ = *last*, not first: Sourcify shows WhitelistManager @24134627, CorkAdapter @24134645 —
  backfill from 24134627; discrepancy D3).
- `[mainnet.bytes32]`: full CREATE2 salt set, identical across chains by design ("Salts MUST be
  identical across all chains") — this is what makes `cork meta config --verify` (derive
  addresses from salt + deployer + initcode hash) and cross-chain address assumptions work.
- Sepolia mirrors mainnet addresses exactly (CREATE2), different bundler3 + test multisigs.

## depeg-frontend `src/config/mainnet.config.ts` (branch `pre-prod`, commit 723718e)

- viem `defineChain` over wagmi mainnet defaults; RPC from `NEXT_PUBLIC_MAINNET_RPC_URL`.
- contracts: corkPool (=PM proxy), corkPoolAdapter, corkWhitelistManager — all match prod.toml;
  plus permit2 `0x0000…22D4…3BA3`, bundler3 (matches), and **lopAddress
  `0x111111125421cA6dc452d289314280a0f8842A65` = 1inch Aggregation Router v6 / LOP v4** — the
  limit-order rail confirmation. `blockCreated: 0` everywhere (no deploy-block info here).

## Cross-check status (config ↔ frontend ↔ Sourcify ↔ on-chain)

- Address triangle: consistent for all overlapping keys. Sourcify full-match verified for core
  contracts (ABI keyless: `GET sourcify.dev/server/v2/contract/1/<addr>?fields=abi`).
- On-chain code present at all addresses (implicitly verified by the fork experiments calling
  them). CREATE2 derivation itself not yet recomputed (needs initcode hashes from build
  artifacts — slot it into `cork meta config --verify` implementation).
