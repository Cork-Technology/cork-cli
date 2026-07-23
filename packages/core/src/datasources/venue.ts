// Centralized-mode datasource: the as-built Cork venue at api-phoenix.cork.tech/v1
// (cork-knowledge: rollover-venue-interface.md + agent-rfq-venue-interface.md, both live).
// Read endpoints are keyless; the fetch implementation is injectable so the entire surface is
// testable offline. Responses are UNTRUSTED input: shapes are zod-validated before use (lenient —
// key fields typed, extra fields passed through, because the venue's own zod schemas are the
// authoritative contract and it may add fields).
import { z } from "zod";
import type { LopOrder } from "../orders.ts";

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
  /** False only for a legacy bare-array response, whose completeness cannot be proven. */
  paginationKnown: boolean;
}

/** Cursor + page-size passthrough for a paged venue read (both optional; the venue ignores what it doesn't support). */
export interface PageParams {
  cursor?: string;
  limit?: number;
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
    // A bare array carries no pagination metadata — completeness is unprovable.
    if (Array.isArray(raw)) return { items: z.array(Row).parse(raw), paginationKnown: false };
    throw new VenueUnreachable(`venue ${what} response did not match the expected list shape`);
  }
  const p = parsed.data;
  return {
    items: p.items,
    nextCursor: p.nextCursor ?? p.next_cursor,
    paginationKnown: true,
    ...(p.hasMore !== undefined ? { hasMore: p.hasMore } : {}),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** GET /v1/pools — indexed Phoenix pools (new markets appear within seconds of MarketCreated). */
export async function getPools(deps: VenueDeps, chainId: number, page: PageParams = {}): Promise<VenueList> {
  return asList(await getJson(deps, `/pools${qs({ chainId, cursor: page.cursor, limit: page.limit })}`), "pools");
}

export interface LopBookParams extends PageParams {
  chainId: number;
  poolId?: string;
  side?: string;
  status?: string;
}

/** GET /v1/limit-orders/orderbook — resting orders (each row carries the full signed order). */
export async function getLopOrderbook(deps: VenueDeps, p: LopBookParams): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/orderbook${qs({ chainId: p.chainId, poolId: p.poolId, side: p.side, status: p.status, cursor: p.cursor, limit: p.limit })}`), "orderbook");
}

/** GET /v1/limit-orders/fills. */
export async function getLopFills(deps: VenueDeps, p: { chainId: number; orderHash?: string; cursor?: string; limit?: number }): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/fills${qs(p)}`), "fills");
}

/** GET /v1/limit-orders/markets — enumerable cPT/cST markets. */
export async function getLopMarkets(deps: VenueDeps, chainId: number, page: PageParams = {}): Promise<VenueList> {
  return asList(await getJson(deps, `/limit-orders/markets${qs({ chainId, cursor: page.cursor, limit: page.limit })}`), "limit-order-markets");
}

export interface RolloverOrdersParams extends PageParams {
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
  return asList(await getJson(deps, `/rollover/orders${qs({ chainId: p.chainId, user: p.user, poolId: p.poolId, settler: p.settler, status: p.status, fillable: p.fillable, source: p.source, cursor: p.cursor, limit: p.limit })}`), "rollover orders");
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
export async function getRolloverFills(deps: VenueDeps, p: { chainId: number; orderDigest?: string; filler?: string; cursor?: string; limit?: number }): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/fills${qs(p)}`), "rollover fills");
}

/** GET /v1/rollover/contracts — per-user rollover clones (setup gate: "does my clone exist?"). */
export async function getRolloverContracts(deps: VenueDeps, p: { chainId: number; owner?: string; address?: string; cursor?: string; limit?: number }): Promise<VenueList> {
  return asList(await getJson(deps, `/rollover/contracts${qs(p)}`), "rollover contracts");
}

export interface RfqListParams extends PageParams {
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
      `/rfqs${qs({ chain_id: p.chainId, state: p.state, reference_asset: p.referenceAsset, requester: p.requester, with_answers: p.withAnswers, cursor: p.cursor, limit: p.limit })}`,
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
    const makerAccountType = kind === "EOA" ? "EOA" : kind === "ERC1271" || kind === "EIP1271" ? "ERC1271" : null;
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
