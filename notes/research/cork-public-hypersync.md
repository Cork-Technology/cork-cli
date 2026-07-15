# Research: Cork protocol public surface + Envio HyperSync practicalities

Date: 2026-07-15. For the `cork` CLI + MCP server (Centralized / Lite-Decentralized / Full-Decentralized data modes).

---

## Part A — Cork protocol public surface

### A1. Documentation (docs.cork.tech) — enrichment-reference URLs

Docs are GitBook-hosted at `https://docs.cork.tech`. **Cloudflare-challenged for plain curl/WebFetch** on inner pages, but two reliable programmatic paths exist:

- **`https://docs.cork.tech/llms.txt`** — machine-readable full index (title + URL + one-line description per page). Ideal to keep as the canonical enrichment-link source; fetched successfully with a browser UA once, but flaky behind Cloudflare.
- **GitHub mirror (always works, no CF):** repo `Cork-Technology/docs`, default branch **`gitbook`** → `https://raw.githubusercontent.com/Cork-Technology/docs/gitbook/<path>.md`. The path structure matches docs.cork.tech URLs 1:1.

**Current ("phoenix") architecture pages** — stable URLs to embed as JSON field doc-links:

| Concept | URL |
|---|---|
| What is Cork (overview) | https://docs.cork.tech/ (repo: `overview/readme.md`) |
| Cork Pool (markets, dual-token, exercise/repurchase mechanics) | https://docs.cork.tech/core-concepts/cork-pool |
| Swap Token (cST) | https://docs.cork.tech/core-concepts/swap-token |
| Principal Token (cPT) | https://docs.cork.tech/core-concepts/principal-token |
| Reference Asset (REF) | https://docs.cork.tech/core-concepts/reference-asset |
| Collateral Asset (CA) | https://docs.cork.tech/core-concepts/collateral-asset |
| Fees | https://docs.cork.tech/core-concepts/fees |
| Whitelist functionality | https://docs.cork.tech/core-concepts/whitelist-functionality |
| Target assets & use cases | https://docs.cork.tech/core-concepts/target-assets-and-use-cases |
| Exercise swaps (user guide) | https://docs.cork.tech/user-guides/exercise-swaps |
| Provide liquidity / Mint tokens | https://docs.cork.tech/user-guides/provide-liquidity (+ `/mint-tokens`, `/mint-tokens-without-dapp`, `/mint-tokens-without-dapp-or-batch-capable-wallet`) |
| Unwind tokens | https://docs.cork.tech/user-guides/provide-liquidity/unwind-tokens-without-dapp |
| OTC trading of Swap Tokens | https://docs.cork.tech/user-guides/otc-trading-of-swap-tokens |
| FAQ | https://docs.cork.tech/faq/frequently-asked-questions |
| Audits | https://docs.cork.tech/smart-contracts/audits |
| Phoenix deployments (addresses) | https://docs.cork.tech/smart-contracts/phoenix-deployments |
| Developer quick start | https://docs.cork.tech/developers/quick-start |
| Contract reference (index) | https://docs.cork.tech/developers/contract-reference |
| CorkAdapter reference | https://docs.cork.tech/developers/contract-reference/cork-adapter |
| CorkPoolManager reference | https://docs.cork.tech/developers/contract-reference/cork-pool-manager |
| Admin & governance reference | https://docs.cork.tech/developers/contract-reference/admin-and-governance |
| REST API reference | https://docs.cork.tech/developers/api-reference |
| **AI Context (LLM-optimized consolidated reference)** | https://docs.cork.tech/developers/ai-context |

**Legacy vs current:** the live docs site now describes ONLY the phoenix architecture. Legacy-era items:
- `smart-contracts/v1/overview` (`https://docs.cork.tech/smart-contracts/v1/overview`) still appears in Google results but is **not in the current llms.txt/gitbook tree** — treat as legacy (Depeg Swap / PSM / Cork AMM / Vault era).
- The **OTC trading of Swap Tokens** user guide is a leftover from the pre-limit-order era: it walks through **Airswap OTC** (airswap.xyz/otc), not the current 1inch-LOP-based orderbook. Don't cite it for limit-order mechanics.
- **No "Dutch auction" or "rollover" page exists in current docs** (rollover was a v1 Liquidity-Vault concept; the post-mortem discusses rollover pricing as part of the exploited OLD system). GitHub code search for "dutch"/"1inch" in `Cork-Technology/docs` and "limit order" in `phoenix` returned nothing — the docs deliberately don't name 1inch; the API reference says only "Orders use EIP-712 typed signing… Contact the Cork team for the signing SDK."

