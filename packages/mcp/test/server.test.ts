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
  it("advertises 9 tools with JSON input schemas", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(9);
    const swap = tools.find((t) => t.name === "cork_prepare_phoenix");
    expect(swap?.inputSchema.type).toBe("object");
    expect(swap?.annotations?.readOnlyHint).toBe(true);
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

  it("flags invalid input as an MCP error", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "cork_prepare_phoenix", arguments: { chainId: 1, account: "bad", clientRequestId: "x", action: {}, format: "concise" } });
    expect(res.isError).toBe(true);
  });

  it("marks phase-gated tools unavailable (isError)", async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: "cork_query", arguments: { resource: "markets", pageSize: 25, format: "concise" } });
    expect(res.isError).toBe(true);
    const env = res.structuredContent as { state: string };
    expect(env.state).toBe("unavailable");
  });
});
