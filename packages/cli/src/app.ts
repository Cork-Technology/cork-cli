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
    .name("cork")
    .description("Cork Phoenix CLI — reads, deterministic math, and unsigned tx/bundle preparation.")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => (out += s),
      writeErr: (s) => (err += s),
    });

  // Group commands by their cliPath prefix so `prepare phoenix` nests under `prepare`.
  const groups = new Map<string, Command>();
  const groupFor = (seg: string): Command => {
    let g = groups.get(seg);
    if (!g) {
      g = new Command(seg).exitOverride().configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (err += s) });
      groups.set(seg, g);
      program.addCommand(g);
    }
    return g;
  };

  for (const tool of REGISTRY) {
    const parent = tool.cliPath.length > 1 ? groupFor(tool.cliPath[0]!) : program;
    const cmd = new Command(leafName(tool))
      .description(`[phase ${tool.phase}] ${tool.description}`)
      .option("--json <json>", "structured tool input as a JSON string")
      .option("--rpc-url <url>", "RPC endpoint for chain-backed reads/compute")
      .option("--explain", "print the tool's contract (description + JSON schema) and exit")
      .exitOverride()
      .configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (err += s) })
      .action(async (opts: { json?: string; rpcUrl?: string; explain?: boolean }) => {
        if (opts.explain) {
          out += `${JSON.stringify({ tool: tool.name, cli: `cork ${tool.cliPath.join(" ")}`, phase: tool.phase, description: tool.description, inputSchema: inputJsonSchema(tool.name) }, null, 2)}\n`;
          return;
        }
        let input: unknown = {};
        if (opts.json) {
          try {
            input = JSON.parse(opts.json);
          } catch (e) {
            err += `invalid --json: ${(e as Error).message}\n`;
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
          if (e instanceof ToolInputError) {
            err += `invalid input for ${e.tool}: ${JSON.stringify(e.issues)}\n`;
            code = EXIT.invalid;
          } else {
            err += `error: ${(e as Error).message}\n`;
            code = EXIT.error;
          }
        }
      });
    parent.addCommand(cmd);
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
