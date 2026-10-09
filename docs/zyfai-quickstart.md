# Cork × Zyfai: integration quick start

**Audience:** the Zyfai engineering team. **Assumes:** fluency with Safe and ERC-7579, 1inch LOP v4,
EIP-712 and ERC-1271, ERC-2612 permits, ERC-4626, CREATE2. **Chain:** Base (8453). Everything here
also runs on Arbitrum One (42161). Only the chain id and the asset addresses change, because each
Distribution set lives at identical addresses on both chains.

**Status (2026-10-09).** A chain hosts a set of contract generations. One of them is the primary.
On Base and Arbitrum One the primary is **`phoenix/v0.5`** (Distribution `phoenix/v0.5-rc.1`).
It runs Market Registry contracts release **0.6.0**. That release is the 0.5.0 registry
`0xe1f569f152bDB6eBB2d49cFd9d4aB98ECEe955c5` with a new JIT adapter, CorkLimitOrderAdapter 0.5.0 at
`0x960Cd94B31121806b1b0Ff02230D189Ad0310616`. It runs on the Phoenix 1.4.0-rc.1 pool manager
`0xcC17…0C2D`. Its JIT permit is one `bytes` signature, so a Safe can sign it through ERC-1271.

Two older sets stay active on both chains. Select one with `--generation <label>`:

- `phoenix/v0.4-rc.1` shares every contract with the primary except the JIT adapter
  (`0x3E01C558fc0854e92e6ef2a84c19D6Bf9D82B104`, which takes v/r/s permits only).
- `phoenix/v0.3-rc.1` is the previous set: contracts release **0.3.3** (registry
  `0xa78d8137B01058dD23e545b6557209eBBc9611F1`) on the Phoenix v1.3 pool manager. Most pools that
  the venue lists live there.

Arbitrum One also keeps `arbitrum-v1.1` active: the stack of its first 176 pools.

On 2026-10-09 the venue listed 584 pools on Base: 551 on the previous set and 33 on the primary.
Primary pools are short-dated, so pick a live one when you run the examples. A prepare targets the
primary unless you pass `--generation`. A read of an existing pool follows the generation of that
pool.

We ran every example below live on Base on 2026-10-09 with cork-cli `0.7.1-rc.1`. The trimmed
responses come from that run. Use them for orientation, and take the real values from the tool:
`ch query protocol-config` lists every generation with every address and wire. Never hardcode an
address.

This handoff has two parts. Part one is a compact model of what Cork gives you and where your
agent plugs in. Part two is `cork-cli`, a helper that you drive from an MCP client or the shell.
It reads state, derives markets, builds unsigned transactions and simulates them. It never signs
and never holds funds.

---

## 1. What Cork is

Cork is middleware for tokenized, tradeable downside cover. A Cork market tokenizes one covered
position into two ERC-20 legs.

| Term | Meaning | Who holds it |
|---|---|---|
| **REF** | the asset your user is exposed to and wants cover on. The registry lists the approved assets. Read the list; do not assume. | the user |
| **CA** | the liquid collateral asset that the cover pays out. Pilot: **sUSDe**, `0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2`, 18 decimals. | the pool |
| **cST** | the cover token: the right to swap REF for CA at the market's tracked rate before expiry | **Zyfai (demand)** |
| **cPT** | the principal token: the underwriter's leg plus the premium | **bond.credit (supply)** |

One naming rule applies to the whole page. A **cork-pool** is one concrete expiry of a
**market**: an instance of it. The CLI accepts `pool` and `market-instance` as synonyms for
`cork-pool`. Despite the word, a cork-pool is not an AMM liquidity pool. It is a covered position,
tokenized into the two legs above. A **trading-pair** is a pair listed on the LOP venue book. The
**orderbook** holds the resting orders of that pair.

The pool id is the keccak of the on-chain `Market` struct of the pool, so you can derive it
off-chain before the pool exists. Markets are short-dated, and you pick the term. A **recipe**, an
approved contract, sets the rate rules. Four are live. **fixed**: the rate never moves.
**liquidity**, in two flavors that share one policy and differ only in the source of the rate:
**price** (a market feed, the depeg view) and **nav** (the vault's own accounting, the book-value
view). **impairment**: a window sized from an annual yield spread. **The recipe decides what the
cover pays.** A liquidity recipe gives an exit. The impairment recipe gives downside protection
(step 1b). The registry limits market life: `maxExpiryDuration` is 30 days. A fill that would
create a longer market reverts.

**You are the demand side.** You buy cST cover on a position that your yield agent manages, and
you exercise it on impairment. The underwriter is the supply side. It prices and sells the cover
and holds cPT. Settlement is atomic on 1inch LOP v4. The fill mints cST and cPT just in time
(JIT), so nobody pre-funds inventory.

---

## 2. The flow end to end

The flow has four steps, seen from the demand side. Each step has a `ch` command that returns an
unsigned artifact or a plain read. You sign and broadcast with your own stack.

| # | Step | What happens | Tool |
|---|---|---|---|
| 1 | **Select the asset and open an RFQ** (off-chain) | Pick REF, CA, recipe and term from the registry. Derive the market they name. Open a request-for-quote on the venue. | `ch query registry-*`, `ch query derive-cork-pool`, `ch submit rfq-open` |
| 2 | **The underwriter answers and rests a SELL order** | The underwriter answers with priced options. Each option carries its signed SELL order. The underwriter then rests that order on the book: makerAsset is the cST, takerAsset is CA. The cST does not exist yet; the order carries the market. | `ch query rfq`, `ch query orderbook`, `ch decode order` |
| 3 | **You buy the cST** by filling that order | Verify, build, simulate, then fill on the LOP. If the market is new, the adapter creates it and mints the cST to your Safe in the same transaction. | `ch fill`, `ch track simulate` |
| 4 | **You exercise** the cST | Hand in cST plus REF, and receive CA at the market's rate. This is a direct Phoenix call, not an LOP fill. | `ch compute cst-swap-rate`, `ch exercise`, `ch track simulate` |

Three facts shape the flow.

- **Market identity is pinned at signing.** The order carries its resolved rate constraint. So the
  pool id and the cST and cPT addresses are fixed the moment the maker signs the order. The fill
  checks staleness instead: if the live rate has left the carried window, the fill reverts
  `RecipeRejectedConstraint`. It keeps reverting until the maker signs a fresh constraint.
- **The tool picks the fill flavor.** `fillOrderArgs` for an EOA maker, `fillContractOrderArgs` for
  a Safe maker. A wrong guess reverts `BadSignature`.
- **Redeem is a supply-side action.** You hold cST only. Your terminal move is exercise, never
  redeem. An unexercised cST is worthless after expiry.

Before step 1 comes one preparation per pair, done once: the rate oracle of the pair. It is
permissionless, idempotent and optional, because a JIT fill deploys a missing oracle itself. On the
primary registry the sUSDe/mwUSDC oracle is not deployed yet. This changes one detail in step 1:
the anchor rate. After step 4, or instead of it near expiry, comes rollover.

