// WHICH COVER an RFQ buys (planning#88 / the docs-and-CLI sub-issue, 2026-10-01): the recipe in
// the inline template decides it; the venue's `modes` are pricing labels. Zyfai asked for downside
// cover and got an exit-only pool because nothing on the request path said so. rfq-open now
// returns `data.cover` and names a request that contradicts itself (`cover_mode_mismatch`).
//
// The band goldens are FROM THE CHAIN: `recipe.resolve` on the deployed ApySpreadImpairmentRecipe
// 0xd5e8…0Ed9 (Base, USDC/baseUSD, live anchor 1.091071, 2026-10-01) returned the four limits
// asserted below for a 30-day duration at 10%/yr and at 100%/yr. The constraint shapes are the
// two pools the fork experiment created (experiments/fork-harness/script/cover-types-rehearsal.ts).
import { describe, expect, it } from "vitest";
import {
  BUNDLED_DEFAULTS,
  COVER_KINDS,
  COVER_PROTECTION,
  coverKindOfConstraint,
  coverKindOfRecipeName,
  generationsOf,
  impairmentBandPercentage,
  impairmentWindow,
  primaryOf,
  readRfqCover,
  RFQ_MODE_COVER,
  runTool,
  type HandlerContext,
} from "@cork/core";
import { DOC_TOPICS, findDocTopic, TOOL_EXAMPLES } from "@cork/schemas";

const NOW = 1_790_000_000n;
const CHAIN = 8453;
const gens = generationsOf(BUNDLED_DEFAULTS, CHAIN);
const recipes = primaryOf(gens)!.marketRegistry!.recipes!;
const IMPAIRMENT = recipes["impairment"]!;
const NAV = recipes["nav"]!;
const FIXED = recipes["fixed"]!;
const PREVIOUS_IMPAIRMENT = gens.find((g) => g.label === "phoenix/v0.3-rc.1")!.marketRegistry!.recipes!["impairment"]!;
const ANCHOR = 1_091_071_000_000_000_000n;
const TEN_PERCENT = 10n * 10n ** 18n;

describe("the cover kinds — recipe names and constraint shapes", () => {
  it("a recipe hint names its cover: the two liquidity recipes (price and nav source) are the SAME exit-only cover", () => {
    expect(coverKindOfRecipeName("liquidity")).toBe("liquidity");
    expect(coverKindOfRecipeName("nav")).toBe("liquidity");
    expect(coverKindOfRecipeName("impairment")).toBe("impairment");
    expect(coverKindOfRecipeName("fixed")).toBe("fixed-rate");
    expect(coverKindOfRecipeName("other")).toBeUndefined();
    expect(coverKindOfRecipeName(undefined)).toBeUndefined();
    expect(RFQ_MODE_COVER).toEqual({ liquidity_only: "liquidity", liquidity_impairment: "impairment" });
    for (const k of COVER_KINDS) expect(COVER_PROTECTION[k].length).toBeGreaterThan(40);
    expect(COVER_PROTECTION.liquidity).toMatch(/pays nothing for that loss/u);
  });

  it("a live pool's four limits name its cover: 1 wei floor = liquidity, zero allowances = fixed-rate, a band = impairment (the fork's two pools)", () => {
    // The LIQUIDITY pool of the experiment: rateMin 1 wei, rateMax 2x, perDay = anchor, capacity 3x.
    expect(coverKindOfConstraint({ rateMin: 1n, rateChangePerDayMax: 1_091_072_000_000_000_000n, rateChangeCapacityMax: 3_273_216_000_000_000_000n })).toBe("liquidity");
    // The IMPAIRMENT pool: floor 1.086741, perDay 0.000299, capacity 0.002092.
    expect(coverKindOfConstraint({ rateMin: 1_086_740_725_093_049_214n, rateChangePerDayMax: 298_923_835_616_438n, rateChangeCapacityMax: 2_092_466_849_315_068n })).toBe("impairment");
    expect(coverKindOfConstraint({ rateMin: ANCHOR, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n })).toBe("fixed-rate");
    // A band with only ONE allowance at zero is still a band, not a frozen rate.
    expect(coverKindOfConstraint({ rateMin: ANCHOR - 1n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 5n })).toBe("impairment");
    expect(coverKindOfConstraint({ rateMin: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n })).toBe("liquidity");
  });

  it("the band is apySpread × duration / 365 d and the window is the anchor ± that — wei-for-wei the deployed recipe's own resolve", () => {
    const thirtyDays = 2_592_000n;
    const band10 = impairmentBandPercentage(thirtyDays, TEN_PERCENT);
    expect(band10).toBe(821_917_808_219_178_082n); // 0.8219% on the percentage scale (1e18 = 1%)
    expect(impairmentWindow(ANCHOR, band10)).toEqual({ rateFloor: 1_082_103_293_150_684_932n, rateCeiling: 1_100_038_706_849_315_068n });
    const band100 = impairmentBandPercentage(thirtyDays, 100n * 10n ** 18n);
    expect(impairmentWindow(ANCHOR, band100)).toEqual({ rateFloor: 1_001_393_931_506_849_316n, rateCeiling: 1_180_748_068_493_150_684n });
    // A third read, 14 days at 10%/yr, taken after the oracle ticked to 1.091072.
    expect(impairmentWindow(1_091_072_000_000_000_000n, impairmentBandPercentage(1_209_600n, TEN_PERCENT))).toEqual({ rateFloor: 1_086_887_066_301_369_864n, rateCeiling: 1_095_256_933_698_630_136n });
  });
});

