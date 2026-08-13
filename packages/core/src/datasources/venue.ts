// Centralized-mode datasource: the as-built Cork venue at api-phoenix.cork.tech
// (cork-knowledge: rollover-venue-interface.md + agent-rfq-venue-interface.md, both live).
// Read endpoints are keyless; the fetch implementation is injectable so the entire surface is
// testable offline. Responses are UNTRUSTED input: shapes are zod-validated before use (lenient —
// key fields typed, extra fields passed through, because the venue's own zod schemas are the
// authoritative contract and it may add fields).
//
// Routing follows cork-api 0.3.3 (2026-08-12): versions belong to the MODULE, not the base —
// the canonical form is /<module>/v<n> (/limit-orders/v1/orderbook, /rollover/v1/orders). The
// base URL is therefore the bare origin, and every path literal below carries its module's own
// version. The old base-versioned form (/v1/<module>) survives on a temporary server-side
// rewrite that answers with `Deprecation: true` + `x-cork-canonical-path`; those headers are
// captured per call and surfaced as telemetry so a stale literal (or a stale user override)
// announces itself instead of riding the shim silently until the shim retires.
import { z } from "zod";
import { fetchWithTimeout } from "../fetch-timeout.ts";
import { breakerOnFailure, breakerOnSuccess, breakerOpen, breakerRemainingMs, type BreakerEntry, type BreakerPolicy } from "../breaker.ts";
import { hostOf } from "../chain/rpc.ts";
import type { LopOrder } from "../orders.ts";

export const DEFAULT_VENUE_URL = "https://api-phoenix.cork.tech";

/** Resolve the venue base and normalize away the retired base-versioned form: a configured
 *  base ending in /v<n> (the pre-0.3.3 convention, when the version lived in the base) would
 *  compose with the module-versioned literals into /v1/<module>/v1/… — a path no form of the
 *  API ever served. Stripping the suffix is safe in both directions: against cork-api the
 *  canonical paths are the primary form, and a proxy of the old form was passing through to
 *  the same host the canonical paths hit. The strip is disclosed in the changelog rather than
 *  per-call (it is a config migration, not a per-request event); the per-request radar is the
 *  Deprecation-header capture below. */
export function venueBaseUrl(override?: string): string {
  const raw = override ?? process.env.CORK_VENUE_URL ?? DEFAULT_VENUE_URL;
  return raw.replace(/\/+$/u, "").replace(/\/v\d+$/u, "").replace(/\/+$/u, "");
}

export type VenueFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Per-host breaker entries — callers own the container (the module singleton for the real
 *  network; tests inject their own to stay isolated). */
export interface VenueBreakerState {
  byHost: Record<string, BreakerEntry>;
}

export interface VenueDeps {
  fetch?: VenueFetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Clock for breaker decisions; defaults to Date.now. */
  now?: () => number;
  /** Breaker container override: an explicit state object, or null to disable. When omitted, the
   *  module singleton guards the REAL network only — an injected `fetch` stub is not a network,
   *  so stubbed calls (the entire offline test surface) neither consult nor pollute the shared
   *  breaker unless they opt in by injecting a state object. */
  breaker?: VenueBreakerState | null;
}

// Same shape as the RPC endpoint breaker (3 consecutive transport failures → open 30 s). The
// state machine is the shared one in breaker.ts; only the container and the keying differ.
export const VENUE_BREAKER_POLICY: BreakerPolicy = { openThreshold: 3, cooldownMs: 30_000 };

const moduleBreaker: VenueBreakerState = { byHost: {} };

/** Last real-network venue call outcome (diagnostics only — never drives admission). */
let lastOutcome: { ok: boolean; host: string; atMs: number } | null = null;

/** Test hook: clear the module-level breaker + diagnostics memory. */
export function resetVenueBreaker(): void {
  moduleBreaker.byHost = {};
  lastOutcome = null;
}

function breakerStateOf(deps: VenueDeps): VenueBreakerState | null {
  if (deps.breaker !== undefined) return deps.breaker;
  return deps.fetch ? null : moduleBreaker;
}