---

## 3. The flow, step by step

Every command below ran live on Base on 2026-10-09. Each returns an unsigned artifact or a plain
read. A trimmed response follows each command. Conventions:

- Replace `0xYOUR_SAFE` with the Safe you drive.
- The action is a subcommand, and its fields are flags: `ch exercise --pool-id 0x… --cst-shares-in
  1000e18`. Every subcommand has `--help` and `--explain`. A mistyped action gets a did-you-mean.
- Amount flags take exact sugar: `1000e18`, `1_000000`. Spelling is forgiving: `--pool-id`,
  `--poolid` and `--poolId` are one flag.
- The canonical wire form works everywhere: `--input '{…}'` with the full object. A flag overrides
  the same key in the blob. An MCP call carries exactly that object.
- `--client-request-id` names the request. To retry the same request, reuse the id. For a new
  request, use a new id. For orders the id decides the invalidator bit: two live orders that share
  an id kill each other.
- Output is prose by default. A bare `--json` returns the raw envelope. The responses below are
  that JSON, trimmed.

The pair used throughout:

| Role | Asset | Address | Decimals |
|---|---|---|---|
| **REF**, what the user is exposed to | mwUSDC (Moonwell Flagship USDC) | `0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca` | 18 |
| **CA**, what the user is paid on exercise | sUSDe | `0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2` | 18 |

In the tool, CA is `collateralAsset` and REF is `referenceAsset`.

### Step 1: select the asset and open an RFQ

RFQs have no UI. Use the CLI or MCP. The same core also ships as the typed `@cork/core` SDK
([sdk.md](sdk.md)).

#### 1a. Pick the REF asset

The registry lists the assets it approves. Each entry describes the price and NAV sources of the
asset. Look one up by address:

```sh
ch query registry-assets --chain-id 8453 --address 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca --json
```
<!-- example: output data.items.0 -->
```jsonc
// data.items[0]; data also names registry 0xe1f569f1…55c5, contractsVersion 0.6.0, generation phoenix/v0.5
{ "address": "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca", "name": "mwUSDC", "kind": "ERC4626",
  "priceSource": null,
  "navSource":   { "address": "0xc1256Ae5…A2Ca", "sourceType": "NAV", "sourceInterface": "ERC4626",
                   "denomination": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },   // USDC, by unit address
  "token": { "decimals": 18, "symbol": "mwUSDC", "name": "Moonwell Flagship USDC" } }
```

Each asset carries up to two source slots. `priceSource` is what the market says the asset is
worth: a Chainlink-style aggregator. `navSource` is what the asset's own accounting says, here the
vault's `convertToAssets`. mwUSDC carries only `navSource`; sUSDe carries only `priceSource`. That
decides the oracle mode for the pair: it composes as `nav` only. This is why every step below
says `nav`. Fourteen assets are registered on Base today; `ch query registry-assets --chain-id
8453` lists them.

Two supporting tables show how sources compare. Denominations map a unit to its symbol. On the
0.5.0 registry the key is the unit address (five on Base: USD, ETH, wstETH, USDC, cbETH). Feeds
are directed conversion edges with live answers (four on Base: ETH, USDC and cbETH into USD, and
wstETH into ETH). A pair whose sources have no path to a common unit cannot get a price oracle.

```sh
ch query registry-denominations --chain-id 8453 --json
ch query registry-feeds --chain-id 8453 --json
```

#### 1b. Pick the cover, and with it the recipe

First decide what you want the cover to pay. The recipe decides that, not the RFQ `modes`. The
modes name the alternatives you accept, and nothing on chain reads them. A request carries one
market template, so it describes one cover. Open one request per cover.

| Cover | Recipe | The pool's rate | A loss in the reference | RFQ mode to name |
|---|---|---|---|---|
| **Liquidity (duration-risk) cover**: an exit | LiquidityPriceRecipe, LiquidityNavRecipe | follows the oracle: window 1 wei to 2x the anchor, one whole anchor of movement a day | **not paid**. The rate falls with the reference, so you hand in more reference for the same collateral | `liquidity_only` |
| **Impairment (credit-risk) cover**: downside, with a deductible | ApySpreadImpairmentRecipe | held in a band: anchor ± `apy_spread × duration / 365 d`, one day of the spread of movement a day | **covered beyond the part of the band the rate has given up**. The whole band is your worst-case deductible | `liquidity_impairment` |
| **Fixed-rate cover**: downside, frozen | FixedRateRecipe | never moves: the window is the rate to the rate plus 1 wei | **covered in full below the frozen rate**. The pool does not track the yield of the reference after creation | `fixed_rate` (venue 0.4.4) |

We measured the difference on a Base fork against the deployed `phoenix/v0.4-rc.1` contracts
(2026-10-01). We used three pools over USDC and baseUSD with the same expiry, one per recipe. The
fixed pool froze the oracle's rate at creation. The reference vault took a real 10% loss. One hour
later the holder exercised 100 cST on each pool:

| | Reference handed in | Its value after the loss | Collateral received | Payout of the cover |
|---|---|---|---|---|
| Liquidity cover | 101.835 baseUSD | 100.000 USDC | 100.000 USDC | **0.000 USDC** |
| Impairment cover (10% a year over 14.4 days: a 0.394% band) | 91.828 baseUSD | 90.173 USDC | 100.000 USDC | **9.827 USDC** |
| Fixed-rate cover (frozen at the rate at creation) | 91.652 baseUSD | 90.001 USDC | 100.000 USDC | **9.999 USDC** |

The band is the worst-case deductible, not the deductible on every day. The rate of the impairment
pool walks toward its floor at one day of the spread per day. One hour after the loss, the rate had
given up only the burst capacity (0.19% of the anchor). So the payout was 9.827. When the rate
reaches the floor, the payout is the loss less the whole band.

Liquidity cover answers duration risk: you cannot sell or redeem the reference at its book value
in time. It does not protect you against a loss of value in the reference. Impairment cover
answers credit risk: the reference loses value.

**A loss that the share price does not report moves no rate.** The liquidity and impairment
recipes read the rate oracle, and a NAV oracle reads the vault's reported share price. A
fixed-rate pool reads no feed. MetaMorpho v1.1 vaults keep realized bad debt out of that price:
they add it to `lostAssets`. So on those vaults the pool's rate does not move on bad debt, under
either recipe. You can still swap at the reported price while the pool has collateral. The
underwriter carries any open shortfall, so expect it to price that risk or to pass. YCSUSDC and
sparkUSDC are such vaults on Base today. Neither has an open shortfall. The `lostAssets` counter
never decreases, and the owner of YCSUSDC covered its 131.38 USDC loss through `address(1)` (read
2026-10-01). For a NAV-sourced recipe, `ch submit rfq-open` reads `lostAssets()` and that cover.
When the reference has the counter, it warns `reference_loss_unreported` with the open shortfall.
`data.cover.notRead` lists what the tool could not read.

