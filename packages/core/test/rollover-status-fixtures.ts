import { buildRolloverIntent, resolveRollover, type HandlerContext } from "@cork/core";
import { stubRpc } from "./helpers.ts";

export const NOW = 1_790_000_000n;
export const CHAIN = 8453;
const SETTLER = (await resolveRollover(CHAIN)).rollover!.exactSettler as `0x${string}`;

// Authored wire fixtures for production c10ae6b (field omitted) and additive API119
// 9a8b35d (raw status plus effectiveStatus), not evidence of a live API or settler.
export interface RolloverRow extends Record<string, unknown> {
  orderDigest: string;
  settler: string;
  status: string;
  effectiveStatus?: unknown;
  fillDeadline: string;
  expiredAt: string | null;
}

export function rolloverRow(deadline = NOW - 1n): RolloverRow {
  const built = buildRolloverIntent({
    chainId: CHAIN, user: "0x0000000000000000000000000000000000000011", settler: SETTLER,
    rolloverContract: "0x0000000000000000000000000000000000000012", srcCstToken: "0x0000000000000000000000000000000000000013",
    dstCstToken: "0x0000000000000000000000000000000000000014", premiumToken: "0x0000000000000000000000000000000000000015",
    srcPoolId: `0x${"11".repeat(32)}`, dstPoolId: `0x${"22".repeat(32)}`, orderSize: 100n, minPremiumPerShare: 1n,
    openDeadline: deadline - 60n, fillDeadline: deadline, clientRequestId: "effective-status-" + deadline,
  });
  return {
    orderDigest: built.orderDigest, chainId: CHAIN, settler: SETTLER, status: "PENDING",
    openDeadline: (deadline - 60n).toString(), fillDeadline: deadline.toString(), remainingSize: "100", expiredAt: null,
    payload: { chainId: CHAIN, order: built.venuePost.order, intent: built.venuePost.intent, signature: "0x1234" },
  };
}

export function rolloverContext(row: RolloverRow, chainStatus: number | "error" = 0, logsStatus: "ok" | "error" = "ok") {
  const requests: URL[] = [];
  const reads: string[] = [];
  const context: HandlerContext = {
    nowSeconds: NOW,
    venueFetch: async (url) => {
      const u = new URL(url);
      requests.push(u);
      if (u.pathname === `/rollover/v1/orders/${row.orderDigest}`) return Response.json({ order: row, fills: [], slots: [] });
      if (u.pathname === "/rollover/v1/orders") return Response.json({ items: [row], hasMore: false });
      throw new Error("unexpected venue route: " + u.pathname);
    },
    resolveRpc: stubRpc((call) => {
      if (call.functionName !== "orderStatus") throw new Error("unexpected chain read: " + call.functionName);
      reads.push(call.address.toLowerCase());
      if (chainStatus === "error") throw new Error("fixture RPC unavailable");
      return chainStatus;
    }),
    logsUrl: "http://rollover-fixture.invalid/logs",
    logsFetch: async () => {
      if (logsStatus === "error") throw new Error("fixture event history unavailable");
      return Response.json({ jsonrpc: "2.0", id: 1, result: [] });
    },
  };
  return { context, requests, reads };
}
