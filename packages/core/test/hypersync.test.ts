// full-decentralized mode, fully offline: an injected HyperSyncSource plays Envio. Covers the
// event-derived resources (markets / LOP fills / rollover fills / clone discovery), the
// structural rejections (resting orders emit no events), decode fidelity against real event
// encodings, and honest degradation when no client/token is available.
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import {
  runTool,
  collectPagedLogs,
  decodeMarketRows,
  decodeCloneRows,
  decodeLopFillRows,
  decodeRolloverFillRows,
  decodeWhitelistRows,
  loadHyperSync,
  normalizeNapiLog,
  MARKET_CREATED_TOPIC,
  CLONE_DEPLOYED_TOPIC,
  type HandlerContext,
  type HyperSyncLog,
  type HyperSyncSource,
} from "@cork/core";
import { stubRpc } from "./helpers.ts";

const NOW = 1_790_000_000n;
const POOL = `0x${"cc".repeat(32)}`;
const REF = "0x9d39a5de30e57443bff2a8307a4256c8797a3497";
const COL = "0x53e82abbb12638f09d9e624578ccb666217a765e";
const ORACLE = "0x78fb656d01141e3ac2073c9372c8b3e636f49d01";
const CPT = "0x988dc887bec09db524d23a9714bdcd23cb518535";
const CST = "0x997f71adad54fbf76a07fbdbc376b1f6c23a6dc5";
const STAGING_PM = "0x4d0ab6735def9fbaddbf0f2ffb92353afae623d2";
const FACTORY = "0xbbcc54c637c26b484a8c57b5695c04e09dace13a";
const OWNER = "0xc0ffee0000000000000000000000000000000001";
const CLONE = "0xc10e000000000000000000000000000000000001";

const marketAbi = parseAbi([
  "event MarketCreated(bytes32 indexed id, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken)",
]);
const cloneAbi = parseAbi(["event RolloverContractDeployed(address indexed user, address indexed rolloverContract)"]);

function marketLog(): HyperSyncLog {
  const topics = encodeEventTopics({ abi: marketAbi, eventName: "MarketCreated", args: { id: POOL as `0x${string}`, referenceAsset: REF, collateralAsset: COL } });
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }],
    [1798761600n, ORACLE, CPT, CST],
  );
  return { address: STAGING_PM, topics: [...topics] as Array<string | null>, data, blockNumber: 485000001, transactionHash: `0x${"ab".repeat(32)}` };
}

function cloneLog(): HyperSyncLog {
  const topics = encodeEventTopics({ abi: cloneAbi, eventName: "RolloverContractDeployed", args: { user: OWNER, rolloverContract: CLONE } });
  return { address: FACTORY, topics: [...topics] as Array<string | null>, data: "0x", blockNumber: 485000002, transactionHash: `0x${"cd".repeat(32)}` };
}

function fakeSource(logsByTopic: Record<string, HyperSyncLog[]>, seen: Array<{ fromBlock: number; address?: string[] }> = []): HyperSyncSource {
  return {
    async queryLogs(q) {
      seen.push({ fromBlock: q.fromBlock, ...(q.address ? { address: q.address } : {}) });
      const t0s = q.topics?.[0] ?? [];
      const logs = (t0s ?? []).flatMap((t) => logsByTopic[t] ?? []);
      return { logs, archiveHeight: 485_999_999 };
    },
  };
}

