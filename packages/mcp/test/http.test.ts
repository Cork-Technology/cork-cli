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
import { createCorkServer, createHttpHandler } from "@cork/mcp";

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
      const handler = createHttpHandler({ token: "sekrit" }); // like /healthz, no bearer required
      const res = await handler(new Request("http://cork.test/readyz"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        version: string;
        subsystems: {
          rpc: { chosen: Record<string, { host: string }>; breakers: Array<{ host: string; open: boolean }>; degraded: boolean };
          venue: { host: string; degraded: boolean };
          config: { source: string | null; degraded: boolean };
        };
      };
      expect(body.status).toBe("ok");
      expect(body.subsystems.rpc.chosen["1"]!.host).toBe(new URL(tokened).host);
      expect(body.subsystems.rpc.degraded).toBe(true); // the seeded breaker is open
      expect(body.subsystems.venue.host).toBe("api-phoenix.cork.tech");
      // CORK_CONFIG_NO_FETCH=1 (vitest config) → deliberate offline mode, bundled + not degraded.
      expect(body.subsystems.config).toMatchObject({ source: "bundled", degraded: false });
      // The redaction guarantee: the access token embedded in the default URL's PATH must not
      // appear anywhere in the payload.
      const tokenSegment = tokened.split("/").pop()!;
      expect(JSON.stringify(body)).not.toContain(tokenSegment);
    } finally {
      if (prev === undefined) delete process.env.CORK_RPC_CACHE_FILE;
      else process.env.CORK_RPC_CACHE_FILE = prev;
    }
  });
});
