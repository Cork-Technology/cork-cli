// Watching the book for a better order — the taker's question "did anything I would rather fill
// appear since I last looked?" answered from the RANKED view, never from venue rows alone.
//
// The venue exposes no `updated_after` and its rows carry no version or timestamp, so the
// watermark is CLIENT-SIDE: an opaque token over the live set the last ranked read served (every
// fillable order hash, collapsed group rungs included) and the best order per side. A later read
// diffs itself against it. Pure: a watermark and a rank result in, the changes out; no I/O.
//
// Verify before announce (owner ruling 2026-09-02, design §5): a row the venue lists OPEN can be
// dead on chain (a filled sibling of its group, a cancel). The hybrid read already DROPS rows the
// chain refutes before ranking sees them, so a surviving row with `verification:"confirmed"` has
// had its invalidator bit read clear this call. Only such rows are announced under `appeared` and
// `better`; a row nobody could confirm (no RPC, budget exhausted) rides under `unconfirmed` — the
// set changed, but the caller must confirm it before acting.
//
// "Better" (ruling): a lower unit price for the taker on a SELL row (higher on a BUY row, where
// the maker pays), or an improved REACH at the same price — an order reserved for this fill
// sender beats an open one, because nobody can race it.
import type { RankedRow, RankResult } from "./orders-rank.ts";

// base64url via Buffer (Bun and Node >= 22, the SDK's engines floor) — no dependency.
const encodeBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const decodeBase64Url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

export const WATERMARK_PREFIX = "bw1.";
/** Long-poll cadence: the book is re-read every this many seconds while `wait` runs. */
export const WATCH_POLL_SECONDS = 2;
/** `wait` ceiling — under the HTTP ingress deadline (30 s) so a long-poll over HTTP completes. */
export const WATCH_WAIT_MAX_SECONDS = 25;

export type BookSide = "SELL" | "BUY";
const SIDES: readonly BookSide[] = ["SELL", "BUY"];

export interface WatchBest {
  orderHash: string;
  /** takerAsset base units per 1e18 makerAsset (the ranker's unitPrice — a decaying row at its price when read). */
  unitPrice: string;
  reservedForAccount: boolean;
}

export interface BookWatermark {
  v: 1;
  /** The fill sender the ranked read was FOR (lowercase), null for a price-only read. */
  account: string | null;
  /** Every fillable order hash the read served (lowercase), collapsed group rungs included. */
  live: string[];
  best: Record<BookSide, WatchBest | null>;
}

export class WatermarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatermarkError";
  }
}

const lower = (s: unknown): string => String(s).toLowerCase();
const sideOf = (row: RankedRow): BookSide | null => {
  const s = typeof row.side === "string" ? row.side.toUpperCase() : "";
  return s === "SELL" || s === "BUY" ? s : null;
};
const reservedForAccount = (row: RankedRow): boolean => row.exclusivity === "reserved-for-account";
const confirmed = (row: RankedRow): boolean => row.verification === "confirmed";
const bestOf = (row: RankedRow): WatchBest => ({ orderHash: lower(row.orderHash), unitPrice: row.price.unitPrice, reservedForAccount: reservedForAccount(row) });

/** The live set + per-side best of a ranked read. Items are already best-first per side. */
export function bookWatermarkOf(ranked: RankResult): BookWatermark {
  const live: string[] = [];
  const best: Record<BookSide, WatchBest | null> = { SELL: null, BUY: null };
  for (const row of ranked.items) {
    live.push(lower(row.orderHash));
    for (const sib of row.group?.collapsed ?? []) live.push(lower(sib));
    const side = sideOf(row);
    if (side && best[side] === null) best[side] = bestOf(row);
  }
  return { v: 1, account: ranked.rankedFor ? ranked.rankedFor.toLowerCase() : null, live: [...new Set(live)].sort(), best };
}

/** Opaque wire form: prefix + base64url(JSON). Compact hashes (no 0x); the structure is not a contract. */
export function encodeBookWatermark(w: BookWatermark): string {
  const b = (x: WatchBest | null) => (x ? { h: x.orderHash.slice(2), p: x.unitPrice, r: x.reservedForAccount ? 1 : 0 } : null);
  return WATERMARK_PREFIX + encodeBase64Url(new TextEncoder().encode(JSON.stringify({ v: 1, a: w.account, l: w.live.map((h) => h.slice(2)), b: { S: b(w.best.SELL), B: b(w.best.BUY) } })));
}

