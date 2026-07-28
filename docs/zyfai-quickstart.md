# Cork × Zyfai — Integration Quick Start

**Audience:** the Zyfai engineering team. **Assumes:** fluency with Safe/ERC-7579, 1inch LOP v4,
EIP-712/ERC-1271, ERC-2612 permits, ERC-4626/7540, CREATE2. **Chain:** Arbitrum One (42161).
**Status:** as of 2026-07-27. Addresses/rates below were read live from chain; still, **treat this
doc as orientation and pull the authoritative values from the tool** (`ch query protocol-config`),
never hardcode them.

This is a two-part handoff: (1) a compact model of what Cork gives you and where your agent plugs
in, and (2) `cork-mcp-cli` — a read/derive/build/simulate helper you can drive from an MCP client or
the shell to make every step concrete without signing or custodying anything.

---

## 1. What Cork is

Cork is middleware for **tokenized, tradeable downside cover**. A Cork *market* tokenizes one covered
position into two ERC-20 legs:

| Term | Meaning | Who holds it |
|---|---|---|
| **REF** | the asset your user is exposed to and wants cover on. Live Arbitrum markets use **waArbUSDT**, waArbUSDCn, or waArbwstETH — read the market, don't assume | the user |
| **CA** | the liquid collateral asset paid out on cover (pilot: **sUSDe**, `0x211Cc4DD…5fE5d2`, 18 dec) | pool |
| **cST** | the cover / "swap" token — right to swap REF→CA at the market's fixed rate before expiry | **Zyfai (demand)** |
| **cPT** | the principal token — the underwriter's leg + premium | **bond.credit (supply)** |

The market itself is **identified by the keccak of its `Market` struct** (`poolId`), so it is fully
**derivable off-chain before it exists**. Pilot markets are **short-dated (you pick the term — e.g.
7 days) and typically fixed-rate** (recipe mode `fixed` = rate pinned at creation, no drift), which
keeps premiums tiny and drops the oracle dependency.

**You are the demand side:** you buy cST cover on a position your yield agent manages, and you
**exercise** it on impairment. bond.credit is the supply side; it prices and sells the cover and
holds cPT. Settlement is atomic on **1inch LOP v4** with **just-in-time (JIT) minting** of cST/cPT
inside the fill — no pre-funded inventory.

---

## 2. The loop, and the tool at each step

Roles and mechanics from Cork's live Arbitrum deployment. Every step has a `ch …` command that
returns **unsigned** artifacts or reads — you sign/broadcast with your own stack.

| # | Step (demand-side) | What happens | Tool |
|---|---|---|---|
| 0 | **Oracle setup** (once per CA/REF pair) | `MarketRegistry.deploy(ca, ref)` — permissionless, **idempotent** (re-sending is a safe no-op) | `ch prepare market` → `deploy-wrapper` |
| 1 | **Derive the market** (off-chain, before it exists) | Get the `poolId`, cST/cPT addresses, resolved rate bands, and whether the pool exists yet — *the exact derivation a JIT fill runs* | `ch query` → `market-predict` |
| 2 | **Discover the ask** | Read bond.credit's signed SELL order (makerAsset=cST, takerAsset=CA) from the venue book | `ch query` → `orderbook` / `rfqs` |
| 3 | **Verify + dry-run** | Re-verify maker/market on-chain (book is discovery only), then simulate the fill bytes before signing | `ch query` → `market`; `ch track` → `simulate` |
| 4 | **Buy cST (fill)** | Fill the ask on the LOP; the adapter JIT-creates the market (if new) and JIT-mints cST to you, pulling the CA premium from you — **atomic** | `ch prepare orders` → `taker-fill` |
| 5 | **Exercise on impairment** | Hand in cST + REF, receive CA at the fixed rate — a **direct** Phoenix call, *not* an LOP fill | `ch prepare phoenix` → `exercise` / `exercise-other` |
| 6 | **Rollover near expiry** | *Fill* a cPT-holder's open rollover order: front the user's expiring cST, swap some REF→premium token, pay the premium, receive fresh cST for the successor market | discover: `ch query` → `flows` (kind=orders); the `fill` tx is your own stack (`ch` filler builder is future) |

Implementation notes:
- **`taker-fill` picks the right fill flavor for you** — `fillOrderArgs` (EOA maker) vs
  `fillContractOrderArgs` (Safe/ERC-1271 maker). Guessing wrong reverts `BadSignature`.
