// full-decentralized datasource [C12]: bulk-historical event queries over Envio HyperSync.
// HyperSync is backfill-only (no eth_call) — live state stays on RPC (lite-decentralized), and
// the pre-commitment venue flow (resting orders, RFQs) emits NO events and can never be served
// by any indexer, ours or Envio's. What IS event-derived: market discovery (MarketCreated),
// rollover fills (RolloverLegFilled/PremiumLegFilled/reclaims), per-user clone discovery
// (RolloverContractDeployed), and LOP fills (OrderFilled).
//
// The napi client (@envio-dev/hypersync-client) is OPTIONAL: a host that cannot load it gets an
// honest `hypersync_unavailable`, never a crash, and tests inject a fake source. Two ways in:
//  - a compiled release binary EMBEDS its target's native binding — scripts/compile-binaries.mjs
//    stamps the platform package's `.node` specifier as the build-time constant
//    CH_HYPERSYNC_BINDING and Bun bundles that one file (extracted to the OS temp dir and
//    dlopen'd on first load). Targets without a binding (Envio deprecated Windows at client
//    1.1.0 — commit dcdab8f, 2026-02-25 — and has never built linux-arm64-musl) leave it
//    undefined and answer with a target-specific reason. Before 0.4.1 the
//    bare image could never serve full-decentralized mode: the package was imported by name
//    and no node_modules exists inside a compiled binary (found by ops, 2026-08-20).
//  - a source run imports the package by NAME; its own loader picks the binding at runtime
//    (setting CH_HYPERSYNC_BINDING to a `.node` path in the environment overrides that).
import { decodeEventLog, parseAbi, toEventSelector } from "viem";
import { BUILD_TARGET, HYPERSYNC_BINDING } from "../version.ts";
import { hyperSyncUrl } from "./envio.ts";

type Hex = `0x${string}`;
type Address = `0x${string}`;

export interface HyperSyncLog {
  address: string;
  topics: Array<string | null>;
  data: string;
  blockNumber: number;
  transactionHash: string;
}

export interface HyperSyncLogsQuery {
  fromBlock: number;
  address?: string[];
  topics?: Array<string[] | null>;
}

/** Narrow client-agnostic surface — the napi client adapts to it; tests inject a fake.
 *  `complete` is false when the scan stopped before the archive height (page cap) — omitting it
 *  means complete, so simple injected fakes stay valid. `nextBlock` is the resume point. */
export interface HyperSyncSource {
  queryLogs(q: HyperSyncLogsQuery): Promise<{ logs: HyperSyncLog[]; archiveHeight?: number; complete?: boolean; nextBlock?: number }>;
}

/** Hard bound on HyperSync pages walked per query — mirrors the venue-path bounded traversal;
 *  hitting it yields an HONEST partial (complete:false + nextBlock), never silent truncation. */
export const HYPERSYNC_MAX_PAGES = 20;

/** One HyperSync response page: the logs it carried, the archive head (once known), and the
 *  server's resume point (`nextBlock`). Omitting `nextBlock` means "no more pages". */
export interface HyperSyncPage {
  logs: HyperSyncLog[];
  archiveHeight?: number;
  nextBlock?: number;
}

/**
 * Walk HyperSync pages from `fromBlock`, accumulating logs, under a hard page bound. Pure and
 * transport-agnostic: `getPage(fromBlock)` fetches one page (the napi client in production, a fake
 * in tests). Termination — any of: the server stops advancing (`nextBlock` absent, or not past the
 * cursor), the resume point passes the archive height (we've read everything), or the page cap is
 * hit (an HONEST `complete:false` + `nextBlock` to resume, never a silent truncation).
 */
