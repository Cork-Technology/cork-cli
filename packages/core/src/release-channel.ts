// INTERNAL: one build identity and credential boundary for config and CLI updates.
import { createHash } from "node:crypto";
import { compareVersions } from "./version.ts";

export const SOURCE_REPO = "Cork-Technology/cork-cli";
export const PUBLIC_REPO = "Cork-Technology/cork-cli";
export const PRIVATE_REPO = `${PUBLIC_REPO}-private`;
export type ReleaseRepo = typeof PUBLIC_REPO | "Cork-Technology/cork-cli-private";
export function releaseRepo(value: string = process.env.CH_BUILD_REPO ?? SOURCE_REPO): ReleaseRepo {
  if (value !== PUBLIC_REPO && value !== PRIVATE_REPO) throw new Error("unsupported build repository identity");
  return value as ReleaseRepo;
}
export const BUILD_REPO = releaseRepo();
export const PRIVATE_CHANNEL = BUILD_REPO === PRIVATE_REPO;

/** Explicit opt-in only: never borrow the operator's unrelated gh login or ambient GH_TOKEN. */
export function githubToken(env: Record<string, string | undefined> = process.env): string {
  const token = env.CORK_GITHUB_TOKEN;
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new Error("private GitHub reads require an authorized CORK_GITHUB_TOKEN");
  return token;
}
export function channelCacheKey(repo: string, resource: string): string {
  return createHash("sha256").update(`${repo}\n${resource}`).digest("hex");
}
function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid GitHub resource URL"); }
  if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("unsafe GitHub resource URL");
  return url;
}
const ASSET_HOSTS: Record<string, true> = { "release-assets.githubusercontent.com": true, "objects.githubusercontent.com": true };

/** Credentials may reach only this repo's GitHub API. Metadata redirects are refused; asset
 * redirects can go only to GitHub's HTTPS asset hosts and permanently lose Authorization. */
export async function channelFetch(
  value: string,
  opts: { repo?: ReleaseRepo; env?: Record<string, string | undefined>; asset?: boolean; timeoutMs?: number; accept?: string; authenticated?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const repo = opts.repo ?? BUILD_REPO;
  const url = safeUrl(value);
  const privateRead = opts.authenticated ?? repo === PRIVATE_REPO;
  const apiScoped = url.origin === "https://api.github.com" && url.pathname.startsWith(`/repos/${repo}/`);
  if (privateRead && !apiScoped) throw new Error("private GitHub authentication refused outside the build repository API");
  let headers: Record<string, string> = { accept: opts.accept ?? "application/vnd.github+json", "user-agent": "cork-cli" };
  if (privateRead) headers.authorization = `Bearer ${githubToken(opts.env)}`;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8_000);
  let current = url;
  for (let hops = 0; ; hops++) {
    let response: Response;
    try { response = await fetchImpl(current.href, { headers, signal, redirect: "manual" }); }
    catch { throw new Error("GitHub resource request failed"); }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (!opts.asset || hops >= 3) throw new Error("GitHub resource redirect refused");
    const location = response.headers.get("location");
    if (!location) throw new Error("GitHub asset redirect has no location");
    let next: URL;
    try { next = safeUrl(new URL(location, current).href); } catch { throw new Error("unsafe GitHub asset redirect"); }
    if (next.protocol !== "https:" || !Object.hasOwn(ASSET_HOSTS, next.hostname) || next.port) throw new Error("GitHub asset redirect outside approved download hosts");
    if (headers.authorization) headers = { accept: headers.accept!, "user-agent": headers["user-agent"]! };
    current = next;
  }
}

/** A raw override gets credentials ONLY when it names this build's repo and defaults file.
 * Everything else stays unauthenticated. Private canonical raw reads use the contents API. */
export function configResource(value: string, repo: ReleaseRepo = BUILD_REPO): { url: string; authenticated: boolean } {
  const url = safeUrl(value);
  const ownApi = url.origin === "https://api.github.com" && url.pathname === `/repos/${repo}/contents/cork-defaults.v2.json`;
  if (url.search && (!ownApi || [...url.searchParams.keys()].some((key) => key !== "ref") || url.searchParams.getAll("ref").length !== 1)) throw new Error("defaults URL query refused; use a credential-free URL and CORK_GITHUB_TOKEN");
  const prefix = `/${repo}/`;
  if (repo === PRIVATE_REPO && url.origin === "https://raw.githubusercontent.com" && url.pathname.startsWith(prefix) && url.pathname.endsWith("/cork-defaults.v2.json") && !url.search) {
    const ref = url.pathname.slice(prefix.length, -"/cork-defaults.v2.json".length);
    if (!ref) throw new Error("invalid defaults ref");
    return { url: `https://api.github.com/repos/${repo}/contents/cork-defaults.v2.json?ref=${encodeURIComponent(ref)}`, authenticated: true };
  }
  if (repo === PRIVATE_REPO && url.origin === "https://api.github.com" && url.pathname === `/repos/${repo}/contents/cork-defaults.v2.json`) {
    return { url: url.href, authenticated: true };
  }
  return { url: url.href, authenticated: false };
}

/** Public means GitHub latest stable. Private is an RC-only channel; latest excludes RCs.
 * Exhaust the bounded feed before selecting by SemVer (publication order is not precedence). */
export async function latestReleaseTag(repo: ReleaseRepo = BUILD_REPO, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  let best: string | undefined;
  const deadline = Date.now() + 15_000;
  for (let page = 1; page <= 5; page++) {
    const privateFeed = repo === PRIVATE_REPO;
    const path = privateFeed ? `releases?per_page=100&page=${page}` : "releases/latest";
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("GitHub release lookup deadline exceeded");
    const response = await channelFetch(`https://api.github.com/repos/${repo}/${path}`, { repo, env, timeoutMs: remaining }, fetchImpl);
    if (!response.ok) throw new Error(`GitHub release lookup HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!privateFeed) {
      const tag = (body as { tag_name?: unknown } | null)?.tag_name;
      if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("invalid GitHub release tag");
      return tag;
    }
    if (!Array.isArray(body)) throw new Error("invalid GitHub prerelease feed");
    for (const row of body as { tag_name?: unknown; draft?: boolean; prerelease?: boolean }[]) {
      if (row && row.draft === false && row.prerelease === true && typeof row.tag_name === "string" && /^v\d+\.\d+\.\d+-rc\.\d+$/.test(row.tag_name) && (!best || compareVersions(row.tag_name, best) > 0)) best = row.tag_name;
    }
    if (body.length < 100) { if (best) return best; throw new Error("no published private RC is available"); }
  }
  throw new Error("private release lookup exceeded its bounded traversal; select --tag explicitly");
}
