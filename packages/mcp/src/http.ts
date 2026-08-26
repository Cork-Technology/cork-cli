// Streamable HTTP projection of the same MCP server (Phase 2a of the remote-deploy plan). One
// fetch handler (Request → Response) serves three routes:
//   POST /mcp              — the MCP Streamable HTTP endpoint (SDK web-standard transport,
//                            STATELESS: sessionIdGenerator undefined + a fresh createCorkServer
//                            per request — the SDK-recommended stateless shape; our dispatch is
//                            stateless by construction, so no session state exists to lose).
//                            GET/DELETE are refused 405 (spec allowance): with no sessions and
//                            no server-initiated messages, a GET-opened SSE stream could only
//                            dangle — connection-pinning waste on a public deployment.
//   GET /healthz           — 200 + BUILD_VERSION (liveness for the container orchestrator)
//   GET /readyz            — 200 + a machine-readable degradation snapshot (RPC breakers, venue
//                            transport, config source). ALWAYS 200 while the process serves:
//                            the pure tools (capabilities/decode/byte-building) need no upstream,
//                            so "not ready" would lie — ingress/monitoring alert on the BODY
//                            (subsystems.*.degraded), not the status code. Hosts only, never
//                            full URLs: the committed default RPC URLs embed access tokens in
//                            their PATH, and CORK_RPC_URL may too.
//   GET /docs/<topic>      — any DOC_TOPICS body as text/markdown, resolved by name OR alias
//                            through the same findDocTopic the capabilities tool uses (same
//                            constant as the topic lookup and the initialize instructions — zero
//                            drift); unknown topic 404s with the available list
// The handler is a pure function so tests drive it without a socket; `startHttpServer` wraps it
// in Bun.serve for the real deployment (container entrypoint: `ch mcp --http`).
//
// Auth: when CORK_MCP_TOKEN is set the MCP endpoint requires `Authorization: Bearer <token>`;
// unset = open — the deployed endpoint is public BY DESIGN (a workshop hands its URL to a room).
// The token is never logged. Open does not mean unbounded: admission.ts enforces the body, depth,
// batch, concurrency and deadline bounds an ingress cannot see, per CLIENT (audit MCP-NET-003).
// Clients CANNOT override the RPC endpoint per-call — server reads run on server-side RPC
// config only, and broadcasting is always client-side (cork_capabilities topic:"signing").
import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DOC_TOPICS, findDocTopic } from "@cork/schemas";
import { BUILD_VERSION, configDiagnostics, rpcDiagnostics, venueDiagnostics, type HandlerContext } from "@cork/core";
import { createCorkServer } from "./server.ts";
import { AdmissionController, type DeadlineScheduler, MCP_HTTP_LIMITS, principalOf } from "./admission.ts";

export interface CorkHttpOptions {
  ctx?: HandlerContext;
  /** Bearer token gating the MCP endpoint (CORK_MCP_TOKEN). Unset = open; ingress owns auth. */
  token?: string;
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
}

/** Constant-time bearer check — a plain === would leak prefix length via timing. */
function bearerOk(header: string | null, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The pure fetch handler — testable without a listening socket. `peerAddress` is supplied by
 *  the server wrapper (Bun knows the socket's peer; a bare Request does not). */
export function createHttpHandler(opts: CorkHttpOptions = {}): (req: Request, peerAddress?: string) => Promise<Response> {
  const host = opts.host ?? "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const trustForwardedFor = opts.trustForwardedFor ?? !loopback;
  // ONE controller per handler: the counters are the server's, not the request's.
  const admission = new AdmissionController(opts.deadlineMs, opts.scheduleDeadline);
  return async (req: Request, peerAddress?: string): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return new Response(`ok ${BUILD_VERSION}\n`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/readyz") {
      const rpc = rpcDiagnostics();
      const venue = venueDiagnostics();
      const config = configDiagnostics();
      const body = {
        status: "ok",
        version: BUILD_VERSION,
        subsystems: {
          rpc: { ...rpc, degraded: rpc.breakers.some((b) => b.open) },
          venue: { ...venue, degraded: venue.breaker?.open === true || venue.lastOutcome?.ok === false },
          admission: { ...admission.inFlight(), limits: MCP_HTTP_LIMITS, degraded: false },
          config: config ? { ...config } : { source: null, degraded: false, note: "no config resolution yet this process" },
        },
      };
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
      if (req.method !== "POST") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `${req.method} is not served: this deployment is stateless (no server-initiated streams, no sessions) — POST JSON-RPC messages to this endpoint` }, id: null }), {
          status: 405,
          headers: { "content-type": "application/json", allow: "POST" },
        });
      }
      // Admission: bound the body/shape, take a per-client concurrency slot, and parse ONCE —
      // the parsed body is handed to the transport so untrusted input is not read twice.
      return admission.handle(req, principalOf(req, { trustForwardedFor, peerAddress }), async (parsedBody, signal) => {
        // Stateless mode: a fresh server + transport per request. tools/list and every handler are
        // pure projections of the compiled registry, so per-request construction is cheap and the
        // transport never accumulates session state. The deadline signal rides in the context, so
        // a request that outlives its budget stops its own in-flight upstream work.
        const server = createCorkServer({ ...(opts.ctx ?? {}), signal });
        // sessionIdGenerator undefined = stateless (the SDK types the field optional-but-not-
        // undefined under exactOptionalPropertyTypes; spreading nothing expresses the same).
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(req, { parsedBody });
      });
    }
    return new Response("not found — routes: /mcp (MCP Streamable HTTP), /healthz, /readyz, /docs/<topic>\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
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
  }): { port: number; hostname?: string; stop(): Promise<void> };
};

/** Serve the handler with Bun.serve. Returns the Bun server (has .port, .hostname and .stop()).
 * `stop()` stops accepting and resolves once in-flight requests have finished (Bun 1.3.14,
 * verified) — the drain a graceful shutdown awaits. Binds loopback unless opts.host widens it —
 * Bun's own default is 0.0.0.0, which must never be the accidental outcome of a bare
 * `ch mcp --http`. */
export function startHttpServer(port: number, opts: CorkHttpOptions = {}): { port: number; hostname: string; stop: () => Promise<void> } {
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
  return { port: server.port ?? port, hostname: server.hostname ?? hostname, stop: () => server.stop() };
}