- **Market identity follows the live oracle rate.** If the rate moves between signing and filling,
  the derived `poolId` moves and the fill reverts `OrderNotForPool` (a deliberate staleness guard).
  `market-predict` emits a `rate_drift_notice` so you can see this coming.
- **Partial fills settle pro-rata** at the static 1inch price; the adapter mints exactly the filled
  cST and pulls the matching CA. Keep `allowPartialFills` and `allowMultipleFills` equal.
- **Redeem is a supply-side action.** You hold cST only; your terminal move is **exercise**, never
  redeem. An unexercised cST is worthless after expiry.

---

## 3. The journey, step by step

This section walks through one full cover cycle end to end. Every step has a real `ch` command you
can run as-is, followed by a trimmed real response and a short note on what to check. Each command
returns **unsigned** artifacts or plain reads — you sign with your own Safe stack.

**Two conventions for every command below:**
- Replace **`0xYOUR_SAFE`** with the user smart account (Safe) you're driving.
- Steps 5–7 reuse one market's `poolId` and `cST` address. The values shown are the live
  **sUSDe / waArbUSDT** market derived in Step 4. Because that market doesn't exist yet, those two
  values drift with the oracle rate — run Step 4 yourself and paste *your* output. Everything else
  (asset addresses, `chainId`) is real and runnable today.

The pilot pair, for reference:

| Role | Asset | Address | Decimals | `kind` |
|---|---|---|---|---|
| **REF** — what the user is exposed to and covers | waArbUSDT | `0xa6D12574eFB239FC1D2099732bd8b5dC6306897F` | 6 | 1 |
| **CA** — what the user is paid out in on exercise | sUSDe | `0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2` | 18 | 0 |

