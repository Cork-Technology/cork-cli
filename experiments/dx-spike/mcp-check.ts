// mcp-check.ts — does MCP SDK v1 (1.29.0) registerTool actually accept zod v4 schemas?
// Full roundtrip over in-memory transport: listTools (inspect generated inputSchema),
// callTool valid, callTool invalid.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ratesFloor } from "./registry.ts";

const server = new McpServer({ name: "cork-spike", version: "0.0.0" });

// Attempt 1: pass the zod v4 object's raw shape (v1 SDK's documented ZodRawShape style)
server.registerTool(
  ratesFloor.name,
  {
    description: ratesFloor.description,
    inputSchema: ratesFloor.input.shape,
  },
  async (args: Record<string, unknown>) => {
    const parsed = ratesFloor.input.parse(args);
    const out = ratesFloor.output.parse(await ratesFloor.handler(parsed));
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
  },
);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "spike-client", version: "0.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const tools = await client.listTools();
console.log("=== listTools inputSchema ===");
console.log(JSON.stringify(tools.tools[0]?.inputSchema, null, 1));

console.log("=== callTool VALID ===");
const ok = await client.callTool({
  name: ratesFloor.name,
  arguments: {
    poolId: "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a",
    lastAdjustedRate: "800000000000000000",
    remainingCredits: "7000000000000000",
    rateMin: "500000000000000000",
    perDayMax: "1000000000000000",
    horizonDays: 64,
  },
});
console.log(JSON.stringify(ok, null, 1));

console.log("=== callTool INVALID ===");
try {
  const bad = await client.callTool({
    name: ratesFloor.name,
    arguments: { poolId: "0x12", lastAdjustedRate: "abc" },
  });
  console.log(JSON.stringify(bad, null, 1).slice(0, 800));
} catch (e) {
  console.log("threw:", e instanceof Error ? e.message.slice(0, 300) : e);
}
process.exit(0);
