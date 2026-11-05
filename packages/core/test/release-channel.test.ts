import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_REPO, releaseRepo, channelCacheKey, channelFetch, configResource } from "../src/release-channel.ts";
import { BUNDLED_DEFAULTS, CORK_DEFAULTS_URL, realConfigDeps, resetConfigMemo, resolveConfig } from "../src/config-remote.ts";

const TOKEN = "fixture-not-a-real-secret";
const API = `https://api.github.com/repos/${PUBLIC_REPO}`;
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetConfigMemo(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function cacheFile(): string { const d = mkdtempSync(join(tmpdir(), "channel-cache-")); dirs.push(d); return join(d, "config.json"); }
function responses(...values: Response[]): { fetch: typeof fetch; calls: { url: string; headers: Headers; redirect?: RequestInit["redirect"] }[] } {
  const calls: { url: string; headers: Headers; redirect?: RequestInit["redirect"] }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init?.headers), redirect: init?.redirect }); return values.shift() ?? new Response("unexpected", { status: 500 }); };
  return { fetch: fn as typeof fetch, calls };
}

describe("public release transport boundaries", () => {
  it("refuses unsupported build identities instead of changing the release source", () => {
    expect(releaseRepo(PUBLIC_REPO)).toBe(PUBLIC_REPO);
    expect(() => releaseRepo("other/foreign")).toThrow("unsupported");
  });
  it("never forwards ambient GitHub credentials to metadata or custom config", async () => {
    vi.stubEnv("GH_TOKEN", TOKEN); vi.stubEnv("GITHUB_TOKEN", TOKEN);
    const r = responses(new Response("{}"), new Response("{}"));
    await channelFetch(`${API}/releases/latest`, {}, r.fetch);
    await channelFetch(configResource("https://config.example/defaults.json"), {}, r.fetch);
    expect(r.calls.every((c) => !c.headers.has("authorization") && !c.url.includes(TOKEN) && c.redirect === "manual")).toBe(true);
  });
  it("follows an approved asset redirect without credentials", async () => {
    vi.stubEnv("GH_TOKEN", TOKEN);
    const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/123/file?signature=fixture";
    const r = responses(new Response(null, { status: 302, headers: { location: cdn } }), new Response("binary"));
    expect(await (await channelFetch(`https://github.com/${PUBLIC_REPO}/releases/download/v1.0.0/ch`, { asset: true, accept: "application/octet-stream" }, r.fetch)).text()).toBe("binary");
    expect(r.calls.map((c) => c.url)).toEqual([`https://github.com/${PUBLIC_REPO}/releases/download/v1.0.0/ch`, cdn]);
    expect(r.calls.every((c) => !c.headers.has("authorization"))).toBe(true);
  });
  it.each(["https://evil.example/file", "https://constructor/file", "https://__proto__/file", "http://release-assets.githubusercontent.com/file", "https://u:p@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file", `${API}/releases/assets/456`])("refuses unsafe asset redirect %s before its next request", async (location) => {
    const r = responses(new Response(null, { status: 302, headers: { location } }));
    await expect(channelFetch(`${API}/releases/assets/123`, { asset: true }, r.fetch)).rejects.toThrow(/redirect/);
    expect(r.calls).toHaveLength(1);
  });
  it("refuses metadata redirects even to another trusted GitHub host", async () => {
    const r = responses(new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file" } }));
    await expect(channelFetch(`${API}/releases/latest`, {}, r.fetch)).rejects.toThrow("redirect refused");
    expect(r.calls).toHaveLength(1);
  });
  it("bounds redirect chains and does not echo transport errors or signed URLs", async () => {
    const redirect = () => new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file?signature=fixture" } });
    const r = responses(redirect(), redirect(), redirect(), redirect(), new Response("too late"));
    await expect(channelFetch(`${API}/releases/assets/1`, { asset: true }, r.fetch)).rejects.toThrow("redirect refused");
    expect(r.calls).toHaveLength(4);
    const failing = (async () => { throw new Error(TOKEN); }) as typeof fetch;
    await expect(channelFetch(`${API}/releases/latest`, {}, failing)).rejects.toThrow(/^GitHub resource request failed$/);
  });
});

describe("config override and cache boundaries", () => {
  it("keeps public/custom defaults credential-free and rejects credential-bearing URLs", () => {
    const raw = `https://raw.githubusercontent.com/${PUBLIC_REPO}/config/0.8/cork-defaults.v2.json`;
    expect(configResource(raw)).toBe(raw);
    expect(configResource("https://config.example/cork-defaults.v2.json")).toBe("https://config.example/cork-defaults.v2.json");
    expect(configResource(`${API}/contents/cork-defaults.v2.json?ref=config%2F0.8`)).toBe(`${API}/contents/cork-defaults.v2.json?ref=config%2F0.8`);
    expect(() => configResource("https://user:secret@config.example/config.json")).toThrow("unsafe");
    for (const url of ["https://config.example/config.json?token=secret", `${API}/contents/cork-defaults.v2.json?ref=main&token=secret`, `${API}/contents/cork-defaults.v2.json?ref=main&ref=other`]) expect(() => configResource(url)).toThrow("query refused");
  });
  it("cannot import foreign-resource, foreign-repository or unscoped cache entries", () => {
    const file = cacheFile(); vi.stubEnv("CORK_CONFIG_CACHE_FILE", file); vi.stubEnv("CORK_DEFAULTS_URL", "https://config.example/main.json");
    const entry = { fetchedAt: Date.now(), defaults: BUNDLED_DEFAULTS };
    const foreignScope = createHash("sha256").update("other/repo\nhttps://config.example/main.json").digest("hex");
    for (const resource of [{ scope: foreignScope, entry }, { scope: channelCacheKey("https://config.example/other.json"), entry }, entry]) {
      writeFileSync(file, JSON.stringify(resource)); expect(realConfigDeps().loadCache()).toBeNull();
    }
    realConfigDeps().saveCache(entry); expect(realConfigDeps().loadCache()).toEqual(entry);
  });
  it.each([404, 410])("classifies public HTTP %s as absent and backs off without credentials", async (status) => {
    vi.stubEnv("CORK_CONFIG_NO_FETCH", ""); vi.stubEnv("CORK_CONFIG_NO_OVERRIDE", "1");
    vi.stubEnv("CORK_DEFAULTS_URL", CORK_DEFAULTS_URL); vi.stubEnv("CORK_CONFIG_CACHE_FILE", cacheFile());
    const r = responses(new Response("not published", { status })); vi.stubGlobal("fetch", r.fetch);
    const result = await resolveConfig();
    expect(result.source).toBe("bundled"); expect(result.warning).toBeUndefined();
    expect(realConfigDeps().loadCache()?.failure).toBe("absent");
    resetConfigMemo(); await resolveConfig(); expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.headers.has("authorization")).toBe(false);
  });
  it("changing the override resource invalidates in-process memo as well as disk scope", async () => {
    vi.stubEnv("CORK_CONFIG_NO_FETCH", ""); vi.stubEnv("CORK_CONFIG_NO_OVERRIDE", "1");
    const d = { now: () => Date.now(), loadCache: () => null, saveCache: () => {}, fetchRemote: vi.fn(async () => ({ kind: "ok" as const, data: BUNDLED_DEFAULTS })) };
    vi.stubEnv("CORK_DEFAULTS_URL", "https://config.example/a"); await resolveConfig(d);
    vi.stubEnv("CORK_DEFAULTS_URL", "https://config.example/b"); await resolveConfig(d);
    expect(d.fetchRemote).toHaveBeenCalledTimes(2);
  });
});
