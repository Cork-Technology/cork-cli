// offers — the unified discovery view: live orders (ranked, hybrid-verified) joined with the RFQ
// answer options they cite, and an indicative tally for the options nobody has backed with an
// order. Real signed rows built by buildMakerOrder; the venue is a stub of the two routes the
// view composes (orderbook + rfqs), the chain a stub answering "live".
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { buildMakerOrder, LOP_ADDRESSES, runTool, ToolInputError } from "@cork/core";
import { stubRpc } from "./helpers.ts";

const LOP = LOP_ADDRESSES[1]!;
const NOW = 1_800_000_000n;
const maker = privateKeyToAccount(`0x${"0e".repeat(32)}`);
const ME = "0xc0ffee0000000000000000000000000000000001" as const;
const STRANGER = "0xc0ffee0000000000000000000000000000000002" as const;
const REQUESTER = "0xc0ffee0000000000000000000000000000000003" as const;
const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";

async function row(id: string, o: { taking?: bigint; allowedSender?: `0x${string}`; quoteRef?: { rfq_id: string; answer_id: string; option_id: string } } = {}) {
  const built = buildMakerOrder({ chainId: 1, lop: LOP, maker: maker.address, makerAsset: CST, takerAsset: SUSDE, makingAmount: 10n ** 18n, takingAmount: o.taking ?? 5n * 10n ** 16n, clientRequestId: id, ...(o.allowedSender ? { allowedSender: o.allowedSender } : {}) });
  const order = built.order;
  return {
    orderHash: built.orderHash,
    order: { salt: order.salt.toString(), maker: order.maker, receiver: order.receiver, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: order.makingAmount.toString(), takingAmount: order.takingAmount.toString(), makerTraits: order.makerTraits.toString() },
    signature: await maker.sign({ hash: built.orderHash }),
    extension: "0x",
    makerAccountType: "EOA",
    side: "SELL",
    status: "OPEN",
    quoteRef: o.quoteRef ?? null,
  };
}
const option = (option_id: string, premium: string) => ({ option_id, premium_annualized: premium, expiry: 1_900_000_000 });
const answer = (answer_id: string, underwriter: string, opts: ReturnType<typeof option>[]) => ({ answer_id, underwriter, answer: { status: "quoted", options: opts } });
const rfq = (rfq_id: string, answers: unknown[]) => ({ rfq_id, state: "open", chain_id: 1, requester: REQUESTER, version: 1, answers, answer_count: answers.length });

/** A venue serving exactly the two routes the view composes. */
const venueWith = (book: unknown[], rfqs: unknown[], seen: string[] = []) => async (url: string) => {
  seen.push(url);
  if (url.includes("/limit-orders/v1/orderbook")) return new Response(JSON.stringify({ items: book, hasMore: false }), { status: 200 });
  const single = /\/rfqs\/v1\/([^/?]+)/.exec(url)?.[1];
  if (single) { const hit = (rfqs as Array<{ rfq_id: string }>).find((r) => r.rfq_id === decodeURIComponent(single)); return new Response(JSON.stringify(hit ?? { message: "not found" }), { status: hit ? 200 : 404 }); }
  if (url.includes("/rfqs/v1")) return new Response(JSON.stringify({ items: rfqs, next_cursor: null }), { status: 200 });
  return new Response(JSON.stringify({ items: [] }), { status: 200 });
};
const live = stubRpc((c) => { if (c.functionName === "bitInvalidatorForOrder") return 0n; throw new Error(`no stub for ${c.functionName}`); });
const offers = (venue: (u: string) => Promise<Response>, filters: Record<string, unknown> = { account: ME }) => runTool("cork_query", { resource: "offers", chainId: 1, filters, format: "concise" }, { nowSeconds: NOW, venueFetch: venue, resolveRpc: live });

type OffersData = { resource: string; rankedFor: string | null; count: number; items: Array<{ orderHash: string; rank: number; provenance: string; quote: null | { rfqId: string; answerId: string; optionId: string; underwriter?: string; requester?: string; premiumAnnualized?: string; resolved?: boolean } }>; excluded?: Array<{ orderHash: string }>; indicative: { count: number; options: Array<{ rfqId: string; answerId: string; optionId: string; underwriter: string | null; reason: string }> }; pagination: { orderbook: unknown; rfqs: unknown }; scales: Record<string, string>; note: string };

