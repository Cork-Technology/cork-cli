// Streamable HTTP projection of the same MCP server. One
// fetch handler (Request → Response) serves three routes:
//   POST /mcp              — the MCP Streamable HTTP endpoint (SDK web-standard transport,
//                            STATELESS: sessionIdGenerator undefined + a fresh createCorkServer
//                            per request — the SDK-recommended stateless shape; our dispatch is
//                            stateless by construction, so no session state exists to lose).
//                            GET/DELETE are refused 405 (spec allowance): with no sessions and
//                            no server-initiated messages, a GET-opened SSE stream could only
//                            dangle — connection-pinning waste on a public deployment.
//   GET /healthz           — 200 + BUILD_VERSION (liveness for the container orchestrator)
//   GET /readyz            — 200 + a machine-readable degradation snapshot. ALWAYS 200 while the
//                            process serves: the pure tools (capabilities/decode/byte-building)
//                            need no upstream, so "not ready" would lie — ingress/monitoring
//                            alert on the BODY (subsystems.*.degraded), not the status code.
//                            TWO VIEWS (2026-10-07): the public body is the
//                            SUMMARY — one `degraded` flag per subsystem and the aggregate — and
//                            nothing else; the FULL view (RPC hosts and breaker states, the venue
//                            host and its last outcome, in-flight counts and the admission bounds,
//                            the trust posture, the config source) is served only to a caller
//                            presenting the MCP bearer or the diagnostics bearer
//                            (CORK_MCP_DIAGNOSTICS_TOKEN). The full view is an operator's
//                            reconnaissance map (which RPC vendor, when a breaker is open, how
//                            loaded the server is right now), and a public endpoint should not
//                            hand it to whoever asks. Hosts only, never full URLs, even in the
//                            full view: the committed default RPC URLs embed access tokens in
//                            their PATH, and CORK_RPC_URL may too.
//   GET /docs/<topic>      — any DOC_TOPICS body as text/markdown, resolved by name OR alias
//                            through the same findDocTopic the capabilities tool uses (same
//                            constant as the topic lookup and the initialize instructions — zero
//                            drift); unknown topic 404s with the available list
// The handler is a pure function so tests drive it without a socket; `startHttpServer` wraps it
// in Bun.serve for the real deployment (container entrypoint: `ch mcp --http`).
//
// Every response — the transport's included — carries MCP_SECURITY_HEADERS:
// the endpoint serves JSON and markdown to machine clients, so nothing here is ever meant to be
// rendered, framed, cached by an intermediary, or sniffed into another type; the headers say so
// once, in one place, instead of relying on every route and every SDK version to say it.
//
// Auth: when CORK_MCP_TOKEN is set the MCP endpoint requires `Authorization: Bearer <token>`;
// unset = open — the deployed endpoint is public BY DESIGN (a workshop hands its URL to a room).
// The token is never logged. Open does not mean unbounded: admission.ts enforces the body, depth,
// batch, concurrency and deadline bounds an ingress cannot see, per CLIENT.
// Clients CANNOT override the RPC endpoint per-call — server reads run on server-side RPC
// config only, and broadcasting is always client-side (cork_capabilities topic:"signing").
import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DOC_TOPICS, findDocTopic, REGISTRY } from "@cork/schemas";
import { BUILD_VERSION, configDiagnostics, type CorkClientIdentity, mcpClientLabel, rpcDiagnostics, venueDiagnostics, type HandlerContext } from "@cork/core";
import { createCorkServer } from "./server.ts";
import { AdmissionController, type DeadlineScheduler, MCP_HTTP_LIMITS, principalOf } from "./admission.ts";
import { decodeSessionToken, encodeSessionToken, type McpAnalytics, newSessionId, productTokens, type RequestMeta, type SessionInfo, token as cleanToken, vendorClient as vendorToken, versionToken } from "./lib/mcp-analytics.ts";