**Key protocol semantics captured from AI-context page** (`developers/ai-context.md`, verbatim-checked):
- Market struct = 8 fields: `collateralAsset, referenceAsset, expiryTimestamp, rateMin, rateMax, rateChangePerDayMax, rateChangeCapacityMax, rateOracle`. **MarketId = keccak256(abi.encode(Market))** — all 8 fields, chain-independent. (Note: the phoenix-deployments page contradicts this with "keccak256(abi.encode(collateralAsset, referenceAsset))" — the ai-context/quick-start 8-field version is the correct one; deployments page hint is stale/wrong.)
- Ops before expiry: Deposit (CA→cPT+cST), Unwind Deposit (cPT+cST→CA), Withdraw (cPT→CA+REF), Exercise (REF+cST→CA minus fee), Repurchase/UnwindSwap (CA→REF+cST). After expiry: Redeem (cPT→CA+REF proportional).
- cPT/cST always 18 decimals regardless of underlying. Fees 18-dec precision, `1e18 = 1%`, max `5e18` (5%); apply to Exercise + Repurchase.
- Reads via CorkPoolManager (`swapRate`, `assets`, `shares`, `market`, `preview*`, `max*`, `swapFee`, `unwindSwapFee`); writes via CorkAdapter `safe*` (slippage + deadline). Whitelist check: `WhitelistManager.isWhitelisted(marketId, account)`.

### A2. GitHub — Cork-Technology org

https://github.com/Cork-Technology — public repos (as of 2026-07-15):

| Repo | Status | Notes |
|---|---|---|
| **phoenix** | **PUBLIC**, default branch `main`, updated 2026-03-05 | The current protocol. Solidity/Foundry. `contracts/core/`: CorkPoolManager, CorkPoolManagerStorage, DefaultCorkController, WhitelistManager, ConstraintRateAdapter, Extsload, assets/PoolShare + SharesFactory. `contracts/periphery/`: CorkAdapter, GeneralAdapter, WrapperRateConsumer, bundler3 adapters (Morpho Bundler3). **No limit-order contracts in-repo** — limit orders ride entirely on external 1inch LOP v4. Installable: `forge install cork-technology/phoenix`; import `contracts/interfaces/IPoolManager.sol`, `ICorkAdapter.sol`. Release tag `v1.1.0` exists (Certora audit scope). https://github.com/Cork-Technology/phoenix |
| **docs** | public, default branch **`gitbook`** | GitBook source of docs.cork.tech (see A1). |
| bond-cork-zyfai | public, TS | Hackathon/event project (Arbitrum Open House, Jul 2026). Not relevant. |
| clear-signing-erc7730-registry / -builder | public | ERC-7730 clear-signing descriptors — mildly relevant if the CLI ever surfaces signing metadata. |
| vault-v2 | public, Solidity | Fork of Morpho Vault V2. Peripheral. |
| mta-sts.cork.tech | public | Email infra, irrelevant. |
| **Depeg-swap** | public, **ARCHIVED** (Jul 2025) | Legacy v1 protocol (exploited era). |
| **Cork-Hook** | public, **ARCHIVED** | Legacy Uniswap-v4 hook (exploit locus). |
| **V1-Router** | public, **ARCHIVED** | Legacy. |
| DefiLlama-Adapters, puffer-assets, ethena_sats_adapters, v2-periphery | archived forks/misc | Legacy. |

**Not found (404 → private or nonexistent):** `cork-indexing-api`, `indexer`, `sdk`, `cork-sdk`, `app`, `frontend`. The indexer behind api-phoenix.cork.tech and the frontend are closed-source.

