// Live parity for the bit-invalidator read. Self-skips unless CORK_RPC_LIVE=1.
//
// The venue lists orders it recorded as FILLED or CANCELLED. For a bit-invalidator order, the
// chain holds the proof: the order's bit in `_raw[nonce >> 8]` is set. This suite reads the
// venue rows unverified, then reads the chain two ways. The nonce argument (the view's contract)
// must show the bit set. The pre-shifted slot index (the 2026-08-20 bug) must read a word
// WITHOUT the bit — the word that made a dead order look live.
import { describe, expect, it } from "vitest";
import { classifyInvalidatorWord, hashLopOrder, LOP_ADDRESSES, lopInvalidatorAbi, lopInvalidatorPlan, type LopOrder, readLopInvalidator, resolveRpc, runTool } from "@cork/core";
import { parseSignedLopOrder } from "../src/datasources/venue.ts";

const LIVE = process.env.CORK_RPC_LIVE === "1";
const CHAIN = 42161;

type Row = { status: string; order: LopOrder };

async function deadRows(status: string): Promise<Row[]> {
  // resolveRpc → null: the hybrid read cannot verify, so it labels every row unverified and
  // keeps it — the raw venue view, without dropping the rows this suite wants to examine.
  const env = await runTool("cork_query", { resource: "orderbook", chainId: CHAIN, filters: { status }, pageSize: 10, maxPages: 1 }, { resolveRpc: async () => null });
  if (env.state !== "ok") return [];
  // The same parser the hybrid verifier uses — no second guess at the venue's row shape.
  return (env.data as { items: Array<Record<string, unknown>> }).items.flatMap((raw) => {
    const parsed = parseSignedLopOrder(raw);
    return parsed.ok && lopInvalidatorPlan(parsed.value.order.makerTraits).mode === "bit" ? [{ status: String(raw.status), order: parsed.value.order }] : [];
  });
}

describe.skipIf(!LIVE)("bit-invalidator read — live parity against venue FILLED/CANCELLED rows (Arbitrum)", () => {
  it("every dead bit-invalidator row reads dead through readLopInvalidator; the pre-shifted slot argument reads an empty word", async () => {
    const resolved = await resolveRpc(CHAIN, undefined);
    expect(resolved).not.toBeNull();
    const client = resolved!.client;
    const lop = LOP_ADDRESSES[CHAIN]!;
    const rows = [...(await deadRows("FILLED")), ...(await deadRows("CANCELLED"))];
    if (rows.length === 0) {
      console.warn("venue has no FILLED/CANCELLED bit-invalidator rows on Arbitrum right now — nothing to compare");
      return;
    }
    for (const row of rows) {
      const plan = lopInvalidatorPlan(row.order.makerTraits);
      if (plan.mode !== "bit") continue;
      const orderHash = hashLopOrder(CHAIN, lop, row.order);
      const word = await readLopInvalidator(client, plan, lop, row.order.maker, orderHash);
      expect(classifyInvalidatorWord(plan, word), `${row.status} row ${orderHash} must read dead`).toBe("filled-or-cancelled");
      // The bug, replayed: ask the view with the slot index instead of the nonce.
      const preShifted = (await client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "bitInvalidatorForOrder", args: [row.order.maker, plan.slot] })) as bigint;
      expect(preShifted & plan.mask, `slot-index read for ${orderHash} must NOT show the bit`).toBe(0n);
    }
    console.info(`verified ${String(rows.length)} dead bit-invalidator rows both ways`);
  }, 120_000);

  it("the hybrid orderbook read drops every FILLED row the chain refutes (status_mismatch); none survive as confirmed", async () => {
    const env = await runTool("cork_query", { resource: "orderbook", chainId: CHAIN, filters: { status: "FILLED" }, pageSize: 10, maxPages: 1 }, {});
    expect(env.state).toBe("ok");
    const v = (env.data as { verification: { confirmed: number; dropped: number; unverified: number } }).verification;
    if (v.confirmed + v.dropped + v.unverified === 0) return;
    expect(v.confirmed).toBe(0);
    expect(v.dropped).toBeGreaterThan(0);
    expect(env.warnings.some((w) => w.code === "status_mismatch")).toBe(true);
  }, 120_000);
});
