// The grader's params matcher: expected params are a subset of the call input, and a RegExp in
// the expectation tests a string field. Pinned so the widening stays exactly that — a RegExp can
// only match a string, and only the field it names.
import { describe, expect, it } from "vitest";
import { plainAnswer, subsetMatch } from "./run.ts";
import { parseTraceCell } from "./regrade.ts";

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

describe("plainAnswer", () => {
  it("strips markdown emphasis and code markers and collapses whitespace, so a phrase split by bold still reads as the phrase", () => {
    expect(plainAnswer("does **not** check out")).toBe("does not check out");
    expect(plainAnswer("hash `0xabc`\n\nis _wrong_")).toBe("hash 0xabc is wrong");
    expect(/not check out/.test(plainAnswer("Your claim does **not** check out."))).toBe(true);
  });
  it("never inserts words: a text lacking the concept still lacks it", () => {
    expect(/not check out|mismatch/.test(plainAnswer("The claim **checks out** and the hashes match."))).toBe(false);
  });
});

describe("parseTraceCell inverts run.ts traceCell", () => {
  it("round-trips state, codes, the invalid marker and the unknown state", () => {
    expect(parseTraceCell("cork_track→conflict/marketid_mismatch+venue_reported", { a: 1 })).toEqual({ tool: "cork_track", input: { a: 1 }, state: "conflict", codes: ["marketid_mismatch", "venue_reported"] });
    expect(parseTraceCell("cork_query→ok", null)).toEqual({ tool: "cork_query", input: null, state: "ok", codes: [] });
    expect(parseTraceCell("cork_query!", null)).toEqual({ tool: "cork_query", input: null, invalid: true });
    expect(parseTraceCell("cork_query→?", null)).toEqual({ tool: "cork_query", input: null, state: undefined, codes: [] });
  });
});
