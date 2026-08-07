# Cork × Zyfai — Integration Quick Start

**Audience:** the Zyfai engineering team. **Assumes:** fluency with Safe/ERC-7579, 1inch LOP v4,
EIP-712/ERC-1271, ERC-2612 permits, ERC-4626/7540, CREATE2. **Chain:** Arbitrum One (42161).
**Status:** as of 2026-08-06, against the redeployed MarketRegistry 2.1.0 stack (whose contracts
self-report `contractsVersion 0.3.0` — same deployment, relabeled). Addresses/rates
below were read live from chain; still, **treat this doc as orientation and pull the authoritative
values from the tool** (`ch query protocol-config`), never hardcode them.

This is a two-part handoff: (1) a compact model of what Cork gives you and where your agent plugs
in, and (2) `cork-cli` — a helper you drive from an MCP client or the shell to read state,
derive markets, build unsigned transactions, and simulate them. It never signs and never holds
funds.

---

## 1. What Cork is

Cork is middleware for **tokenized, tradeable downside cover**. A Cork *market* tokenizes one covered
position into two ERC-20 legs:

| Term | Meaning | Who holds it |
|---|---|---|
| **REF** | the asset your user is exposed to and wants cover on. The registry lists the approved assets — read the list, don't assume | the user |
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
**exercise** it on impairment. The underwriter (bond.credit in the pilot) is the supply side; it prices and sells
the cover and holds cPT. Settlement is atomic on **1inch LOP v4** with **just-in-time (JIT)
minting** of cST/cPT inside the fill — no pre-funded inventory.

---

## 2. The flow end-to-end, and the tool at each step

Four steps, demand-side view. Every step has a `ch …` command that returns **unsigned** artifacts or
plain reads — you sign/broadcast with your own stack.

| # | Step | What happens | Tool |
|---|---|---|---|
| 1 | **Zyfai selects the asset and submits an RFQ** (off-chain — CLI/MCP only) | Pick REF + CA + recipe + term from the registry, derive the market it names, then open a request-for-quote on the venue | `ch query` → `registry-assets` / `registry-recipes` / `derive-market`; `ch submit` → `rfq-open`; watch with `ch query` → `rfqs` |
| 2 | **The underwriter mints cST and creates a limit order (to sell)** | The underwriter answers your RFQ with priced options, then rests a signed SELL order (makerAsset = cST, takerAsset = CA). The cST usually doesn't exist yet — the order carries the market's recipe + constraint, and the mint happens inside the fill | The underwriter's side. You watch: `ch query` → `rfqs` / `orderbook`; inspect what a fill commits to with `ch decode` → `order` |
| 3 | **Zyfai buys the underwriter's cST** (by filling their limit order) | Verify the order/market, simulate, then fill on the LOP; the adapter JIT-creates the market (if new) and JIT-mints cST to you, pulling the CA premium from you — **atomic** | `ch query` → `market`; `ch prepare order` → `taker-fill`; `ch track` → `simulate` |
| 4 | **Zyfai exercises the cST**, swapping an impaired REF asset for a stable CA asset | Hand in cST + REF, receive CA at the market's rate — a **direct** Phoenix call, *not* an LOP fill | `ch prepare pool` → `exercise` / `exercise-other` |

One piece of one-time prep per CA/REF pair comes before step 1: deploying the pair's rate oracle
(`ch prepare market` → `deploy-oracle`). It is permissionless, idempotent, and optional — a JIT
fill deploys a missing oracle itself. After step 4 (or instead of it, near expiry) comes
**rollover** — see "After the flow" below.

Implementation notes:
- **`taker-fill` picks the right fill flavor for you** — `fillOrderArgs` (EOA maker) vs
  `fillContractOrderArgs` (Safe/ERC-1271 maker). Guessing wrong reverts `BadSignature`.
- **Market identity is pinned at signing (2.1.0).** The order *carries* its resolved rate constraint,
  so the `poolId` and cST/cPT addresses are fixed the moment the order is signed — they no longer
  drift with the oracle. Staleness is guarded at fill time instead: if the live rate has left the
  carried constraint's window, the fill reverts `RecipeRejectedConstraint` until a fresh constraint
  is signed.
- **One live footgun: a resting order can be killed by a share-address race.** A not-yet-created
  market's cST address is predicted from a deployer nonce, and every *successful* JIT fill — of
  anyone's order — consumes nonces, invalidating other resting orders' predictions. Filling a dead
  row reverts `OrderNotForPool`. The tool diagnoses this before you sign (`jit_side_mismatch` +
  `stale_share_prediction`, naming the pool that consumed the address); on either warning, pick a
  fresher order.
- **Redeem is a supply-side action.** You hold cST only; your terminal move is **exercise**, never
  redeem. An unexercised cST is worthless after expiry.

---

## 3. The flow, step by step

One full cover cycle end to end. Every step has a real `ch` command you can run as-is, followed by a
trimmed real response (read live 2026-08-06) and a short note on what to check. Each command returns
**unsigned** artifacts or plain reads — you sign with your own Safe stack.

**A few conventions for every command below:**
- Replace **`0xYOUR_SAFE`** with the user smart account (Safe) you're driving.
- Steps 3–4 reuse one market's `poolId` and `cST` address. The values shown come from the
  **sUSDe / dUSDC** market derived in step 1c — a market that doesn't exist yet, so run the
  derivation yourself and paste *your* output. Everything else (asset addresses, `chainId`) is real
  and runnable today.
