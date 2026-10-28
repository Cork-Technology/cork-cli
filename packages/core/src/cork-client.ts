// Client attribution headers for every HTTP call to a Cork server (the venue API at
// api-phoenix.cork.tech, breaking.cork.tech, or whatever CORK_VENUE_URL names).
//
// The Cork client header contract: every Cork client that calls a Cork server sends
//   X-Cork-Client: <client>/<version>                                   (bare, machine-read)
//   User-Agent:    <client>/<version>[ (surface=…; client=…)] <runtime>  (RFC 9110 products)
// so the API can count calls per client and version. It is ATTRIBUTION ONLY: the server never
// trusts it for auth, and nothing else rides on it — no user, wallet, key, machine or session
// identifier. The optional User-Agent comment names the surface and the MCP client that drove the
// call; the MCP client is mapped onto a CLOSED allowlist (mcpClientLabel, unknown → "other"), so
// a hostile or merely chatty client name — an address, an e-mail, a hex blob — can never reach a
// header. The runtime's own product token (`Bun/1.3.x`, what fetch would have sent) stays last.
//
// X-Cork-Client values this package sends (four of the clients the API accepts; the others are
// other Cork software):
//   cork-cli/<v>      — `ch <command>`
//   cork-cli-mcp/<v>  — `ch mcp` over stdio / `cork-mcp` (a local process the user runs)
//   cork-mcp/<v>      — the hosted MCP server (`ch mcp --http`)
//   cork-sdk/<v>      — @cork/core embedded by someone else
// <v> is semver-shaped and matches the API's version pattern: the build version without its `v`;
// an unstamped build ("dev") is the published package's version for an npm consumer of
// @cork/core (stamped into dist by scripts/build-packages.mjs), else 0.0.0-dev (a source run).
import { PACKAGE_VERSION } from "./package-version.ts";
import { BUILD_VERSION } from "./version.ts";

export type CorkClientName = "cork-cli" | "cork-cli-mcp" | "cork-mcp" | "cork-sdk";

/** The MCP clients a header or an analytics event may name. Anything else is "other". */
export type McpClientLabel =
  | "claude-code" | "claude-desktop" | "claude-ai" | "cowork" | "cursor" | "windsurf" | "vscode" | "roo-code" | "cline" | "continue" | "zed"
  | "goose" | "codex" | "chatgpt" | "gemini-cli" | "opencode" | "amp" | "devin" | "librechat" | "mcp-inspector" | "cork-agent" | "other";

export interface CorkClientIdentity {
  client: CorkClientName;
  /** `surface` (e.g. "mcp") and `client` (the MCP client's clientInfo.name — mapped onto the
   *  allowlist on output, never echoed). */
  comment?: { surface?: "mcp" | undefined; client?: string | undefined };
}

/** The identity used when the embedding surface did not say who it is: an SDK consumer. */
export const DEFAULT_CORK_CLIENT: CorkClientIdentity = Object.freeze({ client: "cork-sdk" });

// Ordered: the first fragment contained in the normalized name (lowercased, separators dropped)
// wins, so the specific names come before the ones they contain ("claude-code" before "claude",
// "roo-cline" before "cline"). The fragments are what the clients send as clientInfo.name
// (verified against PostHog's MCP client detection, services/mcp/src/lib/client-detection.ts,
// and its MCP analytics fixtures): claude-code, "Anthropic/ClaudeAI" / claude-ai, cursor-vscode,
// "Visual Studio Code", Cline, Roo Code, continue-client, Zed, goose, codex-mcp-client,
// openai-mcp (ChatGPT), gemini-cli-mcp-client, windsurf-client, opencode, amp-mcp-client, Devin,
// LibreChat, mcp-inspector / inspector-client.
const MCP_CLIENT_FRAGMENTS: ReadonlyArray<readonly [string, McpClientLabel]> = [
  ["corkagent", "cork-agent"],
  ["claudecode", "claude-code"],
  ["claudedesktop", "claude-desktop"],
  ["cowork", "cowork"],
  ["claudeai", "claude-ai"],
  ["anthropic", "claude-ai"],
  ["cursor", "cursor"],
  ["windsurf", "windsurf"],
  ["roocode", "roo-code"],
  ["roocline", "roo-code"],
  ["cline", "cline"],
  ["continue", "continue"],
  ["visualstudiocode", "vscode"],
  ["vscode", "vscode"],
  ["copilot", "vscode"],
  ["zed", "zed"],
  ["goose", "goose"],
  ["opencode", "opencode"],
  ["codex", "codex"],
  ["openaimcp", "chatgpt"],
  ["chatgpt", "chatgpt"],
  ["geminicli", "gemini-cli"],
  ["ampmcpclient", "amp"],
  ["devin", "devin"],
  ["librechat", "librechat"],
  ["inspector", "mcp-inspector"],
];

