# `ch` — CLI reference

`ch` is the Cork command line. One command per tool, one subcommand per action, one flag per
field. Every command either reads state or builds an **unsigned** artifact. You sign and
broadcast with your own wallet and your own RPC. `ch` never holds a key.

This page is the map. `ch <command> --explain` prints the exact contract of any command, with
every field and its meaning. `ch capabilities` is the searchable manual.

## 1. How a command is shaped

```sh
ch <command> [subcommand] --chain-id <id|name> [--field <value> …]   # fields as flags
ch <command> --json '<object>'                                          # the same input as one JSON object
ch <command> … --json                                                   # bare --json: print the raw result envelope
ch <command> --explain                                                  # print the contract and exit
```

- **Chain.** `--chain-id` takes a number or a name: `mainnet`, `arbitrum`, `base`, `sepolia`.
- **Amounts** are base units of the token. Flags accept exact sugar: `1000e18`, `95e16`, `1_000000`.
  A fractional remainder is refused. Inside a `--json` object, amounts are plain digit strings.
- **Idempotency.** Every prepare and submit takes `--client-request-id`. Reuse the id when you
  retry the same request. Use a new id for a new intent.
- **RPC.** Chain-backed commands pick a public endpoint by themselves. `--rpc-url` overrides it. An
  explicit endpoint must answer for the requested chain, or the command refuses.
- **Output.** Prose by default. `--json` (bare) or `CORK_JSON=1` prints the result envelope.

Every result is one envelope: `{ state, data, warnings[], provenance }`. Read `state` first.
`ok` means use `data`. `unavailable` means the call could not be served, and `warnings[0].code`
says why. `conflict` means the tool ran and found a mismatch you must not paper over. The exit
code mirrors the state: `0` ok, `2` invalid input, `3` unavailable, `4` conflict, `1` unexpected.

## 2. Generations

A chain hosts a set of contract generations. One is primary. On Arbitrum One and Base the primary
is `cork/v0.4` and the previous set is `cork/v0.3`. A label names the Distribution bundle the
contracts were cut in, not the core protocol: Phoenix is one component of a bundle. Each result
also carries the bundle's own record name in `generation.distribution`.

Three rules cover every command:

1. **A pool decides its own generation.** A command that names `--pool-id` finds the pool on
   the chain and uses the contracts that pool belongs to. You pass no switch.
2. **A new thing goes to the primary.** A registry read, a derivation or a new market targets the
   primary unless you pass `--generation`. The flag takes a label (`cork/v0.3`), `previous` (the
   newest active non-primary set that has the contracts the command needs) or `primary`.
3. **Every result names its generation.** Read `data.generation` and `provenance.generation`.
   Results carry the label, never the alias.

`ch query protocol-config` lists a chain's generations with every address and wire.
`ch capabilities --topic generations` explains the model. A pool no generation knows is
`pool_not_found`. A label the chain does not configure is `generation_unknown`. The 0.6.0
spellings `phoenix/v0.4-rc.1` and `phoenix/v0.3-rc.1` still resolve to the new labels.

## 3. Read state — `ch query`

The vocabulary: a **cork-pool** is one expiry of a **market**, the family of pools over one
collateral/reference pair. A **trading-pair** is a pair listed on the LOP venue book. The
**orderbook** holds that pair's resting orders. **Rollover-orders** move a position to a
successor pool.