- **Commands read like English: the action is a subcommand, its fields are flags.**
  `ch prepare pool exercise --pool-id 0x… --cst-shares-in 1000e18 …`,
  `ch compute resolve-recipe --recipe 0x…`, `ch submit rfq-open …` — every action/kind of every
  tool is its own subcommand with its own `--help` and `--explain` (`pool` and `order` are
  the canonical spellings; the MCP tool names keep the internal `phoenix`/`orders`, which the CLI
  still accepts as aliases), and a mistyped action gets a
  did-you-mean instead of a cryptic error. The 13 pool actions and `fill` are also top-level
  verbs — `ch exercise …` = `ch prepare pool exercise …`, `ch fill …` = `ch prepare order
  taker-fill …`. Scalar fields are plain flags (spelling is forgiving:
  `--pool-id`, `--poolid` and `--poolId` are one flag); on `ch query` every known filter key is
  itself a flag (`--pool-id`, `--rfq-id`, `--status`, `--collateral-asset` … — no JSON needed;
  `--filters '{…}'` still works, and a flag overrides the same key in the blob), and `ch query
  rfq` is accepted for `rfqs`; other object-valued fields take a JSON string
  (`--for-self '{…}'`); amount fields accept exact human sugar (`1000e18`,
  `95e16`, `1_000000` — expanded by integer math, never floats); `--chain-id` takes network names
  too (`arbitrum`, `mainnet`, `base`, `sepolia`).
- **Treat `--client-request-id` as the name of the request, not a random string.** Retrying the
  same thing? Reuse the id — that is what makes retries safe (the venue dedupes on it, and the
  same id with a *different* payload is refused as `venue_conflict`). Doing a new thing? New id,
  always. For orders this is load-bearing: the id decides which cancellation slot the order
  occupies on-chain, and two live orders sharing an id can kill each other.
- **The canonical wire form still works everywhere** — `--input '{…}'` (or `--json '{…}'`) with
  the full object, `--action`/`--params` blobs, and the older `ch prepare pool 42161 --action
  '{…}'` shape (`phoenix` works there too) are all unchanged; flags override blob keys, so a saved blob is reusable. Some
  examples below show this as the **alternative style** — it is what an MCP call carries.
- **Output is prose by default; a bare `--json` returns the raw result envelope.** The walkthrough
  adds `--json` wherever it dissects a response, and the responses shown are that JSON, trimmed.

The pair used throughout, for reference:

| Role | Asset | Address | Decimals |
|---|---|---|---|
| **REF** — what the user is exposed to and covers | dUSDC | `0x444868B6e8079ac2c55eea115250f92C2b2c4D14` | 6 |
| **CA** — what the user is paid out in on exercise | sUSDe | `0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2` | 18 |

Your user holds **cST** (the cover); the underwriter holds **cPT** (the principal leg). In the tool, CA is
`collateralAsset` and REF is `referenceAsset`.

---

### Step 1 — Zyfai selects the asset and submits an RFQ (off-chain — only available via CLI or MCP)

This step is entirely off-chain: choosing what to cover, deriving the market those choices name, and
asking the supply side to price it. There is no UI for RFQs — the CLI/MCP is the way in. Or take the
code route: fork the repository, or cherry-pick a subset of the typed per-tool handlers from
[`packages/core/src/handlers`](https://github.com/Cork-Technology/cork-cli/tree/main/packages/core/src/handlers)
straight into your own stack.

Sections 1a–1d below are the fast path. If you want to understand *why* those four choices are the
whole selection — and how the registry decides which markets are even possible — take the slower
tour first:

<details>
<summary><b>Market selection, deliberately — how the registry decides what you can ask for (expand)</b></summary>

A Cork market has no factory catalog to browse. There is no list of "available markets" anywhere —
a market is **fully named by four choices** (CA + REF + expiry + recipe), and the registry holds the
**ingredients** every legal market is made from. Selecting a market means walking those
ingredients; the RFQ you open in step 1d is simply that selection written down. Six stops, each a
read you can run right now (all responses below were captured live).

**Stop 1 — assets: who is registered, and how each one is priced.**
`registry-assets` (step 1a) is the universe: an asset absent from it cannot be covered, period.
Look one asset up by address to see what the registry actually knows about it:

```sh
ch query registry-assets --chain-id 42161 --address 0x444868B6e8079ac2c55eea115250f92C2b2c4D14 --json
# alternative — the same key in a filters blob:
ch query registry-assets --chain-id 42161 --input '{"filters":{"address":"0x4448…4D14"}}' --json
```
```jsonc
{ "address": "0x444868B6e8079ac2c55eea115250f92C2b2c4D14", "name": "dUSDC", "kind": "ERC4626",
  "priceSource": { "address": "0x5E794850…", "sourceType": "PRICE",
                   "sourceInterface": "AGGREGATOR_V3", "denomination": "USD" },
  "navSource":   { "address": "0x444868B6…", "sourceType": "NAV",
                   "sourceInterface": "ERC4626",       "denomination": "USDC" },
  "token": { "decimals": 6, "symbol": "dUSDC" } }
```
Each asset carries up to **two named source slots**, and they answer different questions:
- **`priceSource`** — what the *market* says the asset is worth (a Chainlink-style aggregator),
  quoted in some denomination (here USD).
- **`navSource`** — what the asset's own *accounting* says it is worth (here the ERC-4626 vault's
  `convertToAssets`), quoted in its underlying (here USDC).

An asset may carry either slot, or both. dUSDC carries both — which means a dUSDC pair could be
covered against its **market price** (a depeg view) or against its **book value** (an accounting
view). That choice surfaces later as the oracle *mode* (`price` | `nav`), and it changes what
"impairment" means for your cover — so it's a product decision, not a plumbing detail.

**Stop 2 — denominations: the units prices are quoted in.**
Source values are only comparable when they end up in the same unit. The registry's denomination
table maps each label to its unit (a token address, or a pseudo-unit like ISO-4217 USD):

```sh
ch query registry-denominations --chain-id 42161 --json
# alternative — the rest in one --input blob:
ch query registry-denominations --input '{"chainId":42161}' --json
```
```jsonc
// 5 labels live: USD, ETH, USDS, USDC, WETH — trimmed to two
{ "label": "USD", "unit": "0x0000000000000000000000000000000000000348", "labelSource": "pseudo-unit table" }
{ "label": "ETH", "unit": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "labelSource": "pseudo-unit table" }
```
Labels are **exact bytes** (case-sensitive; `labelHash` is the real identity). Two assets whose
sources are denominated in the *same* label compare directly; different labels need a bridge —
which is the next stop.

