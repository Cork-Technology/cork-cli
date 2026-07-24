# Proposal: sweep-back leg for exact-OUT funding (F13) — plan + tests

*2026-07-24. Held out of the footgun-hardening pass deliberately: this changes **fund-moving bundle
output**, so per the brief it is proposed here, not auto-applied. Decision needed from the owner
before it ships. Companion contract-side fix is in
`notes/external-dependency-recommendations-2026-07-24.md` §1c.*

## The problem (confirmed, all three legs by source)

For every **exact-OUT** action, `cork_prepare_phoenix` funds the caller-set **slippage cap**, not the
amount actually consumed:

| Action | Funded (cap) | Actually consumed |
|---|---|---|
| `mint` | `maxCollateralAssetsIn` | the real collateral for the exact shares out |
| `swap` | `maxCstSharesIn` + `maxReferenceAssetsIn` | the real cST + reference for the exact collateral out |
| `exercise` | `maxReferenceAssetsIn` (+ exact `cstSharesIn`) | the real reference |
| `exercise-other` | `maxCstSharesIn` (+ exact `referenceAssetsIn`) | the real cST |
| `unwind-exercise` / `-other` | `maxCollateralAssetsIn` | the real collateral |

`fundingPlan` (funding.ts:111-112, `FUNDING_TABLE`) moves the **cap** into the adapter. When
consumption < cap — the normal case for anyone who sets a slippage buffer — the delta is left on the
adapter and **no return leg is built**.

Confirmed on-chain source, all three legs:
1. **Funding funds the cap** — `funding.ts:107` (`args: […, BigInt(raw)]`, `raw` = the `max*` field).
2. **The adapter never refunds** — `CorkAdapter.safeSwap` (and siblings) consume ≤ cap and stop; there
   is no refund line.
3. **The residual is skimmable** — `CoreAdapter.erc20Transfer` (phoenix-private
   `contracts/periphery/bundler3/adapters/CoreAdapter.sol:62-70`) has a `uint256.max` full-balance
   sentinel and gates only on `onlyBundler3`; it does **not** check that `receiver` is the initiator.
   `Bundler3.multicall` is public, so anyone can call it next block with `receiver = themselves` and
   take whatever the adapter holds.

This is the standard Morpho adapter invariant ("adapters must end each tx holding zero balance"),
violated in the *common* case, not an edge.

## The proposed change

Append one sweep-back leg per funded, capped token to the **end** of the bundle (after the action
leg), returning any residual to the declared initiator:

```
erc20Transfer(token, account, type(uint256).max)
```

- `token` = the same token(s) `FUNDING_TABLE` funded for the action.
- `account` = `input.account` — this is exactly the reserved-but-unused field from F12; the sweep
  target is its natural first real use. (The on-chain `erc20Transfer` takes a literal `receiver`; it
  does not read `initiator()` itself, so we pass the declared account.)
- `uint256.max` = the sentinel that resolves to the adapter's full balance of that token at execution
  time, so we don't need to predict the exact residual.
- The `erc20Transfer` leg fn already exists in `bundlerLegAbi` (legs.ts:10) — no new ABI.

### Scope

- **Only for the auto-funding modes** (`erc20-approve`, `permit2`) and **only for exact-OUT actions**
  in `FUNDING_TABLE` — i.e. where *we* moved a cap in and therefore created the residual. Exact-IN
  actions (`deposit`, `unwind-swap`, `exercise` on its exact `cstSharesIn` leg) fund the exact amount
  and leave nothing, so they get no sweep-back for that leg.
- **`pre-funded` mode: no sweep-back.** The caller owns the funding there; sweeping their pre-placed
  balance could contradict their intent. (Could be an opt-in flag later.)
- Sweeping the *full* balance is safe: by the zero-residual invariant the adapter should hold none of
  that token except this bundle's leftover. If it holds a stranger's abandoned residual too, sweeping
  it to our initiator is at worst neutral (that balance was already skimmable by anyone) — worth a
  one-line note in the result, not a blocker.

### Implementation sketch (small, one file + the call site)