/** Host-only snapshot of venue transport health for the /readyz diagnostics surface. */
export function venueDiagnostics(now: number = Date.now()): {
  host: string;
  breaker: { failures: number; open: boolean; remainingCooldownMs: number } | null;
  lastOutcome: { ok: boolean; ageMs: number } | null;
  /** Present when the configured base carried a trailing version segment that venueBaseUrl
   *  normalized away — the ONE observable trace of that config rewrite (per-call disclosure
   *  would be noise; zero disclosure would make a mis-normalized proxy setup undebuggable).
   *  Only the stripped suffix is exposed, never the configured URL: /readyz discloses hosts
   *  only, and a user override may embed credentials in its path. */
  normalizedVersionSuffix?: string;
} {
  const host = hostOf(venueBaseUrl());
  const entry = moduleBreaker.byHost[host];
  const configured = (process.env.CORK_VENUE_URL ?? DEFAULT_VENUE_URL).replace(/\/+$/u, "");
  const suffix = /\/v\d+$/u.exec(configured)?.[0];
  return {
    host,
    breaker: entry ? { failures: entry.failures, open: breakerOpen(entry, now, VENUE_BREAKER_POLICY), remainingCooldownMs: breakerRemainingMs(entry, now, VENUE_BREAKER_POLICY) } : null,
    lastOutcome: lastOutcome && lastOutcome.host === host ? { ok: lastOutcome.ok, ageMs: Math.max(0, now - lastOutcome.atMs) } : null,
    ...(suffix !== undefined ? { normalizedVersionSuffix: suffix } : {}),
  };
}

/** Transport-level failure (network, timeout, non-JSON body) — distinct from an HTTP status. */
export class VenueUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueUnreachable";
  }
}

const Row = z.record(z.string(), z.unknown());
const ListResponse = z
  .object({
    items: z.array(Row),
    nextCursor: z.unknown().optional(),
    next_cursor: z.unknown().optional(),
    hasMore: z.boolean().optional(),
    // In-band venue notices (cork-api 0.3.3+): deprecations and operational warnings ride on
    // the response body ({code, message, deprecates?, effectiveAt?}). UNTRUSTED rows — callers
    // relay them as labeled venue text, never act on them as instructions.
    warnings: z.array(Row).optional(),
  })
  .loose();

export interface VenueList {
  items: Array<Record<string, unknown>>;
  nextCursor?: unknown;
  hasMore?: boolean;
  /** False only for a legacy bare-array response, whose completeness cannot be proven. */
  paginationKnown: boolean;
  /** The venue's own in-band notices for this response, verbatim and untrusted. */
  venueWarnings?: Array<Record<string, unknown>>;
  /** Set when the response was served by the deprecated-path rewrite (`Deprecation: true`):
   *  the canonical path the venue says this call should use. Our literals are canonical, so
   *  seeing this means either a stale literal (a bug here) or a base override re-adding the
   *  old form — both worth announcing. */
  deprecatedPath?: string;
}

/** Cursor + page-size passthrough for a paged venue read (both optional; the venue ignores what it doesn't support). */
export interface PageParams {
  cursor?: string;
  limit?: number;
}

/** Offset + page-size passthrough for the /rollover/v1 lists — the one venue family that pages
 *  by row offset (its openapi defines no cursor param, and the routes silently ignore an
 *  unknown one, serving page 1 forever — verified live on 0.3.4). */
export interface OffsetPageParams {
  offset?: number;
  limit?: number;
}

export interface VenuePostResult {
  httpStatus: number;
  body: unknown;
  /** Seconds the venue asked us to wait (429 Retry-After), when it said. */
  retryAfterSeconds?: number;
  /** Canonical path from the deprecated-path rewrite's headers, when the shim served this call. */
  deprecatedPath?: string;
}

/** One transport attempt: breaker-gated (fail fast while open), breaker-fed (a fetch throw /
 *  timeout records a failure; ANY HTTP response — even a 5xx — records a success, because the
 *  breaker guards the 10s-timeout class of waste, not server-side errors that answer quickly). */