**Stop 3 — feeds: the bridges between denominations.**

```sh
ch query registry-feeds --chain-id 42161 --json
# alternative — the rest in one --input blob:
ch query registry-feeds --input '{"chainId":42161}' --json
```
```jsonc
// 4 directed edges live, all into USD — trimmed to one
{ "base": "0x6491c05A…", "quote": "0x…0348",   // USDS → USD
  "aggregator": "0x37833E5b…", "feedDecimals": 8,
  "live": { "answer": "99990612", "decimals": 8, "updatedAt": "1785962274" } }
```
Feeds are **directed** conversion edges with live answers — base→quote is not quote→base. When
your CA's and REF's sources speak different denominations, the registry needs a feed path to
reconcile them; a pair with **no path cannot get a price oracle at all** (you'd see
`oracle_not_deployable` at the next stop). Today every edge converts into USD, so USD is the hub.

**Stop 4 — the pair's oracle: does your CA/REF combination actually price?**
This is the go/no-go check for a pair, before you think about terms:

```sh
ch query registry-oracle --chain-id 42161 --json \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0x444868B6e8079ac2c55eea115250f92C2b2c4D14
# alternative — the same keys in a filters blob:
ch query registry-oracle --chain-id 42161 --input '{"filters":{…same…}}' --json
```
```jsonc
{ "mode": "price",   // the default; pass filters.mode "nav" explicitly when you mean book value
  "modeNote": "…one pair can hold a price AND a nav wrapper at different addresses…",
  "oracle": { "address": "0x0DF21ad4Ce3F27Aac74b977e58E0943D8B3aC033",
              "deployed": true, "deployable": true, "rate": "1025603415387290352" } }
```
Read `oracle` as a three-state answer:
- **`deployed: true`** — the pair prices today; `rate` is live (1e18 = 1.0).
- **`deployed: false, deployable: true`** — fine too: the oracle deploy is permissionless and
  idempotent, and a JIT fill performs it inside the fill transaction. You lose nothing by waiting.
- **`deployable: false`** — the pair is not viable: an asset is unregistered or a denomination has
  no feed path. The fix is Cork-side (register the asset / add the feed) — ask, don't retry.

**Stop 5 — recipes: the actual terms of the cover.**
Step 1b lists the two approved recipe contracts. To see what a recipe would *actually commit you
to* on your pair, ask it — `resolve-recipe` is the very staticcall a fill runs:

```sh
ch compute resolve-recipe --chain-id 42161 --json \
  --recipe 0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0x444868B6e8079ac2c55eea115250f92C2b2c4D14
# alternative — the canonical wire blob:
ch compute --chain-id 42161 --input '{"params":{"kind":"resolve-recipe","recipe":"0xA39d…1234D","collateralAsset":"0x211C…5d2","referenceAsset":"0x4448…D14"}}' --json
```
```jsonc
{ "kind": "resolve-recipe", "recipe": "0xA39d5528…1234D",
  "constraint": { "rateMin": "1", "rateMax": "2051206830774580704",
                  "rateChangePerDayMax": "1025603415387290352",
                  "rateChangeCapacityMax": "3076810246161871056" },
  "scales": { "constraint": "ABSOLUTE rates, 1e18 = 1.0 — these four raw values are what a JIT order carries, in this order" } }
```
Simply put, for the **liquidity** recipe (anchor = the oracle rate at resolve time, ~1.0256
here): the market's tracked rate may fall all the way to 1 wei (`rateMin: 1` — the cover never
stops paying out on the way down), may never exceed twice the anchor (`rateMax`), and may move at
most one whole anchor per day (`rateChangePerDayMax`) with a total budget of three
(`rateChangeCapacityMax`). Those speed limits are the product: a slow bleed is tracked, a flash
crash is rate-limited — which is what makes the worst case computable (`ch compute` →
`impairment-floor`). The **fixed** recipe instead pins the rate forever (both change limits zero).
Either way, **these four numbers are literally what the underwriter's order will sign**, and the market's
identity is derived from them.

**Stop 6 — the identity check.**
`derive-market` (step 1c) is the final dry-run: it folds your four choices through the registry —
predicts the oracle, resolves the constraint, derives the `poolId` and the cST/cPT addresses, and
tells you whether the pool already exists. Nothing is deployed or signed; it is the same
derivation a JIT fill runs on-chain.

**How the selection becomes your RFQ (step 1d).** Every field of `rfq-open` is one of the choices
you just made:

| Your choice (stop) | RFQ field |
|---|---|
| REF asset (1) | `referenceAsset` |
| CA asset (1) | `collateralAsset.exact` — or `one_of: […]` to let underwriters pick from a set |
| Price-vs-NAV view (1, 4) | implied by the recipe + oracle mode behind `oracle_recipe` |
| Recipe contract (5) | `marketTemplate.inline.oracle_recipe` — copy the address from `registry-recipes`, never hand-type it |
| Term (6) | `expiryWindow` — pin an exact expiry with `notBefore = notAfter − 1` |
| Cover style | `modes` (`liquidity_only` pairs with the liquidity recipe) + the venue's `packageIds` |

Note what the RFQ does **not** carry: the constraint. The four numbers get resolved and pinned
when the underwriter *signs the order* (step 2) — your recipe choice determines them, but the anchor is read
at signing time. That's why deriving, quoting, and signing close together matters (step 1c).

**Pre-RFQ checklist:**
1. REF appears in `registry-assets` (and carries the source slot your view needs).
2. `registry-oracle` says the pair is `deployed` or at least `deployable` — in the mode you mean.
3. The recipe address came from `registry-recipes` on-chain, not from a doc or a chat message.
4. `derive-market` returns a full identity and the expiry you want.
5. `packageIds` and `notionalAssets` units confirmed with your Cork contact (venue conventions).

</details>

#### 1a. Pick the REF asset to cover

List the assets the registry approves. Each entry self-describes its price/NAV sources and token
metadata:

