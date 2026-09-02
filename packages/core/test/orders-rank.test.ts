// Best-first book ranking — the pure ranker over REAL signed rows (built by buildMakerOrder, so
// traits, nonces, reservations, and the Fusion extension are the bytes a maker would sign) and
// the cork_query default that serves it. Ordering facts are asserted one rule at a time so a
// comparator mutation fails the rule it breaks, not a blur of "order changed".
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { buildMakerOrder, hashLopOrder, LOP_ADDRESSES, type LopOrder, ocoGroupNonce, parseSignedLopOrder, rankBookRows, runTool, ToolInputError } from "@cork/core";
import { stubRpc } from "./helpers.ts";

const LOP = LOP_ADDRESSES[1]!;
const NOW = 1_800_000_000n;
const maker = privateKeyToAccount(`0x${"0c".repeat(32)}`);
const otherMaker = privateKeyToAccount(`0x${"0d".repeat(32)}`);
const ME = "0xc0ffee0000000000000000000000000000000001" as const;
const STRANGER = "0xc0ffee0000000000000000000000000000000002" as const;
const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";

type RowOver = { making?: bigint; taking?: bigint; allowedSender?: `0x${string}`; ocoGroup?: string; expiry?: bigint; side?: "BUY" | "SELL"; status?: string; verification?: string; signer?: typeof maker };

/** A venue book row as the hybrid path serves it: the SIGNED order (real traits) plus labels. */
async function row(id: string, o: RowOver = {}) {
  const signer = o.signer ?? maker;
  const built = buildMakerOrder({ chainId: 1, lop: LOP, maker: signer.address, makerAsset: CST, takerAsset: SUSDE, makingAmount: o.making ?? 10n ** 18n, takingAmount: o.taking ?? 5n * 10n ** 16n, clientRequestId: id, ...(o.expiry !== undefined ? { expiry: o.expiry } : {}), ...(o.allowedSender ? { allowedSender: o.allowedSender } : {}), ...(o.ocoGroup ? { ocoGroup: o.ocoGroup } : {}) });
  const order = built.order;
  const signature = await signer.sign({ hash: built.orderHash });
  return {
    orderHash: built.orderHash,
    order: { salt: order.salt.toString(), maker: order.maker, receiver: order.receiver, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: order.makingAmount.toString(), takingAmount: order.takingAmount.toString(), makerTraits: order.makerTraits.toString() },
    signature,
    extension: built.extension,
    makerAccountType: "EOA",
    side: o.side ?? "SELL",
    status: o.status ?? "OPEN",
    ...(o.verification ? { verification: o.verification } : {}),
  };
}
const hashes = (r: { items: Array<Record<string, unknown>> }) => r.items.map((x) => x.orderHash);
const rank = (rows: Array<Record<string, unknown>>, account?: `0x${string}`) => rankBookRows(rows, { chainId: 1, lop: LOP, ...(account ? { account } : {}), nowSeconds: NOW });

describe("rankBookRows — price from the signed amounts", () => {
  it("SELL rows: the cheaper unit price ranks first, whatever the venue order was", async () => {
    const dear = await row("r-1", { taking: 6n * 10n ** 16n });
    const cheap = await row("r-2", { taking: 4n * 10n ** 16n });
    const mid = await row("r-3", { taking: 5n * 10n ** 16n });
    const r = rank([dear, cheap, mid], ME);
    expect(hashes(r)).toEqual([cheap.orderHash, mid.orderHash, dear.orderHash]);
    expect(r.items[0]!.price).toEqual({ unitPrice: (4n * 10n ** 16n).toString(), shape: "fixed" });
    expect(r.items.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r.fillableCount).toBe(3);
    expect(String(r.rankedFor).toLowerCase()).toBe(ME);
  });

  it("BUY rows: the maker paying MORE per unit ranks first; sides never interleave (SELL block first)", async () => {
    const buyLow = await row("b-1", { side: "BUY", taking: 4n * 10n ** 16n });
    const buyHigh = await row("b-2", { side: "BUY", taking: 6n * 10n ** 16n });
    const sell = await row("b-3", { side: "SELL", taking: 9n * 10n ** 16n });
    expect(hashes(rank([buyLow, sell, buyHigh], ME))).toEqual([sell.orderHash, buyHigh.orderHash, buyLow.orderHash]);
  });

  it("unit price is exact integer arithmetic over the signed amounts, not the listing premium", async () => {
    // 3 taker units for 7 maker units: floor(3e18/7) — no float ever touches it.
    const r = rank([await row("u-1", { making: 7n, taking: 3n })], ME);
    expect(r.items[0]!.price.unitPrice).toBe(((3n * 10n ** 18n) / 7n).toString());
  });
});

