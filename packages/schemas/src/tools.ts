import { z } from "zod";
import {
  Address,
  Bytes32,
  ChainId,
  ClientRequestId,
  DataMode,
  Format,
  Hex,
  MarketId,
  TokenAmount,
  Uint64Str,
  UintStr,
  UnixSeconds,
  UNIX_SECONDS_MAX_NUMBER,
} from "./primitives.ts";

// ────────────────────────────────────────────────────────────────────────────
// Common envelope (RFC §6). Version lives here, never in the tool name.
// ────────────────────────────────────────────────────────────────────────────
export const Provenance = z.object({
  source: z.enum(["chain", "indexer", "service", "config"]),
  mode: DataMode.optional(),
  chainId: ChainId,
  block: UintStr.optional(),
  fetchedAt: z.string(),
  digest: Bytes32.optional(),
  staleness: z.number().int().nonnegative().optional().describe("age of the served data in SECONDS (reserved; currently never emitted)"),
  /** Which RPC endpoint served a chain read (format:"full" only): resolution tier + host. */
  rpc: z.object({ source: z.enum(["explicit", "default", "chainlist"]), host: z.string() }).optional(),
});

export const Envelope = z.object({
  state: z.enum(["ok", "conflict", "unavailable"]),
  data: z.unknown(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .default([]),
  provenance: Provenance,
  schemaVersion: z.string(),
});
export type Envelope = z.infer<typeof Envelope>;

// ────────────────────────────────────────────────────────────────────────────
// 1. cork_query (R1)
// ────────────────────────────────────────────────────────────────────────────
export const QueryInput = z.object({
  resource: z
    .enum([
      "markets",
      "market",
      "pool-whitelist",
      "whitelisted-addresses",
      "flows",
      "limit-order-markets",
      "orderbook",
      "fills",
      "account-state",
      "protocol-config",
      "registry-assets",
      "registry-oracle",
      "registry-recipes",
      "registry-denominations",
      "registry-feeds",
      "derive-market",
      "rfqs",
    ])
    .describe(
      "markets=list all pools; market=one pool's full live state (needs filters.poolId); pool-whitelist=is a pool access-gated; whitelisted-addresses=enumerate CURRENT whitelist membership replayed from WhitelistManager events (HyperSync, needs ENVIO token; live-view verified when an RPC resolves; filters.poolId scopes to one pool, global rows ride along); flows=rollover orders/fills/contracts (filters.kind); limit-order-markets=tradable LOP pairs; orderbook=resting limit orders; fills=executed trades; account-state=balances+funding allowances (needs filters.poolId+account); protocol-config=deployed addresses (no RPC); registry-assets=MarketRegistry-approved assets, each with TWO NAMED SOURCE SLOTS (priceSource/navSource, either may be null) + token self-description; registry-oracle=rate-oracle status — a pair's MODE-KEYED wrapper (filters.collateralAsset+referenceAsset [+filters.mode 'price'|'nav'; one pair can hold both at different addresses]) OR a fixed-rate oracle keyed on the RATE (filters.rate, no pair); returns oracle{address,deployed,deployable} — address is the wrapper when deployed, the predicted wrapper when only deployable, null when the pair can't get one; registry-recipes=the approved recipe CONTRACTS (2.1.0: a recipe is an ADDRESS that self-reports source/description/constants — no modes, no stored bands; constants ending _PERCENTAGE are 1e18=1%, everything else 1e18=1.0); registry-denominations=label→unit map (labels are EXACT BYTES, case-sensitive; labelHash is the identity, label is display); registry-feeds=the Chainlink conversion feeds with live answers (one DIRECTED edge each — base→quote ≠ quote→base); derive-market=derive a market BEFORE it exists (needs filters.collateralAsset+referenceAsset+expiry+recipe [filters.mode = deprecated sugar; optional args/rate/rateOracle]): recipe+source, oracle{address,deployed,deployable,rate}, the OFF-CHAIN-resolved constraint, pool id, shares{corkSwapToken,corkPrincipalToken}, and whether the pool exists — the same derivation a JIT LOP fill runs; identity is PINNED once an order carrying the constraint is signed (Arbitrum One); rfqs=venue RFQ feed — open requests-for-quote awaiting underwriter answers (default state=open; filters.rfqId for one record with all answers). Shared vocabulary across every read: the two share tokens are ALWAYS corkSwapToken (the cST) and corkPrincipalToken (the cPT); rateOracle inside a market's on-chain struct is the same contract that registry-oracle/derive-market report under oracle{address}",
    ),
  chainId: ChainId.optional(),
  mode: DataMode.optional(),
  filters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "resource-specific filters. Known keys: poolId (market/account-state/pool-whitelist), account (account-state/flows/rfqs — rfqs maps it to the requester), kind ('orders'|'fills'|'contracts' for flows), side, status, orderDigest, orderHash, filler, address (flows contracts / registry-assets single lookup by asset address), fillable, source, collateralAsset+referenceAsset (registry-oracle & derive-market — ORDER MATTERS, collateral first), recipe (registry-recipes single lookup / derive-market — the approved recipe CONTRACT ADDRESS), args (derive-market — the recipe's additionalData as raw hex, e.g. abi.encode(anchorRate) for the liquidity recipe), rate (registry-oracle fixed-rate lookup / derive-market FIXED recipes — 18-decimal integer string, 1e18=1.0), rateOracle (derive-market — explicit oracle override), mode (registry-oracle: 'price'|'nav', default price; registry-recipes/derive-market: DEPRECATED sugar that maps a legacy mode name to a configured recipe address, with a deprecation_notice), label (registry-denominations single lookup — EXACT BYTES, case-sensitive), base+quote (registry-feeds single lookup — direction matters), expiry (derive-market — market expiry as unix seconds, decimal string), legacy (registry-* reads: route to the DEPRECATED pre-2.1.0 registry generation; requires CORK_ENABLE_DEPRECATED=1), rfqId (rfqs single get, 'rfq_…'), state ('open'|'expired' for rfqs; default open), withAnswers (rfqs list: embed each RFQ's answers). Unknown keys are a teachable error",
    ),
  cursor: z.string().optional().describe("opaque cursor from a prior page's pagination.nextCursor, to resume a venue traversal"),
  pageSize: z.number().int().min(1).max(200).default(25).describe("items requested per venue page during traversal"),
  maxPages: z.number().int().min(1).max(50).default(10).describe("hard bound on pages walked in one venue traversal; hitting it returns state=ok with a pagination_incomplete warning and a nextCursor to resume"),
  format: Format,
});
export type QueryInput = z.infer<typeof QueryInput>;

