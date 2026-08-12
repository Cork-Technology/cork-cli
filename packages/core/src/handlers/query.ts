// Split from handlers.ts (2026-08-05): query handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope, QueryInput, UNITS_TOPIC_REFERENCE } from "@cork/schemas";
import { type CorkAddresses, readPoolState, resolvePoolTokens } from "../chain/reads.ts";
import { hostOf, type ResolvedRpc } from "../chain/rpc.ts";
import { erc20Abi, permit2AllowanceAbi, whitelistManagerAbi } from "../chain/abis.ts";
import { LOP_ADDRESSES } from "../orders.ts";
import { CREATE2_DEPLOYER } from "../config.ts";
import { resolveConfig, resolveRollover } from "../config-remote.ts";
import { CLONE_DEPLOYED_TOPIC, decodeCloneRows, decodeLopFillRows, decodeMarketRows, decodeRolloverFillRows, decodeWhitelistRows, type HyperSyncLog, loadHyperSync, LOP_FILLED_TOPIC, MARKET_CREATED_TOPIC, replayWhitelist, ROLLOVER_FILL_TOPICS, WHITELIST_TOPICS } from "../datasources/hypersync.ts";
import { envioToken } from "../datasources/envio.ts";
import { getLopFills, getLopMarkets, getLopOrderbook, getPools, getRfq, getRfqs, getRolloverContracts, getRolloverFills, getRolloverOrder, getRolloverOrders, venueBaseUrl, type VenueList } from "../datasources/venue.ts";
import { chainReadFailed, envelope, firstLine, getDep, getRpc, type HandlerContext, nowSecondsOf, PERMIT2_ADDRESS, rpcProvenance, rpcWarn, unavailable, venueDepsOf, venueFailed } from "./shared.ts";
import { parseQueryFilters, type QueryFilters } from "./filters.ts";
import { handleQueryMarketPredict, handleQueryRegistry } from "./registry.ts";

/** Venue-backed resources (centralized mode) vs live-chain resources (lite-decentralized). */
const VENUE_RESOURCES = new Set(["cork-pools", "orderbook", "fills", "trading-pairs", "rollover-orders", "rfqs"]);

/** One event-derived resource's scan, shared by the HyperSync backfill AND the live-tail RPC merge
 *  so the two legs can never scan different addresses/topics or decode differently. `key` yields a
 *  stable per-row identity for de-duplicating the (block-disjoint) tail against the backfill. */
interface HsScanSpec {
  fromBlock: number;
  address: `0x${string}`[];
  topics: Array<`0x${string}`[] | null>;
  decode: (logs: HyperSyncLog[]) => Array<Record<string, unknown>>;
  postFilter: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  key: (row: Record<string, unknown>) => string;
}

/** The two JSON-RPC calls the live-tail needs — a structural subset of viem's PublicClient, so the
 *  resolved client satisfies it with no cast. blockNumber/transactionHash are nullable in the RPC
 *  log shape (pending logs); a bounded historical range never yields those, and we filter anyway. */
interface LiveTailClient {
  getBlockNumber(): Promise<bigint>;
  request(args: {
    method: "eth_getLogs";
    params: [{ fromBlock: `0x${string}`; toBlock: `0x${string}`; address: `0x${string}`[]; topics: Array<`0x${string}`[] | null> }];
  }): Promise<Array<{ address: `0x${string}`; topics: `0x${string}`[]; data: `0x${string}`; blockNumber: `0x${string}` | null; transactionHash: `0x${string}` | null }>>;
}

/** Per-token funding-allowance report on account-state reads: both spender layers, plus the
 *  Permit2-internal (user, token, spender=adapter) allowance the permit2 funding leg consumes. */
type FundingAllowances = {
  spenders: { corkAdapter: `0x${string}`; permit2: `0x${string}` };
  note: string;
  byToken: Record<string, { corkAdapter: bigint; permit2: bigint; permit2Internal: { amount: bigint; expiration: number; expired: boolean } | null }>;
};

type LiveTailResult =
  | { status: "no-rpc" } // nothing configured / a wrong-chain explicit endpoint — skip silently
  | { status: "current" } // the archive head is already at/above chain head — nothing to add
  | { status: "merged"; rows: Array<Record<string, unknown>>; headBlock: number }
  | { status: "error"; message: string }; // the RPC refused the range (disclosed, non-fatal)

/**
 * Freshness leg for full-decentralized reads: HyperSync is an ARCHIVE index whose head can trail
 * chain head, so a time-sensitive read would miss the most recent events. This scans the tail
 * (archiveHeight+1 → chain head) over the REGULAR resolved Web3 RPC (CORK_RPC_URL / --rpc-url →
 * built-in default → chainlist fallback) with the SAME address+topics+decoder, so recent blocks are
 * covered. Best-effort by design: a missing RPC or a range-capped endpoint degrades to an honest
 * warning, never a failed read — the HyperSync answer still stands. Callers gate this on a COMPLETE
 * backfill (a page-capped partial already left an interior gap, so a disjoint tail would mislead).
 */