**npm:** `@cork-technology/phoenix` **does NOT exist on npm** (registry 404), despite the quick-start docs saying `npm install @cork-technology/phoenix`. The CLI cannot rely on a published Cork ABI/SDK package — vendor ABIs from the phoenix repo or Sourcify (below).

### A3. Contract verification (keyless ABI/source retrieval — Full-Decentralized mode)

All core contracts are **verified on Sourcify with full/perfect match** (creation + runtime), verified 2026-01-16. Sourcify's v2 API is keyless and JSON:

- `GET https://sourcify.dev/server/v2/contract/1/<address>` → match status.
- `GET https://sourcify.dev/server/v2/contract/1/<address>?fields=abi` → **full ABI, no API key** ✔ (tested).
- `?fields=compilation,deployment` → compiler settings, fully-qualified name, **deployment tx hash + block number + deployer** ✔.
- `repo.sourcify.dev` legacy path returns 307 redirects — use the `/server/v2` API instead.

Verified facts pulled from Sourcify (chain 1):

| Contract | Address | FQN / name | Deploy block | Deploy tx |
|---|---|---|---|---|
| CorkAdapter (docs call it "CorkAdapter", not "CorkPoolAdapter") | `0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407` | `contracts/periphery/CorkAdapter.sol:CorkAdapter` | **24134645** | `0xddd1aa30…2056` |
| CorkPoolManager (proxy) | `0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC` | (ERC1967/UUPS proxy) | **24238837** | `0x1645feb4…079c` |
| WhitelistManager (proxy) | `0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE` | — | **24134627** | `0xb21400da…05cd` |

Deployer for all: `0x6B472867Df483d14e8FdEdcbB60D4f20A26E5DE3` via Safe CREATE2 Deployer `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` (deterministic addresses across chains). Compiler solc 0.8.30, viaIR, optimizer runs=1, evmVersion paris, `appendCBOR: false` / `bytecodeHash: none`.

> Note: the task brief said "deployed around block 24238826" — that matches the CorkPoolManager *proxy* (24238837); CorkAdapter and WhitelistManager are earlier (~24134.6k). For HyperSync backfill, **start at 24134627** (earliest core deployment) to catch everything.

**Etherscan:** presumably verified too (docs link to etherscan.io pages), but the Etherscan v2 API **requires an API key** even for `getsourcecode`/`getabi` (tested: `Missing/Invalid API Key`). So **Sourcify is the keyless programmatic source of truth** for Full-Decentralized mode.