// The rollover premium floor is a RATE, not an amount — describing it as a plain TokenAmount was
// a measured footgun (F9): with a 6-decimals premium asset the correct value is 1e12x smaller
// than the TokenAmount examples suggest. One shared $defs entry teaches this at every use site.
const PremiumPerShareRate = TokenAmount.describe(
  "premium floor RATE, not a plain amount: base units of the premium asset per 1e18 (one whole) dstCst share — premium floor = dstCstProduced * this / 1e18. Example: 0.012 per share is '12000000000000000' when the premium asset has 18 decimals but '12000' when it has 6",
).meta({ id: "PremiumPerShareRate" });

// ────────────────────────────────────────────────────────────────────────────
// 2. cork_compute (R2) — closed per-kind params
// ────────────────────────────────────────────────────────────────────────────
const AtPin = z.strictObject({
  block: UintStr.optional().describe("pin the read to this block number for bit-identical replay"),
  timestamp: UnixSeconds.optional().describe("unix SECONDS to evaluate at. HONORED by dutch-auction-price (a time-decaying price is pinned by the clock, not a block); accepted-but-reserved for the block-anchored kinds"),
});

export const ComputeParams = z.discriminatedUnion("kind", [
  z.strictObject({
      kind: z.literal("cst-swap-rate"),
      poolId: MarketId,
      collateralAssetsOut: TokenAmount,
    }).describe("cost (cST shares + reference assets in) of taking an exact collateral amount out via safeSwap, at the current on-chain rate"),
  z.strictObject({
      kind: z.literal("unwind-rate"),
      poolId: MarketId,
      collateralAssetsIn: TokenAmount,
    }).describe("reverse of cst-swap-rate: what putting an exact collateral amount back in returns"),
  z.strictObject({
      kind: z.literal("dutch-auction-price"),
      order: z
        .record(z.string(), z.unknown())
        .describe("the LOP v4 order: the 8 struct fields (decimal strings + addresses) PLUS `extension` (hex) — the auction curve lives in the extension and is reconstructed from those bytes [K3]"),
      baseFeeWei: UintStr.optional().describe("block base fee in WEI for the gas-bump term; omitted = gas bump skipped = the UPPER-BOUND price (public-node eth_call cannot verify this term — it runs with basefee 0)"),
      taker: Address.optional().describe("price for THIS taker (getter-whitelist discount applies); omitted = both whitelisted and non-whitelisted prices are returned"),
      makingAmount: TokenAmount.optional().describe("price this making amount (the fillable range is 0..the order's own makingAmount; a larger value is extrapolated past what any fill can consume and warns makingamount_exceeds_order); omitted = the full order"),
    }).describe(
      "current decayed price of a 1inch Fusion dutch-auction order (v3.1 layout) — pure local math, wei-exact vs the deployed settlement getters; pin the moment with at.timestamp (defaults to now)",
    ),
  z.strictObject({
      kind: z.literal("rollover-premium-floor"),
      dstCstProduced: TokenAmount,
      minPremiumPerShare: PremiumPerShareRate,
    }).describe("minimum premium a rollover order is guaranteed to earn — pure math, no RPC needed"),
  z.strictObject({
      kind: z.literal("impairment-floor"),
      poolId: MarketId,
      horizonSeconds: z.number().int().min(0).describe("look-ahead horizon, relative seconds"),
    }).describe("worst-case rate-constrained impairment over the horizon — a floor, not a forecast"),
  z.strictObject({
      kind: z.literal("rfq-quote"),
      marketTypeBucket: z.string(),
      durationSeconds: z.number().int().min(0),
      tokenRiskStats: z.record(z.string(), z.unknown()).optional(),
    }).describe("indicative RFQ quote for a market-type bucket (phase-gated)"),
  z.strictObject({
      kind: z.literal("resolve-recipe"),
      recipe: Address.optional().describe("the approved recipe CONTRACT ADDRESS (2.1.0: recipes are contracts, not mode strings) — discover with cork_query resource:'registry-recipes'"),
      mode: z.string().min(1).optional().describe("DEPRECATED sugar: a legacy mode name ('liquidity', 'fixed') mapped to a configured recipe address, with a deprecation_notice. Pass `recipe` instead. With legacy:true this is the OLD registry's exact mode string"),
      collateralAsset: Address.optional().describe("the pair the constraint is for (order matters: collateral first)"),
      referenceAsset: Address.optional(),
      args: Hex.optional().describe("the recipe's additionalData, raw hex passed verbatim into resolve (e.g. abi.encode(uint256 anchorRate) for the liquidity recipe when no oracle is live; the fixed-rate recipe rejects any payload)"),
      rate: UintStr.optional().describe("FIXED recipes (new path): the rate keying the FixedRateOracle (1e18 = 1.0). LEGACY path (legacy:true): the explicit rate to resolve percentage bands against"),
      rateOracle: Address.optional().describe("explicit rate-oracle override — used as given (live if deployed, else passed to the recipe as address(0), which is what lets the liquidity recipe fall back to the anchorRate in args)"),
      legacy: z.boolean().optional().describe("route to the DEPRECATED pre-2.1.0 band math against the OLD registry (requires CORK_ENABLE_DEPRECATED=1 and `mode`)"),
    }).describe(
      "ask a recipe CONTRACT what four rate limits it would impose on a pair — a staticcall to recipe.resolve, THE step that produces the constraint a JIT order carries and signs (fill the order's recipe/constraint/additionalData from ONE call so they agree). Constraint values are ABSOLUTE rates, 1e18 = 1.0",
    ),
]);
export type ComputeParams = z.infer<typeof ComputeParams>;

export const ComputeInput = z.object({
  params: ComputeParams,
  chainId: ChainId.optional(),
  at: AtPin.optional(),
  format: Format,
});
export type ComputeInput = z.infer<typeof ComputeInput>;

