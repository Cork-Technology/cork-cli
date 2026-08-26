// Unit coverage for the single-binary release machinery: version compare, asset naming
// (locked between the TS self-update module and the .mjs compile script), checksum parsing,
// the update-notifier decision gates, and the new non-tool CLI commands.
import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "@cork/cli";
import { compareVersions } from "@cork/core";
import { assetForTarget, parseChecksums } from "../src/self-update.ts";
import { updateDecision, type UpdateCache } from "../src/update-notify.ts";
// The compile script must name assets exactly as self-update expects to find them.
import { assetForTarget as scriptAssetForTarget, compileDefines, hyperSyncBindingForTarget } from "../../../scripts/compile-binaries.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("compareVersions", () => {
  it("orders releases numerically, not lexically", () => {
    expect(compareVersions("v1.10.0", "v1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.0.2", "v0.0.10")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });
  it("sorts a pre-release below its release", () => {
    expect(compareVersions("v1.2.3-rc.1", "v1.2.3")).toBeLessThan(0);
    expect(compareVersions("v1.2.3", "v1.2.3-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3-rc.1", "v1.2.3-rc.2")).toBeLessThan(0);
  });
  it("orders prerelease identifiers by SemVer §11: NUMERIC ones numerically (rc.10 > rc.9)", () => {
    // A plain string compare puts "rc.10" below "rc.9", so self-update would have offered rc.9
    // as an "update" over rc.10 — and refused rc.10 as a downgrade.
    expect(compareVersions("v1.2.3-rc.10", "v1.2.3-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3-rc.2", "v1.2.3-rc.10")).toBeLessThan(0);
    // numeric sorts below non-numeric; a shorter identifier list sorts below a longer one
    expect(compareVersions("v1.2.3-1", "v1.2.3-alpha")).toBeLessThan(0);
    expect(compareVersions("v1.2.3-rc", "v1.2.3-rc.1")).toBeLessThan(0);
    expect(compareVersions("v1.2.3-alpha.1", "v1.2.3-beta.1")).toBeLessThan(0);
    // leading zeros and absurd lengths still compare by value, not by text
    expect(compareVersions("v1.2.3-rc.007", "v1.2.3-rc.7")).toBe(0);
    expect(compareVersions(`v1.2.3-rc.${"9".repeat(40)}`, "v1.2.3-rc.8")).toBeGreaterThan(0);
  });
});

describe("release asset naming", () => {
  const targets = [
    ["bun-linux-x64", "ch-linux-x64"],
    ["bun-linux-arm64", "ch-linux-arm64"],
    ["bun-linux-x64-musl", "ch-linux-x64-musl"],
    ["bun-linux-arm64-musl", "ch-linux-arm64-musl"],
    ["bun-darwin-arm64", "ch-darwin-arm64"],
    ["bun-darwin-x64", "ch-darwin-x64"],
    ["bun-windows-x64", "ch-windows-x64.exe"],
  ] as const;
  it("maps every release target to its fixed asset name", () => {
    for (const [target, asset] of targets) expect(assetForTarget(target)).toBe(asset);
  });
  it("the compile script and self-update agree on every name", () => {
    for (const [target] of targets) expect(scriptAssetForTarget(target)).toBe(assetForTarget(target));
  });
  it("rejects unknown shapes", () => {
    expect(assetForTarget("")).toBeNull();
    expect(assetForTarget("linux-x64")).toBeNull();
    expect(assetForTarget("bun-freebsd-x64")).toBeNull();
  });
});

describe("embedded HyperSync binding per release target", () => {
  // What Envio publishes (npm, 1.4.0): five bindings. linux-arm64-musl and windows get none,
  // and the binary must say so rather than carry a binding that cannot load.
  const spec = (slug: string) => `@envio-dev/hypersync-client-${slug}/hypersync-client.${slug}.node`;
  const expected: Array<[string, string | null]> = [
    ["bun-linux-x64", spec("linux-x64-gnu")],
    ["bun-linux-arm64", spec("linux-arm64-gnu")],
    ["bun-linux-x64-musl", spec("linux-x64-musl")],
    ["bun-linux-arm64-musl", null],
    ["bun-darwin-arm64", spec("darwin-arm64")],
    ["bun-darwin-x64", spec("darwin-x64")],
    ["bun-windows-x64", null],
  ];
  it("maps every release target to the binding Envio publishes — null where it publishes none", () => {
    for (const [target, binding] of expected) expect(hyperSyncBindingForTarget(target), target).toBe(binding);
  });
  it("rejects unknown shapes", () => {
    expect(hyperSyncBindingForTarget("")).toBeNull();
    expect(hyperSyncBindingForTarget("linux-x64")).toBeNull();
    expect(hyperSyncBindingForTarget("bun-freebsd-x64")).toBeNull();
    expect(hyperSyncBindingForTarget("bun-linux-x64-baseline")).toBeNull();
  });
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const core = JSON.parse(readFileSync(`${root}/packages/core/package.json`, "utf8")) as { optionalDependencies: Record<string, string> };
  const clientPin = core.optionalDependencies["@envio-dev/hypersync-client"];

  it("every binding names a package @cork/core declares as an optionalDependency, at the client's own pin", () => {
    // The bundler resolves the specifier from @cork/core — the package that imports the client
    // and requires the binding (isolated linker: nothing is hoisted) — so a binding the manifest
    // does not declare cannot be embedded. Bind mapping to manifest, all six at ONE pin.
    expect(clientPin).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [, binding] of expected) {
      if (!binding) continue;
      const pkg = binding.split("/").slice(0, 2).join("/");
      expect(core.optionalDependencies[pkg], pkg).toBe(clientPin);
    }
  });
  it("the map agrees with the platform set the pinned client itself declares (an Envio change on upgrade is loud)", () => {
    // The client's package.json optionalDependencies IS Envio's published platform set for that
    // version (napi-rs writes it). Every declared package that corresponds to a release target
    // must be mapped, and nothing may be mapped that the client does not declare — so if Envio
    // re-adds Windows or adds linux-arm64-musl, or drops a platform, the pin bump fails here.
    const client = JSON.parse(readFileSync(`${root}/packages/core/node_modules/@envio-dev/hypersync-client/package.json`, "utf8")) as { version: string; optionalDependencies: Record<string, string> };
    expect(client.version).toBe(clientPin);
    const declared = new Set(Object.keys(client.optionalDependencies));
    const mapped = new Set(expected.flatMap(([, b]) => (b ? [b.split("/").slice(0, 2).join("/")] : [])));
    expect([...mapped].sort()).toEqual([...declared].sort());
  });
  it("compileDefines stamps identity plus the binding — the literal `undefined` where there is none", () => {
    const withBinding = compileDefines({ version: "v1.2.3", commit: "abc", target: "bun-linux-x64" });
    expect(withBinding.filter((a) => a === "--define")).toHaveLength(4);
    expect(withBinding).toContain('process.env.CH_BUILD_VERSION="v1.2.3"');
    expect(withBinding).toContain('process.env.CH_BUILD_COMMIT="abc"');
    expect(withBinding).toContain('process.env.CH_BUILD_TARGET="bun-linux-x64"');
    expect(withBinding).toContain(`process.env.CH_HYPERSYNC_BINDING="${spec("linux-x64-gnu")}"`);
    const without = compileDefines({ version: "v1.2.3", commit: "abc", target: "bun-windows-x64" });
    expect(without).toContain("process.env.CH_HYPERSYNC_BINDING=undefined");
  });
});

