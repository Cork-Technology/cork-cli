// Read-only deployment-behavior gate; separate release/environment approval is still required.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import venueDefaults from "../packages/core/src/datasources/venue-defaults.mjs";
import { apiComponent, requiredApiRevision, supportedApiRevisions } from "../packages/core/src/datasources/native-api-contract.mjs";
const DEFAULT_ENDPOINTS = [venueDefaults.venueUrl];

// Actual merged API110 contract pin; separately supplied deployment identity remains required.
// A merge or successful workflow is not evidence of default endpoint readiness.
export const REQUIRED_API_REVISION = requiredApiRevision;
export const REQUIRED_INFRA_REVISION = "499f6411a10b9733dcac4c6a465f888663c302e8";
const INDEX_SHA256 = "879ea3d9d5d42989c1e43ea50c379ed7c4a623d22074af6d79dff30467b18110";
const CONFIDENCE_VALUES = ["unknown", "provisional", "confirmed"];
const hash32 = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const address = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const hashOf = (row) => row.orderHash?.toLowerCase();
const requiredRow = (rows, hash) => {
  const row = rows.find((item) => hashOf(item) === hash.toLowerCase());
  assert.ok(row, "required deployment probe row is not observable within the bounded page; no compatibility claim");
  assert.ok(CONFIDENCE_VALUES.includes(row.confidence), "unsupported native checkpoint confidence; never finality or execution permission");
  for (const field of ["makingAmount", "takingAmount", "filledMakingAmount", "filledTakingAmount", "remainingMakingAmount", "remainingTakingAmount"]) assert.match(row[field], /^\d+$/, field + " must remain a native-unit decimal string");
  return row;
};

export async function verifyCompatibleApi(evidence, { endpoints = DEFAULT_ENDPOINTS, fetchImpl = fetch } = {}) {
  assert.ok(evidence && typeof evidence === "object", "CORK_NATIVE_API_RELEASE_EVIDENCE is required; a merged API PR is not deployment evidence");
  assert.ok(supportedApiRevisions.includes(evidence.apiRevision), "deployment identity must match an exact reviewed native API source revision");
  assert.equal(evidence.infraRevision, REQUIRED_INFRA_REVISION);
  assert.equal(evidence.indexMigrationSha256, INDEX_SHA256);
  assert.ok(Number.isFinite(Date.parse(evidence.deployedAt)), "actual deployment timestamp required");
  assert.ok(Array.isArray(evidence.endpoints));
  assert.equal(evidence.endpoints.length, endpoints.length, "evidence must cover exactly every shipped default endpoint");
  const results = [];
  for (const endpoint of endpoints) {
    const base = new URL(endpoint).href.replace(/\/$/, "");
    const probes = evidence.endpoints.filter((entry) => new URL(entry.url).href.replace(/\/$/, "") === base);
    assert.equal(probes.length, 1, "missing or duplicate evidence for shipped default " + base);
    const p = probes[0];
    assert.ok(Number.isSafeInteger(p.chainId) && p.chainId > 0 && address(p.maker));
    for (const field of ["activeOrderHash", "inactiveOrderHash", "blockedSiblingOrderHash"]) assert.ok(hash32(p[field]), "real probe hash required: " + field);
    assert.equal(new Set([p.activeOrderHash, p.inactiveOrderHash, p.blockedSiblingOrderHash].map((h) => h.toLowerCase())).size, 3);
    let requests = 0;
    const metadataResponse = await fetchImpl(new URL(base + "/meta/v1"), { signal: AbortSignal.timeout(10_000), redirect: "error" });
    requests++;
    assert.equal(metadataResponse.status, 200, "native API metadata is unavailable");
    assert.equal(metadataResponse.redirected, false, "metadata must answer directly");
    assert.equal(metadataResponse.headers.get("deprecation"), null, "metadata shims cannot admit the endpoint");
    const metadata = await metadataResponse.json();
    assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata), "metadata must be an object");
    assert.equal(metadata.component, apiComponent);
    assert.equal(typeof metadata.version, "string");
    assert.equal(metadata.status, "active");
    assert.equal(metadata.commit, evidence.apiRevision, "served metadata must match the declared reviewed deployment identity");
    const get = async (params) => {
      const url = new URL(base + "/limit-orders/v1/orderbook");
      const query = new URLSearchParams({ chainId: String(p.chainId), limit: "2000" });
      for (const [key, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
      url.search = query.toString();
      requests++;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      assert.equal(response.status, 200, "dependency failure is not absence: " + url.href);
      assert.equal(response.headers.get("deprecation"), null, "compatibility shims cannot satisfy the gate");
      const body = await response.json();
      assert.ok(Array.isArray(body.items));
      assert.equal(body.hasMore, false, "probe dataset must be exhaustive within one 2000-row page; no scan-based absence claim");
      return body.items;
    };
    const active = requiredRow(await get({ orderHash: p.activeOrderHash }), p.activeOrderHash);
    assert.equal(active.availability?.state, "candidate");
    assert.ok(address(active.makerAsset) && address(active.takerAsset));
    assert.equal(active.maker.toLowerCase(), p.maker.toLowerCase());
    const pair = { makerAsset: active.makerAsset, takerAsset: active.takerAsset };
    const inactive = requiredRow(await get({ orderHash: p.inactiveOrderHash }), p.inactiveOrderHash);
    assert.ok(["CANCELLED", "FILLED", "EXPIRED"].includes(inactive.status));
    assert.equal(inactive.availability?.state, "unavailable");
    const blocked = requiredRow(await get({ orderHash: p.blockedSiblingOrderHash }), p.blockedSiblingOrderHash);
    assert.ok(["OPEN", "PARTIALLY_FILLED"].includes(blocked.status));
    assert.deepEqual(blocked.availability, { state: "unavailable", reason: "bit-consumed" });
    const candidates = await get({ ...pair, view: "discovery" });
    requiredRow(candidates, p.activeOrderHash);
    assert.ok(candidates.every((row) => row.availability?.state === "candidate"));
    assert.ok(!candidates.some((row) => [p.inactiveOrderHash.toLowerCase(), p.blockedSiblingOrderHash.toLowerCase()].includes(hashOf(row))));
    const management = await get({ maker: p.maker, view: "management", status: ["OPEN", "PARTIALLY_FILLED", "CANCELLED", "FILLED", "EXPIRED"] });
    requiredRow(management, p.inactiveOrderHash);
    requiredRow(management, p.blockedSiblingOrderHash);
    const explicitActive = await get({ ...pair, view: "management", status: "OPEN" });
    requiredRow(explicitActive, p.blockedSiblingOrderHash);
    results.push({ endpoint: base, chainId: p.chainId, requests, apiRevision: evidence.apiRevision, infraRevision: evidence.infraRevision, behavior: "explicit strict discovery; explicit management/status lifecycle; inactive exact history; exact consumed nonce; supported checkpoint confidence (not finality or permission); native totals" });
  }
  return { status: "PASS", endpoints: results, limits: "Read-only HTTP behavior plus operator-supplied deployment identity. Does not attest live DB grants, migration interruption/rollback, module/account permissions or owner/release authorization." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyCompatibleApi(JSON.parse(process.env.CORK_NATIVE_API_RELEASE_EVIDENCE ?? "null"));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Compatible default API gate BLOCKED:", error.message);
    process.exitCode = 1;
  }
}