// ────────────────────────────────────────────────────────────────────────────
// 3. cork_decode (R3)
// ────────────────────────────────────────────────────────────────────────────
export const DecodeInput = z.object({
  kind: z
    .enum(["calldata", "tx", "order", "event", "receipt"])
    .describe(
      "all local reconstruction [K3]. calldata=Cork/Bundler3 tx bytes → labeled legs (recursively unwraps multicall); tx=a SIGNED raw transaction (legacy RLP or typed envelope 0x01–0x04) → recovered signer + to/value/chainId/nonce/gas, the target named against known Cork deployment addresses (plain warning when unknown), and the inner calldata decoded to the same labeled legs + summary — the validate-before-broadcast step (a supplied chainId that contradicts the tx's own is a conflict); order=1inch LOP v4 order (hex 8-word tuple, or the JSON struct fields) → full makerTraits breakdown + locally recomputed EIP-712 orderHash (a supplied orderHash/extension is cross-checked, mismatch → conflict); event=ONE log object {address?, topics[], data} → named args against the source-verified Cork/rollover/LOP/ERC-20 ABI set (unverified layouts labeled raw, never guessed); receipt=a tx receipt object {logs:[…]} → every log labeled the same way",
    ),
  data: z.union([
    Hex.describe("raw bytes to decode — tx calldata for kind 'calldata', the SIGNED raw transaction bytes for kind 'tx', or the 8-word order tuple for kind 'order'"),
    z
      .record(z.string(), z.unknown())
      .describe("an already-structured payload to label: the order's JSON struct fields (kind 'order'), ONE log object {address?, topics[], data} (kind 'event'), or a receipt {logs:[...]} (kind 'receipt')"),
  ]),
  chainId: ChainId.optional(),
  format: Format,
});
export type DecodeInput = z.infer<typeof DecodeInput>;

// ────────────────────────────────────────────────────────────────────────────
// 4. cork_prepare_phoenix (R4) — 13 adapter actions + 2 authority variants
// ────────────────────────────────────────────────────────────────────────────
const A = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.strictObject({ type: z.literal(t), ...shape });

// One-line disambiguation per branch: near-twin variant names (withdraw vs redeem vs unwind-*)
// are measured hard distractors for agents, and the min*/max* fields are slippage bounds whose
// direction the description must carry (the field name alone under-specifies).
export const PhoenixAction = z.discriminatedUnion("type", [
  A("mint", {
    poolId: MarketId,
    cptAndCstSharesOut: TokenAmount,
    receiver: Address,
    maxCollateralAssetsIn: TokenAmount,
  }).describe("enter exact-OUT: buy an exact number of CPT+CST share pairs; maxCollateralAssetsIn is the slippage cap on collateral paid"),
  A("deposit", {
    poolId: MarketId,
    collateralAssetsIn: TokenAmount,
    receiver: Address,
    minCptAndCstSharesOut: TokenAmount,
  }).describe("enter exact-IN: deposit an exact collateral amount; minCptAndCstSharesOut is the slippage floor on share pairs received"),
  A("unwind-deposit", {
    poolId: MarketId,
    collateralAssetsOut: TokenAmount,
    owner: Address,
    receiver: Address,
    maxCptAndCstSharesIn: TokenAmount,
  }).describe("exit exact-OUT (pre-expiry): burn share pairs to get an exact collateral amount back; maxCptAndCstSharesIn caps the pairs burned"),
  A("unwind-mint", {
    poolId: MarketId,
    cptAndCstSharesIn: TokenAmount,
    owner: Address,
    receiver: Address,
    minCollateralAssetsOut: TokenAmount,
  }).describe("exit exact-IN (pre-expiry): burn an exact number of share pairs; minCollateralAssetsOut floors the collateral returned"),
  A("withdraw", {
    poolId: MarketId,
    collateralAssetsOut: TokenAmount,
    owner: Address,
    receiver: Address,
    maxCptSharesIn: TokenAmount,
  }).describe("POST-expiry settle, exact collateral out: burn at most maxCptSharesIn CPT (CPT only — vs unwind-* which burn CPT+CST pairs pre-expiry)"),
  A("withdraw-other", {
    poolId: MarketId,
    referenceAssetsOut: TokenAmount,
    owner: Address,
    receiver: Address,
    maxCptSharesIn: TokenAmount,
  }).describe("POST-expiry settle, exact REFERENCE assets out (not collateral): burn at most maxCptSharesIn CPT"),
  A("redeem", {
    poolId: MarketId,
    cptSharesIn: TokenAmount,
    owner: Address,
    receiver: Address,
    minReferenceAssetsOut: TokenAmount,
    minCollateralAssetsOut: TokenAmount,
  }).describe("POST-expiry settle, exact-IN: burn an exact CPT amount for pro-rata reference + collateral; both min* fields are slippage floors"),
  A("swap", {
    poolId: MarketId,
    collateralAssetsOut: TokenAmount,
    receiver: Address,
    maxCstSharesIn: TokenAmount,
    maxReferenceAssetsIn: TokenAmount,
  }).describe("coverage payout (safeSwap): take an exact collateral amount out, paying CST + reference in; both max* fields are slippage caps"),
  A("exercise", {
    poolId: MarketId,
    cstSharesIn: TokenAmount,
    receiver: Address,
    minCollateralAssetsOut: TokenAmount,
    maxReferenceAssetsIn: TokenAmount,
  }).describe("coverage payout exact-IN: burn an exact CST amount (+reference capped by maxReferenceAssetsIn) for collateral floored by minCollateralAssetsOut"),
  A("exercise-other", {
    poolId: MarketId,
    referenceAssetsIn: TokenAmount,
    receiver: Address,
    minCollateralAssetsOut: TokenAmount,
    maxCstSharesIn: TokenAmount,
  }).describe("coverage payout pinned on the REFERENCE leg: pay an exact reference amount in, CST capped, collateral floored"),
  A("unwind-swap", {
    poolId: MarketId,
    collateralAssetsIn: TokenAmount,
    receiver: Address,
    minReferenceAssetsOut: TokenAmount,
    minCstSharesOut: TokenAmount,
  }).describe("reverse of swap: put an exact collateral amount back in, receiving CST + reference (both floored)"),
  A("unwind-exercise", {
    poolId: MarketId,
    cstSharesOut: TokenAmount,
    receiver: Address,
    minReferenceAssetsOut: TokenAmount,
    maxCollateralAssetsIn: TokenAmount,
  }).describe("reverse of exercise: recover an exact CST amount, paying collateral (capped) and receiving reference (floored)"),
  A("unwind-exercise-other", {
    poolId: MarketId,
    referenceAssetsOut: TokenAmount,
    receiver: Address,
    minCstSharesOut: TokenAmount,
    maxCollateralAssetsIn: TokenAmount,
  }).describe("reverse of exercise-other, pinned on the REFERENCE leg: recover an exact reference amount; CST floored, collateral capped"),
  A("authority-onboard", {
    token: Address,
    spender: Address,
    amount: TokenAmount.optional(),
  }).describe("token-authority op: unsigned DIRECT ERC-20 approve tx granting a standing allowance (amount omitted = unlimited) — an owner-signed tx, not a bundle leg (allowances are keyed to msg.sender); spender is normally the corkAdapter (erc20-approve mode) or canonical Permit2 (permit2 mode)"),
  A("authority-revoke", { token: Address, spender: Address })
    .describe("token-authority op: unsigned DIRECT ERC-20 approve(spender, 0) tx zeroing an allowance"),
]);
export type PhoenixAction = z.infer<typeof PhoenixAction>;

