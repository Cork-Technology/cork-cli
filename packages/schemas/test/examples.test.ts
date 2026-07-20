// The examples/teaching contract, enforced mechanically:
//  1. every shipped example validates against its own tool's input schema — so the "corrected
//     example" a teaching error returns is guaranteed to be a valid next call;
//  2. every tool has ≥1 example and a maturity entry;
//  3. teaching errors carry per-issue paths, a typo suggestion for closed enums, and the example.
import { describe, expect, it } from "vitest";
import { buildTeaching, MATURITY, nearestValue, REGISTRY, TOOL_EXAMPLES, toolByName } from "@cork/schemas";

describe("shipped examples are valid invocations (the next-call-succeeds guarantee)", () => {
  for (const tool of REGISTRY) {
    const examples = TOOL_EXAMPLES[tool.name]!;
    it(`${tool.name}: has examples and every one parses`, () => {
      expect(examples.length).toBeGreaterThan(0);
      for (const ex of examples) {
        const r = tool.input.safeParse(ex.input);
        expect(r.success, `${tool.name} example "${ex.title}" must validate: ${r.success ? "" : JSON.stringify(r.error?.issues)}`).toBe(true);
      }
    });
  }
});

describe("maturity map covers the whole surface", () => {
  it("every registered tool has a maturity entry with a valid status", () => {
    for (const tool of REGISTRY) {
      const m = MATURITY[tool.name]!;
      expect(m, tool.name).toBeTruthy();
      expect(["activated", "implemented", "specified"]).toContain(m.status);
      for (const v of Object.values(m.variants ?? {})) {
        expect(["activated", "implemented", "specified"]).toContain(v.status);
        if (v.status === "specified") expect(v.reason, "specified variants must say why").toBeTruthy();
      }
    }
  });
});

describe("teaching errors", () => {
  it("closed-enum typo → nearest-value suggestion + corrected example that validates", () => {
    const query = toolByName("cork_query")!;
    const bad = { resource: "markett", format: "concise" };
    const parsed = query.input.safeParse(bad);
    expect(parsed.success).toBe(false);
    const t = buildTeaching("cork_query", parsed.error!.issues, bad);
    expect(t.summary).toContain("cork_query");
    expect(t.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.issues)).toMatch(/did you mean/);
    expect(t.remediation).toMatch(/retry/i);
    expect(t.example).toBeTruthy();
    expect(query.input.safeParse(t.example!.input).success).toBe(true); // the fix it hands out works
  });

  it("field-level issues carry path + expected where zod provides them", () => {
    const phoenix = toolByName("cork_prepare_phoenix")!;
    const bad = { chainId: 1, account: "0x123", clientRequestId: "demo-bad-0001", action: { type: "deposit" } };
    const parsed = phoenix.input.safeParse(bad);
    const t = buildTeaching("cork_prepare_phoenix", parsed.success ? [] : parsed.error.issues, bad);
    expect(t.issues.some((i) => i.path.startsWith("account") || i.path.startsWith("action"))).toBe(true);
  });

  it("nearestValue: close typo suggests, distant garbage does not", () => {
    expect(nearestValue("swap-rate", ["cst-swap-rate", "unwind-rate"])).toBe("cst-swap-rate");
    expect(nearestValue("zzzzzzzzzz", ["cst-swap-rate", "unwind-rate"])).toBeUndefined();
  });
});
