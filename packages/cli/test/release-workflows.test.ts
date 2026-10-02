// The release pipeline's ORDER and its rehearsal, read from the real workflow files.
//
// On 2026-10-01 the v0.6.1-rc.3 run published the GitHub Release and then failed to build the
// image the Release body names. Two properties keep that from happening again, and nothing but
// the workflow files can hold them:
//   1. PUBLISH LAST — every channel the Release claims is built before the Release is public;
//      the hosted deployment (an excluded channel) comes after it and cannot hold it back.
//   2. THE REHEARSAL — every push to main builds the apk and the image with the release's own
//      scripts and command lines, and is unable to publish anything.
// The workflows are parsed with the real yq (the CI runners and the apk job have it; the block
// self-skips without it) and, when actionlint is on PATH, linted as GitHub would read them.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const wfPath = (name: string) => join(root, ".github/workflows", name);
const text = (name: string) => readFileSync(wfPath(name), "utf8");
const hasYq = spawnSync("yq", ["--version"]).status === 0;
const hasActionlint = spawnSync("actionlint", ["-version"]).status === 0;

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; shell?: string };
type Job = {
  needs?: string | string[]; uses?: string; if?: string; secrets?: string; environment?: string;
  permissions?: Record<string, string>; with?: Record<string, string>; steps?: Step[];
  container?: { image: string; options?: string }; outputs?: Record<string, string>;
};
type Workflow = { on: Record<string, any>; permissions?: Record<string, string>; jobs: Record<string, Job> };

function load(name: string): Workflow {
  const r = spawnSync("yq", ["-o=json", ".", wfPath(name)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`yq failed on ${name}: ${r.stderr}`);
  return JSON.parse(r.stdout) as Workflow;
}
const needsOf = (job: Job) => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);
/** Every job that runs after `name`, directly or through other jobs. */
function descendants(wf: Workflow, name: string): string[] {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, job] of Object.entries(wf.jobs)) {
      if (!out.has(id) && needsOf(job).some((n) => n === name || out.has(n))) { out.add(id); grew = true; }
    }
  }
  return [...out].sort();
}
/** Every job that must finish before `name` starts. */
function ancestors(wf: Workflow, name: string): string[] {
  const out = new Set<string>();
  const walk = (id: string) => { for (const n of needsOf(wf.jobs[id]!)) { if (!out.has(n)) { out.add(n); walk(n); } } };
  walk(name);
  return [...out].sort();
}
const runs = (job: Job) => (job.steps ?? []).map((s) => s.run ?? "").join("\n");
const installLines = (wf: Workflow, job: string) => runs(wf.jobs[job]!).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("apk add "));

