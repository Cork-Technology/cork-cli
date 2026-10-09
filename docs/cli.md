# `ch` — CLI reference

`ch` is the Cork command line. It has one command per tool, one subcommand per action and one flag
per field. Tool commands read state, build **unsigned** artifacts, or relay venue payloads that the
caller authorized. The optional CLI keystore commands can sign, after a person confirms and types
the password at a terminal prompt. MCP never holds keys or signs. Broadcast onchain transactions
through your own RPC.

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
- **Amounts** are in base units of the token. Flags accept exact sugar: `1000e18`, `95e16`,
  `1_000000`. The command refuses a fractional remainder. Inside a `--json` object, amounts are
  plain digit strings.
- **Idempotency.** Every prepare and submit takes `--client-request-id`. Reuse the id when you retry
  the same request. Use a new id for a new intent.
- **RPC.** Chain-backed commands pick a public endpoint themselves. `--rpc-url` overrides it. An
  explicit endpoint must answer for the requested chain, or the command refuses.
- **Output.** Prose by default. `--json` (bare) or `CORK_JSON=1` prints the result envelope.

Every result is one envelope: `{ state, data, warnings[], provenance }`. Read `state` first. `ok`
means: use `data`. `unavailable` means the tool could not serve the call, and `warnings[0].code`
says why. `conflict` means the tool ran and found a mismatch. Do not paper over it. The exit code
mirrors the state: `0` ok, `2` invalid input, `3` unavailable, `4` conflict, `1` unexpected. A
schema or CLI rejection writes an error to **stderr**, not a result envelope to stdout. A domain or
preflight rejection can instead return an `unavailable` result on **stdout** (exit `3`). With
`--json`, check both the exit code and the matching JSON channel. A nonempty `warnings` array alone
does not mean failure: an `ok` preparation still exits `0` and returns its unsigned artifact. Read
each warning before you decide to sign or continue.

## 2. Generations

A chain hosts a set of contract generations. One is primary. On Arbitrum One and Base the primary is
`phoenix/v0.5` and the previous set is `phoenix/v0.3-rc.1`. `phoenix/v0.4-rc.1` stays active. It
shares every contract with `phoenix/v0.5` except the JIT adapter, so `previous` skips it. To target
it, name it. A set records the Distribution its contracts were cut in. Each result also carries that
record name in `generation.distribution`.

Three rules cover every command:

1. **A pool decides its own generation.** A command that names `--pool-id` finds the pool on the
   chain and uses that pool's contracts. You pass no switch.
2. **A new thing goes to the primary.** A registry read, a derivation or a new market targets the
   primary unless you pass `--generation`. The flag takes a label (`phoenix/v0.3-rc.1`), `previous`
   (the newest active non-primary set that has the contracts the command needs) or `primary`.
3. **Every result names its generation.** Read `data.generation` and `provenance.generation`.
   Results carry the label, never the alias. A pool-scoped result also lists any other set that
   shares the pool's manager, in `data.generation.alsoIn`.

`ch query protocol-config` lists a chain's generations with every address and wire.
`ch capabilities --topic generations` explains the model. A pool that no generation knows is
`pool_not_found`. A label that the chain does not configure is `generation_unknown`.

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

The **fill sender** is the address that calls the protocol. If your wallet fills through a ForSelf
adapter, pass the adapter as `--account`. The ranked book classifies every row against the fill
sender. It collapses one-cancels-the-other rungs to their best rung. It sets aside the rows that the
maker cannot deliver, and gives the reason.

**Lists page.** Venue lists take `--page-size` and `--max-pages`. A partial walk returns `ok` with
`pagination_incomplete` and a `--cursor` to resume. `--mode` names who the call may contact:
`hybrid` (the venue plus your RPC, the default for lists), `lite-decentralized` (your RPC only),
`full-decentralized` (your RPC plus HyperSync, never the venue). The tool never substitutes a mode
for you.

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
  --collateral-asset <0x…> --reference-asset <0x…> --expiry <unix> --recipe <0x…> [--args <0x…>] \
  [--swap-fee-percentage <1e18=1%>] [--unwind-swap-fee-percentage <…>] [--oracle-salt <bytes32>]
  # derive one pool BEFORE it exists: pool id, cST and cPT addresses, constraint, existence.
  # --args is abi.encode(anchorRate): a liquidity recipe needs it while the pair has no oracle.
