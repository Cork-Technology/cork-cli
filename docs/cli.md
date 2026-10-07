# `ch` — CLI reference

`ch` is the Cork command line. One command per tool, one subcommand per action, one flag per
field. Tool commands read state, build **unsigned** artifacts, or relay caller-authorized venue
payloads. The optional CLI keystore commands can sign after human confirmation and a terminal-only
password prompt. MCP never holds keys or signs. Broadcast onchain transactions through your own RPC.

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
Schema/CLI rejection writes an error to **stderr**, not a result envelope to stdout. Domain
and preflight rejection can instead return an `unavailable` result on **stdout** (exit `3`).
With `--json`, inspect both the exit code and the appropriate JSON channel. A nonempty
`warnings` array alone does not mean failure: an `ok` preparation still exits `0` and returns
its unsigned artifact. Read each warning before deciding whether to sign or proceed.

## 2. Generations

A chain hosts a set of contract generations. One is primary. On Arbitrum One and Base the primary
is `phoenix/v0.4-rc.1` and the previous set is `phoenix/v0.3-rc.1`. A label names the Distribution record
the contracts were cut in. Each result also carries that record name in `generation.distribution`.

Three rules cover every command:

1. **A pool decides its own generation.** A command that names `--pool-id` finds the pool on
   the chain and uses the contracts that pool belongs to. You pass no switch.
2. **A new thing goes to the primary.** A registry read, a derivation or a new market targets the
   primary unless you pass `--generation`. The flag takes a label (`phoenix/v0.3-rc.1`), `previous` (the
   newest active non-primary set that has the contracts the command needs) or `primary`.
3. **Every result names its generation.** Read `data.generation` and `provenance.generation`.
   Results carry the label, never the alias.

`ch query protocol-config` lists a chain's generations with every address and wire.
`ch capabilities --topic generations` explains the model. A pool no generation knows is
`pool_not_found`. A label the chain does not configure is `generation_unknown`.

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
ch query rfqs --chain-id <id> --rfq-kind rollover                      # rollover RFQs only (--kind selects the flows feed)

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
  `--address`. The 0.3.3 registry (`--generation phoenix/v0.3-rc.1`) keys them by exact-bytes `--label`.
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

**Burn-side actions need one allowance from you.** `withdraw`, `withdraw-other`, `redeem`,
`unwind-deposit` and `unwind-mint` burn cST or cPT from `owner`. When `owner` is your account, the
pool burns with the adapter as caller, so approve the cST and cPT to the **cork adapter** of the
pool's generation first. The result says so under `owner_managed_funding` and names the adapter.
An allowance to the pool manager is never spent. Without the allowance the bundle reverts
`ERC20InsufficientAllowance`, and `ch track simulate` shows it before you sign. Verified on a Base
fork on 2026-09-25.

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
  [--answer-id <…> --option-id <…>] [--premium-annualized "0.041"] [--fill-sender <0x…>]            # the order AND the answer option that carries it
ch prepare order rfq-write --chain-id <id> --account <0x…> --client-request-id <id> --request '{"type":"rfq-open",…}'
                                                                                                     # the CorkRfqWrite typed data every RFQ write is signed with
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
order would create, before the fill. A Safe or any contract account needs it on the flat
(0.3.x) wire, where the mid-fill mint needs a permit only a plain wallet can sign. On the nested
wire (the primary, JIT adapter 0.5.0+) a contract account can instead sign that permit through
ERC-1271 and pass it as `signature`. The registry allows an expiry at most 30 days
out; `ch` warns before the transaction can revert.

The JIT block (`--jit-market` on orders, the flags above on `create-pool`) names the recipe bytes
`extraData`. The old name `additionalData` still works with a deprecation notice. The bytes follow
the selected generation's wire: nested on `phoenix/v0.4-rc.1`, flat on `phoenix/v0.3-rc.1`.

## 7. Inspect bytes — `ch decode`

```sh
ch decode calldata --chain-id <id> --data <0x…> [--to <0x…>]   # labeled legs; --to verifies the target
ch decode tx      --chain-id <id> --data <0x…>                 # a SIGNED raw tx: signer, target, legs. Run this before you broadcast.
ch decode order   --chain-id <id> --data '{…}'                 # LOP order: traits, orderHash, JIT and auction labels
ch decode event   --chain-id <id> --data '{…one log…}'
ch decode receipt --chain-id <id> --data '{…}'
```