```sh
ch query registry-assets --chain-id 42161
# alternative — the rest in one --input blob:
ch query registry-assets --input '{"chainId":42161}'
```
```text
OK  ·  ch query  ·  chain 42161

resource               registry-assets
registry               0x47C3AF38435Db64D9400c30575E4c10482c0752D
contractsVersion       0.3.0
count                  11
items
  [2]  sUSDe
    address            0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2
    priceSource
      sourceType       PRICE
      sourceInterface  AGGREGATOR_V3
      denomination     USD
    token
      decimals         18
      symbol           sUSDe
  …                    (11 total: sUSDS, weETH, wstETH, dWETH, fUSDT, USDACM, dUSDC [6 dec],
                        fWETH, arbUSD, sUSDai — dUSDC at 0x444868B6e8079ac2c55eea115250f92C2b2c4D14)
```
Pick an asset your users actually hold. This walkthrough uses **dUSDC**, one of the assets live
RFQs cover. (If an asset isn't on this list it isn't coverable yet — registering it is a Cork-side
step.)

#### 1b. Pick the cover template (recipe)

The recipe sets how the market's rate may move, which is what defines the cover. Since 2.1.0 a
recipe is an **approved contract address** that self-reports its rules:

```sh
ch query registry-recipes --chain-id 42161
# alternative — the rest in one --input blob:
ch query registry-recipes --input '{"chainId":42161}'
```
```text
OK  ·  ch query  ·  chain 42161

resource               registry-recipes
contractsVersion       0.3.0
count                  2
items
  [1]  0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D
    source             price
    description        Liquidity: the widest rate window CorkPoolManager will accept. rateMin is
                       1 wei always, rateMax is twice the anchor rate, rateChangePerDayMax is the
                       whole anchor rate…
  [2]  0xA85cFa6E66f301a18D182A8304f5C4afEf5b4682
    source             fixed
    description        Fixed rate: the market's rate is whatever immutable FixedRateOracle the
                       order names, and it can never move.…
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
ch query derive-market --chain-id 42161 --json \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0x444868B6e8079ac2c55eea115250f92C2b2c4D14 \
  --expiry "$EXP" --recipe 0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D
# alternative — the rest in one --input blob (`--json` stays the bare output flag):
ch query derive-market --chain-id 42161 --json \
  --input "{\"filters\":{\"collateralAsset\":\"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2\",\"referenceAsset\":\"0x444868B6e8079ac2c55eea115250f92C2b2c4D14\",\"expiry\":\"$EXP\",\"recipe\":\"0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D\"}}"
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
  can pre-deploy with `ch prepare market` → `deploy-oracle` (permissionless, idempotent).
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
envelope (pair, mode, size, acceptable expiry window) that underwriters answer against. Every field
in the call below is one of the choices from 1a–1c — the collapsible tour above ends with a
field-by-field mapping and a pre-RFQ checklist if any of them feels arbitrary.

```sh
VU=$(date -u -d '+1 hour' +%s)
ch submit rfq-open --chain-id 42161 --client-request-id rfq-0001 --json \
  --requester 0xYOUR_SAFE \
  --reference-asset 0x444868B6e8079ac2c55eea115250f92C2b2c4D14 \
  --collateral-asset '{"exact":"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"}' \
  --modes '["liquidity_only"]' --package-ids '["balanced-v1"]' \
  --expiry-window "{\"notBefore\":$((EXP-1)),\"notAfter\":$EXP}" \
  --market-template '{"inline":{"oracle_recipe":"0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D"}}' \
  --notional-assets … --valid-until $VU --signature 0x…
# alternative — the canonical wire blob behind the positional chainId:
ch submit 42161 --client-request-id rfq-0001 --json \
  --input "{\"action\":{\"type\":\"rfq-open\", …the same fields… }}"
```
Conventions the live flow uses (all observable in the venue's open RFQs):
- **`modes: ["liquidity_only"]`** and **`packageIds: ["balanced-v1"]`** — the live package. Confirm
  the package catalog and the `notionalAssets` units with your Cork contact before your first post.
- **Pin an exact expiry** by setting `notBefore = notAfter - 1` (live RFQs do exactly this).
- **`marketTemplate.inline.oracle_recipe` carries the recipe's contract address** — this field is
  the bridge from quote to order, so both sides must put the address here for the quote to be
  executable. The venue stores it as unchecked free text: a mistyped address still posts and fails
  only at fill time, so copy it from `registry-recipes`, never type it.
- You sign the RFQ with your own stack; `ch submit` only relays — it never signs.

Then watch for answers — this is also how you'd browse what others are asking:

```sh
ch query rfqs --chain-id 42161                                    # all open RFQs
ch query rfq --chain-id 42161 --rfq-id 'rfq_…'                    # one RFQ with all its answers
# alternative — the same key in a filters blob:
ch query rfqs --chain-id 42161 --input '{"filters":{"rfqId":"rfq_…"}}'
```

---

### Step 2 — The underwriter mints cST and creates a limit order (to sell)

This step is the underwriter's, not yours — but you can watch every part of it, and you should verify the
result before buying. The underwriter answers your RFQ with priced options. Here's a real answer captured from
the venue (RFQ `rfq_kzbbztw3mfyws9zz3335m8cw`, dUSDC/sUSDe, liquidity_only):

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

The underwriter then rests a signed **SELL** limit order on the venue book executing that quote: `makerAsset` =
the cST, `takerAsset` = CA (your premium). A note on "mints": the cST usually does **not** exist yet
when the order is posted. The signed order *carries* the market's recipe and constraint — which is
what pins the cST address (step 1c) — and the actual mint happens **inside your fill**, funded by
the underwriter's collateral. Economically, the underwriter mints cST and sells it to you; mechanically, the mint and your
purchase are one atomic transaction.

Find the resting order for your market, and inspect exactly what a fill of it would do before you
commit — `decode order` unpacks the adapter, recipe, carried constraint, and permits from the
order's own bytes:

```sh
ch query orderbook --chain-id 42161 --json \
  --pool-id 0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78
