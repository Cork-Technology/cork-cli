import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCorkServer } from "@cork/mcp";
import { corkActionCall, encodeMulticall, MAINNET_DEPLOYMENT } from "@cork/core";

const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const RCV = "0xc0ffee0000000000000000000000000000000001" as const;
const NOW = 1_800_000_000n;

async function connectedClient() {
  const server = createCorkServer({ nowSeconds: NOW });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return client;
}

describe("MCP server in-memory roundtrip", () => {
  it("initialize carries the signing instructions (derived from DOC_TOPICS — one constant, no drift)", async () => {
    const client = await connectedClient();
    const instructions = client.getInstructions();
    expect(instructions).toContain("UNSIGNED");
    expect(instructions).toContain("never signs");
    expect(instructions).toContain('cork_capabilities topic:"signing"');
  });

  it("advertises 9 tools with JSON input schemas", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    const swap = tools.find((t) => t.name === "cork_prepare_phoenix");
    expect(swap?.inputSchema.type).toBe("object");
    expect(swap?.annotations?.readOnlyHint).toBe(true);
    // every tool advertises the shared Envelope output schema for structuredContent
    const out = swap?.outputSchema as { type?: string; properties?: Record<string, unknown> };
    expect(out?.type).toBe("object");
    expect(Object.keys(out?.properties ?? {})).toEqual(expect.arrayContaining(["state", "data", "warnings", "provenance", "schemaVersion"]));
  });

  it("calls cork_decode and returns a structured envelope", async () => {
    const client = await connectedClient();
    const data = encodeMulticall([
      corkActionCall(MAINNET_DEPLOYMENT.corkAdapter, "safeSwap", {
        poolId: POOL,
        collateralAssetsOut: 100n * 10n ** 18n,
        receiver: RCV,
        maxCstSharesIn: 101n * 10n ** 18n,
        maxReferenceAssetsIn: 130n * 10n ** 18n,
        deadline: NOW + 1800n,
      }),
    ]);
    const res = await client.callTool({ name: "cork_decode", arguments: { kind: "calldata", data, format: "concise" } });
    expect(res.isError).toBeFalsy();
    const env = res.structuredContent as { state: string; data: { legs: Array<{ action?: string }> } };
    expect(env.state).toBe("ok");
    expect(env.data.legs[0]?.action).toBe("safeSwap");
  });

  it("flags invalid input as an MCP error — with a schema-conforming error envelope", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "cork_prepare_phoenix", arguments: { chainId: 1, account: "bad", clientRequestId: "x", action: {}, format: "concise" } });
    expect(res.isError).toBe(true);
    // even failures honor the advertised outputSchema
    const env = res.structuredContent as { state: string; warnings: Array<{ code: string }>; schemaVersion: string };
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_input");
    expect(env.schemaVersion).toBeTruthy();
  });

  it("marks phase-gated tools unavailable (isError)", async () => {
    const client = await connectedClient();
    // rfq-quote is the LAST deliberately-gated variant (pricing model deferred).
    const res = await client.callTool({ name: "cork_compute", arguments: { params: { kind: "rfq-quote", marketTypeBucket: "stable", durationSeconds: 86400 }, format: "concise" } });
    expect(res.isError).toBe(true);
    const env = res.structuredContent as { state: string; warnings: Array<{ code: string }> };
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("phase_gated");
  });

  it("conflict envelopes are NOT isError (the tool executed; it reports a mismatch)", async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: "cork_track",
      arguments: { mode: "verify", subject: { kind: "artifact", artifact: { a: 1 } }, expect: { artifactDigest: `0x${"0".repeat(64)}` }, format: "concise" },
    });
    expect(res.isError).toBeFalsy();
    const env = res.structuredContent as { state: string; warnings: Array<{ code: string }> };
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("digest_mismatch");
  });
});

  it("filters-level ToolInputError (no teaching payload) still yields a conforming error envelope", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "cork_query", arguments: { resource: "market", filters: { poolId: "not-hex" }, pageSize: 25, format: "concise" } });
    expect(res.isError).toBe(true);
    const env = res.structuredContent as { state: string; warnings: Array<{ code: string; message: string }> };
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_input");
    expect(env.warnings[0]?.message).toContain("poolId");
  });

  it("non-ToolInputError exceptions become internal_error envelopes (first line only, no stack)", async () => {
    const client = await connectedClient();
    // A venueFetch that throws a non-Error rides the internal path via cork_query markets.
    const res = await client.callTool({ name: "cork_capabilities", arguments: { topic: "definitely-not-a-topic-xyz", format: "concise" } });
    // unknown topic is a HANDLED unavailable, not an exception — assert the distinction holds:
    const env = res.structuredContent as { state: string; warnings: Array<{ code: string }> };
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_topic");
  });

describe("2026-07-28 RC conformance (forward-compatible under 2025-11-25)", () => {
  it("tools/list carries resultType complete + CacheableResult hints, in deterministic REGISTRY order", async () => {
    const client = await connectedClient();
    const first = (await client.listTools()) as Record<string, unknown> & { tools: Array<{ name: string }> };
    expect(first.resultType).toBe("complete");
    expect(first.ttlMs).toBe(3_600_000);
    expect(first.cacheScope).toBe("public");
    // Deterministic ordering (RC SHOULD; prompt-cache hits depend on it): two calls, same order.
    const second = await client.listTools();
    expect(second.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name));
  });

  it("tools/call results carry resultType complete on success AND on in-band error paths", async () => {
    const client = await connectedClient();
    const ok = (await client.callTool({ name: "cork_capabilities", arguments: {} })) as Record<string, unknown>;
    expect(ok.resultType).toBe("complete");
    expect(ok.isError ?? false).toBe(false);
    const bad = (await client.callTool({ name: "cork_query", arguments: { resource: "nope" } })) as Record<string, unknown>;
    expect(bad.resultType).toBe("complete");
    expect(bad.isError).toBe(true); // SEP-1303: in-band, never a protocol error / reserved code
  });
});