describe("full-decentralized cork_query over an injected HyperSync source", () => {
  it("markets: decodes MarketCreated across configured PMs (primary + staging profile)", async () => {
    const seen: Array<{ fromBlock: number; address?: string[] }> = [];
    const ctx: HandlerContext = { nowSeconds: NOW, hyperSync: fakeSource({ [MARKET_CREATED_TOPIC]: [marketLog()] }, seen) };
    const env = await runTool("cork_query", { resource: "markets", chainId: 42161, mode: "full-decentralized", pageSize: 25, format: "concise" }, ctx);
    expect(env.state).toBe("ok");
    expect(env.provenance.mode).toBe("full-decentralized");
    const d = env.data as { count: number; items: Array<Record<string, unknown>>; archiveHeight: number };
    expect(d.count).toBe(1);
    expect(d.items[0]).toMatchObject({ poolId: POOL, referenceAsset: expect.stringMatching(/^0x/) as unknown, poolManager: STAGING_PM });
    expect(d.archiveHeight).toBe(485_999_999);
    // both the production PM and the staging-profile PM are scanned
    expect(seen[0]!.address!.map((a) => a.toLowerCase())).toEqual(
      expect.arrayContaining(["0xc2de56fb1c7a85250ce69c37b4773767c77954ae", STAGING_PM]),
    );
  });

  it("flows kind=contracts: clone discovery from the factory's RolloverContractDeployed", async () => {
    const seen: Array<{ fromBlock: number; address?: string[] }> = [];
    const ctx: HandlerContext = { nowSeconds: NOW, hyperSync: fakeSource({ [CLONE_DEPLOYED_TOPIC]: [cloneLog()] }, seen) };
    const env = await runTool(
      "cork_query",
      { resource: "flows", chainId: 42161, mode: "full-decentralized", filters: { kind: "contracts", account: OWNER }, pageSize: 25, format: "concise" },
      ctx,
    );
    expect(env.state).toBe("ok");
    const d = env.data as { count: number; items: Array<Record<string, unknown>> };
    expect(d.count).toBe(1);
    expect(d.items[0]).toMatchObject({ owner: expect.stringMatching(/^0x/) as unknown, rolloverContract: expect.stringMatching(/^0x/) as unknown });
    // scan starts at the seeding block, scoped to the factory
    expect(seen[0]!.fromBlock).toBe(484973917);
    expect(seen[0]!.address!.map((a) => a.toLowerCase())).toEqual([FACTORY]);
  });

  it("structural rejections: resting orders emit no events in ANY mode", async () => {
    const ctx: HandlerContext = { nowSeconds: NOW, hyperSync: fakeSource({}) };
    for (const input of [
      { resource: "orderbook", chainId: 42161, mode: "full-decentralized" },
      { resource: "limit-order-markets", chainId: 42161, mode: "full-decentralized" },
      { resource: "flows", chainId: 42161, mode: "full-decentralized" }, // kind defaults to orders
    ]) {
      const env = await runTool("cork_query", { ...input, pageSize: 25, format: "concise" }, ctx);
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe("mode_unavailable");
      expect(env.warnings[0]?.message).toContain("emit no events");
    }
  });

  it("chains without a rollover deployment gate flows honestly", async () => {
    const ctx: HandlerContext = { nowSeconds: NOW, hyperSync: fakeSource({}) };
    const env = await runTool(
      "cork_query",
      { resource: "flows", chainId: 1, mode: "full-decentralized", filters: { kind: "fills" }, pageSize: 25, format: "concise" },
      ctx,
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
  });
});

describe("loadHyperSync honesty (no injection)", () => {
  it("missing token → typed reason mentioning the token, without touching the network", async () => {
    const r = await loadHyperSync(42161, undefined);
    expect("error" in r && r.error).toContain("ENVIO_API_TOKEN");
  });
  it("unsupported chain → typed reason", async () => {
    const r = await loadHyperSync(49222, "tok");
    expect("error" in r && r.error).toContain("no HyperSync endpoint");
  });
  it("runTool surfaces the load failure as hypersync_unavailable", async () => {
    const prev = process.env.ENVIO_API_TOKEN;
    delete process.env.ENVIO_API_TOKEN;
    const env = await runTool("cork_query", { resource: "markets", chainId: 42161, mode: "full-decentralized", pageSize: 25, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("hypersync_unavailable");
    if (prev) process.env.ENVIO_API_TOKEN = prev;
  });
});

describe("decode fidelity", () => {
  it("decodeMarketRows tolerates foreign logs (skips, never throws)", () => {
    const rows = decodeMarketRows([marketLog(), { address: STAGING_PM, topics: ["0xdead"], data: "0x", blockNumber: 1, transactionHash: "0x" }]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.expiry).toBe("1798761600");
  });

  it("decentralized market rows use the shared corkSwapToken/corkPrincipalToken names (NOT raw swap/principal)", () => {
    const row = decodeMarketRows([marketLog()])[0]!;
    // marketLog() encodes (…, principalToken=CPT, swapToken=CST); the row must map them to the
    // surface vocabulary, not pass the raw event field names through (which inverted the label).
    expect((row.corkSwapToken as string).toLowerCase()).toBe(CST); // cST == swapToken
    expect((row.corkPrincipalToken as string).toLowerCase()).toBe(CPT); // cPT == principalToken
    expect(row).not.toHaveProperty("swapToken");
    expect(row).not.toHaveProperty("principalToken");
  });
});

describe("full-decentralized fills paths (previously untested decode surfaces)", () => {
  const DIGEST = `0x${"5".repeat(64)}` as const;
  const FILLER = "0x00000000000000000000000000000000deadbeef";
  const SETTLER = "0x983270ae48545665cee4d7ef61c65ff3fdc8222d";
  const LOP = "0x111111125421ca6dc452d289314280a0f8842a65";

  const fillAbis = parseAbi([
    "event RolloverLegFilled(bytes32 indexed orderDigest, address indexed filler, bytes32 indexed subFiller, uint256 srcCstProvided, uint256 dstCstProduced)",
    "event PremiumLegFilled(bytes32 indexed orderDigest, address indexed premiumPayer, address indexed rolloverFiller, bytes32 subFiller, uint256 premium)",
    "event DefaulterResidualReclaimed(bytes32 indexed orderId, address indexed defaulterFiller, address indexed recipientRolloverContract, uint256 amount)",
    "event OrderFilled(bytes32 orderHash, uint256 remainingAmount)",
  ]);

  function evLog(eventName: "RolloverLegFilled" | "PremiumLegFilled" | "DefaulterResidualReclaimed", args: Record<string, unknown>, data: `0x${string}`): HyperSyncLog {
    const topics = encodeEventTopics({ abi: fillAbis, eventName, args } as never);
    return { address: SETTLER, topics: [...topics] as Array<string | null>, data, blockNumber: 485000010, transactionHash: `0x${"ee".repeat(32)}` };
  }

  it("flows kind=fills: all three leg kinds decode with amounts (real encodings)", async () => {
    const logs = [
      evLog("RolloverLegFilled", { orderDigest: DIGEST, filler: FILLER, subFiller: `0x${"0".repeat(64)}` }, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [100n, 95n])),
      evLog("PremiumLegFilled", { orderDigest: DIGEST, premiumPayer: FILLER, rolloverFiller: FILLER }, encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [`0x${"0".repeat(64)}`, 12n])),
      evLog("DefaulterResidualReclaimed", { orderId: DIGEST, defaulterFiller: FILLER, recipientRolloverContract: "0xc10e000000000000000000000000000000000001" }, encodeAbiParameters([{ type: "uint256" }], [5n])),
    ];
    const byTopic: Record<string, HyperSyncLog[]> = {};
    for (const l of logs) byTopic[l.topics[0]!] = [...(byTopic[l.topics[0]!] ?? []), l];
    const seen: Array<{ fromBlock: number; address?: string[] }> = [];
    const env = await runTool(
      "cork_query",
      { resource: "flows", chainId: 42161, mode: "full-decentralized", filters: { kind: "fills", orderDigest: DIGEST }, pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: fakeSource(byTopic, seen) },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { items: Array<Record<string, unknown>> };
    expect(d.items.map((i) => i.leg).sort()).toEqual(["PREMIUM", "RECLAIM", "ROLLOVER"]);
    const roll = d.items.find((i) => i.leg === "ROLLOVER")!;
    expect(roll).toMatchObject({ srcCstProvided: "100", dstCstProduced: "95" });
    // both settlers scanned from the seeding block
    expect(seen[0]!.fromBlock).toBe(484973917);
    expect(seen[0]!.address!.length).toBe(2);
  });

  it("fills (LOP): OrderFilled decodes from data (non-indexed) and orderHash filters client-side", async () => {
    const mk = (hash: `0x${string}`): HyperSyncLog => ({
      address: LOP,
      topics: [encodeEventTopics({ abi: fillAbis, eventName: "OrderFilled" })[0] as string],
      data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [hash, 42n]),
      blockNumber: 485000011,
      transactionHash: `0x${"ff".repeat(32)}`,
    });
    const topic = encodeEventTopics({ abi: fillAbis, eventName: "OrderFilled" })[0] as string;
    const env = await runTool(
      "cork_query",
      { resource: "fills", chainId: 42161, mode: "full-decentralized", filters: { orderHash: DIGEST }, pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: fakeSource({ [topic]: [mk(DIGEST), mk(`0x${"6".repeat(64)}`)] }) },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { count: number; items: Array<Record<string, unknown>> };
    expect(d.count).toBe(1); // the foreign hash was filtered out
    expect(d.items[0]).toMatchObject({ orderHash: DIGEST, remainingAmount: "42", lop: LOP });
  });
});

describe("full-decentralized honesty: completeness + scoping disclosure (F15)", () => {
  it("markets: a source reporting complete:false surfaces pagination_incomplete (partial evidence, not the full set)", async () => {
    const partial: HyperSyncSource = {
      async queryLogs() {
        return { logs: [marketLog()], archiveHeight: 485_999_999, complete: false, nextBlock: 485_500_000 };
      },
    };
    const env = await runTool(
      "cork_query",
      { resource: "markets", chainId: 42161, mode: "full-decentralized", pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: partial },
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "pagination_incomplete")).toBe(true);
    // decoded rows carry blockNumber as a decimal STRING (chain integers ride the wire as strings, F10)
    const item = (env.data as { items: Array<Record<string, unknown>> }).items[0];
    expect(typeof item?.blockNumber).toBe("string");
    expect(item?.blockNumber).toBe("485000001");
  });

  it("a source that omits `complete` is treated as complete (no false pagination warning)", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "markets", chainId: 42161, mode: "full-decentralized", pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: fakeSource({ [MARKET_CREATED_TOPIC]: [marketLog()] }) },
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "pagination_incomplete")).toBe(false);
  });

  it("fills WITHOUT an orderHash filter warns the rows are the whole 1inch LOP, not Cork-scoped", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "fills", chainId: 42161, mode: "full-decentralized", pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: fakeSource({}) },
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "pagination_incomplete" && /1inch LOP|Cork-scoped/i.test(w.message))).toBe(true);
  });
});

