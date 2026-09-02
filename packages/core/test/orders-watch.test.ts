// Watching the book: the client-side watermark, the diff that announces only chain-CONFIRMED
// rows, the "better" rule (price, then reach), and the poll-count-driven long-poll. Real signed
// rows built by buildMakerOrder; the venue is a stub whose book changes between reads; the chain
// a stub that can mark a maker's whole bit slot spent.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { bookWatermarkOf, buildMakerOrder, decodeBookWatermark, diffBook, encodeBookWatermark, isBetterOffer, LOP_ADDRESSES, rankBookRows, runTool, ToolInputError, WATCH_POLL_SECONDS, WatermarkError } from "@cork/core";
import { stubRpc } from "./helpers.ts";

const LOP = LOP_ADDRESSES[1]!;
const NOW = 1_800_000_000n;
const maker = privateKeyToAccount(`0x${"0f".repeat(32)}`);
const deadMaker = privateKeyToAccount(`0x${"1f".repeat(32)}`);
const ME = "0xc0ffee0000000000000000000000000000000001" as const;
const STRANGER = "0xc0ffee0000000000000000000000000000000002" as const;
const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";

type RowOver = { taking?: bigint; allowedSender?: `0x${string}`; ocoGroup?: string; side?: "BUY" | "SELL"; signer?: typeof maker; verification?: string };
async function row(id: string, o: RowOver = {}) {
  const signer = o.signer ?? maker;
  const built = buildMakerOrder({ chainId: 1, lop: LOP, maker: signer.address, makerAsset: CST, takerAsset: SUSDE, makingAmount: 10n ** 18n, takingAmount: o.taking ?? 5n * 10n ** 16n, clientRequestId: id, ...(o.allowedSender ? { allowedSender: o.allowedSender } : {}), ...(o.ocoGroup ? { ocoGroup: o.ocoGroup } : {}) });
  const order = built.order;
  return {
    orderHash: built.orderHash,
    order: { salt: order.salt.toString(), maker: order.maker, receiver: order.receiver, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: order.makingAmount.toString(), takingAmount: order.takingAmount.toString(), makerTraits: order.makerTraits.toString() },
    signature: await signer.sign({ hash: built.orderHash }),
    extension: "0x",
    makerAccountType: "EOA",
    side: o.side ?? "SELL",
    status: "OPEN",
    ...(o.verification ? { verification: o.verification } : {}),
    // The labels the hybrid path stamps before ranking (decoded from the signed traits there).
    exclusivity: o.allowedSender ? (o.allowedSender.toLowerCase() === ME ? "reserved-for-account" : "reserved-for-other") : "open",
  };
}
const lc = (h: string) => h.toLowerCase();
/** Rank as the hybrid path would after verification: rows labeled confirmed unless the row says otherwise. */
const rank = (rows: Array<Record<string, unknown>>, account: `0x${string}` | undefined = ME) => rankBookRows(rows.map((r) => ({ verification: "confirmed", ...r })), { chainId: 1, lop: LOP, ...(account ? { account } : {}), nowSeconds: NOW });

describe("book watermark — an opaque token over the live set and the best per side", () => {
  it("round-trips through the wire form; live set includes collapsed group rungs; best is per side", async () => {
    const worse = await row("w-1", { ocoGroup: "g", taking: 6n * 10n ** 16n });
    const better = await row("w-2", { ocoGroup: "g", taking: 5n * 10n ** 16n });
    const buy = await row("w-3", { side: "BUY", taking: 7n * 10n ** 16n });
    const w = bookWatermarkOf(rank([worse, better, buy]));
    expect(w.account).toBe(ME);
    expect(w.live).toEqual([worse.orderHash, better.orderHash, buy.orderHash].map(lc).sort());
    expect(w.best.SELL).toEqual({ orderHash: lc(better.orderHash), unitPrice: (5n * 10n ** 16n).toString(), reservedForAccount: false });
    expect(w.best.BUY).toEqual({ orderHash: lc(buy.orderHash), unitPrice: (7n * 10n ** 16n).toString(), reservedForAccount: false });
    const wire = encodeBookWatermark(w);
    expect(wire.startsWith("bw1.")).toBe(true);
    expect(decodeBookWatermark(wire)).toEqual(w);
  });

  it("refuses foreign or tampered tokens with a WatermarkError naming the fix", () => {
    expect(() => decodeBookWatermark("abc")).toThrow(WatermarkError);
    expect(() => decodeBookWatermark("bw1.!!!")).toThrow(/does not decode|unknown shape/);
    expect(() => decodeBookWatermark(`bw1.${Buffer.from(JSON.stringify({ v: 1, a: null, l: ["zz"], b: {} })).toString("base64url")}`)).toThrow(/live set is malformed/);
  });
});

