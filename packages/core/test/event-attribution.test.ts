// Emitter-authenticated event attribution (audit STATE-007).
//
// A topic0 names an ABI shape, not a contract. Before this module, cork_track labeled receipt
// and history logs by topic alone — so ANY contract in the transaction that emitted
// `OrderSettled(bytes32)` read as Cork lifecycle evidence. Every fixture address below is the
// REAL configured contract from cork-defaults.json (Arbitrum One), so the tests exercise the
// same config resolution production reads, not a hand-built emitter table.
import { toEventSelector } from "viem";
import { describe, expect, it } from "vitest";
import { BUNDLED_DEFAULTS, CREATOR_MARKET_CREATED_TOPIC, generationsOf, type HandlerContext, POOL_MANAGER_MARKET_CREATED_10_TOPIC, runTool } from "@cork/core";
import { attributeLogs, PROTOCOL_EVENTS, protocolEmittersFor } from "../src/event-attribution.ts";
import { stubResolved } from "./helpers.ts";

const TX_HASH = `0x${"12".repeat(32)}` as const;
const DIGEST = `0x${"34".repeat(32)}` as const;
const ATTACKER = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
// rc.2 (active) and July 2026 (retired) rollover settlers; 2.1.0 and pre-2.1.0 JIT adapters.
const ACTIVE_EXACT = "0xF4ffd4b3FAedb784b04d1883119840515f224C2f" as const;
const ACTIVE_PARTIAL = "0xC0fbA28687D16e9A94527F7864C7c8D41f1E6B4e" as const;
const RETIRED_EXACT = "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D" as const;
const RETIRED_PARTIAL = "0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a" as const;
// The 0.4-rc.1 candidate set: a second ACTIVE rollover generation beside rc.2 (2026-09-11).
const CANDIDATE_EXACT = "0x0F2Ce7a5b817865ebFf50c58439B9A27E38f452E" as const;
const CANDIDATE_PARTIAL = "0x5E19Be0743fE521d8BF85b5A558356675499bE9e" as const;
const JIT_ADAPTER = "0x8902a88912a334263fe3d731d03c267715b9374f" as const;
// The 0.5.0 (nested-wire) adapter of the primary phoenix/v0.4-rc.1 generation.
const NESTED_JIT_ADAPTER = "0x3E01C558fc0854e92e6ef2a84c19D6Bf9D82B104" as const;
const LEGACY_JIT_ADAPTER = "0xea15BF1E5565181Ed8678CcFf39D797272858505" as const;

const ORDER_SETTLED = toEventSelector("OrderSettled(bytes32)");
const LEG_FILLED = toEventSelector("RolloverLegFilled(bytes32,address,bytes32,uint256,uint256)");
const JIT_CREATED = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,address)");
const JIT_CREATED_LEGACY = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,string)");
const JIT_MINTED = toEventSelector("JITMinted(bytes32,address,uint256,uint256)");
const UNKNOWN_TOPIC = `0x${"ef".repeat(32)}` as const;
const ARBITRUM = generationsOf(BUNDLED_DEFAULTS, 42161);

type Hex = `0x${string}`;
const receiptLog = (address: Hex, topic0: Hex, data: Hex = "0x") => ({ address, topics: [topic0, DIGEST] as [Hex, ...Hex[]], data });

