// Stage 2c (0.6): pool-scoped reads, prepares and event scans follow the generation the POOL
// lives on, not the primary. Every pool the venue serves today lives on an OLDER manager than
// the 10-field primary (176 on arbitrum-v1.1, 3 on arbitrum-legacy, 6 on phoenix/v0.3-rc.1),
// so a read or bundle routed through the primary's addresses answers for the wrong contract.
// Offline: one stub client answers `shares(poolId)` non-zero on exactly ONE manager and serves
// that manager's wire-shaped `market()` tuple; everything else is fixed fixture state.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeAbiParameters, encodeEventTopics, parseAbi, toEventSelector } from "viem";
import {
  attributeLogs,
  BASE_FILLER_JIT_MARKET_CREATED_TOPIC,
  BUNDLED_DEFAULTS,
  classifyAddress,
  computeMarketId,
  decodeMarketRows,
  generationsOf,
  type HandlerContext,
  KNOWN_EVENTS_ABI,
  MARKET_CREATED_10_TOPIC,
  MARKET_CREATED_TOPIC,
  PROTOCOL_EVENTS,
  protocolEmittersFor,
  runTool,
  ToolInputError,
} from "@cork/core";
import { getPoolDep } from "../src/handlers/shared.ts";
// scan-cache is INTERNAL (never re-exported from the SDK surface) — imported relatively.
import { readScanCache, SCAN_CACHE_SCHEMA, scanCacheId, writeScanCache } from "../src/scan-cache.ts";
import { stubResolved } from "./helpers.ts";

const NOW = 1_753_000_000n;
const CHAIN = 42161;
const ARBITRUM = generationsOf(BUNDLED_DEFAULTS, CHAIN);
const pmOf = (label: string) => ARBITRUM.find((g) => g.label === label)!.phoenix!.poolManager as `0x${string}`;
const PRIMARY_PM = pmOf("phoenix/v0.4-rc.1"); // 10-field
const V03_PM = pmOf("phoenix/v0.3-rc.1"); // 8-field, active, not primary
const LEGACY_PM = pmOf("arbitrum-legacy"); // 8-field, read-only
const V03_ADAPTER = ARBITRUM.find((g) => g.label === "phoenix/v0.3-rc.1")!.phoenix!.corkAdapter!;
const PRIMARY_ADAPTER = ARBITRUM.find((g) => g.label === "phoenix/v0.4-rc.1")!.phoenix!.corkAdapter!;

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const COL = "0x1111111111111111111111111111111111111111" as const;
const REF = "0x2222222222222222222222222222222222222222" as const;
const ORACLE = "0x3333333333333333333333333333333333333333" as const;
const CPT = "0x4444444444444444444444444444444444444444" as const;
const CST = "0x5555555555555555555555555555555555555555" as const;
const RCV = "0x6666666666666666666666666666666666666666" as const;
const POOL = `0x${"ab".repeat(32)}` as const;
const WAD = 10n ** 18n;
const FEE = 5n * WAD; // 5% (1e18 = 1%)

const MARKET8 = { collateralAsset: COL, referenceAsset: REF, expiryTimestamp: 9_999_999_999n, rateMin: WAD / 2n, rateMax: WAD, rateChangePerDayMax: WAD / 10n, rateChangeCapacityMax: WAD, rateOracle: ORACLE };

/** A client on which exactly `poolOn` knows POOL (any poolId). `market()` answers the wire shape
 *  of THAT manager (10-field managers answer the fee words; `viewFee` lets a test make the fee
 *  VIEWS disagree with the tuple). `getCode` throws so the implementation guard stays silent. */
