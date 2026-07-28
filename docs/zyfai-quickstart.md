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
| **REF** | the covered/reference asset (design pair: yoUSD; the live Arbitrum markets on 2026-07-28 were sUSDe against **waArbUSDT**/waArbUSDCn — read the market, don't assume) | — |
| **CA** | the liquid collateral asset paid out on cover (pilot: **sUSDe**, `0x211Cc4DD…5fE5d2`, 18 dec) | pool |
| **cST** | the cover / "swap" token — right to swap REF→CA at the market's fixed rate before expiry | **Zyfai (demand)** |
| **cPT** | the principal token — the underwriter's leg + premium | **bond.credit (supply)** |

The market itself is **identified by the keccak of its `Market` struct** (`poolId`), so it is fully
**derivable off-chain before it exists**. Pilot markets are **short-dated (you pick the term — e.g.
7 days) and typically fixed-rate** (recipe mode `fixed` = rate pinned 1.0, no drift), which keeps
premiums tiny and drops the oracle dependency.

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

A plain-language walk through one full cover cycle, with the real `ch` command at each step
(Arbitrum 42161, the live **sUSDe / waArbUSDT** pilot pair). Outputs below are trimmed real reads.
The kit itself is detailed in §4; the risks you own are §5. Every `ch` call returns **unsigned**
artifacts or reads — you sign with your own Safe stack.

Naming, so the commands read cleanly:
- **REF** = the asset your user is exposed to and wants cover on — here **waArbUSDT**
  (`0xa6D12574…897F`, **6-dec**, registry `kind: 1`).
- **CA** = the asset your user is paid out in when they exercise — here **sUSDe**
  (`0x211Cc4DD…5fE5d2`, **18-dec**, registry `kind: 0`).
- **cST** = the cover token your user holds; **cPT** = the underwriter's leg (bond.credit holds it).
- In the tool, `market-predict` and the Market struct call CA `collateralAsset` and REF
  `referenceAsset`.

---

### Step 1 — Choose the REF asset to cover

List the assets the MarketRegistry approves; the `kind` field splits them — `1` = reference-eligible
(what you cover), `0` = collateral-eligible (what you're paid in).

```sh
ch query --json '{"resource":"registry-assets","chainId":42161}'
```
```jsonc
{ "state": "ok", "data": { "count": 9, "items": [
  { "addr": "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", "name": "sUSDe",      "kind": 0, "denomination": "USD" },
  { "addr": "0xa6D12574eFB239FC1D2099732bd8b5dC6306897F", "name": "waArbUSDT",  "kind": 1, "denomination": "USD" },
  { "addr": "0x7F6501d3B98eE91f9b9535E4b0ac710Fb0f9e0bc", "name": "waArbUSDCn", "kind": 1, "denomination": "USD" },
  { "addr": "0xe98fc055c99DECD8Da0c111B090885d5d15C774E", "name": "waArbwstETH","kind": 1, "denomination": "USD" }
  /* …9 total */ ] } }
```
**Pick** an approved `kind: 1` asset your users actually hold. We take **waArbUSDT**. (An asset
missing from this list isn't coverable until it's registered — a Cork-side step.)

---

### Step 2 — Choose the cover template (recipe / mode)

The recipe fixes how the cover's rate may move — i.e. *what kind of impairment it pays on*. List the
live modes:

```sh
ch query --json '{"resource":"registry-recipes","chainId":42161}'
```
```jsonc
{ "state": "ok", "data": { "scale": "bands are PERCENTAGES: 1e18 = 1%", "modes": ["liquidity","fixed"], "items": [
  { "mode": "liquidity", "rateMin": "99000000000000000000", "rateMax": "100000000000000000000", "rateChangePerDayMax": "100000000000000000000" },
  { "mode": "fixed",     "rateMin": "1000000000000000000",  "rateMax": "1000000000000000000",   "rateChangePerDayMax": "0" }
] } }
```
- **`fixed`** — rate pinned to par (1.0), no drift. Simplest cover; premiums tiny; no oracle path.
- **`liquidity`** — a narrow band (99–100%) that tracks the oracle within tolerance.

To resolve a mode's bands into **absolute** rate constraints at a given rate (the exact math a fill
runs — self-checked bit-for-bit against chain):
```sh
ch compute --json '{"chainId":42161,"params":{"kind":"resolve-recipe","mode":"fixed","rate":"1000000000000000000"}}'
```
**Pick** the mode matching the impairment you're hedging. Pilot default: **`fixed`**.

---

### Step 3 — Choose the CA (payout) asset

Same list, `kind: 0` — this is what your user receives on exercise. Pilot: **sUSDe**
(`0x211Cc4DD…5fE5d2`, 18-dec). CA + REF + mode + expiry are the four inputs that name a market.

---

### Step 4 — Pick a duration and derive the market (before it exists)

Cover markets are short-dated — pick any term (e.g. **7 days**) as a unix expiry, then derive the
exact market a fill would create: `poolId`, cST/cPT addresses, oracle, resolved bands, and whether
it exists yet — **all off-chain, nothing signed or deployed**.

```sh
EXP=$(date -u -d "+7 days" +%s)        # e.g. 1785848231
ch query --json '{"resource":"market-predict","chainId":42161,"filters":{
  "collateralAsset":"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
  "referenceAsset":"0xa6D12574eFB239FC1D2099732bd8b5dC6306897F",
  "expiry":"'"$EXP"'","mode":"liquidity"}}'
```
```jsonc
{ "state": "ok",
  "data": {
    "oracle": { "address": "0x6c5ce1b9…34Ec", "deployed": true, "rate": "805138582043777852" },
    "market": { "poolId": "0xac2bee2abb22905def74edd68af3ecd21fff29a28a0e7497e1bef96e400a5c9c",
                "exists": false,
                "resolved": { "rateMin": "8051385820437779", "rateMax": "1610277164087555704" } },
    "shares": { "corkSwapToken": "0x0fEb532a…bCfb", "corkPrincipalToken": "0xD63A52A7…77DF", "source": "simulated" } },
  "warnings": [ { "code": "rate_drift_notice",
    "message": "the pool does not exist yet, so pool id and cST/cPT are derived from TODAY's oracle rate and drift until the pool is created" } ] }
```
**Read the result:**
- `oracle.deployed: true` — if `false`, deploy it first with `ch prepare market … deploy-wrapper`
  (permissionless, idempotent — §2 step 0).
- `market.exists` — `false` = the first fill JIT-creates it; `true` = you can fill straight away.
- `corkSwapToken` = the **cST** you'll buy; `corkPrincipalToken` = cPT (the underwriter's leg).
- The `rate_drift_notice`: until the pool exists, `poolId`/cST/cPT track the **live** oracle rate and
  move with it. An order signed against a drifted rate reverts `OrderNotForPool` — so derive,
  discover, and fill close together, and re-derive if the rate moved.