async function fetchLiveTail(ctx: HandlerContext, chainId: ChainId, spec: HsScanSpec, archiveHeight: number): Promise<LiveTailResult> {
  let rpc: ResolvedRpc | null;
  try {
    rpc = await getRpc(ctx, chainId);
  } catch {
    return { status: "no-rpc" };
  }
  if (!rpc) return { status: "no-rpc" };
  const client: LiveTailClient = rpc.client;
  try {
    const head = Number(await client.getBlockNumber());
    if (!Number.isFinite(head) || head <= archiveHeight) return { status: "current" };
    const toHex = (n: number): `0x${string}` => `0x${n.toString(16)}`;
    // Bounded to (archiveHeight, head]: disjoint from the backfill by block number, so a small,
    // recent-only range that ordinary public RPCs serve even when they refuse deep history.
    const logs = await client.request({
      method: "eth_getLogs",
      params: [{ fromBlock: toHex(archiveHeight + 1), toBlock: toHex(head), address: spec.address, topics: spec.topics }],
    });
    const mined = logs.filter((l): l is typeof l & { blockNumber: `0x${string}`; transactionHash: `0x${string}` } => l.blockNumber !== null && l.transactionHash !== null);
    const rows = spec.postFilter(spec.decode(mined.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash }))));
    return { status: "merged", rows, headBlock: head };
  } catch (err) {
    return { status: "error", message: `live-tail eth_getLogs via ${hostOf(rpc.url)} failed: ${firstLine(err)}` };
  }
}

/**
 * full-decentralized [C12]: the event-derived subset over HyperSync, with a live-tail RPC merge for
 * freshness (see fetchLiveTail). Structural honesty: resting orders / RFQs emit no events — those
 * resources are venue-only in EVERY mode.
 */
