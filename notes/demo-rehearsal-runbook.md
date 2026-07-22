# Demo rehearsal runbook — JIT market creation end-to-end (Arbitrum One)

Goal: walk the Jul 28 demo flow once with real funds BEFORE the demo, so the demo is a replay.
Everything below is live TODAY (roles granted, registry populated, adapter verified). The tool
never holds keys [K1]: steps marked **SIGN** are yours.

Prereqs: a throwaway maker account funded with a small amount of sUSDe
(`0x211C…5E5d2`) + ETH for gas; a taker account (can be the same wallet for rehearsal) with the
counter-asset; `ch` on PATH (or the MCP tools — same core).

## 1. Discovery (agent-visible reads)

```sh
ch query --json '{"chainId":42161,"resource":"registry-assets"}'
ch query --json '{"chainId":42161,"resource":"registry-recipes"}'
ch query --json '{"chainId":42161,"resource":"registry-oracle","filters":{"collateralAsset":"<CA>","referenceAsset":"<REF>"}}'
ch compute --json '{"chainId":42161,"params":{"kind":"resolve-recipe","mode":"liquidity","collateralAsset":"<CA>","referenceAsset":"<REF>"}}'
```

Expect: 4 assets, modes `liquidity`/`fixed`, the pair's oracle (sUSDe/waArbUSDCn already
deployed at `0x2BA2…d757`), and parity-verified resolved constraints at the live rate.

## 2. Prepare the JIT maker order

```sh
ch prepare orders --json '{"chainId":42161,"account":"<MAKER>","clientRequestId":"demo-jit-0001","action":{
  "type":"maker-order","poolId":"0x…(any placeholder)","side":"SELL",
  "makerAsset":"<PREDICTED_CST — see below>","takerAsset":"<REF>",
  "makingAmount":"<cST amount>","takingAmount":"<price>","expirySeconds":86400,
  "jitMarket":{"collateralAsset":"<CA>","referenceAsset":"<REF>","expiryTimestamp":"<unix>","mode":"liquidity","enableJitMint":true}}}'
```

First run: use any makerAsset — the result's `jit.predictedCst` + `jit_side_mismatch` warning
tell you the REAL cST address. Re-run with `makerAsset` = that address until the warnings are
only `rate_drift_notice`. The result also carries `jit.derivedPoolId`, resolved constraints,
and the permit guidance.

## 3. **SIGN** (maker)

- The order typed-data (`typedData` in the result) — EIP-712, 1inch LOP v4 domain.
- For a NEW pool: an ERC-2612 permit over `jit.predictedCst` (owner = maker, spender = the LOP
  `0x1111…2A65`, value ≥ makingAmount) — pass it in `jitMarket.permits` and re-prepare, OR have
  the taker submit it with the fill. A fresh cST has no prior allowance; without the permit the
  LOP's pull reverts.

## 4. Fill (taker) — this is the market-creation moment

The taker calls LOP `fillOrderArgs(order, r, vs, amount, takerTraits, args)` with the extension
bytes from the prepare result (the taker MUST pass the extension verbatim — the salt commits to
it). Via cast, a taker bot, or Gio's agent. Rate-drift note: fill soon after signing; if the
oracle rate steps, the fill reverts `OrderNotForPool` by design — re-prepare and re-sign.

## 5. Verify what happened

```sh
ch track --json '{"chainId":42161,"mode":"reconcile","subject":{"kind":"txHash","txHash":"<fill tx>"}}'
# → corkEvents: JITMarketCreated + JITMinted labeled in the receipt
ch query --json '{"chainId":42161,"resource":"market","filters":{"poolId":"<jit.derivedPoolId>"}}'
ch query --json '{"chainId":42161,"resource":"account-state","filters":{"poolId":"<derivedPoolId>","account":"<MAKER>"}}'
```

## Safety rails available at every step

- `ch track --json '{"mode":"simulate","chainId":42161,"subject":{"kind":"artifact","artifact":{"to":"<to>","data":"<bytes>","from":"<acct>"}}}'`
  — eth_call dry-run of any prepared tx (wouldRevert + reason) BEFORE signing.
- All prepare pre-flights re-verify the volatile adapter bindings + roles on-chain per call.
- If anything returns `unavailable`/`conflict`, read `warnings[0]` — it names the fix.

## Known gaps for the rehearsal

- The FILL itself cannot be fully simulated by the tool (it is the taker's tx through the LOP
  with taker-side args); the pre-flights + simulate cover everything up to it.
- Venue relay (`cork_submit lop-order`) is optional for this flow — a direct on-chain fill
  needs no venue. Use the venue path only if the demo wants the orderbook visible.