```sh
ch query protocol-config --chain-id <id>                 # every generation, every address, no RPC needed
ch query cork-pool  --chain-id <id> --pool-id <0x…>      # one pool's live state, on its own generation
ch query cork-pools --chain-id <id>                      # the pools the venue lists (--mode full-decentralized: from the chain)
ch query trading-pairs --chain-id <id>                   # pairs listed for trading

ch query orderbook --chain-id <id> --pool-id <0x…> --account <0x…>    # resting orders, RANKED for the fill sender
ch query orderbook --chain-id <id> --pool-id <0x…> --sort venue       # the venue's own order, every row
ch query orderbook … --account <0x…> --watch [--interval <s>] [--iterations <n>]   # print only the ticks that changed
ch query offers    --chain-id <id> --pool-id <0x…> --account <0x…>    # live orders joined with the RFQ quotes they cite
ch query fills     --chain-id <id>                                     # executed trades
ch query rollover-orders --chain-id <id> --kind orders                 # orders | fills | contracts

ch query rfqs --chain-id <id>                                          # open requests-for-quote
ch query rfq  --chain-id <id> --rfq-id <rfq_…>                         # one RFQ with its answers
ch query rfqs --chain-id <id> --underwriter <0x…> --with-answers true  # the RFQs you answered
ch query rfqs --chain-id <id> --watch [--interval <s>]                 # alert when a requester accepts a quote nobody rested

ch query account-state --chain-id <id> --pool-id <0x…> --account <0x…>   # balances and funding allowances for one pool
ch query account-state --chain-id <id> --account <0x…>                   # NO pool id: your positions across every generation
ch query pool-whitelist --chain-id <id> --pool-id <0x…> --account <0x…>  # is a gated pool open to you
ch query whitelisted-addresses --chain-id <id> --pool-id <0x…>           # whitelist membership; needs ENVIO_HYPERSYNC_TOKEN, else hypersync_unavailable
```

The **fill sender** is the address that will call the protocol. For a wallet that fills through a
ForSelf adapter, pass the adapter as `--account`. The ranked book classifies every row against
it, collapses one-cancels-the-other rungs to their best, and sets aside rows the maker cannot
deliver, with the reason.

**Lists page.** Venue lists take `--page-size` and `--max-pages`; a partial walk returns `ok` with
`pagination_incomplete` and a `--cursor` to resume. `--mode` names who the call may contact:
`hybrid` (the venue plus your RPC, the default for lists), `lite-decentralized` (your RPC only),
`full-decentralized` (your RPC plus HyperSync, never the venue). The tool never substitutes a
mode for you.

### Registry reads

A pair's oracle serves every expiry of that pair, so these facts are market-level.

```sh
ch query registry-assets --chain-id <id> [--address <0x…>]   # approved assets with their price and NAV sources
ch query registry-recipes --chain-id <id>                    # approved recipe contracts with live constants
ch query registry-denominations --chain-id <id>              # denomination units
ch query registry-feeds --chain-id <id>                      # directed conversion feeds with live answers
ch query registry-oracle --chain-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --oracle-mode <price|nav>   # the pair's oracle: deployed, deployable, rate
ch query derive-cork-pool --chain-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry <unix> --recipe <0x…> \
  [--swap-fee-percentage <1e18=1%>] [--unwind-swap-fee-percentage <…>] [--oracle-salt <bytes32>]
  # derive one pool BEFORE it exists: pool id, cST and cPT addresses, constraint, existence
```

What the registry assumes, and what `ch` therefore does:

- **Modes compose differently.** `price` needs a price source on every leg. `nav` needs at least
  one NAV source and lets a leg fall back to price. A pair that cannot compose reports
  `deployable: false` with the registry's own error. The fix is registration, not a retry.
- **Pair order and mode both matter.** `(ca, ref)` and `(ref, ca)` are different pairs. One pair
  can hold a `price` wrapper and a `nav` wrapper at different addresses.
- **Feeds are directed.** base→quote is not quote→base. Each feed carries `live.decimals`.
- **Denominations follow the wire.** The 0.5.0 registry (the primary) lists address units and takes
  `--address`. The 0.3.3 registry (`--generation cork/v0.3`) keys them by exact-bytes `--label`.
- **Recipe constants mix two scales by name.** A constant ending `_PERCENTAGE` is on the 1e18 = 1%
  scale. A `RATE_MIN`-style constant is an absolute rate, 1e18 = 1.0. `ch capabilities --topic
  units` is the full table.
- **On the primary the two fees are part of the pool id.** Pass the fees you will create with, or
  the derived id is a different pool. The salt matters only for a pair's first oracle.
