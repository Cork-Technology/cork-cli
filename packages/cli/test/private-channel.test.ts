import { afterEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PRIVATE_REPO, PUBLIC_REPO, latestReleaseTag, channelCacheKey } from "../../core/src/release-channel.ts";
import { refreshUpdateCache } from "../src/update-notify.ts";
import { z } from "zod";

const TOKEN = "fixture-private-read-token";
const COMMIT = "a".repeat(40);
const TAG = "v0.7.0-rc.2";
const TARGET = "bun-darwin-arm64";
const bunPath = process.versions.bun ? process.execPath : execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
if (!bunPath) throw new Error("private updater tests require the pinned Bun executable");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir(): string { const d = mkdtempSync(join(tmpdir(), "private-update-")); dirs.push(d); return d; }
function feed(tags: string[]): Response { return Response.json(tags.map((tag_name) => ({ tag_name, prerelease: true, draft: false }))); }

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}

describe("private RC release selection and channel-isolated update cache", () => {
  it("selects highest published RC, not publication order, drafts, stable, another prerelease or /latest", async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => { asked.push(url); return Response.json([
      { tag_name: "v0.7.0-rc.9", prerelease: true, draft: false }, { tag_name: "v0.7.0-rc.10", prerelease: true, draft: false },
      { tag_name: "v99.0.0-rc.1", prerelease: true, draft: true }, { tag_name: "v99.0.0", prerelease: false, draft: false },
      { tag_name: "v99.0.0-beta.1", prerelease: true, draft: false },
    ]); }) as typeof fetch;
    expect(await latestReleaseTag(PRIVATE_REPO, { CORK_GITHUB_TOKEN: TOKEN }, fetcher)).toBe("v0.7.0-rc.10");
    expect(asked).toEqual([`https://api.github.com/repos/${PRIVATE_REPO}/releases?per_page=100&page=1`]);
  });
  it("traverses pages and refuses an incomplete feed instead of calling a partial maximum latest", async () => {
    let calls = 0;
    const first = Array.from({ length: 100 }, () => "v0.7.0-rc.1");
    const fetcher = (async () => ++calls === 1 ? feed(first) : feed([TAG])) as typeof fetch;
    expect(await latestReleaseTag(PRIVATE_REPO, { CORK_GITHUB_TOKEN: TOKEN }, fetcher)).toBe(TAG); expect(calls).toBe(2);
    calls = 0;
    const endless = (async () => { calls++; return feed(first); }) as typeof fetch;
    await expect(latestReleaseTag(PRIVATE_REPO, { CORK_GITHUB_TOKEN: TOKEN }, endless)).rejects.toThrow("bounded traversal"); expect(calls).toBe(5);
  });
  it("an empty/unauthorized feed is unavailable, not an already-current result", async () => {
    await expect(latestReleaseTag(PRIVATE_REPO, { CORK_GITHUB_TOKEN: TOKEN }, (async () => feed([])) as typeof fetch)).rejects.toThrow("no published private RC");
    await expect(latestReleaseTag(PRIVATE_REPO, { CORK_GITHUB_TOKEN: TOKEN }, (async () => new Response("", { status: 404 })) as typeof fetch)).rejects.toThrow("HTTP 404");
  });
  it("the same explicit cache file never carries public latest/notified state into private (or the inverse), including auth failure", async () => {
    const file = join(dir(), "cache.json"); const env = { CORK_UPDATE_CACHE_FILE: file, CORK_GITHUB_TOKEN: TOKEN };
    await refreshUpdateCache(env, (async () => Response.json({ tag_name: "v99.0.0" })) as typeof fetch, PUBLIC_REPO);
    expect(JSON.parse(readFileSync(file, "utf8")).latest).toBe("v99.0.0");
    await refreshUpdateCache({ CORK_UPDATE_CACHE_FILE: file }, (async () => { throw new Error("must not fetch without auth"); }) as typeof fetch, PRIVATE_REPO);
    let cache = JSON.parse(readFileSync(file, "utf8")); expect(cache.latest).toBeUndefined(); expect(cache.scope).toBe(channelCacheKey(PRIVATE_REPO, "releases/latest"));
    await refreshUpdateCache(env, (async () => feed([TAG])) as typeof fetch, PRIVATE_REPO);
    expect(JSON.parse(readFileSync(file, "utf8")).latest).toBe(TAG);
    await refreshUpdateCache(env, (async () => new Response("", { status: 500 })) as typeof fetch, PUBLIC_REPO);
    cache = JSON.parse(readFileSync(file, "utf8")); expect(cache.latest).toBeUndefined(); expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });
});

