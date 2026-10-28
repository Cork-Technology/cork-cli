// cork-telemetry-core@40e0e86 analytics.ts
/**
 * Cork PostHog core (Node, posthog-node). CORE FILE: copy as is.
 *
 * The ONLY file that imports posthog-node. Block it elsewhere with
 * `no-restricted-imports` (or a guard test).
 *
 * Repo-specific parts live elsewhere:
 * - analytics-catalog.ts: PRODUCT, SERVICE, EVENTS;
 * - initAnalytics(env, { passthrough }): exact keys that skip the shape
 *   filter, each with its own validator (e.g. public on-chain log fields);
 * - registerSecret() calls at boot for secrets that are not in env;
 * - the schema-typed extractor (scrub.ts `PropertyExtractor`).
 *
 * Sent: counts, ids, enums, amounts, chain / pool ids, addresses, order and
 * tx hashes, the partner org. Never: IP ($ip removed, $geoip_disable on
 * every event), device ids, emails, free text in properties, bodies,
 * signatures / calldata, secrets.
 *
 * Kill switch: POSTHOG_KEY empty, DO_NOT_TRACK=1, CORK_TELEMETRY=0, or a
 * key<->env mismatch = no client, no timer, no network.
 */
import { createHash } from "node:crypto";
// TEMPLATE-DEVIATION http-sink: the HTTP transport in posthog-http.ts (POST /batch/, at most
// once, no retry) instead of posthog-node. This file ships in the public `ch` binary, which must
// not carry a PostHog SDK.
import { PostHogHttpSink as PostHog, type PostHogOptions } from "./posthog-http.js";

import { EVENTS, PRODUCT, SERVICE, type EventName } from "./analytics-catalog.js";
import { createLogExporter, type LogExportConfig, type LogExporter, type LogExporterOptions, type LogRecordInput } from "./log-export.js";
import type { TelemetryEnv } from "./telemetry-env.js";
import {
  CREDENTIAL_PREFIX_RE,
  isAddress,
  registerEnvSecrets,
  scrubProperties,
  scrubText,
  type Properties,
} from "./scrub.js";

export { EVENTS, PRODUCT, SERVICE, type EventName, type LogExportConfig, type LogRecordInput };

/** The shape of analytics-catalog.ts. */
export type Catalog = { PRODUCT: string; SERVICE: string; EVENTS: Readonly<Record<string, string>> };
const REPO_CATALOG: Catalog = { PRODUCT, SERVICE, EVENTS };

// ---------------------------------------------------------------------------
// Projects and the key <-> env guard
// ---------------------------------------------------------------------------

/** Public ingestion tokens (EU cloud). Write-only, public-safe. */
export const PROJECT_KEYS = {
  prod: "phc_ktQQriXeDWDvNGf77xxrDmvrp8SKCzZAHEKs9ZP7UD8N",
  status: "phc_sMjyFgzg5DBE2CRwfxdXRwX3FnGN4GMJDMJWEvzEAMzt",
  staging: "phc_uYXWW5y6FzTqqxkLEEfSopsLmTYu5VGiCcoG3FhRbXnU",
} as const;

/** The CORK_ENV each project key requires. */
export const KEY_ENV: ReadonlyMap<string, TelemetryEnv["CORK_ENV"]> = new Map<string, TelemetryEnv["CORK_ENV"]>([
  [PROJECT_KEYS.prod, "prod"],
  [PROJECT_KEYS.status, "prod"],
  [PROJECT_KEYS.staging, "staging"],
]);

/**
 * Why tracking stays off, or undefined when it may run. Symmetric: a prod
 * key needs CORK_ENV=prod, the staging key needs CORK_ENV=staging, any other
 * key is refused. Staging never writes to prod, prod is never labelled staging.
 */
export function trackingBlocker(env: TelemetryEnv): string | undefined {
  if (env.DO_NOT_TRACK) return "DO_NOT_TRACK=1";
  if (!env.CORK_TELEMETRY) return "CORK_TELEMETRY=0";
  if (!env.POSTHOG_KEY) return "POSTHOG_KEY unset";
  const required = KEY_ENV.get(env.POSTHOG_KEY);
  if (required === undefined) return "POSTHOG_KEY is not a Cork project key";
  return env.CORK_ENV === required ? undefined : `${required} project key with CORK_ENV=${env.CORK_ENV}`;
}

