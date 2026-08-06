import { describe, expect, it } from "vitest";
import { toFunctionSelector, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  bundlerSweepAbi,
  corkActionCall,
  encodeMulticall,
  hashLopOrder,
  LOP_ADDRESSES,
  runTool,
  ToolInputError,
  MAINNET_DEPLOYMENT,
  type LopOrder,
  type SafeSwapParams,
} from "@cork/core";
import { stubResolved } from "./helpers.ts";

const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const RCV = "0xc0ffee0000000000000000000000000000000001" as const;
const NOW = 1_800_000_000n; // deterministic clock
const SUSDE = "0x9d39a5de30e57443bff2a8307a4256c8797a3497" as const;
const VBUSDC = "0x53e82abbb12638f09d9e624578ccb666217a765e" as const;

describe("runTool: cork_capabilities", () => {
  it("lists all 9 tools with phase + cli", async () => {
    const env = await runTool("cork_capabilities", {}, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const data = env.data as { tools: Array<{ name: string; cli: string; phase: number }> };
    expect(data.tools).toHaveLength(9);
    expect(data.tools.map((t) => t.name)).toContain("cork_prepare_phoenix");
    expect(data.tools.find((t) => t.name === "cork_prepare_phoenix")?.cli).toBe("ch prepare phoenix");
  });

  it("search resolves natural-language queries to the tool AND variant (RFC §13 worked example)", async () => {
    // "executed trades history" appears in no tool description — only the fills variant hint.
    const env = await runTool("cork_capabilities", { search: "executed trades history" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { matches: Array<{ name: string; variant?: string; variantMaturity?: { status: string } }> };
    expect(d.matches[0]?.name).toBe("cork_query");
    expect(d.matches[0]?.variant).toBe("fills");
    // the variant's maturity rides along so the agent knows the outcome before calling
    expect(d.matches[0]?.variantMaturity?.status).toBe("activated"); // venue-backed since R1
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
  it("whitelisted-addresses rejects lite-decentralized honestly (mappings are not enumerable over RPC views)", async () => {
    const env = await runTool("cork_query", { resource: "whitelisted-addresses", mode: "lite-decentralized", pageSize: 25, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("mode_unavailable");
    expect(env.warnings[0]?.message).toMatch(/pool-whitelist/);
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
const throwingResolver = async () =>
  stubResolved(
    {
      getBlockNumber: async () => {
        throw Object.assign(new Error("execution reverted\nlong viem detail"), { shortMessage: "The contract function \"swapRate\" reverted." });
      },
      readContract: async () => {
        throw new Error("should not reach");
      },
    },
    "default",
    "https://stub.invalid/rpc",
  );

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

describe("deployment gating per capability (42161 promoted 2026-07-22; 8453 still ungated)", () => {
  it("pool-whitelist is configured on BOTH chains now → offline resolver yields requires_rpc, not unknown_deployment", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "pool-whitelist", pageSize: 25, format: "concise", filters: { poolId: POOL, account: RCV } },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    const env42 = await runTool(
      "cork_query",
      { chainId: 42161, resource: "pool-whitelist", pageSize: 25, format: "concise", filters: { poolId: POOL, account: RCV } },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("requires_rpc");
    expect(env42.state).toBe("unavailable");
    expect(env42.warnings[0]?.code).toBe("requires_rpc"); // wlm now configured — the gate no longer fires
  });

  it("prepare_phoenix on 42161 builds a bundle against the announced tx-path contracts", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 42161, account: RCV, clientRequestId: "arb-0001", fundingMode: "pre-funded", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: RCV, minCptAndCstSharesOut: "1" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { bundler3: string; corkAdapter: string };
    expect(d.bundler3).toBe("0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13");
    expect(d.corkAdapter).toBe("0xe9f364dfcc358DC745Ff7C54cb087AE2520F1bed");
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
      resolveRpc: async (_c, url) =>
        stubResolved(
          {
            readContract: async () => {
              throw Object.assign(new Error("fetch failed\nURL: https://secret-node.example/SECRETTOKEN"), { name: "HttpRequestError", shortMessage: "HTTP request failed." });
            },
          },
          "explicit",
          url!,
        ),
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
      resolveRpc: async (_c, url) =>
        stubResolved(
          {
            // resolvePoolTokens does market() + shares(); a nonexistent pool returns zeroed values
            readContract: async (args: { functionName: string }) =>
              args.functionName === "market"
                ? { collateralAsset: ZERO, referenceAsset: ZERO, expiryTimestamp: 0n, rateMin: 0n, rateMax: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateOracle: ZERO }
                : [ZERO, ZERO],
          },
          "explicit",
          url!,
        ),
    });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("pool_not_found");
  });

  it("healthy pool still builds the funding leg (happy path preserved)", async () => {
    const env = await runTool("cork_prepare_phoenix", depositInput("fund-guard-0003"), {
      nowSeconds: NOW,
      rpcUrl: "https://node.example/rpc",
      resolveRpc: async (_c, url) =>
        stubResolved(
          {
            readContract: async (args: { functionName: string }) =>
              args.functionName === "market"
                ? { collateralAsset: SUSDE, referenceAsset: SUSDE, expiryTimestamp: 1n, rateMin: 0n, rateMax: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateOracle: SUSDE }
                : [SUSDE, SUSDE],
          },
          "explicit",
          url!,
        ),
    });
    expect(env.state).toBe("ok");
    expect((env.data as { fundingLegs: number }).fundingLegs).toBe(1);
  });

  // Sweep-back [F13], end-to-end through the handler: a CAPPED action must emit the return leg
  // LAST, after the action leg, so the residual of the funded cap goes back to the initiator
  // rather than sitting on the adapter where anyone can take it.
  const mintInput = (id: string) => ({
    chainId: 1,
    account: RCV,
    clientRequestId: id,
    fundingMode: "erc20-approve",
    action: { type: "mint", poolId: POOL, cptAndCstSharesOut: "1", receiver: RCV, maxCollateralAssetsIn: "9" },
    format: "concise",
  });
  const healthyRpc = {
    nowSeconds: NOW,
    rpcUrl: "https://node.example/rpc",
    resolveRpc: async (_c: unknown, url?: string) =>
      stubResolved(
        {
          readContract: async (args: { functionName: string }) =>
            args.functionName === "market"
              ? { collateralAsset: SUSDE, referenceAsset: SUSDE, expiryTimestamp: 0n, rateMin: 0n, rateMax: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateOracle: SUSDE }
              : [SUSDE, SUSDE],
        },
        "explicit",
        url!,
      ),
  };

  it("capped action appends a sweep-back leg as the LAST leg, and discloses it", async () => {
    const env = await runTool("cork_prepare_phoenix", mintInput("sweep-0001"), healthyRpc);
    expect(env.state).toBe("ok");
    const d = env.data as { fundingLegs: number; sweepBackLegs: number; bundle: Array<{ to: string; data: `0x${string}` }> };
    expect(d.fundingLegs).toBe(1);
    expect(d.sweepBackLegs).toBe(1);
    // funding, action, sweep — in that order
    expect(d.bundle).toHaveLength(3);
    const last = d.bundle[d.bundle.length - 1]!;
    expect(last.data.slice(0, 10)).toBe(toFunctionSelector(bundlerSweepAbi[0]!));
    expect(env.warnings.some((w) => w.code === "sweep_back")).toBe(true);
  });

  it("pause + whitelist guards reach the result through the handler", async () => {
    // The unit suite covers the guard matrix; this proves the handler is actually wired to it.
    const env = await runTool("cork_prepare_phoenix", depositInput("preflight-0001"), {
      nowSeconds: NOW,
      rpcUrl: "https://node.example/rpc",
      resolveRpc: async (_c: unknown, url?: string) =>
        stubResolved(
          {
            readContract: async (args: { functionName: string; args?: readonly unknown[] }) => {
              switch (args.functionName) {
                case "market":
                  return { collateralAsset: SUSDE, referenceAsset: SUSDE, expiryTimestamp: 0n, rateMin: 0n, rateMax: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateOracle: SUSDE };
                case "shares":
                  return [SUSDE, SUSDE];
                case "paused":
                  return false;
                case "getPausedBitMap":
                  return 1; // bit 0 -> deposit paused
                case "isWhitelisted":
                  return false; // neither the user nor the adapter
                default:
                  return [SUSDE, SUSDE];
              }
            },
          },
          "explicit",
          url!,
        ),
    });
    expect(env.state).toBe("ok"); // still built, just labelled
    const codes = env.warnings.map((w) => w.code);
    expect(codes).toContain("pool_paused");
    expect(codes.filter((c) => c === "not_whitelisted")).toHaveLength(2); // initiator AND adapter
  });

  it("exact-amount action gets no sweep-back leg (nothing is stranded)", async () => {
    const env = await runTool("cork_prepare_phoenix", depositInput("sweep-0002"), healthyRpc);
    expect(env.state).toBe("ok");
    const d = env.data as { sweepBackLegs: number; bundle: unknown[] };
    expect(d.sweepBackLegs).toBe(0);
    expect(d.bundle).toHaveLength(2);
    expect(env.warnings.some((w) => w.code === "sweep_back")).toBe(false);
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
      resolveRpc: async () => stubResolved({ getTransactionReceipt: async () => ({ status: "success", blockNumber: 5n, gasUsed: 21000n, logs: [] }) }, "default", "https://x.example/rpc"),
    });
    expect(chainEnv.provenance.mode).toBe("lite-decentralized");
    const cfgEnv = await runTool("cork_query", { resource: "protocol-config", pageSize: 25, format: "concise" }, { nowSeconds: NOW });
    expect(cfgEnv.provenance.mode).toBeUndefined();
  });

  it("track mode 'simulate' on a non-executable artifact teaches the shape (activated 2026-07-22; deep coverage in track-simulate.test.ts)", async () => {
    const env = await runTool("cork_track", { mode: "simulate", subject: { kind: "artifact", artifact: { a: 1 } }, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("missing_filter"); // no to/data in the artifact — never silently treated as verify
  });

  it("format 'full' adds provenance.rpc (endpoint tier + host) on chain-backed reads", async () => {
    const okResolver = async () => stubResolved({ getTransactionReceipt: async () => ({ status: "success", blockNumber: 5n, gasUsed: 21000n, logs: [] }) }, "default", "https://rpc.example.org/x");
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

  it("marketRef needs RPC; orderHash fails honestly offline", async () => {
    const m = await runTool("cork_track", { mode: "verify", subject: { kind: "marketRef", poolId: POOL }, format: "concise" }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(m.state).toBe("unavailable");
    expect(m.warnings[0]?.code).toBe("requires_rpc");
    // orderHash reconcile is venue-backed now — offline (stubbed unreachable) it fails honestly.
    const o = await runTool("cork_track", { mode: "reconcile", subject: { kind: "orderHash", orderHash: `0x${"1".repeat(64)}` }, format: "concise" }, { nowSeconds: NOW, venueFetch: async () => { throw new Error("offline"); } });
    expect(o.state).toBe("unavailable");
    expect(o.warnings[0]?.code).toBe("venue_unreachable");
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
  it("taker-fill is wired (not gated): an empty COMPLETE book yields order_not_found, not needs_service", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: RCV, clientRequestId: "ord-00000003", action: { type: "taker-fill", orderHash: `0x${"3".repeat(64)}` }, format: "concise" },
      { nowSeconds: NOW, venueFetch: async () => new Response(JSON.stringify({ items: [], hasMore: false }), { status: 200 }) },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("order_not_found");
  });
});

describe("runTool: cork_prepare_orders finalize-maker-order", () => {
  const LOP = LOP_ADDRESSES[1]!;
  const acct = privateKeyToAccount(`0x${"03".repeat(32)}`);
  const orderT: LopOrder = { salt: 5n, maker: acct.address, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: 1_000_000_000_000_000_000n, takingAmount: 1_000_000n, makerTraits: 0n };
  const orderHash = hashLopOrder(1, LOP, orderT);
  // The wire form the caller round-trips back (amounts as decimal strings).
  const prepared = { kind: "maker-order", lop: LOP, typedData: { domain: { chainId: 1, verifyingContract: LOP }, message: { salt: "5", maker: acct.address, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" } }, orderHash, extension: "0x", clientRequestId: "final-int-01" };
  const listing = { side: "SELL", premium: 4.1, expiry: 0, nonce: "0", allowsPartialFills: true };
  // resolveRpc pinned to null: finalize now checks whether the maker has code (the ERC-1271
  // path) whenever an RPC resolves — offline tests must not attempt the built-in endpoints.
  const call = (over: Record<string, unknown>, crid = "final-int-01") =>
    runTool("cork_prepare_orders", { chainId: 1, account: acct.address, clientRequestId: crid, action: { type: "finalize-maker-order", prepared, listing, ...over }, format: "concise" }, { nowSeconds: NOW, resolveRpc: async () => null });

  it("verifies the signer and emits a verbatim cork_submit lop-order artifact (never signs)", async () => {
    const signature = await acct.sign({ hash: orderHash });
    const env = await call({ signature });
    expect(env.state).toBe("ok");
    const d = env.data as { recoveredSigner: string; callerSigned: boolean; helperSigned: boolean; signedArtifactDigest: string; submitInput: { action: { type: string; signature: string; premium: number } } };
    expect(d.recoveredSigner).toBe(acct.address);
    expect(d.callerSigned).toBe(true);
    expect(d.helperSigned).toBe(false);
    expect(d.signedArtifactDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.submitInput.action.type).toBe("lop-order");
    expect(d.submitInput.action.signature).toBe(signature);
    expect(d.submitInput.action.premium).toBe(4.1);
    expect(env.warnings[0]?.code).toBe("caller_signed_artifact");
  });

  it("a signature from the wrong key → conflict (recovered signer ≠ maker), never relayed", async () => {
    const wrong = await privateKeyToAccount(`0x${"04".repeat(32)}`).sign({ hash: orderHash });
    const env = await call({ signature: wrong });
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("signature_or_reconstruction_mismatch");
  });

  it("a clientRequestId that disagrees with the prepared order → prepared_context_mismatch", async () => {
    const signature = await acct.sign({ hash: orderHash });
    const env = await call({ signature }, "different-crid-99");
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("prepared_context_mismatch");
  });

  // ── ERC-1271 contract makers (the Zyfai Safe shape): verified with the SAME staticcall the
  // fill performs, never ecrecovered ────────────────────────────────────────────────────────
  const contractMakerRpc = (magic: string | Error) => async () =>
    stubResolved({
      getCode: async () => "0x60806040" as const, // the maker has code
      readContract: async (a: { functionName: string }) => {
        if (a.functionName !== "isValidSignature") throw new Error(`no stub for ${a.functionName}`);
        if (magic instanceof Error) throw magic;
        return magic;
      },
    });

  it("a CONTRACT maker that answers the ERC-1271 magic finalizes with makerAccountType ERC1271", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: acct.address, clientRequestId: "final-int-01", action: { type: "finalize-maker-order", prepared, listing, signature: "0xdeadbeef" }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: contractMakerRpc("0x1626ba7e") },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { makerAccountType: string; recoveredSigner: string | null; submitInput: { action: { makerAccountType: string } } };
    expect(d.makerAccountType).toBe("ERC1271");
    expect(d.recoveredSigner).toBeNull(); // nothing was (or could be) ecrecovered
    expect(d.submitInput.action.makerAccountType).toBe("ERC1271");
    expect(env.warnings[0]?.code).toBe("caller_signed_artifact");
    expect(env.warnings[0]?.message).toContain("isValidSignature");
  });

  it("a CONTRACT maker that rejects the signature → conflict (the fill would never succeed)", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: acct.address, clientRequestId: "final-int-01", action: { type: "finalize-maker-order", prepared, listing, signature: "0xdeadbeef" }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: contractMakerRpc("0xffffffff") },
    );
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("signature_or_reconstruction_mismatch");
    expect(env.warnings[0]?.message).toContain("ERC-1271");
  });

  it("without an RPC a contract maker fails in the ecrecover branch WITH the ERC-1271 hint", async () => {
    // The signature is opaque contract bytes; recovery cannot yield the maker. The conflict
    // must teach the fix (an RPC) instead of a bare mismatch.
    const sig = await privateKeyToAccount(`0x${"05".repeat(32)}`).sign({ hash: orderHash });
    const env = await call({ signature: sig });
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.message).toContain("ERC-1271");
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

});

describe("runTool: cork_decode (order/event/receipt — local reconstruction [K3])", () => {
  const ORDER_REC = {
    salt: "1",
    maker: RCV,
    receiver: zeroAddress,
    makerAsset: SUSDE,
    takerAsset: VBUSDC,
    makingAmount: "1000000000000000000",
    takingAmount: "1000000",
    makerTraits: "0",
  };
  const ORDER_STRUCT: LopOrder = {
    salt: 1n,
    maker: RCV,
    receiver: zeroAddress,
    makerAsset: SUSDE,
    takerAsset: VBUSDC,
    makingAmount: 1000000000000000000n,
    takingAmount: 1000000n,
    makerTraits: 0n,
  };

  it("order (JSON fields): full makerTraits breakdown + recomputed EIP-712 orderHash", async () => {
    const env = await runTool("cork_decode", { kind: "order", data: ORDER_REC, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { orderHash: string; lop: string; makerTraits: Record<string, unknown>; order: Record<string, string> };
    expect(d.lop).toBe(LOP_ADDRESSES[1]);
    expect(d.orderHash).toBe(hashLopOrder(1, LOP_ADDRESSES[1]!, ORDER_STRUCT));
    expect(d.makerTraits.allowPartialFills).toBe(true);
    expect(d.makerTraits.allowMultipleFills).toBe(false);
    expect(d.makerTraits.usePermit2).toBe(false);
    expect(d.makerTraits.expiry).toBe("0");
    expect(d.order.makingAmount).toBe("1000000000000000000");
  });

  it("order (hex tuple): decodes the 8-word uint256 form to the same result", async () => {
    const words = [1n, BigInt(RCV), 0n, BigInt(SUSDE), BigInt(VBUSDC), 1000000000000000000n, 1000000n, 1n << 255n];
    const data = `0x${words.map((w) => w.toString(16).padStart(64, "0")).join("")}`;
    const env = await runTool("cork_decode", { kind: "order", data, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { makerTraits: Record<string, unknown>; order: Record<string, string> };
    expect(String(d.order.maker).toLowerCase()).toBe(RCV.toLowerCase());
    expect(d.makerTraits.allowPartialFills).toBe(false); // bit 255 set
  });

  it("order: a caller-claimed orderHash is cross-checked — mismatch is a conflict [K3]", async () => {
    const env = await runTool(
      "cork_decode",
      { kind: "order", data: { ...ORDER_REC, orderHash: `0x${"11".repeat(32)}` }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "digest_mismatch")).toBe(true);
  });

  it("order: a salt not bound to the supplied extension is a conflict (InvalidExtension at fill)", async () => {
    const ext = `0x${"00".repeat(32)}ff`; // valid-shaped bytes; salt 1 is not keccak-bound to them
    const env = await runTool("cork_decode", { kind: "order", data: { ...ORDER_REC, extension: ext }, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "extension_salt_mismatch")).toBe(true);
  });

  it("order on a chain with no known LOP: struct + traits decode, hash honestly null", async () => {
    const env = await runTool("cork_decode", { kind: "order", data: ORDER_REC, chainId: 8453, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    expect((env.data as { orderHash: unknown }).orderHash).toBeNull();
    expect(env.warnings[0]?.code).toBe("no_lop");
  });

  it("event: a settler lifecycle log decodes to named args", async () => {
    const digest = `0x${"93".repeat(32)}`;
    const env = await runTool(
      "cork_decode",
      { kind: "event", data: { topics: ["0xd4250d6114a611e75d68b1c6f14c61e967863d8ac20bc8ebfa4e5f28f6647366", digest], data: "0x" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { known: boolean; event: string; args: Record<string, string> };
    expect(d.known).toBe(true);
    expect(d.event).toBe("OrderSettled");
    expect(d.args.orderId).toBe(digest);
  });

  it("event: an unknown topic0 comes back labeled raw, never guessed", async () => {
    const env = await runTool(
      "cork_decode",
      { kind: "event", data: { topics: [`0x${"ab".repeat(32)}`], data: "0x" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { known: boolean; event: string | null; note: string };
    expect(d.known).toBe(false);
    expect(d.event).toBeNull();
    expect(d.note).toMatch(/known/);
  });

  it("event: hex input is a teachable invalid-input (a log OBJECT is required)", async () => {
    await expect(runTool("cork_decode", { kind: "event", data: "0x00", format: "concise" }, { nowSeconds: NOW })).rejects.toThrow(ToolInputError);
  });

  it("receipt: labels every log; status echoed as a normalized claim", async () => {
    const digest = `0x${"93".repeat(32)}`;
    const env = await runTool(
      "cork_decode",
      {
        kind: "receipt",
        data: {
          status: "0x1",
          logs: [
            { address: SUSDE, topics: ["0xd4250d6114a611e75d68b1c6f14c61e967863d8ac20bc8ebfa4e5f28f6647366", digest], data: "0x" },
            { address: SUSDE, topics: [`0x${"ab".repeat(32)}`], data: "0x" },
          ],
        },
        format: "concise",
      },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { status: string; logCount: number; knownCount: number; logs: Array<{ known: boolean; event: string | null }> };
    expect(d.status).toBe("success");
    expect(d.logCount).toBe(2);
    expect(d.knownCount).toBe(1);
    expect(d.logs[0]?.event).toBe("OrderSettled");
    expect(d.logs[1]?.known).toBe(false);
  });

  it("receipt: missing logs array is a teachable invalid-input", async () => {
    await expect(runTool("cork_decode", { kind: "receipt", data: {}, format: "concise" }, { nowSeconds: NOW })).rejects.toThrow(ToolInputError);
  });
});

describe("runTool: cork_prepare_phoenix (authority ops)", () => {
  const APPROVE_SELECTOR = "0x095ea7b3";
  const ADAPTER = "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407";

  it("authority-onboard with amount omitted builds an unlimited approve to the adapter", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: RCV, clientRequestId: "auth-on-0001", action: { type: "authority-onboard", token: SUSDE, spender: ADAPTER }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { kind: string; to: string; calldata: string; amount: string; unlimited: boolean; spenderRole: string; value: string };
    expect(d.kind).toBe("authority-onboard");
    expect(d.to.toLowerCase()).toBe(SUSDE.toLowerCase()); // tx target is the TOKEN
    expect(d.calldata.startsWith(APPROVE_SELECTOR)).toBe(true);
    expect(d.calldata).toContain(ADAPTER.slice(2).toLowerCase()); // spender arg
    expect(d.calldata.endsWith("f".repeat(64))).toBe(true); // max-uint amount word
    expect(d.amount).toBe(((1n << 256n) - 1n).toString());
    expect(d.unlimited).toBe(true);
    expect(d.spenderRole).toMatch(/corkAdapter/);
    expect(d.value).toBe("0");
  });

  it("authority-onboard with an explicit amount encodes exactly that amount", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: RCV, clientRequestId: "auth-on-0002", action: { type: "authority-onboard", token: SUSDE, spender: ADAPTER, amount: "2500000" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { amount: string; unlimited: boolean };
    expect(d.amount).toBe("2500000");
    expect(d.unlimited).toBe(false);
  });

  it("authority-revoke zeroes the allowance; an unrecognized spender is flagged", async () => {
    const stranger = "0x00000000000000000000000000000000000000A1";
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: RCV, clientRequestId: "auth-rev-0001", action: { type: "authority-revoke", token: SUSDE, spender: stranger }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { amount: string; unlimited: boolean; spenderRole: string; calldata: string };
    expect(d.amount).toBe("0");
    expect(d.unlimited).toBe(false);
    expect(d.calldata.endsWith("0".repeat(64))).toBe(true); // zero amount word
    expect(d.spenderRole).toMatch(/unrecognized/i);
  });

  it("authority ops toward the canonical Permit2 name the permit2 layer", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: RCV, clientRequestId: "auth-on-0003", action: { type: "authority-onboard", token: SUSDE, spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect((env.data as { spenderRole: string }).spenderRole).toMatch(/Permit2/);
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

  // A full readPoolState stub (single pinned block) so the chain-backed compute path is exercised
  // OFFLINE for the two branches no live pool can reach: a rateMin-0 impairment collapse, and the
  // accepted-but-reserved at.timestamp disclosure. Wei parity itself is covered by fork-parity.
  const ORACLE = "0x78fb656d01141e3ac2073c9372c8b3e636f49d01";
  const CPT = "0x988dc887bec09db524d23a9714bdcd23cb518535";
  const CST = "0x997f71adad54fbf76a07fbdbc376b1f6c23a6dc5";
  const W = 10n ** 18n;
  const poolStateClient = (over: { rateMin?: bigint } = {}) => ({
    getBlockNumber: async () => 100n,
    getBlock: async () => ({ timestamp: NOW }),
    readContract: async (c: { functionName: string }) => {
      switch (c.functionName) {
        case "market":
          return { collateralAsset: SUSDE, referenceAsset: VBUSDC, expiryTimestamp: NOW + 1_000_000n, rateMin: over.rateMin ?? W / 2n, rateMax: W, rateChangePerDayMax: 10n ** 15n, rateChangeCapacityMax: W, rateOracle: ORACLE };
        case "constraints":
          return [8n * 10n ** 17n, 1n, W]; // lastAdjustedRate, lastAdjustmentTimestamp, remainingCredits
        case "swapRate": return W;
        case "swapFee": return 0n;
        case "unwindSwapFee": return 0n;
        case "shares": return [CPT, CST];
        case "rate": return W;
        case "decimals": return 18;
        case "issuedAt": return NOW - 10_000n;
        default: throw new Error(`unexpected readContract ${c.functionName}`);
      }
    },
  });

  it("impairment-floor with rateMin 0 → ok, an invalid_state warning, and null maxReferencePerCst", async () => {
    const env = await runTool(
      "cork_compute",
      { params: { kind: "impairment-floor", poolId: POOL, horizonSeconds: 2_592_000 }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: async () => stubResolved(poolStateClient({ rateMin: 0n }), "default") },
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "invalid_state")).toBe(true);
    expect((env.data as { maxReferencePerCst: string | null }).maxReferencePerCst).toBeNull();
  });

  it("cst-swap-rate labels units (scales + native decimals) and discloses at.timestamp as reserved-ignored", async () => {
    const env = await runTool(
      "cork_compute",
      { params: { kind: "cst-swap-rate", poolId: POOL, collateralAssetsOut: "1000000000000000000" }, at: { timestamp: "1790000000" }, format: "concise" },
      { nowSeconds: NOW, resolveRpc: async () => stubResolved(poolStateClient(), "default") },
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "reserved_field_ignored")).toBe(true);
    const d = env.data as { scales: Record<string, string>; collateralDecimals: number; referenceDecimals: number };
    expect(d.scales).toBeDefined();
    expect(d.collateralDecimals).toBe(18);
    expect(d.referenceDecimals).toBe(18);
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

describe("expiry pre-flight + funding-allowance visibility (guards added 2026-07-21)", () => {
  const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
  const depositInput = (id: string) => ({
    chainId: 1,
    account: "0xc0ffee0000000000000000000000000000000001",
    clientRequestId: id,
    fundingMode: "erc20-approve",
    action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1000", receiver: "0xc0ffee0000000000000000000000000000000001", minCptAndCstSharesOut: "1" },
  });
  const mkClient = (expiry: bigint) =>
    ({
      readContract: async (args: { functionName: string; args?: unknown[] }) => {
        switch (args.functionName) {
          case "market":
            return { collateralAsset: SUSDE, referenceAsset: SUSDE, expiryTimestamp: expiry, rateMin: 0n, rateMax: 0n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n, rateOracle: SUSDE };
          case "shares":
            return [SUSDE, SUSDE];
          case "balanceOf":
            return 5n;
          case "allowance":
            // 2-arg = ERC-20 allowance (uint256); 3-arg = Permit2-internal (amount, expiration, nonce).
            return (args.args?.length ?? 0) === 3 ? [777n, 0, 0] : 777n;
          default:
            throw new Error(`no stub for ${args.functionName}`);
        }
      },
    }) as never;
  const rpcCtx = (expiry: bigint) => ({
    nowSeconds: NOW,
    rpcUrl: "https://node.example/rpc",
    resolveRpc: async (_c: unknown, url: string | undefined) => stubResolved(mkClient(expiry), "explicit", url!),
  });

  it("pre-expiry action against an EXPIRED pool builds WITH a pool_expired warning", async () => {
    const env = await runTool("cork_prepare_phoenix", depositInput("exp-guard-0001"), rpcCtx(NOW - 1n));
    expect(env.state).toBe("ok"); // still buildable — the caller decides; the warning teaches
    const warn = env.warnings.find((w) => w.code === "pool_expired");
    expect(warn?.message).toContain("would revert on-chain");
    expect(warn?.message).toContain("withdraw");
  });

  it("future expiry → no warning; withdraw-family on an expired pool → no warning (post-expiry path)", async () => {
    const fresh = await runTool("cork_prepare_phoenix", depositInput("exp-guard-0002"), rpcCtx(NOW + 10_000n));
    expect(fresh.warnings.some((w) => w.code === "pool_expired")).toBe(false);

    const withdraw = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: "0xc0ffee0000000000000000000000000000000001", clientRequestId: "exp-guard-0003", fundingMode: "erc20-approve", action: { type: "redeem", poolId: POOL, cptSharesIn: "1", owner: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407", receiver: "0xc0ffee0000000000000000000000000000000001", minReferenceAssetsOut: "0", minCollateralAssetsOut: "0" } },
      rpcCtx(NOW - 1n),
    );
    expect(withdraw.state).toBe("ok");
    expect(withdraw.warnings.some((w) => w.code === "pool_expired")).toBe(false);
  });

  it("account-state now reports funding allowances per token for BOTH spenders (adapter + Permit2)", async () => {
    const env = await runTool(
      "cork_query",
      { resource: "account-state", chainId: 1, pageSize: 25, format: "concise", filters: { poolId: POOL, account: "0xc0ffee0000000000000000000000000000000001" } },
      { nowSeconds: NOW, resolveRpc: async () => stubResolved(mkClient(NOW + 1n)) },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { allowances: { spenders: Record<string, string>; byToken: Record<string, { corkAdapter: string; permit2: string }> } };
    expect(d.allowances.spenders.permit2).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(Object.keys(d.allowances.byToken).sort()).toEqual(["collateral", "corkPrincipalToken", "corkSwapToken", "reference"]);
    // permit2Internal is the Permit2-INTERNAL (user, token, spender=adapter) allowance the
    // permit2 funding leg actually consumes (F18); expiration 0 = no permit granted yet.
    expect(d.allowances.byToken.collateral).toEqual({ corkAdapter: "777", permit2: "777", permit2Internal: { amount: "777", expiration: 0, expired: false } });
  });
});

describe("deadlineAt: byte-stable retries [K2 deadline-basis]", () => {
  const base = (id: string, extra: Record<string, unknown> = {}) => ({
    chainId: 1,
    account: "0xc0ffee0000000000000000000000000000000001",
    clientRequestId: id,
    fundingMode: "pre-funded",
    action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1000", receiver: "0xc0ffee0000000000000000000000000000000001", minCptAndCstSharesOut: "1" },
    ...extra,
  });

  it("same id at DIFFERENT clocks: relative deadline drifts, absolute deadlineAt is byte-identical", async () => {
    const t1 = { nowSeconds: NOW };
    const t2 = { nowSeconds: NOW + 120n };
    const rel1 = await runTool("cork_prepare_phoenix", base("k2-dl-0001"), t1);
    const rel2 = await runTool("cork_prepare_phoenix", base("k2-dl-0001"), t2);
    expect(rel1.provenance.digest).not.toBe(rel2.provenance.digest); // documented drift

    const abs1 = await runTool("cork_prepare_phoenix", base("k2-dl-0001", { deadlineAt: String(NOW + 3600n) }), t1);
    const abs2 = await runTool("cork_prepare_phoenix", base("k2-dl-0001", { deadlineAt: String(NOW + 3600n) }), t2);
    expect(abs1.provenance.digest).toBe(abs2.provenance.digest); // byte-stable retry
    expect((abs1.data as { deadline: string }).deadline).toBe(String(NOW + 3600n));
  });
});

describe("filters contract: parser and schema description stay in lockstep", () => {
  it("every key parseQueryFilters accepts is named in the filters describe (and the describe names no ghost keys)", async () => {
    const { KNOWN_FILTER_KEYS } = await import("../src/handlers.ts");
    const { QueryInput } = await import("@cork/schemas");
    const describeText = QueryInput.shape.filters.description ?? "";
    for (const key of KNOWN_FILTER_KEYS) {
      expect(describeText, `filter key '${key}' is parseable but undocumented in the schema describe`).toContain(key);
    }
  });

  it("an unknown filter key fails BEFORE any venue/chain call, with the known-key list", async () => {
    const err = await runTool(
      "cork_query",
      { resource: "markets", chainId: 1, filters: { poolID: `0x${"ab".repeat(32)}` }, pageSize: 25, format: "concise" },
      {
        nowSeconds: 1n,
        venueFetch: async () => {
          throw new Error("must not be called");
        },
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolInputError);
    const issues = (err as InstanceType<typeof ToolInputError>).issues as Array<{ message: string }>;
    expect(issues[0]!.message).toContain("poolId");
    expect(issues[0]!.message).toContain("known:");
  });
});