A recipe is an approved contract address. Copy it from the registry, never from a chat message:

```sh
ch query registry-recipes --chain-id 8453 --json
```
<!-- example: output data -->
```jsonc
// data, trimmed: the primary's registry
{ "generation": "phoenix/v0.5", "registry": "0xe1f569f152bDB6eBB2d49cFd9d4aB98ECEe955c5", "contractsVersion": "0.6.0",
  "items": [
    { "address": "0x679Cbd016587c423f342e5Ba31e58356228c964d", "source": "price" },   // LiquidityPriceRecipe
    { "address": "0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3", "source": "nav"   },   // LiquidityNavRecipe: this pair
    { "address": "0xEC26bb7d911aFe374721Ecd963543f7e52468C49", "source": "fixed" },   // FixedRateRecipe
    { "address": "0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9", "source": "nav"   }    // ApySpreadImpairmentRecipe
  ] }
```

The previous set has its own registry and its own four recipes. Add `--generation phoenix/v0.3-rc.1`
to list them. A recipe works only on the registry that approves it.

The liquidity policy: the rate may fall to 1 wei (`rateMin`) and may never exceed twice the anchor
(`rateMax`). It may move one anchor per day (`rateChangePerDayMax`), with a total budget of three
(`rateChangeCapacityMax`). In practice the rate follows the oracle: in the measurement above, it
had tracked the whole 10% loss within the hour.

The impairment policy: you choose a duration and an annual spread. The band is
`apy_spread × duration / 365 d`. The rate may move one day of the spread per day, with seven days
of it available as a burst. Each recipe states its own limits, and the limits differ per
generation. The 0.5.0 recipe (on the primary and on `phoenix/v0.4-rc.1`) caps the spread at 100%
a year and the duration at 30 days. The duration must also fit inside the pool's remaining life at
the fill that creates the pool. The tool restates none of these limits. `rfq-open` asks the recipe
(`resolve`, then `verify` with the pool expiry your block names). It returns the recipe's answer in
`data.cover.resolved`, or a warning. The recipe rejects a duration above the pool's remaining life
when the pool is created, and the fill then reverts `RecipeRejectedConstraint`. `rfq-open` warns
`would_revert` and names that cause. Ask the recipe what a choice commits you to. Pass three
words: the anchor, the duration in seconds, and the spread on the percentage scale (1e18 = 1%, so
10% a year is `10000000000000000000`):

```sh
ch compute recipe-rate-constraint --chain-id 8453 --json \
  --recipe 0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9 \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca \
  --args-uints '["871637111019090856","1209600","10000000000000000000"]'
```
<!-- example: output data -->
```jsonc
// captured 2026-10-01: 14 days at 10% a year around the anchor 0.871637 = a 0.3836% band
{ "recipe": "0xd5e8F76A…0Ed9", "source": "nav",
  "constraint": { "rateMin": "868293845387784755", "rateMax": "874980376650396957",
                  "rateChangePerDayMax": "238804687950435", "rateChangeCapacityMax": "1671632815653050" },
  "rateOracle": { "address": "0x6df4a5EE…5836", "status": "predicted", "mode": "nav", "rate": null } }
```

`rateMin` is the worst rate you would ever swap at. For a pool that exists,
`ch compute impairment-floor --pool-id …` returns the worst rate over a horizon. `ch query
cork-pool` returns `data.cover`, read from the four limits of the pool. Both rate-change
allowances at zero means fixed-rate cover. Else, a `rateMin` of at most 1 wei means liquidity
cover. Else, the pool holds a band.

The fixed-rate policy: you choose one rate (1e18 = 1.0). One reference then swaps for that much
collateral for the pool's whole life. First read the reference's rate (`ch query registry-oracle`).
At that rate you lock in today's value. Below it, the gap is your deductible. Above it, the cover
pays the gap at once, with no loss at all. `rfq-open` then warns `fixed_rate_in_the_money`, and an
underwriter prices that gap as a certain payout or passes. The rate is part of pool identity:
another rate is another oracle and another pool. To ask for this cover, name
`modes: ["fixed_rate"]` and an inline template with the fixed recipe and a `cork-inline-fixed/1`
block:

```jsonc
{ "inline": { "oracle_recipe": "0xEC26bb7d911aFe374721Ecd963543f7e52468C49",
              "oracle_params": { "schema": "cork-inline-fixed/1", "rate_override": "1075000000000000000",
                                 "expiry": "1796256000", "swap_fee_wad": "0", "unwind_swap_fee_wad": "0" } } }
```

The venue refuses a fixed-rate request without a valid `rate_override` (a decimal string, no
leading zero). The tool refuses it first and gives the reason.

#### 1c. Check the pair's oracle, then derive the market

The go/no-go check for a pair:

```sh
ch query registry-oracle --chain-id 8453 --json \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca --oracle-mode nav
```
<!-- example: output data -->
```jsonc
{ "generation": "phoenix/v0.5",
  "oracle": { "address": "0x6df4a5EEd8dC546682253F5FDf2c1d8E17965836", "deployed": false, "deployable": true } }
```

Read `oracle` as an answer with three states. `deployed: true` means the pair prices today and
`rate` is live. `deployed: false, deployable: true` means the first fill deploys the oracle; you
lose nothing by waiting. `deployable: false` means the pair is not viable as asked. `reason` names
the registry's own error, and the fix is a registration on Cork's side.

**This pair's oracle is not deployed on the primary yet.** The liquidity recipe reads the live
oracle when one exists. When none exists, it needs an anchor rate. A good anchor is the live rate
on the previous registry, where this pair's oracle has run since August:

```sh
ch query registry-oracle --chain-id 8453 --json --generation previous \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca --oracle-mode nav
# → "generation": "phoenix/v0.3-rc.1",
#   "oracle": { "address": "0x9a1d1213…BF0E", "deployed": true, "rate": "871637111019090856", "rateScale": "ABSOLUTE, 1e18 = 1.0" }
#   (the rate on 2026-09-25; a NAV rate moves, and the examples below keep this anchor)
```

Now ask the recipe what it would commit you to. A fill runs this same staticcall. Pass the anchor
as one uint word; the tool encodes it:

```sh
ch compute recipe-rate-constraint --chain-id 8453 --json \
  --recipe 0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3 \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca \
  --args-uints '["871637111019090856"]'
```
<!-- example: output data -->
```jsonc
{ "recipe": "0xed6A6b04…87e3", "source": "nav",
  "constraint": { "rateMin": "1", "rateMax": "1743274222038181712",
                  "rateChangePerDayMax": "871637111019090856", "rateChangeCapacityMax": "2614911333057272568" },
  "rateOracle": { "address": "0x6df4a5EE…5836", "status": "predicted", "mode": "nav", "rate": null },
  "note": "no live oracle — the recipe resolved from its fallback (e.g. the anchorRate in args); the eventual fill deploys the oracle and re-checks with recipe.verify against the LIVE rate" }
```