async function rawFetch(deps: VenueDeps, path: string, init?: RequestInit): Promise<Response> {
  const f = deps.fetch ?? fetch;
  const br = breakerStateOf(deps);
  const now = deps.now ?? Date.now;
  const host = hostOf(venueBaseUrl(deps.baseUrl));
  if (br && breakerOpen(br.byHost[host], now(), VENUE_BREAKER_POLICY)) {
    const waitMs = breakerRemainingMs(br.byHost[host], now(), VENUE_BREAKER_POLICY);
    throw new VenueUnreachable(`venue unreachable: failing fast — ${host} failed ${br.byHost[host]!.failures} consecutive transport attempts and its breaker is open for another ${Math.ceil(waitMs / 1000)}s; check connectivity or CORK_VENUE_URL`);
  }
  try {
    const res = await fetchWithTimeout(`${venueBaseUrl(deps.baseUrl)}${path}`, init ?? {}, deps.timeoutMs ?? 10_000, f);
    if (br) br.byHost[host] = breakerOnSuccess();
    if (br === moduleBreaker) lastOutcome = { ok: true, host, atMs: now() };
    return res;
  } catch (err) {
    if (br) br.byHost[host] = breakerOnFailure(br.byHost[host], now(), VENUE_BREAKER_POLICY);
    if (br === moduleBreaker) lastOutcome = { ok: false, host, atMs: now() };
    throw new VenueUnreachable(`venue unreachable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

/** GET transport with ONE immediate silent retry on a transport-class failure — GETs are
 *  idempotent, and a single blip (connection reset, DNS hiccup) shouldn't fail a read that
 *  would succeed 50ms later. Never retries when the failure just opened the breaker (fail-fast
 *  wins), and never applies to POSTs: relays retry only under the caller's [K2] idempotency
 *  contract, not silently at the transport. Same-tier retries stay silent by the same rule the
 *  RPC resolver's backoff retries do — only tier CHANGES are disclosed. */
async function getFetch(deps: VenueDeps, path: string): Promise<Response> {
  try {
    return await rawFetch(deps, path);
  } catch (err) {
    if (!(err instanceof VenueUnreachable)) throw err;
    const br = breakerStateOf(deps);
    const now = deps.now ?? Date.now;
    if (br && breakerOpen(br.byHost[hostOf(venueBaseUrl(deps.baseUrl))], now(), VENUE_BREAKER_POLICY)) throw err;
    return rawFetch(deps, path);
  }
}

/** Parse a Retry-After header: delta-seconds, or an HTTP-date (converted to seconds from now). */
function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

/** The shim's fingerprint: `Deprecation: true` plus the canonical path it wants instead. */
function deprecatedPathOf(res: Response): string | undefined {
  if ((res.headers.get("deprecation") ?? "").toLowerCase() !== "true") return undefined;
  return res.headers.get("x-cork-canonical-path") ?? "(header x-cork-canonical-path absent)";
}

async function getJson(deps: VenueDeps, path: string): Promise<{ body: unknown; deprecatedPath?: string }> {
  const res = await getFetch(deps, path);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VenueUnreachable(`venue returned non-JSON (HTTP ${res.status}) for ${path}`);
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : `HTTP ${res.status}`;
    throw new VenueHttpError(res.status, msg, body, parseRetryAfter(res.headers.get("retry-after"), (deps.now ?? Date.now)()));
  }
  const deprecatedPath = deprecatedPathOf(res);
  return { body, ...(deprecatedPath !== undefined ? { deprecatedPath } : {}) };
}

/** Non-2xx venue response with the parsed body attached (message says why). */
export class VenueHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
    /** Seconds the venue asked us to wait (429 Retry-After), when it said. */
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "VenueHttpError";
  }
}

function asList(raw: { body: unknown; deprecatedPath?: string }, what: string): VenueList {
  const parsed = ListResponse.safeParse(raw.body);
  const meta = raw.deprecatedPath !== undefined ? { deprecatedPath: raw.deprecatedPath } : {};
  if (!parsed.success) {
    // A bare array carries no pagination metadata — completeness is unprovable. safeParse, not
    // parse: a malformed element must surface as the same venue-typed shape error every other
    // malformed response gets, never as a raw ZodError (which read as internal_error).
    if (Array.isArray(raw.body)) {
      const rows = z.array(Row).safeParse(raw.body);
      if (rows.success) return { items: rows.data, paginationKnown: false, ...meta };
    }
    throw new VenueUnreachable(`venue ${what} response did not match the expected list shape`);
  }
  const p = parsed.data;
  return {
    items: p.items,
    nextCursor: p.nextCursor ?? p.next_cursor,
    paginationKnown: true,
    ...(p.hasMore !== undefined ? { hasMore: p.hasMore } : {}),
    ...(p.warnings !== undefined && p.warnings.length > 0 ? { venueWarnings: p.warnings } : {}),
    ...meta,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** GET /pools/v1 — indexed Phoenix pools (new markets appear within seconds of MarketCreated). */
export async function getPools(deps: VenueDeps, chainId: number, page: PageParams = {}): Promise<VenueList> {
  return asList(await getJson(deps, `/pools/v1${qs({ chainId, cursor: page.cursor, limit: page.limit })}`), "pools");
}

export interface LopBookParams extends PageParams {
  chainId: number;
  poolId?: string;
  side?: string;
  status?: string;
}

/** GET /limit-orders/v1/orderbook — resting orders (each row carries the full signed order). */
export async function getLopOrderbook(deps: VenueDeps, p: LopBookParams): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/v1/orderbook${qs({ chainId: p.chainId, poolId: p.poolId, side: p.side, status: p.status, cursor: p.cursor, limit: p.limit })}`), "orderbook");
}

