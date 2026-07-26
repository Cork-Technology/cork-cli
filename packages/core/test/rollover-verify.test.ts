// [K7] chain-verification legs for track reconcile, fully offline: injected venue stub + injected
// RPC client (orderStatus view) + injected logs endpoint (HyperRPC-shaped eth_getLogs).
import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";
import {
  runTool,
  chainStatusName,
  venueChainConsistent,
  resolveLogsEndpoint,
  fetchDigestLogs,
  labelLogs,
  LogsRangeLimited,
  verificationDigest,
  SETTLER_EVENTS,
  type HandlerContext,
} from "@cork/core";
import { stubResolved } from "./helpers.ts";

const NOW = 1_790_000_000n;
const DIGEST = `0x${"4".repeat(64)}`;
const EXACT = "0x983270ae48545665cee4d7ef61c65ff3fdc8222d";

function venueRow(status: string) {
  return {
    order: { orderDigest: DIGEST, status, settler: EXACT, remainingSize: "0" },
    fills: [],
    slots: [],
  };
}

function stubCtx(args: {
  venueStatus: string;
  chainStatus?: number; // orderStatus() return; undefined = no RPC resolves
  logs?: Array<{ topic0: string }>; // undefined = no logs endpoint
  logsError?: string;
}): HandlerContext {
  const ctx: HandlerContext = {
    nowSeconds: NOW,
    venueFetch: async (url) => {
      if (url.includes(`/rollover/orders/${DIGEST}`)) return new Response(JSON.stringify(venueRow(args.venueStatus)), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
    resolveRpc:
      args.chainStatus === undefined
        ? async () => null
        : async () => stubResolved({ readContract: async () => args.chainStatus }),
  };
  if (args.logs !== undefined || args.logsError) {
    ctx.logsUrl = "https://stub-logs/rpc";
    ctx.logsFetch = async () => {
      if (args.logsError) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: args.logsError } }), { status: 200 });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: (args.logs ?? []).map((l, i) => ({ address: EXACT, topics: [l.topic0, DIGEST], data: "0x", blockNumber: `0x${(485000000 + i).toString(16)}`, transactionHash: `0x${"aa".repeat(32)}`, logIndex: "0x0" })),
        }),
        { status: 200 },
      );
    };
  }
  return ctx;
}

const track = (ctx: HandlerContext) =>
  runTool("cork_track", { mode: "reconcile", chainId: 42161, subject: { kind: "orderHash", orderHash: DIGEST }, format: "concise" }, ctx);

describe("status leg (settler orderStatus view)", () => {
  it("venue SETTLED + chain Settled → ok, chain-sourced, consistent", async () => {
    const env = await track(stubCtx({ venueStatus: "SETTLED", chainStatus: 2 }));
    expect(env.state).toBe("ok");
    expect(env.provenance.source).toBe("chain");
    const v = (env.data as { chainVerification: { chainStatus: string; consistent: boolean } }).chainVerification;
    expect(v.chainStatus).toBe("Settled");
    expect(v.consistent).toBe(true);
    // no logs endpoint configured → the gap is disclosed, not hidden
    expect(env.warnings.some((w) => w.code === "logs_unavailable")).toBe(true);
  });

  it("venue PENDING + chain None → consistent (pre-open silence is by design)", async () => {
    const env = await track(stubCtx({ venueStatus: "PENDING", chainStatus: 0 }));
    expect(env.state).toBe("ok");
    expect((env.data as { chainVerification: { consistent: boolean } }).chainVerification.consistent).toBe(true);
  });

  it("venue SETTLED + chain Opened → CONFLICT, chain outranks [K7]", async () => {
    const env = await track(stubCtx({ venueStatus: "SETTLED", chainStatus: 1 }));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("status_mismatch");
    expect(env.warnings[0]?.message).toContain("chain outranks indexer");
    const d = env.data as { venueStatus: string; chainStatus: string };
    expect(d.venueStatus).toBe("SETTLED");
    expect(d.chainStatus).toBe("Opened");
  });

  it("no RPC resolvable → venue-reported result with the disclosure warning", async () => {
    const env = await track(stubCtx({ venueStatus: "OPENED" }));
    expect(env.state).toBe("ok");
    expect(env.provenance.source).toBe("indexer");
    expect(env.warnings.some((w) => w.code === "venue_reported")).toBe(true);
  });
});

