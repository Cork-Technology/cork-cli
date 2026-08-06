# Cork × Zyfai — Integration Quick Start

**Audience:** the Zyfai engineering team. **Assumes:** fluency with Safe/ERC-7579, 1inch LOP v4,
EIP-712/ERC-1271, ERC-2612 permits, ERC-4626/7540, CREATE2. **Chain:** Arbitrum One (42161).
**Status:** as of 2026-08-06, against the redeployed MarketRegistry 2.1.0 stack. Addresses/rates
below were read live from chain; still, **treat this doc as orientation and pull the authoritative
values from the tool** (`ch query protocol-config`), never hardcode them.

This is a two-part handoff: (1) a compact model of what Cork gives you and where your agent plugs
in, and (2) `cork-mcp-cli` — a read/derive/build/simulate helper you can drive from an MCP client or
the shell to make every step concrete without signing or custodying anything.

---

## 1. What Cork is

Cork is middleware for **tokenized, tradeable downside cover**. A Cork *market* tokenizes one covered
position into two ERC-20 legs:

| Term | Meaning | Who holds it |
|---|---|---|
| **REF** | the asset your user is exposed to and wants cover on. The live RFQ flow currently covers **dUSDC**; the registry lists 11 approved assets — read the list, don't assume | the user |
| **CA** | the liquid collateral asset paid out on cover (pilot: **sUSDe**, `0x211Cc4DD…5fE5d2`, 18 dec) | pool |
| **cST** | the cover / "swap" token — right to swap REF→CA at the market's tracked rate before expiry | **Zyfai (demand)** |
| **cPT** | the principal token — the underwriter's leg + premium | **bond.credit (supply)** |

The market itself is **identified by the keccak of its `Market` struct** (`poolId`), so it is fully
**derivable off-chain before it exists**. Markets are **short-dated (you pick the term)**, and the
rate rules come from a **recipe** — since 2.1.0 a recipe is an approved *contract*, not a mode
string. Two are live: **fixed** (rate pinned forever — simplest cover) and **liquidity** (rate
follows the oracle inside wide speed limits — what the live RFQ flow uses today, mode
`liquidity_only`).

**You are the demand side:** you buy cST cover on a position your yield agent manages, and you
**exercise** it on impairment. bond.credit ("Bond" below) is the supply side; it prices and sells
the cover and holds cPT. Settlement is atomic on **1inch LOP v4** with **just-in-time (JIT)
minting** of cST/cPT inside the fill — no pre-funded inventory.

---

## 2. The flow end-to-end, and the tool at each step

Four steps, demand-side view. Every step has a `ch …` command that returns **unsigned** artifacts or
plain reads — you sign/broadcast with your own stack.

| # | Step | What happens | Tool |
|---|---|---|---|
| 1 | **Zyfai selects the asset and submits an RFQ** (off-chain — CLI/MCP only) | Pick REF + CA + recipe + term from the registry, derive the market it names, then open a request-for-quote on the venue | `ch query` → `registry-assets` / `registry-recipes` / `market-predict`; `ch submit` → `rfq-open`; watch with `ch query` → `rfqs` |
| 2 | **Bond mints cST and creates a limit order (to sell)** | Bond answers your RFQ with priced options, then rests a signed SELL order (makerAsset = cST, takerAsset = CA). The cST usually doesn't exist yet — the order carries the market's recipe + constraint, and the mint happens inside the fill | Bond's side. You watch: `ch query` → `rfqs` / `orderbook`; inspect what a fill commits to with `ch decode` → `order` |
| 3 | **Zyfai buys Bond's cST** (by filling Bond's limit order) | Verify the order/market, simulate, then fill on the LOP; the adapter JIT-creates the market (if new) and JIT-mints cST to you, pulling the CA premium from you — **atomic** | `ch query` → `market`; `ch prepare orders` → `taker-fill`; `ch track` → `simulate` |
| 4 | **Zyfai exercises the cST**, swapping an impaired REF asset for a stable CA asset | Hand in cST + REF, receive CA at the market's rate — a **direct** Phoenix call, *not* an LOP fill | `ch prepare phoenix` → `exercise` / `exercise-other` |

Before step 1, one piece of one-time prep per CA/REF pair: the pair's rate oracle
(`ch prepare market` → `deploy-wrapper` — permissionless and **idempotent**; a JIT fill will also
deploy it itself if missing). After step 4 (or instead of it, near expiry): **rollover** — see
"After the flow" below.

Implementation notes:
- **`taker-fill` picks the right fill flavor for you** — `fillOrderArgs` (EOA maker) vs
  `fillContractOrderArgs` (Safe/ERC-1271 maker). Guessing wrong reverts `BadSignature`.
- **Market identity is pinned at signing (2.1.0).** The order *carries* its resolved rate constraint,
  so the `poolId` and cST/cPT addresses are fixed the moment the order is signed — they no longer
  drift with the oracle. Staleness is guarded at fill time instead: if the live rate has left the
  carried constraint's window, the fill reverts `RecipeRejectedConstraint` until a fresh constraint
  is signed.
