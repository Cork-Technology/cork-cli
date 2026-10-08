// Answering an RFQ with a firm order — the amount math and the defaults the underwriter loop
// applies on every answer, as pure functions so the sugar (`cork_prepare_orders answer-rfq`) and
// its tests share one source with nothing hidden in a handler.
//
// The venue's convention (the venue's golden-units vectors, buyer side):
//   premium_amount = premium_fraction × notional × tenor_seconds / YEAR   (ACT/365, integer math,
//                    rounded TOWARD THE MAKER — ceil), in the collateral asset's native units;
//   makingAmount   = notional rescaled to the 18-decimal cST;
//   tenor is pinned at signing (pool expiry − now).
// Nothing here chooses a premium: the caller's quote is an input.

import { encodeImpairmentArgs } from "./market-registry.ts";
import { encodeAbiParameters } from "viem";
import { ceilDiv, normalizeDecimals } from "./math/fixed.ts";

/** ACT/365: the year the venue divides by. */
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
 *  Since cork-api 0.4.4 the venue DOES name one key in the bag: `rate_override`, required when a
 *  request or an option says `fixed_rate` (see fixedRateOverrideViolation below).
 *
 *  Every value is read defensively: another schema name, a missing field, or a non-digit value
 *  reads as absent, never as a guess. */
export const INLINE_LIQUIDITY_SCHEMA = "cork-inline-liquidity/1";
export const INLINE_IMPAIRMENT_SCHEMA = "cork-inline-impairment/1";
/** `cork-inline-fixed/1` — the block for the FIXED-rate recipe: `rate_override` (the venue's own
 *  key, cork-api 0.4.4) plus the pool expiry and the two creation fees this tool's other blocks
 *  carry. The fixed recipe takes NO recipe bytes: the rate rides as the order's `rateOverride`. */
export const INLINE_FIXED_SCHEMA = "cork-inline-fixed/1";
export const INLINE_TEMPLATE_SCHEMAS = [INLINE_LIQUIDITY_SCHEMA, INLINE_IMPAIRMENT_SCHEMA, INLINE_FIXED_SCHEMA] as const;
export type InlineTemplateSchema = (typeof INLINE_TEMPLATE_SCHEMAS)[number];
interface InlineCommonParams {
  anchorRate?: bigint;
  expiry?: bigint;
  swapFeeWad?: string;
  unwindSwapFeeWad?: string;
  /** OPTIONAL `oracle_salt` (bytes32 hex) — the salt of the destination pair's FIRST oracle
   *  wrapper on a nested-wire generation (market-registry 0.5.0 `deploy(ca, ref, mode, salt)`;
   *  part of the pool's identity through the oracle address). A requester↔underwriter
   *  convention of OURS on the inline schemas (2026-09-22): the venue stores the bag verbatim
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
export interface InlineFixedParams extends InlineCommonParams {
  schema: typeof INLINE_FIXED_SCHEMA;
  /** The frozen rate, ABSOLUTE 1e18 = 1.0 — absent when `rate_override` breaks the venue's rule. */
  rateOverride?: bigint;
}
export type InlineTemplateParams = InlineLiquidityParams | InlineImpairmentParams | InlineFixedParams;

/** `market_template.inline`, or undefined for a template id, no template, or a malformed value.
 *  THE one walk into a template: every reader of `oracle_recipe` / `oracle_params` goes
 *  through here, so they cannot disagree on what counts as an inline template. */
export function inlineOfTemplate(t: unknown): Record<string, unknown> | undefined {
  if (!t || typeof t !== "object") return undefined;
  const inline = (t as { inline?: unknown }).inline;
  return inline && typeof inline === "object" ? (inline as Record<string, unknown>) : undefined;
}

/** `market_template.inline.oracle_params`, or undefined for a template id or a malformed bag. */
export function oracleParamsOf(t: unknown): Record<string, unknown> | undefined {
  const op = inlineOfTemplate(t)?.["oracle_params"];
  return op && typeof op === "object" ? (op as Record<string, unknown>) : undefined;
}

/** `market_template.inline.oracle_recipe` when it is a well-formed address. */
export function recipeAddressOfTemplate(t: unknown): `0x${string}` | undefined {
  const raw = inlineOfTemplate(t)?.["oracle_recipe"];
  return typeof raw === "string" && /^0x[0-9a-fA-F]{40}$/u.test(raw) ? (raw as `0x${string}`) : undefined;
}