describe("event-history leg (HyperRPC-shaped logs endpoint)", () => {
  it("labels settler lifecycle events from the digest-topic scan", async () => {
    const env = await track(
      stubCtx({
        venueStatus: "SETTLED",
        chainStatus: 2,
        logs: [
          { topic0: toEventSelector("RolloverLegFilled(bytes32,address,bytes32,uint256,uint256)") },
          { topic0: toEventSelector("PremiumLegFilled(bytes32,address,address,bytes32,uint256)") },
          { topic0: toEventSelector("OrderSettled(bytes32)") },
        ],
      }),
    );
    expect(env.state).toBe("ok");
    const events = (env.data as { chainVerification: { events: Array<{ event: string }> } }).chainVerification.events;
    expect(events.map((e) => e.event)).toEqual(["RolloverLegFilled", "PremiumLegFilled", "OrderSettled"]);
  });

  it("range-capped endpoints are reported as logs_range_limited, never silently truncated", async () => {
    const env = await track(stubCtx({ venueStatus: "SETTLED", chainStatus: 2, logsError: "ranges over 10000 blocks are not supported on freetier" }));
    expect(env.state).toBe("ok"); // status leg still verified
    expect(env.warnings.some((w) => w.code === "logs_range_limited")).toBe(true);
  });
});

describe("helpers", () => {
  it("status names follow RolloverTypes.OrderStatus enum order; out-of-range is reported honestly", () => {
    expect([0, 1, 2, 3, 4, 5].map(chainStatusName)).toEqual(["None", "Opened", "Settled", "Expired", "Cancelled", "Closing"]);
    // An unknown enum value must never masquerade as "None": that could fabricate a
    // status_mismatch (venue OPENED vs fake None) or mask one (venue PENDING matching fake None).
    expect(chainStatusName(99)).toBe("unknown(99)");
    expect(venueChainConsistent("PENDING", chainStatusName(99))).toBe(false);
  });
  it("venue sub-states (PARTIALLY_FILLED/AWAITING_PREMIUM) map to chain Opened", () => {
    expect(venueChainConsistent("PARTIALLY_FILLED", "Opened")).toBe(true);
    expect(venueChainConsistent("AWAITING_PREMIUM", "Opened")).toBe(true);
    expect(venueChainConsistent("PARTIALLY_FILLED", "Settled")).toBe(false);
  });
  it("logs endpoint resolution: explicit override wins; HyperRPC URL shape from the token", () => {
    expect(resolveLogsEndpoint(42161, "https://x/rpc")).toBe("https://x/rpc");
    const prevToken = process.env.ENVIO_API_TOKEN;
    const prevRpcToken = process.env.ENVIO_HYPERRPC_TOKEN;
    const prevUrl = process.env.CORK_LOGS_RPC_URL;
    delete process.env.CORK_LOGS_RPC_URL;
    delete process.env.ENVIO_HYPERRPC_TOKEN;
    process.env.ENVIO_API_TOKEN = "tok123";
    expect(resolveLogsEndpoint(42161)).toBe("https://42161.rpc.hypersync.xyz/tok123");
    // separate Envio products: the dedicated var outranks the shared fallback
    process.env.ENVIO_HYPERRPC_TOKEN = "rpc456";
    expect(resolveLogsEndpoint(42161)).toBe("https://42161.rpc.hypersync.xyz/rpc456");
    delete process.env.ENVIO_HYPERRPC_TOKEN;
    delete process.env.ENVIO_API_TOKEN;
    expect(resolveLogsEndpoint(42161)).toBe(null);
    if (prevToken) process.env.ENVIO_API_TOKEN = prevToken;
    if (prevRpcToken) process.env.ENVIO_HYPERRPC_TOKEN = prevRpcToken;
    if (prevUrl) process.env.CORK_LOGS_RPC_URL = prevUrl;
  });
  it("the event table covers the full settler lifecycle", () => {
    expect(new Set(Object.values(SETTLER_EVENTS))).toEqual(
      new Set(["OrderSettled", "OrderExpired", "OrderCancelled", "OrderClosing", "RolloverLegFilled", "PremiumLegFilled", "SrcCstRefunded", "DefaulterResidualReclaimed", "DefaulterResidualReclaimedWithSubFiller", "FillerSettled"]),
    );
  });
  it("verificationDigest is deterministic and content-addressed", () => {
    const a = verificationDigest({ x: 1, y: "z" });
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verificationDigest({ x: 1, y: "z" })).toBe(a);
    expect(verificationDigest({ x: 2, y: "z" })).not.toBe(a);
  });
});

