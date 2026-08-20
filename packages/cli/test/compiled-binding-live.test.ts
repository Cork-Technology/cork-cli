// Live acceptance for the embedded HyperSync binding: compiles `ch` for THIS host with the real
// release script (a native build, the melange shape) and proves the binary gets PAST the native
// loader — the exact read ops found failing in the bare image (2026-08-20: the package was
// imported by name and no node_modules exists inside a compiled binary). Self-skips unless
// CORK_RPC_LIVE=1 (the live-smoke job); where Envio ships no binding for the host
// (linux-arm64-musl) the test states so and passes, because the binary must refuse honestly.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetForTarget, hyperSyncBindingForTarget } from "../../../scripts/compile-binaries.mjs";

const LIVE = process.env.CORK_RPC_LIVE === "1";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The bun compile target this host IS — vitest runs on Node, whose report carries the libc. */
function hostTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const musl = process.platform === "linux" && !report?.header?.glibcVersionRuntime;
  return `bun-${os}-${process.arch}${musl ? "-musl" : ""}`;
}

const target = hostTarget();
const binding = hyperSyncBindingForTarget(target);

describe.skipIf(!LIVE)("compiled binary — embedded HyperSync binding (live)", () => {
  it(
    binding
      ? `the ${target} binary embeds ${binding} and gets past the native loader`
      : `${target}: Envio publishes no binding — the binary must say so (nothing to embed)`,
    () => {
      const outdir = mkdtempSync(join(tmpdir(), "ch-binding-live-"));
      try {
        const build = spawnSync("bun", ["scripts/compile-binaries.mjs", "--native", "--targets", target, "--version", "v0.0.0-live", "--outdir", outdir], { cwd: ROOT, encoding: "utf8" });
        expect(build.status, build.stderr).toBe(0);
        const bin = join(outdir, assetForTarget(target)!);
        const env = { ...process.env, CORK_CONFIG_NO_FETCH: "1", CORK_NO_UPDATE_NOTIFIER: "1" };

        const version = JSON.parse(spawnSync(bin, ["version", "--json"], { encoding: "utf8", env }).stdout) as { hyperSyncBinding: string | null; target: string };
        expect(version.target).toBe(target);
        expect(version.hyperSyncBinding).toBe(binding);

        // A token that cannot be valid: with the binding loaded, the failure (if any) comes from
        // the network/auth layer, never from the loader; without one, the typed gap reason.
        const r = spawnSync(bin, ["query", "whitelisted-addresses", "--chain-id", "42161", "--mode", "full-decentralized", "--json"], {
          encoding: "utf8",
          env: { ...env, ENVIO_API_TOKEN: "live-smoke-not-a-real-token" },
          timeout: 180_000,
        });
        const text = `${r.stdout}\n${r.stderr}`;
        if (binding) {
          expect(text).not.toMatch(/could not load|carries no HyperSync binding/);
        } else {
          expect(text).toMatch(/carries no HyperSync binding/);
          expect(text).toContain(target);
        }
      } finally {
        rmSync(outdir, { recursive: true, force: true });
      }
    },
    420_000,
  );
});
