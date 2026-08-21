// scripts/toolchain-pin.sh is the ONE parser of mise.toml: apk-spec-identity.sh (CI side) and
// the melange spec's build-time assertion (sandbox side) both read the Bun pin through it.
// These tests run the real script with the real awk against the repo's mise.toml and crafted ones.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(root, "scripts/toolchain-pin.sh");

function run(tool: string, toml?: string) {
  const args = [script, tool];
  if (toml !== undefined) {
    const f = join(mkdtempSync(join(tmpdir(), "mise-")), "mise.toml");
    writeFileSync(f, toml);
    args.push(f);
  }
  const r = spawnSync("sh", args, { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

describe("toolchain-pin.sh — the one reader of mise.toml", () => {
  it("reads the repo's own bun pin, and it is an exact version", () => {
    const r = run("bun");
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/^\d+\.\d+\.\d+$/);
    // Agrees with a naive read of the file — the parser adds rigor, not a different answer.
    expect(readFileSync(join(root, "mise.toml"), "utf8")).toContain(`bun = "${r.out}"`);
  });

  it("ignores the same key outside [tools], comments, and spacing variants", () => {
    const toml = `[env]\nbun = "9.9.9" # not a tool\n\n[tools] # toolchain\n# bun = "0.0.1"\nnode="22.1.0"\n  bun   =   "1.2.3"   # trailing\n`;
    expect(run("bun", toml)).toMatchObject({ status: 0, out: "1.2.3" });
    expect(run("node", toml)).toMatchObject({ status: 0, out: "22.1.0" });
  });

  it("refuses an alias or a range operator — the runtime is embedded, the pin must be exact", () => {
    for (const v of ['"latest"', '"^1.3.14"', '"1.3.x"', '"~1.3"']) {
      const r = run("bun", `[tools]\nbun = ${v}\n`);
      expect(r.status, v).toBe(2);
      expect(r.err).toContain("exact version");
    }
    // A bare major.minor passes the shape check (digits and dots). mise would resolve it as a
    // prefix, so the release builds could float within that line; the melange assertion step
    // (`bun --version`, always three parts, must equal the pin) is what catches it at build time.
    expect(run("bun", `[tools]\nbun = "1.3"\n`).status).toBe(0);
  });

  it("refuses a missing key, a key in no table, or a non-double-quoted value — never guesses", () => {
    expect(run("bun", `[tools]\nnode = "22"\n`).status).toBe(2);
    expect(run("bun", `bun = "1.2.3"\n[tools]\n`).status).toBe(2);
    expect(run("bun", `[tools]\nbun = '1.2.3'\n`).status).toBe(2);
    expect(run("bun", `[tools]\nbun = 1.2.3\n`).status).toBe(2);
    expect(run("bun", `[tools]\n`).err).toContain("no `bun =");
  });

  it("a missing file is a clear error", () => {
    const r = spawnSync("sh", [script, "bun", "/nonexistent/mise.toml"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not found");
  });
});
