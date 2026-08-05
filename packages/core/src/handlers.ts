// One typed dispatch shared by the MCP server and the CLI (RFC: "MCP + CLI over one core").
// Pure/offline tools are fully implemented; chain-backed compute runs when an RPC + addresses
// are supplied, else returns an honest `unavailable` envelope; unimplemented phases return
// `unavailable` with a reason rather than a fabricated result [K1/K3].
// Split 2026-08-05: per-tool handler modules live in ./handlers/; this file keeps the runTool
// dispatch and re-exports the original public surface (external interface unchanged).
import { buildTeaching, type ChainId, ComputeInput, DecodeInput, Envelope, PrepareOrdersInput, PreparePhoenixInput, QueryInput, SubmitInput, toolByName, type ToolName, TrackInput } from "@cork/schemas";
import { computeMarketId } from "./marketid.ts";
import { type CorkActionParamMap } from "./bundle/actions.ts";
import { type HandlerContext, ToolInputError, unavailable } from "./handlers/shared.ts";
import { handleCapabilities } from "./handlers/capabilities.ts";
import { handlePreparePhoenix } from "./handlers/phoenix.ts";
import { handleCompute } from "./handlers/compute.ts";
import { handleDecode } from "./handlers/decode.ts";
import { handleQuery } from "./handlers/query.ts";
import { handlePrepareMarket } from "./handlers/prepare-market.ts";
import { handlePrepareOrders } from "./handlers/prepare-orders.ts";
import { handleTrack } from "./handlers/track.ts";
import { handleSubmit } from "./handlers/submit.ts";

export { ToolInputError, jsonSafe, type HandlerContext } from "./handlers/shared.ts";
export { KNOWN_FILTER_KEYS } from "./handlers/filters.ts";
export { resetRegistryBindingGuardCache } from "./handlers/registry.ts";
export { decimalToScaled } from "./handlers/submit.ts";


/** Validate + dispatch a tool call. Throws ToolInputError on schema failure. */
export async function runTool(name: string, rawInput: unknown, ctx: HandlerContext = {}): Promise<Envelope> {
  const def = toolByName(name);
  if (!def) throw new ToolInputError(name, `unknown tool: ${name}`);
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(name, parsed.error.issues, buildTeaching(name as ToolName, parsed.error.issues, rawInput));
  const chainIdOf = (x: unknown): ChainId => (x as { chainId?: ChainId }).chainId ?? 1;

  switch (name) {
    case "cork_capabilities":
      return handleCapabilities(parsed.data as { topic?: string; search?: string }, ctx);
    case "cork_decode":
      return handleDecode(parsed.data as DecodeInput, ctx);
    case "cork_compute":
      return handleCompute(parsed.data as ComputeInput, ctx);
    case "cork_prepare_phoenix":
      return handlePreparePhoenix(parsed.data as PreparePhoenixInput, ctx);
    case "cork_query":
      return handleQuery(parsed.data as QueryInput, ctx);
    case "cork_track":
      return handleTrack(parsed.data as TrackInput, ctx);
    case "cork_prepare_orders":
      return handlePrepareOrders(parsed.data as PrepareOrdersInput, ctx);
    case "cork_prepare_market":
      return handlePrepareMarket(parsed.data as Parameters<typeof handlePrepareMarket>[0], ctx);
    case "cork_submit":
      return handleSubmit(parsed.data as SubmitInput, ctx);
    default:
      return unavailable(chainIdOf(parsed.data), "phase_gated", `${name} is not implemented in this iteration`, ctx);
  }
}

export { computeMarketId };
export type { CorkActionParamMap };

