// scripts/release-toolchain-preflight.sh runs every `apk add` of the release workflow in the
// image that workflow pins, on main, before a tag exists. On 2026-10-01 a six-week-old image pin
// broke v0.6.1-rc.3 after its GitHub Release was published: the image's world file held
// libcrypto3 back while Wolfi's repository rolled on. These tests run the real script with a
// recording stand-in for the container runtime (CI has docker; this suite must not need it), and
// hold the script to the REAL workflow file — the single source of the image and the lines.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(root, "scripts/release-toolchain-preflight.sh");
const workflow = readFileSync(join(root, ".github/workflows/apk-repo.yml"), "utf8");
const DIGEST = "a".repeat(64);

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("sh", [script, ...args], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** A workflow file with the given images and install lines, in the two shapes apk-repo.yml uses. */
function workflowFile(images: string[], lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-preflight-"));
  const body = images.map((image, i) => [
    `  job${i}:`,
    "    container:",
    `      image: ${image}`,
    "    steps:",
    ...(i % 2 === 0
      ? ["      - shell: sh", "        run: |", `          ${lines[i] ?? "true"}`, "          git config --global --add safe.directory x"]
      : ["      - shell: sh", `        run: ${lines[i] ?? "true"}`]),
  ].join("\n")).join("\n");
  const file = join(dir, "apk-repo.yml");
  writeFileSync(file, `# a comment that says \`apk add\`s its tools\njobs:\n${body}\n`);
  return { dir, file };
}

/** A stand-in runtime: appends its argv to a log, one argument per line, and fails when the install line contains `failOn`. */
function runtime(dir: string, failOn = "@@never@@") {
  const log = join(dir, "calls.log");
  const bin = join(dir, "runtime.sh");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nprintf -- '--\\n' >> "${log}"\ncase "$6" in *"${failOn}"*) echo "ERROR: simulated file conflict"; exit 1 ;; esac\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8").split("--\n").filter(Boolean).map((c) => c.trimEnd().split("\n")) };
}

const image = (digest = DIGEST) => `cgr.dev/chainguard/wolfi-base@sha256:${digest}`;

describe("release-toolchain preflight — the real workflow", () => {
  const listed = run(["--list"]);
  const [imageLine, ...lines] = listed.out.trimEnd().split("\n");

  it("reads ONE digest-pinned image and every install line from apk-repo.yml", () => {
    expect(listed.status).toBe(0);
    expect(imageLine).toMatch(/^image: cgr\.dev\/chainguard\/wolfi-base@sha256:[0-9a-f]{64}$/);
    // Every `apk add` the workflow runs is found — none is missed by the line pattern.
    const inWorkflow = workflow.split("\n").filter((l) => /^\s*(run: )?apk add /.test(l)).map((l) => l.replace(/^\s*(run: )?/, ""));
    expect(lines).toEqual(inWorkflow);
    expect(lines.length).toBe(3);
  });

  it("every job container of the workflow carries that same digest", () => {
    const pins = [...workflow.matchAll(/^\s*image: (\S+)$/gm)].map((m) => m[1]);
    expect(pins.length).toBe(3);
    expect(new Set(pins)).toEqual(new Set([imageLine!.replace("image: ", "")]));
  });

  it("the build toolchain asks for the versioned openssl CLI, never the unversioned name", () => {
    // The unversioned name is what an aged image's world pin turns into an old, colliding build.
    const build = lines.find((l) => l.includes("melange"))!;
    expect(build.split(" ")).toContain("openssl-4.0");
    expect(lines.flatMap((l) => l.split(" "))).not.toContain("openssl");
  });

  it("CI runs the script on main, without a container of its own", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const job = ci.slice(ci.indexOf("  release-toolchain:"), ci.indexOf("  live-smoke:"));
    // The exact command, to the end of the line: `--list` would print and check nothing.
    expect(job).toMatch(/^ {8}run: sh scripts\/release-toolchain-preflight\.sh$/m);
    expect(job).toContain("runs-on: ubuntu-latest");
    expect(job).not.toContain("container:");
    expect(job).not.toContain("needs:");
  });
});

describe("release-toolchain preflight — the run", () => {
  const A = "apk add --no-cache bash git melange openssl-4.0 yq";
  const B = "apk add --no-cache bash apko curl";

  it("runs each line in a FRESH container of the pinned image, in order", () => {
    const wf = workflowFile([image(), image()], [A, B]);
    const rt = runtime(wf.dir);
    const r = run([], { RELEASE_WORKFLOW: wf.file, CONTAINER_RUNTIME: rt.bin });
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
    const rt = runtime(wf.dir, "melange");
    const r = run([], { RELEASE_WORKFLOW: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`::error::release-toolchain: FAILED in the pinned image: ${A}`);
    expect(rt.calls().length).toBe(1);
    expect(r.out).not.toContain("OK    ");
  });

  it("fails when a LATER install fails, after the earlier one passed", () => {
    const wf = workflowFile([image(), image()], [A, B]);
    const rt = runtime(wf.dir, "apko");
    const r = run([], { RELEASE_WORKFLOW: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`release-toolchain: OK    ${A}`);
    expect(r.out).toContain(`FAILED in the pinned image: ${B}`);
  });

  it("--list runs nothing", () => {
    const wf = workflowFile([image()], [A]);
    const r = run(["--list"], { RELEASE_WORKFLOW: wf.file, CONTAINER_RUNTIME: join(wf.dir, "absent") });
    expect(r.status).toBe(0);
    expect(r.out).toBe(`image: ${image()}\n${A}\n`);
  });
});

describe("release-toolchain preflight — refusals", () => {
  const A = "apk add --no-cache bash";

  it("refuses two different image pins: the jobs must not age apart", () => {
    const wf = workflowFile([image(), image("b".repeat(64))], [A, A]);
    const rt = runtime(wf.dir);
    const r = run([], { RELEASE_WORKFLOW: wf.file, CONTAINER_RUNTIME: rt.bin });
    expect(r.status).toBe(1);
    expect(r.err).toContain("expected ONE job-container image");
    expect(r.err).toContain("found 2");
  });

  it("refuses an image that is not digest-pinned", () => {
    for (const loose of ["cgr.dev/chainguard/wolfi-base:latest", "cgr.dev/chainguard/wolfi-base", `cgr.dev/chainguard/wolfi-base@sha256:${"a".repeat(63)}`]) {
      const wf = workflowFile([loose], [A]);
      const r = run(["--list"], { RELEASE_WORKFLOW: wf.file });
      expect(r.status, loose).toBe(1);
      expect(r.err, loose).toContain("not digest-pinned");
    }
  });

  it("refuses a workflow with no install line, and a missing workflow file", () => {
    const wf = workflowFile([image()], ["echo nothing to install"]);
    const none = run(["--list"], { RELEASE_WORKFLOW: wf.file });
    expect(none.status).toBe(1);
    expect(none.err).toContain("no `apk add --no-cache` line found");
    const missing = run(["--list"], { RELEASE_WORKFLOW: join(wf.dir, "absent.yml") });
    expect(missing.status).toBe(1);
    expect(missing.err).toContain("not found");
  });
});