export const PreparePhoenixInput = z.object({
  chainId: ChainId,
  account: Address.describe("the initiating account. Funding legs pull from Bundler3's initiator at execution time, but this is ALSO the recipient of the sweep-back legs: for actions funded from a slippage CAP (any max* input), the bundle ends by returning the unspent remainder here, so it is not left on the adapter where anyone can take it. Set it to the address that actually funds the bundle"),
  clientRequestId: ClientRequestId,
  fundingMode: z
    .enum(["permit2", "erc20-approve", "pre-funded"])
    .default("permit2")
    .describe(
      "how the bundle sources tokens: permit2=Permit2 signature-based legs (default); erc20-approve=direct ERC-20 approve legs to the cork adapter; pre-funded=no funding legs (tokens already in place)",
    ),
  deadlineSeconds: z
    .number()
    .int()
    .min(1)
    .max(86400)
    .default(1800)
    .describe("RELATIVE deadline, seconds from now — re-anchors to the clock on every call, so a retry produces different bytes; pass deadlineAt instead for byte-stable retries"),
  // Absolute deadline override (unix seconds). deadlineSeconds re-anchors to the clock on every
  // call, so a retry produces different bytes; pin deadlineAt to make same-id retries BYTE-STABLE
  // [K2 §9 deadline-basis].
  deadlineAt: UnixSeconds.optional(),
  forSelf: z
    .strictObject({
      adapter: Address.describe("the INTEGRATOR-DEPLOYED Cork ForSelf pool adapter (Cork-Technology/cork-periphery shape) — not a Cork deployment; its CORK() binding is verified on-chain best-effort and a mismatch is a conflict, because the caller will be granting this address token allowances"),
    })
    .optional()
    .describe("emit the action as a DIRECT call to a Cork ForSelf ADAPTER (the *ForSelf twin of the action — e.g. exercise → exerciseForSelf) instead of a Bundler3 bundle — for accounts behind a parameter-blind (contract, selector) session-key policy (the Zyfai shape). The adapter's entrypoints carry NO receiver/owner parameters: outputs are structurally delivered to the calling account, inputs are pulled from it against allowances granted TO THE ADAPTER, and any unspent cap returns in the same transaction (custody-free). The action's receiver (and owner) must therefore equal `account`. fundingMode is ignored on this path — there are no funding or sweep legs to build. Not applicable to the authority ops"),
  action: PhoenixAction,
  format: Format,
});
export type PreparePhoenixInput = z.infer<typeof PreparePhoenixInput>;

// ────────────────────────────────────────────────────────────────────────────
// 5. cork_prepare_orders (R4, Phase 3)
// ────────────────────────────────────────────────────────────────────────────
const QuoteRef = z.strictObject({ rfqId: z.string(), answerId: z.string(), optionId: z.string() });

// The exact `data` object cork_prepare_orders maker-order returns, handed back verbatim to
// finalize-maker-order. Wire-serialized: message amounts/salt/traits are decimal strings.
// z.object strips the extra fields (types, jit) the caller round-trips.
const PreparedMakerOrderWire = z.object({
  kind: z.literal("maker-order"),
  lop: Address,
  typedData: z.object({
    domain: z.object({ chainId: ChainId, verifyingContract: Address }),
    message: z.object({
      salt: UintStr,
      maker: Address,
      receiver: Address,
      makerAsset: Address,
      takerAsset: Address,
      makingAmount: TokenAmount,
      takingAmount: TokenAmount,
      makerTraits: UintStr,
    }),
  }),
  orderHash: Bytes32,
  extension: Hex.default("0x"),
  clientRequestId: ClientRequestId,
});

