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

type Hex = `0x${string}`;
type Address = `0x${string}`;

/** Envio HyperSync endpoints per chain (token required since 2025-11-03). */
export const HYPERSYNC_URLS: Record<number, string> = {
  1: "https://eth.hypersync.xyz",
  42161: "https://arbitrum.hypersync.xyz",
  8453: "https://base.hypersync.xyz",
  11155111: "https://sepolia.hypersync.xyz",
};

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

/** Narrow client-agnostic surface — the napi client adapts to it; tests inject a fake. */
export interface HyperSyncSource {
  queryLogs(q: HyperSyncLogsQuery): Promise<{ logs: HyperSyncLog[]; archiveHeight?: number }>;
}

export type HyperSyncLoad = { source: HyperSyncSource } | { error: string };

/**
 * Load the real napi client for a chain. Every failure mode is a typed reason:
 * unsupported chain, missing token, or an unloadable native binding on this host.
 */
export async function loadHyperSync(chainId: number, token: string | undefined): Promise<HyperSyncLoad> {
  const url = HYPERSYNC_URLS[chainId];
  if (!url) return { error: `no HyperSync endpoint for chainId ${chainId}` };
  if (!token) return { error: "ENVIO_HYPERSYNC_TOKEN (or shared ENVIO_API_TOKEN) is not set — HyperSync needs one (https://app.envio.dev/api-tokens); tokenless access has been rejected since 2025-11" };
  let mod: {
    HypersyncClient: { new(opts: { url: string; bearerToken: string }): unknown };
    LogField: Record<string, string>;
  };
  try {
    const name = "@envio-dev/hypersync-client";
    mod = (await import(name)) as never;
  } catch (err) {
    return { error: `the @envio-dev/hypersync-client native binding could not load on this host (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — see experiments/hypersync-spike/README.md for platform coverage` };
  }
  const client = (mod.HypersyncClient as unknown as { new: (o: { url: string; bearerToken: string }) => { get: (q: unknown) => Promise<{ data: { logs: Array<Record<string, unknown>> }; archiveHeight?: number }> } }).new({ url, bearerToken: token });
  const F = mod.LogField;
  return {
    source: {
      async queryLogs(q) {
        const res = await client.get({
          fromBlock: q.fromBlock,
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
        };
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
  return { blockNumber: l.blockNumber, txHash: l.transactionHash, emitter: l.address };
}

export function decodeMarketRows(logs: HyperSyncLog[]): Array<Record<string, unknown>> {
  return logs.flatMap((l) => {
    try {
      const d = decodeEventLog({ abi: marketCreatedAbi, topics: strictTopics(l), data: l.data as Hex });
      return [{ poolId: d.args.id, referenceAsset: d.args.referenceAsset, collateralAsset: d.args.collateralAsset, expiry: d.args.expiry.toString(), rateOracle: d.args.rateOracle, principalToken: d.args.principalToken, swapToken: d.args.swapToken, poolManager: l.address, ...meta(l) }];
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