describe("parseChecksums", () => {
  it("parses sha256sum format, tolerating the binary-mode asterisk", () => {
    const sha = "a".repeat(64);
    const map = parseChecksums(`${sha}  ch-linux-x64\n${"b".repeat(64)} *ch-windows-x64.exe\n\nnot a line\n`);
    expect(map.get("ch-linux-x64")).toBe(sha);
    expect(map.get("ch-windows-x64.exe")).toBe("b".repeat(64));
    expect(map.size).toBe(2);
  });
});

describe("updateDecision", () => {
  const base = {
    currentVersion: "v1.0.0",
    argv: ["query", "cork-pools"] as string[],
    env: {} as Record<string, string | undefined>,
    stderrIsTTY: true,
    cache: null as UpdateCache | null,
    nowMs: Date.parse("2026-07-31T12:00:00Z"),
  };
  const fresh = (over: Partial<typeof base>) => updateDecision({ ...base, ...over });

  it("asks for a refresh when there is no cache, without a notice", () => {
    const d = fresh({});
    expect(d.refresh).toBe(true);
    expect(d.notice).toBeNull();
  });
  it("notices a newer cached release, once per interval", () => {
    const cache: UpdateCache = { checkedAt: "2026-07-31T11:00:00Z", latest: "v1.1.0" };
    const d = fresh({ cache });
    expect(d.notice).toContain("v1.1.0");
    expect(d.refresh).toBe(false);
    expect(d.cacheUpdate?.notifiedAt).toBeTruthy();
    const again = fresh({ cache: { ...cache, notifiedAt: "2026-07-31T11:30:00Z" } });
    expect(again.notice).toBeNull();
  });
  it("stays silent when up to date or ahead", () => {
    expect(fresh({ cache: { checkedAt: "2026-07-31T11:00:00Z", latest: "v1.0.0" } }).notice).toBeNull();
    expect(fresh({ cache: { checkedAt: "2026-07-31T11:00:00Z", latest: "v0.9.0" } }).notice).toBeNull();
  });
  it("is fully suppressed for non-TTY, dev builds, CI, JSON output, opt-out, and protocol/updater modes", () => {
    const cache: UpdateCache = { latest: "v9.9.9" }; // would otherwise notice AND refresh
    for (const over of [
      { stderrIsTTY: false },
      { currentVersion: "dev" },
      { env: { CI: "1" } },
      { env: { CORK_NO_UPDATE_NOTIFIER: "1" } },
      { env: { CORK_JSON: "1" } },
      { argv: ["query", "cork-pools", "--json"] },
      { argv: ["mcp"] },
      { argv: ["self-update"] },
      { argv: ["__update-check"] },
    ] as Partial<typeof base>[]) {
      const d = fresh({ cache, ...over });
      expect(d.notice).toBeNull();
      expect(d.refresh).toBe(false);
    }
  });
});

describe("non-tool CLI commands", () => {
  it("version --json reports build identity with dev fallbacks", async () => {
    const r = await runCli(["version", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    const info = JSON.parse(r.stdout);
    expect(info.version).toBe("dev");
    expect(info.schemaVersion).toBeTruthy();
    expect(info.target).toBeNull();
  });
  it("--version prints the version", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout.trim()).toBe("dev");
  });
  it("mcp via runCli explains that the server needs the real entrypoint", async () => {
    const r = await runCli(["mcp"]);
    expect(r.code).toBe(EXIT.error);
    expect(r.stderr).toContain("ch mcp");
  });
  it("self-update refuses to run from source", async () => {
    const r = await runCli(["self-update"]);
    expect(r.code).toBe(EXIT.error);
    expect(r.stderr).toContain("source run");
  });
});