export const OrdersAction = z.discriminatedUnion("type", [
  A("maker-order", {
    poolId: MarketId,
    side: z.enum(["BUY", "SELL"]).describe("side from the MAKER's perspective for the venue listing"),
    makerAsset: Address,
    takerAsset: Address,
    makingAmount: TokenAmount,
    takingAmount: TokenAmount,
    expirySeconds: z.number().int().min(1).max(315_576_000).optional().describe("RELATIVE expiry, seconds from now (omit for no expiry; max 10 years — the trait slot is 40-bit and an absolute/ms value pasted here would otherwise silently wrap)"),
    allowsPartialFills: z.boolean().default(true).describe("true allows a fill smaller than makingAmount — but Cork-built orders live in the 1inch BIT invalidator (allowMultipleFills is off), so the FIRST fill of ANY size consumes the whole order: post 100, get 1 filled, and the remaining 99 are dead. To serve multiple takers, post several smaller orders EACH WITH ITS OWN clientRequestId — the invalidator bit is derived from it, and orders sharing an id would share a bit, so filling one would invalidate the others"),
    usePermit2: z.boolean().default(false),
    extension: Hex.optional().describe("raw 1inch LOP v4 extension bytes; when set, the salt is derived to commit to it (OrderLib InvalidExtension check). Mutually exclusive with jitMarket and auction, which BUILD the extension"),
    auction: z
      .strictObject({
        startTime: UnixSeconds.optional().describe("when the price starts decaying, absolute unix SECONDS — omitted = prepare time (the price then decays from the first moment the order can rest)"),
        durationSeconds: z.number().int().min(60).max(16_777_215).describe("how long the decay runs, RELATIVE seconds (3-byte wire field, max ~194 days). After start+duration the price sits at the signed floor until the order expires"),
        initialRateBump: UintStr.describe("the premium ABOVE the signed takingAmount at auction start, base 1e7 = +100% — '500000' starts the price 5% above the floor and decays linearly to it (piecewise-linear with points). The signed takingAmount IS the floor"),
        points: z
          .array(z.strictObject({ rateBump: UintStr.describe("bump at this point, base 1e7; must be NON-INCREASING — each point <= the preceding point's bump (<= initialRateBump for the first). The getters interpolate linearly between points, so a point higher than its predecessor would make the price RISE across that segment; a dutch auction only decays."), timeDelta: z.number().int().min(1).max(65_535).describe("seconds since the previous point (2-byte wire field)") }))
          .max(255)
          .optional()
          .describe("piecewise-linear curve knees; omitted = one straight line from initialRateBump to 0 over the duration"),
      })
      .optional()
      .describe("Cork-native DECAYING-PREMIUM order (the modeled-quote-free answer to rfq-quote): the deployed 1inch Fusion settlement is used purely as an AMOUNT GETTER — no postInteraction, so ANY taker fills at the current decayed price through the plain LOP fill path; the auction discovers the premium instead of a pricing model. Composes with jitMarket (one extension, one salt binding). Mutually exclusive with raw `extension`. Price the resting order any time with cork_compute dutch-auction-price"),
    jitMarket: z
      .strictObject({
        collateralAsset: Address,
        referenceAsset: Address,
        expiryTimestamp: UnixSeconds.describe("pool expiry — must be in the future at creation"),
        recipe: Address.optional().describe("the approved IMarketRecipe CONTRACT ADDRESS the order names — required in 2.1.0 (no unverified path; discover with cork_query resource:'registry-recipes'). Omittable only when `mode` sugar is used"),
        mode: z.string().min(1).optional().describe("DEPRECATED sugar: a legacy mode name ('liquidity', 'fixed') mapped to a configured recipe address, with a deprecation_notice — pass `recipe` instead. With legacy:true this is the OLD registry's exact mode string (required there)"),
        rateOverride: UintStr.default("0").describe("FIXED recipes only: the rate their FixedRateOracle is deployed at (ABSOLUTE, 1e18 = 1.0; zero reverts). For price/nav recipes this MUST stay 0 — a non-zero value is REJECTED by the fill (UnexpectedRateOverride), not ignored"),
        additionalData: Hex.optional().describe("the recipe-specific bytes the constraint is derived from and re-checked against (e.g. abi.encode(uint256 anchorRate) for the liquidity recipe while its oracle is undeployed; the fixed-rate recipe rejects any payload). Defaults to 0x"),
        constraint: z
          .strictObject({ rateMin: UintStr, rateMax: UintStr, rateChangePerDayMax: UintStr, rateChangeCapacityMax: UintStr })
          .optional()
          .describe("the four rate limits the order carries (ABSOLUTE, 1e18 = 1.0) — PART OF POOL IDENTITY, pinned at signing. Omit to auto-resolve via recipe.resolve at prepare time (needs an RPC), guaranteeing recipe/constraint/additionalData agree; pass explicitly (from cork_compute resolve-recipe) for offline byte-building"),
        swapFeePercentage: UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18 = 5%) — consumed only if this fill creates the pool"),
        unwindSwapFeePercentage: UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18) — creation only"),
        enableJitMint: z.boolean().default(false).describe("maker-side just-in-time mint of the cST being sold, funded by the maker's own collateral; false = market-creation only (maker must already hold the cST). IGNORED on the taker path, which always mints"),
        permits: z
          .array(z.strictObject({ token: Address, value: UintStr, deadline: UnixSeconds, v: z.number().int().min(0).max(255), r: Bytes32, s: Bytes32 }))
          .max(8)
          .optional()
          .describe("pre-signed ERC-2612 permits the adapter executes after the mint (spender is always the LOP) — needed to let the LOP pull a just-created cST; the result reports the predicted cST address to sign the permit over"),
        legacy: z.boolean().optional().describe("build against the DEPRECATED pre-2.1.0 adapter/registry generation (mode-string extraData, constraint derived at FILL time) — requires CORK_ENABLE_DEPRECATED=1 and `mode`. Kept because that adapter still holds the controller roles until governance grants the 2.1.0 ones"),
      })
      .optional()
      .describe(
        "attach the Cork JIT adapter as the maker-side preInteraction hook (2.1.0): the order names a recipe CONTRACT and CARRIES the off-chain-resolved constraint — pool id and share addresses are PINNED at signing; the fill deploys the oracle if needed, re-checks the constraint with recipe.verify (stale ⇒ RecipeRejectedConstraint), creates the pool if missing, and (if enableJitMint) mints the cST just in time. One order side MUST be the derived pool's cST. Omit entirely for a plain order on an existing pool",
      ),
  }).describe("signable 1inch LOP v4 maker order (typed-data to sign, then finalize-maker-order, then pass its submitInput verbatim to cork_submit); optional jitMarket block attaches just-in-time Cork market creation/minting to the fill"),
  A("finalize-maker-order", {
    prepared: PreparedMakerOrderWire.describe("the exact data object returned by cork_prepare_orders maker-order"),
    signature: Hex.describe("the caller's EIP-712 signature over the prepared order — recovered against the locally reconstructed hash, never produced here [K1]"),
    listing: z.strictObject({
      side: z.enum(["BUY", "SELL"]),
      premium: z.number().min(0).max(1000).describe("PERCENT number for the venue listing (4.1 = 4.1%), not a fraction; must be 0..1000"),
      expiry: z.number().int().nonnegative().max(UNIX_SECONDS_MAX_NUMBER).describe("absolute unix SECONDS (not ms; bounded to year 2100); 0 = no expiry"),
      nonce: UintStr,
      allowsPartialFills: z.boolean(),
      quoteRef: QuoteRef.optional().describe("the RFQ answer option this order executes, if any"),
    }),
  }).describe("verify a caller-signed maker order (recover signer, reconstruct exact bytes, check salt↔extension binding) and emit a ready cork_submit lop-order artifact — never signs [K1]"),
  A("taker-fill", {
    orderHash: Bytes32,
    fillMakingAmount: TokenAmount.optional().describe("making amount to receive; omit for the full remaining order"),
    maximumTakingAmount: TokenAmount.optional().describe("hard cap on taking amount paid (slippage guard); omit to use the exact rounded-up signed ratio"),
    receiver: Address.optional().describe("recipient of the maker asset; defaults to account"),
    interaction: Hex.optional().describe("RAW taker interaction calldata (`adapter address ++ extraData`), invoked via takerInteraction DURING the fill — after the maker asset moves, before the taker asset is pulled. Prefer `jitMarket`, which BUILDS these bytes with pre-flights; pass raw hex only when you assembled the payload yourself. Rides in args after the extension; length packed at takerTraits bits 200-223"),
    jitMarket: z
      .strictObject({
        collateralAsset: Address,
        referenceAsset: Address,
        expiryTimestamp: UnixSeconds.describe("pool expiry — must be in the future at creation"),
        recipe: Address.optional().describe("the approved IMarketRecipe CONTRACT ADDRESS (discover with cork_query resource:'registry-recipes'). Omittable only when `mode` sugar is used"),
        mode: z.string().min(1).optional().describe("DEPRECATED sugar: a legacy mode name mapped to a configured recipe address, with a deprecation_notice — pass `recipe` instead"),
        rateOverride: UintStr.default("0").describe("FIXED recipes only (ABSOLUTE, 1e18 = 1.0; zero reverts); MUST stay 0 for price/nav recipes — rejected by the fill, not ignored"),
        additionalData: Hex.optional().describe("the recipe-specific bytes the constraint is derived from and re-checked against. Defaults to 0x"),
        constraint: z
          .strictObject({ rateMin: UintStr, rateMax: UintStr, rateChangePerDayMax: UintStr, rateChangeCapacityMax: UintStr })
          .optional()
          .describe("the four rate limits (ABSOLUTE, 1e18 = 1.0) — PART OF POOL IDENTITY: they must derive the pool whose cST one side of the RESTING ORDER names, or the fill reverts OrderNotForPool. Omit to auto-resolve via recipe.resolve (needs an RPC); when the resting order carries its own JIT extension, the derived pool id is cross-checked against it"),
        swapFeePercentage: UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18) — consumed only if this fill creates the pool"),
        unwindSwapFeePercentage: UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18) — creation only"),
        enableJitMint: z.boolean().default(false).describe("encoded because the struct layout requires it, but IGNORED on the taker path — takerInteraction ALWAYS mints (attaching the hook to the taker side IS the opt-in)"),
        permits: z
          .array(z.strictObject({ token: Address, value: UintStr, deadline: UnixSeconds, v: z.number().int().min(0).max(255), r: Bytes32, s: Bytes32 }))
          .max(8)
          .optional()
          .describe("pre-signed ERC-2612 permits the adapter executes after the mint — owner is the TAKER (the party served by this hook), spender is always the LOP; needed so the LOP can pull the just-minted cST from the taker. The result reports the predicted cST address to sign the permit over"),
      })
      .optional()
      .describe(
        "build the taker interaction FOR this fill (2.1.0): lifting a BUY-cover resting order, the underwriter-taker delivers a not-yet-minted cST — takerInteraction deploys the oracle if needed, verifies the carried constraint, creates the pool, mints the cST to the taker (funded by the taker's collateral; approve the adapter for the collateral pull), and executes the permits, all between the maker asset moving and the taker asset being pulled. Mutually exclusive with raw `interaction`",
      ),
    forSelf: z
      .strictObject({
        adapter: Address.describe("the INTEGRATOR-DEPLOYED Cork ForSelf fill adapter (Cork-Technology/cork-periphery shape) — not a Cork deployment; its CORK()/LOP() bindings are verified on-chain best-effort and a mismatch is a conflict, because the caller will be granting this address an allowance"),
        poolId: MarketId.describe("the Cork market this fill must belong to — the wrapper binds the order's asset pair to this pool ON-CHAIN (checked after the fill, so a just-in-time order whose market is created during the fill still passes) and reverts OrderAssetsNotInMarket otherwise"),
        deadlineSeconds: z.number().int().min(1).max(86400).default(1800).describe("RELATIVE deadline for the wrapper's own deadline check, seconds from now — re-anchors to the clock on every call; pass deadlineAt for byte-stable retries"),
        deadlineAt: UnixSeconds.optional().describe("absolute wrapper deadline (unix seconds) — pins same-clientRequestId retries to identical bytes [K2]"),
      })
      .optional()
      .describe("emit the unsigned fill as a call to a Cork ForSelf ADAPTER (fillOrderForSelf) instead of raw LOP calldata — for accounts behind a parameter-blind (contract, selector) session-key policy (the Zyfai shape). The wrapper structurally forces the bought asset to the CALLER, disables taker interactions and Permit2 sourcing, pulls the taker asset from the caller up to the slippage cap and sweeps back the unspent remainder, and binds the fill to `poolId`. Approve the ORDER's taker asset to the ADAPTER (not the LOP). Mutually exclusive with receiver, interaction, and jitMarket — lifting a BUY-cover order with a taker-side JIT mint is the underwriter's raw-LOP path, not a caged-wallet path"),
    maxPages: z.number().int().min(1).max(50).default(10).describe("hard bound on venue orderbook pages searched for the resting order; an exhausted bound fails closed as pagination_incomplete"),
  }).describe("unsigned fill calldata for a resting venue order: fetches and locally re-hashes the signed order, then emits canonical 1inch v6 fillOrder(Args) calldata (uint256 tuple selector) with the extension/receiver/interaction args layout when needed — or, with `forSelf`, an unsigned call to an integrator-deployed Cork ForSelf adapter's fillOrderForSelf for parameter-blind session-key wallets — never signs or broadcasts"),
  A("cancel", { orderHash: Bytes32, makerTraits: UintStr.describe("the order's makerTraits value, verbatim from the resting order") })
    .describe("on-chain cancel calldata for a resting LOP order you made"),
  A("rollover-intent", {
    settler: Address.describe("CorkSettler to bind to: ExactSettler (all-or-nothing) or PartialSettler (partial fills) — mode gate must match allowPartialFills"),
    rolloverContract: Address,
    srcPoolId: MarketId,
    dstPoolId: MarketId,
    srcCstToken: Address,
    dstCstToken: Address,
    premiumToken: Address,
    orderSize: TokenAmount,
    minPremiumPerShare: PremiumPerShareRate,
    openDeadline: UnixSeconds,
    fillDeadline: UnixSeconds,
    minCaReceived: TokenAmount.optional(),
    minSharesOut: TokenAmount.optional(),
    allowPartialFills: z.boolean().default(false).describe("must match the settler kind: true requires PartialSettler, false requires ExactSettler"),
    allowUnderfill: z.boolean().default(false),
    premiumPaymentMode: z.union([z.literal(0), z.literal(1)]).optional().describe("0=upfront, 1=on-settle"),
    fillerHint: Address.optional(),
    exclusiveFiller: Address.optional(),
    orderSalt: Uint64Str.optional().describe("pin for byte-stable retries; omitted = derived from clientRequestId"),
    nonce: Uint64Str.optional(),
  }).describe("signable rollover ERC-7683 OrderData under the CorkSettler EIP-712 domain (sign, then cork_submit rollover-order)"),
]);
export const PrepareOrdersInput = z.object({
  chainId: ChainId,
  account: Address,
  clientRequestId: ClientRequestId,
  action: OrdersAction,
  format: Format,
});
export type PrepareOrdersInput = z.infer<typeof PrepareOrdersInput>;

