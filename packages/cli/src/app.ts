// CLI projection of the same registry the MCP server uses — one command per tool at its cliPath.
//
// INPUT can arrive three ways, and they compose (later wins):
//   1. `--json '<object>'`  the canonical wire shape, identical to what MCP receives
//   2. `--input '<object>'` the same thing under an unambiguous name
//   3. flags derived from the tool's own schema, plus one positional for the first required
//      scalar — so `ch query registry-assets --chainid=42161` says what it means
//
// OUTPUT is prose by default and JSON on request (`--json` with no value, or CORK_JSON=1).
// The wire format has not changed; what changed is who the default serves. Scripts that
// already pass `--json '<object>'` keep getting JSON, because supplying input that way is
// itself a machine-readable intent.
//
// `--explain` prints the tool's contract: prose by default (explain.ts), JSON Schema under
// --json or CORK_EXPLAIN_JSON=1.
//
// Exit codes map envelope state so scripts can branch: 0 ok, 2 invalid input,
// 3 unavailable, 4 conflict, 1 unexpected error.
import { Command } from "commander";
import { REGISTRY, SCHEMA_VERSION, inputJsonSchema, type ToolDef } from "@cork/schemas";
import { BUILD_COMMIT, BUILD_TARGET, BUILD_VERSION, runTool, ToolInputError, type HandlerContext } from "@cork/core";
import { explainWantsJson, formatExplainText } from "./explain.ts";
import { renderEnvelope, renderError } from "./render.ts";
import { runSelfUpdate } from "./self-update.ts";

export const EXIT = { ok: 0, error: 1, invalid: 2, unavailable: 3, conflict: 4 } as const;

/**
 * JSON.parse that REFUSES silent integer precision loss: a numeric-field literal like
 * 2500000000000000001 becomes 2500000000000000000 in a plain parse BEFORE any schema sees it.
 * Uses the ES2024 reviver `context.source` (raw literal text, supported by Bun/JSC) to detect
 * an integer literal that no longer round-trips; falls back to a plain parse on engines
 * without source access. Amount-class fields are strings and unaffected.
 */
export function parseJsonPrecise(text: string): unknown {
  return JSON.parse(text, function reviver(_key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && context && typeof context.source === "string" && /^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) {
      throw new Error(
        `integer ${context.source} exceeds JavaScript's safe integer range and would silently lose precision in JSON parsing — pass this value as a decimal STRING (the schema's string-typed fields take arbitrary precision)`,
      );
    }
    return value;
  } as Parameters<typeof JSON.parse>[1]);
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function leafName(tool: ToolDef): string {
  return tool.cliPath[tool.cliPath.length - 1]!;
}

interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
}

/**
 * Resolve a `$ref` into its `$defs` target so classification sees the concrete shape.
 * A field like `account: { $ref: "#/$defs/Address" }` IS a string (pattern-checked) —
 * without resolution it mis-classifies as a JSON flag and `--account 0x…` demands quoting.
 * Local keys (description) win over the target's; depth-capped for $ref-of-$ref chains.
 */
function resolveNode(node: SchemaNode, defs: Record<string, SchemaNode>, depth = 0): SchemaNode {
  if (!node.$ref || depth >= 3) return node;
  const target = defs[node.$ref.replace("#/$defs/", "")];
  if (!target) return node;
  const { $ref: _drop, ...local } = node;
  return resolveNode({ ...target, ...local }, defs, depth + 1);
}

/**
 * Does the schema admit a plain string for this field? Judged by the schema, not by how a value
 * looks: union fields like decode's `data` (hex-string-or-object, the string side behind a $ref)
 * accept a raw flag value, while object-only fields (`--filters`, `--action`) keep the loud
 * JSON-parse error — the actionable message when a structure was clearly intended.
 */
