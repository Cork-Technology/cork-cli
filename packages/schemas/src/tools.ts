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
  UintStr,
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
  resource: z.enum([
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
  ]),
  chainId: ChainId.optional(),
  mode: DataMode.optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().min(1).max(200).default(25),
  format: Format,
});
export type QueryInput = z.infer<typeof QueryInput>;

// ────────────────────────────────────────────────────────────────────────────
// 2. cork_compute (R2) — closed per-kind params
// ────────────────────────────────────────────────────────────────────────────
const AtPin = z
  .object({ block: UintStr.optional(), timestamp: UintStr.optional() })
  .strict();

export const ComputeParams = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cst-swap-rate"),
      poolId: MarketId,
      collateralAssetsOut: UintStr,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unwind-rate"),
      poolId: MarketId,
      collateralAssetsIn: UintStr,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dutch-auction-price"),
      order: z.record(z.string(), z.unknown()),
      baseFeeWei: UintStr.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rollover-premium-floor"),
      dstCstProduced: UintStr,
      minPremiumPerShare: UintStr,
    })
    .strict(),
  z
    .object({
      kind: z.literal("impairment-floor"),
      poolId: MarketId,
      horizonSeconds: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rfq-quote"),
      marketTypeBucket: z.string(),
      durationSeconds: z.number().int().min(0),
      tokenRiskStats: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
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
  kind: z.enum(["calldata", "order", "event", "receipt"]),
  data: z.union([Hex, z.record(z.string(), z.unknown())]),
  chainId: ChainId.optional(),
  format: Format,
});
export type DecodeInput = z.infer<typeof DecodeInput>;

// ────────────────────────────────────────────────────────────────────────────
// 4. cork_prepare_phoenix (R4) — 13 adapter actions + 2 authority variants
// ────────────────────────────────────────────────────────────────────────────
const A = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ type: z.literal(t), ...shape }).strict();

export const PhoenixAction = z.discriminatedUnion("type", [
  A("mint", {
    poolId: MarketId,
    cptAndCstSharesOut: UintStr,
    receiver: Address,
    maxCollateralAssetsIn: UintStr,
  }),
  A("deposit", {
    poolId: MarketId,
    collateralAssetsIn: UintStr,
    receiver: Address,
    minCptAndCstSharesOut: UintStr,
  }),
  A("unwind-deposit", {
    poolId: MarketId,
    collateralAssetsOut: UintStr,
    owner: Address,
    receiver: Address,
    maxCptAndCstSharesIn: UintStr,
  }),
  A("unwind-mint", {
    poolId: MarketId,
    cptAndCstSharesIn: UintStr,
    owner: Address,
    receiver: Address,
    minCollateralAssetsOut: UintStr,
  }),
  A("withdraw", {
    poolId: MarketId,
    collateralAssetsOut: UintStr,
    owner: Address,
    receiver: Address,
    maxCptSharesIn: UintStr,
  }),
  A("withdraw-other", {
    poolId: MarketId,
    referenceAssetsOut: UintStr,
    owner: Address,
    receiver: Address,
    maxCptSharesIn: UintStr,
  }),
  A("redeem", {
    poolId: MarketId,
    cptSharesIn: UintStr,
    owner: Address,
    receiver: Address,
    minReferenceAssetsOut: UintStr,
    minCollateralAssetsOut: UintStr,
  }),
  A("swap", {
    poolId: MarketId,
    collateralAssetsOut: UintStr,
    receiver: Address,
    maxCstSharesIn: UintStr,
    maxReferenceAssetsIn: UintStr,
  }),
  A("exercise", {
    poolId: MarketId,
    cstSharesIn: UintStr,
    receiver: Address,
    minCollateralAssetsOut: UintStr,
    maxReferenceAssetsIn: UintStr,
  }),
  A("exercise-other", {
    poolId: MarketId,
    referenceAssetsIn: UintStr,
    receiver: Address,
    minCollateralAssetsOut: UintStr,
    maxCstSharesIn: UintStr,
  }),
  A("unwind-swap", {
    poolId: MarketId,
    collateralAssetsIn: UintStr,
    receiver: Address,
    minReferenceAssetsOut: UintStr,
    minCstSharesOut: UintStr,
  }),
  A("unwind-exercise", {
    poolId: MarketId,
    cstSharesOut: UintStr,
    receiver: Address,
    minReferenceAssetsOut: UintStr,
    maxCollateralAssetsIn: UintStr,
  }),
  A("unwind-exercise-other", {
    poolId: MarketId,
    referenceAssetsOut: UintStr,
    receiver: Address,
    minCstSharesOut: UintStr,
    maxCollateralAssetsIn: UintStr,
  }),
  A("authority-onboard", {
    token: Address,
    spender: Address,
    amount: UintStr.optional(),
  }),
  A("authority-revoke", { token: Address, spender: Address }),
]);
export type PhoenixAction = z.infer<typeof PhoenixAction>;

export const PreparePhoenixInput = z.object({
  chainId: ChainId,
  account: Address,
  clientRequestId: ClientRequestId,
  fundingMode: z
    .enum(["permit2", "erc20-approve", "pre-funded"])
    .default("permit2"),
  deadlineSeconds: z.number().int().min(1).max(86400).default(1800),
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
    side: z.enum(["BUY", "SELL"]),
    makerAsset: Address,
    takerAsset: Address,
    makingAmount: UintStr,
    takingAmount: UintStr,
    expirySeconds: z.number().int().min(1).optional(),
    allowsPartialFills: z.boolean().default(true),
    usePermit2: z.boolean().default(false),
  }),
  A("taker-fill", { orderHash: Bytes32, fillMakingAmount: UintStr.optional() }),
  A("cancel", { orderHash: Bytes32, makerTraits: UintStr }),
  A("rollover-intent", {
    settler: Address,
    rolloverContract: Address,
    srcPoolId: MarketId,
    dstPoolId: MarketId,
    srcCstToken: Address,
    dstCstToken: Address,
    premiumToken: Address,
    orderSize: UintStr,
    minPremiumPerShare: UintStr,
    openDeadline: UintStr,
    fillDeadline: UintStr,
    minCaReceived: UintStr.optional(),
    minSharesOut: UintStr.optional(),
    allowPartialFills: z.boolean().default(false),
    premiumPaymentMode: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
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
    A("deploy-wrapper", { collateralAsset: Address, referenceAsset: Address }),
  ]),
  format: Format,
});
export type PrepareMarketInput = z.infer<typeof PrepareMarketInput>;

// ────────────────────────────────────────────────────────────────────────────
// 7. cork_track (R5)
// ────────────────────────────────────────────────────────────────────────────
export const TrackSubject = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("artifact"),
      artifact: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ kind: z.literal("txHash"), txHash: Bytes32 }).strict(),
  z.object({ kind: z.literal("orderHash"), orderHash: Bytes32 }).strict(),
  z.object({ kind: z.literal("marketRef"), poolId: MarketId }).strict(),
  z
    .object({ kind: z.literal("submissionRef"), submissionRef: z.string() })
    .strict(),
]);
export type TrackSubject = z.infer<typeof TrackSubject>;

export const TrackInput = z.object({
  mode: z.enum(["verify", "simulate", "reconcile"]),
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
// 9. cork_submit (R5 submission — the only side-effecting tool)
// ────────────────────────────────────────────────────────────────────────────
export const SubmitInput = z.object({
  signedOrder: z.record(z.string(), z.unknown()),
  signature: Hex,
  chainId: ChainId,
  clientRequestId: ClientRequestId,
});
export type SubmitInput = z.infer<typeof SubmitInput>;
