// Emitter-authenticated event attribution (audit STATE-007).
//
// A topic0 names an ABI shape, not a contract. Before this module, cork_track labeled receipt
// and history logs by topic alone — so ANY contract in the transaction that emitted
// `OrderSettled(bytes32)` read as Cork lifecycle evidence. Every fixture address below is the
// REAL configured contract from cork-defaults.json (Arbitrum One), so the tests exercise the
// same config resolution production reads, not a hand-built emitter table.
import { toEventSelector } from "viem";
import { describe, expect, it } from "vitest";
import { type HandlerContext, runTool } from "@cork/core";
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
const JIT_ADAPTER = "0x8902a88912a334263fe3d731d03c267715b9374f" as const;
const LEGACY_JIT_ADAPTER = "0xea15BF1E5565181Ed8678CcFf39D797272858505" as const;

const ORDER_SETTLED = toEventSelector("OrderSettled(bytes32)");
const LEG_FILLED = toEventSelector("RolloverLegFilled(bytes32,address,bytes32,uint256,uint256)");
const JIT_CREATED = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,address)");
const JIT_CREATED_LEGACY = toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,string)");
const JIT_MINTED = toEventSelector("JITMinted(bytes32,address,uint256,uint256)");
const UNKNOWN_TOPIC = `0x${"ef".repeat(32)}` as const;

type Hex = `0x${string}`;
const receiptLog = (address: Hex, topic0: Hex, data: Hex = "0x") => ({ address, topics: [topic0, DIGEST] as [Hex, ...Hex[]], data });

describe("protocolEmittersFor — the emitter table is the deployment config, both generations", () => {
  it("Arbitrum: active + retired settlers and both JIT adapters, each with its role", async () => {
    const emitters = await protocolEmittersFor(42161);
    const byAddress = Object.fromEntries(emitters.map((e) => [e.address.toLowerCase(), e]));
    expect(byAddress[ACTIVE_EXACT.toLowerCase()]).toMatchObject({ role: "exactSettler", generation: "active" });
    expect(byAddress[ACTIVE_PARTIAL.toLowerCase()]).toMatchObject({ role: "partialSettler", generation: "active" });
    expect(byAddress[RETIRED_EXACT.toLowerCase()]).toMatchObject({ role: "exactSettler", generation: "retired", label: "july-2026" });
    expect(byAddress[RETIRED_PARTIAL.toLowerCase()]).toMatchObject({ role: "partialSettler", generation: "retired", label: "july-2026" });
    expect(byAddress[JIT_ADAPTER.toLowerCase()]).toMatchObject({ role: "jitAdapter", generation: "active" });
    expect(byAddress[LEGACY_JIT_ADAPTER.toLowerCase()]).toMatchObject({ role: "legacyJitAdapter", generation: "retired" });
    expect(emitters).toHaveLength(6);
  });
  it("mainnet has no rollover or registry deployment — no emitter, so nothing can be attributed there", async () => {
    expect(await protocolEmittersFor(1)).toEqual([]);
  });
  it("the event registry covers every settler event plus the three JIT topics, keyed lowercase", () => {
    expect(Object.keys(PROTOCOL_EVENTS)).toHaveLength(13);
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
    expect(a.corkEvents[0]).toMatchObject({ event: "OrderSettled", emitter: { role: "exactSettler", generation: "retired", label: "july-2026" }, topic1: DIGEST });
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
      expect.objectContaining({ event: "OrderSettled", address: ACTIVE_EXACT, emitter: { role: "exactSettler", generation: "active" } }),
      expect.objectContaining({ event: "RolloverLegFilled", address: ACTIVE_PARTIAL, emitter: { role: "partialSettler", generation: "active" } }),
      expect.objectContaining({ event: "OrderSettled", address: RETIRED_EXACT, emitter: { role: "exactSettler", generation: "retired", label: "july-2026" } }),
      expect.objectContaining({ event: "RolloverLegFilled", address: RETIRED_PARTIAL, emitter: { role: "partialSettler", generation: "retired", label: "july-2026" } }),
      expect.objectContaining({ event: "JITMarketCreated", address: JIT_ADAPTER, emitter: { role: "jitAdapter", generation: "active" } }),
      expect.objectContaining({ event: "JITMarketCreated (legacy pre-2.1.0)", address: LEGACY_JIT_ADAPTER, emitter: { role: "legacyJitAdapter", generation: "retired" } }),
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
    expect(v.events).toEqual([expect.objectContaining({ address: RETIRED_EXACT, event: "OrderSettled", emitter: { role: "exactSettler", generation: "retired", label: "july-2026" } })]);
    expect(v.unattributedEvents).toBeUndefined();
    expect(v.otherLogs).toBeUndefined();
  });
});
