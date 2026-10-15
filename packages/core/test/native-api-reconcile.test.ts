import { describe, expect, it } from "vitest";
import { buildMakerOrder, LOP_ADDRESSES, parseSignedLopOrder, runTool, ToolInputError, type HandlerContext } from "@cork/core";
import capture from "./fixtures/venue-native-api110.json";
import { stubResolved, withNativeApiMetadata } from "./helpers.ts";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const inactive = capture.responses[3]!.body.items[0]!;
const usedBit = capture.responses[1]!.body.items[0]!;
const candidate = capture.responses[0]!.body.items[0]!;
function ctx(chainRead?: bigint): HandlerContext {
  return {
    nowSeconds: 1_790_000_000n,
    resolveRpc: chainRead === undefined ? async () => null : async () => stubResolved({ readContract: async ({ functionName }: { functionName: string }) => functionName === "orderStatus" ? 0 : chainRead }),
    venueFetch: withNativeApiMetadata(async (url) => {
      const u = new URL(url);
      if (u.pathname.startsWith("/rollover/v1/orders/")) return Response.json({}, { status: 404 });
      if (u.pathname.endsWith("/orderbook") || u.pathname.endsWith("/fills")) {
        const wanted = u.searchParams.get("orderHash");
        const response = capture.responses.find((r) => {
          const p = new URL(r.path, "http://fixture");
          return p.pathname === u.pathname && p.searchParams.get("chainId") === u.searchParams.get("chainId") && p.searchParams.get("orderHash") === wanted && p.searchParams.get("cursor") === u.searchParams.get("cursor");
        });
        return Response.json(response?.body ?? { items: [], hasMore: false });
      }
      return Response.json({ items: [], hasMore: false });
    }),
  };
}
const track = (row: { chainId: number; orderHash: string }, context = ctx()) => runTool("cork_track", { mode: "reconcile", chainId: row.chainId, subject: { kind: "orderHash", orderHash: row.orderHash } }, { ...context, ...(context.venueFetch ? { venueFetch: withNativeApiMetadata(context.venueFetch) } : {}) });

