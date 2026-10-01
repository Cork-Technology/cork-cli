// WHICH COVER A cST IS — decided by the market's RECIPE, never by the label on the request.
//
// A Cork pool lets the cST holder swap the reference asset for collateral at the pool's rate.
// What that is worth after a loss in the reference depends on ONE thing: how far the pool's rate
// may follow the rate oracle down. The recipe fixes that at creation (it resolves the four rate
// limits the pool is born with), so the recipe — not the mode a request names — is the cover:
//
//   liquidity   the window is 1 wei .. 2x the anchor and the rate may move a whole anchor a day:
//               the rate FOLLOWS the oracle. A loss in the reference lowers the rate with it, so
//               the holder hands in more reference for the same collateral and the cover pays
//               nothing for the loss. It pays only when the reference cannot be sold or redeemed
//               at the oracle's rate elsewhere (an exit, not protection).
//   impairment  the window is the anchor ± apySpread × duration / 365 d, the rate moves one day of
//               that spread per day (seven days of it in a burst): the rate is HELD near the
//               anchor. A loss beyond the band is paid by the cover; the band is the deductible.
//   fixed-rate  the oracle is an immutable FixedRateOracle and the window is rate .. rate + 1 with
//               both rate-change allowances zero (read from the live recipe, Base, 2026-10-01):
//               the rate never moves. Every loss below it is paid; the reference's yield after
//               creation is not tracked; and it reads no price feed at all.
//
// Measured on a Base fork against the phoenix/v0.4-rc.1 contracts
// (experiments/fork-harness/script/cover-types-rehearsal.ts): pools over USDC / baseUSD, same
// expiry; the reference vault takes a real 10% loss; 100 cST exercised on each — see the
// script's RESULT header for the payouts.
//
// The venue's RFQ `modes` name the alternatives a requester accepts (cork-api 0.4.4:
// liquidity_only | liquidity_impairment | fixed_rate). Nothing on chain reads them. A request
// carries ONE market template, so it describes ONE alternative; an answer for another mode must
// bring its own. A mode that names a cover the template's recipe does not give is the mismatch
// this module names before relay: an underwriter that builds the pool from the request's
// template would sell one cover priced as another (Zyfai's first trade asked for downside cover
// and created an exit-only pool).
import type { RfqMode } from "@cork/schemas";
import type { referenceLossReading } from "./chain/nav-loss.ts";
import { fixedRateOverrideOfTemplate, INLINE_FIXED_SCHEMA, INLINE_IMPAIRMENT_SCHEMA, INLINE_LIQUIDITY_SCHEMA, type InlineTemplateParams, type InlineTemplateSchema, inlineParamsOfTemplate, oracleParamsOf, YEAR_SECONDS } from "./orders-answer.ts";

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
    "DOWNSIDE protection at a frozen rate: the pool rate is an immutable rate fixed at creation and reads no price feed, so every loss in the reference below that rate is paid by the cover, reported by the reference's share price or not; the reference's yield after creation is not tracked",
};

/** Every venue RFQ mode and the cover it asks for. `satisfies Record<RfqMode, …>` makes a mode
 *  the venue adds (RFQ_MODES in @cork/schemas) a compile error here until it is mapped. */
export const RFQ_MODE_COVER = { liquidity_only: "liquidity", liquidity_impairment: "impairment", fixed_rate: "fixed-rate" } as const satisfies Record<RfqMode, CoverKind>;
/** The inverse: the ONE mode that asks for a cover kind. */
export const COVER_RFQ_MODE = { liquidity: "liquidity_only", impairment: "liquidity_impairment", "fixed-rate": "fixed_rate" } as const satisfies Record<CoverKind, RfqMode>;

/** The cover each inline block is the parameter block of. */
export const INLINE_SCHEMA_COVER = {
  [INLINE_LIQUIDITY_SCHEMA]: "liquidity",
  [INLINE_IMPAIRMENT_SCHEMA]: "impairment",
  [INLINE_FIXED_SCHEMA]: "fixed-rate",
} as const satisfies Record<InlineTemplateSchema, CoverKind>;
const COVER_INLINE_SCHEMA: Record<CoverKind, InlineTemplateSchema> = { liquidity: INLINE_LIQUIDITY_SCHEMA, impairment: INLINE_IMPAIRMENT_SCHEMA, "fixed-rate": INLINE_FIXED_SCHEMA };

