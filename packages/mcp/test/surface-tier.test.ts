// The tier boundary is MECHANICAL and these tests pin it against the REAL committed surface —
// every case mutates a structuredClone of the actual fixture, so the classifier is exercised on
// the exact material the drift gate feeds it, not on toy JSON. The property that matters most:
// every ambiguous or structural case lands SEMANTIC (an unnecessary eval, never a skipped one).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySurfaceDelta, sentenceCount } from "../src/surface-tier.ts";

type Json = Record<string, unknown>;
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "tool-surface.json"), "utf8")) as Json;

const clone = () => structuredClone(FIXTURE);
const tools = (s: Json) => s.tools as Array<Record<string, unknown>>;

/** First tool whose input schema has a $defs entry with a description — a real nested prose site. */
function firstDefWithDescription(s: Json): Record<string, unknown> {
  for (const t of tools(s)) {
    const defs = ((t.inputSchema as Json)?.$defs ?? {}) as Record<string, Json>;
    for (const d of Object.values(defs)) if (typeof d.description === "string") return d;
  }
  throw new Error("no $defs description found in the fixture — the fixture format regressed");
}

describe("surface tier classifier (mechanical boundary, owner-approved 2026-08-11)", () => {
  it("identical surfaces are tier none", () => {
    expect(classifySurfaceDelta(FIXTURE, clone()).tier).toBe("none");
  });

  it("PROSE: a sentence-preserving typo fix inside a nested schema description", () => {
    const after = clone();
    const d = firstDefWithDescription(after);
    const before = d.description as string;
    d.description = before.replace(/[a-z]/, (m) => m.toUpperCase()); // case tweak, zero sentences moved
    expect(d.description).not.toBe(before); // the mutation must be real or this test is a no-op
    const v = classifySurfaceDelta(FIXTURE, after);
    expect(v.tier).toBe("prose");
    expect(v.changes.every((c) => c.kind === "description-reworded")).toBe(true);
  });

  it("PROSE: rewording the tool-level description and the server instructions together", () => {
    const after = clone();
    after.instructions = (after.instructions as string).replace("Every", "Each");
    const t0 = tools(after)[0]!;
    t0.description = (t0.description as string).replace(/\ba\b/, "one");
    expect(classifySurfaceDelta(FIXTURE, after).tier).toBe("prose");
  });

  it("SEMANTIC: a description gaining a sentence — new content is not a rewording", () => {
    const after = clone();
    const d = firstDefWithDescription(after);
    d.description = `${d.description as string} Trust me.`;
    const v = classifySurfaceDelta(FIXTURE, after);
    expect(v.tier).toBe("semantic");
    expect(v.changes.some((c) => c.kind === "description-resized")).toBe(true);
  });

  it("SEMANTIC: an x-units value changing — units are covered surface, never prose", () => {
    const after = clone();
    const hit = (function find(n: unknown): Record<string, unknown> | null {
      if (n === null || typeof n !== "object") return null;
      if (!Array.isArray(n) && typeof (n as Json)["x-units"] === "string") return n as Json;
      for (const v of Object.values(n as Json)) {
        const r = find(v);
        if (r) return r;
      }
      return null;
    })(after);
    expect(hit, "no x-units in the fixture — the emission regressed").not.toBeNull();
    hit!["x-units"] = "D18{1}" === hit!["x-units"] ? "D18{%}" : "D18{1}"; // the 100x lie
    const v = classifySurfaceDelta(FIXTURE, after);
    expect(v.tier).toBe("semantic");
    expect(v.changes.some((c) => c.kind === "value-changed" && c.path.endsWith("x-units"))).toBe(true);
  });

  it("SEMANTIC: a key appearing anywhere (new field), a key vanishing, an enum resizing", () => {
    const addKey = clone();
    ((tools(addKey)[0]!.inputSchema as Json).properties as Json)["newField"] = { type: "string" };
    expect(classifySurfaceDelta(FIXTURE, addKey).tier).toBe("semantic");

    const dropKey = clone();
    const props = (tools(dropKey)[0]!.inputSchema as Json).properties as Json;
    delete props[Object.keys(props)[0]!];
    expect(classifySurfaceDelta(FIXTURE, dropKey).tier).toBe("semantic");

    const resizeEnum = clone();
    const withEnum = (function find(n: unknown): Json | null {
      if (n === null || typeof n !== "object") return null;
      // Descend through arrays too — enum-bearing nodes live inside anyOf/oneOf branches.
      if (Array.isArray(n)) {
        for (const v of n) {
          const r = find(v);
          if (r) return r;
        }
        return null;
      }
      if (Array.isArray((n as Json).enum)) return n as Json;
      for (const v of Object.values(n as Json)) {
        const r = find(v);
        if (r) return r;
      }
      return null;
    })(resizeEnum);
    expect(withEnum).not.toBeNull();
    (withEnum!.enum as unknown[]).push("bogus-member");
    expect(classifySurfaceDelta(FIXTURE, resizeEnum).tier).toBe("semantic");
  });

  it("mixed prose + structural lands SEMANTIC — one structural change poisons the whole delta", () => {
    const after = clone();
    after.instructions = (after.instructions as string).replace("Every", "Each"); // prose
    ((tools(after)[0]!.inputSchema as Json).properties as Json)["newField"] = { type: "string" }; // structural
    expect(classifySurfaceDelta(FIXTURE, after).tier).toBe("semantic");
  });

  it("descriptionTokensApprox is derived and never reported on its own", () => {
    const after = clone();
    tools(after)[0]!.descriptionTokensApprox = 999999;
    expect(classifySurfaceDelta(FIXTURE, after).tier).toBe("none");
  });

  it("sentenceCount: symmetric approximation — abbreviations cancel, terminal runs count once", () => {
    expect(sentenceCount("One. Two! Three?")).toBe(3);
    expect(sentenceCount("Ends without punctuation")).toBe(0);
    expect(sentenceCount("Really?!")).toBe(1); // a run of terminals is one boundary
    // "e.g. " miscounts as a boundary — SYMMETRICALLY on both sides, so an edit elsewhere in the
    // same string still classifies prose; an edit that adds "e.g." itself falls to semantic,
    // which is the fail-expensive direction, by design.
    expect(sentenceCount("Use sugar, e.g. 1e18, freely.")).toBe(2);
  });
});
