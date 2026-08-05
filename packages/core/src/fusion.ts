// 1inch Fusion dutch-auction decode + pricing (v3.1 layout), pure and offline. The price of a
// Fusion order is a deterministic function of (extension bytes, taker, basefee, timestamp) — this
// module reconstructs everything from the ORDER'S OWN BYTES [K3] and reimplements the deployed
// SimpleSettlement pricing chain bit-exactly.
//
// Ground truth: fusion-protocol @ v3.1.2 (SimpleSettlement.sol) + LOP 4.3.2 extensions
// (AmountGetterWithFee/AmountGetterBase), byte layouts documented in
// notes/research/fusion-dutch-auction.md §3. Empirically proven 10/10 WEI-EXACT against the
// DEPLOYED getters on mainnet + Arbitrum via eth_call (experiments/fusion-spike/probe.ts,
// 2026-07-28) — both rounding directions, interpolation, fee/whitelist-discount, boundaries.
// Known deployed-getter gotchas carried from the spike: the on-chain selectors use the
// all-uint256 Order tuple, and public-node eth_call runs with block.basefee = 0.
import { concatHex, keccak256, size, sliceHex, toHex } from "viem";
import bundledDefaults from "../../../cork-defaults.json" with { type: "json" };
import { decodeExtensionFields, type LopExtensionFields, type LopOrder } from "./orders.ts";

type Hex = `0x${string}`;

/** Classification reference set (cork-defaults.json). The ACTIVE settlement is always decoded
 *  from the order's extension — this set only says which layout/deployment it is. */
export const FUSION_SETTLEMENTS: Record<number, { current: Hex; legacy: Hex[] }> = Object.fromEntries(
  Object.entries((bundledDefaults as { fusionSettlements?: Record<string, { current: Hex; legacy?: Hex[] }> }).fusionSettlements ?? {}).map(
    ([k, v]) => [Number(k), { current: v.current, legacy: v.legacy ?? [] }],
  ),
);

export type SettlementClass = "current" | "legacy" | "unknown";
export function classifySettlement(address: string, chainId: number): SettlementClass {
  const set = FUSION_SETTLEMENTS[chainId];
  const a = address.toLowerCase();
  if (set?.current.toLowerCase() === a) return "current";
  if (set?.legacy.some((l) => l.toLowerCase() === a)) return "legacy";
  // Cross-chain fallback: the v3.1/v2 deployments are CREATE3-same-address, so classify against
  // any configured chain before declaring unknown (a chain we lack config for, not a new layout).
  for (const s of Object.values(FUSION_SETTLEMENTS)) {
    if (s.current.toLowerCase() === a) return "current";
    if (s.legacy.some((l) => l.toLowerCase() === a)) return "legacy";
  }
  return "unknown";
}

// ── pricing constants (SimpleSettlement / AmountGetterWithFee) ───────────────────────────────
export const FUSION_BASE_POINTS = 10_000_000n; // rate-bump base: 1e7 = 100%
export const FUSION_GAS_PRICE_BASE = 1_000_000n; // gasPriceEstimate unit: 1000 = 1 gwei
export const FUSION_FEE_BASE = 100_000n; // fee base: 1e5

export interface FusionAuction {
  gasBumpEstimate: bigint; // uint24, 1e7 base
  gasPriceEstimate: bigint; // uint32, 1000 = 1 gwei
  startTime: bigint; // uint32, unix seconds
  duration: bigint; // uint24, seconds
  initialRateBump: bigint; // uint24, 1e7 base
  points: Array<{ rateBump: bigint; timeDelta: bigint }>; // uint24 ‖ uint16 (cumulative deltas)
}

export interface FusionGetterFees {
  integratorFee: bigint; // uint16, 1e5 base
  integratorShare: bigint; // uint8, 1e2 base
  resolverFee: bigint; // uint16, 1e5 base
  whitelistDiscountNumerator: bigint; // uint8, 1e2 base
  /** Low-10-byte halves of whitelisted resolver addresses (getter-side list, no time deltas). */
  whitelist: Hex[];
}

