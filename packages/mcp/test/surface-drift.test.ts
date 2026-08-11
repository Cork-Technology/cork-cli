// Layer-A eval gate: the advertised tool surface (names, descriptions incl. inline examples,
// FULL input/output schemas, annotations) is snapshotted to a committed fixture. Any diff fails
// CI until the fixture is regenerated deliberately. The gate is TIERED mechanically
// (surface-tier.ts, owner-approved 2026-08-11): a sentence-preserving rewording of existing
// description strings is prose tier (regenerate, no eval); anything structural — keys, names,
// types, enums, x-units, sentence counts — is semantic tier (run Layer B, then regenerate).
// Schemas are stored as FULL JSON, not hashes (since 2026-08-11): a hash flip is detectable but
// not reviewable, the classifier needs the material, and a units change should be readable in
// the fixture diff.
//
// Regenerate after an intentional change:  UPDATE_SURFACE=1 bunx vitest run packages/mcp/test/surface-drift.test.ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCorkServer } from "@cork/mcp";
import { classifySurfaceDelta } from "../src/surface-tier.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "tool-surface.json");

interface SurfaceEntry {
  name: string;
  description: string;
  descriptionTokensApprox: number; // chars/4 — a drift-visible budget proxy, not an exact count
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: Record<string, unknown>;
}

/** The whole agent-visible surface: the initialize `instructions` string is prompt-injected into
 *  every connected agent exactly like tool descriptions are, so it drifts under the same gate. */
interface Surface {
  instructions: string;
  tools: SurfaceEntry[];
}

async function currentSurface(): Promise<Surface> {
  const server = createCorkServer({ nowSeconds: 1_800_000_000n });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drift-gate", version: "0" });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  const { tools } = await client.listTools();
  return {
    instructions: client.getInstructions() ?? "",
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      descriptionTokensApprox: Math.ceil((t.description ?? "").length / 4),
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema ?? null,
      annotations: (t.annotations ?? {}) as Record<string, unknown>,
    })),
  };
}

describe("tool-surface drift gate", () => {
  it("advertised surface matches the committed fixture (or UPDATE_SURFACE=1 to regenerate)", async () => {
    const surface = await currentSurface();

    if (process.env.UPDATE_SURFACE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(surface, null, 2) + "\n");
      expect(surface.tools.length).toBe(9);
      expect(surface.instructions.length).toBeGreaterThan(0);
      return; // fixture (re)generated deliberately — record and pass
    }

    const committed = JSON.parse(readFileSync(FIXTURE, "utf8")) as Surface;
    const verdict = classifySurfaceDelta(committed, surface);
    const paths = verdict.changes.slice(0, 12).map((c) => `${c.kind} ${c.path}`).join("; ");
    const guidance =
      verdict.tier === "prose"
        ? `PROSE-tier surface edit (sentence-preserving rewording of existing descriptions only): regenerate the fixture with UPDATE_SURFACE=1 — no eval run required (mechanical tier, surface-tier.ts). Changes: ${paths}`
        : `SEMANTIC-tier surface change: run the agent evals against the new surface (bun run eval; EVAL_HELD_OUT=1 per the cadence), then regenerate the fixture with UPDATE_SURFACE=1. Changes: ${paths}`;
    expect(surface, guidance).toEqual(committed);
  });

  it("description token budget stays bounded (context economy)", async () => {
    const surface = await currentSurface();
    const total = surface.tools.reduce((s, t) => s + t.descriptionTokensApprox, 0) + Math.ceil(surface.instructions.length / 4);
    // 9 tools incl. one inline example each + the instructions string — generous ceiling that
    // still catches runaway prose.
    expect(total).toBeLessThan(3000);
  });
});