/** GET /limit-orders/v1/fills. */
export async function getLopFills(deps: VenueDeps, p: { chainId: number; orderHash?: string; cursor?: string; limit?: number }): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/v1/fills${qs(p)}`), "fills");
}

/** GET /limit-orders/v1/markets — enumerable cPT/cST markets. */
export async function getLopMarkets(deps: VenueDeps, chainId: number, page: PageParams = {}): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/v1/markets${qs({ chainId, cursor: page.cursor, limit: page.limit })}`), "trading-pairs");
}

export interface RolloverOrdersParams extends OffsetPageParams {
  chainId: number;
  user?: string;
  poolId?: string;
  settler?: string;
  status?: string;
  fillable?: boolean;
  source?: string;
}

/** GET /rollover/v1/orders — the rollover order feed (solver feed with fillable=true). */
export async function getRolloverOrders(deps: VenueDeps, p: RolloverOrdersParams): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/v1/orders${qs({ chainId: p.chainId, user: p.user, poolId: p.poolId, settler: p.settler, status: p.status, fillable: p.fillable, source: p.source, offset: p.offset, limit: p.limit })}`), "rollover orders");
}

/** GET /rollover/v1/orders/{orderDigest} — one order fully resolved ({order, fills, slots}).
 *  Known scope cut, here and on getRfq: single-record gets return the row only — body-level
 *  venue warnings[] and the shim's deprecation header are surfaced on the LIST and POST paths
 *  (where the venue actually attaches them today); thread a meta return through these two if a
 *  single-get ever starts carrying notices. */
export async function getRolloverOrder(deps: VenueDeps, orderDigest: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await getJson(deps, `/rollover/v1/orders/${orderDigest}`);
    return Row.parse(raw.body);
  } catch (err) {
    if (err instanceof VenueHttpError && err.status === 404) return null;
    throw err;
  }
}

/** GET /rollover/v1/fills — indexed rollover fill legs (ROLLOVER/PREMIUM/RECLAIM/REFUND). */
export async function getRolloverFills(deps: VenueDeps, p: { chainId: number; orderDigest?: string; filler?: string } & OffsetPageParams): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/v1/fills${qs({ chainId: p.chainId, orderDigest: p.orderDigest, filler: p.filler, offset: p.offset, limit: p.limit })}`), "rollover fills");
}

