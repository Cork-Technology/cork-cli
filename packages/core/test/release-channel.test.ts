import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_REPO, PUBLIC_REPO, PRIVATE_REPO, channelCacheKey, channelFetch, configResource, githubToken } from "../src/release-channel.ts";
import { BUNDLED_DEFAULTS, CORK_DEFAULTS_URL, realConfigDeps, resetConfigMemo, resolveConfig } from "../src/config-remote.ts";

const TOKEN = "fixture-not-a-real-secret";
const API = `https://api.github.com/repos/${PRIVATE_REPO}`;
const env = { CORK_GITHUB_TOKEN: TOKEN };
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetConfigMemo(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function cacheFile(): string { const d = mkdtempSync(join(tmpdir(), "channel-cache-")); dirs.push(d); return join(d, "config.json"); }
function responses(...values: Response[]): { fetch: typeof fetch; calls: { url: string; headers: Headers; redirect?: RequestInit["redirect"] }[] } {
  const calls: { url: string; headers: Headers; redirect?: RequestInit["redirect"] }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init?.headers), redirect: init?.redirect }); return values.shift() ?? new Response("unexpected", { status: 500 }); };
  return { fetch: fn as typeof fetch, calls };
}

describe("release channel credentials", () => {
  it("does not borrow ambient gh credentials, and sends no request without explicit private opt-in", async () => {
    expect(() => githubToken({ GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN })).toThrow("CORK_GITHUB_TOKEN");
    const r = responses(new Response("{}"));
    await expect(channelFetch(`${API}/releases/latest`, { repo: PRIVATE_REPO, env: {} }, r.fetch)).rejects.toThrow("CORK_GITHUB_TOKEN");
    expect(r.calls).toHaveLength(0);
  });
  it("authenticates only this private repo API; public requests remain unauthenticated", async () => {
    const r = responses(new Response("{}"), new Response("{}"));
    await channelFetch(`${API}/releases/latest`, { repo: PRIVATE_REPO, env }, r.fetch);
    await channelFetch(`https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`, { repo: PUBLIC_REPO, env }, r.fetch);
    expect(r.calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(r.calls[1]!.headers.has("authorization")).toBe(false);
    expect(r.calls.every((c) => !c.url.includes(TOKEN) && c.redirect === "manual")).toBe(true);
    await expect(channelFetch(`https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`, { repo: PRIVATE_REPO, env }, r.fetch)).rejects.toThrow("outside");
    expect(r.calls).toHaveLength(2);
  });
  it("strips Authorization at a proper private asset redirect", async () => {
    const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/123/file?signature=fixture";
    const r = responses(new Response(null, { status: 302, headers: { location: cdn } }), new Response("binary"));
    expect(await (await channelFetch(`${API}/releases/assets/123`, { repo: PRIVATE_REPO, env, asset: true, accept: "application/octet-stream" }, r.fetch)).text()).toBe("binary");
    expect(r.calls.map((c) => c.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`, null]);
    expect(r.calls[0]!.headers.get("accept")).toBe("application/octet-stream");
  });
  it.each(["https://evil.example/file", "https://constructor/file", "https://__proto__/file", "http://release-assets.githubusercontent.com/file", "https://u:p@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file", `${API}/releases/assets/456`])("refuses unsafe asset redirect %s without making its next request", async (location) => {
    const r = responses(new Response(null, { status: 302, headers: { location } }));
    await expect(channelFetch(`${API}/releases/assets/123`, { repo: PRIVATE_REPO, env, asset: true }, r.fetch)).rejects.toThrow(/redirect/);
    expect(r.calls).toHaveLength(1);
  });
  it("refuses metadata redirects even to another trusted GitHub host", async () => {
    const r = responses(new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file" } }));
    await expect(channelFetch(`${API}/releases/latest`, { repo: PRIVATE_REPO, env }, r.fetch)).rejects.toThrow("redirect refused");
    expect(r.calls).toHaveLength(1);
  });
  it("bounds redirect chains and does not echo transport errors or signed download URLs", async () => {
    const redirect = () => new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file" } });
    const r = responses(redirect(), redirect(), redirect(), redirect(), new Response("too late"));
    await expect(channelFetch(`${API}/releases/assets/1`, { repo: PRIVATE_REPO, env, asset: true }, r.fetch)).rejects.toThrow("redirect refused");
    expect(r.calls).toHaveLength(4);
    const failing = (async () => { throw new Error(TOKEN); }) as typeof fetch;
    await expect(channelFetch(`${API}/releases/latest`, { repo: PRIVATE_REPO, env }, failing)).rejects.toThrow(/^GitHub resource request failed$/);
  });
});

describe("config override and cache boundaries", () => {
  it("maps only this private defaults resource to the authenticated contents API", () => {
    expect(configResource(`https://raw.githubusercontent.com/${PRIVATE_REPO}/config/0.7/cork-defaults.v2.json`, PRIVATE_REPO)).toEqual({ url: `${API}/contents/cork-defaults.v2.json?ref=config%2F0.7`, authenticated: true });
    expect(configResource(`https://raw.githubusercontent.com/${PUBLIC_REPO}/main/cork-defaults.v2.json`, PRIVATE_REPO).authenticated).toBe(false);
    expect(configResource("https://config.example/cork-defaults.v2.json", PRIVATE_REPO).authenticated).toBe(false);
    expect(() => configResource("https://user:secret@config.example/config.json", PRIVATE_REPO)).toThrow("unsafe");
    expect(() => configResource("https://config.example/config.json?token=secret", PRIVATE_REPO)).toThrow("query refused");
    expect(() => configResource(`${API}/contents/cork-defaults.v2.json?ref=main&token=secret`, PRIVATE_REPO)).toThrow("query refused");
  });
  it("explicit cache-file override cannot import another channel, ref or a legacy unscoped cache", () => {
    const file = cacheFile(); vi.stubEnv("CORK_CONFIG_CACHE_FILE", file); vi.stubEnv("CORK_DEFAULTS_URL", "https://config.example/main.json");
    const entry = { fetchedAt: Date.now(), defaults: BUNDLED_DEFAULTS };
    const otherRepo = BUILD_REPO === PRIVATE_REPO ? PUBLIC_REPO : PRIVATE_REPO;
    for (const resource of [{ scope: channelCacheKey(otherRepo, "https://config.example/main.json"), entry }, { scope: channelCacheKey(BUILD_REPO, "https://config.example/other.json"), entry }, entry]) {
      writeFileSync(file, JSON.stringify(resource)); expect(realConfigDeps().loadCache()).toBeNull();
    }
    realConfigDeps().saveCache(entry); expect(realConfigDeps().loadCache()).toEqual(entry);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });
  it("an unauthorized private 404 warns and negative-caches failure, never silently claims current remote", async () => {
    if (BUILD_REPO !== PRIVATE_REPO) return;
    vi.stubEnv("CORK_CONFIG_NO_FETCH", ""); vi.stubEnv("CORK_CONFIG_NO_OVERRIDE", "1"); vi.stubEnv("CORK_GITHUB_TOKEN", TOKEN);
    vi.stubEnv("CORK_DEFAULTS_URL", CORK_DEFAULTS_URL); vi.stubEnv("CORK_CONFIG_CACHE_FILE", cacheFile());
    const r = responses(new Response("not found", { status: 404 })); vi.stubGlobal("fetch", r.fetch);
    const result = await resolveConfig();
    expect(result.source).toBe("bundled"); expect(result.warning?.code).toBe("config_fetch_failed");
    expect(realConfigDeps().loadCache()?.failure).toBe("error"); expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(r.calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
  it("changing the override resource invalidates the in-process memo as well as disk scope", async () => {
    vi.stubEnv("CORK_CONFIG_NO_FETCH", ""); vi.stubEnv("CORK_CONFIG_NO_OVERRIDE", "1");
    const d = { now: () => Date.now(), loadCache: () => null, saveCache: () => {}, fetchRemote: vi.fn(async () => ({ kind: "ok" as const, data: BUNDLED_DEFAULTS })) };
    vi.stubEnv("CORK_DEFAULTS_URL", "https://config.example/a"); await resolveConfig(d);
    vi.stubEnv("CORK_DEFAULTS_URL", "https://config.example/b"); await resolveConfig(d);
    expect(d.fetchRemote).toHaveBeenCalledTimes(2);
  });
});
