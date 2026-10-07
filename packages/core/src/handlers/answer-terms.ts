// The market terms an RFQ answer builds from, each with the source that stated it.
//
// An answer reads its terms from two templates: the REQUEST's and, on a cited answer, the CITED
// OPTION's. Which template may speak for which term is a rule, and it lives here, in one place:
// a term taken from the request on a cited answer is a term the quote did not state, so it is
// either named (`borrowed`) or not taken at all. A variable that starts as the request's value
// and is overwritten "if the option has one" hid exactly that difference (2026-10-02).
import { fixedRateOverrideOfTemplate, type InlineTemplateParams, inlineParamsOfTemplate, recipeAddressOfTemplate } from "../orders-answer.ts";

export type TermSource = "cited option" | "rfq";
export interface Sourced<T> {
  value: T;
  from: TermSource;
}
export type BorrowedTerm = "recipe" | "inline block";
export interface QuotedTerms {
  /** The recipe contract. A cited option that names none borrows the request's. */
  recipe: Sourced<`0x${string}`> | undefined;
  /** The inline block (anchor, expiry, fees, salt, impairment words). Borrowed like the recipe. */
  inline: Sourced<InlineTemplateParams> | undefined;
  /** The frozen rate of a fixed-rate quote. NEVER borrowed: a rate is a quoted price term, so a
   *  cited option without one quoted no rate. */
  rate: Sourced<bigint> | undefined;
  /** The rate the request asks for, whatever the answer builds at. */
  requestedRate: bigint | undefined;
  /** What a cited answer took from the request because the cited option does not state it. */
  borrowed: BorrowedTerm[];
}

const sourced = <T>(value: T | undefined, from: TermSource): Sourced<T> | undefined => (value === undefined ? undefined : { value, from });

/** `cited` is the cited option's `market_template` wrapped in an object, so "a cited option with
 *  no template" (`{ template: undefined }`) is not the same call as "an uncited answer". */
export function quotedTerms(rfqTemplate: unknown, cited: { template: unknown } | undefined): QuotedTerms {
  const requestedRate = fixedRateOverrideOfTemplate(rfqTemplate);
  const requestRecipe = sourced(recipeAddressOfTemplate(rfqTemplate), "rfq");
  const requestInline = sourced(inlineParamsOfTemplate(rfqTemplate), "rfq");
  if (cited === undefined) return { recipe: requestRecipe, inline: requestInline, rate: sourced(requestedRate, "rfq"), requestedRate, borrowed: [] };
  const recipe = sourced(recipeAddressOfTemplate(cited.template), "cited option") ?? requestRecipe;
  const inline = sourced(inlineParamsOfTemplate(cited.template), "cited option") ?? requestInline;
  const borrowed: BorrowedTerm[] = [...(recipe?.from === "rfq" ? (["recipe"] as const) : []), ...(inline?.from === "rfq" ? (["inline block"] as const) : [])];
  return { recipe, inline, rate: sourced(fixedRateOverrideOfTemplate(cited.template), "cited option"), requestedRate, borrowed };
}
