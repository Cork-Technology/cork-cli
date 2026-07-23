import { describe, expect, it } from "vitest";
import { searchTools } from "@cork/schemas";

// searchTools is the engine behind `cork_capabilities` search — the contract is that a
// natural-language phrase routes to the right tool AND its best-matching variant, even when no
// tool description contains the query words. These pin that contract directly (it was previously
// exercised only indirectly through the capabilities handler).
describe("searchTools — natural-language tool routing", () => {
  it("routes a phrase with no matching tool word to the right variant (the motivating case)", () => {
    // No tool DESCRIPTION contains "executed/trades/history"; only cork_query's `fills` hint does.
    const r = searchTools("executed trades history");
    expect(r[0]?.name).toBe("cork_query");
    expect(r[0]?.variant).toBe("fills");
  });

  it("ranks the capability-specific tool first and returns results sorted by descending score", () => {
    const r = searchTools("swap rate cost quote");
    expect(r[0]).toMatchObject({ name: "cork_compute", variant: "cst-swap-rate" });
    const scores = r.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("weights variant evidence above description-only matches (which carry no variant)", () => {
    const r = searchTools("decode calldata bytes");
    expect(r[0]?.name).toBe("cork_decode");
    expect(r[0]?.variant).toBe("calldata");
    // Any lower-ranked, description-only match carries no `variant` and scores below the variant hit.
    for (const lower of r.slice(1).filter((x) => x.variant === undefined)) {
      expect(lower.score).toBeLessThan(r[0]!.score);
    }
  });

  it("returns nothing for a query with no signal, or one made only of stopwords/short tokens", () => {
    expect(searchTools("xyzzy nomatch")).toEqual([]);
    expect(searchTools("the of a to")).toEqual([]);
  });

  it("respects the result limit", () => {
    expect(searchTools("swap rate cost quote order market fill", 2).length).toBeLessThanOrEqual(2);
  });
});