# alternative:
ch query orderbook --chain-id 42161 --json \
  --input '{"filters":{"poolId":"0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78"}}'
```
```jsonc
{ "items": [ {   // a real SELL row, trimmed (see the caveat below)
  "orderHash": "0x9cf3b9c9a331518beb88a417fa3075a66c78775ede1d4afafc17f13dadf2df05",
  "side": "SELL", "status": "OPEN",
  "makerAsset": "0xca46bd3c576b1d7585fc1f8fa343936dd8834e79",  // a cST
  "takerAsset": "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",  // sUSDe (CA)
  "remainingMakingAmount": "100000000000000"
} ] }
```
(A real row captured at the time of writing, for the same dUSDC/sUSDe pair — it executes the RFQ
answer shown above; its pinned expiry differs from our 7-day example, hence a different `poolId`.
**Never reuse a hash from a document**: the venue's re-quote loop cancels and reposts orders
within hours — this very row died the same day it was captured. Query with *your* poolId from
step 1c and pick a currently-OPEN row.)

The venue row carries the order's own struct fields (`salt`/`maker`/…/`extension`) verbatim — pass
them straight to the decoder:

```sh
ch decode order --chain-id 42161 --data '{…the signed order row…}' --json
# alternative:
ch decode order --chain-id 42161 --input '{"data":{…the signed order row…}}' --json
```
```jsonc
{ "state": "ok", "data": { "jit": {          // decoded live from the row above
  "generation": "2.1.0", "adapter": "0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B",
  "collateralAsset": "0x211Cc4DD…5fE5d2", "referenceAsset": "0x444868B6…2c4D14",
  "recipe": "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D",
  "constraint": { "rateMin": "1", "rateMax": "2051135217108776914", /* … */ },
  "enableJitMint": true, "permits": 1 } } }  // ← the fill WILL mint the cST just-in-time
```
If step 1c showed `exists: false`, there may be no orders yet — you're the first mover, and the underwriter's
SELL is the order whose first fill creates the market.

---

### Step 3 — Zyfai buys the underwriter's cST (by filling their limit order)

Your users are ERC-1271 smart accounts, so fills use `fillContractOrderArgs` — the tool selects that
for you. Three commands: re-verify, build, dry-run.

```sh
# 1. re-verify the market on-chain (the book is discovery only)
#    NOTE: if the market doesn't exist yet (step 1c said `exists: false`), this read FAILS with
#    chain_read_failed — that is the expected pre-creation state, not a problem. Your fill is what
#    creates the market. Verify the order's carried constraint with `ch decode order` instead.
ch query market --chain-id 42161 --json \
  --pool-id 0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78

# 2. build the unsigned fill (use an OPEN orderHash from step 2; replace 0xYOUR_SAFE)
ch fill --chain-id 42161 --account 0xYOUR_SAFE --client-request-id buy-0001 --json \
  --order-hash 0x9cf3b9c9a331518beb88a417fa3075a66c78775ede1d4afafc17f13dadf2df05 \
  --fill-making-amount 100000000000000
#    (`fill` is the top-level verb for `ch prepare order taker-fill` — both work)
#    (alternative — the canonical wire blob behind the positional chainId:)
ch prepare order 42161 --json \
  --input '{"account":"0xYOUR_SAFE","clientRequestId":"buy-0001","action":{"type":"taker-fill","orderHash":"0x9cf3…df05","fillMakingAmount":"100000000000000"}}'

# 3. dry-run: does it revert at current state? (paste the artifact object from step 2's output)
ch track simulate --chain-id 42161 --subject '{"kind":"artifact","artifact":{…}}' --json
#    (alternative:)
ch track simulate --chain-id 42161 --input '{"subject":{"kind":"artifact","artifact":{…}}}' --json
```
Then **sign the calldata with your own Safe stack and broadcast.** The fill is atomic: the adapter
creates the market if it's new and mints the cST to your Safe, pulling the CA premium from you in
the same transaction. What to check:
- An `unsigned_artifact` warning on the prepare is expected — it's calldata only. Require
  `wouldRevert: false` from the simulate.
- **Only one fill ever lands, so size it for everything you want.** Cork orders use 1inch's *bit*
  invalidator: the first fill — of any size — consumes the whole order. If you take half of the
  underwriter's size, the other half is dead, not waiting. Going back for seconds means waiting
  for a fresh order.
- The result's `data.execution` block names the exact completion path (sign → decode-verify →
  broadcast → reconcile); `ch capabilities --topic signing` is the full reference.
- **If the prepare warns `jit_side_mismatch` / `stale_share_prediction`, stop** — that resting order
  is dead (its predicted cST address was consumed by another market's creation; the warning names
  the consuming pool). Pick a fresher order; filling it would revert `OrderNotForPool`.
- Stale book rows are refused outright: before building fill bytes, the tool reads the order's
  on-chain 1inch invalidator and rejects rows that are already filled or cancelled
  (`status_mismatch`). The book has served dead rows before; chain outranks it.
- Some SELL rows carry a **decaying premium** (an auction: the taker price starts above the signed
  floor and falls toward it over a window). `taker-fill` detects these automatically, defaults your
  cap to the curve's ceiling so the artifact stays valid whenever you broadcast, and reports
  `data.auction` (current/ceiling/floor) with a `decaying_price_notice` — re-price and simulate
  close to broadcast time.
- Before broadcasting: set the CA allowance (§5, item C) and pin the fill target to the Safe
  (§5, item A).
- **Or build through your deployed adapter and skip both worries:** add
  `--for-self '{"adapter":"0xYOUR_ADAPTER","poolId":"0x…"}'` to the `taker-fill` subcommand (in
  blob form: `"forSelf":{…}` inside the action) and the tool emits `fillOrderForSelf` instead —
  the bought asset structurally forced to the caller, taker interactions impossible, the
  taker-asset allowance granted to the adapter (never the LOP). The tool verifies the adapter's
  on-chain bindings first and hard-refuses a mismatched or code-less address
  (`adapter_binding_mismatch`) — your wallet is about to grant it an allowance.

<details>
<summary><b>Variation — resting your own BUY order instead</b> (available-but-verify; expand)</summary>

You can invert the trade: post a signed BUY (makerAsset = CA, takerAsset = the predicted cST) with
`ch prepare orders` → `maker-order`, submit it with `ch submit`, and wait for a supply-side filler
to lift it — the book has carried real BUY rows shaped exactly like this, including for the market
derived in step 1c. Since 2.1.0 the taker-side JIT interaction can create the market and mint
inside the lift, so this works even for a not-yet-created market — the amounts ratio is the premium
you're offering, `expirySeconds` bounds the order, and the Safe (as maker) structurally receives
the cST. Safe makers are first-class: order finalization and venue submission verify the ERC-1271
signature with the same `isValidSignature` staticcall the fill performs, and `ch submit`
cross-checks your listing premium against the cited RFQ option, refusing an obvious
percent-vs-fraction mix-up. It's still the road less traveled for the pilot: you depend on a filler
showing up, and your resting order is exposed to the shares-address race (step 2's dead-row warning
applies to you then). Fill the underwriter's SELL (above) as the default; confirm the BUY path with Cork
before relying on it.

</details>

---

### Step 4 — Zyfai exercises the cST, swapping an impaired REF asset for a stable CA asset

When your risk monitor sees impairment on the user's REF, exercise the cover: hand in **cST + REF**,
receive **CA** at the market's tracked rate. This is a direct Phoenix call, not an LOP fill — no
counterparty needed, so it works exactly when the market is stressed.

```sh
# replace 0xYOUR_SAFE (used for both account and receiver); REF (dUSDC) is 6-dec, CA (sUSDe) 18-dec
# amounts use exact sugar: 1000e18 cST in, floor 0.95 sUSDe out, at most 1 dUSDC (1_000000) in
ch exercise --chain-id 42161 --account 0xYOUR_SAFE --client-request-id exercise-0001 --json \
  --pool-id 0x6b02971336d7749ee305284f1c3ca6cac35562812e1466bab527014de1ae7a78 \
  --cst-shares-in 1000e18 --receiver 0xYOUR_SAFE \
  --min-collateral-assets-out 95e16 --max-reference-assets-in 1_000000
