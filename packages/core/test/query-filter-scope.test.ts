// The per-resource filter applicability gate: a KNOWN filter key on a resource that does not
// consume it is refused with teaching (exit 2) — "a known filter key is never silently
// unapplied" (the orderHash client-side rule), generalized. Plus the drift gates that pin the
// RESOURCE_FILTER_KEYS record to the schema's resource enum and to KNOWN_FILTER_KEYS from both
// sides, so a new resource or a new key cannot land half-mapped.
import { describe, expect, it } from "vitest";
import { QueryInput } from "@cork/schemas";
import { runTool, ToolInputError } from "@cork/core";
import { KNOWN_FILTER_KEYS, RESOURCE_FILTER_KEYS } from "../src/handlers/filters.ts";

const q = (resource: string, filters: Record<string, unknown>) =>
  runTool("cork_query", { resource, chainId: 1, pageSize: 25, format: "concise", filters }, { nowSeconds: 1_790_000_000n, venueFetch: async () => new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }) });

describe("per-resource filter applicability", () => {
  it("a known key on the wrong resource is refused, naming the resource's own keys", async () => {
    await expect(q("cork-pool", { poolId: `0x${"ab".repeat(32)}`, side: "SELL" })).rejects.toThrow(ToolInputError);
    const err = await q("cork-pool", { poolId: `0x${"ab".repeat(32)}`, side: "SELL" }).catch((e: ToolInputError) => e);
    const issue = (err as ToolInputError & { issues: Array<{ path: unknown[]; message: string }> }).issues[0]!;
    expect(issue.path).toEqual(["filters", "side"]);
    expect(issue.message).toContain("cork-pool");
    expect(issue.message).toContain("consumes: poolId");
  });

  it("a resource that takes no filters says so", async () => {
    const err = await q("protocol-config", { poolId: `0x${"ab".repeat(32)}` }).catch((e: ToolInputError) => e);
    expect((err as ToolInputError & { issues: Array<{ message: string }> }).issues[0]!.message).toContain("takes no filters");
  });

  it("near-miss teaching stays resource-scoped: rfqs refuses `label` without offering another resource's key", async () => {
    const err = await q("rfqs", { label: "USD" }).catch((e: ToolInputError) => e);
    const msg = (err as ToolInputError & { issues: Array<{ message: string }> }).issues[0]!.message;
    expect(msg).toContain("rfqs");
    expect(msg).not.toContain("collateralAsset"); // another resource's vocabulary never leaks into this teaching
  });

  it("keys a resource DOES consume pass the gate (the over-refusal direction)", async () => {
    // orderbook consumes account (the exclusivity fill sender) — an empty book answers ok.
    const book = await q("orderbook", { account: "0x00000000000000000000000000000000000000dd" });
    expect(book.state).toBe("ok");
    // fills consumes poolId only in full-decentralized mode, but the union rule admits it here.
    const fills = await q("fills", { orderHash: `0x${"cd".repeat(32)}` });
    expect(fills.state).toBe("ok");
  });

  it("a globally unknown key still gets the global did-you-mean, not the applicability teaching", async () => {
    const err = await q("orderbook", { poolid: `0x${"ab".repeat(32)}` }).catch((e: ToolInputError) => e);
    expect((err as ToolInputError & { issues: Array<{ message: string }> }).issues[0]!.message).toContain("unknown filter key");
  });
});