- **A pair whose oracle is not deployed yet needs an anchor rate.** The liquidity recipe reads
  the live oracle when one exists and refuses otherwise (`recipe_refused`, `MalformedExtraData`).
  `ch query registry-oracle` tells you: `deployed: false, deployable: true`. Pass the anchor as
  `abi.encode(uint256 anchorRate)`, 1e18 = 1.0, and the fill deploys the oracle in the same
  transaction:

  ```sh
  ch compute recipe-rate-constraint … --recipe <nav-recipe> --args-uints '["1090410000000000000"]'
  ch query derive-cork-pool         … --recipe <nav-recipe> --args 0x<anchor as 32 bytes>
  ch prepare market create-pool     … --recipe <nav-recipe> --extra-data 0x<anchor as 32 bytes>
  ```

  A useful anchor is the pair's live rate on the previous registry (`--generation previous` on
  `registry-oracle`). Once the oracle is deployed the recipe ignores the anchor and reads the
  chain.
- **`derive-cork-pool` simulates the registry's own deploy.** The prediction is an `eth_call` of
  the real deployment, so it cannot drift from what a fill does. The RPC must honor state
  overrides. If it does not, `ch` returns the derivation without share addresses and says so.
- **Never infer the chain from an address.** The stack deploys at identical addresses on both
  chains. Only `--chain-id` selects the deployment.

## 4. Migrate between generations

Moving funds from a pool on the previous set to a pool on the current one takes ordinary
commands. Every pool-scoped command follows the pool's own generation, so you pass pool ids, not
generation switches.

```sh
# 1. What do I hold, and where? One row per pool with a balance, tagged with its generation.
ch query account-state --chain-id 8453 --account <0x…>
ch query account-state --chain-id 8453 --account <0x…> --generation previous   # only the previous set

# 2. Exit each old pool with the action for its expiry state.
ch unwind-deposit --chain-id 8453 --pool-id <old> --collateral-assets-out 1000e6 --max-cpt-and-cst-shares-in 1100e18 \
  --owner <0x…> --receiver <0x…> --account <0x…> --client-request-id mig-exit-0001 --funding-mode erc20-approve   # before expiry
ch withdraw --chain-id 8453 --pool-id <old> …                                                                    # after expiry

# 3. Enter on the primary. Create the pool first if it does not exist yet.
ch prepare market create-pool --chain-id 8453 --client-request-id mig-create-0001 \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry-timestamp <unix> --recipe <0x…>
ch deposit --chain-id 8453 --pool-id <new> --collateral-assets-in 1000e6 --min-cpt-and-cst-shares-out 1 --receiver <0x…> …

# 4. Verify.
ch track reconcile --chain-id 8453 --subject '{"kind":"txHash","txHash":"0x…"}'
```

The positions read scans the chain over your RPC and finds every pool in one request. Each row
carries the expiry as ISO-8601 UTC and as unix seconds. `--mode hybrid` takes the venue's pool
list instead. `ch capabilities --topic migration` is the full recipe.

## 5. Deterministic math — `ch compute`

```sh
ch compute recipe-rate-constraint --chain-id <id> --recipe <0x…> \
  --collateral-asset <0x…> --reference-asset <0x…> [--args-uints '["<anchor>"]']   # the constraint a JIT order carries
ch compute cst-swap-rate  --chain-id <id> --pool-id <0x…> --collateral-assets-out <amt>   # cost of a cover payout
ch compute unwind-rate    --chain-id <id> --pool-id <0x…> --collateral-assets-in <amt>
ch compute impairment-floor --chain-id <id> --pool-id <0x…> --horizon-seconds <n>       # worst case, not a forecast
ch compute rollover-premium-floor --dst-cst-produced <amt> --min-premium-per-share <rate>  # pure math, no RPC
ch compute dutch-auction-price --chain-id <id> --order '{…}'                             # current decayed Fusion price, local math
```

Every money field in a result carries a unit label in `scales`. Read the labels. Do not assume
18 decimals.

## 6. Build unsigned artifacts — `ch prepare`

Every prepare returns bytes or typed data plus `data.execution`, the ordered steps that finish
the job: simulate, sign, decode the signed transaction, send through your RPC, track. Nothing is
signed or sent here.

### Pool actions

Thirteen actions. Each is a subcommand of `ch prepare pool` and also a top-level verb:
`ch exercise …` is `ch prepare pool exercise …`.

