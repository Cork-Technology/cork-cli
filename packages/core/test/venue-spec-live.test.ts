// The venue spec-hash tripwire: the venue publishes its whole API contract as one document
// (openapi at /docs/json — every path, field, and premium pattern this tool replicates
// op-for-op). This live-gated test canonicalizes that document and compares it against the
// committed fixture, so a venue contract change arrives as a NAMED alert with a reviewable diff
// instead of as unexplained 400s in production. Same philosophy (and same regen knob idiom) as
// the surface-drift gate, pointed outward: on an EXPECTED change, review the fixture diff and
// re-capture deliberately with UPDATE_VENUE_SPEC=1.
//
// Self-skips unless CORK_RPC_LIVE=1 (the offline suite stays deterministic), and self-skips
// with a loud log when the venue itself is unreachable — an outage is not a contract change.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { venueBaseUrl } from "@cork/core";

const LIVE = process.env.CORK_RPC_LIVE === "1";
const FIXTURE = new URL("./fixtures/venue-openapi.json", import.meta.url);

/** Canonical form: parse → re-serialize with sorted keys. Key ORDER is presentation, not
 *  contract — the venue's serializer may reorder without changing a single field. */
const canonical = (value: unknown): string => JSON.stringify(value, replacerSortKeys, 1);
function replacerSortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

describe.skipIf(!LIVE)("venue openapi tripwire — live", () => {
  it("the venue's published contract matches the committed capture (or UPDATE_VENUE_SPEC=1 to re-capture)", async () => {
    let live: unknown;
    try {
      const res = await fetch(`${venueBaseUrl()}/docs/json`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      live = await res.json();
    } catch (err) {
      console.log(`venue spec tripwire: venue unreachable (${err instanceof Error ? err.message : String(err)}) — an outage is not a contract change; skipping`);
      return;
    }
    const liveCanonical = canonical(live);
    if (process.env.UPDATE_VENUE_SPEC === "1") {
      writeFileSync(FIXTURE, `${liveCanonical}\n`);
      console.log("venue spec fixture re-captured — review the diff before committing");
      return;
    }
    const committed = canonical(JSON.parse(readFileSync(FIXTURE, "utf8")));
    if (liveCanonical !== committed) {
      const pathsOf = (s: unknown): Set<string> => new Set(Object.keys((s as { paths?: Record<string, unknown> }).paths ?? {}));
      const was = pathsOf(JSON.parse(committed));
      const now = pathsOf(live);
      const added = [...now].filter((p) => !was.has(p));
      const removed = [...was].filter((p) => !now.has(p));
      const versionOf = (s: unknown): unknown => (s as { info?: { version?: unknown } }).info?.version;
      expect.fail(
        `the venue's published API contract CHANGED since the committed capture ` +
          `(committed info.version ${String(versionOf(JSON.parse(committed)))} → live ${String(versionOf(live))}; ` +
          `paths added: ${added.length ? added.join(", ") : "none"}; removed: ${removed.length ? removed.join(", ") : "none"}; ` +
          `field-level changes may exist beyond paths). Review what moved, adapt the replicated gates if needed, ` +
          `then re-capture deliberately: CORK_RPC_LIVE=1 UPDATE_VENUE_SPEC=1 vitest run packages/core/test/venue-spec-live.test.ts`,
      );
    }
  }, 45_000);
});