/** A configured recipe hint name → the cover its pools give. `liquidity` (price source) and
 *  `nav` (nav source) are the SAME liquidity recipe over two oracle sources. */
export function coverKindOfRecipeName(name: string | undefined): CoverKind | undefined {
  if (name === "liquidity" || name === "nav") return "liquidity";
  if (name === "impairment") return "impairment";
  if (name === "fixed") return "fixed-rate";
  return undefined;
}

/** The cover a LIVE pool gives, read from the limits it was created with — the chain's own
 *  answer, for a pool whose recipe is not at hand (the Market struct does not store the recipe).
 *  Both rate-change allowances at zero is the fixed recipe's signature and is asked FIRST: a
 *  fixed pool at a rate of 1 wei also has a floor of 1 wei, and only its allowances tell it from
 *  a liquidity pool (whose per-day allowance is its whole anchor, never zero). A floor of at
 *  most 1 wei is then the liquidity recipes' by construction; anything else holds the rate in a
 *  band. */
export function coverKindOfConstraint(c: { rateMin: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint }): CoverKind {
  if (c.rateChangePerDayMax === 0n && c.rateChangeCapacityMax === 0n) return "fixed-rate";
  if (c.rateMin <= 1n) return "liquidity";
  return "impairment";
}

/** 100% on the PERCENTAGE scale (1e18 = 1%). */
const PERCENT_SCALE = 100n * 10n ** 18n;
const UINT256_MAX = 2n ** 256n - 1n;

/** The impairment recipe's band on the PERCENTAGE scale (1e18 = 1%): apySpreadPercentage ×
 *  durationSeconds / 365 days — the arithmetic both recipe generations state in their own
 *  description. The band is how far the pool's rate may END UP below the anchor: the WORST-case
 *  deductible. The rate moves there at one day of the spread per day, so a loss is paid in full
 *  at first and less the band only once the rate has walked the whole way. What a recipe ALLOWS
 *  (caps on the spread and the duration) differs per generation and is not restated here: the
 *  handler asks the recipe (`recipe.resolve`, `recipe.verify`) and reports its answer. Two
 *  things ARE named chain-free below, because they are arithmetic no recipe can resolve: a band
 *  that leaves no window, and a frozen rate whose rate + 1 overflows. */
export function impairmentBandPercentage(durationSeconds: bigint, apySpreadPercentage: bigint): bigint {
  return (apySpreadPercentage * durationSeconds) / YEAR_SECONDS;
}

/** Where a frozen rate sits against the reference's rate today. The holder swaps one reference
 *  for `fixedRate` collateral whatever the reference is worth, so:
 *    below  the reference must lose `gapPercentage` of its value before the cover pays — the
 *           deductible of a fixed-rate cover;
 *    above  the cover pays `gapPercentage` AT ONCE, with no loss at all: the underwriter is out
 *           of pocket from the first block.
 *  `gapPercentage` is |live − fixed| / live on the PERCENTAGE scale (1e18 = 1%), floored. */
export function fixedRateMoneyness(fixedRate: bigint, liveRate: bigint): { position: "below" | "at" | "above"; gapPercentage: bigint } {
  if (liveRate <= 0n) throw new Error("liveRate must be positive");
  const gap = fixedRate > liveRate ? fixedRate - liveRate : liveRate - fixedRate;
  return { position: fixedRate > liveRate ? "above" : fixedRate < liveRate ? "below" : "at", gapPercentage: (gap * PERCENT_SCALE) / liveRate };
}

type Warning = { code: string; message: string };
type ReferenceLossReading = ReturnType<typeof referenceLossReading>;

const pct = (percentage: bigint): string => `${percentage / 10n ** 18n}.${(percentage % 10n ** 18n).toString().padStart(18, "0").slice(0, 4)}%`;

