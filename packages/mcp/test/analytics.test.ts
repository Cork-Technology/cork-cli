// Hosted-MCP analytics (packages/mcp/src/lib/mcp-analytics.ts over the analytics core
// lib/analytics.ts, transport lib/posthog-http.ts): the kill switch, the `$mcp_tool_call`
// event shape, the shape-filtered tool arguments and the wallet identity of write tools, what is
// never sent (free text, long hex, results, read-tool addresses, caller IPs), the session
// token that carries the initialize handshake across stateless requests, the request logs, and
// the attribution headers the hosted and stdio servers send to Cork servers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BUILD_VERSION, formatCorkUserAgent } from "@cork/core";
import { EXIT, runCli } from "@cork/cli";
import { createCorkServer, createHttpHandler } from "../src/index.ts";
import { z } from "zod";
import { Address, Bytes32, DECIMAL_FRACTION_PATTERN, DEMO_ACCOUNT, DEMO_POOL_ID, Hex, REGISTRY, TOOL_EXAMPLES, toolByName, UintStr } from "@cork/schemas";
import { analyticsFromEnv, decodeSessionToken, encodeSessionToken, isReservedEventKey, MAX_ARG_PROPERTIES, type McpAnalytics, PROJECT_KEYS, productTokens, shapeFilteredArgs, token, toolArgProperties, vendorClient, versionToken, withoutReservedKeys } from "../src/lib/mcp-analytics.ts";
import { MAX_EVENTS_PER_CALLER_PER_MINUTE, resetAnalyticsForTests, scrubEvent, shutdownAnalytics, stackFrames } from "../src/lib/analytics.ts";
import { ANALYTICS_QUEUE_CAP, PostHogHttpSink, rawFrames } from "../src/lib/posthog-http.ts";
import { parseTelemetryEnv } from "../src/lib/telemetry-env.ts";
import { poolAliases, scrubText } from "../src/lib/scrub.ts";
import { corkClientVersion } from "../../core/src/cork-client.ts";

const NOW = 1_800_000_000n;
const V = corkClientVersion(BUILD_VERSION);
const ADDRESS = "0x1111111111111111111111111111111111111111";
const SECRET_ARG = "secret-argument-value";

function fetchInto(handler: (req: Request) => Promise<Response>) {
  return (url: string | URL | Request, init?: RequestInit) => handler(new Request(url, init));
}

/** A PostHog stub: records every capture batch and every OTLP logs request. */
function posthogStub() {
  const batches: Array<{ api_key: string; batch: Array<{ event: string; properties: Record<string, unknown>; timestamp: string; type: string }> }> = [];
  const logs: Array<{ auth: string | null; body: { resourceLogs: Array<{ resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> }; scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string }; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> } }> = [];
  const urls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/batch/")) batches.push(body);
    else if (url.endsWith("/i/v1/logs")) logs.push({ auth: new Headers(init?.headers).get("authorization"), body });
    return new Response("{}", { status: 200 });
  };
  return { batches, logs, urls, fetchImpl, raw: () => JSON.stringify({ batches, logs }) };
}

/** A venue stub recording the attribution headers of every call. */
function venueStub() {
  const clients: Array<string | null> = [];
  const agents: Array<string | null> = [];
  const venueFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    clients.push(new Headers(init?.headers).get("x-cork-client"));
    agents.push(new Headers(init?.headers).get("user-agent"));
    return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { clients, agents, venueFetch };
}

const PROD = { CORK_MCP_ANALYTICS: "1", POSTHOG_KEY: PROJECT_KEYS.prod, CORK_ENV: "prod" };
const STAGING = { CORK_MCP_ANALYTICS: "1", POSTHOG_KEY: PROJECT_KEYS.staging, CORK_ENV: "staging" };

/** Analytics over a recording PostHog stub. The injected sink is the core's test seam (it
 *  skips the key<->env guard, not the kill switches nor the CORK_MCP_ANALYTICS opt-in). */
function startWith(
  ph: { fetchImpl: (url: string, init?: RequestInit) => Promise<Response> },
  env: Record<string, string> = {},
  sinkOpts: { flushAt?: number; warn?: (m: string) => void } = {},
  extra: { now?: () => number; warn?: (m: string) => void } = {},
): { analytics: McpAnalytics; sink: PostHogHttpSink } {
  const sink = new PostHogHttpSink("phc_test", { host: "https://eu.i.posthog.com", flushInterval: 0, fetch: ph.fetchImpl, before_send: (e) => scrubEvent(e), warn: () => undefined, ...sinkOpts });
  const { analytics, status } = analyticsFromEnv({ CORK_MCP_ANALYTICS: "1", POSTHOG_KEY: "phc_test", ...env }, { sink, fetch: ph.fetchImpl, warn: () => undefined, ...extra });
  if (!analytics) throw new Error(`analytics did not start: ${status}`);
  return { analytics, sink };
}
const statusOf = (env: Record<string, string | undefined>): string => analyticsFromEnv(env, { warn: () => undefined }).status;

beforeEach(() => {
  resetAnalyticsForTests();
});

/** One raw JSON-RPC POST to the handler. */
function rpcPost(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://cork.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
}
const INIT = (name: string, version = "1.0.0", params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version }, ...params } });

async function connect(handler: (req: Request) => Promise<Response>, name = "claude-code", version = "2.1.0") {
  const seenSessionHeaders: Array<string | null> = [];
  const transport = new StreamableHTTPClientTransport(new URL("http://cork.test/mcp"), {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const res = await fetchInto(handler)(url, init);
      seenSessionHeaders.push(res.headers.get("mcp-session-id"));
      return res;
    },
    requestInit: { headers: { "user-agent": "claude-code/2.1.0 (cli)", "x-forwarded-for": "203.0.113.7" } },
  });
  const client = new Client({ name, version });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return { client, seenSessionHeaders };
}

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await shutdownAnalytics(0);
  resetAnalyticsForTests();
});

