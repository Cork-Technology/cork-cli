import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";

const StepSchema = z.object({
  uses: z.string().optional(), if: z.string().optional(), run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(), with: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const JobSchema = z.object({
  needs: z.union([z.string(), z.array(z.string())]).optional(), uses: z.string().optional(),
  if: z.string().optional(), environment: z.string().optional(), permissions: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.unknown()).optional(), steps: z.array(StepSchema).optional(),
  strategy: z.object({ matrix: z.object({ include: z.array(z.record(z.string(), z.string())).optional() }).passthrough().optional() }).passthrough().optional(),
}).passthrough();
const WorkflowSchema = z.object({ jobs: z.record(z.string(), JobSchema) }).passthrough();
const ReleaseWorkflowsSchema = z.object({
  release: WorkflowSchema.extend({ jobs: z.object({ "version-gate": JobSchema, "build-primary": JobSchema, "build-shadow": JobSchema, determinism: JobSchema, smoke: JobSchema, "config-branch": JobSchema, "apk-repo": JobSchema, publish: JobSchema, "deploy-cvm": JobSchema }).catchall(JobSchema) }),
  build: WorkflowSchema.extend({ jobs: z.object({ build: JobSchema }).catchall(JobSchema) }),
  apk: WorkflowSchema.extend({ jobs: z.object({ plan: JobSchema, "melange-build": JobSchema, publish: JobSchema }).catchall(JobSchema) }),
  toolchain: WorkflowSchema.extend({ jobs: z.object({ preflight: JobSchema, "rehearsal-build": JobSchema, "rehearsal-image": JobSchema }).catchall(JobSchema) }),
});
type Job = z.infer<typeof JobSchema>;
export type ReleaseWorkflows = z.infer<typeof ReleaseWorkflowsSchema>;

// Executed before a cut and on main. This is policy over parsed workflow graphs, not a lint
// approximation: adding a covered channel without making it an ancestor of publish is refused.
export function validateReleaseGraph(workflows: ReleaseWorkflows, repo: string, tag?: string): void {
  if (repo !== "Cork-Technology/cork-cli" && repo !== "Cork-Technology/cork-cli-private") throw new Error("unknown release component");
  const privateRepo = repo === "Cork-Technology/cork-cli-private";
  if (tag && !/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(tag)) throw new Error("unsupported release tag");
  if (privateRepo && tag && !/-rc\.\d+$/.test(tag)) throw new Error("private stable publication is unsupported");
  for (const [name, workflow] of Object.entries(workflows)) {
    const active = new Set<string>(), done = new Set<string>();
    function visit(id: string): void {
      if (!workflow.jobs[id]) throw new Error(`${name}: missing dependency ${id}`);
      if (active.has(id)) throw new Error(`${name}: dependency cycle at ${id}`);
      if (done.has(id)) return;
      active.add(id);
      const needs = workflow.jobs[id].needs;
      for (const parent of typeof needs === "string" ? [needs] : needs ?? []) visit(parent);
      active.delete(id); done.add(id);
    }
    for (const id of Object.keys(workflow.jobs)) visit(id);
  }
  function requireAncestor(jobs: Record<string, Job>, ancestor: string, descendant: string): void {
    if (!jobs[ancestor] || !jobs[descendant]) throw new Error(`missing mandatory job ${ancestor}/${descendant}`);
    const pending = [descendant], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const needs = jobs[id]!.needs; // The complete dependency graph was validated above.
      const parents = typeof needs === "string" ? [needs] : needs ?? [];
      if (parents.includes(ancestor)) return;
      pending.push(...parents);
    }
    throw new Error(`${ancestor} must precede ${descendant}`);
  }
  const jobs = workflows.release.jobs;
  for (const id of ["version-gate", "build-primary", "build-shadow", "determinism", "smoke", "config-branch", "apk-repo", "publish", "deploy-cvm"]) {
    if (!jobs[id]) throw new Error(`missing mandatory release job ${id}`);
  }
  if (jobs.publish.if) throw new Error("covered publication must not be conditionally skipped");
  for (const job of [jobs["version-gate"], workflows.toolchain.jobs.preflight]) {
    if (job?.if || !job?.steps?.some((step) => !step.if && step.run?.trim() === "bun scripts/release-graph.ts")) throw new Error("release and main must execute graph admission before doing work; must not be conditionally skipped");
  }
  if (jobs["config-branch"].with?.ref !== "${{ github.sha }}") throw new Error("config side effects must use the immutable admitted source commit");
  const imageRecords = jobs.publish.steps?.filter((step) => step.env?.PUBLISHED_IMAGE) ?? [];
  if (imageRecords.length !== 2 || imageRecords.some((step) => step.env?.PUBLISHED_IMAGE !== "${{ needs.apk-repo.outputs.image-name }}")) throw new Error("release image destination must come from the attested apk output");
  for (const id of Object.keys(jobs)) {
    if (id !== "publish" && id !== "deploy-cvm") {
      if (jobs[id]!.if) throw new Error(`covered job ${id} must not be conditionally skipped`);
      requireAncestor(jobs, id, "publish");
    }
  }
  for (const id of ["build-primary", "build-shadow"] as const) {
    requireAncestor(jobs, "version-gate", id);
    requireAncestor(jobs, id, "determinism");
    if (jobs[id].uses !== "./.github/workflows/build-binaries.yml") throw new Error(`${id}: wrong builder`);
    if (jobs[id].with?.version !== "${{ github.ref_name }}") throw new Error(`${id}: source tag not propagated`);
  }
  if (jobs["build-primary"].with?.attest !== true || jobs["build-shadow"].with?.attest !== false) throw new Error("primary must be attested and shadow independent/unattested");
  if (jobs["build-primary"].with?.["artifact-name"] !== "binaries-primary" || jobs["build-shadow"].with?.["artifact-name"] !== "binaries-shadow") throw new Error("primary/shadow artifact identity is ambiguous");
  requireAncestor(jobs, "determinism", "smoke");
  requireAncestor(jobs, "smoke", "config-branch");
  requireAncestor(jobs, "config-branch", "apk-repo");
  requireAncestor(jobs, "publish", "deploy-cvm");
  const smoke = jobs.smoke.strategy?.matrix?.include ?? [];
  const expectedSmoke: Record<string, string> = { "ubuntu-latest": "ch-linux-x64", "ubuntu-24.04-arm": "ch-linux-arm64", "macos-latest": "ch-darwin-arm64", "windows-latest": "ch-windows-x64.exe" };
  if (smoke.length !== 4 || smoke.some((row) => row.os === undefined || expectedSmoke[row.os] !== row.asset) || new Set(smoke.map((row) => row.os)).size !== 4) throw new Error("complete four-platform smoke matrix required");
  const deployIf = (jobs["deploy-cvm"].if ?? "").replace(/\s/g, "").replace(/^\$\{\{|\}\}$/g, "");
  if (deployIf !== "github.repository=='Cork-Technology/cork-cli'&&needs.apk-repo.outputs.candidate=='false'") throw new Error("deployment must exclude private and candidate channels");
  const builder = workflows.build.jobs.build;
  if (!builder) throw new Error("missing reusable builder");
  const attest = builder.steps?.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  const subjects = attest?.with?.["subject-path"];
  if (attest?.if !== "${{ inputs.attest }}" || typeof subjects !== "string" || !["dist/ch-*", "dist/cork-*.tgz", "dist/checksums.txt"].every((subject) => subjects.split(/\s+/).includes(subject))) throw new Error("binary/SDK/checksum attestation coverage required");
  if (builder.permissions?.["id-token"] !== "write" || builder.permissions?.attestations !== "write") throw new Error("builder attestation permissions required");
  const apkJobs = workflows.apk.jobs;
  requireAncestor(apkJobs, "plan", "melange-build");
  requireAncestor(apkJobs, "melange-build", "publish");
  if (apkJobs["melange-build"].environment !== "release") throw new Error("package signing requires release reviewer gate");
  const archs = apkJobs["melange-build"].strategy?.matrix?.include?.map((row) => row.arch).sort();
  if (JSON.stringify(archs) !== JSON.stringify(["aarch64", "x86_64"])) throw new Error("both package architectures required");
  const imageAttest = apkJobs.publish.steps?.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  if (imageAttest?.with?.["subject-name"] !== "${{ env.IMAGE_NAME }}" || imageAttest.with["subject-digest"] !== "${{ env.IMAGE_DIGEST }}" || imageAttest.with["push-to-registry"] !== true) throw new Error("image identity/digest registry attestation required");
  if (privateRepo) {
    requireAncestor(workflows.toolchain.jobs, "preflight", "rehearsal-build");
    const rehearsal = workflows.toolchain.jobs["rehearsal-build"];
    const rehearsalIf = (rehearsal?.if ?? "").replace(/\s/g, "").replace(/^\$\{\{|\}\}$/g, "");
    if (rehearsalIf !== "(github.repository=='Cork-Technology/cork-cli'||github.repository=='Cork-Technology/cork-cli-private')&&github.event_name!='pull_request'") throw new Error("private complete rehearsal must not be skipped");
    const rehearsalArchs = rehearsal.strategy?.matrix?.include?.map((row) => row.arch).sort();
    if (JSON.stringify(rehearsalArchs) !== JSON.stringify(["aarch64", "x86_64"])) throw new Error("private rehearsal requires both architectures");
    requireAncestor(workflows.toolchain.jobs, "rehearsal-build", "rehearsal-image");
  }
}

if (import.meta.main) {
  try {
    const directory = process.argv[2] ?? ".github/workflows";
    const names = { release: "release", build: "build-binaries", apk: "apk-repo", toolchain: "release-toolchain" } as const;
    const workflows: Record<string, unknown> = {};
    for (const [key, name] of Object.entries(names)) {
      const parsed = spawnSync("yq", ["-o=json", ".", join(directory, `${name}.yml`)], { encoding: "utf8" });
      if (parsed.status !== 0) throw new Error(`cannot parse ${name} with yq: ${parsed.stderr || parsed.error?.message}`);
      workflows[key] = JSON.parse(parsed.stdout);
    }
    const admitted = ReleaseWorkflowsSchema.parse(workflows);
    validateReleaseGraph(admitted, process.env.GITHUB_REPOSITORY ?? "Cork-Technology/cork-cli", process.env.RELEASE_TAG);
    console.log("release graph admitted: complete builds, attestations, smoke, signing, rehearsal and publication-last dependencies");
  } catch (error) {
    console.error(`release-graph: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