export interface FusionPostInteraction {
  integratorFeeRecipient: Hex;
  protocolFeeRecipient: Hex;
  customReceiver: Hex | null;
  integratorFee: bigint;
  integratorShare: bigint;
  resolverFee: bigint;
  whitelistDiscountNumerator: bigint;
  /** Fill gating: nobody may fill before this moment. */
  resolvingStartTime: bigint;
  /** Cascade entries: entry i becomes eligible at resolvingStartTime + Σ delta[0..i]. */
  whitelist: Array<{ addressHalf: Hex; timeDelta: bigint }>;
  /** Everyone (with the access token) may fill from this moment. */
  publicFillTime: bigint;
  estimatedTakingAmount: bigint;
  surplusFeePercent: bigint; // uint8, 1e2 base
  extraInteractionTarget: Hex | null;
}

const hx = (data: Hex, from: number, to: number): Hex => sliceHex(data, from, to);
const num = (data: Hex, from: number, to: number): bigint => BigInt(hx(data, from, to));

function need(data: Hex, bytes: number, what: string): void {
  if (size(data) < bytes) {
    throw new Error(`Fusion ${what}: needs ${bytes} bytes, got ${size(data)} — truncated or not a v3.1 layout`);
  }
}

/** Parse the amount-getter extraData (what follows the 20-byte settlement address in
 *  makingAmountData): AuctionDetails ‖ fee section ‖ getter whitelist. Rejects a non-empty tail —
 *  a real v3 Fusion order leaves none (a ≥20-byte tail would delegate to ANOTHER getter, which
 *  changes the price and must not be silently ignored). */
export function parseAuctionGetterData(extraData: Hex): { auction: FusionAuction; fees: FusionGetterFees } {
  need(extraData, 18, "auction header");
  const auction: FusionAuction = {
    gasBumpEstimate: num(extraData, 0, 3),
    gasPriceEstimate: num(extraData, 3, 7),
    startTime: num(extraData, 7, 11),
    duration: num(extraData, 11, 14),
    initialRateBump: num(extraData, 14, 17),
    points: [],
  };
  const n = Number(num(extraData, 17, 18));
  need(extraData, 18 + 5 * n, `auction points (count ${n})`);
  for (let i = 0; i < n; i++) {
    const off = 18 + 5 * i;
    auction.points.push({ rateBump: num(extraData, off, off + 3), timeDelta: num(extraData, off + 3, off + 5) });
  }
  const feeOff = 18 + 5 * n;
  need(extraData, feeOff + 7, "getter fee section");
  const whitelistSize = Number(num(extraData, feeOff + 6, feeOff + 7));
  need(extraData, feeOff + 7 + 10 * whitelistSize, `getter whitelist (${whitelistSize} entries)`);
  const whitelist: Hex[] = [];
  for (let i = 0; i < whitelistSize; i++) {
    const off = feeOff + 7 + 10 * i;
    whitelist.push(hx(extraData, off, off + 10));
  }
  const end = feeOff + 7 + 10 * whitelistSize;
  if (size(extraData) > end) {
    throw new Error(`Fusion getter data: ${size(extraData) - end} unexpected trailing byte(s) after the whitelist — a >=20-byte tail delegates to another amount getter, which this pricer refuses to guess about`);
  }
  return {
    auction,
    fees: {
      integratorFee: num(extraData, feeOff, feeOff + 2),
      integratorShare: num(extraData, feeOff + 2, feeOff + 3),
      resolverFee: num(extraData, feeOff + 3, feeOff + 5),
      whitelistDiscountNumerator: num(extraData, feeOff + 5, feeOff + 6),
      whitelist,
    },
  };
}

// ── auction ENCODE (the build side of F2: Cork-native decaying-premium orders) ───────────────

function fit(value: bigint, bytes: number, what: string): Hex {
  if (value < 0n) throw new Error(`Fusion ${what}: negative values cannot be encoded`);
  const max = (1n << BigInt(8 * bytes)) - 1n;
  if (value > max) throw new Error(`Fusion ${what}: ${value} does not fit ${bytes} byte(s) (max ${max}) — the v3.1 layout is fixed-width`);
  return toHex(value, { size: bytes });
}