describe("isBetterOffer — price first, then reach", () => {
  const at = (unitPrice: bigint, reservedForAccount = false) => ({ orderHash: "0x00", unitPrice: unitPrice.toString(), reservedForAccount });
  it("SELL: lower unit price is better; BUY: higher is better", () => {
    expect(isBetterOffer("SELL", at(4n), at(5n))).toBe(true);
    expect(isBetterOffer("SELL", at(6n), at(5n))).toBe(false);
    expect(isBetterOffer("BUY", at(6n), at(5n))).toBe(true);
    expect(isBetterOffer("BUY", at(4n), at(5n))).toBe(false);
  });
  it("equal price: reserved-for-account beats open, never the reverse; nothing beats nothing-to-nothing", () => {
    expect(isBetterOffer("SELL", at(5n, true), at(5n, false))).toBe(true);
    expect(isBetterOffer("SELL", at(5n, false), at(5n, true))).toBe(false);
    expect(isBetterOffer("SELL", at(5n, true), at(5n, true))).toBe(false);
    expect(isBetterOffer("SELL", at(9n), null)).toBe(true);
  });
});

describe("diffBook — what changed since the watermark", () => {
  it("a new cheaper confirmed row: appeared, better, and the best changed (the old best did not die)", async () => {
    const old = await row("d-1", { taking: 5n * 10n ** 16n });
    const prev = bookWatermarkOf(rank([old]));
    const cheaper = await row("d-2", { taking: 4n * 10n ** 16n });
    const d = diffBook(prev, rank([old, cheaper]));
    expect(d.changed).toBe(true);
    expect(d.appeared).toEqual([lc(cheaper.orderHash)]);
    expect(d.gone).toEqual([]);
    expect(d.unconfirmed).toEqual([]);
    expect(d.better.map((b) => [b.orderHash, b.side, b.rank])).toEqual([[lc(cheaper.orderHash), "SELL", 1]]);
    expect(d.best.SELL).toMatchObject({ changed: true, died: false, current: { orderHash: lc(cheaper.orderHash) } });
    expect(d.best.BUY).toBeNull();
  });

  it("an UNCONFIRMED new row is a set change but never an announcement: not appeared, not better", async () => {
    const old = await row("d-3", { taking: 5n * 10n ** 16n });
    const prev = bookWatermarkOf(rank([old]));
    const cheaperUnverified = await row("d-4", { taking: 4n * 10n ** 16n, verification: "unverified" });
    const d = diffBook(prev, rank([old, cheaperUnverified]));
    expect(d.changed).toBe(true);
    expect(d.appeared).toEqual([]);
    expect(d.better).toEqual([]);
    expect(d.unconfirmed).toEqual([lc(cheaperUnverified.orderHash)]);
    // It still ranks first, so the best "changed" — the caller sees WHY it is not announced.
    expect(d.best.SELL!.changed).toBe(true);
  });

  it("the best disappearing: gone + died; a same-price row reserved for me is better than the open one it follows", async () => {
    const open = await row("d-5", { taking: 5n * 10n ** 16n });
    const prev = bookWatermarkOf(rank([open]));
    const mine = await row("d-6", { taking: 5n * 10n ** 16n, allowedSender: ME });
    const d = diffBook(prev, rank([mine]));
    expect(d.gone).toEqual([lc(open.orderHash)]);
    expect(d.best.SELL).toMatchObject({ died: true, changed: true });
    expect(d.better.map((b) => b.orderHash)).toEqual([lc(mine.orderHash)]);
  });

  it("a dearer new row is appeared but NOT better; an identical book is no change at all", async () => {
    const old = await row("d-7", { taking: 5n * 10n ** 16n });
    const prev = bookWatermarkOf(rank([old]));
    const dearer = await row("d-8", { taking: 6n * 10n ** 16n });
    const d = diffBook(prev, rank([old, dearer]));
    expect(d.appeared).toEqual([lc(dearer.orderHash)]);
    expect(d.better).toEqual([]);
    expect(d.best.SELL!.changed).toBe(false);
    const same = diffBook(prev, rank([old]));
    expect(same.changed).toBe(false);
    expect(same).toMatchObject({ appeared: [], gone: [], unconfirmed: [], better: [] });
  });

  it("a rung joining an existing group is not 'gone' for the rung it displaces as representative", async () => {
    const rep = await row("d-9", { ocoGroup: "g2", taking: 5n * 10n ** 16n });
    const prev = bookWatermarkOf(rank([rep]));
    const newBest = await row("d-10", { ocoGroup: "g2", taking: 4n * 10n ** 16n });
    const d = diffBook(prev, rank([rep, newBest]));
    expect(d.gone).toEqual([]);
    expect(d.appeared).toEqual([lc(newBest.orderHash)]);
  });

  it("a watermark taken for another fill sender does not compare", async () => {
    const prev = bookWatermarkOf(rank([await row("d-11")], STRANGER));
    expect(() => diffBook(prev, rank([], ME))).toThrow(/different|fill sender/);
  });
});

