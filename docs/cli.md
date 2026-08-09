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

## Read state — `ch query`

```sh
ch query cork-pool --chain-id <id> --pool-id <0x…>       # one pool's full live state
ch query cork-pools --chain-id <id>                      # all pools the venue lists
ch query trading-pairs --chain-id <id>                   # tradable pair listings on the venue book
ch query orderbook --chain-id <id> --pool-id <0x…>       # resting limit orders (--side, --status, --order-hash)
ch query rollover-orders --chain-id <id> --kind orders   # rollover feed (orders | fills | contracts)
ch query rfqs --chain-id <id>                            # open requests-for-quote
ch query rfq --chain-id <id> --rfq-id <rfq_…>            # one RFQ with all its answers
ch query account-state --chain-id <id> --pool-id <0x…> --account <0x…>   # balances + funding allowances
ch query pool-whitelist --chain-id <id> --pool-id <0x…> --account <0x…>  # is a gated pool open to you
ch query whitelisted-addresses --chain-id <id> --pool-id <0x…>           # whitelist membership (HyperSync)
ch query fills --chain-id <id>                           # executed trades
ch query protocol-config --chain-id <id>                 # deployed addresses (no RPC needed)
```

Market-level registry facts (a pair's oracle serves every expiry of that pair):

```sh
ch query registry-assets --chain-id <id> [--address <0x…>]   # the approved assets + their price/NAV sources
ch query registry-recipes --chain-id <id>                    # the approved recipe contracts + live constants
ch query registry-denominations --chain-id <id>              # label → unit table
ch query registry-feeds --chain-id <id>                      # directed conversion feeds, live answers
ch query registry-oracle --chain-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --oracle-mode <price|nav>   # the pair's oracle status
ch query derive-cork-pool --chain-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry <unix> --recipe <0x…>
  # derive one pool BEFORE it exists: poolId, cST/cPT, constraint, existence
```

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
ch prepare market deploy-oracle --chain-id <id> --collateral-asset <0x…> --reference-asset <0x…>
ch prepare market deploy-fixed-oracle --chain-id <id> --rate <1e18-scale>
```

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