# alternative — the canonical wire blob behind the positional chainId:
ch prepare pool 42161 --json \
  --input '{"account":"0xYOUR_SAFE","clientRequestId":"exercise-0001","action":{"type":"exercise","poolId":"0x6b02…7a78","cstSharesIn":"1000000000000000000000","receiver":"0xYOUR_SAFE","minCollateralAssetsOut":"950000000000000000","maxReferenceAssetsIn":"1000000"}}'
```
Build with `--rpc-url <your node>` so the funding legs resolve — without an explicit RPC the bundle
still builds, but with `fundingLegs: 0` and a `funding_needs_rpc` warning (funding-leg resolution is
deliberately offline by default). Then sign with your Safe stack, routing the call through your
`*ForSelf` adapter so `receiver` is forced to the Safe (§5, item A).

**Mind the clock while signatures are collected:** every prepared bundle expires — the default
deadline is 30 minutes from when it was built. A Safe signing ceremony that takes longer than that
produces a transaction that reverts on arrival. If your ceremony can be slow, build with
`--deadline-seconds 7200` (up to 24 h) or pin an absolute `--deadline-at <unix seconds>` — the
absolute form also makes a retried prepare byte-identical, so a re-run doesn't invalidate
signatures already collected.

Once that adapter is deployed, skip the routing step and build the twin call directly: add
`--for-self '{"adapter":"0xYOUR_ADAPTER"}'` and the artifact becomes a single `exerciseForSelf`
transaction — no Bundler3 legs, output structurally to the Safe, allowances to the adapter (each
flow's exact allowance needs are machine-readable in `data.forSelf.allowances`). Keep in mind:
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
ch query flows --chain-id 42161 --kind orders
# alternative — the same key in a filters blob:
ch query flows --chain-id 42161 --input '{"filters":{"kind":"orders"}}'
```
```text
OK  ·  ch query  ·  chain 42161

resource               flows
kind                   orders
count                  0          # none open right now — a normal result
items
  (none)
```
To fill one, a single atomic settler call does three things:
1. **Fronts the user's expiring srcCST** (pulled from the user's Safe).
2. **Pays the premium in the order's `premiumToken`.** You supply that token, so first **swap some of
   the user's REF into it** in your own stack. (There is no swap hook — the order's hooks are
   author-signed, attested modules, not something the filler injects.)
3. **Delivers the fresh dstCST** — the new-term cover — to the user's Safe.

The counterparty (cPT-holder) supplies the matching srcCPT for the unwind, keeps their cPT leg, and
receives your premium. Net: you spend the expiring cST plus a premium (bought with the user's REF)
and the user gets fresh cover — you are paying to carry the cover forward, and how you charge the
user for that carry is your own off-chain pricing decision.

> **Tool status (your action item).** `ch` builds the **supply side** of rollover today (`ch prepare
> orders` → `rollover-intent`, then `ch submit` → `rollover-order`) — what a cPT-holder posts. It
> does **not** yet build the **filler** transaction or the REF→premium swap that you need. So for
> now: discover with `flows`, then build and sign the `fill` with your own stack (entrypoint below).
> A filler-side `ch prepare` action is a natural next addition — confirm the current path with Cork.

<details>
<summary>The on-chain entrypoint your filler transaction calls (expand)</summary>

```
ExactSettler.fill(bytes32 orderId, bytes originData, bytes fillerData)     // all-or-nothing
PartialSettler.fill(bytes32 orderId, bytes originData, bytes fillerData)   // fill a slice
```

The order's signed `allowPartialFills` flag routes it to exactly one of these (ExactSettler rejects
partials; PartialSettler requires them). `originData` carries the maker's signed order; `fillerData`
carries your side of the fill.