/** This server's identity to Cork servers: X-Cork-Client `cork-mcp/<v>`, User-Agent
 *  `cork-mcp/<v> (client=<allowlisted mcp client>) Bun/<v>` (cork-client.ts). */
const HOSTED_MCP_CLIENT: CorkClientIdentity = Object.freeze({ client: "cork-mcp" });
const KNOWN_TOOLS: ReadonlySet<string> = new Set(REGISTRY.map((t) => t.name));
/** JSON-RPC methods named as-is in request logs; anything else is "other" (never a caller string). */
const LOGGED_RPC_METHODS: ReadonlySet<string> = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "resources/list", "prompts/list", "notifications/cancelled"]);

/** What one /mcp request says about itself, for analytics and logs. Every value is validated
 *  (closed sets or closed charsets); the body itself never leaves this function. */
function describeRpc(body: unknown): { rpcMethod?: string; tool?: string; initialize?: { clientName?: string; clientVersion?: string; protocolVersion?: string } } {
  const messages = Array.isArray(body) ? body : [body];
  const first = messages[0] as { method?: unknown; params?: { name?: unknown } } | undefined;
  const methodOf = (m: unknown): string | undefined => (typeof m === "string" ? (LOGGED_RPC_METHODS.has(m) ? m : "other") : undefined);
  const rpcMethod = messages.length > 1 ? "batch" : methodOf(first?.method);
  const tool = messages.length === 1 && first?.method === "tools/call" && typeof first.params?.name === "string" ? (KNOWN_TOOLS.has(first.params.name) ? first.params.name : "unknown_tool") : undefined;
  const init = messages.find((m) => (m as { method?: unknown } | null)?.method === "initialize") as { params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } } } | undefined;
  const clientName = mcpClientLabel(init?.params?.clientInfo?.name);
  const clientVersion = versionToken(init?.params?.clientInfo?.version);
  const protocolVersion = cleanToken(init?.params?.protocolVersion, 32);
  return {
    ...(rpcMethod ? { rpcMethod } : {}),
    ...(tool ? { tool } : {}),
    ...(init ? { initialize: { ...(clientName ? { clientName } : {}), ...(clientVersion ? { clientVersion } : {}), ...(protocolVersion ? { protocolVersion } : {}) } } : {}),
  };
}

/** The route TEMPLATE for a request log (never the raw path: /docs/<anything> is one route). */
function routeTemplate(pathname: string): string {
  if (pathname === "/mcp" || pathname === "/healthz" || pathname === "/readyz") return pathname;
  if (pathname.startsWith("/docs/")) return "/docs/:topic";
  return "not_found";
}

/** Did this initialize succeed? Only then does the client get a session token. The JSON
 *  response is read from a CLONE (the client still gets the untouched body). */
async function initializeSucceeded(res: Response): Promise<boolean> {
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return false;
  try {
    const body = (await res.clone().json()) as unknown;
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((m) => typeof (m as { result?: { protocolVersion?: unknown } } | null)?.result?.protocolVersion === "string");
  } catch {
    return false;
  }
}

