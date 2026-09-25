# `ch` — CLI reference

One command per tool, one subcommand per action, fields as flags. Everything returns **unsigned**
artifacts or plain reads — you sign and broadcast with your own stack. Output is prose by default;
add `--json` for the raw result envelope. `--explain` on any command prints its exact contract.

The taxonomy in one line: a **cork-pool** is one expiry of a **market** (the family of pools over
one collateral/reference pair — an *instance* of it, not an AMM pool); a **trading-pair** is a pair
listed for trading on the LOP venue book; the **orderbook** holds that pair's resting orders;
**rollover-orders** are orders whose execution migrates a position to a successor pool.

Common flags everywhere: `--chain-id <id|name>` (`mainnet`/`arbitrum`/`base` work), `--json`,
`--rpc-url <url>`, `--explain`. Amounts take exact sugar: `1000e18`, `95e16`, `1_000000`.
Retrying the same request? Reuse its `--client-request-id`; new intent, new id.

**Generations.** A chain hosts a SET of contract generations, one of them primary
(`cork/v0.4` on Arbitrum and Base). Every chain-backed command takes
`--generation <label>`. Omit it and a prepare targets the primary; a pool-scoped read or bundle
(`--pool-id …`) follows the generation the POOL lives on, resolved from the chain, and reports it
as `data.generation`. `ch query protocol-config` lists a chain's generations with each block's
addresses and wire; `ch capabilities --topic generations` explains the model. A pool no generation
knows is `pool_not_found`; a label the chain does not configure is `generation_unknown`.

## Read state — `ch query`

```sh
ch query cork-pool --chain-id <id> --pool-id <0x…>       # one pool's full live state
ch query cork-pools --chain-id <id>                      # all pools the venue lists
ch query trading-pairs --chain-id <id>                   # tradable pair listings on the venue book
ch query orderbook --chain-id <id> --pool-id <0x…>       # resting limit orders (--side, --status, --order-hash)
ch query rollover-orders --chain-id <id> --kind orders   # rollover feed (orders | fills | contracts)
ch query rfqs --chain-id <id>                            # open requests-for-quote
ch query rfq --chain-id <id> --rfq-id <rfq_…>            # one RFQ with all its answers
ch query rfqs --chain-id <id> --underwriter <0x…> --with-answers true   # the RFQs you answered (venue-side filter)
ch query account-state --chain-id <id> --pool-id <0x…> --account <0x…>   # balances + funding allowances
ch query account-state --chain-id <id> --account <0x…>   # NO pool id: the account's positions across every generation (pools scanned over your RPC; --mode hybrid takes the venue's list)
ch query pool-whitelist --chain-id <id> --pool-id <0x…> --account <0x…>  # is a gated pool open to you
ch query whitelisted-addresses --chain-id <id> --pool-id <0x…>           # whitelist membership (HyperSync)
ch query fills --chain-id <id>                           # executed trades
ch query protocol-config --chain-id <id>                 # deployed addresses (no RPC needed)
```

Market-level registry facts (a pair's oracle serves every expiry of that pair):

```sh
ch query registry-assets --chain-id <id> [--address <0x…>]   # the approved assets + their price/NAV sources
ch query registry-recipes --chain-id <id>                    # the approved recipe contracts + live constants
ch query registry-denominations --chain-id <id>              # denomination units (address-keyed on the 0.5.0 registry; label → unit on 0.3.3)
ch query registry-feeds --chain-id <id>                      # directed conversion feeds, live answers
ch query registry-oracle --chain-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --oracle-mode <price|nav>   # the pair's oracle status
ch query derive-cork-pool --chain-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry <unix> --recipe <0x…> \
  [--swap-fee-percentage <1e18=1%>] [--unwind-swap-fee-percentage <…>] [--oracle-salt <bytes32>]
  # derive one pool BEFORE it exists: poolId, cST/cPT, constraint, existence
  # (on the 10-field primary the two fees are part of the pool id; the salt matters only for a pair's first oracle)
```

**Registry semantics these commands assume** (the contract-level rules; the JIT-order side is
[jit-order-anatomy.md](jit-order-anatomy.md)):

- **Oracle modes compose differently.** `price` requires **every** leg of the pair to carry a
  price source; `nav` lets a leg fall back to its price source but requires **at least one**
  leg to carry a real NAV source. A pair that cannot compose in the mode you asked reports
  `deployable: false` with the registry's own error (`MissingSource`,
  `NavModeWithoutNavSource`) — the fix is registration (Cork-side), not retrying.
- **Pair order matters, and so does mode.** `(ca, ref)` and `(ref, ca)` are different pairs
  with different oracles, and one pair can hold a `price` wrapper *and* a `nav` wrapper at
  different addresses. A wrapper's identity also folds in which source each leg actually
  resolved to (a `nav` leg that fell back to price is part of the key, not hidden).