1. `funding.ts`: add a `SWEEP_TABLE: Partial<Record<PhoenixAction["type"], TokenRole[]>>` listing the
   capped input roles per exact-OUT action (mirrors `FUNDING_TABLE`'s roles). Extend `FundingPlan`
   with the sweep legs, or return them separately so the handler orders them last.
2. `fundingPlan(...)`: after building the value-in legs, for each `SWEEP_TABLE[action.type]` role,
   emit `call(adapter, encodeFunctionData({ abi: generalAdapterAbi + erc20Transfer, functionName:
   "erc20Transfer", args: [tokenFor(role, tokens), account, MAX_UINT] }))`. Needs `account` threaded
   into `fundingPlan` (new param).
3. `handlers.ts` prepare_phoenix: pass `input.account`; place sweep legs **after** `actionLeg` in the
   bundle array (`[...funding, actionLeg, ...sweepBack]`). Add a `sweep_back` info warning naming the
   swept tokens + recipient so the change is disclosed.
4. Result envelope: expose `sweepBackLegs: n` alongside `fundingLegs: n`.

## The test plan

Two layers, matching the repo's existing pattern.

### Unit (offline, `funding.test.ts` / `handlers.test.ts`)
- A capped `mint` in `erc20-approve` mode produces `[fund(collateral, cap), action, sweep(collateral,
  MAX)]` — assert the third leg is `erc20Transfer(collateral, account, uint256.max)` on the adapter.
- A capped `swap` produces two sweep legs (cST + reference), both to `account`, both after the action.
- `deposit` (exact-IN) produces **no** sweep leg.
- `pre-funded` mode produces no sweep leg.
- The `sweep_back` warning is present and names the tokens + recipient.

### Fork (the load-bearing one — `bundle-sim.test.ts`, gated on `CORK_TEST_RPC`)
This is the empirical proof the leg actually zeroes the residual on-chain:
1. Build a capped `mint`/`swap` where **consumption < cap** (set the cap ~2× the real amount).
2. Execute the multicall on the vnet fork (the harness already does `eth_call`/impersonated send for
   deposit/swap/unwind bundles).
3. **Positive assertion:** `balanceOf(adapter)` for each capped token == 0 after the bundle.
4. **Negative control:** the *same* bundle **without** the sweep-back leg leaves
   `balanceOf(adapter) == cap − consumed > 0` — proving the leg is what closes the gap, and that the
   residual is real (not a phantom).
5. **Recipient assertion:** the initiator's balance increased by exactly `cap − consumed`.

The negative control (step 4) is the key evidence: it demonstrates F13 is real on-chain *and* that
the fix removes it, in one test.

## Risks / open questions

- **Empirically confirm the adapter's non-refund on a fork first.** The three legs are proven by
  source reading; step 4 above is also the fork confirmation that `safeSwap` leaves the residual. Run
  that before shipping the leg, per the brief.
- **Gas.** One extra `erc20Transfer` per capped token (~30–50k gas each). Acceptable for the
  fund-safety it buys; disclose in the result.
- **Ordering.** The sweep must be the last leg(s); if a future action added a post-action leg that
  itself needs the adapter balance, the sweep would starve it. Today no such action exists; assert the
  ordering in the unit test so a future change trips it.
- **`account` semantics.** We sweep to the *declared* `input.account`, not the tx's actual
  `msg.sender`. If a caller broadcasts from a different address than they declared, the residual goes
  to the declared account. That is the correct intent (the declared owner of the funds), but it should
  be documented on the `account` field (which we already relabeled as reserved in F12 — this promotes
  it to load-bearing).

## Relationship to the contract-side fix

The durable fix is in the adapter (deliverable-2 §1c): make `safeSwap` et al. refund the unused
funded amount, and gate `erc20Transfer`'s full-balance path to the initiator. If the contracts adopt
that, this tool-side sweep-back becomes redundant and should be removed. Until then, the sweep-back
protects bundles this tool builds. It does **not** protect bundles other integrators build — only the
contract fix does that, which is why both are proposed.

## Note on the sibling exclusion ("string-ifying wire fields")

The brief grouped "string-ifying wire fields" with this item as a change that alters fund-moving
bundle output. For the record: the F10 blockNumber stringification I **did** apply is on **read
responses only** (`labelLogs`, HyperSync `meta`) — never on a field inside a signed order, a
Bundler3 `Call` struct, or any hashed/fund-moving payload. No signed-payload or bundle wire
representation was changed, so that exclusion was not touched. Nothing further is proposed there.
