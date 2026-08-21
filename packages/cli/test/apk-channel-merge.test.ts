// The immutability rule of the apk channel, as the workflow runs it: scripts/apk-channel-merge.sh
// merges one build's output into the published per-arch directory. These tests run the real
// script against temp directories — no melange, no git: the rule is pure file logic, and the
// index signing that follows it in melange-build is melange's own job.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/apk-channel-merge.sh", import.meta.url));

function fixture(files: { channel?: Record<string, string>; incoming: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), "apk-merge-"));
  const channel = join(dir, "channel");
  const incoming = join(dir, "incoming");
  mkdirSync(channel);
  mkdirSync(incoming);
  for (const [n, c] of Object.entries(files.channel ?? {})) writeFileSync(join(channel, n), c);
  for (const [n, c] of Object.entries(files.incoming)) writeFileSync(join(incoming, n), c);
  const added = join(dir, "added.txt");
  const r = spawnSync("sh", [script, channel, incoming, added], { encoding: "utf8" });
  const channelFile = (n: string) => (existsSync(join(channel, n)) ? readFileSync(join(channel, n), "utf8") : null);
  const addedList = existsSync(added) ? readFileSync(added, "utf8").split("\n").filter(Boolean) : [];
  return { status: r.status, out: r.stdout + r.stderr, channelFile, addedList };
}

const APK = "cork-cli-0.4.0-r0.apk";
const ATTEST = "cork-cli-0.4.0-r0.attest.tar.gz";

describe("apk-channel-merge.sh — the channel's immutability rule", () => {
  it("first publish: adds the apk and its provenance, lists exactly those, ignores the local index", () => {
    const r = fixture({ channel: { "older-0.3.0-r0.apk": "old" }, incoming: { [APK]: "bytes", [ATTEST]: "prov", "APKINDEX.tar.gz": "local-index" } });
    expect(r.status, r.out).toBe(0);
    expect(r.addedList).toEqual([APK, ATTEST]);
    expect(r.channelFile(APK)).toBe("bytes");
    expect(r.channelFile(ATTEST)).toBe("prov");
    expect(r.channelFile("APKINDEX.tar.gz")).toBeNull();
    expect(r.channelFile("older-0.3.0-r0.apk")).toBe("old");
  });

  it("re-run of the same release: byte-identical files are skipped and nothing is listed as added", () => {
    const r = fixture({ channel: { [APK]: "bytes", [ATTEST]: "prov" }, incoming: { [APK]: "bytes", [ATTEST]: "prov" } });
    expect(r.status, r.out).toBe(0);
    expect(r.addedList).toEqual([]);
    expect(r.out.match(/byte-identical/g)).toHaveLength(2);
  });

  it("rebuilt provenance differs (wall-clock fields): the FIRST-published attestation is kept", () => {
    const r = fixture({ channel: { [APK]: "bytes", [ATTEST]: "prov-first" }, incoming: { [APK]: "bytes", [ATTEST]: "prov-rebuilt" } });
    expect(r.status, r.out).toBe(0);
    expect(r.channelFile(ATTEST)).toBe("prov-first");
    expect(r.addedList).toEqual([]);
    expect(r.out).toContain("FIRST-published");
  });

  it("different apk bytes under a published name: REFUSED, and the channel is left untouched — even files that would have been fine", () => {
    const NEW = "cork-cli-0.4.1-r0.apk";
    const r = fixture({ channel: { [APK]: "bytes" }, incoming: { [APK]: "tampered", [NEW]: "new" } });
    expect(r.status).toBe(1);
    expect(r.out).toContain("REFUSING");
    expect(r.channelFile(APK)).toBe("bytes");
    expect(r.channelFile(NEW)).toBeNull(); // pass 1 refuses before pass 2 copies anything
    expect(r.addedList).toEqual([]);
  });

  it("an incoming dir with no apk is a loud error, not a silent empty merge", () => {
    const r = fixture({ incoming: { "README": "x" } });
    expect(r.status).toBe(2);
    expect(r.out).toContain("no .apk");
  });
});