describe("collectPagedLogs — pure pagination walk (transport-agnostic)", () => {
  const mkLog = (bn: number): HyperSyncLog => ({ address: "0x00", topics: ["0x00"], data: "0x", blockNumber: bn, transactionHash: "0x00" });

  it("a single page with no nextBlock is complete and carries all its logs", async () => {
    const r = await collectPagedLogs(0, async () => ({ logs: [mkLog(1)], archiveHeight: 100 }));
    expect(r.complete).toBe(true);
    expect(r.logs).toHaveLength(1);
    expect(r.nextBlock).toBeUndefined();
  });

  it("accumulates across pages until the server stops advancing", async () => {
    const pages = [
      { logs: [mkLog(1)], nextBlock: 10, archiveHeight: 100 },
      { logs: [mkLog(2)], nextBlock: 20, archiveHeight: 100 },
      { logs: [mkLog(3)] }, // no nextBlock → done
    ];
    let i = 0;
    const r = await collectPagedLogs(0, async () => pages[i++]!);
    expect(r.complete).toBe(true);
    expect(r.logs.map((l) => l.blockNumber)).toEqual([1, 2, 3]);
  });

  it("terminates (complete) when the resume point passes the archive height — everything read", async () => {
    const r = await collectPagedLogs(0, async () => ({ logs: [mkLog(1)], nextBlock: 200, archiveHeight: 100 }));
    expect(r.complete).toBe(true);
    expect(r.nextBlock).toBeUndefined();
  });

  it("terminates (complete) when nextBlock does not advance — never an infinite loop", async () => {
    const r = await collectPagedLogs(50, async () => ({ logs: [mkLog(1)], nextBlock: 50 }));
    expect(r.complete).toBe(true);
  });

  it("hitting the page cap returns an HONEST partial: complete:false + a resume nextBlock", async () => {
    let calls = 0;
    const r = await collectPagedLogs(
      0,
      async (from) => {
        calls += 1;
        return { logs: [mkLog(from)], nextBlock: from + 1, archiveHeight: 1_000_000 };
      },
      3,
    );
    expect(calls).toBe(3); // bounded by maxPages, no runaway
    expect(r.complete).toBe(false);
    expect(r.nextBlock).toBe(3); // cursor after 3 advances: 0 → 1 → 2 → 3
    expect(r.logs).toHaveLength(3);
  });
});