Without the anchor, the call refuses with `recipe_refused` and `MalformedExtraData`. Once the
oracle is deployed, the recipe ignores the anchor and reads the chain.

Then derive the market. The registry limits the term (30 days). With CA, REF, recipe and expiry
chosen, you have named a market. Derive what a fill would create, before anything exists:

```sh
EXP=$(( $(date +%s) + 7*86400 ))
ANCHOR_HEX=0x$(printf '%064x' 871637111019090856)     # abi.encode(uint256 anchorRate)
ch query derive-cork-pool --chain-id 8453 --json \
  --collateral-asset 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 \
  --reference-asset 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca \
  --expiry "$EXP" --recipe 0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3 --args "$ANCHOR_HEX"
```
<!-- example: output -->
```jsonc
{ "state": "ok", "data": {
  "recipe": "0xed6A6b04…87e3", "source": "nav",
  "oracle": { "address": "0x6df4a5EEd8dC546682253F5FDf2c1d8E17965836", "deployed": false, "deployable": true, "mode": "nav" },
  "pool":   { "poolId": "0x22eeb2b19fa6d4d0434f468cb03ce77f2d6870128a5a2c64453562db4651b858", "exists": false, "wire": "10-field",
              "constraint": { "rateMin": "1", "rateMax": "1743274222038181712", "rateChangePerDayMax": "871637111019090856", "rateChangeCapacityMax": "2614911333057272568" },
              "swapFeePercentage": "0", "unwindSwapFeePercentage": "0" },
  "shares": { "corkSwapToken": "0xE3a3b5Df61Fd654D3f012466a89764EF670B5683",
              "corkPrincipalToken": "0x011B3FF6a26A8E867b6b8f0880A807790014f474", "source": "simulated" } },
  "warnings": [ { "code": "oracle_not_deployed", "message": "…identity derives against the PREDICTED oracle address; the fill deploys it in-tx…" } ] }
```

What to check:

- **`pool.exists: false`** means the first fill creates the pool. **`corkSwapToken`** is the cST you
  will buy.
- **`pool.wire: "10-field"`**: on the primary, the two fee percentages are part of the pool id.
  Pass the fees you will create with, or the id names a different pool. Zero is the live default.
- **`constraint`** is what the underwriter's order will sign. Carry it verbatim into any order you
  build yourself. A NAV rate can tick between two resolves minutes apart. The re-resolved
  constraint then names a different pool. The tool still builds the mismatched order, but it
  warns `jit_side_mismatch`: the fill would revert `OrderNotForPool`.
- **The anchor you passed (`--args`) is the anchor you publish in the RFQ**, and `--expiry` is
  its expiry. On a pair
  whose oracle is not deployed, the anchor lets an underwriter who reads at a different moment land
  on this exact `poolId`. On a pair whose oracle is deployed, the recipe ignores the anchor and
  reads the live rate at the moment the underwriter signs. So the pool that the order creates
  follows the underwriter's derivation. Compare its `answer.pool.poolId` with yours before you
  fill.

The steps below use this market: `poolId` `0x22eeb2b1…b858`, cST `0xE3a3b5Df…5683`.

#### 1d. Open the RFQ

An RFQ is an off-chain venue posting: the parameter envelope that underwriters answer against.
Every field is one of your choices from 1a to 1c.

Every RFQ write is proven (venue RFQ v2). First send the same request through `ch prepare order
rfq-write --chain-id 8453 --account 0xYOUR_SAFE --client-request-id rfq-0001 --request
'{"type":"rfq-open",…}'`. Sign its `data.typedData` with your Safe, and pass that signature as
`--auth`. The tool checks your Safe's `isValidSignature` before it relays.

```sh
VU=$(( $(date +%s) + 3600 ))
ch submit rfq-open --chain-id 8453 --client-request-id rfq-0001 --json \
  --kind new_position --requester 0xYOUR_SAFE \
  --reference-asset 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca \
  --collateral-asset '{"exact":"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"}' \
  --modes '["liquidity_only"]' --package-ids '["balanced-v1"]' \
  --expiry-window "{\"notBefore\":$((EXP-1)),\"notAfter\":$EXP}" \
  --market-template "{\"inline\":{\"oracle_recipe\":\"0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3\",\"oracle_params\":{\"schema\":\"cork-inline-liquidity/1\",\"anchor_rate\":\"871637111019090856\",\"expiry\":\"$EXP\",\"swap_fee_wad\":\"0\",\"unwind_swap_fee_wad\":\"0\"}}}" \
  --notional-assets … --valid-until $VU --auth '{"method":"signature","signature":"0x…"}'
```

Conventions the live flow uses:

- `modes` must match the recipe (step 1b): `["liquidity_only"]` with a liquidity recipe,
  `["liquidity_impairment"]` with the impairment recipe, `["fixed_rate"]` with the fixed recipe.
  The result carries `data.cover`. It names the kind of cover the request buys and the recipe's
  own rate limits for it (`resolved`). For impairment it adds the band. For fixed-rate it adds the
  position of the frozen rate against the reference's rate today. The tool relays a request whose
  mode and recipe disagree, with a `cover_mode_mismatch` warning. An impairment mode on a
  liquidity recipe is priced as downside cover, but it creates an exit-only pool.
- `packageIds: ["balanced-v1"]` is the live package. Confirm the catalog and the
  `notionalAssets` units with your Cork contact before your first post.
- Pin an exact expiry with `notBefore = notAfter - 1`.
- `oracle_recipe` carries the recipe's contract address. The venue stores it as free text, so a
  typo posts fine and fails only at fill time. Copy the address from `registry-recipes`.
- `oracle_params` carries the pool identity in the `cork-inline-liquidity/1` block: `anchor_rate`
  from 1c, the `expiry` you derived with, and the two fees as decimal strings. Never send `{}`.
  Without the block, an underwriter falls back to the end of the window and zero fees. A different
  expiry or fee names a different pool.
- You sign the RFQ with your own stack. `ch submit` checks the signer and relays; it never signs.

To ask for **impairment (credit-risk) cover** instead, change three things: the mode, the recipe
and the block. The block is `cork-inline-impairment/1`: the liquidity block plus `duration_seconds`
and `apy_spread_percentage` (1e18 = 1%). All three words are required. The tool never fills in a
partial block with zeros.

```sh
ch submit rfq-open --chain-id 8453 --client-request-id rfq-0002 --json \
  --kind new_position --requester 0xYOUR_SAFE \
  --reference-asset 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca \
  --collateral-asset '{"exact":"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"}' \
  --modes '["liquidity_impairment"]' --package-ids '["balanced-v1"]' \
  --expiry-window "{\"notBefore\":$((EXP-1)),\"notAfter\":$EXP}" \
  --market-template "{\"inline\":{\"oracle_recipe\":\"0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9\",\"oracle_params\":{\"schema\":\"cork-inline-impairment/1\",\"anchor_rate\":\"871637111019090856\",\"expiry\":\"$EXP\",\"swap_fee_wad\":\"0\",\"unwind_swap_fee_wad\":\"0\",\"duration_seconds\":\"1209600\",\"apy_spread_percentage\":\"10000000000000000000\"}}}" \
  --notional-assets … --valid-until $VU --auth '{"method":"signature","signature":"0x…"}'
```