/** The disclosure for a frozen rate above the reference's rate, worded for the side reading it. */
export function fixedRateInTheMoneyWarning(a: { fixedRate: bigint; liveRate: bigint; liveRateSource: string; side: "requester" | "underwriter" }): Warning | undefined {
  const m = fixedRateMoneyness(a.fixedRate, a.liveRate);
  if (m.position !== "above") return undefined;
  const fact = `the frozen rate ${a.fixedRate} is ${pct(m.gapPercentage)} ABOVE the reference's rate today (${a.liveRate}, the pair's ${a.liveRateSource} oracle; both ABSOLUTE, 1e18 = 1.0): the holder swaps one reference for ${a.fixedRate} of collateral whatever the reference is worth, so this cover pays that gap at once, before any loss`;
  return {
    code: "fixed_rate_in_the_money",
    message: a.side === "underwriter"
      ? `${fact}. You would be out of pocket by that gap on every cST from the first block — price it as a certain payout, counter with a rate at or below ${a.liveRate}, or pass. cork_capabilities topic:"cover"`
      : `${fact}. An underwriter prices that gap as a certain payout or passes; to lock in today's value ask for a rate at or below ${a.liveRate} (cork_query registry-oracle reads it). cork_capabilities topic:"cover"`,
  };
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
  /** Whether the request names exactly the ONE mode that asks for the template's cover
   *  (null = cannot tell: no recipe to read). */
  modesAgree: boolean | null;
  /** Present when a chain read found the reference keeps losses out of its share price (a
   *  NAV-sourced recipe only — the one kind of pool that swaps at that price). */
  referenceLoss?: ReferenceLossReading;
  /** What the handler could NOT read from the chain, and why — so a result without a
   *  `resolved` or a `referenceLoss` block is never mistaken for a clean one. */
  notRead?: string[];
  /** Impairment cover: the band the block asks for (arithmetic on the block, chain-free). */
  band?: { apySpreadPercentage: string; durationSeconds: string; bandPercentage: string };
  /** The recipe's OWN answer for this request today (`recipe.resolve`, a chain read): the four
   *  rate limits a pool created now is born with, against the oracle the pool would read. Absent
   *  without an RPC, for a `one_of` collateral, or when the recipe refused (then a warning names
   *  its error). */
  resolved?: {
    source: string;
    oracle: { address: `0x${string}` | null; deployed: boolean; rate: string | null };
    constraint: { rateMin: string; rateMax: string; rateChangePerDayMax: string; rateChangeCapacityMax: string };
  };
  /** Fixed-rate cover: the frozen rate and, when a chain read found the pair's oracle, where it
   *  sits against the reference's rate today. */
  fixed?: {
    rateOverride: string | null;
    liveRate?: string;
    liveRateSource?: string;
    position?: "below" | "at" | "above";
    gapPercentage?: string;
  };
  scales?: Record<string, string>;
}

const FIXED_SCALES = {
  rateOverride: "ABSOLUTE rate, 1e18 = 1.0 — the frozen rate: one reference swaps for this much collateral for the pool's whole life",
  liveRate: "ABSOLUTE rate, 1e18 = 1.0 — the pair's rate oracle today",
  gapPercentage: "PERCENTAGE of the live rate, 1e18 = 1% — below: the loss the reference must take before the cover pays (the deductible); above: paid at once",
} as const;

/** Fill a fixed-rate reading with the reference's rate today (the handler's chain read). */
export function withFixedRateLiveRate(cover: CoverReading, liveRate: bigint, liveRateSource: string): void {
  if (!cover.fixed || cover.fixed.rateOverride === null) return;
  const m = fixedRateMoneyness(BigInt(cover.fixed.rateOverride), liveRate);
  cover.fixed = { ...cover.fixed, liveRate: liveRate.toString(), liveRateSource, position: m.position, gapPercentage: m.gapPercentage.toString() };
}

/** Every requested mode that asks for a cover the template's recipe does not give, and the
 *  missing mode that does — one warning each way, from the mode table. */
