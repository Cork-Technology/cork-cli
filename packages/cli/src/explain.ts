// Human-readable rendering of a tool's contract for `ch <command> --explain`.
//
// By default `--explain` prints this plain-English view; the machine-readable JSON schema is opt-in
// (pass --json, or set CORK_EXPLAIN_JSON=1) so a person at a terminal gets prose and a script gets
// JSON. The renderer walks the same JSON Schema the MCP `outputSchema`/`inputSchema` advertises —
// resolving $ref into $defs, unfolding discriminated unions (oneOf/anyOf) into one block per
// variant, and word-wrapping every description — so the two surfaces never drift.

/** The contract object the CLI assembles for a tool (also the shape emitted as JSON). */
export interface ExplainDoc {
  tool: string;
  cli: string;
  phase: number;
  description: string;
  // The advertised JSON Schema — typed as unknown because inputJsonSchema() returns unknown; the
  // formatter narrows it defensively (a non-object schema renders as "no input").
  inputSchema: unknown;
}

type Schema = Record<string, unknown>;

const WIDTH = 88;

/** Word-wrap `text` to `WIDTH`, prefixing every produced line with `indent` spaces (hanging). */
function wrap(text: string, indent: number): string[] {
  const pad = " ".repeat(indent);
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line === "") line = w;
    else if (pad.length + line.length + 1 + w.length <= WIDTH) line += ` ${w}`;
    else {
      lines.push(pad + line);
      line = w;
    }
  }
  if (line !== "") lines.push(pad + line);
  return lines;
}

function isSchema(v: unknown): v is Schema {
  return typeof v === "object" && v !== null;
}

/** `#/$defs/Name` → the last path segment (`Name`); used as a compact type label. */
function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

/** Resolve a single `$ref` against the root schema's `$defs` (one hop; enough for our schemas). */
function resolveRef(ref: string, root: Schema): Schema | undefined {
  const defs = root.$defs;
  if (!isSchema(defs)) return undefined;
  const target = defs[refName(ref)];
  return isSchema(target) ? target : undefined;
}

/** A short human label for a field's type — the $def name (MarketId, Address…), a literal, an
 *  enum list, or the JSON primitive. */
function typeLabel(schema: Schema, root: Schema): string {
  if (typeof schema.const === "string" || typeof schema.const === "number") return `= ${JSON.stringify(schema.const)}`;
  if (typeof schema.$ref === "string") return refName(schema.$ref);
  if (Array.isArray(schema.enum)) {
    const vals = schema.enum.map((v) => JSON.stringify(v));
    const joined = vals.join(" | ");
    return joined.length <= 60 ? `one of: ${joined}` : `one of ${vals.length} values`;
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const n = ((schema.oneOf ?? schema.anyOf) as unknown[]).length;
    return `one of ${n} variants`;
  }
  const t = schema.type;
  if (t === "array") {
    const items = isSchema(schema.items) ? typeLabel(schema.items, root) : "value";
    return `array of ${items}`;
  }
  if (t === "object") {
    // Freeform bag (propertyNames/additionalProperties, no declared properties) vs a real shape.
    return isSchema(schema.properties) ? "object" : "JSON object";
  }
  if (typeof t === "string") return t;
  return "value";
}

/** The description to show for a field: its own, else the one carried by its `$ref` target. */
function describe(schema: Schema, root: Schema): string | undefined {
  if (typeof schema.description === "string") return schema.description;
  if (typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref, root);
    if (target && typeof target.description === "string") return target.description;
  }
  return undefined;
}

/** True for a discriminated-union branch: an object whose first field is a `const` (kind/resource). */
function discriminant(branch: Schema): { key: string; value: string } | undefined {
  const props = branch.properties;
  if (!isSchema(props)) return undefined;
  for (const [key, v] of Object.entries(props)) {
    if (isSchema(v) && (typeof v.const === "string" || typeof v.const === "number")) return { key, value: String(v.const) };
  }
  return undefined;
}