// ────────────────────────────────────────────────────────────────────────────
// 6. cork_prepare_market (R4, Phase 4 — provisional, Q-REG)
// ────────────────────────────────────────────────────────────────────────────
export const PrepareMarketInput = z.object({
  chainId: ChainId,
  clientRequestId: ClientRequestId,
  action: z.discriminatedUnion("type", [
    A("deploy-oracle", {
      collateralAsset: Address,
      referenceAsset: Address,
      mode: z.enum(["price", "nav"]).optional().describe("which wrapper to deploy — oracles are MODE-KEYED in 2.1.0 (one pair can hold a price AND a nav wrapper at different addresses). Defaults to 'price' with a note"),
    })
      .describe("unsigned MarketRegistry.deploy(ca, ref, mode) tx: create the pair's mode-keyed rate-oracle wrapper — permissionless and IDEMPOTENT (an existing pair/mode just returns the recorded wrapper). Pair order matters: collateral first"),
    A("deploy-fixed-oracle", {
      rate: UintStr.describe("the fixed rate the oracle reports, ABSOLUTE 1e18 = 1.0 — CREATE2-salted by this rate, so a given rate has ONE oracle per chain; zero reverts"),
    })
      .describe("unsigned MarketRegistry.deployFixedRateOracle(rate) tx: create the fixed-rate oracle for a RATE (no pair — a fixed rate is not a fact about two assets). Permissionless and IDEMPOTENT; this is the oracle a FIXED-recipe JIT order's rateOverride will produce"),
  ]),
  format: Format,
});
export type PrepareMarketInput = z.infer<typeof PrepareMarketInput>;