export async function collectPagedLogs(
  fromBlock: number,
  getPage: (fromBlock: number) => Promise<HyperSyncPage>,
  maxPages = HYPERSYNC_MAX_PAGES,
): Promise<{ logs: HyperSyncLog[]; archiveHeight?: number; complete: boolean; nextBlock?: number }> {
  const logs: HyperSyncLog[] = [];
  let cursor = fromBlock;
  let archiveHeight: number | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await getPage(cursor);
    logs.push(...res.logs);
    if (res.archiveHeight !== undefined) archiveHeight = res.archiveHeight;
    const next = res.nextBlock;
    if (next === undefined || next <= cursor || (archiveHeight !== undefined && next > archiveHeight)) {
      return { logs, ...(archiveHeight !== undefined ? { archiveHeight } : {}), complete: true };
    }
    cursor = next;
  }
  return { logs, ...(archiveHeight !== undefined ? { archiveHeight } : {}), complete: false, nextBlock: cursor };
}

export type HyperSyncLoad = { source: HyperSyncSource } | { error: string };

/**
 * Load the real napi client for a chain. Every failure mode is a typed reason:
 * unsupported chain, missing token, or an unloadable native binding on this host.
 */
/** Tokenless fallback: a HyperSyncSource built from windowed eth_getLogs over an ordinary RPC —
 *  slow-but-free where HyperSync is token-gated. Bounded honestly: at most MAX_WINDOWS ranges
 *  per call, adaptive window shrink when the endpoint refuses a range, and a partial walk
 *  returns complete:false + nextBlock so the standard pagination_incomplete honesty applies.
 *  NOT a substitute where correctness needs FULL history in one answer (the whitelist replay
 *  derives membership from every event — a capped walk there would fabricate verdicts). */
export const WINDOWED_RPC_WINDOW_BLOCKS = 50_000;
export const WINDOWED_RPC_MAX_WINDOWS = 20;

interface WindowedRpcClient {
  getBlockNumber(): Promise<bigint>;
  request(args: { method: "eth_getLogs"; params: [Record<string, unknown>] }): Promise<Array<{ address: string; topics: string[]; data: string; blockNumber: string | null; transactionHash: string | null }>>;
}

export function windowedRpcSource(client: WindowedRpcClient): HyperSyncSource {
  return {
    async queryLogs(q) {
      const head = Number(await client.getBlockNumber());
      const toHex = (n: number): `0x${string}` => `0x${n.toString(16)}`;
      const logs: HyperSyncLog[] = [];
      let from = q.fromBlock;
      let window = WINDOWED_RPC_WINDOW_BLOCKS;
      let windows = 0;
      while (from <= head && windows < WINDOWED_RPC_MAX_WINDOWS) {
        const to = Math.min(from + window - 1, head);
        try {
          const raw = await client.request({
            method: "eth_getLogs",
            params: [{ fromBlock: toHex(from), toBlock: toHex(to), ...(q.address ? { address: q.address } : {}), ...(q.topics ? { topics: q.topics } : {}) }],
          });
          for (const l of raw) {
            if (l.blockNumber === null || l.transactionHash === null) continue;
            logs.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash });
          }
          from = to + 1;
          windows += 1;
        } catch (err) {
          // Range refused: shrink and retry — public endpoints cap ranges differently. A window
          // already at the floor is a real failure and propagates (the handler attributes it).
          if (window > 2_000) {
            window = Math.max(2_000, Math.floor(window / 5));
            continue;
          }
          throw err;
        }
      }
      return { logs, archiveHeight: head, ...(from <= head ? { complete: false as const, nextBlock: from } : {}) };
    },
  };
}

// Structural view of the napi module. Client 1.x exposes HypersyncClient as a CONSTRUCTOR whose
// config field is `apiToken` (the 0.x API was a static `.new({ bearerToken })` — different on both
// counts). LIVE-verified against the real 1.4.0 client (glibc container, 2026-07-27): `LogField`
// is a TYPE-only string union in 1.4.0 (`module.exports.LogField` is an empty napi object at
// runtime), so field selection must use the literal strings from index.d.ts — the old
// `F.Address`-style lookups silently produced `[undefined…]`. One cast at the import boundary —
// the module is untyped to us (an optional dep; the platform `.node` exports the same surface
// the package's index.js re-exports).
interface HyperSyncNapiModule {
  HypersyncClient: new (cfg: { url: string; apiToken: string }) => {
    get: (q: unknown) => Promise<{ data: { logs: Array<Record<string, unknown>> }; archiveHeight?: number; nextBlock?: number }>;
  };
}