`ch` reconstructs from the bytes. It never trusts a parse you hand it. A leg at the wrong contract
is `TARGET MISMATCH — do not sign`. Every configured generation's Cork adapter is a right contract:
a bundle for a `phoenix/v0.3-rc.1` pool runs at that generation's adapter, decodes as trusted, and its legs
carry `generation: "phoenix/v0.3-rc.1"`. Legs at the primary's adapter carry no label.

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

The venue-relay command. It sends caller-signed payloads or RFQ writes authorized with an API key.
Without `--account` it never signs; the optional CLI-only `--account` flow signs an RFQ write after
human confirmation and a terminal password prompt. Local wallet/auth management also writes files.

```sh
ch submit lop-order      --chain-id <id> --client-request-id <id> --action '{…}'   # rest a signed order; the payload is finalize-maker-order's submitInput
ch submit rollover-order --chain-id <id> --client-request-id <id> --action '{…}'
ch submit rfq-open       --chain-id <id> --client-request-id <id> --action '{…}'   # open a request-for-quote (buyer)
ch submit rfq-answer     --chain-id <id> --client-request-id <id> --action '{…}'   # answer one (underwriter); revisions replace
ch submit rfq-counter    --chain-id <id> --client-request-id <id> --action '{…}'   # counter-bid (requester)
```

Every RFQ write is proven (venue RFQ v2). Run the same request through `ch prepare order rfq-write`
with the same client request id, sign `data.typedData` with the address it names, and pass the
signature as `"auth": {"method": "signature", "signature": "0x…"}`. The tool rebuilds the body and
checks the signer before it relays. With a partner API key, pass `"auth": {"method": "apiKey"}`
instead: the key is never part of the input (see "RFQ API keys" below). `rfq-open` needs `kind`:
`new_position` or `rollover`. A quoted `new_position` answer carries each option's signed order:
`answer-rfq` builds both, and the answer goes before the order rests on the book.

To sign and submit an RFQ write in one command, add `--account <keystore>` (see below):

```sh
ch submit rfq-open --json '{…without auth…}' --account alice   # prepares, shows what it signs, asks yes/no, then the password
```

### RFQ API keys

`ch` finds a key the way the AWS CLI finds credentials. The first hit wins:

1. The `CORK_RFQ_API_KEY` environment variable.
2. The profile's `credential_process`: a command that prints `{"Version": 1, "RfqApiKey": "…"}`.
3. The key stored in the profile for the venue host you are writing to.

The first two apply to whatever venue is configured. A stored key belongs to one venue host, so a
staging key is never sent to production.

```sh
printf %s "$KEY" | ch auth set-key --venue https://breaking.cork.tech   # or run it bare for a hidden prompt
ch auth set-key --profile desk                                           # a second profile, production venue
ch auth list                                                             # profiles, hosts, keys masked to …last4
ch auth status --venue https://breaking.cork.tech                        # which source serves, never the key
ch auth remove --venue https://breaking.cork.tech
ch submit rfq-open --profile desk --action '{…, "auth": {"method": "apiKey"}}'
```

The file is `~/.config/cork-helper-cli/credentials` (override `CORK_CREDENTIALS_FILE`). `ch`
writes it with mode 600 and refuses to read it when other users can:

```ini
[default]
rfq_api_key.breaking.cork.tech = <staging key>

[desk]
credential_process = op read "op://Cork/rfq api key/credential" --format json
rfq_api_key.api-phoenix.cork.tech = <production key>
```

The profile is `--profile`, else `CORK_PROFILE`, else `default`. `ch` never takes a key on the
command line, never prints one, and the HTTP MCP endpoint never uses one: a shared server's key
is its operator's, not its callers'.

### Sign with a keystore — `ch wallet`, `ch sign`

The MCP server never signs. The CLI can, for a person at a terminal. Keys live encrypted in
`~/.config/cork-helper-cli/keystores/` (the standard v3 keystore format; `CORK_KEYSTORE_DIR` moves
it). No other tool's keystore folder is read.

```sh
ch wallet new alice                          # new key; you type a password twice
ch wallet import alice                       # existing key, typed at a hidden prompt
printf %s "$KEY" | ch wallet import alice --from-stdin
ch wallet list                               # names and addresses, no password needed
ch prepare order rfq-write … --json | ch sign --account alice
ch sign tx.json --account alice              # a COMPLETE transaction: nonce, gas and fees filled in
```

Before every signature `ch` shows what will be signed and asks yes or no. Only then does it ask for
the password. The password is read from the terminal only, never from an environment variable, a
file or a pipe, so a script or an agent cannot sign for you. `ch` never broadcasts: check a signed
transaction with `ch decode tx` and send it through your own RPC.

