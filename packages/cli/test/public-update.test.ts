import { afterEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { channelCacheKey } from "../../core/src/release-channel.ts";
import { refreshUpdateCache } from "../src/update-notify.ts";
import { z } from "zod";

const REPO = "Cork-Technology/cork-cli";
const COMMIT = "a".repeat(40);
const TAG = "v0.8.0-rc.5";
const TARGET = "bun-darwin-arm64";
const bunPath = process.versions.bun ? process.execPath : execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
if (!bunPath) throw new Error("updater tests require the pinned Bun executable");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir(): string { const d = mkdtempSync(join(tmpdir(), "public-update-")); dirs.push(d); return d; }

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => {
    return new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  } };
}

describe("public update cache isolation", () => {
  it("does not import foreign or unscoped latest/notified state on a failed refresh", async () => {
    const file = join(dir(), "cache.json");
    for (const prior of [{ scope: "foreign", latest: "v99.0.0", notifiedAt: new Date().toISOString() }, { latest: "v99.0.0" }]) {
      writeFileSync(file, JSON.stringify(prior));
      await refreshUpdateCache({ CORK_UPDATE_CACHE_FILE: file }, (async () => new Response("unavailable", { status: 500 })) as typeof fetch);
      const cache = JSON.parse(readFileSync(file, "utf8"));
      expect(cache.latest).toBeUndefined(); expect(cache.notifiedAt).toBeUndefined();
      expect(cache.scope).toBe(channelCacheKey("releases/latest")); expect(Number.isFinite(Date.parse(cache.checkedAt))).toBe(true);
    }
  });
});