export interface CorkHttpOptions {
  ctx?: HandlerContext;
  /** Bearer token gating the MCP endpoint (CORK_MCP_TOKEN). Unset = open; ingress owns auth.
   * Also unlocks the full /readyz view. */
  token?: string;
  /** Bearer token that unlocks the FULL /readyz view without gating /mcp
   * (CORK_MCP_DIAGNOSTICS_TOKEN) — for an open deployment whose operator still wants the
   * hosts, breakers and in-flight counts remotely. Unset = the full view needs the MCP token;
   * with neither set the summary is all anyone gets. */
  diagnosticsToken?: string;
  /** Bind address. Default 127.0.0.1 — loopback-only, so `ch mcp --http` on a workstation never
   * exposes an open endpoint to the network by accident. Widening to 0.0.0.0 is an explicit act
   * (`--host 0.0.0.0`), which is what the container deployment passes (packaging/phala-compose.yml)
   * because a mapped port needs a non-loopback bind and Phala's ingress fronts the CVM. */
  host?: string;
  /** Trust `X-Forwarded-For` for per-client accounting. Set ONLY when a trusted ingress fronts
   * this process (it does on the CVM); the header is caller-supplied, so trusting it without one
   * lets anyone mint a fresh principal per request. Defaults on for a non-loopback bind. */
  trustForwardedFor?: boolean;
  /** Request deadline; tests inject a short one. */
  deadlineMs?: number;
  /** Deterministic deadline scheduler seam for tests. */
  scheduleDeadline?: DeadlineScheduler;
  /** Server-side analytics (lib/mcp-analytics.ts over the analytics core in lib/):
   *  `$mcp_tool_call` events, request logs and
   *  exception capture. Absent = off — nothing is sent (session tokens are still minted: they
   *  are protocol behaviour and venue attribution, not analytics). Only `ch mcp --http`
   *  constructs one, on the explicit opt-in (CORK_MCP_ANALYTICS=1 + a Cork project key). */
  analytics?: McpAnalytics;
}

/** Constant-time bearer check — a plain === would leak prefix length via timing. */
function bearerOk(header: string | null, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Does the request present ANY of the configured bearers? Each configured token is checked in
 *  constant time; an unconfigured one never matches (so an empty header never unlocks). */
function presentsBearer(req: Request, tokens: ReadonlyArray<string | undefined>): boolean {
  const header = req.headers.get("authorization");
  let ok = false;
  for (const token of tokens) if (token !== undefined && bearerOk(header, token)) ok = true;
  return ok;
}

/** The headers every response carries. The endpoint is machine-to-machine JSON/markdown:
 *  - `x-content-type-options: nosniff` — a client must not reinterpret a body as another type;
 *  - `cache-control: no-store` — nothing here is cacheable: envelopes carry live chain/venue
 *    state and the bearer-gated views must never sit in a shared cache;
 *  - `referrer-policy: no-referrer` — a URL on this host is never leaked onward;
 *  - `content-security-policy: default-src 'none'; frame-ancestors 'none'` and
 *    `x-frame-options: DENY` — no body here is a document to render or frame;
 *  - `cross-origin-resource-policy: same-origin` — no cross-site embedding of a response.
 *  HSTS is deliberately absent: it belongs to the TLS terminator (the ingress); set from a plain
 *  HTTP loopback bind it would be a lie about the connection. */
export const MCP_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
});

/** Return `res` with MCP_SECURITY_HEADERS applied. The headers WIN over whatever the route or
 *  the SDK transport set for the same names (a transport that marked a body cacheable would
 *  undo the posture); every other header, the status and the body stream pass through. A new
 *  Response is built because a transport's Response may carry immutable headers. */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(MCP_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** The /readyz body. `detail: "summary"` is the public view — one `degraded` flag per subsystem
 *  and the aggregate; `detail: "full"` adds the operator's diagnostics (hosts, breakers, venue
 *  outcome, in-flight counts, bounds, trust posture, config source). */
export interface ReadyzBody {
  status: "ok";
  version: string;
  detail: "summary" | "full";
  degraded: boolean;
  subsystems: Record<"rpc" | "venue" | "admission" | "config", { degraded: boolean } & Record<string, unknown>>;
  note?: string;
}

/** The /readyz snapshot at the requested detail. Pure over the diagnostics it is handed, so the
 *  trim is testable without a server: the summary is BUILT from the degraded flags alone, never
 *  by deleting keys from the full view — a new diagnostic field can only ever reach the public
 *  body by being added here on purpose. */