A venue listing carries one premium field, `premiumAnnualized`, a fraction string: `"0.041"` is
4.1%. `ch` recomputes every commitment before relay and refuses a payload whose signature does
not recover to its maker.

### RFQ mode and failure contract

`rfq-open` requires **one to three unique modes**, chosen from `liquidity_only`,
`liquidity_impairment`, and `fixed_rate`. The input schema enforces the list length
(`minItems: 1`, `maxItems: 3`); domain preflight enforces uniqueness. A request naming
`fixed_rate` also needs an inline template with a positive decimal uint256
`oracle_params.rate_override` (absolute scale: 1e18 = 1.0).

For otherwise valid inputs, the JSON-mode contract is:

| Case | Rejection/result layer | Exit | stdout | stderr |
|---|---|---|---|---|
| Four or more modes, including an overlength list with repeats | Local input schema, before domain preflight or relay | `2` | Empty | JSON error with `error.code: "invalid_input"` |
| Duplicate modes within the one-to-three length bound | Local domain/preflight, before relay | `3` | JSON result: `state: "unavailable"`, warning code `invalid_order_terms` | Empty |
| `rfq-open` succeeds with `recipe_generation_notice` or `cover_mode_mismatch` | Relay with warnings | `0` | JSON result: `state: "ok"`, RFQ data and warnings | Empty |

The domain-refusal row assumes authorization resolves and the other required fields are valid. With `auth.method: "apiKey"` but no available key, credential resolution instead returns `api_key_missing` (exit 3) before domain preflight. Neither path relays a venue write.

Local rejection is not a venue response: do not expect `venue_rejected` for either invalid
mode-list case. `venue_rejected` reports a venue refusal of a relayed request, not these local
checks. Scripts must handle exit `2` and stderr as well as exit `3` result envelopes.
Without JSON mode, the same exits and channels apply, rendered as human-readable text.

