import { describe, expect, it } from "vitest";
import { capture, maker, NOW, signedRow, withSurface } from "./native-api-compat-helpers.ts";
import type { HandlerContext } from "@cork/core";
import { withNativeApiMetadata } from "../../core/test/helpers.ts";

// Explicit authored API110 declaration for these native-row/checkpoint fixtures, not live-runtime evidence.
const api110Context = (context: HandlerContext & { venueFetch: NonNullable<HandlerContext["venueFetch"]> }) => ({ ...context, venueFetch: withNativeApiMetadata(context.venueFetch) });

const confidences = ["unknown", "provisional", "confirmed"] as const;
const hash = capture.unknown.orderHash;
const newCursor = capture.fillsPages[0]!.body.nextCursor!;

for (const surface of ["CLI", "MCP"] as const) describe(surface + " native API confidence compatibility", () => {
  it.each(confidences)("%s checkpoint confidence cannot admit an unavailable active residual or attest a candidate", async (confidence) => {
    const candidate = await signedRow(capture[confidence], "compat-candidate-" + confidence);
    const unavailable = { ...await signedRow(capture.unavailable, "compat-unavailable-" + confidence), confidence };
    await withSurface(surface, api110Context({ nowSeconds: NOW, resolveRpc: async () => null,
      venueFetch: async (url) => Response.json({ items: new URL(url).searchParams.has("orderHash") ? [unavailable] : [unavailable, candidate], hasMore: false }) }), async (call) => {
    const { envelope, failed } = await call("cork_query", { resource: "orderbook", chainId: 8453 });
    expect(failed).toBe(false);
    expect(envelope.state).toBe("ok");
    const data = envelope.data as { confidence: string; items: Array<Record<string, unknown>>; excluded: Array<Record<string, unknown>>; verification: { confirmed: number } };
    expect(data.items.map((row) => row.orderHash)).toEqual([candidate.orderHash]);
    expect(data.excluded).toMatchObject([{ orderHash: unavailable.orderHash, status: "OPEN", remainingMakingAmount: "10", remainingTakingAmount: "7", fillable: false, exclusion: "venue-status" }]);
    expect(data.items[0]).toMatchObject({ confidence, verification: "unverified", makingAmount: "10", takingAmount: "7", filledMakingAmount: "6", filledTakingAmount: "10", remainingMakingAmount: "4", remainingTakingAmount: "0" });
    expect(data.verification.confirmed).toBe(0);
    expect(data.confidence).toBe("unknown");
    // Exact history must retain the very same unavailable record, without ranking it away.
    const history = await call("cork_query", { resource: "orderbook", chainId: 8453, filters: { orderHash: unavailable.orderHash } });
    expect(history.envelope.state).toBe("ok");
    expect(history.envelope.data).toMatchObject({ confidence: "unknown", items: [unavailable] });
        });
  });

  it.each(confidences)("%s unavailable rows refuse fill and refresh before RPC or signable bytes", async (confidence) => {
    const row = { ...await signedRow(capture.unavailable, "compat-prepare-" + confidence), confidence };
    let rpcCalls = 0;
    await withSurface(surface, api110Context({ nowSeconds: NOW, resolveRpc: async () => { rpcCalls++; return null; },
      venueFetch: async (url) => {
        const query = new URL(url).searchParams;
        if (query.get("chainId") !== "8453" || query.get("orderHash") !== row.orderHash) throw new Error("wrong native identity");
        return Response.json({ items: [row], hasMore: false });
      } }), async (call) => {
    for (const type of ["taker-fill", "refresh-order"]) {
      const { envelope, failed } = await call("cork_prepare_orders", { chainId: 8453, account: maker.address, clientRequestId: "compat-prepare-" + type, action: { type, orderHash: row.orderHash } });
      expect(failed).toBe(true);
      expect(envelope.state).toBe("unavailable");
      expect(envelope.data).toBeNull();
      expect(envelope.warnings.map((warning) => warning.code)).toContain("invalid_order_terms");
    }
        });
    expect(rpcCalls).toBe(0);
  });

  it.each(["orderbook", "fills"])("%s metadata failure remains unavailable, not empty history", async (resource) => {
    const failure = capture.metadataFailures.find((entry) => entry.path.includes("/" + resource))!;
    await withSurface(surface, api110Context({ nowSeconds: NOW, resolveRpc: async () => null,
      venueFetch: async () => Response.json(failure.body, { status: failure.status }) }), async (call) => {
    const { envelope, failed } = await call("cork_query", { resource, chainId: 8453, filters: { orderHash: hash } });
    expect(failed).toBe(true);
    expect(envelope.state).toBe("unavailable");
    expect(envelope.data).toBeNull();
    expect(envelope.warnings.map((warning) => warning.code)).toContain("venue_unreachable");
    expect(envelope.warnings.map((warning) => warning.code)).not.toContain("order_not_found");
        });
  });

  it("book metadata failure preserves independently observed fills and unknown resting state", async () => {
    await withSurface(surface, api110Context({ nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async (url) => {
      if (url.includes("/rollover/")) return Response.json({}, { status: 404 });
      if (url.includes("/orderbook")) return Response.json(capture.metadataFailures[1]!.body, { status: 500 });
      return Response.json({ items: [...capture.fillsPages[0]!.body.items, ...capture.fillsPages[1]!.body.items], hasMore: false });
    } }), async (call) => {
      const { envelope, failed } = await call("cork_track", { mode: "reconcile", chainId: 8453, subject: { kind: "orderHash", orderHash: hash } });
      expect(failed).toBe(false);
      expect(envelope.state).toBe("ok");
      expect(envelope.data).toMatchObject({ resting: null, confidence: "unknown", count: 2, fills: [{ logIndex: 2, takingAmount: "8" }, { logIndex: 1, takingAmount: "2", observedBlockTimestamp: null }] });
      expect(envelope.warnings.map((warning) => warning.code)).toContain("venue_unreachable");
      expect(envelope.warnings.map((warning) => warning.code)).not.toContain("order_not_found");
    });
  });

  it("bounded walks resume saved and current opaque cursors without dropping same-tx logs", async () => {
    const cursors: Array<string | null> = [];
    await withSurface(surface, api110Context({ nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async (url) => {
      const query = new URL(url).searchParams;
      if (query.get("chainId") !== "8453" || query.get("orderHash") !== hash) throw new Error("wrong native identity");
      const cursor = query.get("cursor");
      cursors.push(cursor);
      if (cursor === null) return Response.json(capture.fillsPages[0]!.body);
      if (cursor === newCursor) return Response.json(capture.fillsPages[1]!.body);
      throw new Error("opaque cursor changed");
    } }), async (call) => {
      const input = { resource: "fills", chainId: 8453, filters: { orderHash: hash }, pageSize: 1, maxPages: 1 };
      const first = await call("cork_query", input);
      expect(first.envelope.state).toBe("ok");
      expect(first.envelope.data).toMatchObject({ pagination: { complete: false, nextCursor: newCursor }, items: [{ logIndex: 2, makingAmount: "3", takingAmount: "8" }] });
      expect(first.envelope.warnings.map((warning) => warning.code)).toContain("pagination_incomplete");
      {
        const cursor = newCursor;
        const next = await call("cork_query", { ...input, cursor });
        expect(next.envelope.state).toBe("ok");
        expect(next.envelope.data).toMatchObject({ pagination: { complete: true }, items: [{ logIndex: 1, makingAmount: "3", takingAmount: "2", observedBlockTimestamp: null }] });
      }
      const all = await call("cork_query", { ...input, maxPages: 2 });
      expect(all.envelope.data).toMatchObject({ pagination: { complete: true }, items: [{ logIndex: 2, txHash: capture.fillsPages[0]!.body.items[0]!.txHash }, { logIndex: 1, txHash: capture.fillsPages[0]!.body.items[0]!.txHash }] });
    });
    expect(cursors).toEqual([null, newCursor, null, newCursor]);
  });
  it("saved two-part book cursor continues through a new chain-qualified cursor", async () => {
    // Construct the saved format with the pinned API parseCursor/encodeKeysetCursor contract.
    // The CLI/MCP must keep it opaque; API acceptance belongs to the producer gate.
    const saved = Buffer.from("v2|2026-01-01 00:00:00+00|" + hash).toString("base64url");
    const current = Buffer.from("v2|2026-01-01 00:00:00+00|" + hash + "|8453").toString("base64url");
    const retired = await signedRow(capture.unavailable, "compat-saved-book");
    const candidate = await signedRow(capture.confirmed, "compat-current-book");
    const cursors: Array<string | null> = [];
    await withSurface(surface, api110Context({ nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async (url) => {
      const query = new URL(url).searchParams;
      if (query.get("chainId") !== "8453") throw new Error("wrong native chain");
      const cursor = query.get("cursor");
      cursors.push(cursor);
      if (cursor === saved) return Response.json({ items: [retired], hasMore: true, nextCursor: current });
      if (cursor === current) return Response.json({ items: [candidate], hasMore: false });
      throw new Error("saved opaque cursor changed");
    } }), async (call) => {
      const { envelope, failed } = await call("cork_query", { resource: "orderbook", chainId: 8453, sort: "venue", cursor: saved, pageSize: 1, maxPages: 2 });
      expect(failed).toBe(false);
      expect(envelope.state).toBe("ok");
      expect(envelope.data).toMatchObject({ confidence: "unknown", pagination: { complete: true }, items: [
        { orderHash: retired.orderHash, availability: { state: "unavailable" }, remainingMakingAmount: "10" },
        { orderHash: candidate.orderHash, confidence: "confirmed", verification: "unverified", filledTakingAmount: "10" },
      ] });
    });
    expect(cursors).toEqual([saved, current]);
  });
});