function modeWarnings(kind: CoverKind, recipe: `0x${string}`, modes: readonly RfqMode[]): Warning[] {
  const expected = COVER_RFQ_MODE[kind];
  const label = COVER_LABELS[kind];
  const out: Warning[] = [];
  const others = modes.filter((m) => RFQ_MODE_COVER[m] !== kind);
  if (others.length > 0) {
    const trap = kind === "liquidity"
      ? ` The pool this template creates follows the oracle's rate and pays NOTHING for a loss in the reference. For downside protection name the impairment or the fixed recipe of the generation you trade (cork_query registry-recipes) with its own inline block.`
      : ` An underwriter pricing ${others.join(" / ")} from this template would sell downside protection at another cover's price, so expect a pass.`;
    out.push({
      code: "cover_mode_mismatch",
      message: `modes names ${others.join(" and ")}, but the template's recipe ${recipe} gives ${label}. A request carries ONE template, so it describes one alternative: an answer for another mode must bring its own template, and an underwriter that builds the pool from THIS one creates ${label} whatever mode it priced.${trap} Ask for ${expected} alone, and open a separate request for each other cover. cork_capabilities topic:"cover"`,
    });
  }
  if (!modes.includes(expected)) {
    out.push({ code: "cover_mode_mismatch", message: `the template's recipe ${recipe} gives ${label}, and no requested mode asks for it — name ${expected}. cork_capabilities topic:"cover"` });
  }
  return out;
}

/** What an inline block and its template contradict about the recipe: a block written for
 *  another cover (the recipe reads none of that block's own parameters), and a `rate_override`
 *  on a recipe that takes none. Shared by rfq-open (the requester's request) and answer-rfq
 *  (the underwriter's order), so both name the same contradiction; only the way out differs.
 *  `rate.raw` is the template's `oracle_params.rate_override` as written; `rate.admissible` is
 *  that value when it passes the venue's rule. */
export function inlineBlockWarnings(
  kind: CoverKind,
  recipe: `0x${string}`,
  params: InlineTemplateParams | undefined,
  rate: { raw: unknown; admissible: bigint | undefined },
  audience: "requester" | "underwriter",
): Warning[] {
  const out: Warning[] = [];
  if (params !== undefined && INLINE_SCHEMA_COVER[params.schema] !== kind) {
    const wayOut = audience === "requester"
      ? `Use ${COVER_INLINE_SCHEMA[kind]}, or name the recipe the block belongs to`
      : `The block's bytes are NOT carried into this order; pass jitMarket.extraData for this recipe, or answer with the recipe the block belongs to`;
    out.push({ code: "invalid_order_terms", message: `the inline block is ${params.schema}, the parameter block of ${COVER_LABELS[INLINE_SCHEMA_COVER[params.schema]]}, but the recipe ${recipe} gives ${COVER_LABELS[kind]}: the recipe reads none of that block's own parameters, so an underwriter cannot build the pool the requester means from it. ${wayOut}` });
  }
  if (kind !== "fixed-rate") {
    if (rate.admissible !== undefined) {
      const wayOut = audience === "requester" ? "Remove rate_override, or name the fixed recipe" : "The rate is NOT carried into this order; for fixed-rate cover answer with the fixed recipe (jitMarket.recipe)";
      out.push({ code: "invalid_order_terms", message: `the template carries rate_override ${rate.admissible}, but the recipe ${recipe} gives ${COVER_LABELS[kind]} and reads a rate oracle: a fill that carries a non-zero rateOverride on such a recipe REVERTS (UnexpectedRateOverride), and the venue does not check this. ${wayOut}` });
    } else if (rate.raw !== undefined && audience === "requester") {
      out.push({ code: "invalid_order_terms", message: `the template carries a rate_override that the recipe ${recipe} does not read (it gives ${COVER_LABELS[kind]} and reads a rate oracle), and the value is not an admissible rate either. Remove rate_override` });
    }
  }
  return out;
}

