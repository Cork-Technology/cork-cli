// WHICH COVER an RFQ buys (the 2026-10-01 cover-kind finding; cork-api 0.4.4 fixed-rate mode): the recipe in
// the inline template decides it; the venue's `modes` name what the requester accepts. rfq-open
// returns `data.cover`, names a request that works against itself, and — with an RPC — carries
// the recipe's OWN answer (`recipe.resolve`) instead of a local restatement of its rules.
//
// Where the numbers come from:
//   - the band goldens: `recipe.resolve` on the deployed ApySpreadImpairmentRecipe 0xd5e8…0Ed9
//     (Base, 2026-10-01) — the bands asserted here are the ones those windows were built from;
//   - the constraint shapes: the three pools the fork experiment created
//     (experiments/fork-harness/script/cover-types-rehearsal.ts, block 52038242);
//   - the rate-rule vectors: the venue's OWN test vectors for `rate_override` (cork-api 0.4.4),
//     each also sent to the real venue by fixed-rate-rfq-rehearsal.ts;
//   - the chain: the eval stub, whose fixed recipe behaves as the live one was read to behave
//     (payload checked first, then the oracle; rate .. rate + 1; Panic at uint256's maximum).
import { describe, expect, it } from "vitest";
import {
  BUNDLED_DEFAULTS,
  COVER_KINDS,
  COVER_LABELS,
  COVER_PROTECTION,
  COVER_RFQ_MODE,
  coverKindOfConstraint,
  coverKindOfRecipeName,
  fixedRateInTheMoneyWarning,
  fixedRateMoneyness,
  fixedRateOverrideOfTemplate,
  fixedRateOverrideViolation,
  generationsOf,
  impairmentBandPercentage,
  INLINE_SCHEMA_COVER,
  INLINE_TEMPLATE_SCHEMAS,
  inlineAdditionalData,
  inlineBlockWarnings,
  inlineParamsOfTemplate,
  primaryOf,
  readRfqCover,
  readUnreportedLoss,
  recipeAddressOfTemplate,
  referenceLossReading,
  RFQ_MODE_COVER,
  runTool,
  unreportedLossShare,
  unreportedLossState,
  unreportedLossWarning,
  withFixedRateLiveRate,
  withResolvedConstraint,
  type CoverReading,
  type HandlerContext,
  type UnreportedLoss,
} from "@cork/core";
import { DEMO_ACCOUNT, DOC_TOPICS, findDocTopic, RFQ_MODES, TOOL_EXAMPLES, type RfqMode } from "@cork/schemas";
import { DEPLOYED_FIXED_RATE, FIXED_RECIPE, IMPAIRMENT_RECIPE, JIT_TASK_PAIR, LIQUIDITY_RECIPE, predictedFixedOracle, RFQ_IMPAIRMENT_EXPIRY, stubContext } from "../../../evals/stub.ts";
import { blockBytesFor, classifyInlineRecipe, durationBeyondLifeNote, readFixedRatePosition, readRecipeSource, singleCollateral } from "../src/handlers/cover-reading.ts";
import { readPairLiveRate } from "../src/handlers/registry.ts";
import { fixedRateTemplateViolation, rfqModesViolation } from "../src/handlers/submit.ts";

const NOW = 1_790_000_000n; // the eval stub's clock
const CHAIN = 8453;
const gens = generationsOf(BUNDLED_DEFAULTS, CHAIN);
const recipes = primaryOf(gens)!.marketRegistry!.recipes!;
const IMPAIRMENT = recipes["impairment"]!;
const NAV = recipes["nav"]!;
const FIXED = recipes["fixed"]!;
const PRIMARY = primaryOf(gens)!.label;
const PREVIOUS_IMPAIRMENT = gens.find((g) => g.label === "phoenix/v0.3-rc.1")!.marketRegistry!.recipes!["impairment"]!;
const ANCHOR = 1_091_071_000_000_000_000n;
const WAD = 10n ** 18n;
const TEN_PERCENT = 10n * WAD;
const UINT256_MAX = 2n ** 256n - 1n;
const codes = (w: Array<{ code: string }>) => w.map((x) => x.code);

