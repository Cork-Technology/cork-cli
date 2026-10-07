import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseGraph, type ReleaseWorkflows } from "../../../scripts/release-graph.ts";

const privateRepo = "Cork-Technology/cork-cli-private";
function admittedGraph(): ReleaseWorkflows {
  return {
    release: { jobs: {
      "version-gate": { steps: [{ run: "bun scripts/release-graph.ts" }] },
      "build-primary": { needs: "version-gate", uses: "./.github/workflows/build-binaries.yml", with: { version: "${{ github.ref_name }}", attest: true, "artifact-name": "binaries-primary" } },
      "build-shadow": { needs: "version-gate", uses: "./.github/workflows/build-binaries.yml", with: { version: "${{ github.ref_name }}", attest: false, "artifact-name": "binaries-shadow" } },
      determinism: { needs: ["build-primary", "build-shadow"] },
      smoke: { needs: "determinism", strategy: { matrix: { include: [{ os: "ubuntu-latest", asset: "ch-linux-x64" }, { os: "ubuntu-24.04-arm", asset: "ch-linux-arm64" }, { os: "macos-latest", asset: "ch-darwin-arm64" }, { os: "windows-latest", asset: "ch-windows-x64.exe" }] } } },
      "config-branch": { needs: "smoke", with: { ref: "${{ github.sha }}" } },
      "apk-repo": { needs: "config-branch" },
      publish: { needs: "apk-repo", steps: [{ env: { PUBLISHED_IMAGE: "${{ needs.apk-repo.outputs.image-name }}" } }, { env: { PUBLISHED_IMAGE: "${{ needs.apk-repo.outputs.image-name }}" } }] },
      "deploy-cvm": { needs: "publish", if: "${{ github.repository == 'Cork-Technology/cork-cli' && needs.apk-repo.outputs.candidate == 'false' }}" },
    } },
    build: { jobs: { build: { permissions: { "id-token": "write", attestations: "write" }, steps: [{ uses: `actions/attest-build-provenance@${"a".repeat(40)}`, if: "${{ inputs.attest }}", with: { "subject-path": "dist/ch-*\ndist/cork-*.tgz\ndist/checksums.txt" } }] } } },
    apk: { jobs: { plan: {}, "melange-build": { needs: "plan", environment: "release", strategy: { matrix: { include: [{ arch: "x86_64" }, { arch: "aarch64" }] } } }, publish: { needs: "melange-build", steps: [{ uses: `actions/attest-build-provenance@${"a".repeat(40)}`, with: { "subject-name": "${{ env.IMAGE_NAME }}", "subject-digest": "${{ env.IMAGE_DIGEST }}", "push-to-registry": true } }] } } },
    toolchain: { jobs: { preflight: { steps: [{ run: "bun scripts/release-graph.ts" }] }, "rehearsal-build": { needs: "preflight", if: "${{ (github.repository == 'Cork-Technology/cork-cli' || github.repository == 'Cork-Technology/cork-cli-private') && github.event_name != 'pull_request' }}", strategy: { matrix: { include: [{ arch: "x86_64" }, { arch: "aarch64" }] } } }, "rehearsal-image": { needs: "rehearsal-build" } } },
  };
}

