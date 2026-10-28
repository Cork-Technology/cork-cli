// cork-telemetry-core@40e0e86 vectors.test.ts
/**
 * Cork telemetry scrub conformance. CORE FILE: copy as is, next to the
 * repo's copy of vectors.json. Change only the import path of scrub.js.
 * Runs under vitest and under `bun test` (bun maps "vitest" to bun:test).
 *
 * vectors.json is data: never edit a copy. Change the source, then re-copy.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { registerSecret, resetSecretsForTests, scrubProperties, scrubText, scrubValue } from "../src/lib/scrub.js";

type Case = {
  id: string;
  fn: "scrubText" | "scrubValue" | "scrubProperties";
  input: unknown;
  expect?: unknown;
  expectAbsent?: unknown[];
  expectPresent?: unknown[];
};
type Vectors = { version: number; setup?: { registerSecrets?: unknown[] }; cases: Case[] };

// JSON.parse keeps `__proto__` as an own key (an import would too, but not every runner agrees).
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as Vectors;

/** `{ "$join": [..] }` -> the parts joined; applied everywhere in the case. */
function resolve(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolve);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.$join) && Object.keys(o).length === 1) return o.$join.join("");
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      Object.defineProperty(out, k, { value: resolve(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

const FNS = {
  scrubText: (x: unknown) => scrubText(x as string),
  scrubValue: (x: unknown) => scrubValue(x),
  scrubProperties: (x: unknown) => scrubProperties(x as Record<string, unknown>),
} as const;

describe(`scrub conformance vectors v${vectors.version}`, () => {
  beforeAll(() => {
    resetSecretsForTests();
    for (const s of vectors.setup?.registerSecrets ?? []) registerSecret(resolve(s) as string);
  });

  it("has unique ids", () => {
    const ids = vectors.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const c of vectors.cases) {
    it(c.id, () => {
      const out = FNS[c.fn](resolve(c.input));
      const json = typeof out === "string" ? out : JSON.stringify(out);
      if ("expect" in c) expect(out).toEqual(resolve(c.expect));
      for (const a of (resolve(c.expectAbsent ?? []) as string[])) expect(json.toLowerCase()).not.toContain(a.toLowerCase());
      for (const p of (resolve(c.expectPresent ?? []) as string[])) expect(json).toContain(p);
    });
  }
});
