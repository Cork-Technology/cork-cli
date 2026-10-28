// cork-telemetry-core@40e0e86 analytics-core.test.ts
/**
 * Core tests for analytics.ts, log-export.ts and telemetry-env.ts. CORE FILE:
 * copy as is (only import paths may change). Catalog-free: every init
 * passes the fixture CATALOG (`initAnalytics(env, { catalog: CATALOG, catalog })`), so a repo with no
 * events runs it too. No module mock: any runner (vitest, bun).
 */
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";

import { pinoDestination } from "../src/lib/log-export.js";
import { parseTelemetryEnv } from "../src/lib/telemetry-env.js";
import { exportLog, type Catalog, type EventName, flushAnalytics, MAX_EVENTS_PER_CALLER_PER_MINUTE, type InitOptions, EXCEPTION_DEDUPE_MS, MAX_DEDUPE_KEYS, PROJECT_KEYS, resetAnalyticsForTests, analyticsEnabled, captureException, identityFor, initAnalytics, trackServer, trackingBlocker, shutdownAnalytics, logExportConfig, type AnalyticsSink } from "../src/lib/analytics.js";

/** Fixture catalog (service id = svc_<service>). */
const CATALOG: Catalog = { PRODUCT: "example", SERVICE: "example-worker", EVENTS: { thing_done: "thing_done" } };
/** The fixture catalog's one event (typed as the repo's EventName). */
const EVENT = "thing_done" as unknown as EventName;

function fake() {
  const calls: { kind: string; args: unknown[] }[] = [];
  const sink: AnalyticsSink = {
    capture: (m) => void calls.push({ kind: "capture", args: [m] }),
    groupIdentify: (m) => void calls.push({ kind: "group", args: [m] }),
    captureException: (...a) => void calls.push({ kind: "exception", args: a }),
    flush: async () => {},
    shutdown: async () => {},
  };
  return { sink, calls };
}

describe("env", () => {
  it("blank = default, bad = default", () => {
    const e = parseTelemetryEnv({ POSTHOG_KEY: "  ", POSTHOG_HOST: "", CORK_ENV: "production", POSTHOG_LOGS: "maybe", POSTHOG_RELEASE: "ABCDEF0123456789abcdef", POSTHOG_LOGS_MAX_PER_SECOND: "-3", DO_NOT_TRACK: "" });
    expect(e).toMatchObject({ POSTHOG_KEY: "", POSTHOG_HOST: "https://eu.i.posthog.com", CORK_ENV: "staging", POSTHOG_LOGS: true, POSTHOG_RELEASE: "abcdef012345", POSTHOG_LOGS_MAX_PER_SECOND: 200, DO_NOT_TRACK: false, CORK_TELEMETRY: true });
    expect(parseTelemetryEnv({ POSTHOG_HOST: "https://eu.i.posthog.com/", POSTHOG_RELEASE: "nope" })).toMatchObject({ POSTHOG_HOST: "https://eu.i.posthog.com", POSTHOG_RELEASE: undefined });
  });
  it("guard", () => {
    const g = (k: string, e: string, extra = {}) => trackingBlocker(parseTelemetryEnv({ POSTHOG_KEY: k, CORK_ENV: e, ...extra }));
    expect(g(PROJECT_KEYS.prod, "prod")).toBeUndefined();
    expect(g(PROJECT_KEYS.prod, "staging")).toMatch(/prod project key/);
    expect(g(PROJECT_KEYS.staging, "prod")).toMatch(/staging project key/);
    expect(g(PROJECT_KEYS.staging, "")).toBeUndefined();
    expect(g(PROJECT_KEYS.status, "prod")).toBeUndefined();
    expect(g(PROJECT_KEYS.status, "staging")).toMatch(/prod project key with CORK_ENV=staging/);
    expect(g(PROJECT_KEYS.status, "")).toMatch(/prod project key/);
    expect(g("phc_other", "staging")).toMatch(/not a Cork/);
    expect(g(PROJECT_KEYS.prod, "prod", { DO_NOT_TRACK: "1" })).toBe("DO_NOT_TRACK=1");
    expect(g(PROJECT_KEYS.prod, "prod", { CORK_TELEMETRY: "0" })).toBe("CORK_TELEMETRY=0");
  });
});

