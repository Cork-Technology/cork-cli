import { venueInstant } from "@cork/schemas";
// `ch query rfqs --watch`: the RFQ-firmness liveness loop (2026-09-11).
//
// The dead-kernel-underwriter signature, seen live on 2026-09-10: the requester posts a counter
// that ACCEPTS one quoted option (its `option_ref` names the answer and the option), and no
// resting order ever cites that option — the underwriter that quoted it never rested the cover.
// The venue cannot see it (a counter binds nobody; a quote is firm only when a live order cites
// it), so the buyer waits on a price nobody can buy. The loop re-reads the RFQ feed WITH answers
// (the `firm` labels come from the ranked-book join the read already makes), reduces every row
// to a small signature, diffs it against the previous tick, and names every accepted counter
// that no live order backs.
//
// Pure functions: the CLI loop calls them; the tests hold them to fixed rows. No venue field is
// trusted beyond its shape — a row that lacks a field reads as `null`, never as a verdict.

/** The requester's current counter, reduced: which option it accepts and how fresh it is. */
export interface RfqWatchCounter {
  counterId: string | null;
  answerId: string | null;
  optionId: string | null;
  premiumAnnualized: string | null;
  receivedAt: number | null;
  freshUntil: number | null;
}

/** One RFQ per tick: the fields whose movement the watcher reports. `backed` is the verdict on
 *  the counter — `true` = the cited option is firm (a live order cites it), `false` = it is not,
 *  `null` = no counter, a counter that cites no option, or the cited option sits beyond the
 *  truncated embed while other options ARE firm (undecidable from this read). */
export interface RfqWatchRow {
  rfqId: string;
  version: number | null;
  firmQuotes: number | null;
  indicativeQuotes: number | null;
  counter: RfqWatchCounter | null;
  backed: boolean | null;
}

/** An accepted counter no live order backs — the alert row. */
export interface RfqUnbacked {
  rfqId: string;
  version: number | null;
  counter: RfqWatchCounter;
  firmQuotes: number | null;
  indicativeQuotes: number | null;
  /** counter.fresh_until against the clock; null when the counter carries no fresh_until. */
  counterFresh: boolean | null;
  reason: string;
}

export interface RfqWatchChanges {
  changed: boolean;
  appeared: string[];
  gone: string[];
  moved: Array<{ rfqId: string; version: { from: number | null; to: number | null } }>;
  /** Every accepted counter that no live order backs on THIS tick (the full set, not a delta). */
  unbacked: RfqUnbacked[];
  /** RFQs whose accepted counter is backed on this tick and was unbacked on the previous one. */
  backedNow: string[];
  note: string;
}

/** A venue timestamp (received_at, fresh_until) as unix seconds through the shared boundary parser:
 *  integer seconds or strict explicit-zone ISO-8601; anything else null. */
