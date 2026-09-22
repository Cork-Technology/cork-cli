// Answering an RFQ with a firm order — the amount math and the defaults the underwriter loop
// applies on every answer, as pure functions so the sugar (`cork_prepare_orders answer-rfq`) and
// its tests share one source with nothing hidden in a handler.
//
// The kernel's convention (the venue's golden-units script and its RFC, "Buyer" section):
//   premium_amount = premium_fraction × notional × tenor_seconds / YEAR   (ACT/365, integer math,
//                    rounded TOWARD THE MAKER — ceil), in the collateral asset's native units;
//   makingAmount   = notional rescaled to the 18-decimal cST;
//   tenor is pinned at signing (pool expiry − now).
// Nothing here chooses a premium: the caller's quote is an input.

import { encodeImpairmentArgs } from "./market-registry.ts";
import { encodeAbiParameters } from "viem";
import { ceilDiv, normalizeDecimals } from "./math/fixed.ts";

/** ACT/365: the year the venue and the kernel divide by. */
export const YEAR_SECONDS = 31_536_000n;
/** cST and cPT are always 18 decimals (protocol invariant, same claim as the compute labels). */
export const SHARE_DECIMALS = 18;
/** The venue's re-rest rule: an answer rests for at most this long … */
export const RE_REST_MAX_SECONDS = 600;
/** … and at least this long, so a lift has a window to land. */
export const RE_REST_MIN_SECONDS = 90;