describe("decode row helpers — direct, including the honest malformed-log skip", () => {
  it("decodeMarketRows emits blockNumber as a string and cST/cPT under the canonical names", () => {
    const rows = decodeMarketRows([marketLog()]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.poolId).toLowerCase()).toBe(POOL);
    expect(String(rows[0]!.corkSwapToken).toLowerCase()).toBe(CST);
    expect(String(rows[0]!.corkPrincipalToken).toLowerCase()).toBe(CPT);
    expect(typeof rows[0]!.blockNumber).toBe("string");
  });

  it("a malformed log is SKIPPED (returns []), never throws — one bad log can't abort the batch", () => {
    const bad: HyperSyncLog = { address: "0x00", topics: ["0xdeadbeef"], data: "0x", blockNumber: 1, transactionHash: "0x00" };
    expect(decodeMarketRows([bad])).toEqual([]);
    expect(decodeCloneRows([bad])).toEqual([]);
    expect(decodeLopFillRows([bad])).toEqual([]);
    expect(decodeRolloverFillRows([bad])).toEqual([]);
    expect(decodeWhitelistRows([bad])).toEqual([]);
  });
});

// ── whitelisted-addresses: event replay + [K7] live-view verification ─────────────────────────

const WLM_ARB = "0xec187ba7bbd4016d8db326ea1dfb3dd48d17bd3a"; // Arbitrum whitelistManager (cork-defaults)
const wlAbi = parseAbi([
  "event GlobalWhitelistAdded(address indexed account)",
  "event GlobalWhitelistRemoved(address indexed account)",
  "event MarketWhitelistAdded(bytes32 indexed poolId, address account)",
  "event MarketWhitelistRemoved(bytes32 indexed poolId, address account)",
  "event MarketWhitelistEnabled(bytes32 indexed poolId)",
]);
const ACCT_G = "0xaaaa000000000000000000000000000000000001";
const ACCT_M = "0xbbbb000000000000000000000000000000000002";
const ACCT_RM = "0xcccc000000000000000000000000000000000003";
const OTHER_POOL = `0x${"dd".repeat(32)}` as `0x${string}`;

