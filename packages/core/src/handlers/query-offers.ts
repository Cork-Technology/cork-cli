// cork_query offers: the unified discovery view. Split from query.ts (2026-09-03) — the two reads
// it composes (orderbook sort:best, rfqs with answers) are re-entered through the injected `read`
// (= handleQuery), so this module has no import cycle with the dispatcher.
import { type ChainId, Envelope, QueryInput, UNITS_TOPIC_REFERENCE } from "@cork/schemas";
import { envelope, type HandlerContext, unavailable } from "./shared.ts";
import type { QueryFilters } from "./filters.ts";

// ── offers: the unified discovery view (owner ruling 2026-09-02) ─────────────────────────────
// An OFFER is a price somebody can actually buy: a live, signed resting order. A quote (an RFQ
// answer option) is FIRM only when a live order cites it via quoteRef — otherwise it is
// INDICATIVE, a price nobody can buy, and it is counted here, never ranked. The view composes
// the two reads it needs by re-entering this handler — the ranked orderbook (hybrid-verified,
// best-first for filters.account) and the RFQ feed with the current answers embedded — and joins
// them on the citation. It adds no venue call the two reads do not already make.
type OfferQuote = { rfqId: string; answerId: string; optionId: string; underwriter: string | null; requester: string | null; premiumAnnualized: string | null; optionExpiry: string | null };
type IndicativeOption = OfferQuote & { reason: string };

function offerQuoteOf(rfq: Record<string, unknown>, answer: Record<string, unknown>, option: Record<string, unknown>): OfferQuote {
  const inner = (answer.answer && typeof answer.answer === "object" ? (answer.answer as Record<string, unknown>) : answer) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
  return {
    rfqId: String(rfq.rfq_id),
    answerId: String(answer.answer_id),
    optionId: String(option.option_id),
    underwriter: s(answer.underwriter) ?? s(inner.underwriter),
    requester: s(rfq.requester),
    premiumAnnualized: s(option.premium_annualized),
    optionExpiry: s(option.expiry),
  };
}

/** Walk every (rfq, answer, option) the RFQ rows embed. */
function* rfqOptions(rfqs: Array<Record<string, unknown>>): Generator<{ rfq: Record<string, unknown>; answer: Record<string, unknown>; option: Record<string, unknown> }> {
  for (const rfq of rfqs) {
    const answers = Array.isArray(rfq.answers) ? (rfq.answers as unknown[]) : [];
    for (const a of answers) {
      if (!a || typeof a !== "object") continue;
      const answer = a as Record<string, unknown>;
      const inner = (answer.answer && typeof answer.answer === "object" ? (answer.answer as Record<string, unknown>) : answer) as Record<string, unknown>;
      if (inner.status !== undefined && inner.status !== "quoted") continue; // a pass has no price
      const options = Array.isArray(inner.options) ? (inner.options as unknown[]) : [];
      for (const o of options) if (o && typeof o === "object") yield { rfq, answer, option: o as Record<string, unknown> };
    }
  }
}

/** A book row's citation (quoteRef), snake or camel, or null. */
export function quoteRefOf(row: Record<string, unknown>): { answerId: string; optionId: string; rfqId: string } | null {
  const ref = row.quoteRef ?? row.quote_ref;
  if (!ref || typeof ref !== "object") return null;
  const r = ref as Record<string, unknown>;
  const answerId = r.answer_id ?? r.answerId;
  const optionId = r.option_id ?? r.optionId;
  const rfqId = r.rfq_id ?? r.rfqId;
  return typeof answerId === "string" && typeof optionId === "string" ? { answerId, optionId, rfqId: typeof rfqId === "string" ? rfqId : "" } : null;
}

/** The (answer_id|option_id) keys LIVE resting rows cite: every ranked row, plus rows excluded
 *  ONLY for being reserved for another sender — live, just not yours. Dead or unreadable
 *  exclusions back nothing. Shared by `offers` and the `firm` flag on `rfqs` rows, so the two
 *  views never disagree on what backs a quote. */
export function citedOptionKeys(bookData: { items: Array<Record<string, unknown>>; excluded?: Array<Record<string, unknown>> }): Set<string> {
  const cited = new Set<string>();
  for (const row of bookData.items) {
    const ref = quoteRefOf(row);
    if (ref) cited.add(`${ref.answerId}|${ref.optionId}`);
  }
  for (const row of bookData.excluded ?? []) {
    if ((row as { exclusion?: string }).exclusion !== "reserved-for-other") continue;
    const ref = quoteRefOf(row);
    if (ref) cited.add(`${ref.answerId}|${ref.optionId}`);
  }
  return cited;
}

/** Label every embedded answer option `firm` (a live resting order cites it) or not, and
 *  count per RFQ. Rows without an `answers` embed pass through untouched. A pass has no options
 *  and is never firm. */
export function markFirmOptions(rows: Array<Record<string, unknown>>, cited: ReadonlySet<string>): Array<Record<string, unknown>> {
  return rows.map((rfq) => {
    if (!Array.isArray(rfq.answers)) return rfq;
    let firmQuotes = 0;
    let indicativeQuotes = 0;
    const answers = (rfq.answers as unknown[]).map((a) => {
      if (!a || typeof a !== "object") return a;
      const answer = a as Record<string, unknown>;
      const nested = answer.answer && typeof answer.answer === "object" ? (answer.answer as Record<string, unknown>) : null;
      const inner = nested ?? answer;
      const options = Array.isArray(inner.options) ? (inner.options as unknown[]) : [];
      let anyFirm = false;
      const labeled = options.map((o) => {
        if (!o || typeof o !== "object") return o;
        const option = o as Record<string, unknown>;
        const firm = cited.has(`${String(answer.answer_id)}|${String(option.option_id)}`);
        if (firm) { anyFirm = true; firmQuotes += 1; } else indicativeQuotes += 1;
        return { ...option, firm };
      });
      return nested ? { ...answer, firm: anyFirm, answer: { ...nested, options: labeled } } : { ...answer, firm: anyFirm, options: labeled };
    });
    return { ...rfq, answers, firmQuotes, indicativeQuotes };
  });
}