describe("the cover kinds — names, tables, and a live pool's limits", () => {
  it("a recipe hint names its cover: the two liquidity recipes (price and nav source) are the SAME exit-only cover", () => {
    expect(coverKindOfRecipeName("liquidity")).toBe("liquidity");
    expect(coverKindOfRecipeName("nav")).toBe("liquidity");
    expect(coverKindOfRecipeName("impairment")).toBe("impairment");
    expect(coverKindOfRecipeName("fixed")).toBe("fixed-rate");
    expect(coverKindOfRecipeName("other")).toBeUndefined();
    expect(coverKindOfRecipeName(undefined)).toBeUndefined();
    expect(COVER_LABELS).toEqual({ liquidity: "liquidity (duration-risk) cover", impairment: "impairment (credit-risk) cover", "fixed-rate": "fixed-rate cover" });
    expect(COVER_PROTECTION.liquidity).toMatch(/^duration-risk cover.*pays nothing for that loss/u);
    expect(COVER_PROTECTION.impairment).toMatch(/^credit-risk cover.*a loss the oracle reports beyond the band/u);
    expect(COVER_PROTECTION["fixed-rate"]).toMatch(/reads no price feed.*reported by the reference's share price or not.*yield after creation is not tracked/u);
  });

  it("every venue mode maps to one cover and back: the two tables are inverses over the venue's full mode list (cork-api 0.4.4)", () => {
    expect(RFQ_MODES).toEqual(["liquidity_only", "liquidity_impairment", "fixed_rate"]);
    expect(RFQ_MODE_COVER).toEqual({ liquidity_only: "liquidity", liquidity_impairment: "impairment", fixed_rate: "fixed-rate" });
    for (const m of RFQ_MODES) expect(COVER_RFQ_MODE[RFQ_MODE_COVER[m]]).toBe(m);
    for (const k of COVER_KINDS) expect(RFQ_MODE_COVER[COVER_RFQ_MODE[k]]).toBe(k);
    // Each inline block is the parameter block of exactly one cover, and every cover has one.
    expect(Object.keys(INLINE_SCHEMA_COVER).sort()).toEqual([...INLINE_TEMPLATE_SCHEMAS].sort());
    expect(new Set(Object.values(INLINE_SCHEMA_COVER))).toEqual(new Set(COVER_KINDS));
    expect(INLINE_SCHEMA_COVER["cork-inline-fixed/1"]).toBe("fixed-rate");
  });

  it("a live pool's limits name its cover — the fork's three pools, and the cases only the ORDER of the checks gets right", () => {
    // LIQUIDITY pool 0xbd2e…1b72: rateMin 1 wei, rateMax 2x, perDay = anchor, capacity 3x.
    expect(coverKindOfConstraint({ rateMin: 1n, rateChangePerDayMax: 1_091_086_000_000_000_000n, rateChangeCapacityMax: 3_273_258_000_000_000_000n })).toBe("liquidity");
    // IMPAIRMENT pool 0x96aa…898a: floor 1.086788, perDay 0.000299, capacity 0.002092.
    expect(coverKindOfConstraint({ rateMin: 1_086_787_689_952_929_985n, rateChangePerDayMax: 298_927_671_232_876n, rateChangeCapacityMax: 2_092_493_698_630_136n })).toBe("impairment");
    // FIXED pool 0xba19…91c4: rate .. rate + 1, both allowances zero.
    expect(coverKindOfConstraint({ rateMin: 1_091_086_000_000_000_000n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n })).toBe("fixed-rate");
    // A fixed pool at a rate of 1 wei ALSO has a floor of 1 wei: only its allowances tell it
    // from a liquidity pool, so the allowances are asked first (the venue admits "1").
    expect(coverKindOfConstraint({ rateMin: 1n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n })).toBe("fixed-rate");
    // ONE allowance at zero is not a frozen rate.
    expect(coverKindOfConstraint({ rateMin: ANCHOR - 1n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 5n })).toBe("impairment");
    expect(coverKindOfConstraint({ rateMin: 1n, rateChangePerDayMax: 5n, rateChangeCapacityMax: 0n })).toBe("liquidity");
    // The floor boundary: 1 wei is the liquidity recipes' floor, 2 wei is already a band.
    expect(coverKindOfConstraint({ rateMin: 2n, rateChangePerDayMax: 1n, rateChangeCapacityMax: 1n })).toBe("impairment");
  });

  it("the band is apySpread × duration / 365 d, floored — the arithmetic both recipe generations state", () => {
    expect(impairmentBandPercentage(2_592_000n, TEN_PERCENT)).toBe(821_917_808_219_178_082n); // 30 days at 10%/yr = 0.8219%
    expect(impairmentBandPercentage(1_209_600n, TEN_PERCENT)).toBe(383_561_643_835_616_438n); // 14 days
    expect(impairmentBandPercentage(31_536_000n, TEN_PERCENT)).toBe(TEN_PERCENT); // a whole year = the spread
    expect(impairmentBandPercentage(1n, 31_535_999n)).toBe(0n); // floor, never a rounded-up band
  });
});

describe("a frozen rate against the reference's rate today", () => {
  it("below = a deductible, above = paid at once, with the gap as a floored share of the LIVE rate", () => {
    // The fork rehearsal's own request: 1.08017613 against 1.091087 is exactly 1% below.
    expect(fixedRateMoneyness(1_080_176_130_000_000_000n, 1_091_087_000_000_000_000n)).toEqual({ position: "below", gapPercentage: WAD });
    expect(fixedRateMoneyness(750_000_000_000_000_000n, 800_000_000_000_000_000n)).toEqual({ position: "below", gapPercentage: 6_250_000_000_000_000_000n });
    expect(fixedRateMoneyness(900_000_000_000_000_000n, 800_000_000_000_000_000n)).toEqual({ position: "above", gapPercentage: 12_500_000_000_000_000_000n });
    expect(fixedRateMoneyness(800_000_000_000_000_000n, 800_000_000_000_000_000n)).toEqual({ position: "at", gapPercentage: 0n });
    // One wei either side is not "at"; the gap floors to zero on the percentage scale only when it is below 1e-20 of the rate.
    expect(fixedRateMoneyness(3n, 2n)).toEqual({ position: "above", gapPercentage: 50n * WAD });
    expect(fixedRateMoneyness(2n, 3n)).toEqual({ position: "below", gapPercentage: 33_333_333_333_333_333_333n });
    expect(() => fixedRateMoneyness(1n, 0n)).toThrow(/liveRate must be positive/u);
  });

  it("only a rate ABOVE the reference's warns, and each side reads its own consequence", () => {
    const at = { fixedRate: 800_000_000_000_000_000n, liveRate: 800_000_000_000_000_000n, liveRateSource: "nav" };
    expect(fixedRateInTheMoneyWarning({ ...at, side: "requester" })).toBeUndefined();
    expect(fixedRateInTheMoneyWarning({ ...at, fixedRate: at.fixedRate - 1n, side: "underwriter" })).toBeUndefined();
    const above = { ...at, fixedRate: 900_000_000_000_000_000n };
    const uw = fixedRateInTheMoneyWarning({ ...above, side: "underwriter" })!;
    expect(uw.code).toBe("fixed_rate_in_the_money");
    expect(uw.message).toMatch(/the frozen rate 900000000000000000 is 12\.5000% ABOVE the reference's rate today \(800000000000000000, the pair's nav oracle/u);
    expect(uw.message).toMatch(/You would be out of pocket by that gap on every cST from the first block.*counter with a rate at or below 800000000000000000, or pass/u);
    const rq = fixedRateInTheMoneyWarning({ ...above, side: "requester" })!;
    expect(rq.message).toMatch(/An underwriter prices that gap as a certain payout or passes/u);
    expect(rq.message).not.toMatch(/You would be out of pocket/u);
  });

  it("withFixedRateLiveRate fills a reading that HAS a rate and leaves one without a rate alone", () => {
    const cover: CoverReading = { kind: "fixed-rate", decidedBy: "x", requestedModes: ["fixed_rate"], modesAgree: true, fixed: { rateOverride: "900000000000000000" } };
    withFixedRateLiveRate(cover, 800_000_000_000_000_000n, "price");
    expect(cover.fixed).toEqual({ rateOverride: "900000000000000000", liveRate: "800000000000000000", liveRateSource: "price", position: "above", gapPercentage: "12500000000000000000" });
    const noRate: CoverReading = { kind: "fixed-rate", decidedBy: "x", requestedModes: [], modesAgree: false, fixed: { rateOverride: null } };
    withFixedRateLiveRate(noRate, 800_000_000_000_000_000n, "nav");
    expect(noRate.fixed).toEqual({ rateOverride: null });
    const notFixed: CoverReading = { kind: "liquidity", decidedBy: "x", requestedModes: [], modesAgree: true };
    withFixedRateLiveRate(notFixed, 1n, "nav");
    expect(notFixed.fixed).toBeUndefined();
  });
});

describe("the venue's fixed-rate rule (cork-api 0.4.4), mirrored value for value", () => {
  // The venue's own test vectors for inline.oracle_params.rate_override.
  const REJECTED: unknown[] = ["0", "01", "-1", "1.5", "1e18", "0x01", "abc", "", 1, null, (2n ** 256n).toString()];
  const ACCEPTED = ["1", UINT256_MAX.toString()];
  const template = (rate: unknown, schema = "cork-inline-fixed/1") => ({ inline: { oracle_recipe: FIXED, oracle_params: { schema, rate_override: rate } } });

  it("the value rule: a positive decimal uint256 STRING with no leading zero — every venue vector lands where the venue lands", () => {
    for (const bad of REJECTED) expect(fixedRateOverrideViolation(bad), JSON.stringify(bad)).not.toBeNull();
    for (const good of ACCEPTED) expect(fixedRateOverrideViolation(good), good).toBeNull();
    expect(fixedRateOverrideViolation(undefined)).toMatch(/got nothing/u);
    expect(fixedRateOverrideViolation(1)).toMatch(/must be a decimal STRING, got 1/u);
    // A bigint (the SDK path can hand one over) is refused in words — JSON cannot print it.
    expect(fixedRateOverrideViolation(750_000_000_000_000_000n)).toMatch(/must be a decimal STRING, got 750000000000000000n \(a bigint\)/u);
    expect(fixedRateOverrideViolation({ rate: 1n })).toMatch(/must be a decimal STRING/u);
    // The uint256 bound is exact at 78 digits: the maximum passes, the next integer does not,
    // and a smaller 78-digit value passes (the comparison is on the digits, not the length).
    expect(fixedRateOverrideViolation(`1${"0".repeat(77)}`)).toBeNull();
    expect(fixedRateOverrideViolation(`2${"0".repeat(77)}`)).toMatch(/exceeds uint256/u);
    expect(fixedRateOverrideViolation((UINT256_MAX + 1n).toString())).toMatch(/exceeds uint256/u);
    expect(fixedRateOverrideViolation(`1${"0".repeat(78)}`)).not.toBeNull(); // 79 digits
  });

  it("the template rule: INLINE with a valid rate — a template id, no template, or a bag without the key is refused", () => {
    for (const bad of REJECTED) expect(fixedRateTemplateViolation(template(bad)), JSON.stringify(bad)).not.toBeNull();
    for (const good of ACCEPTED) expect(fixedRateTemplateViolation(template(good))).toBeNull();
    expect(fixedRateTemplateViolation({ market_template_id: "tmpl_1" })).toMatch(/needs an INLINE market template.*a market_template_id alone, or no template, cannot declare the frozen rate/u);
    expect(fixedRateTemplateViolation(undefined)).toMatch(/needs an INLINE market template/u);
    expect(fixedRateTemplateViolation({ inline: { oracle_recipe: FIXED } })).toMatch(/rate_override is required.*got nothing/u);
    expect(fixedRateTemplateViolation({ inline: { oracle_recipe: FIXED, oracle_params: {} } })).toMatch(/got nothing/u);
    // The venue's rule reads the key, not the schema name: any block name passes with a valid rate.
    expect(fixedRateTemplateViolation(template("1075000000000000000", "anything/9"))).toBeNull();
  });

  it("modes must be unique (the venue's refine); the read of a template's rate follows the same value rule", () => {
    expect(rfqModesViolation(["fixed_rate"])).toBeNull();
    expect(rfqModesViolation(["liquidity_only", "liquidity_impairment", "fixed_rate"])).toBeNull();
    expect(rfqModesViolation(["fixed_rate", "fixed_rate"])).toMatch(/fixed_rate is repeated/u);
    expect(rfqModesViolation(["liquidity_only", "fixed_rate", "liquidity_only"])).toMatch(/liquidity_only is repeated/u);
    expect(fixedRateOverrideOfTemplate(template("1075000000000000000"))).toBe(1_075_000_000_000_000_000n);
    expect(fixedRateOverrideOfTemplate(template("1075000000000000000", "cork-inline-liquidity/1"))).toBe(1_075_000_000_000_000_000n);
    for (const bad of REJECTED) expect(fixedRateOverrideOfTemplate(template(bad))).toBeUndefined();
    expect(fixedRateOverrideOfTemplate({ market_template_id: "x" })).toBeUndefined();
  });

  it("the fixed block parses to its own schema and encodes NO recipe bytes (the fixed recipe refuses any payload)", () => {
    const params = inlineParamsOfTemplate({ inline: { oracle_recipe: FIXED, oracle_params: { schema: "cork-inline-fixed/1", rate_override: "1075000000000000000", expiry: "1800000000", swap_fee_wad: "0", unwind_swap_fee_wad: "0" } } })!;
    expect(params).toMatchObject({ schema: "cork-inline-fixed/1", rateOverride: 1_075_000_000_000_000_000n, expiry: 1_800_000_000n });
    expect(inlineAdditionalData(params)).toBeUndefined();
    // An inadmissible rate reads as absent, never as a guess.
    expect(inlineParamsOfTemplate({ inline: { oracle_params: { schema: "cork-inline-fixed/1", rate_override: "01" } } })).toEqual({ schema: "cork-inline-fixed/1" });
  });
});

const impBlock = (over: Record<string, unknown> = {}) => ({ schema: "cork-inline-impairment/1", anchor_rate: ANCHOR.toString(), expiry: "1791209600", swap_fee_wad: "0", unwind_swap_fee_wad: "0", duration_seconds: "1209600", apy_spread_percentage: TEN_PERCENT.toString(), ...over });
const liqBlock = (over: Record<string, unknown> = {}) => ({ schema: "cork-inline-liquidity/1", anchor_rate: ANCHOR.toString(), expiry: "1791209600", swap_fee_wad: "0", unwind_swap_fee_wad: "0", ...over });
const fixBlock = (over: Record<string, unknown> = {}) => ({ schema: "cork-inline-fixed/1", rate_override: "1075000000000000000", expiry: "1791209600", swap_fee_wad: "0", unwind_swap_fee_wad: "0", ...over });
const IMP = { address: IMPAIRMENT, recipeName: "impairment", generation: PRIMARY };
const LIQ = { address: NAV, recipeName: "nav", generation: PRIMARY };
const FIX = { address: FIXED, recipeName: "fixed", generation: PRIMARY };
const read = (modes: RfqMode[], recipe: typeof IMP | undefined, params: Record<string, unknown> | undefined, extra: { unknownRecipe?: `0x${string}`; expiryWindow?: { notBefore: bigint; notAfter: bigint } } = {}) =>
  readRfqCover({ modes, marketTemplate: recipe === undefined && extra.unknownRecipe === undefined ? { market_template_id: "tmpl_1" } : { inline: { oracle_recipe: recipe?.address ?? extra.unknownRecipe, ...(params ? { oracle_params: params } : {}) } }, recipe, ...extra, nowSeconds: NOW });

describe("readRfqCover — what the request itself contradicts (pure, chain-free)", () => {
  it("each cover asked for by its own mode with its own block: the kind, the label, and no warning", () => {
    const imp = read(["liquidity_impairment"], IMP, impBlock());
    expect(imp.warnings).toEqual([]);
    expect(imp.cover).toMatchObject({ kind: "impairment", label: "impairment (credit-risk) cover", recipe: IMPAIRMENT, recipeName: "impairment", generation: PRIMARY, modesAgree: true, requestedModes: ["liquidity_impairment"], protection: COVER_PROTECTION.impairment });
    // The band is arithmetic on the block; the WINDOW is the recipe's to state (data.cover.resolved).
    expect(imp.cover.band).toEqual({ apySpreadPercentage: TEN_PERCENT.toString(), durationSeconds: "1209600", bandPercentage: "383561643835616438" });
    expect(imp.cover.scales!["bandPercentage"]).toMatch(/1e18 = 1%.*WORST-case deductible/u);
    const liq = read(["liquidity_only"], LIQ, liqBlock());
    expect(liq.warnings).toEqual([]);
    expect(liq.cover).toMatchObject({ kind: "liquidity", modesAgree: true });
    expect(liq.cover.band).toBeUndefined();
    expect(liq.cover.fixed).toBeUndefined();
    const fix = read(["fixed_rate"], FIX, fixBlock());
    expect(fix.warnings).toEqual([]);
    expect(fix.cover).toMatchObject({ kind: "fixed-rate", label: "fixed-rate cover", modesAgree: true, fixed: { rateOverride: "1075000000000000000" } });
    expect(fix.cover.scales!["rateOverride"]).toMatch(/ABSOLUTE rate, 1e18 = 1\.0/u);
  });

  it("THE TRAP: an impairment mode on a liquidity recipe creates an exit-only pool — warned alone or beside liquidity_only", () => {
    for (const modes of [["liquidity_impairment"], ["liquidity_only", "liquidity_impairment"]] as RfqMode[][]) {
      const { cover, warnings } = read(modes, LIQ, liqBlock());
      expect(cover).toMatchObject({ kind: "liquidity", modesAgree: false });
      expect(warnings[0]!.code).toBe("cover_mode_mismatch");
      expect(warnings[0]!.message).toMatch(/modes names liquidity_impairment, but the template's recipe .* gives liquidity \(duration-risk\) cover.*pays NOTHING for a loss in the reference/u);
      // Asking for ONLY the wrong mode also names the right one; asking for both does not.
      expect(codes(warnings)).toEqual(modes.length === 1 ? ["cover_mode_mismatch", "cover_mode_mismatch"] : ["cover_mode_mismatch"]);
      if (modes.length === 1) expect(warnings[1]!.message).toMatch(/no requested mode asks for it — name liquidity_only/u);
    }
  });

  it("one template, one alternative: every mode that names another cover is listed, for each kind of template", () => {
    const mixedFixed = read(["liquidity_only", "liquidity_impairment", "fixed_rate"], FIX, fixBlock());
    expect(codes(mixedFixed.warnings)).toEqual(["cover_mode_mismatch"]);
    expect(mixedFixed.warnings[0]!.message).toMatch(/modes names liquidity_only and liquidity_impairment, but the template's recipe .* gives fixed-rate cover.*Ask for fixed_rate alone, and open a separate request for each other cover/u);
    expect(mixedFixed.warnings[0]!.message).toMatch(/expect a pass/u);
    expect(mixedFixed.cover.modesAgree).toBe(false);
    const impAsLiquidity = read(["liquidity_only"], IMP, impBlock());
    expect(codes(impAsLiquidity.warnings)).toEqual(["cover_mode_mismatch", "cover_mode_mismatch"]);
    expect(impAsLiquidity.warnings[1]!.message).toMatch(/name liquidity_impairment/u);
    const fixedOnLiquidity = read(["fixed_rate"], LIQ, liqBlock());
    expect(fixedOnLiquidity.warnings[0]!.message).toMatch(/modes names fixed_rate.*gives liquidity \(duration-risk\) cover/u);
  });

  it("a block written for another cover, and a rate on a recipe that takes none, are named once each", () => {
    const wrongBlock = read(["liquidity_only"], LIQ, impBlock());
    expect(codes(wrongBlock.warnings)).toEqual(["invalid_order_terms"]);
    expect(wrongBlock.warnings[0]!.message).toMatch(/the inline block is cork-inline-impairment\/1, the parameter block of impairment \(credit-risk\) cover, but the recipe .* gives liquidity \(duration-risk\) cover.*Use cork-inline-liquidity\/1, or name the recipe the block belongs to/u);
    // The impairment recipe with a liquidity block: ONE warning (the block), not a second "lacks" one.
    const impWithLiq = read(["liquidity_impairment"], IMP, liqBlock());
    expect(codes(impWithLiq.warnings)).toEqual(["invalid_order_terms"]);
    expect(impWithLiq.cover.band).toBeUndefined();
    const strayRate = read(["liquidity_only"], LIQ, liqBlock({ rate_override: "1075000000000000000" }));
    expect(codes(strayRate.warnings)).toEqual(["invalid_order_terms"]);
    expect(strayRate.warnings[0]!.message).toMatch(/carries rate_override 1075000000000000000, but the recipe .* reads a rate oracle.*REVERTS \(UnexpectedRateOverride\), and the venue does not check this\. Remove rate_override, or name the fixed recipe/u);
    // An INADMISSIBLE value on a non-fixed recipe is named too, without the revert claim: a
    // value that is no rate cannot be carried, so nothing reverts — the key is just not read.
    const notARate = read(["liquidity_impairment"], IMP, impBlock({ rate_override: "0" }));
    expect(codes(notARate.warnings)).toEqual(["invalid_order_terms"]);
    expect(notARate.warnings[0]!.message).toMatch(/carries a rate_override that the recipe .* does not read.*not an admissible rate either/u);
    expect(notARate.warnings[0]!.message).not.toMatch(/REVERTS/u);
    // On the fixed recipe the key is the point, not a stray.
    expect(read(["fixed_rate"], FIX, fixBlock()).warnings).toEqual([]);
    // ...also when the request never names fixed_rate: the modes are named, the rate is not.
    expect(read(["liquidity_only"], FIX, fixBlock()).warnings.some((w) => /rate_override/u.test(w.message))).toBe(false);
    // A request that NAMES fixed_rate must carry the rate whatever recipe its template names
    // (the venue's rule), so there the rate is no stray: "remove rate_override" would be advice
    // the venue refuses. The mode that asks for another cover is still listed.
    const mixed = read(["liquidity_impairment", "fixed_rate"], IMP, impBlock({ rate_override: "1075000000000000000" }));
    expect(codes(mixed.warnings)).toEqual(["cover_mode_mismatch"]);
    expect(mixed.warnings.some((w) => /rate_override/u.test(w.message))).toBe(false);
    // The reader itself: a rate with a reader is passed as `undefined` and nothing is said; a
    // rate without one is judged, for the requester and for the underwriter alike.
    const rate = { raw: "1075000000000000000", admissible: 1075000000000000000n };
    expect(inlineBlockWarnings("liquidity", LIQ.address, undefined, undefined, "requester")).toEqual([]);
    expect(inlineBlockWarnings("liquidity", LIQ.address, undefined, rate, "requester").map((w) => w.code)).toEqual(["invalid_order_terms"]);
    expect(inlineBlockWarnings("liquidity", LIQ.address, undefined, rate, "underwriter")[0]!.message).toMatch(/The rate is NOT carried into this order/u);
    // A block of another cover is still named when the rate is not judged.
    expect(inlineBlockWarnings("liquidity", LIQ.address, inlineParamsOfTemplate({ inline: { oracle_params: impBlock() } }), undefined, "requester").map((w) => w.code)).toEqual(["invalid_order_terms"]);
  });

  it("an impairment block the band cannot be read from: missing, partial, or a band with no window left", () => {
    const noBlock = read(["liquidity_impairment"], IMP, undefined);
    expect(codes(noBlock.warnings)).toEqual(["invalid_order_terms"]);
    expect(noBlock.warnings[0]!.message).toMatch(/needs a cork-inline-impairment\/1 block.*no readable inline block/u);
    expect(noBlock.cover.band).toBeUndefined();
    const partial = read(["liquidity_impairment"], IMP, impBlock({ apy_spread_percentage: undefined }));
    expect(partial.warnings[0]!.message).toMatch(/lacks apy_spread_percentage \(each a positive decimal string\).*never encoded with zeros/u);
    const both = read(["liquidity_impairment"], IMP, impBlock({ apy_spread_percentage: undefined, duration_seconds: undefined }));
    expect(both.warnings[0]!.message).toMatch(/lacks duration_seconds and apy_spread_percentage/u);
    // 100%/yr over a whole year is a band of exactly 100%: no window. One second less has one.
    const full = read(["liquidity_impairment"], IMP, impBlock({ apy_spread_percentage: (100n * WAD).toString(), duration_seconds: "31536000" }));
    expect(full.warnings[0]!.message).toMatch(/is 100% of the anchor or more.*no recipe resolves it/u);
    expect(full.cover.band!.bandPercentage).toBe((100n * WAD).toString());
    expect(read(["liquidity_impairment"], IMP, impBlock({ apy_spread_percentage: (100n * WAD).toString(), duration_seconds: "31535999" })).warnings).toEqual([]);
    // What a recipe ALLOWS below that (a spread cap, a duration cap) is never restated here:
    // a 40-day duration reads clean, and the recipe's own refusal comes from the chain read.
    expect(read(["liquidity_impairment"], IMP, impBlock({ duration_seconds: "3456000" })).warnings).toEqual([]);
  });

  it("a fixed recipe without a usable rate, and the one rate the venue admits and the recipe cannot build", () => {
    const none = read(["fixed_rate"], FIX, { schema: "cork-inline-fixed/1", expiry: "1791209600" });
    expect(codes(none.warnings)).toEqual(["invalid_order_terms"]);
    expect(none.warnings[0]!.message).toMatch(/needs the frozen rate in marketTemplate\.inline\.oracle_params\.rate_override.*"1075000000000000000" = 1\.075/u);
    expect(none.cover.fixed).toEqual({ rateOverride: null });
    const max = read(["fixed_rate"], FIX, fixBlock({ rate_override: UINT256_MAX.toString() }));
    expect(codes(max.warnings)).toEqual(["invalid_order_terms"]);
    expect(max.warnings[0]!.message).toMatch(/is uint256's maximum: the fixed recipe's window is rate \.\. rate \+ 1, which overflows.*the venue admits the value; the chain does not/u);
    expect(max.cover.fixed).toEqual({ rateOverride: UINT256_MAX.toString() });
    expect(read(["fixed_rate"], FIX, fixBlock({ rate_override: (UINT256_MAX - 1n).toString() })).warnings).toEqual([]);
  });

  it("the block's pool expiry against the request's own window and the clock", () => {
    const window = { notBefore: 1_791_209_599n, notAfter: 1_791_209_600n };
    expect(read(["fixed_rate"], FIX, fixBlock(), { expiryWindow: window }).warnings).toEqual([]);
    expect(read(["fixed_rate"], FIX, fixBlock({ expiry: "1791209599" }), { expiryWindow: window }).warnings).toEqual([]);
    const late = read(["fixed_rate"], FIX, fixBlock({ expiry: "1791209601" }), { expiryWindow: window });
    expect(late.warnings[0]!.message).toMatch(/pool expiry 1791209601, outside the request's own expiryWindow \[1791209599, 1791209600\].*ask for different pools/u);
    const early = read(["liquidity_only"], LIQ, liqBlock({ expiry: "1791209598" }), { expiryWindow: window });
    expect(early.warnings[0]!.message).toMatch(/outside the request's own expiryWindow/u);
    const past = read(["liquidity_only"], LIQ, liqBlock({ expiry: NOW.toString() }), { expiryWindow: window });
    expect(past.warnings[0]!.message).toMatch(/not in the future \(now 1790000000\)/u);
    expect(read(["liquidity_only"], LIQ, liqBlock({ expiry: (NOW + 1n).toString() })).warnings).toEqual([]);
  });

  it("a template id, and a recipe no configured generation names, are `unknown` — never guessed, never warned here", () => {
    const byId = read(["fixed_rate"], undefined, undefined);
    expect(byId.cover).toEqual({ kind: "unknown", decidedBy: expect.stringMatching(/market_template_id names a pool/u), requestedModes: ["fixed_rate"], modesAgree: null });
    expect(byId.warnings).toEqual([]);
    const foreign = read(["liquidity_only"], undefined, impBlock(), { unknownRecipe: "0x00000000000000000000000000000000000000ee" });
    expect(foreign.cover).toMatchObject({ kind: "unknown", recipe: "0x00000000000000000000000000000000000000ee", modesAgree: null });
    expect(foreign.cover.decidedBy).toMatch(/not one a configured generation names/u);
    expect(foreign.warnings).toEqual([]);
    // A configured recipe whose hint names no cover reads as unknown too, with its address.
    const odd = readRfqCover({ modes: ["liquidity_only"], marketTemplate: { inline: { oracle_recipe: NAV } }, recipe: { address: NAV, recipeName: "exotic", generation: PRIMARY }, nowSeconds: NOW });
    expect(odd.cover).toMatchObject({ kind: "unknown", recipe: NAV });
  });

  it("withResolvedConstraint attaches the recipe's answer and labels its scale beside the scales already there", () => {
    const { cover } = read(["fixed_rate"], FIX, fixBlock());
    const resolved = { source: "fixed", oracle: { address: FIXED, deployed: false, rate: null }, constraint: { rateMin: "1075000000000000000", rateMax: "1075000000000000001", rateChangePerDayMax: "0", rateChangeCapacityMax: "0" } };
    withResolvedConstraint(cover, resolved);
    expect(cover.resolved).toEqual(resolved);
    expect(cover.scales!["resolved"]).toMatch(/ABSOLUTE rates, 1e18 = 1\.0.*rateMin is the worst rate the holder can ever swap at/u);
    expect(cover.scales!["rateOverride"]).toBeDefined();
  });
});

// ── the reference's unreported loss ────────────────────────────────────────────────────────────
const REF = "0xE74c499fA461AF1844fCa84204490877787cED56" as const; // YCSUSDC on Base
const BLOCK = 52_038_242n;
const transport = (m = "fetch failed") => Object.assign(new Error(m), { name: "HttpRequestError" });
type Answer = bigint | Error;
/** A vault that answers each view from a table, records every call, and can fail in transport. */
function vault(answers: Partial<Record<"lostAssets" | "totalAssets" | "balanceOf" | "convertToAssets", Answer>>, block: bigint | Error = BLOCK) {
  const calls: Array<{ functionName: string; blockNumber?: bigint; args?: readonly unknown[] }> = [];
  return {
    calls,
    getBlockNumber: async () => {
      if (block instanceof Error) throw block;
      return block;
    },
    readContract: async (a: { functionName: string; blockNumber?: bigint; args?: readonly unknown[] }) => {
      calls.push({ functionName: a.functionName, ...(a.blockNumber !== undefined ? { blockNumber: a.blockNumber } : {}), ...(a.args ? { args: a.args } : {}) });
      const v = answers[a.functionName as "lostAssets"];
      if (v === undefined) throw new Error(`execution reverted: no ${a.functionName}`);
      if (v instanceof Error) throw v;
      return v;
    },
  };
}
// YCSUSDC read on Base 2026-10-01: the counter, the reported total, and the value of the shares
// the vault owner supplied to address(1) the day after the loss.
const YCS = { lostAssets: 131_382_052n, totalAssets: 701_852_210_909n, balanceOf: 130_677_114_637_008_347_797n, convertToAssets: 140_548_086n };
const loss = (o: Partial<UnreportedLoss> = {}): UnreportedLoss => ({ lostAssets: 131_382_052n, totalAssets: 701_674_000_000n, coveredAssets: 0n, openShortfall: 131_382_052n, blockNumber: BLOCK, ...o });

describe("a reference whose share price does not report its losses (MetaMorpho v1.1 lostAssets)", () => {
  it("reads the counter AND the cover held by address(1), every read pinned to ONE block", async () => {
    const v = vault(YCS);
    expect(await readUnreportedLoss(v, REF)).toEqual({ status: "read", loss: { lostAssets: 131_382_052n, totalAssets: 701_852_210_909n, coveredAssets: 140_548_086n, openShortfall: 0n, blockNumber: BLOCK } });
    expect(v.calls.map((c) => c.functionName)).toEqual(["lostAssets", "totalAssets", "balanceOf", "convertToAssets"]);
    // A loss or a cover landing mid-read cannot pair a new counter with an old cover.
    for (const c of v.calls) expect(c.blockNumber).toBe(BLOCK);
    expect(v.calls[2]!.args).toEqual(["0x0000000000000000000000000000000000000001"]);
    expect(v.calls[3]!.args).toEqual([YCS.balanceOf]);
  });

  it("the open shortfall is counter − cover, floored at zero; no shares at address(1) = nothing covered and convertToAssets not asked", async () => {
    expect(await readUnreportedLoss(vault({ ...YCS, convertToAssets: 31_382_052n }), REF)).toMatchObject({ status: "read", loss: { coveredAssets: 31_382_052n, openShortfall: 100_000_000n } });
    expect(await readUnreportedLoss(vault({ ...YCS, convertToAssets: YCS.lostAssets }), REF)).toMatchObject({ loss: { openShortfall: 0n } });
    expect(await readUnreportedLoss(vault({ ...YCS, convertToAssets: YCS.lostAssets - 1n }), REF)).toMatchObject({ loss: { openShortfall: 1n } });
    const none = vault({ lostAssets: 131_382_052n, totalAssets: 701_852_210_909n, balanceOf: 0n });
    expect(await readUnreportedLoss(none, REF)).toMatchObject({ status: "read", loss: { coveredAssets: 0n, openShortfall: 131_382_052n } });
    expect(none.calls.map((c) => c.functionName)).not.toContain("convertToAssets");
  });

  it("a ZERO counter records no loss: nothing is asked of address(1), and the cover reads as 0, not as unread", async () => {
    const v = vault({ lostAssets: 0n, totalAssets: 329_960_189_000_000n, balanceOf: new Error("must not be asked"), convertToAssets: new Error("must not be asked") });
    expect(await readUnreportedLoss(v, REF)).toEqual({ status: "read", loss: { lostAssets: 0n, totalAssets: 329_960_189_000_000n, coveredAssets: 0n, openShortfall: 0n, blockNumber: BLOCK } });
    expect(v.calls.map((c) => c.functionName)).toEqual(["lostAssets", "totalAssets"]);
  });

  it("three outcomes that are never confused: the view is ABSENT (it reverted), NOBODY KNOWS (transport), and the cover alone unread", async () => {
    // The vault has no such view: its call reverts.
    expect(await readUnreportedLoss(vault({ totalAssets: 5n }), REF)).toEqual({ status: "absent" });
    // lostAssets() answers and totalAssets() reverts: not a vault this reading knows.
    expect(await readUnreportedLoss(vault({ lostAssets: 1n }), REF)).toEqual({ status: "absent" });
    // The RPC failed: no verdict on the vault. Only POSITIVE evidence of a revert is `absent`:
    // a node error that is neither (a lagging node without the pinned block, a rate limit) is
    // unread too — an outage must never read as "this vault has no such view".
    expect(await readUnreportedLoss(vault({ ...YCS, lostAssets: Object.assign(new Error("header not found"), { name: "RpcRequestError" }) }), REF)).toEqual({ status: "unread", reason: "header not found" });
    expect(await readUnreportedLoss(vault({ ...YCS, lostAssets: new Error("something unexpected") }), REF)).toEqual({ status: "unread", reason: "something unexpected" });
    expect(await readUnreportedLoss(vault({ ...YCS, lostAssets: Object.assign(new Error("the call reverted"), { name: "ContractFunctionExecutionError", cause: Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError" }) }) }), REF)).toEqual({ status: "absent" });
    expect(await readUnreportedLoss(vault({ ...YCS, lostAssets: Object.assign(new Error("returned no data"), { name: "ContractFunctionZeroDataError" }) }), REF)).toEqual({ status: "absent" });
    expect(await readUnreportedLoss(vault(YCS, transport("block read failed")), REF)).toEqual({ status: "unread", reason: "block read failed" });
    expect(await readUnreportedLoss(vault({ ...YCS, lostAssets: transport("socket hang up") }), REF)).toEqual({ status: "unread", reason: "socket hang up" });
    expect(await readUnreportedLoss(vault({ ...YCS, totalAssets: transport("timeout") }), REF)).toEqual({ status: "unread", reason: "timeout" });
    // The counter read, the cover did not (a revert or a transport fault alike): the WHOLE
    // counter is reported open, labeled by coveredAssets null.
    for (const fault of [new Error("execution reverted"), transport()]) {
      expect(await readUnreportedLoss(vault({ ...YCS, balanceOf: fault }), REF)).toEqual({ status: "read", loss: { lostAssets: 131_382_052n, totalAssets: 701_852_210_909n, coveredAssets: null, openShortfall: 131_382_052n, blockNumber: BLOCK } });
      expect(await readUnreportedLoss(vault({ ...YCS, convertToAssets: fault }), REF)).toMatchObject({ status: "read", loss: { coveredAssets: null, openShortfall: 131_382_052n } });
    }
  });

  it("one classification for every consumer: none | cover-unread | covered | open — a zero counter is `none` whatever else was read", () => {
    expect(unreportedLossState(loss({ lostAssets: 0n, coveredAssets: null, openShortfall: 0n }))).toBe("none");
    expect(unreportedLossState(loss({ lostAssets: 0n, coveredAssets: 0n, openShortfall: 0n }))).toBe("none");
    expect(unreportedLossState(loss({ coveredAssets: null }))).toBe("cover-unread");
    expect(unreportedLossState(loss({ coveredAssets: 140_548_086n, openShortfall: 0n }))).toBe("covered");
    expect(unreportedLossState(loss({ coveredAssets: 31_382_052n, openShortfall: 100_000_000n }))).toBe("open");
    expect(unreportedLossState(loss())).toBe("open");
    expect(referenceLossReading(loss({ coveredAssets: null }))).toMatchObject({ reportedInSharePrice: false, state: "cover-unread", lostAssets: "131382052", totalAssets: "701674000000", coveredAssets: null, openShortfall: "131382052", blockNumber: BLOCK.toString() });
    expect(referenceLossReading(loss({ coveredAssets: 5n })).coveredAssets).toBe("5");
  });

  it("the share is exact integer math over the OPEN shortfall (1e8 = 100%), and each side reads its own consequence in each state", () => {
    expect(unreportedLossShare(loss())).toBe(18_724n); // 0.018724%
    expect(unreportedLossShare({ openShortfall: 1n, totalAssets: 0n })).toBe(0n);
    expect(unreportedLossShare({ openShortfall: 5n, totalAssets: 10n })).toBe(50_000_000n);
    const req = unreportedLossWarning(REF, loss(), "requester");
    expect(req.code).toBe("reference_loss_unreported");
    expect(req.message).toMatch(/this pool's NAV rate oracle reads the reported price/u);
    expect(req.message).toMatch(/cover 0 of it, and 131382052 of 701674000000 reported total assets is OPEN shortfall \(0\.018724%/u);
    expect(req.message).toMatch(/you can still swap at the reported price.*the underwriter carries an open shortfall/u);
    const uw = unreportedLossWarning(REF, loss(), "underwriter");
    expect(uw.message).toMatch(/You carry an open shortfall/u);
    expect(uw.message).not.toMatch(/you can still swap/u);
    const covered = unreportedLossWarning(REF, loss({ totalAssets: 701_852_210_909n, coveredAssets: 140_548_086n, openShortfall: 0n }), "underwriter");
    expect(covered.message).toMatch(/counter reads 131382052 \(the counter never decreases\) and the shares held by address\(1\) are worth 140548086, so that loss is COVERED: no shortfall is open today/u);
    expect(covered.message).not.toMatch(/is OPEN shortfall|treated as OPEN/u);
    expect(covered.message).toMatch(/You would carry a future uncovered loss/u);
    expect(covered.message).not.toMatch(/You carry an open shortfall/u);
    const none = unreportedLossWarning(REF, loss({ lostAssets: 0n, coveredAssets: 0n, openShortfall: 0n }), "requester");
    expect(none.message).toMatch(/counter reads 0: no loss is recorded today/u);
    expect(none.message).toMatch(/the underwriter would carry a future uncovered loss/u);
    expect(none.message).not.toMatch(/COVERED/u);
    const unread = unreportedLossWarning(REF, loss({ coveredAssets: null }), "requester");
    expect(unread.message).toMatch(/could not be read, so the whole counter is treated as OPEN \(0\.018724%\)/u);
    // Nothing was ESTABLISHED about the cover: the burden is worded as possible, not as present.
    expect(unread.message).toMatch(/the underwriter may carry an open shortfall \(the cover was not read\)/u);
    expect(unread.message).not.toMatch(/the underwriter carries an open shortfall/u);
    expect(unreportedLossWarning(REF, loss({ coveredAssets: null }), "underwriter").message).toMatch(/You may carry an open shortfall up to the cover size \(the cover was not read\)/u);
  });
});

// ── rfq-open against the stub chain + venue (chain 42161) ──────────────────────────────────────
const STUB_EXPIRY = Number(RFQ_IMPAIRMENT_EXPIRY); // NOW + 7 days + 1 hour: creatable
const ORACLE_RATE = 800_000_000_000_000_000n; // the stub pair oracle's rate()
type Seen = { url: string; body: Record<string, unknown> };
type Rpc = NonNullable<Awaited<ReturnType<NonNullable<HandlerContext["resolveRpc"]>>>>;
/** The stub context, counting venue POSTs, with an optional wrapper around the chain client. */
function world(over: { client?: (inner: Rpc["client"]) => Record<string, unknown>; resolveRpc?: HandlerContext["resolveRpc"] } = {}) {
  const stub = stubContext();
  const posts: Seen[] = [];
  const ctx: HandlerContext = {
    ...stub,
    venueFetch: async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return stub.venueFetch!(url, init);
    },
    resolveRpc: over.resolveRpc ?? (async (chainId, url) => {
      const r = (await stub.resolveRpc!(chainId, url))!;
      return over.client ? ({ ...r, client: { ...r.client, ...over.client(r.client) } } as typeof r) : r;
    }),
  };
  return { ctx, posts };
}
let seq = 0;
const openOn = (w: ReturnType<typeof world>, action: Record<string, unknown>) =>
  runTool(
    "cork_submit",
    {
      chainId: 42161,
      clientRequestId: `cover-open-${++seq}`,
      action: { type: "rfq-open", requester: DEMO_ACCOUNT, referenceAsset: JIT_TASK_PAIR.referenceAsset, collateralAsset: { exact: JIT_TASK_PAIR.collateralAsset }, modes: ["fixed_rate"], packageIds: ["balanced-v1"], expiryWindow: { notBefore: STUB_EXPIRY - 1, notAfter: STUB_EXPIRY }, notionalAssets: "1000000000", validUntil: Number(NOW) + 86_400, signature: "0x", ...action },
    },
    w.ctx,
  );
const stubFixed = (rate: unknown) => ({ inline: { oracle_recipe: FIXED_RECIPE, oracle_params: { schema: "cork-inline-fixed/1", rate_override: rate, expiry: String(STUB_EXPIRY), swap_fee_wad: "0", unwind_swap_fee_wad: "0" } } });
const stubImpairment = (over: Record<string, unknown> = {}) => ({ inline: { oracle_recipe: IMPAIRMENT_RECIPE, oracle_params: { schema: "cork-inline-impairment/1", anchor_rate: "700000000000000000", expiry: String(STUB_EXPIRY), swap_fee_wad: "0", unwind_swap_fee_wad: "0", duration_seconds: "604800", apy_spread_percentage: TEN_PERCENT.toString(), ...over } } });
const stubLiquidity = (over: Record<string, unknown> = {}) => ({ inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: { schema: "cork-inline-liquidity/1", anchor_rate: "700000000000000000", expiry: String(STUB_EXPIRY), swap_fee_wad: "0", unwind_swap_fee_wad: "0", ...over } } });
type Cover = CoverReading;
const coverOf = (env: { data: unknown }) => (env.data as { cover: Cover }).cover;

describe("cork_submit rfq-open, fixed-rate (cork-api 0.4.4) — refused where the venue refuses, relayed with the recipe's own answer", () => {
  it("a fixed-rate request below the reference's rate: relayed verbatim, the constraint from the deploy-then-resolve simulation, the deductible named", async () => {
    const w = world();
    const env = await openOn(w, { marketTemplate: stubFixed("750000000000000000") });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]!.body["modes"]).toEqual(["fixed_rate"]);
    expect(w.posts[0]!.body["market_template"]).toEqual(stubFixed("750000000000000000"));
    const cover = coverOf(env);
    expect(cover).toMatchObject({ kind: "fixed-rate", modesAgree: true, recipe: FIXED_RECIPE });
    // No FixedRateOracle exists at this rate: a plain recipe.resolve reverts RateOracleNotDeployed,
    // so the answer can only come from the simulation that deploys it first.
    expect(cover.resolved).toEqual({
      source: "fixed",
      oracle: { address: predictedFixedOracle(750_000_000_000_000_000n), deployed: false, rate: null },
      constraint: { rateMin: "750000000000000000", rateMax: "750000000000000001", rateChangePerDayMax: "0", rateChangeCapacityMax: "0" },
    });
    expect(cover.fixed).toEqual({ rateOverride: "750000000000000000", liveRate: ORACLE_RATE.toString(), liveRateSource: "nav", position: "below", gapPercentage: "6250000000000000000" });
    expect(cover.notRead).toBeUndefined();
    expect(cover.referenceLoss).toBeUndefined(); // a fixed rate reads no feed
    expect(codes(env.warnings)).toEqual(["recipe_generation_notice"]);
  });

  it("a rate ABOVE the reference's rate is relayed and the requester is told the cover pays at once", async () => {
    const w = world();
    const env = await openOn(w, { marketTemplate: stubFixed("900000000000000000") });
    expect(env.state).toBe("ok");
    expect(w.posts).toHaveLength(1);
    expect(coverOf(env).fixed).toMatchObject({ position: "above", gapPercentage: "12500000000000000000" });
    expect(codes(env.warnings)).toEqual(["recipe_generation_notice", "fixed_rate_in_the_money"]);
    expect(env.warnings[1]!.message).toMatch(/12\.5000% ABOVE.*An underwriter prices that gap as a certain payout or passes/u);
    // AT the rate there is no gap to warn about.
    const at = await openOn(world(), { marketTemplate: stubFixed(ORACLE_RATE.toString()) });
    expect(coverOf(at).fixed).toMatchObject({ position: "at", gapPercentage: "0" });
    expect(codes(at.warnings)).toEqual(["recipe_generation_notice"]);
  });

  it("the venue's refusals are refused here first, with NOTHING relayed: an inadmissible rate, a template id, no template, a repeated mode", async () => {
    for (const bad of ["0", "01", "1.5", "1e18", "0x01", "", "-1", (2n ** 256n).toString()]) {
      const w = world();
      const env = await openOn(w, { marketTemplate: stubFixed(bad) });
      expect(env.state, bad).toBe("unavailable");
      expect(env.warnings[0]!.code).toBe("invalid_order_terms");
      expect(env.warnings[0]!.message).toMatch(/modes names fixed_rate, and market_template\.inline\.oracle_params\.rate_override is required.*The venue refuses the request without it \(cork-api 0\.4\.4\)/u);
      expect(w.posts).toHaveLength(0);
    }
    const byId = world();
    expect((await openOn(byId, { marketTemplate: { market_template_id: "tmpl_1" } })).warnings[0]!.message).toMatch(/modes names fixed_rate, and fixed-rate cover needs an INLINE market template/u);
    expect(byId.posts).toHaveLength(0);
    const none = world();
    expect((await openOn(none, {})).state).toBe("unavailable");
    expect(none.posts).toHaveLength(0);
    // The rule is keyed on the MODE: fixed_rate beside another mode still needs the rate.
    const mixedNoRate = world();
    expect((await openOn(mixedNoRate, { modes: ["liquidity_only", "fixed_rate"], marketTemplate: stubLiquidity() })).state).toBe("unavailable");
    expect(mixedNoRate.posts).toHaveLength(0);
    const dup = world();
    const dupEnv = await openOn(dup, { modes: ["fixed_rate", "fixed_rate"], marketTemplate: stubFixed("750000000000000000") });
    expect(dupEnv.state).toBe("unavailable");
    expect(dupEnv.warnings[0]!.message).toMatch(/fixed_rate is repeated/u);
    expect(dup.posts).toHaveLength(0);
    // Four modes cannot be unique over three names: the input schema refuses the count itself.
    await expect(openOn(world(), { modes: ["liquidity_only", "liquidity_impairment", "fixed_rate", "fixed_rate"], marketTemplate: stubFixed("1") })).rejects.toThrow();
    // Without the fixed_rate mode the rate rule does not apply: a template id is relayed as before.
    const other = world();
    expect((await openOn(other, { modes: ["liquidity_only"], marketTemplate: { market_template_id: "tmpl_1" } })).state).toBe("ok");
    expect(other.posts).toHaveLength(1);
  });

  it("mixed modes with one fixed template are relayed with cover_mode_mismatch; a rate on a liquidity recipe is relayed and named", async () => {
    const mixed = world();
    const env = await openOn(mixed, { modes: ["liquidity_only", "fixed_rate"], marketTemplate: stubFixed("750000000000000000") });
    expect(env.state).toBe("ok");
    expect(mixed.posts).toHaveLength(1);
    expect(codes(env.warnings)).toEqual(["recipe_generation_notice", "cover_mode_mismatch"]);
    expect(coverOf(env).modesAgree).toBe(false);
    const stray = world();
    const strayEnv = await openOn(stray, { modes: ["liquidity_only"], marketTemplate: stubLiquidity({ rate_override: "750000000000000000" }) });
    expect(strayEnv.state).toBe("ok");
    expect(stray.posts).toHaveLength(1);
    expect(strayEnv.warnings.find((x) => x.code === "invalid_order_terms")!.message).toMatch(/UnexpectedRateOverride/u);
    // The recipe is still asked — WITHOUT the stray rate — and answers its liquidity window.
    expect(coverOf(strayEnv).resolved!.constraint.rateMin).toBe("1");
  });

  it("uint256's maximum: the venue admits it, the request is relayed, and BOTH the reading and the recipe say it cannot be built", async () => {
    const w = world();
    const env = await openOn(w, { marketTemplate: stubFixed(UINT256_MAX.toString()) });
    expect(env.state).toBe("ok");
    expect(w.posts).toHaveLength(1);
    // …and such a rate is far above any reference's rate, which the moneyness read says too.
    expect(codes(env.warnings)).toEqual(["recipe_generation_notice", "invalid_order_terms", "recipe_refused", "fixed_rate_in_the_money"]);
    expect(env.warnings[2]!.message).toMatch(/the recipe does not resolve this request as written.*Panic\(17\)/u);
    expect(coverOf(env).resolved).toBeUndefined();
    expect(coverOf(env).fixed!.position).toBe("above");
  });

  it("an endpoint that cannot simulate is NOT the recipe's refusal: it is listed as not read; a deploy that would revert is a fact about the oracle — and neither blocks the relay", async () => {
    const noSim = world({ client: () => ({ simulateCalls: async () => { throw new Error("the method eth_simulateV1 does not exist"); } }) });
    const a = await openOn(noSim, { marketTemplate: stubFixed("750000000000000000") });
    expect(a.state).toBe("ok");
    expect(noSim.posts).toHaveLength(1);
    // Nothing was established about the request: no warning accuses it.
    expect(codes(a.warnings)).toEqual(["recipe_generation_notice"]);
    expect(coverOf(a).notRead).toHaveLength(1);
    expect(coverOf(a).notRead![0]).toMatch(/^recipe\.resolve: .*the deploy-then-resolve simulation could not run on this endpoint \(.*eth_simulateV1.*\), so the constraint was NOT resolved.*deploy the oracle first \(cork_prepare_market deploy-fixed-oracle/u);
    expect(coverOf(a).resolved).toBeUndefined();
    // The moneyness read does not depend on the simulation.
    expect(coverOf(a).fixed).toMatchObject({ position: "below" });
    const badDeploy = world({ client: () => ({ simulateCalls: async () => ({ results: [{ status: "failure", data: "0x", error: new Error("out of gas") }, { status: "failure", data: "0x" }] }) }) });
    const b = await openOn(badDeploy, { marketTemplate: stubFixed("750000000000000000") });
    expect(b.state).toBe("ok");
    const deploy = b.warnings.find((x) => x.code === "oracle_not_deployable")!;
    expect(deploy.message).toMatch(/^the request cannot be resolved against the chain as it stands today — .*is not deployed and its deploy would revert: the registry's oracle deploy failed: out of gas/u);
    expect(deploy.message).not.toMatch(/the recipe does not resolve this request as written/u);
    // A simulation whose deploy leg is green and whose resolve leg returns nothing is the recipe's refusal, not a constraint.
    const emptyResolve = world({ client: () => ({ simulateCalls: async () => ({ results: [{ status: "success", data: "0x" }, { status: "success" }] }) }) });
    const c = await openOn(emptyResolve, { marketTemplate: stubFixed("750000000000000000") });
    expect(c.warnings.find((x) => x.code === "recipe_refused")!.message).toMatch(/^the recipe does not resolve this request as written/u);
    expect(coverOf(c).resolved).toBeUndefined();
  });

  it("a rate whose FixedRateOracle ALREADY exists resolves by a plain read against it — the same window, the oracle named as deployed", async () => {
    const w = world();
    const env = await openOn(w, { marketTemplate: stubFixed(DEPLOYED_FIXED_RATE.toString()) });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(coverOf(env).resolved).toEqual({
      source: "fixed",
      oracle: { address: predictedFixedOracle(DEPLOYED_FIXED_RATE), deployed: true, rate: DEPLOYED_FIXED_RATE.toString() },
      constraint: { rateMin: DEPLOYED_FIXED_RATE.toString(), rateMax: (DEPLOYED_FIXED_RATE + 1n).toString(), rateChangePerDayMax: "0", rateChangeCapacityMax: "0" },
    });
    // 0.5 against 0.8: 37.5% below.
    expect(coverOf(env).fixed).toMatchObject({ position: "below", gapPercentage: "37500000000000000000" });
    // The plain path must not run a simulation it does not need.
    let simulated = 0;
    const counting = world({ client: (inner) => ({ simulateCalls: async (x: unknown) => { simulated++; return (inner.simulateCalls as (y: unknown) => Promise<unknown>)(x); } }) });
    await openOn(counting, { marketTemplate: stubFixed(DEPLOYED_FIXED_RATE.toString()) });
    expect(simulated).toBe(0);
    await openOn(counting, { marketTemplate: stubFixed("750000000000000000") });
    expect(simulated).toBe(1);
  });

  it("a rate handed over as a BIGINT (the SDK path) is refused in words, never thrown", async () => {
    const w = world();
    const env = await openOn(w, { marketTemplate: stubFixed(750_000_000_000_000_000n) });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.message).toMatch(/it must be a decimal STRING, got 750000000000000000n \(a bigint\)/u);
    expect(w.posts).toHaveLength(0);
  });
});

describe("cork_submit rfq-answer — a fixed_rate option carries its OWN frozen rate (cork-api 0.4.4)", () => {
  const option = (over: Record<string, unknown>) => ({ option_id: "opt1", chain_id: 42161, collateral_asset: JIT_TASK_PAIR.collateralAsset, reference_asset: JIT_TASK_PAIR.referenceAsset, mode: "fixed_rate", package_id: "balanced-v1", expiry: STUB_EXPIRY, premium_annualized: "0.05", notional_max_assets: "1000000000", fresh_until: Number(NOW) + 600, ...over });
  const post = (w: ReturnType<typeof world>, options: Array<Record<string, unknown>>) => runTool("cork_submit", { chainId: 42161, clientRequestId: `cover-answer-${++seq}`, action: { type: "rfq-answer", rfqId: "rfq_open7", underwriter: DEMO_ACCOUNT, status: "quoted", options, signature: "0x" } }, w.ctx);

  it("an option with its template and rate is relayed verbatim; another rate than the request's is the option's to propose", async () => {
    const w = world();
    const options = [option({ market_template: stubFixed("750000000000000000") }), option({ option_id: "opt2", market_template: stubFixed("740000000000000000") })];
    const env = await post(w, options);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]!.body["options"]).toEqual(options);
  });

  it("a fixed_rate option without an admissible rate is refused before relay, naming the option — whichever option it is", async () => {
    for (const bad of [{ market_template: { market_template_id: "tmpl_1" } }, {}, { market_template: stubFixed("01") }, { market_template: stubFixed(undefined) }]) {
      const w = world();
      const env = await post(w, [option({ market_template: stubFixed("750000000000000000") }), option({ option_id: "opt2", ...bad })]);
      expect(env.state, JSON.stringify(bad)).toBe("unavailable");
      expect(env.warnings[0]!.code).toBe("invalid_order_terms");
      expect(env.warnings[0]!.message).toMatch(/options\[1\]\.mode is fixed_rate, and .*The venue refuses the answer without it \(cork-api 0\.4\.4\)/u);
      expect(w.posts).toHaveLength(0);
    }
  });

  it("the rule is keyed on the option's MODE: another mode with a template id, or with a stray rate, is relayed", async () => {
    const w = world();
    expect((await post(w, [option({ mode: "liquidity_only", market_template: { market_template_id: "tmpl_1" } })])).state).toBe("ok");
    expect((await post(w, [option({ mode: "liquidity_impairment", market_template: stubFixed("01") })])).state).toBe("ok");
    // The venue checks the KEY, not the recipe: a fixed_rate option naming a liquidity recipe
    // with a valid rate is admitted there, so it is relayed here (answer-rfq names the revert).
    expect((await post(w, [option({ market_template: { inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: { rate_override: "750000000000000000" } } } })])).state).toBe("ok");
    expect(w.posts).toHaveLength(3);
  });

  it("an option's mode is the venue's enum: a misspelled mode is refused before relay (it would also slip past the fixed-rate rule)", async () => {
    const w = world();
    const env = await post(w, [option({ mode: "fixed-rate", market_template: { market_template_id: "tmpl_1" } })]);
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.message).toMatch(/options\[0\]\.mode must be one of liquidity_only, liquidity_impairment, fixed_rate — got "fixed-rate"/u);
    expect(w.posts).toHaveLength(0);
    // An option that names no mode is the venue's to judge (its schema requires the field): relayed.
    const { mode: _none, ...noMode } = option({ market_template: { market_template_id: "tmpl_1" } });
    expect((await post(w, [noMode])).state).toBe("ok");
  });
});

describe("cork_submit rfq-open — the chain's side of the reading (best-effort, never blocking, never silent about what it missed)", () => {
  it("the impairment recipe's own window rides the result: the same four limits cork_compute returns for the same bytes", async () => {
    const w = world();
    const env = await openOn(w, { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const cover = coverOf(env);
    expect(cover.kind).toBe("impairment");
    expect(cover.band).toEqual({ apySpreadPercentage: TEN_PERCENT.toString(), durationSeconds: "604800", bandPercentage: "191780821917808219" });
    const direct = await runTool("cork_compute", { chainId: 42161, params: { kind: "recipe-rate-constraint", recipe: IMPAIRMENT_RECIPE, collateralAsset: JIT_TASK_PAIR.collateralAsset, referenceAsset: JIT_TASK_PAIR.referenceAsset, argsUints: ["700000000000000000", "604800", TEN_PERCENT.toString()] } }, w.ctx);
    const want = (direct.data as { constraint: Record<string, bigint | string> }).constraint;
    for (const k of ["rateMin", "rateMax", "rateChangePerDayMax", "rateChangeCapacityMax"] as const) expect(cover.resolved!.constraint[k]).toBe(String(want[k]));
    expect(cover.resolved!.source).toBe("nav");
    expect(cover.resolved!.oracle).toMatchObject({ deployed: true, rate: ORACLE_RATE.toString() });
    // The window is a BAND around the deployed oracle's rate — the carried 0.7 anchor is ignored.
    const c = cover.resolved!.constraint;
    expect(BigInt(c.rateMin) < ORACLE_RATE && ORACLE_RATE < BigInt(c.rateMax)).toBe(true);
    expect(coverKindOfConstraint({ rateMin: BigInt(c.rateMin), rateChangePerDayMax: BigInt(c.rateChangePerDayMax), rateChangeCapacityMax: BigInt(c.rateChangeCapacityMax) })).toBe("impairment");
    expect(cover.scales!["resolved"]).toMatch(/a carried anchor_rate is then ignored/u);
  });

  it("a request the RECIPE refuses is relayed with the recipe's own error — a 40-day duration on a recipe that caps it at 30", async () => {
    const w = world();
    const env = await openOn(w, { modes: ["liquidity_impairment"], marketTemplate: stubImpairment({ duration_seconds: "3456000" }) });
    expect(env.state).toBe("ok");
    expect(w.posts).toHaveLength(1);
    expect(codes(env.warnings)).toEqual(["recipe_generation_notice", "recipe_refused"]);
    expect(env.warnings[1]!.message).toMatch(/the recipe does not resolve this request as written, so an underwriter that derives the pool from it fails the same way — .*DurationTooLong\(3456000, 2592000\)/u);
    expect(coverOf(env).resolved).toBeUndefined();
    expect(coverOf(env).band!.durationSeconds).toBe("3456000"); // the arithmetic reading stays
  });

  it("an unbuildable block is not sent to the recipe; a block of another cover does not lend its bytes", async () => {
    let resolves = 0;
    const counting = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => { if (a.functionName === "resolve") resolves++; return (inner.readContract as (x: unknown) => Promise<unknown>)(a); } });
    const partial = await openOn(world({ client: counting }), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment({ apy_spread_percentage: undefined }) });
    expect(partial.state).toBe("ok");
    expect(resolves).toBe(0);
    expect(coverOf(partial).resolved).toBeUndefined();
    // A liquidity recipe under an impairment BLOCK: the recipe is asked with NO bytes (the
    // block's three words are another recipe's), and still answers its own window.
    const seen: unknown[] = [];
    const spy = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string; args?: unknown[] }) => { if (a.functionName === "resolve") seen.push(a.args?.[3]); return (inner.readContract as (x: unknown) => Promise<unknown>)(a); } });
    const wrong = await openOn(world({ client: spy }), { modes: ["liquidity_only"], marketTemplate: { inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: stubImpairment().inline.oracle_params } } });
    expect(seen).toEqual(["0x"]);
    expect(coverOf(wrong).resolved!.constraint.rateMin).toBe("1");
  });

  it("only a NAV-sourced recipe gets the loss reading: the impairment recipe (nav) does, the price-sourced liquidity recipe does not", async () => {
    const lossy = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => (a.functionName in YCS ? YCS[a.functionName as keyof typeof YCS] : (inner.readContract as (x: unknown) => Promise<unknown>)(a)) });
    const nav = await openOn(world({ client: lossy }), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(coverOf(nav).referenceLoss).toMatchObject({ reportedInSharePrice: false, state: "covered", lostAssets: "131382052", coveredAssets: "140548086", openShortfall: "0", blockNumber: "23000000" });
    expect(codes(nav.warnings)).toEqual(["recipe_generation_notice", "reference_loss_unreported"]);
    expect(nav.warnings[1]!.message).toMatch(/no shortfall is open today.*you can still swap at the reported price/u);
    const price = await openOn(world({ client: lossy }), { modes: ["liquidity_only"], marketTemplate: stubLiquidity() });
    expect(coverOf(price).resolved!.source).toBe("price");
    expect(coverOf(price).referenceLoss).toBeUndefined();
    expect(codes(price.warnings)).toEqual(["recipe_generation_notice"]);
    expect(coverOf(price).notRead).toBeUndefined();
    // The stub vault has no such view: absent is silent, and NOT listed as unread.
    const plain = await openOn(world(), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(coverOf(plain).referenceLoss).toBeUndefined();
    expect(coverOf(plain).notRead).toBeUndefined();
    expect(codes(plain.warnings)).toEqual(["recipe_generation_notice"]);
  });

  it("what could not be read is LISTED: no RPC, an RPC that throws, a one_of collateral, a counter read that failed in transport", async () => {
    const offline = world({ resolveRpc: async () => null });
    const a = await openOn(offline, { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(a.state).toBe("ok");
    expect(offline.posts).toHaveLength(1);
    expect(coverOf(a).notRead).toEqual(["no RPC resolved: the recipe was not asked and the reference was not read"]);
    expect(coverOf(a).resolved).toBeUndefined();
    const broken = world({ resolveRpc: (async () => { throw new Error("rpc down"); }) as unknown as HandlerContext["resolveRpc"] });
    const b = await openOn(broken, { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(b.state).toBe("ok");
    expect(broken.posts).toHaveLength(1);
    expect(coverOf(b).notRead).toEqual(["the chain could not be reached: rpc down"]);
    // one_of with ONE entry names a single pair, and is resolved like an exact collateral.
    const single = await openOn(world(), { modes: ["liquidity_impairment"], collateralAsset: { one_of: [JIT_TASK_PAIR.collateralAsset] }, marketTemplate: stubImpairment() });
    expect(coverOf(single).notRead).toBeUndefined();
    expect(coverOf(single).resolved).toBeDefined();
    const several = await openOn(world(), { modes: ["liquidity_impairment"], collateralAsset: { one_of: [JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset] }, marketTemplate: stubImpairment() });
    expect(coverOf(several).notRead).toEqual(["the collateral is one_of with several entries: no single pair to resolve the recipe against"]);
    expect(coverOf(several).resolved).toBeUndefined();
    expect(singleCollateral({ exact: JIT_TASK_PAIR.collateralAsset })).toBe(JIT_TASK_PAIR.collateralAsset);
    expect(singleCollateral({ one_of: [] })).toBeUndefined();
    const flaky = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => { if (a.functionName === "lostAssets") throw transport("socket hang up"); return (inner.readContract as (x: unknown) => Promise<unknown>)(a); } });
    const c = await openOn(world({ client: flaky }), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(coverOf(c).notRead).toEqual(["the reference's lost-assets counter: socket hang up"]);
    expect(coverOf(c).referenceLoss).toBeUndefined();
    expect(coverOf(c).resolved).toBeDefined(); // the recipe still answered
    // A fixed-rate request for a pair with no deployed oracle has nothing to compare with — said.
    const noOracle = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => (a.functionName === "lookupWrapper" ? "0x0000000000000000000000000000000000000000" : (inner.readContract as (x: unknown) => Promise<unknown>)(a)) });
    const d = await openOn(world({ client: noOracle }), { marketTemplate: stubFixed("750000000000000000") });
    expect(coverOf(d).notRead).toEqual(["the reference's rate today: the pair has no deployed nav or price oracle to compare the frozen rate with"]);
    expect(coverOf(d).fixed).toEqual({ rateOverride: "750000000000000000" });
    expect(coverOf(d).resolved).toBeDefined();
    // An oracle that IS deployed and cannot be read is said as that — not as "no oracle".
    const deadRate = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string; address: string }) => { if (a.functionName === "rate") throw transport("rate read timed out"); return (inner.readContract as (x: unknown) => Promise<unknown>)(a); } });
    const e = await openOn(world({ client: deadRate }), { marketTemplate: stubFixed("750000000000000000") });
    expect(coverOf(e).notRead).toHaveLength(1);
    expect(coverOf(e).notRead![0]).toMatch(/^the reference's rate today: the pair's nav oracle 0x[0-9a-fA-F]{40} is deployed and its rate\(\) read failed in transport \(rate read timed out\)/u);
    expect(coverOf(e).fixed).toEqual({ rateOverride: "750000000000000000" });
    // A recipe no configured generation names: the kind is unknown and NOTHING is asked — said.
    const unhinted = await openOn(world(), { modes: ["liquidity_only"], marketTemplate: { inline: { oracle_recipe: "0x00000000000000000000000000000000000000ee", oracle_params: stubLiquidity().inline.oracle_params } } });
    expect(coverOf(unhinted).kind).toBe("unknown");
    expect(coverOf(unhinted).notRead).toEqual(["the recipe is not one a configured generation names, so nothing was asked of the chain: no constraint, no reference rate, no loss reading"]);
    expect(codes(unhinted.warnings)).toEqual(["recipe_not_found"]);
    // The recipe's source could not be read (and no resolve ran to supply it): the loss
    // reading was not attempted, and that is said — not passed off as "no loss view".
    const noSource = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => { if (a.functionName === "source") throw transport("source read timed out"); return (inner.readContract as (x: unknown) => Promise<unknown>)(a); } });
    const g = await openOn(world({ client: noSource }), { modes: ["liquidity_impairment"], collateralAsset: { one_of: [JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset] }, marketTemplate: stubImpairment() });
    expect(coverOf(g).notRead).toEqual(["the collateral is one_of with several entries: no single pair to resolve the recipe against", "the recipe's source (source read timed out), so the reference's lost-assets counter was not asked"]);
    // A template id names no recipe at all: nothing to ask and nothing to list.
    const byId = await openOn(world(), { modes: ["liquidity_only"], marketTemplate: { market_template_id: "tmpl_1" } });
    expect(coverOf(byId).notRead).toBeUndefined();
  });

  it("the creating fill's own check: recipe.verify — the call that takes the expiry — REJECTS a duration beyond the pool life the block itself names, and the cause is named", async () => {
    // The block names a pool that lives 7 days + 1 hour and sizes the window for 20 days.
    // recipe.resolve takes no expiry and answers a window; only verify can refuse — and it
    // answers false (the live recipe does not revert here), so the fill reverts RecipeRejectedConstraint.
    const env = await openOn(world(), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment({ duration_seconds: "1728000" }) });
    expect(env.state).toBe("ok");
    expect(coverOf(env).resolved).toBeDefined();
    expect(codes(env.warnings)).toEqual(["recipe_generation_notice", "would_revert"]);
    expect(env.warnings[1]!.message).toMatch(/recipe\.verify REJECTS the constraint it resolved, for the pool the block names \(expiry \d+, being created\): the fill that creates this pool reverts RecipeRejectedConstraint.*The carried duration 1728000 s exceeds the market's remaining life 608400 s/u);
    // The boundary is inclusive: a duration equal to the pool's life passes, one second more does not.
    expect(codes((await openOn(world(), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment({ duration_seconds: "608400" }) })).warnings)).toEqual(["recipe_generation_notice"]);
    expect(codes((await openOn(world(), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment({ duration_seconds: "608401" }) })).warnings)).toEqual(["recipe_generation_notice", "would_revert"]);
    // A rejection whose cause this tool cannot see is reported without an invented reason.
    const rejecting = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => (a.functionName === "verify" ? false : (inner.readContract as (x: unknown) => Promise<unknown>)(a)) });
    const r = await openOn(world({ client: rejecting }), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    const rejected = r.warnings.find((x) => x.code === "would_revert")!.message;
    expect(rejected).toMatch(/recipe\.verify REJECTS.*RecipeRejectedConstraint.*The recipe does not say why/u);
    expect(rejected).not.toMatch(/exceeds the market's remaining life/u);
    // A REVERT of verify keeps the recipe's own error name; a transport fault on it is listed, not warned.
    const reverting = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => { if (a.functionName === "verify") throw new Error("execution reverted: SomeRecipeError(7)"); return (inner.readContract as (x: unknown) => Promise<unknown>)(a); } });
    const v = await openOn(world({ client: reverting }), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(v.warnings.find((x) => x.code === "would_revert")!.message).toMatch(/runs recipe\.verify with the block's pool expiry \d+, and it reverts: .*SomeRecipeError\(7\)/u);
    const flaky = (inner: Rpc["client"]) => ({ readContract: async (a: { functionName: string }) => { if (a.functionName === "verify") throw transport("verify timed out"); return (inner.readContract as (x: unknown) => Promise<unknown>)(a); } });
    const f = await openOn(world({ client: flaky }), { modes: ["liquidity_impairment"], marketTemplate: stubImpairment() });
    expect(codes(f.warnings)).toEqual(["recipe_generation_notice"]);
    expect(coverOf(f).notRead).toEqual(["recipe.verify: verify timed out"]);
  });

  it("the duration diagnosis is the MEASURED rule of the nested recipe: beyond the life only, inclusive at the boundary, and silent where verify takes no expiry", () => {
    expect(durationBeyondLifeNote("nested", 608_401n, 608_400n)).toMatch(/The carried duration 608401 s exceeds the market's remaining life 608400 s, and that life shrinks until the fill.*measured on the live recipe/u);
    expect(durationBeyondLifeNote("nested", 608_400n, 608_400n)).toBeUndefined();
    expect(durationBeyondLifeNote("nested", 1n, 608_400n)).toBeUndefined();
    expect(durationBeyondLifeNote("nested", undefined, 608_400n)).toBeUndefined();
    // The flat (0.3.x) verify takes no expiry: nothing to diagnose.
    expect(durationBeyondLifeNote("flat", 608_401n, 608_400n)).toBeUndefined();
  });

  it("the worked examples: impairment on the primary's recipe and fixed-rate, each relayed with the cover it buys", async () => {
    const imp = TOOL_EXAMPLES.cork_submit!.find((e) => e.title.includes("IMPAIRMENT"))!;
    const fix = TOOL_EXAMPLES.cork_submit!.find((e) => e.title.includes("FIXED-RATE"))!;
    for (const [example, kind, mode] of [[imp, "impairment", "liquidity_impairment"], [fix, "fixed-rate", "fixed_rate"]] as const) {
      const w = world({ resolveRpc: async () => null });
      const env = await runTool("cork_submit", JSON.parse(JSON.stringify(example.input)), w.ctx);
      expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
      expect(w.posts).toHaveLength(1);
      expect(w.posts[0]!.body["modes"]).toEqual([mode]);
      expect(coverOf(env)).toMatchObject({ kind, generation: PRIMARY, modesAgree: true });
      expect(codes(env.warnings)).toEqual(["recipe_generation_notice"]);
    }
  });

  it("Zyfai's mistake, reproduced: a nav liquidity recipe under an impairment mode is relayed (an RFQ binds nobody) and named", async () => {
    const example = TOOL_EXAMPLES.cork_submit!.find((e) => e.title.includes("IMPAIRMENT"))!;
    const input = JSON.parse(JSON.stringify(example.input)) as { action: Record<string, unknown> };
    input.action["marketTemplate"] = { inline: { oracle_recipe: NAV, oracle_params: liqBlock({ expiry: "1796256000" }) } };
    const w = world({ resolveRpc: async () => null });
    const env = await runTool("cork_submit", input, w.ctx);
    expect(env.state).toBe("ok");
    expect(w.posts).toHaveLength(1);
    expect(coverOf(env).kind).toBe("liquidity");
    expect(codes(env.warnings)).toEqual(["recipe_generation_notice", "cover_mode_mismatch", "cover_mode_mismatch"]);
  });
});

