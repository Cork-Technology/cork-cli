// The grader's params matcher: expected params are a subset of the call input, and a RegExp in
// the expectation tests a string field. Pinned so the widening stays exactly that — a RegExp can
// only match a string, and only the field it names.
import { describe, expect, it } from "vitest";
import { subsetMatch } from "./run.ts";

describe("subsetMatch", () => {
  it("matches a nested subset and rejects a missing or different leaf", () => {
    expect(subsetMatch({ action: { type: "cancel" } }, { chainId: 1, action: { type: "cancel", orderHash: "0x01" } })).toBe(true);
    expect(subsetMatch({ action: { type: "cancel" } }, { action: { type: "deposit" } })).toBe(false);
    expect(subsetMatch({ search: "unwind" }, {})).toBe(false);
  });
  it("a RegExp tests a string field — a broader query still satisfies the intent", () => {
    expect(subsetMatch({ search: /unwind/i }, { search: "unwind" })).toBe(true);
    expect(subsetMatch({ search: /unwind/i }, { search: "unwind covered position" })).toBe(true);
    expect(subsetMatch({ search: /unwind/i }, { search: "exercise coverage" })).toBe(false);
  });
  it("a RegExp never matches a non-string (no widening beyond the named string field)", () => {
    expect(subsetMatch({ search: /unwind/i }, { search: 5 })).toBe(false);
    expect(subsetMatch({ search: /unwind/i }, { search: { nested: "unwind" } })).toBe(false);
    expect(subsetMatch({ search: /unwind/i }, {})).toBe(false);
  });
});
