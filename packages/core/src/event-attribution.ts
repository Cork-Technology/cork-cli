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
import { resolveMarketRegistry, resolveMarketRegistryLegacy, resolveRollover } from "./config-remote.ts";
import { JIT_MARKET_CREATED_LEGACY_TOPIC, JIT_MARKET_CREATED_TOPIC, JIT_MINTED_TOPIC } from "./market-registry.ts";
import { SETTLER_EVENTS } from "./rollover-verify.ts";

/** Who is allowed to emit a given protocol event. */
export type EmitterRole = "exactSettler" | "partialSettler" | "jitAdapter" | "legacyJitAdapter";

/** One configured emitter: the contract, its role, and which generation it belongs to. */
export interface ProtocolEmitter {
  address: `0x${string}`;
  role: EmitterRole;
  generation: "active" | "retired";
  /** The retired generation's config label (e.g. "july-2026"), when it has one. */
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
};

/** Every contract this build recognizes as a protocol emitter on `chainId`, from the same
 *  config every other trust decision reads: the active rollover settlers, each retired
 *  generation's settlers, and the JIT adapters of both registry generations. */
export async function protocolEmittersFor(chainId: number): Promise<ProtocolEmitter[]> {
  const [{ rollover }, { marketRegistry }, { marketRegistry: legacy }] = await Promise.all([
    resolveRollover(chainId),
    resolveMarketRegistry(chainId),
    resolveMarketRegistryLegacy(chainId),
  ]);
  const out: ProtocolEmitter[] = [];
  if (rollover) {
    out.push({ address: rollover.exactSettler as `0x${string}`, role: "exactSettler", generation: "active" });
    out.push({ address: rollover.partialSettler as `0x${string}`, role: "partialSettler", generation: "active" });
    for (const g of rollover.legacyGenerations ?? []) {
      out.push({ address: g.exactSettler as `0x${string}`, role: "exactSettler", generation: "retired", ...(g.label ? { label: g.label } : {}) });
      out.push({ address: g.partialSettler as `0x${string}`, role: "partialSettler", generation: "retired", ...(g.label ? { label: g.label } : {}) });
    }
  }
  if (marketRegistry?.adapter) out.push({ address: marketRegistry.adapter as `0x${string}`, role: "jitAdapter", generation: "active" });
  if (legacy?.adapter) out.push({ address: legacy.adapter as `0x${string}`, role: "legacyJitAdapter", generation: "retired" });
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
