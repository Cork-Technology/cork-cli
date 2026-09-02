// Best-first ranking of resting book rows for ONE fill sender — the taker's question "what can I
// fill best, in this pool and side, as this sender?" answered from the SIGNED order, never from
// venue metadata [K3]. Pure: rows in, ranked rows + excluded rows out; no I/O.
//
// The order of business (owner ruling 2026-09-02):
//   1. partition FILLABLE from not — a row is excluded when it is reserved for another fill
//      sender, expired by its own signed traits, dead by venue status, or unparseable;
//   2. price from the signed amounts (a decaying row at its price NOW), never from the listing's
//      premium; a SELL of cover is cheaper when the taker pays less per unit made, a BUY (the
//      maker buys cover) is better when the maker pays more;
//   3. a reserved-for-account row wins a price tie (no race), a chain-confirmed row beats an
//      unverified one, a longer-lived row beats a shorter one, then orderHash for determinism;
//   4. rungs of one one-cancels-the-other group (same maker, same bit-invalidator nonce)
//      collapse to their best fillable rung, the group attached — because only one of them can
//      ever fill.
// The ranked view is computed over the rows it is GIVEN (one bounded venue walk); it does not
// re-page. Group death is invisible to the venue: a rung whose sibling filled reads OPEN here
// until the chain says otherwise, which is why the hybrid liveness leg runs before this.
import { decodeMakerTraits, hashLopOrder, isAllowedSender, type LopOrder, lopInvalidatorPlan } from "./orders.ts";
import { auctionPhase, decodeFusionOrder, fusionRateBump, fusionTakerPays, fusionTotalFee, isGetterWhitelisted, NotAFusionOrder } from "./fusion.ts";
import { parseSignedLopOrder, type SignedLopOrder } from "./datasources/venue.ts";

export type BookSort = "best" | "venue";
export const BOOK_SORTS = ["best", "venue"] as const;

/** A venue book row after hybrid verification (loosely typed: the venue's JSON plus our labels). */
export type BookRow = Record<string, unknown>;

export interface RankedPrice {
  /** taker-asset base units per 1e18 maker-asset base units (exact integer, floor). */
  unitPrice: string;
  shape: "fixed" | "decaying";
  /** decaying rows only: where the curve is at `nowSeconds`, and what the taker pays NOW for the full making amount. */
  phase?: "pre-start" | "decaying" | "floor";
  takerPaysNow?: string;
}

export interface RankedGroup {
  /** `<maker>:<nonce>` — the shared bit invalidator slot every rung of the group spends. */
  key: string;
  nonce: string;
  /** Order hashes of the OTHER fillable rungs collapsed under this one (best first). */
  collapsed: string[];
}

export type RankedRow = BookRow & { rank: number; fillable: true; price: RankedPrice; group?: RankedGroup };
/** Why a row is not fillable, as a branchable code beside the prose. `reserved-for-other` is the
 *  one LIVE exclusion: the order exists and backs whatever quote it cites — only this sender may
 *  not lift it. The others describe an order that is dead or unreadable. */
export type BookExclusion = "reserved-for-other" | "expired" | "venue-status" | "unparseable" | "zero-amount";
export type ExcludedRow = BookRow & { fillable: false; exclusion: BookExclusion; whyNotFillable: string };

export interface RankOptions {
  chainId: number;
  lop: `0x${string}`;
  /** The fill sender the ranking is FOR (the ForSelf ADAPTER on a wrapper fill). Absent = a
   *  price-only ranking in which `reserved` rows are kept and flagged, since nobody can say
   *  whether they are fillable. */
  account?: `0x${string}` | undefined;
  nowSeconds: bigint;
  /** Parse results the hybrid verifier already produced, keyed by lowercase order hash: a row
   *  found here is not parsed or hashed again (same bytes, same verdict). Rows absent from the
   *  map — or any row when the map is omitted — take the parse path. */
  parsed?: ReadonlyMap<string, { signed: SignedLopOrder; localHash: `0x${string}` }> | undefined;
}

export interface RankResult {
  items: RankedRow[];
  excluded: ExcludedRow[];
  rankedFor: `0x${string}` | null;
  /** Fillable rows before group collapse (items.length + every collapsed sibling). */
  fillableCount: number;
}

const WAD = 10n ** 18n;