function impairmentReading(recipe: `0x${string}`, params: InlineTemplateParams | undefined): { band?: NonNullable<CoverReading["band"]>; scales?: Record<string, string>; warnings: Warning[] } {
  if (params === undefined) {
    return { warnings: [{ code: "invalid_order_terms", message: `the impairment recipe ${recipe} needs a ${INLINE_IMPAIRMENT_SCHEMA} block (schema, anchor_rate, expiry, swap_fee_wad, unwind_swap_fee_wad, duration_seconds, apy_spread_percentage) — the request carries no readable inline block, so an underwriter cannot derive the band and the pool` }] };
  }
  // Another cover's block is named once, by inlineBlockWarnings.
  if (params.schema !== INLINE_IMPAIRMENT_SCHEMA) return { warnings: [] };
  if (params.durationSeconds === undefined || params.apySpreadPercentage === undefined) {
    const missing = [params.durationSeconds === undefined ? "duration_seconds" : "", params.apySpreadPercentage === undefined ? "apy_spread_percentage" : ""].filter(Boolean).join(" and ");
    return { warnings: [{ code: "invalid_order_terms", message: `the ${INLINE_IMPAIRMENT_SCHEMA} block lacks ${missing} (each a positive decimal string): the recipe's payload is exactly three words (anchor, duration, spread) and a partial block is never encoded with zeros — the band is undefined` }] };
  }
  const band = impairmentBandPercentage(params.durationSeconds, params.apySpreadPercentage);
  return {
    band: { apySpreadPercentage: params.apySpreadPercentage.toString(), durationSeconds: params.durationSeconds.toString(), bandPercentage: band.toString() },
    scales: {
      apySpreadPercentage: "PERCENTAGE, 1e18 = 1% (a 10%/year spread is 10e18)",
      bandPercentage: "PERCENTAGE of the anchor, 1e18 = 1% — how far the pool rate may end up below the anchor: the WORST-case deductible, reached at one day of the spread per day",
      durationSeconds: "plain seconds",
    },
    // A band of 100% or more has no window at all: the floor would be at or below zero.
    warnings: band >= PERCENT_SCALE ? [{ code: "invalid_order_terms", message: `the band apy_spread_percentage × duration_seconds / 365 d = ${band} is 100% of the anchor or more (1e18 = 1%): there is no rate window left, and no recipe resolves it` }] : [],
  };
}

/** The pool expiry an inline block names against the window the request itself accepts. */
function inlineExpiryWarnings(params: InlineTemplateParams | undefined, window: { notBefore: bigint; notAfter: bigint } | undefined, nowSeconds: bigint): Warning[] {
  const expiry = params?.expiry;
  if (expiry === undefined) return [];
  if (expiry <= nowSeconds) return [{ code: "invalid_order_terms", message: `the inline block names pool expiry ${expiry}, which is not in the future (now ${nowSeconds}) — no pool can be created at it` }];
  if (window !== undefined && (expiry < window.notBefore || expiry > window.notAfter)) {
    return [{ code: "invalid_order_terms", message: `the inline block names pool expiry ${expiry}, outside the request's own expiryWindow [${window.notBefore}, ${window.notAfter}]: the expiry is part of pool identity, so the block and the window ask for different pools` }];
  }
  return [];
}

function fixedReading(recipe: `0x${string}`, rateOverride: bigint | undefined): { fixed: NonNullable<CoverReading["fixed"]>; warnings: Warning[] } {
  if (rateOverride === undefined) {
    return {
      fixed: { rateOverride: null },
      warnings: [{ code: "invalid_order_terms", message: `the fixed recipe ${recipe} needs the frozen rate in marketTemplate.inline.oracle_params.rate_override — a decimal string, ABSOLUTE 1e18 = 1.0 ("1075000000000000000" = 1.075). The pool is keyed on that rate (it becomes the order's rateOverride), so without it an underwriter cannot derive the pool` }],
    };
  }
  // The recipe's window is rate .. rate + 1 (its WINDOW_WIDTH): the top of uint256 has no rate + 1.
  const overflow = rateOverride === UINT256_MAX;
  return {
    fixed: { rateOverride: rateOverride.toString() },
    warnings: overflow ? [{ code: "invalid_order_terms", message: `rate_override ${rateOverride} is uint256's maximum: the fixed recipe's window is rate .. rate + 1, which overflows, so recipe.resolve reverts and no pool can be created at this rate (the venue admits the value; the chain does not)` }] : [],
  };
}

