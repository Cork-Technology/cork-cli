import { describe, expect, it } from "vitest";
import { call, decodeBundle, encodeCorkAction, encodeMulticall } from "@cork/core";
import { ACTION_VECTORS } from "./fixtures/action-vectors.ts";
import golden from "./fixtures/action-golden.json" with { type: "json" };

const ADP = "0xccccccccccccbad6f772a511b337d9ccc9570407" as const;
const goldenMap = golden as Record<string, string>;

describe("all 13 CorkAdapter action encoders", () => {
  it("has a golden vector for every action (no gaps)", () => {
    expect(ACTION_VECTORS).toHaveLength(13);
    for (const v of ACTION_VECTORS) expect(goldenMap[v.name], v.name).toBeTruthy();
  });

  for (const v of ACTION_VECTORS) {
    it(`${v.name}: byte-parity with cast`, () => {
      expect(encodeCorkAction(v.name, v.params)).toBe(goldenMap[v.name]);
    });

    it(`${v.name}: decode round-trips every field`, () => {
      const data = encodeCorkAction(v.name, v.params);
      const [leg] = decodeBundle(encodeMulticall([call(ADP, data)]));
      expect(leg?.kind).toBe("cork");
      if (leg?.kind !== "cork") return;
      expect(leg.action).toBe(v.name);
      const decoded = leg.params as Record<string, unknown>;
      for (const [k, want] of Object.entries(v.params as unknown as Record<string, unknown>)) {
        const got = decoded[k];
        // addresses/bytes32 compare case-insensitively; bigints exactly.
        if (typeof want === "string") expect(String(got).toLowerCase(), `${v.name}.${k}`).toBe(want.toLowerCase());
        else expect(got, `${v.name}.${k}`).toBe(want);
      }
    });
  }
});
