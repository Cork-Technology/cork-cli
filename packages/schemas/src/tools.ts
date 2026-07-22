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
  staleness: z.number().optional(),
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
    ])
    .describe(
      "markets=list all pools; market=one pool's full live state (needs filters.poolId); pool-whitelist=is a pool access-gated; whitelisted-addresses=gated rows per pool; flows=rollover orders/fills/contracts (filters.kind); limit-order-markets=tradable LOP pairs; orderbook=resting limit orders; fills=executed trades; account-state=balances+funding allowances (needs filters.poolId+account); protocol-config=deployed addresses (no RPC); registry-assets=MarketRegistry-approved assets; registry-oracle=rate-oracle status for a pair (needs filters.collateralAsset+referenceAsset; deployed/deployable/why-not); registry-recipes=constraint recipe modes (percentage bands, 1e18=1%)",
    ),
  chainId: ChainId.optional(),
  mode: DataMode.optional(),
  filters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "resource-specific filters. Known keys: poolId (market/account-state/pool-whitelist), account (account-state/flows), kind ('orders'|'fills'|'contracts' for flows), side, status, orderDigest, orderHash, filler, address, fillable, source, collateralAsset+referenceAsset (registry-oracle — ORDER MATTERS, collateral first), mode (registry-recipes single lookup — exact case-sensitive string). Unknown keys are a teachable error",
    ),
  cursor: z.string().optional().describe("reserved for a later phase — accepted but not yet honored; omit"),
  pageSize: z.number().int().min(1).max(200).default(25).describe("reserved for a later phase — accepted but not yet honored"),
  format: Format,
});
export type QueryInput = z.infer<typeof QueryInput>;

// ────────────────────────────────────────────────────────────────────────────
// 2. cork_compute (R2) — closed per-kind params
// ────────────────────────────────────────────────────────────────────────────
const AtPin = z.strictObject({
  block: UintStr.optional().describe("pin the read to this block number for bit-identical replay"),
  timestamp: UintStr.optional().describe("reserved for a later phase — accepted but not yet honored"),
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
      order: z.record(z.string(), z.unknown()),
      baseFeeWei: UintStr.optional(),
    }).describe("current decayed price of a 1inch Fusion dutch-auction order (phase-gated)"),
  z.strictObject({
      kind: z.literal("rollover-premium-floor"),
      dstCstProduced: TokenAmount,
      minPremiumPerShare: TokenAmount,
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
      mode: z.string().min(1).describe("registry recipe mode — EXACT case-sensitive string (e.g. 'liquidity', 'fixed')"),
      rate: UintStr.optional().describe("18-decimal rate to resolve against (1e18 = 1.0). Omit and pass collateralAsset+referenceAsset to use the pair's LIVE oracle rate instead"),
      collateralAsset: Address.optional(),
      referenceAsset: Address.optional(),
    }).describe(
      "resolve a MarketRegistry recipe's PERCENTAGE bands (1e18 = 1%) into ABSOLUTE rate constraints (1e18 = 1.0) — the exact math a JIT fill runs; bit-parity self-checked against the on-chain applyBands",
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
    .enum(["calldata", "order", "event", "receipt"])
    .describe("calldata=Cork/Bundler3 tx bytes → labeled legs (live); order/event/receipt are phase-gated and return unavailable"),
  data: z.union([Hex, z.record(z.string(), z.unknown())]),
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
  }).describe("token-authority op (phase-gated): grant a standing allowance; amount omitted = unlimited"),
  A("authority-revoke", { token: Address, spender: Address })
    .describe("token-authority op (phase-gated): zero out an allowance"),
]);
export type PhoenixAction = z.infer<typeof PhoenixAction>;

export const PreparePhoenixInput = z.object({
  chainId: ChainId,
  account: Address,
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
  action: PhoenixAction,
  format: Format,
});
export type PreparePhoenixInput = z.infer<typeof PreparePhoenixInput>;