- **One live footgun: resting orders can die by shares-address races.** A not-yet-created market's
  cST address is predicted from a deployer nonce, and every *successful* JIT fill (of anyone's
  order) consumes nonces — which can invalidate other resting orders' predictions. Filling a dead
  row reverts `OrderNotForPool`. The tool's pre-flight diagnoses this before you sign
  (`jit_side_mismatch` + `stale_share_prediction`, naming the pool that consumed the address) — if
  you see either warning, pick a fresher order.
- **Redeem is a supply-side action.** You hold cST only; your terminal move is **exercise**, never
  redeem. An unexercised cST is worthless after expiry.

---

## 3. The flow, step by step

One full cover cycle end to end. Every step has a real `ch` command you can run as-is, followed by a
trimmed real response (read live 2026-08-06) and a short note on what to check. Each command returns
**unsigned** artifacts or plain reads — you sign with your own Safe stack.

**A few conventions for every command below:**
- Replace **`0xYOUR_SAFE`** with the user smart account (Safe) you're driving.
- Steps 3–4 reuse one market's `poolId` and `cST` address. The values shown are the live
  **sUSDe / dUSDC** market derived in step 1c — that market doesn't exist yet, so run the derivation
  yourself and paste *your* output. Everything else (asset addresses, `chainId`) is real and
  runnable today.
