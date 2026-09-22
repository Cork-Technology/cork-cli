// Emitter-authenticated event attribution (audit STATE-007, 2026-08-24).
//
// A topic0 names an ABI shape, not a contract: any contract can emit `OrderSettled(bytes32)`.
// Labeling a receipt's logs by topic alone therefore lets ANY emitter in the transaction —
// a router, a token, an attacker's contract — appear as Cork lifecycle evidence. So a log is
// attributed only when its EMITTER is the configured contract for that event's role, in either
// the active or a retired generation. Everything else is still reported — a recognized topic
// from the wrong emitter as `unattributed` (with the reason), an unrecognized log byte-exact as
// `other` — because a decoder that drops what it cannot name hides exactly what a reader most
// needs to see. Neither of those two collections is lifecycle evidence.
import { resolveGenerations, resolveRollover } from "./config-remote.ts";
import { CREATOR_MARKET_CREATED_TOPIC, JIT_MARKET_CREATED_LEGACY_TOPIC, JIT_MARKET_CREATED_TOPIC, JIT_MINTED_TOPIC, POOL_MANAGER_MARKET_CREATED_10_TOPIC } from "./market-registry.ts";
import { SETTLER_EVENTS } from "./rollover-verify.ts";
import { rolloverGenerations } from "./rollover.ts";

/** Who is allowed to emit a given protocol event. */
export type EmitterRole = "exactSettler" | "partialSettler" | "jitAdapter" | "legacyJitAdapter" | "marketCreator" | "poolManager";

/** One configured emitter: the contract, its role, and which generation it belongs to. */
export interface ProtocolEmitter {
  address: `0x${string}`;
  role: EmitterRole;
  generation: "active" | "retired";
  /** The chain generation's label (every emitter carries one since 0.6: "phoenix/v0.4-rc.1",
   *  "arbitrum-v1.1" for the retired July settlers and the legacy JIT adapter, …). */
  label?: string;
}

/** The event registry: topic0 → event name + the roles that legitimately emit it. Built from
 *  the same signature tables the rest of the tool decodes with, so a new event lands here the
 *  moment its signature exists. */
export const PROTOCOL_EVENTS: Readonly<Record<string, { event: string; roles: readonly EmitterRole[] }>> = {
  ...Object.fromEntries(Object.entries(SETTLER_EVENTS).map(([topic, event]) => [topic.toLowerCase(), { event, roles: ["exactSettler", "partialSettler"] as const }])),
  [JIT_MARKET_CREATED_TOPIC.toLowerCase()]: { event: "JITMarketCreated", roles: ["jitAdapter"] },
  [JIT_MINTED_TOPIC.toLowerCase()]: { event: "JITMinted", roles: ["jitAdapter"] },
  [JIT_MARKET_CREATED_LEGACY_TOPIC.toLowerCase()]: { event: "JITMarketCreated (legacy pre-2.1.0)", roles: ["legacyJitAdapter"] },
  // The nested wire's creation evidence: the adapter emits no JITMarketCreated; the CREATOR does
  // (its own MarketCreated), and the 10-field pool manager announces the pool with its fees.
  [CREATOR_MARKET_CREATED_TOPIC.toLowerCase()]: { event: "MarketCreated (CorkMarketCreator)", roles: ["marketCreator"] },
  [POOL_MANAGER_MARKET_CREATED_10_TOPIC.toLowerCase()]: { event: "MarketCreated (pool manager, 10-field)", roles: ["poolManager"] },
};

/** Every contract this build recognizes as a protocol emitter on `chainId`, from the same
 *  config every other trust decision reads: every rollover generation's settlers (active and
 *  retired, primary first), then every generation's JIT adapter in resolution order — the
 *  flat/nested-wire adapters as `jitAdapter` (active), the legacy-wire adapter as
 *  `legacyJitAdapter` (retired — the deprecated lane's emitter keeps its own role because its
 *  JITMarketCreated carries a different signature). Every emitter carries its chain
 *  generation's label. */