</details>

---

## 4. `cork-cli` — the integration kit

**One typed core, two surfaces.** The same 9-tool dispatch is exposed as an **MCP server** (stdio
or Streamable HTTP) and a **CLI** (`ch`). It reads live chain + venue state, runs Cork's math
**bit-exact** (ported and verified wei-for-wei against on-chain reads), and **builds unsigned
bytes/typed-data**. It **never signs, never custodies, never broadcasts** — the one side-effecting
tool only relays a payload *you* already signed to the venue.

**Install (MCP):**
```sh
# from a clone of github.com/Cork-Technology/cork-cli; ABSOLUTE bun path so the spawned server finds it
claude mcp add cork-defi -- "$(which bun)" /path/to/cork-cli/packages/mcp/src/bin.ts
claude mcp list   # expect: cork-defi … ✓ Connected
# health check — a good install returns exactly 9 tools:
#   call cork_capabilities with no args
```
(The same server also runs from the built binary — `ch mcp` for stdio, `ch mcp --http` for a
Streamable HTTP endpoint with `/healthz` and `/docs/signing`.)

**CLI:** put `bin/` on PATH → `ch <command> [action] [--flags…] [--json] [--rpc-url <url>]
[--explain]`. Every action/kind is a subcommand with its fields as flags
(`ch prepare pool exercise --pool-id … --cst-shares-in 1000e18`), the pool actions + `fill` are
also top-level verbs (`ch exercise …`, `ch fill …`), query filter keys are flags
(`ch query orderbook --pool-id …`), amount fields take exact
human sugar (`1000e18`, `1_000000`), objects ride as JSON-string flag values, and the canonical
wire blob (`--input '{…}'`) works everywhere; a bare `--json` switches the output from prose to
the raw envelope. Runtime is **Bun** (pinned), not Node.

**The 9 tools:** `capabilities` (searchable manual + maturity map — start here), `query` (state
reads), `compute` (deterministic math: swap/unwind rate, impairment floor, recipe resolution),
`decode` (bytes→labeled JSON — calldata incl. Bundler3 unwrap, signed **tx** with signer recovery,
order, event, receipt), `prepare_market` / `prepare_orders` / `prepare_phoenix` (unsigned tx/order
builders), `track` (verify / **simulate frozen bytes** / reconcile), `submit` (the only relay — LOP
orders, rollover orders, and the RFQ open/answer pair from step 1d).

**Every prepared artifact tells you how to finish it.** Prepare results carry a `data.execution`
block — sign method (`eth_signTransaction` vs `eth_signTypedData_v4`), the ordered next steps, and a
pointer to the full guide: `ch capabilities --topic signing` covers client-side signing,
validating signed bytes with `ch decode` (kind `tx` recovers the signer and labels the target before
you broadcast), and broadcasting through your own RPC.

**The result envelope — always check `state` before trusting `data`:**
- `ok` → use `data`. `unavailable` → not servable now; `warnings[0].code` says why (don't retry
  blindly). `conflict` → the tool ran and found a mismatch (e.g. a digest mismatch, a dead resting
  order) — surface it, don't paper over it. CLI exit codes mirror this (`0/2/3/4/1`).
- Money/rate outputs carry a `scales` block + `collateralDecimals`/`referenceDecimals` — **read the
  labels; do not assume 18 decimals** (dUSDC REF is 6-dec while sUSDe CA is 18-dec).

**Trust posture in one line:** everything you need for the four-step flow is live and verified
against chain — and whatever you run, **simulate before, reconcile after**. (`ch capabilities`
self-reports per-tool maturity, live, if you ever need the detail.)

**RPC & secrets:** Arbitrum reads **work out of the box** (built-in default endpoints + a public
fallback). Set `CORK_RPC_URL` only to use your own/faster node. Full-decentralized reads and order
reconciliation want an Envio token (`ENVIO_API_TOKEN`) — generate one at
<https://envio.dev/app/api-tokens> (sign-in required; docs at
<https://docs.envio.dev/docs/HyperSync/api-tokens>). **Never commit an RPC URL or token** — env only.

**Venue reads can lag; chain wins.** The book/RFQ/fill feeds come from Cork's off-chain indexer,
which can trail chain head — so for anything time-sensitive (an order right before a fill, status
right after one), verify against chain (`ch query market`, `ch track`) rather than trusting the
feed. Details on the read backends, if you want them:

<details>
<summary>Read backends and how to force one (expand)</summary>

The venue-backed reads (`orderbook`, `rfqs`, `fills`, `flows`, `markets`) are served by
api-phoenix, Cork's indexer. The decentralized paths are `lite-decentralized` (direct RPC chain
reads — already the default for `market` / `account-state` / `derive-market`) and
`full-decentralized` (HyperSync event scans; needs `ENVIO_API_TOKEN`). Where a resource supports
more than one backend you can force it with `mode` on `ch query`, and every result's
`provenance.mode` says which one answered. When indexer and chain disagree, chain wins — the
reconcile principle behind `ch track` (§5, item F). RFQs are the one venue-only resource by
construction: a request-for-quote emits no on-chain events.

</details>

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
Aave/Morpho/Euler) — and whitelist *that* instead.