describe("runtime release graph admission", () => {
  it("admits complete private candidates and unchanged public stable graphs", () => {
    expect(() => validateReleaseGraph(admittedGraph(), privateRepo, "v0.7.0-rc.1")).not.toThrow();
    expect(() => validateReleaseGraph(admittedGraph(), "Cork-Technology/cork-cli", "v1.0.0")).not.toThrow();
  });
  it("requires execution of admission in both release and main before work", () => {
    for (const workflow of ["release", "toolchain"] as const) {
      const graph = admittedGraph();
      const gate = workflow === "release" ? graph.release.jobs["version-gate"] : graph.toolchain.jobs.preflight;
      gate.steps = [];
      expect(() => validateReleaseGraph(graph, privateRepo)).toThrow("must execute graph admission");
    }
  });
  it("admits a new covered channel only when it precedes publication", () => {
    const graph = admittedGraph();
    graph.release.jobs["new-covered-channel"] = { needs: "apk-repo" };
    graph.release.jobs.publish.needs = ["apk-repo", "new-covered-channel"];
    expect(() => validateReleaseGraph(graph, privateRepo)).not.toThrow();
    graph.release.jobs.publish.needs = "apk-repo";
    expect(() => validateReleaseGraph(graph, privateRepo)).toThrow("must precede publish");
  });
  it("rejects covered channels placed after publication, absent dependencies and cycles", () => {
    const late = admittedGraph(); late.release.jobs["new-covered-channel"] = { needs: "publish" };
    expect(() => validateReleaseGraph(late, privateRepo)).toThrow("must precede publish");
    const missing = admittedGraph(); missing.release.jobs.publish.needs = "missing-channel";
    expect(() => validateReleaseGraph(missing, privateRepo)).toThrow("missing dependency");
    const cycle = admittedGraph(); cycle.release.jobs["version-gate"].needs = "publish";
    expect(() => validateReleaseGraph(cycle, privateRepo)).toThrow("dependency cycle");
  });
  it.each(["version-gate", "build-primary", "build-shadow", "determinism", "smoke", "config-branch", "apk-repo"])("rejects a missing or skipped mandatory %s job", (id) => {
    const missing = admittedGraph(); delete missing.release.jobs[id];
    expect(() => validateReleaseGraph(missing, privateRepo)).toThrow();
    const skipped = admittedGraph();
    const protectedJob = skipped.release.jobs[id];
    if (!protectedJob) throw new Error(`missing fixture job ${id}`);
    protectedJob.if = "false";
    expect(() => validateReleaseGraph(skipped, privateRepo)).toThrow("conditionally skipped");
  });
  it.each([
    ["determinism", "build-primary"],
    ["smoke", "build-primary"],
    ["config-branch", "determinism"],
    ["apk-repo", "smoke"],
    ["deploy-cvm", "apk-repo"],
  ])("rejects bypassed ordering at %s", (job, needs) => {
    const graph = admittedGraph();
    const target = graph.release.jobs[job];
    if (!target) throw new Error(`missing fixture job ${job}`);
    target.needs = needs;
    expect(() => validateReleaseGraph(graph, privateRepo)).toThrow();
  });
  it("requires independent named builds with the same propagated source tag and an attested primary", () => {
    for (const field of ["attest", "artifact-name", "version"]) {
      const graph = admittedGraph(); graph.release.jobs["build-primary"].with![field] = false;
      expect(() => validateReleaseGraph(graph, privateRepo)).toThrow();
    }
    const shadow = admittedGraph(); shadow.release.jobs["build-shadow"].with!.attest = true;
    expect(() => validateReleaseGraph(shadow, privateRepo)).toThrow("shadow independent");
  });
  it("requires attestations for binaries, all SDK packages and checksums, with actual permissions", () => {
    for (const subject of ["dist/ch-*", "dist/cork-*.tgz", "dist/checksums.txt"]) {
      const graph = admittedGraph(); graph.build.jobs.build.steps![0]!.with!["subject-path"] = ["dist/ch-*", "dist/cork-*.tgz", "dist/checksums.txt"].filter((item) => item !== subject).join("\n");
      expect(() => validateReleaseGraph(graph, privateRepo)).toThrow("attestation coverage");
    }
    const noPermission = admittedGraph(); noPermission.build.jobs.build.permissions!.attestations = "read";
    expect(() => validateReleaseGraph(noPermission, privateRepo)).toThrow("permissions");
  });
  it("refuses incomplete/duplicate/wrong-asset smoke and single-architecture package builds", () => {
    const missing = admittedGraph(); missing.release.jobs.smoke.strategy!.matrix!.include!.pop();
    expect(() => validateReleaseGraph(missing, privateRepo)).toThrow("four-platform");
    const duplicate = admittedGraph(); duplicate.release.jobs.smoke.strategy!.matrix!.include![3] = duplicate.release.jobs.smoke.strategy!.matrix!.include![0]!;
    expect(() => validateReleaseGraph(duplicate, privateRepo)).toThrow("four-platform");
    const wrong = admittedGraph(); wrong.release.jobs.smoke.strategy!.matrix!.include![0]!.asset = "ch-darwin-x64";
    expect(() => validateReleaseGraph(wrong, privateRepo)).toThrow("four-platform");
    const packageGraph = admittedGraph(); packageGraph.apk.jobs["melange-build"].strategy!.matrix!.include!.pop();
    expect(() => validateReleaseGraph(packageGraph, privateRepo)).toThrow("both package architectures");
  });
  it("requires reviewer-gated package signing and registry provenance over the exact pushed image", () => {
    const signing = admittedGraph(); signing.apk.jobs["melange-build"].environment = "other";
    expect(() => validateReleaseGraph(signing, privateRepo)).toThrow("reviewer gate");
    for (const field of ["subject-name", "subject-digest", "push-to-registry"]) {
      const graph = admittedGraph(); graph.apk.jobs.publish.steps![0]!.with![field] = false;
      expect(() => validateReleaseGraph(graph, privateRepo)).toThrow("registry attestation");
    }
  });
  it("refuses private/public destination substitution and config side effects from a movable tag", () => {
    const image = admittedGraph(); image.release.jobs.publish.steps![0]!.env!.PUBLISHED_IMAGE = "ghcr.io/cork-technology/cork-cli";
    expect(() => validateReleaseGraph(image, privateRepo)).toThrow("attested apk output");
    const config = admittedGraph(); config.release.jobs["config-branch"].with!.ref = "${{ github.ref_name }}";
    expect(() => validateReleaseGraph(config, privateRepo)).toThrow("immutable admitted source");
  });
  it("refuses private stable/unknown components and private or candidate production deployments", () => {
    expect(() => validateReleaseGraph(admittedGraph(), privateRepo, "v0.7.0")).toThrow("private stable");
    expect(() => validateReleaseGraph(admittedGraph(), "other/repo")).toThrow("unknown release component");
    for (const condition of ["true", "${{ needs.apk-repo.outputs.candidate == 'false' }}", "${{ github.repository == 'Cork-Technology/cork-cli' }}", "${{ github.repository == 'Cork-Technology/cork-cli' || needs.apk-repo.outputs.candidate == 'false' }}"]) {
      const graph = admittedGraph(); graph.release.jobs["deploy-cvm"].if = condition;
      expect(() => validateReleaseGraph(graph, privateRepo)).toThrow("exclude private and candidate");
    }
  });
  it("requires a complete private package and image rehearsal rather than a public-only skip", () => {
    const excluded = admittedGraph(); excluded.toolchain.jobs["rehearsal-build"].if = "github.repository == 'Cork-Technology/cork-cli'";
    expect(() => validateReleaseGraph(excluded, privateRepo)).toThrow("must not be skipped");
    const oneArch = admittedGraph(); oneArch.toolchain.jobs["rehearsal-build"].strategy!.matrix!.include!.pop();
    expect(() => validateReleaseGraph(oneArch, privateRepo)).toThrow("both architectures");
    const noImage = admittedGraph(); noImage.toolchain.jobs["rehearsal-image"].needs = "preflight";
    expect(() => validateReleaseGraph(noImage, privateRepo)).toThrow("must precede rehearsal-image");
  });
  it.skipIf(spawnSync("yq", ["--version"]).status !== 0)("runs the real Bun/yq policy CLI against allowed and rejected synthetic workflow files", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-graph-"));
    try {
      const graph = admittedGraph();
      const files = { release: "release", build: "build-binaries", apk: "apk-repo", toolchain: "release-toolchain" } as const;
      for (const [key, name] of Object.entries(files)) writeFileSync(join(dir, `${name}.yml`), JSON.stringify(graph[key as keyof ReleaseWorkflows]));
      const path = fileURLToPath(new URL("../../../scripts/release-graph.ts", import.meta.url));
      const options = { encoding: "utf8" as const, env: { PATH: process.env.PATH, GITHUB_REPOSITORY: privateRepo, RELEASE_TAG: "v0.7.0-rc.1" } };
      const admitted = spawnSync(process.execPath, [path, dir], options);
      expect(admitted.status, admitted.stderr).toBe(0);
      expect(admitted.stdout).toContain("release graph admitted");
      graph.release.jobs.publish.needs = "build-primary";
      writeFileSync(join(dir, "release.yml"), JSON.stringify(graph.release));
      const refused = spawnSync(process.execPath, [path, dir], options);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("must precede publish");
      writeFileSync(join(dir, "release.yml"), JSON.stringify({ jobs: [] }));
      const malformed = spawnSync(process.execPath, [path, dir], options);
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain("invalid_type");
      expect(malformed.stdout).not.toContain("release graph admitted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
