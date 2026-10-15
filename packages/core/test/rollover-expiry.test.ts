import { describe, expect, it } from "vitest";
import { runTool } from "@cork/core";
import { toEventSelector } from "viem";
import { z } from "zod";
import { stubRpc } from "./helpers.ts";
import { CHAIN, NOW, rolloverContext, rolloverRow, type RolloverRow } from "./rollover-status-fixtures.ts";

const track = (row: RolloverRow, chain: number | "error" = 0) => runTool("cork_track", { mode: "reconcile", chainId: CHAIN, subject: { kind: "orderHash", orderHash: row.orderDigest } }, rolloverContext(row, chain).context);
const query = (row: RolloverRow, chain: number | "error" = 0) => runTool("cork_query", { resource: "rollover-orders", chainId: CHAIN, mode: "hybrid" }, rolloverContext(row, chain).context);
const QueryData = z.object({ items: z.array(z.record(z.string(), z.unknown())), verification: z.object({ confirmed: z.number(), unverified: z.number(), dropped: z.number() }) });

describe("raw rollover lifecycle with optional API effectiveStatus", () => {
  it.each([NOW - 1n, NOW, NOW + 1n])("old API omitting effectiveStatus retains PENDING/None at deadline %s", async (deadline) => {
    const row = rolloverRow(deadline);
    const t = await track(row);
    expect(t.state).toBe("ok");
    expect(t.data).toMatchObject({ lifecycle: "PENDING", order: { status: "PENDING", expiredAt: null }, chainVerification: { chainStatus: "None", consistent: true, events: [] } });
    const data = z.object({ order: z.record(z.string(), z.unknown()) }).parse(t.data);
    expect(data.order).not.toHaveProperty("effectiveStatus");
    expect(t.data).not.toHaveProperty("expiry");
    const q = QueryData.parse((await query(row)).data);
    expect(q.items[0]).toMatchObject({ orderDigest: row.orderDigest, status: "PENDING", verification: "confirmed", expiredAt: null });
    expect(q.items[0]).not.toHaveProperty("effectiveStatus");
    expect(q.items[0]).not.toHaveProperty("expiry");
    expect(q.verification).toMatchObject({ confirmed: 1, dropped: 0 });
  });

  it.each([NOW - 1n, NOW])("additive effective EXPIRED at %s never becomes a chain transition", async (deadline) => {
    const row = { ...rolloverRow(deadline), effectiveStatus: "EXPIRED" };
    const t = await track(row);
    expect(t.state).toBe("ok");
    expect(t.data).toMatchObject({ lifecycle: "PENDING", order: { status: "PENDING", effectiveStatus: "EXPIRED", expiredAt: null }, chainVerification: { chainStatus: "None", venueStatus: "PENDING", consistent: true, events: [] } });
    const data = z.object({ chainVerification: z.record(z.string(), z.unknown()) }).parse(t.data);
    expect(data.chainVerification).not.toHaveProperty("expiry");
    const q = QueryData.parse((await query(row)).data);
    expect(q.items[0]).toMatchObject({ status: "PENDING", effectiveStatus: "EXPIRED", verification: "confirmed", expiredAt: null, fillable: false });
    expect(q.items[0]).not.toHaveProperty("chainStatus");
    expect(q.items[0]).not.toHaveProperty("expiry");
    expect(q.verification).toMatchObject({ confirmed: 1, dropped: 0 });
  });

  it("annotation does not change default filters or locally assessed fillability", async () => {
    const old = rolloverRow(NOW + 3600n);
    const additive = { ...old, effectiveStatus: "EXPIRED" }; // Untrusted annotation must not control execution advice.
    const before = QueryData.parse((await query(old)).data);
    const fixture = rolloverContext(additive);
    const after = QueryData.parse((await runTool("cork_query", { resource: "rollover-orders", chainId: CHAIN }, fixture.context)).data);
    expect(before.items[0]).toMatchObject({ status: "PENDING", fillable: true });
    expect(after.items[0]).toMatchObject({ status: "PENDING", effectiveStatus: "EXPIRED", fillable: true });
    const params = fixture.requests[0]!.searchParams;
    expect(params.has("status")).toBe(false);
    expect(params.has("fillable")).toBe(false);
    expect(params.has("effectiveStatus")).toBe(false);
    expect(fixture.reads).toEqual([old.settler.toLowerCase()]);
  });

  it.each(["FUTURE_STATUS", null, 99])("unknown present effectiveStatus %s is only a raw annotation", async (effectiveStatus) => {
    const row = { ...rolloverRow(), effectiveStatus };
    const t = await track(row);
    expect(t.data).toMatchObject({ lifecycle: "PENDING", order: { effectiveStatus }, chainVerification: { chainStatus: "None", venueStatus: "PENDING" } });
    const q = QueryData.parse((await query(row)).data);
    expect(q.items[0]).toMatchObject({ status: "PENDING", effectiveStatus });
    const contradicted = { ...row, status: "OPENED" };
    expect((await track(contradicted)).state).toBe("conflict");
    const conflict = QueryData.parse((await query(contradicted)).data);
    expect(conflict.verification.dropped).toBe(1);
  });

  it.each([["OPENED", 1], ["PARTIALLY_FILLED", 1], ["AWAITING_PREMIUM", 1], ["SETTLED", 2], ["CANCELLED", 4], ["CLOSING", 5], ["EXPIRED", 3]] as const)("late %s retains raw chain enum %s", async (status, chain) => {
    const row = { ...rolloverRow(), status, effectiveStatus: status };
    const t = await track(row, chain);
    expect(t.state).toBe("ok");
    expect(t.data).toMatchObject({ lifecycle: status, order: { status, effectiveStatus: status }, chainVerification: { consistent: true } });
    const q = QueryData.parse((await query(row, chain)).data);
    expect(q.items[0]).toMatchObject({ status, effectiveStatus: status, verification: "confirmed" });
  });

  it.each([null, "2026-09-21T10:00:00.000Z"])("raw EXPIRED/None is a real lifecycle conflict, regardless of expiredAt %s", async (expiredAt) => {
    const row = { ...rolloverRow(), status: "EXPIRED", effectiveStatus: "EXPIRED", expiredAt };
    const t = await track(row);
    expect(t.state).toBe("conflict");
    expect(t.provenance.source).toBe("chain");
    expect(t.data).toMatchObject({ venueStatus: "EXPIRED", chainStatus: "None", chainVerification: { consistent: false } });
    const q = QueryData.parse((await query(row)).data);
    expect(q.verification).toMatchObject({ confirmed: 0, dropped: 1 });
  });

  it("genuine onchain expiry reports only its emitter-authenticated event", async () => {
    const row = { ...rolloverRow(), status: "EXPIRED", effectiveStatus: "EXPIRED", expiredAt: "2026-09-21T10:00:00.000Z" };
    const context = rolloverContext(row, 3).context;
    context.logsFetch = async () => Response.json({ jsonrpc: "2.0", id: 1, result: [{ address: row.settler, topics: [toEventSelector("OrderExpired(bytes32)"), row.orderDigest], data: "0x", blockNumber: "0x100", transactionHash: `0x${"ab".repeat(32)}`, logIndex: "0x0" }] });
    const result = await runTool("cork_track", { mode: "reconcile", chainId: CHAIN, subject: { kind: "orderHash", orderHash: row.orderDigest } }, context);
    expect(result.state).toBe("ok");
    expect(result.data).toMatchObject({ lifecycle: "EXPIRED", order: { expiredAt: row.expiredAt }, chainVerification: { chainStatus: "Expired", consistent: true, events: [{ event: "OrderExpired", address: row.settler, topic1: row.orderDigest }] } });
  });

  it.each(["venue", "chain"])("unknown %s status retains track conflict and hybrid unverified", async (unknown) => {
    const row = { ...rolloverRow(), status: unknown === "venue" ? "FUTURE_STATUS" : "PENDING", effectiveStatus: "EXPIRED" };
    const chain = unknown === "chain" ? 99 : 0;
    expect((await track(row, chain)).state).toBe("conflict");
    const q = QueryData.parse((await query(row, chain)).data);
    expect(q.verification).toMatchObject({ confirmed: 0, unverified: 1, dropped: 0 });
  });

  it("status RPC failure preserves successful history without confirming lifecycle", async () => {
    const row = { ...rolloverRow(), effectiveStatus: "EXPIRED" };
    const t = await track(row, "error");
    expect(t.state).toBe("ok");
    expect(t.provenance.source).toBe("chain");
    expect(t.warnings.map((w) => w.code)).toContain("chain_read_failed");
    expect(t.warnings.map((w) => w.code)).not.toContain("logs_unavailable");
    expect(t.data).toMatchObject({ lifecycle: "PENDING", order: { status: "PENDING", effectiveStatus: "EXPIRED", expiredAt: null }, chainVerification: { events: [] } });
    const data = z.object({ chainVerification: z.record(z.string(), z.unknown()) }).parse(t.data);
    expect(data.chainVerification).not.toHaveProperty("chainStatus");
    expect(data.chainVerification).not.toHaveProperty("consistent");
    const q = QueryData.parse((await query(row, "error")).data);
    expect(q.verification).toMatchObject({ confirmed: 0, unverified: 1, dropped: 0 });
  });

  it("both status RPC and history failure retain indexer-only lifecycle without absence", async () => {
    const row = { ...rolloverRow(), effectiveStatus: "EXPIRED" };
    const context = rolloverContext(row, "error", "error").context;
    const t = await runTool("cork_track", { mode: "reconcile", chainId: CHAIN, subject: { kind: "orderHash", orderHash: row.orderDigest } }, context);
    expect(t.state).toBe("ok");
    expect(t.provenance.source).toBe("indexer");
    expect(t.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["chain_read_failed", "logs_unavailable"]));
    expect(t.data).toMatchObject({ lifecycle: "PENDING", order: { status: "PENDING", effectiveStatus: "EXPIRED", expiredAt: null } });
    expect(t.data).not.toHaveProperty("chainVerification");
    const q = QueryData.parse((await runTool("cork_query", { resource: "rollover-orders", chainId: CHAIN, mode: "hybrid" }, context)).data);
    expect(q.items[0]).toMatchObject({ orderDigest: row.orderDigest, status: "PENDING", effectiveStatus: "EXPIRED", expiredAt: null, verification: "unverified" });
    expect(q.verification).toMatchObject({ confirmed: 0, unverified: 1, dropped: 0 });
  });

  it("retains annotations beyond the verification budget without claiming chain confirmation", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({ ...rolloverRow(NOW - 1n - BigInt(i)), effectiveStatus: "EXPIRED" }));
    let reads = 0;
    const context = { ...rolloverContext(rows[0]!).context, venueFetch: async () => Response.json({ items: rows, hasMore: false }), resolveRpc: stubRpc(() => { reads++; return 0; }) };
    const result = await runTool("cork_query", { resource: "rollover-orders", chainId: CHAIN, pageSize: 100 }, context);
    const data = QueryData.parse(result.data);
    expect(data.items.map((row) => row.orderDigest)).toEqual(rows.map((row) => row.orderDigest));
    expect(data.verification).toMatchObject({ confirmed: 50, unverified: 5, dropped: 0 });
    expect(reads).toBe(50);
    expect(data.items.slice(50).map((row) => [row.status, row.effectiveStatus, row.verification])).toEqual(Array.from({ length: 5 }, () => ["PENDING", "EXPIRED", "unverified"]));
  });
});