Your user holds **cST** (the cover); bond.credit holds **cPT** (the underwriter's leg). In the tool,
CA is `collateralAsset` and REF is `referenceAsset`.

---

### Step 1 — Choose the REF asset to cover

List the assets the registry approves. The `kind` field is the role: `1` = reference-eligible (what
you cover), `0` = collateral-eligible (what you're paid in).

```sh
ch query --json '{"resource":"registry-assets","chainId":42161}'
```
```jsonc
{ "state": "ok", "data": { "count": 9, "items": [
  { "addr": "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", "name": "sUSDe",       "kind": 0 },
  { "addr": "0xa6D12574eFB239FC1D2099732bd8b5dC6306897F", "name": "waArbUSDT",   "kind": 1 },
  { "addr": "0x7F6501d3B98eE91f9b9535E4b0ac710Fb0f9e0bc", "name": "waArbUSDCn",  "kind": 1 },
  { "addr": "0xe98fc055c99DECD8Da0c111B090885d5d15C774E", "name": "waArbwstETH", "kind": 1 }
  // …9 total
] } }
```
Pick a `kind: 1` asset your users actually hold. This walkthrough uses **waArbUSDT**. (If an asset
isn't on this list it isn't coverable yet — registering it is a Cork-side step.)

---

### Step 2 — Choose the cover template (recipe)

The recipe sets how the market's rate may move, which is what defines the cover. List the live
templates:

```sh
ch query --json '{"resource":"registry-recipes","chainId":42161}'
```
```jsonc
{ "state": "ok", "data": { "modes": ["liquidity","fixed"], "items": [
  { "mode": "liquidity", "rateMin": "99000000000000000000", "rateMax": "100000000000000000000" },
  { "mode": "fixed",     "rateMin": "1000000000000000000",  "rateMax": "1000000000000000000", "rateChangePerDayMax": "0" }
] } }
```
- **`fixed`** — the rate is pinned at creation and can't drift (`rateChangePerDay = 0`), within a
  tight ±1% tolerance. Simplest cover, smallest premiums. **Pilot default.**
- **`liquidity`** — a wide band that lets the rate track the oracle across a large range.

To see what a template resolves to as an **absolute** rate constraint (the exact math a fill runs,
checked bit-for-bit against chain):

```sh
ch compute --json '{"chainId":42161,"params":{"kind":"resolve-recipe","mode":"fixed","rate":"1000000000000000000"}}'
```
Use `fixed` unless you specifically want the wider `liquidity` band.

---

### Step 3 — Choose the CA (payout) asset

The CA is what your user receives on exercise. It's the same list filtered to `kind: 0`. The pilot
uses **sUSDe** (`0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2`, 18-dec).

You've now chosen the four inputs that name a market: **CA + REF + recipe + expiry.**

---

### Step 4 — Pick a duration and derive the market

Markets are short-dated — pick any term (7 days here) as a Unix expiry, then derive the exact market
a fill would create: its `poolId`, cST/cPT addresses, oracle, resolved bands, and whether it exists
yet. Nothing is signed or deployed.

```sh
EXP=$(date -u -d '+7 days' +%s)
ch query --json "{\"resource\":\"market-predict\",\"chainId\":42161,\"filters\":{\"collateralAsset\":\"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2\",\"referenceAsset\":\"0xa6D12574eFB239FC1D2099732bd8b5dC6306897F\",\"expiry\":\"$EXP\",\"mode\":\"fixed\"}}"
```
```jsonc
{ "state": "ok", "data": {
  "oracle": { "address": "0x6c5ce1b98303a3687BB9871ce8cd2c41506e34Ec", "deployed": true, "rate": "805138582043777852" },
  "market": { "poolId": "0xfb8644980136a0f81b33cbe5c2aed94ebeea58824aafbefe35d92206aa6615dd",
              "exists": false,
              "resolved": { "rateMin": "797087196223340074", "rateMax": "813189967864215630", "rateChangePerDayMax": "0" } },
  "shares": { "corkSwapToken": "0x5a21A1CBE2605193c06F9EecA93906A93843097d",
              "corkPrincipalToken": "0xd2a69BB777A66551Ae7571dE39Fa1f41Ce0A4eE7", "source": "simulated" } },
  "warnings": [ { "code": "rate_drift_notice",
    "message": "the pool does not exist yet, so pool id and cST/cPT are derived from today's oracle rate and drift until the pool is created" } ] }
```
What to check:
- **`oracle.deployed`** — if `false`, deploy it first with `ch prepare market … deploy-wrapper`
  (permissionless and idempotent; see §2, step 0).
- **`market.exists`** — `false` means the first fill creates the market; `true` means you can fill
  right away.
- **`corkSwapToken`** is the **cST** you'll buy; **`corkPrincipalToken`** is the cPT.
- **`rate_drift_notice`** — until the pool exists, the `poolId` and cST/cPT addresses are derived
  from the *current* oracle rate and move with it. An order signed against a stale rate reverts
  `OrderNotForPool`. So derive, discover, and fill close together, and re-derive if the rate moved.

The commands below use this market: `poolId` =
`0xfb8644980136a0f81b33cbe5c2aed94ebeea58824aafbefe35d92206aa6615dd`, `cST` =
`0x5a21A1CBE2605193c06F9EecA93906A93843097d`.

---

### Step 5 — Buy the cST cover

Your users are ERC-1271 smart accounts, so orders are Safe-signed and fills use
`fillContractOrderArgs` — the tool selects that for you. There are two ways to buy.

#### Path A (recommended) — fill an existing SELL order

bond.credit rests signed **SELL** orders (`makerAsset` = cST, `takerAsset` = CA). Find one for your
market:

```sh
ch query --json '{"resource":"orderbook","chainId":42161,"filters":{"poolId":"0xfb8644980136a0f81b33cbe5c2aed94ebeea58824aafbefe35d92206aa6615dd"}}'
```
```jsonc
{ "items": [ {
  "orderHash": "0xe2b67c02022118bb93bab230e110258425da5b57c8ae6052113032700ec40510",
  "makerAsset": "0xd1f71c26cc66938b789b23615fe554f6fce835f8", // a cST
  "takerAsset": "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2", // sUSDe (CA)
  "side": "SELL", "allowsPartialFills": true,
  "status": "OPEN", "remainingMakingAmount": "124999875000000"  // confirm status/remaining on the live row
} ] }
```
If Step 4 showed `exists: false`, there won't be orders yet — you're the first mover, and
bond.credit's SELL is the order whose first fill creates the market. Once you have an OPEN
`orderHash` with enough `remainingMakingAmount`, re-verify the market on-chain and build the fill:

```sh
# 1. re-verify the market on-chain (the book is discovery only)
ch query --json '{"resource":"market","chainId":42161,"filters":{"poolId":"0xfb8644980136a0f81b33cbe5c2aed94ebeea58824aafbefe35d92206aa6615dd"}}'

# 2. build the unsigned fill (use an OPEN orderHash from the read above; replace 0xYOUR_SAFE)
ch prepare orders --json '{"chainId":42161,"account":"0xYOUR_SAFE","clientRequestId":"buy-0001","action":{"type":"taker-fill","orderHash":"0xe2b67c02022118bb93bab230e110258425da5b57c8ae6052113032700ec40510","fillMakingAmount":"124999875000000"}}'
```
The prepare output includes the unsigned fill calldata as an `artifact`. Dry-run it before you sign
— paste that `artifact` object in place of `{…}`:

```sh
# 3. dry-run: does it revert at current state?
ch track --json '{"mode":"simulate","chainId":42161,"subject":{"kind":"artifact","artifact":{…}}}'
```
Then **sign the calldata with your own Safe stack and broadcast.** The fill is atomic: the adapter
creates the market if it's new and mints the cST to your Safe, pulling the CA premium from you in the
same transaction. Before broadcasting, set the CA allowance (§5, item C) and pin the fill target to
the Safe (§5, item A). Expect an `unsigned_artifact` warning on the prepare (it's calldata only), and
require `wouldRevert: false` from the simulate.

#### Path B — post your own BUY order

Instead of taking an ask, rest your **own** BUY order and let a supply-side filler match it. Here
`makerAsset` = CA (the premium you offer) and `takerAsset` = cST:

```sh
# replace 0xYOUR_SAFE; takerAsset is your cST from Step 4
ch prepare orders --json '{"chainId":42161,"account":"0xYOUR_SAFE","clientRequestId":"bid-0001","action":{"type":"maker-order","poolId":"0xfb8644980136a0f81b33cbe5c2aed94ebeea58824aafbefe35d92206aa6615dd","side":"BUY","makerAsset":"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2","takerAsset":"0x5a21A1CBE2605193c06F9EecA93906A93843097d","makingAmount":"1000000000000000000","takingAmount":"1000000000000000000000","expirySeconds":604800}}'
```
Sign it (Safe/ERC-1271), then post it to the venue with `ch submit` (`action.type: "lop-order"`).

> **Confirm this path with Cork before relying on it.** On a BUY order the cST is minted by the
> *filler* through the adapter's taker-side interaction. That's a real on-chain capability, but:
> (1) `ch` doesn't build the filler side today — that's the supply side's tooling, not yours; and
> (2) taker-side minting only works into a market that already exists (market *creation* happens on
> the maker side). So a resting BUY order fills only when a supply-side filler with taker-side JIT
> support picks it up, against an existing market. **Path A is the proven route for the pilot; treat
> Path B as available-but-verify.**

---

### Step 6 — Exercise the cover on a haircut

When your risk monitor sees impairment on the user's REF, exercise the cover: hand in **cST + REF**,
receive **CA** at the market's rate. This is a direct Phoenix call, not an LOP fill.

```sh
# replace 0xYOUR_SAFE (used for both account and receiver)
ch prepare phoenix --json '{"chainId":42161,"account":"0xYOUR_SAFE","clientRequestId":"exercise-0001","action":{"type":"exercise","poolId":"0xfb8644980136a0f81b33cbe5c2aed94ebeea58824aafbefe35d92206aa6615dd","cstSharesIn":"1000000000000000000000","receiver":"0xYOUR_SAFE","minCollateralAssetsOut":"950000000000000000","maxReferenceAssetsIn":"1000000"}}'
```
Sign with your Safe stack, and route the call through your `*ForSelf` adapter so `receiver` is forced
to the Safe (§5, item A). A few things to keep in mind:
- `exercise` has no built-in slippage guard beyond the `min*/max*` you pass. Re-check the preview at
  send time, and treat a zero preview as *unavailable*, not free (§5, item D).
- A REF pause blocks the REF transfer — i.e. the exercise leg itself — so keep positions small and
  monitor REF liveness (§5, item E).
- Approvals: REF → CorkPoolManager. cST needs **no** pool-manager approval on the direct path
  (§5, item C).

---

### Step 7 — Roll the cover near expiry

Near expiry, roll the user's cover into the successor market instead of letting it lapse. Rollover is
a two-party trade, and the roles are easy to mix up:
- The rollover order is **signed by a cPT-holder** — the underwriter/supply side, a *different*
  party from your user. They offer to co-roll their principal and **collect** a premium.
- **You are the filler** — the cST/demand side, acting for your user. You roll *your user's* cover
  from the old market to the new one and **pay** that premium.

Find open rollover orders:

```sh
ch query --json '{"resource":"flows","chainId":42161,"filters":{"kind":"orders"}}'
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
reads), `compute` (deterministic math: swap/unwind rate, impairment floor, band resolution),
`decode` (bytes→labeled JSON, unwraps Bundler3 multicall), `prepare_market` / `prepare_orders` /
`prepare_phoenix` (unsigned tx/order builders), `track` (verify / **simulate frozen bytes** /
reconcile), `submit` (the only relay).

**The result envelope — always check `state` before trusting `data`:**
- `ok` → use `data`. `unavailable` → not servable now; `warnings[0].code` says why (don't retry
  blindly). `conflict` → the tool ran and found a mismatch (e.g. a stale rate, a digest mismatch) —
  surface it, don't paper over it. CLI exit codes mirror this (`0/2/3/4/1`).
- Money/rate outputs carry a `scales` block + `collateralDecimals`/`referenceDecimals` — **read the
  labels; do not assume 18 decimals** (the reference leg is 6-dec on every live market so far —
  yoUSD and waArbUSDT alike — while sUSDe collateral is 18-dec).

**Maturity — the tool self-reports it, and the labels are precise.** `cork_capabilities` returns a
per-tool/per-variant map with three states (mirrors the committed source; verified 2026-07-27):
`activated` = live and verified against chain; `implemented` = code-complete and locally verified,
awaiting a live-milestone flip (not a code gap); `specified` = designed, not built (returns
`unavailable`).

- **`activated`** — the whole **read → derive → build → simulate → verify** path: `query` (incl.
  `market-predict` and `whitelisted-addresses` — whitelist membership replayed from WhitelistManager
  events over HyperSync, live-view verified when an RPC resolves; needs an Envio token), `compute`,
  `prepare_market`, `prepare_orders` (maker-order incl. JIT, taker-fill, finalize, cancel,
  rollover-intent), `prepare_phoenix` (all 13 adapter actions **plus** the token-authority ops —
  unsigned direct ERC-20 approve txs, onboard/revoke), `track` (verify / simulate / reconcile),
  **all four `decode` kinds** (calldata incl. Bundler3 unwrap; order → makerTraits breakdown +
  recomputed orderHash; event/receipt → named args against the verified ABI set), and `compute`'s
  `dutch-auction-price` (pure-local pricing of 1inch Fusion v3.1 dutch-auction orders from the
  order's own extension bytes — wei-exact vs the deployed settlement getters on mainnet+Arbitrum,
  incl. a real production order; `at.timestamp` pins the moment). The math ports are checked
  **bit-exact, wei-for-wei** against on-chain reads.
- **`implemented`** — `submit`, the one venue-write tool. All four writes (`lop-order`,
  `rollover-order`, `rfq-open`, `rfq-answer`) are wired **and do real pre-flight**: it recomputes the
  `orderHash` / intent-hash and **recovers the maker/user signature locally** before relaying, and is
  idempotent by `clientRequestId`. The map flips it to `activated` on the first venue-accepted live
  POST — i.e. what's unproven is the live venue round-trip (partly the venue's readiness), not the
  relay logic. It never signs; you sign, it relays. Simulate + reconcile around it as normal.

**RPC & secrets:** Arbitrum reads **work out of the box** (built-in default endpoints + a public
fallback). Set `CORK_RPC_URL` only to use your own/faster node. Full-decentralized reads and order
reconciliation want an Envio token (`ENVIO_API_TOKEN`) — generate one at
<https://envio.dev/app/api-tokens> (sign-in required; docs at
<https://docs.envio.dev/docs/HyperSync/api-tokens>). **Never commit an RPC URL or token** — env only.

---

## 5. Risks & ownership

Sections A–C are the security core.

**A. Outputs go to an address argument your policy layer cannot see — you must force the receiver.**
Every asset-moving *raw* Cork method sends its output to a `receiver`/`target` **parameter**, while
pulling inputs from `msg.sender`. A Zodiac/ERC-7579-style whitelist gates `(contract, selector)` but
**not calldata**, so a prompt-injected or compromised agent can point that argument at an attacker
while your Safe funds the call. This is **source-confirmed and still present in the latest Phoenix
build**, across three distinct surfaces:

| Surface | The unseen argument | Your remedy |
|---|---|---|
| `exercise` / `swap` / `redeem` / `withdraw` / `unwind*` (direct Phoenix) | `receiver` | Route through a **self-forcing wrapper** that fixes `receiver = Safe` |
| Buying cST via the 1inch fill | takerTraits **bit-251 `target`** (routes the bought cST) | Leave `target` unset / pin it to the Safe on **every** fill |

**This is yours to own, and it fits what you already run.** Your deployed `*ForSelf` / AdapterProxy
pattern (the one behind `supplyForSelf`/`withdrawForSelf`/… for Aave/Morpho/Euler) is exactly the
right shape: whitelist a **Zyfai-owned** route that forces the receiver to the Safe, rather than raw
Cork methods — because your users trust *Zyfai*, not Cork. **Cork will provide reference/example
adapter code, but you audit, vet, and deploy it.** Guardrail worth internalizing: *"Zyfai-owned" is
the trust anchor, not the safety property* — the wrapper still has to actually force the receiver,
hold no custody, and be audited. (Cork can share the full analysis and the on-chain evidence behind
this — the "Scope & Ownership" write-up — on request.)

**B. The market must be created with `isWhitelistEnabled = false`.** The JIT adapter is the
`msg.sender` of the mint; a whitelisted pool can never be JIT-minted, so every fill would revert
`MintUnavailable`. The JIT builders set this; it is not configurable.

**C. Different approve spenders — and one approval you do *not* need.** CA premium → **1inch LOP**;
REF (for exercise) → **CorkPoolManager**. Same selector, different spender — easy to get wrong, and
your carve-out must allow both explicitly. **cST needs no approval to the pool manager** (corrected
2026-07-28, source-verified): the cST leg of `swap`/`exercise`/`exerciseOther` moves through the
gated 4-arg `PoolShare.transferFrom(sender, owner, to, amount)` called as
`(_msgSender(), _msgSender(), address(this), …)`, which skips `_spendAllowance` when
`sender == owner`. Granting one anyway is a standing approval that can never be spent. The same
applies to cPT when you exit your own position. If you route through a `*ForSelf` adapter, cST does
need approving — to that adapter, never to the pool manager.

**D. `exercise` has no slippage guard** and is gated by the constraint-rate credit bucket + a pause
bit. Re-check the preview at send time; treat a zero preview as "unavailable," not "free."

**E. yoUSD (REF) pausability.** A REF pause freezes transfers — including the `cST + REF → CA`
exercise, i.e. exactly when you need cover. Keep pilot positions small and monitor REF liveness.

**F. `submit` is code-complete; the live venue round-trip is the unproven part** (see §4 — status
`implemented`, not a code gap). Simulate (`ch track simulate`) before signing and reconcile
(`ch track` → `reconcile/orderHash`) after; chain outranks the indexer on any disagreement.

**G. Addresses drift; read them live.** Pull the deployment from `ch query protocol-config`
(Arbitrum today: poolManager `0x4d0ab673…`, corkAdapter `0xe9f364df…`, bundler3 `0x1FA4431b…`,
MarketRegistry `0xF674488b…`). The current venue pool list is `api-phoenix.cork.tech/v1/pools/`.

---

## 6. What you need to do (checklist)

1. **Stand up the tool** — `claude mcp add` (or `ch` on PATH), confirm `cork_capabilities` returns 9
   tools. Optional: `CORK_RPC_URL` (own node), `ENVIO_API_TOKEN` (decentralized reads).
2. **Deploy the receiver-forcing routes on your side** — extend your `*ForSelf`/AdapterProxy to cover
   the Cork exercise/swap family and a target-pinned 1inch fill. Cork ships examples; you audit +
   deploy.
3. **Load the whitelist** for the loop (your own AdapterProxy routes, not raw Cork): create/fill,
   `exercise`/`exerciseOther`, and the three approvals (CA→LOP, cST→PoolManager, REF→PoolManager).
4. **Wire the loop against the tool** — derive with `market-predict`, discover on the book, **simulate
   every artifact before signing**, fill with `taker-fill` (target pinned), exercise with
   `prepare_phoenix`, reconcile with `track`.
5. **Confirm ownership + timeline back to Cork** — Cork needs no protocol change from you; it needs to
   know when your adapter routes will be ready so the pilot's fill/exercise path lands inside your
   trust boundary.

---

*Questions or a stale value? `ch capabilities` (search/topic) is the living manual — the authority on
tool state, examples, and maturity. For the deeper security analysis and the pilot's open items, ask
your Cork contact (Baptiste).*