describe("protocolEmittersFor — the emitter table is the deployment config, every generation", () => {
  it("Arbitrum: every rollover generation's settlers (two active, one retired) and every generation's JIT adapter, each with its role and chain-generation label", async () => {
    const emitters = await protocolEmittersFor(42161);
    const byAddress = Object.fromEntries(emitters.map((e) => [e.address.toLowerCase(), e]));
    expect(byAddress[ACTIVE_EXACT.toLowerCase()]).toEqual({ address: ACTIVE_EXACT, role: "exactSettler", generation: "active", label: "phoenix/v0.3-rc.1" });
    expect(byAddress[ACTIVE_PARTIAL.toLowerCase()]).toEqual({ address: ACTIVE_PARTIAL, role: "partialSettler", generation: "active", label: "phoenix/v0.3-rc.1" });
    expect(byAddress[CANDIDATE_EXACT.toLowerCase()]).toEqual({ address: CANDIDATE_EXACT, role: "exactSettler", generation: "active", label: "phoenix/v0.4-rc.1" });
    expect(byAddress[CANDIDATE_PARTIAL.toLowerCase()]).toEqual({ address: CANDIDATE_PARTIAL, role: "partialSettler", generation: "active", label: "phoenix/v0.4-rc.1" });
    expect(byAddress[RETIRED_EXACT.toLowerCase()]).toMatchObject({ role: "exactSettler", generation: "retired", label: "arbitrum-v1.1" });
    expect(byAddress[RETIRED_PARTIAL.toLowerCase()]).toMatchObject({ role: "partialSettler", generation: "retired", label: "arbitrum-v1.1" });
    expect(byAddress[JIT_ADAPTER.toLowerCase()]).toEqual({ address: JIT_ADAPTER, role: "jitAdapter", generation: "active", label: "phoenix/v0.3-rc.1" });
    expect(byAddress[NESTED_JIT_ADAPTER.toLowerCase()]).toEqual({ address: NESTED_JIT_ADAPTER, role: "jitAdapter", generation: "active", label: "phoenix/v0.4-rc.1" });
    expect(byAddress[LEGACY_JIT_ADAPTER.toLowerCase()]).toEqual({ address: LEGACY_JIT_ADAPTER, role: "legacyJitAdapter", generation: "retired", label: "arbitrum-v1.1" });
    // The nested wire's creation emitters: the 0.5.0 creator and the 10-field pool manager of
    // phoenix/v0.4-rc.1 — and ONLY that generation's (a periphery creator / 8-field manager never
    // emits those topics).
    const nested = ARBITRUM.find((g) => g.label === "phoenix/v0.4-rc.1")!;
    expect(byAddress[nested.marketRegistry!.marketCreator!.toLowerCase()]).toEqual({ address: nested.marketRegistry!.marketCreator, role: "marketCreator", generation: "active", label: "phoenix/v0.4-rc.1" });
    expect(byAddress[nested.phoenix!.poolManager.toLowerCase()]).toEqual({ address: nested.phoenix!.poolManager, role: "poolManager", generation: "active", label: "phoenix/v0.4-rc.1", wire: "10-field" });
    // Since stage 2c EVERY pool manager is a poolManager emitter (each tagged with its wire, so
    // attribution admits only its own MarketCreated topic): four managers on Arbitrum, one creator.
    expect(emitters.filter((e) => e.role === "marketCreator")).toHaveLength(1);
    expect(emitters.filter((e) => e.role === "poolManager").map((e) => [e.label, e.wire])).toEqual([
      ["phoenix/v0.4-rc.1", "10-field"],
      ["phoenix/v0.3-rc.1", "8-field"],
      ["arbitrum-v1.1", "8-field"],
      ["arbitrum-legacy", "8-field"],
    ]);
    // The rollover BaseFillers (the 0.2 and rc.2 records; the July rc.1 record predates the
    // component baselines and names none) and every rollover factory ride along.
    expect(emitters.filter((e) => e.role === "baseFiller").map((e) => [e.address, e.label])).toEqual([
      ["0x3D16AD60a2fbD352Cc1108c4144F4093ab2E1224", "phoenix/v0.4-rc.1"],
      ["0xCdD4D39EBeBD5b8d4153E498220FB2Fe16807B9d", "phoenix/v0.3-rc.1"],
    ]);
    expect(emitters.filter((e) => e.role === "factory")).toHaveLength(3);
    // 3 rollover generations × (2 settlers + factory) + 2 BaseFillers + the three registry
    // generations' JIT adapters + the nested creator + 4 pool managers + every configured
    // whitelist manager (3: the read-only legacy set has none).
    const whitelistManagers = ARBITRUM.filter((g) => g.phoenix?.whitelistManager !== undefined).length;
    expect(whitelistManagers).toBe(3);
    expect(emitters).toHaveLength(9 + 2 + 3 + 1 + 4 + whitelistManagers);
    // Primary first: the order is the config's flattening, not an address sort.
    expect(emitters.slice(0, 2).map((e) => e.address)).toEqual([CANDIDATE_EXACT, CANDIDATE_PARTIAL]);
  });
  it("mainnet has no rollover or registry deployment — only its phoenix contracts emit (the 8-field pool manager and the whitelist manager)", async () => {
    const mainnet = generationsOf(BUNDLED_DEFAULTS, 1)[0]!;
    expect(await protocolEmittersFor(1)).toEqual([
      { address: mainnet.phoenix!.poolManager, role: "poolManager", generation: "active", label: "mainnet", wire: "8-field" },
      { address: mainnet.phoenix!.whitelistManager, role: "whitelistManager", generation: "active", label: "mainnet" },
    ]);
  });
  it("the event registry covers every settler event plus the three JIT topics and the two nested-wire MarketCreated topics, keyed lowercase", () => {
    // 10 settler events + 3 JIT-adapter topics + 2 nested-wire MarketCreated + the 8-field
    // MarketCreated + the BaseFiller JITMarketCreated + RolloverContractDeployed + 6 whitelist.
    expect(Object.keys(PROTOCOL_EVENTS)).toHaveLength(24);
    expect(PROTOCOL_EVENTS[CREATOR_MARKET_CREATED_TOPIC.toLowerCase()]).toEqual({ event: "MarketCreated (CorkMarketCreator)", roles: ["marketCreator"] });
    expect(PROTOCOL_EVENTS[POOL_MANAGER_MARKET_CREATED_10_TOPIC.toLowerCase()]).toEqual({ event: "MarketCreated (pool manager, 10-field)", roles: ["poolManager"] });
    for (const topic of Object.keys(PROTOCOL_EVENTS)) expect(topic).toBe(topic.toLowerCase());
    expect(PROTOCOL_EVENTS[ORDER_SETTLED.toLowerCase()]).toEqual({ event: "OrderSettled", roles: ["exactSettler", "partialSettler"] });
    expect(PROTOCOL_EVENTS[JIT_MINTED.toLowerCase()]).toEqual({ event: "JITMinted", roles: ["jitAdapter"] });
    expect(PROTOCOL_EVENTS[JIT_CREATED_LEGACY.toLowerCase()]).toEqual({ event: "JITMarketCreated (legacy pre-2.1.0)", roles: ["legacyJitAdapter"] });
  });
});