function poolRpc(poolOn: `0x${string}`, opts: { wire?: "8-field" | "10-field"; viewFee?: bigint; expiry?: bigint } = {}) {
  const wire = opts.wire ?? "8-field";
  const viewFee = opts.viewFee ?? FEE;
  const market = { ...MARKET8, ...(opts.expiry !== undefined ? { expiryTimestamp: opts.expiry } : {}), ...(wire === "10-field" ? { swapFeePercentage: FEE, unwindSwapFeePercentage: FEE } : {}) };
  return async () =>
    stubResolved({
      getBlockNumber: async () => 100n,
      getBlock: async () => ({ timestamp: NOW }),
      getCode: async () => {
        throw new Error("stub holds no bytecode");
      },
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        switch (functionName) {
          case "shares":
            return address.toLowerCase() === poolOn.toLowerCase() ? [CPT, CST] : [ZERO, ZERO];
          case "market":
            return address.toLowerCase() === poolOn.toLowerCase() ? market : { ...MARKET8, collateralAsset: ZERO, referenceAsset: ZERO, rateOracle: ZERO, expiryTimestamp: 0n };
          case "constraints":
            return [WAD, NOW - 86_400n, WAD / 100n];
          case "swapRate":
            return WAD;
          case "swapFee":
          case "unwindSwapFee":
            return viewFee;
          case "rate":
            return WAD;
          case "decimals":
            return 18;
          case "issuedAt":
            return NOW - 604_800n;
          case "balanceOf":
          case "allowance":
            return 0n;
          case "paused":
            return false;
          case "getPausedBitMap":
            return 0n;
          case "isWhitelisted":
          case "isMarketWhitelistEnabled":
            return true;
          default:
            throw new Error(`no stub for ${functionName}`);
        }
      },
    });
}

const ctxFor = (poolOn: `0x${string}`, opts: Parameters<typeof poolRpc>[1] = {}, more: Partial<HandlerContext> = {}): HandlerContext => ({ nowSeconds: NOW, resolveRpc: poolRpc(poolOn, opts), ...more });
const corkPool = (ctx: HandlerContext) => runTool("cork_query", { resource: "cork-pool", chainId: CHAIN, pageSize: 25, format: "concise", filters: { poolId: POOL } }, ctx);
const deposit = (ctx: HandlerContext, type: "deposit" | "withdraw" = "deposit") =>
  runTool(
    "cork_prepare_phoenix",
    type === "deposit"
      ? { chainId: CHAIN, account: RCV, clientRequestId: "poolgen-dep-0001", fundingMode: "erc20-approve", action: { type, poolId: POOL, collateralAssetsIn: "1", receiver: RCV, minCptAndCstSharesOut: "1" }, format: "concise" }
      : { chainId: CHAIN, account: RCV, clientRequestId: "poolgen-wd-0001", fundingMode: "erc20-approve", action: { type, poolId: POOL, collateralAssetsOut: "1", owner: RCV, receiver: RCV, maxCptSharesIn: "1" }, format: "concise" },
    ctx,
  );

type Gen = { label: string; status: string };

