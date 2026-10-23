// The hosted MCP's PostHog transport: a small HTTP client in place of posthog-node.
//
// WHY NO SDK. The hosted server is not a separate program: the CVM runs the same attested `ch`
// binary users install (packaging/cork-cli.apko.yaml composes the image from the public apk). A
// PostHog SDK dependency would therefore ship inside every user's CLI, which must not happen.
// So this file talks to PostHog's documented public capture batch API (`POST <host>/batch/`)
// directly, and NOTHING in the repo imports a PostHog package
// (packages/mcp/test/analytics-guard.test.ts). Logs go through the core's exporter
// (log-export.ts, fetch only), which analytics.ts starts.
//
// PostHogHttpSink is the subset of posthog-node that analytics.ts (the core) uses — `capture`,
// `captureException`, `flush`, `shutdown` — and takes the same constructor options, so
// analytics.ts swaps it in by its import line only.
//
// Delivery is AT MOST ONCE: a failed send is counted and dropped, never retried
// (`fetchRetryCount` is accepted for posthog-node option parity and ignored). The queue is
// capped (ANALYTICS_QUEUE_CAP, oldest dropped). Constructed only when tracking is on: off = no
// object, no timer, no network.
import { BUILD_VERSION } from "@cork/core";
// The core's `stackFrames` (err.stack only, message header cut, lines scrubbed). A cycle with
// analytics.ts, which constructs this sink; each side uses the other only at call time.
import { stackFrames } from "./analytics.js";

/** Event queue cap: past it the OLDEST item is dropped and counted. */
export const ANALYTICS_QUEUE_CAP = 1000;
const MAX_EXCEPTION_VALUE = 1_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Warn = (message: string) => void;

/** What `before_send` sees and returns (posthog-node's EventMessage, as far as it is used). */
export type SinkEvent = { event: string; properties?: Record<string, unknown> } & Record<string, unknown>;

/** posthog-node's constructor options, as analytics.ts passes them, plus the transport's seams. */
export interface PostHogHttpOptions {
  host: string;
  /** Flush when this many events are queued. Default 20. */
  flushAt?: number;
  /** Periodic flush in ms; 0 = no timer (tests flush by hand). Default 10 s. */
  flushInterval?: number;
  /** Per-request timeout in ms. Default 3 s. */
  requestTimeout?: number;
  /** posthog-node parity only: this transport never retries (at most once). */
  fetchRetryCount?: number;
  disableGeoip?: boolean;
  /** posthog-node parity only: this transport never autocaptures. */
  enableExceptionAutocapture?: boolean;
  /** The last line before the queue (analytics.ts wires `scrubEvent`). null = drop. */
  before_send?: (event: SinkEvent) => SinkEvent | null;
  /** Test seam. Default: the global fetch, read at send time. */
  fetch?: Fetch;
  /** Operator warnings (stderr). Never carries a payload. Default console.warn. */
  warn?: Warn;
}

/** The name analytics.ts imports with the sink (posthog-node's `PostHogOptions`). */
export type PostHogOptions = PostHogHttpOptions;

interface CaptureItem {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  type: "capture";
}

/** Warn at most once per 10 minutes about failed sends; count every dropped item. */
class Delivery {
  dropped = 0;
  private lastWarnAt = 0;
  constructor(
    private readonly fetchImpl: Fetch | undefined,
    private readonly timeoutMs: number,
    private readonly warn: Warn,
  ) {}

  async post(url: string, headers: Record<string, string>, body: unknown, count: number): Promise<void> {
    try {
      const res = await (this.fetchImpl ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status < 200 || res.status >= 300) this.failed(count, `HTTP ${res.status}`);
    } catch (err) {
      this.failed(count, err instanceof Error ? err.name : "error");
    }
  }

  private failed(count: number, why: string): void {
    this.dropped += count;
    const now = Date.now();
    if (now - this.lastWarnAt < 600_000) return;
    this.lastWarnAt = now;
    this.warn(`[analytics] a send to PostHog failed (${why}); ${this.dropped} item(s) dropped so far`);
  }
}