Read the answers before you rely on the cover. Each underwriter decides its own supply. A `pass`
means that no underwriter quotes that recipe for the pair yet. Raise it with your Cork contact. Do
not fall back to a liquidity recipe under the impairment mode.

Then watch for answers:

```sh
ch query rfqs --chain-id 8453                      # every open RFQ
ch query rfq  --chain-id 8453 --rfq-id 'rfq_…'     # one RFQ with all its answers
ch query rfqs --chain-id 8453 --watch              # alert when a requester accepts a quote nobody rested
```

### Step 2: the underwriter answers and rests a SELL order

This step belongs to the underwriter. But you can watch every part of it, and you should verify
the result before you buy. An answer carries priced options that echo your template. Each quoted
option also carries the full signed SELL order behind it (`order`, plus the venue's `order_hash`
when you read it back):

```jsonc
{ "status": "quoted", "options": [ {
  "option_id": "…-liquidity_only-<expiry>", "mode": "liquidity_only", "package_id": "balanced-v1",
  "market_template": { "inline": { "oracle_recipe": "0xed6A6b04…87e3",
      "oracle_params": { "schema": "cork-inline-liquidity/1", "anchor_rate": "871637111019090856", "expiry": "<EXP>", "swap_fee_wad": "0", "unwind_swap_fee_wad": "0" } } },
  "premium_annualized": "0.032",        // a fraction string: 0.032 is 3.2%
  "fresh_until": 1790340000 } ] }
```

The underwriter then rests a signed SELL order on the venue book: `makerAsset` is the cST,
`takerAsset` is CA. The cST does not exist yet. The signed order carries the market's recipe and
constraint, and these pin the cST address. The mint happens inside your fill, and the
underwriter's collateral funds it. The tool builds exactly that order for an underwriter. Here is
the order we built against the market from 1c, decoded from its own bytes:

```sh
ch query orderbook --chain-id 8453 --json --pool-id 0x22eeb2b19fa6d4d0434f468cb03ce77f2d6870128a5a2c64453562db4651b858 --account 0xYOUR_ADAPTER
ch decode order --chain-id 8453 --data '{…the signed order row…}' --json
```
```jsonc
{ "state": "ok", "data": { "jit": {
  "verification": "trusted", "generation": "phoenix/v0.5", "wire": "nested",
  "adapter": "0x960Cd94B31121806b1b0Ff02230D189Ad0310616",
  "collateralAsset": "0x211Cc4DD…5fE5d2", "referenceAsset": "0xc1256Ae5…A2Ca",
  "recipe": "0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3", "rateOverride": "0",
  "constraint": { "rateMin": "1", "rateMax": "1743274222038181712", "rateChangePerDayMax": "871637111019090856", "rateChangeCapacityMax": "2614911333057272568" },
  "extraData": "0x…anchor…", "enableJitMint": true } } }
```

Read `generation` and `wire`. `phoenix/v0.5` and `nested` name the primary's adapter. Its payload
wraps the creator's `MarketParams`: `extraData`, `oracleSalt`, and the two fees, which are part of
the pool id. `phoenix/v0.4-rc.1` names the older adapter `0x3E01…B104` on the same wire. A row
that decodes to `phoenix/v0.3-rc.1` and `flat` names the 0.3.3 adapter
`0x8902a88912a334263fe3d731d03c267715b9374f`. The tool identifies the adapter first, and then
decodes with the layout of that generation. It never decodes by trial.

Pass your adapter as `--account`. The tool ranks the book for the address that calls the LOP. For
a ForSelf wallet, that address is the adapter, not the Safe. An empty book is a normal result:
markets are short-dated, and the book refills in waves. Never reuse an order hash from a document.

**The JIT permit rule.** Nobody can pre-approve a token that does not exist yet. So the order
carries the maker's ERC-2612 permit over the predicted cST. The party being served (the
underwriter) signs it, the spender is always the 1inch LOP, and the permit executes right after
the mint. This is the maker's problem, never yours. On the `fillOrderForSelf` route the two
allowance systems never touch: your taker-asset approval goes to your ForSelf adapter.
[jit-order-anatomy.md](jit-order-anatomy.md) is the contract-level reference.

### Step 3: buy the cST by filling the order

Your users are ERC-1271 smart accounts, so fills use `fillContractOrderArgs`. The tool selects it.
Three commands: verify, build, dry-run.

```sh
# 1. Verify the market on chain. Before the first fill the pool does not exist; that read answers
#    pool_not_found, which is the expected pre-creation state. Verify the order's carried constraint
#    with `ch decode order` instead.
ch query cork-pool --chain-id 8453 --json --pool-id 0x22eeb2b19fa6d4d0434f468cb03ce77f2d6870128a5a2c64453562db4651b858

# 2. Build the unsigned fill through your ForSelf adapter (an OPEN orderHash from step 2).
ch fill --chain-id 8453 --account 0xYOUR_SAFE --client-request-id buy-0001 --json \
  --order-hash 0x… --fill-making-amount 1000e18 \
  --for-self '{"adapter":"0xYOUR_ADAPTER","poolId":"0x22eeb2b19fa6d4d0434f468cb03ce77f2d6870128a5a2c64453562db4651b858"}'

# 3. Dry-run the frozen bytes. Paste the artifact object from step 2.
ch track simulate --chain-id 8453 --subject '{"kind":"artifact","artifact":{…}}' --json
```

Then sign the calldata with your Safe stack and broadcast it. What to check:

- `unsigned_artifact` on the prepare is expected. Require `wouldRevert: false` from the simulate.
- **One fill lands, so size it for everything you want.** Cork orders use the 1inch bit
  invalidator: the first fill of any size spends the whole order.
- The tool refuses a dead row before it builds bytes. It reads the order's invalidator on chain
  (`status_mismatch`). It verifies the maker's signature and extension the way the fill does. It
  sets aside a row whose maker cannot deliver (`maker_not_ready`). It also refuses an order
  reserved for another sender (`private_order`), and an order whose extension names a contract it
  does not know.
- With `--for-self`, the bought asset goes to the caller, and taker interactions are impossible.
  The taker-asset allowance goes to the adapter, never the LOP. The tool first verifies the
  adapter's on-chain bindings and refuses a mismatch (`adapter_binding_mismatch`).
- Some SELL rows carry a decaying premium. The tool detects them, caps at the curve's ceiling and
  reports `data.auction`. Re-price and simulate close to broadcast.
- `data.execution` names the completion path. `ch capabilities --topic signing` is the guide.

### Step 4: exercise the cST