/** GET /rollover/v1/contracts — per-user rollover clones (setup gate: "does my clone exist?"). */
export async function getRolloverContracts(deps: VenueDeps, p: { chainId: number; owner?: string; address?: string } & OffsetPageParams): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/v1/contracts${qs({ chainId: p.chainId, owner: p.owner, address: p.address, offset: p.offset, limit: p.limit })}`), "rollover contracts");
}

export interface RfqListParams extends PageParams {
  chainId?: number;
  state?: "open" | "expired";
  referenceAsset?: string;
  requester?: string;
  withAnswers?: boolean;
  view?: "full" | "current";
}

/**
 * GET /rfqs/v1 — the RFQ discovery feed (how a quoter finds work; poll, no webhooks).
 * Server defaults: state=open, newest first, keyset-paged on rfq_id ({items, next_cursor}).
 * with_answers=true embeds each RFQ's answers (newest first, venue-capped per row);
 * view=current narrows the embed to the negotiation frontier (one current answer per
 * underwriter + the current counter). Rows carry `version`, the venue's monotonic change
 * counter — poll the list, re-read only what moved.
 */
export async function getRfqs(deps: VenueDeps, p: RfqListParams): Promise<VenueList> {
  return asList(
    await getJson(
      deps,
      `/rfqs/v1${qs({ chain_id: p.chainId, state: p.state, reference_asset: p.referenceAsset, requester: p.requester, with_answers: p.withAnswers, view: p.view, cursor: p.cursor, limit: p.limit })}`,
    ),
    "rfqs",
  );
}

/** GET /rfqs/v1/{rfq_id} — the full RFQ record with answers (for quote_ref cross-checks). */
export async function getRfq(deps: VenueDeps, rfqId: string, view?: "full" | "current"): Promise<Record<string, unknown> | null> {
  try {
    const raw = await getJson(deps, `/rfqs/v1/${encodeURIComponent(rfqId)}${qs({ view })}`);
    return Row.parse(raw.body);
  } catch (err) {
    if (err instanceof VenueHttpError && err.status === 404) return null;
    throw err;
  }
}

// ── Untrusted signed-order parsing ──────────────────────────────────────────
// A venue orderbook row carries a full signed LOP order. It is UNTRUSTED: fields may be nested
// under `.order`, keyed camelCase or snake_case, and must be shape-validated before we re-hash
// and verify locally [K3]. A zod pipeline (normalize → validate → transform) does this on the
// same footing as the rest of the venue surface — no bespoke throwing validators.
const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/u, "expected a 20-byte address");
const HexBytes = z.string().regex(/^0x([0-9a-fA-F]{2})*$/u, "expected 0x-prefixed bytes");
const Uint = z.string().regex(/^(0|[1-9][0-9]*)$/u, "expected a base-10 uint");

export interface SignedLopOrder {
  order: LopOrder;
  signature: `0x${string}`;
  extension: `0x${string}`;
  makerAccountType: "EOA" | "ERC1271";
  /** The venue's own claimed order hash, when present (cross-checked against the local re-hash). */
  venueOrderHash?: `0x${string}`;
}

const SignedLopOrderRow = z
  .preprocess((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const nested = row.order && typeof row.order === "object" && !Array.isArray(row.order) ? (row.order as Record<string, unknown>) : {};
    const pick = (...keys: string[]): unknown => {
      for (const k of keys) {
        const v = nested[k] ?? row[k];
        if (v !== undefined) return v;
      }
      return undefined;
    };
    return {
      salt: pick("salt"),
      maker: pick("maker"),
      receiver: pick("receiver"),
      makerAsset: pick("makerAsset", "maker_asset"),
      takerAsset: pick("takerAsset", "taker_asset"),
      makingAmount: pick("makingAmount", "making_amount"),
      takingAmount: pick("takingAmount", "taking_amount"),
      makerTraits: pick("makerTraits", "maker_traits"),
      signature: pick("signature"),
      extension: pick("extension") ?? "0x",
      makerAccountType: pick("makerAccountType", "maker_account_type") ?? "EOA",
      orderHash: pick("orderHash", "order_hash"),
    };
  }, z.object({
    salt: Uint,
    maker: HexAddress,
    receiver: HexAddress,
    makerAsset: HexAddress,
    takerAsset: HexAddress,
    makingAmount: Uint,
    takingAmount: Uint,
    makerTraits: Uint,
    signature: HexBytes,
    extension: z.union([z.literal(""), HexBytes]),
    makerAccountType: z.string(),
    orderHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/u).optional(),
  }))
  .transform((v, ctx): SignedLopOrder => {
    const kind = v.makerAccountType.toUpperCase().replace(/[-_]/gu, "");
    // "CONTRACT" is the venue's own vocabulary (its post/get schemas say EOA|CONTRACT); it
    // means the same thing our surface calls ERC1271 — the standard the fill invokes. Without
    // this mapping every contract-maker book row failed row validation.
    const makerAccountType = kind === "EOA" ? "EOA" : kind === "ERC1271" || kind === "EIP1271" || kind === "CONTRACT" ? "ERC1271" : null;
    if (makerAccountType === null) {
      ctx.addIssue({ code: "custom", message: `unsupported makerAccountType '${v.makerAccountType}'` });
      return z.NEVER;
    }
    return {
      order: {
        salt: BigInt(v.salt),
        maker: v.maker as `0x${string}`,
        receiver: v.receiver as `0x${string}`,
        makerAsset: v.makerAsset as `0x${string}`,
        takerAsset: v.takerAsset as `0x${string}`,
        makingAmount: BigInt(v.makingAmount),
        takingAmount: BigInt(v.takingAmount),
        makerTraits: BigInt(v.makerTraits),
      },
      signature: v.signature as `0x${string}`,
      extension: (v.extension === "" ? "0x" : v.extension) as `0x${string}`,
      makerAccountType,
      ...(v.orderHash ? { venueOrderHash: v.orderHash as `0x${string}` } : {}),
    };
  });

/** Validate + normalize an untrusted venue orderbook row into a signed LOP order (Result, never throws). */
export function parseSignedLopOrder(row: unknown): { ok: true; value: SignedLopOrder } | { ok: false; error: string } {
  const parsed = SignedLopOrderRow.safeParse(row);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "order"}: ${i.message}`).join("; ") };
}

