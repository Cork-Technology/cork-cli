import { describe, expect, it } from "vitest";
import { runCli } from "@cork/cli";
import { withSurface } from "./native-api-compat-helpers.ts";
import { CHAIN, rolloverContext, rolloverRow } from "../../core/test/rollover-status-fixtures.ts";

for (const surface of ["CLI", "MCP"] as const) describe(surface + " optional rollover effectiveStatus", () => {
  it.each(["old-missing", "additive"])("%s preserves raw lifecycle, event history and default query membership", async (producer) => {
    const row = rolloverRow();
    if (producer === "additive") row.effectiveStatus = "EXPIRED";
    const fixture = rolloverContext(row);
    await withSurface(surface, fixture.context, async (call) => {
      const tracked = await call("cork_track", { mode: "reconcile", chainId: CHAIN, subject: { kind: "orderHash", orderHash: row.orderDigest } });
      expect(tracked.failed).toBe(false);
      expect(tracked.envelope.state).toBe("ok");
      expect(tracked.envelope.data).toMatchObject({ lifecycle: "PENDING", order: row, chainVerification: { chainStatus: "None", venueStatus: "PENDING", consistent: true, events: [] } });
      expect(tracked.envelope.data).not.toHaveProperty("effectiveStatus"); // No duplicate summary alias.
      if (producer === "additive") expect(tracked.envelope.data).toHaveProperty("order.effectiveStatus", "EXPIRED");
      else expect(tracked.envelope.data).not.toHaveProperty("order.effectiveStatus");
      const queried = await call("cork_query", { resource: "rollover-orders", chainId: CHAIN });
      expect(queried.failed).toBe(false);
      expect(queried.envelope.data).toMatchObject({ items: [{ orderDigest: row.orderDigest, status: "PENDING", expiredAt: null, verification: "confirmed", fillable: false }], verification: { confirmed: 1, dropped: 0 } });
      if (producer === "additive") expect(queried.envelope.data).toHaveProperty("items.0.effectiveStatus", "EXPIRED");
      else expect(queried.envelope.data).not.toHaveProperty("items.0.effectiveStatus");
    });
    expect(fixture.requests.find((url) => url.pathname === "/rollover/v1/orders")!.searchParams.has("status")).toBe(false);
  });

  it("effectiveStatus cannot hide a raw lifecycle contradiction", async () => {
    const row = { ...rolloverRow(), status: "EXPIRED", effectiveStatus: "EXPIRED" };
    await withSurface(surface, rolloverContext(row).context, async (call) => {
      const tracked = await call("cork_track", { mode: "reconcile", chainId: CHAIN, subject: { kind: "orderHash", orderHash: row.orderDigest } });
      expect(tracked.envelope.state).toBe("conflict");
      expect(tracked.envelope.provenance.source).toBe("chain");
      expect(tracked.envelope.data).toMatchObject({ venueStatus: "EXPIRED", chainStatus: "None", order: { expiredAt: null }, chainVerification: { consistent: false } });
      expect(tracked.failed).toBe(surface === "CLI"); // MCP conflict is not isError; CLI retains exit 4.
      const queried = await call("cork_query", { resource: "rollover-orders", chainId: CHAIN });
      expect(queried.envelope.data).toMatchObject({ items: [], verification: { confirmed: 0, dropped: 1 } });
    });
  });

  it("unknown raw status stays unverified/conflicting even with known effectiveStatus", async () => {
    const row = { ...rolloverRow(), status: "FUTURE_STATUS", effectiveStatus: "EXPIRED" };
    await withSurface(surface, rolloverContext(row).context, async (call) => {
      const queried = await call("cork_query", { resource: "rollover-orders", chainId: CHAIN });
      expect(queried.envelope.data).toMatchObject({ items: [{ status: "FUTURE_STATUS", effectiveStatus: "EXPIRED", verification: "unverified" }], verification: { confirmed: 0, unverified: 1, dropped: 0 } });
      const tracked = await call("cork_track", { mode: "reconcile", chainId: CHAIN, subject: { kind: "orderHash", orderHash: row.orderDigest } });
      expect(tracked.envelope.state).toBe("conflict");
    });
  });
});

it.each(["old-missing", "additive"])("human CLI %s shows raw lifecycle separately from the optional annotation", async (producer) => {
  const row = rolloverRow();
  if (producer === "additive") row.effectiveStatus = "EXPIRED";
  const context = rolloverContext(row).context;
  const result = await runCli(["track", "--input", JSON.stringify({ mode: "reconcile", chainId: CHAIN, subject: { kind: "orderHash", orderHash: row.orderDigest } })], context);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/lifecycle\s+PENDING/);
  expect(result.stdout).toMatch(/chainStatus\s+None/);
  if (producer === "additive") expect(result.stdout).toMatch(/effectiveStatus\s+EXPIRED/);
  else expect(result.stdout).not.toContain("effectiveStatus");
});