When your risk monitor sees impairment on the user's REF, exercise the cover. Hand in cST plus
REF, and receive CA at the market's tracked rate. This is a direct Phoenix call with no
counterparty, so it works exactly when the market is stressed.

The pool fixes the arithmetic, so size the call before you build it. One cST plus `1 / swapRate`
REF buys one CA. The pool takes its swap fee from the CA leg only. So the CA you receive depends
on the cST you hand in and on the fee. The REF you pay depends on the rate, and the rate moves.
Your cap protects that number.

Your pair has no pool before its first fill. So this run uses a live pool on the primary, with
USDC as CA (6 decimals). Pick a pool that has not expired: `ch query cork-pools --chain-id 8453`
lists the pools with their expiry. The run below used USDC/YCSUSDC, `0xe12aef66…319d`, which
expires on 2026-10-16. The tool follows the pool's generation, and the commands are the same for
your pair.

```sh
POOL=0x…    # a live pool from ch query cork-pools

# 1. Preview: what do 1000 CA cost in cST plus REF right now?
ch compute cst-swap-rate --chain-id 8453 --json --pool-id "$POOL" --collateral-assets-out 1000e6
```
<!-- example: output -->
```jsonc
{ "state": "ok", "data": {
  "generation": { "label": "phoenix/v0.5", "status": "active", "distribution": "phoenix/v0.5-rc.1", "alsoIn": ["phoenix/v0.4-rc.1"] },
  "swapRate": "1076509000000000000", "cstSharesIn": "1000000000000000000000",
  "referenceAssetsIn": "928928601618750981181", "fee": "0",
  "scales": { "swapRate": "1e18 = 1.0 (WAD)", "cstSharesIn": "cST shares, always 18-decimals",
              "referenceAssetsIn": "native decimals of the reference asset (18)", "fee": "native decimals of the collateral asset (6)" },
  "collateralDecimals": 6, "referenceDecimals": 18 } }
```

Read it as: 1000 CA out cost 1000 cST plus 928.93 REF at 1.076509 CA per REF, with no fee.
`alsoIn` says that the pool manager is shared: the same pool is reachable through
`phoenix/v0.4-rc.1`. Three numbers size the build. `cstSharesIn` is exact. `referenceAssetsIn`
plus a margin becomes `maxReferenceAssetsIn`. The margin covers a rate move before broadcast, and
the unspent part comes back. `collateralAssetsOut` minus a small margin becomes
`minCollateralAssetsOut`. A zero preview means the market cannot pay right now. It does not mean
the cover is free.

```sh
# 2. Build the unsigned exercise. Bounds from the preview: 1000e18 cST in, floor 995 CA out,
#    cap 1100e18 REF in (18% over 928.93). Take the numbers from YOUR preview.
ch exercise --chain-id 8453 --account 0xYOUR_SAFE --client-request-id exercise-0001 --json \
  --pool-id "$POOL" \
  --cst-shares-in 1000e18 --receiver 0xYOUR_SAFE --min-collateral-assets-out 995e6 --max-reference-assets-in 1100e18

# 3. Dry-run. Paste the artifact object from step 2.
ch track simulate --chain-id 8453 --subject '{"kind":"artifact","artifact":{…}}' --json
```

Read the build's `summary` before you sign. It has four legs, in execution order:

```text
1. fund via Permit2: pull 1000000000000000000000 of cST (0x9452…4647) from you into the adapter (0x71eB…84A7)
2. fund via Permit2: pull 1100000000000000000000 of reference (0xE74c…ED56) from you into the adapter (0x71eB…84A7)
3. run Cork 'safeExercise' on the adapter (0x71eB…84A7) — proceeds to you (0xYOUR_SAFE)
4. return the entire remaining balance of reference (0xE74c…ED56) to you (0xYOUR_SAFE)
```

Check three things. The two pulls match your cST count and your REF cap. Leg 3 names your Safe
after "proceeds to". Leg 4 returns the unspent REF to the same Safe; the `sweep_back` warning
announces that leg. The dry-run then answers `wouldRevert`. With an account that holds no cST, it
answers `true`, as an unfunded Safe would. Require `false` from your own run.

Once your ForSelf adapter is deployed, add `--for-self '{"adapter":"0xYOUR_ADAPTER"}'`. The
artifact then becomes a single `exerciseForSelf` call: no Bundler3 legs, output to the Safe, every
allowance to the adapter (`data.forSelf.allowances` lists them). Every prepared bundle expires,
and the default deadline is 30 minutes. For a slow signing ceremony, build with
`--deadline-seconds 7200` or pin `--deadline-at <unix seconds>`. A pinned deadline also makes a
retried prepare byte-identical.

The variant `exercise-other` pins the REF leg instead: you pass the exact REF you spend, cap the
cST and floor the CA. Its ForSelf twin is `exerciseOtherForSelf`.

Keep in mind: `exercise` has only the bounds you pass. Re-run the preview at send time. A paused
REF blocks the exercise leg, so keep positions small and monitor REF liveness.

### After the flow: roll the cover near expiry

Near expiry, roll the user's cover into the successor market. Do not let it lapse. A rollover is a
trade between two parties. A cPT holder, the supply side, signs the rollover order. The holder
offers to roll their principal together with you, and collects a premium. You are the filler: you
roll your user's cover and pay that premium. The rollover settlers of every active generation run on
both chains. To find open orders:

```sh
ch query rollover-orders --chain-id 8453 --kind orders      # the open rollover orders, newest first
```

One atomic `BaseFiller.execute` call does three things. It takes the user's expiring cST. It pays
the premium in the order's `premiumToken`. It delivers the fresh cST to the caller, the user's
Safe. You supply the premium token. So first swap some of the user's REF into it, in your own
stack.

`ch` builds the fill:

```sh
ch prepare order rollover-fill --chain-id 8453 --account <safe> --client-request-id <id> \
  --order-digest <0x…>                                       # unsigned BaseFiller.execute calldata
```

- BaseFiller pulls two things from the caller: the source cST, and at most `premiumCap` of the
  premium token. The result's `data.approvals` lists both allowances to BaseFiller, each with an
  unsigned approve transaction. It warns `approval_missing` when the chain shows that one is
  absent.
- The call has no recipient argument. The fresh cST and every refund go to the caller. BaseFiller
  accepts only its own two settlers. A session-key policy must admit `BaseFiller.execute` and the
  two approvals.
- The order's signed `allowPartialFills` flag picks the settler. An all-or-nothing order needs the
  full size, unless it allows underfill. A partial order takes `--filler-src-cst` for a slice.
- An order reserved for another filler needs the signature of that filler, `--filler-auth-sig`.
  The result explains how to get it.
- BaseFiller decides where the value goes. The user's clone decides how much value. The clone runs
  the hooks that its owner signed, under attesters that its owner chose. A mid-roll hook can keep
  the unwound collateral. `data.trust` reports the clone's attesters. It warns on any hook that the
  default attesters do not vouch for.