/**
 * Why a compiled binary cannot serve HyperSync at all — null when it can, and null for a source
 * run (there the package's own loader decides at import time). Pure: `target` is the build
 * target, `embedded` the embedded binding's specifier (HYPERSYNC_BINDING; null when none).
 */
export function hyperSyncBindingGap(target: string, embedded: string | null): string | null {
  if (!target || embedded) return null;
  return `this ${target} build carries no HyperSync binding — Envio deprecated its Windows bindings at client 1.1.0 and has never built linux-arm64-musl; use a glibc Linux, musl x64, or macOS build for full-decentralized reads`;
}

async function importNapiModule(): Promise<HyperSyncNapiModule> {
  // The literal `process.env.CH_HYPERSYNC_BINDING` is the define boundary: the bundler
  // substitutes it in BOTH places below, which makes the require static and the binding
  // embedded. Do not hoist it into a shared constant — a cross-module const is not guaranteed to
  // fold before the bundler resolves the specifier.
  if (process.env.CH_HYPERSYNC_BINDING) return require(process.env.CH_HYPERSYNC_BINDING) as HyperSyncNapiModule;
  const name = "@envio-dev/hypersync-client";
  return (await import(name)) as HyperSyncNapiModule;
}

export async function loadHyperSync(chainId: number, token: string | undefined): Promise<HyperSyncLoad> {
  const url = hyperSyncUrl(chainId);
  if (!url) return { error: `no HyperSync endpoint for chainId ${chainId}` };
  if (!token) return { error: "ENVIO_HYPERSYNC_TOKEN (or shared ENVIO_API_TOKEN) is not set — HyperSync needs one (https://app.envio.dev/api-tokens); tokenless access has been rejected since 2025-11" };
  const gap = hyperSyncBindingGap(BUILD_TARGET, HYPERSYNC_BINDING);
  if (gap) return { error: gap };
  let mod: HyperSyncNapiModule;
  try {
    mod = await importNapiModule();
  } catch (err) {
    return { error: `the @envio-dev/hypersync-client native binding could not load on this host (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — a compiled binary extracts its embedded binding to the OS temp dir (TMPDIR) on first load; Envio ships bindings for glibc Linux x64/arm64, musl Linux x64, and macOS` };
  }
  const client = new mod.HypersyncClient({ url, apiToken: token });
  // Literal LogField union members per the shipped 1.4.0 index.d.ts.
  const LOG_FIELDS = ["Address", "Topic0", "Topic1", "Topic2", "Topic3", "Data", "BlockNumber", "TransactionHash"];
  return {
    source: {
      // HyperSync answers are PAGED: each response carries `nextBlock`, the resume point. This
      // closure is now JUST the transport (one napi page → a normalized HyperSyncPage); the
      // page-walk, completeness, and page-cap honesty live in the pure collectPagedLogs (F15).
      async queryLogs(q) {
        return collectPagedLogs(q.fromBlock, async (fromBlock) => {
          const res = await client.get({
            fromBlock,
            logs: [{ ...(q.address ? { address: q.address } : {}), ...(q.topics ? { topics: q.topics } : {}) }],
            fieldSelection: { log: LOG_FIELDS },
          });
          return {
            logs: res.data.logs.map(normalizeNapiLog),
            ...(res.archiveHeight !== undefined ? { archiveHeight: res.archiveHeight } : {}),
            ...(res.nextBlock !== undefined ? { nextBlock: res.nextBlock } : {}),
          };
        });
      },
    },
  };
}