function wlLog(eventName: "GlobalWhitelistAdded" | "GlobalWhitelistRemoved" | "MarketWhitelistEnabled", arg: string, block: number): HyperSyncLog {
  const topics =
    eventName === "MarketWhitelistEnabled"
      ? encodeEventTopics({ abi: wlAbi, eventName, args: { poolId: arg as `0x${string}` } })
      : encodeEventTopics({ abi: wlAbi, eventName, args: { account: arg as `0x${string}` } });
  return { address: WLM_ARB, topics: [...topics] as Array<string | null>, data: "0x", blockNumber: block, transactionHash: `0x${"ee".repeat(32)}` };
}

function wlMarketLog(eventName: "MarketWhitelistAdded" | "MarketWhitelistRemoved", poolId: string, account: string, block: number): HyperSyncLog {
  const topics = encodeEventTopics({ abi: wlAbi, eventName, args: { poolId: poolId as `0x${string}` } });
  const data = encodeAbiParameters([{ type: "address" }], [account as `0x${string}`]);
  return { address: WLM_ARB, topics: [...topics] as Array<string | null>, data, blockNumber: block, transactionHash: `0x${"ee".repeat(32)}` };
}

/** All whitelist fixture logs in chain order: global add, market adds (one later removed), enable. */
function wlFixtureLogs(): HyperSyncLog[] {
  return [
    wlLog("GlobalWhitelistAdded", ACCT_G, 100),
    wlMarketLog("MarketWhitelistAdded", POOL, ACCT_M, 101),
    wlMarketLog("MarketWhitelistAdded", POOL, ACCT_RM, 102),
    wlMarketLog("MarketWhitelistAdded", OTHER_POOL, ACCT_M, 103),
    wlLog("MarketWhitelistEnabled", POOL, 104),
    wlMarketLog("MarketWhitelistRemoved", POOL, ACCT_RM, 105), // removal wins over the earlier add
  ];
}

function wlSource(logs: HyperSyncLog[], opts: { complete?: boolean } = {}, seen: Array<{ fromBlock: number; address?: string[] }> = []): HyperSyncSource {
  return {
    async queryLogs(q) {
      seen.push({ fromBlock: q.fromBlock, ...(q.address ? { address: q.address } : {}) });
      const wanted = new Set(q.topics?.[0] ?? []);
      return { logs: logs.filter((l) => wanted.has(String(l.topics[0]))), archiveHeight: 485_999_999, ...(opts.complete === false ? { complete: false, nextBlock: 200 } : {}) };
    },
  };
}

describe("normalizeNapiLog — 1.4.0 topics-array shape AND legacy topic0..3 scalars", () => {
  // LIVE-verified 2026-07-27: the 1.4.0 napi client returns `topics: Array<string|null>`, not
  // topic0..3 scalars — the old mapping read undefined×4 and every decode silently dropped,
  // so full-decentralized reads returned empty-but-"ok". This pins both accepted shapes.
  it("1.4.0 shape: topics array is passed through and padded to 4", () => {
    const l = normalizeNapiLog({ address: "0xabc", topics: ["0x11", "0x22"], data: "0xdd", blockNumber: 7, transactionHash: "0xtt" });
    expect(l.topics).toEqual(["0x11", "0x22", null, null]);
    expect(l.blockNumber).toBe(7);
  });
  it("legacy shape: topic0..3 scalars still map", () => {
    const l = normalizeNapiLog({ address: "0xabc", topic0: "0x11", topic1: null, data: "0xdd", blockNumber: 7, transactionHash: "0xtt" });
    expect(l.topics).toEqual(["0x11", null, null, null]);
  });
  it("a real MarketCreated row in 1.4.0 shape decodes to a market", () => {
    const src = marketLog();
    const rows = decodeMarketRows([normalizeNapiLog({ address: src.address, topics: src.topics, data: src.data, blockNumber: src.blockNumber, transactionHash: src.transactionHash })]);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.poolId).toLowerCase()).toBe(POOL);
  });
});

