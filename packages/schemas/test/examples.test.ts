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
    const bad = { resource: "cork-poool", format: "concise" };
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

describe("teaching builder: defensive branches", () => {
  it("tolerates non-array issues (never throws on malformed zod output)", () => {
    const t = buildTeaching("cork_query", { weird: true }, {});
    expect(t.issues).toEqual([]);
    expect(t.summary).toBe("invalid input for cork_query");
    // No enum issue in sight → no enum advice: the closed-enum reminder is emitted only when
    // some issue actually carried a legal-value set (it used to ride every remediation).
    expect(t.remediation).not.toContain("closed");
    expect(t.remediation).toContain("Fix the listed field(s)");
  });

  it("the closed-enum reminder appears exactly when an issue carries a legal-value set", () => {
    const withEnum = buildTeaching("cork_query", [{ code: "invalid_value", path: ["resource"], message: "bad", values: ["cork-pool", "fills"] }], { resource: "pool" });
    expect(withEnum.remediation).toContain("closed");
    const withoutEnum = buildTeaching("cork_query", [{ code: "invalid_type", path: ["chainId"], message: "expected number" }], { chainId: "x" });
    expect(withoutEnum.remediation).not.toContain("closed");
  });

  it("walks array indices in issue paths to fetch the received value for suggestions", () => {
    const t = buildTeaching(
      "cork_query",
      [{ code: "invalid_value", path: ["filters", "list", 0], message: "bad", values: ["orders", "fills", "contracts"] }],
      { filters: { list: ["ordrs"] } },
    );
    expect(t.issues[0]?.suggestion).toBe('did you mean "orders"?');
    expect(t.issues[0]?.expected).toBe("orders | fills | contracts");
  });

  it("offers NO suggestion when the received value is not levenshtein-close to any legal value", () => {
    const t = buildTeaching(
      "cork_query",
      [{ code: "invalid_value", path: ["resource"], message: "bad", values: ["markets", "orderbook"] }],
      { resource: "completely-unrelated-thing" },
    );
    expect(t.issues[0]?.suggestion).toBeUndefined();
  });

  it("non-string received values (objects) never produce a suggestion", () => {
    const t = buildTeaching(
      "cork_query",
      [{ code: "invalid_value", path: ["resource"], message: "bad", values: ["markets"] }],
      { resource: { nested: true } },
    );
    expect(t.issues[0]?.suggestion).toBeUndefined();
  });
});

describe("example address literals ↔ cork-defaults.json (offline drift gate)", () => {
  // The worked examples pin recipe CONTRACT addresses inline (schema-layer files cannot import
  // core's config resolution without inverting the package layering). Nothing else bound them:
  // a recipe redeploy that updates cork-defaults.json would leave the SHIPPED wire examples
  // advertising a dead address — the stub.ts pinned-literal rot class, on the tool surface.
  it("every 0x address in an example that looks like a recipe matches a configured recipe", async () => {
    const { default: corkDefaults } = await import("../../../cork-defaults.json");
    const configured = new Set<string>();
    for (const mr of Object.values((corkDefaults as { marketRegistry: Record<string, { recipes?: Record<string, string> }> }).marketRegistry)) {
      for (const addr of Object.values(mr.recipes ?? {})) configured.add(addr.toLowerCase());
    }
    const recipeRefs: string[] = [];
    const walk = (v: unknown, keyed: string): void => {
      if (typeof v === "string" && keyed === "recipe" && /^0x[0-9a-fA-F]{40}$/.test(v)) recipeRefs.push(v);
      else if (Array.isArray(v)) for (const item of v) walk(item, keyed);
      else if (v && typeof v === "object") for (const [k, item] of Object.entries(v)) walk(item, k);
    };
    for (const examples of Object.values(TOOL_EXAMPLES)) for (const e of examples ?? []) walk(e.input, "");
    expect(recipeRefs.length).toBeGreaterThan(0);
    for (const addr of recipeRefs) {
      expect(configured.has(addr.toLowerCase()), `example recipe ${addr} is not a configured recipe address in cork-defaults.json — the redeploy updated the config but not the shipped examples`).toBe(true);
    }
  });
});
