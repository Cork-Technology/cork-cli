// [K7] chain-verification legs for track reconcile, fully offline: injected venue stub + injected
// RPC client (orderStatus view) + injected logs endpoint (HyperRPC-shaped eth_getLogs).
import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";
import {
  runTool,
  chainStatusName,
  venueChainConsistent,
  resolveLogsEndpoint,
  SETTLER_EVENTS,
  type HandlerContext,
} from "@cork/core";

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
        : async () => ({
            url: "https://stub/rpc",
            source: "explicit" as const,
            client: { readContract: async () => args.chainStatus } as never,
          }),
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
  it("status names follow RolloverTypes.OrderStatus enum order", () => {
    expect([0, 1, 2, 3, 4, 5].map(chainStatusName)).toEqual(["None", "Opened", "Settled", "Expired", "Cancelled", "Closing"]);
  });
  it("venue sub-states (PARTIALLY_FILLED/AWAITING_PREMIUM) map to chain Opened", () => {
    expect(venueChainConsistent("PARTIALLY_FILLED", "Opened")).toBe(true);
    expect(venueChainConsistent("AWAITING_PREMIUM", "Opened")).toBe(true);
    expect(venueChainConsistent("PARTIALLY_FILLED", "Settled")).toBe(false);
  });
  it("logs endpoint resolution: explicit override wins; HyperRPC URL shape from the token", () => {
    expect(resolveLogsEndpoint(42161, "https://x/rpc")).toBe("https://x/rpc");
    const prevToken = process.env.ENVIO_API_TOKEN;
    const prevUrl = process.env.CORK_LOGS_RPC_URL;
    delete process.env.CORK_LOGS_RPC_URL;
    process.env.ENVIO_API_TOKEN = "tok123";
    expect(resolveLogsEndpoint(42161)).toBe("https://42161.rpc.hypersync.xyz/tok123");
    delete process.env.ENVIO_API_TOKEN;
    expect(resolveLogsEndpoint(42161)).toBe(null);
    if (prevToken) process.env.ENVIO_API_TOKEN = prevToken;
    if (prevUrl) process.env.CORK_LOGS_RPC_URL = prevUrl;
  });
  it("the event table covers the full settler lifecycle", () => {
    expect(new Set(Object.values(SETTLER_EVENTS))).toEqual(
      new Set(["OrderSettled", "OrderExpired", "OrderCancelled", "OrderClosing", "RolloverLegFilled", "PremiumLegFilled", "SrcCstRefunded", "DefaulterResidualReclaimed", "DefaulterResidualReclaimedWithSubFiller", "FillerSettled"]),
    );
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
