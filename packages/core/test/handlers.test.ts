import { describe, expect, it } from "vitest";
import {
  corkActionCall,
  encodeMulticall,
  runTool,
  ToolInputError,
  MAINNET_DEPLOYMENT,
  type SafeSwapParams,
} from "@cork/core";

const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const RCV = "0xc0ffee0000000000000000000000000000000001" as const;
const NOW = 1_800_000_000n; // deterministic clock

describe("runTool: cork_capabilities", () => {
  it("lists all 9 tools with phase + cli", async () => {
    const env = await runTool("cork_capabilities", {}, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const data = env.data as { tools: Array<{ name: string; cli: string; phase: number }> };
    expect(data.tools).toHaveLength(9);
    expect(data.tools.map((t) => t.name)).toContain("cork_prepare_phoenix");
    expect(data.tools.find((t) => t.name === "cork_prepare_phoenix")?.cli).toBe("ch prepare phoenix");
  });

  it("search returns matching tools with their input schema", async () => {
    const env = await runTool("cork_capabilities", { search: "bundle" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { matches: Array<{ name: string; inputSchema: unknown }> };
    expect(d.matches.length).toBeGreaterThan(0);
    expect(d.matches.some((m) => m.name === "cork_prepare_phoenix")).toBe(true);
    expect(d.matches[0]?.inputSchema).toBeTruthy();
  });

  it("topic resolves a tool (by name, cork_ prefix, or cli leaf)", async () => {
    for (const topic of ["cork_compute", "compute"]) {
      const env = await runTool("cork_capabilities", { topic }, { nowSeconds: NOW });
      expect(env.state).toBe("ok");
      expect((env.data as { name: string }).name).toBe("cork_compute");
    }
    const miss = await runTool("cork_capabilities", { topic: "nonexistent" }, { nowSeconds: NOW });
    expect(miss.state).toBe("unavailable");
    expect(miss.warnings[0]?.code).toBe("unknown_topic");
  });

  it("topic 'verify' re-derives deployed addresses via CREATE2 (all match)", async () => {
    const env = await runTool("cork_capabilities", { topic: "verify" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const data = env.data as { verifications: Array<{ name: string; match: boolean; computed: string }> };
    expect(data.verifications.length).toBeGreaterThan(0);
    expect(data.verifications.every((v) => v.match)).toBe(true);
    expect(data.verifications.find((v) => v.name === "corkAdapter")?.computed).toBe("0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407");
  });
});

describe("envelope provenance digest", () => {
  it("is a deterministic bytes32 content hash of the data", async () => {
    const a = await runTool("cork_capabilities", {}, { nowSeconds: NOW });
    const b = await runTool("cork_capabilities", {}, { nowSeconds: NOW + 100n });
    expect(a.provenance.digest).toMatch(/^0x[0-9a-f]{64}$/);
    // same data (capabilities is static) -> same digest even though fetchedAt differs
    expect(a.provenance.digest).toBe(b.provenance.digest);
  });
});

describe("runTool: cork_query", () => {
  it("protocol-config returns the deployment (no RPC needed)", async () => {
    const env = await runTool("cork_query", { resource: "protocol-config", pageSize: 25, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { deployment: { corkAdapter: string }; create2Deployer: string };
    expect(d.deployment.corkAdapter).toBe("0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407");
    expect(d.create2Deployer).toBe("0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7");
  });
  it("indexer-only resources are honestly unavailable", async () => {
    const env = await runTool("cork_query", { resource: "orderbook", pageSize: 25, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("needs_indexer");
  });
  it("chain resources are requires_rpc when no RPC can be resolved", async () => {
    // Inject a resolver that yields nothing, so this deterministically exercises the no-RPC branch
    // offline (the built-in resolver would otherwise reach the committed default over the network).
    const env = await runTool("cork_query", { resource: "market", pageSize: 25, format: "concise", filters: { poolId: POOL } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("requires_rpc");
  });
});

// A resolver stub whose client fails on first use — drives the chain_read_failed path offline.
const throwingResolver = async () => ({
  url: "https://stub.invalid/rpc",
  source: "default" as const,
  client: {
    getBlockNumber: async () => {
      throw Object.assign(new Error("execution reverted\nlong viem detail"), { shortMessage: "The contract function \"swapRate\" reverted." });
    },
    readContract: async () => {
      throw new Error("should not reach");
    },
  } as never,
});

describe("chain-read failures map to envelopes (never raw exceptions)", () => {
  it("compute cst-swap-rate: revert → unavailable + chain_read_failed", async () => {
    const env = await runTool(
      "cork_compute",
      { params: { kind: "cst-swap-rate", poolId: POOL, collateralAssetsOut: "1" }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: throwingResolver },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("chain_read_failed");
    expect(env.warnings[0]?.message).toContain("reverted");
    expect(env.warnings[0]?.message).not.toContain("long viem detail"); // trimmed, not a stack dump
  });

  it("query market: revert → unavailable + chain_read_failed", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "market", pageSize: 25, format: "concise", filters: { poolId: POOL } },
      { nowSeconds: NOW, resolveRpc: throwingResolver },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("chain_read_failed");
  });

  it("track marketRef: revert → unavailable + chain_read_failed", async () => {
    const env = await runTool(
      "cork_track",
      { mode: "verify", subject: { kind: "marketRef", poolId: POOL }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: throwingResolver },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("chain_read_failed");
  });
});

describe("partial deployments gate per capability (Arbitrum 42161)", () => {
  it("pool-whitelist on 42161 → unknown_deployment (wlm not configured), before any RPC use", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "pool-whitelist", pageSize: 25, format: "concise", filters: { poolId: POOL, account: RCV } },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    // resolver returns null, but the wlm gate must fire FIRST with the more truthful reason
    const env42 = await runTool(
      "cork_query",
      { chainId: 42161, resource: "pool-whitelist", pageSize: 25, format: "concise", filters: { poolId: POOL, account: RCV } },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(env.state).toBe("unavailable"); // mainnet has wlm → falls through to requires_rpc
    expect(env.warnings[0]?.code).toBe("requires_rpc");
    expect(env42.state).toBe("unavailable");
    expect(env42.warnings[0]?.code).toBe("unknown_deployment");
  });

  it("prepare_phoenix on 42161 → unknown_deployment (corkAdapter/bundler3 not configured)", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 42161, account: RCV, clientRequestId: "arb-0001", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: RCV, minCptAndCstSharesOut: "1" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
  });

  it("query on a chain with no deployment at all (8453) → unknown_deployment, not requires_rpc", async () => {
    const env = await runTool(
      "cork_query",
      { chainId: 8453, resource: "market", pageSize: 25, format: "concise", filters: { poolId: POOL } },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
  });
});

describe("prepare_phoenix funding path is guarded (explicit RPC)", () => {
  const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
  const depositInput = (id: string) => ({
    chainId: 1,
    account: RCV,
    clientRequestId: id,
    fundingMode: "erc20-approve",
    action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: RCV, minCptAndCstSharesOut: "1" },
    format: "concise",
  });

  it("transport failure → chain_read_failed envelope (no raw escape, no URL in output)", async () => {
    const env = await runTool("cork_prepare_phoenix", depositInput("fund-guard-0001"), {
      nowSeconds: NOW,
      rpcUrl: "https://secret-node.example/SECRETTOKEN",
      resolveRpc: async (_c, url) => ({
        url: url!,
        source: "explicit" as const,
        client: {
          readContract: async () => {
            throw Object.assign(new Error("fetch failed\nURL: https://secret-node.example/SECRETTOKEN"), { name: "HttpRequestError", shortMessage: "HTTP request failed." });
          },
        } as never,
      }),
    });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("chain_read_failed");
    expect(JSON.stringify(env)).not.toContain("SECRETTOKEN"); // the explicit RPC URL must not leak
  });

  it("nonexistent pool (zeroed market struct) → pool_not_found, never zero-address funding legs", async () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    const env = await runTool("cork_prepare_phoenix", depositInput("fund-guard-0002"), {
      nowSeconds: NOW,
      rpcUrl: "https://node.example/rpc",
      resolveRpc: async (_c, url) => ({
        url: url!,
        source: "explicit" as const,
        client: {
          // resolvePoolTokens does market() + shares(); a nonexistent pool returns zeroed values
          readContract: async (args: { functionName: string }) =>
            args.functionName === "market"
              ? { collateralAsset: ZERO, referenceAsset: ZERO, expiryTimestamp: 0n, rateMin: 0n, rateMax: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateOracle: ZERO }
              : [ZERO, ZERO],
        } as never,
      }),
    });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("pool_not_found");
  });

  it("healthy pool still builds the funding leg (happy path preserved)", async () => {
    const env = await runTool("cork_prepare_phoenix", depositInput("fund-guard-0003"), {
      nowSeconds: NOW,
      rpcUrl: "https://node.example/rpc",
      resolveRpc: async (_c, url) => ({
        url: url!,
        source: "explicit" as const,
        client: {
          readContract: async (args: { functionName: string }) =>
            args.functionName === "market"
              ? { collateralAsset: SUSDE, referenceAsset: SUSDE, expiryTimestamp: 1n, rateMin: 0n, rateMax: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateOracle: SUSDE }
              : [SUSDE, SUSDE],
        } as never,
      }),
    });
    expect(env.state).toBe("ok");
    expect((env.data as { fundingLegs: number }).fundingLegs).toBe(1);
  });
});

describe("input hardening + format semantics", () => {
  it("malformed filters.poolId / filters.account → ToolInputError (CLI exit 2)", async () => {
    await expect(
      runTool("cork_query", { resource: "market", pageSize: 25, format: "concise", filters: { poolId: "not-a-pool" } }, { nowSeconds: NOW }),
    ).rejects.toBeInstanceOf(ToolInputError);
    await expect(
      runTool("cork_query", { resource: "account-state", pageSize: 25, format: "concise", filters: { poolId: POOL, account: "0x123" } }, { nowSeconds: NOW }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("query data mode: unsupported modes fail loudly; chain results are labeled", async () => {
    const gated = await runTool("cork_query", { resource: "market", mode: "centralized", pageSize: 25, format: "concise", filters: { poolId: POOL } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(gated.state).toBe("unavailable");
    expect(gated.warnings[0]?.code).toBe("mode_unavailable");

    // chain-backed envelopes state their mode (lite-decentralized), config ones stay unlabeled
    const chainEnv = await runTool("cork_track", { mode: "reconcile", subject: { kind: "txHash", txHash: `0x${"a".repeat(64)}` }, format: "concise" }, {
      nowSeconds: NOW,
      resolveRpc: async () => ({ url: "https://x.example/rpc", source: "default" as const, client: { getTransactionReceipt: async () => ({ status: "success", blockNumber: 5n, gasUsed: 21000n, logs: [] }) } as never }),
    });
    expect(chainEnv.provenance.mode).toBe("lite-decentralized");
    const cfgEnv = await runTool("cork_query", { resource: "protocol-config", pageSize: 25, format: "concise" }, { nowSeconds: NOW });
    expect(cfgEnv.provenance.mode).toBeUndefined();
  });

  it("track mode 'simulate' is honestly phase-gated (not silently treated as verify)", async () => {
    const env = await runTool("cork_track", { mode: "simulate", subject: { kind: "artifact", artifact: { a: 1 } }, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("phase_gated");
  });

  it("format 'full' adds provenance.rpc (endpoint tier + host) on chain-backed reads", async () => {
    const okResolver = async () => ({
      url: "https://rpc.example.org/x",
      source: "default" as const,
      client: {
        getTransactionReceipt: async () => ({ status: "success", blockNumber: 5n, gasUsed: 21000n, logs: [] }),
      } as never,
    });
    const full = await runTool("cork_track", { mode: "reconcile", subject: { kind: "txHash", txHash: `0x${"a".repeat(64)}` }, format: "full" }, { nowSeconds: NOW, resolveRpc: okResolver });
    expect(full.state).toBe("ok");
    expect(full.provenance.rpc).toEqual({ source: "default", host: "rpc.example.org" });
    const concise = await runTool("cork_track", { mode: "reconcile", subject: { kind: "txHash", txHash: `0x${"a".repeat(64)}` }, format: "concise" }, { nowSeconds: NOW, resolveRpc: okResolver });
    expect(concise.provenance.rpc).toBeUndefined();
  });
});

describe("runTool: cork_track", () => {
  it("artifact: recomputes digest and reconciles match/mismatch", async () => {
    const artifact = { a: 1, b: "x", nested: { c: [1, 2, 3] } };
    const first = await runTool("cork_track", { mode: "verify", subject: { kind: "artifact", artifact }, format: "concise" }, { nowSeconds: NOW });
    expect(first.state).toBe("ok");
    const digest = (first.data as { computedDigest: `0x${string}` }).computedDigest;
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);

    const match = await runTool("cork_track", { mode: "verify", subject: { kind: "artifact", artifact }, expect: { artifactDigest: digest }, format: "concise" }, { nowSeconds: NOW });
    expect(match.state).toBe("ok");
    expect((match.data as { verified: boolean }).verified).toBe(true);

    const wrong = `0x${"0".repeat(64)}` as const;
    const mismatch = await runTool("cork_track", { mode: "verify", subject: { kind: "artifact", artifact }, expect: { artifactDigest: wrong }, format: "concise" }, { nowSeconds: NOW });
    expect(mismatch.state).toBe("conflict");
    expect(mismatch.warnings[0]?.code).toBe("digest_mismatch");
  });

  it("marketRef needs RPC; orderHash needs service", async () => {
    const m = await runTool("cork_track", { mode: "verify", subject: { kind: "marketRef", poolId: POOL }, format: "concise" }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(m.state).toBe("unavailable");
    expect(m.warnings[0]?.code).toBe("requires_rpc");
    const o = await runTool("cork_track", { mode: "reconcile", subject: { kind: "orderHash", orderHash: `0x${"1".repeat(64)}` }, format: "concise" }, { nowSeconds: NOW });
    expect(o.warnings[0]?.code).toBe("needs_service");
  });
});

describe("runTool: cork_prepare_orders", () => {
  const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
  const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e";
  it("maker-order returns EIP-712 typed data + orderHash", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: RCV, clientRequestId: "ord-00000001", action: { type: "maker-order", poolId: POOL, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { kind: string; orderHash: string; typedData: { domain: { name: string }; primaryType: string } };
    expect(d.kind).toBe("maker-order");
    expect(d.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.typedData.primaryType).toBe("Order");
    expect(d.typedData.domain.name).toBe("1inch Aggregation Router");
  });
  it("cancel returns LOP cancelOrder calldata", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: RCV, clientRequestId: "ord-00000002", action: { type: "cancel", orderHash: `0x${"2".repeat(64)}`, makerTraits: "0" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    expect((env.data as { calldata: string }).calldata.startsWith("0x")).toBe(true);
  });
  it("taker-fill / rollover-intent are honestly service-gated", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: RCV, clientRequestId: "ord-00000003", action: { type: "taker-fill", orderHash: `0x${"3".repeat(64)}` }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("needs_service");
  });
});

describe("runTool: cork_decode (calldata)", () => {
  it("decodes a Bundler3 bundle to labeled cork legs", async () => {
    const swap: SafeSwapParams = {
      poolId: POOL,
      collateralAssetsOut: 100n * 10n ** 18n,
      receiver: RCV,
      maxCstSharesIn: 101n * 10n ** 18n,
      maxReferenceAssetsIn: 130n * 10n ** 18n,
      deadline: NOW + 1800n,
    };
    const data = encodeMulticall([corkActionCall(MAINNET_DEPLOYMENT.corkAdapter, "safeSwap", swap)]);
    const env = await runTool("cork_decode", { kind: "calldata", data, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const legs = (env.data as { legs: Array<{ kind: string; action?: string }> }).legs;
    expect(legs[0]?.kind).toBe("cork");
    expect(legs[0]?.action).toBe("safeSwap");
  });

  it("non-calldata kinds are honestly unavailable", async () => {
    const env = await runTool("cork_decode", { kind: "event", data: {}, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("phase_gated");
  });
});

describe("runTool: cork_compute", () => {
  it("rollover-premium-floor is pure and exact", async () => {
    const env = await runTool(
      "cork_compute",
      { params: { kind: "rollover-premium-floor", dstCstProduced: "1000000000000000000000", minPremiumPerShare: "20000000000000000" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    // 1000e18 * 0.02e18 / 1e18 = 20e18
    expect((env.data as { premiumFloor: string }).premiumFloor).toBe("20000000000000000000");
  });

  it("chain-backed kinds are unavailable without an RPC", async () => {
    const env = await runTool(
      "cork_compute",
      { params: { kind: "impairment-floor", poolId: POOL, horizonSeconds: 86400 }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("requires_rpc");
  });
});

describe("runTool: cork_prepare_phoenix", () => {
  it("builds a swap bundle with deterministic deadline + multicall bytes", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      {
        chainId: 1,
        account: RCV,
        clientRequestId: "req-00000001",
        action: { type: "swap", poolId: POOL, collateralAssetsOut: "100000000000000000000", receiver: RCV, maxCstSharesIn: "101000000000000000000", maxReferenceAssetsIn: "130000000000000000000" },
        format: "concise",
      },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const data = env.data as { deadline: string; multicall: string; action: string; corkAdapter: string };
    expect(data.action).toBe("safeSwap");
    expect(data.deadline).toBe((NOW + 1800n).toString());
    expect(data.multicall.startsWith("0x374f435d")).toBe(true); // Bundler3.multicall selector
    // default fundingMode=permit2 + no RPC -> can't resolve token addresses for the funding leg
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc")).toBe(true);
    expect((env.data as { fundingLegs: number }).fundingLegs).toBe(0);
  });

  it("rejects malformed input with ToolInputError", async () => {
    await expect(
      runTool("cork_prepare_phoenix", { chainId: 1, account: "not-an-address", clientRequestId: "x", action: {}, format: "concise" }, { nowSeconds: NOW }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
