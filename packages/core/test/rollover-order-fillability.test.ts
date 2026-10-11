// A venue rollover-order row says whether its settler admits a fill NOW. The venue keeps a signed
// order PENDING after its deadlines pass, and the settler still answers None for it — consistent,
// so the row reads "confirmed". Without this flag an agent that reads the feed takes a lapsed
// order for a live one (2026-10-09 on Base: 187 of the 250 newest orders were PENDING and lapsed,
// none fillable). The rule is the one rollover-fill refuses on, at the same boundaries.
import { describe, expect, it } from "vitest";
import { runTool } from "../src/index.ts";
import { rolloverOrderFillability } from "../src/handlers/rollover-ranges.ts";
import type { HandlerContext } from "../src/handlers/shared.ts";

const NOW = 1_800_000_000n;
const ahead = String(NOW + 3_600n);
const row = (over: Record<string, unknown> = {}) => ({ status: "PENDING", openDeadline: ahead, fillDeadline: ahead, remainingSize: "1000000000000000000", ...over });

describe("rolloverOrderFillability: the settler's own refusals, at rollover-fill's boundaries", () => {
  it("an open order with both deadlines ahead is fillable", () => {
    expect(rolloverOrderFillability(row(), NOW)).toEqual({ fillable: true });
  });

  it("the fillDeadline bounds at equality, as rollover-fill does (fillDeadline <= now refuses)", () => {
    expect(rolloverOrderFillability(row({ fillDeadline: String(NOW) }), NOW)).toEqual({ fillable: false, whyNotFillable: [`its fillDeadline ${NOW} has passed (Settler__FillAfterDeadline)`] });
    expect(rolloverOrderFillability(row({ fillDeadline: String(NOW + 1n) }), NOW).fillable).toBe(true);
  });

  it("an UNOPENED order past its openDeadline is refused; an opened one is not", () => {
    expect(rolloverOrderFillability(row({ openDeadline: String(NOW) }), NOW)).toEqual({ fillable: false, whyNotFillable: [`it is not opened and its openDeadline ${NOW} has passed (Settler__OpenAfterOpenDeadline)`] });
    expect(rolloverOrderFillability(row({ status: "PARTIALLY_FILLED", openDeadline: String(NOW - 10n) }), NOW).fillable).toBe(true);
  });

  it("every terminal status is refused, whatever its deadlines say", () => {
    for (const status of ["SETTLED", "EXPIRED", "CANCELLED", "CLOSING", "settled"]) {
      const v = rolloverOrderFillability(row({ status, remainingSize: "0" }), NOW);
      expect(v.fillable, status).toBe(false);
      expect(v.whyNotFillable, status).toEqual([`the order is ${status.toLowerCase()} (Settler__OrderInTerminalState)`]);
    }
  });

  it("a live order with nothing left is refused; the remaining size may be a number on an older row", () => {
    expect(rolloverOrderFillability(row({ status: "PARTIALLY_FILLED", remainingSize: "0" }), NOW).whyNotFillable).toEqual(["nothing of the order remains (Settler__RolloverAmountOutOfBounds)"]);
    expect(rolloverOrderFillability(row({ remainingSize: 0 }), NOW).fillable).toBe(false);
    expect(rolloverOrderFillability(row({ remainingSize: 5 }), NOW).fillable).toBe(true);
  });

  it("every reason is named, not only the first", () => {
    expect(rolloverOrderFillability(row({ openDeadline: String(NOW - 1n), fillDeadline: String(NOW - 1n) }), NOW).whyNotFillable).toHaveLength(2);
  });

  it("a row without its status or fillDeadline is unknown, never guessed fillable", () => {
    expect(rolloverOrderFillability({ openDeadline: ahead, fillDeadline: ahead }, NOW)).toEqual({ fillable: null });
    expect(rolloverOrderFillability({ status: "PENDING", fillDeadline: "soon" }, NOW)).toEqual({ fillable: null });
  });
});

describe("cork_query rollover-orders marks each row and counts them", () => {
  const venueRows = [
    { orderDigest: `0x${"01".repeat(32)}`, ...row() },
    { orderDigest: `0x${"02".repeat(32)}`, ...row({ fillDeadline: String(NOW - 60n), openDeadline: String(NOW - 120n) }) },
    { orderDigest: `0x${"03".repeat(32)}`, ...row({ status: "SETTLED", remainingSize: "0" }) },
    { orderDigest: `0x${"04".repeat(32)}`, status: "PENDING" },
  ];
  const ctx: HandlerContext = {
    nowSeconds: NOW,
    resolveRpc: async () => null,
    venueFetch: async (url) => (url.includes("/rollover/v1/orders") ? new Response(JSON.stringify({ items: venueRows, nextCursor: null }), { status: 200 }) : new Response("{}", { status: 404 })),
  };
  const read = (filters: Record<string, unknown> = {}) => runTool("cork_query", { chainId: 8453, resource: "rollover-orders", filters: { kind: "orders", ...filters } }, ctx);

  it("without an RPC too: the flag comes from the row's own signed deadlines", async () => {
    const r = await read();
    expect(r.state).toBe("ok");
    const d = r.data as { items: Array<{ orderDigest: string; fillable: boolean | null; whyNotFillable?: string[] }>; fillability: { fillable: number; notFillable: number; unknown: number; note: string } };
    expect(d.items.map((i) => i.fillable)).toEqual([true, false, false, null]);
    expect(d.items[1]!.whyNotFillable).toEqual([`its fillDeadline ${NOW - 60n} has passed (Settler__FillAfterDeadline)`, `it is not opened and its openDeadline ${NOW - 120n} has passed (Settler__OpenAfterOpenDeadline)`]);
    expect({ ...d.fillability, note: undefined }).toEqual({ fillable: 1, notFillable: 2, unknown: 1, note: undefined });
    expect(d.fillability.note).toMatch(/filters\.fillable true/);
  });

  it("the other rollover feeds carry no fillability block", async () => {
    const r = await runTool("cork_query", { chainId: 8453, resource: "rollover-orders", filters: { kind: "contracts" } }, ctx);
    expect((r.data as Record<string, unknown> | null)?.fillability).toBeUndefined();
  });
});