describe("attributeLogs — evidence only from the configured emitter for that event's role", () => {
  it("a recognized topic from an unconfigured emitter is reported, never evidence", async () => {
    const a = attributeLogs([receiptLog(ATTACKER, ORDER_SETTLED, "0xdeadbeef")], await protocolEmittersFor(42161));
    expect(a.corkEvents).toEqual([]);
    expect(a.unattributedEvents).toEqual([{ address: ATTACKER, event: "OrderSettled", reason: "emitter_not_configured", topics: [ORDER_SETTLED, DIGEST], data: "0xdeadbeef" }]);
    expect(a.otherLogs).toEqual([]);
  });
  it("a configured emitter emitting an event outside its role is a role mismatch (an ExactSettler cannot mint JIT)", async () => {
    const a = attributeLogs([receiptLog(ACTIVE_EXACT, JIT_MINTED)], await protocolEmittersFor(42161));
    expect(a.corkEvents).toEqual([]);
    expect(a.unattributedEvents[0]).toMatchObject({ address: ACTIVE_EXACT, event: "JITMinted", reason: "emitter_role_mismatch" });
  });
  it("each generation's JIT adapter owns ITS market-created layout — the topics do not cross generations", async () => {
    const emitters = await protocolEmittersFor(42161);
    const a = attributeLogs(
      [receiptLog(JIT_ADAPTER, JIT_CREATED), receiptLog(LEGACY_JIT_ADAPTER, JIT_CREATED_LEGACY), receiptLog(JIT_ADAPTER, JIT_CREATED_LEGACY), receiptLog(LEGACY_JIT_ADAPTER, JIT_CREATED)],
      emitters,
    );
    expect(a.corkEvents.map((e) => [e.event, e.emitter.role, e.emitter.generation])).toEqual([
      ["JITMarketCreated", "jitAdapter", "active"],
      ["JITMarketCreated (legacy pre-2.1.0)", "legacyJitAdapter", "retired"],
    ]);
    expect(a.unattributedEvents.map((e) => [e.address, e.reason])).toEqual([
      [JIT_ADAPTER, "emitter_role_mismatch"],
      [LEGACY_JIT_ADAPTER, "emitter_role_mismatch"],
    ]);
  });
  it("matches the emitter address case-insensitively (checksummed config vs lowercase receipt)", async () => {
    const a = attributeLogs([receiptLog(RETIRED_EXACT.toLowerCase() as Hex, ORDER_SETTLED)], await protocolEmittersFor(42161));
    expect(a.corkEvents[0]).toMatchObject({ event: "OrderSettled", emitter: { role: "exactSettler", generation: "retired", label: "arbitrum-v1.1" }, topic1: DIGEST });
  });
  it("an unknown topic rides byte-exact as an other log, whoever emitted it; a topic-less log too", () => {
    const a = attributeLogs(
      [
        { address: ACTIVE_EXACT, topics: [UNKNOWN_TOPIC, DIGEST], data: "0xcafebabe", blockNumber: 494_104_800n, transactionHash: TX_HASH, logIndex: 3 },
        { address: ATTACKER, topics: [], data: "0x" },
      ],
      [{ address: ACTIVE_EXACT, role: "exactSettler", generation: "active" }],
    );
    expect(a.corkEvents).toEqual([]);
    expect(a.unattributedEvents).toEqual([]);
    // chain integers ride as decimal strings (F10), from either source shape
    expect(a.otherLogs).toEqual([
      { address: ACTIVE_EXACT, txHash: TX_HASH, blockNumber: "494104800", logIndex: "3", topics: [UNKNOWN_TOPIC, DIGEST], data: "0xcafebabe" },
      { address: ATTACKER, topics: [], data: "0x" },
    ]);
  });
  it("with no emitters at all, every recognized topic is unattributed — never a silent drop", () => {
    const a = attributeLogs([receiptLog(ACTIVE_EXACT, ORDER_SETTLED)], []);
    expect(a.corkEvents).toEqual([]);
    expect(a.unattributedEvents).toHaveLength(1);
  });
});

