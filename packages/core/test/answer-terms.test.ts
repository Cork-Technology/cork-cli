// The source rule of an answer's market terms: which template may speak for which term.
import { describe, expect, it } from "vitest";
import { quotedTerms } from "../src/handlers/answer-terms.ts";

const RECIPE_A = "0x679C1D0f8d1c9E0Aa2d1b0cC4E5f6a7B8c9D964d";
const RECIPE_B = "0xEC26bb7d911aFe374721Ecd963543f7e52468C49";
const block = (over: Record<string, unknown> = {}) => ({ schema: "cork-inline-liquidity/1", anchor_rate: "700000000000000000", expiry: "1900000000", swap_fee_wad: "1000000000000000000", unwind_swap_fee_wad: "0", ...over });
const inline = (recipe: string | undefined, params?: Record<string, unknown>) => ({ inline: { ...(recipe !== undefined ? { oracle_recipe: recipe } : {}), ...(params !== undefined ? { oracle_params: params } : {}) } });
const fixed = (recipe: string, rate?: string) => inline(recipe, { schema: "cork-inline-fixed/1", ...(rate !== undefined ? { rate_override: rate } : {}), expiry: "1900000000", swap_fee_wad: "0", unwind_swap_fee_wad: "0" });

describe("quotedTerms — each term with the source that stated it", () => {
  it("uncited: every term is the request's, and nothing is borrowed", () => {
    const t = quotedTerms(fixed(RECIPE_B, "750000000000000000"), undefined);
    expect(t.recipe).toEqual({ value: RECIPE_B, from: "rfq" });
    expect(t.inline?.from).toBe("rfq");
    expect(t.rate).toEqual({ value: 750000000000000000n, from: "rfq" });
    expect(t.requestedRate).toBe(750000000000000000n);
    expect(t.borrowed).toEqual([]);
  });

  it("cited, the option states everything: every term is the option's", () => {
    const t = quotedTerms(fixed(RECIPE_B, "750000000000000000"), { template: fixed(RECIPE_B, "740000000000000000") });
    expect(t.recipe).toEqual({ value: RECIPE_B, from: "cited option" });
    expect(t.inline?.from).toBe("cited option");
    expect(t.rate).toEqual({ value: 740000000000000000n, from: "cited option" });
    expect(t.requestedRate).toBe(750000000000000000n);
    expect(t.borrowed).toEqual([]);
  });

  it("cited, the option carries a template id: the recipe and the block are BORROWED and named; the rate is not borrowed", () => {
    const t = quotedTerms(fixed(RECIPE_B, "750000000000000000"), { template: { market_template_id: "tmpl_x" } });
    expect(t.recipe).toEqual({ value: RECIPE_B, from: "rfq" });
    expect(t.inline?.from).toBe("rfq");
    expect(t.borrowed).toEqual(["recipe", "inline block"]);
    // A rate is a quoted price term: the option named none, so the quote has none.
    expect(t.rate).toBeUndefined();
    expect(t.requestedRate).toBe(750000000000000000n);
  });

  it("each term is borrowed on its own: a recipe without a block, a block without a recipe", () => {
    const recipeOnly = quotedTerms(inline(RECIPE_A, block()), { template: inline(RECIPE_B) });
    expect(recipeOnly.recipe).toEqual({ value: RECIPE_B, from: "cited option" });
    expect(recipeOnly.inline?.from).toBe("rfq");
    expect(recipeOnly.borrowed).toEqual(["inline block"]);
    const blockOnly = quotedTerms(inline(RECIPE_A, block()), { template: inline(undefined, block({ anchor_rate: "800000000000000000" })) });
    expect(blockOnly.recipe).toEqual({ value: RECIPE_A, from: "rfq" });
    expect(blockOnly.inline).toMatchObject({ from: "cited option", value: { anchorRate: 800000000000000000n } });
    expect(blockOnly.borrowed).toEqual(["recipe"]);
  });

  it("a cited option with NO template is still a cited answer; a request without a term lends none", () => {
    const t = quotedTerms(inline(RECIPE_A, block()), { template: undefined });
    expect(t.borrowed).toEqual(["recipe", "inline block"]);
    expect(t.rate).toBeUndefined();
    const bare = quotedTerms({ market_template_id: "tmpl_r" }, { template: { market_template_id: "tmpl_o" } });
    expect(bare).toEqual({ recipe: undefined, inline: undefined, rate: undefined, requestedRate: undefined, borrowed: [] });
  });
});