/** Encode the amount-getter extraData — the exact inverse of parseAuctionGetterData, with the
 *  fee section ZEROED and the getter whitelist EMPTY (the Cork-native shape: L1+L2 only, any
 *  taker fills at the decayed price through the plain LOP fill path; §2.4 of the fusion plan
 *  proved the deployed getters answer standalone with exactly this shape). Field widths are the
 *  v3.1 layout's — over-wide values throw with the width named, never truncate. */
export function encodeAuctionGetterData(a: FusionAuction): Hex {
  if (a.points.length > 255) throw new Error(`Fusion auction: ${a.points.length} points do not fit the 1-byte count (max 255)`);
  if (a.duration === 0n) throw new Error("Fusion auction: zero duration — the price would be at the floor from the first block; use a plain order instead");
  const parts: Hex[] = [
    fit(a.gasBumpEstimate, 3, "gasBumpEstimate"),
    fit(a.gasPriceEstimate, 4, "gasPriceEstimate"),
    fit(a.startTime, 4, "startTime"),
    fit(a.duration, 3, "duration"),
    fit(a.initialRateBump, 3, "initialRateBump"),
    fit(BigInt(a.points.length), 1, "point count"),
  ];
  let cumulative = 0n;
  for (const [i, p] of a.points.entries()) {
    if (p.rateBump > a.initialRateBump) throw new Error(`Fusion auction point ${i}: rateBump ${p.rateBump} exceeds initialRateBump ${a.initialRateBump} — the curve must decay (the getters interpolate DOWN between points)`);
    parts.push(fit(p.rateBump, 3, `point ${i} rateBump`), fit(p.timeDelta, 2, `point ${i} timeDelta`));
    cumulative += p.timeDelta;
  }
  if (cumulative > a.duration) throw new Error(`Fusion auction: point timeDeltas sum to ${cumulative}s, past the ${a.duration}s duration — the tail would never be reached`);
  parts.push(toHex(0n, { size: 7 })); // zeroed fee section: integratorFee(2) integratorShare(1) resolverFee(2) whitelistDiscount(1) whitelistSize(1)
  return concatHex(parts);
}

/** The two amount-getter extension fields of a Cork-native auction order: the CURRENT Fusion
 *  settlement (used purely as an amount getter — no postInteraction, so fills stay
 *  permissionless) followed by the auction blob; taking == making byte-for-byte (the fusion-sdk
 *  invariant decodeFusionOrder enforces). */
export function buildAuctionAmountData(chainId: number, auction: FusionAuction): { makingAmountData: Hex; takingAmountData: Hex; settlement: Hex } {
  const settlement = FUSION_SETTLEMENTS[chainId]?.current;
  if (!settlement) throw new Error(`no known Fusion settlement (amount getter) for chainId ${chainId} — cork-defaults.json fusionSettlements has no entry`);
  const data = concatHex([settlement, encodeAuctionGetterData(auction)]);
  return { makingAmountData: data, takingAmountData: data, settlement };
}

/** Parse the post-interaction extraData (after the 20-byte settlement address): fee recipients,
 *  resolving window, whitelist time cascade, surplus baseline (research note §3.5 / FeeTaker +
 *  SimpleSettlement sources). */