/** Map an MCP client's self-reported name onto the closed allowlist. undefined in = undefined
 *  out (no name was given); any other string becomes a known label or "other". Names that look
 *  like an address, a hash or an e-mail are "other" whatever they contain. */
export function mcpClientLabel(raw: unknown): McpClientLabel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return "other";
  if (raw.length > 128 || /0x[0-9a-f]{4,}|[0-9a-f]{16,}|@/iu.test(raw)) return "other";
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  for (const [fragment, label] of MCP_CLIENT_FRAGMENTS) if (normalized.includes(fragment)) return label;
  return "other";
}

// MAJOR.MINOR.PATCH plus at most ONE `-…` or `+…` suffix of ≤ 32 characters: a subset of both
// SemVer and the API's X-Cork-Client version pattern (`^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,32})?$`),
// so every value sent passes the API's check. A pre-release WITH build metadata
// (`1.2.3-rc.1+abc`) or a longer suffix is "0.0.0-unknown".
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})([-+][0-9A-Za-z.-]{1,32})?$/u;

/** The version token: the build version without its leading `v` ("v0.7.1" → "0.7.1"), checked
 *  semver-shaped and capped; an unstamped build ("dev") is the npm package's version, else
 *  "0.0.0-dev"; anything else unusable is "0.0.0-unknown". */
export function corkClientVersion(version: string = BUILD_VERSION): string {
  const v = version.trim().replace(/^v/u, "");
  if (v === "dev") return PACKAGE_VERSION !== undefined && SEMVER.test(PACKAGE_VERSION) ? PACKAGE_VERSION : "0.0.0-dev";
  return v.length <= 64 && SEMVER.test(v) ? v : "0.0.0-unknown";
}

/** The runtime's own User-Agent product token — what fetch would have sent had we not set one
 *  (`Bun/1.3.14`; `Node.js/22` under node). Kept only if it is a plain `name/version` token. */
function runtimeProduct(): string | undefined {
  const ua = (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent;
  return typeof ua === "string" && /^[A-Za-z][A-Za-z0-9.-]{0,31}\/[0-9][A-Za-z0-9.+-]{0,31}$/u.test(ua) ? ua : undefined;
}

/** `X-Cork-Client`: the bare `<client>/<version>`. */
export function formatCorkClient(id: CorkClientIdentity = DEFAULT_CORK_CLIENT, version: string = BUILD_VERSION): string {
  return `${id.client}/${corkClientVersion(version)}`;
}

/** `User-Agent`: `<client>/<version>[ (surface=…; client=<label>)][ <runtime>]` — RFC 9110
 *  product + comment grammar; every part is a closed value. */
export function formatCorkUserAgent(id: CorkClientIdentity = DEFAULT_CORK_CLIENT, version: string = BUILD_VERSION, runtime: string | undefined = runtimeProduct()): string {
  const parts: string[] = [];
  if (id.comment?.surface === "mcp") parts.push("surface=mcp");
  const client = mcpClientLabel(id.comment?.client);
  if (client) parts.push(`client=${client}`);
  return `${formatCorkClient(id, version)}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}${runtime ? ` ${runtime}` : ""}`;
}

/** The two attribution headers, lowercase names (fetch normalizes them anyway). */
export function corkClientHeaders(id: CorkClientIdentity | undefined, version: string = BUILD_VERSION): { "user-agent": string; "x-cork-client": string } {
  const who = id ?? DEFAULT_CORK_CLIENT;
  return { "user-agent": formatCorkUserAgent(who, version), "x-cork-client": formatCorkClient(who, version) };
}

/** A call site's headers with the attribution pair set LAST, so no call site can override them
 *  (datasources/venue.ts rawFetch; not part of the SDK surface). `X-Cork-Client` is replaced;
 *  `User-Agent` puts `<client>/<version>` first and keeps a call site's own User-Agent after it
 *  (the client header contract: existing UA info stays, after ours). */
export function withCorkClientHeaders(headers: RequestInit["headers"], client: CorkClientIdentity | undefined): Headers {
  const out = new Headers(headers);
  const existing = out.get("user-agent")?.replace(/[^\x20-\x7e]+/gu, " ").trim().slice(0, 256);
  for (const [name, value] of Object.entries(corkClientHeaders(client))) out.set(name, value);
  if (existing) out.set("user-agent", `${out.get("user-agent")} ${existing}`);
  return out;
}

/** Return the identity with the MCP client name filled in (when one is known). */
export function withMcpClient(id: CorkClientIdentity, mcpClientName: string | undefined): CorkClientIdentity {
  if (mcpClientName === undefined) return id;
  return { ...id, comment: { ...(id.comment ?? {}), client: mcpClientName } };
}
