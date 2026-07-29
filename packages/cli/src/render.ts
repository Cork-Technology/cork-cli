// Human-readable rendering for the CLI. The wire format is JSON — that is what the MCP
// server speaks and what scripts parse — but a person at a terminal reading a 200-line
// `JSON.stringify` is doing the formatter's job by hand. So JSON is opt-in (`--json`, or
// CH_JSON=1) and prose is the default.
//
// Everything here is generic over the envelope and the JSON Schema rather than written
// per tool: there are nine tools and dozens of resources, and a bespoke renderer for each
// would rot the moment a handler grew a field. The cost of that choice is that this file
// knows nothing about domain meaning — it lays out whatever shape it is handed.
import type { ToolDef, ToolName } from "@cork/schemas";

/** Terminal-ish width. Fixed rather than read from tput so output is reproducible in tests. */
const WIDTH = 88;
const LABEL = 22;

/** Wrap `text` to WIDTH, indenting every line by `indent` spaces. */
export function wrap(text: string, indent = 0, width = WIDTH): string {
  const pad = " ".repeat(indent);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length + indent <= width) line += ` ${word}`;
    else {
      lines.push(pad + line);
      line = word;
    }
  }
  if (line !== "") lines.push(pad + line);
  return lines.join("\n");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Schema descriptions are written for models: exhaustive, several hundred words, every
 * caveat inline. That is right for the wire and wrong for a terminal. Keep the opening
 * sentences up to a readable budget and let `--json` carry the rest.
 */