**Cork's reference adapter now exists and is proven end-to-end.** `CorkForSelfAdapter`
([`Cork-Technology/cork-periphery`](https://github.com/Cork-Technology/cork-periphery)) is the `*ForSelf` twin of the whole surface: one address, 14
entrypoints (the 13 pool actions plus `fillOrderForSelf`), custody-free (it pulls, spends, and
sweeps back in a single transaction), every output structurally delivered to the calling Safe —
**no receiver parameter exists anywhere on it** — every fill bound on-chain to a named Cork
market, and all ERC-20 approvals go to the adapter itself, never to the LOP or the pool manager.
It was exercised end-to-end on an Arbitrum fork against the real 1inch LOP, pool manager, and
2.1.0 JIT adapter. **You still audit, vet, and deploy it** — your users trust Zyfai, not Cork —
and the guardrail stands: *"Zyfai-owned" says who is accountable, not what makes it safe*; the
wrapper is only safe because it structurally forces the receiver, holds nothing, and has been
audited. (Cork can share the full analysis and on-chain evidence — the "Scope & Ownership"
write-up — on request.)

**B. Markets in this flow have their pool-level access whitelist turned OFF — by construction.**
The just-in-time mint inside a fill is performed by Cork's adapter contract. A market created with
its whitelist *enabled* would refuse that adapter, so every purchase would revert
(`MintUnavailable`). The order builders always create markets with the whitelist off, and it isn't
a knob you can turn — this item exists so nobody asks for a gated pool and then wonders why nothing
fills.

**C. Know which spender model your route uses — and one approval you should NOT grant.**
On the **raw route**, two approvals go to two different spenders: the premium you pay (CA, sUSDe)
is approved to the **1inch exchange**, and the REF you hand in on exercise to **Cork's pool
manager**. It's the same `approve` call with two different spenders — easy to wire wrong, and your
allow-list must permit both explicitly. On the **`*ForSelf` adapter route, every approval goes to
the adapter itself** — CA for the fill, REF *and cST* for the exercise — never to the LOP or the
pool manager (each action's exact needs are machine-readable in the artifact's
`data.forSelf.allowances`). On either route, do **not** approve the cST to the pool manager: when
you exercise, the pool manager moves your cST through an internal transfer path that skips the
allowance check whenever the token's owner is the caller (source-verified 2026-07-28: the 4-arg
`PoolShare.transferFrom` skips `_spendAllowance` when `sender == owner`). A cST approval to the
pool manager can therefore never legitimately be spent — it just sits there as standing risk. The
same goes for cPT if you ever exit an underwriter position.

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

**G. Addresses drift; read them live.** Pull the deployment from `ch query protocol-config` and
the registry stack from `ch query registry-assets` — the whole registry stack was redeployed
2026-07-31, so anything cached before then is stale. Installed copies of the tool pick up
redeployed addresses automatically within an hour (remote config), so reads need no update from
you. The current venue pool list is `api-phoenix.cork.tech/v1/pools/`.

---

## 6. What you need to do (checklist)

1. **Stand up the tool** — `claude mcp add` (or `ch` on PATH), confirm `cork_capabilities` returns 9
   tools. Optional: `CORK_RPC_URL` (own node), `ENVIO_API_TOKEN` (decentralized reads).
2. **Audit and deploy the receiver-forcing adapter** — Cork's reference `CorkForSelfAdapter` lives
   in [`Cork-Technology/cork-periphery`](https://github.com/Cork-Technology/cork-periphery) (one address, 14 entrypoints covering the pool actions and the 1inch
   fill); you audit, vet, and deploy it — or extend your own `*ForSelf`/AdapterProxy to the same
   shape.
3. **Load the whitelist** for the loop (your own adapter routes, not raw Cork): the fill and
   exercise routes (`fillOrderForSelf`, `exerciseForSelf`/`exerciseOtherForSelf` — or your
   equivalents) and the approvals for the route you chose (§5, item C — adapter route:
   CA/REF/cST → the adapter; raw route: CA→LOP, REF→PoolManager).
4. **Wire the four-step flow against the tool** — select + derive with `registry-*`/`derive-market`,
   RFQ with `submit rfq-open` / watch `rfqs`, **simulate every artifact before signing**, fill with
   `taker-fill` (target pinned), exercise with `prepare_phoenix`, reconcile with `track`.
5. **Confirm ownership + timeline back to Cork** — Cork needs no protocol change from you; it needs to
   know when your adapter routes will be ready so the pilot's fill/exercise path lands inside your
   trust boundary. Also confirm the RFQ package catalog (`packageIds`) and notional units for step 1d.

---

## 7. Finding the right command

You don't have to memorize any of the commands above: the tool documents itself two ways. And
because the MCP tools and the CLI are the same core, **an MCP tool's input fields *are* the CLI's
flags** — any MCP input object runs verbatim via `--input '<object>'`, so anything that can drive
the MCP server (Claude Code included) can also hand you the exact `ch` line for a script.

### 7a. `--explain` — the exact contract for one command

Every `ch <command>` accepts `--explain`. By default it prints a **human-readable contract** —
description plus a per-parameter breakdown with variants unfolded — then exits, no chain call. Add
`--json` when you want the raw JSON schema instead:

```sh
ch compute --explain                     # human-readable contract, all variants
ch compute cst-swap-rate --explain       # scoped to ONE variant
ch compute --explain --json              # the raw JSON schema
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
ch capabilities --json                                   # maturity of every tool + variant, as JSON
ch capabilities --topic compute                          # full docs for one tool
ch capabilities --topic signing                          # the sign→validate→broadcast guide for prepared artifacts
ch capabilities --search "swap rate" --json              # keywords -> matching tool/variant + ready-to-run examples
# alternative — the rest in one --input blob:
ch capabilities --input '{"search":"swap rate"}' --json
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
Lift the `input` object's fields straight onto the command line (`ch compute --chain-id 42161
--params '{…}'`) — or run the object verbatim with `ch compute --input '<that object>'`.

### 7c. Try it from Claude Code

With the `cork-defi` server installed (§4), prompts like these exercise the whole surface — start
with *"call `cork_capabilities` first"* when in doubt, so it grounds itself before acting:

> "Using cork-defi, derive the sUSDe / dUSDC market on Arbitrum that expires in 7 days, and give
> me the poolId and cST address."

> "What's the `ch` command to build an unsigned exercise bundle — 1000 cST out of pool
> `0x…`, receiver my Safe `0x…`?"

> "List the Cork registry recipes on Arbitrum and explain the difference between the fixed and
> liquidity recipes for my cover."

---

*Questions or a stale value? `ch capabilities` (search/topic) is the living manual — the authority on
tool state, examples, and maturity. For the deeper security analysis and the pilot's open items, ask
your Cork contact (Baptiste).*