const block = (over: Record<string, unknown> = {}) => ({ schema: "cork-inline-impairment/1", anchor_rate: ANCHOR.toString(), expiry: "1791209600", swap_fee_wad: "0", unwind_swap_fee_wad: "0", duration_seconds: "1209600", apy_spread_percentage: TEN_PERCENT.toString(), ...over });
const read = (modes: string[], recipe: string | undefined, params: Record<string, unknown> | undefined, hint?: { recipeName?: string; generation: string }) =>
  readRfqCover({ modes, marketTemplate: recipe === undefined ? { market_template_id: `0x${"11".repeat(32)}` } : { inline: { oracle_recipe: recipe, ...(params ? { oracle_params: params } : {}) } }, recipeHint: hint, nowSeconds: NOW });
const codes = (w: Array<{ code: string }>) => w.map((x) => x.code);

describe("readRfqCover — the request's own contradictions, named", () => {
  const IMP_HINT = { recipeName: "impairment", generation: "phoenix/v0.4-rc.1" };
  const NAV_HINT = { recipeName: "nav", generation: "phoenix/v0.4-rc.1" };

  it("an impairment recipe with a complete block: the kind, the deductible band and the rate floor, no warning", () => {
    const { cover, warnings } = read(["liquidity_impairment"], IMPAIRMENT, block(), IMP_HINT);
    expect(warnings).toEqual([]);
    expect(cover).toMatchObject({ kind: "impairment", recipe: IMPAIRMENT, recipeName: "impairment", generation: "phoenix/v0.4-rc.1", modesAgree: true, requestedModes: ["liquidity_impairment"] });
    // 10%/yr over 14 days: 10e18 × 1209600 / 31536000.
    expect(cover.band).toEqual({ apySpreadPercentage: TEN_PERCENT.toString(), durationSeconds: "1209600", bandPercentage: "383561643835616438", anchorRate: ANCHOR.toString(), rateFloor: "1086886070136986302", rateCeiling: "1095255929863013698" });
    expect(cover.scales!["bandPercentage"]).toMatch(/1e18 = 1%.*deductible/u);
    expect(cover.protection).toBe(COVER_PROTECTION.impairment);
  });

  it("THE TRAP: an impairment mode on a liquidity recipe is priced as downside cover and creates an exit-only pool — warned whether or not liquidity_only rides along", () => {
    for (const modes of [["liquidity_impairment"], ["liquidity_only", "liquidity_impairment"]]) {
      const { cover, warnings } = read(modes, NAV, { schema: "cork-inline-liquidity/1", anchor_rate: ANCHOR.toString(), expiry: "1791209600", swap_fee_wad: "0", unwind_swap_fee_wad: "0" }, NAV_HINT);
      expect(cover).toMatchObject({ kind: "liquidity", modesAgree: false });
      expect(codes(warnings)).toEqual(["cover_mode_mismatch"]);
      expect(warnings[0]!.message).toMatch(/LIQUIDITY recipe.*pays NOTHING for a loss in the reference/u);
    }
    const honest = read(["liquidity_only"], NAV, { schema: "cork-inline-liquidity/1", anchor_rate: ANCHOR.toString(), expiry: "1791209600" }, NAV_HINT);
    expect(honest.warnings).toEqual([]);
    expect(honest.cover).toMatchObject({ kind: "liquidity", modesAgree: true });
    expect(honest.cover.band).toBeUndefined();
  });

  it("the reverse: an impairment recipe priced as liquidity invites a pass; an impairment block on a liquidity recipe is ignored words", () => {
    const under = read(["liquidity_only"], IMPAIRMENT, block(), IMP_HINT);
    expect(codes(under.warnings)).toEqual(["cover_mode_mismatch"]);
    expect(under.warnings[0]!.message).toMatch(/expect a pass/u);
    expect(under.cover.modesAgree).toBe(false);
    const both = read(["liquidity_only", "liquidity_impairment"], IMPAIRMENT, block(), IMP_HINT);
    expect(codes(both.warnings)).toEqual(["cover_mode_mismatch"]);
    const wrongBlock = read(["liquidity_only"], NAV, block(), NAV_HINT);
    expect(codes(wrongBlock.warnings)).toEqual(["invalid_order_terms"]);
    expect(wrongBlock.warnings[0]!.message).toMatch(/duration and spread are ignored/u);
  });

  it("an impairment request the recipe would refuse is named with the recipe's own error: no block, a partial block, the spread cap, the band cap, a duration past the pool's life", () => {
    const noBlock = read(["liquidity_impairment"], IMPAIRMENT, {}, IMP_HINT);
    expect(codes(noBlock.warnings)).toEqual(["invalid_order_terms"]);
    expect(noBlock.warnings[0]!.message).toMatch(/needs a cork-inline-impairment\/1 block.*no readable inline block/u);
    expect(noBlock.cover.band).toBeUndefined();
    const liquidityBlock = read(["liquidity_impairment"], IMPAIRMENT, { schema: "cork-inline-liquidity/1", anchor_rate: ANCHOR.toString() }, IMP_HINT);
    expect(liquidityBlock.warnings[0]!.message).toMatch(/the block is cork-inline-liquidity\/1/u);
    const partial = read(["liquidity_impairment"], IMPAIRMENT, block({ apy_spread_percentage: undefined }), IMP_HINT);
    expect(partial.warnings[0]!.message).toMatch(/lacks apy_spread_percentage.*never encoded with zeros/u);
    const bothMissing = read(["liquidity_impairment"], IMPAIRMENT, block({ apy_spread_percentage: undefined, duration_seconds: undefined }), IMP_HINT);
    expect(bothMissing.warnings[0]!.message).toMatch(/lacks duration_seconds and apy_spread_percentage/u);
    const atCap = read(["liquidity_impairment"], IMPAIRMENT, block({ apy_spread_percentage: (100n * 10n ** 18n).toString() }), IMP_HINT);
    expect(atCap.warnings).toEqual([]); // the cap is inclusive
    const spread = read(["liquidity_impairment"], IMPAIRMENT, block({ apy_spread_percentage: (100n * 10n ** 18n + 1n).toString() }), IMP_HINT);
    expect(spread.warnings.map((w) => w.message).join(" ")).toMatch(/SpreadTooHigh/u);
    // 100%/yr over 200 days = a 54.8% band: the spread is within its cap, the band is not.
    const wide = read(["liquidity_impairment"], IMPAIRMENT, block({ apy_spread_percentage: (100n * 10n ** 18n).toString(), duration_seconds: "17280000", expiry: "1890000000" }), IMP_HINT);
    expect(wide.warnings.map((w) => w.message).join(" ")).toMatch(/BandTooWide/u);
    expect(wide.warnings.map((w) => w.message).join(" ")).not.toMatch(/SpreadTooHigh/u);
    // expiry − now = 1,209,600 s exactly: a duration of that length is admissible, one second more is not.
    const exact = read(["liquidity_impairment"], IMPAIRMENT, block({ expiry: (NOW + 1_209_600n).toString() }), IMP_HINT);
    expect(exact.warnings).toEqual([]);
    const long = read(["liquidity_impairment"], IMPAIRMENT, block({ expiry: (NOW + 1_209_599n).toString() }), IMP_HINT);
    expect(long.warnings[0]!.message).toMatch(/DurationTooLong/u);
  });

  it("fixed-rate cannot be requested through an RFQ; a template id or an unconfigured recipe is `unknown`, never guessed", () => {
    const fixed = read(["liquidity_impairment"], FIXED, {}, { recipeName: "fixed", generation: "phoenix/v0.4-rc.1" });
    expect(fixed.cover.kind).toBe("fixed-rate");
    expect(codes(fixed.warnings)).toEqual(["invalid_order_terms"]);
    expect(fixed.warnings[0]!.message).toMatch(/no inline schema carries that rate/u);
    const byId = read(["liquidity_impairment"], undefined, undefined);
    expect(byId.cover).toMatchObject({ kind: "unknown", modesAgree: null });
    expect(byId.cover.decidedBy).toMatch(/market_template_id names a pool/u);
    expect(byId.warnings).toEqual([]);
    const foreign = read(["liquidity_only"], "0x00000000000000000000000000000000000000ee", block(), undefined);
    expect(foreign.cover).toMatchObject({ kind: "unknown", recipe: "0x00000000000000000000000000000000000000ee" });
    expect(foreign.warnings).toEqual([]);
  });
});

