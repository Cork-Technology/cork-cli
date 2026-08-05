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
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
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

  for (const tool of REGISTRY) {
    const parent = tool.cliPath.length > 1 ? groupFor(tool.cliPath[0]!) : program;
    const schema = inputJsonSchema(tool.name) as SchemaNode;
    const props = schema?.properties ?? {};
    const required = schema?.required ?? [];
    // One positional, for the first required scalar — `ch query market`, `ch decode calldata`.
    const positional = required.find((r) => props[r] && isScalarNode(props[r]!));

    const cmd = parent
      .command(leafName(tool))
      .description(`[phase ${tool.phase}] ${tool.description}`)
      // commander v12 silently ignores extra positional args by default — a typo like
      // `ch query market <poolId>` (input belongs in a flag) must error, not half-run.
      .allowExcessArguments(false)
      .option("--json [json]", "with a value: tool input as JSON. Bare: print JSON instead of prose.")
      .option("--input <json>", "tool input as a JSON string (unambiguous form of --json <json>)")
      .option("--rpc-url <url>", "RPC endpoint for chain-backed reads/compute")
      .option("--enable-deprecated", "unlock DEPRECATED features (e.g. the pre-2.1.0 registry generation via legacy:true) — same effect as CORK_ENABLE_DEPRECATED=1; every result they produce is labelled")
      .option("--explain", "print the tool's contract and exit (prose; JSON Schema under --json)");

    if (positional) cmd.argument(`[${positional}]`, props[positional]?.description ? firstSentence(props[positional]!.description!) : `${positional} to act on`);

    for (const [name, node] of Object.entries(props)) {
      if (name === positional) continue;
      const hint = isScalarNode(node) ? describeShort(node) : "json";
      // Fall back to the accepted values rather than echoing the flag's own name, which
      // tells a reader nothing they cannot see in the left-hand column.
      const help = node.description
        ? firstSentence(node.description)
        : node.enum && node.enum.length > 0
          ? `one of: ${node.enum.join(", ")}`
          : `${name} (see --explain)`;
      cmd.option(`--${flagFor(name)} <${hint}>`, help);
    }

    cmd.action(async (...args: unknown[]) => {
      // commander hands (positionalArgs..., options, command); options is second-to-last.
      const opts = args[args.length - 2] as Record<string, unknown>;
      const positionalValue = positional ? (args[0] as string | undefined) : undefined;

      const jsonOpt = opts["json"];
      const wantsJson = jsonOpt !== undefined || envWantsJson;

      if (opts["explain"]) {
        const doc = { tool: tool.name, cli: `ch ${tool.cliPath.join(" ")}`, phase: tool.phase, description: tool.description, inputSchema: inputJsonSchema(tool.name) };
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

      // Then the ergonomic forms, which win over the JSON blob so a flag can override it.
      if (positional && positionalValue !== undefined) input[positional] = coerce(props[positional]!, positionalValue);
      for (const [name, node] of Object.entries(props)) {
        if (name === positional) continue;
        const supplied = opts[flagFor(name)];
        if (supplied === undefined) continue;
        if (isScalarNode(node)) {
          input[name] = coerce(node, String(supplied));
          continue;
        }
        try {
          input[name] = parseJsonPrecise(String(supplied));
        } catch (e) {
          const payload = { error: { code: "invalid_json", tool: tool.name, message: `--${flagFor(name)} expects JSON: ${(e as Error).message}` } };
          err += wantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
          code = EXIT.invalid;
          return;
        }
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
    });
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
    await program.parseAsync(normaliseArgv(argv, knownFlags), { from: "user" });
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
