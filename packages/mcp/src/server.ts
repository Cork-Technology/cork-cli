// MCP server projection of the tool registry. Uses the low-level Server + request handlers —
// a deliberate choice for single-dispatch parity with the CLI: one `runTool` validates and routes
// every call, and the registry drives the wire schemas/annotations directly. (SDK ≥1.29's
// registerTool does accept zod v4, so this is about keeping one dispatch path, not zod coupling.)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ChainId, descriptionExample, Envelope, REGISTRY, SCHEMA_VERSION, inputJsonSchema } from "@cork/schemas";
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
    // 2026-07-28 RC conformance (forward-compatible extras under 2025-11-25, where unknown
    // result fields are legal): every result carries resultType (SEP-2322; "complete" = an
    // ordinary result — this server never does MRTR input_required round-trips), and list
    // results carry CacheableResult freshness hints (SEP-2549). The tool surface is compiled
    // into the process (REGISTRY + static examples), identical for every caller, and changes
    // only on redeploy — so a 1 h public TTL is honest and prompt-cache friendly. The registry
    // array also fixes tools/list ordering, which the RC asks to be deterministic.
    resultType: "complete",
    ttlMs: 3_600_000,
    cacheScope: "public",
    tools: REGISTRY.map((t) => ({
      name: t.name,
      // Display-only label (models see name/description/schema; title is client-UI plumbing).
      title: t.title,
      // One worked example inline (shipped input examples measurably raise parameter accuracy);
      // the full example set + filled templates live behind cork_capabilities [C13].
      description: t.description + descriptionExample(t.name),
      inputSchema: inputJsonSchema(t.name) as { type: "object" },
      outputSchema: ENVELOPE_SCHEMA,
      annotations: {
        title: t.title,
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
        resultType: "complete" as const,
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope as Record<string, unknown>,
        isError: envelope.state === "unavailable",
      };
    } catch (err) {
      const invalid = err instanceof ToolInputError;
      const teaching = invalid ? (err as ToolInputError).teaching : undefined;
      const message = teaching
        ? `${teaching.summary}. ${teaching.remediation}${teaching.example ? ` Example — ${teaching.example.title}: ${JSON.stringify(teaching.example.input)}` : ""}`
        : invalid
          ? `invalid input for ${(err as ToolInputError).tool}: ${JSON.stringify((err as ToolInputError).issues)}`
          : err instanceof Error
            ? err.message.split("\n")[0]!
            : String(err);
      // Even the failure path honors the advertised outputSchema: a minimal error envelope as
      // structuredContent, with the teaching payload (issues/remediation/corrected example) as its
      // data so the agent's next call can succeed without a doc lookup [v2 §5.4].
      // provenance.chainId echoes the REQUESTED chain when one was passed — a hardcoded 1 misled
      // clients that branch on it (F20).
      const requestedChain = (args as { chainId?: unknown } | undefined)?.chainId;
      const chainId = ChainId.safeParse(requestedChain).data ?? 1;
      const errorEnvelope = {
        state: "unavailable" as const,
        data: teaching ?? null,
        warnings: [{ code: invalid ? "invalid_input" : "internal_error", message }],
        provenance: { source: "config" as const, chainId, fetchedAt: new Date().toISOString() },
        schemaVersion: SCHEMA_VERSION,
      };
      // Still resultType "complete": SEP-1303 keeps validation failures IN-BAND (isError results
      // an agent can self-correct from), and the reserved protocol-error band (-32020..-32099,
      // RC error-code policy) stays untouched — this server never mints custom JSON-RPC codes.
      return {
        resultType: "complete" as const,
        content: [{ type: "text" as const, text: message }],
        structuredContent: errorEnvelope as Record<string, unknown>,
        isError: true,
      };
    }
  });

  return server;
}