**Full deployment table** (from https://docs.cork.tech/smart-contracts/phoenix-deployments):
- CorkPoolManager impl: `0x1cCccCccCcCf9A60Fe57cd7CEf504d1DaaA78244` (UUPS)
- SharesFactory: `0xcCCCccCCCcCc1782617fe14A386AC910a20D4324` (deploys per-pool cPT/cST)
- DefaultCorkController: `0xcCcCcCccCccbC06627F8aad7aAF13fe3a457f779`
- ConstraintRateAdapter (proxy): `0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A` (Chainlink constraint-rate)
- Timelocks: Upgrade `0x7CcCCCccCcc0b4c00d01f321035b8e4523eF8448` (5d), Admin `0x7CccCCccccCCe566CdAFFA9EF2CB245Ad5575c3b` (1d), Operational `0x7CcCcCCcCccCC1d856F2994A66fAa7011F1A89D9` (6h)
- External deps: Morpho Bundler3 `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- Call path: `User → Morpho Bundler3 → CorkAdapter → CorkPoolManager → SharesFactory → cPT/cST`

### A4. Cork's own API (Centralized mode)

**Base URL: `https://api-phoenix.cork.tech`** — live, keyless, CORS-open enough for curl; Swagger UI at `/docs`, **OpenAPI JSON at `/docs/json`** (title: "Cork Protocol API — Read-only analytics API for Cork data (flows, pools, etc.)", v1.0.0). Docs page: https://docs.cork.tech/developers/api-reference

Endpoints (all cursor-paginated `{items, nextCursor, hasMore}`):
- `GET /v1/pools/` — pool metadata, TVL (USD), fee config, pause flags. Filters: `chainId`/`chainName` (mainnet|virtual|sepolia), `poolId`, `collateralAddress`, `referenceAddress`, `principalAddress`, `swapAddress`, `poolWhitelistStatus`, `expiryBefore/After`, `limit` (default & max 2000). **Live response is richer than docs**: includes `deploymentBlockNumber`, `deploymentTxHash`, `blockNumber/blockTimestamp` (last event), `rateOracleAddress`, `poolManagerAddress`. Example live pool: `sUSDe-vbUSDC-20APR2026`, poolId `0xab4988fb…702a`, pool deployed block 24274824.
- `GET /v1/pools/whitelisted-addresses` — per-pool whitelist entries with `isGlobalWhitelisted` / `isMarketWhitelisted`; `walletAddress` filter for point checks.
- `GET /v1/flows/` — tx history; `actionType` enum: `exercise, repurchase, redeem, mint, unwind`; filters by wallet/pool/block-range/timestamps.
- `GET /v1/limit-orders/markets` — limit-order markets `{chainId, poolId, makerAsset, takerAsset, isActive}`. **Live data: active markets currently on Arbitrum (chainId 42161)** — Cork is multichain (same CREATE2 addresses); the CLI must not hardcode chainId=1.
- `GET /v1/limit-orders/orderbook` — active orders; filters `maker`, `side` (BUY|SELL), `status[]`.
- `GET /v1/limit-orders/fills` — fills by `orderHash`/`maker`/`taker`/time range.
- `POST /v1/limit-orders/` — submit signed order. Request body is **exactly a 1inch Limit Order Protocol v4 order** + Cork metadata: `salt, maker, receiver, makerAsset, takerAsset, makingAmount, takingAmount, makerTraits, extension, orderHash, signature` plus `makerAccountType (EOA|CONTRACT), makerPermit2, side, premium (0–10000), expiry, nonce, allowsPartialFills, chainId`. This confirms limit orders ride 1inch LOP v4 (`0x111111125421cA6dc452d289314280a0f8842A65`, same address all chains) even though docs never name 1inch.

No auth, no documented rate limits. Docs hint: "Always include `chainId=1`… other chain IDs may return testnet data" (but note live Arbitrum data above). No public GraphQL endpoint found; no Envio-hosted public indexer found for Cork (the indexer is private; the REST API fronts it).

### A5. Exploit history, phoenix relaunch, audits

- **May 28 2025 exploit (~$11–12M, 3,761 wstETH)** on the OLD architecture (Cork Beta: Peg Stability Module + Liquidity Vault + Uniswap v4 "Cork Hook" + FlashSwapRouter). Official post-mortem: https://www.cork.tech/blog/post-mortem (4 Jun 2025). Two combined vectors: (1) rollover-pricing edge case near market expiry let attacker buy 3,761 Cover Tokens for ~0.000002 wstETH; (2) malicious hook-like contract bypassed authorization in Cork Hook + FlashSwapRouter (Cork used a Uniswap v4 periphery version predating an upstream explicit-authorization feature). Third-party analyses: Dedaub https://dedaub.com/blog/the-11m-cork-protocol-hack-a-critical-lesson-in-uniswap-v4-hook-security/, Halborn https://www.halborn.com/blog/post/explained-the-cork-protocol-hack-may-2025, QuillAudits https://www.quillaudits.com/blog/hack-analysis/cork-protocol-hack-explained, SlowMist https://slowmist.medium.com/exploit-analysis-cork-protocol-attacked-over-10-million-lost-75de9f229307.
- **Cork Phoenix** = ground-up rebuild: singleton CorkPoolManager, no AMM/no Uniswap hook, no Liquidity Vault automation/rollover; risk transfer via cPT/cST minting + off-chain-signed 1inch LOP orders; oracle-constrained swap rates (ConstraintRateAdapter with rateMin/rateMax/daily-change caps); timelocked governance. Mainnet deployment Dec 2025–Jan 2026 (blocks ~24.13M–24.24M); first pool Jan 20 2026.
- **Audits of the NEW architecture** (https://docs.cork.tech/smart-contracts/audits):
  - **ChainSecurity** — full protocol audit of phoenix v0.5.0 pre-release (commit `fe005f1be810c0f3f76fd8471fb199772cf1ac3a`), Nov 2025. PDF: https://drive.google.com/file/d/1l16EzUj8GRDA19Ta5AC0LM4Z25In_xxD/view
  - **Certora** — full audit + formal verification of phoenix v1.1.0 (https://github.com/Cork-Technology/phoenix/releases/tag/v1.1.0), Jan 2026; 11 verified properties (accounting consistency, token backing, front-run resilience, fee enforcement). PDF: https://drive.google.com/file/d/1TPizkmb0EVETjoONSjxe6TAAKVpeAKyH/view

---

## Part B — Envio HyperSync practicalities

### B1. API tokens, limits, pricing

- Docs: https://docs.envio.dev/docs/HyperSync/api-tokens. Tokens are generated in the Envio dashboard: https://envio.dev/app/api-tokens (sign-in required).
- **Tokens are required since 3 November 2025** for normal service; requests without a token are (aggressively) rate-limited — plan on requiring the user to supply `ENVIO_API_TOKEN` for Full-Decentralized mode, with tokenless as degraded fallback at best.
- Usage is metered two ways: **request count** and **"credits"** (composite of bandwidth, disk reads, other resources). Exact free-tier credit caps and per-tier rate limits are **not published** in docs; pricing page https://envio.dev/pricing shows tiers exist (free dev tier → paid production) but numbers are behind the dashboard/sales. Envio Cloud-deployed indexers get token-free special access.
- Practical implication for the CLI: treat token as config, surface 429/credit-exhaustion errors clearly; don't promise specific free-tier volumes in docs.

### B2. Endpoints, freshness, reorgs

- Endpoint scheme: `https://<network>.hypersync.xyz` or `https://<chainId>.hypersync.xyz`; **Ethereum mainnet = `https://eth.hypersync.xyz` (= `https://1.hypersync.xyz`)**. 90+ EVM networks + Fuel. List: https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks (Arbitrum = `https://arbitrum.hypersync.xyz` — needed since Cork limit-order markets live there).
- Query/response model (https://docs.envio.dev/docs/HyperSync/hypersync-query): response carries `archive_height` (HyperSync's current indexed height — compare with `next_block` to know if you're at tip), `next_block` (pagination cursor), and **`rollback_guard`** (block hash/number/timestamp) for reorg detection. HyperSync itself validates parent hashes and re-syncs on forks, so it always serves canonical data, but **already-fetched data can go stale**: clients must compare the guard's parent hash against the previously stored hash and re-fetch the affected range on mismatch.
- Freshness: HyperSync follows the head with small lag (near-real-time; Envio markets it for monitoring/trading agents — https://docs.envio.dev/blog/stream-onchain-events-ai-trading-agent). There is no hard SLA on blocks-behind-head; poll `archive_height` and, if sub-block latency at tip matters, supplement with an RPC `eth_blockNumber` cross-check.
- **`stream()`/`collect()` are explicitly NOT designed for the chain tip** (no rollback handling). Correct live-follow pattern: paginate with `get()` in a loop — `fromBlock = res.nextBlock`, sleep/poll when `next_block >= archive_height`, check `rollback_guard` each iteration. Backfill with `stream()`, then switch to the polling loop at tip. This "backfill + follow" pattern is standard usage; people do run HyperSync for live following, with hand-rolled reorg handling (HyperIndex automates exactly this on top of HyperSync — https://docs.envio.dev/docs/HyperIndex/reorgs-support).

### B3. Node client vs Rust crate

- **Node:** `@envio-dev/hypersync-client` — latest **1.4.0** (2026-06-08; upgraded to hypersync-client Rust 1.3.0 + "streaming v2"). Repo: https://github.com/enviodev/hypersync-client-node. It is **itself a napi-rs binding over the Rust client** (prebuilt native binaries per platform), so heavy lifting (Arrow/capnp decode, decompression) is native.
- **Rust:** crate `hypersync-client` — latest **1.4.0** (2026-06-22), https://crates.io/crates/hypersync-client / https://docs.rs/hypersync-client. Repo: https://github.com/enviodev/hypersync-client-rust.
- API shape (both): query object `{fromBlock, toBlock?, logs: [{address[], topics[[..],[..]]}], transactions: [{from/to/sighash/status}], traces, fieldSelection: {block[], log[], transaction[]}, joinMode (Default|JoinAll|JoinNothing), maxNum*}`; preset helpers (`presetQueryLogsOfEvent`, etc.); `get()` single page, `stream()` auto-pagination, `collect*()`, Parquet export; event decoder utilities. Multiple log selections OR together; field selection keeps payloads small. `reverse: true` scans backward from head.
- **Recommendation: use the official Node package, do NOT build a custom napi addon around the Rust crate.** The Node package already is a maintained napi wrapper of the same crate, tracks server protocol changes (e.g. streaming v2), ships prebuilds for common platforms, and its memory behavior is fine for our modest scope (one contract + LOP-filtered logs). A custom addon buys nothing except maintenance burden; only reconsider if we need exotic Arrow-level processing or platforms Envio doesn't prebuild for.

### B4. Pattern for Cork discovery ("all events for contract X from block N + follow tip")

- Backfill: `logs: [{address: [CorkPoolManager, WhitelistManager, DefaultCorkController]}]` from block **24134627**, no topics filter (small address set → cheap), `fieldSelection` limited to needed log/tx fields, via `stream()`.
- 1inch LOP orders: LOP v4 `0x111111125421cA6dc452d289314280a0f8842A65` is shared infrastructure — filter by `address = LOP` + `topics[0] = OrderFilled/OrderCancelled` and post-filter by maker/makerAsset/takerAsset ∈ Cork cST/cPT token set (built from SharesFactory/pool discovery). Same on Arbitrum endpoint.
- Tip-follow: switch to `get()` polling loop with `rollback_guard` checks (B2).
- Limitations to design around: **no eth_call, no state/balance/storage queries** — HyperSync is history only. Current `swapRate`/`assets`/whitelist point-reads must come from RPC (Lite mode path) even in Full-Decentralized mode; HyperSync covers discovery + history only.

### B5. Alternatives / adjacent options

- **Envio HyperIndex** (https://docs.envio.dev/docs/HyperIndex/overview): full indexing framework on top of HyperSync with automatic reorg handling, GraphQL, hosted or self-hosted. Overkill for an embedded CLI (brings Postgres/Hasura runtime), but the right upgrade path if we ever want a persistent Cork indexer; also its reorg docs are the reference for correct rollback semantics (https://docs.envio.dev/docs/HyperIndex/reorgs-support).
- **HyperRPC** (`https://<network>.rpc.hypersync.xyz`): Envio's accelerated read-only RPC — could serve as one of the Lite-mode RPC endpoints (also token-gated now).
- Raw `eth_getLogs` over free public RPCs (chainlist.org): viable fallback for Full-Decentralized when no Envio token, but block-range caps (~1k–10k blocks/req) make 24.1M→head backfills slow; fine for incremental sync.
- ABI/source without keys: **Sourcify v2 API** (A3) — Etherscan needs a key.

---

## Quick-reference (for CLI implementation)

- Centralized mode base: `https://api-phoenix.cork.tech` (OpenAPI at `/docs/json`).
- Backfill start block (mainnet): 24134627 (WhitelistManager) / 24134645 (CorkAdapter) / 24238837 (CorkPoolManager proxy).
- HyperSync mainnet: `https://eth.hypersync.xyz`; Arbitrum: `https://arbitrum.hypersync.xyz`; token from https://envio.dev/app/api-tokens (required since 2025-11-03).
- ABI source (keyless): `https://sourcify.dev/server/v2/contract/{chainId}/{address}?fields=abi`.
- Doc-link enrichment index: `https://docs.cork.tech/llms.txt` (mirror: `raw.githubusercontent.com/Cork-Technology/docs/gitbook/...`).