describe("the inline recipe, classified chain-free against the configured generations", () => {
  it("recipeAddressOfTemplate reads only a well-formed address", () => {
    expect(recipeAddressOfTemplate({ inline: { oracle_recipe: FIXED } })).toBe(FIXED);
    for (const t of [undefined, {}, { market_template_id: "x" }, { inline: {} }, { inline: { oracle_recipe: "liquidity" } }, { inline: { oracle_recipe: `${FIXED}00` } }, { inline: { oracle_recipe: 5 } }]) expect(recipeAddressOfTemplate(t)).toBeUndefined();
  });

  it("the primary's recipe is named with its generation; a previous generation's says what that costs; an unknown address is recipe_not_found — none refuses", async () => {
    const primary = await classifyInlineRecipe(CHAIN, { inline: { oracle_recipe: FIXED } });
    expect(primary.recipe).toEqual({ address: FIXED, recipeName: "fixed", generation: PRIMARY });
    expect(primary.warnings).toHaveLength(1);
    expect(primary.warnings[0]).toMatchObject({ code: "recipe_generation_notice" });
    expect(primary.warnings[0]!.message).toMatch(/is the fixed recipe of the primary/u);
    const previous = await classifyInlineRecipe(CHAIN, { inline: { oracle_recipe: PREVIOUS_IMPAIRMENT } });
    expect(previous.recipe).toEqual({ address: PREVIOUS_IMPAIRMENT, recipeName: "impairment", generation: "phoenix/v0.3-rc.1" });
    expect(previous.warnings[0]!.message).toMatch(/is the impairment recipe of the phoenix\/v0\.3-rc\.1 generation \(active\), not the primary.*an underwriter quoting the primary alone passes on this RFQ silently/u);
    const unknown = await classifyInlineRecipe(CHAIN, { inline: { oracle_recipe: "0x00000000000000000000000000000000000000ee" } });
    expect(unknown).toMatchObject({ address: "0x00000000000000000000000000000000000000ee", warnings: [{ code: "recipe_not_found" }] });
    expect(unknown.recipe).toBeUndefined();
    expect(await classifyInlineRecipe(CHAIN, { market_template_id: "x" })).toEqual({ warnings: [] });
  });

  it("a recipe's source is asked of the recipe; a failed read is reported as a failure with its kind, never as a source", async () => {
    const client = (await stubContext().resolveRpc!(42161, undefined))!.client;
    expect(await readRecipeSource(client, FIXED_RECIPE)).toEqual({ source: "fixed" });
    expect(await readRecipeSource(client, IMPAIRMENT_RECIPE)).toEqual({ source: "nav" });
    expect(await readRecipeSource(client, LIQUIDITY_RECIPE)).toEqual({ source: "price" });
    expect(await readRecipeSource({ readContract: async () => { throw new Error("execution reverted"); } } as never, FIXED_RECIPE)).toEqual({ error: "execution reverted", transport: false });
    expect(await readRecipeSource({ readContract: async () => { throw transport("socket hang up"); } } as never, FIXED_RECIPE)).toEqual({ error: "socket hang up", transport: true });
    expect(await readRecipeSource({ readContract: async () => 9 } as never, FIXED_RECIPE)).toEqual({ error: "source() answered the unknown ordinal 9", transport: false });
  });

  it("a block lends its bytes only to its own recipe's cover; with the cover unknown it rides as written", () => {
    const imp = inlineParamsOfTemplate({ inline: { oracle_params: impBlock() } })!;
    const liq = inlineParamsOfTemplate({ inline: { oracle_params: liqBlock() } })!;
    expect(blockBytesFor("impairment", imp)).toBe(inlineAdditionalData(imp));
    expect(blockBytesFor("liquidity", imp)).toBeUndefined();
    expect(blockBytesFor("fixed-rate", liq)).toBeUndefined();
    expect(blockBytesFor("liquidity", liq)).toBe(inlineAdditionalData(liq));
    expect(blockBytesFor(undefined, imp)).toBe(inlineAdditionalData(imp));
    expect(blockBytesFor("impairment", undefined)).toBeUndefined();
  });
});

