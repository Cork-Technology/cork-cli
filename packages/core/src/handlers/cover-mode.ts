// The cover an ORDER delivers against the cover an RFQ asks for — read from identities, never
// from a label (cork-cli#6, 2026-10-07). An RFQ's `modes` name what a requester accepts; nothing
// on chain reads them. What a cST IS is decided by the recipe the market is created under, and
// an order's JIT block names that recipe and carries the limits it resolved. So the answer side
// (an option's label beside its template) and the requester side (a fill of a cited order) are
// both judged here from the recipe and the limits, and a label that disagrees is named.
//
// Nothing here refuses: the venue admits counter-proposals, and a requester may want one. Every
// verdict is build-and-warn with the facts in `data.cover`, so the signer decides with them.
import { RFQ_MODES, type RfqMode } from "@cork/schemas";
import { COVER_LABELS, COVER_RFQ_MODE, type CoverKind, coverKindOfConstraint, coverKindOfRecipeName, RFQ_MODE_COVER } from "../cover.ts";
import { resolveGenerations } from "../config-remote.ts";
import { classifyAddress, type ResolvedGeneration } from "../generations.ts";
import { getRfq } from "../datasources/venue.ts";
import { decodeJitExtensionFor } from "../jit-extension.ts";
import { recipeAddressOfTemplate } from "../orders-answer.ts";
import { quoteRefOf } from "./query-offers.ts";
import { resolveCitation } from "./rfq-citation.ts";
import { type HandlerContext, venueDepsOf } from "./shared.ts";

export interface Warning {
  code: string;
  message: string;
}

/** The modes an RFQ record asks for, as the venue serves them (`modes` on a flattened record,
 *  `request.modes` on a raw v2 row); unknown values dropped. */
export function rfqModesOf(rfq: Record<string, unknown> | undefined): RfqMode[] {
  const request = rfq?.request;
  const raw = Array.isArray(rfq?.modes) ? rfq.modes : request && typeof request === "object" && Array.isArray((request as { modes?: unknown }).modes) ? (request as { modes: unknown[] }).modes : [];
  return raw.filter((m): m is RfqMode => (RFQ_MODES as readonly unknown[]).includes(m));
}

/** A recipe address → the cover its pools give, by the configured hint (chain-free). */
export function coverOfRecipeAddress(generations: readonly ResolvedGeneration[], address: `0x${string}`): { kind: CoverKind | undefined; recipeName: string | undefined; generation: string | undefined } {
  const hit = classifyAddress(generations, address).find((c) => c.role === "recipe");
  return { kind: coverKindOfRecipeName(hit?.recipeName), recipeName: hit?.recipeName, generation: hit?.label };
}

/** What a resting order's JIT block will CREATE: the cover of the recipe it names, else the
 *  cover its carried limits describe (the chain's own reading, hint-free). An order without a
 *  JIT block fills on a pool that already exists, whose cover is not in the bytes. */
export type DeliveredCover =
  | { kind: CoverKind; by: "recipe" | "constraint"; recipe: `0x${string}`; recipeName: string | null; generation: string }
  | { kind: null; by: "no-jit-block" | "unclassified-adapter" | "unreadable"; recipe: null };

export function deliveredCoverOfExtension(generations: readonly ResolvedGeneration[], extension: `0x${string}` | undefined): DeliveredCover {
  if (extension === undefined || extension === "0x") return { kind: null, by: "no-jit-block", recipe: null };
  let dec: ReturnType<typeof decodeJitExtensionFor>;
  try {
    dec = decodeJitExtensionFor(generations, extension);
  } catch {
    return { kind: null, by: "unreadable", recipe: null };
  }
  if (dec === null) return { kind: null, by: "unclassified-adapter", recipe: null };
  if (dec.wire === "legacy") return { kind: null, by: "unreadable", recipe: null };
  const recipe = dec.params.recipe;
  const byRecipe = coverOfRecipeAddress(generations, recipe);
  if (byRecipe.kind !== undefined) return { kind: byRecipe.kind, by: "recipe", recipe, recipeName: byRecipe.recipeName ?? null, generation: dec.generation };
  const byConstraint = coverKindOfConstraint(dec.params.constraint);
  return { kind: byConstraint, by: "constraint", recipe, recipeName: null, generation: dec.generation };
}

