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
**derivable off-chain before it exists**. Pilot markets are **short (~24h) and fixed-rate** (recipe
mode `fixed` = rate pinned 1.0, no drift), which keeps premiums tiny and drops the oracle dependency.

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
| 6 | **Rollover at expiry** | Re-run 1/4 against the successor market and exit the old one — no new selectors | `ch prepare orders` → `rollover-intent`, then `ch submit` |

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

## 3. `cork-mcp-cli` — the integration kit

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

## 4. Risks & ownership

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

**F. `submit` is code-complete; the live venue round-trip is the unproven part** (see §3 — status
`implemented`, not a code gap). Simulate (`ch track simulate`) before signing and reconcile
(`ch track` → `reconcile/orderHash`) after; chain outranks the indexer on any disagreement.

**G. Addresses drift; read them live.** Pull the deployment from `ch query protocol-config`
(Arbitrum today: poolManager `0x4d0ab673…`, corkAdapter `0xe9f364df…`, bundler3 `0x1FA4431b…`,
MarketRegistry `0xF674488b…`). The current venue pool list is `api-phoenix.cork.tech/v1/pools/`.

---

## 5. What you need to do (checklist)

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
