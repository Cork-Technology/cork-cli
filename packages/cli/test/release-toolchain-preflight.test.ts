// scripts/release-toolchain-preflight.sh runs every `apk add` of the release workflow in the
// image that workflow pins, on main, before a tag exists. On 2026-10-01 a six-week-old image pin
// broke v0.6.1-rc.3 after its GitHub Release was published: the image's world file held
// libcrypto3 back while Wolfi's repository rolled on. scripts/bump-wolfi-pin.sh is the other
// half: it moves the pin to the image the registry serves now.
//
// These tests run the real scripts. The container runtime is a recording stand-in (CI has docker;
// this suite must not need it); the registry is a real HTTP server on localhost that the script's
// own curl talks to. The first block holds both scripts to the REAL workflow files.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const preflight = join(root, "scripts/release-toolchain-preflight.sh");
const bump = join(root, "scripts/bump-wolfi-pin.sh");
/** Every workflow that runs a job in the pinned image: the apk and image build, the CVM deploy, the rehearsal. */
const PINNED_WORKFLOWS = ["apk-repo.yml", "deploy-cvm.yml", "release-toolchain.yml"];
const workflowText = (name: string) => readFileSync(join(root, ".github/workflows", name), "utf8");
const workflow = workflowText("apk-repo.yml");
const DIGEST = "a".repeat(64);
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("sh", [preflight, ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** The text of a workflow with the given images and install lines, in the two shapes apk-repo.yml uses. */
function fixtureText(images: string[], lines: string[]) {
  const body = images.map((image, i) => [
    `  job${i}:`,
    "    # Pinned 2026-08-19: the image built 2026-08-18T11:02:13Z.",
    "    container:",
    `      image: ${image}`,
    "    steps:",
    ...(i % 2 === 0
      ? ["      - shell: sh", "        run: |", `          ${lines[i] ?? "true"}`, "          git config --global --add safe.directory x"]
      : ["      - shell: sh", `        run: ${lines[i] ?? "true"}`]),
  ].join("\n")).join("\n");
  return `# a comment that says \`apk add\`s its tools\njobs:\n${body}\n`;
}
function workflowFile(images: string[], lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-preflight-"));
  const file = join(dir, "apk-repo.yml");
  writeFileSync(file, fixtureText(images, lines));
  return { dir, file };
}

/**
 * A stand-in runtime. `run`: appends its argv to a log, one argument per line, and fails when the
 * install line contains `failOn`. `image inspect`: prints `created` (the image's build time).
 */
function runtime(dir: string, opts: { failOn?: string; created?: string } = {}) {
  const log = join(dir, "calls.log");
  const bin = join(dir, "runtime.sh");
  writeFileSync(bin, [
    "#!/bin/sh",
    `if [ "$1" = image ]; then printf '%s\\n' "$*" >> "${log}.inspect"; ${opts.created === undefined ? "exit 1" : `echo "${opts.created}"; exit 0`}; fi`,
    `for a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done`,
    `printf -- '--\\n' >> "${log}"`,
    `case "$6" in *"${opts.failOn ?? "@@never@@"}"*) echo "ERROR: simulated file conflict"; exit 1 ;; esac`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
  return {
    bin,
    calls: () => read(log).split("--\n").filter(Boolean).map((c) => c.trimEnd().split("\n")),
    inspects: () => read(`${log}.inspect`).trimEnd().split("\n").filter(Boolean),
  };
}

const image = (digest = DIGEST) => `cgr.dev/chainguard/wolfi-base@sha256:${digest}`;

describe("release-toolchain preflight — the real workflow files", () => {
  const listed = run(["--list"]);
  const [imageLine, ...lines] = listed.out.trimEnd().split("\n");

  it("finds every workflow that names the image, and reads ONE digest and every install line from them", () => {
    expect(listed.status).toBe(0);
    expect(imageLine).toMatch(/^image: cgr\.dev\/chainguard\/wolfi-base@sha256:[0-9a-f]{64}$/);
    // Discovery, not a list: the files that carry an `image:` line with the wolfi-base name.
    const naming = readdirSync(join(root, ".github/workflows")).filter((f) => /^ *image: *cgr\.dev\/chainguard\/wolfi-base/m.test(workflowText(f))).sort();
    expect(naming).toEqual([...PINNED_WORKFLOWS].sort());
    // Every `apk add` those workflows run is found — none is missed by the line pattern —
    // each distinct line once, in first-seen order (the rehearsal repeats the release's lines).
    const inWorkflows = [...PINNED_WORKFLOWS].sort().flatMap((f) => workflowText(f).split("\n").filter((l) => /^\s*(run: )?apk add /.test(l)).map((l) => l.replace(/^\s*(run: )?/, "")));
    expect(inWorkflows.length).toBe(5);
    expect(lines).toEqual([...new Set(inWorkflows)]);
    expect(lines.length).toBe(3);
  });

  it("every job container of every release workflow carries that same digest", () => {
    const pins = PINNED_WORKFLOWS.flatMap((f) => [...workflowText(f).matchAll(/^\s*image: (\S+)$/gm)].map((m) => m[1]));
    expect(pins.length).toBe(5);
    expect(new Set(pins)).toEqual(new Set([imageLine!.replace("image: ", "")]));
  });

  it("the build toolchain asks for the versioned openssl CLI, never the unversioned name", () => {
    // The unversioned name is what an aged image's world pin turns into an old, colliding build.
    const build = lines.find((l) => l.includes("melange"))!;
    expect(build.split(" ")).toContain("openssl-4.0");
    expect(lines.flatMap((l) => l.split(" "))).not.toContain("openssl");
  });

  it("the pin carries the dated line the bump script rewrites", () => {
    expect(workflow.match(/^ *# Pinned \d{4}-\d{2}-\d{2}: the image built \S+\.$/gm)?.length).toBe(1);
  });

  it("the release-toolchain workflow runs the script on push, on pull requests, and weekly with the age limit", () => {
    const wf = readFileSync(join(root, ".github/workflows/release-toolchain.yml"), "utf8");
    const triggers = wf.slice(wf.indexOf("\non:\n"), wf.indexOf("\npermissions:"));
    // Pushes to main AND to a release branch run it: release candidates are tagged from their
    // public release/vX.Y.Z branch, so that branch needs the same evidence main gets.
    expect(triggers).toMatch(/^ {2}push:\n {4}branches: \[main, "release\/v\*"\]$/m);
    expect(triggers).toMatch(/^ {2}pull_request:$/m);
    expect(triggers).toMatch(/^ {2}schedule:\n {4}- cron: "\d+ \d+ \* \* [0-6]"/m);
    expect(triggers).toMatch(/^ {2}workflow_dispatch:$/m);
    // The preflight job alone (the rehearsal jobs below it have their own tests).
    const job = wf.slice(wf.indexOf("\n  preflight:\n"), wf.indexOf("\n  # The apk build of the release, rehearsed"));
    expect(job.length).toBeGreaterThan(100);
    // The exact commands, to the end of the line: `--list` would print and check nothing.
    const steps = [...job.matchAll(/^ {8}if: (.+)\n {8}run: (.+)$/gm)].map((m) => [m[1], m[2]]);
    expect(steps).toEqual([
      ["github.event_name == 'push' || github.event_name == 'pull_request'", "sh scripts/release-toolchain-preflight.sh"],
      ["github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'", "sh scripts/release-toolchain-preflight.sh --max-age-days 30"],
    ]);
    // The job runs on the bare runner and starts its own containers: no job container here.
    expect(job).not.toMatch(/^\s+container:/m);
    // As YAML keys, in the whole file (the header comment may use the words): no secret, no environment.
    expect(wf).not.toMatch(/\$\{\{\s*secrets\./);
    expect(wf).not.toMatch(/^\s+environment:/m);
    // actionlint reads every workflow as GitHub does, from an image pinned by version AND digest.
    expect(job).toMatch(/^ {8}run: docker run --rm -v "\$PWD:\/repo" -w \/repo rhysd\/actionlint:\d+\.\d+\.\d+@sha256:[0-9a-f]{64} -shellcheck= -pyflakes=$/m);
    expect(wf).toMatch(/^permissions:\n {2}contents: read$/m);
  });

});

describe("release-toolchain preflight — the run", () => {
  const A = "apk add --no-cache bash git melange openssl-4.0 yq";
  const B = "apk add --no-cache bash apko curl";

  it("runs each line in a FRESH container of the pinned image, in order", () => {
    const wf = workflowFile([image(), image()], [A, B]);
    const rt = runtime(wf.dir);
    const r = run([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(0);
    expect(rt.calls()).toEqual([
      ["run", "--rm", image(), "sh", "-ec", A],
      ["run", "--rm", image(), "sh", "-ec", B],
    ]);
    expect(r.out).toContain(`release-toolchain: OK    ${A}`);
    expect(r.out).toContain(`release-toolchain: OK    ${B}`);
  });

  it("fails when one install fails, names the line, and stops there", () => {
    const wf = workflowFile([image(), image()], [A, B]);
    const rt = runtime(wf.dir, { failOn: "melange", created: "2026-09-29T20:55:55Z" });
    const r = run([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`::error::release-toolchain: FAILED in the pinned image: ${A}`);
    expect(r.out).toContain("sh scripts/bump-wolfi-pin.sh");
    expect(rt.calls().length).toBe(1);
    expect(r.out).not.toContain("OK    ");
    // A failed install is the verdict; the age is not asked for after it.
    expect(rt.inspects()).toEqual([]);
  });

  it("fails when a LATER install fails, after the earlier one passed", () => {
    const wf = workflowFile([image(), image()], [A, B]);
    const rt = runtime(wf.dir, { failOn: "apko" });
    const r = run([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`release-toolchain: OK    ${A}`);
    expect(r.out).toContain(`FAILED in the pinned image: ${B}`);
  });

  it("reads several workflow files as one release path: each distinct line once, in first-seen order", () => {
    const one = workflowFile([image(), image()], [A, B]);
    const two = workflowFile([image(), image()], [B, "apk add --no-cache bash nodejs"]);
    const rt = runtime(one.dir);
    const r = run([], { RELEASE_WORKFLOWS: `${one.file} ${two.file}`, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(0);
    expect(rt.calls().map((c) => c[5])).toEqual([A, B, "apk add --no-cache bash nodejs"]);
  });

  it("--list runs nothing", () => {
    const wf = workflowFile([image()], [A]);
    const r = run(["--list"], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: join(wf.dir, "absent") });
    expect(r.status).toBe(0);
    expect(r.out).toBe(`image: ${image()}\n${A}\n`);
  });
});

describe("release-toolchain preflight — the image's age", () => {
  const A = "apk add --no-cache bash";
  const built = "2026-08-18T11:02:13Z";
  const go = (args: string[], created: string | undefined, now: string) => {
    const wf = workflowFile([image()], [A]);
    const rt = runtime(wf.dir, created === undefined ? {} : { created });
    return { ...run(args, { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin, PREFLIGHT_NOW_EPOCH: String(epoch(now)) }), rt };
  };

  it("enforces the same calendar age for Docker RFC3339 and Podman's space-separated inspect date", () => {
    for (const created of ["2026-10-01T15:12:42Z", "2026-10-01 15:12:42 +0000 UTC"]) {
      const admitted = go(["--max-age-days", "30"], created, "2026-10-07T00:00:00Z");
      expect(admitted.status, admitted.out).toBe(0);
      expect(admitted.out).toContain("6 days ago");
      const expired = go(["--max-age-days", "30"], created, "2026-11-01T00:00:00Z");
      expect(expired.status, expired.out).toBe(1);
      expect(expired.out).toContain("31 days old");
    }
  });
  it("reports the age in whole days, from the image the runs pulled", () => {
    const r = go([], built, "2026-10-01T18:54:00Z");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`the pinned image was built ${built} — 44 days ago`);
    expect(r.rt.inspects()).toEqual([`image inspect --format {{.Created}} ${image()}`]);
  });

  it("counts calendar days across a month end, a year end and a leap day", () => {
    const days = (created: string, now: string) => Number(/— (-?\d+) days ago/.exec(go([], created, now).out)?.[1]);
    expect(days("2026-01-31T23:59:59Z", "2026-02-01T00:00:00Z")).toBe(1);
    expect(days("2026-12-31T00:00:00Z", "2027-01-01T12:00:00Z")).toBe(1);
    expect(days("2028-02-28T00:00:00Z", "2028-03-01T00:00:00Z")).toBe(2); // 2028 is a leap year
    expect(days("2027-02-28T00:00:00Z", "2027-03-01T00:00:00Z")).toBe(1);
    expect(days("2026-10-01T00:00:00Z", "2026-10-01T23:59:59Z")).toBe(0);
    expect(days("2024-10-01T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(730);
  });

  it("without a limit an old image passes: a push must not fail for the calendar", () => {
    expect(go([], built, "2027-10-01T00:00:00Z").status).toBe(0);
  });

  it("--max-age-days: the limit itself passes, one day more fails and names the fix", () => {
    const on = go(["--max-age-days", "30"], built, "2026-09-17T11:00:00Z"); // 30 days
    expect(on.out).toContain("— 30 days ago");
    expect(on.status).toBe(0);
    const over = go(["--max-age-days", "30"], built, "2026-09-18T00:00:00Z"); // 31 days
    expect(over.status).toBe(1);
    expect(over.out).toContain("::error::release-toolchain: the pinned wolfi-base image is 31 days old (limit 30)");
    expect(over.out).toContain("sh scripts/bump-wolfi-pin.sh");
  });

  it("an unreadable build date fails only when a limit was asked for", () => {
    const quiet = go([], undefined, "2026-10-01T00:00:00Z");
    expect(quiet.status).toBe(0);
    expect(quiet.out).toContain("build date is not readable; age not checked");
    const asked = go(["--max-age-days", "30"], undefined, "2026-10-01T00:00:00Z");
    expect(asked.status).toBe(1);
    expect(asked.out).toContain("the age limit cannot be checked");
    expect(go(["--max-age-days", "30"], "yesterday", "2026-10-01T00:00:00Z").status).toBe(1);
  });

  it("refuses a limit that is not a whole number, and an unknown argument", () => {
    for (const bad of [["--max-age-days"], ["--max-age-days", "soon"], ["--max-age-days", "3.5"], ["--max-age-days", "-1"], ["--frobnicate"]]) {
      expect(run(bad).status, bad.join(" ")).toBe(2);
    }
  });
});

describe("release-toolchain preflight — refusals", () => {
  const A = "apk add --no-cache bash";

  it("refuses two different image pins: the jobs must not age apart", () => {
    const wf = workflowFile([image(), image("b".repeat(64))], [A, A]);
    const rt = runtime(wf.dir);
    const r = run([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(1);
    expect(r.err).toContain("expected ONE job-container image");
    expect(r.err).toContain("found 2");
  });

  it("refuses two pins that live in two different workflow files", () => {
    const one = workflowFile([image()], [A]);
    const two = workflowFile([image("b".repeat(64))], [A]);
    const r = run(["--list"], { RELEASE_WORKFLOWS: `${one.file} ${two.file}` });
    expect(r.status).toBe(1);
    expect(r.err).toContain("expected ONE job-container image");
    expect(r.err).toContain("found 2");
  });

  it("refuses when no workflow names the image", () => {
    // Discovery runs in the working directory: an empty one has no workflow to find.
    const empty = mkdtempSync(join(tmpdir(), "toolchain-empty-"));
    const none = spawnSync("sh", [preflight, "--list"], { cwd: empty, encoding: "utf8" });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("no workflow names the wolfi-base image");
  });

  it("refuses an image that is not digest-pinned", () => {
    for (const loose of ["cgr.dev/chainguard/wolfi-base:latest", "cgr.dev/chainguard/wolfi-base", `cgr.dev/chainguard/wolfi-base@sha256:${"a".repeat(63)}`]) {
      const wf = workflowFile([loose], [A]);
      const r = run(["--list"], { RELEASE_WORKFLOWS: wf.file });
      expect(r.status, loose).toBe(1);
      expect(r.err, loose).toContain("not digest-pinned");
    }
  });

  it("refuses a workflow with no install line, and a missing workflow file", () => {
    const wf = workflowFile([image()], ["echo nothing to install"]);
    const none = run(["--list"], { RELEASE_WORKFLOWS: wf.file });
    expect(none.status).toBe(1);
    expect(none.err).toContain("no `apk add --no-cache` line found");
    const missing = run(["--list"], { RELEASE_WORKFLOWS: join(wf.dir, "absent.yml") });
    expect(missing.status).toBe(1);
    expect(missing.err).toContain("not found");
  });
});

// ── bump-wolfi-pin.sh ────────────────────────────────────────────────────────────────────────

/** What the registry serves: the manifest body for `latest`, and the digest it CLAIMS for it. */
type Served = { body: string; claimed?: string };
const manifest = (created: string) => JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [], annotations: { "org.opencontainers.image.created": created, "org.opencontainers.image.title": "wolfi-base" } });
const digestOf = (body: string) => `sha256:${createHash("sha256").update(body).digest("hex")}`;

describe("bump-wolfi-pin", () => {
  let server: Server;
  let base = "";
  let served: Served = { body: "" };
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ""}`);
      const claimed = served.claimed ?? digestOf(served.body);
      if (req.url?.startsWith("/token?scope=repository:chainguard/wolfi-base:pull")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ token: "tok-123" }));
      }
      if (req.headers.authorization !== "Bearer tok-123") { res.statusCode = 401; return res.end(); }
      if (req.url === "/v2/chainguard/wolfi-base/manifests/latest" && req.method === "HEAD") {
        if (claimed) res.setHeader("docker-content-digest", claimed);
        return res.end();
      }
      if (req.url === `/v2/chainguard/wolfi-base/manifests/${claimed}`) return res.end(served.body);
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  /** Async: the registry lives in this process, so a blocking spawn would starve it. */
  function runBump(args: string[], env: Record<string, string>) {
    return new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("sh", [bump, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", WOLFI_REGISTRY: base, ...env } });
      let out = ""; let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (status) => resolve({ status, out, err }));
    });
  }
  const A = "apk add --no-cache bash git";
  const B = "apk add --no-cache bash apko";
  const C = "apk add --no-cache bash nodejs";
  const three = () => workflowFile([image(), image(), image()], [A, B, C]);
  const BUILT = "2026-09-29T20:55:55Z";

  it("moves every pin to the digest the registry serves, proves it, dates the line, and runs the preflight on the NEW image", async () => {
    served = { body: manifest(BUILT) };
    const next = digestOf(served.body);
    const wf = three();
    const rt = runtime(wf.dir, { created: BUILT });
    seen.length = 0;
    const r = await runBump([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    // The file is the original with ONLY the digest and the dated line replaced.
    const today = new Date().toISOString().slice(0, 10);
    const expected = fixtureText([image(), image(), image()], [A, B, C])
      .replaceAll(`sha256:${DIGEST}`, next)
      .replaceAll("# Pinned 2026-08-19: the image built 2026-08-18T11:02:13Z.", `# Pinned ${today}: the image built ${BUILT}.`);
    expect(readFileSync(wf.file, "utf8")).toBe(expected);
    expect(expected).not.toContain(DIGEST);
    expect(r.out).toContain(`pinned:  ${image()}`);
    expect(r.out).toContain(`current: cgr.dev/chainguard/wolfi-base@${next}   (built ${BUILT})`);
    expect(r.out).toContain("3 pins moved");
    const moved = `cgr.dev/chainguard/wolfi-base@${next}`;
    expect(rt.calls()).toEqual([A, B, C].map((line) => ["run", "--rm", moved, "sh", "-ec", line]));
    expect(r.out).toContain("the preflight passed on the new image");
    // The token is asked for once and sent on both registry reads.
    expect(seen).toEqual([
      "GET /token?scope=repository:chainguard/wolfi-base:pull auth=",
      "HEAD /v2/chainguard/wolfi-base/manifests/latest auth=Bearer tok-123",
      `GET /v2/chainguard/wolfi-base/manifests/${next} auth=Bearer tok-123`,
    ]);
  });

  it("moves the pins of several workflow files together", async () => {
    served = { body: manifest(BUILT) };
    const next = digestOf(served.body);
    const one = workflowFile([image(), image()], [A, B]);
    const two = workflowFile([image()], [C]);
    const rt = runtime(one.dir);
    const r = await runBump([], { RELEASE_WORKFLOWS: `${one.file} ${two.file}`, CONTAINER_RUNTIME: rt.bin });
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain("3 pins moved");
    for (const f of [one.file, two.file]) {
      const after = readFileSync(f, "utf8");
      expect(after).not.toContain(DIGEST);
      expect(after).toContain(`cgr.dev/chainguard/wolfi-base@${next}`);
    }
    // The preflight then ran over BOTH files, on the new image.
    expect(rt.calls().map((c) => [c[2], c[5]])).toEqual([A, B, C].map((line) => [`cgr.dev/chainguard/wolfi-base@${next}`, line]));
  });

  it("refuses two different pins across two files, and changes neither", async () => {
    served = { body: manifest(BUILT) };
    const one = workflowFile([image()], [A]);
    const two = workflowFile([image("b".repeat(64))], [B]);
    const before = [one.file, two.file].map((f) => readFileSync(f, "utf8"));
    const r = await runBump([], { RELEASE_WORKFLOWS: `${one.file} ${two.file}`, CONTAINER_RUNTIME: runtime(one.dir).bin });
    expect(r.status).toBe(1);
    expect(r.err).toContain("expected ONE cgr.dev/chainguard/wolfi-base pin");
    expect([one.file, two.file].map((f) => readFileSync(f, "utf8"))).toEqual(before);
  });

  it("--dry-run reports both digests and changes nothing", async () => {
    served = { body: manifest(BUILT) };
    const wf = three();
    const rt = runtime(wf.dir);
    const before = readFileSync(wf.file, "utf8");
    const r = await runBump(["--dry-run"], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(0);
    expect(r.out).toContain(digestOf(served.body));
    expect(r.out).toContain("--dry-run, nothing changed");
    expect(readFileSync(wf.file, "utf8")).toBe(before);
    expect(rt.calls()).toEqual([]);
  });

  it("a pin that is already the current image is left alone", async () => {
    served = { body: manifest(BUILT) };
    const current = digestOf(served.body).slice("sha256:".length);
    const wf = workflowFile([image(current), image(current)], [A, B]);
    const rt = runtime(wf.dir);
    const before = readFileSync(wf.file, "utf8");
    const r = await runBump([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(0);
    expect(r.out).toContain("nothing to change");
    expect(readFileSync(wf.file, "utf8")).toBe(before);
    expect(rt.calls()).toEqual([]);
  });

  it("refuses a digest the served content does not hash to", async () => {
    served = { body: manifest(BUILT), claimed: `sha256:${"c".repeat(64)}` };
    const wf = three();
    const before = readFileSync(wf.file, "utf8");
    const r = await runBump([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: runtime(wf.dir).bin });
    expect(r.status).toBe(1);
    expect(r.err).toContain("refusing a digest the content does not prove");
    expect(readFileSync(wf.file, "utf8")).toBe(before);
  });

  it("refuses when the registry names no digest, or one that is not a full sha256", async () => {
    for (const claimed of ["", "sha256:abc", `sha512:${"a".repeat(64)}`, `sha256:${"G".repeat(64)}`]) {
      served = { body: manifest(BUILT), claimed };
      const wf = three();
      const before = readFileSync(wf.file, "utf8");
      const r = await runBump([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: runtime(wf.dir).bin });
      expect(r.status, claimed).toBe(1);
      expect(r.err, claimed).toContain("did not name a sha256 digest");
      expect(readFileSync(wf.file, "utf8"), claimed).toBe(before);
    }
  });

  it("refuses a workflow whose job containers carry two different pins", async () => {
    served = { body: manifest(BUILT) };
    const wf = workflowFile([image(), image("b".repeat(64))], [A, B]);
    const before = readFileSync(wf.file, "utf8");
    const r = await runBump([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: runtime(wf.dir).bin });
    expect(r.status).toBe(1);
    expect(r.err).toContain("expected ONE cgr.dev/chainguard/wolfi-base pin");
    expect(readFileSync(wf.file, "utf8")).toBe(before);
  });

  it("a preflight that fails on the new image fails the bump and says the file is already moved", async () => {
    served = { body: manifest(BUILT) };
    const wf = three();
    const rt = runtime(wf.dir, { failOn: "apko" });
    const r = await runBump([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(1);
    expect(r.err).toContain("the preflight FAILED on the new image");
    expect(readFileSync(wf.file, "utf8")).toContain(digestOf(served.body));
  });

  it("without a container runtime it moves the pins and says that CI runs the preflight", async () => {
    served = { body: manifest(BUILT) };
    const wf = three();
    const r = await runBump([], { RELEASE_WORKFLOWS: wf.file, CONTAINER_RUNTIME: "no-such-container-runtime" });
    expect(r.status).toBe(0);
    expect(readFileSync(wf.file, "utf8")).toContain(digestOf(served.body));
    expect(r.out).toContain("no container runtime here, so the preflight did not run");
    expect(r.out).not.toContain("the preflight passed");
  });

  it("refuses an unknown argument before it asks the registry anything", async () => {
    seen.length = 0;
    const r = await runBump(["--force"], { RELEASE_WORKFLOWS: three().file });
    expect(r.status).toBe(2);
    expect(seen).toEqual([]);
  });
});