describe("rankBookRows — tie-breaks, in order", () => {
  it("reserved-for-account beats open at equal price (no race for the reserved row)", async () => {
    const open = await row("t-1");
    const mine = await row("t-2", { allowedSender: ME });
    expect(hashes(rank([open, mine], ME))).toEqual([mine.orderHash, open.orderHash]);
    expect(hashes(rank([mine, open], ME))).toEqual([mine.orderHash, open.orderHash]);
  });

  it("chain-confirmed beats unverified at equal price and reach", async () => {
    const unverified = await row("t-3", { verification: "unverified" });
    const confirmed = await row("t-4", { verification: "confirmed" });
    expect(hashes(rank([unverified, confirmed], ME))).toEqual([confirmed.orderHash, unverified.orderHash]);
  });

  it("longer-lived beats shorter; no expiry (0) outlives every timestamp; then orderHash decides", async () => {
    const soon = await row("t-5", { expiry: NOW + 60n });
    const later = await row("t-6", { expiry: NOW + 3600n });
    const forever = await row("t-7");
    expect(hashes(rank([soon, later, forever], ME))).toEqual([forever.orderHash, later.orderHash, soon.orderHash]);
    const a = await row("t-8");
    const b = await row("t-9");
    const sorted = [a.orderHash, b.orderHash].sort();
    expect(hashes(rank([b, a], ME))).toEqual(sorted);
  });
});

describe("rankBookRows — what is not fillable, and why", () => {
  it("a row reserved for another fill sender is excluded with the PrivateOrder reason; without an account it is kept and flagged", async () => {
    const theirs = await row("x-1", { allowedSender: STRANGER });
    const withMe = rank([theirs], ME);
    expect(withMe.items).toHaveLength(0);
    expect(withMe.excluded[0]!.whyNotFillable).toContain("PrivateOrder");
    expect(withMe.excluded[0]!.exclusion).toBe("reserved-for-other");
    expect(withMe.excluded[0]!.fillable).toBe(false);
    const nobody = rank([theirs]);
    expect(nobody.items).toHaveLength(1);
    expect(nobody.rankedFor).toBeNull();
  });

  it("expiry mirrors the LOP (MakerTraitsLib.isExpired is `<`): a row expiring exactly now is still fillable, one second earlier is not", async () => {
    const past = await row("x-2", { expiry: NOW - 1n });
    const atNow = await row("x-3", { expiry: NOW });
    const r = rank([past, atNow], ME);
    expect(hashes(r)).toEqual([atNow.orderHash]);
    expect(r.excluded[0]!.whyNotFillable).toContain("expired");
    expect(r.excluded[0]!.exclusion).toBe("expired");
  });

  it("venue status FILLED/CANCELLED/EXPIRED excludes; OPEN and PARTIALLY_FILLED rank", async () => {
    const filled = await row("x-4", { status: "FILLED" });
    const partial = await row("x-5", { status: "PARTIALLY_FILLED" });
    const r = rank([filled, partial], ME);
    expect(hashes(r)).toEqual([partial.orderHash]);
    expect(r.excluded[0]!.whyNotFillable).toContain("FILLED");
    expect(r.excluded[0]!.exclusion).toBe("venue-status");
  });

  it("an unparseable row is excluded, not dropped: it stays served with the reason", () => {
    const r = rank([{ orderHash: `0x${"9c".repeat(32)}`, status: "OPEN" }], ME);
    expect(r.items).toHaveLength(0);
    expect(r.excluded[0]!.whyNotFillable).toContain("could not be parsed");
    expect(r.excluded[0]!.exclusion).toBe("unparseable");
    expect(r.excluded[0]!.orderHash).toBe(`0x${"9c".repeat(32)}`);
  });
});

