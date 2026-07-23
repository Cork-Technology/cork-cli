# Arbitrum-mainnet E2E readiness — JIT order round-trip

Written 2026-07-23 after the first live end-to-end round-trip on an Arbitrum fork
(`experiments/fork-harness/test/JitOrderRoundTrip.t.sol`). This records what is proven,
what the fork does NOT cover, and exactly what is needed to run the same on Arbitrum One.

## Blockers verified CLEARED

- **(a) A pool on the new Arbitrum PM (Zian/Filip).** The new PoolManager
  `0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2` has 5 live pools (sUSDe-waArbUSDT), all read
  successfully on-chain; and the JIT path creates new ones on the fill. Roles/bindings verified
  granted. Whitelist is disabled on these pools, so an arbitrary taker can fill.
- **(b) The venue accepting a signed order post (Raouf).** `api-phoenix.cork.tech` orderbook
  serves 23 Arbitrum orders (10 OPEN, 3 FILLED, real makers); the fills feed returns 9 fills.
  The venue is live and accepting/serving posted LOP orders.

## What the fork run PROVED (prepare → sign → fill → verify)

1. `ch prepare orders` (JIT block) → maker order + extension + predicted cST + derived poolId.
2. Maker signs the EIP-712 order (throwaway key) + the ERC-2612 permit over the predicted cST.
3. Taker fills through the real 1inch LOP v4 → the fill's preInteraction runs the Cork adapter,
   which deploys pool shares, pulls the maker's collateral, deposits, and mints the cST.
4. `ch track reconcile <txHash>` labels **JITMarketCreated + JITMinted** at the derived poolId;
   `ch query market` confirms the pool exists with the predicted cST.
   The tool's predicted cST address, poolId, and resolved constraints matched on-chain wei-for-wei.

A real bug was found and fixed en route: the JIT order set `HAS_EXTENSION_FLAG` but not
`PRE_INTERACTION_CALL_FLAG`, so the hook never ran and the fill was a silent no-op. Fixed in
`packages/core/src/orders.ts` (`extensionInteractionFlags`), regression-tested.

## Ground-truth facts the fork surfaced (apply identically on mainnet)

- **Fill selector = `0xf497df75`.** 1inch v6 declares `Order` with the `Address is uint256`
  custom value type, so the canonical `fillOrderArgs` uses uint256 fields, not `address`
  (`0x5d9dbf53`). Same calldata, different selector — the address-typed variant hits the router
  fallback and reverts at dispatch. **The taker integration MUST use the uint256 signature.**
- **The router (`0x1111…2A65`, Aggregation Router V6) does not expose `hashOrder()` /
  `DOMAIN_SEPARATOR()`** as external getters. The tool computes `orderHash` off-chain against the
  router's `eip712Domain` (name "1inch Aggregation Router", version "6"); the fill confirms parity.
- **Fill gas ≈ 5.3M** for a JIT-creating fill (deploy shares + deposit + mint). Trivial cost on
  Arbitrum; well within block limits.
- **Rate-drift window is wide.** The derived poolId held stable across ~230k Arbitrum blocks
  (~16h) — the sUSDe/waArbUSDT oracle moves slowly. Fill-after-sign has comfortable slack, but the
  `rate_drift_notice` guard is real: if the oracle steps between sign and fill, the derived poolId
  changes and the fill reverts `OrderNotForPool` — re-prepare + re-sign.

## What the fork does NOT cover (must be handled for real Arbitrum)

1. **Funded wallets.** A maker with real sUSDe (collateral for the JIT mint) + ETH for gas, and a
   taker with the takerAsset + gas. The fork uses a whale transfer + impersonation; mainnet needs
   real balances. This is the funded-rehearsal-wallet dependency (target Jul 24–25).
2. **Maker collateral approval OR permit.** The adapter pulls the maker's collateral during the
   preInteraction, so the maker must approve the adapter for the collateral asset (an ERC-20
   approve tx), OR route it through a permit. The cST permit (spender = LOP) is already handled via
   `jitMarket.permits`; the COLLATERAL approval to the adapter is a separate, currently-manual step.
   → Consider a prepare-side funding leg / guidance for the collateral approval (today the runbook
   assumes it is done out-of-band).
3. **The taker fill is out of the tool's scope by design.** Our tool builds the maker order; the
   taker constructs `fillOrderArgs(0xf497df75)` with the extension passed verbatim and
   `takerTraits = MAKER_AMOUNT_FLAG | (extLen << 224)`. Whoever fills (Gio's agent, a bot, or a
   cast script) needs this recipe. The fork test is the reference implementation.
4. **Signing.** The tool never signs [K1]. On mainnet the maker key is the user's / Gio's kernel
   (CallerOwnedSigner, "limit-order" purpose → MAIN key). Rehearsal used a throwaway key.
5. **Optional venue path.** For orderbook visibility, post the signed order via
   `cork_submit lop-order` (verified the venue accepts posts). A direct bilateral fill needs no
   venue. The demo can do either; the venue path makes the order discoverable to arbitrary takers.

## Minimal mainnet runbook delta (vs the fork test)

- Fund maker (sUSDe + ETH) and taker (takerAsset + ETH) — real balances.
- Maker: `approve(collateralAsset, adapter, ≥ makingAmount-worth of collateral)` once.
- `ch prepare orders` (JIT) → sign order + cST permit → (optional `ch submit lop-order`).
- Taker fills within the drift window using selector `0xf497df75` + the extension.
- `ch track reconcile <txHash>` → expect JITMarketCreated + JITMinted; `ch query market` to confirm.

Nothing here is a code blocker on our side — the tool surface is ready. The remaining items are
operational (funded wallets, the maker's collateral approval step, and the taker-fill integration
owning the correct selector).
