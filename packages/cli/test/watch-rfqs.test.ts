// `ch query rfqs --watch` — the pure reduction and diff behind the RFQ-firmness liveness loop.
// The rows are the venue's live shape (captured 2026-09-11: `counter: { counter_id, received_at,
// counter: { option_ref: { answer_id, option_id }, premium_annualized, fresh_until } }`, answers
// nested under `answer`, `firm` labels from the ranked-book join).
import { describe, expect, it } from "vitest";
import { diffRfqWatch, rfqWatchRows } from "../src/watch-rfqs.ts";

const NOW = 1_789_120_000n;
type Opt = { option_id: string; firm?: boolean };
const rfq = (id: string, version: number, answers: Array<{ answer_id: string; options: Opt[] }>, counter?: { answerId: string; optionId: string; freshUntil?: number; premium?: string }) => {
  let firmQuotes = 0;
  let indicativeQuotes = 0;
  for (const a of answers) for (const o of a.options) (o.firm ? firmQuotes++ : indicativeQuotes++);
  return {
    rfq_id: id,
    version,
    firmQuotes,
    indicativeQuotes,
    answers: answers.map((a) => ({ answer_id: a.answer_id, underwriter: "0xabc", firm: a.options.some((o) => o.firm), answer: { status: "quoted", options: a.options.map((o) => ({ ...o, premium_annualized: "0.04" })) } })),
    counter: counter
      ? { counter_id: `ctr_${id}`, received_at: Number(NOW) - 60, counter: { requester: "0xreq", option_ref: { answer_id: counter.answerId, option_id: counter.optionId }, premium_annualized: counter.premium ?? "0.0365", fresh_until: counter.freshUntil ?? Number(NOW) + 600, schema_version: "1" } }
      : null,
  };
};