/** Render an object schema's fields as aligned `name  type  (required)` lines + wrapped notes. */
function renderFields(schema: Schema, root: Schema, indent: number, depth: number, out: string[]): void {
  const props = schema.properties;
  if (!isSchema(props)) return;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const names = Object.keys(props);
  const col = Math.min(Math.max(...names.map((n) => n.length), 0), 26);
  const pad = " ".repeat(indent);
  for (const name of names) {
    const field = props[name];
    if (!isSchema(field)) continue;
    const req = required.has(name) ? "(required)" : "(optional)";
    out.push(`${pad}${name.padEnd(col)}  ${typeLabel(field, root)}  ${req}`);
    const note = describe(field, root);
    if (note) out.push(...wrap(note, indent + 4));
    // One level of nesting: expand a declared sub-object; deeper shapes defer to --json.
    const branches = (field.oneOf ?? field.anyOf) as unknown;
    if (Array.isArray(branches) && depth < 2) {
      renderVariants(branches, root, indent + 4, depth + 1, out);
    } else if (isSchema(field.properties)) {
      if (depth < 2) renderFields(field, root, indent + 4, depth + 1, out);
      else out.push(...wrap("(nested object — see the JSON schema via --json for its full shape)", indent + 4));
    }
  }
}

/** Render each branch of a oneOf/anyOf as its own block, headed by the discriminant value. */
function renderVariants(branches: unknown[], root: Schema, indent: number, depth: number, out: string[]): void {
  const pad = " ".repeat(indent);
  branches.forEach((b, i) => {
    if (!isSchema(b)) return;
    const disc = discriminant(b);
    const heading = disc ? `${disc.value}` : `variant ${i + 1}`;
    out.push("");
    out.push(`${pad}▸ ${heading}`);
    const note = typeof b.description === "string" ? b.description : undefined;
    if (note) out.push(...wrap(note, indent + 4));
    renderFields(b, root, indent + 4, depth, out);
  });
}

/** Full plain-English rendering of a tool contract for the terminal. */
export function formatExplainText(doc: ExplainDoc): string {
  const out: string[] = [];
  out.push(`${doc.tool}  ·  ${doc.cli}  ·  phase ${doc.phase}`);
  out.push("");
  out.push(...wrap(doc.description, 0));

  const schema: Schema = isSchema(doc.inputSchema) ? doc.inputSchema : {};
  const props = isSchema(schema.properties) ? schema.properties : undefined;
  out.push("");
  if (!props || Object.keys(props).length === 0) {
    out.push("INPUT: none — call with no arguments.");
  } else {
    out.push("INPUT");
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const [name, v] of Object.entries(props)) {
      if (!isSchema(v)) continue;
      out.push("");
      const req = required.has(name) ? "(required)" : "(optional)";
      const branches = (v.oneOf ?? v.anyOf) as unknown;
      if (Array.isArray(branches)) {
        out.push(`  ${name}  ${req} — one of these variants:`);
        const note = describe(v, schema);
        if (note) out.push(...wrap(note, 4));
        renderVariants(branches, schema, 4, 1, out);
      } else {
        out.push(`  ${name}  ${typeLabel(v, schema)}  ${req}`);
        const note = describe(v, schema);
        if (note) out.push(...wrap(note, 4));
        if (isSchema(v.properties)) renderFields(v, schema, 4, 1, out);
      }
    }
  }
  out.push("");
  out.push("For the machine-readable JSON schema: add --json '{}' or set CORK_EXPLAIN_JSON=1.");
  return out.join("\n");
}

/** Whether `--explain` should emit JSON: an explicit --json value, or a truthy CORK_EXPLAIN_JSON. */
export function explainWantsJson(jsonOpt: string | undefined, env: Record<string, string | undefined>): boolean {
  if (jsonOpt !== undefined) return true;
  const flag = env.CORK_EXPLAIN_JSON;
  return flag !== undefined && flag !== "" && flag !== "0" && flag.toLowerCase() !== "false";
}