describe("private self-update authenticated local HTTP + real subprocess smoke", () => {
  // Local fixture models GitHub transport; fake gh is explicitly NOT cryptographic proof.
  // It executes for real and refuses unless repo/workflow/peeled SHA/tag ref are all supplied.
  async function run(mode: "ok" | "reject" | "wrong-repo" | "no-gh" | "redirect" | "bad-tag" | "unauthorized" | "malformed" | "checksum-bad" | "service-error" | "bad-type", repo: typeof PRIVATE_REPO | typeof PUBLIC_REPO = PRIVATE_REPO) {
    const d = dir(); const installed = join(d, "installed"); const ghLog = join(d, "gh-args");
    writeFileSync(installed, "original binary");
    const gh = join(d, "gh");
    if (mode !== "no-gh" && repo === PRIVATE_REPO) { writeFileSync(gh, `#!/bin/sh\nif [ "$1" = --version ]; then exit 0; fi\nprintf '%s\\n' "$@" > "$FIXTURE_GH_LOG"\n[ "$GH_TOKEN" = "$CORK_GITHUB_TOKEN" ] || exit 6\n[ "$GH_HOST" = github.com ] || exit 7\n[ "$1" = attestation ] && [ "$2" = verify ] || exit 8\nshift 3\n[ "$1" = --repo ] && [ "$2" = '${PRIVATE_REPO}' ] || exit 9\nshift 2\n[ "$1" = --signer-workflow ] && [ "$2" = '${PRIVATE_REPO}/.github/workflows/build-binaries.yml' ] || exit 10\nshift 2\n[ "$1" = --source-digest ] && [ "$2" = '${COMMIT}' ] || exit 11\nshift 2\n[ "$1" = --source-ref ] && [ "$2" = 'refs/tags/${TAG}' ] || exit 12\nif [ "$FIXTURE_MODE" = reject ]; then echo "$CORK_GITHUB_TOKEN" >&2; exit 1; fi\nexit 0\n`); chmodSync(gh, 0o755); }
    const staged = `#!/bin/sh\necho '${JSON.stringify({ version: TAG, commit: COMMIT, target: TARGET, repository: mode === "wrong-repo" ? PUBLIC_REPO : repo })}'\n`;
    const calls: { path: string; auth: string | undefined; accept: string | undefined }[] = [];
    const server = await fixture((req, res) => {
      const path = req.url ?? ""; calls.push({ path, auth: req.headers.authorization, accept: req.headers.accept });
      const send = (value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
      if (repo === PUBLIC_REPO && path.includes("/releases/latest")) { send({ tag_name: TAG }); return; }
      if (repo === PUBLIC_REPO && path.includes("/releases/download/")) {
        if (path.endsWith("checksums.txt")) res.end(`${mode === "checksum-bad" ? "0".repeat(64) : createHash("sha256").update(staged).digest("hex")}  ch-darwin-arm64\n`);
        else res.end(staged);
        return;
      }
      if (path.startsWith("/cdn/")) { res.end(mode === "malformed" ? "not executable" : staged); return; }
      if ((repo === PRIVATE_REPO && req.headers.authorization !== `Bearer ${TOKEN}`) || mode === "unauthorized") { res.statusCode = 404; res.end("not found"); return; }
      if (path.includes("/releases?")) { send([{ tag_name: TAG, draft: false, prerelease: true }]); return; }
      if (path.includes("/git/ref/tags/")) { send(mode === "service-error" ? { error: TOKEN } : { ref: mode === "bad-tag" ? TOKEN : `refs/tags/${TAG}`, object: { type: "tag", sha: "b".repeat(40) } }); return; }
      if (path.includes("/git/tags/")) { send({ object: { type: mode === "bad-type" ? TOKEN : "commit", sha: COMMIT } }); return; }
      if (path.includes("/releases/tags/")) { send({ tag_name: TAG, draft: false, prerelease: true, assets: [{ name: "ch-darwin-arm64", id: 123, browser_download_url: "https://evil.example/stolen" }] }); return; }
      if (path.includes("/releases/assets/123")) { res.statusCode = 302; res.setHeader("location", mode === "redirect" ? "https://evil.example/stolen" : "https://release-assets.githubusercontent.com/cdn/ch"); res.end(); return; }
      res.statusCode = 500; res.end("unexpected request");
    });
    const harness = join(d, "run.ts");
    const module = fileURLToPath(new URL("../src/self-update.ts", import.meta.url));
    writeFileSync(harness, `import { runSelfUpdate } from ${JSON.stringify(module)};\nconst network = fetch;\nconst fixtureFetch = (url, init) => { const u = new URL(String(url)); if (!["api.github.com", "release-assets.githubusercontent.com", "github.com"].includes(u.hostname)) throw new Error("unexpected host"); return network(process.env.FIXTURE_ORIGIN + u.pathname + u.search, init); };\nconsole.log(JSON.stringify(await runSelfUpdate({}, fixtureFetch, { installPath: process.env.FIXTURE_INSTALL })));\n`);
    try {
      const { stdout, stderr } = await promisify(execFile)(bunPath, [harness], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), timeout: 15_000, env: { ...process.env, PATH: d, CH_BUILD_VERSION: "v0.7.0-rc.1", CH_BUILD_TARGET: TARGET, CH_BUILD_REPO: repo, CORK_GITHUB_TOKEN: TOKEN, GH_HOST: "enterprise.example", GH_TOKEN: "ambient-token", GH_ENTERPRISE_TOKEN: "ambient-enterprise-token", GITHUB_ENTERPRISE_TOKEN: "ambient-enterprise-token", GITHUB_TOKEN: "ambient-github-token", CORK_CONFIG_NO_FETCH: "1", CORK_CONFIG_NO_OVERRIDE: "1", FIXTURE_MODE: mode, FIXTURE_ORIGIN: server.origin, FIXTURE_INSTALL: installed, FIXTURE_GH_LOG: ghLog } });
      const result = z.object({ code: z.number().int(), out: z.string(), err: z.string() }).parse(JSON.parse(stdout));
      return { result, stderr, installed: readFileSync(installed, "utf8"), staged, calls, ghArgs: mode === "no-gh" || !readdirSync(d).includes("gh-args") ? "" : readFileSync(ghLog, "utf8"), leftovers: readdirSync(d).filter((n) => n.startsWith(".ch-update-")) };
    } finally { await server.close(); }
  }
  it("updates atomically from the authenticated API asset, strips the CDN credential and binds provenance to peeled source before identity", async () => {
    const r = await run("ok"); expect(r.result.code).toBe(0); expect(r.installed).toBe(r.staged); expect(r.leftovers).toEqual([]);
    expect(r.calls.find((c) => c.path.includes("/releases/assets/"))?.accept).toBe("application/octet-stream");
    expect(r.calls.filter((c) => c.path.startsWith("/repos/")).every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(r.calls.find((c) => c.path.startsWith("/cdn/"))?.auth).toBeUndefined();
    expect(r.ghArgs).toContain(COMMIT); expect(r.ghArgs).toContain(`refs/tags/${TAG}`); expect(r.ghArgs).toContain(`${PRIVATE_REPO}/.github/workflows/build-binaries.yml`);
    expect(JSON.stringify(r.result) + r.stderr + r.ghArgs).not.toContain(TOKEN);
  });
  it.each(["reject", "wrong-repo", "no-gh", "redirect", "bad-tag", "unauthorized", "malformed", "service-error", "bad-type"] as const)("refuses %s without replacing the original, leaking credentials or downgrading to checksums", async (mode) => {
    const r = await run(mode); expect(r.result.code).not.toBe(0); expect(r.installed).toBe("original binary"); expect(r.leftovers).toEqual([]);
    expect(JSON.stringify(r.result) + r.stderr + r.ghArgs).not.toContain(TOKEN);
    expect(r.calls.some((c) => c.path.includes("checksums") || c.path.includes("evil"))).toBe(false);
    if (mode === "no-gh") expect(r.calls).toHaveLength(0);
  });
  it("preserves public unauthenticated checksum fallback, and refuses an integrity mismatch", async () => {
    const good = await run("no-gh", PUBLIC_REPO);
    expect(good.result.code).toBe(0); expect(good.installed).toBe(good.staged);
    expect(good.result.out).toContain("sha256"); expect(good.calls.every((c) => c.auth === undefined)).toBe(true);
    const bad = await run("checksum-bad", PUBLIC_REPO);
    expect(bad.result.code).not.toBe(0); expect(bad.installed).toBe("original binary");
    expect(bad.result.err).toContain("CHECKSUM MISMATCH"); expect(bad.leftovers).toEqual([]);
    expect(bad.calls.every((c) => c.auth === undefined)).toBe(true);
  });
});