```

What the registry assumes, and what `ch` therefore does:

- **Modes compose differently.** `price` needs a price source on every leg. `nav` needs at least one
  NAV source and lets a leg fall back to price. A pair that cannot compose reports
  `deployable: false` with the registry's own error. The fix is registration, not a retry.
- **Pair order and mode both matter.** `(ca, ref)` and `(ref, ca)` are different pairs. One pair can
  hold a `price` wrapper and a `nav` wrapper at different addresses.
- **Feeds are directed.** base→quote is not quote→base. Each feed carries `live.decimals`.
- **Denominations follow the wire.** The 0.5.0 registry (the primary) lists address units and takes
  `--address`. The 0.3.3 registry (`--generation phoenix/v0.3-rc.1`) keys them by exact-bytes
  `--label`.
- **Recipe constants mix two scales by name.** A constant whose name ends in `_PERCENTAGE` uses the
  1e18 = 1% scale. A `RATE_MIN`-style constant is an absolute rate, 1e18 = 1.0.
  `ch capabilities --topic units` is the full table.
- **On the primary the two fees are part of the pool id.** Pass the fees you will create the pool
  with. Other fees give a different pool id. The salt matters only for a pair's first oracle.
- **A pair whose oracle is not deployed yet needs an anchor rate.** The liquidity recipe reads the
  live oracle when one exists, and refuses otherwise (`recipe_refused`, `MalformedExtraData`).
  `ch query registry-oracle` shows this case as `deployed: false, deployable: true`. Pass the anchor
  as `abi.encode(uint256 anchorRate)`, 1e18 = 1.0. The fill then deploys the oracle in the same
  transaction:

  ```sh
  ch compute recipe-rate-constraint … --recipe <nav-recipe> --args-uints '["1090410000000000000"]'
  ch query derive-cork-pool         … --recipe <nav-recipe> --args 0x<anchor as 32 bytes>
  ch prepare market create-pool     … --recipe <nav-recipe> --extra-data 0x<anchor as 32 bytes>
  ```

  A useful anchor is the pair's live rate on the previous registry (`--generation previous` on
  `registry-oracle`). After the oracle is deployed, the recipe ignores the anchor and reads the
  chain.
- **`derive-cork-pool` simulates the registry's own deploy.** The prediction is an `eth_call` of the
  real deployment, so it cannot drift from what a fill does. The RPC must honor state overrides. If
  it does not, `ch` returns the derivation without share addresses and says so.
- **Never infer the chain from an address.** The stack deploys at identical addresses on both
  chains. Only `--chain-id` selects the deployment.

## 4. Migrate between generations

To move funds from a pool on the previous set to a pool on the current set, you use ordinary
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

# 3. Enter on the primary. Create the pool first if it does not exist yet. A liquidity recipe on a
#    pair whose oracle is not deployed needs the anchor rate: --extra-data is abi.encode(anchorRate).
ch prepare market create-pool --chain-id 8453 --client-request-id mig-create-0001 \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry-timestamp <unix> --recipe <0x…> [--extra-data <0x…>]
ch deposit --chain-id 8453 --pool-id <new> --collateral-assets-in 1000e6 --min-cpt-and-cst-shares-out 1 --receiver <0x…> …

# 4. Verify.
ch track reconcile --chain-id 8453 --subject '{"kind":"txHash","txHash":"0x…"}'
```

The positions read scans the chain over your RPC and finds every pool in one request. Each row
carries the expiry as ISO-8601 UTC and as unix seconds. `--mode hybrid` takes the venue's pool list
instead. `ch capabilities --topic migration` is the full recipe.

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

Every prepare returns bytes or typed data, plus `data.execution`: the ordered steps that finish the
job. The steps are: simulate, sign, decode the signed transaction, send through your RPC, track.
`ch prepare` signs nothing and sends nothing.

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
pool burns with the adapter as caller. So first approve the cST and cPT to the **cork adapter** of
the pool's generation. The result says so under `owner_managed_funding` and names the adapter.
Nothing spends an allowance to the pool manager. Without the allowance the bundle reverts
`ERC20InsufficientAllowance`. `ch track simulate` shows this before you sign. We verified this on a
Base fork on 2026-09-25.