describe("cork_query whitelisted-addresses (event replay over HyperSync)", () => {
  const noRpc = async () => null;

  it("replays add/remove to CURRENT membership; global rows ride along under a poolId filter", async () => {
    const seen: Array<{ fromBlock: number; address?: string[] }> = [];
    const env = await runTool(
      "cork_query",
      { resource: "whitelisted-addresses", chainId: 42161, filters: { poolId: POOL }, pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: wlSource(wlFixtureLogs(), {}, seen), resolveRpc: noRpc },
    );
    expect(env.state).toBe("ok");
    expect(env.provenance.mode).toBe("full-decentralized");
    expect(seen[0]?.address?.[0]?.toLowerCase()).toBe(WLM_ARB); // scoped to the configured WLM
    const d = env.data as { count: number; items: Array<{ account: string; scope: string; poolId?: string }>; enabledByPool: Record<string, boolean>; verification: string };
    // ACCT_RM was added then removed — replay must exclude it; OTHER_POOL's row is filtered out.
    expect(d.items.map((i) => i.account.toLowerCase()).sort()).toEqual([ACCT_G, ACCT_M].sort());
    expect(d.items.find((i) => i.account.toLowerCase() === ACCT_G)?.scope).toBe("global");
    expect(d.items.find((i) => i.account.toLowerCase() === ACCT_M)?.scope).toBe("market");
    expect(d.enabledByPool[POOL]).toBe(true);
    expect(d.verification).toMatch(/skipped/);
  });

  it("without a poolId filter, every pool's rows and gating flags are returned", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "whitelisted-addresses", chainId: 42161, pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: wlSource(wlFixtureLogs()), resolveRpc: noRpc },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { count: number; items: Array<{ poolId?: string }>; enabledByPool: Record<string, boolean> };
    expect(d.count).toBe(3); // global + POOL market + OTHER_POOL market
    expect(d.items.some((i) => i.poolId === OTHER_POOL)).toBe(true);
    expect(d.enabledByPool[POOL]).toBe(true);
    expect(d.enabledByPool[OTHER_POOL]).toBeUndefined(); // never gated — everyone passes
  });

  it("[K7] live-view verification: rows re-checked against the contract; a disagreement is disclosed", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "whitelisted-addresses", chainId: 42161, filters: { poolId: POOL }, pageSize: 25, format: "concise" },
      {
        nowSeconds: NOW,
        hyperSync: wlSource(wlFixtureLogs()),
        // isGlobalWhitelisted(ACCT_G) → true; isMarketWhitelisted(POOL, ACCT_M) → false (a removal
        // the scan missed) — the chain view outranks the replay and is surfaced, not papered over.
        resolveRpc: stubRpc((c) => c.functionName === "isGlobalWhitelisted"),
      },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { items: Array<{ account: string; verified?: boolean }>; verification: string };
    expect(d.verification).toMatch(/live/);
    expect(d.items.find((i) => i.account.toLowerCase() === ACCT_G)?.verified).toBe(true);
    expect(d.items.find((i) => i.account.toLowerCase() === ACCT_M)?.verified).toBe(false);
    expect(env.warnings.some((w) => w.code === "status_mismatch")).toBe(true);
  });

  it("a partial scan is honest: pagination_incomplete + rows flagged as evidence", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "whitelisted-addresses", chainId: 42161, pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: wlSource(wlFixtureLogs(), { complete: false }), resolveRpc: noRpc },
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "pagination_incomplete")).toBe(true);
  });

  it("centralized mode is structurally rejected (the venue has no whitelist endpoint)", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "whitelisted-addresses", chainId: 42161, mode: "centralized", pageSize: 25, format: "concise" },
      { nowSeconds: NOW, hyperSync: wlSource([]) },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("mode_unavailable");
  });
});
