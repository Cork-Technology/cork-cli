// cork-telemetry-core@40e0e86 log-export.ts
/**
 * Cork logs -> PostHog Logs (OTLP/HTTP JSON over fetch). CORE FILE: copy as is.
 *
 * Runtime-agnostic (Node 20+, Bun, Workers). No @opentelemetry dependency.
 * - Node with analytics.ts: initAnalytics() starts it; use `pinoDestination()`
 *   as an extra pino destination (stdout stays the primary sink).
 * - Workers / MCP: call `exportLog(record)` (analytics.ts) or build one with
 *   `createLogExporter(config)`.
 * Body: scrubText. Attributes: optional allowlist; then `passthrough` keys
 * (repo checks), `textKeys` (scrubText, kept, capped) and scrubProperties
 * for the rest (route templates allowed under `route`). Caps: per second, per UTC day,
 * min level. At most once: a failed POST is counted, never retried.
 */
import { MAX_NUMERIC_CHARS, defaultLeaf, scrubProperties, scrubText, type LeafJudge, type Scalar } from "./scrub.js";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };
/** pino numeric levels. */
const PINO_LEVEL: Record<number, LogLevel> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };

export type LogExportConfig = {
  url: string;
  headers: Record<string, string>;
  minLevel: LogLevel;
  maxPerSecond: number;
  maxPerDay: number;
  /** `service.name` (= SERVICE), `service.version` (app_version), `deployment.environment`, `product`. */
  resource: Record<string, string>;
};

export type LogRecordInput = {
  level: LogLevel;
  body: string;
  attributes?: Record<string, unknown>;
  /** ms since epoch. Default: now. */
  time?: number;
};

export type LogExporterOptions = {
  /** Keep only these attribute keys (repo-specific allowlist). Default: all keys, still filtered. */
  allow?: (key: string) => boolean;
  /**
   * Exact keys that skip the shape filter, each with its own check (same
   * contract as analytics `passthrough`): return the value to send, or
   * undefined to drop it. Scalars and arrays of scalars; objects are sent as
   * JSON text. Strings capped at 32 KB. Public on-chain data only (e.g. raw event log fields).
   */
  passthrough?: Record<string, (value: unknown) => unknown>;
  /**
   * Keys whose string values are KEPT after scrubText (secrets, URLs, IPs
   * redacted), cut to 1,000 chars, instead of being dropped as free text.
   * Default: DEFAULT_TEXT_KEYS.
   */
  textKeys?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Send when this many records are queued. Default 100. */
  batchSize?: number;
  /** Periodic send (Node). 0 = none (Workers: flush per invocation). Default 0. */
  flushIntervalMs?: number;
  warn?: (message: string) => void;
};

export interface LogExporter {
  exportLog(record: LogRecordInput): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): { sent: number; dropped: number; failed: number };
}

const MAX_BODY = 2_000;
const QUEUE_CAP = 5_000;
/** `/rfqs/v2/:rfq_id`: a route TEMPLATE, never a raw path (no hex, no long digit run). */
const ROUTE_TEMPLATE = /^\/[A-Za-z0-9_/:{}.-]{0,100}$/;

/** defaultLeaf, plus a route template under a key named `route`. */
export const logLeaf: LeafJudge = (v, key, path) => {
  if (key === "route" && typeof v === "string" && ROUTE_TEMPLATE.test(v) && !/0x|[0-9a-fA-F]{16,}|\d{6,}/.test(v)) return v;
  return defaultLeaf(v, key, path);
};

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
const otlpValue = (v: Scalar): OtlpValue =>
  typeof v === "boolean"
    ? { boolValue: v }
    : typeof v === "number"
      ? Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER
        ? { intValue: String(v) }
        : { doubleValue: v }
      : { stringValue: v.length > MAX_NUMERIC_CHARS * 2 ? v.slice(0, MAX_NUMERIC_CHARS * 2) : v };
const kv = (o: Record<string, Scalar>) => Object.entries(o).map(([key, v]) => ({ key, value: otlpValue(v) }));

/**
 * pino error fields as pinoDestination flattens them (`err.message` ->
 * `err_message`, `err.type` -> `err_type`: class names can pass the 28-char enum limit).
 */
export const DEFAULT_TEXT_KEYS: readonly string[] = ["err_message", "err_type"];
export const MAX_TEXT_ATTRIBUTE = 1_000;
const MAX_PASSTHROUGH_CHARS = 32_768;

type AnyValue = OtlpValue | { arrayValue: { values: OtlpValue[] } };
const rawScalar = (v: unknown): OtlpValue | undefined => {
  if (typeof v === "string") return { stringValue: v.slice(0, MAX_PASSTHROUGH_CHARS) };
  if (typeof v === "number") return Number.isFinite(v) ? otlpValue(v) : undefined;
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "bigint") return { stringValue: v.toString() };
  return undefined;
};
/** A passthrough value as an OTLP AnyValue (array of scalars, scalar, or JSON text). */
function passthroughValue(v: unknown): AnyValue | undefined {
  if (Array.isArray(v)) {
    const values = v.map(rawScalar).filter((x): x is OtlpValue => x !== undefined);
    return { arrayValue: { values } };
  }
  if (v !== null && typeof v === "object") {
    try {
      return { stringValue: JSON.stringify(v).slice(0, MAX_PASSTHROUGH_CHARS) };
    } catch {
      return undefined;
    }
  }
  return rawScalar(v);
}

