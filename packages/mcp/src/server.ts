// MCP server projection of the tool registry. Uses the low-level Server + request handlers —
// a deliberate choice for single-dispatch parity with the CLI: one `runTool` validates and routes
// every call, and the registry drives the wire schemas/annotations directly. (SDK ≥1.29's
// registerTool does accept zod v4, so this is about keeping one dispatch path, not zod coupling.)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ChainId, descriptionExample, DOC_TOPICS, Envelope, REGISTRY, SCHEMA_VERSION, inputJsonSchema } from "@cork/schemas";
import { BUILD_VERSION, type CorkClientIdentity, runTool, ToolInputError, type HandlerContext, withMcpClient } from "@cork/core";

// All tools return the same envelope; advertise it once so clients can rely on structuredContent.
// io:"input": the hex primitives are transforms (string -> `0x${string}`) whose output side zod
// cannot render; their input side has the identical wire shape (regex-checked string).
const ENVELOPE_SCHEMA = z.toJSONSchema(Envelope, { io: "input" }) as { type: "object" };

/** What a tools/call looked like, for an observer — metadata only. The result is deliberately NOT
 *  here (an observer cannot leak what it is never handed); the arguments go to `onToolCall` as a
 *  separate value, for the hosted analytics to shape-filter (lib/mcp-analytics.ts). */
export interface ToolCallObservation {
  /** A registry tool name, or "unknown_tool" (a caller-chosen string is never passed on). */
  tool: string;
  durationMs: number;
  /** The envelope state; a thrown/invalid call is "unavailable". */
  state: "ok" | "unavailable" | "conflict";
  /** The MCP `isError` flag this call returned. */
  isError: boolean;
  /** The first warning code (a closed snake_case enum), "invalid_input" or "internal_error". */
  errorType?: string;
  /** provenance.chainId of an envelope the tool produced (a public protocol identifier). */
  chainId?: number;
  /** The thrown error of an internal_error call, for exception capture by the observer. */
  error?: unknown;
}

export interface CorkServerHooks {
  /** The MCP client's name when the TRANSPORT knows it but this instance never saw the
   *  initialize handshake (the stateless HTTP projection builds a server per request). */
  clientName?: () => string | undefined;
  /** Called once per tools/call, after the result is built, with the call's raw arguments. Must
   *  not throw (it is guarded). Only the hosted HTTP projection sets it. */
  onToolCall?: (call: ToolCallObservation, args: unknown) => void;
}

/** The identity of a server whose embedder did not set ctx.corkClient: the local stdio MCP
 *  (`ch mcp`, `cork-mcp`) — a process the user runs, driven by an agent. */
const STDIO_MCP_CLIENT: CorkClientIdentity = Object.freeze({ client: "cork-cli-mcp", comment: { surface: "mcp" as const } });

const KNOWN_TOOLS: ReadonlySet<string> = new Set(REGISTRY.map((t) => t.name));
const WARNING_CODE = /^[a-z0-9_]{1,64}$/u;

export function createCorkServer(ctx: HandlerContext = {}, hooks: CorkServerHooks = {}): Server {
  // serverInfo.version is the BUILD version (release tag, "dev" in source runs); the envelope
  // schema version stays SCHEMA_VERSION on every result — two different contracts.
  const server = new Server(
    { name: "cork-mcp", version: BUILD_VERSION },
    {
      capabilities: { tools: {} },
      // The signing topic's summary IS the server instructions — one constant, three surfaces
      // (initialize instructions, cork_capabilities topic:"signing", HTTP /docs/signing), so
      // drift between them is impossible by construction. Clients of a REMOTE deployment learn
      // in-band that every prepared artifact is unsigned and completed client-side.
      instructions: DOC_TOPICS.signing!.summary,
    },
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
      // the full example set + filled templates live behind cork_capabilities.
      description: t.description + descriptionExample(t.name),
      inputSchema: inputJsonSchema(t.name),
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

  // Each call names the MCP client that drove it in the attribution headers it sends to Cork
  // servers (cork-client.ts): from this instance's own handshake, else from the transport.
  const callCtx = (): HandlerContext => ({ ...ctx, corkClient: withMcpClient(ctx.corkClient ?? STDIO_MCP_CLIENT, server.getClientVersion()?.name ?? hooks.clientName?.()) });
  const observe = (call: ToolCallObservation, args: unknown): void => {
    try {
      hooks.onToolCall?.(call, args);
    } catch {
      /* an observer failure must never change a tool result */
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const started = performance.now();
    const tool = KNOWN_TOOLS.has(name) ? name : "unknown_tool";
    try {
      const envelope = await runTool(name, args ?? {}, callCtx());
      const code = envelope.warnings[0]?.code;
      observe({
        tool,
        durationMs: Math.round(performance.now() - started),
        state: envelope.state,
        isError: envelope.state === "unavailable",
        ...(envelope.state !== "ok" && code !== undefined && WARNING_CODE.test(code) ? { errorType: code } : {}),
        ...(typeof envelope.provenance?.chainId === "number" ? { chainId: envelope.provenance.chainId } : {}),
      }, args);
      return {
        resultType: "complete" as const,
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope as Record<string, unknown>,
        isError: envelope.state === "unavailable",
      };
    } catch (err) {
      // One instanceof narrowing instead of repeated casts — `tie` is the typed view of the error.
      const tie = err instanceof ToolInputError ? err : undefined;
      const teaching = tie?.teaching;
      const message = teaching
        ? `${teaching.summary}. ${teaching.remediation}${teaching.example ? ` Example — ${teaching.example.title}: ${JSON.stringify(teaching.example.input)}` : ""}`
        : tie
          ? `invalid input for ${tie.tool}: ${JSON.stringify(tie.issues)}`
          : err instanceof Error
            ? err.message.split("\n")[0]!
            : String(err);
      // Even the failure path honors the advertised outputSchema: a minimal error envelope as
      // structuredContent, with the teaching payload (issues/remediation/corrected example) as its
      // data so the agent's next call can succeed without a doc lookup.
      // provenance.chainId echoes the REQUESTED chain when one was passed — a hardcoded 1 misled
      // clients that branch on it.
      const requestedChain = (args as { chainId?: unknown } | undefined)?.chainId;
      const chainId = ChainId.safeParse(requestedChain).data ?? 1;
      const errorEnvelope = {
        state: "unavailable" as const,
        data: teaching ?? null,
        warnings: [{ code: tie ? "invalid_input" : "internal_error", message }],
        provenance: { source: "config" as const, chainId, fetchedAt: new Date().toISOString() },
        schemaVersion: SCHEMA_VERSION,
      };
      observe({ tool, durationMs: Math.round(performance.now() - started), state: "unavailable", isError: true, errorType: tie ? "invalid_input" : "internal_error", ...(tie ? {} : { error: err }) }, args);
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