describe("cork_query offers — live orders joined with the quotes they cite; the rest is indicative", () => {
  it("a cited order carries its quote; an uncited order is still an offer; an answer no order backs is counted as indicative", async () => {
    const cited = await row("o-1", { taking: 5n * 10n ** 16n, quoteRef: { rfq_id: "rfq_1", answer_id: "ans_firm", option_id: "opt1" } });
    const standing = await row("o-2", { taking: 6n * 10n ** 16n });
    const rfqs = [rfq("rfq_1", [answer("ans_firm", maker.address, [option("opt1", "0.05")]), answer("ans_soft", STRANGER, [option("opt1", "0.03"), option("opt2", "0.04")])])];
    const env = await offers(venueWith([standing, cited], rfqs));
    expect(env.state).toBe("ok");
    const d = env.data as OffersData;
    expect(d.resource).toBe("offers");
    expect(String(d.rankedFor).toLowerCase()).toBe(ME);
    // Ranked like the book: the cheaper (cited) order first, ranks renumbered on the view.
    expect(d.items.map((i) => [i.orderHash, i.rank, i.provenance])).toEqual([[cited.orderHash, 1, "cited"], [standing.orderHash, 2, "uncited"]]);
    expect(d.items[0]!.quote).toMatchObject({ rfqId: "rfq_1", answerId: "ans_firm", optionId: "opt1", underwriter: maker.address, requester: REQUESTER, premiumAnnualized: "0.05" });
    expect(d.items[1]!.quote).toBeNull();
    // The soft underwriter's two options are prices nobody can buy: counted, not ranked.
    expect(d.indicative.count).toBe(2);
    expect(d.indicative.options.map((o) => [o.answerId, o.optionId])).toEqual([["ans_soft", "opt1"], ["ans_soft", "opt2"]]);
    expect(d.indicative.options[0]!.reason).toContain("no live resting order");
    expect(d.scales.premiumAnnualized).toContain("never used for ranking");
    expect(d.note).toContain("FIRM only when a live order cites it");
  });

  it("the citation must resolve on BOTH ids: an answer id with a different option id is cited-unresolved, and the real option stays indicative", async () => {
    const wrongOption = await row("o-3", { quoteRef: { rfq_id: "rfq_1", answer_id: "ans_firm", option_id: "optX" } });
    const env = await offers(venueWith([wrongOption], [rfq("rfq_1", [answer("ans_firm", maker.address, [option("opt1", "0.05")])])]));
    const d = env.data as OffersData;
    expect(d.items[0]!.provenance).toBe("cited-unresolved");
    expect(d.items[0]!.quote).toMatchObject({ answerId: "ans_firm", optionId: "optX", resolved: false });
    expect(d.indicative.count).toBe(1);
  });

  it("filters.rfqId narrows to offers executing THAT request and reads the single RFQ record", async () => {
    const forOne = await row("o-4", { quoteRef: { rfq_id: "rfq_1", answer_id: "a1", option_id: "opt1" } });
    const forOther = await row("o-5", { quoteRef: { rfq_id: "rfq_2", answer_id: "a2", option_id: "opt1" } });
    const standing = await row("o-6");
    const seen: string[] = [];
    const env = await offers(venueWith([forOne, forOther, standing], [rfq("rfq_1", [answer("a1", maker.address, [option("opt1", "0.05")])]), rfq("rfq_2", [answer("a2", maker.address, [option("opt1", "0.05")])])], seen), { account: ME, rfqId: "rfq_1" });
    const d = env.data as OffersData;
    expect(d.items.map((i) => i.orderHash)).toEqual([forOne.orderHash]);
    expect(d.count).toBe(1);
    expect(seen.some((u) => /\/rfqs\/v1\/rfq_1/.test(u))).toBe(true);
  });

  it("exclusion is the book's: a row reserved for another fill sender rides under excluded, not among the offers", async () => {
    const theirs = await row("o-7", { allowedSender: STRANGER, quoteRef: { rfq_id: "rfq_1", answer_id: "a1", option_id: "opt1" } });
    const env = await offers(venueWith([theirs], [rfq("rfq_1", [answer("a1", maker.address, [option("opt1", "0.05")])])]));
    const d = env.data as OffersData;
    expect(d.items).toHaveLength(0);
    expect(d.excluded!.map((x) => x.orderHash)).toEqual([theirs.orderHash]);
    // Its cited option is still backed by a LIVE order, so it is NOT indicative: firmness is about
    // the order existing, not about who may fill it.
    expect(d.indicative.count).toBe(0);
  });

  it("a passed answer has no price and is neither cited nor indicative — even when a revision left stale options beside the pass", async () => {
    const clean = await offers(venueWith([await row("o-8")], [rfq("rfq_1", [{ answer_id: "a-pass", underwriter: STRANGER, answer: { status: "pass", reason_code: "NO_CAPACITY" } }])]));
    expect((clean.data as OffersData).indicative.count).toBe(0);
    // The venue stores answers as revisions; a pass that still carries the previous revision's
    // options must not resurrect those prices — the status decides, not the presence of options.
    const stale = await offers(venueWith([await row("o-8b")], [rfq("rfq_1", [{ answer_id: "a-pass-2", underwriter: STRANGER, answer: { status: "pass", reason_code: "NO_CAPACITY", options: [option("opt1", "0.02")] } }])]));
    expect((stale.data as OffersData).indicative.count).toBe(0);
  });

  it("when the RFQ leg fails the view still serves the book, says so, and every order reads uncited", async () => {
    const standing = await row("o-9", { quoteRef: { rfq_id: "rfq_1", answer_id: "a1", option_id: "opt1" } });
    const venue = async (url: string) => (url.includes("/limit-orders/v1/orderbook") ? new Response(JSON.stringify({ items: [standing], hasMore: false }), { status: 200 }) : new Response("upstream down", { status: 503 }));
    const env = await offers(venue);
    expect(env.state).toBe("ok");
    const d = env.data as OffersData;
    expect(d.items[0]!.provenance).toBe("cited-unresolved");
    expect(d.indicative.count).toBe(0);
    expect(env.warnings.some((w) => w.code === "needs_service" && w.message.includes("RFQ leg"))).toBe(true);
  });

  it("offers is hybrid-only, takes only its own filters, and refuses sort like every non-orderbook resource", async () => {
    const venue = venueWith([], []);
    const mode = await runTool("cork_query", { resource: "offers", chainId: 1, mode: "lite-decentralized" }, { nowSeconds: NOW, venueFetch: venue, resolveRpc: live });
    expect(mode.state).toBe("unavailable");
    expect(mode.warnings[0]!.code).toBe("mode_unavailable");
    await expect(runTool("cork_query", { resource: "offers", chainId: 1, filters: { status: "OPEN" } }, { nowSeconds: NOW, venueFetch: venue })).rejects.toBeInstanceOf(ToolInputError);
    await expect(runTool("cork_query", { resource: "offers", chainId: 1, sort: "best" }, { nowSeconds: NOW, venueFetch: venue })).rejects.toBeInstanceOf(ToolInputError);
  });
});