/** Reasons that are a normal "off" (no warning). The guard reasons warn once. */
const SILENT = new Set(["DO_NOT_TRACK=1", "CORK_TELEMETRY=0", "POSTHOG_KEY unset"]);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type Caller = {
  /** The acting wallet of a write. Signature auth: verified = true. API key / MCP claim: false. */
  wallet?: { address: string; verified: boolean };
  /** Cork's own agent (manifest name). */
  agentId?: string;
  /** The agent's own wallet (Cork data), sent as `agent_wallet`. */
  agentWallet?: string;
  /** NON-secret key identifier (key name / id). Never the key secret, never its stored hash. */
  keyId?: string;
  /** Partner organization (API key name): the `organization` group. */
  org?: string;
  /** Machine process with no caller (a worker, a scheduled job): `svc_<service>`. */
  service?: string;
  /** Mapped client value (`cork-cli`, `cork-mcp`, ...), never raw header text. */
  client?: string;
  /**
   * Per-caller cap key when distinct_id is shared (all `anon_mcp-<client>`
   * sessions): e.g. an MCP session id. Memory only, never sent.
   */
  capKey?: string;
};

export type Identity = {
  distinctId: string;
  /** true only for a wallet: the event creates / updates that wallet's person. */
  person: boolean;
  /** `organization` group key. */
  org?: string;
  /** Identity facts added to the event (`address_verified`, `agent_id`, `agent_wallet`). */
  properties: Properties;
  /** Key of the per-caller minute cap instead of distinct_id. Never sent. */
  capKey?: string;
};