export async function protocolEmittersFor(chainId: number): Promise<ProtocolEmitter[]> {
  const [{ rollover }, { generations }] = await Promise.all([resolveRollover(chainId), resolveGenerations(chainId)]);
  const out: ProtocolEmitter[] = [];
  if (rollover) {
    for (const g of rolloverGenerations(rollover)) {
      out.push({ address: g.exactSettler as `0x${string}`, role: "exactSettler", generation: g.status, label: g.label });
      out.push({ address: g.partialSettler as `0x${string}`, role: "partialSettler", generation: g.status, label: g.label });
    }
  }
  for (const g of generations) {
    const standing = g.status === "active" ? "active" : "retired";
    const adapter = g.marketRegistry?.adapter as `0x${string}` | undefined;
    if (adapter) {
      if (g.marketRegistry!.wire === "legacy") out.push({ address: adapter, role: "legacyJitAdapter", generation: "retired", label: g.label });
      else out.push({ address: adapter, role: "jitAdapter", generation: standing, label: g.label });
    }
    // The nested wire's creation evidence: the 0.5.0 CREATOR emits MarketCreated (the adapter
    // emits no JITMarketCreated there) and the 10-field pool manager announces the pool with its
    // fees. Only the generations whose wires SPEAK those topics are listed for them — a periphery
    // creator or an 8-field manager never emits them, and an emitter table that named them would
    // be a claim about bytes those contracts never produce.
    const creator = g.marketRegistry?.marketCreator as `0x${string}` | undefined;
    if (creator && g.marketRegistry!.wire === "nested") out.push({ address: creator, role: "marketCreator", generation: standing, label: g.label });
    const poolManager = g.phoenix?.poolManager as `0x${string}` | undefined;
    if (poolManager && g.phoenix!.wire === "10-field") out.push({ address: poolManager, role: "poolManager", generation: standing, label: g.label });
  }
  return out;
}

/** The minimal log shape both sources produce: viem receipt logs (bigint block, numeric index)
 *  and eth_getLogs rows (hex strings). */
export interface AttributableLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber?: bigint | string;
  transactionHash?: string | null;
  logIndex?: number | string | null;
}

/** Where a log came from, carried on every row — chain integers as decimal strings (F10). */
interface LogOrigin {
  address: string;
  txHash?: string;
  blockNumber?: string;
  logIndex?: string;
}

/** A log whose emitter IS the configured contract for its event's role: lifecycle evidence. */
export interface AttributedEvent extends LogOrigin {
  event: string;
  emitter: { role: EmitterRole; generation: "active" | "retired"; label?: string };
  /** topics[1] — for every settler event and JIT event, the order digest / pool id. */
  topic1?: string;
}

/** A recognized topic from an emitter that is NOT configured for it. Reported, never trusted. */
export interface UnattributedEvent extends LogOrigin {
  event: string;
  reason: "emitter_not_configured" | "emitter_role_mismatch";
  topics: string[];
  data: string;
}

/** A log whose topic0 this build does not know. Byte-exact, so the reader can see it. */
export interface OtherLog extends LogOrigin {
  topics: string[];
  data: string;
}

export interface AttributedLogs {
  corkEvents: AttributedEvent[];
  unattributedEvents: UnattributedEvent[];
  otherLogs: OtherLog[];
}

const originOf = (l: AttributableLog): LogOrigin => ({
  address: l.address,
  ...(l.transactionHash ? { txHash: l.transactionHash } : {}),
  ...(l.blockNumber !== undefined ? { blockNumber: BigInt(l.blockNumber).toString() } : {}),
  ...(l.logIndex !== undefined && l.logIndex !== null ? { logIndex: BigInt(l.logIndex).toString() } : {}),
});

/**
 * Split logs into lifecycle evidence, recognized-but-unauthenticated events, and everything
 * else. The emitter is matched by ADDRESS against `emitters`; the event's allowed roles must
 * include that emitter's role — an active ExactSettler emitting `JITMinted` is a role mismatch,
 * not evidence.
 */
export function attributeLogs(logs: readonly AttributableLog[], emitters: readonly ProtocolEmitter[]): AttributedLogs {
  const corkEvents: AttributedEvent[] = [];
  const unattributedEvents: UnattributedEvent[] = [];
  const otherLogs: OtherLog[] = [];
  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    const spec = topic0 !== undefined ? PROTOCOL_EVENTS[topic0] : undefined;
    if (!spec) {
      otherLogs.push({ ...originOf(log), topics: [...log.topics], data: log.data });
      continue;
    }
    const emitter = emitters.find((e) => e.address.toLowerCase() === log.address.toLowerCase());
    if (emitter === undefined || !spec.roles.includes(emitter.role)) {
      unattributedEvents.push({
        ...originOf(log),
        event: spec.event,
        reason: emitter === undefined ? "emitter_not_configured" : "emitter_role_mismatch",
        topics: [...log.topics],
        data: log.data,
      });
      continue;
    }
    corkEvents.push({
      ...originOf(log),
      event: spec.event,
      emitter: { role: emitter.role, generation: emitter.generation, ...(emitter.label ? { label: emitter.label } : {}) },
      ...(log.topics[1] ? { topic1: log.topics[1] } : {}),
    });
  }
  return { corkEvents, unattributedEvents, otherLogs };
}
