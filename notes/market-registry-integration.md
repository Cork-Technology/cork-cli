# MarketRegistry + JIT adapter integration (2026-07-22)

Source of truth: `Cork-Technology/market-registry-api` @ `895748ca` (INTEGRATOR.md, README,
contract sources) + live Arbitrum One state. Closes **Q-REG** (RFC 011 §15): the MarketRegistry
surface is now verified and consumed.

## The purpose model (why this exists — Zian's vertical)

**Governed market creation.** The MarketRegistry is an owner-curated approval record (assets,
conversion feeds, constraint recipes; one curator Safe per chain, populated through an
evidence-based onboarding pipeline in the same repo). The `CorkLimitOrderAdapter` is the
**permissionless-but-bounded** creation entrypoint: a 1inch LOP v4 fill carrying the adapter hook
derives a market from a curated recipe against the LIVE oracle rate, creates the pool if missing,
and optionally JIT-mints the cST inside the fill. Agents "creating markets" can only ever create
markets whose ingredients governance pre-approved. `rfcs/agent-rfq-venue-interface.md` supplies
the upstream: RFQs negotiate a market as a *template referencing a recipe*, and the implied
oracle address + MarketId must be computable before deployment — which `deriveJitMarket` does.

## Empirical findings (all verified on-chain 2026-07-22)

- **Both INTEGRATOR.md and README say "the adapter is not usable yet" (roles ungranted). STALE:**
  `hasRole` on the controller returns TRUE for both `POOL_CREATOR_ROLE` and `CONFIGURATOR_ROLE`
  on the adapter — the fill path is live. (Flagged to Zian/Filip.)
- Adapter immutables bind to OUR promoted deployment: `POOL_MANAGER()` = `0x4d0a…23d2`,
  `CONTROLLER()` = `0xdCC0…6172`, `LIMIT_ORDER_PROTOCOL()` = the LOP v4 we already sign against,
  `MARKET_REGISTRY()` = `0xF674…600A`.
- Live registry content: recipes `liquidity` (min 99% / max 100% / day 100% / cap 100%) and
  `fixed`; 4 assets (sUSDe + 3 Aave wrapped); the sUSDe/waArbUSDCn oracle already deployed at
  `0x2BA2…d757` reading rate ≈ 0.8063.
- `applyBands` port proven bit-exact against the chain at the live rate (the resolve-recipe
  handler self-checks parity on EVERY call and returns `conflict` on divergence).
- `eth_simulateV1` works on public Arbitrum RPCs → the not-yet-created pool's cST address is
  predicted by simulating `controller.createNewPool` (from: the adapter, which holds the role)
  then reading `shares(poolId)` — no CREATE2 reimplementation needed.
- The maker-side hook rides the ORDER EXTENSION (ExtensionLib field 6 = preInteractionData =
  adapter ++ `abi.encode(JITMarketParams, PermitParams[])`), so it is maker-signed and
  salt-committed; the taker-side hook is a fill-time argument and is NOT part of the signable
  order (out of prepare's scope by construction).

## What was built

- `cork_query`: `registry-assets`, `registry-oracle` (deployed/deployable/why-not via simulated
  deploy), `registry-recipes` — chain views, 42161 (Base pending owner check).
- `cork_compute resolve-recipe`: bands→absolute resolution, caller rate or live oracle rate,
  chain-parity-checked. (The band math `rfq-quote` will need; rfq-quote's pricing model stays
  gated — that part is Rob/Raouf territory.)
- `cork_prepare_market deploy-wrapper`: unsigned idempotent `registry.deploy(ca, ref)` tx —
  the opt-out path for users who want the oracle ahead of any order. **Q-REG closed.**
- `cork_prepare_orders maker-order.jitMarket`: builds the adapter extension; pre-flights
  (best-effort, every gap disclosed): adapter binding re-verification (volatile address),
  both role grants, recipe existence (exact-string teaching), oracle deployability, live-rate
  market derivation (poolId + resolved constraints), predicted cST + order-side match
  (`jit_side_mismatch` when a fill would revert `OrderNotForPool`), ERC-2612 permit guidance.
  Omit `jitMarket` → byte-identical plain maker order (the user fallback).
- `cork_track` reconcile txHash: labels `JITMarketCreated`/`JITMinted` (+ settler events) in
  receipts.

## Deliberately out of scope

- The curation/onboarding tooling (propose-asset/triage/registry-sync, Safe flows) — curator
  territory, not integrator surface.
- The read HTTP API as a `centralized` mode — only a degraded sandbox exists; revisit when a
  real deployment lands (per owner: don't wait for it).
- Base (8453) registry reads — registry is live there, adapter is not; pending owner check.
- Taker-side JIT (`takerInteraction`) — a fill-time argument, not a signable artifact.

## Volatility notes

The adapter is expected to be redeployed (split deploy scripts exist for exactly that) and the
roles may be split later — hence config marks it volatile and every JIT prepare re-verifies
bindings + roles on-chain (`adapter_binding_mismatch` conflict / `roles_not_granted` warning).