`--account` is the address that funds the bundle. It also receives the sweep-back of any unspent
cap, so set it to the real payer. A bundle pulls, acts and sweeps in one transaction. The tool
refuses a plan that cannot be atomic. For a session-key wallet, `--for-self '{"adapter":"0x…"}'`
emits a direct call to your ForSelf adapter instead of a bundle.

### Orders

```sh
ch prepare order maker-order --chain-id <id> --account <0x…> --client-request-id <id> --pool-id <0x…> \
  --side SELL --maker-asset <0x…> --taker-asset <0x…> --making-amount <amt> --taking-amount <amt> \
  [--expiry-seconds <n>] [--allowed-sender <0x…>] [--oco-group <key>] [--jit-market '{…}'] [--auction '{…}']
ch prepare order maker-ladder … --rungs '[{"takingAmount":"…"},{"takingAmount":"…","allowedSender":"0x…"}]'   # 2 to 32 rungs in one call
ch prepare order answer-rfq --chain-id <id> --account <0x…> --client-request-id <id> --rfq-id <rfq_…> \
  --premium-annualized "0.041" --expiry-timestamp <unix> [--fill-sender <0x…>]                      # a new answer: the order AND the option that carries it
ch prepare order answer-rfq … --rfq-id <rfq_…> --answer-id <…> --option-id <…>                       # re-quote your own option at its premium and expiry
ch prepare order rfq-write --chain-id <id> --account <0x…> --client-request-id <id> --request '{"type":"rfq-open",…}'
                                                                                                     # the CorkRfqWrite typed data every RFQ write is signed with
ch prepare order finalize-maker-order --chain-id <id> --account <0x…> --client-request-id <id> \
  --prepared '{…}' --signature <0x…> --listing '{…}'                                                   # verify your signature, get the submit payload
ch fill --chain-id <id> --account <0x…> --client-request-id <id> --order-hash <0x…> \
  [--fill-making-amount <amt>] [--for-self '{"adapter":"0x…","poolId":"0x…"}']                        # unsigned fill calldata
ch prepare order refresh-order --chain-id <id> --account <0x…> --client-request-id <id> --order-hash <0x…>   # re-rest on the same nonce
ch prepare order cancel --chain-id <id> --account <0x…> --client-request-id <id> --order-hash <0x…> --maker-traits <n> [--scope order|slot] [--max-pages <n>]
ch prepare order rollover-intent --chain-id <id> --account <0x…> --client-request-id <id> --settler <0x…> …   # cPT holder: signable ERC-7683 order
ch prepare order deploy-rollover-contract --chain-id <id> --account <0x…> --client-request-id <id>           # cPT holder: the clone the order names, once per factory
ch prepare order rollover-fill --chain-id <id> --account <0x…> --client-request-id <id> --order-digest <0x…> # cST holder: unsigned BaseFiller.execute calldata
```

Three facts about orders. First, a Cork-built order fills once: the first fill of any size spends
it. To serve several takers, post several smaller orders. Second, `--oco-group` ties orders to one
nonce, so the first fill retires the rest. Third, `--allowed-sender` reserves the fill for the
address that calls the protocol. For a ForSelf wallet that address is the adapter, not the Safe.
`ch capabilities --topic orders` gives one term per concept.

### Markets

```sh
ch prepare market deploy-oracle --chain-id <id> --client-request-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> [--mode price|nav] [--oracle-salt <bytes32>]
ch prepare market deploy-fixed-oracle --chain-id <id> --client-request-id <id> --rate <1e18=1.0>
ch prepare market create-pool --chain-id <id> --client-request-id <id> \
  --collateral-asset <0x…> --reference-asset <0x…> --expiry-timestamp <unix> --recipe <0x…> \
  [--extra-data <0x…>] [--swap-fee-percentage <1e18=1%>] [--unwind-swap-fee-percentage <…>] [--oracle-salt <bytes32>]
```

All three are permissionless and safe to repeat. `create-pool` builds the pool that a just-in-time
order would create, before the fill. Use it from a Safe or any contract account on
`phoenix/v0.4-rc.1` or the flat wire: there the mid-fill mint needs a permit that only a plain
wallet can sign. The registry allows an expiry at most 30 days out. `ch` warns before the
transaction can revert.