const HASH64 = /^[0-9a-f]{64}$/;
export function decodeBookWatermark(s: string): BookWatermark {
  if (!s.startsWith(WATERMARK_PREFIX)) throw new WatermarkError(`not a book watermark (expected the '${WATERMARK_PREFIX}' prefix a prior orderbook read returned as data.watermark)`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(decodeBase64Url(s.slice(WATERMARK_PREFIX.length))));
  } catch {
    throw new WatermarkError("book watermark does not decode — pass data.watermark verbatim from a prior orderbook read");
  }
  const r = raw as { v?: unknown; a?: unknown; l?: unknown; b?: { S?: unknown; B?: unknown } };
  if (r.v !== 1 || !Array.isArray(r.l) || !r.b || typeof r.b !== "object") throw new WatermarkError("book watermark has an unknown shape");
  const best = (x: unknown): WatchBest | null => {
    if (x === null || x === undefined) return null;
    const o = x as { h?: unknown; p?: unknown; r?: unknown };
    if (typeof o.h !== "string" || !HASH64.test(o.h) || typeof o.p !== "string" || !/^[0-9]+$/.test(o.p)) throw new WatermarkError("book watermark best entry is malformed");
    return { orderHash: `0x${o.h}`, unitPrice: o.p, reservedForAccount: o.r === 1 };
  };
  const live = (r.l as unknown[]).map((h) => {
    if (typeof h !== "string" || !HASH64.test(h)) throw new WatermarkError("book watermark live set is malformed");
    return `0x${h}`;
  });
  return { v: 1, account: typeof r.a === "string" ? r.a.toLowerCase() : null, live, best: { SELL: best(r.b.S), BUY: best(r.b.B) } };
}

/** Is `cand` an order the taker would rather fill than `prev` (same side)? null prev = anything is better than nothing. */
export function isBetterOffer(side: BookSide, cand: WatchBest, prev: WatchBest | null): boolean {
  if (prev === null) return true;
  const c = BigInt(cand.unitPrice);
  const p = BigInt(prev.unitPrice);
  if (c !== p) return side === "SELL" ? c < p : c > p;
  return cand.reservedForAccount && !prev.reservedForAccount;
}

export interface BestChange {
  previous: WatchBest | null;
  current: WatchBest | null;
  /** The best order is a different order than before (or there was none / is none now). */
  changed: boolean;
  /** The previous best is no longer in the live set — filled, cancelled, expired, or dropped by the chain. */
  died: boolean;
}

export interface BookChanges {
  changed: boolean;
  /** Fillable orders new since the watermark whose invalidator bit read CLEAR this call. */
  appeared: string[];
  /** Orders in the watermark's live set that this read no longer serves as fillable. */
  gone: string[];
  /** New rows nobody could confirm on chain this call — a set change, not an announcement. */
  unconfirmed: string[];
  best: Record<BookSide, BestChange | null>;
  /** Confirmed rows better than the watermark's best on their side (price, or reach at equal price). */
  better: Array<{ orderHash: string; side: BookSide; unitPrice: string; exclusivity: unknown; rank: number }>;
}

/** Diff a ranked read against the watermark it followed. Throws WatermarkError on a sender mismatch. */
export function diffBook(prev: BookWatermark, ranked: RankResult): BookChanges {
  const account = ranked.rankedFor ? ranked.rankedFor.toLowerCase() : null;
  if (prev.account !== account) {
    throw new WatermarkError(`watermark was taken for fill sender ${prev.account ?? "(none)"} but this read is for ${account ?? "(none)"} — reach and exclusion differ per sender, so the two reads do not compare; take a fresh watermark`);
  }
  const now = bookWatermarkOf(ranked);
  const prevLive = new Set(prev.live);
  const nowLive = new Set(now.live);
  const appeared: string[] = [];
  const unconfirmed: string[] = [];
  const better: BookChanges["better"] = [];
  for (const row of ranked.items) {
    const h = lower(row.orderHash);
    const isNew = !prevLive.has(h);
    if (isNew) (confirmed(row) ? appeared : unconfirmed).push(h);
    const side = sideOf(row);
    if (side && confirmed(row) && isBetterOffer(side, bestOf(row), prev.best[side])) {
      better.push({ orderHash: h, side, unitPrice: row.price.unitPrice, exclusivity: row.exclusivity, rank: row.rank });
    }
  }
  const gone = prev.live.filter((h) => !nowLive.has(h));
  const best: Record<BookSide, BestChange | null> = { SELL: null, BUY: null };
  for (const side of SIDES) {
    const p = prev.best[side];
    const c = now.best[side];
    if (p === null && c === null) continue;
    best[side] = { previous: p, current: c, changed: (p?.orderHash ?? null) !== (c?.orderHash ?? null), died: p !== null && !nowLive.has(p.orderHash) };
  }
  const changed = appeared.length > 0 || gone.length > 0 || unconfirmed.length > 0 || better.length > 0 || SIDES.some((s) => best[s]?.changed === true);
  return { changed, appeared, gone, unconfirmed, best, better };
}