/** A decimal-fraction string ("0.041") as an exact rational num/den — no float ever touches it. */
export function premiumFraction(premiumAnnualized: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(premiumAnnualized.trim());
  if (!m) throw new Error(`premiumAnnualized must be a decimal-fraction string like "0.041" (got ${JSON.stringify(premiumAnnualized)})`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  return { num: BigInt(whole + frac), den: 10n ** BigInt(frac.length) };
}

/** premium_amount in the collateral asset's native units, rounded toward the maker (ceil). */
export function premiumAmount(premiumAnnualized: string, notionalAssets: bigint, tenorSeconds: bigint): bigint {
  if (notionalAssets <= 0n) throw new Error("notionalAssets must be positive");
  if (tenorSeconds <= 0n) throw new Error("tenorSeconds must be positive — the pool expiry is not in the future");
  const { num, den } = premiumFraction(premiumAnnualized);
  return ceilDiv(num * notionalAssets * tenorSeconds, den * YEAR_SECONDS);
}

/** The cover's makingAmount: the notional in 18-decimal cST shares. */
export function coverMakingAmount(notionalAssets: bigint, collateralDecimals: number): bigint {
  return normalizeDecimals(notionalAssets, collateralDecimals, SHARE_DECIMALS);
}

/** How long a re-rested answer should live: max(90 s, min(10 min, remaining / 2)). */
export function reRestExpirySeconds(remainingSeconds: bigint): number {
  const half = Number(remainingSeconds / 2n);
  return Math.max(RE_REST_MIN_SECONDS, Math.min(RE_REST_MAX_SECONDS, half));
}

/** The group every rung answering one RFQ shares by default: a revision retires the earlier price. */
export function answerOcoGroup(rfqId: string): string {
  return `rfq:${rfqId}`;
}

/** Decode an order's amounts back to the annualized fraction it implies, at 18 decimals (for echo and cross-checks). */
export function impliedPremiumWad(premiumAmountNative: bigint, notionalAssets: bigint, tenorSeconds: bigint): bigint {
  if (notionalAssets <= 0n || tenorSeconds <= 0n) return 0n;
  return (premiumAmountNative * YEAR_SECONDS * 10n ** 18n) / (notionalAssets * tenorSeconds);
}

/** The inline template's `oracle_params` block. The venue types the block as a FREE-FORM bag
 *  (verified against api-phoenix 0.4.3's openapi: `additionalProperties: string | number |
 *  boolean | null`, nothing named), so the schema names below are THIS tool's conventions —
 *  the requester and the answering underwriter agree on them, the venue merely relays them.
 *
 *  `cork-inline-liquidity/1` is the shape the Cork status-page heartbeat RFQs carry: the
 *  requester's anchor rate (the rate it derived its pool with, ABSOLUTE 1e18 = 1.0), the pool
 *  expiry it derived with, and the two creation fees, every value a decimal string.
 *
 *  `cork-inline-impairment/1` adds the ApySpreadImpairmentRecipe's two extra words —
 *  `duration_seconds` (plain seconds, the author's choice; the recipe never checks it against
 *  the expiry) and `apy_spread_percentage` (1e18 = 1%, the PERCENTAGE scale — a 10%/year spread
 *  is "10000000000000000000"). Both are REQUIRED by the recipe's resolve; a block missing either
 *  cannot build the recipe's 96-byte additionalData and reads as incomplete (`complete: false`),
 *  so the caller is told to pass jitMarket.additionalData instead of getting a guessed word.
 *
 *  Every value is read defensively: another schema name, a missing field, or a non-digit value
 *  reads as absent, never as a guess. */
export const INLINE_LIQUIDITY_SCHEMA = "cork-inline-liquidity/1";
export const INLINE_IMPAIRMENT_SCHEMA = "cork-inline-impairment/1";
export const INLINE_TEMPLATE_SCHEMAS = [INLINE_LIQUIDITY_SCHEMA, INLINE_IMPAIRMENT_SCHEMA] as const;
export type InlineTemplateSchema = (typeof INLINE_TEMPLATE_SCHEMAS)[number];
interface InlineCommonParams {
  anchorRate?: bigint;
  expiry?: bigint;
  swapFeeWad?: string;
  unwindSwapFeeWad?: string;
  /** OPTIONAL `oracle_salt` (bytes32 hex) — the salt of the destination pair's FIRST oracle
   *  wrapper on a nested-wire generation (market-registry 0.5.0 `deploy(ca, ref, mode, salt)`;
   *  part of the pool's identity through the oracle address). A requester↔underwriter
   *  convention of OURS on both inline schemas (2026-09-22): the venue stores the bag verbatim
   *  and has no view on it. Absent = the zero salt (the pair's default wrapper); an explicit
   *  `jitMarket.oracleSalt` on the answer wins over it. Read only as a 32-byte hex string. */
  oracleSalt?: `0x${string}`;
}
export interface InlineLiquidityParams extends InlineCommonParams {
  schema: typeof INLINE_LIQUIDITY_SCHEMA;
}
export interface InlineImpairmentParams extends InlineCommonParams {
  schema: typeof INLINE_IMPAIRMENT_SCHEMA;
  durationSeconds?: bigint;
  apySpreadPercentage?: bigint;
}
export type InlineTemplateParams = InlineLiquidityParams | InlineImpairmentParams;
export function inlineParamsOfTemplate(t: unknown): InlineTemplateParams | undefined {
  if (!t || typeof t !== "object") return undefined;
  const inline = (t as { inline?: unknown }).inline;
  const op = inline && typeof inline === "object" ? (inline as { oracle_params?: unknown }).oracle_params : undefined;
  if (!op || typeof op !== "object") return undefined;
  const o = op as Record<string, unknown>;
  if (o.schema !== INLINE_LIQUIDITY_SCHEMA && o.schema !== INLINE_IMPAIRMENT_SCHEMA) return undefined;
  const digits = (v: unknown): string | undefined => {
    const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
    return s !== undefined && /^\d+$/.test(s) ? s : undefined;
  };
  const positive = (v: unknown): bigint | undefined => {
    const d = digits(v);
    return d !== undefined && BigInt(d) > 0n ? BigInt(d) : undefined;
  };
  const bytes32 = (v: unknown): `0x${string}` | undefined => (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as `0x${string}`) : undefined);
  const anchor = positive(o.anchor_rate), expiry = positive(o.expiry), swapFee = digits(o.swap_fee_wad), unwindFee = digits(o.unwind_swap_fee_wad), oracleSalt = bytes32(o.oracle_salt);
  const common: InlineCommonParams = {
    ...(anchor !== undefined ? { anchorRate: anchor } : {}),
    ...(expiry !== undefined ? { expiry } : {}),
    ...(swapFee !== undefined ? { swapFeeWad: swapFee } : {}),
    ...(unwindFee !== undefined ? { unwindSwapFeeWad: unwindFee } : {}),
    ...(oracleSalt !== undefined ? { oracleSalt } : {}),
  };
  if (o.schema === INLINE_IMPAIRMENT_SCHEMA) {
    const durationSeconds = positive(o.duration_seconds), apySpreadPercentage = positive(o.apy_spread_percentage);
    return { schema: INLINE_IMPAIRMENT_SCHEMA, ...common, ...(durationSeconds !== undefined ? { durationSeconds } : {}), ...(apySpreadPercentage !== undefined ? { apySpreadPercentage } : {}) };
  }
  return { schema: INLINE_LIQUIDITY_SCHEMA, ...common };
}

/** The recipe `additionalData` an inline block resolves to, by its schema — or undefined when
 *  the block cannot yield the recipe's payload (liquidity: no anchor; impairment: any of the
 *  three words missing — the recipe's _decode takes exactly 96 bytes, so a partial block is
 *  NOT encoded with zeros: a zero anchor/duration/spread would revert or produce a window the
 *  requester never asked for). */
export function inlineAdditionalData(p: InlineTemplateParams): `0x${string}` | undefined {
  if (p.schema === INLINE_IMPAIRMENT_SCHEMA) {
    if (p.anchorRate === undefined || p.durationSeconds === undefined || p.apySpreadPercentage === undefined) return undefined;
    return encodeImpairmentArgs({ anchorRate: p.anchorRate, durationSeconds: p.durationSeconds, apySpreadPercentage: p.apySpreadPercentage });
  }
  return p.anchorRate !== undefined ? encodeAnchorArgs(p.anchorRate) : undefined;
}

/** The liquidity recipes' `additionalData`: `abi.encode(uint256 anchorRate)`. */
export const encodeAnchorArgs = (anchorRate: bigint): `0x${string}` => encodeAbiParameters([{ type: "uint256" }], [anchorRate]);