describe("kill switch: off unless explicitly opted in with a Cork project key; DO_NOT_TRACK / CORK_TELEMETRY=0 always win", () => {
  it("resolves the status from the environment (the core's guard plus the MCP opt-in)", () => {
    expect(statusOf({})).toBe("off (CORK_MCP_ANALYTICS is not 1)");
    // A PostHog key in someone's shell does nothing — Cork's own key included — without the opt-in.
    expect(statusOf({ POSTHOG_KEY: PROJECT_KEYS.prod, CORK_ENV: "prod" })).toMatch(/^off/u);
    expect(statusOf({ ...PROD, CORK_MCP_ANALYTICS: "true" })).toMatch(/^off/u);
    expect(statusOf({ ...PROD, POSTHOG_KEY: "  " })).toBe("off (POSTHOG_KEY unset)");
    // Any other key — someone's own PostHog project — is refused.
    expect(statusOf({ ...PROD, POSTHOG_KEY: "phc_someone_elses_project" })).toBe("off (POSTHOG_KEY is not a Cork project key)");
    expect(statusOf({ ...PROD, DO_NOT_TRACK: "1" })).toBe("off (DO_NOT_TRACK=1)");
    expect(statusOf({ ...PROD, CORK_TELEMETRY: "0" })).toBe("off (CORK_TELEMETRY=0)");
    // A host that is not a plain http(s) origin falls back to the default (the env contract).
    expect(statusOf({ ...PROD, POSTHOG_HOST: "https://user:pw@evil.example?x=1" })).toMatch(/^on \(prod → https:\/\/eu\.i\.posthog\.com,/u);
    expect(statusOf(PROD)).toMatch(/^on \(prod → https:\/\/eu\.i\.posthog\.com, key …UD8N/u);
    expect(statusOf(STAGING)).toMatch(/^on \(staging → /u);
  });

  it("never sends staging events to the prod project, nor prod events to staging", () => {
    // CORK_ENV defaults to staging: the prod key without CORK_ENV=prod is refused.
    expect(statusOf({ ...PROD, CORK_ENV: undefined })).toBe("off (prod project key with CORK_ENV=staging)");
    expect(statusOf({ ...PROD, CORK_ENV: "staging" })).toMatch(/^off/u);
    expect(statusOf({ ...PROD, CORK_ENV: "local" })).toMatch(/^off/u);
    expect(statusOf({ ...STAGING, CORK_ENV: "prod" })).toBe("off (staging project key with CORK_ENV=prod)");
    expect(analyticsFromEnv({}).analytics).toBeUndefined();
  });

  it("DO_NOT_TRACK=1 / CORK_TELEMETRY=0 win even over an injected sink (the guard's test seam)", () => {
    const sink = new PostHogHttpSink("phc_test", { host: "https://eu.i.posthog.com", flushInterval: 0, fetch: posthogStub().fetchImpl });
    for (const kill of [{ DO_NOT_TRACK: "1" }, { CORK_TELEMETRY: "0" }]) {
      resetAnalyticsForTests();
      expect(analyticsFromEnv({ CORK_MCP_ANALYTICS: "1", POSTHOG_KEY: "phc_test", ...kill }, { sink, warn: () => undefined }).analytics, JSON.stringify(kill)).toBeUndefined();
    }
  });

  it("the test run itself is DO_NOT_TRACK (vitest.setup.ts), so a spawned server never sends", () => {
    expect(process.env["DO_NOT_TRACK"]).toBe("1");
    expect(statusOf({ ...process.env, ...PROD })).toBe("off (DO_NOT_TRACK=1)");
  });

  it("the old cap names are gone: only the POSTHOG_*_MAX_PER_DAY names are read", () => {
    const e = parseTelemetryEnv({ CORK_MCP_ANALYTICS_EVENT_CAP: "7", CORK_MCP_ANALYTICS_LOG_CAP: "9" });
    expect(e).toMatchObject({ POSTHOG_EVENTS_MAX_PER_DAY: 5_000, POSTHOG_LOGS_MAX_PER_DAY: 2_000_000, POSTHOG_EXCEPTIONS_MAX_PER_DAY: 1_000 });
    expect(parseTelemetryEnv({ POSTHOG_EVENTS_MAX_PER_DAY: "7", POSTHOG_LOGS_MAX_PER_DAY: "9" })).toMatchObject({ POSTHOG_EVENTS_MAX_PER_DAY: 7, POSTHOG_LOGS_MAX_PER_DAY: 9 });
    expect(parseTelemetryEnv({ POSTHOG_EVENTS_MAX_PER_DAY: "-1" })).toMatchObject({ POSTHOG_EVENTS_MAX_PER_DAY: 5_000 });
  });

  it("without analytics the hosted server makes no PostHog call, still mints the session token, and still names the MCP client to the venue", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}");
    }) as typeof fetch;
    const venue = venueStub();
    const { client, seenSessionHeaders } = await connect(createHttpHandler({ ctx: { nowSeconds: NOW, venueFetch: venue.venueFetch } }), "cursor-vscode");
    await client.callTool({ name: "cork_capabilities", arguments: { search: "orders" } });
    await client.callTool({ name: "cork_query", arguments: { resource: "rfqs" } });
    expect(seenSessionHeaders[0]).toMatch(/^ckm1\./u);
    expect(calls.filter((u) => u.includes("posthog"))).toEqual([]);
    expect(venue.clients.length).toBeGreaterThan(0);
    for (const c of venue.clients) expect(c).toBe(`cork-mcp/${V}`);
    for (const ua of venue.agents) expect(ua).toBe(formatCorkUserAgent({ client: "cork-mcp", comment: { client: "cursor" } }));
  });
});

