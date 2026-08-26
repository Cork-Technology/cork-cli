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
 * The HyperSync native binding this binary embeds, as the platform package's `.node` specifier
 * (stamped by compile-binaries.mjs; the require that loads it lives in datasources/hypersync.ts).
 * Null in a source run, and on a target Envio ships no binding for — `ch version` reports it so
 * an operator can see at a glance whether an image can serve full-decentralized reads.
 */
export const HYPERSYNC_BINDING: string | null = process.env.CH_HYPERSYNC_BINDING ?? null;

/** Compare two dot-separated prerelease identifier lists by SemVer §11 precedence: numeric
 *  identifiers compare NUMERICALLY (so rc.10 > rc.9 — a plain string compare gets this backwards
 *  and would offer rc.9 as an "update" over rc.10), numeric sorts below non-numeric, and a
 *  shorter list sorts below an otherwise-equal longer one. */
function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1; // a release outranks its own prerelease
  if (b === "") return -1;
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i]!;
    const y = bs[i]!;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = BigInt(x) - BigInt(y); // BigInt: an absurdly long identifier must not lose precision
      if (d !== 0n) return d > 0n ? 1 : -1;
      continue;
    }
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * Compare two release versions ("v1.2.3", "1.2.3", "v1.2.3-rc.1"). Returns <0 | 0 | >0.
 * Numeric dot-segments compare numerically; a pre-release suffix sorts BELOW its release
 * (1.2.3-rc.1 < 1.2.3), and prerelease identifiers follow SemVer §11 precedence.
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
  return comparePrerelease(pa.pre, pb.pre);
}
