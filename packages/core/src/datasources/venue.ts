// Centralized-mode datasource: the as-built Cork venue at api-phoenix.cork.tech/v1
// (cork-knowledge: rollover-venue-interface.md + agent-rfq-venue-interface.md, both live).
// Read endpoints are keyless; the fetch implementation is injectable so the entire surface is
// testable offline. Responses are UNTRUSTED input: shapes are zod-validated before use (lenient —
// key fields typed, extra fields passed through, because the venue's own zod schemas are the
// authoritative contract and it may add fields).
import { z } from "zod";

export const DEFAULT_VENUE_URL = "https://api-phoenix.cork.tech/v1";

export function venueBaseUrl(override?: string): string {
  return override ?? process.env.CORK_VENUE_URL ?? DEFAULT_VENUE_URL;
}

export type VenueFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface VenueDeps {
  fetch?: VenueFetch;
  baseUrl?: string;
  timeoutMs?: number;
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
  })
  .loose();

export interface VenueList {
  items: Array<Record<string, unknown>>;
  nextCursor?: unknown;
  hasMore?: boolean;
}

export interface VenuePostResult {
  httpStatus: number;
  body: unknown;
}

async function rawFetch(deps: VenueDeps, path: string, init?: RequestInit): Promise<Response> {
  const f = deps.fetch ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 10_000);
  try {
    return await f(`${venueBaseUrl(deps.baseUrl)}${path}`, { ...init, signal: ctrl.signal });
  } catch (err) {
    throw new VenueUnreachable(`venue unreachable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  } finally {
    clearTimeout(t);
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function getJson(deps: VenueDeps, path: string): Promise<unknown> {
  const res = await rawFetch(deps, path);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new VenueUnreachable(`venue returned non-JSON (HTTP ${res.status}) for ${path}`);
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : `HTTP ${res.status}`;
    const err = new VenueHttpError(res.status, msg, body);
    throw err;
  }
  return body;
}

/** Non-2xx venue response with the parsed body attached (message says why). */
export class VenueHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
    this.name = "VenueHttpError";
  }
}

function asList(raw: unknown, what: string): VenueList {
  const parsed = ListResponse.safeParse(raw);
  if (!parsed.success) {
    // Some endpoints may return a bare array.
    if (Array.isArray(raw)) return { items: z.array(Row).parse(raw) };
    throw new VenueUnreachable(`venue ${what} response did not match the expected list shape`);
  }
  const p = parsed.data;
  return {
    items: p.items,
    nextCursor: p.nextCursor ?? p.next_cursor,
    ...(p.hasMore !== undefined ? { hasMore: p.hasMore } : {}),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** GET /v1/pools — indexed Phoenix pools (new markets appear within seconds of MarketCreated). */
export async function getPools(deps: VenueDeps, chainId: number): Promise<VenueList> {
  return asList(await getJson(deps, `/pools${qs({ chainId })}`), "pools");
}

export interface LopBookParams {
  chainId: number;
  poolId?: string;
  side?: string;
  status?: string;
}

/** GET /v1/limit-orders/orderbook — resting orders (each row carries the full signed order). */
export async function getLopOrderbook(deps: VenueDeps, p: LopBookParams): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/orderbook${qs({ chainId: p.chainId, poolId: p.poolId, side: p.side, status: p.status })}`), "orderbook");
}

/** GET /v1/limit-orders/fills. */
export async function getLopFills(deps: VenueDeps, p: { chainId: number; orderHash?: string }): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/fills${qs(p)}`), "fills");
}

/** GET /v1/limit-orders/markets — enumerable cPT/cST markets. */
export async function getLopMarkets(deps: VenueDeps, chainId: number): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/markets${qs({ chainId })}`), "limit-order-markets");
}

export interface RolloverOrdersParams {
  chainId: number;
  user?: string;
  poolId?: string;
  settler?: string;
  status?: string;
  fillable?: boolean;
  source?: string;
}

/** GET /v1/rollover/orders — the rollover order feed (solver feed with fillable=true). */
export async function getRolloverOrders(deps: VenueDeps, p: RolloverOrdersParams): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/orders${qs({ chainId: p.chainId, user: p.user, poolId: p.poolId, settler: p.settler, status: p.status, fillable: p.fillable, source: p.source })}`), "rollover orders");
}

/** GET /v1/rollover/orders/{orderDigest} — one order fully resolved ({order, fills, slots}). */
export async function getRolloverOrder(deps: VenueDeps, orderDigest: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await getJson(deps, `/rollover/orders/${orderDigest}`);
    return Row.parse(raw);
  } catch (err) {
    if (err instanceof VenueHttpError && err.status === 404) return null;
    throw err;
  }
}

/** GET /v1/rollover/fills — indexed rollover fill legs (ROLLOVER/PREMIUM/RECLAIM/REFUND). */
export async function getRolloverFills(deps: VenueDeps, p: { chainId: number; orderDigest?: string; filler?: string }): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/fills${qs(p)}`), "rollover fills");
}

/** GET /v1/rollover/contracts — per-user rollover clones (setup gate: "does my clone exist?"). */
export async function getRolloverContracts(deps: VenueDeps, p: { chainId: number; owner?: string; address?: string }): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/contracts${qs(p)}`), "rollover contracts");
}

export interface RfqListParams {
  chainId?: number;
  state?: "open" | "expired";
  referenceAsset?: string;
  requester?: string;
  withAnswers?: boolean;
}

/**
 * GET /v1/rfqs — the RFQ discovery feed (how a quoter finds work; poll, no webhooks).
 * Server defaults: state=open, newest first, keyset-paged on rfq_id ({items, next_cursor}).
 * with_answers=true embeds each RFQ's answers (newest first, venue-capped per row).
 */
export async function getRfqs(deps: VenueDeps, p: RfqListParams): Promise<VenueList> {
  return asList(
    await getJson(
      deps,
      `/rfqs${qs({ chain_id: p.chainId, state: p.state, reference_asset: p.referenceAsset, requester: p.requester, with_answers: p.withAnswers })}`,
    ),
    "rfqs",
  );
}

/** GET /v1/rfqs/{rfq_id} — the full RFQ record with answers (for quote_ref cross-checks). */
export async function getRfq(deps: VenueDeps, rfqId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await getJson(deps, `/rfqs/${encodeURIComponent(rfqId)}`);
    return Row.parse(raw);
  } catch (err) {
    if (err instanceof VenueHttpError && err.status === 404) return null;
    throw err;
  }
}

// ── Writes (relays of caller-authored/signed payloads [K1]) ─────────────────

async function postJson(deps: VenueDeps, path: string, body: unknown): Promise<VenuePostResult> {
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
  return { httpStatus: res.status, body: parsed };
}

/** POST /v1/rollover/orders — relay a signed rollover order. */
export async function postRolloverOrder(deps: VenueDeps, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, "/rollover/orders", body);
}

/** POST /v1/limit-orders — relay a signed LOP order. */
export async function postLopOrder(deps: VenueDeps, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, "/limit-orders", body);
}

/** POST /v1/rfqs — open an RFQ (parameter envelope). */
export async function postRfq(deps: VenueDeps, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, "/rfqs", body);
}

/** POST /v1/rfqs/{rfqId}/answers — answer an RFQ with priced options or a typed pass. */
export async function postRfqAnswer(deps: VenueDeps, rfqId: string, body: unknown): Promise<VenuePostResult> {
  return postJson(deps, `/rfqs/${encodeURIComponent(rfqId)}/answers`, body);
}