describe("pool-scoped generation resolution — the manager that HOLDS the pool answers", () => {
  it("cork-pool on a phoenix/v0.3-rc.1 pool while the primary is 10-field: reads THAT manager, 8-field wire, label in data AND provenance", async () => {
    const env = await corkPool(ctxFor(V03_PM));
    expect(env.state).toBe("ok");
    const d = env.data as { generation: Gen; wire: string; market: Record<string, unknown>; swapFeePercentage: string; scales: Record<string, string> };
    expect(d.generation).toEqual({ label: "phoenix/v0.3-rc.1", status: "active", distribution: "phoenix/v0.3-rc.1" });
    expect(env.provenance.generation).toEqual({ label: "phoenix/v0.3-rc.1", status: "active", distribution: "phoenix/v0.3-rc.1" });
    expect(d.wire).toBe("8-field");
    // 8-field: the struct carries no fees — they come from the views, byte-identical to 0.5.x.
    expect(d.market).not.toHaveProperty("swapFeePercentage");
    expect(d.swapFeePercentage).toBe(FEE.toString());
    expect(d.scales["market"]).not.toContain("10-field");
    expect(env.warnings.map((w) => w.code)).not.toContain("invalid_state");
  });
  it("`generation` NARROWS the search to one manager: the pool on v0.3 is unknown to the primary alone → pool_not_found naming only the manager asked", async () => {
    const env = await corkPool(ctxFor(V03_PM, {}, { generation: "phoenix/v0.4-rc.1" }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("pool_not_found");
    expect(env.warnings[0]?.message).toContain(`phoenix/v0.4-rc.1 (${PRIMARY_PM})`);
    expect(env.warnings[0]?.message).not.toContain("phoenix/v0.3-rc.1");
  });
  it("no manager knows the pool → pool_not_found naming EVERY manager asked, with its label (read-only sets included)", async () => {
    const env = await corkPool(ctxFor(ZERO));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("pool_not_found");
    for (const g of ARBITRUM) expect(env.warnings[0]?.message).toContain(`${g.label} (${g.phoenix!.poolManager})`);
  });
  it("an unknown `generation` label is the caller's own field → ToolInputError (invalid input), never an envelope", async () => {
    await expect(corkPool(ctxFor(V03_PM, {}, { generation: "phoenix/v9" }))).rejects.toBeInstanceOf(ToolInputError);
  });
  it("a phoenix bundle for a v0.3 pool targets the v0.3 adapter — not the primary's — and carries the generation", async () => {
    const env = await deposit(ctxFor(V03_PM));
    expect(env.state).toBe("ok");
    const d = env.data as { corkAdapter: string; bundler3: string; generation: Gen; multicall: string };
    expect(d.corkAdapter).toBe(V03_ADAPTER);
    expect(d.corkAdapter).not.toBe(PRIMARY_ADAPTER);
    expect(d.multicall.toLowerCase()).toContain(V03_ADAPTER.slice(2).toLowerCase());
    expect(d.generation).toMatchObject({ label: "phoenix/v0.3-rc.1", status: "active" });
    expect(env.provenance.generation).toMatchObject({ label: "phoenix/v0.3-rc.1" });
  });
  it("account-state and pool-whitelist ride the same resolver", async () => {
    const as = await runTool("cork_query", { resource: "account-state", chainId: CHAIN, pageSize: 25, format: "concise", filters: { poolId: POOL, account: RCV } }, ctxFor(V03_PM));
    expect(as.state).toBe("ok");
    expect((as.data as { generation: Gen; allowances: { spenders: { corkAdapter: string } } }).generation.label).toBe("phoenix/v0.3-rc.1");
    expect((as.data as { allowances: { spenders: { corkAdapter: string } } }).allowances.spenders.corkAdapter).toBe(V03_ADAPTER);
    const wl = await runTool("cork_query", { resource: "pool-whitelist", chainId: CHAIN, pageSize: 25, format: "concise", filters: { poolId: POOL, account: RCV } }, ctxFor(V03_PM));
    expect(wl.state).toBe("ok");
    expect(wl.provenance.generation).toMatchObject({ label: "phoenix/v0.3-rc.1" });
  });
  it("compute kinds run over the pool's manager and echo the generation", async () => {
    const env = await runTool("cork_compute", { chainId: CHAIN, params: { kind: "cst-swap-rate", poolId: POOL, collateralAssetsOut: "1000" }, format: "concise" }, ctxFor(V03_PM));
    expect(env.state).toBe("ok");
    expect((env.data as { generation: Gen }).generation.label).toBe("phoenix/v0.3-rc.1");
    expect(env.provenance.generation).toMatchObject({ label: "phoenix/v0.3-rc.1" });
  });
});

describe("10-field reads: fees FROM the tuple, the views compared", () => {
  it("a pool on the 10-field primary: the widened tuple is decoded, fees ride inside market, the scales label says so, views agreeing → no warning", async () => {
    const env = await corkPool(ctxFor(PRIMARY_PM, { wire: "10-field" }));
    expect(env.state).toBe("ok");
    const d = env.data as { generation: Gen; wire: string; market: Record<string, string>; swapFeePercentage: string; scales: Record<string, string> };
    expect(d.generation.label).toBe("phoenix/v0.4-rc.1");
    expect(d.wire).toBe("10-field");
    expect(d.market["swapFeePercentage"]).toBe(FEE.toString());
    expect(d.market["unwindSwapFeePercentage"]).toBe(FEE.toString());
    expect(d.swapFeePercentage).toBe(FEE.toString());
    expect(d.scales["market"]).toContain("10-field");
    expect(env.warnings.map((w) => w.code)).not.toContain("invalid_state");
  });
  it("a crafted tuple↔view disagreement surfaces as invalid_state naming BOTH values; the result carries the tuple (the identity)", async () => {
    const env = await corkPool(ctxFor(PRIMARY_PM, { wire: "10-field", viewFee: 6n * WAD }));
    expect(env.state).toBe("ok");
    const warn = env.warnings.find((w) => w.code === "invalid_state");
    expect(warn?.message).toContain(`swapFeePercentage: tuple ${FEE.toString()} vs swapFee() ${(6n * WAD).toString()}`);
    expect(warn?.message).toContain(`unwindSwapFeePercentage: tuple ${FEE.toString()} vs unwindSwapFee() ${(6n * WAD).toString()}`);
    expect((env.data as { swapFeePercentage: string }).swapFeePercentage).toBe(FEE.toString());
    // The same disagreement reaches the compute kinds (their fee input is the tuple's).
    const c = await runTool("cork_compute", { chainId: CHAIN, params: { kind: "cst-swap-rate", poolId: POOL, collateralAssetsOut: "1000" }, format: "concise" }, ctxFor(PRIMARY_PM, { wire: "10-field", viewFee: 6n * WAD }));
    expect(c.warnings.map((w) => w.code)).toContain("invalid_state");
  });
  it("track marketRef re-hashes on the POOL's wire: a 10-field pool verifies only with its fees in the hash", async () => {
    const market10 = { ...MARKET8, swapFeePercentage: FEE, unwindSwapFeePercentage: FEE };
    const id10 = computeMarketId(market10, "10-field");
    expect(computeMarketId(MARKET8, "8-field")).not.toBe(id10);
    const env = await runTool("cork_track", { chainId: CHAIN, mode: "verify", subject: { kind: "marketRef", poolId: id10 }, format: "concise" }, ctxFor(PRIMARY_PM, { wire: "10-field" }));
    expect(env.state).toBe("ok");
    const d = env.data as { verified: boolean; wire: string; marketIdRecomputed: string; generation: Gen };
    expect(d.verified).toBe(true);
    expect(d.wire).toBe("10-field");
    expect(d.marketIdRecomputed).toBe(id10);
    expect(d.generation.label).toBe("phoenix/v0.4-rc.1");
    // And an 8-field pool on v0.3 verifies on the 8-field hash.
    const id8 = computeMarketId(MARKET8, "8-field");
    const env8 = await runTool("cork_track", { chainId: CHAIN, mode: "verify", subject: { kind: "marketRef", poolId: id8 }, format: "concise" }, ctxFor(V03_PM));
    expect(env8.state).toBe("ok");
    expect((env8.data as { wire: string }).wire).toBe("8-field");
  });
});

describe("read-only generations: reads and post-expiry settles yes, pre-expiry prepares no", () => {
  it("cork-pool on the read-only arbitrum-legacy manager reads fine and says so", async () => {
    const env = await corkPool(ctxFor(LEGACY_PM));
    expect(env.state).toBe("ok");
    expect((env.data as { generation: Gen }).generation).toMatchObject({ label: "arbitrum-legacy", status: "read-only" });
  });
  it("a pre-expiry deposit into a pool on a read-only generation refuses generation_read_only (and names the pool's generation)", async () => {
    const env = await deposit(ctxFor(LEGACY_PM));
    expect(env.state).toBe("unavailable");
    expect(env.warnings.map((w) => w.code)).toContain("generation_read_only");
    expect(env.warnings.find((w) => w.code === "generation_read_only")?.message).toContain("arbitrum-legacy");
    expect(env.provenance.generation).toMatchObject({ label: "arbitrum-legacy", status: "read-only" });
  });
  it("a post-expiry withdraw on the same pool passes the gate (the legacy set has no tx-path contracts, so it stops at unknown_deployment — never at the generation gate)", async () => {
    const env = await deposit(ctxFor(LEGACY_PM, { expiry: NOW - 1n }), "withdraw");
    expect(env.warnings.map((w) => w.code)).not.toContain("generation_read_only");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
    expect(env.warnings[0]?.message).toContain("arbitrum-legacy");
  });
  it("getPoolDep: purpose read serves a read-only set; purpose prepare refuses it; the shares ride along", async () => {
    const resolved = await poolRpc(LEGACY_PM)();
    const read = await getPoolDep({ nowSeconds: NOW }, CHAIN, resolved, POOL, { tool: "t" });
    expect(read.dep?.poolManager).toBe(LEGACY_PM);
    expect(read.generation).toMatchObject({ label: "arbitrum-legacy", status: "read-only", wire: "8-field" });
    expect(read.shares).toEqual({ corkPrincipalToken: CPT, corkSwapToken: CST });
    const prep = await getPoolDep({ nowSeconds: NOW }, CHAIN, resolved, POOL, { tool: "t", purpose: "prepare" });
    expect(prep.dep).toBeUndefined();
    expect(prep.refusal?.warnings[0]?.code).toBe("generation_read_only");
  });
});

// ── Event scans: both MarketCreated shapes, ABI chosen by the EMITTER's wire ───────────────────

const marketCreated7 = parseAbi(["event MarketCreated(bytes32 indexed id, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken)"]);
const marketCreated9 = parseAbi(["event MarketCreated(bytes32 indexed poolId, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken, uint256 swapFeePercentage, uint256 unwindSwapFeePercentage)"]);

function log7(emitter: string) {
  const topics = encodeEventTopics({ abi: marketCreated7, eventName: "MarketCreated", args: { id: POOL, referenceAsset: REF, collateralAsset: COL } });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }], [1_798_761_600n, ORACLE, CPT, CST]);
  return { address: emitter, topics: [...topics] as string[], data, blockNumber: 1, transactionHash: `0x${"ab".repeat(32)}` };
}
// The 9-arg fixture is CRAFTED FROM THE ABI: no pool exists on the 10-field manager 0xcC17… yet
// (2026-09-22), so there is no chain-captured log to pin — the decoder and the event-decode
// declaration share one signature, which is what this fixture exercises.
function log9(emitter: string) {
  const topics = encodeEventTopics({ abi: marketCreated9, eventName: "MarketCreated", args: { poolId: POOL, referenceAsset: REF, collateralAsset: COL } });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [1_798_761_600n, ORACLE, CPT, CST, FEE, 2n * WAD]);
  return { address: emitter, topics: [...topics] as string[], data, blockNumber: 2, transactionHash: `0x${"cd".repeat(32)}` };
}
const EMITTERS = ARBITRUM.filter((g) => g.phoenix).map((g) => ({ poolManager: g.phoenix!.poolManager, wire: g.phoenix!.wire, label: g.label }));
/** The same log as a receipt-shaped AttributableLog (bigint block). */
const asReceiptLog = (l: ReturnType<typeof log7>) => ({ ...l, blockNumber: BigInt(l.blockNumber) });

