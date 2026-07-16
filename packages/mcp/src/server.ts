// MCP server projection of the tool registry. Uses the low-level Server + request handlers so
// each tool advertises its JSON Schema (from zod v4 `z.toJSONSchema`) directly on the wire,
// avoiding the SDK's bundled-zod (v3) coupling in the high-level registerTool helper.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { REGISTRY, SCHEMA_VERSION, inputJsonSchema } from "@cork/schemas";
import { runTool, ToolInputError, type HandlerContext } from "@cork/core";

export function createCorkServer(ctx: HandlerContext = {}): Server {
  const server = new Server(
    { name: "cork-mcp", version: SCHEMA_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: REGISTRY.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputJsonSchema(t.name) as { type: "object" },
      annotations: {
        title: t.name,
        readOnlyHint: t.annotations.readOnlyHint,
        ...(t.annotations.idempotentHint !== undefined ? { idempotentHint: t.annotations.idempotentHint } : {}),
        ...(t.annotations.destructiveHint !== undefined ? { destructiveHint: t.annotations.destructiveHint } : {}),
        ...(t.annotations.openWorldHint !== undefined ? { openWorldHint: t.annotations.openWorldHint } : {}),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const envelope = await runTool(name, args ?? {}, ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope as Record<string, unknown>,
        isError: envelope.state === "unavailable",
      };
    } catch (err) {
      const message =
        err instanceof ToolInputError
          ? `invalid input for ${err.tool}: ${JSON.stringify(err.issues)}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  });

  return server;
}
