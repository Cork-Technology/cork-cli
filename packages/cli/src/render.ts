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
import { GLYPH, PLAIN, type Style } from "./ansi.ts";

/** Terminal-ish width. Fixed rather than read from tput so output is reproducible in tests. */
const WIDTH = 88;
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
 *
 * Styling discipline (holds for every renderer in this file): wrap and pad on PLAIN text,
 * apply SGR to the finished token — escape sequences are zero-width on screen but would
 * count toward width/padEnd math, so they must never enter it. Keys get color (the eye
 * scans by key), values stay plain (they are the payload being read).
 */
function renderValue(value: unknown, indent = 0, s: Style = PLAIN): string {
  const pad = " ".repeat(indent);
  if (!isPlainObject(value) && !Array.isArray(value)) return `${pad}${scalar(value)}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${s.dim("(none)")}`;
    const allScalar = value.every((v) => !isPlainObject(v) && !Array.isArray(v));
    if (allScalar) return wrapped(value.map(scalar).join(", "), indent);
    return value
      .map((item, i) => {
        const label = itemLabel(item);
        return `${pad}${s.dim(`[${i + 1}]`)}${label === "" ? "" : s.bold(label)}\n${renderValue(item, indent + 2, s)}`;
      })
      .join("\n");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return `${pad}${s.dim("(empty)")}`;
  return entries
    .map(([k, v]) => {
      if (isPlainObject(v) || Array.isArray(v)) return `${pad}${s.cyan(s.bold(k))}\n${renderValue(v, indent + 2, s)}`;
      const label = k.padEnd(Math.max(0, LABEL - indent));
      return `${pad}${s.cyan(label)} ${scalar(v)}`;
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

/** The state badge: glyph + word, colored by trust level — green ✔ ok, yellow ⚠ unavailable,
 *  red ✖ conflict. An unrecognized state stays bold-plain rather than guessing a color. */
function stateBadge(state: string, s: Style): string {
  const word = state.toUpperCase();
  if (state === "ok") return s.green(s.bold(`${GLYPH.ok} ${word}`));
  if (state === "unavailable") return s.yellow(s.bold(`${GLYPH.warn} ${word}`));
  if (state === "conflict") return s.red(s.bold(`${GLYPH.fail} ${word}`));
  return s.bold(word);
}

/**
 * The result of a tool call, for a person. Leads with the state because that is what
 * decides whether the rest is trustworthy, keeps warnings prominent (they carry the
 * reason an `unavailable` happened), and compresses provenance to one line.
 */
export function renderEnvelope(env: unknown, tool: ToolDef, s: Style = PLAIN): string {
  if (!isPlainObject(env)) return renderValue(env, 0, s);
  const e = env as Envelope;
  const parts: string[] = [];

  const state = e.state ?? "ok";
  const chain = e.provenance?.["chainId"];
  const sep = s.dim(`  ${GLYPH.sep}  `);
  const head = [stateBadge(state, s), `ch ${tool.cliPath.join(" ")}`, chain ? `chain ${chain}` : ""].filter(Boolean).join(sep);
  parts.push(head);

  // The hint gets the state's color line-by-line AFTER wrapping — the wrap math never sees
  // an escape sequence.
  const tint = state === "conflict" ? s.red : s.yellow;
  if (state !== "ok") parts.push("", ...wrap(stateHint(state)).map((line) => tint(line)));

  // `data: null` is the normal shape of a non-ok envelope; printing a bare "null" would
  // say nothing a reader does not already know from the state line.
  if (e.data !== undefined && e.data !== null) parts.push("", renderValue(e.data, 0, s));

  if (e.warnings && e.warnings.length > 0) {
    parts.push("", s.bold(`warnings (${e.warnings.length})`));
    for (const w of e.warnings) {
      const code = w.code ?? "warning";
      const head = `${GLYPH.warn} ${code}`;
      const lines = wrap(`${head} — ${w.message ?? ""}`.trim(), 2);
      // Colorize the code token in place: it is the leading text of the first wrapped line,
      // so a plain first-occurrence replace can only hit the prefix.
      if (lines.length > 0) lines[0] = lines[0]!.replace(head, s.yellow(head));
      parts.push(lines.join("\n"));
    }
  }

  if (e.provenance) {
    const p = e.provenance;
    const bits = ["source", "mode", "block", "fetchedAt"].map((k) => (p[k] === undefined ? "" : `${k} ${scalar(p[k])}`)).filter(Boolean);
    if (bits.length > 0) parts.push("", s.dim(`provenance  ${bits.join(` ${GLYPH.sep} `)}`));
  }

  return `${parts.join("\n")}\n`;
}

/** The stderr JSON error payload the CLI emits — also renderError's input. `issues` stays
 *  unknown on purpose: teaching issues and raw zod issues differ in shape, and the renderer
 *  walks whichever arrived defensively. */
export interface CliErrorPayload {
  error: {
    code?: string;
    tool?: string;
    message?: string;
    issues?: unknown;
    remediation?: string;
    example?: unknown;
  };
}

/** Structured failures, for a person. The JSON form stays on stderr when JSON is requested. */
export function renderError(payload: CliErrorPayload, s: Style = PLAIN): string {
  const e = payload.error;
  const parts: string[] = [`${s.red(s.bold(`${GLYPH.fail} ERROR`))}  ${s.red(scalar(e.code ?? "error"))}`];
  if (e.message) parts.push("", wrapped(String(e.message), 2));
  const issues = e.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    parts.push("", s.bold("Problems"));
    for (const raw of issues) {
      const i = raw as Record<string, unknown>;
      const where = i["path"] ? String(i["path"]) : "(input)";
      // Teaching issues carry a human message; fall back to expected/received for raw zod issues.
      const detail = i["message"]
        ? String(i["message"])
        : [i["expected"] ? `expected ${i["expected"]}` : "", i["received"] ? `received ${i["received"]}` : ""].filter(Boolean).join(", ");
      // Colorize the field path in place after wrapping, same first-occurrence-prefix trick
      // as the warning codes.
      const lines = wrap(`- ${where}${detail ? `: ${detail}` : ""}`, 2);
      if (lines.length > 0) lines[0] = lines[0]!.replace(`- ${where}`, `- ${s.cyan(where)}`);
      parts.push(lines.join("\n"));
      // Suggestions are complete sentences ('did you mean "x"?', '"a" was renamed to "b"') —
      // print verbatim, never re-wrap.
      if (i["suggestion"]) parts.push(wrap(`${GLYPH.suggest} ${i["suggestion"]}`, 4).map((line) => s.green(line)).join("\n"));
    }
  }
  if (e.remediation) parts.push("", wrapped(String(e.remediation), 2));
  if (e.example) parts.push("", s.bold("Working example"), `  ${s.dim(JSON.stringify(e.example))}`);
  return `${parts.join("\n")}\n`;
}
