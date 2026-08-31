// Live contract gate for the venue's RFQ NEGOTIATION surface (answer revisions, requester
// counters, view=current frontier, version change-polling) —
// asserted against the REAL deployed venue through our own read path, so a venue contract
// change surfaces here the way the registry redeploy surfaced in rpc-live. Self-skips unless
// CORK_RPC_LIVE=1 (same convention as rpc-live.test.ts); tolerates an unreachable venue and an
// empty RFQ table (structural assertions only run over what exists — live data is never
// value-pinned, only shape-and-invariant pinned).
import { describe, expect, it } from "vitest";
import { runTool } from "@cork/core";
import type { Envelope } from "@cork/schemas";

const LIVE = process.env.CORK_RPC_LIVE === "1";

interface RfqRow {
  rfq_id: string;
  state: string;
  version: number;
  answer_count: number;
  answers?: Array<{ answer_id: string; underwriter?: string; revisions?: number; answer?: Record<string, unknown> }>;
  answers_truncated?: boolean;
  truncated?: boolean;
  counter?: { counter_id: string; counter?: Record<string, unknown> } | null;
  request?: Record<string, unknown>;
}

const itemsOf = (env: Envelope): RfqRow[] => (env.data as { items?: RfqRow[] }).items ?? [];

/** One list read via the real tool path; null when the venue is unreachable (do not fail the
 *  run on the external dependency — but a venue that ANSWERS with a broken shape must fail). */
async function listRfqs(filters: Record<string, unknown>): Promise<Envelope | null> {
  const env = await runTool("cork_query", { resource: "rfqs", chainId: 42161, filters, pageSize: 25, format: "concise" }, {});
  if (env.state === "unavailable" && env.warnings.some((w) => w.code === "venue_unreachable" || w.code === "venue_rate_limited")) return null;
  return env;
}

describe.skipIf(!LIVE)("RFQ negotiation surface — live venue contract", () => {
  it("every RFQ row carries the monotonic `version`; view=current serves one thread per underwriter with revision counts", async () => {
    // Expired RFQs accumulate history, so they are the stable place to observe negotiation
    // artifacts; open ones may legitimately be absent at any moment.
    const env = await listRfqs({ state: "expired", withAnswers: true, view: "current" });
    if (env === null) return; // venue down — nothing to assert, nothing to fail
    expect(env.state).toBe("ok");
    const rows = itemsOf(env);
    if (rows.length === 0) return; // fresh venue: shape asserted by state=ok alone
    for (const row of rows) {
      // `version` is on EVERY read (the venue bumps it in-transaction on every stored
      // answer/counter). NO relation to answer_count is promised: the migration backfills
      // `DEFAULT 0`, so pre-negotiation answers never counted (observed live: an RFQ with
      // 7 stored answers at version 6). The contract is presence + monotonicity, nothing more.
      expect(Number.isInteger(row.version), `${row.rfq_id}: version missing/non-integer`).toBe(true);
      expect(row.version).toBeGreaterThanOrEqual(0);
      // `counter` is present (possibly null) whenever answers are embedded.
      expect("counter" in row, `${row.rfq_id}: counter field missing from with_answers read`).toBe(true);
      const answers = row.answers ?? [];
      // view=current contract: one row per underwriter thread, each carrying its thread
      // identity + stored-revision count.
      const underwriters = answers.map((a) => a.underwriter);
      for (const [i, a] of answers.entries()) {
        expect(typeof a.underwriter, `${row.rfq_id}: answers[${i}].underwriter missing in view=current`).toBe("string");
        expect(Number.isInteger(a.revisions) && (a.revisions ?? 0) >= 1, `${row.rfq_id}: answers[${i}].revisions missing/zero`).toBe(true);
      }
      expect(new Set(underwriters.map((u) => u?.toLowerCase())).size, `${row.rfq_id}: duplicate underwriter threads in the frontier`).toBe(underwriters.length);
    }
  });

  it("single-get frontier arithmetic: thread revisions PARTITION the stored rows (sum(revisions) == answer_count)", async () => {
    const list = await listRfqs({ state: "expired" });
    if (list === null) return;
    // Pick the most negotiated RFQ visible; skip cleanly when the venue holds none.
    const candidate = itemsOf(list).sort((a, b) => b.answer_count - a.answer_count)[0];
    if (!candidate || candidate.answer_count === 0) return;

    const [full, current] = await Promise.all([
      listRfqs({ rfqId: candidate.rfq_id, view: "full" }),
      listRfqs({ rfqId: candidate.rfq_id, view: "current" }),
    ]);
    if (full === null || current === null) return;
    const f = itemsOf(full)[0]!;
    const c = itemsOf(current)[0]!;

    // The frontier is a REDUCTION of the history: at most one row per thread, never more rows
    // than stored answers, and — when neither read is truncated — the thread revision counts
    // partition the stored rows exactly (the venue's latest-per-sender supersession model).
    expect((c.answers ?? []).length).toBeLessThanOrEqual(f.answer_count);
    if (f.truncated !== true && c.truncated !== true) {
      const partitioned = (c.answers ?? []).reduce((n, a) => n + (a.revisions ?? 0), 0);
      expect(partitioned, `${candidate.rfq_id}: frontier revisions do not partition the stored rows`).toBe(f.answer_count);
      expect((f.answers ?? []).length, `${candidate.rfq_id}: view=full embed disagrees with answer_count`).toBe(f.answer_count);
    }
    // `version` is monotonic — two reads of the same RFQ may only move forward.
    expect(c.version).toBeGreaterThanOrEqual(f.version);
    // A stored counter surfaces with its payload on the single get.
    if (c.counter) {
      expect(typeof c.counter.counter_id).toBe("string");
      expect(typeof (c.counter.counter as { premium_annualized?: unknown } | undefined)?.premium_annualized).toBe("string");
    }
  });
});
