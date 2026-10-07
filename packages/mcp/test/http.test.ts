// Streamable HTTP projection (Phase 2a): the SAME server surface over HTTP. The handler is a
// pure fetch function, so the whole suite runs offline with zero sockets — the SDK client's
// custom-fetch hook drives real Streamable HTTP protocol traffic straight into the handler.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DOC_TOPICS } from "@cork/schemas";
import { DEFAULT_RPCS } from "@cork/core";
import { createCorkServer, createHttpHandler, MCP_HTTP_LIMITS, MCP_SECURITY_HEADERS, readyzBody, withSecurityHeaders } from "@cork/mcp";

const NOW = 1_800_000_000n;

function fetchInto(handler: (req: Request) => Promise<Response>) {
  return (url: string | URL | Request, init?: RequestInit) => handler(new Request(url, init));
}

async function httpClient(opts: { token?: string; header?: string } = {}) {
  const handler = createHttpHandler({ ctx: { nowSeconds: NOW }, ...(opts.token !== undefined ? { token: opts.token } : {}) });
  const transport = new StreamableHTTPClientTransport(new URL("http://cork.test/mcp"), {
    fetch: fetchInto(handler),
    ...(opts.header !== undefined ? { requestInit: { headers: { authorization: opts.header } } } : {}),
  });
  const client = new Client({ name: "http-test", version: "0" });
  // exactOptionalPropertyTypes friction in the SDK's own types (sessionId: string | undefined
  // vs optional) — the runtime shape is exactly a Transport.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

describe("Streamable HTTP MCP endpoint (stateless)", () => {
  it("completes the initialize handshake and carries the signing instructions", async () => {
    const client = await httpClient();
    expect(client.getInstructions()).toBe(DOC_TOPICS.signing!.summary);
  });

  it("tools/list over HTTP is IDENTICAL to the stdio surface", async () => {
    const http = await httpClient();
    const { tools: viaHttp } = await http.listTools();

    const server = createCorkServer({ nowSeconds: NOW });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const stdio = new Client({ name: "stdio-test", version: "0" });
    await Promise.all([stdio.connect(clientT), server.connect(serverT)]);
    const { tools: viaStdio } = await stdio.listTools();

    expect(viaHttp).toEqual(viaStdio);
    expect(viaHttp).toHaveLength(9);
  });

  it("a tool call returns the envelope as structuredContent", async () => {
    const client = await httpClient();
    const res = (await client.callTool({ name: "cork_capabilities", arguments: { topic: "signing" } })) as { structuredContent?: Record<string, unknown>; isError?: boolean };
    expect(res.isError ?? false).toBe(false);
    const env = res.structuredContent as { state: string; data: { topic: string; body: string }; schemaVersion: string };
    expect(env.state).toBe("ok");
    expect(env.data.topic).toBe("signing");
    expect(env.data.body).toBe(DOC_TOPICS.signing!.body);
  });

  it("an RFQ write with auth apiKey is refused over HTTP even when the operator has a key — nothing reaches the venue", async () => {
    const prev = process.env.CORK_RFQ_API_KEY;
    process.env.CORK_RFQ_API_KEY = "operator-key-should-never-leave";
    try {
      let venueCalls = 0;
      const handler = createHttpHandler({ ctx: { nowSeconds: NOW, venueFetch: async () => { venueCalls++; return new Response("{}", { status: 201 }); } } });
      const transport = new StreamableHTTPClientTransport(new URL("http://cork.test/mcp"), { fetch: fetchInto(handler) });
      const client = new Client({ name: "http-test", version: "0" });
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      const res = (await client.callTool({
        name: "cork_submit",
        arguments: { chainId: 42161, clientRequestId: "test-http-apikey-01", action: { type: "rfq-counter", rfqId: "rfq_1", requester: "0x1111111111111111111111111111111111111111", premiumAnnualized: "0.03", auth: { method: "apiKey" } } },
      })) as { structuredContent?: { state: string; warnings: Array<{ code: string; message: string }> } };
      expect(res.structuredContent?.state).toBe("unavailable");
      expect(res.structuredContent?.warnings[0]?.code).toBe("api_key_missing");
      expect(res.structuredContent?.warnings[0]?.message).toContain("HTTP MCP endpoint");
      expect(JSON.stringify(res)).not.toContain("operator-key-should-never-leave");
      expect(venueCalls).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.CORK_RFQ_API_KEY;
      else process.env.CORK_RFQ_API_KEY = prev;
    }
  });

  it("bearer auth: rejects a missing/wrong token with 401, admits the right one", async () => {
    const handler = createHttpHandler({ token: "sekrit" });
    const bare = await handler(new Request("http://cork.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) }));
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe("Bearer");
    const wrong = await handler(new Request("http://cork.test/mcp", { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) }));
    expect(wrong.status).toBe(401);
    // A full handshake succeeds with the right token.
    const client = await httpClient({ token: "sekrit", header: "Bearer sekrit" });
    expect((await client.listTools()).tools).toHaveLength(9);
  });

  it("GET/DELETE /mcp are refused in stateless mode — 405 + Allow: POST (no dangling SSE streams)", async () => {
    // The SDK transport would open a server-initiated SSE stream on GET even though a stateless
    // per-request server can never push to it (verified empirically) — the handler refuses
    // non-POST up front, using the spec's "MAY respond 405" allowance.
    const handler = createHttpHandler({});
    for (const method of ["GET", "DELETE"]) {
      const res = await handler(new Request("http://cork.test/mcp", { method, headers: { accept: "application/json, text/event-stream" } }));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("healthz and /docs/signing serve without auth; unknown routes 404", async () => {
    const handler = createHttpHandler({ token: "sekrit" });
    const health = await handler(new Request("http://cork.test/healthz"));
    expect(health.status).toBe(200);
    expect(await health.text()).toMatch(/^ok /);
    const docs = await handler(new Request("http://cork.test/docs/signing"));
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/markdown");
    expect(await docs.text()).toBe(DOC_TOPICS.signing!.body);
    const missing = await handler(new Request("http://cork.test/nope"));
    expect(missing.status).toBe(404);
  });

  it("/docs/<topic> serves EVERY doc topic by name and by alias; an unknown topic 404s with the list", async () => {
    // The route resolves through findDocTopic, so this passes for a topic added later without
    // touching http.ts — the property the previous hardcoded /docs/signing could not have.
    const handler = createHttpHandler({});
    for (const topic of Object.values(DOC_TOPICS)) {
      for (const key of [topic.name, ...topic.aliases]) {
        const res = await handler(new Request(`http://cork.test/docs/${key}`));
        expect(res.status, `/docs/${key}`).toBe(200);
        expect(await res.text()).toBe(topic.body);
      }
    }
    const bad = await handler(new Request("http://cork.test/docs/not-a-topic"));
    expect(bad.status).toBe(404);
    const listed = await bad.text();
    for (const topic of Object.values(DOC_TOPICS)) expect(listed).toContain(`/docs/${topic.name}`);
  });

  it("/docs/<malformed-percent-encoding> is a 404, not a thrown URIError", async () => {
    // decodeURIComponent throws on "%" and truncated escapes; on a public deployment an uncaught
    // throw is a 500 for a request that deserves the 404 + topic list.
    const handler = createHttpHandler({});
    for (const path of ["/docs/%", "/docs/%zz", "/docs/%e0%"]) {
      const res = await handler(new Request(`http://cork.test${path}`));
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("/docs/units");
    }
  });
});

describe("/readyz diagnostics", () => {
  it("serves a 200 degradation snapshot without auth, and NEVER leaks a full RPC URL — hosts only", async () => {
    // Seed the resolver's disk state with entries for the tokened default URL, then prove the
    // snapshot redacts to hosts. The cache path is env-switchable per process (documented), so
    // this drives the REAL realDeps() load path, not a stub.
    const dir = mkdtempSync(join(tmpdir(), "cork-readyz-"));
    const file = join(dir, "rpc-state.json");
    const tokened = DEFAULT_RPCS[1]!;
    writeFileSync(file, JSON.stringify({ version: 1, breaker: { [tokened]: { failures: 3, openedAt: Date.now() } }, chosen: { 1: { url: tokened, source: "default", ts: Date.now() } }, candidates: {} }));
    const prev = process.env.CORK_RPC_CACHE_FILE;
    process.env.CORK_RPC_CACHE_FILE = file;
    try {
      const handler = createHttpHandler({ token: "sekrit" });
      // The FULL view needs a bearer (cork-cli-private#6); the MCP token is one of the two.
      const res = await handler(new Request("http://cork.test/readyz", { headers: { authorization: "Bearer sekrit" } }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        version: string;
        detail: string;
        subsystems: {
          rpc: { chosen: Record<string, { host: string }>; breakers: Array<{ host: string; open: boolean }>; degraded: boolean };
          venue: { host: string; degraded: boolean };
          config: { source: string | null; degraded: boolean };
        };
      };
      expect(body.status).toBe("ok");
      expect(body.detail).toBe("full");
      expect(body.subsystems.rpc.chosen["1"]!.host).toBe(new URL(tokened).host);
      expect(body.subsystems.rpc.degraded).toBe(true); // the seeded breaker is open
      expect(body.subsystems.venue.host).toBe("api-phoenix.cork.tech");
      // CORK_CONFIG_NO_FETCH=1 (vitest config) → deliberate offline mode, bundled + not degraded.
      expect(body.subsystems.config).toMatchObject({ source: "bundled", degraded: false });
      // The redaction guarantee: the access token embedded in the default URL's PATH must not
      // appear anywhere in the payload.
      const tokenSegment = tokened.split("/").pop()!;
      expect(JSON.stringify(body)).not.toContain(tokenSegment);
      // The PUBLIC view, same process, same seeded state: the degraded flags survive, the host
      // does not — not as a redaction of the full body, but because the summary never carried it.
      const pub = await handler(new Request("http://cork.test/readyz"));
      expect(pub.status).toBe(200);
      const summary = (await pub.json()) as { detail: string; degraded: boolean; subsystems: Record<string, Record<string, unknown>> };
      expect(summary.detail).toBe("summary");
      expect(summary.degraded).toBe(true);
      expect(summary.subsystems.rpc).toEqual({ degraded: true });
      expect(JSON.stringify(summary)).not.toContain(new URL(tokened).host);
      expect(JSON.stringify(summary)).not.toContain(tokenSegment);
    } finally {
      if (prev === undefined) delete process.env.CORK_RPC_CACHE_FILE;
      else process.env.CORK_RPC_CACHE_FILE = prev;
    }
  });
});

describe("/readyz: two views (cork-cli-private#6)", () => {
  const SUMMARY_KEYS = ["admission", "config", "rpc", "venue"];
  const body = async (res: Response) => (await res.json()) as { status: string; detail: string; degraded: boolean; note?: string; subsystems: Record<string, Record<string, unknown>> };

  it("a request with no bearer gets the SUMMARY: degraded flags only, still 200, no challenge", async () => {
    const handler = createHttpHandler({ token: "sekrit", diagnosticsToken: "diag" });
    const res = await handler(new Request("http://cork.test/readyz"));
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const b = await body(res);
    expect(b.status).toBe("ok");
    expect(b.detail).toBe("summary");
    expect(Object.keys(b.subsystems).sort()).toEqual(SUMMARY_KEYS);
    for (const sub of Object.values(b.subsystems)) expect(Object.keys(sub)).toEqual(["degraded"]);
    expect(b.note).toContain("summary view");
    // Nothing operational: no hosts, no bounds, no posture, no counts, no config source.
    const text = JSON.stringify(b);
    for (const leak of ["host", "limits", "trustForwardedFor", "global", "breakers", "chosen", "source", "lastOutcome", "bodyBytes"]) expect(text, leak).not.toContain(`"${leak}"`);
  });

  it("a WRONG bearer gets the summary too — never a 401 (a liveness probe is never told to authenticate)", async () => {
    const handler = createHttpHandler({ token: "sekrit", diagnosticsToken: "diag" });
    for (const header of ["Bearer nope", "Bearer ", "Basic c2Vrcml0", "sekrit"]) {
      const res = await handler(new Request("http://cork.test/readyz", { headers: { authorization: header } }));
      expect(res.status, header).toBe(200);
      expect((await body(res)).detail, header).toBe("summary");
    }
  });

  it("the MCP bearer unlocks the FULL view; so does the diagnostics bearer, which does NOT unlock /mcp", async () => {
    const handler = createHttpHandler({ token: "sekrit", diagnosticsToken: "diag" });
    for (const header of ["Bearer sekrit", "Bearer diag"]) {
      const res = await handler(new Request("http://cork.test/readyz", { headers: { authorization: header } }));
      const b = await body(res);
      expect(b.detail, header).toBe("full");
      expect(b.subsystems.admission).toMatchObject({ limits: MCP_HTTP_LIMITS, trustForwardedFor: false, global: expect.any(Number) });
      expect(b.subsystems.venue).toHaveProperty("host");
      expect(b.subsystems.config).toHaveProperty("source");
      expect(b.note).toBeUndefined();
    }
    // The diagnostics bearer is READ-ONLY: /mcp still wants the MCP token.
    const mcp = await handler(new Request("http://cork.test/mcp", { method: "POST", headers: { authorization: "Bearer diag", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) }));
    expect(mcp.status).toBe(401);
  });

  it("with NEITHER token configured the summary is all anyone gets — an empty bearer never unlocks", async () => {
    const handler = createHttpHandler({});
    for (const headers of [{}, { authorization: "Bearer " }, { authorization: "Bearer undefined" }]) {
      const res = await handler(new Request("http://cork.test/readyz", { headers }));
      expect((await body(res)).detail).toBe("summary");
    }
  });

  /** The same diagnostics with every upstream quiet: no open breaker, no venue outcome. */
  const quietOf = (diag: Parameters<typeof readyzBody>[1]) => ({ ...diag, rpc: { ...diag.rpc, breakers: [] } as typeof diag.rpc, venue: { host: "v", breaker: undefined, lastOutcome: undefined } as unknown as typeof diag.venue });

  it("readyzBody is pure: the summary is BUILT from the degraded flags, the full view carries the diagnostics", () => {
    const diag = {
      rpc: { source: "default", chosen: { 8453: { host: "rpc.example.test" } }, breakers: [{ host: "rpc.example.test", open: true }] } as unknown as Parameters<typeof readyzBody>[1]["rpc"],
      venue: { host: "venue.example.test", breaker: { open: false }, lastOutcome: { ok: false } } as unknown as Parameters<typeof readyzBody>[1]["venue"],
      config: { source: "bundled", degraded: false } as unknown as Parameters<typeof readyzBody>[1]["config"],
      admission: { global: 3, principals: 2 },
      trustForwardedFor: true,
    };
    const summary = readyzBody("summary", diag);
    expect(summary.degraded).toBe(true);
    expect(summary.subsystems).toEqual({ rpc: { degraded: true }, venue: { degraded: true }, admission: { degraded: false }, config: { degraded: false } });
    expect(JSON.stringify(summary)).not.toContain("example.test");
    const full = readyzBody("full", diag);
    expect(full.degraded).toBe(true);
    expect(full.subsystems.rpc).toMatchObject({ degraded: true, breakers: [{ host: "rpc.example.test", open: true }] });
    expect(full.subsystems.venue).toMatchObject({ degraded: true, host: "venue.example.test" });
    expect(full.subsystems.admission).toMatchObject({ global: 3, principals: 2, limits: MCP_HTTP_LIMITS, trustForwardedFor: true, degraded: false });
    expect(full.subsystems.config).toMatchObject({ source: "bundled", degraded: false });
    // The config resolver's own flag is CARRIED into both views and the aggregate — a remote
    // fetch that fell back to the bundled copy with a warning must show (the first draft of the
    // trim overwrote it with false).
    const configDown = { ...quietOf(diag), config: { source: "bundled", ageMs: 5, ttlMs: 3_600_000, degraded: true } as unknown as typeof diag.config };
    expect(readyzBody("summary", configDown).subsystems.config).toEqual({ degraded: true });
    expect(readyzBody("summary", configDown).degraded).toBe(true);
    expect(readyzBody("full", configDown).subsystems.config).toMatchObject({ source: "bundled", ageMs: 5, degraded: true });
    expect(readyzBody("full", configDown).degraded).toBe(true);
    // No config resolution yet: not degraded, and the full view says why.
    const noConfig = { ...quietOf(diag), config: null };
    expect(readyzBody("summary", noConfig).subsystems.config).toEqual({ degraded: false });
    expect(readyzBody("full", noConfig).subsystems.config).toMatchObject({ source: null, degraded: false, note: expect.stringContaining("no config resolution") });
    // A quiet process is not degraded in either view.
    const quiet = quietOf(diag);
    expect(readyzBody("summary", quiet).degraded).toBe(false);
    expect(readyzBody("full", quiet).degraded).toBe(false);
  });
});

describe("security headers ride EVERY response (cork-cli-private#6)", () => {
  const expectSecured = (res: Response, label: string) => {
    for (const [name, value] of Object.entries(MCP_SECURITY_HEADERS)) expect(res.headers.get(name), `${label}: ${name}`).toBe(value);
  };

  it("the header set is the hardening posture, stated once", () => {
    expect(MCP_SECURITY_HEADERS).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
    });
    // HSTS is the TLS terminator's to set — never from a plain-HTTP bind.
    expect(Object.keys(MCP_SECURITY_HEADERS)).not.toContain("strict-transport-security");
  });

  it("every route, every status: healthz, readyz (both views), docs, 404, 405, 401, admission 413, and the transport's own 200", async () => {
    const gated = createHttpHandler({ token: "sekrit" });
    const open = createHttpHandler({});
    const cases: Array<[string, Promise<Response>, number]> = [
      ["healthz", open(new Request("http://cork.test/healthz")), 200],
      ["readyz summary", open(new Request("http://cork.test/readyz")), 200],
      ["readyz full", gated(new Request("http://cork.test/readyz", { headers: { authorization: "Bearer sekrit" } })), 200],
      ["docs", open(new Request("http://cork.test/docs/signing")), 200],
      ["docs 404", open(new Request("http://cork.test/docs/not-a-topic")), 404],
      ["unknown route", open(new Request("http://cork.test/nope")), 404],
      ["GET /mcp", open(new Request("http://cork.test/mcp", { headers: { accept: "application/json, text/event-stream" } })), 405],
      ["401", gated(new Request("http://cork.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) })), 401],
      ["413", open(new Request("http://cork.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": String(MCP_HTTP_LIMITS.bodyBytes + 1) }, body: "{}" })), 413],
      ["transport 200", open(new Request("http://cork.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) })), 200],
    ];
    for (const [label, pending, status] of cases) {
      const res = await pending;
      expect(res.status, label).toBe(status);
      expectSecured(res, label);
    }
    // Route-set headers survive beside the posture: content types and the 405's Allow.
    expect((await cases[3]![1]).headers.get("content-type")).toContain("text/markdown");
    expect((await cases[6]![1]).headers.get("allow")).toBe("POST");
    expect((await cases[7]![1]).headers.get("www-authenticate")).toBe("Bearer");
  });

  it("the posture WINS over a route or transport header of the same name; status, body and other headers pass through", async () => {
    const res = withSecurityHeaders(new Response("body", { status: 418, statusText: "teapot", headers: { "cache-control": "public, max-age=600", "x-frame-options": "SAMEORIGIN", "content-type": "text/plain", "x-custom": "kept" } }));
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("teapot");
    expect(await res.text()).toBe("body");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-custom")).toBe("kept");
    // A streaming body is passed through, not buffered away.
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("chunk")); c.close(); } });
    expect(await withSecurityHeaders(new Response(stream)).text()).toBe("chunk");
  });

  it("a tool call over the SDK client still works with the headers on (the transport's Response was rebuilt, not broken)", async () => {
    const client = await httpClient();
    expect((await client.listTools()).tools).toHaveLength(9);
  });
});