/**
 * Normalize one napi-client log row to our HyperSyncLog. The 1.4.0 client returns a `topics`
 * ARRAY (`Array<string | undefined | null>`, per its index.d.ts Log type) — NOT the `topic0..3`
 * scalar fields the 0.x shape used. Both shapes are accepted: the old mapping read `l.topic0` of
 * a 1.4.0 row as undefined×4, so every decode failed and every full-decentralized read returned
 * an empty-but-"ok" result. LIVE-verified against Arbitrum MarketCreated logs (2026-07-27).
 */
export function normalizeNapiLog(l: Record<string, unknown>): HyperSyncLog {
  const topics = Array.isArray(l.topics)
    ? l.topics.map((t) => (t == null ? null : String(t)))
    : [l.topic0, l.topic1, l.topic2, l.topic3].map((t) => (t == null ? null : String(t)));
  while (topics.length < 4) topics.push(null);
  return {
    address: String(l.address),
    topics,
    data: String(l.data ?? "0x"),
    blockNumber: Number(l.blockNumber ?? 0),
    transactionHash: String(l.transactionHash ?? "0x"),
  };
}

// ── Event decoding (signatures validated on-chain / against the pinned repos) ──────────────────

const marketCreatedAbi = parseAbi([
  "event MarketCreated(bytes32 indexed id, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken)",
]);
const cloneDeployedAbi = parseAbi(["event RolloverContractDeployed(address indexed user, address indexed rolloverContract)"]);
const rolloverFillAbis = parseAbi([
  "event RolloverLegFilled(bytes32 indexed orderDigest, address indexed filler, bytes32 indexed subFiller, uint256 srcCstProvided, uint256 dstCstProduced)",
  "event PremiumLegFilled(bytes32 indexed orderDigest, address indexed premiumPayer, address indexed rolloverFiller, bytes32 subFiller, uint256 premium)",
  "event DefaulterResidualReclaimed(bytes32 indexed orderId, address indexed defaulterFiller, address indexed recipientRolloverContract, uint256 amount)",
]);
const lopFilledAbi = parseAbi(["event OrderFilled(bytes32 orderHash, uint256 remainingAmount)"]);
// The canonical ERC-20 Transfer — the join key that Cork-scopes the LOP fill feed: every Cork
// order has a pool share token on one side by construction, so a transaction that both fills a
// LOP order and moves a Cork share token is a Cork fill (JIT mints included: the mint is a
// Transfer from the zero address in the same transaction).
const erc20TransferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
// WhitelistManager events, verbatim from phoenix IWhitelistManager.sol: the membership
// mappings are NOT enumerable on-chain, so these six events are the only enumeration source.
const whitelistAbi = parseAbi([
  "event GlobalWhitelistAdded(address indexed account)",
  "event GlobalWhitelistRemoved(address indexed account)",
  "event MarketWhitelistAdded(bytes32 indexed poolId, address account)",
  "event MarketWhitelistRemoved(bytes32 indexed poolId, address account)",
  "event MarketWhitelistDisabled(bytes32 indexed poolId)",
  "event MarketWhitelistEnabled(bytes32 indexed poolId)",
]);

// Topic selectors DERIVED from the parsed declarations above — never a second hand-written
// compact string. The filter topic and the decode ABI must agree byte-for-byte or the stream
// silently filters for events the decoder then rejects; deriving one from the other makes that
// drift structurally impossible (each signature used to be maintained twice in this file).
export const MARKET_CREATED_TOPIC = toEventSelector(marketCreatedAbi[0]);
export const CLONE_DEPLOYED_TOPIC = toEventSelector(cloneDeployedAbi[0]);
export const ROLLOVER_FILL_TOPICS = rolloverFillAbis.map((e) => toEventSelector(e));
export const LOP_FILLED_TOPIC = toEventSelector(lopFilledAbi[0]);
export const ERC20_TRANSFER_TOPIC = toEventSelector(erc20TransferAbi[0]);
export const WHITELIST_TOPICS = whitelistAbi.map((e) => toEventSelector(e));

function strictTopics(l: HyperSyncLog): [Hex, ...Hex[]] {
  return l.topics.filter((t): t is string => t != null) as [Hex, ...Hex[]];
}

