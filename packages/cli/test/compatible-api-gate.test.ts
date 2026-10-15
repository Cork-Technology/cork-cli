// Authored HTTP fixtures are not deployment evidence for any default endpoint.
import { AssertionError } from "node:assert";
import { describe, expect, it } from "vitest";
import { REQUIRED_API_REVISION, verifyCompatibleApi } from "../../../scripts/verify-compatible-api.mjs";
import venueDefaults from "../../core/src/datasources/venue-defaults.mjs";
import { apiComponent } from "../../core/src/datasources/native-api-contract.mjs";

const base = venueDefaults.venueUrl.endsWith("/") ? venueDefaults.venueUrl.slice(0, -1) : venueDefaults.venueUrl;
const hash = (digit: string) => "0x" + digit.repeat(64);
const maker = "0x" + "11".repeat(20);
const evidence = () => ({
  apiRevision: REQUIRED_API_REVISION,
  infraRevision: "499f6411a10b9733dcac4c6a465f888663c302e8",
  indexMigrationSha256: "879ea3d9d5d42989c1e43ea50c379ed7c4a623d22074af6d79dff30467b18110",
  deployedAt: "2026-10-07T10:00:00Z", // fixture declaration, not an observed deployment
  endpoints: [{ url: base, chainId: 1, maker, activeOrderHash: hash("1"), inactiveOrderHash: hash("2"), blockedSiblingOrderHash: hash("3") }],
});

function venue(confidence: unknown = "unknown", opts: { status?: number; hasMore?: boolean; ignoreView?: boolean; firstStatusOnly?: boolean; metadata?: unknown } = {}) {
  const common = { chainId: 1, maker, makerAsset: "0x" + "22".repeat(20), takerAsset: "0x" + "33".repeat(20), confidence, makingAmount: "10", takingAmount: "5", filledMakingAmount: "0", filledTakingAmount: "0", remainingMakingAmount: "10", remainingTakingAmount: "5" };
  const active = { ...common, orderHash: hash("1"), status: "OPEN", availability: { state: "candidate", reason: "no-known-blocker" } };
  const inactive = { ...common, orderHash: hash("2"), status: "FILLED", filledMakingAmount: "10", filledTakingAmount: "6", remainingMakingAmount: "0", remainingTakingAmount: "0", availability: { state: "unavailable", reason: "exhausted" } };
  const blocked = { ...common, orderHash: hash("3"), status: "OPEN", availability: { state: "unavailable", reason: "bit-consumed" } };
  const rows = [active, inactive, blocked];
  const requests: URL[] = [];
  const fetchImpl = async (input: URL) => {
    const url = new URL(String(input));
    requests.push(url);
    if (opts.status) return Response.json({ error: "metadata unavailable" }, { status: opts.status });
    if (url.pathname === "/meta/v1") return Response.json(opts.metadata === undefined ? { component: apiComponent, version: "0.4.6", status: "active", commit: REQUIRED_API_REVISION } : opts.metadata);
    const q = url.searchParams;
    const statuses = opts.firstStatusOnly ? q.getAll("status").slice(0, 1) : q.getAll("status");
    const selected = rows.filter(row => Number(q.get("chainId")) === row.chainId
      && (!q.has("orderHash") || row.orderHash === q.get("orderHash"))
      && (!q.has("maker") || row.maker === q.get("maker"))
      && (!q.has("status") || statuses.includes(row.status))
      && (q.has("orderHash") || q.has("status") || row.status === "OPEN")
      && (opts.ignoreView || q.get("view") !== "discovery" || row.status !== "OPEN" || row.availability.state === "candidate"));
    return Response.json({ items: selected, hasMore: opts.hasMore ?? false });
  };
  return { fetchImpl, requests };
}

describe("compatible default API release gate", () => {
  it.each([null, { component: apiComponent, version: "0.4.6", status: "active", commit: null }, { component: apiComponent, version: "0.4.6", status: "active", commit: "0".repeat(40) }])("unadmitted served metadata refuses before order reads", async metadata => {
    const fixture = venue("unknown", { metadata });
    await expect(verifyCompatibleApi(evidence(), fixture)).rejects.toBeInstanceOf(AssertionError);
    expect(fixture.requests).toHaveLength(1);
  });

  it("rejects an endpoint that ignores strict discovery and returns a consumed sibling", async () => {
    await expect(verifyCompatibleApi(evidence(), venue("unknown", { ignoreView: true }))).rejects.toBeInstanceOf(AssertionError);
  });

  it("rejects truncated lifecycle status selection rather than admitting incomplete management history", async () => {
    await expect(verifyCompatibleApi(evidence(), venue("unknown", { firstStatusOnly: true }))).rejects.toBeInstanceOf(AssertionError);
  });

  it.each(["unknown", "provisional", "confirmed"])("%s is compatible without making an unavailable sibling a candidate", async confidence => {
    const fixture = venue(confidence);
    const result = await verifyCompatibleApi(evidence(), fixture);
    expect(result.status).toBe("PASS");
    expect(fixture.requests).toHaveLength(7);
  });

  it.each([
    ["stale API runtime", { apiRevision: "d5e0757d90640023c31008bc73b06e1ab7aa9cef" }],
    ["stale Infra runtime despite identical index bytes", { infraRevision: "2955cdb84b41a16c68ecc4dae3bb8bda8c5ef5c8" }],
    ["different migration artifact", { indexMigrationSha256: "0".repeat(64) }],
  ])("refuses %s before HTTP", async (_name, invalid) => {
    const fixture = venue("confirmed");
    await expect(verifyCompatibleApi({ ...evidence(), ...invalid }, fixture)).rejects.toBeInstanceOf(AssertionError);
    expect(fixture.requests).toEqual([]);
  });

  it("requires exactly the shipped endpoint evidence, not an extra staging identity", async () => {
    const fixture = venue();
    const claim = evidence();
    claim.endpoints.push({ ...claim.endpoints[0]!, url: "https://not-shipped.invalid" });
    await expect(verifyCompatibleApi(claim, fixture)).rejects.toBeInstanceOf(AssertionError);
    expect(fixture.requests).toEqual([]);
  });

  it.each(["finalized", null])("an unsupported confidence %s cannot pass the gate", async confidence => {
    const fixture = venue(confidence);
    await expect(verifyCompatibleApi(evidence(), fixture)).rejects.toBeInstanceOf(AssertionError);
    expect(fixture.requests).toHaveLength(2);
  });

  it.each([{ status: 500 }, { hasMore: true }])("dependency failure or incomplete history is not compatibility", async opts => {
    const fixture = venue("provisional", opts);
    await expect(verifyCompatibleApi(evidence(), fixture)).rejects.toBeInstanceOf(AssertionError);
    expect(fixture.requests).toHaveLength(opts.status ? 1 : 2);
  });
});