export async function handleQueryOffers(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext, read: (input: QueryInput, ctx: HandlerContext) => Promise<Envelope>): Promise<Envelope> {
  if (input.mode !== undefined && input.mode !== "hybrid") {
    return unavailable(chainId, "mode_unavailable", "cork_query('offers') is venue-backed (it joins the orderbook with the RFQ feed); omit mode or use 'hybrid'", ctx);
  }
  // Leg 1: the ranked book for this fill sender. Leg 2: the RFQ feed with the current answers.
  // Both are the SAME reads a caller could make by hand; composing them here is what makes the
  // join, the tally, and the ranking one coherent answer.
  const book = await read({ ...input, resource: "orderbook", sort: "best", filters: { ...(filters.poolId ? { poolId: filters.poolId } : {}), ...(filters.side ? { side: filters.side } : {}), ...(filters.account ? { account: filters.account } : {}) } }, ctx);
  if (book.state !== "ok") return book;
  const rfqs = filters.rfqId
    ? await read({ ...input, resource: "rfqs", filters: { rfqId: filters.rfqId, view: "current" } }, ctx)
    : await read({ ...input, resource: "rfqs", filters: { withAnswers: true, view: "current" } }, ctx);
  const rfqRows: Array<Record<string, unknown>> = rfqs.state === "ok" ? ((rfqs.data as { items?: Array<Record<string, unknown>> }).items ?? []) : [];

  // The citation index: (answer_id, option_id) → the quote it names.
  const quotes = new Map<string, OfferQuote>();
  for (const { rfq, answer, option } of rfqOptions(rfqRows)) {
    const q = offerQuoteOf(rfq, answer, option);
    quotes.set(`${q.answerId}|${q.optionId}`, q);
  }
  const bookData = book.data as { items: Array<Record<string, unknown>>; excluded?: Array<Record<string, unknown>>; count: number; fillableCount?: number; rankedFor?: string | null; verification?: unknown; pagination?: unknown; scales?: Record<string, string> };
  // A row this sender may not fill but that is LIVE (reserved for someone else) still backs the
  // quote it cites: firmness is about the order existing, not about who may lift it. Dead or
  // unreadable exclusions back nothing. (citedOptionKeys — the same set the rfqs `firm` flag uses.)
  const cited = citedOptionKeys(bookData);
  const items = bookData.items.map((row) => {
    const ref = quoteRefOf(row);
    // A row is FIRM-cited only when BOTH ids resolve to an option the venue currently serves;
    // an answer id alone could name a different option's terms.
    const quote = ref ? (quotes.get(`${ref.answerId}|${ref.optionId}`) ?? null) : null;
    return { ...row, provenance: ref ? (quote ? "cited" : "cited-unresolved") : "uncited", quote: quote ?? (ref ? { rfqId: ref.rfqId, answerId: ref.answerId, optionId: ref.optionId, resolved: false } : null) };
  });
  // If an rfqId was asked for, only offers executing THAT request qualify.
  const scoped = filters.rfqId ? items.filter((it) => it.quote !== null && (it.quote as { rfqId: string }).rfqId === filters.rfqId) : items;
  const indicative: IndicativeOption[] = [];
  for (const q of quotes.values()) {
    if (!cited.has(`${q.answerId}|${q.optionId}`)) indicative.push({ ...q, reason: "no live resting order cites this option — a price nobody can buy yet" });
  }

  const warnings = [...book.warnings.map((w) => ({ ...w, message: `orderbook: ${w.message}` })), ...rfqs.warnings.map((w) => ({ ...w, message: `rfqs: ${w.message}` }))];
  if (rfqs.state !== "ok") warnings.push({ code: "needs_service", message: `the RFQ leg did not answer (${rfqs.warnings[0]?.code ?? rfqs.state}); offers are served from the book alone, so every order reads uncited and no indicative tally exists` });
  return envelope({
    state: "ok",
    data: {
      resource: "offers",
      rankedFor: bookData.rankedFor ?? null,
      count: scoped.length,
      items: scoped.map((it, i) => ({ ...it, rank: i + 1 })),
      ...(bookData.excluded ? { excluded: bookData.excluded } : {}),
      indicative: { count: indicative.length, options: indicative },
      ...(bookData.fillableCount !== undefined ? { fillableCount: bookData.fillableCount } : {}),
      ...(bookData.verification ? { verification: bookData.verification } : {}),
      pagination: { orderbook: bookData.pagination, rfqs: rfqs.state === "ok" ? (rfqs.data as { pagination?: unknown }).pagination ?? null : null },
      scales: { ...(bookData.scales ?? {}), premiumAnnualized: "annualized decimal-fraction STRING (\"0.041\" = 4.1%) — the venue's quote scale, shown for the citation, never used for ranking", unitsTopic: UNITS_TOPIC_REFERENCE },
      note: "an offer is a live signed order (cited = it executes an RFQ answer option; uncited = a standing order). A quote is FIRM only when a live order cites it; `indicative` counts the served answer options no live order backs — prices nobody can buy yet. Ranking, exclusion, and verification are the orderbook's (sort best); the RFQ leg is venue-claimed",
    },
    chainId,
    source: "indexer",
    warnings,
    ctx,
  });
}