// ── Writes (relays of caller-authored/signed payloads [K1]) ─────────────────

async function postJson(deps: VenueDeps, path: string, body: unknown): Promise<VenuePostResult> {
  // Deliberately NO transport retry here (contrast getFetch): a relay retries only under the
  // caller's [K2] clientRequestId idempotency contract, never silently at the transport layer.
  const res = await rawFetch(deps, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* some errors have empty bodies — keep the status */
  }
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"), (deps.now ?? Date.now)());
  const deprecatedPath = deprecatedPathOf(res);
  return { httpStatus: res.status, body: parsed, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}), ...(deprecatedPath !== undefined ? { deprecatedPath } : {}) };
}

/** POST /rollover/v1/orders — relay a signed rollover order. */
export async function postRolloverOrder(deps: VenueDeps, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, "/rollover/v1/orders", body);
}

/** POST /limit-orders/v1 — relay a signed LOP order. */
export async function postLopOrder(deps: VenueDeps, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, "/limit-orders/v1", body);
}

/** POST /rfqs/v1 — open an RFQ (parameter envelope). */
export async function postRfq(deps: VenueDeps, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, "/rfqs/v1", body);
}

/** POST /rfqs/v1/{rfqId}/answers — answer an RFQ with priced options or a typed pass. */
export async function postRfqAnswer(deps: VenueDeps, rfqId: string, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, `/rfqs/v1/${encodeURIComponent(rfqId)}/answers`, body);
}

/** POST /rfqs/v1/{rfqId}/counters — the requester's non-committal counter-bid (requester-only). */
export async function postRfqCounter(deps: VenueDeps, rfqId: string, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, `/rfqs/v1/${encodeURIComponent(rfqId)}/counters`, body);
}