describe("public self-update over local HTTP and real staged subprocesses", () => {
  // The intercepted gh validates invocation/bindings, NOT Sigstore cryptography.
  async function run(mode: "ok" | "reject" | "wrong-repo" | "no-gh" | "redirect" | "bad-tag" | "unauthorized" | "malformed" | "checksum-bad" | "service-error" | "bad-type") {
    const d = dir(); const installed = join(d, "installed"); const ghLog = join(d, "gh-args");
    writeFileSync(installed, "original binary");
    const gh = join(d, "gh");
    if (mode !== "no-gh" && mode !== "checksum-bad") {
      writeFileSync(gh, `#!/bin/sh\nif [ "$1" = --version ]; then exit 0; fi\nprintf '%s\\n' "$@" > "$FIXTURE_GH_LOG"\n[ "$1" = attestation ] && [ "$2" = verify ] || exit 8\nshift 3\n[ "$1" = --repo ] && [ "$2" = '${REPO}' ] || exit 9\nshift 2\n[ "$1" = --signer-workflow ] && [ "$2" = '${REPO}/.github/workflows/build-binaries.yml' ] || exit 10\nshift 2\n[ "$1" = --source-digest ] && [ "$2" = '${COMMIT}' ] || exit 11\nshift 2\n[ "$1" = --source-ref ] && [ "$2" = 'refs/tags/${TAG}' ] || exit 12\n[ "$FIXTURE_MODE" != reject ] || exit 1\nexit 0\n`);
      chmodSync(gh, 0o755);
    }
    const staged = `#!/bin/sh\necho '${JSON.stringify({ version: TAG, commit: COMMIT, target: TARGET, repository: mode === "wrong-repo" ? "other/foreign" : REPO })}'\n`;
    const calls: { path: string; auth: string | undefined }[] = [];
    const server = await fixture((req, res) => {
      const path = req.url ?? ""; calls.push({ path, auth: req.headers.authorization });
      const send = (value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
      if (mode === "unauthorized") { res.statusCode = 401; res.end("not authorized"); return; }
      if (path.includes("/releases/latest")) { send({ tag_name: TAG }); return; }
      if (path.includes("/git/ref/tags/")) { send(mode === "service-error" ? { error: "fixture error" } : { ref: mode === "bad-tag" ? "refs/tags/v1.0.0" : `refs/tags/${TAG}`, object: { type: "tag", sha: "b".repeat(40) } }); return; }
      if (path.includes("/git/tags/")) { send({ object: { type: mode === "bad-type" ? "blob" : "commit", sha: COMMIT } }); return; }
      if (path.includes("/releases/download/")) {
        if (path.endsWith("checksums.txt")) res.end(`${mode === "checksum-bad" ? "0".repeat(64) : createHash("sha256").update(staged).digest("hex")}  ch-darwin-arm64\n`);
        else { res.statusCode = 302; res.setHeader("location", mode === "redirect" ? "https://evil.example/stolen" : "https://release-assets.githubusercontent.com/cdn/ch"); res.end(); }
        return;
      }
      if (path.startsWith("/cdn/")) { res.end(mode === "malformed" ? "not executable" : staged); return; }
      res.statusCode = 500; res.end("unexpected request");
    });
    const harness = join(d, "run.ts");
    const module = fileURLToPath(new URL("../src/self-update.ts", import.meta.url));
    writeFileSync(harness, `import { runSelfUpdate } from ${JSON.stringify(module)};\nconst network = fetch;\nconst fixtureFetch = (url, init) => { const u = new URL(String(url)); if (!["api.github.com", "release-assets.githubusercontent.com", "github.com"].includes(u.hostname)) throw new Error("unexpected host"); return network(process.env.FIXTURE_ORIGIN + u.pathname + u.search, init); };\nconsole.log(JSON.stringify(await runSelfUpdate({}, fixtureFetch, { installPath: process.env.FIXTURE_INSTALL })));\n`);
    try {
      const { stdout, stderr } = await promisify(execFile)(bunPath, [harness], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), timeout: 15_000, env: { ...process.env, PATH: d, CH_BUILD_VERSION: "v0.8.0-rc.4", CH_BUILD_TARGET: TARGET, CH_BUILD_REPO: REPO, GH_TOKEN: "ambient-token", GITHUB_TOKEN: "ambient-github-token", CORK_CONFIG_NO_FETCH: "1", CORK_CONFIG_NO_OVERRIDE: "1", FIXTURE_MODE: mode, FIXTURE_ORIGIN: server.origin, FIXTURE_INSTALL: installed, FIXTURE_GH_LOG: ghLog } });
      const result = z.object({ code: z.number().int(), out: z.string(), err: z.string() }).parse(JSON.parse(stdout));
      return { result, stderr, installed: readFileSync(installed, "utf8"), staged, calls, ghArgs: readdirSync(d).includes("gh-args") ? readFileSync(ghLog, "utf8") : "", leftovers: readdirSync(d).filter((n) => n.startsWith(".ch-update-")) };
    } finally { await server.close(); }
  }
  it("updates atomically from public assets with peeled-source provenance and staged identity", async () => {
    const r = await run("ok"); expect(r.result.code).toBe(0); expect(r.installed).toBe(r.staged); expect(r.leftovers).toEqual([]);
    expect(r.calls.some((c) => c.path.startsWith("/cdn/"))).toBe(true);
    expect(r.calls.every((c) => c.auth === undefined)).toBe(true);
    expect(r.ghArgs).toContain(COMMIT); expect(r.ghArgs).toContain(`refs/tags/${TAG}`); expect(r.ghArgs).toContain(`${REPO}/.github/workflows/build-binaries.yml`);
  });
  it.each(["reject", "wrong-repo", "redirect", "bad-tag", "unauthorized", "malformed", "service-error", "bad-type"] as const)("refuses %s without replacement or provenance downgrade", async (mode) => {
    const r = await run(mode); expect(r.result.code).not.toBe(0); expect(r.installed).toBe("original binary"); expect(r.leftovers).toEqual([]);
    expect(r.calls.some((c) => c.path.includes("checksums") || c.path.includes("evil"))).toBe(false);
    expect(r.calls.every((c) => c.auth === undefined)).toBe(true);
  });
  it("retains public checksum fallback only when gh is absent, with an integrity gate", async () => {
    const good = await run("no-gh"); expect(good.result.code).toBe(0); expect(good.installed).toBe(good.staged);
    expect(good.result.out).toContain("sha256"); expect(good.calls.every((c) => c.auth === undefined)).toBe(true);
    const bad = await run("checksum-bad"); expect(bad.result.code).not.toBe(0); expect(bad.installed).toBe("original binary");
    expect(bad.result.err).toContain("CHECKSUM MISMATCH"); expect(bad.leftovers).toEqual([]);
  });
});
