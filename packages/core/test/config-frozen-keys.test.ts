// The frozen-keys tripwire. A released 0.6 binary fetches cork-defaults.v2.json and
// resolves `generation` against the document's set KEYS, so a key a released line knows may never
// disappear from the file that line reads. 0.6.0 reads the file from main; 0.6.1 and later read it
// from the config-only branch config/0.6. This test holds the tree's file to the keys, and, when
// live tests are enabled, the PUBLIC refs too (the file a released binary actually fetches). It
// exists because on 2026-09-25 the keys of the main-branch file were renamed under the released
// 0.6.0 and `--generation phoenix/v0.4-rc.1` stopped working within the hour; no test read the
// live file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORK_DEFAULTS_REPO, corkDefaultsUrlFor } from "@cork/core";

type Doc = { schemaVersion: number; generations: Record<string, { primary: string; sets: Record<string, unknown> }> };

const LINE_06_KEYS: Record<string, readonly string[]> = {
  "1": ["mainnet"],
  "42161": ["phoenix/v0.4-rc.1", "phoenix/v0.3-rc.1", "arbitrum-v1.1", "arbitrum-legacy"],
  "8453": ["phoenix/v0.4-rc.1", "phoenix/v0.3-rc.1"],
};

/** Per released line: the ref it reads and the set keys its binaries know per chain. An entry is
 *  appended when a line is cut and NEVER edited afterwards — that is the point. */
export const RELEASED_LINE_KEYS: ReadonlyArray<{ line: string; file: string; ref: string; keys: Record<string, readonly string[]> }> = [
  // 0.6.0 (tag v0.6.0, 2026-09-24) predates the config branch: it fetches the file from MAIN by name.
  { line: "0.6.0", file: "cork-defaults.v2.json", ref: "main", keys: LINE_06_KEYS },
  // 0.6.1 and later fetch it from config/0.6, a branch holding only that file (the release workflow writes it).
  { line: "0.6", file: "cork-defaults.v2.json", ref: "config/0.6", keys: LINE_06_KEYS },
];

/** A primary a released line does not know, admitted ONLY where that line provably FAILS CLOSED on
 *  it. 2026-10-09: main's primary moved to phoenix/v0.5 (owner ruling). A 0.6.0 binary keeps every
 *  key it knows (so `--generation phoenix/v0.4-rc.1` works), strips the unknown jitPermitWire,
 *  and on the new default its JIT prepares REFUSE (implementation_not_approved): the set's adapter
 *  code is not in the allowlist the 0.6.0 binary bundles — the hashes below, copied from the
 *  0.6 tags. Main served the same refusal from 0.7.0-rc.1 until the 2026-10-09 revert. */
/** The JIT allowlist every 0.6 binary bundles (v0.6.0 and v0.6.1-rc.1..rc.3 carry the same hashes). */
const LINE_06_JIT_ALLOWLIST: Record<string, readonly string[]> = {
  "42161": ["0x2fe70bacb5c81095f8ba03bdb1eeb4f6d1969787d82e140f5c8642f77f52d35a", "0x5b6c36ca1be5a6187bd76ba759b0c6514bc1519af4d15030b90d16f884650320", "0x60ce947daf8a8db2b1eb581903bcc74caef76488a4849cc4a0427a3e9606e9d1"],
  "8453": ["0x2fe70bacb5c81095f8ba03bdb1eeb4f6d1969787d82e140f5c8642f77f52d35a", "0x5b6c36ca1be5a6187bd76ba759b0c6514bc1519af4d15030b90d16f884650320"],
};
const PRIMARY_MOVES: ReadonlyArray<{ line: string; primary: string; adapterCodeHash: string; lineJitAllowlist: Record<string, readonly string[]> }> = ["0.6.0", "0.6"].map((line) => ({
  line,
  primary: "phoenix/v0.5",
  adapterCodeHash: "0x24a11fba142a4b681a3bfbadf0ed74566fdf6281102137794d35c217f004225d",
  lineJitAllowlist: LINE_06_JIT_ALLOWLIST,
}));

function assertKeys(doc: Doc, keys: Record<string, readonly string[]>, where: string, line?: string): void {
  expect(doc.schemaVersion, `${where}: schema`).toBe(2);
  for (const [chainId, known] of Object.entries(keys)) {
    const chain = doc.generations[chainId];
    expect(chain, `${where}: chain ${chainId} vanished`).toBeDefined();
    for (const k of known) expect(Object.keys(chain!.sets), `${where}: chain ${chainId} lost the key '${k}' a released binary resolves against`).toContain(k);
    const move = PRIMARY_MOVES.find((m) => m.line === line && m.primary === chain!.primary && m.lineJitAllowlist[chainId] !== undefined);
    if (move !== undefined) {
      // Admitted only while the line cannot build JIT bytes for that primary's adapter.
      expect(move.lineJitAllowlist[chainId], `${where}: chain ${chainId}: the line would ACCEPT the new primary's adapter code`).not.toContain(move.adapterCodeHash);
      continue;
    }
    expect(known, `${where}: chain ${chainId} primary '${chain!.primary}' is a key no released binary of this line knows`).toContain(chain!.primary);
  }
}

const LIVE = Boolean(process.env["CORK_RPC_LIVE"]);

describe("frozen keys — the file a released line reads keeps every set key that line knows", () => {
  it("in the tree: the 0.6 document still carries every key the line knows", () => {
    for (const entry of RELEASED_LINE_KEYS) {
      const doc = JSON.parse(readFileSync(new URL(`../../../${entry.file}`, import.meta.url), "utf8")) as Doc;
      assertKeys(doc, entry.keys, `${entry.file} (line ${entry.line})`, entry.line);
    }
  });

  it("a primary move is admitted only where the line fails closed: the moved primary's adapter code is the one this tree approves", () => {
    const doc = JSON.parse(readFileSync(new URL("../../../cork-defaults.v2.json", import.meta.url), "utf8")) as Doc & { approvedImplementations: Record<string, { jitAdapter: { approved: string[] } }> };
    for (const m of PRIMARY_MOVES) for (const chainId of Object.keys(m.lineJitAllowlist)) {
      expect(doc.approvedImplementations[chainId]!.jitAdapter.approved).toContain(m.adapterCodeHash);
    }
  });

  it("the URL a released 0.6 binary builds names the config/0.6 branch and the line's file", () => {
    const entry = RELEASED_LINE_KEYS.find((e) => e.line === "0.6")!;
    // Exact equality: the WHOLE URL a binary fetches — repo, branch and file — not a suffix.
    expect(corkDefaultsUrlFor("v0.6.1-rc.1")).toBe(`${CORK_DEFAULTS_REPO}/${entry.ref}/${entry.file}`);
  });

  it.skipIf(!LIVE)("LIVE: the public refs serve the keys each line knows", async () => {
    for (const entry of RELEASED_LINE_KEYS) {
      const url = `https://raw.githubusercontent.com/Cork-Technology/cork-cli/${entry.ref}/${entry.file}?t=${Date.now()}`;
      const res = await fetch(url);
      expect(res.ok, `${url}: HTTP ${res.status} — the branch or file a released line fetches is missing`).toBe(true);
      assertKeys((await res.json()) as Doc, entry.keys, `${url}`);
    }
  }, 30_000);
});
