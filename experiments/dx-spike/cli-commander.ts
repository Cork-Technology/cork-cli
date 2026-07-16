// cli-commander.ts — EXIT-DIRECTION TEST: render the SAME untouched registry onto
// bare commander (no trpc-cli). This prices the "re-renders in days" claim.
// Feature parity target: nested commands, kebab flags, positionals, defaults,
// number coercion, --json whole-input mode, validation, JSON error envelope, help.
import { z } from "zod";
import { Command } from "commander";
import { registry, type ToolDef } from "./registry.ts";

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

type PropInfo = { key: string; kind: string; hasDefault: boolean; description: string };

function props(input: z.ZodObject): PropInfo[] {
  return Object.entries(input.shape).map(([key, schema]) => {
    let s = schema as z.ZodType;
    let hasDefault = false;
    for (;;) {
      const def = (s as { _zod: { def: { type: string; innerType?: z.ZodType } } })._zod.def;
      if (def.type === "default") hasDefault = true;
      if ((def.type === "default" || def.type === "optional") && def.innerType) s = def.innerType;
      else return { key, kind: def.type, hasDefault, description: (schema as z.ZodType).description ?? "" };
    }
  });
}

function fail(message: string, issues?: unknown): never {
  console.error(JSON.stringify({ error: { message, issues } }, null, 2));
  process.exit(1);
}

function run(def: ToolDef, raw: Record<string, unknown>, jsonArg: string | undefined): void {
  let candidate: unknown = raw;
  if (jsonArg !== undefined) {
    try {
      candidate = JSON.parse(jsonArg);
    } catch {
      fail("--json argument is not valid JSON");
    }
  }
  const parsed = def.input.safeParse(candidate);
  if (!parsed.success) fail("invalid input", parsed.error.issues);
  Promise.resolve(def.handler(parsed.data as never)).then(
    (out) => console.log(JSON.stringify(def.output.parse(out), null, 2)),
    (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
  );
}

const program = new Command("cork").version("0.0.0-spike-exit");
const groups = new Map<string, Command>();

for (const def of registry) {
  const [group, verb] = def.cliPath as [string, string];
  let parent = groups.get(group);
  if (!parent) {
    parent = program.command(group);
    groups.set(group, parent);
  }
  const cmd = parent.command(verb).description(def.description);
  const positionals = def.positional ?? [];
  const infos = props(def.input);
  for (const p of positionals) {
    const info = infos.find((i) => i.key === p);
    cmd.argument(`[${p}]`, info?.description ?? "");
  }
  for (const info of infos) {
    if (positionals.includes(info.key)) continue;
    const flag = `--${kebab(info.key)} <value>`;
    cmd.option(flag, info.description + (info.hasDefault ? " (has default)" : ""));
  }
  cmd.option("--json <json>", "supply the complete input as one JSON object");
  cmd.action((...args: unknown[]) => {
    const opts = cmd.opts<Record<string, string>>();
    const posValues = args.slice(0, positionals.length) as (string | undefined)[];
    const raw: Record<string, unknown> = {};
    positionals.forEach((p, i) => {
      if (posValues[i] !== undefined) raw[p] = posValues[i];
    });
    for (const info of infos) {
      const camel = info.key;
      const v = opts[camel];
      if (v === undefined || positionals.includes(camel)) continue;
      raw[camel] = info.kind === "number" ? Number(v) : info.kind === "boolean" ? v !== "false" : v;
    }
    run(def, raw, opts["json"]);
  });
}

program.parse();
