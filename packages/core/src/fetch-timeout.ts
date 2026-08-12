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
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
