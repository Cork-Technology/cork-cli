// cork-telemetry-core@40e0e86 telemetry-env.ts
/**
 * Cork telemetry env contract (PostHog). CORE FILE: copy as is.
 *
 * Rules:
 * - An empty or blank value is the same as an unset value: the default applies.
 * - A bad value never stops the process: it falls back to the default
 *   (`.catch`). Telemetry must never break a deploy. The key<->env guard in
 *   analytics.ts then keeps a wrong setup off.
 * - Only these names. Do not add aliases (POSTHOG_ENV, APP_VERSION,
 *   GIT_SHA12, ...). GIT_COMMIT is never read or written here.
 *
 * Use: spread `TELEMETRY_ENV_SHAPE` into the repo's own zod env object, or
 * call `parseTelemetryEnv(process.env)` (Workers: pass the `env` binding).
 */
import { z } from "zod";

export const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com";

/** "" and "   " become undefined, so `.default()` applies. */
const blank = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

/** "1/true/yes/on" -> true, "0/false/no/off" -> false, anything else -> the default. */
const bool = (def: boolean) =>
  z.preprocess(
    (v) => {
      const b = blank(v);
      if (typeof b !== "string") return b;
      const n = b.trim().toLowerCase();
      if (TRUE.has(n)) return true;
      if (FALSE.has(n)) return false;
      return undefined;
    },
    z.boolean().default(def).catch(def),
  );

const positiveInt = (def: number) =>
  z.preprocess(blank, z.coerce.number().int().positive().default(def).catch(def));

/** http(s) origin, no trailing slash, no userinfo, no query. */
const host = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .default(DEFAULT_POSTHOG_HOST)
    .transform((v, ctx) => {
      try {
        const u = new URL(v);
        if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !u.search) {
          return u.origin;
        }
      } catch {
        /* fall through */
      }
      ctx.issues.push({ code: "custom", message: "POSTHOG_HOST is not an http(s) origin", input: v });
      return z.NEVER;
    })
    .catch(DEFAULT_POSTHOG_HOST),
);

/** 7..40 hex chars, cut to 12 (the Cork release id). Anything else: unset. */
const release = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{7,40}$/)
    .transform((v) => v.slice(0, 12))
    .optional()
    .catch(undefined),
);

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export const TELEMETRY_ENV_SHAPE = {
  /** Project ingestion token (phc_...). Empty = tracking off (events, exceptions, logs). */
  POSTHOG_KEY: z.preprocess(blank, z.string().trim().default("")),
  POSTHOG_HOST: host,
  /** Which PostHog world this deploy reports as. Default staging: a box can never pass as prod by omission. */
  CORK_ENV: z.preprocess(blank, z.enum(["prod", "staging"]).default("staging").catch("staging")),
  /** Release id = app_version (12-char git SHA, stamped by the deploy). */
  POSTHOG_RELEASE: release,
  /** Ship logs to PostHog Logs (OTLP). Ignored when tracking is off. */
  POSTHOG_LOGS: bool(true),
  POSTHOG_LOGS_MIN_LEVEL: z.preprocess(
    (v) => {
      const b = blank(v);
      return typeof b === "string" ? b.trim().toLowerCase() : b;
    },
    z.enum(LOG_LEVELS).default("info").catch("info"),
  ),
  POSTHOG_LOGS_MAX_PER_SECOND: positiveInt(200),
  POSTHOG_LOGS_MAX_PER_DAY: positiveInt(2_000_000),
  /** Per event NAME per UTC day. */
  POSTHOG_EVENTS_MAX_PER_DAY: positiveInt(5_000),
  /** `$exception` events per UTC day, all sites together. */
  POSTHOG_EXCEPTIONS_MAX_PER_DAY: positiveInt(1_000),
  /** Kill switches, honoured everywhere. */
  DO_NOT_TRACK: bool(false),
  CORK_TELEMETRY: bool(true),
} as const;

export const TelemetryEnvSchema = z.object(TELEMETRY_ENV_SHAPE);
export type TelemetryEnv = z.infer<typeof TelemetryEnvSchema>;

/** Never throws (every field has a fallback). */
export function parseTelemetryEnv(raw: Record<string, unknown>): TelemetryEnv {
  return TelemetryEnvSchema.parse(raw);
}
