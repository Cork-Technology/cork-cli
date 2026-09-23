// venueInstant — the ONE boundary parser for every venue timestamp (2026-09-23). Two admitted
// shapes, both unambiguous; everything Date.parse would have quietly accepted is refused.
import { describe, expect, it } from "vitest";
import { isoOfSeconds, venueInstant } from "../src/instant.ts";

describe("venueInstant", () => {
  it("integer unix seconds — the shape every RFQ field serves live (number or digit string) — canonicalise to the same ISO", () => {
    expect(venueInstant(1790150310)).toEqual({ iso: "2026-09-23T07:58:30Z", seconds: "1790150310", shape: "seconds" });
    expect(venueInstant("1790150310")).toEqual({ iso: "2026-09-23T07:58:30Z", seconds: "1790150310", shape: "seconds" });
    expect(venueInstant(0)).toEqual({ iso: "1970-01-01T00:00:00Z", seconds: "0", shape: "seconds" });
  });
  it("strict ISO-8601 with an explicit zone — the shape /pools/v1 serves — canonicalises to UTC second precision", () => {
    expect(venueInstant("2026-08-10T12:30:00.000Z")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000", shape: "iso" });
    expect(venueInstant("2026-08-10T14:30:00+02:00")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000", shape: "iso" });
    expect(venueInstant("2026-08-10T07:30:00-05:00")!.seconds).toBe("1786365000");
    expect(venueInstant("2026-08-10T12:30:00.999999999Z")!.seconds).toBe("1786365000"); // fraction dropped
  });
  it("the two shapes agree: seconds in and ISO in for one instant yield byte-identical output", () => {
    const a = venueInstant(1786365000)!;
    const b = venueInstant("2026-08-10T12:30:00Z")!;
    expect(a.iso).toBe(b.iso);
    expect(a.seconds).toBe(b.seconds);
    expect(isoOfSeconds(1786365000n)).toBe(a.iso);
  });
  it("refuses every ambiguous or lenient shape", () => {
    const refused: unknown[] = [
      "2026-08-10T12:30:00", // no zone → Date.parse reads LOCAL time
      "2026-08-10", // date only
      "2026-08-10 12:30:00Z", // space separator
      "2026-08-10T12:30Z", // no seconds
      "1790150310000", // 13 digits: milliseconds masquerading as seconds
      1790150310000,
      "4102444801", // past the year-2100 bound the input schemas enforce
      1790150310.5, // fractional seconds as a number
      -1,
      "Aug 10 2026 12:30:00 GMT",
      "next tuesday",
      "2026-02-30T00:00:00Z", // invalid calendar — refused, never rolled into March
      "2026-13-01T00:00:00Z",
      "2026-08-10T24:00:00Z",
      "2026-08-10T12:60:00Z",
      "2101-01-01T00:00:00Z", // ISO past the bound
      "", null, undefined, {}, [],
    ];
    for (const v of refused) expect(venueInstant(v), JSON.stringify(v)).toBeUndefined();
  });
});
