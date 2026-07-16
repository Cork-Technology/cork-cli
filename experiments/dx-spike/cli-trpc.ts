// cli-trpc.ts — projection: registry -> trpc-cli. CLI meta (positional) is injected
// HERE, not in the registry, so registry schemas stay clean for MCP export.
import { z } from "zod";
import { createCli, t } from "trpc-cli";
import { registry, type ToolDef } from "./registry.ts";

function toProcedure(def: ToolDef) {
  const shape = def.input.shape;
  const withMeta = Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      def.positional?.includes(key) ? (schema as z.ZodType).meta({ positional: true }) : schema,
    ]),
  );
  return t.procedure
    .meta({ description: def.description })
    .input(z.object(withMeta))
    .query(async ({ input }) => def.output.parse(await def.handler(input as never)));
}

const router = t.router(
  Object.fromEntries(registry.map((def) => [def.cliPath.join(" "), toProcedure(def)])),
);

void createCli({ router, name: "cork", version: "0.0.0-spike", jsonInput: "auto" }).run();
