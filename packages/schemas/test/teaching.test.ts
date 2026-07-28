// Teaching payload: nearest-value enum help + the CORRECTED example must match the FAILING
// variant, not blindly echo the tool's first example (which would silently change the caller's
// action/resource and teach the wrong move). Agent-facing surface — asserted here directly.
import { describe, expect, it } from "vitest";
import { buildTeaching, nearestValue, TOOL_EXAMPLES } from "@cork/schemas";

describe("nearestValue — closed-enum typo suggestion", () => {
  it("suggests the closest legal member for a near typo", () => {
    expect(nearestValue("liquidty", ["liquidity", "fixed"])).toBe("liquidity");
    expect(nearestValue("centralised", ["centralized", "lite-decentralized", "full-decentralized"])).toBe("centralized");
    expect(nearestValue("MARKET", ["market", "account-state"])).toBe("market"); // case-insensitive
  });
  it("returns undefined when nothing is within the edit-distance budget", () => {
    expect(nearestValue("zzzzzzzzzz", ["liquidity", "fixed"])).toBeUndefined();
    expect(nearestValue("", ["market"])).toBeUndefined();
  });
});

describe("buildTeaching — corrected example matches the failing variant", () => {
  // Read the variant the same way the module does, to assert selection without exporting internals.
  const variant = (input: unknown): string | undefined => {
    const o = input as Record<string, unknown> | undefined;
    const sub = (v: unknown, k: string) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined);
    return (sub(o?.action, "type") ?? sub(o?.params, "kind") ?? o?.resource ?? sub(o?.subject, "kind") ?? o?.kind) as string | undefined;
  };

  it("cork_compute impairment-floor input → the impairment-floor example (not the first, cst-swap-rate)", () => {
    const t = buildTeaching("cork_compute", [], { params: { kind: "impairment-floor", poolId: "0x0" } });
    expect(variant(t.example?.input)).toBe("impairment-floor");
    // guard the premise: the FIRST example is a different variant, so this proves per-variant pick
    expect(variant(TOOL_EXAMPLES.cork_compute![0]!.input)).not.toBe("impairment-floor");
  });

  it("cork_query market-predict input → the market-predict example", () => {
    const t = buildTeaching("cork_query", [], { resource: "market-predict" });
    expect(variant(t.example?.input)).toBe("market-predict");
  });

  it("cork_prepare_orders cancel input → the cancel example", () => {
    const t = buildTeaching("cork_prepare_orders", [], { action: { type: "cancel" } });
    expect(variant(t.example?.input)).toBe("cancel");
  });

  it("cork_track txHash subject → the txHash example", () => {
    const t = buildTeaching("cork_track", [], { subject: { kind: "txHash" } });
    expect(variant(t.example?.input)).toBe("txHash");
  });

  // Activated 2026-07-27 — each new variant must teach with ITS OWN example, not the first one.
  it("cork_decode order/event/receipt inputs → the matching decode example", () => {
    for (const kind of ["order", "event", "receipt"] as const) {
      const t = buildTeaching("cork_decode", [], { kind, data: 5 });
      expect(variant(t.example?.input)).toBe(kind);
    }
  });

  it("cork_compute dutch-auction-price input → the dutch-auction example (activated 2026-07-28)", () => {
    const t = buildTeaching("cork_compute", [], { params: { kind: "dutch-auction-price", order: 5 } });
    expect(variant(t.example?.input)).toBe("dutch-auction-price");
  });

  it("cork_query whitelisted-addresses input → the whitelisted-addresses example", () => {
    const t = buildTeaching("cork_query", [], { resource: "whitelisted-addresses", filters: { poolId: "bad" } });
    expect(variant(t.example?.input)).toBe("whitelisted-addresses");
  });

  it("cork_prepare_phoenix authority-onboard input → the authority example", () => {
    const t = buildTeaching("cork_prepare_phoenix", [], { action: { type: "authority-onboard" } });
    expect(variant(t.example?.input)).toBe("authority-onboard");
  });

  it("falls back to the FIRST example when the variant has no matching example", () => {
    const t = buildTeaching("cork_compute", [], { params: { kind: "no-such-kind" } });
    expect(t.example).toBe(TOOL_EXAMPLES.cork_compute![0]);
  });

  it("falls back to the FIRST example when no input is provided", () => {
    const t = buildTeaching("cork_query", []);
    expect(t.example).toBe(TOOL_EXAMPLES.cork_query![0]);
  });
});

describe("buildTeaching — enum-typo issue enrichment", () => {
  it("adds a did-you-mean suggestion and fills expected from the legal set", () => {
    const t = buildTeaching(
      "cork_query",
      [{ code: "invalid_value", path: ["resource"], message: "invalid", values: ["market", "account-state", "protocol-config"] }],
      { resource: "makret" },
    );
    expect(t.issues[0]?.suggestion).toBe('did you mean "market"?');
    expect(t.issues[0]?.expected).toContain("market");
    expect(t.summary).toContain("resource"); // failing field surfaced in the summary
  });

  it("tolerates a non-array issue payload without throwing (defensive)", () => {
    const t = buildTeaching("cork_decode", "not-an-array" as unknown);
    expect(t.issues).toEqual([]);
    expect(t.example).toBe(TOOL_EXAMPLES.cork_decode![0]); // single-variant tool still gets its example
  });
});