describe("readPairLiveRate — the reference's rate today, from the registry's own deployed wrapper", () => {
  const REGISTRY = "0x00000000000000000000000000000000000000a1" as const;
  const NAV_WRAPPER = "0x00000000000000000000000000000000000000b1";
  const PRICE_WRAPPER = "0x00000000000000000000000000000000000000b2";
  const ZERO = "0x0000000000000000000000000000000000000000";
  // lookupWrapper(ca, ref, mode): mode 0 = price, 1 = nav (ORACLE_MODE) — answered per mode.
  const client = (wrappers: { nav?: string; price?: string }, rates: Record<string, bigint | Error>) => {
    const asked: string[] = [];
    return {
      asked,
      readContract: async (a: { functionName: string; address: string; args?: readonly unknown[] }) => {
        if (a.functionName === "lookupWrapper") {
          const mode = Number(a.args![2]) === 1 ? "nav" : "price";
          asked.push(mode);
          return wrappers[mode] ?? ZERO;
        }
        const r = rates[a.address];
        if (r === undefined || r instanceof Error) throw r ?? new Error("execution reverted");
        return r;
      },
    } as never;
  };

  it("the NAV wrapper when the pair has one, else the price wrapper, else `none`", async () => {
    const both = client({ nav: NAV_WRAPPER, price: PRICE_WRAPPER }, { [NAV_WRAPPER]: 11n, [PRICE_WRAPPER]: 22n });
    expect(await readPairLiveRate(both, REGISTRY, JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset)).toEqual({ status: "read", rate: 11n, source: "nav", oracle: NAV_WRAPPER });
    expect((both as unknown as { asked: string[] }).asked).toEqual(["nav"]);
    const priceOnly = client({ price: PRICE_WRAPPER }, { [PRICE_WRAPPER]: 22n });
    expect(await readPairLiveRate(priceOnly, REGISTRY, JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset)).toEqual({ status: "read", rate: 22n, source: "price", oracle: PRICE_WRAPPER });
    expect(await readPairLiveRate(client({}, {}), REGISTRY, JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset)).toEqual({ status: "none" });
  });

  it("a DEPLOYED wrapper that cannot be read is `unreadable` with its reason — never `none`, and never silently replaced by the other wrapper", async () => {
    // The NAV wrapper reverts while a price wrapper exists: the two measure different things,
    // so the price is not passed off as the reference's NAV.
    const navDead = client({ nav: NAV_WRAPPER, price: PRICE_WRAPPER }, { [NAV_WRAPPER]: new Error("execution reverted: Panic(17)"), [PRICE_WRAPPER]: 22n });
    expect(await readPairLiveRate(navDead, REGISTRY, JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset)).toMatchObject({ status: "unreadable", source: "nav", oracle: NAV_WRAPPER, failure: "revert" });
    expect((navDead as unknown as { asked: string[] }).asked).toEqual(["nav"]);
    const navDown = client({ nav: NAV_WRAPPER }, { [NAV_WRAPPER]: transport("rate read timed out") });
    expect(await readPairLiveRate(navDown, REGISTRY, JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset)).toMatchObject({ status: "unreadable", failure: "transport", reason: expect.stringMatching(/rate read timed out/u) });
    const navZero = client({ nav: NAV_WRAPPER }, { [NAV_WRAPPER]: 0n });
    expect(await readPairLiveRate(navZero, REGISTRY, JIT_TASK_PAIR.collateralAsset, JIT_TASK_PAIR.referenceAsset)).toEqual({ status: "unreadable", source: "nav", oracle: NAV_WRAPPER, reason: "rate() answers zero", failure: "zero" });
  });

  it("readFixedRatePosition words each outcome for the side reading it and never throws", async () => {
    const pair = JIT_TASK_PAIR;
    const ok = client({ nav: NAV_WRAPPER }, { [NAV_WRAPPER]: 800_000_000_000_000_000n });
    expect(await readFixedRatePosition(ok, REGISTRY, pair, 750_000_000_000_000_000n, "underwriter")).toEqual({ live: { rate: 800_000_000_000_000_000n, source: "nav", position: "below", gapPercentage: 6_250_000_000_000_000_000n } });
    const above = await readFixedRatePosition(ok, REGISTRY, pair, 900_000_000_000_000_000n, "underwriter");
    expect(above.live).toMatchObject({ position: "above" });
    expect(above.warning!.message).toMatch(/You would be out of pocket/u);
    expect((await readFixedRatePosition(ok, REGISTRY, pair, 900_000_000_000_000_000n, "requester")).warning!.message).toMatch(/An underwriter prices that gap/u);
    expect(await readFixedRatePosition(client({}, {}), REGISTRY, pair, 1n, "requester")).toEqual({ notRead: "the reference's rate today: the pair has no deployed nav or price oracle to compare the frozen rate with" });
    const zero = await readFixedRatePosition(client({ nav: NAV_WRAPPER }, { [NAV_WRAPPER]: 0n }), REGISTRY, pair, 1n, "requester");
    expect(zero.notRead).toMatch(/is deployed and its rate\(\) answers zero/u);
    const reverting = await readFixedRatePosition(client({ nav: NAV_WRAPPER }, {}), REGISTRY, pair, 1n, "requester");
    expect(reverting.notRead).toMatch(/is deployed and its rate\(\) reverts/u);
    // The registry read itself throwing is caught and listed.
    const broken = { readContract: async () => { throw new Error("registry read failed"); } } as never;
    expect(await readFixedRatePosition(broken, REGISTRY, pair, 1n, "requester")).toEqual({ notRead: "the reference's rate today: registry read failed" });
  });
});