function admitsString(node: SchemaNode, defs: Record<string, SchemaNode>, depth = 0): boolean {
  if (depth >= 4) return false;
  const n = resolveNode(node, defs);
  const t = Array.isArray(n.type) ? n.type : n.type ? [n.type] : [];
  if (t.includes("string")) return true;
  return [...(n.anyOf ?? []), ...(n.oneOf ?? [])].some((b) => admitsString(b, defs, depth + 1));
}

/** Flag spelling for a schema property: lowercased, so `chainId` answers to `--chainid`. */
function flagFor(prop: string): string {
  return prop.toLowerCase();
}

/** `--chain-id`, `--chainId` and `--chainid` should all reach the same option. */
function canonicalise(flagName: string): string {
  return flagName.replace(/-/g, "").toLowerCase();
}

function isScalarNode(node: SchemaNode): boolean {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  if (node.enum && node.enum.length > 0) return true;
  return t === "string" || t === "number" || t === "integer" || t === "boolean";
}

/** Coerce a command-line string into the type the schema expects. */
function coerce(node: SchemaNode, raw: string): unknown {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  const numeric = t === "number" || t === "integer" || (!t && (node.enum ?? []).length > 0 && (node.enum ?? []).every((v) => typeof v === "number"));
  if (numeric) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (t === "boolean") return raw === "" || raw === "true" || raw === "1";
  return raw;
}

/**
 * Rewrite argv so a schema-derived flag can be spelled any of the ways a person might
 * reasonably type it. Only names that resolve to a known property are touched; anything
 * else (including `--rpc-url`) passes through untouched for commander to handle.
 */
export function normaliseArgv(argv: readonly string[], known: ReadonlySet<string>): string[] {
  return argv.map((token) => {
    if (!token.startsWith("--")) return token;
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    const canon = canonicalise(name);
    if (!known.has(canon) || canon === name) return token;
    return eq === -1 ? `--${canon}` : `--${canon}${token.slice(eq)}`;
  });
}

