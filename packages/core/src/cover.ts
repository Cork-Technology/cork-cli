// WHICH COVER A cST IS — decided by the market's RECIPE, never by the venue's RFQ `mode`.
//
// A Cork pool lets the cST holder swap the reference asset for collateral at the pool's rate.
// What that is worth after a loss in the reference depends on ONE thing: how far the pool's rate
// may follow the rate oracle down. The recipe fixes that at creation (it resolves the four rate
// limits the pool is born with), so the recipe — not the label on the request — is the cover:
//
//   liquidity   the window is 1 wei .. 2x the anchor and the rate may move a whole anchor a day:
//               the rate FOLLOWS the oracle. A loss in the reference lowers the rate with it, so
//               the holder hands in more reference for the same collateral and the cover pays
//               nothing for the loss. It pays only when the reference cannot be sold or redeemed
//               at the oracle's rate elsewhere (an exit, not protection).
//   impairment  the window is the anchor ± apySpread × duration / 365 d, the rate moves one day of
//               that spread per day (seven days of it in a burst): the rate is HELD near the
//               anchor. A loss beyond the band is paid by the cover; the band is the deductible.
//   fixed-rate  the rate is an immutable FixedRateOracle and never moves: every loss below it is
//               paid; the reference's yield after creation is not tracked.
//
// Measured on a Base fork against the phoenix/v0.4-rc.1 contracts (2026-10-01,
// experiments/fork-harness/script/cover-types-rehearsal.ts): two pools over USDC / baseUSD, same
// expiry, same NAV oracle; the reference vault takes a real 10% loss; 100 cST exercised on each.
// The liquidity cover paid 0.000000 USDC. The impairment cover (10%/yr over 14.5 days, a 0.397%
// band) paid 9.826589 USDC.
//
// The venue's RFQ `modes` (liquidity_only | liquidity_impairment) are PRICING labels an
// underwriter's model reads; the venue never interprets them and nothing on chain reads them. An
// RFQ whose mode says impairment and whose template names a liquidity recipe is priced as
// downside cover and creates an exit-only pool — the mismatch this module names before relay.
import { INLINE_IMPAIRMENT_SCHEMA, INLINE_LIQUIDITY_SCHEMA, inlineParamsOfTemplate, YEAR_SECONDS } from "./orders-answer.ts";

export const COVER_KINDS = ["liquidity", "impairment", "fixed-rate"] as const;
export type CoverKind = (typeof COVER_KINDS)[number];

/** The names to say. Liquidity cover answers DURATION risk (you cannot sell or redeem the
 *  reference at its book value in time); impairment cover answers CREDIT risk (the reference
 *  loses value). */
export const COVER_LABELS: Record<CoverKind, string> = {
  liquidity: "liquidity (duration-risk) cover",
  impairment: "impairment (credit-risk) cover",
  "fixed-rate": "fixed-rate cover",
};

/** One plain sentence per kind: what the holder is protected against. Every kind but
 *  fixed-rate reads the rate oracle, so "a loss" means a loss the oracle REPORTS — a vault that
 *  keeps bad debt out of its share price (chain/nav-loss.ts) moves no rate. */
export const COVER_PROTECTION: Record<CoverKind, string> = {
  liquidity:
    "duration-risk cover — an EXIT at the oracle's rate, not credit protection: the pool rate follows the reference's NAV or price, so a loss the oracle reports lowers the rate with it and this cover pays nothing for that loss; it pays only when the reference cannot be sold or redeemed at the oracle's rate elsewhere",
  impairment:
    "credit-risk cover — DOWNSIDE protection with a deductible: the pool rate is held inside a band around the rate at creation, so a loss the oracle reports beyond the band is paid by the cover",
  "fixed-rate":
    "DOWNSIDE protection at a frozen rate: the pool rate is an immutable rate fixed at creation, so every loss in the reference below it is paid by the cover; the reference's yield after creation is not tracked",
};

