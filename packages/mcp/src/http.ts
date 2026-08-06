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
//   GET /docs/signing      — the DOC_TOPICS signing body as text/markdown (same constant as the
//                            capabilities topic and the initialize instructions — zero drift)
// The handler is a pure function so tests drive it without a socket; `startHttpServer` wraps it
// in Bun.serve for the real deployment (container entrypoint: `ch mcp --http`).
//
// Auth: when CORK_MCP_TOKEN is set the MCP endpoint requires `Authorization: Bearer <token>`;
// unset = open (the deployment's ingress owns auth/rate-limits). The token is never logged.
// Clients CANNOT override the RPC endpoint per-call — server reads run on server-side RPC
// config only, and broadcasting is always client-side (cork_capabilities topic:"signing").
import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DOC_TOPICS } from "@cork/schemas";
import { BUILD_VERSION, configDiagnostics, rpcDiagnostics, venueDiagnostics, type HandlerContext } from "@cork/core";
import { createCorkServer } from "./server.ts";

export interface CorkHttpOptions {
  ctx?: HandlerContext;
  /** Bearer token gating the MCP endpoint (CORK_MCP_TOKEN). Unset = open; ingress owns auth. */
  token?: string;
  /** Bind address. Default 127.0.0.1 — loopback-only, so `ch mcp --http` on a workstation never
   * exposes an open endpoint to the network by accident. Widening to 0.0.0.0 is an explicit act
   * (`--host 0.0.0.0`), which is what the container deployment passes (packaging/phala-compose.yml)
   * because a mapped port needs a non-loopback bind and Phala's ingress fronts the CVM. */
  host?: string;
}

/** Constant-time bearer check — a plain === would leak prefix length via timing. */
function bearerOk(header: string | null, token: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The pure fetch handler — testable without a listening socket. */
export function createHttpHandler(opts: CorkHttpOptions = {}): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
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
          config: config ? { ...config } : { source: null, degraded: false, note: "no config resolution yet this process" },
        },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/docs/signing") {
      return new Response(DOC_TOPICS.signing!.body, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
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
      // Stateless mode: a fresh server + transport per request. tools/list and every handler are
      // pure projections of the compiled registry, so per-request construction is cheap and the
      // transport never accumulates session state.
      const server = createCorkServer(opts.ctx ?? {});
      // sessionIdGenerator undefined = stateless (the SDK types the field optional-but-not-
      // undefined under exactOptionalPropertyTypes; spreading nothing expresses the same).
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(req);
    }
    return new Response("not found — routes: /mcp (MCP Streamable HTTP), /healthz, /readyz, /docs/signing\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  };
}

// Minimal ambient Bun.serve surface — the repo compiles with plain TS (no bun-types); the
// runtime is always Bun (mise-pinned), so the declaration only mirrors what we call.
declare const Bun: { serve(opts: { port: number; hostname: string; fetch: (req: Request) => Promise<Response> }): { port: number; hostname?: string; stop(): void } };

/** Serve the handler with Bun.serve. Returns the Bun server (has .port, .hostname and .stop()).
 * Binds loopback unless opts.host widens it — Bun's own default is 0.0.0.0, which must never be
 * the accidental outcome of a bare `ch mcp --http`. */
export function startHttpServer(port: number, opts: CorkHttpOptions = {}): { port: number; hostname: string; stop: () => void } {
  const handler = createHttpHandler(opts);
  const hostname = opts.host ?? "127.0.0.1";
  const server = Bun.serve({ port, hostname, fetch: handler });
  return { port: server.port ?? port, hostname: server.hostname ?? hostname, stop: () => server.stop() };
}