/** A batching queue with one send in flight at a time and an optional unref'd timer. */
class Queue<T> {
  private items: T[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly send: (items: T[]) => Promise<void>,
    private readonly flushAt: number,
    every: number,
    private readonly delivery: Delivery,
  ) {
    if (every > 0) {
      this.timer = setInterval(() => void this.flush(), every);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  push(item: T): void {
    if (this.items.length >= ANALYTICS_QUEUE_CAP) {
      this.items.shift();
      this.delivery.dropped++;
    }
    this.items.push(item);
    if (this.items.length >= this.flushAt) void this.flush();
  }

  /** Send what is queued. One send at a time; never throws. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight.then(() => (this.items.length > 0 ? this.flush() : undefined));
    const items = this.items;
    this.items = [];
    if (items.length === 0) return Promise.resolve();
    this.inFlight = this.send(items).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

// ── Exceptions in PostHog's error-tracking schema ──────────────────────

/** PostHog's Node.js raw frame (cymbal `RawNodeFrame`, `platform: "node:javascript"`): with no
 *  chunk id it is taken as already resolved — this binary ships no source maps to resolve with. */
export interface Frame {
  platform: "node:javascript";
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/** A frame's file as something safe to keep: the compiled binary's `/$bunfs/…` path, a
 *  repo-relative `packages/…` path, a dependency's `node_modules/…` path or a runtime-internal
 *  `node:…`/`native` name. Anything else (a path on someone's disk) is `<external>`. */
function frameFile(raw: string): string {
  const f = raw.replace(/^file:\/\//u, "");
  let kept: string;
  if (f.startsWith("/$bunfs/")) kept = f;
  else if (f.includes("/node_modules/")) kept = f.slice(f.lastIndexOf("/node_modules/") + 1);
  else if (f.includes("/packages/")) kept = f.slice(f.lastIndexOf("/packages/") + 1);
  else if (/^(node:[a-z_/]+|native|<anonymous>)$/u.test(f)) kept = f;
  else return "<external>";
  return kept.replace(/0x[0-9a-f]+/giu, "0x…").replace(/[0-9a-f]{16,}/giu, "<hex>").replace(/[^A-Za-z0-9_$.<>:/@-]/gu, "").replace(/@/gu, "").slice(-200);
}

/** A frame's function name: identifier-ish characters only, hex and addresses removed. */
function frameFunction(raw: string | undefined): string {
  if (!raw) return "<anonymous>";
  const s = raw.replace(/0x[0-9a-f]+/giu, "0x…").replace(/[0-9a-f]{16,}/giu, "<hex>").replace(/\S+@\S+/gu, "").replace(/[^A-Za-z0-9_$.<>[\] ]/gu, "").trim().slice(0, 128);
  return s.length > 0 ? s : "<anonymous>";
}

/** Parse the `    at fn (file:line:col)` lines that the core's `stackFrames(err)` returns
 *  (taken from err.stack only, after the message, already scrubbed) into PostHog's raw frame
 *  shape, outermost first (the order the error-tracking schema expects). Code locations only. */
export function rawFrames(lines: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of lines.split("\n").slice(0, 50)) {
    const m = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/u.exec(line);
    if (!m) continue;
    const filename = frameFile(m[2]!);
    // A frame outside the code we ship keeps no function name either (it could be anything).
    frames.push({ platform: "node:javascript", filename, function: filename === "<external>" ? "<anonymous>" : frameFunction(m[1]), lineno: Number(m[3]), colno: Number(m[4]), in_app: !filename.startsWith("node_modules/") && (filename.startsWith("packages/") || filename.startsWith("/$bunfs/")) });
  }
  return frames.reverse();
}

/** `$exception_list` for the rebuilt error analytics.ts hands over (name, scrubbed message,
 *  `at` lines). The class name passes only identifier-shaped. */
export function exceptionList(error: unknown): unknown[] {
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "non-Error thrown");
  return [{
    type: /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/u.test(e.name) ? e.name : "Error",
    value: e.message.slice(0, MAX_EXCEPTION_VALUE),
    mechanism: { handled: true, synthetic: !(error instanceof Error) },
    stacktrace: { type: "raw", frames: rawFrames(stackFrames(e)) },
  }];
}

// ── Events: POST <host>/batch/ ─────────────────────────────────────────

export class PostHogHttpSink {
  private readonly host: string;
  private readonly delivery: Delivery;
  private readonly queue: Queue<CaptureItem>;
  private readonly beforeSend: ((event: SinkEvent) => SinkEvent | null) | undefined;
  private readonly geoipOff: boolean;

  constructor(
    private readonly apiKey: string,
    opts: PostHogHttpOptions,
  ) {
    this.host = opts.host.replace(/\/+$/u, "");
    this.beforeSend = opts.before_send;
    this.geoipOff = opts.disableGeoip ?? true;
    this.delivery = new Delivery(opts.fetch, opts.requestTimeout ?? 3_000, opts.warn ?? ((m) => console.warn(m)));
    this.queue = new Queue<CaptureItem>(
      (batch) => this.delivery.post(`${this.host}/batch/`, { "content-type": "application/json" }, { api_key: this.apiKey, batch }, batch.length),
      opts.flushAt ?? 20,
      opts.flushInterval ?? 10_000,
      this.delivery,
    );
  }

  /** Items dropped so far: queue overflow and failed sends. */
  get dropped(): number {
    return this.delivery.dropped;
  }

  capture(message: { distinctId: string; event: string; properties: Record<string, unknown>; groups?: Record<string, string>; disableGeoip?: boolean }): void {
    const properties: Record<string, unknown> = {
      ...message.properties,
      distinct_id: message.distinctId,
      $lib: "cork-mcp-server",
      $lib_version: BUILD_VERSION.replace(/^v/u, ""),
      ...(message.groups ? { $groups: message.groups } : {}),
      ...(this.geoipOff || message.disableGeoip ? { $geoip_disable: true } : {}),
    };
    const event = this.beforeSend ? this.beforeSend({ event: message.event, properties }) : { event: message.event, properties };
    if (!event) return;
    this.queue.push({ event: event.event, properties: event.properties ?? {}, timestamp: new Date().toISOString(), type: "capture" });
  }

  /** `$exception` in PostHog's error-tracking schema, from the error analytics.ts rebuilt. */
  captureException(error: unknown, distinctId?: string, additionalProperties: Record<string, unknown> = {}): void {
    this.capture({
      distinctId: distinctId ?? "anonymous",
      event: "$exception",
      properties: { ...additionalProperties, $exception_list: exceptionList(error), $exception_level: "error" },
    });
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  /** Stop the timer and send what is queued. */
  async shutdown(_timeoutMs?: number): Promise<void> {
    this.queue.stopTimer();
    await this.queue.flush();
  }
}
