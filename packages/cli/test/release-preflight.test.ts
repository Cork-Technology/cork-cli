// Exercise the real read-only admission script against an authenticated HTTP fixture.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const repo = "Cork-Technology/cork-cli";
const token = "fixture-authorized-token";
const config = '{"schemaVersion":2,"generations":{}}\n';
let server: Server;
let origin: string;
let repositoryIdentity: { full_name: string; private: boolean; visibility: string };
let publishedRelease: { tag_name: string; draft: boolean; prerelease: boolean; immutable?: boolean | string };
let failure: { path: string; status: number } | undefined;
let seen: { method: string; path: string; auth: string | undefined }[];
let liveCommit: string;
let annotated: boolean;
const dir = mkdtempSync(join(tmpdir(), "release-preflight-"));

async function run(mode = "release", opts: { repo?: string; tag?: string; token?: string; branch?: string; origin?: string } = {}) {
  const output = join(dir, "served.json");
  return await new Promise<{ status: number | null; out: string; err: string; output: string }>((resolve) => {
    const child = spawn("sh", [join(root, "scripts/release-preflight.sh"), mode, opts.branch ?? "config/0.7", output], {
      cwd: root,
      env: { PATH: process.env.PATH, GITHUB_SHA: "a".repeat(40), GITHUB_REPOSITORY: opts.repo ?? repo, RELEASE_TAG: opts.tag ?? "v0.7.0-rc.1", GH_TOKEN: opts.token ?? token, CORK_RELEASE_API_URL: opts.origin ?? origin },
    });
    let out = "", err = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.on("close", (status) => resolve({ status, out, err, output }));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url!;
    seen.push({ method: req.method!, path, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(JSON.stringify({ message: token })); return; }
    if (failure?.path === path) { res.writeHead(failure.status).end(JSON.stringify({ message: token })); return; }
    if (path.includes("/releases/tags/")) { res.end(JSON.stringify(publishedRelease)); return; }
    if (path === `/repos/${repo}`) {
      res.end(JSON.stringify(repositoryIdentity));
    } else if (path.includes("/git/ref/tags/")) {
      res.end(JSON.stringify({ object: { type: annotated ? "tag" : "commit", sha: annotated ? "c".repeat(40) : liveCommit } }));
    } else if (path.includes("/git/tags/")) {
      res.end(JSON.stringify({ object: { type: "commit", sha: liveCommit } }));
    } else if (path.includes("/git/ref/heads/")) {
      res.end(JSON.stringify({ object: { sha: "a".repeat(40) } }));
    } else if (path.includes("/contents/cork-defaults.v2.json")) {
      res.end(JSON.stringify({ encoding: "base64", content: Buffer.from(config).toString("base64"), sha: "b".repeat(40) }));
    } else { res.writeHead(404).end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { repositoryIdentity = { full_name: repo, private: false, visibility: "public" }; publishedRelease = { tag_name: "v0.7.0-rc.1", draft: false, prerelease: true, immutable: true }; failure = undefined; seen = []; liveCommit = "a".repeat(40); annotated = false; });
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });

describe("release admission and authenticated config readback", () => {
  it("refuses curl-config metacharacters in credentials before making a request", async () => {
    const r = await run("publish", { token: 'bad"\nurl = "https://example.invalid' });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("malformed authentication token");
    expect(seen).toEqual([]);
  });
  it("refuses mismatched repository identity or nonpublic visibility before proceeding", async () => {
    for (const value of [{ full_name: "other/foreign" }, { private: true }, { visibility: "internal" }]) {
      repositoryIdentity = { full_name: repo, private: false, visibility: "public", ...value };
      const r = await run("publish");
      expect(r.status).not.toBe(0);
      expect(seen.at(-1)?.path).toBe(`/repos/${repo}`);
    }
  });
  it("peels annotated tags and refuses a live tag that moved away from the artifact commit", async () => {
    annotated = true;
    expect((await run("publish")).status).toBe(0);
    liveCommit = "d".repeat(40);
    const moved = await run("publish");
    expect(moved.status).not.toBe(0);
    expect(moved.err).toContain("exact artifact source commit");
  });
  it("refuses unreadable or mismatched published Release metadata without disclosing the response body", async () => {
    for (const status of [401, 403, 404, 500]) {
      failure = { path: `/repos/${repo}/releases/tags/v0.7.0-rc.1`, status };
      const r = await run("release-readback");
      expect(r.status).not.toBe(0);
      expect(r.err).toContain(`HTTP ${status}`);
      expect(r.err).toContain("publication already occurred");
      expect(r.err).not.toContain(token);
    }
    failure = undefined;
    for (const value of [{ tag_name: "v0.7.0-rc.2" }, { draft: true }, { prerelease: false }]) {
      publishedRelease = { tag_name: "v0.7.0-rc.1", draft: false, prerelease: true, immutable: true, ...value };
      expect((await run("release-readback")).status).not.toBe(0);
    }
    expect(seen.every((request) => request.method === "GET")).toBe(true);
  });
  it("proves known contents authorization before classifying a branch's 404 as absence", async () => {
    failure = { path: `/repos/${repo}/git/ref/heads/main`, status: 404 };
    const r = await run("config-current");
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("exists=false");
  });
  it("admits only the public component destination, with authorized GETs and no token in output", async () => {
    const r = await run("publish");
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("image=ghcr.io/cork-technology/cork-cli\n");
    expect(r.out).toContain("candidate=true\n");
    expect(r.out + r.err).not.toContain(token);
    expect(seen.every((r) => r.method === "GET" && r.auth === `Bearer ${token}`)).toBe(true);
  });
  it("refuses unknown repository identities before any request", async () => {
    expect((await run("release", { repo: "Cork-Technology/other" })).status).not.toBe(0);
    expect(seen).toEqual([]);
  });
  it("preserves public stable admission with bounded repository and source-tag reads", async () => {
    const r = await run("release", { tag: "v1.0.0" });
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain("image=ghcr.io/cork-technology/cork-cli\n");
    expect(r.out).toContain("candidate=false\n");
    expect(seen).toHaveLength(2);
  });
  it("rejects unauthorized authentication and untrusted API origins", async () => {
    const unauthorized = await run("publish", { token: "wrong-token" });
    expect(unauthorized.status).not.toBe(0);
    expect(unauthorized.err).toContain("HTTP 401");
    expect(unauthorized.err).not.toContain(token);
    expect((await run("publish", { origin: "https://untrusted.example" })).status).not.toBe(0);
  });
  it("reads config contents with authorization, preserving exact published bytes", async () => {
    const r = await run("config-readback");
    expect(r.status, r.err).toBe(0);
    expect(readFileSync(r.output, "utf8")).toBe(config);
    expect(r.out).toContain(`blob=${"b".repeat(40)}`);
    expect(seen.every((r) => r.auth === `Bearer ${token}`)).toBe(true);
  });
  it("classifies only a confirmed missing branch as first publication; missing file is failure", async () => {
    failure = { path: `/repos/${repo}/git/ref/heads/config/0.7`, status: 404 };
    const missing = await run("config-current");
    expect(missing.status, missing.err).toBe(0);
    expect(missing.out).toBe("exists=false\nunchanged=false\n");
    expect((await run("config-readback")).status).not.toBe(0);
    failure = { path: `/repos/${repo}/contents/cork-defaults.v2.json?ref=config/0.7`, status: 404 };
    expect((await run("config-current")).status).not.toBe(0);
  });
  it.each([401, 403, 429, 500])("does not turn branch HTTP %s into absence", async (status) => {
    failure = { path: `/repos/${repo}/git/ref/heads/config/0.7`, status };
    const r = await run("config-current");
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("exists=false");
  });
});

describe.skipIf(spawnSync("yq", ["--version"]).status !== 0)("publication shell smoke without remote publication", () => {
  async function publication(publishedImage?: string) {
    const work = mkdtempSync(join(dir, "publication-"));
    mkdirSync(join(work, "scripts"));
    mkdirSync(join(work, "dist"));
    mkdirSync(join(work, "bin"));
    copyFileSync(join(root, "scripts/release-preflight.sh"), join(work, "scripts/release-preflight.sh"));
    const assets = ["ch-darwin-arm64", "ch-darwin-x64", "ch-linux-x64", "ch-linux-arm64", "ch-linux-x64-musl", "ch-linux-arm64-musl", "ch-windows-x64.exe", "cork-schemas-0.7.0-rc.1.tgz", "cork-core-0.7.0-rc.1.tgz", "cork-mcp-0.7.0-rc.1.tgz", "checksums.txt", "image.txt"];
    for (const asset of assets) writeFileSync(join(work, "dist", asset), "fixture-bytes");
    writeFileSync(join(work, "bin/gh"), '#!/bin/sh\n[ "$GH_TOKEN" = fixture-write-token ] || exit 99\nprintf \'%s\\0\' "$@" > called.argv\n');
    chmodSync(join(work, "bin/gh"), 0o755);
    const repository = repo;
    const tag = "v0.7.0-rc.1";
    const extracted = spawnSync("yq", ["-r", '.jobs.publish.steps[] | select(.name == "Create the (immutable) release from the attested primary bytes") | .run', join(root, ".github/workflows/release.yml")], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    const command = extracted.stdout.replaceAll("${{ github.repository }}", repository).replaceAll("${{ github.ref_name }}", tag).replaceAll("${{ github.sha }}", "a".repeat(40));
    const result = await new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("sh", ["-eu", "-c", command], { cwd: work, env: { PATH: `${join(work, "bin")}:${process.env.PATH}`, GH_TOKEN: token, GH_RELEASE_TOKEN: "fixture-write-token", RELEASE_TAG: tag, GITHUB_REF_NAME: tag, GITHUB_SHA: "a".repeat(40), GITHUB_REPOSITORY: repository, CORK_RELEASE_API_URL: origin, PUBLISHED_IMAGE: publishedImage ?? "ghcr.io/cork-technology/cork-cli" } });
      let out = "", err = "";
      child.stdout.on("data", (data) => { out += data; });
      child.stderr.on("data", (data) => { err += data; });
      child.on("close", (status) => resolve({ status, out, err }));
    });
    return { ...result, args: existsSync(join(work, "called.argv")) ? readFileSync(join(work, "called.argv"), "utf8").split("\0").filter(Boolean) : [] };
  }

  it("never reaches the intercepted publication boundary with a substituted image identity", async () => {
    const wrongImage = await publication("ghcr.io/other/foreign");
    expect(wrongImage.status).not.toBe(0);
    expect(wrongImage.args).toEqual([]);
  });
  it("does not report a successful publication until the actual Release is confirmed immutable", async () => {
    const success = await publication();
    expect(success.status, success.err).toBe(0);
    expect(success.out).toContain("release=immutable");
    for (const value of [false, undefined, "true"]) {
      if (value === undefined) delete publishedRelease.immutable; else publishedRelease.immutable = value;
      const failed = await publication();
      expect(failed.status).not.toBe(0);
      expect(failed.err).toContain("not confirmed immutable");
      expect(failed.err).toContain("publication already occurred");
    }
  });

});
