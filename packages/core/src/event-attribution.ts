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
import type { GenerationStatus, MarketRegistryWire, PhoenixWire } from "./generations.ts";
import { CLONE_DEPLOYED_TOPIC, MARKET_CREATED_TOPIC, WHITELIST_TOPICS } from "./datasources/hypersync.ts";
import { CREATOR_MARKET_CREATED_TOPIC, JIT_MARKET_CREATED_LEGACY_TOPIC, JIT_MARKET_CREATED_TOPIC, JIT_MINTED_TOPIC, POOL_MANAGER_MARKET_CREATED_10_TOPIC } from "./market-registry.ts";
import { BASE_FILLER_JIT_MARKET_CREATED_TOPIC, SETTLER_EVENTS } from "./rollover-verify.ts";
import { rolloverGenerations } from "./rollover.ts";

/** Who is allowed to emit a given protocol event. The pre-2.1.0 adapter is a `jitAdapter` too
 *  (its `legacyJitAdapter` role was retired 2026-09-22, review B4): which JITMarketCreated
 *  signature an adapter emits is a WIRE fact, gated by `EMITTER_WIRE_TOPICS`, not a role. */
export type EmitterRole = "exactSettler" | "partialSettler" | "baseFiller" | "factory" | "jitAdapter" | "marketCreator" | "poolManager" | "whitelistManager";

/** The compact generation reference every emitter carries — the chain generation's label and
 *  its `active | read-only` status (generations.ts GenerationStatus, the one vocabulary; until
 *  2026-09-22 this field held an `active | retired` string that mapped read-only to retired and
 *  forced the legacy adapter to retired while its generation is active — review B4). */
export interface EmitterGeneration {
  label: string;
  status: GenerationStatus;
}

/** One configured emitter: the contract, its role, and which generation it belongs to. */
export interface ProtocolEmitter {
  address: `0x${string}`;
  role: EmitterRole;
  generation: EmitterGeneration;
  /** Rollover-block roles only: the block's `retired` date when the venue no longer admits the
   *  generation (a rollover fact, kept beside the chain generation's status — never folded into it). */
  retired?: string;
  /** `poolManager` (phoenix wire) and `jitAdapter` (registry wire) emitters: the wire decides
   *  WHICH creation topic the contract legitimately emits (7-arg vs 9-arg MarketCreated; the
   *  2.1.0 six-arg vs the legacy mode-string JITMarketCreated). */
  wire?: PhoenixWire | MarketRegistryWire;
}

/** The creation topics that are WIRE-specific: an emitter carrying a wire is attributed for one
 *  of these topics only when its wire is listed. Topics not in this table (JITMinted, the settler
 *  events, …) are gated by role alone. The nested-wire adapter emits NO JITMarketCreated (the
 *  creator's MarketCreated announces creation there), so no wire lists the six-arg topic for it. */
const EMITTER_WIRE_TOPICS: Readonly<Record<string, readonly (PhoenixWire | MarketRegistryWire)[]>> = {
  [MARKET_CREATED_TOPIC.toLowerCase()]: ["8-field"],
  [POOL_MANAGER_MARKET_CREATED_10_TOPIC.toLowerCase()]: ["10-field"],
  [JIT_MARKET_CREATED_TOPIC.toLowerCase()]: ["flat"],
  [JIT_MARKET_CREATED_LEGACY_TOPIC.toLowerCase()]: ["legacy"],
};

/** The event registry: topic0 → event name + the roles that legitimately emit it. Built from
 *  the same signature tables the rest of the tool decodes with, so a new event lands here the
 *  moment its signature exists. */
export const PROTOCOL_EVENTS: Readonly<Record<string, { event: string; roles: readonly EmitterRole[] }>> = {
  ...Object.fromEntries(Object.entries(SETTLER_EVENTS).map(([topic, event]) => [topic.toLowerCase(), { event, roles: ["exactSettler", "partialSettler"] as const }])),
  [JIT_MARKET_CREATED_TOPIC.toLowerCase()]: { event: "JITMarketCreated", roles: ["jitAdapter"] },
  [JIT_MINTED_TOPIC.toLowerCase()]: { event: "JITMinted", roles: ["jitAdapter"] },
  [JIT_MARKET_CREATED_LEGACY_TOPIC.toLowerCase()]: { event: "JITMarketCreated (legacy pre-2.1.0)", roles: ["jitAdapter"] },
  // The nested wire's creation evidence: the adapter emits no JITMarketCreated; the CREATOR does
  // (its own MarketCreated), and the 10-field pool manager announces the pool with its fees.
  [CREATOR_MARKET_CREATED_TOPIC.toLowerCase()]: { event: "MarketCreated (CorkMarketCreator)", roles: ["marketCreator"] },
  [POOL_MANAGER_MARKET_CREATED_10_TOPIC.toLowerCase()]: { event: "MarketCreated (pool manager, 10-field)", roles: ["poolManager"] },
  // The 7-arg MarketCreated every 8-field manager emits (v1.1 … v1.3.0-rc.1) — the same role,
  // a different topic0; `protocolEmittersFor` lists a manager under `poolManager` for exactly
  // the topic its wire speaks, so a 7-arg log from a 10-field manager stays unattributed.
  [MARKET_CREATED_TOPIC.toLowerCase()]: { event: "MarketCreated (pool manager, 8-field)", roles: ["poolManager"] },
  // The rollover BaseFiller's own three-arg JITMarketCreated (a fill that created the destination
  // pool just in time) — not the adapter's six-arg event, not the settlers'.
  [BASE_FILLER_JIT_MARKET_CREATED_TOPIC.toLowerCase()]: { event: "JITMarketCreated (BaseFiller)", roles: ["baseFiller"] },
  [CLONE_DEPLOYED_TOPIC.toLowerCase()]: { event: "RolloverContractDeployed", roles: ["factory"] },
  ...Object.fromEntries(
    (["GlobalWhitelistAdded", "GlobalWhitelistRemoved", "MarketWhitelistAdded", "MarketWhitelistRemoved", "MarketWhitelistDisabled", "MarketWhitelistEnabled"] as const).map((name, i) => [
      WHITELIST_TOPICS[i]!.toLowerCase(),
      { event: name, roles: ["whitelistManager"] as const },
    ]),
  ),
};