async function handleQueryHyperSync(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  const kind = filters.kind ?? "orders";
  const structural =
    input.resource === "orderbook" || input.resource === "trading-pairs"
      ? `'${input.resource}' cannot be served in full-decentralized mode: resting orders live only at the venue (signed-but-unfilled orders emit no events, by design)`
      : input.resource === "rfqs"
        ? "'rfqs' cannot be served in full-decentralized mode: RFQ requests and answers are off-chain venue JSON that never binds and emits no events, by design — omit mode or use 'centralized'"
        : input.resource === "rollover-orders" && kind === "orders"
        ? "flows kind='orders' cannot be served in full-decentralized mode: pre-commitment rollover orders emit no events; use kind='fills' or kind='contracts', or centralized mode for the order feed"
        : null;
  if (structural) return unavailable(chainId, "mode_unavailable", structural, ctx);

  // HyperSync and HyperRPC are different Envio products with DIFFERENT tokens; the dedicated
  // var wins, ENVIO_API_TOKEN remains a shared fallback.
  const load = ctx.hyperSync ? { source: ctx.hyperSync } : await loadHyperSync(chainId, envioToken("hypersync"));
  if ("error" in load) return unavailable(chainId, "hypersync_unavailable", load.error, ctx);
  const hs = load.source;

  try {
    const hsWarnings: Array<{ code: string; message: string }> = [];
    // Build the per-resource scan ONCE (address/topics/decoder/filter); both the HyperSync backfill
    // and the live-tail RPC merge below run it, so they can never diverge.
    let spec: HsScanSpec;
    if (input.resource === "cork-pools") {
      // Scan every configured Phoenix PM on this chain (primary deployment + named profiles).
      const cfg = await resolveConfig();
      const pms = new Set<`0x${string}`>();
      const primary = cfg.defaults.deployments[String(chainId)];
      if (primary) pms.add(primary.poolManager);
      for (const profile of Object.values(cfg.defaults.deploymentProfiles?.[String(chainId)] ?? {})) pms.add(profile.poolManager);
      if (pms.size === 0) return unavailable(chainId, "unknown_deployment", `no Cork deployment configured for chainId ${chainId}`, ctx);
      spec = {
        fromBlock: 0,
        address: [...pms],
        topics: [[MARKET_CREATED_TOPIC]],
        decode: decodeMarketRows,
        postFilter: (rows) => (filters.poolId ? rows.filter((m) => String(m.poolId).toLowerCase() === filters.poolId!.toLowerCase()) : rows),
        key: (m) => `market:${String(m.poolId).toLowerCase()}`,
      };
    } else if (input.resource === "fills") {
      const lop = LOP_ADDRESSES[chainId];
      if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
      if (!filters.orderHash) {
        // OrderFilled's orderHash is NOT an indexed topic, so this scan sees the ENTIRE 1inch
        // LOP — a very high-volume address. Without an orderHash filter the rows are all of
        // 1inch's fills, not Cork's; disclose instead of presenting them as Cork activity (F15).
        hsWarnings.push({ code: "pagination_incomplete", message: "fills in full-decentralized mode scan the whole 1inch LOP (orderHash is not an indexed topic) — rows are NOT Cork-scoped; pass filters.orderHash to isolate one order, or use centralized mode for the Cork-only feed" });
      }
      spec = {
        fromBlock: 0,
        address: [lop],
        topics: [[LOP_FILLED_TOPIC]],
        decode: decodeLopFillRows,
        postFilter: (rows) => (filters.orderHash ? rows.filter((f) => String(f.orderHash).toLowerCase() === filters.orderHash!.toLowerCase()) : rows),
        key: (f) => `fill:${String(f.txHash)}:${String(f.orderHash)}:${String(f.remainingAmount)}`,
      };
    } else {
      // flows kind=fills|contracts — needs the rollover deployment (settlers/factory + seed block).
      const { rollover } = await resolveRollover(chainId);
      if (!rollover) return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId}`, ctx);
      if (kind === "fills") {
        const topics: Array<`0x${string}`[] | null> = [ROLLOVER_FILL_TOPICS];
        if (filters.orderDigest) topics.push([filters.orderDigest]);
        spec = {
          fromBlock: rollover.seededAtBlock,
          address: [rollover.exactSettler, rollover.partialSettler],
          topics,
          decode: decodeRolloverFillRows,
          postFilter: (rows) => (filters.filler ? rows.filter((f) => String(f.filler).toLowerCase() === filters.filler!.toLowerCase()) : rows),
          key: (f) => `rfill:${String(f.txHash)}:${String(f.leg)}:${String(f.orderDigest)}`,
        };
      } else {
        spec = {
          fromBlock: rollover.seededAtBlock,
          address: [rollover.factory],
          topics: [[CLONE_DEPLOYED_TOPIC]],
          decode: decodeCloneRows,
          postFilter: (rows) => (filters.account ? rows.filter((c) => String(c.owner).toLowerCase() === filters.account!.toLowerCase()) : rows),
          key: (c) => `clone:${String(c.rolloverContract).toLowerCase()}`,
        };
      }
    }

    const r = await hs.queryLogs({ fromBlock: spec.fromBlock, address: spec.address, topics: spec.topics });
    const archiveHeight = r.archiveHeight;
    // Honest completeness (F15): a HyperSync scan that hits the page bound is partial EVIDENCE,
    // never presented as the complete set — mirroring the venue path's pagination discipline.
    if (r.complete === false) {
      hsWarnings.push({ code: "pagination_incomplete", message: `the HyperSync scan hit the page bound before reaching the archive height${r.nextBlock !== undefined ? ` (stopped at block ${r.nextBlock})` : ""}; counts/items are partial evidence, not the complete set` });
    }
    let items = spec.postFilter(spec.decode(r.logs));

    // Live-tail merge [freshness]: cover blocks the archive index hasn't ingested yet by scanning
    // (archiveHeight, chain head] over the regular RPC. Only when the backfill actually reached its
    // archive head — a page-capped partial already left an interior gap, so a disjoint tail atop it
    // would mislead; that read is honestly labeled pagination_incomplete instead.
    let liveTail: { fromBlock: number; headBlock: number; merged: number } | undefined;
    if (r.complete !== false && archiveHeight !== undefined) {
      const tail = await fetchLiveTail(ctx, chainId, spec, archiveHeight);
      if (tail.status === "merged") {
        // The tail is block-disjoint from the backfill; the seen-set is a defensive guard against a
        // boundary reorg re-emitting an archived log, never the primary correctness mechanism.
        const have = new Set(items.map(spec.key));
        const fresh = tail.rows.filter((row) => !have.has(spec.key(row)));
        items = items.concat(fresh);
        liveTail = { fromBlock: archiveHeight + 1, headBlock: tail.headBlock, merged: fresh.length };
        if (fresh.length > 0) {
          hsWarnings.push({ code: "live_tail_merged", message: `merged ${fresh.length} recent event row(s) from the RPC tail (blocks ${archiveHeight + 1}–${tail.headBlock}) beyond HyperSync's archive height ${archiveHeight}; results reflect chain head, not just the indexer` });
        }
      } else if (tail.status === "error") {
        hsWarnings.push({ code: "live_tail_unavailable", message: `${tail.message} — results reflect the HyperSync archive (height ${archiveHeight}) only; blocks after it may be missing` });
      }
      // "no-rpc" (nothing configured) and "current" (archive already at/above head) add nothing, silently.
    }

    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        ...(input.resource === "rollover-orders" ? { kind } : {}),
        count: items.length,
        items,
        ...(archiveHeight !== undefined ? { archiveHeight } : {}),
        ...(liveTail ? { liveTail } : {}),
      },
      chainId,
      source: "chain",
      mode: "full-decentralized",
      warnings: hsWarnings,
      ctx,
    });
  } catch (err) {
    return unavailable(chainId, "hypersync_unavailable", `HyperSync query failed: ${firstLine(err)}`, ctx);
  }
}

// Why a venue list read can stop short of exhaustive. A repeated cursor is the venue
// contradicting itself (pointing back at a page already seen) — a genuine conflict; the
// rest are honest partial reads.
type IncompleteReason = "metadata_absent" | "cursor_absent" | "cursor_repeated" | "max_pages";

/** Venue-side notices accumulated over a traversal: in-band `warnings[]` rows (deduped — every
 *  page repeats the same deprecation entry) and the shim's canonical-path header, if any page
 *  was served by the deprecated-path rewrite. Composed once into envelope warnings by the
 *  caller — the venue's text is UNTRUSTED and always relayed under a "venue" label. */
interface VenueNotices {
  venueWarnings: Array<Record<string, unknown>>;
  deprecatedPath?: string;
}

type PageTraversalBase = VenueNotices & { items: Array<Record<string, unknown>>; pagesFetched: number };
// Discriminated so an incomplete traversal can never masquerade as complete.
type PageTraversal =
  | (PageTraversalBase & { complete: true })
  | (PageTraversalBase & { complete: false; reason: IncompleteReason; nextCursor?: string });