describe("Mcp-Session-Id: minted on a successful initialize only, the handshake wins over a stale token", () => {
  it("a failed initialize gets no token; a successful one does", async () => {
    const handler = createHttpHandler({ ctx: { nowSeconds: NOW } });
    const bad = await handler(rpcPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { nonsense: true } }));
    expect(bad.headers.get("mcp-session-id")).toBeNull();
    const good = await handler(rpcPost(INIT("claude-code")));
    expect(good.status).toBe(200);
    expect(decodeSessionToken(good.headers.get("mcp-session-id"))).toMatchObject({ clientName: "claude-code", clientVersion: "1.0.0" });
    // The body the client reads is intact (the success check read a clone).
    expect(((await good.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBeDefined();
  });

  it("an initialize carrying a stale token opens a new session named by the handshake, and is recorded", async () => {
    const ph = posthogStub();
    const { analytics } = startWith(ph);
    const handler = createHttpHandler({ ctx: { nowSeconds: NOW }, analytics });
    const stale = encodeSessionToken({ sessionId: `ses_${"a".repeat(32)}`, clientName: "cursor", clientVersion: "0.1.0" });
    const res = await handler(rpcPost(INIT("codex-mcp-client", "0.9.0"), { "mcp-session-id": stale }));
    const fresh = decodeSessionToken(res.headers.get("mcp-session-id"))!;
    expect(fresh.sessionId).not.toBe(`ses_${"a".repeat(32)}`);
    expect(fresh).toMatchObject({ clientName: "codex", clientVersion: "0.9.0" });
    await analytics.flush();
    const events = ph.batches.flatMap((b) => b.batch);
    expect(events.map((e) => e.event)).toEqual(["$mcp_initialize"]);
    expect(events[0]!.properties).toMatchObject({ mcp_session_id: fresh.sessionId, $mcp_client_name: "codex", distinct_id: "anon_mcp-codex" });
  });
});

describe("$mcp_tool_call over the hosted server", () => {
  const ALLOWED = new Set([
    "distinct_id", "$process_person_profile", "$geoip_disable", "$lib", "$lib_version", "product", "app_version", "env",
    "$mcp_source", "$mcp_interface", "$mcp_server_name", "$mcp_server_version", "$mcp_server_build", "mcp_session_id",
    "$mcp_client_name", "$mcp_client_version", "$mcp_protocol_version", "$mcp_client_user_agent", "$mcp_vendor_client",
    "$mcp_tool_name", "$mcp_resource_name", "$mcp_duration_ms", "$mcp_is_error", "$mcp_error_type", "envelope_state", "chain_id",
    "args_dropped", "client", "pool_id", "src_pool_id", "dst_pool_id",
  ]);
  /** The fixed allowlist, plus the keys the extractor kept for THIS call's arguments. */
  const allowedFor = (tool: unknown, args: unknown) => {
    const kept = new Set(Object.keys((typeof tool === "string" ? toolArgProperties(tool, args)?.properties : undefined) ?? {}));
    return (k: string): boolean => ALLOWED.has(k) || kept.has(k);
  };

  it("records tool, client, latency, outcome and safe-shaped read arguments — never free text, results, read addresses or the caller IP", async () => {
    const ph = posthogStub();
    const venue = venueStub();
    const { analytics } = startWith(ph);
    const handler = createHttpHandler({ ctx: { nowSeconds: NOW, venueFetch: venue.venueFetch }, analytics, trustForwardedFor: true });
    const { client, seenSessionHeaders } = await connect(handler);
    // The handshake answered a session token; the client replays it on every later request.
    expect(seenSessionHeaders[0]).toMatch(/^ckm1\./u);
    const sent: Record<string, Record<string, unknown>> = { cork_capabilities: { search: `${ADDRESS} ${SECRET_ARG}` }, cork_query: { resource: "rfqs", filters: { account: ADDRESS } }, cork_decode: { kind: "nonsense", input: ADDRESS } };
    const ok = (await client.callTool({ name: "cork_capabilities", arguments: sent["cork_capabilities"]! })) as { structuredContent?: unknown };
    expect(JSON.stringify(ok.structuredContent)).toBeDefined();
    await client.callTool({ name: "cork_query", arguments: sent["cork_query"]! });
    await client.callTool({ name: "cork_decode", arguments: sent["cork_decode"]! });
    await analytics.flush();

    const events = ph.batches.flatMap((b) => b.batch);
    expect(ph.batches.every((b) => b.api_key === "phc_test")).toBe(true);
    expect(events.map((e) => e.event)).toEqual(["$mcp_initialize", "$mcp_tool_call", "$mcp_tool_call", "$mcp_tool_call"]);
    const sessions = new Set(events.map((e) => e.properties.mcp_session_id));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^ses_[0-9a-f]{32}$/u);
    for (const e of events) {
      const allowed = allowedFor(e.properties.$mcp_tool_name, sent[String(e.properties.$mcp_tool_name)]);
      for (const k of Object.keys(e.properties)) expect(allowed(k), `unexpected property ${k}`).toBe(true);
      expect(e.properties).toMatchObject({ distinct_id: "anon_mcp-claude-code", $process_person_profile: false, $geoip_disable: true, product: "mcp", env: "staging", app_version: "unknown" /* a source run stamps no commit: no POSTHOG_RELEASE */, $mcp_client_name: "claude-code", client: "claude-code", $mcp_client_version: "2.1.0" });
      expect(e.properties).not.toHaveProperty("$ip");
      expect(e.properties).not.toHaveProperty("$mcp_parameters");
      expect(e.properties).not.toHaveProperty("$mcp_response");
      expect(e.properties).not.toHaveProperty("$mcp_intent");
    }
    const calls = events.filter((e) => e.event === "$mcp_tool_call");
    expect(calls.map((e) => e.properties.$mcp_tool_name)).toEqual(["cork_capabilities", "cork_query", "cork_decode"]);
    expect(calls[0]!.properties).toMatchObject({ $mcp_is_error: false, envelope_state: "ok" });
    expect(calls[2]!.properties).toMatchObject({ $mcp_is_error: true, $mcp_error_type: "invalid_input" });
    // The arguments reach the event shape-filtered: the read's enum is kept, its address is not;
    // the free-text search is dropped; an invalid call keeps no argument at all.
    expect(calls[1]!.properties).toMatchObject({ resource: "rfqs" });
    expect(calls[0]!.properties).not.toHaveProperty("search");
    expect(Object.keys(calls[2]!.properties).filter((k) => !ALLOWED.has(k))).toEqual([]);
    expect(typeof calls[0]!.properties.$mcp_duration_ms).toBe("number");
    // Product tokens only: the "(cli)" comment is dropped.
    expect(calls[0]!.properties.$mcp_client_user_agent).toBe("claude-code/2.1.0");

    // No free-text argument, no address passed to a read, nothing a tool answered, no caller IP —
    // anywhere, events and logs alike.
    const everything = ph.raw();
    expect(everything).not.toContain(ADDRESS.slice(2, 12));
    expect(everything).not.toContain(SECRET_ARG);
    expect(everything).not.toContain("203.0.113.7");
    expect(everything).not.toContain("signing"); // a word from the capabilities result body

    // The hosted server forwards the end client to the API.
    expect(venue.clients.length).toBeGreaterThan(0);
    for (const c of venue.clients) expect(c).toBe(`cork-mcp/${V}`);
    for (const ua of venue.agents) expect(ua).toBe(formatCorkUserAgent({ client: "cork-mcp", comment: { client: "claude-code" } }));
  });

  it("a tool call returns while PostHog hangs: analytics is never on the request path", async () => {
    let posted = 0;
    const { analytics } = startWith({ fetchImpl: () => { posted++; return new Promise<Response>(() => undefined); } }, {}, { flushAt: 1 });
    const handler = createHttpHandler({ ctx: { nowSeconds: NOW }, analytics });
    const { client } = await connect(handler);
    const started = performance.now();
    const res = (await client.callTool({ name: "cork_capabilities", arguments: {} })) as { isError?: boolean };
    expect(res.isError).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(posted).toBeGreaterThan(0);
  });

  it("the client's User-Agent and vendor header are reduced to closed product tokens", async () => {
    // Known product names keep their canonical spelling; unknown names and non-version
    // versions are "other".
    expect(productTokens("claude-code/2.1.141 (cli; user alice@example.com) node/22.1.0 bun/1.3 extra/1")).toBe("claude-code/2.1.141 node/22.1.0 Bun/1.3");
    expect(productTokens("Mozilla/5.0 (X11; Linux x86_64) wallet/0x1111111111111111111111111111111111111111")).toBe("Mozilla/5.0 other/other");
    expect(productTokens("Anthropic/ClaudeAI")).toBe("Anthropic/other");
    expect(productTokens("my-secret-agent/1.0 python-httpx/0.27.0 curl/8.5.0")).toBe("other/1.0 python-httpx/0.27.0 curl/8.5.0");
    expect(productTokens("cursor-vscode/1.0.0")).toBe("cursor/1.0.0");
    expect(productTokens("((((")).toBeUndefined();
    expect(versionToken("2.1.0")).toBe("2.1.0");
    expect(versionToken("v1.0.0-beta.1")).toBe("v1.0.0-beta.1");
    // A four-part numeric version is IPv4-shaped, so it is never passed on.
    expect(versionToken("10.0.0.1")).toBe("other");
    for (const bad of ["latest", "1.0 (build 7)", `1.0.0-${ADDRESS}`, "1.0.0-deadbeefdeadbeefdeadbeef"]) expect(versionToken(bad), bad).toBe("other");
    expect(versionToken(undefined)).toBeUndefined();
    expect(vendorClient("ClaudeCode")).toBe("ClaudeCode");
    expect(vendorClient("claude-ai")).toBe("ClaudeAI");
    expect(vendorClient("Cowork")).toBe("Cowork");
    expect(vendorClient("my-own-tool")).toBe("other");
    expect(token("ClaudeCode")).toBe("ClaudeCode");
    for (const evil of [ADDRESS, "alice@example.com", "deadbeefdeadbeefdeadbeef", "10.0.0.1"]) expect(token(evil), evil).toBeUndefined();
    const ph = posthogStub();
    const { analytics } = startWith(ph);
    const handler = createHttpHandler({ ctx: { nowSeconds: NOW }, analytics });
    await handler(rpcPost(INIT("claude-ai"), { "user-agent": `agent/1.0 (${ADDRESS})`, "x-anthropic-client": `Cowork ${ADDRESS}` }));
    await analytics.flush();
    const props = ph.batches.flatMap((b) => b.batch)[0]!.properties;
    expect(props.$mcp_client_user_agent).toBe("other/1.0");
    expect(props.$mcp_vendor_client).toBe("other");
    expect(ph.raw()).not.toContain(ADDRESS.slice(2, 12));
  });

  it("request logs go to the OTLP endpoint through the core's exporter, with route templates and no bodies", async () => {
    const ph = posthogStub();
    const { analytics } = startWith(ph, { CORK_ENV: "prod" });
    const handler = createHttpHandler({ ctx: { nowSeconds: NOW }, analytics });
    const { client } = await connect(handler);
    await client.callTool({ name: "cork_capabilities", arguments: { search: SECRET_ARG } });
    await handler(new Request("http://cork.test/docs/signing"));
    await handler(new Request("http://cork.test/healthz"));
    await analytics.flush();
    expect(ph.logs.length).toBeGreaterThan(0);
    expect(ph.logs[0]!.auth).toBe("Bearer phc_test");
    const records = ph.logs.flatMap((l) => l.body.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)));
    const attr = (r: (typeof records)[number], k: string) => r.attributes.find((a) => a.key === k)?.value;
    const routes = records.map((r) => attr(r, "route")?.stringValue);
    expect(routes).toContain("/mcp");
    expect(routes).toContain("/docs/:topic");
    expect(routes).not.toContain("/healthz");
    const toolLine = records.find((r) => attr(r, "tool")?.stringValue === "cork_capabilities");
    expect(toolLine).toBeDefined();
    expect(attr(toolLine!, "client")).toEqual({ stringValue: "claude-code" });
    expect(attr(toolLine!, "rpc_method")).toEqual({ stringValue: "tools_call" });
    // The client version passes through its own validator (as on the API's logs).
    expect(attr(toolLine!, "client_version")).toEqual({ stringValue: "2.1.0" });
    // OTLP/JSON int64 is a decimal string (proto3 JSON mapping).
    expect(attr(toolLine!, "status")).toEqual({ intValue: "200" });
    expect(typeof attr(toolLine!, "latency_ms")?.intValue).toBe("string");
    // Only the allowlisted request keys; product, env and app_version are resource attributes.
    for (const r of records) for (const a of r.attributes) expect(["route", "method", "status", "latency_ms", "client", "client_version", "rpc_method", "tool", "event"]).toContain(a.key);
    // No error text in MCP logs (REQUEST_LOG_KEYS): never err_message / err_type.
    expect(JSON.stringify(records)).not.toMatch(/err_message|err_type/u);
    const resource = ph.logs[0]!.body.resourceLogs[0]!.resource.attributes;
    expect(resource).toEqual(expect.arrayContaining([{ key: "deployment.environment", value: { stringValue: "prod" } }, { key: "product", value: { stringValue: "mcp" } }, { key: "service.name", value: { stringValue: "cork-cli" } }]));
    expect(ph.raw()).not.toContain(SECRET_ARG);
  });

  it("a flush failure is counted and warned once, never thrown", async () => {
    const warnings: string[] = [];
    const { analytics, sink } = startWith({ fetchImpl: async () => { throw new TypeError("network down"); } }, {}, { warn: (m) => warnings.push(m) });
    analytics.initialize({});
    analytics.initialize({});
    await analytics.flush();
    expect(sink.dropped).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it("daily caps per event name (POSTHOG_EVENTS_MAX_PER_DAY) and for logs (POSTHOG_LOGS_MAX_PER_DAY): past them items drop, one warning for events, reset at 00:00 UTC, then capped_drops", async () => {
    const ph = posthogStub();
    const warnings: string[] = [];
    let now = Date.UTC(2026, 9, 20, 23, 59);
    const { analytics } = startWith(ph, { POSTHOG_EVENTS_MAX_PER_DAY: "2", POSTHOG_LOGS_MAX_PER_DAY: "1" }, { flushAt: Number.MAX_SAFE_INTEGER }, { now: () => now, warn: (m) => warnings.push(m) });
    for (let i = 0; i < 4; i++) analytics.initialize({});
    analytics.captureException(new Error("x"));
    for (let i = 0; i < 3; i++) analytics.requestLog({ route: "/mcp", method: "POST", status: 200, latencyMs: 1, meta: {} });
    expect(warnings).toHaveLength(1);
    now += 120_000; // the next UTC day
    analytics.initialize({});
    await analytics.flush();
    const events = ph.batches.flatMap((b) => b.batch);
    expect(events.map((e) => e.event)).toEqual(["$mcp_initialize", "$mcp_initialize", "$exception", "$mcp_initialize"]);
    expect(events[3]!.properties).toMatchObject({ capped_drops: 2 });
    expect(ph.logs.flatMap((l) => l.body.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((sc) => sc.logRecords)))).toHaveLength(1);
  });

  it("per caller: at most MAX_EVENTS_PER_CALLER_PER_MINUTE of one event per MCP session per minute (capKey = the session id; a retry loop cannot flood)", async () => {
    const ph = posthogStub();
    let now = Date.UTC(2026, 9, 20, 12, 0);
    const { analytics } = startWith(ph, {}, { flushAt: Number.MAX_SAFE_INTEGER }, { now: () => now });
    expect(MAX_EVENTS_PER_CALLER_PER_MINUTE).toBe(120);
    const meta = { session: { sessionId: `ses_${"d".repeat(32)}`, clientName: "cursor" } };
    for (let i = 0; i < 125; i++) analytics.toolCall({ tool: "cork_capabilities", durationMs: 1, state: "ok", isError: false }, meta, {});
    // Another client is another caller; so is another session of the same client (same
    // distinct_id `anon_mcp-cursor`, its own capKey).
    analytics.toolCall({ tool: "cork_capabilities", durationMs: 1, state: "ok", isError: false }, { session: { sessionId: `ses_${"e".repeat(32)}`, clientName: "zed" } }, {});
    analytics.toolCall({ tool: "cork_capabilities", durationMs: 1, state: "ok", isError: false }, { session: { sessionId: `ses_${"f".repeat(32)}`, clientName: "cursor" } }, {});
    now += 60_000;
    analytics.toolCall({ tool: "cork_capabilities", durationMs: 1, state: "ok", isError: false }, meta, {});
    await analytics.flush();
    const events = ph.batches.flatMap((b) => b.batch);
    const ids = events.map((e) => e.properties.distinct_id);
    expect(ids.filter((d) => d === "anon_mcp-cursor")).toHaveLength(122);
    expect(ids.filter((d) => d === "anon_mcp-zed")).toHaveLength(1);
    expect(events.filter((e) => e.properties.mcp_session_id === `ses_${"f".repeat(32)}`)).toHaveLength(1);
    // The cap key is memory only: never a property.
    expect(JSON.stringify(events)).not.toMatch(/capKey|cap_key/u);
  });

  it("passthrough keys ($mcp_*, mcp_session_id, client) skip the shape filter only through their own validators", async () => {
    const ph = posthogStub();
    const { analytics } = startWith(ph);
    // Values no real session produces (decodeSessionToken refuses them): each key's validator does.
    const meta = { session: { sessionId: "ses_not a session id 0x1111", clientName: "Free Text Client", clientVersion: "v1 (beta)" }, protocolVersion: "2025-06-18", userAgent: "agent/1.0\nInjected: header", vendorClient: "Cowork!" };
    analytics.toolCall({ tool: "cork_capabilities", durationMs: Number.NaN, state: "ok", isError: false }, meta, {});
    await analytics.flush();
    const p = ph.batches.flatMap((b) => b.batch)[0]!.properties;
    for (const k of ["mcp_session_id", "client", "$mcp_client_name", "$mcp_client_version", "$mcp_client_user_agent", "$mcp_vendor_client", "$mcp_duration_ms"]) expect(p, k).not.toHaveProperty(k);
    expect(p).toMatchObject({ $mcp_protocol_version: "2025-06-18", $mcp_tool_name: "cork_capabilities", $mcp_server_name: "cork-mcp" });
  });

  it("a request log's client_version passes only through its validator", async () => {
    const ph = posthogStub();
    const { analytics } = startWith(ph);
    analytics.requestLog({ route: "/mcp", method: "POST", status: 200, latencyMs: 1, meta: { session: { sessionId: `ses_${"a".repeat(32)}`, clientName: "cursor", clientVersion: "v1 (beta) alice@example.com" } } });
    analytics.requestLog({ route: "/mcp", method: "POST", status: 200, latencyMs: 1, meta: { session: { sessionId: `ses_${"a".repeat(32)}`, clientName: "cursor", clientVersion: "1.4.2" } } });
    await analytics.flush();
    const records = ph.logs.flatMap((l) => l.body.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((sc) => sc.logRecords)));
    expect(records.map((r) => r.attributes.find((a) => a.key === "client_version")?.value)).toEqual([undefined, { stringValue: "1.4.2" }]);
    expect(ph.raw()).not.toContain("alice");
  });

  it("the same exception goes once per dedupe window; each tool has its own window", async () => {
    const ph = posthogStub();
    const { analytics } = startWith(ph);
    for (let i = 0; i < 3; i++) analytics.captureException(new Error("upstream timeout"), {}, { site: "tools/call", toolName: "cork_query" });
    analytics.captureException(new Error("upstream timeout"), {}, { site: "tools/call", toolName: "cork_track" });
    await analytics.flush();
    const tools = ph.batches.flatMap((b) => b.batch).filter((e) => e.event === "$exception").map((e) => e.properties.$mcp_tool_name);
    expect(tools).toEqual(["cork_query", "cork_track"]);
  });

  it("the event queue is capped: past the cap the oldest item is dropped and counted (the log queue is the core exporter's)", async () => {
    const ph = posthogStub();
    // The clock moves a minute per reading, so neither the per-caller nor the per-second cap applies.
    let t = Date.UTC(2026, 0, 1);
    const { analytics, sink } = startWith(ph, { POSTHOG_LOGS: "false" }, { flushAt: Number.MAX_SAFE_INTEGER }, { now: () => (t += 61_000) });
    for (let i = 0; i < ANALYTICS_QUEUE_CAP + 5; i++) analytics.initialize({});
    expect(sink.dropped).toBe(5);
    await analytics.flush();
    expect(ph.batches.flatMap((b) => b.batch)).toHaveLength(ANALYTICS_QUEUE_CAP);
  });
});