describe("MarketCreated scans across generations", () => {
  it("the two topics are the two MarketCreated selectors (7-arg on 8-field managers, 9-arg on 10-field)", () => {
    expect(MARKET_CREATED_TOPIC).toBe("0x0dac57f1a3acd8bd390ce93fd0b5bacf7fca996d56a73396d7c46ec2223262d8");
    expect(MARKET_CREATED_10_TOPIC).toBe("0xd6ed59268acd885a5f5c3b08d31cba4c64aa369f08bae1b32cf1de63385170c7");
  });
  it("decodes each log with the ABI of its EMITTER's wire: 8-field rows carry no fees, 10-field rows carry both, each tagged with wire + generation", () => {
    const rows = decodeMarketRows([log7(V03_PM), log9(PRIMARY_PM)], EMITTERS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ poolId: POOL, poolManager: V03_PM, wire: "8-field", generation: "phoenix/v0.3-rc.1", corkSwapToken: CST });
    expect(rows[0]).not.toHaveProperty("swapFeePercentage");
    expect(rows[1]).toMatchObject({ poolId: POOL, poolManager: PRIMARY_PM, wire: "10-field", generation: "phoenix/v0.4-rc.1", swapFeePercentage: FEE.toString(), unwindSwapFeePercentage: (2n * WAD).toString() });
  });
  it("never guesses by topic: a 9-arg log claiming an 8-field emitter (and vice versa) is SKIPPED, as is a log from an unlisted address", () => {
    expect(decodeMarketRows([log9(V03_PM)], EMITTERS)).toEqual([]);
    expect(decodeMarketRows([log7(PRIMARY_PM)], EMITTERS)).toEqual([]);
    expect(decodeMarketRows([log7(RCV)], EMITTERS)).toEqual([]);
    // Without an emitter table the pre-0.6 contract holds: every log is read as 8-field.
    expect(decodeMarketRows([log7(RCV)])).toHaveLength(1);
    expect(decodeMarketRows([log9(RCV)])).toEqual([]);
  });
  it("attribution: a pool manager is evidence only for ITS wire's MarketCreated — the other shape from the same address is a role mismatch", async () => {
    const emitters = await protocolEmittersFor(CHAIN);
    const ok = attributeLogs([asReceiptLog(log7(V03_PM)), asReceiptLog(log9(PRIMARY_PM))], emitters);
    expect(ok.corkEvents.map((e) => [e.event, e.emitter.label])).toEqual([
      ["MarketCreated (pool manager, 8-field)", "phoenix/v0.3-rc.1"],
      ["MarketCreated (pool manager, 10-field)", "phoenix/v0.4-rc.1"],
    ]);
    const crossed = attributeLogs([asReceiptLog(log7(PRIMARY_PM)), asReceiptLog(log9(V03_PM))], emitters);
    expect(crossed.corkEvents).toEqual([]);
    expect(crossed.unattributedEvents.map((e) => e.reason)).toEqual(["emitter_role_mismatch", "emitter_role_mismatch"]);
  });
});