- Passing input via **`--json`** is what makes `ch` emit JSON (already indented — the `| jq .`
  pipes are cosmetic; drop them if you don't have `jq`). A bare command without `--json` prints a
  human-readable prose rendering instead.

The pair used throughout, for reference:

| Role | Asset | Address | Decimals |
|---|---|---|---|
| **REF** — what the user is exposed to and covers | dUSDC | `0x444868B6e8079ac2c55eea115250f92C2b2c4D14` | 6 |
| **CA** — what the user is paid out in on exercise | sUSDe | `0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2` | 18 |

Your user holds **cST** (the cover); Bond holds **cPT** (the underwriter's leg). In the tool, CA is
`collateralAsset` and REF is `referenceAsset`.

---

### Step 1 — Zyfai selects the asset and submits an RFQ (off-chain — only available via CLI or MCP)

This step is entirely off-chain: choosing what to cover, deriving the market those choices name, and
asking the supply side to price it. There is no UI for RFQs — the CLI/MCP is the way in.

#### 1a. Pick the REF asset to cover

List the assets the registry approves. Each entry self-describes its price/NAV sources and token
metadata:

```sh
ch query --json '{"resource":"registry-assets","chainId":42161}' | jq .
```
```jsonc
{ "state": "ok", "data": {
  "registry": "0x47C3AF38435Db64D9400c30575E4c10482c0752D", "contractsVersion": "2.1.0",
  "count": 11, "items": [
    { "address": "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", "name": "sUSDe",
      "priceSource": { "sourceType": "PRICE", "sourceInterface": "AGGREGATOR_V3", "denomination": "USD" },
      "token": { "decimals": 18, "symbol": "sUSDe" } },
    { "address": "0x444868B6e8079ac2c55eea115250f92C2b2c4D14", "name": "dUSDC",
      "token": { "decimals": 6, "symbol": "dUSDC" } }
    // …11 total: sUSDS, weETH, wstETH, dWETH, fUSDT, USDACM, fWETH, arbUSD, sUSDai, …
] } }
```
Pick an asset your users actually hold. This walkthrough uses **dUSDC** — the pair the live RFQ flow
covers today. (If an asset isn't on this list it isn't coverable yet — registering it is a Cork-side
step.)

#### 1b. Pick the cover template (recipe)

The recipe sets how the market's rate may move, which is what defines the cover. Since 2.1.0 a
recipe is an **approved contract address** that self-reports its rules:

```sh
ch query --json '{"resource":"registry-recipes","chainId":42161}' | jq .
```
```jsonc
{ "state": "ok", "data": { "contractsVersion": "2.1.0", "count": 2, "items": [
  { "address": "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D", "source": "price",
    "description": "Liquidity: the widest rate window CorkPoolManager will accept. rateMin is 1 wei always, rateMax is twice the anchor rate, rateChangePerDayMax is the whole anchor rate…" },
  { "address": "0xA85cFa6E66f301a18D182A8304f5C4afEf5b4682", "source": "fixed",
    "description": "Fixed rate: the market's rate is whatever immutable FixedRateOracle the order names, and it can never move.…" }
] } }
```
- **liquidity** (`0xA39d…1234D`) — the rate follows the price oracle, but only inside wide speed
  limits. **This is what the live RFQ flow uses** (RFQ mode `liquidity_only`).
- **fixed** (`0xA85c…4682`) — the rate is pinned at creation and can never move. Simplest cover.

To see the exact rate limits a recipe would impose on your pair (the same math a fill runs, checked
bit-for-bit against chain): `ch compute` → `resolve-recipe` with the recipe address.

#### 1c. Pick the CA and the term, then derive the market

The CA is what your user receives on exercise — the pilot uses **sUSDe**. With CA + REF + recipe +
expiry chosen, you've named a market. Derive exactly what a fill would create — its `poolId`,
cST/cPT addresses, oracle, and resolved constraint — before anything exists on-chain:

```sh
EXP=$(date -u -d '+7 days' +%s)
ch query --json "{\"resource\":\"market-predict\",\"chainId\":42161,\"filters\":{\"collateralAsset\":\"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2\",\"referenceAsset\":\"0x444868B6e8079ac2c55eea115250f92C2b2c4D14\",\"expiry\":\"$EXP\",\"recipe\":\"0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D\"}}" | jq .
```
```jsonc
{ "state": "ok", "data": {
  "recipe": "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D", "source": "price",
  "oracle": { "address": "0x0DF21ad4Ce3F27Aac74b977e58E0943D8B3aC033", "deployed": true, "rate": "1025550232537882433" },
  "market": { "poolId": "0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78",
              "exists": false,
              "constraint": { "rateMin": "1", "rateMax": "2051100465075764866",
                              "rateChangePerDayMax": "1025550232537882433", "rateChangeCapacityMax": "3076650697613647299" } },
  "shares": { "corkSwapToken": "0x281B9C4C879a784f141b99c86678e2d9A5f45Cf6",
              "corkPrincipalToken": "0xaf9871E0859b54151465D7D0acdEA8d77Ac7e5B5", "source": "simulated" } },
  "warnings": [ { "code": "rate_drift_notice",
    "message": "…an order that CARRIES this constraint fixes the pool id and share addresses at signing — sign, and this identity holds however far the rate moves…" } ] }
```
What to check:
- **`oracle.deployed`** — if `false` the prediction still works (the fill deploys it itself), but you
  can pre-deploy with `ch prepare market` → `deploy-wrapper` (permissionless, idempotent).
- **`market.exists`** — `false` means the first fill creates the market; `true` means it's live.
- **`corkSwapToken`** is the **cST** you'll buy; **`corkPrincipalToken`** is the cPT.
- **`constraint`** — the four rate limits. These are literally what gets embedded in a signed order;
  once an order carrying them is signed, the market identity is **pinned** and no longer drifts.
- Until something is signed, the prediction is conditioned on *today's* oracle rate — so derive,
  quote, and sign close together.

The steps below use this market: `poolId` =
`0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78`, `cST` =
`0x281B9C4C879a784f141b99c86678e2d9A5f45Cf6`.

#### 1d. Open the RFQ

Now ask the supply side to price the cover. An RFQ is an off-chain venue posting: the parameter
envelope (pair, mode, size, acceptable expiry window) that underwriters answer against.

```sh
VU=$(date -u -d '+1 hour' +%s)
ch submit --json "{\"chainId\":42161,\"clientRequestId\":\"rfq-0001\",\"action\":{\"type\":\"rfq-open\",\"requester\":\"0xYOUR_SAFE\",\"referenceAsset\":\"0x444868B6e8079ac2c55eea115250f92C2b2c4D14\",\"collateralAsset\":{\"exact\":\"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2\"},\"modes\":[\"liquidity_only\"],\"packageIds\":[\"balanced-v1\"],\"expiryWindow\":{\"notBefore\":$((EXP-1)),\"notAfter\":$EXP},\"marketTemplate\":{\"inline\":{\"oracle_recipe\":\"0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D\"}},\"notionalAssets\":\"…\",\"validUntil\":$VU,\"signature\":\"0x…\"}}" | jq .
```
Conventions the live flow uses (all visible in today's open RFQs):
- **`modes: ["liquidity_only"]`** and **`packageIds: ["balanced-v1"]`** — the live package. Confirm
  the package catalog and the `notionalAssets` units with your Cork contact before your first post.
- **Pin an exact expiry** by setting `notBefore = notAfter - 1` (live RFQs do exactly this).
- **`marketTemplate.inline.oracle_recipe` carries the recipe's contract address** — this field is
  the bridge from quote to order, so both sides must put the address here for the quote to be
  executable.
- The RFQ is signed by the requester per your own stack; `ch submit` relays, it never signs.

Then watch for answers — this is also how you'd browse what others are asking:

```sh
ch query --json '{"resource":"rfqs","chainId":42161}' | jq .                       # all open RFQs (17 open right now)
ch query --json '{"resource":"rfqs","chainId":42161,"filters":{"rfqId":"rfq_…"}}'  # one RFQ with all its answers
```

---

### Step 2 — Bond mints cST and creates a limit order (to sell)

This step is Bond's, not yours — but you can watch every part of it, and you should verify the
result before buying. Bond answers your RFQ with priced options; here's a real answer from today's
book (RFQ `rfq_kzbbztw3mfyws9zz3335m8cw`, dUSDC/sUSDe, liquidity_only):

```jsonc
{ "status": "quoted", "options": [ {
  "option_id": "e7dda7c5-…-liquidity_only-1786021200",
  "mode": "liquidity_only", "package_id": "balanced-v1",
  "market_template": { "inline": { "oracle_recipe": "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D" } },
  "reference_asset": "0x444868b6…c4d14", "collateral_asset": "0x211cc4dd…5fe5d2",
  "premium_annualized": "0.032",       // fractions in RFQ land: 0.032 = 3.2% — listings use percent instead
  "fresh_until": 1786014948
} ] }
```

Bond then rests a signed **SELL** limit order on the venue book executing that quote: `makerAsset` =
the cST, `takerAsset` = CA (your premium). Plain-English note on "mints": the cST usually does
**not** exist yet when the order is posted. Bond's signed order *carries* the market's recipe and
constraint (which is what pins the cST address, step 1c), and the actual mint happens **inside your
fill**, just-in-time — Bond's collateral funds it. So "Bond mints cST and sells it" is what you
experience economically; mechanically the mint and your purchase are one atomic transaction.

Find the resting order for your market, and inspect exactly what a fill of it would do before you
commit — `decode order` unpacks the adapter, recipe, carried constraint, and permits from the
order's own bytes:

```sh
ch query --json '{"resource":"orderbook","chainId":42161,"filters":{"poolId":"0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78"}}' | jq .
```
```jsonc
{ "items": [ {   // a live SELL row from today's book, trimmed
  "orderHash": "0x9cf3b9c9a331518beb88a417fa3075a66c78775ede1d4afafc17f13dadf2df05",
  "side": "SELL", "status": "OPEN",
  "makerAsset": "0xca46bd3c576b1d7585fc1f8fa343936dd8834e79",  // a cST
  "takerAsset": "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",  // sUSDe (CA)
  "remainingMakingAmount": "100000000000000"
} ] }
```
(This row is live today for the same dUSDC/sUSDe pair — it executes the RFQ answer shown above.
Its pinned expiry differs from our 7-day example derivation, so its `poolId` differs too; query
with *your* poolId from step 1c.)

The venue row carries the order's own struct fields (`salt`/`maker`/…/`extension`) verbatim — pass
them straight to the decoder:

```sh
ch decode --json '{"kind":"order","chainId":42161,"data":{…the signed order row…}}' | jq .
```
```jsonc
{ "state": "ok", "data": { "jit": {          // decoded live from the row above
  "generation": "2.1.0", "adapter": "0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B",
  "collateralAsset": "0x211Cc4DD…5fE5d2", "referenceAsset": "0x444868B6…2c4D14",
  "recipe": "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D",
  "constraint": { "rateMin": "1", "rateMax": "2051135217108776914", /* … */ },
  "enableJitMint": true, "permits": 1 } } }  // ← the fill WILL mint the cST just-in-time
```
If step 1c showed `exists: false`, there may be no orders yet — you're the first mover, and Bond's
SELL is the order whose first fill creates the market.

---

### Step 3 — Zyfai buys Bond's cST (by filling Bond's limit order)

Your users are ERC-1271 smart accounts, so fills use `fillContractOrderArgs` — the tool selects that
for you. Three commands: re-verify, build, dry-run.

```sh
# 1. re-verify the market on-chain (the book is discovery only)
ch query --json '{"resource":"market","chainId":42161,"filters":{"poolId":"0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78"}}' | jq .

# 2. build the unsigned fill (use an OPEN orderHash from step 2; replace 0xYOUR_SAFE)
ch prepare orders --json '{"chainId":42161,"account":"0xYOUR_SAFE","clientRequestId":"buy-0001","action":{"type":"taker-fill","orderHash":"0x9cf3b9c9a331518beb88a417fa3075a66c78775ede1d4afafc17f13dadf2df05","fillMakingAmount":"100000000000000"}}' | jq .

# 3. dry-run: does it revert at current state? (paste the artifact object from step 2's output)
ch track --json '{"mode":"simulate","chainId":42161,"subject":{"kind":"artifact","artifact":{…}}}' | jq .
```
Then **sign the calldata with your own Safe stack and broadcast.** The fill is atomic: the adapter
creates the market if it's new and mints the cST to your Safe, pulling the CA premium from you in
the same transaction. What to check:
- Expect an `unsigned_artifact` warning on the prepare (it's calldata only) and require
  `wouldRevert: false` from the simulate. The result's `data.execution` block names the exact
  completion path (sign → decode-verify → broadcast → reconcile); `ch capabilities --json
  '{"topic":"signing"}'` is the full reference.
- **If the prepare warns `jit_side_mismatch` / `stale_share_prediction`, stop** — that resting order
  is dead (its predicted cST address was consumed by another market's creation; the warning names
  the consuming pool). Pick a fresher order; filling it would revert `OrderNotForPool`.
- Before broadcasting: set the CA allowance (§5, item C) and pin the fill target to the Safe
  (§5, item A).

> **Variation — resting your own BUY order instead.** You can invert the trade: post a signed BUY
> (makerAsset = CA, takerAsset = the predicted cST) with `ch prepare orders` → `maker-order`, submit
> it with `ch submit`, and wait for a supply-side filler to lift it — today's book has live BUY rows
> shaped exactly like this, including for the market derived in step 1c. Since 2.1.0 the taker-side
> JIT interaction can create the market and mint inside the lift, so this works even for a
> not-yet-created market. It's still the road less traveled for the pilot: you depend on a filler
> showing up, and your resting order is exposed to the shares-address race (step 2's dead-row
> warning applies to you then). Fill Bond's SELL (above) as the default; confirm the BUY path with
> Cork before relying on it.

---

### Step 4 — Zyfai exercises the cST, swapping an impaired REF asset for a stable CA asset

When your risk monitor sees impairment on the user's REF, exercise the cover: hand in **cST + REF**,
receive **CA** at the market's tracked rate. This is a direct Phoenix call, not an LOP fill — no
counterparty needed, so it works exactly when the market is stressed.

```sh
# replace 0xYOUR_SAFE (used for both account and receiver); REF (dUSDC) is 6-dec, CA (sUSDe) 18-dec
ch prepare phoenix --json '{"chainId":42161,"account":"0xYOUR_SAFE","clientRequestId":"exercise-0001","action":{"type":"exercise","poolId":"0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78","cstSharesIn":"1000000000000000000000","receiver":"0xYOUR_SAFE","minCollateralAssetsOut":"950000000000000000","maxReferenceAssetsIn":"1000000"}}' | jq .
```
Sign with your Safe stack, and route the call through your `*ForSelf` adapter so `receiver` is forced
to the Safe (§5, item A). Run it with `--rpc-url <your node>` so the funding legs resolve — without
an explicit RPC the bundle still builds, but with `fundingLegs: 0` and a `funding_needs_rpc` warning
(funding-leg token resolution is deliberately offline-by-default). A few things to keep in mind:
- `exercise` has no built-in slippage guard beyond the `min*/max*` you pass. Re-check the preview at
  send time, and treat a zero preview as *unavailable*, not free (§5, item D).
- A REF pause blocks the REF transfer — i.e. the exercise leg itself — so keep positions small and
  monitor REF liveness (§5, item E).
- Approvals: REF → CorkPoolManager. cST needs **no** pool-manager approval on the direct path
  (§5, item C).

---

### After the flow — rolling the cover near expiry

Near expiry, roll the user's cover into the successor market instead of letting it lapse. Rollover is
a two-party trade, and the roles are easy to mix up:
- The rollover order is **signed by a cPT-holder** — the underwriter/supply side, a *different*
  party from your user. They offer to co-roll their principal and **collect** a premium.
- **You are the filler** — the cST/demand side, acting for your user. You roll *your user's* cover
  from the old market to the new one and **pay** that premium.

Find open rollover orders:

```sh
ch query --json '{"resource":"flows","chainId":42161,"filters":{"kind":"orders"}}' | jq .
```
```jsonc
{ "state": "ok", "data": { "kind": "orders", "count": 0, "items": [] } }  // none open right now — a normal result
```
To fill one, a single atomic settler call does three things:
1. **Fronts the user's expiring srcCST** (pulled from the user's Safe).
2. **Pays the premium in the order's `premiumToken`.** You supply that token, so first **swap some of
   the user's REF into it** in your own stack. (There is no swap hook — the order's hooks are
   author-signed, attested modules, not something the filler injects.)
3. **Delivers the fresh dstCST** — the new-term cover — to the user's Safe.

The counterparty (cPT-holder) supplies the matching srcCPT for the unwind, keeps their cPT leg, and
receives your premium. Net: you spend the expiring cST plus a premium (bought with the user's REF) to
get fresh cover for the user — you're paying to carry the cover forward, which you price to your user
off-chain.

The on-chain entrypoint is the CorkSettler:

```
ExactSettler.fill(bytes32 orderId, bytes originData, bytes fillerData)     // all-or-nothing
PartialSettler.fill(bytes32 orderId, bytes originData, bytes fillerData)   // fill a slice
```
The order's signed `allowPartialFills` flag routes it to exactly one of these (ExactSettler rejects
partials; PartialSettler requires them).

> **Tool status.** `ch` builds the **supply side** of rollover today (`ch prepare orders` →
> `rollover-intent`, then `ch submit` → `rollover-order`) — what a cPT-holder posts. It does **not**
> yet build the **filler** transaction (the `fillerData` envelope plus `settler.fill`) or the
> REF→premium swap that you need. So for now: discover with `flows`, then build and sign the `fill`
> with your own stack. A filler-side `ch prepare` action is a natural next addition — confirm the
> current path with Cork.

---

## 4. `cork-mcp-cli` — the integration kit

**One typed core, two surfaces.** The same 9-tool dispatch is exposed as an **MCP server** (stdio)
and a **CLI** (`ch`). It reads live chain + venue state, runs Cork's math **bit-exact** (ported and
verified wei-for-wei against on-chain reads), and **builds unsigned bytes/typed-data**. It **never
signs, never custodies, never broadcasts** — the one side-effecting tool only relays a payload *you*
already signed to the venue.

**Install (MCP):**
```sh
claude mcp add cork-defi -- "$(which bun)" /path/to/cork-helper-cli/packages/mcp/src/bin.ts
# health check — a good install returns exactly 9 tools:
#   call cork_capabilities with no args
```
**CLI:** put `bin/` on PATH → `ch <command> [--json '<input>'] [--rpc-url <url>] [--explain]`.
Runtime is **Bun** (pinned), not Node.

**The 9 tools:** `capabilities` (searchable manual + maturity map — start here), `query` (state
reads), `compute` (deterministic math: swap/unwind rate, impairment floor, recipe resolution),
`decode` (bytes→labeled JSON — calldata incl. Bundler3 unwrap, signed **tx** with signer recovery,
order, event, receipt), `prepare_market` / `prepare_orders` / `prepare_phoenix` (unsigned tx/order
builders), `track` (verify / **simulate frozen bytes** / reconcile), `submit` (the only relay — LOP
orders, rollover orders, and the RFQ open/answer pair from step 1d).

**Every prepared artifact tells you how to finish it.** Prepare results carry a `data.execution`
block — sign method (`eth_signTransaction` vs `eth_signTypedData_v4`), the ordered next steps, and a
pointer to the full guide: `ch capabilities --json '{"topic":"signing"}'` covers client-side signing,
validating signed bytes with `ch decode` (kind `tx` recovers the signer and labels the target before
you broadcast), and broadcasting through your own RPC.

**The result envelope — always check `state` before trusting `data`:**
- `ok` → use `data`. `unavailable` → not servable now; `warnings[0].code` says why (don't retry
  blindly). `conflict` → the tool ran and found a mismatch (e.g. a digest mismatch, a dead resting
  order) — surface it, don't paper over it. CLI exit codes mirror this (`0/2/3/4/1`).
- Money/rate outputs carry a `scales` block + `collateralDecimals`/`referenceDecimals` — **read the
  labels; do not assume 18 decimals** (dUSDC REF is 6-dec while sUSDe CA is 18-dec).

**Maturity — the tool self-reports it; check it live.** `cork_capabilities` returns a per-tool /
per-variant map with three states: `activated` = live and verified against chain; `implemented` =
code-complete and locally verified, awaiting a live-milestone flip (not a code gap); `specified` =
designed, not built (returns `unavailable`). The read → derive → build → simulate → verify path is
`activated` end to end, with the math ports checked **bit-exact, wei-for-wei** against on-chain
reads. `submit` self-reports `implemented` today: code-complete, with real local pre-flight (it
recomputes hashes and recovers your signature before relaying, idempotent by `clientRequestId`) —
the map flips it to `activated` on the first venue-accepted live POST, i.e. the unproven part is
the venue round-trip, not the relay logic. Simulate before, reconcile after, as always.

**RPC & secrets:** Arbitrum reads **work out of the box** (built-in default endpoints + a public
fallback). Set `CORK_RPC_URL` only to use your own/faster node. Full-decentralized reads and order
reconciliation want an Envio token (`ENVIO_API_TOKEN`) — generate one at
<https://envio.dev/app/api-tokens> (sign-in required; docs at
<https://docs.envio.dev/docs/HyperSync/api-tokens>). **Never commit an RPC URL or token** — env only.

**Prefer decentralized reads when freshness matters.** The venue-backed reads (`orderbook`, `rfqs`,
`fills`, `flows`, `markets`) are served by Cork's off-chain indexer (api-phoenix), which can lag chain
head. For anything time-sensitive — discovering an order right before a fill, checking order status,
reconciling after — lean on the decentralized paths instead: `lite-decentralized` (direct RPC chain
reads, already the default for `market` / `account-state` / `market-predict`) and `full-decentralized`
(HyperSync event scans; needs `ENVIO_API_TOKEN`). Where a resource supports more than one backend you
can force it with `mode` on `ch query`, and every result's `provenance.mode` tells you which one
answered. When the indexer and chain disagree, chain wins — that's the reconcile principle behind
`ch track` (§5, item F). (RFQs are the one venue-only resource by construction — a request-for-quote
emits no on-chain events.)

---

## 5. Risks & ownership

Sections A–C are the security core.

**A. Cork sends payouts to an address argument — and your permission layer cannot see arguments.
You must force the receiver yourself.**
Every raw Cork function that pays out takes its destination as a **parameter** (`receiver` or
`target`) while pulling the inputs from the calling Safe. Your Safe-module whitelist
(Zodiac/ERC-7579-style) can only allow or deny *"this contract, this function"* — it cannot look
inside the call to check where the money goes. So an agent that has been prompt-injected or
compromised can make a perfectly *allowed* call in which **your Safe pays and an attacker
receives**, and the whitelist sees nothing wrong. This is **source-confirmed and still present in
the latest Phoenix build**, on two surfaces:

| Surface | The argument the whitelist can't see | Your remedy |
|---|---|---|
| Direct Phoenix calls: `exercise` / `swap` / `redeem` / `withdraw` / `unwind*` | `receiver` — where the payout lands | Only whitelist a wrapper that hardcodes `receiver` = the Safe |
| Buying cST via the 1inch fill | the optional `target` in takerTraits (bit 251) — where the bought cST lands | Leave `target` unset, or pin it to the Safe, on **every** fill |

**The fix is yours to own, and it's a pattern you already run.** Don't whitelist raw Cork methods.
Deploy a small Zyfai-owned wrapper that forces the payout to the Safe — the same shape as your
existing `*ForSelf` / AdapterProxy routes (`supplyForSelf`/`withdrawForSelf`/… for
Aave/Morpho/Euler) — and whitelist *that* instead. **Cork will provide reference/example adapter
code, but you audit, vet, and deploy it** — your users trust Zyfai, not Cork. One guardrail worth
internalizing: *"Zyfai-owned" says who is accountable, not what makes it safe* — the wrapper is
only safe if it actually forces the receiver, holds no funds of its own, and has been audited.
(Cork can share the full analysis and on-chain evidence — the "Scope & Ownership" write-up — on
request.)

**B. Markets in this flow have their pool-level access whitelist turned OFF — by construction.**
The just-in-time mint inside a fill is performed by Cork's adapter contract. A market created with
its whitelist *enabled* would refuse that adapter, so every purchase would revert
(`MintUnavailable`). The order builders always create markets with the whitelist off, and it isn't
a knob you can turn — this item exists so nobody asks for a gated pool and then wonders why nothing
fills.

**C. Two approvals to two different spenders — and one approval you should NOT grant.**
The premium you pay (CA, sUSDe) must be approved to the **1inch exchange**. The REF you hand in on
exercise must be approved to **Cork's pool manager**. It's the same `approve` call with two
different spenders — easy to wire wrong, and your allow-list must permit both explicitly. And do
**not** approve the cST to the pool manager: when you exercise, the pool manager moves your cST
through an internal transfer path that skips the allowance check whenever the token's owner is the
caller (source-verified 2026-07-28: the 4-arg `PoolShare.transferFrom` skips `_spendAllowance` when
`sender == owner`). A cST approval can therefore never legitimately be spent — it just sits there
as standing risk. The same goes for cPT if you ever exit an underwriter position. One exception: if
you route through your own `*ForSelf` wrapper, the cST does need approving — **to that wrapper**,
never to the pool manager.

**D. `exercise` has no built-in slippage protection.** The only bounds on what you receive and pay
are the `min*`/`max*` numbers you pass in yourself (and the call can also be blocked by the
market's rate-change budget or a pause). Compute the expected payout immediately before sending and
pass tight bounds — and read a zero preview as *"the market cannot pay right now,"* never as
*"it's free."*

**E. If the REF token can be paused, your cover freezes with it.** Exercising means transferring
REF in — a paused REF blocks that transfer, so the cover is unusable for exactly as long as the
pause lasts. And pauses tend to happen during the very stress event you bought cover for. Keep
pilot positions small and monitor the REF's pause status.

**F. `submit` pre-flights locally; the venue round-trip is the part to reconcile.** Simulate
(`ch track simulate`) before signing and reconcile (`ch track` → `reconcile/orderHash`) after;
chain outranks the indexer on any disagreement.

**G. Addresses drift; read them live.** Pull the deployment from `ch query protocol-config`
(Arbitrum today: poolManager `0x4d0ab673…`, corkAdapter `0xe9f364df…`, bundler3 `0x1FA4431b…`) and
the registry stack from `ch query registry-assets` (MarketRegistry 2.1.0 at `0x47C3AF38…752D` —
note the whole registry stack was redeployed 2026-07-31; anything you cached before then is stale).
The current venue pool list is `api-phoenix.cork.tech/v1/pools/`.

---

## 6. What you need to do (checklist)

1. **Stand up the tool** — `claude mcp add` (or `ch` on PATH), confirm `cork_capabilities` returns 9
   tools. Optional: `CORK_RPC_URL` (own node), `ENVIO_API_TOKEN` (decentralized reads).
2. **Deploy the receiver-forcing routes on your side** — extend your `*ForSelf`/AdapterProxy to cover
   the Cork exercise/swap family and a target-pinned 1inch fill. Cork ships examples; you audit +
   deploy.
3. **Load the whitelist** for the loop (your own AdapterProxy routes, not raw Cork): fill,
   `exercise`/`exerciseOther`, and the approvals (CA→LOP, REF→PoolManager).
4. **Wire the four-step flow against the tool** — select + derive with `registry-*`/`market-predict`,
   RFQ with `submit rfq-open` / watch `rfqs`, **simulate every artifact before signing**, fill with
   `taker-fill` (target pinned), exercise with `prepare_phoenix`, reconcile with `track`.
5. **Confirm ownership + timeline back to Cork** — Cork needs no protocol change from you; it needs to
   know when your adapter routes will be ready so the pilot's fill/exercise path lands inside your
   trust boundary. Also confirm the RFQ package catalog (`packageIds`) and notional units for step 1d.

---

## 7. Finding the right command (and letting Claude Code find it)

You don't have to memorize any of the commands above. The tool documents itself two ways, and — once
the MCP server is installed — Claude Code can pick the command for you.

### 7a. `--explain` — the exact contract for one command

Every `ch <command>` accepts `--explain`. By default it prints a **plain-English contract** —
description plus a per-parameter breakdown with variants unfolded — then exits, no chain call. Add
`--json` when you want the raw JSON schema instead:

```sh
ch compute --explain            # human-readable contract
ch compute --explain --json | jq .   # the raw JSON schema
```
```jsonc
{
  "tool": "cork_compute",
  "cli": "ch compute",
  "phase": 1,
  "description": "Deterministic math over verified chain state: swap/unwind rate, dutch-auction (Fusion) price, rollover premium floor, worst-case impairment floor, RFQ quote. …",
  "inputSchema": {
    "type": "object",
    "properties": { "params": { "oneOf": [
      { "properties": { "kind": { "const": "cst-swap-rate" }, "poolId": { "$ref": "#/$defs/MarketId" }, "collateralAssetsOut": { "$ref": "#/$defs/TokenAmount" } },
        "required": ["kind","poolId","collateralAssetsOut"] },
      { "properties": { "kind": { "const": "unwind-rate" }, "poolId": { "$ref": "#/$defs/MarketId" }, "collateralAssetsIn": { "$ref": "#/$defs/TokenAmount" } } }
      // …one branch per compute kind
    ] } }
  }
}
```
Each `$ref` carries its own units/format note in `$defs` (e.g. `TokenAmount` = base units as a
decimal string), so you rarely have to guess a value's shape.

### 7b. `ch capabilities` — the searchable manual

`capabilities` is the whole manual in one command:

```sh
ch capabilities                                          # human summary; add --json for the machine-readable map
ch capabilities --json | jq .                            # maturity of every tool + variant (what's live vs gated)
ch capabilities --json '{"topic":"compute"}' | jq .      # full docs for one tool
ch capabilities --json '{"topic":"signing"}' | jq .      # the sign→validate→broadcast guide for prepared artifacts
ch capabilities --json '{"search":"swap rate"}' | jq .   # keywords -> matching tool/variant + ready-to-run examples
```
The `search` result hands you example inputs you can paste straight into the command:
```jsonc
{ "state": "ok", "data": { "query": "swap rate", "matches": [ {
  "name": "cork_compute", "cli": "ch compute", "variant": "cst-swap-rate",
  "examples": [
    { "title": "How much cST + reference does 1 sUSDe out cost right now?",
      "input": { "params": { "kind": "cst-swap-rate", "poolId": "0x…", "collateralAssetsOut": "1000000000000000000" } } }
    // …more examples
  ] } ] } }
```
Copy the `input` object directly into `ch compute --json '<that object>'`.

### 7c. Install the MCP server into Claude Code

The CLI and the MCP server are the **same 9-tool core** — install the server to drive it from Claude
Code (or any MCP client) instead of the shell:

```sh
# from the cloned repo; use an ABSOLUTE bun path so the spawned server can find it
claude mcp add cork-defi -- "$(which bun)" /ABSOLUTE/PATH/TO/cork-helper-cli/packages/mcp/src/bin.ts

# health check — expect: cork-defi … ✓ Connected
claude mcp list
```
Then, inside Claude Code, calling `cork_capabilities` with no arguments should return **exactly 9
tools** — that's the signal the server launched correctly. Optional env: `CORK_RPC_URL` (your own
node) and `ENVIO_API_TOKEN` (full-decentralized reads); never commit either.

### 7d. Ask Claude Code for the right command

Because the MCP tools and the CLI commands are the same core with identical input shapes, two things
follow:
1. You can ask Claude Code in plain language and it will call the right tool with the right
   parameters.
2. **An MCP tool's input *is* the CLI `--json` payload.** So Claude Code can also hand you the exact
   `ch … --json '…'` line to drop into a script — and any `--json` you have will run verbatim as an
   MCP call.

Example prompts, with the `cork-defi` server installed:

> "Using cork-defi, derive the sUSDe / dUSDC market on Arbitrum that expires in 7 days, and give
> me the poolId and cST address."

> "What's the `ch` command with `--json` to build an unsigned exercise bundle — 1000 cST out of pool
> `0x…`, receiver my Safe `0x…`?"

> "List the Cork registry recipes on Arbitrum and explain the difference between the fixed and
> liquidity recipes for my cover."

Claude Code will call `cork_query` / `cork_compute` / `cork_prepare_phoenix` as needed, and can print
the equivalent `ch … --json` line because the payloads are identical. When in doubt, start it with
*"call `cork_capabilities` first"* so it grounds itself in the live tool/variant list before acting.

---

*Questions or a stale value? `ch capabilities` (search/topic) is the living manual — the authority on
tool state, examples, and maturity. For the deeper security analysis and the pilot's open items, ask
your Cork contact (Baptiste).*