describe("tool arguments: shape-filtered, fail-closed; a write's acting wallet is its identity", () => {
  const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
  const MAKER = "0x8badf00d00000000000000000000000000000ab1";
  const LOP_SUBMIT = {
    chainId: 42161,
    clientRequestId: "demo-lop-0001",
    action: {
      type: "lop-order",
      order: { salt: "1", maker: MAKER, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" },
      signature: SIG,
      extension: `0x${"ab".repeat(100)}`,
      side: "SELL",
      premiumAnnualized: "0.041",
      expiry: 0,
      nonce: "0",
      allowsPartialFills: true,
    },
  };
  const SAFE_VALUE = (v: unknown): boolean =>
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (typeof v === "string" && (/^0x[0-9a-f]{40}$/u.test(v) || /^0x[0-9a-f]{64}$/u.test(v) || (/^\d+(\.\d+)?$/u.test(v) && v.length <= 78) || /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(v)));

  async function capture(tool: string, args: unknown, sessionId = `ses_${"c".repeat(32)}`) {
    const ph = posthogStub();
    resetAnalyticsForTests();
    const { analytics } = startWith(ph);
    analytics.toolCall({ tool, durationMs: 3, state: "ok", isError: false }, { session: { sessionId, clientName: "claude-code", clientVersion: "2.1.0" } }, args);
    await analytics.flush();
    return { events: ph.batches.flatMap((b) => b.batch), raw: ph.raw() };
  }

  it("a write naming its acting wallet: distinct_id = the wallet lowercased, address_verified false, person profiles on, session kept, never merged", async () => {
    const { events, raw } = await capture("cork_submit", LOP_SUBMIT);
    expect(events.map((e) => e.event)).toEqual(["$mcp_tool_call"]);
    const p = events[0]!.properties;
    expect(p).toMatchObject({ distinct_id: MAKER.toLowerCase(), address_verified: false, mcp_session_id: `ses_${"c".repeat(32)}`, $geoip_disable: true, "action.type": "lop-order", "action.side": "SELL", "action.order.maker": MAKER.toLowerCase(), "action.order.making_amount": "1000000000000000000", "action.premium_annualized": "0.041", "action.allows_partial_fills": true });
    // chain_id is the envelope's (none in this observation), never the argument's.
    expect(p).not.toHaveProperty("chain_id");
    expect(p).not.toHaveProperty("$process_person_profile");
    // The signature and the extension blob never leave; nor does the free-text request id.
    expect(p).not.toHaveProperty("action.signature");
    expect(p).not.toHaveProperty("action.extension");
    expect(raw).not.toContain("1111111111111111111111111111111111111111111111111111111111111111222");
    expect(raw).not.toContain("abababab");
    expect(raw).not.toContain("demo-lop-0001");
    expect(raw).not.toMatch(/"\$(identify|create_alias|merge_dangerously)"/u);
  });

  it("each write tool's actor field: prepare `account`, rollover `order.user`, RFQ requester / underwriter; prepare_market has none and keeps the session identity", () => {
    expect(toolArgProperties("cork_prepare_phoenix", TOOL_EXAMPLES.cork_prepare_phoenix![0]!.input)?.actor).toBe(DEMO_ACCOUNT);
    expect(toolArgProperties("cork_prepare_orders", TOOL_EXAMPLES.cork_prepare_orders![0]!.input)?.actor).toBe(DEMO_ACCOUNT);
    const submit = (type: string) => TOOL_EXAMPLES.cork_submit!.find((e) => (e.input as { action: { type: string } }).action.type === type)!.input;
    expect(toolArgProperties("cork_submit", submit("rollover-order"))?.actor).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(toolArgProperties("cork_submit", submit("rfq-open"))?.actor).toBe(DEMO_ACCOUNT);
    expect(toolArgProperties("cork_submit", submit("rfq-counter"))?.actor).toBe(DEMO_ACCOUNT);
    expect(toolArgProperties("cork_submit", submit("rfq-answer"))?.actor).toBe(DEMO_ACCOUNT);
    expect(toolArgProperties("cork_submit", LOP_SUBMIT)?.actor).toBe(MAKER.toLowerCase());
    const market = toolArgProperties("cork_prepare_market", TOOL_EXAMPLES.cork_prepare_market![0]!.input);
    expect(market).toBeDefined();
    expect(market?.actor).toBeUndefined();
    // Its contract addresses are still kept (a write).
    expect(Object.values(market!.properties).some((v) => typeof v === "string" && /^0x[0-9a-f]{40}$/u.test(v))).toBe(true);
  });

  it("a write without an acting wallet, and every read, keep the session identity with person profiles off", async () => {
    for (const [tool, args] of [["cork_prepare_market", TOOL_EXAMPLES.cork_prepare_market![0]!.input], ["cork_query", TOOL_EXAMPLES.cork_query![1]!.input]] as const) {
      const { events } = await capture(tool, args);
      expect(events[0]!.properties).toMatchObject({ distinct_id: "anon_mcp-claude-code", $process_person_profile: false, mcp_session_id: `ses_${"c".repeat(32)}` });
      expect(events[0]!.properties).not.toHaveProperty("address_verified");
    }
  });

  it("read tools never carry an address, nor a hash outside keepHashes — for every registry example, and wherever the address sits", async () => {
    const reads = REGISTRY.filter((t) => t.telemetry.kind === "read").map((t) => t.name);
    let checked = 0;
    for (const tool of reads) {
      for (const ex of TOOL_EXAMPLES[tool] ?? []) {
        const out = toolArgProperties(tool, ex.input);
        expect(out, `${tool}: ${ex.title}`).toBeDefined();
        expect(out!.actor).toBeUndefined();
        const keep = new Set((REGISTRY.find((t) => t.name === tool)!.telemetry as { keepHashes?: readonly string[] }).keepHashes ?? []);
        const keptKeys = new Set([...keep].map((p) => p.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase()));
        for (const [k, v] of Object.entries(out!.properties)) {
          expect(typeof v === "string" && /^0x[0-9a-f]{40}$/u.test(v), `${tool} ${k}`).toBe(false);
          if (typeof v === "string" && /^0x[0-9a-f]{64}$/u.test(v)) expect(keptKeys.has(k), `${tool} hash at ${k}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    // An address in a read's typed field (decode's `to`, track's forSelf adapter) is dropped too.
    const { raw } = await capture("cork_track", { mode: "verify", subject: { kind: "forSelfAdapter", adapter: ADDRESS } });
    expect(raw).not.toContain(ADDRESS.slice(2, 12));
    expect(raw).toContain('"subject.kind":"forSelfAdapter"');
  });

  it("every example of every tool projects to safe shapes only, within the property cap", () => {
    for (const t of REGISTRY) {
      for (const ex of TOOL_EXAMPLES[t.name] ?? []) {
        const out = toolArgProperties(t.name, ex.input);
        expect(out, `${t.name}: ${ex.title}`).toBeDefined();
        expect(Object.keys(out!.properties).length).toBeLessThanOrEqual(MAX_ARG_PROPERTIES);
        for (const [k, v] of Object.entries(out!.properties)) {
          expect(SAFE_VALUE(v), `${t.name} ${k}=${String(v)}`).toBe(true);
          expect(k).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+){0,2}$/u);
        }
      }
    }
  });

  it("fail-closed: a value is kept only where the schema declares that very shape; free strings, generic hex, records and deep blobs are dropped", () => {
    const schema = z.object({
      chainId: z.literal([1, 42161]),
      side: z.enum(["BUY", "SELL"]),
      wallet: Address,
      poolId: Bytes32,
      amount: UintStr,
      fraction: z.string().meta({ pattern: DECIMAL_FRACTION_PATTERN.source }), // advertised, as on premiumAnnualized
      when: z.number(),
      flag: z.boolean(),
      list: z.array(z.string()),
      // Free strings and generic hex: nothing they carry is kept, whatever its shape.
      memo: z.string(),
      memoAddress: z.string(),
      memoHash: z.string(),
      memoDigits: z.string(),
      memoEnum: z.string(),
      blob: Hex,
      blobHash: Hex,
      record: z.record(z.string(), z.unknown()),
      nested: z.object({ deep: z.object({ deeper: z.object({ value: UintStr }) }), at: UintStr }),
    });
    const json = z.toJSONSchema(schema, { io: "input", reused: "ref" });
    const input = schema.parse({
      chainId: 42161,
      side: "BUY",
      wallet: "0xabcdef0000000000000000000000000000000001",
      poolId: `0x${"ab".repeat(32)}`,
      amount: "123456789012345678901234567890",
      fraction: "0.041",
      when: 1795000000,
      flag: true,
      list: ["a", "b", "c"],
      memo: "please send to alice@example.com",
      memoAddress: ADDRESS,
      memoHash: `0x${"cd".repeat(32)}`,
      memoDigits: "4111111111111111",
      memoEnum: "BUY",
      blob: `0x${"ef".repeat(65)}`,
      blobHash: `0x${"ab".repeat(32)}`,
      record: { anything: "goes", nested: { address: ADDRESS } },
      nested: { deep: { deeper: { value: "1" } }, at: "7" },
    });
    const write = shapeFilteredArgs(input, json, { addresses: true, hashes: true });
    expect(write.properties).toEqual({
      "chain_id": 42161,
      "side": "BUY",
      "wallet": "0xabcdef0000000000000000000000000000000001",
      "pool_id": `0x${"ab".repeat(32)}`,
      "amount": "123456789012345678901234567890",
      "fraction": "0.041",
      "when": 1795000000,
      "flag": true,
      "list_count": 3,
      "nested.at": "7",
    });
    // memo ×5, blob, blobHash, record (whole), nested.deep.deeper (depth > 3)
    expect(write.dropped).toBe(9);
    // A read: no address, no hash unless the path is allowlisted.
    const read = shapeFilteredArgs(input, json, { addresses: false, hashes: new Set<string>() });
    expect(read.properties).not.toHaveProperty("wallet");
    expect(read.properties).not.toHaveProperty("pool_id");
    expect(shapeFilteredArgs(input, json, { addresses: false, hashes: new Set(["poolId"]) }).properties).toHaveProperty("pool_id");
    // A value past 78 digits is not an amount; an undeclared key never becomes a property name.
    expect(shapeFilteredArgs({ amount: "9".repeat(79), surprise: "1" }, json, { addresses: true, hashes: true }).properties).toEqual({});
  });

  it("unions: a discriminated variant only vouches for its own fields, and a Bytes32 | Hex union keeps nothing", () => {
    const H32 = `0x${"ab".repeat(32)}`;
    const variants = z.object({ action: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("a"), x: Bytes32 }), z.strictObject({ type: z.literal("b"), x: Hex })]), either: z.union([Bytes32, Hex]).optional() });
    const json = z.toJSONSchema(variants, { io: "input", reused: "ref" });
    const all = { addresses: true, hashes: true } as const;
    expect(shapeFilteredArgs({ action: { type: "a", x: H32 } }, json, all).properties).toEqual({ "action.type": "a", "action.x": H32 });
    expect(shapeFilteredArgs({ action: { type: "b", x: H32 } }, json, all).properties).toEqual({ "action.type": "b" });
    expect(shapeFilteredArgs({ either: H32 }, json, all).properties).toEqual({});
  });

  it("review repros through the real registry: 32-byte data in a generic Hex or free-text field is never kept, nor digits in a search", () => {
    const H32 = `0x${"ab".repeat(32)}`;
    const PADDED = `0x${"0".repeat(24)}${ADDRESS.slice(2)}`;
    const values = (tool: string, args: unknown) => Object.values(toolArgProperties(tool, args)?.properties ?? {}).map(String);
    for (const [tool, args] of [
      ["cork_decode", { kind: "calldata", data: H32 }],
      ["cork_decode", { kind: "calldata", data: PADDED }],
      ["cork_capabilities", { search: H32 }],
      ["cork_capabilities", { topic: H32 }],
      ["cork_capabilities", { search: "4111111111111111" }],
      ["cork_capabilities", { search: ADDRESS }],
    ] as const) {
      const out = toolArgProperties(tool, args);
      expect(out, `${tool} ${JSON.stringify(args)}`).toBeDefined();
      for (const v of values(tool, args)) expect([H32, PADDED.toLowerCase(), "4111111111111111", ADDRESS]).not.toContain(v);
    }
    // Generic Hex fields of WRITE tools keep nothing either, even exactly 32 bytes.
    const lop = { ...LOP_SUBMIT, action: { ...LOP_SUBMIT.action, extension: H32, makerPermit2: H32 } };
    const lopProps = toolArgProperties("cork_submit", lop)!.properties;
    expect(lopProps).not.toHaveProperty("action.extension");
    expect(lopProps).not.toHaveProperty("action.maker_permit2");
    const rfq = TOOL_EXAMPLES.cork_submit!.find((e) => (e.input as { action: { type: string } }).action.type === "rfq-counter")!.input as { action: Record<string, unknown> };
    const counter = { ...rfq, action: { ...rfq.action, auth: { method: "signature", signature: H32 } } };
    expect(toolArgProperties("cork_submit", counter)?.properties).not.toHaveProperty("action.auth.signature");
    // premiumAnnualized ADVERTISES its decimal shape (validation unchanged): a decimal is kept, a
    // malformed value still validates (the handler refuses it) but is never kept.
    expect(toolArgProperties("cork_submit", rfq)?.properties).toMatchObject({ "action.premium_annualized": "0.035" });
    const malformed = { ...rfq, action: { ...rfq.action, premiumAnnualized: "4.1% (see memo)" } };
    expect(toolByName("cork_submit")!.input.safeParse(malformed).success).toBe(true);
    expect(toolArgProperties("cork_submit", malformed)?.properties).not.toHaveProperty("action.premium_annualized");
  });

  it("cork_query filters: the advertised typed keys are kept by shape — enums, booleans, pool id; addresses, order hashes, free text and unknown keys are not", () => {
    const out = toolArgProperties("cork_query", { resource: "orderbook", filters: { poolId: DEMO_POOL_ID, side: "SELL", account: ADDRESS, orderHash: `0x${"33".repeat(32)}`, status: "my secret note", view: "discovery", zzz: "free" } })!;
    expect(out.properties).toMatchObject({ "resource": "orderbook", "filters.pool_id": DEMO_POOL_ID, "filters.side": "SELL", "filters.view": "discovery" });
    for (const k of ["filters.account", "filters.order_hash", "filters.status", "filters.zzz"]) expect(out.properties).not.toHaveProperty(k);
    expect(JSON.stringify(out)).not.toContain(ADDRESS.slice(2, 12));
    const rfqs = toolArgProperties("cork_query", { resource: "rfqs", filters: { rfqKind: "rollover", state: "open", withAnswers: true, rfqId: "rfq_0abc", underwriter: ADDRESS } })!.properties;
    expect(rfqs).toMatchObject({ "filters.rfq_kind": "rollover", "filters.state": "open", "filters.with_answers": true });
    expect(rfqs).not.toHaveProperty("filters.rfq_id");
    expect(rfqs).not.toHaveProperty("filters.underwriter");
    // A malformed value of a known key still validates (the handler refuses it) and is never kept.
    expect(toolArgProperties("cork_query", { resource: "orderbook", filters: { side: "sideways", poolId: "nope" } })!.properties).toEqual({ "resource": "orderbook", "page_size": 25, "max_pages": 10, "format": "concise" });
  });

  it("flat pool ids: one distinct kept pool id becomes top-level pool_id (src/dst alike); conflicts give none; generic, no per-tool list", async () => {
    // A write with a pool.
    const write = await capture("cork_prepare_phoenix", TOOL_EXAMPLES.cork_prepare_phoenix![0]!.input);
    expect(write.events[0]!.properties).toMatchObject({ pool_id: DEMO_POOL_ID, "action.pool_id": DEMO_POOL_ID });
    // A read with a keepHashes pool.
    const read = await capture("cork_query", { resource: "cork-pool", filters: { poolId: DEMO_POOL_ID } });
    expect(read.events[0]!.properties).toMatchObject({ pool_id: DEMO_POOL_ID, "filters.pool_id": DEMO_POOL_ID });
    expect(toolArgProperties("cork_track", { mode: "verify", subject: { kind: "marketRef", poolId: DEMO_POOL_ID } })!.pools).toEqual({ pool_id: DEMO_POOL_ID });
    // Conflicting values give none; src/dst are copied the same way; the dotted originals stay.
    const A = `0x${"aa".repeat(32)}`;
    const B = `0x${"bb".repeat(32)}`;
    expect(poolAliases({ "action.pool_id": A, "action.for_self.pool_id": B })).toEqual({});
    expect(poolAliases({ "action.pool_id": A, "action.for_self.pool_id": A })).toEqual({ pool_id: A });
    expect(poolAliases({ "action.src_pool_id": A, "action.dst_pool_id": B, "action.jit.src_pool_id": A })).toEqual({ src_pool_id: A, dst_pool_id: B });
    expect(poolAliases({ "action.src_pool_id": A, "x.src_pool_id": B })).toEqual({});
    // A read's dropped hash never becomes a pool field (only kept values are read).
    expect(toolArgProperties("cork_track", { mode: "reconcile", subject: { kind: "orderHash", orderHash: A } })!.pools).toEqual({});
  });

  it("a read's event carries exactly the extractor's kept arguments plus the pool aliases — never an address, never anything else from its arguments", async () => {
    const reads = REGISTRY.filter((t) => t.telemetry.kind === "read").map((t) => t.name);
    const samples: Array<[string, unknown]> = [
      ...reads.flatMap((tool) => (TOOL_EXAMPLES[tool] ?? []).map((ex) => [tool, ex.input] as [string, unknown])),
      ["cork_query", { resource: "orderbook", filters: { poolId: DEMO_POOL_ID, side: "SELL", account: ADDRESS } }],
      ["cork_compute", TOOL_EXAMPLES.cork_compute![0]!.input],
    ];
    const baseline = new Set(Object.keys((await capture("cork_capabilities", {})).events[0]!.properties));
    for (const [tool, args] of samples) {
      const { events } = await capture(tool, args);
      const kept = toolArgProperties(tool, args)!.properties;
      const extra = Object.keys(events[0]!.properties).filter((k) => !baseline.has(k));
      for (const k of extra) {
        if (["pool_id", "src_pool_id", "dst_pool_id"].includes(k)) continue;
        expect(Object.keys(kept), `${tool} ${k}`).toContain(k);
        expect(events[0]!.properties[k], `${tool} ${k}`).toEqual(kept[k]);
      }
      for (const v of Object.values(events[0]!.properties)) expect(typeof v === "string" && /^0x[0-9a-f]{40}$/u.test(v), `${tool} address ${String(v)}`).toBe(false);
    }
  });

  it("read tools drop 32-byte hashes (tx / order hashes) except the registry's keepHashes pool ids", () => {
    const tx = `0x${"22".repeat(32)}`;
    const track = (subject: Record<string, unknown>) => toolArgProperties("cork_track", { mode: "reconcile", subject })!.properties;
    expect(Object.values(track({ kind: "txHash", txHash: tx }))).not.toContain(tx);
    expect(Object.values(track({ kind: "orderHash", orderHash: tx }))).not.toContain(tx);
    expect(toolArgProperties("cork_track", { mode: "verify", subject: { kind: "marketRef", poolId: DEMO_POOL_ID } })!.properties).toMatchObject({ "subject.pool_id": DEMO_POOL_ID });
    expect(toolArgProperties("cork_compute", TOOL_EXAMPLES.cork_compute![0]!.input)!.properties).toMatchObject({ "params.pool_id": DEMO_POOL_ID });
    // A write keeps its hashes.
    expect(toolArgProperties("cork_prepare_phoenix", TOOL_EXAMPLES.cork_prepare_phoenix![0]!.input)!.properties).toMatchObject({ "action.pool_id": DEMO_POOL_ID });
  });

  it("at most MAX_ARG_PROPERTIES arguments per event; the rest are counted as dropped", () => {
    const shape = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, z.number()]));
    const json = z.toJSONSchema(z.object(shape), { io: "input" });
    const out = shapeFilteredArgs(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, i])), json, { addresses: true, hashes: true });
    expect(Object.keys(out.properties)).toHaveLength(MAX_ARG_PROPERTIES);
    expect(out.dropped).toBe(60 - MAX_ARG_PROPERTIES);
  });

  it("no argument key takes a top-level event name: colliding keys are dropped and counted, pool ids come from the core's poolAliases only", async () => {
    const reserved = ["client", "product", "env", "app_version", "chain_id", "pool_id", "src_pool_id", "dst_pool_id", "mcp_session_id", "envelope_state", "args_dropped", "address_verified", "agent_id", "agent_wallet", "capped_drops", "distinct_id", "$mcp_tool_name", "$process_person_profile"];
    for (const k of reserved) expect(isReservedEventKey(k), k).toBe(true);
    // Dotted paths never collide (the API's own keys: `action.order.maker`).
    for (const k of ["action.order.maker", "filters.pool_id", "params.chain_id", "side"]) expect(isReservedEventKey(k), k).toBe(false);
    const P = `0x${"ab".repeat(32)}`;
    const out = withoutReservedKeys({ client: "x", product: "y", env: "prod", app_version: "1", chain_id: 1, address_verified: true, pool_id: P, "market.pool_id": P, side: "BUY" }, poolAliases({ pool_id: P, "market.pool_id": P }));
    expect(out.properties).toEqual({ "market.pool_id": P, side: "BUY" });
    // The pool id the alias carries with the same value is not counted; the other six are.
    expect(out.dropped).toBe(6);
    // Through a schema whose root fields are named like event properties: the event keeps the
    // core's values and the args_dropped count says the arguments lost them.
    const shape = z.object({ client: z.enum(["evil"]), env: z.enum(["prod"]), product: z.enum(["api"]), address_verified: z.boolean(), args_dropped: z.number(), side: z.enum(["SELL"]) });
    const kept = shapeFilteredArgs({ client: "evil", env: "prod", product: "api", address_verified: true, args_dropped: 0, side: "SELL" }, z.toJSONSchema(shape, { io: "input" }), { addresses: true, hashes: true });
    expect(Object.keys(kept.properties)).toHaveLength(6);
    const filtered = withoutReservedKeys(kept.properties);
    expect(filtered).toEqual({ properties: { side: "SELL" }, dropped: 5 });
    // Every registry example: the kept argument keys never name a top-level event property, and
    // the event's values for those names are the fixed ones.
    for (const def of REGISTRY) {
      for (const ex of TOOL_EXAMPLES[def.name] ?? []) {
        const t = toolArgProperties(def.name, ex.input);
        for (const k of Object.keys(t?.properties ?? {})) expect(isReservedEventKey(k), `${def.name} ${k}`).toBe(false);
      }
    }
    const { events } = await capture("cork_prepare_phoenix", TOOL_EXAMPLES.cork_prepare_phoenix![0]!.input);
    expect(events[0]!.properties).toMatchObject({ product: "mcp", client: "claude-code", address_verified: false, pool_id: DEMO_POOL_ID });
  });

  it("invalid arguments, an unknown tool, or no arguments keep nothing (and never throw)", async () => {
    expect(toolArgProperties("cork_submit", { ...LOP_SUBMIT, chainId: 7 })).toBeUndefined();
    expect(toolArgProperties("cork_nope", { chainId: 1 })).toBeUndefined();
    expect(toolArgProperties("cork_query", "not an object")).toBeUndefined();
    const { events } = await capture("unknown_tool", { account: ADDRESS });
    expect(events[0]!.properties).toMatchObject({ distinct_id: "anon_mcp-claude-code", $process_person_profile: false });
    expect(JSON.stringify(events)).not.toContain(ADDRESS.slice(2, 12));
  });

  it("the opt-in gate still holds: with analytics off, a write call over the hosted server sends nothing", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}");
    }) as typeof fetch;
    for (const env of [{}, { ...PROD, DO_NOT_TRACK: "1" }, { ...PROD, CORK_TELEMETRY: "0" }, { ...PROD, CORK_MCP_ANALYTICS: "0" }]) expect(analyticsFromEnv(env).analytics).toBeUndefined();
    const { client } = await connect(createHttpHandler({ ctx: { nowSeconds: NOW } }));
    await client.callTool({ name: "cork_submit", arguments: LOP_SUBMIT });
    expect(calls.filter((u) => u.includes("posthog"))).toEqual([]);
  });
});

describe("session token: the initialize handshake carried across stateless requests", () => {
  it("round-trips, and re-validates everything a client sends back", () => {
    const tok = encodeSessionToken({ sessionId: `ses_${"a".repeat(32)}`, clientName: "cursor", clientVersion: "1.2" });
    expect(decodeSessionToken(tok)).toEqual({ sessionId: `ses_${"a".repeat(32)}`, clientName: "cursor", clientVersion: "1.2" });
    expect(decodeSessionToken(null)).toBeUndefined();
    expect(decodeSessionToken("not-ours")).toBeUndefined();
    expect(decodeSessionToken(`ckm1.${Buffer.from('{"s":"ses_x"}').toString("base64url")}`)).toBeUndefined();
    // A forged token's name is mapped onto the closed client list; a sensitive version is "other".
    const forged = `ckm1.${Buffer.from(JSON.stringify({ s: `ses_${"b".repeat(32)}`, n: `evil name ${ADDRESS}`, v: ADDRESS })).toString("base64url")}`;
    expect(decodeSessionToken(forged)).toEqual({ sessionId: `ses_${"b".repeat(32)}`, clientName: "other", clientVersion: "other" });
  });
});

describe("exception capture scrubs what must never leave", () => {
  it("$exception keeps the class and code locations, drops URL paths, e-mails and tokens (addresses stay: they are public and not secrets)", async () => {
    const ph = posthogStub();
    const { analytics } = startWith(ph);
    const err = new RangeError(`boom for ${ADDRESS} via https://rpc.example.com/v2/SECRETTOKENSECRETTOKEN?x=1 by a@b.com key ${"kA9".repeat(14)}`);
    analytics.toolCall({ tool: "cork_query", durationMs: 3, state: "unavailable", isError: true, errorType: "internal_error", error: err }, {});
    await analytics.flush();
    const events = ph.batches.flatMap((b) => b.batch);
    expect(events.map((e) => e.event)).toEqual(["$mcp_tool_call", "$exception"]);
    const ex = events[1]!.properties as { $exception_list: Array<{ type: string; value: string; stacktrace: { frames: Array<Record<string, unknown>> } }>; $exception_level: string; $mcp_tool_name: string };
    expect(ex.$exception_level).toBe("error");
    expect(ex.$mcp_tool_name).toBe("cork_query");
    expect(ex.$exception_list[0]!.type).toBe("RangeError");
    const frames = ex.$exception_list[0]!.stacktrace.frames;
    expect(frames.length).toBeGreaterThan(0);
    // PostHog's Node raw frame shape (cymbal RawNodeFrame): platform tag + a filename string.
    for (const f of frames) {
      expect(f.platform).toBe("node:javascript");
      expect(typeof f.filename).toBe("string");
    }
    // The core scrubs each `at` line with scrubText, whose token rule also eats a file path
    // that reads as a 32+ char mixed-case run (the mutation sandbox's /tmp/cork-mutation-XxYy12/…);
    // where the checkout path survives scrubText, the frame keeps its repo-relative file.
    if (scrubText(import.meta.filename) === import.meta.filename) expect(frames.some((f) => f.filename === "packages/mcp/test/analytics.test.ts" && f.in_app === true)).toBe(true);
    else expect(frames.every((f) => !String(f.filename).includes("cork-mutation"))).toBe(true);
    const raw = ph.raw();
    for (const leak of ["SECRETTOKEN", "a@b.com", "kA9kA9kA9", "/home/"]) expect(raw).not.toContain(leak);
    // scrubText keeps addresses and 32-byte hashes in error text.
    expect(ex.$exception_list[0]!.value).toContain(ADDRESS);
    expect(ex.$exception_list[0]!.value).toContain("https://rpc.example.com/");
  });

  it("the former scrub() cases through scrubText: secrets and personal shapes still never leave (the full rule set is vectors.json)", () => {
    const cases: Array<[string, string[]]> = [
      ["fetch https://arb-mainnet.g.alchemy.com/v2/KEY123 failed", ["KEY123"]],
      ["wss://user:pw@rpc.example.org:8546/abc?x=1", ["user", ":pw", "abc", "x=1"]],
      ["ipfs://bafy/abc", ["/abc"]],
      ["api_key=abc token=xyz client_secret=s password=hunter2 auth=1 signature=0xff", ["=abc", "xyz", "=s ", "hunter2", "=1 ", "0xff"]],
      ['{"apiKey":"abc"}', ["abc"]],
      ["Authorization: Bearer abc.def", ["abc.def"]],
      ["password: x, token: y, x-api-key: z", [": x", ": y", ": z"]],
      ["key AKIAIOSFODNN7EXAMPLE leaked", ["AKIAIOSFODNN7EXAMPLE"]],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", ["eyJhbGciOiJIUzI1NiJ9"]],
      ["peer 10.0.0.1:8545 at 12:30:45", ["10.0.0.1"]],
      ["peer 2001:db8:85a3::8a2e:370:7334 and ::1 and fe80:0:0:0:1:2:3:4", ["2001:db8", "fe80"]],
      ["open /home/alice/x, /Users/Bob/y, C:\\Users\\carol\\z", ["alice", "Bob", "carol"]],
      ["mail a.b@c.io", ["a.b@c.io"]],
    ];
    for (const [raw, gone] of cases) for (const g of gone) expect(scrubText(raw), raw).not.toContain(g);
    // Ordinary text survives.
    expect(scrubText("signal: aborted after 30000 ms")).toBe("signal: aborted after 30000 ms");
    // What scrubText keeps on purpose (addresses, hashes and numbers are not secrets).
    expect(scrubText("reverted at 0xdeadbeefcafe in pool 0xabc123")).toBe("reverted at 0xdeadbeefcafe in pool 0xabc123");
  });

  it("frames: the core's stackFrames (err.stack only, after the message), then file and function scrubbed", () => {
    expect(rawFrames("")).toEqual([]);
    expect(rawFrames(stackFrames("not an error"))).toEqual([]);
    const frames = rawFrames("    at inner (/app/packages/core/src/a.ts:1:2)\n    at outer (/app/node_modules/b/c.js:3:4)\n    at run (/srv/secret/d.ts:5:6)");
    // The <external> frame keeps no function name.
    expect(frames.map((f) => f.function)).toEqual(["<anonymous>", "outer", "inner"]);
    expect(frames.map((f) => f.filename)).toEqual(["<external>", "node_modules/b/c.js", "packages/core/src/a.ts"]);
    expect(frames.map((f) => f.in_app)).toEqual([false, false, true]);
    expect(rawFrames("    at x (/$bunfs/root/ch:10:20)")[0]).toMatchObject({ filename: "/$bunfs/root/ch", in_app: true, platform: "node:javascript" });
    // A message that carries frame-shaped lines is message, not stack (the core cuts it).
    const e = new Error(`bad\n    at injected_fn (/app/packages/injected.ts:1:2)\n    at ${ADDRESS} (/home/alice/${ADDRESS}.ts:1:2)`);
    const parsed = rawFrames(stackFrames(e));
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.map((f) => f.function)).not.toContain("injected_fn");
    expect(parsed.map((f) => f.filename)).not.toContain("packages/injected.ts");
    expect(JSON.stringify(parsed)).not.toContain("1111111111");
    expect(JSON.stringify(parsed)).not.toContain("alice");
    // Non-frame lines are skipped; an <external> frame keeps no function name.
    const mixed = rawFrames("  not a frame\n    at a (/app/packages/a.ts:1:1)\n    at secretFn (/tmp/x.ts:2:2)");
    expect(mixed.map((f) => [f.function, f.filename])).toEqual([["<anonymous>", "<external>"], ["a", "packages/a.ts"]]);
    // Function names lose hex and e-mail shapes.
    expect(rawFrames("    at handler_0xdeadbeefcafe a@b.com (/app/packages/x.ts:1:1)")[0]!.function).toBe("handler_0x");
  });
});

describe("attribution headers of the local surfaces", () => {
  it("stdio MCP: X-Cork-Client cork-cli-mcp/<v>, User-Agent (surface=mcp; client=<the MCP client>)", async () => {
    const venue = venueStub();
    const server = createCorkServer({ nowSeconds: NOW, venueFetch: venue.venueFetch });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "cursor-vscode", version: "1.0" });
    await client.connect(clientT);
    await client.callTool({ name: "cork_query", arguments: { resource: "rfqs" } });
    expect(venue.clients.length).toBeGreaterThan(0);
    for (const c of venue.clients) expect(c).toBe(`cork-cli-mcp/${V}`);
    for (const ua of venue.agents) expect(ua).toBe(formatCorkUserAgent({ client: "cork-cli-mcp", comment: { surface: "mcp", client: "cursor" } }));
  });

  it("CLI: cork-cli/<v>", async () => {
    const venue = venueStub();
    const r = await runCli(["query", "rfq", "--json"], { nowSeconds: NOW, venueFetch: venue.venueFetch });
    expect(r.code).toBe(EXIT.ok);
    expect(venue.clients.length).toBeGreaterThan(0);
    for (const c of venue.clients) expect(c).toBe(`cork-cli/${V}`);
    for (const ua of venue.agents) expect(ua).toBe(formatCorkUserAgent({ client: "cork-cli" }));
  });
});
