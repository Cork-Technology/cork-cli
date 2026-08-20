// The warning-code registry gate: WARNING_FAMILIES (packages/schemas/doc-topics.ts) must equal —
// exactly — the set of codes the handlers actually emit. There is deliberately no central code
// enum in src (codes are born next to their messages, where the teaching lives), so the registry
// is enforced BY TEST: this file extracts every emitted code literal from packages/core/src and
// requires set-equality with the registry. A new code without a family classification, or a
// registry entry nothing emits anymore, fails offline — the same registry-by-test posture as the
// API-surface gate, applied to the envelope's fastest-growing vocabulary.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDocTopic, WARNING_FAMILIES } from "@cork/schemas";

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

/** Every code literal the handlers emit, via the two emission shapes:
 *  `code: "<snake>"` on a warning object (excluding zod's addIssue vocabulary), and the
 *  `unavailable(<target>, "<snake>", …)` positional. Mirrors the shapes the codebase actually
 *  uses — a third emission shape would surface here as a missing-code failure, which is the
 *  point: emission shapes are part of the contract this test pins. */
function emittedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of tsFiles(new URL("../src", import.meta.url).pathname)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.includes("addIssue")) continue; // zod issue codes, not envelope warning codes
      for (const m of line.matchAll(/code: "([a-z0-9_]+)"/g)) codes.add(m[1]!);
      for (const m of line.matchAll(/unavailable\([^,]+, "([a-z0-9_]+)"/g)) codes.add(m[1]!);
    }
  }
  return codes;
}

describe("warning-code registry (WARNING_FAMILIES ↔ emitted codes, exact)", () => {
  const registry = new Set(WARNING_FAMILIES.flatMap((f) => [...f.codes]));
  const emitted = emittedCodes();

  it("every emitted code is classified into exactly one family", () => {
    const unclassified = [...emitted].filter((c) => !registry.has(c)).sort();
    expect(unclassified, `emitted but not in WARNING_FAMILIES — classify them: ${unclassified.join(", ")}`).toEqual([]);
    const seen = new Map<string, string>();
    for (const f of WARNING_FAMILIES) {
      for (const c of f.codes) {
        expect(seen.has(c), `code '${c}' appears in both '${seen.get(c)}' and '${f.family}'`).toBe(false);
        seen.set(c, f.family);
      }
    }
  });

  it("every registry code is actually emitted (no dead documentation)", () => {
    const dead = [...registry].filter((c) => !emitted.has(c)).sort();
    expect(dead, `documented but never emitted — retire them from WARNING_FAMILIES: ${dead.join(", ")}`).toEqual([]);
  });

  it("the extraction sees a healthy corpus (tripwire against a silently broken glob/regex)", () => {
    // If a refactor moves the handlers or changes the emission shape wholesale, this floor
    // fails loudly instead of letting both sets shrink toward vacuous equality.
    expect(emitted.size).toBeGreaterThan(80);
  });

  it("topic:'warnings' resolves by name and by every alias, and its table is generated from the registry", () => {
    const topic = findDocTopic("warnings")!;
    expect(topic).toBeDefined();
    for (const alias of ["warning-codes", "codes", "envelope", "states"]) {
      expect(findDocTopic(alias)?.name).toBe("warnings");
    }
    for (const f of WARNING_FAMILIES) {
      expect(topic.body).toContain(`| ${f.family} | ${f.envelope} |`);
      for (const c of f.codes) expect(topic.body).toContain(`\`${c}\``);
    }
  });
});