describe("rankBookRows — pre-parsed rows (the verifier's results) rank identically to a fresh parse", () => {
  it("a parsed map keyed by hash is used verbatim; rows absent from it are parsed; the ranking is the same either way", async () => {
    const a = await row("p-1", { taking: 6n * 10n ** 16n });
    const b = await row("p-2", { taking: 4n * 10n ** 16n, allowedSender: ME });
    const c = await row("p-3", { taking: 5n * 10n ** 16n, ocoGroup: "pp" });
    const fresh = rank([a, b, c], ME);
    const parsed = new Map<string, { signed: import("@cork/core").SignedLopOrder; localHash: `0x${string}` }>();
    for (const r of [a, b]) {
      const p = parseSignedLopOrder(r);
      if (p.ok) parsed.set(r.orderHash.toLowerCase(), { signed: p.value, localHash: hashLopOrder(1, LOP, p.value.order) });
    }
    const pre = rankBookRows([a, b, c], { chainId: 1, lop: LOP, account: ME, nowSeconds: NOW, parsed });
    expect(hashes(pre)).toEqual(hashes(fresh));
    expect(pre.items.map((x) => [x.rank, x.price.unitPrice, x.exclusivity])).toEqual(fresh.items.map((x) => [x.rank, x.price.unitPrice, x.exclusivity]));
    expect(pre.excluded).toEqual(fresh.excluded);
  });
});

describe("rankBookRows — one-cancels-the-other groups collapse to their best rung", () => {
  it("two rungs on one nonce become one item, the BEST one, with the sibling named; fillableCount counts both", async () => {
    const worse = await row("g-1", { ocoGroup: "rfq_1", taking: 6n * 10n ** 16n, allowedSender: ME });
    const better = await row("g-2", { ocoGroup: "rfq_1", taking: 5n * 10n ** 16n, allowedSender: ME });
    const alone = await row("g-3", { taking: 55n * 10n ** 15n });
    const r = rank([worse, alone, better], ME);
    expect(hashes(r)).toEqual([better.orderHash, alone.orderHash]);
    expect(r.items[0]!.group).toEqual({ key: `${maker.address.toLowerCase()}:${ocoGroupNonce("rfq_1").toString()}`, nonce: ocoGroupNonce("rfq_1").toString(), collapsed: [worse.orderHash.toLowerCase()] });
    expect(r.items[1]!.group).toBeUndefined();
    expect(r.fillableCount).toBe(3);
  });

  it("the same nonce under a DIFFERENT maker is a different group — bits are per maker", async () => {
    const a = await row("g-4", { ocoGroup: "rfq_2" });
    const b = await row("g-5", { ocoGroup: "rfq_2", signer: otherMaker });
    const r = rank([a, b], ME);
    expect(r.items).toHaveLength(2);
    expect(r.items.every((x) => x.group === undefined)).toBe(true);
  });
});

describe("rankBookRows — a decaying row ranks at its price NOW", () => {
  it("mid-decay the row prices between ceiling and floor, ranks against fixed rows by that price, and says so", async () => {
    // A real Fusion extension, built by the maker-order path: floor 5e16, +10% at start, 1 h decay.
    const start = NOW - 1800n;
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: maker.address, clientRequestId: "decay-0001", action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: CST, takerAsset: SUSDE, makingAmount: (10n ** 18n).toString(), takingAmount: (5n * 10n ** 16n).toString(), auction: { startTime: start.toString(), durationSeconds: 3600, initialRateBump: "1000000" } } }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { orderHash: `0x${string}`; extension: `0x${string}`; typedData: { message: Record<string, string> } };
    const decaying = { orderHash: d.orderHash, order: d.typedData.message, signature: await maker.sign({ hash: d.orderHash }), extension: d.extension, makerAccountType: "EOA", side: "SELL", status: "OPEN" };
    // Fixed neighbours: one just under the decaying row's current price (~5.25e16), one above.
    const under = await row("d-2", { taking: 52n * 10n ** 15n });
    const over = await row("d-3", { taking: 53n * 10n ** 15n });
    const r = rank([over, decaying, under], ME);
    const dec = r.items.find((x) => x.orderHash === d.orderHash)!;
    expect(dec.price.shape).toBe("decaying");
    expect(dec.price.phase).toBe("decaying");
    const now = BigInt(dec.price.takerPaysNow!);
    expect(now).toBeGreaterThan(5n * 10n ** 16n); // above the floor
    expect(now).toBeLessThan(55n * 10n ** 15n); // below the +10% ceiling
    expect(hashes(r)).toEqual([under.orderHash, d.orderHash, over.orderHash]);
  });
});

