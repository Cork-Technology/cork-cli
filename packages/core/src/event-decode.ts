// Known-event decoding for cork_decode event/receipt: label a raw log (topics + data) against
// the Cork protocol's verified ABI set and return NAMED args. Reconstructs from the bytes;
// never trusts a caller-supplied parse [K3]. Coverage is exactly the declarations verified
// verbatim against the pinned sources (phoenix-private, rollover-private @ 032d3e5a, 1inch
// limit-order-protocol) — events whose INDEXED layout is not source-verified (the JIT adapter
// pair, ERC-7683 Open) are labeled name-only with raw bytes preserved rather than guessed.
import { decodeEventLog, parseAbi } from "viem";
import { JIT_EVENTS } from "./market-registry.ts";

type Hex = `0x${string}`;

/** Every event with a SOURCE-VERIFIED full declaration (indexed layout included). */
export const KNOWN_EVENTS_ABI = parseAbi([
  // phoenix-private: pool lifecycle + whitelist (IPoolManager / IWhitelistManager)
  "event MarketCreated(bytes32 indexed id, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken)",
  "event GlobalWhitelistAdded(address indexed account)",
  "event GlobalWhitelistRemoved(address indexed account)",
  "event MarketWhitelistAdded(bytes32 indexed poolId, address account)",
  "event MarketWhitelistRemoved(bytes32 indexed poolId, address account)",
  "event MarketWhitelistDisabled(bytes32 indexed poolId)",
  "event MarketWhitelistEnabled(bytes32 indexed poolId)",
  // rollover-private @ 032d3e5a: settler lifecycle (ISettler / IPartialSettler) + clone factory
  "event OrderSettled(bytes32 indexed orderId)",
  "event OrderExpired(bytes32 indexed orderId)",
  "event OrderCancelled(bytes32 indexed orderId)",
  "event OrderClosing(bytes32 indexed orderId)",
  "event RolloverLegFilled(bytes32 indexed orderDigest, address indexed filler, bytes32 indexed subFiller, uint256 srcCstProvided, uint256 dstCstProduced)",
  "event PremiumLegFilled(bytes32 indexed orderDigest, address indexed premiumPayer, address indexed rolloverFiller, bytes32 subFiller, uint256 premium)",
  "event SrcCstRefunded(bytes32 indexed orderDigest, address indexed filler, bytes32 indexed subFiller, uint256 reportedSrcLeftover)",
  "event DefaulterResidualReclaimed(bytes32 indexed orderId, address indexed defaulterFiller, address indexed recipientRolloverContract, uint256 amount)",
  "event DefaulterResidualReclaimedWithSubFiller(bytes32 indexed orderId, address indexed defaulterFiller, bytes32 indexed subFiller, address recipientRolloverContract, uint256 amount)",
  "event FillerSettled(bytes32 indexed orderId, address indexed filler, bytes32 indexed subFiller, uint256 residual)",
  "event RolloverContractDeployed(address indexed user, address indexed rolloverContract)",
  // 1inch LOP v4 (IOrderMixin) — fills (no indexed params)
  "event OrderFilled(bytes32 orderHash, uint256 remainingAmount)",
  // ERC-20 (universal layout) — makes receipt decodes show the token flows around Cork events
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

/** LOP OrderCancelled(bytes32 orderHash) shares topic0 with the settlers' OrderCancelled(bytes32
 *  indexed orderId) — indexed-ness does not change the selector. The settler form (2 topics)
 *  lives in KNOWN_EVENTS_ABI; when its strict decode fails on a 1-topic log, this fallback
 *  decodes the LOP form (hash in data, not topics). */
const LOP_CANCELLED_FALLBACK_ABI = parseAbi(["event OrderCancelled(bytes32 orderHash)"]);

export interface RawLogLike {
  address?: string;
  topics: Array<string | null | undefined>;
  data?: string;
}

export type DecodedLogRow =
  | { known: true; event: string; args: Record<string, unknown>; address?: string; topic0: Hex }
  | { known: false; event: string | null; address?: string; topic0: Hex | null; topics: Hex[]; data: Hex; note: string };

/** jsonSafe-lite for event args: bigint → decimal string (envelope jsonSafe would also handle
 *  this, but the rows are typed data other modules may reuse directly). */
function argsSafe(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
}

/** Decode one raw log against the known ABI set. Never throws: unknown or malformed logs come
 *  back as `known:false` with the raw bytes preserved (a decoder that hides logs is a footgun —
 *  same rule as the calldata decoder). */
export function decodeKnownLog(log: RawLogLike): DecodedLogRow {
  const topics = log.topics.filter((t): t is string => typeof t === "string" && t.startsWith("0x")) as Hex[];
  const data = (typeof log.data === "string" && log.data.startsWith("0x") ? log.data : "0x") as Hex;
  const topic0 = topics[0] ?? null;
  const addr = log.address !== undefined ? { address: log.address } : {};
  if (!topic0) {
    return { known: false, event: null, ...addr, topic0: null, topics, data, note: "log has no topic0 (anonymous event) — cannot be matched against the known ABI set" };
  }
  // Name-only labels first: events we can NAME from a frozen selector but whose indexed layout
  // is not source-verified — label + raw bytes, never a guessed arg decode [K3-honest].
  const nameOnly = JIT_EVENTS[topic0];
  if (nameOnly) {
    return { known: false, event: nameOnly, ...addr, topic0, topics, data, note: `recognized ${nameOnly} by selector, but its indexed layout is not source-verified here — args left as raw topics/data rather than guessed` };
  }
  for (const abi of [KNOWN_EVENTS_ABI, LOP_CANCELLED_FALLBACK_ABI]) {
    try {
      const d = decodeEventLog({ abi, topics: topics as [Hex, ...Hex[]], data });
      return { known: true, event: d.eventName, args: argsSafe((d.args ?? {}) as Record<string, unknown>), ...addr, topic0 };
    } catch {
      /* try the next ABI form, then fall through to the honest unknown row */
    }
  }
  return { known: false, event: null, ...addr, topic0, topics, data, note: "topic0 does not match the known Cork/LOP/ERC-20 ABI set (or the body does not decode against it) — raw bytes preserved" };
}