describe("cork_query orderbook — since / wait", () => {
  const venueSeq = (books: unknown[][]) => {
    let call = 0;
    const fetch = async (url: string) => {
      if (!url.includes("/limit-orders/v1/orderbook")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      const items = books[Math.min(call, books.length - 1)]!;
      call++;
      return new Response(JSON.stringify({ items, hasMore: false }), { status: 200 });
    };
    return { fetch, calls: () => call };
  };
  /** Live chain, except every bit of `deadMaker`'s slots is spent. */
  const chain = stubRpc((c) => {
    if (c.functionName === "bitInvalidatorForOrder") return String((c.args as unknown[])[0]).toLowerCase() === deadMaker.address.toLowerCase() ? (1n << 256n) - 1n : 0n;
    throw new Error(`no stub for ${c.functionName}`);
  });
  type BookData = { watermark: string; changes?: { changed: boolean; appeared: string[]; gone: string[]; unconfirmed: string[]; better: Array<{ orderHash: string }> }; waited?: { pollsMade: number; polls: number; changed: boolean; endedBy: string }; items: Array<{ orderHash: string }>; verification: { dropped: number } };
  const read = (venue: (u: string) => Promise<Response>, extra: Record<string, unknown> = {}, sleeps?: number[]) =>
    runTool("cork_query", { resource: "orderbook", chainId: 1, filters: { account: ME }, format: "concise", ...extra }, { nowSeconds: NOW, venueFetch: venue, resolveRpc: chain, sleep: async (ms) => { sleeps?.push(ms); } });

  it("first read returns a watermark and no changes; the second read with `since` announces the confirmed better order", async () => {
    const old = await row("q-1", { taking: 5n * 10n ** 16n });
    const cheaper = await row("q-2", { taking: 4n * 10n ** 16n });
    const v = venueSeq([[old], [old, cheaper]]);
    const first = await read(v.fetch);
    const d1 = first.data as BookData;
    expect(d1.watermark.startsWith("bw1.")).toBe(true);
    expect(d1.changes).toBeUndefined();
    const second = await read(v.fetch, { since: d1.watermark });
    const d2 = second.data as BookData;
    expect(d2.changes!.changed).toBe(true);
    expect(d2.changes!.appeared).toEqual([lc(cheaper.orderHash)]);
    expect(d2.changes!.better.map((b) => b.orderHash)).toEqual([lc(cheaper.orderHash)]);
    expect(d2.watermark).not.toBe(d1.watermark);
  });

  it("verify before announce: a venue row listed OPEN whose bit is SPENT is dropped by the chain leg and never announced", async () => {
    const old = await row("q-3", { taking: 5n * 10n ** 16n });
    const corpse = await row("q-4", { taking: 4n * 10n ** 16n, signer: deadMaker });
    const v = venueSeq([[old], [old, corpse]]);
    const first = await read(v.fetch);
    const second = await read(v.fetch, { since: (first.data as BookData).watermark });
    const d2 = second.data as BookData;
    expect(d2.verification.dropped).toBe(1);
    expect(d2.items.map((i) => i.orderHash)).toEqual([old.orderHash]);
    expect(d2.changes!.changed).toBe(false);
    expect(d2.changes!.better).toEqual([]);
  });

  it("wait long-polls at the 2 s cadence, returning on the first read that changed and saying so", async () => {
    const old = await row("q-5");
    const cheaper = await row("q-6", { taking: 4n * 10n ** 16n });
    const v = venueSeq([[old], [old], [old], [old, cheaper]]);
    const first = await read(v.fetch);
    const sleeps: number[] = [];
    const env = await read(v.fetch, { since: (first.data as BookData).watermark, wait: 25 }, sleeps);
    const d = env.data as BookData;
    expect(d.waited).toMatchObject({ pollsMade: 3, polls: Math.ceil(25 / WATCH_POLL_SECONDS), changed: true, endedBy: "change" });
    expect(sleeps).toEqual([WATCH_POLL_SECONDS * 1000, WATCH_POLL_SECONDS * 1000]);
    expect(d.changes!.better.map((b) => b.orderHash)).toEqual([lc(cheaper.orderHash)]);
    expect(v.calls()).toBe(4);
  });

  it("wait times out after ceil(wait / cadence) polls when nothing changes", async () => {
    const old = await row("q-7");
    const v = venueSeq([[old]]);
    const first = await read(v.fetch);
    const env = await read(v.fetch, { since: (first.data as BookData).watermark, wait: 5 });
    expect((env.data as BookData).waited).toMatchObject({ pollsMade: 3, polls: 3, changed: false, endedBy: "timeout" });
  });

  it("refusals: since/wait off the orderbook, under sort venue, wait without since, a foreign token, a watermark for another sender", async () => {
    const v = venueSeq([[await row("q-8")]]);
    const first = await read(v.fetch);
    const wm = (first.data as BookData).watermark;
    await expect(read(v.fetch, { resource: "rfqs", since: wm })).rejects.toBeInstanceOf(ToolInputError);
    await expect(read(v.fetch, { since: wm, sort: "venue" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(read(v.fetch, { wait: 4 })).rejects.toBeInstanceOf(ToolInputError);
    await expect(read(v.fetch, { since: "not-a-watermark" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(read(v.fetch, { since: wm, filters: { account: STRANGER } })).rejects.toBeInstanceOf(ToolInputError);
  });
});