/** The venue's two RFQ modes and the cover kind each one is the pricing label for. */
export const RFQ_MODE_COVER = { liquidity_only: "liquidity", liquidity_impairment: "impairment" } as const satisfies Record<string, CoverKind>;
export type RfqMode = keyof typeof RFQ_MODE_COVER;

/** A configured recipe hint name → the cover its pools give. `liquidity` (price source) and
 *  `nav` (nav source) are the SAME liquidity recipe over two oracle sources. */
export function coverKindOfRecipeName(name: string | undefined): CoverKind | undefined {
  if (name === "liquidity" || name === "nav") return "liquidity";
  if (name === "impairment") return "impairment";
  if (name === "fixed") return "fixed-rate";
  return undefined;
}

/** The cover a LIVE pool gives, read from the four limits it was created with — the chain's own
 *  answer, for a pool whose recipe is not at hand (the Market struct does not store the recipe).
 *  The liquidity recipes' floor is 1 wei by construction; a fixed-rate pool has both rate-change
 *  allowances at zero; anything else holds the rate in a band. */
export function coverKindOfConstraint(c: { rateMin: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint }): CoverKind {
  if (c.rateMin <= 1n) return "liquidity";
  if (c.rateChangePerDayMax === 0n && c.rateChangeCapacityMax === 0n) return "fixed-rate";
  return "impairment";
}

/** ApySpreadImpairmentRecipe 0.5.0 caps (its own constants; `cork_query registry-recipes` serves
 *  the live values): the spread at most 100% a year, the derived band at most 50%. */
export const IMPAIRMENT_MAX_APY_SPREAD_PERCENTAGE = 100n * 10n ** 18n;
export const IMPAIRMENT_MAX_BAND_PERCENTAGE = 50n * 10n ** 18n;
const PERCENT_SCALE = 100n * 10n ** 18n; // 100% on the percentage scale (1e18 = 1%)

/** The impairment recipe's band — the deductible — on the PERCENTAGE scale (1e18 = 1%):
 *  apySpreadPercentage × durationSeconds / 365 days. */
export function impairmentBandPercentage(durationSeconds: bigint, apySpreadPercentage: bigint): bigint {
  return (apySpreadPercentage * durationSeconds) / YEAR_SECONDS;
}

/** The rate window around an anchor for a band: [anchor − anchor×band, anchor + anchor×band]. */
export function impairmentWindow(anchorRate: bigint, bandPercentage: bigint): { rateFloor: bigint; rateCeiling: bigint } {
  const delta = (anchorRate * bandPercentage) / PERCENT_SCALE;
  return { rateFloor: anchorRate - delta, rateCeiling: anchorRate + delta };
}

export interface CoverReading {
  /** `unknown` = no inline recipe to read (a template id, or a recipe no generation configures). */
  kind: CoverKind | "unknown";
  /** The name to say: "liquidity (duration-risk) cover", "impairment (credit-risk) cover". */
  label?: string;
  decidedBy: string;
  recipe?: `0x${string}`;
  recipeName?: string;
  generation?: string;
  protection?: string;
  requestedModes: readonly string[];
  /** Whether the requested pricing modes name the cover the recipe gives (null = cannot tell). */
  modesAgree: boolean | null;
  /** Present when a chain read found the reference keeps losses out of its share price. */
  referenceLoss?: { reportedInSharePrice: false; lostAssets: string; totalAssets: string; coveredAssets: string | null; openShortfall: string; note: string };
  band?: {
    apySpreadPercentage: string;
    durationSeconds: string;
    bandPercentage: string;
    anchorRate?: string;
    rateFloor?: string;
    rateCeiling?: string;
  };
  scales?: Record<string, string>;
}

type Warning = { code: string; message: string };

/** Read the cover an RFQ asks for from its inline template, and name every way the request
 *  contradicts itself. Pure: `recipeHint` is the configured classification of the template's
 *  recipe (the handler resolves it), `nowSeconds` bounds the impairment duration. */