// ────────────────────────────────────────────────────────────────────────────
// 5. cork_prepare_orders (R4, Phase 3)
// ────────────────────────────────────────────────────────────────────────────
export const OrdersAction = z.discriminatedUnion("type", [
  A("maker-order", {
    poolId: MarketId,
    side: z.enum(["BUY", "SELL"]).describe("side from the MAKER's perspective for the venue listing"),
    makerAsset: Address,
    takerAsset: Address,
    makingAmount: TokenAmount,
    takingAmount: TokenAmount,
    expirySeconds: z.number().int().min(1).optional().describe("RELATIVE expiry, seconds from now (omit for no expiry)"),
    allowsPartialFills: z.boolean().default(true),
    usePermit2: z.boolean().default(false),
    extension: Hex.optional().describe("raw 1inch LOP v4 extension bytes; when set, the salt is derived to commit to it (OrderLib InvalidExtension check). Mutually exclusive with jitMarket, which BUILDS the extension"),
    jitMarket: z
      .strictObject({
        collateralAsset: Address,
        referenceAsset: Address,
        expiryTimestamp: UnixSeconds.describe("pool expiry — must be in the future at creation"),
        mode: z.string().min(1).describe("registry recipe mode, EXACT case-sensitive string (see cork_query registry-recipes)"),
        swapFeePercentage: UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18 = 5%) — consumed only if this fill creates the pool"),
        unwindSwapFeePercentage: UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18) — creation only"),
        enableJitMint: z.boolean().default(false).describe("maker-side just-in-time mint of the cST being sold, funded by the maker's own collateral; false = market-creation only (maker must already hold the cST)"),
        permits: z
          .array(z.strictObject({ token: Address, value: UintStr, deadline: UnixSeconds, v: z.number().int().min(0).max(255), r: Bytes32, s: Bytes32 }))
          .max(8)
          .optional()
          .describe("pre-signed ERC-2612 permits the adapter executes after the mint (spender is always the LOP) — needed to let the LOP pull a just-created cST; the result reports the predicted cST address to sign the permit over"),
      })
      .optional()
      .describe(
        "attach the Cork JIT adapter as the maker-side preInteraction hook: the fill derives the market from the registry recipe against the LIVE oracle rate, creates the pool if missing, and (if enableJitMint) mints the cST just in time. One order side MUST be the derived pool's cST. Omit entirely for a plain order on an existing pool",
      ),
  }).describe("signable 1inch LOP v4 maker order (typed-data to sign, then cork_submit lop-order); optional jitMarket block attaches just-in-time Cork market creation/minting to the fill"),
  A("taker-fill", { orderHash: Bytes32, fillMakingAmount: TokenAmount.optional() })
    .describe("fill calldata against a resting order (phase-gated: needs the orderbook service)"),
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
    minPremiumPerShare: TokenAmount,
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
    A("deploy-wrapper", { collateralAsset: Address, referenceAsset: Address })
      .describe("unsigned MarketRegistry.deploy(ca, ref) tx: create the pair's rate-oracle wrapper — permissionless and IDEMPOTENT (an existing pair just returns the recorded wrapper). Pair order matters: collateral first"),
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
  minPremiumPerShare: TokenAmount,
  allowPartialFills: z.boolean(),
  allowUnderfill: z.boolean(),
  premiumPaymentMode: z.union([z.literal(0), z.literal(1)]),
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
const QuoteRef = z.strictObject({ rfqId: z.string(), answerId: z.string(), optionId: z.string() });

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
    premium: z.number().describe("PERCENT number for the venue listing (4.1 means 4.1%) — NOT a fraction; 0.041 would be read as 0.041% and trips the premium_scale tripwires"),
    expiry: z.number().int().nonnegative().describe("absolute unix seconds; 0 = no expiry"),
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
      notBefore: z.number().int().describe("earliest acceptable pool expiry, absolute unix seconds"),
      notAfter: z.number().int().describe("latest acceptable pool expiry, absolute unix seconds"),
    }),
    marketTemplate: z.record(z.string(), z.unknown()).optional(),
    notionalAssets: TokenAmount,
    validUntil: z.number().int().describe("RFQ validity cutoff, absolute unix seconds"),
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