// ────────────────────────────────────────────────────────────────────────────
// 7. cork_track (R5)
// ────────────────────────────────────────────────────────────────────────────
export const TrackSubject = z.discriminatedUnion("kind", [
  z.strictObject({
      kind: z.literal("artifact"),
      artifact: z.record(z.string(), z.unknown()),
    }).describe("a prepared artifact you were handed — digest-pinned and re-verified, never trusted as-is [K3]"),
  z.strictObject({ kind: z.literal("txHash"), txHash: Bytes32 }).describe("an on-chain transaction — reconcile its receipt to an outcome"),
  z.strictObject({ kind: z.literal("orderHash"), orderHash: Bytes32 }).describe("a rollover orderDigest or LOP orderHash — reconcile venue lifecycle vs on-chain settler state [K7]"),
  z.strictObject({ kind: z.literal("marketRef"), poolId: MarketId }).describe("a pool — re-hash its MarketId against live chain state"),
  z.strictObject({ kind: z.literal("submissionRef"), submissionRef: z.string() }).describe("a prior cork_submit reference — resolve it to a lifecycle state"),
]);
export type TrackSubject = z.infer<typeof TrackSubject>;

export const TrackInput = z.object({
  mode: z
    .enum(["verify", "simulate", "reconcile"])
    .describe("verify=check a resource against deployed chain state; reconcile=resolve a receipt/order to a closed lifecycle state; simulate=eth_call dry-run of a FROZEN prepared artifact (subject kind 'artifact' with to/bundler3 + data/multicall + from/account) — answers wouldRevert BEFORE anyone signs"),
  subject: TrackSubject,
  expect: z.object({ artifactDigest: Bytes32 }).optional(),
  chainId: ChainId.optional(),
  format: Format,
});
export type TrackInput = z.infer<typeof TrackInput>;

// ────────────────────────────────────────────────────────────────────────────
// 8. cork_capabilities (R6)
// ────────────────────────────────────────────────────────────────────────────
export const CapabilitiesInput = z.object({
  topic: z.string().optional(),
  search: z.string().optional(),
});
export type CapabilitiesInput = z.infer<typeof CapabilitiesInput>;

