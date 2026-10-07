// RFQ v2 quotes carry their order (cork-api 0.4.5 post-answer.schema.ts): a quoted new_position
// option is the exact signed 1inch order the underwriter stands behind, plus the terms a
// requester reads. The order_signature proves only the ORDER; the option's own terms —
// premium, capacity, freshness — are signed by the top-level CorkRfqWrite signature, which the
// venue verifies from cork-api PR #113 onward (older 0.4.5 builds did not). These checks hold
// an option to the order it carries before anything is relayed, so a quote cannot show one
// price and fill at another.

import { premiumAmount, premiumFraction, SHARE_DECIMALS } from "./orders-answer.ts";
import { decodeMakerTraits, type LopOrder } from "./orders.ts";

/** The order fields the venue's OrderStructSchema takes: decimal strings, addresses lowercased
 *  as the venue stores them (an RFQ v2 body is hashed as stored). */
export interface QuotedOrderWire {
  salt: string;
  maker: string;
  receiver: string;
  makerAsset: string;
  takerAsset: string;
  makingAmount: string;
  takingAmount: string;
  makerTraits: string;
}

const ORDER_KEYS = ["salt", "maker", "receiver", "makerAsset", "takerAsset", "makingAmount", "takingAmount", "makerTraits"] as const;
const ADDRESS_KEYS = new Set(["maker", "receiver", "makerAsset", "takerAsset"]);
const UINT256_MAX = (1n << 256n) - 1n;

export function quotedOrderWire(order: LopOrder): QuotedOrderWire {
  return {
    salt: order.salt.toString(),
    maker: order.maker.toLowerCase(),
    receiver: order.receiver.toLowerCase(),
    makerAsset: order.makerAsset.toLowerCase(),
    takerAsset: order.takerAsset.toLowerCase(),
    makingAmount: order.makingAmount.toString(),
    takingAmount: order.takingAmount.toString(),
    makerTraits: order.makerTraits.toString(),
  };
}

/** An option's `order` read the way the venue reads it (strict: the eight fields, nothing else;
 *  amounts positive). */
export function parseQuotedOrder(raw: unknown): { ok: true; order: LopOrder } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "order is not an object" };
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(ORDER_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) return { ok: false, reason: `order carries fields the venue refuses (${extra.join(", ")}) — exactly ${ORDER_KEYS.join(", ")}; the extension rides on the book listing, not on the quote` };
  const out: Record<string, unknown> = {};
  for (const k of ORDER_KEYS) {
    const v = o[k];
    if (typeof v !== "string") return { ok: false, reason: `order.${k} must be a string` };
    if (ADDRESS_KEYS.has(k)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return { ok: false, reason: `order.${k} is not an address` };
      out[k] = v;
    } else {
      if (!/^[0-9]+$/.test(v) || v.length > 78 || BigInt(v) > UINT256_MAX) return { ok: false, reason: `order.${k} must be a uint256 as a decimal string` };
      if ((k === "makingAmount" || k === "takingAmount") && BigInt(v) === 0n) return { ok: false, reason: `order.${k} must be positive` };
      out[k] = BigInt(v);
    }
  }
  return { ok: true, order: out as unknown as LopOrder };
}

/** How far a quote's premium may sit from what its order's amounts imply: the order was priced
 *  when it was signed, and the tenor has shrunk since. */
export const QUOTE_PREMIUM_TOLERANCE_PERCENT = 1n;
/** The oldest signing time the premium check allows for. */
export const QUOTE_MAX_SIGNING_AGE_SECONDS = 86_400n;

/**
 * One quoted option held to the order it carries. A cover quote SELLS cST for the collateral:
 * the order takes the option's collateral, sells no more cover than the option's capacity, and
 * its amounts imply the option's premium. The option's freshness cannot outlive its order.
 * `collateralDecimals` undefined = the amounts could not be compared (said in `notChecked`).
 * Returns the refusal text, or the list of what could not be checked.
 */
export function quotedOptionTermsViolation(a: { index: number; option: Record<string, unknown>; order: LopOrder; nowSeconds: bigint; collateralDecimals: number | undefined }): { violation: string } | { violation: null; notChecked: string[] } {
  const { index: i, option, order } = a;
  const notChecked = ["the pool the order's extension creates (reference asset, pool expiry): the quote carries the order without its extension, so only the book listing can show it"];
  const collateral = option.collateral_asset;
  if (typeof collateral !== "string" || collateral.toLowerCase() !== order.takerAsset.toLowerCase()) {
    return { violation: `options[${i}] quotes collateral ${String(collateral)}, but its order takes ${order.takerAsset} — a cover quote sells cST for the premium in the option's own collateral` };
  }
  const orderExpiry = decodeMakerTraits(order.makerTraits).expiry;
  if (orderExpiry !== 0n && orderExpiry <= a.nowSeconds) {
    return { violation: `options[${i}].order expired at ${orderExpiry} (now ${a.nowSeconds}) — a quote whose order is already dead cannot be filled; build a fresh order` };
  }
  const freshUntil = option.fresh_until;
  if (orderExpiry !== 0n && typeof freshUntil === "number" && BigInt(freshUntil) > orderExpiry) {
    return { violation: `options[${i}].fresh_until ${freshUntil} is after its order's expiry ${orderExpiry} — the quote would read fresh while its order can no longer fill; set fresh_until to ${orderExpiry} or earlier` };
  }
  if (a.collateralDecimals === undefined) {
    notChecked.push("the premium and the capacity against the order's amounts: the collateral's decimals were not read (no RPC)");
    return { violation: null, notChecked };
  }
  const dec = a.collateralDecimals;
  const notional = dec <= SHARE_DECIMALS ? order.makingAmount / 10n ** BigInt(SHARE_DECIMALS - dec) : order.makingAmount * 10n ** BigInt(dec - SHARE_DECIMALS);
  const capacity = option.notional_max_assets;
  if (typeof capacity === "string" && /^[0-9]+$/.test(capacity) && notional > BigInt(capacity)) {
    return { violation: `options[${i}].order sells cover on ${notional} collateral units, more than the option's notional_max_assets ${capacity} — the quote must state the capacity its order fills` };
  }
  const premium = option.premium_annualized;
  const poolExpiry = option.expiry;
  if (typeof premium !== "string" || typeof poolExpiry !== "number") return { violation: null, notChecked };
  try {
    premiumFraction(premium);
  } catch {
    return { violation: null, notChecked };
  }
  const tenor = BigInt(poolExpiry) - a.nowSeconds;
  if (tenor <= 0n) return { violation: `options[${i}].expiry ${poolExpiry} is not in the future (now ${a.nowSeconds}) — a cover with no tenor has no premium` };
  if (notional === 0n) return { violation: null, notChecked };
  const low = premiumAmount(premium, notional, tenor);
  const high = premiumAmount(premium, notional, tenor + QUOTE_MAX_SIGNING_AGE_SECONDS);
  const t = order.takingAmount;
  if (t * 100n < low * (100n - QUOTE_PREMIUM_TOLERANCE_PERCENT) || t * 100n > high * (100n + QUOTE_PREMIUM_TOLERANCE_PERCENT)) {
    return { violation: `options[${i}] quotes premium_annualized ${premium}, but its order takes ${t} collateral units for ${notional} of cover to expiry ${poolExpiry} — that premium means ${low}..${high} (signed now .. a day ago); the quote must show the price its order fills at (within ${QUOTE_PREMIUM_TOLERANCE_PERCENT}%)` };
  }
  return { violation: null, notChecked };
}
