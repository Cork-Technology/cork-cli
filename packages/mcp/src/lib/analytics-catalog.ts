/**
 * The hosted MCP's product id, service name and events (read by analytics.ts).
 * Both events are PostHog's reserved MCP Analytics names; `$exception` goes through
 * captureException.
 */

/** Product id. */
export const PRODUCT = "mcp";

/** Service name: OTel `service.name` on logs and the release annotation `<service>@<sha12>`. */
export const SERVICE = "cork-cli";

export const EVENTS = {
  /** Tool call metadata. */
  mcp_tool_call: "$mcp_tool_call",
  /** Client handshake metadata. */
  mcp_initialize: "$mcp_initialize",
} as const;

export type EventName = keyof typeof EVENTS;