describe("derive-cork-pool for the fixed recipe — the constraint the fill itself will read", () => {
  const derive = (ctx: HandlerContext, filters: Record<string, unknown>) =>
    runTool("cork_query", { chainId: 42161, resource: "derive-cork-pool", filters: { collateralAsset: JIT_TASK_PAIR.collateralAsset, referenceAsset: JIT_TASK_PAIR.referenceAsset, expiry: String(STUB_EXPIRY), recipe: FIXED_RECIPE, ...filters } }, ctx);

  it("an undeployed FixedRateOracle: the pool derives against the PREDICTED oracle with rate .. rate + 1 and zero allowances", async () => {
    const env = await derive(stubContext(), { rate: "750000000000000000" });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { source: string; oracle: { address: string; deployed: boolean }; pool: { poolId: string; constraint: Record<string, string> } };
    expect(d.source).toBe("fixed");
    expect(d.oracle).toMatchObject({ address: predictedFixedOracle(750_000_000_000_000_000n), deployed: false });
    expect(d.pool.constraint).toEqual({ rateMin: "750000000000000000", rateMax: "750000000000000001", rateChangePerDayMax: "0", rateChangeCapacityMax: "0" });
    expect(codes(env.warnings)).toContain("oracle_not_deployed");
    // Another rate is another oracle and so another pool.
    const other = (await derive(stubContext(), { rate: "750000000000000001" })).data as typeof d;
    expect(other.oracle.address).not.toBe(d.oracle.address);
    expect(other.pool.poolId).not.toBe(d.pool.poolId);
  });

  it("the recipe's refusals come back with its own error names: a payload, and the rate that overflows", async () => {
    const payload = await derive(stubContext(), { rate: "750000000000000000", args: "0x01" });
    expect(payload.state).toBe("unavailable");
    expect(payload.warnings[0]).toMatchObject({ code: "recipe_refused" });
    expect(payload.warnings[0]!.message).toMatch(/recipe\.resolve reverted UnexpectedExtraData\(1\).*The fixed-rate recipe takes NO extraData/u);
    const overflow = await derive(stubContext(), { rate: UINT256_MAX.toString() });
    expect(overflow.warnings[0]!.message).toMatch(/recipe\.resolve reverted Panic\(17\)/u);
  });

  it("without the rate there is no oracle to predict, and a plain resolve is the recipe's RateOracleNotDeployed", async () => {
    const env = await derive(stubContext(), {});
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]).toMatchObject({ code: "recipe_refused" });
    expect(env.warnings[0]!.message).toMatch(/RateOracleNotDeployed/u);
  });
});