describe.skipIf(!hasYq)("release.yml — the Release publishes last", () => {
  const wf = load("release.yml");

  it("the apk and image build is an ancestor of publish, never a descendant", () => {
    expect(wf.jobs["apk-repo"]!.uses).toBe("./.github/workflows/apk-repo.yml");
    expect(ancestors(wf, "publish")).toContain("apk-repo");
    expect(ancestors(wf, "apk-repo")).not.toContain("publish");
    // Everything the Release's claims rest on is done first: both builds, the determinism
    // proof, the smoke runs, the config branch, the apk and image channel.
    expect(ancestors(wf, "publish")).toEqual(["apk-repo", "build-primary", "build-shadow", "config-branch", "determinism", "smoke", "version-gate"]);
  });

  it("the only job after publish is the hosted deployment — an excluded channel", () => {
    expect(descendants(wf, "publish")).toEqual(["deploy-cvm"]);
    // And no job that uses a build workflow runs after it.
    for (const id of descendants(wf, "publish")) expect(wf.jobs[id]!.uses, id).toBe("./.github/workflows/deploy-cvm.yml");
  });

  it("apk-repo does not wait for the Release, and gets the secrets and the write scopes it needs", () => {
    const job = wf.jobs["apk-repo"]!;
    expect(needsOf(job).sort()).toEqual(["config-branch", "determinism", "smoke"]);
    expect(job.secrets).toBe("inherit");
    expect(job.with).toEqual({ tag: "${{ github.ref_name }}" });
    expect(job.permissions).toEqual({ contents: "write", packages: "write", "id-token": "write", attestations: "write" });
  });

  it("publish refuses to create a Release without a full image digest from apk-repo, and records it as an asset", () => {
    const steps = wf.jobs.publish!.steps!;
    const record = steps.findIndex((s) => s.run?.includes("dist/image.txt") && s.env?.IMAGE_DIGEST !== undefined);
    const create = steps.findIndex((s) => s.run?.includes("gh release create"));
    expect(record).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(record);
    const step = steps[record]!;
    expect(step.env!.IMAGE_DIGEST).toBe("${{ needs.apk-repo.outputs.image-digest }}");
    // The guard: a full sha256 digest, or the job stops before any Release exists.
    expect(step.run).toMatch(/grep -Eqx 'sha256:\[0-9a-f\]\{64\}' \|\| \{[^}]*exit 1; \}/);
    expect(step.run!.indexOf("exit 1")).toBeLessThan(step.run!.indexOf("> dist/image.txt"));
    expect(step.run).toContain(`printf 'ghcr.io/%s/cork-cli:%s@%s\\n' "$owner" "$GITHUB_REF_NAME" "$IMAGE_DIGEST" > dist/image.txt`);
    // The asset list of the one `gh release create` call names it.
    expect(steps[create]!.run).toMatch(/dist\/ch-\* dist\/cork-\*\.tgz dist\/checksums\.txt dist\/image\.txt\s*$/);
    expect(steps[create]!.run).toContain("--verify-tag");
  });

  it("the hosted deployment runs after the Release, for production tags only, with the digest apk-repo pushed", () => {
    const job = wf.jobs["deploy-cvm"]!;
    expect(needsOf(job).sort()).toEqual(["apk-repo", "publish"]);
    expect(job.if).toBe("${{ needs.apk-repo.outputs.candidate == 'false' }}");
    expect(job.secrets).toBe("inherit");
    expect(job.with).toEqual({ "image-digest": "${{ needs.apk-repo.outputs.image-digest }}" });
    expect(job.permissions).toEqual({ contents: "read" });
  });

  it("only tags start a release, and the workflow's own token is read-only by default", () => {
    expect(wf.on).toEqual({ push: { tags: ["v*"] } });
    expect(wf.permissions).toEqual({ contents: "read" });
  });
});

describe.skipIf(!hasYq)("apk-repo.yml — builds the channels, hands the digest to its caller, deploys nothing", () => {
  const wf = load("apk-repo.yml");

  it("has exactly the plan, the signing build and the publish job", () => {
    expect(Object.keys(wf.jobs)).toEqual(["plan", "melange-build", "publish"]);
  });

  it("exports the image digest and the release kind to a calling workflow", () => {
    const outputs = wf.on.workflow_call.outputs;
    expect(outputs["image-digest"].value).toBe("${{ jobs.publish.outputs.image-digest }}");
    expect(outputs.candidate.value).toBe("${{ jobs.plan.outputs.candidate }}");
    expect(wf.jobs.publish!.outputs).toEqual({ "image-digest": "${{ steps.image.outputs.digest }}" });
    expect(wf.jobs.plan!.outputs!.candidate).toBe("${{ steps.p.outputs.candidate }}");
  });

  it("only the signing build is behind the release environment; the publish job holds no secret", () => {
    expect(wf.jobs["melange-build"]!.environment).toBe("release");
    expect(wf.jobs.publish!.environment).toBeUndefined();
    expect(wf.jobs.plan!.environment).toBeUndefined();
    expect(JSON.stringify(wf.jobs.publish)).not.toContain("secrets.");
  });

  it("the build, the slice and the image spec go through the shared scripts — no second spelling here", () => {
    const build = runs(wf.jobs["melange-build"]!);
    expect(build).toContain('sh scripts/apk-melange-build.sh "${{ matrix.arch }}" melange.rsa');
    expect(build).toContain('sh scripts/apk-slice.sh "$ARCH" melange.rsa "$base"');
    const publish = runs(wf.jobs.publish!);
    expect(publish).toContain('sh scripts/apk-image-spec.sh local "$APKVER" "$TAG" "$rev" packaging/melange.rsa.pub');
    expect(publish).toContain('sh scripts/apk-image-spec.sh pages "$APKVER" "$TAG" "$rev"');
    // A candidate composes from its local slices; production from the channel it published.
    expect(publish).toMatch(/if \[ "\$CANDIDATE" = "true" \]; then\s+sh scripts\/apk-image-spec\.sh local [^\n]+\s+else\s+sh scripts\/apk-image-spec\.sh pages /);
    const all = build + publish;
    expect(all).not.toMatch(/melange build /);
    expect(all).not.toMatch(/melange index /);
    expect(all).not.toMatch(/yq -i /);
  });

  it("the image revision is the TAG's commit, resolved in the job, never github.sha", () => {
    const step = wf.jobs.publish!.steps!.find((s) => s.run?.includes("apk-image-spec.sh"))!;
    expect(step.run).toContain('git fetch -q --no-tags origin "+refs/tags/$TAG:refs/tags/$TAG"');
    expect(step.run).toContain('rev="$(git rev-parse "$TAG^{commit}")"');
    // In the commands, not in the comment that explains why.
    const commands = step.run!.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(commands).not.toContain("github.sha");
    expect(commands).not.toContain("GITHUB_SHA");
  });
});

