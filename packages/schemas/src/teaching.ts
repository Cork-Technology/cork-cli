// Errors that teach [v2 §5.4 / RFC §6]: map raw zod issues into a payload an agent can act on in
// one step — per-issue path/expected/received, a nearest-value suggestion for enum typos, one
// remediation line, and a corrected example invocation that itself validates. Returned IN-BAND
// (envelope/stderr), never as a bare protocol error, so the model actually sees it.
import { TOOL_EXAMPLES, type ToolExample } from "./examples.ts";
import type { ToolName } from "./registry.ts";

export interface TeachingIssue {
  path: string;
  code: string;
  message: string;
  expected?: string;
  received?: string;
  /** Nearest legal value when the input looks like a typo of a closed enum member. */
  suggestion?: string;
}

export interface Teaching {
  summary: string;
  issues: TeachingIssue[];
  remediation: string;
  /** A known-good invocation of the same tool — copy, adapt values, retry. */
  example?: ToolExample;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n]!;
}

function valueAt(input: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let v = input;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[k];
  }
  return v;
}

/** Suggest the closest member of a closed value set for a likely typo (≤40% edit distance). */
export function nearestValue(got: string, legal: readonly string[]): string | undefined {
  let best: { v: string; d: number } | undefined;
  for (const v of legal) {
    const d = levenshtein(got.toLowerCase(), v.toLowerCase());
    if (!best || d < best.d) best = { v, d };
  }
  return best && best.d <= Math.max(2, Math.floor(best.v.length * 0.4)) ? best.v : undefined;
}

interface ZodIssueLike {
  code?: string;
  path?: ReadonlyArray<PropertyKey>;
  message?: string;
  expected?: unknown;
  received?: unknown;
  values?: ReadonlyArray<unknown>;
  options?: ReadonlyArray<unknown>;
}

/** Build the teaching payload from raw zod issues (defensive: tolerates any issue shape). */
export function buildTeaching(tool: ToolName, rawIssues: unknown, rawInput?: unknown): Teaching {
  const list = Array.isArray(rawIssues) ? (rawIssues as ZodIssueLike[]) : [];
  const issues: TeachingIssue[] = list.map((i) => {
    const path = (i.path ?? []).join(".");
    const out: TeachingIssue = {
      path,
      code: String(i.code ?? "invalid"),
      message: String(i.message ?? "invalid value"),
    };
    if (i.expected !== undefined) out.expected = String(i.expected);
    if (i.received !== undefined) out.received = String(i.received);
    // Closed-enum typo help: zod v4 carries the legal set on `values` (enum/literal-union).
    const legal = (i.values ?? i.options)?.filter((v): v is string => typeof v === "string");
    if (legal?.length) {
      const got = valueAt(rawInput, i.path ?? []);
      if (typeof got === "string") {
        const s = nearestValue(got, legal);
        if (s) out.suggestion = `did you mean "${s}"?`;
      }
      if (out.expected === undefined) out.expected = legal.join(" | ");
    }
    return out;
  });

  const paths = [...new Set(issues.map((i) => i.path).filter(Boolean))];
  const example = TOOL_EXAMPLES[tool]?.[0];
  return {
    summary: `invalid input for ${tool}${paths.length ? ` (fields: ${paths.join(", ")})` : ""}`,
    issues,
    remediation:
      `Fix the listed field(s) and retry — all enums are closed (no free-form values). ` +
      `Adapt the example below to your case; a retry with the same clientRequestId is idempotent.`,
    ...(example ? { example } : {}),
  };
}
