// INTERNAL: one public build identity and unauthenticated config/update transport.
import { createHash } from "node:crypto";

export const PUBLIC_REPO = "Cork-Technology/cork-cli";
export function releaseRepo(value: string = process.env.CH_BUILD_REPO ?? PUBLIC_REPO): typeof PUBLIC_REPO {
  if (value !== PUBLIC_REPO) throw new Error("unsupported build repository identity");
  return PUBLIC_REPO;
}
export const BUILD_REPO = releaseRepo();

export function channelCacheKey(resource: string): string {
  return createHash("sha256").update(`${PUBLIC_REPO}\n${resource}`).digest("hex");
}
function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid GitHub resource URL"); }
  if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("unsafe GitHub resource URL");
  return url;
}
const ASSET_HOSTS: Record<string, true> = { "release-assets.githubusercontent.com": true, "objects.githubusercontent.com": true };

/** Metadata redirects are refused; assets may redirect only to GitHub's HTTPS asset hosts.
 * Requests never forward ambient credentials, including on redirected downloads. */
export async function channelFetch(
  value: string,
  opts: { asset?: boolean; timeoutMs?: number; accept?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers: Record<string, string> = { accept: opts.accept ?? "application/vnd.github+json", "user-agent": "cork-cli" };
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8_000);
  let current = safeUrl(value);
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
    current = next;
  }
}

/** Custom config remains credential-free; only the canonical contents API permits a ref query. */
export function configResource(value: string): string {
  const url = safeUrl(value);
  const ownApi = url.origin === "https://api.github.com" && url.pathname === `/repos/${PUBLIC_REPO}/contents/cork-defaults.v2.json`;
  if (url.search && (!ownApi || [...url.searchParams.keys()].some((key) => key !== "ref") || url.searchParams.getAll("ref").length !== 1)) throw new Error("defaults URL query refused; use a credential-free URL");
  return url.href;
}

/** GitHub's latest public release; explicit tags remain available to opt into a candidate. */
export async function latestReleaseTag(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await channelFetch(`https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`, { timeoutMs: 15_000 }, fetchImpl);
  if (!response.ok) throw new Error(`GitHub release lookup HTTP ${response.status}`);
  const body: unknown = await response.json();
  const tag = (body as { tag_name?: unknown } | null)?.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("invalid GitHub release tag");
  return tag;
}
