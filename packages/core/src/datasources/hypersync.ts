// full-decentralized datasource [C12]: bulk-historical event queries over Envio HyperSync.
// HyperSync is backfill-only (no eth_call) — live state stays on RPC (lite-decentralized), and
// the pre-commitment venue flow (resting orders, RFQs) emits NO events and can never be served
// by any indexer, ours or Envio's. What IS event-derived: market discovery (MarketCreated),
// rollover fills (RolloverLegFilled/PremiumLegFilled/reclaims), per-user clone discovery
// (RolloverContractDeployed), and LOP fills (OrderFilled).
//
// The napi client (@envio-dev/hypersync-client) is an OPTIONAL dependency loaded dynamically:
// it has per-platform native bindings (no linux-arm64-musl build exists — see
// experiments/hypersync-spike/README.md), and a host that cannot load it gets an honest
// `hypersync_unavailable`, never a crash. Tests inject a fake source.
import { decodeEventLog, parseAbi, toEventSelector } from "viem";
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
export async function loadHyperSync(chainId: number, token: string | undefined): Promise<HyperSyncLoad> {
  const url = hyperSyncUrl(chainId);
  if (!url) return { error: `no HyperSync endpoint for chainId ${chainId}` };
  if (!token) return { error: "ENVIO_HYPERSYNC_TOKEN (or shared ENVIO_API_TOKEN) is not set — HyperSync needs one (https://app.envio.dev/api-tokens); tokenless access has been rejected since 2025-11" };
  // Structural view of the napi module. Client 1.x exposes HypersyncClient as a CONSTRUCTOR whose
  // config field is `apiToken` (the 0.x API was a static `.new({ bearerToken })` — different on both
  // counts). Verified against the pinned 1.4.0 package's shipped README + index.d.ts; a wrong shape
  // here is invisible to CI because the native binding cannot load on this arm64-musl host. One cast
  // at the import boundary — the module is untyped to us as an optional dep imported by bare name.
  interface HyperSyncNapiModule {
    HypersyncClient: new (cfg: { url: string; apiToken: string }) => {
      get: (q: unknown) => Promise<{ data: { logs: Array<Record<string, unknown>> }; archiveHeight?: number; nextBlock?: number }>;
    };
    LogField: Record<string, string>;
  }
  let mod: HyperSyncNapiModule;
  try {
    const name = "@envio-dev/hypersync-client";
    mod = (await import(name)) as HyperSyncNapiModule;
  } catch (err) {
    return { error: `the @envio-dev/hypersync-client native binding could not load on this host (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — see experiments/hypersync-spike/README.md for platform coverage` };
  }
  const client = new mod.HypersyncClient({ url, apiToken: token });
  const F = mod.LogField;
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
            fieldSelection: { log: [F.Address, F.Topic0, F.Topic1, F.Topic2, F.Topic3, F.Data, F.BlockNumber, F.TransactionHash] },
          });
          return {
            logs: res.data.logs.map((l) => ({
              address: String(l.address),
              topics: [l.topic0, l.topic1, l.topic2, l.topic3].map((t) => (t == null ? null : String(t))),
              data: String(l.data ?? "0x"),
              blockNumber: Number(l.blockNumber ?? 0),
              transactionHash: String(l.transactionHash ?? "0x"),
            })),
            ...(res.archiveHeight !== undefined ? { archiveHeight: res.archiveHeight } : {}),
            ...(res.nextBlock !== undefined ? { nextBlock: res.nextBlock } : {}),
          };
        });
      },
    },
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

export const MARKET_CREATED_TOPIC = toEventSelector("MarketCreated(bytes32,address,address,uint256,address,address,address)");
export const CLONE_DEPLOYED_TOPIC = toEventSelector("RolloverContractDeployed(address,address)");
export const ROLLOVER_FILL_TOPICS = [
  toEventSelector("RolloverLegFilled(bytes32,address,bytes32,uint256,uint256)"),
  toEventSelector("PremiumLegFilled(bytes32,address,address,bytes32,uint256)"),
  toEventSelector("DefaulterResidualReclaimed(bytes32,address,address,uint256)"),
];
export const LOP_FILLED_TOPIC = toEventSelector("OrderFilled(bytes32,uint256)");

function strictTopics(l: HyperSyncLog): [Hex, ...Hex[]] {
  return l.topics.filter((t): t is string => t != null) as [Hex, ...Hex[]];
}

function meta(l: HyperSyncLog) {
  // blockNumber rides as a decimal string — chain integers are strings on the wire (F10).
  return { blockNumber: String(l.blockNumber), txHash: l.transactionHash, emitter: l.address };
}

export function decodeMarketRows(logs: HyperSyncLog[]): Array<Record<string, unknown>> {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: marketCreatedAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ poolId: d.args.id, referenceAsset: d.args.referenceAsset, collateralAsset: d.args.collateralAsset, expiry: d.args.expiry.toString(), rateOracle: d.args.rateOracle, corkPrincipalToken: d.args.principalToken, corkSwapToken: d.args.swapToken, poolManager: l.address, ...meta(l) }];
    } catch {
      return [];
    }
  });
}

export function decodeCloneRows(logs: HyperSyncLog[]): Array<Record<string, unknown>> {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: cloneDeployedAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ owner: d.args.user, rolloverContract: d.args.rolloverContract, factory: l.address, ...meta(l) }];
    } catch {
      return [];
    }
  });
}

export function decodeRolloverFillRows(logs: HyperSyncLog[]): Array<Record<string, unknown>> {
  return logs.flatMap((l): Array<Record<string, unknown>> => {
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

export function decodeLopFillRows(logs: HyperSyncLog[]): Array<Record<string, unknown>> {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: lopFilledAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ orderHash: d.args.orderHash, remainingAmount: d.args.remainingAmount.toString(), lop: l.address, ...meta(l) }];
    } catch {
      return [];
    }
  });
}

export type { Address as HsAddress };
