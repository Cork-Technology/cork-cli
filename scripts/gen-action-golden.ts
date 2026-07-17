// Regenerate packages/core/test/fixtures/action-golden.json — independent `cast` calldata for
// every action in ACTION_VECTORS. Field order + type string are derived from corkAdapterAbi, so
// this never transcribes a struct layout by hand. Run: bun scripts/gen-action-golden.ts
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { corkAdapterAbi } from "../packages/core/src/bundle/corkAdapterAbi.ts";
import { ACTION_VECTORS, castValue } from "../packages/core/test/fixtures/action-vectors.ts";

type Comp = { name: string; type: string };
function fn(name: string) {
  const f = corkAdapterAbi.find((x) => x.type === "function" && x.name === name);
  if (!f || f.type !== "function") throw new Error(`no abi fn ${name}`);
  const tuple = f.inputs[0] as { components: readonly Comp[] };
  return tuple.components;
}

// Build one shell script running cast for all 13, emitting `name<TAB>0x…`.
const lines: string[] = [];
for (const v of ACTION_VECTORS) {
  const comps = fn(v.name);
  const typeStr = `(${comps.map((c) => c.type).join(",")})`;
  const args = comps.map((c) => castValue((v.params as Record<string, unknown>)[c.name])).join(",");
  const sig = `${v.name}(${typeStr})`;
  lines.push(`printf '%s\\t' '${v.name}'; cast calldata '${sig}' '(${args})'`);
}
const script = lines.join("\n");

const out = execFileSync(
  "podman",
  ["run", "--rm", "--entrypoint", "sh", "ghcr.io/foundry-rs/foundry:latest", "-c", script],
  { encoding: "utf8" },
);

const golden: Record<string, string> = {};
for (const line of out.split("\n")) {
  const [name, calldata] = line.split("\t");
  if (name && calldata?.startsWith("0x")) golden[name] = calldata.trim();
}
if (Object.keys(golden).length !== ACTION_VECTORS.length) {
  throw new Error(`expected ${ACTION_VECTORS.length} golden entries, got ${Object.keys(golden).length}: ${out}`);
}
const path = new URL("../packages/core/test/fixtures/action-golden.json", import.meta.url);
writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${Object.keys(golden).length} golden vectors`);
