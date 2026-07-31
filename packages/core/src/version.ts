// Build identity, stamped at compile time by the release pipeline:
//
//   bun build --compile \
//     --define "process.env.CH_BUILD_VERSION='\"v0.1.0\"'" \
//     --define "process.env.CH_BUILD_COMMIT='\"<sha>\"'" \
//     --define "process.env.CH_BUILD_TARGET='\"bun-linux-x64\"'" ...
//
// (scripts/compile-binaries.mjs owns the exact invocation.) In a source-run (`bun
// packages/cli/src/bin.ts`) nothing is defined, the env lookups stay live, and the fallbacks
// apply — which also lets tests pin a version via plain env vars.
//
// BUILD_TARGET doubles as the "am I a compiled release binary" signal: self-update refuses to
// run without it, because a source checkout updates through git, not binary replacement.

export const BUILD_VERSION: string = process.env.CH_BUILD_VERSION ?? "dev";
export const BUILD_COMMIT: string = process.env.CH_BUILD_COMMIT ?? "unknown";
export const BUILD_TARGET: string = process.env.CH_BUILD_TARGET ?? "";

/**
 * Compare two release versions ("v1.2.3", "1.2.3", "v1.2.3-rc.1"). Returns <0 | 0 | >0.
 * Numeric dot-segments compare numerically; a pre-release suffix sorts BELOW its release
 * (1.2.3-rc.1 < 1.2.3), matching semver precedence for the shapes our tags actually use.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const stripped = v.trim().replace(/^v/, "");
    const dash = stripped.indexOf("-");
    const core = dash === -1 ? stripped : stripped.slice(0, dash);
    const pre = dash === -1 ? "" : stripped.slice(dash + 1);
    const nums = core.split(".").map((s) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    });
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // release > its own pre-release
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