- **Feeds are directed edges.** base→quote ≠ quote→base. Each feed carries `live.decimals`
  (the aggregator now); on the 0.3.3 registry (`flat` wire) it also carries `feedDecimals`
  (recorded at registration), and comparing the two is how you spot a feed whose decimals drifted
  after registration. The 0.5.0 registry records no `feedDecimals`.
- **Denominations are keyed by wire.** The 0.5.0 registry (`nested`, the primary) lists address
  units (`{ unit, symbol, name }`) and takes `--address` for a single lookup; the 0.3.3 registry
  (`flat`, `--generation cork/v0.3`) keys them by exact-bytes `--label`. Passing `--label`
  to a nested-wire registry is refused with teaching.
- **Recipe values mix two scales by name.** In `registry-recipes` constants, anything ending
  `_PERCENTAGE` is on the 1e18-=-1% scale; `RATE_MIN`-style values are absolute rates
  (1e18 = 1.0); a bare count is neither. Read each value's own name — `ch capabilities
  --topic units` is the full table.
- **Recipe `args` is a verbatim ABI tuple string.** Use `args.type` exactly as served: a recipe
  taking one *struct* reads `((string,uint256))` — double brackets — while loose values read
  `(string,uint256)`, and the encodings differ whenever a member is dynamic. Never convert one
  form to the other by hand.
- **`derive-cork-pool` simulates the registry's own `deploy`.** The prediction comes from an
  `eth_call` simulation of the real deployment (state overrides let it run before the oracle
  exists), not from a local salt re-derivation — so it cannot drift from what a fill will do.
  Consequence: the RPC must honor `eth_call` state overrides / `eth_simulateV1`. The built-in
  default endpoints do; on an RPC that doesn't, `ch` returns the derivation **without** share
  addresses and says so (`share_prediction_unavailable`) rather than inventing them.
- **Never infer the chain from an address.** The stack deploys at identical addresses across
  chains by design; only `--chain-id` selects the deployment. And a superseded generation's
  contracts still *answer* current-shaped calls with plausible values — pin the registry
  address from `ch query protocol-config` (or the Distribution manifest) and let the prepare
  guard (`adapter_binding_mismatch`) do the cross-check on anything you sign.

## Migrating between generations

A chain hosts a set of contract generations, one primary (`ch query protocol-config` lists
them). Moving funds from a pool on the previous generation to a pool on the current one takes
ordinary commands: every pool-scoped command resolves the pool's generation from the chain and
targets THAT set's adapter, so you pass pool ids, not generation switches.

```sh
# 1. What do I hold, where? One row per pool with a non-zero cST/cPT balance, tagged with its generation.
ch query account-state --chain-id 42161 --account <0x…>
ch query account-state --chain-id 42161 --account <0x…> --generation previous   # only the previous set

# 2. Exit each old pool with the action for its expiry state (the tool follows the pool's generation).
ch unwind-deposit --chain-id 42161 --pool-id <old> --collateral-assets-out 1000e18 --max-cpt-and-cst-shares-in 1100e18 \
  --owner <0x…> --receiver <0x…> --account <0x…> --client-request-id mig-exit-0001 --funding-mode erc20-approve   # before expiry
ch withdraw --chain-id 42161 --pool-id <old> …    # after expiry (or redeem / withdraw-other)

# 3. Enter the new pool on the primary (create it first if it does not exist yet).
ch prepare market create-pool --chain-id 42161 --collateral-asset <0x…> --reference-asset <0x…> --expiry-timestamp <unix> --recipe <0x…> …
ch deposit --chain-id 42161 --pool-id <new> --collateral-assets-in 1000e18 --min-cpt-and-cst-shares-out 1 --receiver <0x…> …

# 4. Verify.
ch track reconcile --tx-hash <0x…>
```

`--generation` takes a label (`cork/v0.3`), `previous` (the newest active non-primary set
that carries the contracts the command needs) or `primary` (the default). Results always carry the
resolved label, never the alias. `all` is refused on every command but the positions read, which
spans generations by itself. `ch capabilities --topic migration` is the full recipe, including the
one standing fact about the new set (it has no CREATE2 attestation; its registry has held
registered assets since 2026-09-23).

## Deterministic math — `ch compute`

```sh
ch compute recipe-rate-constraint --chain-id <id> --recipe <0x…> \
  --collateral-asset <0x…> --reference-asset <0x…>     # the rate constraint a JIT order carries (recipe.resolve)