/** Fields every decoded row carries. blockNumber rides as a decimal string — chain integers are
 *  strings on the wire (F10). Row types below are type aliases (not interfaces) so their implicit
 *  index signatures keep them assignable to the generic row plumbing (Record<string, unknown>). */
export type LogMeta = {
  blockNumber: string;
  txHash: string;
  emitter: string;
};

function meta(l: HyperSyncLog): LogMeta {
  return { blockNumber: String(l.blockNumber), txHash: l.transactionHash, emitter: l.address };
}

/** One MarketCreated event: a cork-pool coming into existence on a pool manager. */
export type MarketRow = LogMeta & {
  poolId: Hex;
  referenceAsset: Address;
  collateralAsset: Address;
  expiry: string;
  rateOracle: Address;
  corkPrincipalToken: Address;
  corkSwapToken: Address;
  poolManager: string;
};

/** One RolloverContractDeployed event from the rollover factory. */
export type CloneRow = LogMeta & {
  owner: Address;
  rolloverContract: Address;
  factory: string;
};

/** One settled rollover leg, discriminated on `leg` — the three settler events differ in shape. */
export type RolloverFillRow = LogMeta & { orderDigest: Hex; filler: Address } & (
  | { leg: "ROLLOVER"; subFiller: Address; srcCstProvided: string; dstCstProduced: string }
  | { leg: "PREMIUM"; subFiller: Address; premiumPayer: Address; premium: string }
  | { leg: "RECLAIM"; recipientRolloverContract: Address; amount: string }
);

/** One 1inch LOP OrderFilled event. */
export type LopFillRow = LogMeta & {
  orderHash: Hex;
  remainingAmount: string;
  lop: string;
};

export function decodeMarketRows(logs: HyperSyncLog[]): MarketRow[] {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: marketCreatedAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ poolId: d.args.id, referenceAsset: d.args.referenceAsset, collateralAsset: d.args.collateralAsset, expiry: d.args.expiry.toString(), rateOracle: d.args.rateOracle, corkPrincipalToken: d.args.principalToken, corkSwapToken: d.args.swapToken, poolManager: l.address, ...meta(l) }];
    } catch {
      return [];
    }
  });
}

export function decodeCloneRows(logs: HyperSyncLog[]): CloneRow[] {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: cloneDeployedAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ owner: d.args.user, rolloverContract: d.args.rolloverContract, factory: l.address, ...meta(l) }];
    } catch {
      return [];
    }
  });
}

export function decodeRolloverFillRows(logs: HyperSyncLog[]): RolloverFillRow[] {
  return logs.flatMap((l): RolloverFillRow[] => {
    try {
      const d = decodeEventLog({ abi: rolloverFillAbis, topics: strictTopics(l), data: l.data as Hex });
      if (d.eventName === "RolloverLegFilled") {
        return [{ leg: "ROLLOVER", orderDigest: d.args.orderDigest, filler: d.args.filler, subFiller: d.args.subFiller, srcCstProvided: d.args.srcCstProvided.toString(), dstCstProduced: d.args.dstCstProduced.toString(), ...meta(l) }];
      }
      if (d.eventName === "PremiumLegFilled") {
        return [{ leg: "PREMIUM", orderDigest: d.args.orderDigest, premiumPayer: d.args.premiumPayer, filler: d.args.rolloverFiller, subFiller: d.args.subFiller, premium: d.args.premium.toString(), ...meta(l) }];
      }
      return [{ leg: "RECLAIM", orderDigest: d.args.orderId, filler: d.args.defaulterFiller, recipientRolloverContract: d.args.recipientRolloverContract, amount: d.args.amount.toString(), ...meta(l) }];
    } catch {
      return [];
    }
  });
}

/** One ERC-20 Transfer touching a Cork share token — the raw material of the fills join. */
export type ShareTransferRow = LogMeta & {
  token: Address;
  from: Address;
  to: Address;
  value: string;
};

