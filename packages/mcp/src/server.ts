// MCP server projection of the tool registry. Uses the low-level Server + request handlers —
// a deliberate choice for single-dispatch parity with the CLI: one `runTool` validates and routes
// every call, and the registry drives the wire schemas/annotations directly. (SDK ≥1.29's
// registerTool does accept zod v4, so this is about keeping one dispatch path, not zod coupling.)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Envelope, REGISTRY, SCHEMA_VERSION, inputJsonSchema } from "@cork/schemas";
import { runTool, ToolInputError, type HandlerContext } from "@cork/core";

// All tools return the same envelope; advertise it once so clients can rely on structuredContent.
// io:"input": the hex primitives are transforms (string -> `0x${string}`) whose output side zod
// cannot render; their input side has the identical wire shape (regex-checked string).
const ENVELOPE_SCHEMA = z.toJSONSchema(Envelope, { io: "input" }) as { type: "object" };

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
      outputSchema: ENVELOPE_SCHEMA,
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
      const invalid = err instanceof ToolInputError;
      const message = invalid
        ? `invalid input for ${(err as ToolInputError).tool}: ${JSON.stringify((err as ToolInputError).issues)}`
        : err instanceof Error
          ? err.message.split("\n")[0]!
          : String(err);
      // Even the failure path honors the advertised outputSchema: emit a minimal error envelope
      // as structuredContent so strict clients never see a schema-less error result.
      const errorEnvelope = {
        state: "unavailable" as const,
        data: null,
        warnings: [{ code: invalid ? "invalid_input" : "internal_error", message }],
        provenance: { source: "config" as const, chainId: 1 as const, fetchedAt: new Date().toISOString() },
        schemaVersion: SCHEMA_VERSION,
      };
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: errorEnvelope as Record<string, unknown>,
        isError: true,
      };
    }
  });

  return server;
}