export function readyzBody(detail: "summary" | "full", diag: { rpc: ReturnType<typeof rpcDiagnostics>; venue: ReturnType<typeof venueDiagnostics>; config: ReturnType<typeof configDiagnostics>; admission: Record<string, unknown>; trustForwardedFor: boolean }): ReadyzBody {
  const rpcDegraded = diag.rpc.breakers.some((b) => b.open);
  const venueDegraded = diag.venue.breaker?.open === true || diag.venue.lastOutcome?.ok === false;
  // The config resolver reports its own flag (a remote fetch that fell back to the bundled copy
  // with a warning); it is carried, never recomputed or overwritten here.
  const configDegraded = diag.config?.degraded ?? false;
  const degraded = rpcDegraded || venueDegraded || configDegraded;
  if (detail === "summary") {
    return {
      status: "ok",
      version: BUILD_VERSION,
      detail,
      degraded,
      subsystems: { rpc: { degraded: rpcDegraded }, venue: { degraded: venueDegraded }, admission: { degraded: false }, config: { degraded: configDegraded } },
      note: "summary view: the full snapshot (hosts, breakers, in-flight counts, bounds) is served to a request presenting the MCP bearer or the diagnostics bearer (CORK_MCP_DIAGNOSTICS_TOKEN)",
    };
  }
  return {
    status: "ok",
    version: BUILD_VERSION,
    detail,
    degraded,
    subsystems: {
      rpc: { ...diag.rpc, degraded: rpcDegraded },
      venue: { ...diag.venue, degraded: venueDegraded },
      admission: { ...diag.admission, limits: MCP_HTTP_LIMITS, trustForwardedFor: diag.trustForwardedFor, degraded: false },
      config: diag.config ? { ...diag.config } : { source: null, degraded: false, note: "no config resolution yet this process" },
    },
  };
}

/** The pure fetch handler — testable without a listening socket. `peerAddress` is supplied by
 *  the server wrapper (Bun knows the socket's peer; a bare Request does not). */