export function decodeShareTransferRows(logs: HyperSyncLog[]): ShareTransferRow[] {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: erc20TransferAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ token: l.address as Address, from: d.args.from, to: d.args.to, value: d.args.value.toString(), ...meta(l) }];
    } catch {
      return [];
    }
  });
}

export function decodeLopFillRows(logs: HyperSyncLog[]): LopFillRow[] {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: lopFilledAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ orderHash: d.args.orderHash, remainingAmount: d.args.remainingAmount.toString(), lop: l.address, ...meta(l) }];
    } catch {
      return [];
    }
  });
}

/** One decoded WhitelistManager lifecycle event, in log order. */
export interface WhitelistEventRow {
  type: "global-added" | "global-removed" | "market-added" | "market-removed" | "market-enabled" | "market-disabled";
  account?: Address;
  poolId?: Hex;
  blockNumber: string;
  txHash: string;
  emitter: string;
}

export function decodeWhitelistRows(logs: HyperSyncLog[]): WhitelistEventRow[] {
  return logs.flatMap((l): WhitelistEventRow[] => {
    try {
      const d = decodeEventLog({ abi: whitelistAbi, topics: strictTopics(l), data: l.data as Hex });
      switch (d.eventName) {
        case "GlobalWhitelistAdded":
          return [{ type: "global-added", account: d.args.account, ...meta(l) }];
        case "GlobalWhitelistRemoved":
          return [{ type: "global-removed", account: d.args.account, ...meta(l) }];
        case "MarketWhitelistAdded":
          return [{ type: "market-added", poolId: d.args.poolId, account: d.args.account, ...meta(l) }];
        case "MarketWhitelistRemoved":
          return [{ type: "market-removed", poolId: d.args.poolId, account: d.args.account, ...meta(l) }];
        case "MarketWhitelistEnabled":
          return [{ type: "market-enabled", poolId: d.args.poolId, ...meta(l) }];
        default:
          return [{ type: "market-disabled", poolId: d.args.poolId, ...meta(l) }];
      }
    } catch {
      return [];
    }
  });
}

/** The current whitelist state replayed from the full event history (last event wins). */
export interface WhitelistReplay {
  /** Accounts on the GLOBAL whitelist (admitted to every gated pool). */
  global: Address[];
  /** Per-pool market whitelist membership. */
  byPool: Record<string, Address[]>;
  /** Per-pool gating flag; a pool with NO enable/disable event was never gated (isWhitelisted
   *  returns true for everyone on it). */
  enabledByPool: Record<string, boolean>;
}

/**
 * Replay add/remove/enable events into the CURRENT membership sets. Rows must be in log order —
 * HyperSync returns logs chronologically and collectPagedLogs appends pages in ascending block
 * order, so the decoded array order IS the chain order; the last event per (scope, account) wins,
 * mirroring the contract's last-write-wins mappings.
 */
export function replayWhitelist(rows: WhitelistEventRow[]): WhitelistReplay {
  const global = new Map<string, Address>();
  const byPool = new Map<string, Map<string, Address>>();
  const enabled = new Map<string, boolean>();
  for (const r of rows) {
    if (r.type === "global-added") global.set(r.account!.toLowerCase(), r.account!);
    else if (r.type === "global-removed") global.delete(r.account!.toLowerCase());
    else if (r.type === "market-enabled") enabled.set(r.poolId!.toLowerCase(), true);
    else if (r.type === "market-disabled") enabled.set(r.poolId!.toLowerCase(), false);
    else {
      const key = r.poolId!.toLowerCase();
      const pool = byPool.get(key) ?? new Map<string, Address>();
      if (r.type === "market-added") pool.set(r.account!.toLowerCase(), r.account!);
      else pool.delete(r.account!.toLowerCase());
      byPool.set(key, pool);
    }
  }
  return {
    global: [...global.values()],
    byPool: Object.fromEntries([...byPool.entries()].map(([k, v]) => [k, [...v.values()]])),
    enabledByPool: Object.fromEntries(enabled),
  };
}

export type { Address as HsAddress };