The JIT block (`--jit-market` on orders, the flags above on `create-pool`) names the recipe bytes
`extraData`. The old name `additionalData` still works, with a deprecation notice. The bytes follow
the wire of the selected generation: nested on `phoenix/v0.5` and `phoenix/v0.4-rc.1`, flat on
`phoenix/v0.3-rc.1`. The JIT permit row also follows the set. `phoenix/v0.5` carries
`permits[].signature` as bytes (ERC-1271 works). `phoenix/v0.4-rc.1` and the flat wire take 65-byte
ECDSA only.

## 7. Inspect bytes — `ch decode`

```sh
ch decode calldata --chain-id <id> --data <0x…> [--to <0x…>]   # labeled legs; --to verifies the target
ch decode tx      --chain-id <id> --data <0x…>                 # a SIGNED raw tx: signer, target, legs. Run this before you broadcast.
ch decode order   --chain-id <id> --data '{…}'                 # LOP order: traits, orderHash, JIT and auction labels
ch decode event   --chain-id <id> --data '{…one log…}'
ch decode receipt --chain-id <id> --data '{…}'
```

`ch` reconstructs from the bytes. It never trusts a parse you hand it. A leg at the wrong contract
is `TARGET MISMATCH — do not sign`. The Cork adapter of every configured generation is a right
contract. A bundle for a `phoenix/v0.3-rc.1` pool runs at that generation's adapter and decodes as
trusted. Its legs carry `generation: "phoenix/v0.3-rc.1"`. Legs at the primary's adapter carry no
label.

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

`ch submit` relays payloads to the venue. It sends payloads that the caller signed, or RFQ writes
that an API key authorizes. Without `--account` it never signs. The optional CLI-only `--account`
flow signs an RFQ write after a person confirms and types the password at a terminal prompt. Local
wallet and auth management also writes files.

```sh
ch submit lop-order      --chain-id <id> --client-request-id <id> --action '{…}'   # rest a signed order; the payload is finalize-maker-order's submitInput
ch submit rollover-order --chain-id <id> --client-request-id <id> --action '{…}'
ch submit rfq-open       --chain-id <id> --client-request-id <id> --action '{…}'   # open a request-for-quote (buyer)
ch submit rfq-answer     --chain-id <id> --client-request-id <id> --action '{…}'   # answer one (underwriter); revisions replace
ch submit rfq-counter    --chain-id <id> --client-request-id <id> --action '{…}'   # counter-bid (requester)
```

Every RFQ write is proven (venue RFQ v2). Run the same request through `ch prepare order rfq-write`
with the same client request id. Sign `data.typedData` with the address it names. Pass the signature
as `"auth": {"method": "signature", "signature": "0x…"}`. The tool rebuilds the body and checks the
signer before it relays. With a partner API key, pass `"auth": {"method": "apiKey"}` instead. The
key is never part of the input (see "RFQ API keys" below). `rfq-open` needs `kind`: `new_position`
or `rollover`. A quoted `new_position` answer carries the signed order of each option. `answer-rfq`
builds both. Submit the answer before the order rests on the book.

To sign and submit an RFQ write in one command, add `--account <keystore>` (see below):

```sh
ch submit rfq-open --json '{…without auth…}' --account alice   # prepares, shows what it signs, asks yes/no, then the password
```

### RFQ API keys

`ch` finds a key the way the AWS CLI finds credentials. The first hit wins:

1. The `CORK_RFQ_API_KEY` environment variable.
2. The profile's `credential_process`: a command that prints `{"Version": 1, "RfqApiKey": "…"}`.
3. The key stored in the profile for the venue host you are writing to.

The first two sources apply to whatever venue you configure. A stored key belongs to one venue host,
so `ch` never sends a staging key to production.

```sh
printf %s "$KEY" | ch auth set-key --venue https://breaking.cork.tech   # or run it bare for a hidden prompt
ch auth set-key --profile desk                                           # a second profile, production venue
ch auth list                                                             # profiles, hosts, keys masked to …last4
ch auth status --venue https://breaking.cork.tech                        # which source serves, never the key
ch auth remove --venue https://breaking.cork.tech
ch submit rfq-open --profile desk --action '{…, "auth": {"method": "apiKey"}}'
```

The file is `~/.config/cork-helper-cli/credentials` (override `CORK_CREDENTIALS_FILE`). `ch` writes
it with mode 600. It refuses to read the file when other users can read it:

```ini
[default]
rfq_api_key.breaking.cork.tech = <staging key>

[desk]
credential_process = op read "op://Cork/rfq api key/credential" --format json
rfq_api_key.api-phoenix.cork.tech = <production key>
```

The profile is `--profile`, else `CORK_PROFILE`, else `default`. `ch` never takes a key on the
command line and never prints one. The HTTP MCP endpoint never uses a key: a shared server's key
belongs to its operator, not to its callers.

### Sign with a keystore — `ch wallet`, `ch sign`

The MCP server never signs. The CLI can sign, for a person at a terminal. Keys live encrypted in
`~/.config/cork-helper-cli/keystores/` (the standard v3 keystore format; `CORK_KEYSTORE_DIR` moves
it). `ch` reads no other tool's keystore folder.

```sh
ch wallet new alice                          # new key; you type a password twice
ch wallet import bob                         # existing key, typed at a hidden prompt
printf %s "$KEY" | ch wallet import carol --from-stdin
ch wallet list                               # names and addresses, no password needed
ch prepare order rfq-write … --json | ch sign --account alice
ch sign tx.json --account alice              # a COMPLETE transaction: nonce, gas and fees filled in
```

Before every signature, `ch` shows what it will sign and asks yes or no. Only then does it ask for
the password. `ch` reads the password from the terminal only, never from an environment variable, a
file or a pipe. So a script or an agent cannot sign for you. `ch` never broadcasts. Check a signed
transaction with `ch decode tx` and send it through your own RPC.

A venue listing carries one premium field, `premiumAnnualized`, as a fraction string: `"0.041"` is
4.1%. `ch` recomputes every commitment before relay. It refuses a payload whose signature does not
recover to its maker.

### RFQ mode and failure contract

`rfq-open` requires **one to three unique modes**, chosen from `liquidity_only`,
`liquidity_impairment` and `fixed_rate`. The input schema enforces the list length (`minItems: 1`,
`maxItems: 3`). Domain preflight enforces uniqueness. A request that names `fixed_rate` also needs
an inline template with a positive decimal uint256 `oracle_params.rate_override` (absolute scale:
1e18 = 1.0).

For otherwise valid inputs, the JSON-mode contract is:

| Case | Rejection/result layer | Exit | stdout | stderr |
|---|---|---|---|---|
| Four or more modes, including an overlength list with repeats | Local input schema, before domain preflight or relay | `2` | Empty | JSON error with `error.code: "invalid_input"` |
| Duplicate modes within the one-to-three length bound | Local domain/preflight, before relay | `3` | JSON result: `state: "unavailable"`, warning code `invalid_order_terms` | Empty |
| `rfq-open` succeeds with `recipe_generation_notice` or `cover_mode_mismatch` | Relay with warnings | `0` | JSON result: `state: "ok"`, RFQ data and warnings | Empty |

The domain-refusal row assumes that authorization resolves and that the other required fields are
valid. With `auth.method: "apiKey"` but no available key, credential resolution instead returns
`api_key_missing` (exit 3) before domain preflight. Neither path relays a venue write.

Local rejection is not a venue response. Do not expect `venue_rejected` for either invalid mode-list
case: `venue_rejected` reports a venue refusal of a relayed request, not these local checks. Scripts
must handle exit `2` and stderr, as well as exit `3` result envelopes. Without JSON mode the same
exits and channels apply, rendered as human-readable text.

`recipe_generation_notice` names the generation that an inline recipe selects. It does not assume
the primary generation. `cover_mode_mismatch` names a disagreement between the requested modes and
the cover that the template recipe supplies. Modes do not change the recipe or the onchain cover. At
present these codes come with `rfq-open` results, not with order-preparation artifacts. Warnings can
also come with successful unsigned preparations. Neither an `ok` state nor a warning proves
settlement safety or gives permission to ignore the mismatch. Use `state`, the exit code and the
warning details together.

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