`recipe_generation_notice` identifies the generation selected by an inline recipe rather
than assuming it is the primary generation. `cover_mode_mismatch` identifies disagreement
between requested modes and the cover supplied by the template recipe; modes do not change
the recipe or onchain cover. These codes currently accompany `rfq-open` results, not
order-preparation artifacts. Warnings can also accompany successful unsigned preparations;
neither an `ok` state nor a warning is proof of settlement safety or permission to ignore
the mismatch. Use `state`, exit code, and warning details together.

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
ch version [--json]                      # version, commit, repository, embedded HyperSync binding
ch mcp                                   # MCP server on stdio: claude mcp add cork-defi -- ch mcp
ch mcp --http [--port 8080] [--host 0.0.0.0] [--trust-forwarded-for]   # Streamable HTTP: /mcp, /healthz, /readyz, /docs/<topic>
ch self-update [--tag <vX.Y.Z>] [--dry-run] [--allow-downgrade]         # verifies provenance before it swaps the binary
```

Set `CORK_MCP_TOKEN` for bearer auth on the HTTP server. Pass `--trust-forwarded-for` only behind
an ingress you control; without it every caller behind a proxy shares one client slot.
`ENVIO_HYPERSYNC_TOKEN` enables `--mode full-decentralized` over the HyperSync archive.
`CORK_CONFIG_FILE` points at a local `config.json` that overrides `cork-defaults.v2.json`: a whole
deployment set per key, the primary, or an `only` list of the sets you want to see. `ch query
protocol-config` shows both layers under `data.config`, and every result an override actually shaped
warns `config_override_active`. `CORK_CONFIG_NO_OVERRIDE=1` turns the layer off. A released build
fetches `cork-defaults.v2.json` from its line's config branch (`config/0.7` for this candidate),
so a redeployed address reaches you within an hour without an upgrade.

The build's repository identity also selects its release/update channel; it is shown by
`ch version --json`. A private build uses only that repository, never the public channel.
Set `CORK_GITHUB_TOKEN` explicitly to an authorized, read-only GitHub credential for private
repository contents, releases/assets and attestation reads. It is a process environment value,
not a CLI argument or URL parameter; do not paste it into logs, configuration files or notes.
The RFQ API key is unrelated and cannot authorize GitHub downloads. GitHub credentials are sent
only to the authorized API origin, never to a redirected asset host.

Private self-update requires the GitHub CLI (`gh`) and successful artifact-attestation
verification against the build's repository, release workflow, tag and commit. Release
checksums remain available for manual comparison, but private self-update never substitutes
them for provenance verification. A dry run reports the selected tag, asset and installation path; it does
not download, attest or replace the binary.
Repository-specific caches keep private and public release/config results separate.

Accepted synonyms, and the pre-rename names that answer with their new name, are listed in the
README's synonym table.

## 12. Migrate from 0.6 to 0.7

This candidate breaks covered RFQ input contracts, so it starts the 0.7 minor line below 1.0.
Do not upgrade an unattended RFQ writer without updating its payloads and error handling.
The production API serves both versions, but this CLI, MCP server and SDK RFQ tooling use
**only /rfqs/v2**. There is no v1 shim and a v2 query does not expose v1-opened RFQs. Keep an
appropriate v1 client for existing v1 negotiations, or open a new v2 request with a fresh id;
do not silently reinterpret a prior request as v2. Existing onchain orders and generation
addresses are not migrated or retired by this release.

| 0.6 input or flow | 0.7 replacement |
|---|---|
| RFQ v1 read/write | RFQ v2 with `schema_version: "2"` in the venue body |
| `rfq-open` without kind | Explicit `kind: "new_position"` or `"rollover"` |
| Free `signature` on an RFQ submit | `auth: { method: "signature", signature }` |
| Unsigned RFQ write | Prepare `rfq-write`, sign its exact typed data, submit the same request/id; an authorized API key is optional |
| Quote option without its order | Include the underwriter's exact signed order per quoted new-position option |
| Rest order before quoting it | Sign order → finalize → prepare/sign RFQ write → submit answer → submit listing with quoteRef |

The RFQ write signature binds the entire canonical answer body, operation, target and chain.
An order signature alone does not authorize an answer's quotation terms. A signature-authorized
quoted answer needs **both** its full-answer signature and each order's signature. API-key
mode authorizes the venue write; this tool still checks quoted order signatures before relay.
Sign the body returned by `rfq-write`, not a separately assembled body. Reuse the same
`clientRequestId` for a retry of the same intent; a changed body needs a fresh id.

A rollover RFQ uses `source { poolId, shares }` and `premiumToken`, not new-position
modes/packageIds/notionalAssets. Options name an existing destination pool or a just-in-time
market; prices are raw premium-token units per 1e18 destination shares. `rollover-intent`
accepts `quoteRef` and checks the quoted terms; a reserved rollover fill may additionally
need the exclusive filler's signature, distinct from the RFQ write authorization.

API keys are **optional**, never provisioned by installing or releasing this CLI. Use
`ch auth set-key` with a hidden prompt or pipe, never argv. Stored keys are host-bound;
environment/process keys apply to the configured venue. HTTP MCP refuses the operator's
stored/API keys. A human may instead use `ch wallet` and `ch sign --account <name>`;
passwords come only from a terminal. CLI signing never broadcasts and MCP never signs.
A prepare transaction missing nonce/gas/fees is not a complete transaction to sign.

Handle both JSON channels: invalid input exits 2 with empty stdout and an error on stderr;
a domain refusal exits 3 with an unavailable result on stdout. In particular, four or more
new-position modes are invalid input, while duplicate modes within the size limit are a
domain refusal. Successful results may carry warnings and still exit 0; read the envelope
state and warning evidence before proceeding. See the failure table above.

This is preparation, not evidence of removal-notice compliance or human compatibility
approval. Those decisions, independent review of the signing exposure, and private-release
platform/signing prerequisites must be recorded before an actual cut. Publishing a release
does not deploy the hosted MCP service.


### Reference: terminology

| Term | Meaning |
|---|---|
| RPC (remote procedure call) | The chain endpoint used for reads and broadcasting. |
| JSON (JavaScript Object Notation) | The machine-readable input/output format. |
| LOP (Limit Order Protocol) | The 1inch order execution protocol. |
| NAV (net asset value) | A vault/share valuation source. |
| RFQ (request for quote) | The venue negotiation record. |
| SDK (software development kit) | The typed library packages. |
| JIT (just in time) | A market created during execution. |
| AWS (Amazon Web Services) | The credential-resolution model used as a reference. |
| HTTP (Hypertext Transfer Protocol) | The network MCP transport and venue protocol. |
| ISO (International Organization for Standardization), UTC (Coordinated Universal Time) | The ISO-8601 timestamp standard and explicit UTC timezone. |
| RATE (rate), MIN (minimum), TARGET (target contract) | Literal constant/error-word fragments, not additional APIs. |
| FILE (file), DIR (directory), CONFIG (configuration), TOKEN (token), NO (disable), ENVIO (Envio prefix), GITHUB (GitHub prefix) | Literal environment-variable name fragments; use the complete names shown above. |