describe("cork_query cork-pool — the pool read names the cover from the pool's own limits", () => {
  const POOL = (TOOL_EXAMPLES.cork_query![0]!.input as { filters: { poolId: string } }).filters.poolId;
  /** The stub pool with its four limits replaced (the pool read through the real handler). */
  const poolWith = (limits: Record<string, bigint>) => {
    const stub = stubContext();
    const ctx: HandlerContext = {
      ...stub,
      resolveRpc: async (chainId, url) => {
        const r = (await stub.resolveRpc!(chainId, url))!;
        const inner = r.client.readContract.bind(r.client) as (a: { functionName: string }) => Promise<unknown>;
        return { ...r, client: { ...r.client, readContract: (async (a: { functionName: string }) => { const v = await inner(a); return a.functionName === "market" ? { ...(v as object), ...limits } : v; }) as never } } as typeof r;
      },
    };
    return runTool("cork_query", { chainId: 1, resource: "cork-pool", filters: { poolId: POOL } }, ctx);
  };
  const coverOfPool = (env: { data: unknown }) => (env.data as { cover: { kind: string; label: string; protection: string; readFrom: string } }).cover;

  it("data.cover: kind, label, protection, and that it is an INFERENCE from the limits (the pool records no recipe)", async () => {
    const env = await runTool("cork_query", { chainId: 1, resource: "cork-pool", filters: { poolId: POOL } }, stubContext());
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    // The stub pool: floor 0.5, per-day 0.001, capacity 0.007 — a band.
    expect(coverOfPool(env)).toEqual({ kind: "impairment", label: COVER_LABELS.impairment, protection: COVER_PROTECTION.impairment, readFrom: expect.stringMatching(/^an INFERENCE from the pool's four rate limits — the pool does not record its recipe.*both rate-change allowances zero = fixed-rate; else a floor of at most 1 wei = liquidity/u) });
  });

  it("the three covers through the handler: the fork's liquidity and fixed-rate limits read as what they are", async () => {
    const liquidity = await poolWith({ rateMin: 1n, rateMax: 2_182_172_000_000_000_000n, rateChangePerDayMax: 1_091_086_000_000_000_000n, rateChangeCapacityMax: 3_273_258_000_000_000_000n });
    expect(coverOfPool(liquidity)).toMatchObject({ kind: "liquidity", label: COVER_LABELS.liquidity, protection: COVER_PROTECTION.liquidity });
    const fixed = await poolWith({ rateMin: 1_091_086_000_000_000_000n, rateMax: 1_091_086_000_000_000_001n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n });
    expect(coverOfPool(fixed)).toMatchObject({ kind: "fixed-rate", label: COVER_LABELS["fixed-rate"], protection: COVER_PROTECTION["fixed-rate"] });
  });
});

describe("the cover doc topic", () => {
  it("resolves by name and alias and carries the table, the three measured payouts, and the two fixed-rate traps", () => {
    const t = findDocTopic("cover")!;
    expect(t).toBe(DOC_TOPICS["cover"]);
    for (const alias of ["cover-types", "impairment", "downside", "fixed-rate", "duration-risk", "credit-risk", "duration-risk-cover", "credit-risk-cover"]) expect(findDocTopic(alias)).toBe(t);
    expect(t.body).toMatch(/\*\*Liquidity \(duration-risk\) cover\*\*/u);
    expect(t.body).toMatch(/\*\*Impairment \(credit-risk\) cover\*\*/u);
    expect(t.body).toMatch(/\*\*Fixed-rate cover\*\*.*`fixed_rate` \(venue 0\.4\.4\)/u);
    expect(t.body).toMatch(/\*\*0\.000 USDC\*\*/u);
    expect(t.body).toMatch(/\*\*9\.827 USDC\*\*/u);
    expect(t.body).toMatch(/\*\*9\.999 USDC\*\*/u);
    expect(t.body).toMatch(/The band is the WORST-case deductible, not the deductible on every day/u);
    expect(t.body).toMatch(/## A loss the share price does not report/u);
    expect(t.body).toMatch(/The counter is not the hole/u);
    expect(t.body).toMatch(/the open shortfall is 0/u);
    expect(t.body).toMatch(/This reading applies to NAV-sourced recipes only/u);
    expect(t.body).toMatch(/## The recipe states its own rules: ask it/u);
    expect(t.body).toMatch(/## Ask for fixed-rate cover/u);
    expect(t.body).toMatch(/fixed_rate_in_the_money/u);
    expect(t.body).toMatch(/cover_mode_mismatch/u);
    expect(t.body).toMatch(/UnexpectedRateOverride/u);
    // The old claim is gone: fixed-rate IS requestable.
    expect(t.body).not.toMatch(/cannot be requested through an RFQ/u);
    expect(t.summary).toMatch(/decided by the market's RECIPE.*requestable through an RFQ since venue 0\.4\.4/u);
  });
});
