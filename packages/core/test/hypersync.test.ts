// full-decentralized mode, fully offline: an injected HyperSyncSource plays Envio. Covers the
// event-derived resources (markets / LOP fills / rollover fills / clone discovery), the
// structural rejections (resting orders emit no events), decode fidelity against real event
// encodings, and honest degradation when no client/token is available.
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import {
  runTool,
  decodeMarketRows,
  loadHyperSync,
  MARKET_CREATED_TOPIC,
  CLONE_DEPLOYED_TOPIC,
  type HandlerContext,
  type HyperSyncLog,
  type HyperSyncSource,
} from "@cork/core";

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
});