describe("fetchDigestLogs — the two failure modes are distinguished (never conflated)", () => {
  const common = {
    url: "https://stub-logs/rpc",
    addresses: [EXACT as `0x${string}`],
    digest: DIGEST as `0x${string}`,
    fromBlock: 485_000_000,
  };
  const jsonResp = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it("returns the result array on success", async () => {
    const logs = await fetchDigestLogs({ ...common, fetchImpl: jsonResp({ jsonrpc: "2.0", id: 1, result: [] }) });
    expect(logs).toEqual([]);
  });
  it("range/archive refusals become LogsRangeLimited (a distinct, honest outcome)", async () => {
    await expect(
      fetchDigestLogs({ ...common, fetchImpl: jsonResp({ error: { message: "block range too large" } }) }),
    ).rejects.toBeInstanceOf(LogsRangeLimited);
  });
  it("any other endpoint error surfaces as a generic logs error", async () => {
    await expect(
      fetchDigestLogs({ ...common, fetchImpl: jsonResp({ error: { message: "boom" } }) }),
    ).rejects.toThrow("logs endpoint error: boom");
  });
  it("a transport rejection is reported as unreachable (host redacted), not as an endpoint error", async () => {
    await expect(
      fetchDigestLogs({ ...common, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }),
    ).rejects.toThrow(/logs endpoint \(https:\/\/stub-logs\/<redacted>\) unreachable: ECONNREFUSED/);
  });
  it("a non-Error transport rejection is still reported (stringified)", async () => {
    await expect(
      // throwing a non-Error exercises the String(err) branch of the catch
      fetchDigestLogs({ ...common, fetchImpl: async () => { throw "socket hang up"; } }),
    ).rejects.toThrow(/unreachable: socket hang up/);
  });
  it("NEVER leaks a HyperRPC token: a transport error echoing the token-in-path URL is scrubbed", async () => {
    // undici/fetch transport errors often echo the full request URL — which carries the token in
    // its path for HyperRPC. The thrown message must contain neither the token nor the raw URL.
    const TOKEN = "sk-secret-envio-token-9f3a";
    const url = `https://42161.rpc.hypersync.xyz/${TOKEN}`;
    await expect(
      fetchDigestLogs({ ...common, url, fetchImpl: async () => { throw new Error(`request to ${url} failed`); } }),
    ).rejects.toThrow(/logs endpoint \(https:\/\/42161\.rpc\.hypersync\.xyz\/<redacted>\) unreachable/);
    await fetchDigestLogs({ ...common, url, fetchImpl: async () => { throw new Error(`request to ${url} failed`); } }).catch((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain(url);
    });
  });
  it("an error response with no message falls back to the HTTP status", async () => {
    await expect(
      fetchDigestLogs({ ...common, fetchImpl: async () => new Response("not json", { status: 503 }) }),
    ).rejects.toThrow("logs endpoint error: HTTP 503");
  });
});

describe("labelLogs", () => {
  it("labels known settler events and tags unknown topic0s honestly", () => {
    const known = toEventSelector("OrderSettled(bytes32)");
    const labeled = labelLogs([
      { address: EXACT, topics: [known, DIGEST], data: "0x", blockNumber: "0x1de5b3a0", transactionHash: `0x${"ab".repeat(32)}`, logIndex: "0x0" },
      { address: EXACT, topics: [`0x${"de".repeat(32)}`, DIGEST], data: "0x", blockNumber: "0x1de5b3a1", transactionHash: `0x${"cd".repeat(32)}`, logIndex: "0x1" },
    ]);
    expect(labeled[0]?.event).toBe("OrderSettled");
    expect(labeled[0]?.blockNumber).toBe(String(0x1de5b3a0)); // chain integers ride as strings (F10)
    expect(labeled[1]?.event).toBe("unknown (topic0 0xdededede…)");
  });
  it("does not throw on a log with no topics", () => {
    const labeled = labelLogs([{ address: EXACT, topics: [], data: "0x", blockNumber: "0x0", transactionHash: "0x", logIndex: "0x0" }]);
    expect(labeled[0]?.event).toMatch(/^unknown/);
  });
});

describe("consistency map is EXACT (terminal states never cross-accept — kills map-loosening mutations)", () => {
  it("each venue status accepts exactly its mapped chain status, nothing else", () => {
    const matrix: Array<[string, string]> = [
      ["PENDING", "None"],
      ["OPENED", "Opened"],
      ["PARTIALLY_FILLED", "Opened"],
      ["AWAITING_PREMIUM", "Opened"],
      ["SETTLED", "Settled"],
      ["EXPIRED", "Expired"],
      ["CANCELLED", "Cancelled"],
      ["CLOSING", "Closing"],
    ];
    const chainStates = ["None", "Opened", "Settled", "Expired", "Cancelled", "Closing"] as const;
    for (const [venue, allowed] of matrix) {
      for (const chain of chainStates) {
        expect(venueChainConsistent(venue, chain), `${venue} vs ${chain}`).toBe(chain === allowed);
      }
    }
    // unknown venue statuses are never silently consistent
    expect(venueChainConsistent("SOMETHING_NEW", "Opened")).toBe(false);
  });

  it("venue SETTLED + chain Cancelled → conflict at the tool level (terminal disagreement)", async () => {
    const env = await track(stubCtx({ venueStatus: "SETTLED", chainStatus: 4 }));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("status_mismatch");
  });
});