describe("analytics", () => {
  beforeEach(() => resetAnalyticsForTests());
  it("off without key, warns once on mismatch", () => {
    const warns: string[] = [];
    expect(initAnalytics(parseTelemetryEnv({}), { catalog: CATALOG, warn: (m) => warns.push(m) }).enabled).toBe(false);
    initAnalytics(parseTelemetryEnv({ POSTHOG_KEY: PROJECT_KEYS.prod }), { catalog: CATALOG, warn: (m) => warns.push(m) });
    initAnalytics(parseTelemetryEnv({ POSTHOG_KEY: PROJECT_KEYS.prod }), { catalog: CATALOG, warn: (m) => warns.push(m) });
    expect(warns.length).toBe(1);
    expect(analyticsEnabled()).toBe(false);
  });
  it("kill switch beats an injected sink", () => {
    const { sink } = fake();
    expect(initAnalytics(parseTelemetryEnv({ DO_NOT_TRACK: "1" }), { catalog: CATALOG, sink }).enabled).toBe(false);
  });
  it("tracks with identity, groups, base props, caps", async () => {
    const { sink, calls } = fake();
    initAnalytics(parseTelemetryEnv({ POSTHOG_RELEASE: "0123456789abcdef", POSTHOG_EVENTS_MAX_PER_DAY: "2" }), { catalog: CATALOG, sink, secretEnv: {}, warn: () => {} });
    const id = identityFor({ wallet: { address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", verified: false }, org: "acme", client: "cork-cli" });
    trackServer(EVENT, { chain_id: 1, reason: "free text", nested: { poolId: "0x" + "11".repeat(32) } }, id);
    trackServer(EVENT, {}, id);
    trackServer(EVENT, {}, id);
    const caps = calls.filter((c) => c.kind === "capture");
    expect(caps.length).toBe(2);
    const m = caps[0]!.args[0] as Record<string, any>;
    expect(m.distinctId).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(m.groups).toEqual({ organization: "acme" });
    expect(m.properties).toMatchObject({ product: "example", app_version: "0123456789ab", env: "staging", $geoip_disable: true, address_verified: false, chain_id: 1, pool_id: "0x" + "11".repeat(32) });
    expect(m.properties.$process_person_profile).toBeUndefined();
    expect(m.properties.reason).toBeUndefined();
    expect(calls.filter((c) => c.kind === "group").length).toBe(1);
    expect(logExportConfig()).toMatchObject({ url: "https://eu.i.posthog.com/i/v1/logs", maxPerSecond: 200 });
  });
  it("exceptions: rebuilt, scrubbed, deduped", () => {
    const { sink, calls } = fake();
    initAnalytics(parseTelemetryEnv({}), { catalog: CATALOG, sink, secretEnv: {}, warn: () => {} });
    const err = Object.assign(new Error("fetch https://rpc.example.org/v2/abcdefgh123 failed"), { body: "secret body" });
    captureException(err, { site: "orders.post", props: { route: "/orders/v1", ip: "1.2.3.4" } });
    captureException(err, { site: "orders.post" });
    const ex = calls.filter((c) => c.kind === "exception");
    expect(ex.length).toBe(1);
    const [e, did, props] = ex[0]!.args as [Error, string, Record<string, unknown>];
    expect(e.message).toBe("fetch https://rpc.example.org/[redacted] failed");
    expect(did).toBe("svc_example-worker");
    expect(props).toMatchObject({ site: "orders.post", $process_person_profile: false });
    expect(props.ip).toBeUndefined();
    expect(props.route).toBeUndefined(); // free text-shaped string: not an enum token
  });
  it("identity forms", () => {
    expect(identityFor({ keyId: "acme-prod" }).distinctId).toMatch(/^key_[0-9a-f]{16}$/);
    expect(identityFor({ client: "cork-cli" }).distinctId).toBe("anon_cork-cli");
    expect(identityFor({}).distinctId).toBe("anon_unknown");
    expect(identityFor({ agentId: "example-agent", agentWallet: "0x" + "AB".repeat(20) })).toMatchObject({ distinctId: "agent_example-agent", person: false, properties: { agent_wallet: "0x" + "ab".repeat(20) } });
    expect(identityFor({ service: "example-worker" }).distinctId).toBe("svc_example-worker");
    expect(identityFor({ service: "example-service-dashboard" }).distinctId).toBe("svc_example-service-dashboard");
    expect(identityFor({ service: "example-service-probe-example-agent-one-eu" }).distinctId).toBe("svc_example-service-probe-example-agent-one-eu");
    expect(identityFor({ wallet: { address: "0x" + "0".repeat(40), verified: true }, client: "x" }).distinctId).toBe("anon_x");
  });
  it("dedupe: extra key parts split windows, bounded", () => {
    const { sink, calls } = fake();
    initAnalytics(parseTelemetryEnv({}), { catalog: CATALOG, sink, secretEnv: {}, warn: () => {} });
    const err = new Error("decode failed");
    const a = "0x" + "aa".repeat(20);
    captureException(err, { site: "handler", dedupe: [42161, a] });
    captureException(err, { site: "handler", dedupe: [42161, a.toUpperCase().replace("0X", "0x")] });
    captureException(err, { site: "handler", dedupe: [42161, "0x" + "bb".repeat(20)] });
    captureException(err, { site: "handler", dedupe: ["x".repeat(66) + "1"] });
    captureException(err, { site: "handler", dedupe: ["x".repeat(66) + "2"] });
    expect(calls.filter((c) => c.kind === "exception").length).toBe(3);
  });
  it("dedupe: a full memory refuses new keys, keeps old windows, warns once", () => {
    const { sink, calls } = fake();
    const warns: string[] = [];
    let now = 1_000_000_000_000;
    initAnalytics(parseTelemetryEnv({ POSTHOG_EXCEPTIONS_MAX_PER_DAY: "100000" }), { catalog: CATALOG, sink, secretEnv: {}, warn: (m) => warns.push(m), now: () => now });
    const err = new Error("boom");
    for (let i = 0; i < MAX_DEDUPE_KEYS; i += 1) captureException(err, { dedupe: [i] });
    now += 60_000;
    const sent = () => calls.filter((c) => c.kind === "exception").length;
    const before = sent();
    captureException(err, { dedupe: ["new-1"] });
    captureException(err, { dedupe: ["new-2"] });
    captureException(err, { dedupe: [0] }); // old window still holds
    expect(sent()).toBe(before);
    expect(warns.filter((w) => w.includes("dedupe memory full")).length).toBe(1);
    captureException(err, { dedupe: ["fatal"], fatal: true });
    expect(sent()).toBe(before + 1);
    now += EXCEPTION_DEDUPE_MS;
    captureException(err, { dedupe: ["new-3"] });
    expect(sent()).toBe(before + 2);
  });
  it("capKey splits the per-caller cap and is never sent", () => {
    const { sink, calls } = fake();
    initAnalytics(parseTelemetryEnv({ POSTHOG_EVENTS_MAX_PER_DAY: "100000" }), { catalog: CATALOG, sink, secretEnv: {}, warn: () => {} });
    const a = identityFor({ client: "mcp-claude-code", capKey: "ses_a" });
    const b = identityFor({ client: "mcp-claude-code", capKey: "ses_b" });
    expect(a.distinctId).toBe(b.distinctId);
    for (let i = 0; i < MAX_EVENTS_PER_CALLER_PER_MINUTE + 1; i += 1) trackServer(EVENT, {}, a);
    trackServer(EVENT, {}, b);
    const caps = calls.filter((c) => c.kind === "capture");
    expect(caps.length).toBe(MAX_EVENTS_PER_CALLER_PER_MINUTE + 1);
    expect(JSON.stringify(caps)).not.toContain("ses_");
  });
  it("frames come from err.stack only, not from message lines", () => {
    const { sink, calls } = fake();
    initAnalytics(parseTelemetryEnv({}), { catalog: CATALOG, sink, secretEnv: {}, warn: () => {} });
    const err = new Error("upstream said:\n    at evilFrame (/tmp/x.js:1:1)\ndone");
    captureException(err, { site: "x" });
    const [safe] = calls.find((c) => c.kind === "exception")!.args as [Error];
    expect(safe.message).toContain("at evilFrame");
    expect(safe.stack).not.toContain("evilFrame");
    expect(safe.stack).toMatch(/^Error: upstream said:\n\s+at /);
  });
  it("worker: idempotent init, flushAnalytics waits for pending captures (real posthog-node)", async () => {
    let sent = 0;
    const fetch = (async (_url: string, init: { body?: unknown }) => {
      const raw = init.body;
      const text =
        typeof raw === "string" ? raw : gunzipSync(raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : (raw as Uint8Array)).toString();
      sent += (JSON.parse(text).batch ?? []).length;
      return { status: 200, text: async () => "{}", json: async () => ({}) };
    }) as unknown as NonNullable<InitOptions["fetch"]>;
    const env = parseTelemetryEnv({ POSTHOG_KEY: PROJECT_KEYS.staging, CORK_ENV: "staging" });
    expect(initAnalytics(env, { catalog: CATALOG, runtime: "worker", fetch, secretEnv: {}, warn: () => {} })).toEqual({ enabled: true, reason: undefined });
    initAnalytics(env, { catalog: CATALOG, runtime: "worker", fetch, secretEnv: {}, warn: () => {} }); // 2nd invocation: same client
    for (let i = 0; i < 3; i += 1) captureException(new Error(`e${i}`), { site: `s${i}` });
    await flushAnalytics();
    expect(sent).toBe(3);
  });
  it("logs: pino lines -> OTLP JSON, min level, caps, scrubbed attributes", async () => {
    const posts: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      posts.push({ url, init });
      return { status: 200, body: null };
    }) as unknown as NonNullable<InitOptions["fetch"]>;
    const env = parseTelemetryEnv({ POSTHOG_RELEASE: "0123456789ab", POSTHOG_LOGS_MIN_LEVEL: "warn", POSTHOG_LOGS_MAX_PER_SECOND: "2" });
    initAnalytics(env, { catalog: CATALOG, sink: fake().sink, fetch, secretEnv: {}, warn: () => {}, runtime: "worker" });
    const dest = pinoDestination(exportLog);
    const t0 = 1_800_000_000_000;
    const addr = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    dest.write(JSON.stringify({ level: 30, time: t0, msg: "info is below the floor" }));
    for (const m of ["a", "b", "c"]) dest.write(JSON.stringify({ level: 40, time: t0, msg: m }));
    dest.write(
      JSON.stringify({ level: 50, time: t0 + 1_000, msg: "fetch https://rpc.example.org/v2/abcd1234efgh failed", route: "/orders/:id", maker: addr, reason: "free text", password: "x", pid: 1 }),
    );
    dest.write("not json");
    await flushAnalytics();
    expect(posts.length).toBe(1);
    const post = posts[0]!;
    expect(post.url).toBe("https://eu.i.posthog.com/i/v1/logs");
    expect(post.init.headers.authorization).toMatch(/^Bearer /);
    const payload = JSON.parse(post.init.body);
    const res = Object.fromEntries(payload.resourceLogs[0].resource.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
    expect(res).toMatchObject({ "service.name": "example-worker", "service.version": "0123456789ab", "deployment.environment": "staging", product: "example" });
    const recs = payload.resourceLogs[0].scopeLogs[0].logRecords;
    expect(recs.map((r: any) => r.body.stringValue)).toEqual(["a", "b", "log export cap: 1 record(s) dropped", "fetch https://rpc.example.org/[redacted] failed"]);
    const attrs = Object.fromEntries(recs[3].attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
    expect(attrs).toEqual({ route: "/orders/:id", maker: addr.toLowerCase() });
    expect(recs[3].severityText).toBe("ERROR");
  });
  it("logs: err.message kept after scrubText; passthrough on-chain log fields survive", async () => {
    const posts: string[] = [];
    const fetch = (async (_url: string, init: { body: string }) => {
      posts.push(init.body);
      return { status: 200, body: null };
    }) as unknown as NonNullable<InitOptions["fetch"]>;
    const hex = (v: unknown) => (typeof v === "string" && /^0x[0-9a-f]*$/.test(v) ? v.slice(0, 16_386) : undefined);
    const topics = (v: unknown) => (Array.isArray(v) ? v.filter((t) => typeof t === "string" && /^0x[0-9a-f]{64}$/.test(t)).slice(0, 4) : undefined);
    initAnalytics(parseTelemetryEnv({}), { catalog: CATALOG,
      sink: fake().sink,
      fetch,
      secretEnv: {},
      warn: () => {},
      runtime: "worker",
      logs: { passthrough: { log_data: hex, log_topics: topics } },
    });
    const topic = "0x" + "ab".repeat(32);
    const data = "0x" + "00".repeat(200);
    pinoDestination(exportLog).write(
      JSON.stringify({
        level: 50,
        msg: "decode failed",
        err: { type: "AbiDecodingDataSizeTooSmallError", message: "call https://rpc.example.org/v2/abcd1234efgh with api_key=notreal failed: data too small" },
        log_data: data,
        log_topics: [topic, "not-a-topic"],
        note: "free text stays out",
      }),
    );
    await flushAnalytics();
    const rec = JSON.parse(posts[0]!).resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = Object.fromEntries(rec.attributes.map((a: any) => [a.key, a.value]));
    expect(attrs.err_type).toEqual({ stringValue: "AbiDecodingDataSizeTooSmallError" });
    expect(attrs.err_message).toEqual({ stringValue: "call https://rpc.example.org/[redacted] with api_key=[redacted] failed: data too small" });
    expect(attrs.log_data).toEqual({ stringValue: data });
    expect(attrs.log_topics).toEqual({ arrayValue: { values: [{ stringValue: topic }] } });
    expect(attrs.note).toBeUndefined();
  });
  it("logs: off with POSTHOG_LOGS=false", async () => {
    let posted = 0;
    const fetch = (async () => {
      posted += 1;
      return { status: 200, body: null };
    }) as unknown as NonNullable<InitOptions["fetch"]>;
    initAnalytics(parseTelemetryEnv({ POSTHOG_LOGS: "false" }), { catalog: CATALOG, sink: fake().sink, fetch, secretEnv: {}, warn: () => {} });
    expect(logExportConfig()).toBeUndefined();
    exportLog({ level: "error", body: "x" });
    await flushAnalytics();
    expect(posted).toBe(0);
  });
  it("shutdown", async () => { await shutdownAnalytics(); expect(analyticsEnabled()).toBe(false); });
});
