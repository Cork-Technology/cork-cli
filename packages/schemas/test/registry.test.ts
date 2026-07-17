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