```sh
ch deposit  --chain-id <id> --account <0x…> --client-request-id <id> --pool-id <0x…> \
  --collateral-assets-in <amt> --receiver <0x…> --min-cpt-and-cst-shares-out <amt> [--funding-mode permit2|erc20-approve]
ch exercise --chain-id <id> --account <0x…> --client-request-id <id> --pool-id <0x…> \
  --cst-shares-in <amt> --receiver <0x…> --min-collateral-assets-out <amt> --max-reference-assets-in <amt>
ch mint · ch swap · ch exercise-other                                  # enter and take cover
ch unwind-deposit · ch unwind-mint · ch unwind-swap · ch unwind-exercise · ch unwind-exercise-other   # reverse, before expiry
ch withdraw · ch withdraw-other · ch redeem                            # settle, after expiry
ch prepare pool authority-onboard --chain-id <id> --account <0x…> --client-request-id <id> --token <0x…> --spender <0x…>   # standing approve
ch prepare pool authority-revoke  … --token <0x…> --spender <0x…>                                                           # zero it
```

`--account` is the address that funds the bundle. It also receives the sweep-back of any unspent
cap, so set it to the real payer. A bundle pulls, acts and sweeps in one transaction; a plan that
cannot be atomic is refused. For a session-key wallet, `--for-self '{"adapter":"0x…"}'` emits a
direct call to your ForSelf adapter instead of a bundle.

### Orders

```sh
ch prepare order maker-order --chain-id <id> --account <0x…> --client-request-id <id> --pool-id <0x…> \
  --side SELL --maker-asset <0x…> --taker-asset <0x…> --making-amount <amt> --taking-amount <amt> \
  [--expiry-seconds <n>] [--allowed-sender <0x…>] [--oco-group <key>] [--jit-market '{…}'] [--auction '{…}']
ch prepare order maker-ladder … --rungs '[{"takingAmount":"…"},{"takingAmount":"…","allowedSender":"0x…"}]'   # 2 to 32 rungs in one call
ch prepare order answer-rfq --chain-id <id> --account <0x…> --client-request-id <id> --rfq-id <rfq_…> \
  [--answer-id <…> --option-id <…>] [--premium-annualized "0.041"] [--fill-sender <0x…>]            # one call from RFQ to signable order
ch prepare order finalize-maker-order --chain-id <id> --account <0x…> --client-request-id <id> \
  --prepared '{…}' --signature <0x…> --listing '{…}'                                                   # verify your signature, get the submit payload
ch fill --chain-id <id> --account <0x…> --client-request-id <id> --order-hash <0x…> \
  [--fill-making-amount <amt>] [--for-self '{"adapter":"0x…","poolId":"0x…"}']                        # unsigned fill calldata
ch prepare order refresh-order --chain-id <id> --account <0x…> --client-request-id <id> --order-hash <0x…>   # re-rest on the same nonce
ch prepare order cancel --chain-id <id> --account <0x…> --client-request-id <id> --order-hash <0x…> --maker-traits <n>
ch prepare order rollover-intent --chain-id <id> --account <0x…> --client-request-id <id> --settler <0x…> …   # signable ERC-7683 order
```

Three facts about orders. First, a Cork-built order fills once: the first fill of any size
spends it, so post several smaller orders to serve several takers. Second, `--oco-group` ties
orders to one nonce so the first fill retires the rest. Third, `--allowed-sender` reserves the
fill for the address that calls the protocol; for a ForSelf wallet that is the adapter, not the
Safe. `ch capabilities --topic orders` gives one term per concept.

### Markets

```sh
ch prepare market deploy-oracle --chain-id <id> --client-request-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> [--mode price|nav] [--oracle-salt <bytes32>]
ch prepare market deploy-fixed-oracle --chain-id <id> --client-request-id <id> --rate <1e18=1.0>
ch prepare market create-pool --chain-id <id> --client-request-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry-timestamp <unix> --recipe <0x…> \
  [--extra-data <0x…>] [--swap-fee-percentage <1e18=1%>] [--unwind-swap-fee-percentage <…>] [--oracle-salt <bytes32>]
```

