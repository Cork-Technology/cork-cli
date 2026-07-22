// Deep check of the advertised JSON Schemas: (1) they carry real constraints (patterns, enums,
// discriminated unions, additionalProperties), and (2) ajv-validity against the emitted schema
// AGREES with the handler's zod validation — except for zod refinements (EIP-55 checksum) that a
// JSON Schema pattern cannot express, where the schema is deliberately the weaker gate. That gap
// is pinned explicitly so a future regression (e.g. dropping the zod refine) is caught.
import { describe, expect, it } from "vitest";
import { inputJsonSchema, toolByName, type ToolName } from "@cork/schemas";

// Ajv2020 for draft 2020-12 (what zod v4 emits).
const { default: Ajv2020 } = await import("ajv/dist/2020.js");
const ajv = new Ajv2020({ strict: false, allErrors: true });

function validators(tool: ToolName) {
  const def = toolByName(tool)!;
  const schema = inputJsonSchema(tool) as object;
  const validate = ajv.compile(schema);
  return {
    schema: schema as Record<string, unknown>,
    ajvOk: (input: unknown) => validate(structuredClone(input)) as boolean,
    zodOk: (input: unknown) => def.input.safeParse(input).success,
  };
}

describe("JSON Schema carries real constraints", () => {
  it("prepare_phoenix.action is a discriminated union; account carries an address pattern", () => {
    const s = inputJsonSchema("cork_prepare_phoenix") as Record<string, unknown>;
    const props = s.properties as Record<string, { anyOf?: unknown[]; oneOf?: unknown[]; pattern?: string }>;
    const action = props.action!;
    expect((action.anyOf ?? action.oneOf)?.length).toBeGreaterThan(5);
    expect(JSON.stringify(s)).toMatch(/0x\[0-9a-fA-F\]\{40\}|0x\[0-9a-f-A-F\]/); // address pattern present
  });
  it("compute.params is a union of kinds", () => {
    const s = inputJsonSchema("cork_compute") as Record<string, unknown>;
    const params = (s.properties as Record<string, { anyOf?: unknown[]; oneOf?: unknown[] }>).params!;
    expect((params.anyOf ?? params.oneOf)?.length).toBe(7);
  });
});

describe("ajv (wire schema) agrees with zod (handler) on shape", () => {
  const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a";
  const ADDR = "0x0000000000000000000000000000000000000001";

  const cases: Array<{ tool: ToolName; input: unknown; valid: boolean; note: string }> = [
    { tool: "cork_decode", input: { kind: "calldata", data: "0xabcdef", format: "concise" }, valid: true, note: "good calldata" },
    { tool: "cork_decode", input: { kind: "nonsense", data: "0x", format: "concise" }, valid: false, note: "kind not in enum" },
    // top-level tool inputs are lenient (forward-compat): an unknown top-level key is tolerated.
    { tool: "cork_decode", input: { kind: "calldata", data: "0x", format: "concise", extra: 1 }, valid: true, note: "extra top-level key tolerated" },
    // but discriminated-union MEMBERS are strict: an unknown key inside an action is rejected.
    { tool: "cork_prepare_phoenix", input: { chainId: 1, account: "0x0000000000000000000000000000000000000001", clientRequestId: "req-00000001", action: { type: "deposit", poolId: "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a", collateralAssetsIn: "1", receiver: "0x0000000000000000000000000000000000000001", minCptAndCstSharesOut: "1", bogus: 1 }, format: "concise" }, valid: false, note: "extra key inside strict action member" },
    { tool: "cork_compute", input: { params: { kind: "rollover-premium-floor", dstCstProduced: "1", minPremiumPerShare: "2" }, format: "concise" }, valid: true, note: "good rollover" },
    { tool: "cork_compute", input: { params: { kind: "impairment-floor", poolId: POOL, horizonSeconds: 10 }, format: "concise" }, valid: true, note: "good impairment" },
    { tool: "cork_compute", input: { params: { kind: "impairment-floor", poolId: POOL, horizonSeconds: -1 }, format: "concise" }, valid: false, note: "negative horizon" },
    { tool: "cork_compute", input: { params: { kind: "zzz" }, format: "concise" }, valid: false, note: "bad discriminant" },
    { tool: "cork_prepare_phoenix", input: { chainId: 1, account: ADDR, clientRequestId: "req-00000001", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: ADDR, minCptAndCstSharesOut: "1" }, format: "concise" }, valid: true, note: "good deposit" },
    { tool: "cork_prepare_phoenix", input: { chainId: 1, account: ADDR, clientRequestId: "req-00000001", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: ADDR }, format: "concise" }, valid: false, note: "missing field" },
    { tool: "cork_prepare_phoenix", input: { chainId: 999, account: ADDR, clientRequestId: "req-00000001", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: ADDR, minCptAndCstSharesOut: "1" }, format: "concise" }, valid: false, note: "chainId not in enum" },
    { tool: "cork_prepare_phoenix", input: { chainId: 1, account: "0x123", clientRequestId: "req-00000001", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: ADDR, minCptAndCstSharesOut: "1" }, format: "concise" }, valid: false, note: "malformed address (pattern)" },
  ];

  for (const c of cases) {
    it(`${c.tool}: ${c.note} -> ${c.valid}`, () => {
      const { ajvOk, zodOk } = validators(c.tool);
      expect(ajvOk(c.input), `ajv ${c.note}`).toBe(c.valid);
      expect(zodOk(c.input), `zod ${c.note}`).toBe(c.valid);
    });
  }

  it("documented gap: wire schema accepts a wrong-checksum address that zod refinement rejects", () => {
    const { ajvOk, zodOk } = validators("cork_prepare_phoenix");
    const input = { chainId: 1, account: "0x5aEDA56215b167893e80B4fE645BA6d5Bab767DE", clientRequestId: "req-00000001", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: "0x0000000000000000000000000000000000000001", minCptAndCstSharesOut: "1" }, format: "concise" };
    expect(ajvOk(input)).toBe(true); // pattern-only: shape is fine
    expect(zodOk(input)).toBe(false); // EIP-55 refine catches the typo — handler is the real gate
  });
});