const num = (v: unknown): number | null => {
  const t = venueInstant(v);
  return t ? Number(t.seconds) : null;
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function counterOf(row: Record<string, unknown>): RfqWatchCounter | null {
  const wrap = obj(row.counter);
  if (!wrap) return null;
  // The venue nests the signed counter under `counter.counter`; a flat shape is read the same way.
  const inner = obj(wrap.counter) ?? wrap;
  const ref = obj(inner.option_ref ?? inner.optionRef);
  return {
    counterId: str(wrap.counter_id ?? wrap.counterId),
    answerId: ref ? str(ref.answer_id ?? ref.answerId) : null,
    optionId: ref ? str(ref.option_id ?? ref.optionId) : null,
    premiumAnnualized: str(inner.premium_annualized ?? inner.premiumAnnualized),
    receivedAt: num(wrap.received_at ?? wrap.receivedAt),
    freshUntil: num(inner.fresh_until ?? inner.freshUntil),
  };
}

/** Is the option the counter cites labeled `firm` in this row's embed? `undefined` = not found. */
function citedOptionFirm(row: Record<string, unknown>, counter: RfqWatchCounter): boolean | undefined {
  if (counter.answerId === null || counter.optionId === null || !Array.isArray(row.answers)) return undefined;
  for (const a of row.answers as unknown[]) {
    const answer = obj(a);
    if (!answer || str(answer.answer_id ?? answer.answerId) !== counter.answerId) continue;
    const inner = obj(answer.answer) ?? answer;
    if (!Array.isArray(inner.options)) return undefined;
    for (const o of inner.options as unknown[]) {
      const option = obj(o);
      if (option && str(option.option_id ?? option.optionId) === counter.optionId) return option.firm === true;
    }
  }
  return undefined;
}

/** Reduce the read's rows (an rfqs read WITH answers — `firm`, `firmQuotes` ride along) to the
 *  watch signature. A row without an `rfq_id` is skipped: nothing can be keyed on it. */
export function rfqWatchRows(items: unknown): RfqWatchRow[] {
  if (!Array.isArray(items)) return [];
  const rows: RfqWatchRow[] = [];
  for (const it of items) {
    const row = obj(it);
    const rfqId = row ? str(row.rfq_id ?? row.rfqId) : null;
    if (!row || rfqId === null) continue;
    const counter = counterOf(row);
    const firmQuotes = num(row.firmQuotes);
    let backed: boolean | null = null;
    if (counter && counter.answerId !== null && counter.optionId !== null) {
      const firm = citedOptionFirm(row, counter);
      // Beyond the embed: nothing firm on the RFQ at all still refutes it; otherwise undecidable.
      backed = firm !== undefined ? firm : firmQuotes === 0 ? false : null;
    }
    rows.push({ rfqId, version: num(row.version), firmQuotes, indicativeQuotes: num(row.indicativeQuotes), counter, backed });
  }
  return rows;
}

/** Diff two ticks. `prev` undefined = the first read (everything `appeared`, nothing `changed`
 *  beyond the read itself — the loop prints tick 1 regardless). */
export function diffRfqWatch(prev: RfqWatchRow[] | undefined, next: RfqWatchRow[], nowSeconds: bigint): RfqWatchChanges {
  const before = new Map((prev ?? []).map((r) => [r.rfqId, r] as const));
  const after = new Map(next.map((r) => [r.rfqId, r] as const));
  const appeared = next.filter((r) => !before.has(r.rfqId)).map((r) => r.rfqId);
  const gone = [...before.keys()].filter((id) => !after.has(id));
  const moved: RfqWatchChanges["moved"] = [];
  for (const r of next) {
    const b = before.get(r.rfqId);
    if (b && b.version !== r.version) moved.push({ rfqId: r.rfqId, version: { from: b.version, to: r.version } });
  }
  const unbacked: RfqUnbacked[] = next
    .filter((r): r is RfqWatchRow & { counter: RfqWatchCounter } => r.counter !== null && r.backed === false)
    .map((r) => ({
      rfqId: r.rfqId,
      version: r.version,
      counter: r.counter,
      firmQuotes: r.firmQuotes,
      indicativeQuotes: r.indicativeQuotes,
      counterFresh: r.counter.freshUntil === null ? null : BigInt(r.counter.freshUntil) > nowSeconds,
      reason: `the requester's counter accepts option ${r.counter.optionId ?? "?"} of answer ${r.counter.answerId ?? "?"}${r.counter.premiumAnnualized !== null ? ` at premium ${r.counter.premiumAnnualized}` : ""}, and NO live resting order cites that option (firm quotes on this RFQ: ${r.firmQuotes ?? "unknown"}) — the underwriter that quoted it has not rested the cover; the buyer is waiting on a price nobody can buy. Ask the underwriter to rest the order (answer-rfq cites the option), or lift another firm quote`,
    }));
  const wasUnbacked = new Set((prev ?? []).filter((r) => r.counter !== null && r.backed === false).map((r) => r.rfqId));
  const isUnbacked = new Set(unbacked.map((u) => u.rfqId));
  const backedNow = next.filter((r) => r.backed === true && wasUnbacked.has(r.rfqId)).map((r) => r.rfqId);
  const unbackedMoved = prev !== undefined && (wasUnbacked.size !== isUnbacked.size || [...isUnbacked].some((id) => !wasUnbacked.has(id)));
  const changed = prev !== undefined && (appeared.length > 0 || gone.length > 0 || moved.length > 0 || unbackedMoved || backedNow.length > 0);
  return {
    changed,
    appeared,
    gone,
    moved,
    unbacked,
    backedNow,
    note: "rfqs watch: `version` is the venue's change counter per RFQ; `unbacked` lists every accepted counter (a counter whose option_ref names a quoted option) that no live resting order cites — read with answers embedded, so `firm` comes from the ranked-book join. A counter binds nobody; only a live order citing the option is a price the buyer can lift",
  };
}
