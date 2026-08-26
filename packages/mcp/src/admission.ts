// Application-level admission for the Streamable HTTP endpoint (audit MCP-NET-003, 2026-08-24).
//
// The deployed endpoint is PUBLIC and deliberately open (the workshop hands its URL to a room of
// people). "The ingress owns limits" was true for bandwidth and connection counts, and false for
// everything that only the application can see: a 40 MB JSON body, a 10,000-deep nesting, a
// 5,000-message batch, or a tool call that waits on a slow upstream forever. Each of those is
// cheap to send and expensive to serve, and none of them is visible to a proxy counting requests.
//
// So: bound the body, the depth, the batch, the concurrency and the wall-clock, and parse ONCE
// (the SDK transport would otherwise re-read the stream, which is both a second parse of
// untrusted input and a second chance to blow the same budget).
//
// Concurrency is keyed per PRINCIPAL, and a principal must be something an attacker cannot mint
// for free. Behind an ingress that is the forwarded client IP; on a loopback bind it is the peer
// address. One shared bucket would let a single caller starve a room full of workshop attendees,
// which is the failure this limit exists to prevent.

/** The bounds. Deliberately generous for real use and hostile to abuse: the largest legitimate
 *  request this server sees is a bundle decode of a few hundred KiB. */
export const MCP_HTTP_LIMITS = {
  /** Largest request body, in bytes. */
  bodyBytes: 1_048_576,
  /** Deepest JSON nesting. The tool schemas are a handful of levels; 32 is far past them. */
  jsonDepth: 32,
  /** Most JSON-RPC messages in one batch. */
  batchMessages: 50,
  /** Concurrent in-flight requests per principal … */
  principalRequests: 8,
  /** … and across the whole server, so many principals cannot exhaust it either. */
  globalRequests: 64,
  /** Wall-clock budget for one request, after which its work is cancelled. */
  deadlineMs: 30_000,
} as const;

/** Injectable timer so tests do not sleep. Returns its own canceller. */
export type DeadlineScheduler = (onDeadline: () => void, delayMs: number) => () => void;

const wallClockDeadline: DeadlineScheduler = (onDeadline, delayMs) => {
  const timer = setTimeout(onDeadline, delayMs);
  // Never hold the process open for a deadline that will not fire.
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

export interface AdmissionPermit {
  /** Aborts when the request's deadline elapses; handed to the tool context as `signal`. */
  readonly signal: AbortSignal;
  release(): void;
}

/** JSON-RPC shaped refusal — a client that spoke JSON-RPC deserves a JSON-RPC answer. */
function refusal(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Depth-first, iterative-friendly recursion with an explicit cap: the check itself must not be
 *  the thing that blows the stack on hostile input. */
function exceedsDepth(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth + 1 > MCP_HTTP_LIMITS.jsonDepth) return true;
  if (Array.isArray(value)) {
    for (const child of value) if (exceedsDepth(child, depth + 1)) return true;
    return false;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (exceedsDepth(child, depth + 1)) return true;
  }
  return false;
}

/**
 * One controller per server. It owns the counters, so limits are shared across requests exactly
 * as the deployment shares its process.
 */
export class AdmissionController {
  private activeGlobal = 0;
  private readonly activeByPrincipal = new Map<string, number>();

  constructor(
    private readonly deadlineMs: number = MCP_HTTP_LIMITS.deadlineMs,
    private readonly schedule: DeadlineScheduler = wallClockDeadline,
  ) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("admission: deadlineMs must be a positive number of milliseconds");
  }

  /** Snapshot for diagnostics (/readyz): how loaded the server is right now. */
  inFlight(): { global: number; principals: number } {
    return { global: this.activeGlobal, principals: this.activeByPrincipal.size };
  }

  private tryAcquire(principal: string): AdmissionPermit | null {
    const forPrincipal = this.activeByPrincipal.get(principal) ?? 0;
    if (this.activeGlobal >= MCP_HTTP_LIMITS.globalRequests || forPrincipal >= MCP_HTTP_LIMITS.principalRequests) return null;
    this.activeGlobal++;
    this.activeByPrincipal.set(principal, forPrincipal + 1);
    const controller = new AbortController();
    const cancelDeadline = this.schedule(() => controller.abort(new DOMException("MCP request deadline exceeded", "TimeoutError")), this.deadlineMs);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return; // release() is called from a finally; double-release must not underflow
        released = true;
        cancelDeadline();
        this.activeGlobal--;
        const left = (this.activeByPrincipal.get(principal) ?? 1) - 1;
        if (left === 0) this.activeByPrincipal.delete(principal); // never grow a map keyed by caller-influenced values
        else this.activeByPrincipal.set(principal, left);
      },
    };
  }

  /**
   * Admit one request: take a slot, enforce the byte/shape bounds, parse ONCE, and hand the
   * parsed body plus a deadline signal to `dispatch`. The slot is always released.
   */
  async handle(req: Request, principal: string, dispatch: (parsedBody: unknown, signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const permit = this.tryAcquire(principal);
    if (!permit) return refusal(429, -32000, "server busy: too many requests in flight — retry in a moment", { "retry-after": "1" });
    try {
      // A declared length lets us refuse before reading; a lying or absent one is caught after.
      const declared = req.headers.get("content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MCP_HTTP_LIMITS.bodyBytes) {
        return refusal(413, -32000, `request body exceeds ${MCP_HTTP_LIMITS.bodyBytes} bytes`);
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength > MCP_HTTP_LIMITS.bodyBytes) return refusal(413, -32000, `request body exceeds ${MCP_HTTP_LIMITS.bodyBytes} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        return refusal(400, -32700, "Parse error: invalid JSON");
      }
      if (exceedsDepth(parsed, 0)) return refusal(400, -32600, `request JSON nests deeper than ${MCP_HTTP_LIMITS.jsonDepth}`);
      if (Array.isArray(parsed) && parsed.length > MCP_HTTP_LIMITS.batchMessages) {
        return refusal(400, -32600, `request batch exceeds ${MCP_HTTP_LIMITS.batchMessages} messages`);
      }
      return await dispatch(parsed, permit.signal);
    } finally {
      permit.release();
    }
  }
}

/**
 * The principal a request is counted against.
 *
 * `X-Forwarded-For` is trusted ONLY when the deployment says an ingress is in front of it
 * (`trustForwardedFor`): the header is caller-supplied, so trusting it unconditionally would let
 * anyone mint a fresh principal per request and walk straight past the per-principal limit. The
 * LAST entry is used — a proxy appends the peer it saw, so earlier entries are attacker-authored.
 * With no ingress, the peer address is the principal; when even that is unavailable every caller
 * shares one bucket, which is the safe direction to fail.
 */
export function principalOf(req: Request, opts: { trustForwardedFor: boolean; peerAddress?: string | undefined }): string {
  if (opts.trustForwardedFor) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const hops = forwarded.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
      const nearest = hops[hops.length - 1];
      if (nearest !== undefined) return `ip:${nearest}`;
    }
  }
  return opts.peerAddress !== undefined ? `ip:${opts.peerAddress}` : "shared";
}