describe("pinned API #110 native reconciliation", () => {
  it("default discovery excludes indexed unavailable legacy rows while management and exact history retain them", async () => {
    const maker = privateKeyToAccount(keccak256(toHex("cancel-sweep-maker")));
    const signed = async (native: typeof candidate, id: string) => {
      const parsed = parseSignedLopOrder(native);
      if (!parsed.ok) throw new Error(parsed.error);
      const order = parsed.value.order;
      const built = buildMakerOrder({ chainId: 8453, lop: LOP_ADDRESSES[8453]!, maker: maker.address, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: order.makingAmount, takingAmount: order.takingAmount, clientRequestId: id, allowPartialFills: true, expiry: 1_790_003_600n });
      return { ...native, ...Object.fromEntries(Object.entries(built.order).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])), orderHash: built.orderHash, extension: built.extension, signature: await maker.sign({ hash: built.orderHash }) };
    };
    const live = await signed(candidate, "strict-discovery-live");
    const blocked = await signed(usedBit, "strict-discovery-blocked");
    const context: HandlerContext = { ...ctx(), venueFetch: withNativeApiMetadata(async (url) => {
      const params = new URL(url).searchParams;
      const rows = params.has("orderHash") ? [blocked] : params.get("view") === "discovery" ? [live] : [live, blocked];
      return Response.json({ items: rows, hasMore: false });
    }) };
    const input = { resource: "orderbook", chainId: candidate.chainId, sort: "venue" };
    const discovery = await runTool("cork_query", input, context);
    expect(discovery.data).toMatchObject({ items: [live] });
    const management = await runTool("cork_query", { ...input, filters: { view: "management" } }, context);
    expect(management.data).toMatchObject({ items: [live, blocked] });
    const exact = await runTool("cork_query", { ...input, filters: { orderHash: blocked.orderHash } }, context);
    expect(exact.data).toMatchObject({ items: [blocked] });
  });
  it.each([false, true])("keeps all 1000 observed fills and discloses the cap (chain conflict=%s)", async (conflict) => {
    const observed: Array<Record<string, unknown>> = [];
    const result = await track(candidate, {
      ...ctx(conflict ? (1n << 256n) - 1n : undefined),
      venueFetch: async (url) => {
        const u = new URL(url);
        if (u.pathname.includes("/rollover/")) return Response.json({}, { status: 404 });
        if (u.pathname.endsWith("/orderbook")) return Response.json({ items: conflict ? [candidate] : [], hasMore: false });
        const page = Number(u.searchParams.get("cursor") ?? 0);
        const rows = Array.from({ length: 100 }, (_, i) => ({ orderHash: candidate.orderHash, chainId: candidate.chainId, txHash: `0x${(page * 100 + i + 1).toString(16).padStart(64, "0")}`, logIndex: i, makingAmount: "1", takingAmount: "1" }));
        observed.push(...rows);
        return Response.json({ items: rows, hasMore: true, nextCursor: String(page + 1) });
      },
    });
    expect(result.state).toBe(conflict ? "conflict" : "ok");
    expect(result.data).toMatchObject({ fillsScanComplete: false, fills: observed });
    expect(result.warnings.map((w) => w.code)).toContain("pagination_incomplete");
  });

  it("native CANCELLED retirement preserves a positive mathematical remainder even without availability metadata", async () => {
    const retired = { ...usedBit, status: "CANCELLED", availability: undefined };
    const result = await track(retired, { ...ctx(1n), venueFetch: async (url) => url.includes("/rollover/") ? Response.json({}, { status: 404 }) : Response.json({ items: url.includes("/orderbook") ? [retired] : [], hasMore: false }) });
    expect(result.state).toBe("ok");
    expect(result.data).toMatchObject({ resting: false, confidence: "unknown", order: { status: "CANCELLED", makingAmount: "10", filledMakingAmount: "1", remainingMakingAmount: "9" } });
    expect(result.warnings.map((w) => w.code)).not.toContain("status_mismatch");
  });
  it.each([{ ...inactive, chainId: 1 }, { ...inactive, orderHash: candidate.orderHash }])("a foreign exact-response row is an integrity failure, not history or absence", async (foreign) => {
    const context = { ...ctx(), venueFetch: withNativeApiMetadata(async (url: string) => url.includes("/rollover/") ? Response.json({}, { status: 404 }) : Response.json({ items: url.includes("/orderbook") ? [foreign] : [], hasMore: false })) };
    const query = await runTool("cork_query", { resource: "orderbook", chainId: inactive.chainId, filters: { orderHash: inactive.orderHash } }, context);
    expect(query.state).toBe("unavailable");
    expect(query.warnings[0]?.code).toBe("invalid_service_response");
    const reconciled = await track(inactive, context);
    expect(reconciled.state).toBe("conflict");
    expect(reconciled.warnings.map((w) => w.code)).toContain("invalid_service_response");
    expect(reconciled.warnings.map((w) => w.code)).not.toContain("order_not_found");
  });
  it("preserves distinct same-transaction execution logs and nullable observed time across pages", async () => {
    const result = await runTool("cork_query", { resource: "fills", chainId: candidate.chainId, filters: { orderHash: candidate.orderHash }, pageSize: 1 }, ctx());
    const items = (result.data as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((row) => row.logIndex)).toEqual([2, 1]);
    expect(items.map((row) => row.txHash)).toEqual([`0x${"ee".repeat(32)}`, `0x${"ee".repeat(32)}`]);
    expect(items.map((row) => row.observedBlockTimestamp)).toEqual(["2026-01-01T00:00:00.000Z", null]);
    expect(items.map((row) => [row.makingAmount, row.takingAmount])).toEqual([["3", "8"], ["3", "2"]]);
  });

  it("book transport failure does not turn observed fills into a claim of order absence", async () => {
    const fixture = ctx();
    const result = await track(candidate, { ...fixture, venueFetch: async (url, init) => url.includes("/orderbook") ? Response.json({}, { status: 500 }) : fixture.venueFetch!(url, init) });
    expect(result.state).toBe("ok");
    expect(result.data).toMatchObject({ resting: null, confidence: "unknown", count: 2 });
    expect(result.warnings.map((w) => w.code)).toContain("venue_unreachable");
  });
  it("exact history refuses candidate-only sender and watch parameters rather than ignoring them", async () => {
    const input = { resource: "orderbook", chainId: inactive.chainId, filters: { orderHash: inactive.orderHash } };
    await expect(runTool("cork_query", { ...input, since: "opaque" }, ctx())).rejects.toBeInstanceOf(ToolInputError);
    await expect(runTool("cork_query", { ...input, filters: { ...input.filters, account: inactive.maker } }, ctx())).rejects.toBeInstanceOf(ToolInputError);
  });

  it("missing availability stays unknown even with an untouched bit", async () => {
    const row = { ...usedBit, status: "OPEN", availability: undefined };
    const result = await track(row, { ...ctx(0n), venueFetch: async (url) => url.includes("/rollover/") ? Response.json({}, { status: 404 }) : Response.json({ items: url.includes("/orderbook") ? [row] : [], hasMore: false }) });
    expect(result.data).toMatchObject({ resting: null, confidence: "unknown", chainVerification: { onChainStatus: "live-untouched" } });
  });

  it("unavailable native rows do not generate fill or replacement bytes", async () => {
    for (const type of ["taker-fill", "refresh-order"]) {
      const result = await runTool("cork_prepare_orders", { chainId: usedBit.chainId, account: usedBit.maker, clientRequestId: "native-unavailable", action: { type, orderHash: usedBit.orderHash, ...(type === "taker-fill" ? { fillMakingAmount: "1" } : {}) } }, ctx());
      expect(result.state).toBe("unavailable");
      expect(result.warnings[0]?.code).toBe("invalid_order_terms");
      expect(result.data).toBeNull();
    }
  });

  it("exact query retains inactive signed originals and totals without ranking away history", async () => {
    const result = await runTool("cork_query", { resource: "orderbook", chainId: inactive.chainId, filters: { orderHash: inactive.orderHash } }, ctx());
    expect(result.state).toBe("ok");
    expect(result.data).toMatchObject({ items: [inactive] });
  });

  it("terminal history with a spent chain bit is not a resting-order conflict", async () => {
    const result = await track(inactive, ctx(1n));
    expect(result.state).toBe("ok");
    expect(result.data).toMatchObject({ resting: false, confidence: "unknown", order: inactive, chainVerification: { onChainStatus: "filled-or-cancelled" } });
  });

  it("a bit-consumed partial residual is history, not an executable resting quote", async () => {
    const result = await track(usedBit, ctx(1n));
    expect(result.state).toBe("ok");
    expect(result.data).toMatchObject({ resting: false, order: { makingAmount: "10", remainingMakingAmount: "9", filledMakingAmount: "1", availability: { state: "unavailable", reason: "bit-consumed" }, confidence: "unknown", lastStatusSyncBlock: null } });
  });

  it("candidate with actual cumulative taker overpayment retains unknown confidence", async () => {
    const result = await runTool("cork_query", { resource: "orderbook", chainId: candidate.chainId, filters: { orderHash: candidate.orderHash } }, {
      ...ctx(), venueFetch: withNativeApiMetadata(async () => Response.json({ items: [candidate], hasMore: false })),
    });
    expect(result.data).toMatchObject({ items: [{ makingAmount: "10", takingAmount: "7", filledMakingAmount: "6", filledTakingAmount: "10", remainingMakingAmount: "4", remainingTakingAmount: "0", confidence: "unknown", availability: { state: "candidate" } }] });
  });

  it("same hash on a different chain is a separate native record", async () => {
    const other = capture.responses[5]!.body.items[0]!;
    const result = await track(other);
    expect(result.state).toBe("ok");
    expect(result.data).toMatchObject({ order: { chainId: 1, orderHash: other.orderHash, filledMakingAmount: "0" }, confidence: "unknown" });
  });
});