/** Every contract this build recognizes as a protocol emitter on `chainId`, from the same
 *  config every other trust decision reads: every rollover generation's settlers (live and
 *  retired, primary first), then every generation's JIT adapter in resolution order, each
 *  tagged with its registry wire (the legacy-wire adapter is a `jitAdapter` whose wire admits
 *  only the mode-string JITMarketCreated). Every emitter carries its chain generation's
 *  `{ label, status }`; rollover roles add the block's `retired` date when it has one. */
export async function protocolEmittersFor(chainId: number): Promise<ProtocolEmitter[]> {
  const [{ rollover }, { generations }] = await Promise.all([resolveRollover(chainId), resolveGenerations(chainId)]);
  const out: ProtocolEmitter[] = [];
  const refOf = (label: string): EmitterGeneration => ({ label, status: generations.find((g) => g.label === label)?.status ?? "active" });
  if (rollover) {
    for (const g of rolloverGenerations(rollover)) {
      const retired = g.retired !== undefined ? { retired: g.retired } : {};
      out.push({ address: g.exactSettler as `0x${string}`, role: "exactSettler", generation: refOf(g.label), ...retired });
      out.push({ address: g.partialSettler as `0x${string}`, role: "partialSettler", generation: refOf(g.label), ...retired });
      out.push({ address: g.factory as `0x${string}`, role: "factory", generation: refOf(g.label), ...retired });
      if (g.baseFiller) out.push({ address: g.baseFiller, role: "baseFiller", generation: refOf(g.label), ...retired });
    }
  }
  for (const g of generations) {
    const standing: EmitterGeneration = { label: g.label, status: g.status };
    const adapter = g.marketRegistry?.adapter as `0x${string}` | undefined;
    if (adapter) out.push({ address: adapter, role: "jitAdapter", generation: standing, wire: g.marketRegistry!.wire });
    // The nested wire's creation evidence: the 0.5.0 CREATOR emits MarketCreated (the adapter
    // emits no JITMarketCreated there) and the 10-field pool manager announces the pool with its
    // fees. Only the generations whose wires SPEAK those topics are listed for them — a periphery
    // creator or an 8-field manager never emits them, and an emitter table that named them would
    // be a claim about bytes those contracts never produce.
    const creator = g.marketRegistry?.marketCreator as `0x${string}` | undefined;
    if (creator && g.marketRegistry!.wire === "nested") out.push({ address: creator, role: "marketCreator", generation: standing });
    // Every pool manager is a `poolManager` emitter; WHICH MarketCreated it may emit is decided
    // at attribution by the topic ↔ wire pairing (the 7-arg event on 8-field managers, the 9-arg
    // on 10-field) — see `poolManagerWireOf`.
    const poolManager = g.phoenix?.poolManager as `0x${string}` | undefined;
    if (poolManager) out.push({ address: poolManager, role: "poolManager", generation: standing, wire: g.phoenix!.wire });
    const whitelistManager = g.phoenix?.whitelistManager as `0x${string}` | undefined;
    if (whitelistManager) out.push({ address: whitelistManager, role: "whitelistManager", generation: standing });
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
  emitter: { role: EmitterRole; generation: EmitterGeneration; retired?: string };
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
    // A contract emits ONE creation shape — its wire's. The other wire's topic from the same
    // address is a role mismatch (a 7-arg MarketCreated claiming to come from a 10-field manager,
    // a mode-string JITMarketCreated from the 2.1.0 adapter — not that contract's evidence).
    const wireGate = topic0 !== undefined ? EMITTER_WIRE_TOPICS[topic0] : undefined;
    const wireMismatch = wireGate !== undefined && emitter !== undefined && (emitter.wire === undefined || !wireGate.includes(emitter.wire));
    if (emitter === undefined || !spec.roles.includes(emitter.role) || wireMismatch) {
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
      emitter: { role: emitter.role, generation: emitter.generation, ...(emitter.retired !== undefined ? { retired: emitter.retired } : {}) },
      ...(log.topics[1] ? { topic1: log.topics[1] } : {}),
    });
  }
  return { corkEvents, unattributedEvents, otherLogs };
}