/** A value as it reads in a message — JSON where JSON can say it (a bigint cannot). */
const shown = (v: unknown): string => {
  if (typeof v === "bigint") return `${v}n (a bigint)`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

const UINT256_MAX_DECIMAL = (2n ** 256n - 1n).toString();

/** The venue's fixed-rate rule, op for op (cork-api 0.4.4 `FixedRateMarketTemplateSchema`): a
 *  STRING of 1..78 digits with no leading zero, at most uint256 max. A JSON number, a sign, a
 *  fraction, an exponent, hex, zero and an overflow are all refused there with a 400. Returns
 *  the problem in words, or null when the venue admits the value. */
export function fixedRateOverrideViolation(rate: unknown): string | null {
  if (typeof rate !== "string") return `it must be a decimal STRING, got ${rate === undefined ? "nothing" : shown(rate)}`;
  if (!/^[1-9][0-9]{0,77}$/u.test(rate)) return `${shown(rate)} is not a positive decimal integer without a leading zero (no sign, fraction, exponent or hex; zero has no oracle)`;
  // Equal-length decimal strings order the same way their numbers do.
  if (rate.length === 78 && rate > UINT256_MAX_DECIMAL) return `${rate} exceeds uint256`;
  return null;
}

/** The frozen rate a template carries in `inline.oracle_params.rate_override` (ABSOLUTE,
 *  1e18 = 1.0), read under the VENUE's rule — this key is the venue's, so it is read whatever
 *  schema name the block carries. Undefined when absent or inadmissible. */
export function fixedRateOverrideOfTemplate(t: unknown): bigint | undefined {
  const rate = oracleParamsOf(t)?.rate_override;
  return fixedRateOverrideViolation(rate) === null ? BigInt(rate as string) : undefined;
}

export function inlineParamsOfTemplate(t: unknown): InlineTemplateParams | undefined {
  const o = oracleParamsOf(t);
  if (!o) return undefined;
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
  switch (o.schema) {
    case INLINE_IMPAIRMENT_SCHEMA: {
      const durationSeconds = positive(o.duration_seconds), apySpreadPercentage = positive(o.apy_spread_percentage);
      return { schema: INLINE_IMPAIRMENT_SCHEMA, ...common, ...(durationSeconds !== undefined ? { durationSeconds } : {}), ...(apySpreadPercentage !== undefined ? { apySpreadPercentage } : {}) };
    }
    case INLINE_FIXED_SCHEMA: {
      const rateOverride = fixedRateOverrideOfTemplate(t);
      return { schema: INLINE_FIXED_SCHEMA, ...common, ...(rateOverride !== undefined ? { rateOverride } : {}) };
    }
    case INLINE_LIQUIDITY_SCHEMA:
      return { schema: INLINE_LIQUIDITY_SCHEMA, ...common };
    // Any other schema name is a block this tool has no contract for: read as absent.
    default:
      return undefined;
  }
}

/** The recipe bytes (`extraData`) an inline block resolves to, by its schema — or undefined when
 *  the block yields none: liquidity without an anchor; impairment with any of its three words
 *  missing (the recipe's decoder takes exactly 96 bytes, so a partial block is NOT encoded with
 *  zeros: a zero anchor/duration/spread would revert or produce a window the requester never
 *  asked for); and the fixed block ALWAYS — the fixed recipe refuses any payload
 *  (`UnexpectedExtraData`), its rate rides as the order's `rateOverride`. */
export function inlineAdditionalData(p: InlineTemplateParams): `0x${string}` | undefined {
  switch (p.schema) {
    case INLINE_IMPAIRMENT_SCHEMA:
      if (p.anchorRate === undefined || p.durationSeconds === undefined || p.apySpreadPercentage === undefined) return undefined;
      return encodeImpairmentArgs({ anchorRate: p.anchorRate, durationSeconds: p.durationSeconds, apySpreadPercentage: p.apySpreadPercentage });
    case INLINE_FIXED_SCHEMA:
      return undefined;
    case INLINE_LIQUIDITY_SCHEMA:
      return p.anchorRate !== undefined ? encodeAnchorArgs(p.anchorRate) : undefined;
  }
}

/** The liquidity recipes' `additionalData`: `abi.encode(uint256 anchorRate)`. */
export const encodeAnchorArgs = (anchorRate: bigint): `0x${string}` => encodeAbiParameters([{ type: "uint256" }], [anchorRate]);