// ────────────────────────────────────────────────────────────────────────────
// 9. cork_submit (R5 submission — the only side-effecting tool; all venue writes)
// ────────────────────────────────────────────────────────────────────────────
// Every action is an off-chain HTTPS POST to the as-built venue relaying a CALLER-authored (and
// where the venue verifies it, CALLER-signed) payload [K1]. Commitments in the payload are
// recomputed locally before relaying [K3].
const HookCallWire = z.strictObject({
  target: Address,
  value: UintStr.describe("native value in wei, decimal string"),
  callData: Hex,
  allowFailure: z.boolean(),
  isDelegateCall: z.boolean(),
});
const RolloverParamsWire = z.strictObject({
  srcCstToken: Address,
  dstCstToken: Address,
  minCaReceived: TokenAmount,
  minSharesOut: TokenAmount,
  srcPoolId: Bytes32,
  dstPoolId: Bytes32,
  settler: Address,
});
const RolloverOrderWire = z.strictObject({
  user: Address,
  settler: Address,
  fillerHint: Address,
  exclusiveFiller: Address,
  srcCstToken: Address,
  dstCstToken: Address,
  premiumToken: Address,
  rolloverContract: Address,
  originChainId: Uint64Str,
  destinationChainId: Uint64Str,
  openDeadline: UnixSeconds,
  fillDeadline: UnixSeconds,
  orderSalt: Uint64Str,
  orderSize: TokenAmount,
  minPremiumPerShare: PremiumPerShareRate,
  allowPartialFills: z.boolean(),
  allowUnderfill: z.boolean(),
  premiumPaymentMode: z.union([z.literal(0), z.literal(1)]).describe("0=upfront, 1=on-settle — must match what the signature covers"),
  rolloverIntentHash: Bytes32.describe("EIP-712 struct hash of the zero-digest RolloverIntent — recomputed locally before relay; a mismatch is a conflict, not relayed [K3]"),
  rolloverParams: RolloverParamsWire,
});
const RolloverIntentWire = z.strictObject({
  rolloverContract: Address,
  deadline: UnixSeconds,
  nonce: Uint64Str,
  preRolloverHooks: z.array(HookCallWire).max(32),
  midRolloverHooks: z.array(HookCallWire).max(32),
  postRolloverHooks: z.array(HookCallWire).max(32),
  premiumHooks: z.array(HookCallWire).max(32),
});
const LopOrderStructWire = z.strictObject({
  salt: UintStr,
  maker: Address,
  receiver: Address,
  makerAsset: Address,
  takerAsset: Address,
  makingAmount: TokenAmount,
  takingAmount: TokenAmount,
  makerTraits: UintStr,
});

export const SubmitAction = z.discriminatedUnion("type", [
  A("rollover-order", {
    order: RolloverOrderWire,
    intent: RolloverIntentWire,
    signature: Hex.describe("the maker's EIP-712 signature over the OrderData (CorkSettler domain) — this tool never signs [K1]"),
  }).describe("relay a caller-signed rollover ERC-7683 order to the venue (build it with cork_prepare_orders rollover-intent)"),
  A("lop-order", {
    order: LopOrderStructWire,
    signature: Hex.describe("the maker's EIP-712 signature over the LOP v4 order — this tool never signs [K1]"),
    extension: Hex.default("0x"),
    side: z.enum(["BUY", "SELL"]),
    premium: z.number().min(0).max(1000).describe("PERCENT number for the venue listing (4.1 means 4.1%) — NOT a fraction; 0.041 would be read as 0.041% and trips the premium_scale tripwires. Must be 0..1000: a negative or wad-scale (4.1e18) value is a unit mistake, rejected"),
    expiry: z.number().int().nonnegative().max(UNIX_SECONDS_MAX_NUMBER).describe("absolute unix SECONDS (not ms; bounded to year 2100); 0 = no expiry"),
    nonce: UintStr,
    allowsPartialFills: z.boolean(),
    makerAccountType: z.enum(["EOA", "ERC1271"]).default("EOA"),
    makerPermit2: Hex.default("0x"),
    quoteRef: QuoteRef.optional().describe("the RFQ answer option this order executes, if any — premium is cross-checked against it before relay"),
  }).describe("relay a caller-signed 1inch LOP v4 maker order to the venue orderbook (build it with cork_prepare_orders maker-order)"),
  A("rfq-open", {
    requester: Address,
    referenceAsset: Address,
    collateralAsset: z.union([
      z.strictObject({ exact: Address }).describe("exactly this collateral token"),
      z.strictObject({ one_of: z.array(Address).min(1).max(8) }).describe("any of these collateral tokens is acceptable"),
    ]),
    modes: z.array(z.enum(["liquidity_only", "liquidity_impairment"])).min(1),
    packageIds: z.array(z.string()).min(1).max(8),
    expiryWindow: z.strictObject({
      notBefore: z.number().int().nonnegative().max(UNIX_SECONDS_MAX_NUMBER).describe("earliest acceptable pool expiry, absolute unix SECONDS (not ms; bounded to year 2100)"),
      notAfter: z.number().int().nonnegative().max(UNIX_SECONDS_MAX_NUMBER).describe("latest acceptable pool expiry, absolute unix SECONDS (not ms; bounded to year 2100) — must not precede notBefore"),
    }),
    marketTemplate: z.record(z.string(), z.unknown()).optional().describe("venue market template: either {market_template_id} or {inline:{oracle_recipe, …}}. CONVENTION (2.1.0): put the approved recipe CONTRACT ADDRESS in inline.oracle_recipe — the venue types it as free text (it would happily accept a legacy mode name like 'liquidity'), but the fill path only accepts a registered recipe address, so both sides must put the address here for the quote to be executable"),
    notionalAssets: TokenAmount,
    validUntil: z.number().int().nonnegative().max(UNIX_SECONDS_MAX_NUMBER).describe("RFQ validity cutoff, absolute unix SECONDS (not ms; bounded to year 2100) — must be in the future"),
    signature: Hex,
  }).describe("open a request-for-quote as a coverage buyer: the parameter envelope underwriters answer against"),
  A("rfq-answer", {
    rfqId: z.string().min(1),
    underwriter: Address,
    status: z.enum(["quoted", "pass"]).describe("quoted=submitting priced options; pass=declining (give reasonCode)"),
    options: z.array(z.record(z.string(), z.unknown())).max(16).optional().describe("priced quote options; premium fields inside are fraction STRINGS per the venue numbers contract (\"0.041\" = 4.1%)"),
    reasonCode: z.enum(["NO_CAPACITY", "PAIR_UNSUPPORTED", "TENOR_NOT_QUOTED", "PASS"]).optional(),
    signature: Hex,
  }).describe("answer an open RFQ as an underwriter: priced options or a pass"),
]);

export const SubmitInput = z.object({
  chainId: ChainId,
  clientRequestId: ClientRequestId,
  action: SubmitAction,
  format: Format,
});
export type SubmitInput = z.infer<typeof SubmitInput>;