All three are permissionless and safe to repeat. `create-pool` builds the pool a just-in-time
order would create, before the fill. Use it from a Safe or any contract account: the mid-fill
mint needs a permit only a plain wallet can sign. The registry allows an expiry at most 30 days
out; `ch` warns before the transaction can revert.

The JIT block (`--jit-market` on orders, the flags above on `create-pool`) names the recipe bytes
`extraData`. The old name `additionalData` still works with a deprecation notice. The bytes follow
the selected generation's wire: nested on `cork/v0.4`, flat on `cork/v0.3`.

## 7. Inspect bytes — `ch decode`

```sh
ch decode calldata --chain-id <id> --data <0x…> [--to <0x…>]   # labeled legs; --to verifies the target
ch decode tx      --chain-id <id> --data <0x…>                 # a SIGNED raw tx: signer, target, legs. Run this before you broadcast.
ch decode order   --chain-id <id> --data '{…}'                 # LOP order: traits, orderHash, JIT and auction labels
ch decode event   --chain-id <id> --data '{…one log…}'
ch decode receipt --chain-id <id> --data '{…}'
```

`ch` reconstructs from the bytes. It never trusts a parse you hand it. A leg at the wrong contract
is `TARGET MISMATCH — do not sign`.

## 8. Verify, simulate, reconcile — `ch track`

```sh
ch track simulate  --chain-id <id> --subject '{"kind":"artifact","artifact":{…}}'   # would the frozen bytes revert? Run before you sign.
ch track verify    --chain-id <id> --subject '{"kind":"marketRef","poolId":"0x…"}'
ch track reconcile --chain-id <id> --subject '{"kind":"txHash","txHash":"0x…"}'
ch track reconcile --chain-id <id> --subject '{"kind":"orderHash","orderHash":"0x…"}'
```

Each subject kind is also a subcommand: `ch track tx-hash reconcile --tx-hash <0x…>`. The chain
outranks the venue. A disagreement is `conflict`.

## 9. Relay signed payloads — `ch submit`

The only command with a side effect. It relays a payload you already signed to the venue. It
never signs.

```sh
ch submit lop-order      --chain-id <id> --client-request-id <id> --action '{…}'   # rest a signed order; the payload is finalize-maker-order's submitInput
ch submit rollover-order --chain-id <id> --client-request-id <id> --action '{…}'
ch submit rfq-open       --chain-id <id> --client-request-id <id> --action '{…}'   # open a request-for-quote (buyer)
ch submit rfq-answer     --chain-id <id> --client-request-id <id> --action '{…}'   # answer one (underwriter); revisions replace
ch submit rfq-counter    --chain-id <id> --client-request-id <id> --action '{…}'   # counter-bid (requester)
```

A venue listing carries one premium field, `premiumAnnualized`, a fraction string: `"0.041"` is
4.1%. `ch` recomputes every commitment before relay and refuses a payload whose signature does
not recover to its maker.

## 10. Discover

```sh
ch capabilities                          # the 9 tools and their maturity
ch capabilities --search "unwind"        # keywords → tool, variant, ready-to-run example
ch capabilities --topic signing          # sign → validate → broadcast
ch capabilities --topic migration        # move funds between generations
ch capabilities --topic orders           # reach, groups, liveness: one term per concept
ch capabilities --topic units            # the scale table
ch <command> --explain                   # the exact contract, per subcommand
```

## 11. Run and maintain

```sh
ch version [--json]                      # version, commit, embedded HyperSync binding
ch mcp                                   # MCP server on stdio: claude mcp add cork-defi -- ch mcp
ch mcp --http [--port 8080] [--host 0.0.0.0] [--trust-forwarded-for]   # Streamable HTTP: /mcp, /healthz, /readyz, /docs/<topic>
ch self-update [--tag <vX.Y.Z>] [--dry-run] [--allow-downgrade]         # verifies provenance before it swaps the binary
```

Set `CORK_MCP_TOKEN` for bearer auth on the HTTP server. Pass `--trust-forwarded-for` only behind
an ingress you control; without it every caller behind a proxy shares one client slot.
`ENVIO_HYPERSYNC_TOKEN` enables `--mode full-decentralized` over the HyperSync archive.

Accepted synonyms, and the pre-rename names that answer with their new name, are listed in the
README's synonym table.
