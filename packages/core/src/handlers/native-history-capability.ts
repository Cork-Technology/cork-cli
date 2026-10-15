import { z } from "zod";
import { apiComponent, supportedApiRevisions } from "../datasources/native-api-contract.mjs";
import { venueBaseUrl } from "../datasources/venue.ts";
import { fetchWithTimeout } from "../fetch-timeout.ts";
import type { HandlerContext } from "./shared.ts";

const Metadata = z.object({
  component: z.string(),
  version: z.string(),
  status: z.enum(["active", "paused", "retired"]),
  commit: z.string().nullable(),
});

export type NativeApiCapability =
  | { supported: true; revision: string }
  | { supported: false; code: "native_api_unavailable" | "request_aborted"; reason: string };

/** One read, no retry or shared cache. Callers may reuse its promise only in their own invocation. */
export async function readNativeApiCapability(ctx: HandlerContext): Promise<NativeApiCapability> {
  if (ctx.signal?.aborted) return { supported: false, code: "request_aborted", reason: "the request was cancelled before API capability admission" };
  try {
    const url = new URL(`${venueBaseUrl(ctx.venueUrl)}/meta/v1`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return { supported: false, code: "native_api_unavailable", reason: "the configured API URL cannot be admitted for metadata reads" };
    }
    let body: unknown;
    const response = await fetchWithTimeout(url.href, { method: "GET", redirect: "error", ...(ctx.signal ? { signal: ctx.signal } : {}) }, 10_000, async (input, init) => {
      const response = await (ctx.venueFetch ?? fetch)(input, init);
      // Keep the deadline and composed cancellation signal alive while the body is read.
      if (response.ok && !response.redirected) body = await response.json();
      return response;
    });
    if (ctx.signal?.aborted) return { supported: false, code: "request_aborted", reason: "the request was cancelled during API capability admission" };
    if (!response.ok || response.redirected) return { supported: false, code: "native_api_unavailable", reason: `API capability metadata did not answer directly with success (HTTP ${response.status})` };
    const parsed = Metadata.safeParse(body);
    if (!parsed.success) return { supported: false, code: "native_api_unavailable", reason: "API capability metadata is malformed" };
    const metadata = parsed.data;
    if (metadata.component !== apiComponent || metadata.status !== "active" || metadata.commit === null || !supportedApiRevisions.includes(metadata.commit)) {
      return { supported: false, code: "native_api_unavailable", reason: "the configured API does not declare an active reviewed native-history revision" };
    }
    return { supported: true, revision: metadata.commit };
  } catch {
    return ctx.signal?.aborted
      ? { supported: false, code: "request_aborted", reason: "the request was cancelled during API capability admission" }
      : { supported: false, code: "native_api_unavailable", reason: "the bounded API capability metadata read failed; native history completeness is unknown" };
  }
}