describe("rfqWatchRows — the per-RFQ signature", () => {
  it("reduces version, firm counts, and the counter; a counter that accepts a FIRM option is backed", () => {
    const rows = rfqWatchRows([rfq("rfq_a", 3, [{ answer_id: "ansA", options: [{ option_id: "o1", firm: true }] }], { answerId: "ansA", optionId: "o1" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rfqId: "rfq_a", version: 3, firmQuotes: 1, indicativeQuotes: 0, backed: true });
    expect(rows[0]!.counter).toEqual({ counterId: "ctr_rfq_a", answerId: "ansA", optionId: "o1", premiumAnnualized: "0.0365", receivedAt: Number(NOW) - 60, freshUntil: Number(NOW) + 600 });
  });
  it("a counter that accepts an INDICATIVE option is unbacked; no counter, or a counter citing no option, is null (no verdict)", () => {
    const soft = rfqWatchRows([rfq("rfq_b", 2, [{ answer_id: "ansB", options: [{ option_id: "o1", firm: false }] }], { answerId: "ansB", optionId: "o1" })]);
    expect(soft[0]!.backed).toBe(false);
    const none = rfqWatchRows([rfq("rfq_c", 1, [{ answer_id: "ansC", options: [{ option_id: "o1", firm: false }] }])]);
    expect(none[0]!.counter).toBeNull();
    expect(none[0]!.backed).toBeNull();
    const flat = rfqWatchRows([{ rfq_id: "rfq_d", version: 1, firmQuotes: 0, indicativeQuotes: 1, answers: [], counter: { counter_id: "c", received_at: 1, counter: { premium_annualized: "0.03" } } }]);
    expect(flat[0]!.counter).toMatchObject({ counterId: "c", answerId: null, optionId: null, premiumAnnualized: "0.03" });
    expect(flat[0]!.backed).toBeNull();
  });
  it("a cited option beyond the embed: nothing firm on the RFQ refutes it; something firm leaves it undecidable (null)", () => {
    const nothingFirm = rfqWatchRows([rfq("rfq_e", 5, [{ answer_id: "ansX", options: [{ option_id: "o1", firm: false }] }], { answerId: "ansGone", optionId: "o9" })]);
    expect(nothingFirm[0]!.backed).toBe(false);
    const someFirm = rfqWatchRows([rfq("rfq_f", 5, [{ answer_id: "ansX", options: [{ option_id: "o1", firm: true }] }], { answerId: "ansGone", optionId: "o9" })]);
    expect(someFirm[0]!.backed).toBeNull();
  });
  it("rows without an rfq_id, non-object rows, and a non-array input are skipped, never thrown on", () => {
    expect(rfqWatchRows(undefined)).toEqual([]);
    expect(rfqWatchRows([null, 7, { version: 1 }, { rfq_id: "rfq_g" }])).toEqual([{ rfqId: "rfq_g", version: null, firmQuotes: null, indicativeQuotes: null, counter: null, backed: null }]);
  });
});

describe("diffRfqWatch — what a tick reports", () => {
  const a1 = rfqWatchRows([rfq("rfq_a", 1, [{ answer_id: "ansA", options: [{ option_id: "o1", firm: true }] }, { answer_id: "ansB", options: [{ option_id: "o1", firm: false }] }])]);
  const a2counter = rfqWatchRows([rfq("rfq_a", 2, [{ answer_id: "ansA", options: [{ option_id: "o1", firm: true }] }, { answer_id: "ansB", options: [{ option_id: "o1", firm: false }] }], { answerId: "ansB", optionId: "o1" })]);
  const a2backed = rfqWatchRows([rfq("rfq_a", 2, [{ answer_id: "ansA", options: [{ option_id: "o1", firm: true }] }, { answer_id: "ansB", options: [{ option_id: "o1", firm: true }] }], { answerId: "ansB", optionId: "o1" })]);

  it("the first read: everything appeared, nothing changed (the loop prints tick 1 regardless)", () => {
    const d = diffRfqWatch(undefined, a1, NOW);
    expect(d.changed).toBe(false);
    expect(d.appeared).toEqual(["rfq_a"]);
    expect(d.unbacked).toEqual([]);
  });
  it("an unchanged tick is quiet", () => {
    const d = diffRfqWatch(a1, a1, NOW);
    expect(d.changed).toBe(false);
    expect(d.moved).toEqual([]);
  });
  it("a version move is reported; an accepted counter that no live order cites is the alert, with freshness against the clock", () => {
    const d = diffRfqWatch(a1, a2counter, NOW);
    expect(d.changed).toBe(true);
    expect(d.moved).toEqual([{ rfqId: "rfq_a", version: { from: 1, to: 2 } }]);
    expect(d.unbacked).toHaveLength(1);
    const u = d.unbacked[0]!;
    expect(u).toMatchObject({ rfqId: "rfq_a", version: 2, firmQuotes: 1, indicativeQuotes: 1, counterFresh: true });
    expect(u.counter).toMatchObject({ answerId: "ansB", optionId: "o1", premiumAnnualized: "0.0365" });
    expect(u.reason).toContain("NO live resting order cites that option");
    expect(u.reason).toContain("ansB");
    expect(u.reason).toContain("0.0365");
    // A stale counter is still reported, labeled not fresh.
    const stale = rfqWatchRows([rfq("rfq_a", 2, [{ answer_id: "ansB", options: [{ option_id: "o1", firm: false }] }], { answerId: "ansB", optionId: "o1", freshUntil: Number(NOW) - 1 })]);
    expect(diffRfqWatch(a1, stale, NOW).unbacked[0]!.counterFresh).toBe(false);
  });
  it("the alert set moving is a change on its own (the book moved, the RFQ did not): an order resting behind the counter clears it as backedNow", () => {
    const d = diffRfqWatch(a2counter, a2backed, NOW);
    expect(d.changed).toBe(true);
    expect(d.moved).toEqual([]);
    expect(d.unbacked).toEqual([]);
    expect(d.backedNow).toEqual(["rfq_a"]);
    // And the reverse: the citing order dies (the option loses `firm`) with no version move.
    const back = diffRfqWatch(a2backed, a2counter, NOW);
    expect(back.changed).toBe(true);
    expect(back.unbacked.map((u) => u.rfqId)).toEqual(["rfq_a"]);
    expect(back.backedNow).toEqual([]);
    // Same alert on two consecutive ticks: still listed, but not a change.
    const same = diffRfqWatch(a2counter, a2counter, NOW);
    expect(same.changed).toBe(false);
    expect(same.unbacked).toHaveLength(1);
  });
  it("gone RFQs are reported once", () => {
    const d = diffRfqWatch(a1, [], NOW);
    expect(d.changed).toBe(true);
    expect(d.gone).toEqual(["rfq_a"]);
  });
});