- `minDstPerSrc` is the only value check that the settler makes. Phoenix deposits and unwinds at
  exactly 1:1. So omit `minDstPerSrc`, and `ch` derives the honest rate from the previews of the
  two pools, with no tolerance (`dst_floor_derived`). When `ch` cannot derive it, `ch` refuses
  with `dst_floor_underivable`, and you pass `--min-dst-per-src`. Never send 0. A session-key
  policy that pins only (BaseFiller, execute) cannot enforce this floor, so your stack must keep
  it.
- Simulate with `ch track simulate` before you sign. The tool builds no bytes for an order whose
  fill deadline has passed. It also builds none for an order that the settler reports as settled,
  expired or cancelled.

---

## 4. `cork-cli`, the integration kit

**One typed core, two surfaces.** The same 9-tool dispatch runs as an MCP server (stdio or
Streamable HTTP) and as a CLI (`ch`). It reads live chain and venue state. It runs Cork's math
bit-exact against on-chain reads. It builds unsigned bytes and typed data. It never signs, never
holds custody and never broadcasts. The one tool with a side effect relays a payload that you
already signed.

**Install (MCP):**

```sh
claude mcp add cork-defi -- ch mcp        # the released binary; or "$(which bun)" /path/to/cork-cli/packages/mcp/src/bin.ts from a clone
claude mcp list                           # expect: cork-defi … ✓ Connected
# health check: call cork_capabilities with no arguments; a good install returns exactly 9 tools
```

`ch mcp --http` serves a Streamable HTTP endpoint with `/healthz`, `/readyz` and `/docs/<topic>`.

**CLI:** put `bin/` on PATH, or install the binary. [cli.md](cli.md) is the full reference. Every
action is a subcommand, with its fields as flags. The 13 pool actions and `fill` are also
top-level verbs. Query filter keys are flags. Amounts take exact sugar. Objects go as JSON-string
flags. The canonical wire blob `--input '{…}'` works everywhere. A bare `--json` switches the
output to the raw envelope. The runtime is Bun.

**The 9 tools:** `capabilities` (the searchable manual; start here), `query` (state reads),
`compute` (deterministic math), `decode` (bytes to labeled JSON, including a signed transaction
with signer recovery), `prepare_market`, `prepare_orders` and `prepare_phoenix` (unsigned
builders), `track` (verify, simulate frozen bytes, reconcile), `submit` (the only relay).

**Every prepared artifact tells you how to finish it.** `data.execution` carries the sign method,
the ordered next steps and a pointer to `ch capabilities --topic signing`.

**The envelope:** check `state` before you trust `data`. `ok`: use `data`. `unavailable`: the
tool cannot serve the call now, and `warnings[0].code` says why; do not retry blindly. `conflict`:
the tool found a mismatch; surface it. Exit codes mirror this (`0/2/3/4/1`). Money fields carry a
`scales` block. Read the labels: this page's pair is 18/18, but the USDC family has 6 decimals.

