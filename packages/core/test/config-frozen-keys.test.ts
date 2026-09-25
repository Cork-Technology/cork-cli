// The frozen-keys tripwire (policy R5c, 2026-09-25). A released line fetches its address document
// from its line's CONFIG branch (config/<major>.<minor>, holding only that file) and resolves `generation` against the document's set KEYS, so a
// key a released line knows may never disappear from the file that line reads. This test holds
// the tree's files to that, and — under CORK_RPC_LIVE=1 — the PUBLIC branches too (the file a
// released binary actually fetches). It exists because on 2026-09-25 the keys of the main-branch
// file were renamed under the released 0.6.0 and `--generation phoenix/v0.4-rc.1` stopped
// working within the hour; no test could see it because none read the live file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { corkDefaultsUrlFor, releaseLineOf } from "@cork/core";

type Doc = { schemaVersion: number; generations: Record<string, { primary: string; sets: Record<string, unknown> }> };

/** Per released line: the document it reads and the set keys its binaries know per chain. A line
 *  is appended when it is cut and NEVER edited afterwards — that is the point. */
export const RELEASED_LINE_KEYS: ReadonlyArray<{ line: string; file: string; ref: string; keys: Record<string, readonly string[]> }> = [
  {
    // 0.6.0 (tag v0.6.0, 2026-09-24) fetches cork-defaults.v2.json from MAIN by name and knows the record names.
    line: "0.6.0",
    file: "cork-defaults.v2.json",
    ref: "main",
    keys: {
      "1": ["mainnet"],
      "42161": ["phoenix/v0.4-rc.1", "phoenix/v0.3-rc.1", "arbitrum-v1.1", "arbitrum-legacy"],
      "8453": ["phoenix/v0.4-rc.1", "phoenix/v0.3-rc.1"],
    },
  },
  {
    // 0.7.x (first cut 0.7.0-rc.1) fetches config.default.json from the config-only branch config/0.7
    // and knows the bundle labels (+ the old spellings as INPUT, in code). The label rename is a
    // covered breaking change, so it opened a new line: 0.6.0 stays the only 0.6.x binary.
    line: "0.7",
    file: "config.default.json",
    ref: "config/0.7",
    keys: {
      "1": ["mainnet"],
      "42161": ["cork/v0.4", "cork/v0.3", "arbitrum-v1.1", "arbitrum-legacy"],
      "8453": ["cork/v0.4", "cork/v0.3"],
    },
  },
];

function assertKeys(doc: Doc, keys: Record<string, readonly string[]>, where: string): void {
  expect(doc.schemaVersion, `${where}: schema`).toBe(2);
  for (const [chainId, known] of Object.entries(keys)) {
    const chain = doc.generations[chainId];
    expect(chain, `${where}: chain ${chainId} vanished`).toBeDefined();
    for (const k of known) expect(Object.keys(chain!.sets), `${where}: chain ${chainId} lost the key '${k}' a released binary resolves against`).toContain(k);
    expect(known, `${where}: chain ${chainId} primary '${chain!.primary}' is a key no released binary of this line knows`).toContain(chain!.primary);
  }
}

describe("frozen keys — the file a released line reads keeps every set key that line knows", () => {
  it("in the tree: each line's document still carries its keys", () => {
    for (const entry of RELEASED_LINE_KEYS) {
      const doc = JSON.parse(readFileSync(new URL(`../../../${entry.file}`, import.meta.url), "utf8")) as Doc;
      assertKeys(doc, entry.keys, `${entry.file} (line ${entry.line})`);
    }
  });

  it("the URL a 0.7.x binary builds names the config/0.7 branch and config.default.json", () => {
    expect(releaseLineOf("0.7.0-rc.1")).toBe("0.7");
    expect(corkDefaultsUrlFor("0.7.0-rc.1")).toMatch(/\/config\/0\.7\/config\.default\.json$/u);
  });

  it.skipIf(!process.env.CORK_RPC_LIVE)("LIVE: the public branches serve the keys each line knows", async () => {
    for (const entry of RELEASED_LINE_KEYS) {
      const url = `https://raw.githubusercontent.com/Cork-Technology/cork-cli/${entry.ref}/${entry.file}?t=${Date.now()}`;
      const res = await fetch(url);
      expect(res.ok, `${url}: HTTP ${res.status} — the branch or file a released line fetches is missing`).toBe(true);
      assertKeys((await res.json()) as Doc, entry.keys, `${url}`);
    }
  }, 30_000);
});