---

### Step 5 — Buy the cST cover (drive the user's Safe)

Your user Safes are ERC-1271 smart accounts, so orders are Safe-signed and fills use
`fillContractOrderArgs` (the tool picks this for you). Two demand-side paths:

#### 5a — Fill an existing cST-SELL order (primary, fully tool-supported)

bond.credit rests signed **SELL** orders (makerAsset = cST, takerAsset = CA) on the venue. Find one
for your market, then build the fill:

```sh
# once orders exist for your market, scope by poolId; the row below is a representative live SELL
ch query --json '{"resource":"orderbook","chainId":42161,"filters":{"poolId":"<poolId>"}}'
```
```jsonc
{ "items": [ {
  "orderHash": "0xe2b67c02…0510",
  "maker": "0xd2f5f275…18d0", "makerAsset": "0xd1f71c26…35f8" /* a cST */, "takerAsset": "0x211cc4dd…5fe5d2" /* sUSDe */,
  "makingAmount": "124999875000000", "takingAmount": "9511739",
  "side": "SELL", "premium": 0.0001, "allowsPartialFills": true,
  "status": "OPEN", "remainingMakingAmount": "124999875000000" /* confirm status/remaining on the live row */ } ] }
```
If step 4 showed `exists: false`, there are no resting orders yet — you're first: bond.credit posts
the SELL whose **first fill JIT-creates** the market (maker preInteraction). Pick an order with
enough `remainingMakingAmount`, re-verify on-chain, dry-run, then build the (unsigned) fill:

```sh
ch query   --json '{"resource":"market","chainId":42161,"filters":{"poolId":"<poolId>"}}'          # book is discovery only — re-verify maker/market on-chain
ch prepare orders --json '{"chainId":42161,"account":"<userSafe>","clientRequestId":"buy-0001",
  "action":{"type":"taker-fill","orderHash":"0xe2b67c02…0510","fillMakingAmount":"124999875000000"}}'
ch track   --json '{"mode":"simulate","chainId":42161,"subject":{"kind":"artifact","artifact":{ …the fill bytes… }}}'   # dry-run: wouldRevert + reason
#   ← sign the returned calldata with your Safe stack, then broadcast
```
The fill is atomic: the adapter (maker preInteraction) JIT-creates the market if new and JIT-mints
the cST to your Safe, pulling the CA premium from you in the same tx. Set the CA allowance first
(§5C) and pin the fill target to the Safe (§5A). Expect an `unsigned_artifact` warning (calldata
only) and require a green `ch track simulate` (`wouldRevert: false`) before signing.

#### 5b — Post your own cST-BUY order (supported on-chain; verify before relying on it)

Instead of taking an existing ask, rest your **own** BUY order and let a supply-side filler match it
— makerAsset = CA (the premium you offer), takerAsset = cST:

```sh
ch prepare orders --json '{"chainId":42161,"account":"<userSafe>","clientRequestId":"bid-0001",
  "action":{"type":"maker-order","poolId":"<poolId>","side":"BUY",
    "makerAsset":"0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",   /* CA offered  */
    "takerAsset":"0x0fEb532a…bCfb",                               /* cST wanted (from step 4) */
    "makingAmount":"1000000000000000000",                         /* 1 sUSDe premium (18-dec) */
    "takingAmount":"1000000000000000000000",                      /* cST shares  */
    "expirySeconds":604800}}'
#   ← sign (Safe/ERC-1271), then post to the book:
ch submit --json '{"chainId":42161,"clientRequestId":"bid-0001","action":{"type":"lop-order","order":{…},"signature":"0x…","side":"BUY","premium":<num>,"expiry":<unix>,"nonce":"<n>","allowsPartialFills":true}}'
```
> **Caveat — confirm with Cork before relying on this path.** The cST on a BUY order is minted by
> the *filler* via the adapter's taker-side interaction (a real on-chain capability), but (i) `ch`
> does not build that filler-side interaction today — it's the supply side's tooling, not yours; and
> (ii) taker-side JIT mints into an **already-created** pool (market *creation* is maker-side only).
> So a resting BUY order fills only when a supply-side filler with taker-JIT support picks it up,
> against an existing pool. For the pilot, **5a (taker-fill) is the proven path**; treat 5b as
> available-but-verify.

---

### Step 6 — Exercise before expiry on a haircut

When your risk monitor detects impairment on the user's REF exposure, exercise the cover: hand in
**cST + REF**, receive **CA** at the market's rate. This is a **direct Phoenix call**, not an LOP
fill.

```sh
ch prepare phoenix --json '{"chainId":42161,"account":"<userSafe>","clientRequestId":"exercise-0001",
  "action":{"type":"exercise","poolId":"<poolId>",
    "cstSharesIn":"1000000000000000000000",       /* cST burned                              */
    "receiver":"<userSafe>",                        /* forced to the Safe                      */
    "minCollateralAssetsOut":"950000000000000000",  /* min sUSDe out (18-dec, slippage floor)  */
    "maxReferenceAssetsIn":"1000000"}}'             /* max waArbUSDT in (6-dec)                */
#   ← sign with your Safe stack; route through your *ForSelf adapter so `receiver` is forced (§5A)
```
`exercise` has **no built-in slippage guard** beyond your `min*/max*`, and is gated by a credit
bucket + a pause bit (§5D) — re-check the preview at send time and treat a zero preview as
*unavailable*, not free. A REF pause (§5E) blocks the REF transfer, i.e. exactly the exercise leg —
keep positions small and monitor REF liveness. Approvals: REF → CorkPoolManager; cST needs **no**
pool-manager approval on the direct path (§5C).

---

### Step 7 — Roll the cover near expiry (fill a rollover order)

Near expiry, roll the user's cover into the successor market instead of letting it lapse. Rollover
is a **two-party** trade and the roles are easy to mix up:
- The rollover order is **posted (signed) by a cPT-holder** — the underwriter/supply side
  (`OrderData.user` = the cPT holder, a *different* party from your user). They offer to co-roll
  their principal and **collect** a premium.
- **You (Zyfai) are the FILLER** — the cST/demand side, acting for your user. You roll *your user's*
  cover srcPool→dstPool and **pay** the premium.

Discover open rollover orders:
```sh
ch query --json '{"resource":"flows","chainId":42161,"filters":{"kind":"orders"}}'
```
```jsonc
{ "state": "ok", "data": { "kind": "orders", "count": 0, "items": [],
  "pagination": { "complete": true } } }   // none open right now — a normal, honest result
```

To fill one, in a single atomic settler call you:
1. **front the user's expiring srcCST** (pulled from your caller — the user's Safe);
2. **pay the premium in the order's `premiumToken`** — so first **swap some of the user's REF →
   premiumToken** in your own stack (there is no swap hook: the order's hooks are maker-authored,
   ERC-7484-attested modules, not filler-supplied);
3. receive the fresh **dstCST** (new-term cover), routed to the user's Safe.

The counterparty (cPT-holder) supplies the matching srcCPT to unwind, keeps their CPT leg, and
receives your premium. Net: you spend [expiring srcCST] + [premium bought from the user's REF] to
get [fresh dstCST for the user] — you pay to carry the user's cover forward, a service you price to
your user off-chain.

**On-chain entrypoint** — the CorkSettler:
```
ExactSettler.fill(bytes32 orderId, bytes originData, bytes fillerData)     // all-or-nothing
PartialSettler.fill(bytes32 orderId, bytes originData, bytes fillerData)   // fill a slice
```
The order's signed `allowPartialFills` flag routes it to exactly one settler (ExactSettler rejects
partials; PartialSettler requires them).

> **Tool status.** `ch` builds the **maker/supply** side of rollover today (`prepare orders` →
> `rollover-intent`, then `submit` → `rollover-order`) — what a cPT-holder posts. It does **not** yet
> build the **filler** transaction (the `fillerData` envelope + `settler.fill`) that Zyfai needs, nor
> the REF→premiumToken swap. Discover with `flows`, then build and sign the `fill` with your own
> stack; a filler-side `ch prepare` action is a candidate for a later kit release. Confirm the
> current filler path with Cork.

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