describe("cork_track txHash — receipt events are attributed by emitter, not by topic", () => {
  const trackReceipt = (logs: ReturnType<typeof receiptLog>[]) =>
    runTool(
      "cork_track",
      { mode: "reconcile", chainId: 42161, subject: { kind: "txHash", txHash: TX_HASH }, format: "concise" },
      {
        nowSeconds: 1_800_000_000n,
        resolveRpc: async () => stubResolved({ getTransactionReceipt: async () => ({ status: "success", blockNumber: 494_104_800n, gasUsed: 210_000n, logs }) }),
      } satisfies HandlerContext,
    );
  type ReceiptData = {
    status: string;
    logs: number;
    corkEvents?: Array<{ event: string; address: string; emitter: { role: string; generation: string; label?: string } }>;
    unattributedEvents?: Array<{ event: string; address: string; reason: string; data: string }>;
    otherLogs?: Array<{ address: string; topics: string[]; data: string }>;
  };

  it("an attacker's OrderSettled in the same tx never becomes corkEvents; the unknown log stays readable", async () => {
    const env = await trackReceipt([receiptLog(ATTACKER, ORDER_SETTLED, "0xdeadbeef"), receiptLog(ACTIVE_EXACT, UNKNOWN_TOPIC, "0xcafebabe")]);
    expect(env.state).toBe("ok");
    const data = env.data as ReceiptData;
    expect(data).toMatchObject({ status: "success", logs: 2 });
    expect(data.corkEvents).toBeUndefined();
    expect(data.unattributedEvents).toEqual([expect.objectContaining({ event: "OrderSettled", address: ATTACKER, reason: "emitter_not_configured", data: "0xdeadbeef" })]);
    expect(data.otherLogs).toEqual([{ address: ACTIVE_EXACT, topics: [UNKNOWN_TOPIC, DIGEST], data: "0xcafebabe" }]);
  });

  it("names the role and generation behind every attributed event, in receipt order", async () => {
    const env = await trackReceipt([
      receiptLog(ACTIVE_EXACT, ORDER_SETTLED),
      receiptLog(ACTIVE_PARTIAL, LEG_FILLED),
      receiptLog(RETIRED_EXACT, ORDER_SETTLED),
      receiptLog(RETIRED_PARTIAL, LEG_FILLED),
      receiptLog(JIT_ADAPTER, JIT_CREATED),
      receiptLog(LEGACY_JIT_ADAPTER, JIT_CREATED_LEGACY),
    ]);
    const data = env.data as ReceiptData;
    expect(data.corkEvents).toEqual([
      expect.objectContaining({ event: "OrderSettled", address: ACTIVE_EXACT, emitter: { role: "exactSettler", generation: "active", label: "phoenix/v0.3-rc.1" } }),
      expect.objectContaining({ event: "RolloverLegFilled", address: ACTIVE_PARTIAL, emitter: { role: "partialSettler", generation: "active", label: "phoenix/v0.3-rc.1" } }),
      expect.objectContaining({ event: "OrderSettled", address: RETIRED_EXACT, emitter: { role: "exactSettler", generation: "retired", label: "arbitrum-v1.1" } }),
      expect.objectContaining({ event: "RolloverLegFilled", address: RETIRED_PARTIAL, emitter: { role: "partialSettler", generation: "retired", label: "arbitrum-v1.1" } }),
      expect.objectContaining({ event: "JITMarketCreated", address: JIT_ADAPTER, emitter: { role: "jitAdapter", generation: "active", label: "phoenix/v0.3-rc.1" } }),
      expect.objectContaining({ event: "JITMarketCreated (legacy pre-2.1.0)", address: LEGACY_JIT_ADAPTER, emitter: { role: "legacyJitAdapter", generation: "retired", label: "arbitrum-v1.1" } }),
    ]);
    expect(data.unattributedEvents).toBeUndefined();
    expect(data.otherLogs).toBeUndefined();
  });
});