export function summarise(text: string, budget = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= budget) return clean;
  const sentences = clean.split(/(?<=[.;])\s/);
  let outText = "";
  for (const s of sentences) {
    if (outText === "") outText = s;
    else if (`${outText} ${s}`.length <= budget) outText += ` ${s}`;
    else break;
  }
  if (outText.length > budget) outText = `${outText.slice(0, budget - 1).trimEnd()}…`;
  else if (outText.length < clean.length) outText += " …";
  return outText;
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
    if (allScalar) return wrap(value.map(scalar).join(", "), indent);
    return value
      .map((item, i) => `${pad}[${i + 1}]${itemLabel(item)}\n${renderValue(item, indent + 2)}`)
      .join("\n");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return `${pad}(empty)`;
  return entries
    .map(([k, v]) => {
      if (isPlainObject(v) || Array.isArray(v)) {
        const nested = renderValue(v, indent + 2);
        return `${pad}${k}\n${nested}`;
      }
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
  const head = [state.toUpperCase(), `ch ${tool.cliPath.join(" ")}`, chain ? `chain ${chain}` : ""]
    .filter(Boolean)
    .join("  ·  ");
  parts.push(head);

  if (state !== "ok") {
    parts.push("", wrap(stateHint(state), 0));
  }

  // `data: null` is the normal shape of a non-ok envelope; printing a bare "null" would
  // say nothing a reader does not already know from the state line.
  if (e.data !== undefined && e.data !== null) {
    parts.push("", renderValue(e.data, 0));
  }

  if (e.warnings && e.warnings.length > 0) {
    parts.push("", `warnings (${e.warnings.length})`);
    for (const w of e.warnings) {
      parts.push(wrap(`! ${w.code ?? "warning"} — ${w.message ?? ""}`.trim(), 2));
    }
  }

  if (e.provenance) {
    const p = e.provenance;
    const bits = ["source", "mode", "block", "fetchedAt"]
      .map((k) => (p[k] === undefined ? "" : `${k} ${scalar(p[k])}`))
      .filter(Boolean);
    if (bits.length > 0) parts.push("", `provenance  ${bits.join(" · ")}`);
  }

  return `${parts.join("\n")}\n`;
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

/** JSON Schema fragment, loosely typed — only the parts a reader needs are inspected. */
interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  items?: SchemaNode;
  $ref?: string;
  default?: unknown;
}

/** A short, human phrase for a property's accepted values. */
function describeType(node: SchemaNode): string {
  if (node.enum && node.enum.length > 0) {
    const vals = node.enum.map((v) => scalar(v));
    return vals.length <= 6 ? `one of: ${vals.join(", ")}` : `one of ${vals.length}: ${vals.slice(0, 5).join(", ")}, …`;
  }
  if (node.anyOf || node.oneOf) {
    const branch = (node.anyOf ?? node.oneOf)!;
    const kinds = branch.map((b) => describeType(b)).filter((s) => s !== "");
    return kinds.length > 0 ? kinds.join("  |  ") : "one of several shapes";
  }
  if (node.$ref) return node.$ref.split("/").pop() ?? "object";
  const t = Array.isArray(node.type) ? node.type.join(" | ") : node.type;
  if (t === "array") return `array of ${node.items ? describeType(node.items) : "values"}`;
  return t ?? "value";
}

/**
 * The tool's contract in prose: what it does, what it takes, what comes back. This is the
 * `--explain` a person gets; `--json` still prints the machine contract (the raw JSON
 * Schema), which is what an agent or a code generator wants.
 */
export function renderExplain(
  tool: ToolDef,
  schema: unknown,
  examples: readonly { title: string; input: unknown }[],
  maturity?: { status?: string; reason?: string },
): string {
  const parts: string[] = [];
  const cli = `ch ${tool.cliPath.join(" ")}`;
  const badge = [`phase ${tool.phase}`, maturity?.status].filter(Boolean).join("  ·  ");
  parts.push(`${cli}  —  ${tool.name}${badge ? `  (${badge})` : ""}`);
  parts.push("", wrap(tool.description, 2));

  const s = schema as SchemaNode;
  const props = s?.properties ?? {};
  const required = new Set(s?.required ?? []);
  const names = Object.keys(props);
  if (names.length > 0) {
    parts.push("", "Inputs");
    for (const name of names) {
      const node = props[name]!;
      const star = required.has(name) ? "*" : " ";
      const label = `${name}${star}`.padEnd(LABEL);
      // Enumerations are worth listing in full — they ARE the usable surface. Everything
      // else gets a type and a short gloss; these descriptions are written for models and
      // run to paragraphs, which is unreadable in a terminal. --json has the full text.
      if (node.enum && node.enum.length > 0) {
        parts.push(`  ${label} one of ${node.enum.length}:`);
        parts.push(wrap(node.enum.map((v) => scalar(v)).join(", "), LABEL + 3));
      } else {
        parts.push(`  ${label} ${describeType(node)}`);
      }
      if (node.description) parts.push(wrap(summarise(node.description), LABEL + 3));
    }
    if (required.size > 0) parts.push("", "  * required");
  }

  if (examples.length > 0) {
    parts.push("", "Examples");
    for (const ex of examples.slice(0, 3)) {
      parts.push(wrap(ex.title, 2));
      parts.push(`    ${cli} --json '${JSON.stringify(ex.input)}'`);
    }
  }

  parts.push("", "Output");
  parts.push(
    wrap(
      "An envelope: state (ok | unavailable | conflict), data, warnings, provenance. Check state before trusting data. Exit codes: 0 ok · 2 invalid input · 3 unavailable · 4 conflict · 1 unexpected error.",
      2,
    ),
  );
  parts.push("", wrap(`Add --json for the machine-readable contract (JSON Schema), or set CH_JSON=1 to make JSON the default for every command.`, 0));
  return `${parts.join("\n")}\n`;
}

/** Structured failures, for a person. The JSON form stays on stderr when JSON is requested. */
export function renderError(payload: Record<string, unknown>): string {
  const e = (payload["error"] ?? payload) as Record<string, unknown>;
  const parts: string[] = [`ERROR  ${scalar(e["code"] ?? "error")}`];
  if (e["message"]) parts.push("", wrap(String(e["message"]), 2));
  const issues = e["issues"];
  if (Array.isArray(issues) && issues.length > 0) {
    parts.push("", "Problems");
    for (const raw of issues) {
      const i = raw as Record<string, unknown>;
      const where = i["path"] ? String(i["path"]) : "(input)";
      const detail = [i["expected"] ? `expected ${i["expected"]}` : "", i["received"] ? `received ${i["received"]}` : ""]
        .filter(Boolean)
        .join(", ");
      parts.push(wrap(`- ${where}${detail ? `: ${detail}` : ""}`, 2));
      if (i["suggestion"]) parts.push(wrap(`did you mean ${i["suggestion"]}?`, 4));
    }
  }
  if (e["remediation"]) parts.push("", wrap(String(e["remediation"]), 2));
  if (e["example"]) parts.push("", "Working example", `  ${JSON.stringify(e["example"])}`);
  return `${parts.join("\n")}\n`;
}

export type { ToolName };