export function parsePostInteractionData(data: Hex): FusionPostInteraction {
  need(data, 1, "post-interaction flags");
  const flags = Number(num(data, 0, 1));
  const hasReceiver = (flags & 1) !== 0;
  let off = 1;
  need(data, off + 40 + (hasReceiver ? 20 : 0), "post-interaction recipients");
  const integratorFeeRecipient = hx(data, off, off + 20);
  const protocolFeeRecipient = hx(data, off + 20, off + 40);
  off += 40;
  const customReceiver = hasReceiver ? hx(data, off, off + 20) : null;
  if (hasReceiver) off += 20;
  need(data, off + 6 + 4 + 1, "post-interaction fees + resolving window");
  const integratorFee = num(data, off, off + 2);
  const integratorShare = num(data, off + 2, off + 3);
  const resolverFee = num(data, off + 3, off + 5);
  const whitelistDiscountNumerator = num(data, off + 5, off + 6);
  off += 6;
  const resolvingStartTime = num(data, off, off + 4);
  off += 4;
  const whitelistSize = Number(num(data, off, off + 1));
  off += 1;
  need(data, off + 12 * whitelistSize + 33, `post-interaction whitelist (${whitelistSize} entries) + surplus`);
  const whitelist: FusionPostInteraction["whitelist"] = [];
  let publicFillTime = resolvingStartTime;
  for (let i = 0; i < whitelistSize; i++) {
    const delta = num(data, off + 10, off + 12);
    whitelist.push({ addressHalf: hx(data, off, off + 10), timeDelta: delta });
    publicFillTime += delta;
    off += 12;
  }
  const estimatedTakingAmount = num(data, off, off + 32);
  const surplusFeePercent = num(data, off + 32, off + 33);
  off += 33;
  const rest = size(data) - off;
  const extraInteractionTarget = rest >= 20 ? hx(data, off, off + 20) : null;
  return {
    integratorFeeRecipient,
    protocolFeeRecipient,
    customReceiver,
    integratorFee,
    integratorShare,
    resolverFee,
    whitelistDiscountNumerator,
    resolvingStartTime,
    whitelist,
    publicFillTime,
    estimatedTakingAmount,
    surplusFeePercent,
    extraInteractionTarget,
  };
}

// ── the pricing chain (proven wei-exact vs the deployed getters) ─────────────────────────────

export interface RateBumpParts {
  auctionBump: bigint;
  gasBump: bigint;
  /** max(auctionBump - gasBump, 0) — the bump the getters apply. */
  effective: bigint;
}

/** SimpleSettlement._getRateBump/_getAuctionBump, verbatim integer semantics. baseFeeWei null ⇒
 *  gas bump skipped (matches AuctionCalculator.calcRateBump(time, 0n)) ⇒ UPPER-BOUND price. */
