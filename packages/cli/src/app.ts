// CLI projection of the same registry the MCP server uses — one command per tool at its cliPath.
// Structured input arrives via --json (the canonical wire shape); --explain prints the tool's
// contract (description + JSON schema) without running. Exit codes map envelope state so scripts
// can branch: 0 ok, 2 invalid input, 3 unavailable, 4 conflict, 1 unexpected error.
import { Command } from "commander";
import { REGISTRY, inputJsonSchema, type ToolDef } from "@cork/schemas";
import { runTool, ToolInputError, type HandlerContext } from "@cork/core";

export const EXIT = { ok: 0, error: 1, invalid: 2, unavailable: 3, conflict: 4 } as const;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function leafName(tool: ToolDef): string {
  return tool.cliPath[tool.cliPath.length - 1]!;
}

/** Run the CLI over argv (without node/script prefix). Captures output; never calls process.exit. */
export async function runCli(argv: string[], ctx: HandlerContext = {}): Promise<CliResult> {
  let out = "";
  let err = "";
  let code: number = EXIT.ok;
  const program = new Command();
  program
    .name("ch")
    .description("Cork Phoenix CLI (ch) — reads, deterministic math, and unsigned tx/bundle preparation.")
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

  for (const tool of REGISTRY) {
    const parent = tool.cliPath.length > 1 ? groupFor(tool.cliPath[0]!) : program;
    parent
      .command(leafName(tool))
      .description(`[phase ${tool.phase}] ${tool.description}`)
      .option("--json <json>", "structured tool input as a JSON string")
      .option("--rpc-url <url>", "RPC endpoint for chain-backed reads/compute")
      .option("--explain", "print the tool's contract (description + JSON schema) and exit")
      .action(async (opts: { json?: string; rpcUrl?: string; explain?: boolean }) => {
        if (opts.explain) {
          out += `${JSON.stringify({ tool: tool.name, cli: `ch ${tool.cliPath.join(" ")}`, phase: tool.phase, description: tool.description, inputSchema: inputJsonSchema(tool.name) }, null, 2)}\n`;
          return;
        }
        let input: unknown = {};
        if (opts.json) {
          try {
            input = JSON.parse(opts.json);
          } catch (e) {
            err += `${JSON.stringify({ error: { code: "invalid_json", tool: tool.name, message: `invalid --json: ${(e as Error).message}` } })}\n`;
            code = EXIT.invalid;
            return;
          }
        }
        const callCtx: HandlerContext = { ...ctx, ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}) };
        try {
          const envelope = await runTool(tool.name, input, callCtx);
          out += `${JSON.stringify(envelope, null, 2)}\n`;
          code = envelope.state === "ok" ? EXIT.ok : envelope.state === "conflict" ? EXIT.conflict : EXIT.unavailable;
        } catch (e) {
          // Errors are structured JSON on stderr (one object per line) with the same closed codes
          // as the envelope, so scripts parse failures the same way they parse stdout.
          if (e instanceof ToolInputError) {
            err += `${JSON.stringify({ error: { code: "invalid_input", tool: e.tool, issues: e.issues, ...(e.teaching ? { remediation: e.teaching.remediation, example: e.teaching.example, suggestions: e.teaching.issues.filter((i) => i.suggestion) } : {}) } })}\n`;
            code = EXIT.invalid;
          } else {
            err += `${JSON.stringify({ error: { code: "internal_error", tool: tool.name, message: (e as Error).message.split("\n")[0] } })}\n`;
            code = EXIT.error;
          }
        }
      });
  }

  try {
    await program.parseAsync(argv, { from: "user" });
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