export function createHttpHandler(opts: CorkHttpOptions = {}): (req: Request, peerAddress?: string) => Promise<Response> {
  // X-Forwarded-For is trusted only when the OPERATOR says an ingress is in front. It used to
  // default on for any non-loopback bind — a guess: a bare
  // `--host 0.0.0.0` on a box with no proxy let every caller mint a fresh principal per request
  // and walk past the per-client cap. Default OFF fails the safe way (one shared bucket behind
  // an undeclared ingress, visible in /readyz) instead of the silent one.
  const trustForwardedFor = opts.trustForwardedFor ?? false;
  // ONE controller per handler: the counters are the server's, not the request's.
  const admission = new AdmissionController(opts.deadlineMs, opts.scheduleDeadline);
  const analytics = opts.analytics;
  // Per-request facts the outer wrapper logs once the response exists.
  interface RequestFacts { meta: RequestMeta; rpcMethod?: string; tool?: string }
  const route = async (req: Request, peerAddress: string | undefined, facts: RequestFacts): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return new Response(`ok ${BUILD_VERSION}\n`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/readyz") {
      // Always 200, two views (see the header). A wrong or absent bearer is NOT a 401 here: the
      // summary is the public contract, and a liveness probe must never be told to authenticate.
      const detail = presentsBearer(req, [opts.token, opts.diagnosticsToken]) ? "full" : "summary";
      const body = readyzBody(detail, { rpc: rpcDiagnostics(), venue: venueDiagnostics(), config: configDiagnostics(), admission: admission.inFlight(), trustForwardedFor });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    // /docs/<topic-or-alias> resolves through the SAME lookup the capabilities tool uses, so a new
    // DOC_TOPICS entry is served here the moment it exists — the previous hardcoded /docs/signing
    // would have needed an edit per topic (and silently 404'd until someone remembered).
    if (url.pathname.startsWith("/docs/")) {
      // decodeURIComponent THROWS on malformed percent-encoding ("/docs/%") — on a public
      // deployment an uncaught throw here is a 500 for a request that deserves the 404 + list.
      let slug = "";
      try {
        slug = decodeURIComponent(url.pathname.slice("/docs/".length));
      } catch {
        /* malformed encoding: fall through with no slug → 404 with the topic list */
      }
      const doc = findDocTopic(slug);
      if (doc) {
        return new Response(doc.body, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
      }
      const known = Object.values(DOC_TOPICS).map((d) => `/docs/${d.name}`).join(" ");
      return new Response(`no such doc topic; available: ${known}\n`, { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/mcp") {
      if (opts.token !== undefined && !bearerOk(req.headers.get("authorization"), opts.token)) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "unauthorized: this deployment requires Authorization: Bearer <token>" }, id: null }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
        });
      }
      // Stateless means server-initiated streams cannot exist: each request gets a fresh server
      // that dies with the response, so a GET-opened SSE stream would hang forever carrying
      // nothing — pure resource waste (and a cheap way to pin connections on a public
      // deployment). The SDK transport would happily open one (verified empirically), so GET and
      // DELETE (session teardown — no sessions exist) are refused HERE with the spec's own
      // escape hatch: "the server MAY respond 405 Method Not Allowed".
      // Clients that hold an Mcp-Session-Id (minted at initialize, below) handle the 405 as the
      // spec says: the TypeScript SDK treats a 405 on the standalone GET as "no stream" and stops;
      // the python-sdk tries the GET stream twice (1 s apart) and gives up, and logs a DELETE 405
      // at close as "server does not allow session termination" — a few cheap refusals per
      // session, no error surfaced to the user.
      if (req.method !== "POST") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `${req.method} is not served: this deployment is stateless (no server-initiated streams, no sessions) — POST JSON-RPC messages to this endpoint` }, id: null }), {
          status: 405,
          headers: { "content-type": "application/json", allow: "POST" },
        });
      }
      // Admission: bound the body/shape, take a per-client concurrency slot, and parse ONCE —
      // the parsed body is handed to the transport so untrusted input is not read twice.
      return admission.handle(req, principalOf(req, { trustForwardedFor, peerAddress }), async (parsedBody, signal) => {
        // Who is calling, as far as attribution goes: the initialize handshake in THIS body, else
        // the session token the client replays (minted below at its initialize). Untrusted and
        // re-validated (lib/mcp-analytics.ts); it names a client, it never authorizes anything.
        // An initialize opens a NEW session whatever token it carries (a stale one from an
        // earlier session): the handshake's own client name and version win.
        // The token is minted with or without analytics: Mcp-Session-Id is then uniform protocol
        // behaviour, and the tools/calls it identifies name their MCP client to the venue.
        const rpc = describeRpc(parsedBody);
        const session: SessionInfo | undefined = rpc.initialize
          ? { sessionId: newSessionId(), ...(rpc.initialize.clientName ? { clientName: rpc.initialize.clientName } : {}), ...(rpc.initialize.clientVersion ? { clientVersion: rpc.initialize.clientVersion } : {}) }
          : decodeSessionToken(req.headers.get("mcp-session-id"));
        const protocolVersion = rpc.initialize?.protocolVersion ?? cleanToken(req.headers.get("mcp-protocol-version"), 32);
        // Product tokens only (comments dropped, ≤ 3, known names, version-shaped versions) and the
        // vendor header from its allowlist; anything else is "other".
        const userAgent = productTokens(req.headers.get("user-agent"));
        const vendorClient = vendorToken(req.headers.get("x-anthropic-client"));
        facts.meta = { ...(session ? { session } : {}), ...(protocolVersion ? { protocolVersion } : {}), ...(userAgent ? { userAgent } : {}), ...(vendorClient ? { vendorClient } : {}) };
        if (rpc.rpcMethod) facts.rpcMethod = rpc.rpcMethod;
        if (rpc.tool) facts.tool = rpc.tool;
        const meta = facts.meta;
        // Stateless mode: a fresh server + transport per request. tools/list and every handler are
        // pure projections of the compiled registry, so per-request construction is cheap and the
        // transport never accumulates session state. The deadline signal rides in the context, so
        // a request that outlives its budget stops its own in-flight upstream work.
        const server = createCorkServer(
          { ...(opts.ctx ?? {}), corkClient: opts.ctx?.corkClient ?? HOSTED_MCP_CLIENT, signal, apiKeys: "refuse" },
          {
            clientName: () => session?.clientName,
            ...(analytics ? { onToolCall: (call, args) => analytics.toolCall(call, meta, args) } : {}),
          },
        );
        // sessionIdGenerator undefined = stateless (the SDK types the field optional-but-not-
        // undefined under exactOptionalPropertyTypes; spreading nothing expresses the same).
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        await server.connect(transport);
        const res = await transport.handleRequest(req, { parsedBody });
        if (!rpc.initialize || session === undefined || !(await initializeSucceeded(res))) return res;
        // Hand the client its session token (JSON mode builds headers after the handler ran,
        // so this is the response the client reads it from) and record the handshake.
        analytics?.initialize(meta);
        const headers = new Headers(res.headers);
        headers.set("mcp-session-id", encodeSessionToken(session));
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      });
    }
    return new Response("not found — routes: /mcp (MCP Streamable HTTP), /healthz, /readyz, /docs/<topic>\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  };
  // ONE seam for the posture: every route's response, the transport's and the admission
  // refusals included, passes through here.
  // Analytics rides the same seam: one request log per /mcp or /docs request (health probes are
  // not logged — they would be most of the volume and say nothing), and an exception escaping a
  // route is captured before it propagates exactly as it did without analytics.
  return async (req, peerAddress) => {
    const facts: RequestFacts = { meta: {} };
    const serve = async (): Promise<Response> => withSecurityHeaders(await route(req, peerAddress, facts));
    if (!analytics) return serve();
    const started = performance.now();
    const template = routeTemplate(new URL(req.url).pathname);
    let status = 500;
    try {
      const res = await serve();
      status = res.status;
      return res;
    } catch (err) {
      analytics.captureException(err, facts.meta);
      throw err;
    } finally {
      if (template !== "/healthz" && template !== "/readyz") {
        analytics.requestLog({ route: template, method: req.method, status, latencyMs: Math.round(performance.now() - started), ...(facts.rpcMethod ? { rpcMethod: facts.rpcMethod } : {}), ...(facts.tool ? { tool: facts.tool } : {}), meta: facts.meta });
      }
    }
  };
}