export function createLogExporter(cfg: LogExportConfig, opts: LogExporterOptions = {}): LogExporter {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const batchSize = opts.batchSize ?? 100;
  const minSeverity = SEVERITY[cfg.minLevel];
  let queue: unknown[] = [];
  let sec = -1;
  let inSec = 0;
  let day = -1;
  let inDay = 0;
  let capped = 0;
  const counts = { sent: 0, dropped: 0, failed: 0 };
  const pending = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.flushIntervalMs && opts.flushIntervalMs > 0) {
    timer = setInterval(() => void flush(), opts.flushIntervalMs);
    (timer as { unref?: () => void }).unref?.();
  }

  const textKeys = new Set(opts.textKeys ?? DEFAULT_TEXT_KEYS);
  const passthrough = opts.passthrough ?? {};

  const record = (level: LogLevel, body: string, attributes: Record<string, Scalar>, t: number, extra: { key: string; value: AnyValue }[] = []) => ({
    timeUnixNano: `${Math.floor(t)}000000`,
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: { stringValue: body },
    attributes: [...kv(attributes), ...extra],
  });

  /** passthrough and text keys first (exempt from the shape filter), then scrubProperties for the rest. */
  function attributesOf(picked: Record<string, unknown>): [Record<string, Scalar>, { key: string; value: AnyValue }[]] {
    const extra: { key: string; value: AnyValue }[] = [];
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(picked)) {
      const check = passthrough[k];
      if (check) {
        try {
          const out = check(v);
          const value = out === undefined ? undefined : passthroughValue(out);
          if (value) extra.push({ key: k, value });
        } catch {
          /* drop */
        }
      } else if (textKeys.has(k)) {
        if (typeof v === "string") {
          const text = scrubText(v);
          extra.push({ key: k, value: { stringValue: text.length > MAX_TEXT_ATTRIBUTE ? `${text.slice(0, MAX_TEXT_ATTRIBUTE)}…` : text } });
        }
      } else rest[k] = v;
    }
    return [scrubProperties(rest, logLeaf), extra];
  }

  function underCaps(t: number): boolean {
    const s = Math.floor(t / 1000);
    const d = Math.floor(t / 86_400_000);
    if (d !== day) {
      day = d;
      inDay = 0;
    }
    if (s !== sec) {
      sec = s;
      inSec = 0;
      if (capped > 0) {
        // One summary record per capped episode (counts toward nothing).
        queue.push(record("warn", `log export cap: ${capped} record(s) dropped`, { event: "log_cap" }, t));
        capped = 0;
      }
    }
    if (inSec >= cfg.maxPerSecond || inDay >= cfg.maxPerDay) {
      capped += 1;
      counts.dropped += 1;
      return false;
    }
    inSec += 1;
    inDay += 1;
    return true;
  }

  function exportLog(r: LogRecordInput): void {
    try {
      if (SEVERITY[r.level] === undefined || SEVERITY[r.level] < minSeverity) return;
      const t = r.time ?? now();
      if (!underCaps(t)) return;
      const raw = r.attributes ?? {};
      const picked = opts.allow ? Object.fromEntries(Object.entries(raw).filter(([k]) => opts.allow?.(k))) : raw;
      const body = scrubText(r.body).slice(0, MAX_BODY);
      if (queue.length >= QUEUE_CAP) {
        queue.shift();
        counts.dropped += 1;
      }
      const [attrs, extra] = attributesOf(picked);
      queue.push(record(r.level, body, attrs, t, extra));
      if (queue.length >= batchSize) void flush();
    } catch {
      /* logging never throws */
    }
  }

  function flush(): Promise<void> {
    if (queue.length > 0) {
      const batch = queue;
      queue = [];
      const payload = {
        resourceLogs: [
          {
            resource: { attributes: kv(cfg.resource) },
            scopeLogs: [{ scope: { name: cfg.resource["service.name"] ?? "cork" }, logRecords: batch }],
          },
        ],
      };
      const p = doFetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...cfg.headers },
        body: JSON.stringify(payload),
        ...(typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? { signal: AbortSignal.timeout(5_000) } : {}),
      })
        .then(async (res) => {
          if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
          counts.sent += batch.length;
          await res.body?.cancel().catch(() => undefined);
        })
        .catch((e: unknown) => {
          counts.failed += batch.length;
          opts.warn?.(`[log-export] POST failed (${e instanceof Error ? e.message.slice(0, 80) : "error"}); ${counts.failed} record(s) lost so far`);
        })
        .finally(() => pending.delete(p));
      pending.add(p);
    }
    return Promise.allSettled([...pending]).then(() => undefined);
  }

  return {
    exportLog,
    flush,
    async shutdown() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await flush();
    },
    stats: () => ({ ...counts }),
  };
}

const PINO_DROP = new Set(["level", "time", "msg", "pid", "hostname", "v"]);

/**
 * A pino destination (any object with `write(line)`). Use it in
 * `pino.multistream([{ stream: process.stdout }, { stream: pinoDestination(exportLog) }])`.
 * Each JSON line becomes one record: `msg` -> body, the other fields -> attributes.
 */
export function pinoDestination(exportLog: (r: LogRecordInput) => void): { write(line: string): void } {
  return {
    write(line: string) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        const level = typeof o.level === "number" ? PINO_LEVEL[o.level] : typeof o.level === "string" ? (o.level as LogLevel) : undefined;
        if (!level) return;
        const attributes: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o)) if (!PINO_DROP.has(k) && k !== "err") attributes[k] = v;
        const err = o.err as { type?: unknown; message?: unknown } | undefined;
        if (err && typeof err.type === "string") attributes.err_type = err.type;
        // Text key (DEFAULT_TEXT_KEYS): kept after scrubText. The stack stays on stdout.
        if (err && typeof err.message === "string") attributes.err_message = err.message;
        exportLog({
          level,
          body: typeof o.msg === "string" ? o.msg : "",
          attributes,
          ...(typeof o.time === "number" ? { time: o.time } : {}),
        });
      } catch {
        /* not JSON: skip */
      }
    },
  };
}