export function fusionRateBump(a: FusionAuction, timestamp: bigint, baseFeeWei: bigint | null): RateBumpParts {
  const gasBump =
    baseFeeWei === null || a.gasBumpEstimate === 0n || a.gasPriceEstimate === 0n
      ? 0n
      : (a.gasBumpEstimate * baseFeeWei) / a.gasPriceEstimate / FUSION_GAS_PRICE_BASE;
  const finish = a.startTime + a.duration;
  let auctionBump: bigint;
  if (timestamp <= a.startTime) auctionBump = a.initialRateBump;
  else if (timestamp >= finish) auctionBump = 0n;
  else {
    let currentTime = a.startTime;
    let currentBump = a.initialRateBump;
    auctionBump = -1n;
    for (const p of a.points) {
      const nextTime = currentTime + p.timeDelta;
      if (timestamp <= nextTime) {
        auctionBump = ((timestamp - currentTime) * p.rateBump + (nextTime - timestamp) * currentBump) / (nextTime - currentTime);
        break;
      }
      currentBump = p.rateBump;
      currentTime = nextTime;
    }
    if (auctionBump === -1n) auctionBump = ((finish - timestamp) * currentBump) / (finish - currentTime);
  }
  return { auctionBump, gasBump, effective: auctionBump > gasBump ? auctionBump - gasBump : 0n };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Taker-side cost for a requested makingAmount: linear base (ceil) → fee markup (ceil) → rate
 *  bump (ceil) — the exact nesting of AmountGetterBase → AmountGetterWithFee → SimpleSettlement. */
export function fusionTakerPays(M: bigint, T: bigint, makingAmount: bigint, totalFee: bigint, bump: bigint): bigint {
  const linear = ceilDiv(T * makingAmount, M);
  const withFee = ceilDiv(linear * (FUSION_FEE_BASE + totalFee), FUSION_FEE_BASE);
  return ceilDiv(withFee * (FUSION_BASE_POINTS + bump), FUSION_BASE_POINTS);
}

/** Maker-side give for a requested takingAmount: floor at every step, same nesting. */
export function fusionMakerGives(M: bigint, T: bigint, takingAmount: bigint, totalFee: bigint, bump: bigint): bigint {
  const linear = (M * takingAmount) / T;
  const withFee = (linear * FUSION_FEE_BASE) / (FUSION_FEE_BASE + totalFee);
  return (withFee * FUSION_BASE_POINTS) / (FUSION_BASE_POINTS + bump);
}

/** Total getter-side fee (1e5 base) for a taker class: resolver fee is discounted for getter-
 *  whitelisted takers (AmountGetterWithFee._parseFeeData). */
export function fusionTotalFee(fees: FusionGetterFees, takerWhitelisted: boolean): bigint {
  const resolver = takerWhitelisted ? (fees.resolverFee * fees.whitelistDiscountNumerator) / 100n : fees.resolverFee;
  return fees.integratorFee + resolver;
}

export function isGetterWhitelisted(fees: FusionGetterFees, taker: string): boolean {
  const half = taker.toLowerCase().slice(-20);
  return fees.whitelist.some((w) => w.toLowerCase().slice(2) === half);
}

// ── whole-order decode [K3] ──────────────────────────────────────────────────────────────────

const U160 = (1n << 160n) - 1n;

export interface DecodedFusionOrder {
  settlement: Hex;
  classification: SettlementClass;
  auction: FusionAuction;
  fees: FusionGetterFees;
  /** null when the order carries no post-interaction pointed at the settlement (e.g. a
   *  Cork-native auction order using only the amount getters — permissionless fills). */
  postInteraction: FusionPostInteraction | null;
  extensionFields: LopExtensionFields;
  saltBoundToExtension: boolean;
}

export class NotAFusionOrder extends Error {}

/**
 * Reconstruct the Fusion content of (order, extension) from the raw bytes. Structural rules
 * (fusion-sdk's own invariants): makingAmountData is 20-byte getter address + auction data;
 * takingAmountData must equal it byte-for-byte; a post-interaction pointed at the same address is
 * parsed for fill-gating, any other target is left unparsed. Throws NotAFusionOrder with a
 * specific reason when the shape is not a Fusion order at all.
 */
export function decodeFusionOrder(order: LopOrder, extension: Hex, chainId: number): DecodedFusionOrder {
  if (extension === "0x" || size(extension) === 0) {
    throw new NotAFusionOrder("the order has no extension — a Fusion order's auction lives in extension.makingAmountData");
  }
  const fields = decodeExtensionFields(extension);
  if (size(fields.makingAmountData) < 20) {
    throw new NotAFusionOrder("extension.makingAmountData carries no 20-byte amount-getter address — not an auction-priced order");
  }
  if (fields.takingAmountData.toLowerCase() !== fields.makingAmountData.toLowerCase()) {
    throw new NotAFusionOrder("takingAmountData differs from makingAmountData — Fusion orders use one settlement + one auction blob for both directions (fusion-sdk invariant)");
  }
  const settlement = sliceHex(fields.makingAmountData, 0, 20);
  const classification = classifySettlement(settlement, chainId);
  if (classification === "legacy") {
    throw new NotAFusionOrder(`settlement ${settlement} is a LEGACY Fusion deployment (v2/v1 layouts, superseded by v3.1 in May 2025) — only the v3.1 layout is implemented; flag it if you hold a LIVE legacy order`);
  }
  const { auction, fees } = parseAuctionGetterData(size(fields.makingAmountData) > 20 ? sliceHex(fields.makingAmountData, 20) : "0x");
  let postInteraction: FusionPostInteraction | null = null;
  if (size(fields.postInteractionData) >= 20 && sliceHex(fields.postInteractionData, 0, 20).toLowerCase() === settlement.toLowerCase()) {
    postInteraction = parsePostInteractionData(size(fields.postInteractionData) > 20 ? sliceHex(fields.postInteractionData, 20) : "0x");
  }
  return {
    settlement,
    classification,
    auction,
    fees,
    postInteraction,
    extensionFields: fields,
    saltBoundToExtension: (order.salt & U160) === (BigInt(keccak256(extension)) & U160),
  };
}
