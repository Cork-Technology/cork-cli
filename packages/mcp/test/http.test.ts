// Streamable HTTP projection (Phase 2a): the SAME server surface over HTTP. The handler is a
// pure fetch function, so the whole suite runs offline with zero sockets — the SDK client's
// custom-fetch hook drives real Streamable HTTP protocol traffic straight into the handler.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DOC_TOPICS } from "@cork/schemas";
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