describe.skipIf(!hasYq)("deploy-cvm.yml — one way in, one digest", () => {
  const wf = load("deploy-cvm.yml");
  const job = wf.jobs["deploy-cvm"]!;

  it("can only be called by another workflow: no dispatch, no event trigger", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_call"]);
    expect(wf.on.workflow_call.inputs["image-digest"]).toMatchObject({ required: true, type: "string" });
  });

  it("is behind the release environment and reads the repository only", () => {
    expect(job.environment).toBe("release");
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });

  it("refuses anything but a full sha256 digest before it touches the compose or the key", () => {
    const steps = job.steps!;
    const check = steps.findIndex((s) => s.env?.IMAGE_DIGEST === "${{ inputs.image-digest }}");
    const deploy = steps.findIndex((s) => s.run?.includes("phala deploy"));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThan(check);
    expect(steps[check]!.run).toMatch(/grep -Eqx 'sha256:\[0-9a-f\]\{64\}' \|\| \{[^}]*exit 1; \}/);
    expect(steps[check]!.run!.indexOf("exit 1")).toBeLessThan(steps[check]!.run!.indexOf("sed "));
    // The deploy credential appears in the deploy step only, and the CLI is exact-pinned.
    expect(steps.filter((s) => JSON.stringify(s).includes("PHALA_CLOUD_API_KEY")).length).toBe(1);
    expect(steps[deploy]!.run).toMatch(/npm install -g --ignore-scripts phala@\d+\.\d+\.\d+\n/);
  });
});