export function readRfqCover(a: {
  modes: readonly string[];
  marketTemplate: Record<string, unknown> | undefined;
  recipeHint: { recipeName?: string | undefined; generation: string } | undefined;
  nowSeconds: bigint;
}): { cover: CoverReading; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const inline = a.marketTemplate?.["inline"];
  const recipeRaw = inline && typeof inline === "object" ? (inline as { oracle_recipe?: unknown }).oracle_recipe : undefined;
  const recipe = typeof recipeRaw === "string" && /^0x[0-9a-fA-F]{40}$/u.test(recipeRaw) ? (recipeRaw as `0x${string}`) : undefined;
  const kind = coverKindOfRecipeName(a.recipeHint?.recipeName);
  if (recipe === undefined || kind === undefined) {
    return {
      cover: {
        kind: "unknown",
        decidedBy: recipe === undefined
          ? "no inline recipe on the request: a market_template_id names a pool — read it (cork_query cork-pool) and classify the cover from its rate limits (rateMin of 1 wei = liquidity cover)"
          : "the inline recipe is not one a configured generation names — cork_query registry-recipes lists each recipe with its own description",
        ...(recipe !== undefined ? { recipe } : {}),
        requestedModes: a.modes,
        modesAgree: null,
      },
      warnings,
    };
  }
  const wantsImpairment = a.modes.includes("liquidity_impairment");
  const wantsLiquidity = a.modes.includes("liquidity_only");
  const modesAgree = kind === "liquidity" ? wantsLiquidity && !wantsImpairment : wantsImpairment && !wantsLiquidity;
  const cover: CoverReading = {
    kind,
    label: COVER_LABELS[kind],
    decidedBy: "the recipe named in marketTemplate.inline.oracle_recipe — the venue's `modes` are pricing labels and nothing on chain reads them",
    recipe,
    ...(a.recipeHint?.recipeName !== undefined ? { recipeName: a.recipeHint.recipeName } : {}),
    generation: a.recipeHint!.generation,
    protection: COVER_PROTECTION[kind],
    requestedModes: a.modes,
    modesAgree,
  };
  if (kind === "liquidity" && wantsImpairment) {
    warnings.push({
      code: "cover_mode_mismatch",
      message: `modes names liquidity_impairment, but the template's recipe ${recipe} is a LIQUIDITY recipe (duration-risk cover): the pool it creates follows the oracle's rate and pays NOTHING for a loss in the reference (measured: 0.000000 on a 10% NAV loss), while an underwriter may price this request as downside cover. For credit-risk (downside) protection name the impairment recipe of the generation you trade (cork_query registry-recipes) with a cork-inline-impairment/1 block; for exit-only cover ask for liquidity_only alone. cork_capabilities topic:"cover"`,
    });
  }
  if (kind !== "liquidity" && wantsLiquidity) {
    warnings.push({
      code: "cover_mode_mismatch",
      message: `modes names liquidity_only, but the template's recipe ${recipe} gives ${kind} cover (the pool rate does not follow a loss in the reference): an underwriter pricing the liquidity mode would sell downside protection at an exit-only price, so expect a pass. Ask for liquidity_impairment alone. cork_capabilities topic:"cover"`,
    });
  } else if (kind !== "liquidity" && !wantsImpairment) {
    warnings.push({ code: "cover_mode_mismatch", message: `the template's recipe ${recipe} gives ${kind} cover, and no requested mode prices downside — ask for liquidity_impairment. cork_capabilities topic:"cover"` });
  }
  const params = inlineParamsOfTemplate(a.marketTemplate);
  if (kind === "liquidity" && params?.schema === INLINE_IMPAIRMENT_SCHEMA) {
    warnings.push({ code: "invalid_order_terms", message: `the inline block is ${INLINE_IMPAIRMENT_SCHEMA} but the recipe ${recipe} is a liquidity recipe, which takes one word (the anchor): the duration and spread are ignored and the pool is exit-only cover. Use ${INLINE_LIQUIDITY_SCHEMA}, or name the impairment recipe` });
  }
  if (kind === "fixed-rate") {
    warnings.push({ code: "invalid_order_terms", message: `the fixed-rate recipe takes no inline block: its pool is keyed on the frozen rate (the order's rateOverride), and no inline schema carries that rate, so an underwriter cannot derive the pool from this request. State the rate you want out of band, or request impairment cover` });
  }
  if (kind === "impairment") {
    if (params?.schema !== INLINE_IMPAIRMENT_SCHEMA) {
      warnings.push({ code: "invalid_order_terms", message: `the impairment recipe ${recipe} needs a ${INLINE_IMPAIRMENT_SCHEMA} block (schema, anchor_rate, expiry, swap_fee_wad, unwind_swap_fee_wad, duration_seconds, apy_spread_percentage) — ${params === undefined ? "the request carries no readable inline block" : `the block is ${params.schema}`}, so an underwriter cannot derive the band and the pool` });
    } else if (params.durationSeconds === undefined || params.apySpreadPercentage === undefined) {
      const missing = [params.durationSeconds === undefined ? "duration_seconds" : "", params.apySpreadPercentage === undefined ? "apy_spread_percentage" : ""].filter(Boolean).join(" and ");
      warnings.push({ code: "invalid_order_terms", message: `the ${INLINE_IMPAIRMENT_SCHEMA} block lacks ${missing}: the recipe's payload is exactly three words (anchor, duration, spread) and a partial block is never encoded with zeros — the band, which is the deductible, is undefined` });
    } else {
      const band = impairmentBandPercentage(params.durationSeconds, params.apySpreadPercentage);
      const window = params.anchorRate !== undefined ? impairmentWindow(params.anchorRate, band) : undefined;
      cover.band = {
        apySpreadPercentage: params.apySpreadPercentage.toString(),
        durationSeconds: params.durationSeconds.toString(),
        bandPercentage: band.toString(),
        ...(params.anchorRate !== undefined && window ? { anchorRate: params.anchorRate.toString(), rateFloor: window.rateFloor.toString(), rateCeiling: window.rateCeiling.toString() } : {}),
      };
      cover.scales = {
        apySpreadPercentage: "PERCENTAGE, 1e18 = 1% (a 10%/year spread is 10e18)",
        bandPercentage: "PERCENTAGE of the anchor, 1e18 = 1% — the deductible: a loss in the reference smaller than this is not paid",
        anchorRate: "ABSOLUTE rate, 1e18 = 1.0 — honoured only while the pair's oracle is undeployed; a live oracle's rate is the anchor",
        rateFloor: "ABSOLUTE rate, 1e18 = 1.0 — the worst rate the holder swaps at, anchor × (1 − band)",
        rateCeiling: "ABSOLUTE rate, 1e18 = 1.0",
        durationSeconds: "plain seconds",
      };
      if (params.apySpreadPercentage > IMPAIRMENT_MAX_APY_SPREAD_PERCENTAGE) {
        warnings.push({ code: "invalid_order_terms", message: `apy_spread_percentage ${params.apySpreadPercentage} exceeds the recipe's cap ${IMPAIRMENT_MAX_APY_SPREAD_PERCENTAGE} (100% a year on the percentage scale, 1e18 = 1%) — recipe.resolve reverts SpreadTooHigh; a 10%/year spread is 10000000000000000000` });
      }
      if (band > IMPAIRMENT_MAX_BAND_PERCENTAGE) {
        warnings.push({ code: "invalid_order_terms", message: `the band apy_spread_percentage × duration_seconds / 365 d = ${band} exceeds the recipe's cap ${IMPAIRMENT_MAX_BAND_PERCENTAGE} (50%) — recipe.resolve reverts BandTooWide` });
      }
      if (params.expiry !== undefined && params.expiry > a.nowSeconds && params.durationSeconds > params.expiry - a.nowSeconds) {
        warnings.push({ code: "invalid_order_terms", message: `duration_seconds ${params.durationSeconds} exceeds the pool's remaining life ${params.expiry - a.nowSeconds} s (expiry ${params.expiry}) — the fill that creates the pool reverts DurationTooLong; set duration_seconds to at most expiry minus the time of the fill` });
      }
    }
  }
  return { cover, warnings };
}