**RPC and secrets:** reads on mainnet, Arbitrum One and Base work out of the box. Set
`CORK_RPC_URL` only for your own node. Full-decentralized reads need an Envio token
(`ENVIO_HYPERSYNC_TOKEN`, from <https://envio.dev/app/api-tokens>). Never commit an RPC URL or a
token.

**Venue reads can lag; the chain wins.** The book, RFQ and fill feeds come from Cork's indexer,
which can trail the chain head. For anything time-sensitive, verify against the chain (`ch query
cork-pool`, `ch track`). The tool re-checks every venue row against the chain before it acts on
the row. It drops and counts a refuted row.

### Migrating between generations

Cork redeploys as a new generation, and the previous generation keeps working. The primary is
`phoenix/v0.5`. `phoenix/v0.4-rc.1` (the same contracts with the 0.4.0 JIT adapter) and
`phoenix/v0.3-rc.1` stay active. `cork-cli` supports all of them at the same time:

- With no `--pool-id`, `ch query account-state --chain-id 8453 --account <you>` lists every pool
  where you hold cST or cPT. Each pool comes tagged with its generation and its expiry.
- To exit an old pool, use the pool-scoped command for its expiry state: `unwind-deposit` or
  `unwind-mint` before expiry, `withdraw`, `redeem` or `withdraw-other` after. The tool resolves
  the pool's generation from the chain.
- To enter the new pool, use `deposit` or `mint` on the primary. When the pool does not exist, run
  `ch prepare market create-pool` first. A rollover takes two parties: the cPT holder signs a
  `rollover-intent`, and the cST holder fills it with `rollover-fill`.
- `--generation previous`, `primary`, or a label targets a set explicitly. The result carries the
  resolved label. `ch capabilities --topic migration` has the steps.

Plan for one change: your ForSelf adapter pins the pool manager, the whitelist manager and the LOP
at deployment. Markets on the primary need a second adapter, bound to the 1.4.0-rc.1 pool manager.
Deploy it from the cork-periphery v0.2.0-rc.1 reference, and whitelist it beside the current one.
The current adapter keeps serving every pool on `phoenix/v0.3-rc.1`.

## 5. Risks and ownership

Sections A to C are the security core.

**A. Cork sends payouts to an address argument, and your permission layer cannot see arguments.
You must force the receiver yourself.** Every raw Cork function that pays out takes its
destination as a parameter (`receiver`, or `target` in takerTraits bit 251 on a fill). It pulls
the inputs from the calling Safe. A Safe-module whitelist can only allow or deny "this contract,
this function". It cannot look inside the call. So a prompt-injected or compromised agent can make
an allowed call in which your Safe pays and an attacker receives.

| Surface | The argument the whitelist cannot see | Your remedy |
|---|---|---|
| Direct Phoenix calls: `exercise`, `swap`, `redeem`, `withdraw`, `unwind*` | `receiver` | Whitelist only a wrapper that hardcodes the receiver to the Safe |
| Buying cST through the 1inch fill | `target` in takerTraits (bit 251) | Fill through a wrapper that pins the target to the caller |

**The fix is yours to own, and you already run the pattern.** Do not whitelist raw Cork methods.
Deploy a Zyfai-owned wrapper that forces the payout to the Safe, and whitelist that wrapper. It
has the same shape as your `*ForSelf` and AdapterProxy routes for Aave, Morpho and Euler.

Cork's reference adapter exists, and it is proven end to end. `CorkForSelfAdapter`
([Cork-Technology/cork-periphery](https://github.com/Cork-Technology/cork-periphery)) is the
`*ForSelf` twin of the whole surface. It has one address and 14 entrypoints (the 13 pool actions
plus `fillOrderForSelf`), and it is custody-free. It delivers every output to the calling Safe,
with no receiver parameter anywhere. It binds every fill on chain to a named Cork market, and
every ERC-20 approval goes to the adapter itself. We exercised it end to end on live-chain forks,
against the real 1inch LOP and both pool-manager generations. You still audit, vet and deploy it.
Your users trust Zyfai.

**B. Markets in this flow have the pool-level whitelist OFF, by construction.** Cork's adapter
performs the JIT mint inside a fill. A market with its whitelist on would refuse that mint, and
every purchase would revert `MintUnavailable`. The order builders always create markets with the
whitelist off. This is not a knob.

**C. Know which spender model your route uses, and one approval you must not grant.** On the raw
route, you approve the premium (CA) to the 1inch LOP, and the REF you hand in on exercise to
Cork's pool manager. On the ForSelf route, every approval goes to the adapter: CA for the fill,
REF and cST for the exercise. On either route, do not approve the cST to the pool manager. The
exercise path moves your cST without an allowance check when the caller owns the token. So that
approval can never be spent, and it sits as a standing risk. The same holds for cPT.

**D. `exercise` has no built-in slippage protection.** The only bounds are the `min` and `max`
values you pass. Preview with `cst-swap-rate` right before you send. Read a zero preview as "the
market cannot pay right now".

**E. If the REF token can be paused, your cover freezes with it.** A paused REF blocks the
transfer in, so the cover is unusable for as long as the pause lasts. Keep pilot positions small,
and monitor the pause status of the REF.

**F. `submit` pre-flights locally; reconcile the venue round trip.** Simulate before you sign,
and reconcile after (`ch track reconcile`). The chain outranks the indexer.

**G. Addresses drift; read them live, and know which generation answered.** A chain hosts a set
of generations. `ch query protocol-config` lists them all, with the addresses and wire of each
block. Every result names the generation it answered from (`data.generation`).
`--generation <label>` selects a non-primary set for a prepare. Installed copies of the tool pick
up redeployed addresses within an hour (remote config, `cork-defaults.v2.json`).

The primary set on Base and Arbitrum One is `phoenix/v0.5`: contracts release **0.6.0** on the
Phoenix 1.4.0-rc.1 pool manager, with identical addresses on both chains. `phoenix/v0.4-rc.1` has
the same addresses, except the JIT adapter `0x3E01C558fc0854e92e6ef2a84c19D6Bf9D82B104` (0.4.0,
v/r/s permits):

| Role | Address |
|---|---|
| MarketRegistry 0.5.0 | `0xe1f569f152bDB6eBB2d49cFd9d4aB98ECEe955c5` |
| CorkLimitOrderAdapter 0.5.0 (JIT hook, nested wire, `bytes` permit) | `0x960Cd94B31121806b1b0Ff02230D189Ad0310616` |
| CorkMarketCreator (holds `POOL_CREATOR_ROLE`) | `0x1A074F17647504D1c50B436074a74d051D502dEa` |
| LiquidityPriceRecipe | `0x679Cbd016587c423f342e5Ba31e58356228c964d` |
| LiquidityNavRecipe | `0xed6A6b0448B89F35889Aaf6Df1bdEF27f83787e3` |
| FixedRateRecipe | `0xEC26bb7d911aFe374721Ecd963543f7e52468C49` |
| ApySpreadImpairmentRecipe | `0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9` |
| CorkPoolManager 1.4.0-rc.1 (10-field `Market`) | `0xcC17224A8710fa23BdA40c2CB563b85CeDDb0C2D` |
| CorkAdapter (pool actions) | `0x71eB628c3A40FB3896613804847840426f9284A7` |
| CorkForSelfAdapter v0.2.0-rc.1 (reference) | `0x3864902695DC930Df406ef5dEB74c4DC249e23f1` |

The previous set (`phoenix/v0.3-rc.1`, contracts release **0.3.3**) is where most listed pools
live today. Its registry is `0xa78d8137B01058dD23e545b6557209eBBc9611F1`, and its JIT adapter is
`0x8902a88912a334263fe3d731d03c267715b9374f`. Its recipes are
`0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55` (price), `0xAeD3D0e3C86A994d88741C285657c3e78550f66d`
(nav), `0x133ac0fA9e3d44A34B8cE4E4B8D468758fd165C1` (fixed) and
`0x7340BfbEdF3657a7bBCe0dD2b4ab205754cc9eCA` (impairment). Pass
`--generation phoenix/v0.3-rc.1` to build against it on purpose.

Two rules make redeploys safe to live through. First, an abandoned generation does not go dark: it
answers current-shaped calls with plausible values. Never conclude "this address works, so it must
be current". Second, anything that signs against an adapter must confirm that the adapter binds
the registry you pin. On the 0.3.3 adapter, that check is `MARKET_REGISTRY()`. On the 0.5.0
adapter, it is the chain `MARKET_CREATOR()`, then `creator.MARKET_REGISTRY()`. `ch` runs this
guard on every order prepare and refuses a mismatch (`adapter_binding_mismatch`). You run the
check by hand only when you bypass the tool.

---

## 6. What you need to do

1. **Stand up the tool.** Run `claude mcp add`, or put `ch` on PATH. Confirm that
   `cork_capabilities` returns 9 tools. Optional: `CORK_RPC_URL`, `ENVIO_HYPERSYNC_TOKEN`.
2. **Audit and deploy the receiver-forcing adapter**, one per generation you trade on. The
   reference is `CorkForSelfAdapter` in cork-periphery. You audit, vet and deploy it, or you
   extend your own `*ForSelf` route to the same shape.
3. **Load the whitelist** for the loop: `fillOrderForSelf`, `exerciseForSelf` and
   `exerciseOtherForSelf`, plus the approvals for the route you chose (section 5, item C).
4. **Wire the four-step flow against the tool.** Select and derive with `registry-*` and
   `derive-cork-pool`. Run the RFQ with `submit rfq-open` and `rfqs --watch`. Simulate every
   artifact before you sign. Fill with `ch fill --for-self`. Size the exercise with
   `cst-swap-rate`, and build it with `ch exercise`. Reconcile with `ch track`.
5. **Confirm ownership and timeline with Cork.** Cork needs no protocol change from you. Cork
   needs to know when your adapter routes are ready. Also settle the RFQ package catalog and the
   notional units for step 1d with Cork.

---

## 7. Finding the right command

The tool documents itself in two ways. The MCP tools and the CLI are one core, so an MCP input
object runs verbatim as `ch <command> --input '<object>'`.

```sh
ch compute --explain                      # the contract of one command, all variants
ch compute cst-swap-rate --explain        # one variant
ch compute --explain --json               # the raw JSON schema
ch capabilities                           # the manual: 9 tools and their maturity
ch capabilities --topic signing           # sign, validate, broadcast
ch capabilities --search "swap rate"      # keywords → tool, variant, ready-to-run examples
```

With the `cork-defi` server installed, prompts like these exercise the whole surface. When in
doubt, start with "call `cork_capabilities` first".

> "Using cork-defi, derive the sUSDe / mwUSDC market on Base that expires in 7 days, and give me
> the poolId and cST address."

> "What is the `ch` command to build an unsigned exercise bundle: 1000 cST into pool `0x…`, payout
> to my Safe `0x…`?"

Questions, or a stale value? `ch capabilities` is the living manual. For the deeper security
analysis and the open items of the pilot, ask your Cork contact.
