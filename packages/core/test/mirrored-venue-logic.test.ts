// The route-logic mirror register [C12]: the openapi capture tripwires SCHEMA drift, but venue
// releases can move route BEHAVIOR without touching a schema — cork-api 0.4.1's quote_ref party
// rule did, and the requester-only mirror out-rejected the venue in production until a human
// noticed. MIRRORED_VENUE_LOGIC names every such mirror so the spec tripwire's teaching can
// enumerate the re-verification list. This test keeps the register honest offline: every named
// mirror file exists and still contains the named symbol (a rename rots loudly, not silently),
// and the gates this build is KNOWN to mirror are all present.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIRRORED_VENUE_LOGIC } from "../src/datasources/venue.ts";

describe("MIRRORED_VENUE_LOGIC register", () => {
  it("every entry's mirror file exists and contains the named symbol", () => {
    for (const m of MIRRORED_VENUE_LOGIC) {
      const [file, symbol] = m.mirror.split("#") as [string, string];
      const src = readFileSync(file, "utf8"); // throws loudly on a moved file
      expect(src.includes(symbol), `${m.mirror}: symbol '${symbol}' not found — the mirror moved; re-aim the register entry`).toBe(true);
    }
  });

  it("the gates this build mirrors are all registered (removing one must be deliberate)", () => {
    const gates = MIRRORED_VENUE_LOGIC.map((m) => m.gate).join("\n");
    for (const must of ["quote_ref citation", "premium acceptance band", "premiumAnnualized caps", "listing traits", "rollover admission battery", "rfq-counter", "allowedSender decode", "exclude_request_prefix"]) {
      expect(gates, `register lost the '${must}' gate`).toContain(must);
    }
  });
});
