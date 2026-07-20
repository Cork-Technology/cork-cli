// Layer-A eval gate: the advertised tool surface (names, descriptions incl. inline examples,
// input/output schemas, annotations) is snapshotted to a committed fixture. Any diff fails CI
// until the fixture is regenerated deliberately — description/schema changes are exactly what the
// agent-eval suite (evals/) exists to gate, so a drift here means "run Layer B, then update".
//
// Regenerate after an intentional change:  UPDATE_SURFACE=1 bunx vitest run packages/mcp/test/surface-drift.test.ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCorkServer } from "@cork/mcp";

const FIXTURE = join(import.meta.dirname, "fixtures", "tool-surface.json");

interface SurfaceEntry {
  name: string;
  description: string;
  descriptionTokensApprox: number; // chars/4 — a drift-visible budget proxy, not an exact count
  inputSchemaSha256: string;
  outputSchemaSha256: string;
  annotations: Record<string, unknown>;
}

function sha(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

async function currentSurface(): Promise<SurfaceEntry[]> {
  const server = createCorkServer({ nowSeconds: 1_800_000_000n });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drift-gate", version: "0" });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    descriptionTokensApprox: Math.ceil((t.description ?? "").length / 4),
    inputSchemaSha256: sha(t.inputSchema),
    outputSchemaSha256: sha(t.outputSchema ?? null),
    annotations: (t.annotations ?? {}) as Record<string, unknown>,
  }));
}

describe("tool-surface drift gate", () => {
  it("advertised surface matches the committed fixture (or UPDATE_SURFACE=1 to regenerate)", async () => {
    const surface = await currentSurface();

    if (process.env.UPDATE_SURFACE || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, JSON.stringify(surface, null, 2) + "\n");
      expect(surface.length).toBe(9);
      return; // fixture (re)generated deliberately — record and pass
    }

    const committed = JSON.parse(readFileSync(FIXTURE, "utf8")) as SurfaceEntry[];
    expect(
      surface,
      "Tool surface changed (names/descriptions/schemas). This is eval-gated: run the agent evals (bun run eval) against the new surface, then regenerate the fixture with UPDATE_SURFACE=1.",
    ).toEqual(committed);
  });

  it("description token budget stays bounded (context economy)", async () => {
    const surface = await currentSurface();
    const total = surface.reduce((s, t) => s + t.descriptionTokensApprox, 0);
    // 9 tools incl. one inline example each — generous ceiling that still catches runaway prose.
    expect(total).toBeLessThan(3000);
  });
});
