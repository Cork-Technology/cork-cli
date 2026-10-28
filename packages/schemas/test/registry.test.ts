import { describe, expect, it } from "vitest";
import { Address, inputJsonSchema, REGISTRY, SCHEMA_VERSION, toolByName } from "@cork/schemas";

describe("tool registry invariants", () => {
  it("has 9 tools with unique names and cli paths", () => {
    expect(REGISTRY).toHaveLength(9);
    const names = REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(9);
    const clis = REGISTRY.map((t) => t.cliPath.join(" "));
    expect(new Set(clis).size).toBe(9);
  });

  it("only cork_submit is non-read-only", () => {
    const writers = REGISTRY.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
    expect(writers).toEqual(["cork_submit"]);
  });

  it("every tool declares its telemetry kind; reads are the five non-acting tools; every actor path is an Address in the input", () => {
    for (const t of REGISTRY) expect(["read", "write"], `${t.name} telemetry`).toContain((t as { telemetry?: { kind?: string } }).telemetry?.kind);
    expect(REGISTRY.filter((t) => t.telemetry.kind === "read").map((t) => t.name).sort()).toEqual(["cork_capabilities", "cork_compute", "cork_decode", "cork_query", "cork_track"]);
    expect(REGISTRY.filter((t) => t.telemetry.kind === "write").map((t) => t.name).sort()).toEqual(["cork_prepare_market", "cork_prepare_orders", "cork_prepare_phoenix", "cork_submit"]);
    // An actor path must name an Address somewhere in the input (any union branch) — a typo'd
    // path would silently leave a write on the session identity.
    type Node = { $ref?: string; properties?: Record<string, Node>; anyOf?: Node[]; oneOf?: Node[]; allOf?: Node[] };
    const at = (node: Node | undefined, segs: string[]): Node[] => {
      if (!node) return [];
      const branches = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])].flatMap((b) => at(b, segs));
      if (segs.length === 0) return [node, ...branches];
      const child = node.properties?.[segs[0]!];
      return [...(child ? at(child, segs.slice(1)) : []), ...branches];
    };
    for (const t of REGISTRY) {
      if (t.telemetry.kind !== "write") continue;
      const doc = inputJsonSchema(t.name) as Node & { $defs?: Record<string, Node> };
      for (const path of t.telemetry.actor) {
        const hits = at(doc, path.split("."));
        expect(hits.some((n) => n.$ref === "#/$defs/Address"), `${t.name} actor ${path}`).toBe(true);
      }
    }
    // Every keepHashes path of a read names a Bytes32 / MarketId field of that tool's input.
    for (const t of REGISTRY) {
      if (t.telemetry.kind !== "read") continue;
      const doc = inputJsonSchema(t.name) as Node & { $defs?: Record<string, Node & { pattern?: string }> };
      for (const path of t.telemetry.keepHashes ?? []) {
        const hits = at(doc, path.split("."));
        const isHash = (n: (Node & { pattern?: string }) | undefined, hops = 0): boolean => n !== undefined && hops < 8 && (n.pattern === "^0x[0-9a-fA-F]{64}$" || (n.$ref !== undefined && isHash(doc.$defs?.[n.$ref.slice("#/$defs/".length)], hops + 1)));
        expect(hits.some(isHash), `${t.name} keepHashes ${path}`).toBe(true);
      }
    }
    expect(REGISTRY.flatMap((t) => (t.telemetry.kind === "read" ? (t.telemetry.keepHashes ?? []).map((p) => `${t.name}:${p}`) : []))).toEqual(["cork_query:filters.poolId", "cork_compute:params.poolId", "cork_track:subject.poolId"]);
  });

  it("every tool input produces a JSON schema (object root)", () => {
    for (const t of REGISTRY) {
      const s = inputJsonSchema(t.name) as { type?: string; properties?: unknown };
      expect(s.type).toBe("object");
      expect(s.properties).toBeTruthy();
    }
  });

  it("toolByName round-trips; SCHEMA_VERSION is set", () => {
    expect(toolByName("cork_query")?.cliPath).toEqual(["query"]);
    expect(toolByName("nope")).toBeUndefined();
    expect(SCHEMA_VERSION).toMatch(/^011\./);
  });
});

describe("hex-typed primitives", () => {
  it("Address parses valid, rejects malformed", () => {
    expect(Address.safeParse("0x0000000000000000000000000000000000000001").success).toBe(true);
    expect(Address.safeParse("0x123").success).toBe(false);
    expect(Address.safeParse("nope").success).toBe(false);
  });

  // Golden checksum computed independently via `cast to-check-sum-address`.
  const CHECKSUM = "0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE";

  it("Address normalizes all-lowercase to EIP-55 checksum", () => {
    const r = Address.safeParse(CHECKSUM.toLowerCase());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(CHECKSUM);
  });

  it("Address accepts a correct-checksum address unchanged", () => {
    const r = Address.safeParse(CHECKSUM);
    expect(r.success && r.data).toBe(CHECKSUM);
  });

  it("Address rejects a mixed-case wrong-checksum address (typo signal), cleanly", () => {
    // flip one letter's case vs the correct checksum -> no longer valid EIP-55
    const wrong = `0x5aEDA${CHECKSUM.slice(7)}`; // position 2 A->a
    const r = Address.safeParse(wrong);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/EIP-55/);
  });
});