describe.skipIf(!hasYq)("release-toolchain.yml — the rehearsal builds what a release builds, and cannot publish", () => {
  const wf = load("release-toolchain.yml");
  const apk = load("apk-repo.yml");
  const raw = text("release-toolchain.yml");

  it("installs exactly what the release jobs install, in the same image", () => {
    expect(installLines(wf, "rehearsal-build")).toEqual(installLines(apk, "melange-build"));
    expect(installLines(wf, "rehearsal-image")).toEqual(installLines(apk, "publish"));
    expect(wf.jobs["rehearsal-build"]!.container).toEqual(apk.jobs["melange-build"]!.container);
    expect(wf.jobs["rehearsal-image"]!.container).toEqual(apk.jobs.publish!.container);
    expect(wf.jobs["rehearsal-build"]!.container!.options).toBe("--privileged");
  });

  it("builds both architectures on the runners the release uses", () => {
    const matrix = (j: Job) => (j as any).strategy.matrix.include;
    expect(matrix(wf.jobs["rehearsal-build"]!)).toEqual(matrix(apk.jobs["melange-build"]!));
    expect(matrix(wf.jobs["rehearsal-build"]!).map((m: any) => m.arch)).toEqual(["x86_64", "aarch64"]);
  });

  it("runs the release's own scripts, with a throwaway key and a branch checkout", () => {
    const build = runs(wf.jobs["rehearsal-build"]!);
    expect(build).toContain('sh scripts/apk-spec-identity.sh packaging/melange.yaml "$REHEARSAL_TAG" "$REHEARSAL_APKVER" "$COMMIT"');
    expect(build).toContain('sh scripts/apk-rehearsal-spec.sh packaging/melange.yaml "$GITHUB_REF_NAME"');
    expect(build).toContain('melange keygen "rehearsal-$ARCH.rsa"');
    expect(build).toContain('sh scripts/apk-melange-build.sh "$ARCH" "rehearsal-$ARCH.rsa"');
    expect(build).toContain('sh scripts/apk-slice.sh "$ARCH" "rehearsal-$ARCH.rsa" none');
    // The identity is written before the spec is turned into a rehearsal spec, and both before the build.
    expect(build.indexOf("apk-spec-identity.sh")).toBeLessThan(build.indexOf("apk-rehearsal-spec.sh"));
    expect(build.indexOf("apk-rehearsal-spec.sh")).toBeLessThan(build.indexOf("apk-melange-build.sh"));
    const image = runs(wf.jobs["rehearsal-image"]!);
    expect(image).toMatch(/sh scripts\/apk-image-spec\.sh local 0\.0\.0_rc0 v0\.0\.0-rc\.0 "\$rev" \\\n\s+incoming\/x86_64\/rehearsal-x86_64\.rsa\.pub incoming\/aarch64\/rehearsal-aarch64\.rsa\.pub/);
    expect(image).toContain("apko build packaging/cork-cli.apko.yaml cork-cli:rehearsal rehearsal-image.tar --sbom-path sboms/");
    expect(needsOf(wf.jobs["rehearsal-image"]!)).toEqual(["rehearsal-build"]);
  });

  it("the synthetic identity is one no release can carry, and is the same in both jobs", () => {
    const env = (wf.jobs["rehearsal-build"]! as any).env;
    expect(env).toEqual({ REHEARSAL_TAG: "v0.0.0-rc.0", REHEARSAL_APKVER: "0.0.0_rc0" });
  });

  it("the throwaway PRIVATE key never leaves the job; only its public half is uploaded", () => {
    const steps = wf.jobs["rehearsal-build"]!.steps!;
    const drop = steps.findIndex((s) => s.run === "rm -f rehearsal-*.rsa");
    const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(steps[drop]!.if).toBe("${{ always() }}");
    expect(upload).toBeGreaterThan(drop);
    expect(String(steps[upload]!.with!.path).trim().split("\n")).toEqual(["slice/*", "slice-base.sha", "rehearsal-${{ matrix.arch }}.rsa.pub"]);
  });

  it("runs in the public repository only, and never for a pull request", () => {
    expect(wf.jobs["rehearsal-build"]!.if).toBe("${{ github.repository == 'Cork-Technology/cork-cli' && github.event_name != 'pull_request' }}");
  });

  it("CANNOT publish: read-only token, no secret, no environment, no push, no login, no attestation", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(job.permissions, id).toBeUndefined();
      expect(job.environment, id).toBeUndefined();
      expect(job.secrets, id).toBeUndefined();
    }
    const code = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    for (const forbidden of ["secrets.", "apko publish", "apko login", "docker push", "git push", "attest-build-provenance", "gh release", "id-token", "packages: write", "contents: write"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});

describe("the workflows are valid as GitHub reads them", () => {
  it.skipIf(!hasActionlint)("actionlint passes on every workflow (reusable-workflow inputs, outputs and needs included)", () => {
    const r = spawnSync("actionlint", ["-shellcheck=", "-pyflakes="], { cwd: root, encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("every action is pinned to a full commit SHA", () => {
    for (const name of ["release.yml", "apk-repo.yml", "deploy-cvm.yml", "release-toolchain.yml", "build-binaries.yml", "config-branch.yml", "ci.yml"]) {
      const uses = [...text(name).matchAll(/^\s*-?\s*uses: (\S+)/gm)].map((m) => m[1]!).filter((u) => !u.startsWith("./"));
      for (const u of uses) expect(u, `${name}: ${u}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