/** Walk an opaque venue cursor to exhaustion under a hard page bound — never silently truncating. */
export async function collectVenuePages(
  opts: { cursor?: string; pageSize: number; maxPages: number },
  fetchPage: (cursor: string | undefined) => Promise<VenueList>,
): Promise<PageTraversal> {
  const items: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const notice: VenueNotices = { venueWarnings: [] };
  const seenWarnings = new Set<string>();
  const absorb = (res: VenueList): void => {
    for (const w of res.venueWarnings ?? []) {
      const key = JSON.stringify(w);
      if (seenWarnings.has(key)) continue;
      seenWarnings.add(key);
      notice.venueWarnings.push(w);
    }
    if (res.deprecatedPath !== undefined && notice.deprecatedPath === undefined) notice.deprecatedPath = res.deprecatedPath;
  };
  let cursor = opts.cursor;
  for (let page = 1; page <= opts.maxPages; page += 1) {
    if (cursor !== undefined) {
      if (seen.has(cursor)) return { complete: false, items, pagesFetched: page - 1, reason: "cursor_repeated", nextCursor: cursor, ...notice };
      seen.add(cursor);
    }
    const res = await fetchPage(cursor);
    items.push(...res.items);
    absorb(res);
    if (!res.paginationKnown) return { complete: false, items, pagesFetched: page, reason: "metadata_absent", ...notice };
    const next = typeof res.nextCursor === "string" && res.nextCursor.length > 0 ? res.nextCursor : undefined;
    if (!(res.hasMore ?? next !== undefined)) return { complete: true, items, pagesFetched: page, ...notice };
    if (next === undefined) return { complete: false, items, pagesFetched: page, reason: "cursor_absent", ...notice };
    cursor = next;
  }
  return { complete: false, items, pagesFetched: opts.maxPages, reason: "max_pages", ...(cursor !== undefined ? { nextCursor: cursor } : {}), ...notice };
}

/** Render venue-side notices as envelope warnings: one `venue_notice` per in-band venue warning
 *  (code + message relayed verbatim under the venue label, length-capped — untrusted text is
 *  data to display, never instructions), plus one `venue_deprecated_path` when the shim served
 *  any page of the call. */
export function venueNoticeWarnings(t: { venueWarnings: Array<Record<string, unknown>>; deprecatedPath?: string }): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = [];
  for (const w of t.venueWarnings) {
    const code = typeof w.code === "string" ? w.code : "unlabeled";
    const message = typeof w.message === "string" ? w.message : JSON.stringify(w);
    out.push({ code: "venue_notice", message: `the venue attached an in-band notice [${code}]: ${message.slice(0, 400)}` });
  }
  if (t.deprecatedPath !== undefined) {
    out.push({ code: "venue_deprecated_path", message: `the venue served this call through its deprecated-path rewrite (Deprecation: true) and named the canonical path: ${t.deprecatedPath.slice(0, 200)} — the rewrite is temporary; check CORK_VENUE_URL for a stale /v1 suffix or report a stale path literal` });
  }
  return out;
}