ch compute cst-swap-rate --chain-id <id> --pool-id <0x…> --collateral-assets-out <amt>
ch compute unwind-rate --chain-id <id> --pool-id <0x…> --collateral-assets-in <amt>
ch compute impairment-floor --chain-id <id> --pool-id <0x…> --horizon-seconds <n>
ch compute rollover-premium-floor --dst-cst-produced <amt> --min-premium-per-share <rate>
ch compute dutch-auction-price --chain-id <id> --order '{…}'   # current decayed Fusion price, local math
```

## Build unsigned artifacts — `ch prepare` (+ top-level verbs)

Pool actions (each returns an unsigned bundle + `data.execution` naming the completion path;
all 13 are also top-level verbs — `ch exercise …` ≡ `ch prepare pool exercise …`):

```sh
ch deposit   --chain-id <id> --account <0x…> --client-request-id <id> --pool-id <0x…> \
  --collateral-assets-in <amt> --receiver <0x…> --min-cpt-and-cst-shares-out <amt>
ch exercise  … --cst-shares-in <amt> --min-collateral-assets-out <amt> --max-reference-assets-in <amt>
ch swap … · ch mint … · ch redeem … · ch withdraw … · ch withdraw-other …
ch unwind-deposit … · ch unwind-mint … · ch unwind-swap … · ch unwind-exercise …
ch unwind-exercise-other … · ch exercise-other …
ch prepare pool authority-onboard --token <0x…> --spender <0x…>   # standing ERC-20 approve tx
ch prepare pool authority-revoke  --token <0x…> --spender <0x…>   # zero it
```

Orders and fills:

```sh
ch prepare order maker-order --chain-id <id> --account <0x…> --client-request-id <id> \
  --side SELL --maker-asset <0x…> --taker-asset <0x…> --making-amount <amt> --taking-amount <amt> \
  [--jit-market '{…}'] [--auction '{…}']            # signable LOP typed-data (JIT / decaying premium)
ch fill --chain-id <id> --account <0x…> --client-request-id <id> --order-hash <0x…> \
  [--fill-making-amount <amt>] [--for-self '{"adapter":"0x…","poolId":"0x…"}']   # unsigned fill calldata
ch prepare order finalize-maker-order --prepared '{…}' --signature <0x…> --listing '{…}'
ch prepare order cancel --order-hash <0x…> --maker-traits <n>
ch prepare order rollover-intent --settler <0x…> …    # signable ERC-7683 rollover order
```

Market infrastructure (market-level; permissionless + idempotent):

```sh
ch prepare market deploy-oracle --chain-id <id> --collateral-asset <0x…> --reference-asset <0x…> \
  [--mode price|nav] [--oracle-salt <bytes32>]      # the 0.5.0 registry takes the salt; 0.3.3 does not
ch prepare market deploy-fixed-oracle --chain-id <id> --rate <1e18-scale>
ch prepare market create-pool --chain-id <id> --client-request-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry-timestamp <unix> --recipe <0x…> \
  [--extra-data <0x…>] [--swap-fee-percentage <…>] [--unwind-swap-fee-percentage <…>]
  # create the pool a JIT order derives AHEAD of the fill (the smart-account path around EOA-only permits)
```

The JIT market block (`--jit-market '{…}'` on orders, the flags above on `create-pool`) names the
recipe bytes `extraData`; `additionalData` is accepted as an alias with a deprecation notice. The
bytes follow the selected generation's registry wire: nested (`MarketParams` + `oracleSalt`, a
10-field pool id with the fees inside) on `cork/v0.4`; flat on `cork/v0.3`.

## Inspect bytes — `ch decode`

```sh
ch decode calldata --chain-id <id> --data <0x…>     # labeled legs, Bundler3 unwrapped
ch decode tx --chain-id <id> --data <0x…>           # SIGNED raw tx: recovered signer + named target
ch decode order --chain-id <id> --data '{…}'        # LOP order: traits, orderHash, JIT/auction labels
ch decode event --chain-id <id> --data '{…one log…}'
ch decode receipt --chain-id <id> --data '{…}'
```

## Verify / simulate / reconcile — `ch track`

```sh
ch track simulate  --chain-id <id> --subject '{"kind":"artifact","artifact":{…}}'   # wouldRevert BEFORE signing
ch track verify    --chain-id <id> --subject '{"kind":"marketRef","poolId":"0x…"}'
ch track reconcile --chain-id <id> --subject '{"kind":"orderHash","orderHash":"0x…"}'
ch track reconcile --chain-id <id> --subject '{"kind":"txHash","txHash":"0x…"}'
```

## Relay signed payloads — `ch submit` (the only side-effecting command)

```sh
ch submit lop-order      … --signature <0x…>    # rest a signed order on the venue book
ch submit rollover-order … --signature <0x…>    # relay a signed rollover order
ch submit rfq-open       … --signature <0x…>    # open a request-for-quote
ch submit rfq-answer     … --signature <0x…>    # answer one (underwriter side)
```

## Discovery

```sh
ch capabilities                          # the manual: tools + maturity
ch capabilities --search "<anything>"    # keywords → tool/variant + ready-to-run examples
ch capabilities --topic signing          # the sign → validate → broadcast guide
ch <command> --explain                   # the exact contract, per subcommand
```

Accepted synonyms and the pre-rename names (which never silently work — they answer with their
new name) are listed in the README's synonym table.