interface Scored {
  row: BookRow;
  order: LopOrder;
  hash: string;
  side: "BUY" | "SELL" | "?";
  /** price as an exact rational: taker pays `num` for `den` of the maker asset. */
  num: bigint;
  den: bigint;
  price: RankedPrice;
  reservedForAccount: boolean;
  confirmed: boolean;
  /** signed expiry, 0 = none. */
  expiry: bigint;
  groupKey: string | null;
  nonce: bigint | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Compare two rationals num/den without division: a < b ⇔ a.num*b.den < b.num*a.den. */
function comparePrice(a: Scored, b: Scored): number {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** The ranking comparator — one place, mutation-probed. */
export function compareRanked(a: Scored, b: Scored): number {
  // Sides never interleave: SELL rows (the taker BUYS cover) first, then BUY rows.
  if (a.side !== b.side) return a.side === "SELL" ? -1 : b.side === "SELL" ? 1 : a.side < b.side ? -1 : 1;
  // Price: cheaper cover first on SELL rows; on BUY rows the maker paying MORE per unit is better.
  const p = comparePrice(a, b);
  if (p !== 0) return a.side === "BUY" ? -p : p;
  if (a.reservedForAccount !== b.reservedForAccount) return a.reservedForAccount ? -1 : 1;
  if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
  // Longer life first: 0 (no expiry) outlives every timestamp; otherwise the later expiry wins.
  if (a.expiry !== b.expiry) {
    if (a.expiry === 0n) return -1;
    if (b.expiry === 0n) return 1;
    return a.expiry > b.expiry ? -1 : 1;
  }
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

/** Rank verified book rows best-first for `opts.account`. See the module header for the rule. */
export function rankBookRows(rows: readonly BookRow[], opts: RankOptions): RankResult {
  const account = opts.account;
  const scored: Scored[] = [];
  const excluded: ExcludedRow[] = [];
  const exclude = (row: BookRow, exclusion: BookExclusion, why: string) => excluded.push({ ...row, fillable: false, exclusion, whyNotFillable: why });

  for (const row of rows) {
    const pre = opts.parsed?.get(typeof row.orderHash === "string" ? row.orderHash.toLowerCase() : "");
    const parsed = pre ? ({ ok: true, value: pre.signed } as const) : parseSignedLopOrder(row);
    if (!parsed.ok) {
      exclude(row, "unparseable", `row could not be parsed as a signed order (${parsed.error}) — served venue-claimed, not ranked`);
      continue;
    }
    const { order, extension } = parsed.value;
    const hash = pre ? pre.localHash.toLowerCase() : hashLopOrder(opts.chainId, opts.lop, order).toLowerCase();
    const status = str(row.status)?.toUpperCase();
    if (status !== undefined && status !== "OPEN" && status !== "PARTIALLY_FILLED") {
      exclude(row, "venue-status", `venue status ${status}`);
      continue;
    }
    const traits = decodeMakerTraits(order.makerTraits);
    // MakerTraitsLib.isExpired: `expiration != 0 && expiration < block.timestamp` — a row whose
    // expiry equals `now` is still fillable in this block, so the rule is `<`, not `<=`.
    if (traits.expiry !== 0n && traits.expiry < opts.nowSeconds) {
      exclude(row, "expired", `expired at ${traits.expiry.toString()} (signed makerTraits expiry; the LOP reverts OrderExpired once block.timestamp passes it)`);
      continue;
    }
    if (traits.allowedSender !== null && account !== undefined && !isAllowedSender(order.makerTraits, account)) {
      exclude(row, "reserved-for-other", `reserved for a fill sender whose address ends in ${traits.allowedSender}; ${account} cannot fill it (PrivateOrder)`);
      continue;
    }
    if (order.makingAmount === 0n) {
      exclude(row, "zero-amount", "makingAmount is zero — no price");
      continue;
    }

    // Price from the SIGNED amounts; a decaying row at its price now.
    let num = order.takingAmount;
    const den = order.makingAmount;
    let price: RankedPrice = { unitPrice: ((num * WAD) / den).toString(), shape: "fixed" };
    if (extension !== "0x") {
      try {
        const dec = decodeFusionOrder(order, extension, opts.chainId);
        const fee = fusionTotalFee(dec.fees, account !== undefined && isGetterWhitelisted(dec.fees, account));
        const bump = fusionRateBump(dec.auction, opts.nowSeconds, null);
        num = fusionTakerPays(order.makingAmount, order.takingAmount, order.makingAmount, fee, bump.effective);
        price = { unitPrice: ((num * WAD) / den).toString(), shape: "decaying", phase: auctionPhase(dec.auction, opts.nowSeconds), takerPaysNow: num.toString() };
      } catch (err) {
        if (!(err instanceof NotAFusionOrder)) throw err;
        // a non-Fusion extension (e.g. a JIT hook alone): the signed amounts ARE the price
      }
    }

    const plan = lopInvalidatorPlan(order.makerTraits);
    const nonce = plan.mode === "bit" ? plan.nonceOrEpoch : null;
    const sideRaw = str(row.side)?.toUpperCase();
    scored.push({
      row,
      order,
      hash,
      side: sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : "?",
      num,
      den,
      price,
      reservedForAccount: traits.allowedSender !== null && account !== undefined,
      confirmed: row.verification === "confirmed",
      expiry: traits.expiry,
      groupKey: nonce === null ? null : `${order.maker.toLowerCase()}:${nonce.toString()}`,
      nonce,
    });
  }

  scored.sort(compareRanked);

  // Group collapse: the first (best) rung of a (maker, nonce) group represents it.
  const seen = new Map<string, RankedRow>();
  const items: RankedRow[] = [];
  for (const s of scored) {
    if (s.groupKey !== null) {
      const rep = seen.get(s.groupKey);
      if (rep) {
        rep.group!.collapsed.push(s.hash);
        continue;
      }
    }
    const ranked: RankedRow = { ...s.row, rank: items.length + 1, fillable: true, price: s.price, ...(s.groupKey !== null ? { group: { key: s.groupKey, nonce: s.nonce!.toString(), collapsed: [] } } : {}) };
    if (s.groupKey !== null) seen.set(s.groupKey, ranked);
    items.push(ranked);
  }
  // A group of one is just an order: drop the empty group label to keep single rows plain.
  for (const it of items) if (it.group && it.group.collapsed.length === 0) delete it.group;

  return { items, excluded, rankedFor: account ?? null, fillableCount: scored.length };
}