describe("cork_track orderHash — a digest's history is scoped to ITS settler; the logs endpoint cannot substitute an emitter", () => {
  // The venue row binds the digest to the RETIRED exact settler; the logs endpoint (an external
  // party) answers with logs it chose. Only logs from THAT settler are evidence.
  const historyCtx = (rows: Array<Record<string, unknown>>): HandlerContext => ({
    nowSeconds: 1_800_000_000n,
    venueFetch: async () => new Response(JSON.stringify({ order: { orderDigest: DIGEST, status: "SETTLED", settler: RETIRED_EXACT, chainId: 42161 }, fills: [], slots: [] }), { status: 200 }),
    resolveRpc: async () => stubResolved({ readContract: async () => 2 }),
    logsUrl: "https://stub-logs/rpc",
    logsFetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: rows }), { status: 200 }),
  });
  const row = (address: string, topic0: string, data: string, logIndex: string) => ({ address, topics: [topic0, DIGEST], data, blockNumber: "0x1ce87450", transactionHash: TX_HASH, logIndex });
  type Verification = {
    chainStatus: string;
    events: Array<{ address: string; event: string }>;
    unattributedEvents?: Array<{ address: string; event: string; reason: string; data: string }>;
    otherLogs?: Array<Record<string, unknown>>;
  };
  const reconcile = async (rows: Array<Record<string, unknown>>) => {
    const env = await runTool("cork_track", { mode: "reconcile", chainId: 42161, subject: { kind: "orderHash", orderHash: DIGEST }, format: "concise" }, historyCtx(rows));
    expect(env.state).toBe("ok");
    return (env.data as { chainVerification: Verification }).chainVerification;
  };

  it("an unconfigured emitter's OrderSettled is reported, not evidence; the settler's unknown-topic log stays byte-exact", async () => {
    const v = await reconcile([row(ATTACKER, ORDER_SETTLED, "0xdeadbeef", "0x0"), row(RETIRED_EXACT, UNKNOWN_TOPIC, "0xcafebabe", "0x1")]);
    expect(v.chainStatus).toBe("Settled");
    expect(v.events).toEqual([]);
    expect(v.unattributedEvents).toEqual([expect.objectContaining({ address: ATTACKER, event: "OrderSettled", reason: "emitter_not_configured", data: "0xdeadbeef" })]);
    expect(v.otherLogs).toEqual([{ address: RETIRED_EXACT, txHash: TX_HASH, blockNumber: String(0x1ce87450), logIndex: "1", topics: [UNKNOWN_TOPIC, DIGEST], data: "0xcafebabe" }]);
  });

  it("even ANOTHER configured settler is out of scope for this digest — the ACTIVE exact settler's log is not the retired settler's history", async () => {
    const v = await reconcile([row(ACTIVE_EXACT, ORDER_SETTLED, "0x", "0x0"), row(RETIRED_EXACT, ORDER_SETTLED, "0x", "0x1")]);
    expect(v.events).toEqual([expect.objectContaining({ address: RETIRED_EXACT, event: "OrderSettled" })]);
    expect(v.unattributedEvents).toEqual([expect.objectContaining({ address: ACTIVE_EXACT, event: "OrderSettled", reason: "emitter_not_configured" })]);
  });

  it("a clean history from the bound settler attributes with generation and label, and omits the empty collections", async () => {
    const v = await reconcile([row(RETIRED_EXACT, ORDER_SETTLED, "0x", "0x0")]);
    expect(v.events).toEqual([expect.objectContaining({ address: RETIRED_EXACT, event: "OrderSettled", emitter: { role: "exactSettler", generation: "retired", label: "arbitrum-v1.1" } })]);
    expect(v.unattributedEvents).toBeUndefined();
    expect(v.otherLogs).toBeUndefined();
  });
});
