// fetchWithTimeout is the ONE implementation of the abort-on-timeout dance four modules used to
// hand-roll (chainlist probe, remote-config fetch, venue transport, rollover logs). These tests
// pin the mechanics the consumers rely on; the timeout-fires case is the mutation-probe anchor
// (a probe no-ops the abort callback — this suite must go red).
import { describe, expect, it } from "vitest";
import { fetchWithTimeout } from "../src/fetch-timeout.ts";

/** A fetch stub that resolves/rejects by honoring the AbortSignal like a real transport. */
function abortAwareFetch(resolveAfterMs: number): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise((resolve, reject) => {
      const signal = init?.signal;
      const t = setTimeout(() => resolve(new Response("ok")), resolveAfterMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
}

describe("fetchWithTimeout", () => {
  it("resolves when the transport answers before the deadline (and passes init through)", async () => {
    let seenInit: RequestInit | undefined;
    const res = await fetchWithTimeout(
      "https://stub.test/x",
      { method: "POST", headers: { "content-type": "application/json" } },
      1_000,
      (_url, init) => {
        seenInit = init;
        return Promise.resolve(new Response("ok"));
      },
    );
    expect(await res.text()).toBe("ok");
    expect(seenInit?.method).toBe("POST");
    // The helper must ATTACH its abort signal — that is the whole point.
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the transport when the deadline elapses first", async () => {
    await expect(fetchWithTimeout("https://stub.test/slow", {}, 10, abortAwareFetch(5_000))).rejects.toThrow(/abort/i);
  });

  it("a transport that answers in time is NOT aborted afterwards (timer cleared)", async () => {
    let aborted = false;
    const res = await fetchWithTimeout("https://stub.test/fast", {}, 30, (_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return Promise.resolve(new Response("ok"));
    });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 60)); // past the deadline — the cleared timer must not fire
    expect(aborted).toBe(false);
  });
});
