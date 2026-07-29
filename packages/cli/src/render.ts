// Human-readable rendering of tool RESULTS for the terminal. The contract renderer for
// `--explain` lives next door in explain.ts, which walks the JSON Schema properly
// ($ref resolution, oneOf/anyOf unfolding); this file handles the other half — what comes
// back from a call, and what a failure looks like.
//
// The wire format is JSON — that is what the MCP server speaks and what scripts parse —
// but a person at a terminal reading a 200-line `JSON.stringify` is doing the formatter's
// job by hand. So JSON is opt-in (`--json`, or CORK_JSON=1) and prose is the default.
//
// Everything here is generic over the envelope rather than written per tool: there are
// nine tools and dozens of resources, and a bespoke renderer for each would rot the moment
// a handler grew a field. The cost is that this file knows nothing about domain meaning —
// it lays out whatever shape it is handed.
import type { ToolDef } from "@cork/schemas";

/** Terminal-ish width. Fixed rather than read from tput so output is reproducible in tests. */
export const WIDTH = 88;
const LABEL = 22;

/**
 * Word-wrap `text` to WIDTH, prefixing every produced line with `indent` spaces. Shared with
 * explain.ts — one wrapper, so the two halves of the human output line up.
 */
export function wrap(text: string, indent = 0, width = WIDTH): string[] {
  const pad = " ".repeat(indent);
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (pad.length + line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(pad + line);
      line = word;
    }
  }
  if (line !== "") lines.push(pad + line);
  return lines;
}

/** `wrap` as a single block of text, for callers assembling a string rather than an array. */
function wrapped(text: string, indent = 0): string {
  return wrap(text, indent).join("\n");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A long list of `[1] [2] [3]` blocks is unscannable. If an item carries one of the fields
 * this codebase conventionally uses to name a thing, echo it beside the index so a reader
 * can find the row they want without counting. Purely additive — nothing is hidden, and an
 * item with none of these fields simply keeps its number.
 */
function itemLabel(item: unknown): string {
  if (!isPlainObject(item)) return "";
  for (const key of ["name", "cli", "code", "title", "symbol", "resource", "poolId", "addr", "address"]) {
    const v = item[key];
    if (typeof v === "string" && v !== "") return `  ${v}`;
  }
  return "";
}

/** One scalar, rendered the way a person reads it: no quotes, `null` and booleans spelled out. */
function scalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v === "" ? '""' : v;
  return String(v);
}

/**
 * Lay out arbitrary envelope data as an indented key/value tree. Arrays of scalars go on
 * one line; arrays of objects become numbered blocks so a reader can tell items apart.
 * Nothing is truncated — hiding fields from a person debugging an integration is worse
 * than a long scroll, and `--json` remains available for machine consumption.
 */
export function renderValue(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (!isPlainObject(value) && !Array.isArray(value)) return `${pad}${scalar(value)}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(none)`;
    const allScalar = value.every((v) => !isPlainObject(v) && !Array.isArray(v));
    if (allScalar) return wrapped(value.map(scalar).join(", "), indent);
    return value.map((item, i) => `${pad}[${i + 1}]${itemLabel(item)}\n${renderValue(item, indent + 2)}`).join("\n");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return `${pad}(empty)`;
  return entries
    .map(([k, v]) => {
      if (isPlainObject(v) || Array.isArray(v)) return `${pad}${k}\n${renderValue(v, indent + 2)}`;
      const label = k.padEnd(Math.max(0, LABEL - indent));
      return `${pad}${label} ${scalar(v)}`;
    })
    .join("\n");
}

interface Envelope {
  state?: string;
  data?: unknown;
  warnings?: readonly { code?: string; message?: string }[];
  provenance?: Record<string, unknown>;
  schemaVersion?: string;
}

function stateHint(state: string): string {
  if (state === "unavailable") {
    return "This call cannot be served right now. The warning below says why — do not retry it unchanged, and do not treat the absence of data as an answer.";
  }
  if (state === "conflict") {
    return "The tool ran and found a mismatch between two sources it checked. Chain state outranks the indexer; surface this rather than working around it.";
  }
  return "";
}

/**
 * The result of a tool call, for a person. Leads with the state because that is what
 * decides whether the rest is trustworthy, keeps warnings prominent (they carry the
 * reason an `unavailable` happened), and compresses provenance to one line.
 */
export function renderEnvelope(env: unknown, tool: ToolDef): string {
  if (!isPlainObject(env)) return renderValue(env);
  const e = env as Envelope;
  const parts: string[] = [];

  const state = e.state ?? "ok";
  const chain = e.provenance?.["chainId"];
  const head = [state.toUpperCase(), `ch ${tool.cliPath.join(" ")}`, chain ? `chain ${chain}` : ""].filter(Boolean).join("  ·  ");
  parts.push(head);

  if (state !== "ok") parts.push("", wrapped(stateHint(state)));

  // `data: null` is the normal shape of a non-ok envelope; printing a bare "null" would
  // say nothing a reader does not already know from the state line.
  if (e.data !== undefined && e.data !== null) parts.push("", renderValue(e.data, 0));

  if (e.warnings && e.warnings.length > 0) {
    parts.push("", `warnings (${e.warnings.length})`);
    for (const w of e.warnings) parts.push(wrapped(`! ${w.code ?? "warning"} — ${w.message ?? ""}`.trim(), 2));
  }

  if (e.provenance) {
    const p = e.provenance;
    const bits = ["source", "mode", "block", "fetchedAt"].map((k) => (p[k] === undefined ? "" : `${k} ${scalar(p[k])}`)).filter(Boolean);
    if (bits.length > 0) parts.push("", `provenance  ${bits.join(" · ")}`);
  }

  return `${parts.join("\n")}\n`;
}

/** Structured failures, for a person. The JSON form stays on stderr when JSON is requested. */
export function renderError(payload: Record<string, unknown>): string {
  const e = (payload["error"] ?? payload) as Record<string, unknown>;
  const parts: string[] = [`ERROR  ${scalar(e["code"] ?? "error")}`];
  if (e["message"]) parts.push("", wrapped(String(e["message"]), 2));
  const issues = e["issues"];
  if (Array.isArray(issues) && issues.length > 0) {
    parts.push("", "Problems");
    for (const raw of issues) {
      const i = raw as Record<string, unknown>;
      const where = i["path"] ? String(i["path"]) : "(input)";
      const detail = [i["expected"] ? `expected ${i["expected"]}` : "", i["received"] ? `received ${i["received"]}` : ""].filter(Boolean).join(", ");
      parts.push(wrapped(`- ${where}${detail ? `: ${detail}` : ""}`, 2));
      if (i["suggestion"]) parts.push(wrapped(`did you mean ${i["suggestion"]}?`, 4));
    }
  }
  if (e["remediation"]) parts.push("", wrapped(String(e["remediation"]), 2));
  if (e["example"]) parts.push("", "Working example", `  ${JSON.stringify(e["example"])}`);
  return `${parts.join("\n")}\n`;
}