/** The inline template's recipe as the handler classified it against the configured
 *  generations: ONE object, so the reading below never re-parses the template for it. */
export interface InlineRecipe {
  address: `0x${string}`;
  /** The configured hint name (`liquidity`, `nav`, `impairment`, `fixed`), when one is set. */
  recipeName?: string | undefined;
  generation: string;
}

/** Read the cover an RFQ asks for from its inline template and name what the request itself
 *  contradicts: a mode that asks for another cover, a block written for another recipe, a rate
 *  on a recipe that takes none, an inline expiry outside the request's own window. Pure and
 *  chain-free; what the RECIPE allows is the handler's chain read. `recipe` is undefined for a
 *  template id and for an address no configured generation names. */
export function readRfqCover(a: {
  modes: readonly RfqMode[];
  marketTemplate: Record<string, unknown> | undefined;
  recipe: InlineRecipe | undefined;
  /** The inline template's `oracle_recipe` when it is an address no generation names. */
  unknownRecipe?: `0x${string}` | undefined;
  expiryWindow?: { notBefore: bigint; notAfter: bigint } | undefined;
  nowSeconds: bigint;
}): { cover: CoverReading; warnings: Warning[] } {
  const kind = coverKindOfRecipeName(a.recipe?.recipeName);
  if (a.recipe === undefined || kind === undefined) {
    const address = a.recipe?.address ?? a.unknownRecipe;
    return {
      cover: {
        kind: "unknown",
        decidedBy: address === undefined
          ? "no inline recipe on the request: a market_template_id names a pool — read it (cork_query cork-pool) and take the cover from its data.cover"
          : "the inline recipe is not one a configured generation names — cork_query registry-recipes lists each recipe with its own description",
        ...(address !== undefined ? { recipe: address } : {}),
        requestedModes: a.modes,
        modesAgree: null,
      },
      warnings: [],
    };
  }
  const recipe = a.recipe.address;
  const cover: CoverReading = {
    kind,
    label: COVER_LABELS[kind],
    decidedBy: "the recipe named in marketTemplate.inline.oracle_recipe — a request carries one template, so `modes` name what the requester accepts and nothing on chain reads them",
    recipe,
    ...(a.recipe.recipeName !== undefined ? { recipeName: a.recipe.recipeName } : {}),
    generation: a.recipe.generation,
    protection: COVER_PROTECTION[kind],
    requestedModes: a.modes,
    modesAgree: a.modes.length === 1 && a.modes[0] === COVER_RFQ_MODE[kind],
  };
  const params = inlineParamsOfTemplate(a.marketTemplate);
  const warnings = [...modeWarnings(kind, recipe, a.modes), ...inlineBlockWarnings(kind, recipe, params, { raw: oracleParamsOf(a.marketTemplate)?.["rate_override"], admissible: fixedRateOverrideOfTemplate(a.marketTemplate) }, "requester"), ...inlineExpiryWarnings(params, a.expiryWindow, a.nowSeconds)];
  if (kind === "impairment") {
    const r = impairmentReading(recipe, params);
    if (r.band) cover.band = r.band;
    if (r.scales) cover.scales = r.scales;
    warnings.push(...r.warnings);
  }
  if (kind === "fixed-rate") {
    const r = fixedReading(recipe, fixedRateOverrideOfTemplate(a.marketTemplate));
    cover.fixed = r.fixed;
    cover.scales = { ...FIXED_SCALES };
    warnings.push(...r.warnings);
  }
  return { cover, warnings };
}

/** Attach the recipe's own answer (the handler's `recipe.resolve` read) to a reading. */
export function withResolvedConstraint(cover: CoverReading, resolved: NonNullable<CoverReading["resolved"]>): void {
  cover.resolved = resolved;
  cover.scales = {
    ...cover.scales,
    resolved: "constraint: ABSOLUTE rates, 1e18 = 1.0 — the four limits recipe.resolve returns for this request today; rateMin is the worst rate the holder can ever swap at and rateMax the best. oracle.rate: ABSOLUTE, 1e18 = 1.0 — a DEPLOYED oracle's rate is the anchor (a carried anchor_rate is then ignored)",
  };
}
