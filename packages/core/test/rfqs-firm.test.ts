// rfqs — the `firm` flag on embedded answers and the venue-side `underwriter` filter (2026-09-04).
// Runs against the eval stub's venue: one open RFQ with a FIRM answer (the resting row cites its
// option via quoteRef) and a SOFT answer nobody backed, on a book of two live rows (one open, one
// reserved for a nobody). The chain is the stub's (rows read live), the same stack `offers` uses.
import { describe, expect, it } from "vitest";
import { runTool, ToolInputError } from "@cork/core";
import { FIRM_ANSWER_ID, RFQ_OPEN_ID, SIGNED_LOP_PAYLOAD, SOFT_ANSWER_ID, SOFT_UNDERWRITER, stubContext } from "../../../evals/stub.ts";

// The stub's book (and the resting row's signature) live on chainId 1; its RFQ feed answers any
// chain. Read on 1 so the join sees the live rows, exactly as the offers fixtures do.
const CHAIN = 1;
const RESTING_MAKER_ADDRESS = SIGNED_LOP_PAYLOAD.order.maker;

type Option = { option_id: string; firm?: boolean };
type Answer = { answer_id: string; firm?: boolean; answer: { options: Option[] } };
type Row = { rfq_id: string; answers?: Answer[]; firmQuotes?: number; indicativeQuotes?: number };
type Data = { count: number; items: Row[]; firmness?: { source: string; orderbookPagination: unknown } };

const ctx = stubContext();
const read = (filters: Record<string, unknown>) => runTool("cork_query", { resource: "rfqs", chainId: CHAIN, filters, pageSize: 25, format: "concise" }, ctx);
const issueOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ToolInputError);
  return (err as ToolInputError & { issues: Array<{ message: string }> }).issues[0]!.message;
};

describe("cork_query rfqs — firm flags from the ranked-book join", () => {
  it("with answers embedded, every option and answer says whether a LIVE resting order cites it; counts ride per RFQ", async () => {
    const env = await read({ withAnswers: true });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as Data;
    expect(d.count).toBe(1);
    const row = d.items[0]!;
    const firm = row.answers!.find((a) => a.answer_id === FIRM_ANSWER_ID)!;
    const soft = row.answers!.find((a) => a.answer_id === SOFT_ANSWER_ID)!;
    expect(firm.firm).toBe(true);
    expect(firm.answer.options[0]!.firm).toBe(true);
    expect(soft.firm).toBe(false);
    expect(soft.answer.options[0]!.firm).toBe(false);
    expect(row.firmQuotes).toBe(1);
    expect(row.indicativeQuotes).toBe(1);
    expect(d.firmness?.source).toContain("quoteRef");
    expect(d.firmness?.orderbookPagination).toBeTruthy();
  });

  it("the single-record read labels the same way; a feed read WITHOUT answers carries no flags and makes no book read", async () => {
    const one = await read({ rfqId: RFQ_OPEN_ID });
    expect(one.state).toBe("ok");
    const row = (one.data as Data).items[0]!;
    expect(row.answers!.find((a) => a.answer_id === FIRM_ANSWER_ID)!.firm).toBe(true);
    expect(row.answers!.find((a) => a.answer_id === SOFT_ANSWER_ID)!.firm).toBe(false);
    expect(row.firmQuotes).toBe(1);

    const bare = await read({});
    expect(bare.state).toBe("ok");
    const b = bare.data as Data;
    expect(b.items[0]!.answers).toBeUndefined();
    expect("firmQuotes" in b.items[0]!).toBe(false);
    expect(b.firmness).toBeUndefined();
  });

  it("firm agrees with the offers view: the option offers calls firm is the one flagged here, and the indicative one is the one offers counts", async () => {
    const offers = await runTool("cork_query", { resource: "offers", chainId: CHAIN, pageSize: 25, format: "concise" }, ctx);
    expect(offers.state).toBe("ok");
    const od = offers.data as { items: Array<{ quote: { answerId: string } | null }>; indicative: { options: Array<{ answerId: string }> } };
    expect(od.items.some((it) => it.quote?.answerId === FIRM_ANSWER_ID)).toBe(true);
    expect(od.indicative.options.map((o) => o.answerId)).toEqual([SOFT_ANSWER_ID]);
    const env = await read({ withAnswers: true });
    const row = (env.data as Data).items[0]!;
    expect(row.answers!.filter((a) => a.firm).map((a) => a.answer_id)).toEqual([FIRM_ANSWER_ID]);
    expect(row.answers!.filter((a) => !a.firm).map((a) => a.answer_id)).toEqual([SOFT_ANSWER_ID]);
  });
});

describe("cork_query rfqs — filters.underwriter (venue-side: only RFQs that underwriter has answered)", () => {
  it("an underwriter that answered sees the RFQ; a stranger gets an honestly empty feed; the parameter reaches the venue", async () => {
    const mine = await read({ underwriter: RESTING_MAKER_ADDRESS });
    expect(mine.state, JSON.stringify(mine.warnings)).toBe("ok");
    expect((mine.data as Data).count).toBe(1);
    const soft = await read({ underwriter: SOFT_UNDERWRITER });
    expect((soft.data as Data).count).toBe(1);
    const stranger = await read({ underwriter: "0x1111111111111111111111111111111111111111" });
    expect(stranger.state).toBe("ok");
    expect((stranger.data as Data).count).toBe(0);
  });

  it("underwriter is an address (teaching error otherwise) and applies to rfqs only", async () => {
    expect(await issueOf(read({ underwriter: "not-an-address" }))).toContain("valid EVM address");
    expect(await issueOf(runTool("cork_query", { resource: "orderbook", chainId: CHAIN, filters: { underwriter: RESTING_MAKER_ADDRESS }, pageSize: 25, format: "concise" }, ctx))).toContain("does not apply to resource 'orderbook'");
  });
});