const ZERO_ADDRESS = /^0x0{40}$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
/** Lowercase `[a-z0-9_-]`, max 48; credential- or hex-shaped values become the fallback. */
const idToken = (v: string | undefined, fallback: string): string => {
  const t = (v ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (t === "" || CREDENTIAL_PREFIX_RE.test(t) || /[0-9a-f]{16,}/.test(t)) return fallback;
  return t;
};

export function keyDistinctId(keyId: string): string {
  return `key_${createHash("sha256").update(keyId, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * One identity per event, first match wins:
 * 1. wallet  -> the address lowercased, person profile ON, `address_verified`;
 * 2. agentId -> `agent_<id>`, `agent_wallet` when known;
 * 3. keyId   -> `key_<16 hex of sha256(key id)>`;
 * 4. service -> `svc_<service>`;
 * 5. else    -> `anon_<client>`.
 * Only (1) has a person profile. `org` adds the `organization` group to any
 * of them. Never alias, merge or `$identify` wallets: one key acts for many users.
 */
export function identityFor(c: Caller): Identity {
  const org = c.org !== undefined && ORG_RE.test(c.org) ? c.org : undefined;
  const capKey = typeof c.capKey === "string" && c.capKey !== "" ? c.capKey.slice(0, 128) : undefined;
  const base = { ...(org ? { org } : {}), ...(capKey ? { capKey } : {}) };
  if (c.wallet && isAddress(c.wallet.address) && !ZERO_ADDRESS.test(c.wallet.address)) {
    return {
      ...base,
      distinctId: c.wallet.address.toLowerCase(),
      person: true,
      properties: { address_verified: c.wallet.verified },
    };
  }
  if (c.agentId !== undefined) {
    const id = idToken(c.agentId, "unknown");
    const props: Properties = { agent_id: id };
    if (c.agentWallet && isAddress(c.agentWallet) && !ZERO_ADDRESS.test(c.agentWallet)) {
      props.agent_wallet = c.agentWallet.toLowerCase();
    }
    return { ...base, distinctId: `agent_${id}`, person: false, properties: props };
  }
  if (c.keyId) return { ...base, distinctId: keyDistinctId(c.keyId), person: false, properties: {} };
  if (c.service !== undefined) return { ...base, distinctId: `svc_${idToken(c.service, "unknown")}`, person: false, properties: {} };
  return { ...base, distinctId: `anon_${idToken(c.client, "unknown")}`, person: false, properties: {} };
}

// ---------------------------------------------------------------------------
// Sink (posthog-node, or a fake in tests)
// ---------------------------------------------------------------------------

/** The subset of posthog-node this file uses. Tests inject a fake. */
export interface AnalyticsSink {
  capture(message: {
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
    groups?: Record<string, string>;
    disableGeoip?: boolean;
  }): void;
  groupIdentify?(message: {
    groupType: string;
    groupKey: string;
    properties?: Record<string, unknown>;
    disableGeoip?: boolean;
  }): void;
  captureException(error: unknown, distinctId?: string, additionalProperties?: Record<string, unknown>): void;
  flush(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

/** Validates one exempt key's value; undefined = drop it. */
export type Passthrough = Record<string, (value: unknown) => unknown>;

export type InitOptions = {
  /** Test seam: use this sink instead of posthog-node. Skips the key<->env guard, not the kill switches. */
  sink?: AnalyticsSink;
  /**
   * "node" (default): one client per process, batched (20 events / 10 s).
   * "worker" (Cloudflare Workers): one client per isolate, initAnalytics at
   * the start of each invocation (idempotent), no timers (flushAt 1,
   * flushInterval 0), and `ctx.waitUntil(flushAnalytics())` at the end.
   */
  runtime?: "node" | "worker";
  /** Test seam: replaces the network fetch of posthog-node and of the log exporter (the guard still applies). */
  fetch?: PostHogOptions["fetch"];
  /** Content-hash build id (container images): sent as `build_id`. app_version stays the 12-char SHA. */
  buildId?: string;
  /** Log export (POSTHOG_LOGS): see log-export.ts LogExporterOptions. */
  logs?: Pick<LogExporterOptions, "allow" | "passthrough" | "textKeys">;
  /** Repo-specific exact keys that skip the shape filter (validated by their own function). */
  passthrough?: Passthrough;
  /** Env whose secret-named values are registered for redaction. Default: process.env. */
  secretEnv?: Record<string, string | undefined>;
  /** Test seam: use this catalog instead of analytics-catalog.ts (core tests run without module mocks). */
  catalog?: Catalog;
  /** Process identity for exceptions without a caller. Default: { service: SERVICE } -> `svc_<repo>`. */
  defaultCaller?: Caller;
  /** Operator warnings (stderr). Never carries a payload. */
  warn?: (message: string) => void;
  /** Clock (tests). */
  now?: () => number;
};

type State = {
  sink: AnalyticsSink;
  env: TelemetryEnv;
  version: string;
  buildId: string | undefined;
  passthrough: Passthrough;
  catalog: Catalog;
  logs: LogExporter | undefined;
  defaultIdentity: Identity;
  warn: (message: string) => void;
  now: () => number;
};

let state: State | undefined;
let warnedGuard = false;

// ---------------------------------------------------------------------------
// before_send: last line for what the SDK builds itself (exception lists)
// ---------------------------------------------------------------------------

const FRAME_SOURCE = ["pre_context", "context_line", "post_context"] as const;

type SdkEvent = { event: string; properties?: Record<string, unknown> } & Record<string, unknown>;

/** Drops $ip, forces $geoip_disable, scrubs exception values, drops source lines around frames. */
export function scrubEvent<E extends SdkEvent>(event: E | null): E | null {
  if (!event) return event;
  const props: Record<string, unknown> = { ...(event.properties ?? {}) };
  delete props.$ip;
  props.$geoip_disable = true;
  const list = props.$exception_list;
  if (Array.isArray(list)) {
    props.$exception_list = list.map((ex: Record<string, unknown>) => {
      const st = ex?.stacktrace as { frames?: Record<string, unknown>[] } | undefined;
      return {
        ...ex,
        value: typeof ex?.value === "string" ? scrubText(ex.value) : ex?.value,
        ...(st && Array.isArray(st.frames)
          ? {
              stacktrace: {
                ...st,
                frames: st.frames.map((f) => {
                  const copy = { ...f };
                  for (const k of FRAME_SOURCE) delete copy[k];
                  return copy;
                }),
              },
            }
          : {}),
      };
    });
  }
  for (const k of ["$exception_message", "$exception_values"]) {
    const v = props[k];
    if (typeof v === "string") props[k] = scrubText(v);
    else if (Array.isArray(v)) props[k] = v.map((x) => (typeof x === "string" ? scrubText(x) : x));
  }
  return { ...event, properties: props };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Wire the process once at boot. Returns whether tracking is on and, if
 * not, why. A key<->env mismatch warns once. Never throws.
 */
export type InitResult = { enabled: boolean; reason: string | undefined };

export function initAnalytics(env: TelemetryEnv, opts: InitOptions = {}): InitResult {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  try {
    // Idempotent: the first successful init wins (one client per process /
    // per Worker isolate). shutdownAnalytics() or resetAnalyticsForTests() to redo.
    if (state) return { enabled: true, reason: undefined };
    const blocker = trackingBlocker(env);
    const killed = env.DO_NOT_TRACK || !env.CORK_TELEMETRY;
    if (killed || (blocker && !opts.sink)) {
      state = undefined;
      if (blocker && !SILENT.has(blocker) && !warnedGuard) {
        warnedGuard = true;
        warn(`[analytics] PostHog off: ${blocker}. Nothing will be sent.`);
      }
      return { enabled: false, reason: blocker };
    }
    const secretEnv = opts.secretEnv ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (secretEnv) registerEnvSecrets(secretEnv);
    const sink =
      opts.sink ??
      (new PostHog(env.POSTHOG_KEY, {
        host: env.POSTHOG_HOST,
        flushAt: opts.runtime === "worker" ? 1 : 20,
        flushInterval: opts.runtime === "worker" ? 0 : 10_000,
        requestTimeout: 3_000,
        fetchRetryCount: 1,
        disableGeoip: true,
        // Exceptions are captured explicitly (global handler, fatal path).
        enableExceptionAutocapture: false,
        before_send: (e) => scrubEvent(e as SdkEvent) as typeof e,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }) as unknown as AnalyticsSink);
    state = {
      sink,
      env,
      version: env.POSTHOG_RELEASE ?? "unknown",
      buildId: opts.buildId !== undefined && /^[A-Za-z0-9._+-]{1,64}$/.test(opts.buildId) ? opts.buildId : undefined,
      passthrough: opts.passthrough ?? {},
      catalog: opts.catalog ?? REPO_CATALOG,
      defaultIdentity: identityFor(opts.defaultCaller ?? { service: (opts.catalog ?? REPO_CATALOG).SERVICE }),
      warn,
      now: opts.now ?? Date.now,
      logs: undefined,
    };
    const logCfg = logExportConfig();
    if (logCfg) {
      state.logs = createLogExporter(logCfg, {
        ...(opts.logs?.allow ? { allow: opts.logs.allow } : {}),
        ...(opts.logs?.passthrough ? { passthrough: opts.logs.passthrough } : {}),
        ...(opts.logs?.textKeys ? { textKeys: opts.logs.textKeys } : {}),
        ...(opts.fetch ? { fetch: opts.fetch as unknown as typeof fetch } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        flushIntervalMs: opts.runtime === "worker" ? 0 : 5_000,
        warn,
      });
    }
    return { enabled: true, reason: undefined };
  } catch {
    state = undefined;
    return { enabled: false, reason: "init failed" };
  }
}

export function analyticsEnabled(): boolean {
  return state !== undefined;
}

/** Always the 12-char commit SHA (POSTHOG_RELEASE); "unknown" when the deploy did not stamp it. */
export function appVersion(): string {
  return state?.version ?? "unknown";
}

/** On every event. `$process_person_profile: false` unless the event is a wallet's. */
export function baseProperties(person = false): Properties {
  return {
    product: (state?.catalog ?? REPO_CATALOG).PRODUCT,
    app_version: appVersion(),
    env: state?.env.CORK_ENV ?? "staging",
    ...(state?.buildId ? { build_id: state.buildId } : {}),
    $geoip_disable: true,
    ...(person ? {} : { $process_person_profile: false }),
  };
}

/** Resolve when `p` settles or after `ms`. Never rejects. */
async function withTimeLimit(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Send what is queued. Bounded; never throws. */
export async function flushAnalytics(timeoutMs = 3_000): Promise<void> {
  const s = state;
  if (s) await withTimeLimit(Promise.allSettled([s.sink.flush(), s.logs?.flush()]), timeoutMs);
}

/** Send one log record to PostHog Logs (no-op when tracking or POSTHOG_LOGS is off). Never throws. */
export function exportLog(record: LogRecordInput): void {
  state?.logs?.exportLog(record);
}

/** Flush and close (SIGTERM, Fastify onClose, before process.exit). Bounded; never throws. */
export async function shutdownAnalytics(timeoutMs = 3_000): Promise<void> {
  const s = state;
  state = undefined;
  if (s) await withTimeLimit(Promise.allSettled([s.sink.shutdown(timeoutMs), s.logs?.shutdown()]), timeoutMs + 500);
}

// ---------------------------------------------------------------------------
// Budgets (cost ceilings; stdout / logs keep everything)
// ---------------------------------------------------------------------------

/** Per distinct_id + event per minute: a retry loop cannot flood. */
export const MAX_EVENTS_PER_CALLER_PER_MINUTE = 120;
/** Same exception (site + class + message shape): once per window. */
export const EXCEPTION_DEDUPE_MS = 10 * 60_000;
const MAX_KEYS = 10_000;

const callerBudget = new Map<string, { minute: number; n: number }>();
const dailyBudget = new Map<string, { day: number; n: number; dropped: number }>();
const recentExceptions = new Map<string, number>();
/** Dedupe memory bound. When full, NEW keys are refused (not cleared) until old ones expire. */
export const MAX_DEDUPE_KEYS = 1_000;
let dedupeRefused = 0;
let lastRefusalWarn = Number.NEGATIVE_INFINITY;
const identifiedOrgs = new Set<string>();

/** Test hook: forget budgets, dedupe memory and the process client. */
export function resetAnalyticsForTests(): void {
  state = undefined;
  warnedGuard = false;
  callerBudget.clear();
  dailyBudget.clear();
  recentExceptions.clear();
  identifiedOrgs.clear();
  dedupeRefused = 0;
  lastRefusalWarn = Number.NEGATIVE_INFINITY;
}

/** undefined = over a cap (drop). Else extra properties (`capped_drops` after a capped period). */
function takeBudget(s: State, distinctId: string, name: string, dailyCap: number): Properties | undefined {
  const now = s.now();
  const minute = Math.floor(now / 60_000);
  const ck = `${distinctId}|${name}`;
  const c = callerBudget.get(ck);
  if (!c || c.minute !== minute) {
    if (callerBudget.size > MAX_KEYS) callerBudget.clear();
    callerBudget.set(ck, { minute, n: 1 });
  } else if (++c.n > MAX_EVENTS_PER_CALLER_PER_MINUTE) {
    return undefined;
  }
  const day = Math.floor(now / 86_400_000);
  let d = dailyBudget.get(name);
  if (!d || d.day !== day) {
    if (dailyBudget.size > MAX_KEYS) dailyBudget.clear();
    d = { day, n: 0, dropped: d?.dropped ?? 0 };
    dailyBudget.set(name, d);
  }
  if (d.n >= dailyCap) {
    if (d.n === dailyCap) s.warn(`[analytics] daily cap reached for ${name} (${dailyCap}/UTC day); dropping until 00:00 UTC.`);
    d.n += 1;
    d.dropped += 1;
    return undefined;
  }
  d.n += 1;
  const dropped = d.dropped;
  d.dropped = 0;
  return dropped > 0 ? { capped_drops: dropped } : {};
}

function passthroughProps(s: State, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, check] of Object.entries(s.passthrough)) {
    if (!(k in props)) continue;
    try {
      const v = check(props[k]);
      if (v !== undefined) out[k] = v;
    } catch {
      /* drop */
    }
  }
  return out;
}

function withoutKeys(props: Record<string, unknown>, keys: Passthrough): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (!(k in keys)) out[k] = v;
  return out;
}

function identifyOrgOnce(s: State, org: string): void {
  if (identifiedOrgs.has(org) || !s.sink.groupIdentify || identifiedOrgs.size >= 1_000) return;
  identifiedOrgs.add(org);
  s.sink.groupIdentify({ groupType: "organization", groupKey: org, properties: { name: org }, disableGeoip: true });
}

// ---------------------------------------------------------------------------
// Events and exceptions
// ---------------------------------------------------------------------------

/**
 * Record one catalog event. Properties pass scrubProperties (shape filter,
 * cap 40, pool aliases). Never throws, never blocks: the SDK batches.
 */
export function trackServer(event: EventName, props: Record<string, unknown>, identity: Identity): void {
  const s = state;
  if (!s) return;
  try {
    const name = s.catalog.EVENTS[event];
    if (name === undefined) return;
    const budget = takeBudget(s, identity.capKey ?? identity.distinctId, name, s.env.POSTHOG_EVENTS_MAX_PER_DAY);
    if (!budget) return;
    const base = baseProperties(identity.person);
    const properties = {
      ...scrubProperties({ ...identity.properties, ...budget, ...withoutKeys(props, s.passthrough) }),
      ...passthroughProps(s, props),
      ...base,
    };
    if (identity.org) identifyOrgOnce(s, identity.org);
    s.sink.capture({
      distinctId: identity.distinctId,
      event: name,
      properties,
      ...(identity.org ? { groups: { organization: identity.org } } : {}),
      disableGeoip: true,
    });
  } catch {
    /* tracking never breaks a request */
  }
}

/** A code location or route template (`orders.post`, `/rfqs/v2/:rfq_id`), never a raw path. */
const SITE_RE = /^[A-Za-z/][A-Za-z0-9_.:/{}-]{0,79}$/;
const safeSite = (v: string | undefined): string | undefined =>
  v !== undefined && SITE_RE.test(v) && !/0x[0-9a-fA-F]|\d{6,}|[0-9a-fA-F]{16,}/.test(v) ? v : undefined;

export type ExceptionContext = {
  /** Where it was caught: code location or route TEMPLATE. Part of the dedupe key. */
  site?: string;
  /** The caller, when known. Default: the process identity (`svc_<product>`). */
  identity?: Identity;
  /** Context properties; they pass scrubProperties (and `passthrough`). */
  props?: Record<string, unknown>;
  /**
   * Extra dedupe key parts (never sent), e.g. [chain_id, contract_address, topic0],
   * so failures on different contracts get their own window. Max 8 parts,
   * each lowercased, reduced to [a-z0-9_.:-] and cut to 66 chars.
   */
  dedupe?: readonly unknown[];
  /** Fatal path: skip the dedupe window (the daily cap still applies). */
  fatal?: boolean;
};

/** First viem `shortMessage` along the cause chain, else the message; scrubbed. */
export function errorSummary(error: unknown): { name: string; message: string } {
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "non-error thrown");
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i += 1) {
    const short = (cur as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short !== "") return { name: e.name, message: scrubText(short) };
    cur = (cur as { cause?: unknown }).cause;
  }
  return { name: e.name, message: scrubText(e.message) };
}

const MAX_DEDUPE_PARTS = 8;
const MAX_DEDUPE_PART_CHARS = 66; // 0x + 64 hex

function dedupePart(v: unknown): string {
  if (v === null || v === undefined) return "";
  const t = typeof v;
  if (t !== "string" && t !== "number" && t !== "bigint" && t !== "boolean") return "?";
  return String(v).trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, MAX_DEDUPE_PART_CHARS);
}

/** True when this key may be sent now. Refuses new keys while the memory is full. */
function dedupeAllows(s: State, key: string, now: number): boolean {
  const last = recentExceptions.get(key);
  if (last !== undefined) {
    if (now - last < EXCEPTION_DEDUPE_MS) return false;
    recentExceptions.set(key, now);
    return true;
  }
  if (recentExceptions.size >= MAX_DEDUPE_KEYS) {
    for (const [k, t] of recentExceptions) if (now - t >= EXCEPTION_DEDUPE_MS) recentExceptions.delete(k);
  }
  if (recentExceptions.size >= MAX_DEDUPE_KEYS) {
    dedupeRefused += 1;
    if (now - lastRefusalWarn >= EXCEPTION_DEDUPE_MS) {
      s.warn(`[analytics] exception dedupe memory full (${MAX_DEDUPE_KEYS} keys): ${dedupeRefused} new exception(s) refused.`);
      lastRefusalWarn = now;
      dedupeRefused = 0;
    }
    return false;
  }
  recentExceptions.set(key, now);
  return true;
}

/**
 * The `at ...` frames of err.stack, scrubbed. The message header that V8 puts
 * at the top of the stack is cut first, so frame-like lines INSIDE the
 * message never become frames.
 */
export function stackFrames(err: unknown): string {
  if (!(err instanceof Error) || typeof err.stack !== "string") return "";
  let stack = err.stack;
  const at = err.message ? stack.indexOf(err.message) : -1;
  if (at >= 0) stack = stack.slice(at + err.message.length);
  return stack
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .map(scrubText)
    .join("\n");
}

/** Message shape for the dedupe key: hex, uuids and long digit runs normalised. */
function fingerprint(message: string): string {
  const first = (message.split("\n", 1)[0] ?? "")
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#uuid")
    .replace(/\d{6,}/g, "#");
  return createHash("sha256").update(first).digest("hex").slice(0, 12);
}

/**
 * Send an unexpected error to Error Tracking. Only a rebuilt error leaves:
 * name, scrubbed short message, and the stack frames (code locations). Never
 * the original object, its cause, URL or request body. Never throws.
 */
export function captureException(err: unknown, ctx: ExceptionContext = {}): void {
  const s = state;
  if (!s) return;
  try {
    const { name, message } = errorSummary(err);
    const now = s.now();
    const site = safeSite(ctx.site);
    const extra = (ctx.dedupe ?? []).slice(0, MAX_DEDUPE_PARTS).map(dedupePart).join("|");
    const key = `${site ?? ""}|${name}|${fingerprint(message)}|${extra}`;
    if (!ctx.fatal && !dedupeAllows(s, key, now)) return;
    const identity = ctx.identity ?? s.defaultIdentity;
    const budget = takeBudget(s, identity.capKey ?? identity.distinctId, "$exception", s.env.POSTHOG_EXCEPTIONS_MAX_PER_DAY);
    if (!budget) return;
    const frames = stackFrames(err);
    const safe = new Error(message);
    safe.name = name;
    // Header = first message line only: a message line that looks like a frame never becomes one.
    safe.stack = `${name}: ${message.split("\n", 1)[0] ?? ""}\n${frames}`;
    const props = ctx.props ?? {};
    s.sink.captureException(safe, identity.distinctId, {
      ...scrubProperties({ ...identity.properties, ...budget, ...withoutKeys(props, s.passthrough) }),
      ...(site !== undefined ? { site } : {}),
      ...passthroughProps(s, props),
      ...baseProperties(identity.person),
      ...(identity.org ? { $groups: { organization: identity.org } } : {}),
    });
  } catch {
    /* tracking never breaks a request */
  }
}

// ---------------------------------------------------------------------------
// Logs: the one place the OTLP exporter reads its settings
// ---------------------------------------------------------------------------

/**
 * Settings of the log exporter (log-export.ts), or undefined when logs are
 * off (tracking off, or POSTHOG_LOGS=false).
 */
export function logExportConfig(): LogExportConfig | undefined {
  const s = state;
  if (!s || !s.env.POSTHOG_LOGS) return undefined;
  return {
    url: `${s.env.POSTHOG_HOST}/i/v1/logs`,
    headers: { authorization: `Bearer ${s.env.POSTHOG_KEY}` },
    minLevel: s.env.POSTHOG_LOGS_MIN_LEVEL,
    maxPerSecond: s.env.POSTHOG_LOGS_MAX_PER_SECOND,
    maxPerDay: s.env.POSTHOG_LOGS_MAX_PER_DAY,
    resource: {
      "service.name": s.catalog.SERVICE,
      "service.version": s.version,
      "deployment.environment": s.env.CORK_ENV,
      product: s.catalog.PRODUCT,
    },
  };
}