Set `CORK_MCP_TOKEN` for bearer auth on the HTTP server. Pass `--trust-forwarded-for` only behind an
ingress you control. Without it, every caller behind a proxy shares one client slot. `/readyz`
answers a bare request with a summary: one `degraded` flag per subsystem. A request that presents
the MCP bearer or `CORK_MCP_DIAGNOSTICS_TOKEN` as a bearer gets the full snapshot: RPC hosts,
breakers, venue outcome, in-flight counts, bounds and trust posture. The second token unlocks that
view but does not gate `/mcp`. Every response carries `X-Content-Type-Options: nosniff`,
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a deny-all `Content-Security-Policy`,
`X-Frame-Options: DENY` and `Cross-Origin-Resource-Policy: same-origin`. HSTS belongs to your TLS
terminator. `ENVIO_HYPERSYNC_TOKEN` enables `--mode full-decentralized` over the HyperSync archive.

`CORK_CONFIG_FILE` points at a local `config.json` that overrides `cork-defaults.v2.json`. It can
set a whole deployment set per key, the primary, or an `only` list of the sets you want to see.
`ch query protocol-config` shows both layers under `data.config`. Every result that an override
actually shaped warns `config_override_active`. `CORK_CONFIG_NO_OVERRIDE=1` turns the layer off. A
released build fetches `cork-defaults.v2.json` from its line's config branch (`config/0.7` for the
0.7 line). So a redeployed address reaches you within an hour, without an upgrade.

### Point one install at staging

Staging and production share chain ids, so the switch is two settings, not a flag: the venue URL and
the contract set. Both come from the environment, so one shell profile per environment is the whole
mechanism. The default is production.

```sh
# production: nothing to set.

# staging: the staging venue plus a config.json that names the staging deployment.
export CORK_VENUE_URL=https://breaking.cork.tech
export CORK_CONFIG_FILE=~/.config/cork-helper-cli/staging.json
```

`staging.json` adds the staging deployment as a whole set and makes it the primary for that chain.
Every other set stays readable. Fill the addresses from the staging Distribution record. The file
must carry `schemaVersion: 2` and complete sets. The tool refuses a whole set when a required field
is missing, and drops an unknown field name silently. So copy the field names exactly (a test parses
this very block through the override schema):

```json
{
  "schemaVersion": 2,
  "generations": {
    "8453": {
      "primary": "phoenix/staging",
      "sets": {
        "phoenix/staging": {
          "status": "active",
          "phoenix": { "wire": "10-field", "poolManager": "0x…", "constraintAdapter": "0x…", "corkAdapter": "0x…", "whitelistManager": "0x…", "controller": "0x…" },
          "marketRegistry": { "wire": "nested", "registry": "0x…", "adapter": "0x…", "marketCreator": "0x…", "recipes": { "liquidity": "0x…", "nav": "0x…", "fixed": "0x…", "impairment": "0x…" } }
        }
      }
    }
  }
}
```

`ch query protocol-config --chain-id base` shows which layer is live under `data.config`. Every
result that the override shaped warns `config_override_active`, so you can never mistake a staging
answer for a production one. Add `"only": ["phoenix/staging"]` to hide the production sets from that
install. `CORK_CONFIG_NO_OVERRIDE=1` returns to production without an edit. The code-hash allowlist
(`approvedImplementations`) is never overridable. For a staging adapter whose code is not in the
build's allowlist, the tool warns `implementation_not_approved` on ABI-typed prepares. It also
refuses the JIT hook paths unless `CORK_ALLOW_UNAPPROVED_CODE=1` is set. Expect this for a staging
deployment that comes before the release that ships its hash.

The build's repository identity also selects its release and update channel. `ch version --json`
shows it. A private build uses only that repository, never the public channel. Set
`CORK_GITHUB_TOKEN` explicitly to an authorized, read-only GitHub credential for private repository
contents, releases, assets and attestation reads. It is a process environment value, not a CLI
argument or URL parameter. Do not paste it into logs, configuration files or notes. The RFQ API key
is unrelated and cannot authorize GitHub downloads. `ch` sends GitHub credentials only to the
authorized API origin, never to a redirected asset host.

Private self-update requires the GitHub CLI (`gh`). It also requires a successful
artifact-attestation check against the build's repository, release workflow, tag and commit. Release
checksums stay available for manual comparison. Private self-update never uses them in place of
provenance verification. A dry run reports the selected tag, asset and installation path. It does
not download, attest or replace the binary. Separate caches per repository keep private and public
release and config results apart.

The README's synonym table lists the accepted synonyms, and the pre-rename names that answer with
their new name.

