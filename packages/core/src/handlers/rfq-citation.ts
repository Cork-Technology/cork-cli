// A quote_ref resolved against the RFQ record the venue serves (its TRUNCATED answers embed).
// Shared by the relay (cork_submit lop-order's party rule) and the requester's fill (the cover
// the cited option is labelled with), so the two never read the embed differently.

/** One row of an RFQ record's `answers` embed as the venue's full view serves it: the
 *  underwriter beside the answer payload, the options inside the payload. */
export interface CitedAnswer {
  answer_id?: unknown;
  underwriter?: unknown;
  answer?: { options?: Array<Record<string, unknown>> };
}

/**
 * Resolve a quote_ref against the RFQ's TRUNCATED answers embed. The venue serves the newest
 * answers first and marks the cut (`truncated: true`); superseded answers stay citable, so a
 * missing ANSWER proves absence only when the embed is complete. `unresolved` = the answer may
 * exist beyond the truncation horizon; the caller relays and lets the venue's full-store check
 * rule. A missing OPTION inside a resolved answer is definitive: an embedded answer row carries
 * its whole payload.
 */
export function resolveCitation(rfq: Record<string, unknown>, answerId: string, optionId: string): { answer: CitedAnswer | undefined; option: Record<string, unknown> | undefined; unresolved: boolean } {
  const answers = (rfq.answers ?? []) as CitedAnswer[];
  const answer = answers.find((a) => String(a.answer_id) === answerId);
  const option = answer?.answer?.options?.find((o) => String(o.option_id) === optionId);
  return { answer, option, unresolved: answer === undefined && rfq.truncated === true };
}
