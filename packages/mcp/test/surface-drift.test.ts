// MCP-surface check: protocol-observed description budget; do not snapshot prose or source-generated schemas.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCorkServer } from "@cork/mcp";

describe("tool description context budget", () => {
  it("keeps advertised descriptions and initialize instructions within 3000 approximate tokens", async () => {
    const server = createCorkServer({ nowSeconds: 1_800_000_000n });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "budget-gate", version: "0" });
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const { tools } = await client.listTools();
      const tokens = tools.reduce((sum, tool) => sum + Math.ceil((tool.description ?? "").length / 4), 0) + Math.ceil((client.getInstructions() ?? "").length / 4);
      expect(tokens).toBeLessThan(3000);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
