# Verification Log — RFC 011 (Cork MCP/CLI)

Maps every **carried claim** from the rewrite brief and RFC-010 to **how it was tested** and
**what was observed**. Feeds the factual assertions in `rfc/011-cork-mcp-cli.md`. Evidence lives
in the committed lab notebook (`notes/research/*`, `notes/experiments/*`); this file is the index
+ verdict. Verdict legend: **CONFIRMED** (observed on chain/fork/service), **CORRECTED** (claim
was wrong; RFC states the observation), **OPEN** (could not verify without owner/service — logged
as QUESTION for the RFC's Open Questions).

Environment note: `~/repos/cork-knowledge` (the create-rfc skill's default output repo) is absent;
per the brief's Deliverable section the RFC lands at `rfc/011-cork-mcp-cli.md` in this workspace.
Source of truth for contract claims = `euler-research/phoenix-private` + `rollover-private` +
`limit-order-protocol` (read-only), the Tenderly vnet fork, Sourcify, and `api-phoenix.cork.tech`.

---

## C1 — CorkAdapter protected function list & the "exact-spend vs capped-input" split

**Claim (brief/RFC-010):** 13 functions in 5 families; 6 "exact-spend" buildable today, 7
"capped-input" variants lack a safe on-chain protocol and must be exposed as
specified-but-unavailable.

**Tested:** Read `phoenix-private/contracts/periphery/CorkAdapter.sol` +
`interfaces/ICorkAdapter.sol` line by line (cork-contracts-domain.md §2.1); decoded a real
mainnet exercise tx on the vnet fork (`0xd236b725…`, experiments/01 §5).

**Observed — CORRECTED:** There are exactly **13 `safe*` actions**, all `onlyBundler3
onlyWhitelisted(poolId)`, all state-changing, each taking one struct param with a `deadline` and
balance-snapshot slippage guards. Families as they actually group:
mint (`safeMint`/`safeDeposit`), unwind-deposit (`safeUnwindDeposit`/`safeUnwindMint`),
withdraw/redeem post-expiry (`safeWithdraw`/`safeWithdrawOther`/`safeRedeem`),
swap/exercise (`safeSwap`/`safeExercise`/`safeExerciseOther`),
unwind-swap/exercise (`safeUnwindSwap`/`safeUnwindExercise`/`safeUnwindExerciseOther`).
**The "6 buildable / 7 unavailable" split is not borne out.** Every action is buildable today:
each struct pins the exact leg and bounds the variable legs with `min*`/`max*` fields
(e.g. `safeSwap{collateralAssetsOut, maxCstSharesIn, maxReferenceAssetsIn}`), and the adapter's
snapshot check reverts `SlippageExceeded` rather than leaving residuals. There is no
residual/refund gap that makes any of the 13 unsafe to prepare. → RFC exposes all 13 as
`available` prepare variants; drops the "specified-but-unavailable" tier. Residual handling is a
*bundle-composition* concern (add a sweep leg), not a per-action availability gate.

## C2 — Execution path (Bundler3 multicall + Permit2 funding)

**Claim:** actions route through Morpho Bundler3 `multicall` with Permit2 signature transfers.

**Tested:** `CorkAdapter.sol` modifier chain (`onlyBundler3`, `initiator()` whitelist) +
inherited `GeneralAdapter`/`CoreAdapter` action set; decoded the real tx's bundle on the fork.

**Observed — CONFIRMED.** Every Cork action is `onlyBundler3`; users never call the adapter
directly. A user TX = `Bundler3.multicall(Call[])` where legs are `[fund adapter (erc20TransferFrom
or permit2TransferFromWithPermit) → safeX → optional sweep erc20Transfer back]`. The decoded
mainnet tx was exactly: 2× `permit2TransferFromWithPermit` (pull cST + REF) → `safeExercise`.
Bundler3 mainnet `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` (prod.toml). Funding modes: Permit2
signature-transfer OR plain `erc20TransferFrom` (requires prior approval) OR pre-transfer. → RFC
`cork_prepare_phoenix` emits the full bundle, `fundingMode` enum = `permit2 | erc20-approve | pre-funded`.

## C3 — Preview / view surface

**Claim:** `previewSwap`, `previewUnwindSwap`, preview-mint, max reads exist; each R2 compute kind
has an on-chain view.

**Tested:** `IPoolManager.sol` (983 lines) enumerated; fork calls to `previewSwap`/
`previewUnwindSwap`/`swapRate`/`market`/`assets` on live vnet pools (experiments/01 §2–§3).

**Observed — CONFIRMED with two gotchas.** Full set present: 13 `preview*`, 13 `max*`, plus
`swapRate/assets/shares/market/getId/swapFee/unwindSwapFee/getPausedBitMap` + `extsload`.
Gotcha 1: previews **return `(0,0,0)` when paused/expired** (not revert) — RFC's compute tool must
read `getPausedBitMap` + expiry to disambiguate "0 = disabled" from a real quote (DISCREPANCY D6).
Gotcha 2: `ConstraintRateAdapter.previewAdjustedRate` is **`onlyCorkPoolManager`** — a CLI cannot
call it; read rate via `swapRate(poolId)` or recompute locally from permissionless
`constraints(poolId)` + `market(poolId)` + `rateOracle.rate()`. Every R2 compute kind has an
on-chain view to property-test against EXCEPT the horizon-worst-case impairment floor (C7) and
Fusion auction price (C6), which are local-only projections.

## C4 — Share precision & rounding (`shareQuantum = 10^(18 − poolCollateralDecimals)`)

**Claim:** shares are 18-dec with a `shareQuantum` rounding rule.

**Tested:** `PoolLib.sol` preview math + `MathHelper`/`TransferHelper` scaling; fork
`deposit(100e18 sUSDe)` → shares; `previewSwap`/`previewUnwindSwap` at native-decimal boundaries.

**Observed — CONFIRMED (mechanism), rule restated precisely.** cPT and cST are **always 18-dec**;
CA/REF are native (≤18). Deposit mints cPT+cST 1:1 in 18-dec after normalizing CA via
`tokenNativeDecimalsToFixed` (fork: 100e18 sUSDe → 100e18 each). The quantum shows up as
**ceil on the way in, floor on the way out** at the native↔18-dec boundary
(`fixedToTokenNativeDecimalsWithCeilDiv` for amounts the user pays, plain floor for amounts the
user receives) — protocol-favouring. So "shareQuantum = 10^(18−collatDecimals)" is the granularity
of representable CA amounts, and the rounding direction is per-leg, not a single global rule. → RFC
`cork_compute` documents rounding direction per preview kind; parity CI asserts bit-exactness incl.
the ±1-wei artifacts (experiments/01 §2 pt 5).

## C5 — Limit-order venue = 1inch LOP v4

**Claim:** venue is 1inch LOP v4 at `0x111111125421cA6dc452d289314280a0f8842A65`; which
traits/invalidators matter; what the orderbook accepts.

**Tested:** `cork-indexing-api/src/modules/limit-orders/*`,
`covered-vault/app/packages/lob-orderbook/*`, `api-phoenix.cork.tech` OpenAPI `/docs/json` + live
`/v1/limit-orders/{markets,orderbook}` fetches (cork-public-hypersync.md, cork-contracts-domain.md §5).

**Observed — CONFIRMED.** Address exact; EIP-712 domain `{name:"1inch Aggregation Router",
version:"6", chainId, verifyingContract:LOP}`. Orders are the **bare canonical LOP v4 `Order`
struct** (salt, maker, receiver, makerAsset, takerAsset, makingAmount, takingAmount, makerTraits).
makerTraits bits that matter: expiry `(>>80)&MASK40`, nonce `(>>120)&MASK40`, series
`(>>160)&MASK40`, `NO_PARTIAL_FILLS` bit255, `ALLOW_MULTIPLE_FILLS` bit254, `HAS_EXTENSION`,
`USE_PERMIT2`; low-80 = allowedSender tail. Orderbook accepts a POST whose body is that struct +
Cork metadata (`side: BUY|SELL`, `premium` bps, `nonce`, `allowsPartialFills`, `chainId`,
`extension` default ""); server recomputes the EIP-712 hash and ecrecovers (EOA) or ERC-1271-checks
(contract). Live LOB markets currently on **Arbitrum (42161)**. `OrderFilled(bytes32,uint256)` has
**no indexed params** → log filters select on address+topic0. → RFC `cork_prepare_orders` builds
the LOP v4 struct + typed-data; `cork_submit` POSTs it.

## C6 — Dutch-auction order pricing

**Claim (brief):** "current Dutch-auction limit-order prices" are time-dependent computed state.

**Tested:** searched Cork LOB code + live order `extension` fields (all empty); owner confirmed
Dutch = **1inch Fusion**; researched `github.com/1inch/fusion-protocol` (research/fusion-dutch-auction.md).

**Observed — CORRECTED then RESOLVED.** Cork's *current* orders are fixed-price plain LOP v4 with
no extension — there is no Dutch auction in production today (D1). Per owner: Dutch auctions ride
1inch **Fusion**, which is LOP v4 + a Settlement extension whose `extension` field points at the
Settlement contract (current v3.1 `0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5`, mainnet+Arbitrum).
Auction price is a deterministic pure function of `(AuctionDetails, taker, baseFee, timestamp)`:
piecewise-linear rate bump (base `1e7 = 100%`), optional gas-linked bump component, nested
ceil-rounding; the LOP salt low-160 bits must equal `keccak256(extension) & (2^160−1)` when
makerTraits bit 249 is set (a free integrity check for decode). v2 vs v3 layouts differ (v3 adds a
points-count byte + fee section) — branch on the Settlement address at the head of
`makingAmountData`. `@1inch/fusion-sdk`'s `AuctionCalculator` is reusable prior art. → RFC
`cork_compute { kind: "dutch-auction-price" }` decodes the Fusion extension and computes locally;
detection is via the extension's Settlement address. Marked Phase 3 (rides limit-order lifecycle).

## C7 — Rate-limited impairment floor (worst case ≠ minRate) — HIGHEST-VALUE

**Claim:** the exercise/swap-rate impairment floor moves with time; worst case is NOT `minRate`.

**Tested:** `ConstraintRateAdapter.sol` `_calculateRate` quoted verbatim (cork-contracts-domain.md
§4.2); 9 green forge fork tests time-warping a live vnet pool through an oracle crash
(experiments/01 §2; experiments/fork-harness).

**Observed — CONFIRMED, mechanism fully characterized.** The limiter is a **token bucket in
absolute 1e18-rate units**: credits refill at `rateChangePerDayMax`/day since the last *actual*
rate change, capped at `rateChangeCapacityMax`; one adjustment moves the rate toward the (clamped)
oracle by at most the bucket, charging credits = actual movement; result clamped to
`[rateMin, rateMax]`. Key consequences, all observed on fork: (a) a single commit can spend the
whole accumulated bucket; (b) `previewAdjustedRate`/`swapRate` at horizon T can never show more
than one bucket (~one `capacityMax`) of movement; (c) the **true** reachable floor over horizon Δt
requires modelling repeated commits, and `constraints()` returns `remainingCredits` as of
`lastAdjustmentTimestamp` (not refilled to now) so the bucket is first advanced to the eval instant:
`avail = min(rateChangeCapacityMax, remainingCredits + rateChangePerDayMax·(tEval − lastAdjustmentTimestamp)/86400)`;
`worstRate(Δt) = max(rateMin, lastAdjustedRate − (avail + rateChangePerDayMax·Δt/86400))`
— verified by daily-commit descent reaching `rateMin` on day 64 of a synthetic crash, exactly
`perDayMax`/day after the first full-bucket move, with reproducible ±1-wei integer artifacts. Max
REF impairment per cST at horizon = `ceil(1e18 / worstRate(Δt))`. → RFC
`cork_compute { kind: "impairment-floor", horizon }` is a **local-only** projection (no on-chain
view returns it); parity CI compares the committed-descent path against time-warped fork
`eth_call`s. This is the single strongest justification for the local-math tier.

## C8 — Rollover order pricing

**Claim (brief):** rollover-order prices change over time.

**Tested:** `rollover-private/src/types/RolloverTypes.sol`; PR #161 (deploy surface); owner note.

**Observed — CORRECTED.** Rollover orders are **ERC-7683** (`CorkSettler/1.0.0` domain), not LOP.
Premium is a **fixed floor** `minPremiumPerShare` (raw premium-token units per 1e18 dstCST; settled
`ceil(dstCstProduced·minPremiumPerShare/1e18)`) — no on-chain decay/auction curve (D2). Time
enters a rollover's economics only through Phoenix itself (source-pool unwind time-decay fee → 0 at
expiry; constraint-rate drift). Deploy surface (PR #161, branch `feat/base-staging-deployer`):
fresh factory + exact/partial Settlers + 3600s trust timelock + modules, CREATE2-salted, Arbitrum
+ Base staging; Arbitrum mainnet deploy imminent per owner. → RFC scopes rollover to Phase 3+
`cork_prepare_orders { action: "rollover-*" }`; `cork_compute` exposes `rollover-premium-floor`
(fixed) not a time curve; marks the live-decay question OPEN (Q-ROLL).

## C9 — Phoenix query service (OpenAPI surface)

**Claim:** an OpenAPI document exists; enumerate routes, filters, pagination, auth; note defects.

**Tested:** fetched `https://api-phoenix.cork.tech/docs/json` and live routes (this session +
cork-public-hypersync.md); read `cork-indexing-api/src/db/schema.ts`.

**Observed — CONFIRMED (live, keyless).** Routes: `/v1/pools/`, `/v1/pools/whitelisted-addresses`,
`/v1/limit-orders/{,markets,orderbook,fills}` (+ POST), `/v1/flows/`. Filters incl.
`poolWhitelistStatus` (= on-chain `isMarketWhitelistEnabled`), `expiryBefore/After`, `poolId`,
`chainId`. Chains present: 1, 42161, 49222 ("virtual" Tenderly staging). Defect observed: the
`/pools/` list is not cursor-terminated in the sample (`total`/`nextCursor` null); pagination
contract is weakly specified → RFC's `cork_query` always emits its own
`{complete, pagesRead, cursor, ordering}` envelope and never trusts upstream completeness. No auth
on reads; POST limit-orders is signature-authenticated by the order itself (no API key). → RFC
Centralized mode = this API; RFC records the pagination defect as an enrichment/label note.

## C10 — Config / address sourcing & CREATE2 verifiability

**Claim:** addresses from GitHub config (`cork-defaults.json`, phoenix `config/prod.toml`), cached,
CREATE2-verifiable, never hardcoded.

**Tested:** fetched `Cork-Technology/phoenix config/prod.toml` + depeg-frontend `pre-prod`
`mainnet.config.ts`; reproduced the CorkAdapter address from Sourcify creation bytecode + prod.toml
salt (experiments, github-config-sources.md).

**Observed — CONFIRMED.** prod.toml carries per-chain `[mainnet.address]`/`[mainnet.bytes32]`
(salts) with distinct `expected_*` vs `deployed_*` keys; CREATE2 addresses are cross-chain identical
(Safe Singleton Factory `0x914d7Fec…43d7`). Verified: Sourcify `creationBytecode.onchainBytecode`
→ keccak → `cast create2 --deployer <factory> --salt <cork_adapter_salt>` reproduces
`0xCCcC…0407` exactly. ABIs: no npm `@cork-technology/phoenix` package exists (D5); ABIs come from
`phoenix-private/contracts/interfaces/*.sol` or Sourcify (all core contracts full-match verified,
keyless `GET sourcify.dev/server/v2/contract/1/<addr>?fields=abi`). `history_last_deployment_block =
24238826` is *last*, not first (Sourcify shows WhitelistManager @24134627) — backfills start at
24134627 (D3). → RFC `cork_config` fetches+caches prod.toml, offers `--verify` (CREATE2 + extcodehash
+ config↔frontend↔Sourcify triangulation), never hardcodes.

## C11 — MarketRegistry `deploy(ca, ref)` / `lookupWrapper` / `WRAPPER_FACTORY`

**Claim:** permissionless idempotent `deploy(ca, ref)`; `lookupWrapper`/`WRAPPER_FACTORY` behavior.

**Tested:** searched phoenix-private + rollover-private for a MarketRegistry with this surface;
checked prod.toml; owner said the market-registry-api is WIP ("re-ask later").

**Observed — OPEN (QUESTION Q-REG).** No `MarketRegistry.deploy(ca,ref)` /
`lookupWrapper`/`WRAPPER_FACTORY` found in the available Phoenix source, and no deployment in
prod.toml. Cork's `market-registry-api` (github.com/Cork-Technology/market-registry-api) is
in-progress per owner; expected to expose (a) list market-pair-eligible tokens, (b) query oracle for
a pair. → RFC scopes market deployment to **Phase 4**, `cork_prepare_market` schema stubbed against
the WIP registry, and lists Q-REG as a blocking Open Question (must confirm the registry's real
function surface before freezing the `deploy` variant).

## C12 — HyperSync (Full-Decentralized mode) practicalities

**Claim (requirements §R1):** embedded HyperSync for bulk historical market/order discovery.

**Tested:** Envio docs + `@envio-dev/hypersync-client` FAQ (cork-public-hypersync.md).

**Observed — CONFIRMED with caveats.** Mainnet endpoint `https://eth.hypersync.xyz`; **API token
required since 2025-11-03** (soft-centralization point for a "decentralized" mode — RFC flags it).
Node client 1.4.x is already napi-over-Rust — embedding the Rust crate in our own addon buys nothing
(use the Node client). No `eth_call`/state: live rate/whitelist point-reads stay on RPC even in
Full-Decentralized mode; HyperSync is backfill-only. Reorg handling via `archive_height`/`rollback_guard`;
`stream()` is not tip-safe (backfill then RPC-poll at tip). → RFC data-mode model: `indexer` mode =
HyperSync backfill + RPC live; token is user-supplied config; never silent-fallback to another mode
(D9: public RPCs reject archive `getLogs` without a token — Lite mode fails honestly).

## C13 — MCP tool-design findings still hold

**Claim (multipurpose-agentic-tool-design.md):** deferred loading 85% token cut + 49→74% selection;
3 examples 72→90% param accuracy; progressive disclosure 98.7% context cut; 10 mechanics.

**Tested:** re-checked against MCP spec (2025-06 + 2025-11-25) and Anthropic tool-writing / advanced-
tool-use posts during the prior schema-once research thread (notes/research/schema-once-mcp.md).

**Observed — CONFIRMED, current.** Spec 2025-11-25 mandates JSON-Schema-2020-12 default, snake_case
tool names (1–64 chars), validation-errors-as-tool-results (models self-correct), pagination +
listChanged. No server-side tool-search primitive exists — discovery is a client feature (native
Tool Search Tool), so `cork_capabilities` remains the right progressive-disclosure surface and no
bespoke keyword index is warranted. → RFC §Agent-Usability normatively adopts the 10 mechanics with
schema excerpts; the worked "specialized fetch" round-trip (§3 of the research) becomes the RFC's
canonical example.

---

## Open Questions surfaced (carried into RFC §Open Questions)

- **Q-REG** (C11): MarketRegistry real surface — `deploy(ca,ref)` idempotency, `lookupWrapper`,
  `WRAPPER_FACTORY` — pending `market-registry-api`. Blocks freezing `cork_prepare_market`.
- **Q-ROLL** (C8): is there an off-chain filler-auction (frontend re-posting stepped premiums) that
  motivated "rollover prices over time"? On-chain premium is a fixed floor.
- **Q-FUSION-LIVE** (C6): when does Cork ship Fusion orders to production, and on which chains? The
  decode/price path is spec'd but no live Fusion order was observable.
- **Q-CHAIN** (C5/C9): canonical production chain for limit orders — mainnet vs Arbitrum vs the
  49222 staging vnet — governs default `chainId` and which markets the CLI shows by default.
- **Q-WITHDRAW** (D8/QUESTION-6): `withdraw` NatSpec says pre-expiry but code path is post-expiry;
  confirm intended semantics before labeling the enrichment.

---

## C14 — Implementation parity (Phase-1 core, 2026-07-16)

**Claim:** the TS core reproduces on-chain Cork math bit-exactly; bundle bytes match the wire.

**Tested:** `packages/*` monorepo. Golden vectors derived *independently* of the TS impl —
Foundry unit-test literals (`computeT`, `calculateTimeDecayFee`), Python integer arithmetic
(`_calculateRate` refill + committed-descent floor), `cast`/foundry (`MarketId` keccak, CREATE2,
CorkAdapter action + Bundler3 `multicall` byte-parity). Live fork-parity vs the vnet fixture pool
`0xceebea…c16a` (reads pinned to one block).

**Observed — CONFIRMED.** All 60 offline unit vectors pass; fork-parity reproduces on-chain
`swapRate`, `previewSwap`, `previewUnwindSwap`, and `MarketId` **wei-for-wei** across multiple
amounts, and the full `runTool(cork_compute cst-swap-rate)` handler stack matches on-chain
`previewSwap` exactly. This closes the 03-vnet-fixture flag that unwind time-decay "needs exact
porting" — it now matches to the wei. The committed-descent impairment floor is `≤` a brute-force
adversary simulation across a 5-point horizon matrix (conservative-safe; never optimistic). Bundler3
`Call` struct + `multicall`/`reenter` signatures re-verified against the deployed contract via
Sourcify (`0x6566…0245`), matching the memory note. `A()` discriminated-union helper + hex-typed
primitives (`Address`/`Hex`/`Bytes32` → `` `0x${string}` ``) tightened so schema outputs feed
viem/core directly.