describe("cork_query orderbook — the ranked view is the default; sort:'venue' restores the verbatim rows", () => {
  const venueWith = (items: unknown[]) => async (url: string) => (url.includes("/limit-orders/v1/orderbook") ? new Response(JSON.stringify({ items, hasMore: false }), { status: 200 }) : new Response(JSON.stringify({ items: [] }), { status: 200 }));
  const liveChain = stubRpc((c) => {
    if (c.functionName === "bitInvalidatorForOrder") return 0n;
    throw new Error(`no stub for ${c.functionName}`);
  });

  it("default: fillable rows ranked for filters.account, the rest under `excluded`, count = every served row", async () => {
    const dear = await row("q-1", { taking: 6n * 10n ** 16n });
    const cheap = await row("q-2", { taking: 4n * 10n ** 16n });
    const theirs = await row("q-3", { taking: 1n, allowedSender: STRANGER });
    const env = await runTool("cork_query", { resource: "orderbook", chainId: 1, filters: { account: ME }, format: "concise" }, { nowSeconds: NOW, venueFetch: venueWith([dear, theirs, cheap]), resolveRpc: liveChain });
    expect(env.state).toBe("ok");
    const data = env.data as { sort: string; rankedFor: string; count: number; fillableCount: number; items: Array<{ orderHash: string; rank: number; verification: string; exclusivity: string }>; excluded: Array<{ orderHash: string; whyNotFillable: string; exclusivity: string }>; scales: Record<string, string>; rankingNote: string };
    expect(data.sort).toBe("best");
    expect(String(data.rankedFor).toLowerCase()).toBe(ME);
    expect(data.count).toBe(3);
    expect(data.fillableCount).toBe(2);
    expect(data.items.map((x) => x.orderHash)).toEqual([cheap.orderHash, dear.orderHash]);
    expect(data.items[0]).toMatchObject({ rank: 1, verification: "confirmed", exclusivity: "open" });
    expect(data.excluded.map((x) => x.orderHash)).toEqual([theirs.orderHash]);
    expect(data.excluded[0]!.exclusivity).toBe("reserved-for-other");
    expect(data.scales.unitPrice).toContain("takerAsset base units per 1e18 makerAsset");
    expect(data.rankingNote).toContain("bounded walk");
  });

  it("no account: price-only, reserved rows kept and flagged, and the note says to pass the FILL SENDER", async () => {
    const theirs = await row("q-4", { allowedSender: STRANGER });
    const env = await runTool("cork_query", { resource: "orderbook", chainId: 1, format: "concise" }, { nowSeconds: NOW, venueFetch: venueWith([theirs]), resolveRpc: liveChain });
    const data = env.data as { rankedFor: string | null; items: Array<{ exclusivity: string }>; rankingNote: string };
    expect(data.rankedFor).toBeNull();
    expect(data.items[0]!.exclusivity).toBe("reserved");
    expect(data.rankingNote).toContain("FILL SENDER");
  });

  it("sort:'venue' serves the venue's order verbatim: no ranking keys, no exclusion", async () => {
    const dear = await row("q-5", { taking: 6n * 10n ** 16n });
    const cheap = await row("q-6", { taking: 4n * 10n ** 16n });
    const env = await runTool("cork_query", { resource: "orderbook", chainId: 1, sort: "venue", filters: { account: ME }, format: "concise" }, { nowSeconds: NOW, venueFetch: venueWith([dear, cheap]), resolveRpc: liveChain });
    const data = env.data as { sort: string; items: Array<{ orderHash: string; rank?: number }>; excluded?: unknown; rankedFor?: unknown };
    expect(data.sort).toBe("venue");
    expect(data.items.map((x) => x.orderHash)).toEqual([dear.orderHash, cheap.orderHash]);
    expect(data.items[0]!.rank).toBeUndefined();
    expect(data.excluded).toBeUndefined();
    expect(data.rankedFor).toBeUndefined();
  });

  it("sort on a non-orderbook resource is refused with teaching, never silently unapplied", async () => {
    await expect(runTool("cork_query", { resource: "cork-pools", chainId: 1, sort: "best" }, { nowSeconds: NOW, venueFetch: venueWith([]) })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("the venue-supplied orderHash is irrelevant to ranking: rows are keyed by the LOCAL re-hash", async () => {
    // A row whose claimed hash is wrong is dropped by verification before ranking sees it.
    const good = await row("q-7");
    const liar = { ...(await row("q-8")), orderHash: `0x${"11".repeat(32)}` };
    const env = await runTool("cork_query", { resource: "orderbook", chainId: 1, filters: { account: ME }, format: "concise" }, { nowSeconds: NOW, venueFetch: venueWith([liar, good]), resolveRpc: liveChain });
    const data = env.data as { count: number; items: Array<{ orderHash: string }>; verification: { dropped: number } };
    expect(data.items.map((x) => x.orderHash)).toEqual([good.orderHash]);
    expect(data.verification.dropped).toBe(1);
    expect(data.count).toBe(1);
  });
});

// hashLopOrder and LopOrder are imported so a reader can extend rows by hand without hunting.
void hashLopOrder;
void (null as unknown as LopOrder);