const say = (kind: CoverKind) => `${kind} cover (${COVER_LABELS[kind]})`;
const modeCover = (mode: string): CoverKind | undefined => ((RFQ_MODES as readonly unknown[]).includes(mode) ? RFQ_MODE_COVER[mode as RfqMode] : undefined);

/** The requester-side verdict for a fill of a cited order: the covers the RFQ asked for against
 *  the cover the order creates, and the label the cited option carries against both. */
export function requesterCoverVerdict(a: { rfqId: string; requested: RfqMode[]; delivered: DeliveredCover; citedOptionMode: string | undefined; requester: string | undefined; filler: string; notRead?: string | undefined }): { cover: Record<string, unknown>; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const fillerIsRequester = a.requester !== undefined && a.requester.toLowerCase() === a.filler.toLowerCase();
  const labelKind = a.citedOptionMode !== undefined ? modeCover(a.citedOptionMode) : undefined;
  let agrees: boolean | null = null;
  if (a.notRead !== undefined) {
    warnings.push({ code: "invalid_order_terms", message: `this order cites RFQ ${a.rfqId}, which could not be read (${a.notRead}): the cover this fill buys was NOT compared with the request's modes — read the RFQ before signing if you are the requester` });
  } else if (a.delivered.kind !== null) {
    const deliveredMode = COVER_RFQ_MODE[a.delivered.kind];
    const requested = a.requested;
    agrees = requested.length === 0 ? null : requested.includes(deliveredMode);
    if (requested.length > 0 && !requested.includes(deliveredMode)) {
      const asked = requested.map((m) => `${m} = ${say(RFQ_MODE_COVER[m])}`).join("; ");
      const label = a.citedOptionMode !== undefined ? ` The cited option is labelled ${a.citedOptionMode}${labelKind !== undefined && labelKind !== a.delivered.kind ? ", which does not name this cover either" : ""}.` : "";
      warnings.push({
        code: "cover_mode_mismatch",
        message: `RFQ ${a.rfqId} asks for ${asked}, and the order this fill lifts creates its pool under the ${a.delivered.recipeName ?? "unnamed"} recipe ${a.delivered.recipe} (${a.delivered.generation}), which gives ${say(a.delivered.kind)}.${label} Filling it buys a DIFFERENT cover than the request named — the venue admits counter-proposals, so this is for ${fillerIsRequester ? "you, the requester," : "the requester"} to accept or refuse: sign only if ${a.delivered.kind} cover is what you want; the bytes below are the fill as it would run`,
      });
    } else if (labelKind !== undefined && labelKind !== a.delivered.kind) {
      warnings.push({
        code: "cover_mode_mismatch",
        message: `the cited option is labelled ${a.citedOptionMode} (${say(labelKind)}), but the order creates its pool under the ${a.delivered.recipeName ?? "unnamed"} recipe ${a.delivered.recipe}, which gives ${say(a.delivered.kind)}: the label misdescribes the cover; the request's modes (${a.requested.join(", ")}) do admit ${a.delivered.kind} cover, so the fill buys what was asked under a wrong label`,
      });
    }
  }
  const cover = {
    rfqId: a.rfqId,
    requestedModes: a.requested,
    requestedCovers: a.requested.map((m) => RFQ_MODE_COVER[m]),
    delivered: a.delivered.kind === null ? { kind: null, by: a.delivered.by, note: a.delivered.by === "no-jit-block" ? "the order fills on an existing pool: its cover is not in the order's bytes — read the pool (cork_query cork-pool, data.cover) before signing" : "the order's hook could not be read on any configured generation" } : { kind: a.delivered.kind, by: a.delivered.by, recipe: a.delivered.recipe, recipeName: a.delivered.recipeName, generation: a.delivered.generation },
    citedOptionMode: a.citedOptionMode ?? null,
    agrees,
    requester: a.requester ?? null,
    fillerIsRequester,
    ...(a.notRead !== undefined ? { notRead: a.notRead } : {}),
    rule: "the recipe the order's JIT block names decides the cover; the RFQ's modes name what the requester accepts; a mismatch is warned, never refused (counter-proposals are admitted)",
  };
  return { cover, warnings };
}