describe("variant-scoped applicability (audit DB-006): a key the READ SHAPE never applies is refused", () => {
  const issueOf = async (resource: string, filters: Record<string, unknown>) => {
    const err = await q(resource, filters).catch((e: ToolInputError) => e);
    expect(err).toBeInstanceOf(ToolInputError);
    return (err as ToolInputError & { issues: Array<{ path: unknown[]; message: string }> }).issues[0]!;
  };

  it("rfqs single record: list-only keys beside rfqId are refused, naming the single-record shape and its two keys", async () => {
    // Every value is VALID for its key (the schema's own type checks run first — an invalid
    // value would fail there and prove nothing about applicability).
    const valid: Record<string, unknown> = { state: "expired", account: "0x00000000000000000000000000000000000000dd", underwriter: "0x00000000000000000000000000000000000000dd", excludeRequestPrefix: "healthcheck-", withAnswers: true, referenceAsset: "0x00000000000000000000000000000000000000dd" };
    for (const key of Object.keys(valid)) {
      const issue = await issueOf("rfqs", { rfqId: "rfq_x", [key]: valid[key] });
      expect(issue.path).toEqual(["filters", key]);
      expect(issue.message).toContain("single record");
      expect(issue.message).toContain("consumes: rfqId, view");
    }
  });

  it("rfqs single record: `view` is the one companion key it consumes — the pair passes the gate", async () => {
    // Reaching the venue at all is the proof: the gate throws BEFORE any fetch, so a non-throw
    // with an envelope back means rfqId+view were admitted (the stub venue's answer shape is
    // irrelevant here).
    const env = await q("rfqs", { rfqId: "rfq_x", view: "current" });
    expect(["ok", "unavailable"]).toContain(env.state);
  });

  it("rfqs LIST reads keep the whole union (state, account, underwriter, …) — the narrowing is rfqId-conditional", async () => {
    const env = await q("rfqs", { state: "open", underwriter: "0x00000000000000000000000000000000000000dd", withAnswers: true });
    expect(env.state).toBe("ok");
  });

  it("rollover-orders: each kind refuses the other kinds' keys — a contracts filter on the orders feed, a fills filter on contracts", async () => {
    const onOrders = await issueOf("rollover-orders", { factory: "0x00000000000000000000000000000000000000dd" }); // kind defaults to orders
    expect(onOrders.path).toEqual(["filters", "factory"]);
    expect(onOrders.message).toContain("kind=orders");
    const onContracts = await issueOf("rollover-orders", { kind: "contracts", filler: "0x00000000000000000000000000000000000000dd" });
    expect(onContracts.message).toContain("kind=contracts");
    const onFills = await issueOf("rollover-orders", { kind: "fills", poolId: `0x${"ab".repeat(32)}` });
    expect(onFills.message).toContain("kind=fills");
  });

  it("rollover-orders: each kind still accepts its OWN keys (the over-refusal direction)", async () => {
    expect((await q("rollover-orders", { kind: "orders", settler: "0x00000000000000000000000000000000000000dd", fillable: true })).state).toBe("ok");
    expect((await q("rollover-orders", { kind: "fills", filler: "0x00000000000000000000000000000000000000dd" })).state).toBe("ok");
    expect((await q("rollover-orders", { kind: "contracts", factory: "0x00000000000000000000000000000000000000dd" })).state).toBe("ok");
  });
});

describe("RESOURCE_FILTER_KEYS drift gates", () => {
  const resources = (QueryInput.shape.resource as unknown as { options: readonly string[] }).options;

  it("maps every schema resource, and nothing else", () => {
    expect(Object.keys(RESOURCE_FILTER_KEYS).sort()).toEqual([...resources].sort());
  });

  it("every mapped key is a KNOWN filter key, and every KNOWN key is consumed by at least one resource", () => {
    const known = new Set<string>(KNOWN_FILTER_KEYS);
    const consumed = new Set<string>();
    for (const keys of Object.values(RESOURCE_FILTER_KEYS)) {
      for (const k of keys) {
        expect(known.has(k)).toBe(true);
        consumed.add(k);
      }
    }
    // A key no resource consumes is dead vocabulary: parseQueryFilters would accept it and the
    // gate would refuse it EVERYWHERE — delete it from KNOWN_FILTER_KEYS instead.
    expect([...known].filter((k) => !consumed.has(k))).toEqual([]);
  });
});