export async function handleQuery(input: QueryInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const filters = parseQueryFilters(input.filters);

  if (VENUE_RESOURCES.has(input.resource)) {
    // Explicit full-decentralized mode: serve the EVENT-DERIVED subset over HyperSync.
    if (input.mode === "full-decentralized") {
      return handleQueryHyperSync(input, filters, chainId, ctx);
    }
    // Default/centralized: the as-built venue (api-phoenix). Mode is explicit, never a silent
    // substitute [R1/§7] — lite-decentralized cannot serve venue-only resources.
    if (input.mode !== undefined && input.mode !== "centralized") {
      return unavailable(chainId, "mode_unavailable", `cork_query('${input.resource}') is venue-backed; omit mode, use 'centralized', or use 'full-decentralized' for the event-derived subset (cork-pools, fills, flows kind=fills|contracts)`, ctx);
    }
    const deps = venueDepsOf(ctx);
    const paging = { ...(input.cursor ? { cursor: input.cursor } : {}), pageSize: input.pageSize, maxPages: input.maxPages };
    try {
      let traversal: PageTraversal;
      if (input.resource === "cork-pools") {
        traversal = await collectVenuePages(paging, async (cursor) => {
          const list = await getPools(deps, chainId, { ...(cursor ? { cursor } : {}), limit: input.pageSize });
          return filters.poolId ? { ...list, items: list.items.filter((r) => String(r.poolId).toLowerCase() === filters.poolId!.toLowerCase()) } : list;
        });
      } else if (input.resource === "orderbook") {
        traversal = await collectVenuePages(paging, async (cursor) => {
          const list = await getLopOrderbook(deps, { chainId, ...(filters.poolId ? { poolId: filters.poolId } : {}), ...(filters.side ? { side: filters.side } : {}), ...(filters.status ? { status: filters.status } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize });
          // The venue's orderbook path has no orderHash query param — filter client-side (the
          // markets/poolId pattern above) so a known filter key is never silently unapplied:
          // an "unfiltered because unsupported" read would let a caller mistake the whole book
          // for a per-order answer.
          return filters.orderHash ? { ...list, items: list.items.filter((r) => String((r as { orderHash?: unknown }).orderHash ?? "").toLowerCase() === filters.orderHash!.toLowerCase()) } : list;
        });
      } else if (input.resource === "fills") {
        traversal = await collectVenuePages(paging, (cursor) => getLopFills(deps, { chainId, ...(filters.orderHash ? { orderHash: filters.orderHash } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
      } else if (input.resource === "trading-pairs") {
        traversal = await collectVenuePages(paging, (cursor) => getLopMarkets(deps, chainId, { ...(cursor ? { cursor } : {}), limit: input.pageSize }));
      } else if (input.resource === "rfqs") {
        // Single get by id, or the discovery feed (server default: state=open, newest first).
        if (filters.rfqId) {
          const row = await getRfq(deps, filters.rfqId, filters.view);
          if (!row) return unavailable(chainId, "rfq_not_found", `RFQ '${filters.rfqId}' is unknown to the venue (a normal outcome for a never-posted or mistyped id)`, ctx);
          traversal = { complete: true, items: [row], pagesFetched: 1, venueWarnings: [] };
        } else {
          traversal = await collectVenuePages(paging, (cursor) => getRfqs(deps, {
            chainId,
            ...(filters.state ? { state: filters.state } : {}),
            ...(filters.referenceAsset ? { referenceAsset: filters.referenceAsset.toLowerCase() } : {}),
            ...(filters.account ? { requester: filters.account.toLowerCase() } : {}),
            ...(filters.withAnswers !== undefined ? { withAnswers: filters.withAnswers } : {}),
            ...(filters.view ? { view: filters.view } : {}),
            ...(cursor ? { cursor } : {}),
            limit: input.pageSize,
          }));
        }
      } else {
        // flows = the rollover venue; filters.kind picks the feed (orders default).
        const kind = filters.kind ?? "orders";
        if (kind === "orders") {
          if (filters.orderDigest) {
            const row = await getRolloverOrder(deps, filters.orderDigest);
            if (!row) return unavailable(chainId, "order_not_found", `rollover order ${filters.orderDigest} is unknown to the venue (a normal outcome for a never-posted digest)`, ctx);
            traversal = { complete: true, items: [row], pagesFetched: 1, venueWarnings: [] };
          } else {
            traversal = await collectVenuePages(paging, (cursor) => getRolloverOrders(deps, { chainId, ...(filters.account ? { user: filters.account.toLowerCase() } : {}), ...(filters.poolId ? { poolId: filters.poolId } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.fillable !== undefined ? { fillable: filters.fillable } : {}), ...(filters.source ? { source: filters.source } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
          }
        } else if (kind === "fills") {
          traversal = await collectVenuePages(paging, (cursor) => getRolloverFills(deps, { chainId, ...(filters.orderDigest ? { orderDigest: filters.orderDigest } : {}), ...(filters.filler ? { filler: filters.filler.toLowerCase() } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
        } else {
          traversal = await collectVenuePages(paging, (cursor) => getRolloverContracts(deps, { chainId, ...(filters.account ? { owner: filters.account.toLowerCase() } : {}), ...(filters.address ? { address: filters.address.toLowerCase() } : {}), ...(cursor ? { cursor } : {}), limit: input.pageSize }));
        }
      }
      return envelope({
        // A merely-partial read is honest evidence (state ok + warning); only a self-contradicting
        // venue cursor (repeated) is a conflict.
        state: !traversal.complete && traversal.reason === "cursor_repeated" ? "conflict" : "ok",
        data: {
          resource: input.resource,
          ...(input.resource === "rollover-orders" ? { kind: filters.kind ?? "orders" } : {}),
          count: traversal.items.length,
          items: traversal.items,
          pagination: {
            complete: traversal.complete,
            pagesFetched: traversal.pagesFetched,
            pageSize: input.pageSize,
            maxPages: input.maxPages,
            ...(!traversal.complete ? { reason: traversal.reason } : {}),
            ...(!traversal.complete && traversal.nextCursor ? { nextCursor: traversal.nextCursor } : {}),
          },
          ...(input.format === "full" ? { venue: venueBaseUrl(ctx.venueUrl) } : {}),
        },
        chainId,
        source: "indexer",
        warnings: [
          ...(traversal.complete
            ? []
            : [{ code: "pagination_incomplete", message: `venue traversal did not exhaust the set (${traversal.reason}); items are evidence, not a complete list${traversal.nextCursor ? ` — resume from cursor ${traversal.nextCursor}` : ""}` }]),
          ...venueNoticeWarnings(traversal),
        ],
        ctx,
      });
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  // whitelisted-addresses: event-derived enumeration (WhitelistManager's membership mappings are
  // not enumerable on-chain) — its natural mode is full-decentralized, with a live-view [K7]
  // verification leg when an RPC also resolves.
  if (input.resource === "whitelisted-addresses") {
    return handleQueryWhitelistedAddresses(input, filters, chainId, ctx);
  }

  // Data mode is explicit, never a silent fallback [R1/§7]: chain resources serve only
  // lite-decentralized (RPC). Requesting an unwired mode fails loudly instead of being ignored.
  if (input.mode !== undefined && input.mode !== "lite-decentralized") {
    return unavailable(chainId, "mode_unavailable", `data mode '${input.mode}' is not available for cork_query('${input.resource}') (a live chain read); omit mode or use 'lite-decentralized'`, ctx);
  }

  // MarketRegistry reads (registry-*) — live chain views on the registry contract.
  if (input.resource === "registry-assets" || input.resource === "registry-oracle" || input.resource === "registry-recipes" || input.resource === "registry-denominations" || input.resource === "registry-feeds") {
    return handleQueryRegistry(input, filters, chainId, ctx);
  }
  // derive-cork-pool — the registry+adapter derivation of a pool that may not exist yet.
  if (input.resource === "derive-cork-pool") {
    return handleQueryMarketPredict(input, filters, chainId, ctx);
  }
  const { dep, depWarn } = await getDep(ctx, chainId);

  // protocol-config is pure config (no RPC needed).
  if (input.resource === "protocol-config") {
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known deployment for chainId ${chainId}`, ctx);
    return envelope({ state: "ok", data: { resource: input.resource, chainId, deployment: dep, create2Deployer: CREATE2_DEPLOYER }, chainId, source: "config", warnings: depWarn, ctx });
  }

  const chainResources = new Set(["cork-pool", "account-state", "pool-whitelist"]);
  if (!chainResources.has(input.resource)) {
    // Unreachable today (every enum resource routes above) — kept so a future enum addition
    // fails honestly instead of falling into the poolId-gated chain-read path below.
    return unavailable(chainId, "needs_indexer", `cork_query('${input.resource}') requires an indexer/service backend not wired in this iteration`, ctx);
  }
  if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
  if (input.resource === "pool-whitelist" && !dep.whitelistManager) {
    return unavailable(chainId, "unknown_deployment", `whitelistManager address is not configured for chainId ${chainId} (partial deployment — read tools for market/account-state still work)`, ctx);
  }
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    return unavailable(chainId, "requires_rpc", `cork_query('${input.resource}') needs an RPC endpoint for chainId ${chainId} (none resolved: offline, or a chain with no default/fallback — set CORK_RPC_URL)`, ctx);
  }
  if (!filters.poolId) return unavailable(chainId, "missing_filter", `cork_query('${input.resource}') requires filters.poolId`, ctx);

  const client = resolved.client;
  // rpcWarn/rpcProvenance are deferred to ENVELOPE construction: the client fails over in-call
  // on a dead endpoint (mutating `resolved`), and the disclosure must describe the endpoint
  // that actually served the reads.
  const w = [...depWarn];
  const rpc = () => rpcProvenance(input.format, resolved);
  const addrs: CorkAddresses = { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter };

  try {
    if (input.resource === "cork-pool") {
      const s = await readPoolState(client, addrs, filters.poolId, ctx.atBlock);
      return envelope({
        state: "ok",
        data: {
          resource: input.resource,
          chainId,
          poolId: s.poolId,
          market: s.market,
          constraintState: s.constraintState,
          swapRate: s.onChainSwapRate,
          oracleRate: s.oracleRate,
          swapFeePercentage: s.swapFeePercentage,
          unwindSwapFeePercentage: s.unwindSwapFeePercentage,
          collateralDecimals: s.collateralDecimals,
          referenceDecimals: s.referenceDecimals,
          corkSwapToken: s.cstToken, // cST
          corkPrincipalToken: s.cptToken, // cPT
          issuedAt: s.issuedAt,
          // Unit labels on the most-read resource (footgun audit R1: swapFeePercentage at
          // 1e18=1% beside WAD rates was the single highest-risk unlabeled output — the two are
          // identically shaped and 100x apart). Same convention as the compute kinds.
          scales: {
            swapRate: "1e18 = 1.0 (WAD)",
            oracleRate: "1e18 = 1.0 (WAD)",
            swapFeePercentage: "1e18 = 1% (PERCENTAGE — not WAD; 100x apart)",
            unwindSwapFeePercentage: "1e18 = 1% (PERCENTAGE — not WAD)",
            // One key per nested struct, matching the compute precedent (`constraint: …`) —
            // slash-composite keys are not addressable by a consumer doing scales[field].
            market: "rateMin/rateMax/rateChangePerDayMax/rateChangeCapacityMax: ABSOLUTE rates, 1e18 = 1.0 (WAD)",
            constraintState: "lastAdjustedRate: 1e18 = 1.0 (WAD)",
            unitsTopic: UNITS_TOPIC_REFERENCE,
          },
        },
        chainId,
        source: "chain",
        block: s.blockNumber,
        warnings: [...rpcWarn(resolved), ...w],
        ...rpc(),
        ctx,
      });
    }

    if (input.resource === "account-state") {
      if (!filters.account) return unavailable(chainId, "missing_filter", "account-state requires filters.account", ctx);
      const tokens = await resolvePoolTokens(client, dep.poolManager, filters.poolId, ctx.atBlock);
      const blockOpt = ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {};
      const bal = (token: `0x${string}`) =>
        client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [filters.account!], ...blockOpt });
      const dec = (token: `0x${string}`) =>
        client.readContract({ address: token, abi: erc20Abi, functionName: "decimals", ...blockOpt });
      // Decimals ride along (audit R1.2): balances/allowances are native base units, and without
      // the per-role decimals a 6-dec reference balance reads 10^12 too small on an 18-dec
      // assumption. cST/cPT are always 18 (protocol invariant, same claim as the compute labels).
      const [collateral, reference, corkSwapToken, corkPrincipalToken, collateralDecimals, referenceDecimals] = await Promise.all([
        bal(tokens.collateral), bal(tokens.reference), bal(tokens.cst), bal(tokens.cpt), dec(tokens.collateral), dec(tokens.reference),
      ]);
      // Allowances that gate the funding UX [funding.ts]: erc20-approve mode pulls
      // initiator→ADAPTER (erc20TransferFrom on the adapter), permit2 mode needs the token
      // approved to the canonical Permit2. Only readable where the adapter is configured.
      let allowances: FundingAllowances | undefined;
      if (dep.corkAdapter) {
        const alw = (token: `0x${string}`, spender: `0x${string}`) =>
          client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [filters.account!, spender], ...blockOpt });
        const roles = [
          ["collateral", tokens.collateral],
          ["reference", tokens.reference],
          ["corkSwapToken", tokens.cst], // cST
          ["corkPrincipalToken", tokens.cpt], // cPT
        ] as const;
        // permit2 funding needs TWO layers: the ERC-20 approval TO Permit2 (`permit2`) AND the
        // Permit2-INTERNAL (user, token, spender=adapter) allowance with its uint48 expiry
        // (`permit2Internal`) — reporting only the first let bundles look funded and still
        // revert on a zero/expired internal allowance (F18). Internal read is best-effort
        // (null where Permit2 isn't deployed on the chain).
        const nowSecs = nowSecondsOf(ctx);
        const entries = await Promise.all(
          roles.map(async ([role, token]) => {
            const [toAdapter, toPermit2, p2] = await Promise.all([
              alw(token, dep.corkAdapter!),
              alw(token, PERMIT2_ADDRESS),
              client
                .readContract({ address: PERMIT2_ADDRESS, abi: permit2AllowanceAbi, functionName: "allowance", args: [filters.account!, token, dep.corkAdapter!], ...blockOpt })
                .catch(() => null),
            ]);
            const permit2Internal = Array.isArray(p2) && p2.length >= 2
              // Permit2's own gate is `block.timestamp > allowed.expiration` (AllowanceTransfer
              // ._transfer): spending is allowed AT the boundary second, and expiration 0 is
              // ALWAYS expired — no special case. The earlier form carved 0 out as "not expired",
              // so a hypothetical (amount>0, expiration 0) allowance read as fundable when the
              // contract would revert AllowanceExpired; and its `<=` flipped the boundary second.
              // The funding pre-flight predicts the authority, never improves on it (audit R9;
              // same fidelity ruling as the premium band).
              ? { amount: p2[0] as bigint, expiration: Number(p2[1]), expired: nowSecs > BigInt(Number(p2[1])) }
              : null;
            return [role, { corkAdapter: toAdapter, permit2: toPermit2, permit2Internal }] as const;
          }),
        );
        allowances = {
          spenders: { corkAdapter: dep.corkAdapter, permit2: PERMIT2_ADDRESS },
          note: "permit2-mode funding requires BOTH the ERC-20 approval to Permit2 (permit2) AND an unexpired Permit2-internal allowance for spender=corkAdapter (permit2Internal)",
          byToken: Object.fromEntries(entries),
        };
      } else {
        w.push({ code: "unknown_deployment", message: `corkAdapter is not configured for chainId ${chainId} — allowances (funding pre-flight) omitted; balances are complete` });
      }
      const tokensOut = { collateral: tokens.collateral, reference: tokens.reference, corkSwapToken: tokens.cst, corkPrincipalToken: tokens.cpt, expiryTimestamp: tokens.expiryTimestamp };
      const decimals = { collateral: Number(collateralDecimals), reference: Number(referenceDecimals), corkSwapToken: 18, corkPrincipalToken: 18 };
      // Pointer key is `unitsTopic`, NOT `reference`: scales maps field names to labels, and
      // `reference` IS a field here (the token role) — the pointer must never look like a label.
      const scales = { balances: "native base units of each token — convert by decimals[role]", allowances: "native base units of each token per spender (uint256.max = unlimited standing approval)", unitsTopic: UNITS_TOPIC_REFERENCE };
      return envelope({ state: "ok", data: { resource: input.resource, chainId, poolId: filters.poolId, account: filters.account, balances: { collateral, reference, corkSwapToken, corkPrincipalToken }, decimals, tokens: tokensOut, ...(allowances ? { allowances } : {}), scales }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...w], ...rpc(), ctx });
    }

    // pool-whitelist (wlm presence checked above)
    if (!filters.account) return unavailable(chainId, "missing_filter", "pool-whitelist requires filters.account", ctx);
    const isWhitelisted = await client.readContract({
      address: dep.whitelistManager!,
      abi: whitelistManagerAbi,
      functionName: "isWhitelisted",
      args: [filters.poolId, filters.account],
      ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}),
    });
    return envelope({ state: "ok", data: { resource: input.resource, chainId, poolId: filters.poolId, account: filters.account, isWhitelisted }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...w], ...rpc(), ctx });
  } catch (err) {
    return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...w], ctx, resolved);
  }
}

/**
 * whitelisted-addresses: enumerate the WhitelistManager's CURRENT membership by replaying its
 * lifecycle events (global add/remove, per-market add/remove, market enable/disable). The
 * membership mappings are NOT enumerable on-chain, so the event history is the only enumeration
 * source — served over the same HyperSync path that powers markets/fills/flows. When an RPC also
 * resolves, every derived row is re-checked against the live isGlobalWhitelisted /
 * isMarketWhitelisted views [K7: chain outranks any derivation, including our own].
 */
async function handleQueryWhitelistedAddresses(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (input.mode === "centralized") {
    return unavailable(chainId, "mode_unavailable", "'whitelisted-addresses' is chain-event-derived; the venue has no whitelist endpoint — omit mode or use 'full-decentralized'", ctx);
  }
  if (input.mode === "lite-decentralized") {
    return unavailable(chainId, "mode_unavailable", "'whitelisted-addresses' cannot be ENUMERATED over plain RPC views (the WhitelistManager stores membership in non-enumerable mappings) — omit mode or use 'full-decentralized' (HyperSync event replay); for a single-account check use resource 'pool-whitelist'", ctx);
  }
  const { dep, depWarn } = await getDep(ctx, chainId);
  if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
  if (!dep.whitelistManager) {
    return unavailable(chainId, "unknown_deployment", `whitelistManager address is not configured for chainId ${chainId} (partial deployment)`, ctx);
  }
  const load = ctx.hyperSync ? { source: ctx.hyperSync } : await loadHyperSync(chainId, envioToken("hypersync"));
  if ("error" in load) return unavailable(chainId, "hypersync_unavailable", load.error, ctx);
  try {
    const r = await load.source.queryLogs({ fromBlock: 0, address: [dep.whitelistManager], topics: [WHITELIST_TOPICS] });
    const warnings: Array<{ code: string; message: string }> = [...depWarn];
    if (r.complete === false) {
      warnings.push({ code: "pagination_incomplete", message: `the HyperSync scan hit the page bound before reaching the archive height${r.nextBlock !== undefined ? ` (stopped at block ${r.nextBlock})` : ""} — membership replayed from a PARTIAL history can be stale or wrong; treat rows as evidence, not the full set` });
    }
    const replayed = replayWhitelist(decodeWhitelistRows(r.logs));
    const wantPool = filters.poolId?.toLowerCase();
    type Row = { account: `0x${string}`; scope: "global" | "market"; poolId?: string; verified?: boolean };
    const items: Row[] = [
      // Global members ride along even under a poolId filter: isWhitelisted() admits them to
      // every gated pool, so omitting them would misreport the pool's effective allowlist.
      ...replayed.global.map((account): Row => ({ account, scope: "global" })),
      ...Object.entries(replayed.byPool)
        .filter(([poolId]) => !wantPool || poolId === wantPool)
        .flatMap(([poolId, accounts]) => accounts.map((account): Row => ({ account, scope: "market", poolId }))),
    ];
    const enabledByPool = wantPool
      ? { [wantPool]: replayed.enabledByPool[wantPool] ?? false }
      : replayed.enabledByPool;

    // [K7] live-view verification leg (best-effort): re-check every derived row against the
    // contract's own views. A disagreement is possible exactly when the scan was partial.
    const VERIFY_CAP = 200;
    let verification = "skipped (no rows, or no RPC resolved) — rows are event-derived only";
    const resolved = items.length > 0 ? await getRpc(ctx, chainId) : null;
    if (resolved && items.length <= VERIFY_CAP) {
      const wlm = { address: dep.whitelistManager, abi: whitelistManagerAbi } as const;
      try {
        const checks = await Promise.all(
          items.map((row) =>
            resolved.client.readContract(
              row.scope === "global"
                ? { ...wlm, functionName: "isGlobalWhitelisted", args: [row.account] }
                : { ...wlm, functionName: "isMarketWhitelisted", args: [row.poolId as `0x${string}`, row.account] },
            ) as Promise<boolean>,
          ),
        );
        items.forEach((row, i) => {
          row.verified = checks[i]!;
        });
        verification = "live WhitelistManager views (isGlobalWhitelisted / isMarketWhitelisted)";
        warnings.push(...rpcWarn(resolved));
        const stale = items.filter((row) => row.verified === false);
        if (stale.length > 0) {
          warnings.push({ code: "status_mismatch", message: `${stale.length} event-derived row(s) failed live-view verification (verified:false) — the chain view outranks the event replay [K7]; the scan likely missed later removal events` });
        }
      } catch (err) {
        verification = "attempted but the live views failed — rows are event-derived only";
        warnings.push({ code: "chain_read_failed", message: `live-view verification failed (${firstLine(err)}) — rows are event-derived only` });
      }
    } else if (resolved && items.length > VERIFY_CAP) {
      verification = `skipped (${items.length} rows exceeds the ${VERIFY_CAP}-row live-verification cap) — rows are event-derived only`;
    }

    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        chainId,
        whitelistManager: dep.whitelistManager,
        ...(wantPool ? { poolId: filters.poolId } : {}),
        // Semantics disclosure: a pool with NO enable event was never gated — everyone passes.
        enabledByPool,
        note: "a pool absent from enabledByPool (or false) is NOT gated: isWhitelisted() returns true for every account on it; global rows are admitted to every gated pool",
        verification,
        count: items.length,
        items,
        ...(r.archiveHeight !== undefined ? { archiveHeight: r.archiveHeight } : {}),
      },
      chainId,
      source: "chain",
      mode: "full-decentralized",
      warnings,
      ctx,
    });
  } catch (err) {
    return unavailable(chainId, "hypersync_unavailable", `HyperSync query failed: ${firstLine(err)}`, ctx);
  }
}
