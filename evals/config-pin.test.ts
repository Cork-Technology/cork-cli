// The Layer-B harness must pin config resolution to the tree under test — the stub answers
// MARKET_REGISTRY() from the local cork-defaults.json while an unpinned tool resolves config
// remote-first, and that skew re-creates the adapter_binding_mismatch eval rot of the 0.3.3
// redeploy (see the comment in run.ts). This test lives in its OWN file deliberately: it must
// observe run.ts's import-time side effect, so no static import of run.ts may precede the
// dynamic one below (vitest gives each test file a fresh module registry; log-row.test.ts
// imports run.ts statically and would poison a shared registry).
import { describe, expect, it } from "vitest";

describe("layer-B config pin", () => {
  it("importing the runner pins CORK_CONFIG_NO_FETCH — stub and tool must read the SAME defaults bytes", async () => {
    // vitest.config.ts sets the var globally for unit tests, which would make an assertion on
    // a static import vacuous — delete it first so only run.ts's own pin can restore it.
    const prev = process.env.CORK_CONFIG_NO_FETCH;
    delete process.env.CORK_CONFIG_NO_FETCH;
    try {
      await import("./run.ts");
      expect(process.env.CORK_CONFIG_NO_FETCH).toBe("1");
    } finally {
      process.env.CORK_CONFIG_NO_FETCH = prev ?? "1";
    }
  });
});