// Minimal ambient Bun.serve surface — the repo compiles with plain TS (no bun-types); the
// runtime is always Bun (mise-pinned), so the declaration only mirrors what we call.
declare const Bun: {
  serve(opts: {
    port: number;
    hostname: string;
    maxRequestBodySize: number;
    fetch: (req: Request, server: { requestIP?: (req: Request) => { address: string } | null }) => Promise<Response>;
  }): { port: number; hostname?: string; stop(closeActiveConnections?: boolean): Promise<void> };
};

/** Serve the handler with Bun.serve. Returns the Bun server (has .port, .hostname and .stop()).
 * `stop()` stops accepting and resolves once in-flight requests have finished (Bun 1.3.14,
 * verified) — the drain a graceful shutdown awaits; `stop(true)` also closes the open
 * connections at once (the crash path: nothing more is served by a process that is dying). Binds loopback unless opts.host widens it —
 * Bun's own default is 0.0.0.0, which must never be the accidental outcome of a bare
 * `ch mcp --http`. */
export function startHttpServer(port: number, opts: CorkHttpOptions = {}): { port: number; hostname: string; stop: (closeActive?: boolean) => Promise<void> } {
  const hostname = opts.host ?? "127.0.0.1";
  const handler = createHttpHandler({ ...opts, host: hostname });
  const server = Bun.serve({
    port,
    hostname,
    // Belt and braces: Bun refuses an oversized body at the socket, admission refuses it again
    // for any caller that reaches the handler another way.
    maxRequestBodySize: MCP_HTTP_LIMITS.bodyBytes,
    fetch: (req, srv) => handler(req, srv.requestIP?.(req)?.address),
  });
  return { port: server.port ?? port, hostname: server.hostname ?? hostname, stop: (closeActive = false) => server.stop(closeActive) };
}
