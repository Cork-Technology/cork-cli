/** fetch with a hard timeout — the AbortController + setTimeout + clearTimeout dance, ONCE.
 *  Four modules used to hand-roll this block (chainlist probe, remote-config fetch, venue
 *  transport, rollover logs). Error WRAPPING stays at each call site on purpose: the consumers
 *  speak different failure dialects (venue breaker feed, redacted logs errors, silent []
 *  degrade), and this helper owns only the mechanics. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  // Structural minimum (not `typeof fetch`): the injectable call sites type their stubs as
  // (url, init) => Response, and the global fetch is assignable to this shape.
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  // A caller-provided signal COMPOSES with the deadline: a plain `{ ...init, signal }` spread
  // would have replaced it, so whichever aborts first wins. No current call site passes one —
  // this guards the future caller.
  const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } finally {
    clearTimeout(t);
  }
}

/** How a redirect may be followed. `follow-get` is the read policy (GET/HEAD only, the standard
 *  statuses); `preserve-write` is the relay policy: only 307/308, which keep method and body —
 *  301/302/303 would rewrite the request to a bodyless GET, so a caller-authored payload would
 *  either vanish or (on a permissive client) be replayed somewhere it was never addressed to. */
export type RedirectPolicy = "follow-get" | "preserve-write";

/** Redirects followed before giving up. Three is generous for one API host; a chain longer than
 *  that is a router doing something the caller did not ask for. */
const MAX_REDIRECTS = 3;

/** Parse a URL and hold it to the rules an authority-bound HTTP call needs: http(s) only, no
 *  userinfo (credentials in a URL are both a leak and an auth-confusion vector), and — when
 *  `expectedOrigin` is given — the same origin as the request the caller made. */
function checkedUrl(raw: string | URL, expectedOrigin?: string, base?: URL): URL {
  let parsed: URL;
  try {
    parsed = raw instanceof URL ? new URL(raw.href) : new URL(raw, base);
  } catch {
    throw new Error("redirect policy: the target is not a parseable URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`redirect policy: refusing the ${parsed.protocol} scheme — only http(s) is followed`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("redirect policy: refusing a URL carrying credentials in its userinfo");
  }
  if (expectedOrigin !== undefined && parsed.origin !== expectedOrigin) {
    throw new Error(`redirect policy: refusing a cross-origin hop to ${parsed.origin} — the request was addressed to ${expectedOrigin}`);
  }
  return parsed;
}

/**
 * Fetch that follows redirects MANUALLY, validating each hop before it can receive a request.
 *
 * The default `fetch` follows redirects itself, which means the FIRST the caller hears of a hop
 * is after the body has already been delivered to wherever the redirect pointed (audit
 * MCP-NET-004). For a venue relay that body is a signed order. So: `redirect: "manual"`, every
 * Location checked against the ORIGINAL origin before it is requested, and a body-bearing method
 * followed only across 307/308 (the statuses that preserve method and body).
 *
 * The timeout wraps the WHOLE chain — redirects cannot be used to extend the caller's budget.
 */
export async function fetchFollowingSameOrigin(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  policy: RedirectPolicy,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const original = checkedUrl(url);
  const origin = original.origin;
  const method = (init.method ?? "GET").toUpperCase();
  if (policy === "follow-get" && method !== "GET" && method !== "HEAD") {
    throw new Error(`redirect policy: 'follow-get' is for GET/HEAD, not ${method}`);
  }
  return fetchWithTimeout(original.href, init, timeoutMs, async (_first, timedInit) => {
    let current = original;
    let hops = 0;
    // Headers are rebuilt per hop from the caller's own set, and only AFTER the hop passed the
    // origin check — so nothing the caller sent reaches an address it did not address.
    const headers = new Headers(timedInit?.headers);
    for (;;) {
      const res = await fetchImpl(current.href, { ...(timedInit ?? {}), headers: new Headers(headers), redirect: "manual" });
      // A native Response carries the URL it ended at; an injected test transport may not. When
      // it is present it must still be on the original origin.
      if (res.url !== "") checkedUrl(res.url, origin);
      const redirected = res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308;
      if (!redirected) return res;
      if (policy === "preserve-write" && res.status !== 307 && res.status !== 308) {
        throw new Error(`redirect policy: refusing HTTP ${res.status} for a ${method} — only 307/308 preserve the method and body, and this request carries a caller-authored payload`);
      }
      const location = res.headers.get("location");
      if (location === null) return res; // a redirect status with nowhere to go is the answer
      if (hops >= MAX_REDIRECTS) throw new Error(`redirect policy: refusing to follow more than ${MAX_REDIRECTS} redirects`);
      current = checkedUrl(location, origin, current); // validated BEFORE it becomes the target
      hops++;
    }
  });
}