## 12. Migrate from 0.6 to 0.7

The 0.7 line breaks covered RFQ input contracts, so it starts a new minor line below 1.0. Do not
upgrade an unattended RFQ writer until you update its payloads and error handling. The production
API serves both versions, but this CLI, the MCP server and the SDK RFQ tooling use **only
/rfqs/v2**. There is no v1 shim, and a v2 query does not show RFQs opened on v1. For an existing v1
negotiation, keep a suitable v1 client, or open a new v2 request with a fresh id. Do not silently
reinterpret an earlier request as v2. This release does not migrate or retire existing onchain
orders or generation addresses.

| 0.6 input or flow | 0.7 replacement |
|---|---|
| RFQ v1 read/write | RFQ v2 with `schema_version: "2"` in the venue body |
| `rfq-open` without kind | Explicit `kind: "new_position"` or `"rollover"` |
| Free `signature` on an RFQ submit | `auth: { method: "signature", signature }` |
| Unsigned RFQ write | Prepare `rfq-write`, sign its exact typed data, submit the same request/id; an authorized API key is optional |
| Quote option without its order | Include the underwriter's exact signed order per quoted new-position option |
| Rest order before quoting it | Sign order → finalize → prepare/sign RFQ write → submit answer → submit listing with quoteRef |

The RFQ write signature binds the whole canonical answer body, the operation, the target and the
chain. An order signature alone does not authorize the quotation terms of an answer. A quoted answer
authorized by signature needs **both** its full-answer signature and the signature of each order. In
API-key mode the key authorizes the venue write, and the tool still checks the quoted order
signatures before relay. Sign the body that `rfq-write` returns, not a body you assembled
separately. Reuse the same `clientRequestId` to retry the same intent. A changed body needs a fresh
id.

A rollover takes two parties. The cPT holder signs the order and receives the premium. The
source cST holder fills with `rollover-fill` and pays the premium. Either party can open the
rollover RFQ. When the cPT holder opens it, the cPT holder's order cites the quote with `quoteRef`.
When the cST holder opens it (with `auth {method:"apiKey"}`), the cPT holder answers and rests an
order that cannot cite the RFQ. The cST holder then fills that order by its terms
(cork-indexing-api#121).

A rollover RFQ uses `source { poolId, shares }` and `premiumToken`. It does not use the new-position
modes/packageIds/notionalAssets. Each option names an existing destination pool or a just-in-time
market. Prices are raw premium-token units per 1e18 destination shares. `rollover-intent` accepts
`quoteRef` and checks the quoted terms. A reserved rollover fill can also need the exclusive
filler's signature. That signature is separate from the RFQ write authorization.

`minDstPerSrc` protects the value the filler receives. BaseFiller pays only the caller, but the cPT
holder's clone decides how much it mints, under hooks and attesters that the cPT holder chose.
Phoenix deposits and unwinds at exactly 1:1. So when you omit `minDstPerSrc`, `rollover-fill`
derives the honest rate from `previewUnwindMint` (source) and `previewDeposit` (destination), with
no tolerance. If it cannot derive the rate, it refuses with `dst_floor_underivable`, and you pass
`--min-dst-per-src`. An explicit 0 warns `no_dst_floor`. A floor below the honest rate warns
`dst_floor_slack`. `data.trust` compares the clone's attesters with the factory defaults. It also
reports a queued trust change and checks every hook against the defaults.

API keys are **optional**. Installing or releasing this CLI never provisions one. Use
`ch auth set-key` with a hidden prompt or a pipe, never argv. A stored key is bound to its host. An
environment or process key applies to the configured venue. HTTP MCP refuses the operator's stored
and API keys. A person can instead use `ch wallet` and `ch sign --account <name>`. Passwords come
only from a terminal. CLI signing never broadcasts, and MCP never signs. A transaction from a
prepare that lacks nonce, gas or fees is not a complete transaction to sign.

Handle both JSON channels. Invalid input exits 2 with empty stdout and an error on stderr. A domain
refusal exits 3 with an unavailable result on stdout. For example, four or more new-position modes
are invalid input, but duplicate modes within the size limit are a domain refusal. A successful
result can carry warnings and still exit 0. Read the envelope state and the warning evidence before
you continue. See the failure table above.

Publishing a release does not deploy the hosted MCP service.


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