describe("full-decentralized cork-pools asks BOTH MarketCreated topics", () => {
  it("a pool announced by the 10-field primary (9-arg topic) reaches the feed beside a v0.3 pool (7-arg topic), each tagged with its generation", async () => {
    const asked: Array<Array<string[] | null> | undefined> = [];
    const byTopic: Record<string, Array<ReturnType<typeof log7>>> = { [MARKET_CREATED_TOPIC]: [log7(V03_PM)], [MARKET_CREATED_10_TOPIC]: [{ ...log9(PRIMARY_PM), topics: log9(PRIMARY_PM).topics.map((t, i) => (i === 1 ? `0x${"cd".repeat(32)}` : t)) }] };
    const hyperSync = {
      async queryLogs(q: { fromBlock: number; address?: string[]; topics?: Array<string[] | null> }) {
        asked.push(q.topics);
        const scope = new Set((q.address ?? []).map((a) => a.toLowerCase()));
        const logs = (q.topics?.[0] ?? []).flatMap((t) => byTopic[t] ?? []).filter((l) => scope.size === 0 || scope.has(l.address.toLowerCase()));
        return { logs, archiveHeight: 1_000 };
      },
    };
    const env = await runTool("cork_query", { resource: "cork-pools", chainId: CHAIN, mode: "full-decentralized", pageSize: 25, format: "concise" }, { nowSeconds: NOW, hyperSync, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect(asked[0]?.[0]).toEqual([MARKET_CREATED_TOPIC, MARKET_CREATED_10_TOPIC]);
    const d = env.data as { count: number; items: Array<Record<string, unknown>> };
    expect(d.count).toBe(2);
    expect(d.items.map((r) => [r["poolManager"], r["wire"], r["generation"]])).toEqual([
      [V03_PM, "8-field", "phoenix/v0.3-rc.1"],
      [PRIMARY_PM, "10-field", "phoenix/v0.4-rc.1"],
    ]);
    expect(d.items[1]).toMatchObject({ swapFeePercentage: FEE.toString() });
  });
});

describe("hybrid existence probe reads each manager through ITS wire's market() ABI", () => {
  it("a venue row whose pool lives on v0.3 confirms after the 10-field primary answered zero — and each manager was read with ITS width", async () => {
    const abisSeen = new Map<string, number>();
    const chain = async () =>
      stubResolved({
        readContract: async ({ address, abi, functionName }: { address: string; abi: readonly { name?: string; outputs?: readonly { components?: readonly unknown[] }[] }[]; functionName: string }) => {
          if (functionName !== "market") throw new Error(`no stub for ${functionName}`);
          const width = abi.find((e) => e.name === "market")?.outputs?.[0]?.components?.length ?? 0;
          abisSeen.set(address.toLowerCase(), width);
          // The stub REFUSES a mismatched width the way viem never would (it decodes the first
          // eight words of a 10-word return silently — the very reason the ABI must follow the
          // wire, not the other way round). A refused read is "sawError", which the probe reports
          // as exists:null; the confirmed row below proves neither read was refused.
          if (address.toLowerCase() === PRIMARY_PM.toLowerCase()) {
            if (width !== 10) throw new Error("8-field ABI against a 10-field manager");
            return { ...MARKET8, collateralAsset: ZERO, swapFeePercentage: 0n, unwindSwapFeePercentage: 0n };
          }
          if (width !== 8) throw new Error("10-field ABI against an 8-field manager");
          return address.toLowerCase() === V03_PM.toLowerCase() ? MARKET8 : { ...MARKET8, collateralAsset: ZERO };
        },
      });
    const venue = async (url: string) => (url.includes("pools") ? new Response(JSON.stringify({ items: [{ poolId: POOL }], hasMore: false }), { status: 200 }) : new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const env = await runTool("cork_query", { resource: "cork-pools", chainId: CHAIN, pageSize: 25, format: "concise" }, { nowSeconds: NOW, venueFetch: venue, resolveRpc: chain });
    expect(env.state).toBe("ok");
    const d = env.data as { count: number; items: Array<Record<string, unknown>>; verification: { confirmed: number; dropped: number } };
    expect(d.count).toBe(1);
    expect(d.items[0]).toMatchObject({ poolId: POOL, verification: "confirmed" });
    expect(d.verification.dropped).toBe(0);
    expect(abisSeen.get(PRIMARY_PM.toLowerCase())).toBe(10);
    expect(abisSeen.get(V03_PM.toLowerCase())).toBe(8);
  });
});

describe("scan-cache identity carries the row-shape schema", () => {
  const VAR = "CORK_SCAN_CACHE_FILE";
  it("a cursor written under the 0.5.x identity (schema 1, 7-arg only) is IGNORED by the 0.6 identity", () => {
    const prev = process.env[VAR];
    const path = `${process.env["TMPDIR"] ?? "/tmp"}/cork-scan-poolgen-${process.pid}-${Math.floor(performance.now() * 1e6)}.json`;
    process.env[VAR] = path;
    try {
      const spec = { chainId: CHAIN, name: "markets", fromBlock: 0, address: [V03_PM, PRIMARY_PM], topics: [[MARKET_CREATED_TOPIC, MARKET_CREATED_10_TOPIC]] };
      const id = scanCacheId(spec);
      expect(SCAN_CACHE_SCHEMA).toBe(2);
      expect(id.startsWith(`v${String(SCAN_CACHE_SCHEMA)}:${String(CHAIN)}:markets:0:`)).toBe(true);
      // The 0.5.x spelling had no schema prefix: identical spec fields, a different identity.
      const legacyId = id.slice(`v${String(SCAN_CACHE_SCHEMA)}:`.length);
      expect(legacyId.startsWith(`${String(CHAIN)}:markets:0:`)).toBe(true);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ entries: { [legacyId]: { watermark: 123, rows: [{ poolId: POOL }] } } }));
      expect(readScanCache(legacyId)?.watermark).toBe(123);
      expect(readScanCache(id)).toBeUndefined();
      writeScanCache(id, { watermark: 456, rows: [] });
      expect(readScanCache(id)?.watermark).toBe(456);
    } finally {
      if (prev === undefined) delete process.env[VAR];
      else process.env[VAR] = prev;
    }
  });
});