/** camelCase discriminator value → the kebab-case subcommand spelling (`txHash` → `tx-hash`). */
function kebab(v: string): string {
  return v.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** One variant of a discriminated-union field: the const that names it + its own field schemas. */
interface UnionVariant {
  value: string;
  /** RAW branch node (refs intact) — used for variant-scoped --explain rendering. */
  raw: SchemaNode;
  props: Record<string, SchemaNode>;
  description?: string;
}
interface UnionInfo {
  field: string;
  disc: "type" | "kind";
  variants: UnionVariant[];
}

/**
 * Detect the tool's discriminated-union object field (`action`/`params`/`subject`): a oneOf/anyOf
 * whose EVERY branch carries a const-valued `type` or `kind`. This is what lets the CLI surface
 * each variant as its own subcommand (`ch prepare phoenix exercise …`) — the most meaningful word
 * in the call stops hiding inside a JSON blob. Non-discriminated unions (decode's hex-or-object
 * `data`) are deliberately not matched.
 */
function discriminatedUnion(props: Record<string, SchemaNode>, defs: Record<string, SchemaNode>): UnionInfo | undefined {
  for (const [field, node0] of Object.entries(props)) {
    const node = resolveNode(node0, defs);
    const list = node.oneOf ?? node.anyOf;
    if (!list || list.length === 0) continue;
    let disc: "type" | "kind" | undefined;
    const variants: UnionVariant[] = [];
    for (const raw of list) {
      const b = resolveNode(raw, defs);
      const p = b.properties ?? {};
      const d = (["type", "kind"] as const).find((k) => typeof (p[k] as SchemaNode | undefined)?.const === "string");
      if (!d || (disc && d !== disc)) {
        disc = undefined;
        break;
      }
      disc = d;
      variants.push({ value: (p[d] as SchemaNode).const as string, raw, props: p, ...(b.description !== undefined ? { description: b.description } : {}) });
    }
    if (disc && variants.length === list.length) return { field, disc, variants };
  }
  return undefined;
}

/**
 * Exact human-amount sugar for digits-only fields: `1_000` strips underscores; `1000e18` /
 * `1.5e18` expand by pure string/integer arithmetic (nothing floating-point anywhere in the
 * path). A value that isn't sugar passes through untouched for the schema to judge; sugar that
 * cannot expand to an integer is an error worth teaching.
 */
export function expandAmount(raw: string): { ok: string } | { err: string } {
  const s = raw.replace(/_/g, "");
  if (/^[0-9]+$/.test(s)) return { ok: s };
  const m = /^([0-9]+)(?:\.([0-9]+))?[eE]\+?([0-9]+)$/.exec(s);
  if (!m) return { ok: raw };
  const expRaw = Number(m[3]);
  if (expRaw > 100) return { err: `'${raw}': exponent ${expRaw} is larger than any uint256 quantity (max ~1.16e77)` };
  const frac = m[2] ?? "";
  const exp = expRaw - frac.length;
  if (exp < 0) return { err: `'${raw}' does not expand to an integer — ${frac.length} decimal place(s) exceed the exponent ${expRaw}` };
  const digits = (m[1]! + frac).replace(/^0+(?=[0-9])/, "");
  return { ok: digits + "0".repeat(exp) };
}

/** Is this (resolved) node an amount-class field — a digits-only-pattern string? */
function isAmountNode(node: SchemaNode): boolean {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  return t === "string" && node.pattern === "^[0-9]+$";
}

/** A one-word placeholder for a flag's value, shown in --help. */
function describeShort(node: SchemaNode): string {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  if (node.enum && node.enum.length > 0) return "value";
  if (t === "number" || t === "integer") return "n";
  if (t === "boolean") return "true|false";
  return "value";
}

function firstSentence(text: string): string {
  const cut = text.split(/(?<=\.)\s/)[0] ?? text;
  return cut.length > 110 ? `${cut.slice(0, 107)}…` : cut;
}

/** Run the CLI over argv (without node/script prefix). Captures output; never calls process.exit. */
export async function runCli(
  argv: string[],
  ctx: HandlerContext = {},
  env: Record<string, string | undefined> = {},
): Promise<CliResult> {
  let out = "";
  let err = "";
  let code: number = EXIT.ok;
  const envWantsJson = env["CORK_JSON"] === "1" || env["CORK_JSON"] === "true";

  const program = new Command();
  program
    .name("ch")
    .description("Cork Phoenix CLI (ch) — reads, deterministic math, and unsigned tx/bundle preparation.")
    .version(BUILD_VERSION, "-V, --version", "print the ch version")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => (out += s),
      writeErr: (s) => (err += s),
    });

  // Group commands by their cliPath prefix so `prepare phoenix` nests under `prepare`.
  // parent.command() (vs new Command + addCommand) copies exitOverride/configureOutput from the
  // parent, so the capture wiring is declared once on `program`.
  const GROUP_DESCRIPTIONS: Record<string, string> = {
    prepare: "build unsigned artifacts (Bundler3 bundles, order typed-data, market deployment)",
  };
  const groups = new Map<string, Command>();
  const groupFor = (seg: string): Command => {
    let g = groups.get(seg);
    if (!g) {
      g = program.command(seg).description(GROUP_DESCRIPTIONS[seg] ?? `${seg} tools`);
      groups.set(seg, g);
    }
    return g;
  };

  // Every schema-derived flag across every tool, so argv can be normalised before commander
  // sees it (commander binds one long flag per option; spelling tolerance lives here).
  const knownFlags = new Set<string>();
  for (const tool of REGISTRY) {
    const s = inputJsonSchema(tool.name) as SchemaNode;
    for (const prop of Object.keys(s?.properties ?? {})) knownFlags.add(flagFor(prop));
  }

  // English-order rescue: commander dispatches subcommands on the FIRST operand only, so
  // `ch track verify market-ref …` (mode first, variant second) and `ch prepare phoenix 42161
  // exercise …` (chainId first) would never reach the variant. When the operand after the tool
  // path is a legal positional value AND the next one names a variant, swap them — the positional
  // rides as its flag (`--mode verify`), which the variant subcommand accepts anyway.
  const variantShuffles: Array<{ path: string[]; positionalFlag: string; positionalValues: Set<string>; variants: Set<string> }> = [];
  const shuffleVariantArgv = (argvIn: string[]): string[] => {
    for (const s of variantShuffles) {
      if (s.path.some((seg, i) => argvIn[i] !== seg)) continue;
      const i = s.path.length;
      const posVal = argvIn[i];
      const variantTok = argvIn[i + 1];
      if (posVal === undefined || variantTok === undefined || posVal.startsWith("--") || variantTok.startsWith("--")) continue;
      if (!s.positionalValues.has(posVal) || !s.variants.has(canonicalise(variantTok))) continue;
      return [...s.path, variantTok, `--${s.positionalFlag}`, posVal, ...argvIn.slice(i + 2)];
    }
    return argvIn;
  };

  for (const tool of REGISTRY) {
    const parent = tool.cliPath.length > 1 ? groupFor(tool.cliPath[0]!) : program;
    const schema = inputJsonSchema(tool.name) as SchemaNode;
    const defs = schema?.$defs ?? {};
    const props = Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([k, n]) => [k, resolveNode(n, defs)]));
    const required = schema?.required ?? [];
    // One positional, for the first required scalar — `ch query market`, `ch decode calldata`.
    const positional = required.find((r) => props[r] && isScalarNode(props[r]!));
    // The discriminated-union field (action/params/subject), if the tool has one: each of its
    // variants becomes a SUBCOMMAND (`ch prepare phoenix exercise …`) with the variant's own
    // fields flattened into flags. The legacy forms (positional chainId + --action/--params
    // blobs) keep working on the parent command — the subcommands are additive sugar.
    const union = discriminatedUnion(props, defs);

    const RESERVED = new Set(["json", "input", "rpcurl", "explain", "enabledeprecated", "help"]);
    const baseOptions = (c: Command): Command =>
      c
        // commander v12 silently ignores extra positional args by default — a typo like
        // `ch query market <poolId>` (input belongs in a flag) must error, not half-run.
        .allowExcessArguments(false)
        .option("--json [json]", "with a value: tool input as JSON. Bare: print JSON instead of prose.")
        .option("--input <json>", "tool input as a JSON string (unambiguous form of --json <json>)")
        .option("--rpc-url <url>", "RPC endpoint for chain-backed reads/compute")
        .option("--enable-deprecated", "unlock DEPRECATED features (e.g. the pre-2.1.0 registry generation via legacy:true) — same effect as CORK_ENABLE_DEPRECATED=1; every result they produce is labelled")
        .option("--explain", "print the tool's contract and exit (prose; JSON Schema under --json)");

    const fieldOption = (c: Command, registered: Set<string>, name: string, node: SchemaNode): void => {
      const canon = flagFor(name);
      // Duplicate/reserved canonical names would make one flag write two places — register the
      // first occurrence only; the variant-collision lint test asserts none exist in the registry.
      if (registered.has(canon) || RESERVED.has(canon)) return;
      registered.add(canon);
      const hint = isScalarNode(node) ? describeShort(node) : "json";
      // Fall back to the accepted values rather than echoing the flag's own name, which
      // tells a reader nothing they cannot see in the left-hand column.
      const help = node.description
        ? firstSentence(node.description)
        : node.enum && node.enum.length > 0
          ? `one of: ${node.enum.join(", ")}`
          : `${name} (see --explain)`;
      c.option(`--${canon} <${hint}>`, help);
    };

    const cmd = baseOptions(parent.command(leafName(tool)).description(`[phase ${tool.phase}] ${tool.description}`));
    if (positional) cmd.argument(`[${positional}]`, props[positional]?.description ? firstSentence(props[positional]!.description!) : `${positional} to act on`);
    const cmdRegistered = new Set<string>();
    for (const [name, node] of Object.entries(props)) {
      if (name === positional) continue;
      fieldOption(cmd, cmdRegistered, name, node);
    }

    /** One action body for the parent AND every variant subcommand (closure over out/err/code). */
    const makeAction = (variant?: UnionVariant) =>
      async (...args: unknown[]) => {
        // commander hands (positionalArgs..., options, command); options is second-to-last.
        // On a variant subcommand the PARENT parses any option it also declares (default
        // commander traversal: `--account` after `exercise` still binds to `prepare phoenix`),
        // so the sub merges the parent's consumed opts under its own.
        const self = args[args.length - 1] as Command;
        const parentOpts = variant ? ((self.parent?.opts() ?? {}) as Record<string, unknown>) : {};
        const opts = { ...parentOpts, ...(args[args.length - 2] as Record<string, unknown>) };
        // Variant subcommands take no positionals — every top-level field (chainId included)
        // rides as a flag there, so the variant name owns the readable slot.
        const positionalValue = !variant && positional ? (args[0] as string | undefined) : undefined;

        const jsonOpt = opts["json"];
        const wantsJson = jsonOpt !== undefined || envWantsJson;

        if (opts["explain"]) {
          // Variant-scoped explain: same renderer, with the union field narrowed to this branch
          // (raw node, refs intact) — `ch prepare phoenix exercise --explain` documents exercise.
          let schemaDoc = inputJsonSchema(tool.name) as SchemaNode;
          let cli = `ch ${tool.cliPath.join(" ")}`;
          if (variant && union) {
            const p = { ...(schemaDoc.properties ?? {}) } as Record<string, SchemaNode>;
            const fieldRaw = p[union.field] ?? {};
            const unionKey = fieldRaw.oneOf ? "oneOf" : "anyOf";
            p[union.field] = { ...fieldRaw, [unionKey]: [variant.raw] } as SchemaNode;
            schemaDoc = { ...schemaDoc, properties: p };
            cli += ` ${kebab(variant.value)}`;
          }
          const doc = { tool: tool.name, cli, phase: tool.phase, description: tool.description, inputSchema: schemaDoc };
          // explainWantsJson carries the explain-scoped env var; the global one applies too.
          out += wantsJson || explainWantsJson(undefined, env) ? `${JSON.stringify(doc, null, 2)}\n` : `${formatExplainText(doc)}\n`;
          return;
        }

        // Base input: whichever JSON form was supplied. `--json` with a value and `--input`
        // mean the same thing; a bare `--json` is an output request, not input.
        let input: Record<string, unknown> = {};
        const rawJson = typeof jsonOpt === "string" ? jsonOpt : typeof opts["input"] === "string" ? (opts["input"] as string) : undefined;
        if (rawJson !== undefined) {
          try {
            const parsed = parseJsonPrecise(rawJson);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected a JSON object");
            input = parsed as Record<string, unknown>;
          } catch (e) {
            const payload = { error: { code: "invalid_json", tool: tool.name, message: `invalid JSON input: ${(e as Error).message}` } };
            err += wantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
            code = EXIT.invalid;
            return;
          }
        }

        /** Assign one flag value with amount sugar + scalar/JSON handling; false = error emitted. */
        const assign = (target: Record<string, unknown>, name: string, node: SchemaNode, supplied: unknown): boolean => {
          let rawStr = String(supplied);
          if (isAmountNode(node) && /[_eE]/.test(rawStr)) {
            const ex = expandAmount(rawStr);
            if ("err" in ex) {
              const payload = { error: { code: "invalid_amount", tool: tool.name, message: `--${flagFor(name)}: ${ex.err}` } };
              err += wantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
              code = EXIT.invalid;
              return false;
            }
            rawStr = ex.ok;
          }
          if (isScalarNode(node)) {
            target[name] = coerce(node, rawStr);
            return true;
          }
          try {
            target[name] = parseJsonPrecise(rawStr);
          } catch (e) {
            // Not parseable as JSON: if the SCHEMA admits a string for this field (union-typed,
            // e.g. `--data 0xdeadbeef` on decode: hex-or-object), pass the raw value through and
            // let schema validation judge it. Object-only fields keep the loud parse error.
            if (admitsString(node, defs)) {
              target[name] = rawStr;
              return true;
            }
            const payload = { error: { code: "invalid_json", tool: tool.name, message: `--${flagFor(name)} expects JSON: ${(e as Error).message}` } };
            err += wantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
            code = EXIT.invalid;
            return false;
          }
          return true;
        };

        // Then the ergonomic forms, which win over the JSON blob so a flag can override it.
        if (positional && positionalValue !== undefined) input[positional] = coerce(props[positional]!, positionalValue);
        for (const [name, node] of Object.entries(props)) {
          if (!variant && name === positional) continue;
          if (variant && union && name === union.field) continue;
          const supplied = opts[flagFor(name)];
          if (supplied === undefined) continue;
          if (!assign(input, name, node, supplied)) return;
        }

        // Variant subcommand: build the union object — a blob-supplied field is the base, the
        // variant's flattened flags override it, and the discriminator is always injected from
        // the subcommand's own name (never trusted from the blob).
        if (variant && union) {
          const blobBase = input[union.field];
          const obj: Record<string, unknown> =
            blobBase && typeof blobBase === "object" && !Array.isArray(blobBase) ? { ...(blobBase as Record<string, unknown>) } : {};
          for (const [name, node0] of Object.entries(variant.props)) {
            if (name === union.disc) continue;
            const supplied = opts[flagFor(name)];
            if (supplied === undefined) continue;
            if (!assign(obj, name, resolveNode(node0, defs), supplied)) return;
          }
          obj[union.disc] = variant.value;
          input[union.field] = obj;
        }

        // --enable-deprecated maps onto the same env var the gate reads (deprecation.ts), so the
        // CLI flag and MCP env configuration stay one mechanism.
        if (opts["enableDeprecated"]) process.env["CORK_ENABLE_DEPRECATED"] = "1";
        const callCtx: HandlerContext = { ...ctx, ...(opts["rpcUrl"] ? { rpcUrl: opts["rpcUrl"] as string } : {}) };
        try {
          const envelope = await runTool(tool.name, input, callCtx);
          out += wantsJson ? `${JSON.stringify(envelope, null, 2)}\n` : renderEnvelope(envelope, tool);
          const state = (envelope as { state?: string }).state;
          code = state === "ok" ? EXIT.ok : state === "conflict" ? EXIT.conflict : EXIT.unavailable;
        } catch (e) {
          // Errors are structured on stderr with the same closed codes as the envelope, so
          // scripts parse failures the way they parse stdout.
          if (e instanceof ToolInputError) {
            const payload = { error: { code: "invalid_input", tool: e.tool, issues: e.issues, ...(e.teaching ? { remediation: e.teaching.remediation, example: e.teaching.example, suggestions: e.teaching.issues.filter((i) => i.suggestion) } : {}) } };
            err += wantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
            code = EXIT.invalid;
          } else {
            const payload = { error: { code: "internal_error", tool: tool.name, message: (e as Error).message.split("\n")[0] } };
            err += wantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
            code = EXIT.error;
          }
        }
      };

    cmd.action(makeAction());

    if (union) {
      if (positional && props[positional]?.enum?.length) {
        variantShuffles.push({
          path: [...tool.cliPath],
          positionalFlag: flagFor(positional),
          positionalValues: new Set(props[positional]!.enum!.map((e) => String(e))),
          variants: new Set(union.variants.map((v) => canonicalise(kebab(v.value)))),
        });
      }
      for (const v of union.variants) {
        const sub = baseOptions(
          cmd
            .command(kebab(v.value))
            .description(firstSentence(v.description ?? `${v.value} (see --explain)`)),
        );
        const subRegistered = new Set<string>();
        // Top-level fields ride as flags here (chainId included — the variant owns the slot).
        for (const [name, node] of Object.entries(props)) {
          if (union.field === name) continue;
          fieldOption(sub, subRegistered, name, node);
        }
        // The variant's own fields, flattened.
        for (const [name, node0] of Object.entries(v.props)) {
          if (name === union.disc) continue;
          const node = resolveNode(node0, defs);
          fieldOption(sub, subRegistered, name, node);
          knownFlags.add(flagFor(name));
        }
        sub.action(makeAction(v));
      }
    }
  }

  // Non-tool commands: version/build identity, the MCP server, and self-update. These are CLI
  // plumbing, not registry tools — no envelope, no --explain.
  program
    .command("version")
    .description("print version and build identity (--json for machine-readable)")
    .option("--json", "print as JSON")
    .action((opts: { json?: boolean }) => {
      const info = {
        version: BUILD_VERSION,
        commit: BUILD_COMMIT,
        target: BUILD_TARGET || null,
        schemaVersion: SCHEMA_VERSION,
        runtime: (globalThis as { Bun?: { version: string } }).Bun ? `bun ${(globalThis as { Bun?: { version: string } }).Bun!.version}` : `node ${process.versions.node}`,
      };
      out +=
        opts.json || envWantsJson
          ? `${JSON.stringify(info, null, 2)}\n`
          : `ch ${info.version} (commit ${info.commit})\n  target   ${info.target ?? "(source run)"}\n  schema   ${info.schemaVersion}\n  runtime  ${info.runtime}\n`;
    });

  program
    .command("mcp")
    .description("start the Cork MCP server (all 9 tools): stdio by default (`claude mcp add cork-defi -- ch mcp`), or Streamable HTTP with --http [--port 8080] (endpoint /mcp, health /healthz, docs /docs/signing; bearer auth via CORK_MCP_TOKEN)")
    .option("--http", "serve Streamable HTTP instead of stdio")
    .option("--port <port>", "HTTP port (default 8080)")
    .action(() => {
      // The real server must own stdio from process start, so the binary entrypoint (bin.ts)
      // intercepts `mcp` before commander ever parses. Reaching this action means runCli was
      // invoked directly (tests/embedding), where a captured stdio server cannot work.
      err += "the MCP server owns stdio from process start — run it via the ch entrypoint: `ch mcp`\n";
      code = EXIT.error;
    });

  program
    .command("self-update")
    .description("update ch in place from the latest GitHub release (verifies provenance before swapping)")
    .option("--tag <tag>", "update to a specific release tag instead of latest")
    .option("--dry-run", "resolve and report what would change without downloading")
    .action(async (opts: { tag?: string; dryRun?: boolean }) => {
      const res = await runSelfUpdate({ ...(opts.tag ? { tag: opts.tag } : {}), ...(opts.dryRun ? { dryRun: true } : {}) });
      out += res.out;
      err += res.err;
      code = res.code === 0 ? EXIT.ok : EXIT.error;
    });

  try {
    await program.parseAsync(shuffleVariantArgv(normaliseArgv(argv, knownFlags)), { from: "user" });
  } catch (e) {
    // exitOverride throws CommanderError for --help/--version/parse errors.
    const ce = e as { code?: string; exitCode?: number; message?: string };
    if (ce.code === "commander.helpDisplayed" || ce.code === "commander.help" || ce.code === "commander.version") {
      code = EXIT.ok;
    } else {
      if (err === "" && ce.message) err += `${ce.message}\n`;
      code = code === EXIT.ok ? EXIT.invalid : code;
    }
  }

  return { code, stdout: out, stderr: err };
}