type Seen = { url: string; method: string; body?: Record<string, unknown> };
function ctxWith(seen: Seen[]): HandlerContext {
  return {
    nowSeconds: NOW,
    resolveRpc: async () => null,
    venueFetch: async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
      return new Response(JSON.stringify({ rfq_id: "rfq_cover", state: "open" }), { status: 201 });
    },
  };
}
const open = async (over: Record<string, unknown>) => {
  const seen: Seen[] = [];
  const example = TOOL_EXAMPLES.cork_submit!.find((e) => e.title.includes("IMPAIRMENT"))!;
  const input = JSON.parse(JSON.stringify(example.input)) as { action: Record<string, unknown> };
  Object.assign(input.action, over);
  const env = await runTool("cork_submit", input, ctxWith(seen));
  return { env, posts: seen.filter((s) => s.method === "POST") };
};

describe("cork_submit rfq-open — the cover rides the result, a contradiction is warned and still relayed", () => {
  it("the worked example asks for impairment cover with the primary's recipe: relayed verbatim, data.cover says what it buys", async () => {
    const { env, posts } = await open({});
    expect(env.state).toBe("ok");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body!["modes"]).toEqual(["liquidity_impairment"]);
    expect((posts[0]!.body!["market_template"] as { inline: { oracle_recipe: string } }).inline.oracle_recipe).toBe(IMPAIRMENT);
    const d = env.data as { rfqId: string; cover: { kind: string; generation: string; band: Record<string, string>; modesAgree: boolean } };
    expect(d.rfqId).toBe("rfq_cover");
    expect(d.cover).toMatchObject({ kind: "impairment", generation: "phoenix/v0.4-rc.1", modesAgree: true });
    expect(d.cover.band).toMatchObject({ bandPercentage: "383561643835616438", rateFloor: "1086886070136986302" });
    expect(env.warnings.map((w) => w.code)).toEqual(["recipe_generation_notice"]);
  });

  it("Zyfai's mistake, reproduced: a nav liquidity recipe under an impairment mode is relayed (an RFQ binds nobody) with cover_mode_mismatch and kind liquidity", async () => {
    const { env, posts } = await open({ marketTemplate: { inline: { oracle_recipe: NAV, oracle_params: { schema: "cork-inline-liquidity/1", anchor_rate: ANCHOR.toString(), expiry: "1796256000", swap_fee_wad: "0", unwind_swap_fee_wad: "0" } } } });
    expect(env.state).toBe("ok");
    expect(posts).toHaveLength(1);
    expect((env.data as { cover: { kind: string } }).cover.kind).toBe("liquidity");
    expect(env.warnings.map((w) => w.code)).toEqual(["recipe_generation_notice", "cover_mode_mismatch"]);
  });

  it("a previous generation's impairment recipe is still impairment cover, labeled with its generation; no template = unknown", async () => {
    const prev = await open({ marketTemplate: { inline: { oracle_recipe: PREVIOUS_IMPAIRMENT, oracle_params: block({ expiry: "1796256000" }) } } });
    expect((prev.env.data as { cover: { kind: string; generation: string } }).cover).toMatchObject({ kind: "impairment", generation: "phoenix/v0.3-rc.1" });
    expect(prev.env.warnings.map((w) => w.code)).toEqual(["recipe_generation_notice"]);
    const none = await open({ marketTemplate: undefined });
    expect((none.env.data as { cover: { kind: string } }).cover.kind).toBe("unknown");
    expect(none.env.warnings).toEqual([]);
  });
});

describe("the cover doc topic", () => {
  it("resolves by name and alias and carries the table, the measurement and the trap", () => {
    const t = findDocTopic("cover")!;
    expect(t).toBe(DOC_TOPICS["cover"]);
    for (const alias of ["cover-types", "impairment", "downside", "fixed-rate"]) expect(findDocTopic(alias)).toBe(t);
    expect(t.body).toMatch(/\| \*\*Liquidity\*\* \(an exit\)/u);
    expect(t.body).toMatch(/\*\*0\.000 USDC\*\*/u);
    expect(t.body).toMatch(/\*\*9\.827 USDC\*\*/u);
    expect(t.body).toMatch(/cover_mode_mismatch/u);
    expect(t.summary).toMatch(/decided by the market's RECIPE/u);
  });
});