describe("emitter roles ↔ verified events parity", () => {
  // The verified set also carries the ERC-20 pair and the LOP's OrderFilled — token and 1inch
  // events no Cork contract emits, so they have no emitter role by construction.
  const NON_CORK = new Set(["Transfer", "Approval", "OrderFilled"]);
  it("every Cork topic in event-decode's verified set has at least one emitter role", () => {
    for (const ev of KNOWN_EVENTS_ABI) {
      if (ev.type !== "event" || NON_CORK.has(ev.name)) continue;
      const topic = toEventSelector(ev).toLowerCase();
      expect(PROTOCOL_EVENTS[topic]?.roles.length ?? 0, `${ev.name} (${topic}) has no emitter role`).toBeGreaterThan(0);
    }
  });
  it("every emitter role names at least one topic, and every listed emitter's role is one the registry knows", async () => {
    const rolesWithTopics = new Set(Object.values(PROTOCOL_EVENTS).flatMap((e) => [...e.roles]));
    const emitted = await protocolEmittersFor(CHAIN);
    for (const e of emitted) expect(rolesWithTopics.has(e.role), `emitter role ${e.role} names no topic`).toBe(true);
    for (const role of ["baseFiller", "factory", "poolManager", "marketCreator", "jitAdapter", "legacyJitAdapter", "exactSettler", "partialSettler", "whitelistManager"]) {
      expect(rolesWithTopics.has(role as never), `role ${role} missing from PROTOCOL_EVENTS`).toBe(true);
    }
  });
  it("the BaseFiller JITMarketCreated (three args) is its own selector, emitted by the `baseFiller` role of the generation that records it", async () => {
    expect(BASE_FILLER_JIT_MARKET_CREATED_TOPIC).toBe("0xa42f9e5c6639673ffcad0a9dd20a3a0bb70cd67dd2c9e099d5d6c081dafca217");
    expect(PROTOCOL_EVENTS[BASE_FILLER_JIT_MARKET_CREATED_TOPIC.toLowerCase()]).toEqual({ event: "JITMarketCreated (BaseFiller)", roles: ["baseFiller"] });
    expect(classifyAddress(ARBITRUM, "0x3D16AD60a2fbD352Cc1108c4144F4093ab2E1224")).toEqual([{ label: "phoenix/v0.4-rc.1", status: "active", primary: true, role: "baseFiller" }]);
    expect(classifyAddress(ARBITRUM, "0xCdD4D39EBeBD5b8d4153E498220FB2Fe16807B9d")).toEqual([{ label: "phoenix/v0.3-rc.1", status: "active", primary: false, role: "baseFiller" }]);
    const emitters = await protocolEmittersFor(CHAIN);
    const log = { address: "0x3D16AD60a2fbD352Cc1108c4144F4093ab2E1224", topics: [BASE_FILLER_JIT_MARKET_CREATED_TOPIC, POOL, `0x${"00".repeat(12)}${ORACLE.slice(2)}`], data: encodeAbiParameters([{ type: "address" }], [RCV]) };
    const a = attributeLogs([log], emitters);
    expect(a.corkEvents).toHaveLength(1);
    expect(a.corkEvents[0]).toMatchObject({ event: "JITMarketCreated (BaseFiller)", emitter: { role: "baseFiller", label: "phoenix/v0.4-rc.1" }, topic1: POOL });
  });
});