/** The requester-side reading for a venue book row: the row's quote_ref → the RFQ record → the
 *  verdict. Undefined when the row cites nothing (no RFQ to compare with). */
export async function requesterCoverReading(a: { ctx: HandlerContext; chainId: number; row: Record<string, unknown>; extension: `0x${string}` | undefined; account: `0x${string}` }): Promise<{ cover: Record<string, unknown>; warnings: Warning[] } | undefined> {
  const ref = quoteRefOf(a.row);
  if (ref === null) return undefined;
  const { generations } = await resolveGenerations(a.chainId);
  const delivered = deliveredCoverOfExtension(generations, a.extension);
  let rfq: Record<string, unknown> | null = null;
  let notRead: string | undefined;
  try {
    rfq = await getRfq(venueDepsOf(a.ctx), ref.rfqId);
    if (rfq === null) notRead = `RFQ ${ref.rfqId} is unknown to the venue's /rfqs/v2`;
  } catch (err) {
    notRead = `the venue did not serve RFQ ${ref.rfqId}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
  const cited = rfq ? resolveCitation(rfq, ref.answerId, ref.optionId).option : undefined;
  const citedOptionMode = typeof cited?.mode === "string" ? cited.mode : undefined;
  const requester = typeof rfq?.requester === "string" ? rfq.requester : undefined;
  return requesterCoverVerdict({ rfqId: ref.rfqId, requested: rfqModesOf(rfq ?? undefined), delivered, citedOptionMode, requester, filler: a.account, notRead });
}

/** The answer-side verdict for the options of an rfq-answer relay: each option's label against
 *  the cover its template's recipe gives, and against the covers the request asks for. Chain-free
 *  (the configured recipe hints); an option whose template names no recipe is not judged. */
export async function answerOptionsCoverWarnings(chainId: number, rfq: Record<string, unknown> | undefined, options: ReadonlyArray<Record<string, unknown>>): Promise<Warning[]> {
  const requested = rfqModesOf(rfq);
  const rfqId = typeof rfq?.rfq_id === "string" ? rfq.rfq_id : "the RFQ";
  const { generations } = await resolveGenerations(chainId);
  const warnings: Warning[] = [];
  for (const [i, o] of options.entries()) {
    const mode = typeof o.mode === "string" ? o.mode : undefined;
    const labelled = mode !== undefined ? modeCover(mode) : undefined;
    const recipe = recipeAddressOfTemplate(o.market_template);
    const templateKind = recipe !== undefined ? coverOfRecipeAddress(generations, recipe).kind : undefined;
    if (templateKind !== undefined && labelled !== undefined && templateKind !== labelled) {
      const { recipeName } = coverOfRecipeAddress(generations, recipe!);
      warnings.push({ code: "cover_mode_mismatch", message: `options[${i}] is labelled ${mode} (${say(labelled)}), but its template names the ${recipeName ?? "unnamed"} recipe ${recipe}, which gives ${say(templateKind)} — the venue relays the label as written and a requester reading it is misled; label the option ${COVER_RFQ_MODE[templateKind]}, or quote a recipe that gives ${labelled} cover. Relayed as asked` });
    }
    if (mode !== undefined && requested.length > 0 && !requested.includes(mode as RfqMode)) {
      warnings.push({ code: "cover_mode_mismatch", message: `options[${i}] quotes mode ${mode}, which ${rfqId} does not ask for (${requested.join(", ")}) — a visible counter-proposal the requester may ignore or refuse at fill time. Relayed as asked` });
    }
  }
  return warnings;
}
