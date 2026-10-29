// Authored offline profiles exercise consumer decisions, not deployed API readiness.
import { describe, expect, it } from "vitest";
import { buildMakerOrder, buildMakerTraits, LOP_ADDRESSES, runTool, type HandlerContext } from "@cork/core";
import { nativeApiMetadataFixture } from "../../core/test/helpers.ts";
import { capture, maker, NOW, signedRow, withSurface } from "./native-api-compat-helpers.ts";
import { getAddress } from "viem";

const hash = capture.unknown.orderHash;
const profiles = [
  { name: "ordinary legacy 200/empty", response: () => Response.json({ items: [], hasMore: false }) },
  { name: "null commit", response: () => Response.json({ ...nativeApiMetadataFixture, commit: null }) },
  { name: "unknown future commit", response: () => Response.json({ ...nativeApiMetadataFixture, commit: "f".repeat(40) }) },
  { name: "six-character reviewed prefix", response: () => Response.json({ ...nativeApiMetadataFixture, commit: nativeApiMetadataFixture.commit.slice(0, 6) }) },
  { name: "non-hex revision", response: () => Response.json({ ...nativeApiMetadataFixture, commit: "72010cg" }) },
  { name: "uppercase revision", response: () => Response.json({ ...nativeApiMetadataFixture, commit: "72010C8" }) },
  { name: "unreviewed revision", response: () => Response.json({ ...nativeApiMetadataFixture, commit: "72010c9" }) },
  { name: "unreviewed neighbour of the 0.6.0 source", response: () => Response.json({ ...nativeApiMetadataFixture, version: "0.6.0", commit: "c0bbf06" }) },
  { name: "paused component", response: () => Response.json({ ...nativeApiMetadataFixture, status: "paused" }) },
  { name: "different component", response: () => Response.json({ ...nativeApiMetadataFixture, component: "another-api" }) },
  { name: "malformed metadata", response: () => Response.json({ ...nativeApiMetadataFixture, commit: 110 }) },
  { name: "HTTP failure", response: () => Response.json({}, { status: 503 }) },
  { name: "invalid JSON", response: () => new Response("not-json") },
  { name: "redirect response", response: () => Response.redirect("https://other.invalid/meta/v1", 307) },
  { name: "transport failure", response: () => { throw new Error("offline transport failure"); } },
];

for (const surface of ["CLI", "MCP"] as const) describe(surface + " native history capability", () => {
  it.each(["72010c8", "72010c88a2d5"])("admits reviewed abbreviation %s before reading exact history", async commit => {
    const row = await signedRow(capture.unknown, "reviewed-abbreviation");
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url =>
      new URL(url).pathname === "/meta/v1"
        ? Response.json({ ...nativeApiMetadataFixture, version: "0.5.0", commit })
        : Response.json({ items: [row], hasMore: false }),
    }, async call => {
      const result = await call("cork_query", { resource: "orderbook", chainId: 8453, filters: { orderHash: row.orderHash } });
      expect(result.failed).toBe(false);
      expect(result.envelope).toMatchObject({ state: "ok", data: { items: [row] } });
    });
  });

  it.each(["c0bbf05", "c0bbf0552de9687612ce58a73b0d5cc819ad7059"])("admits the reviewed cork-api 0.6.0 source %s before reading exact history", async commit => {
    const row = await signedRow(capture.unknown, "reviewed-0.6.0");
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url =>
      new URL(url).pathname === "/meta/v1"
        ? Response.json({ ...nativeApiMetadataFixture, version: "0.6.0", commit })
        : Response.json({ items: [row], hasMore: false }),
    }, async call => {
      const result = await call("cork_query", { resource: "orderbook", chainId: 8453, filters: { orderHash: row.orderHash } });
      expect(result.failed).toBe(false);
      expect(result.envelope).toMatchObject({ state: "ok", data: { items: [row] } });
    });
  });

  it.each(profiles)("$name cannot turn an empty book into admitted history", async profile => {
    const requests: string[] = [];
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url => {
      requests.push(new URL(url).pathname);
      return new URL(url).pathname === "/meta/v1" ? profile.response() : Response.json({ items: [], hasMore: false });
    } }, async call => {
      const { envelope, failed } = await call("cork_query", { resource: "orderbook", chainId: 8453, filters: { orderHash: hash } });
      expect(failed).toBe(true);
      expect(envelope).toMatchObject({ state: "unavailable", data: null });
      expect(envelope.warnings.map(w => w.code)).toContain("native_api_unavailable");
      expect(envelope.warnings.map(w => w.code)).not.toContain("order_not_found");
    });
    expect(requests).toEqual(["/meta/v1"]);
  });

  it("unknown capability retains distinct fills without complete totals or a non-resting conclusion", async () => {
    const requests: string[] = [];
    const fills = [...capture.fillsPages[0]!.body.items, ...capture.fillsPages[1]!.body.items];
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path.startsWith("/rollover/")) return Response.json({}, { status: 404 });
      if (path === "/meta/v1") return Response.json({ ...nativeApiMetadataFixture, commit: null });
      return Response.json({ items: path.endsWith("/fills") ? fills : [], hasMore: false });
    } }, async call => {
      const result = await call("cork_track", { mode: "reconcile", chainId: 8453, subject: { kind: "orderHash", orderHash: hash } });
      expect(result.failed).toBe(false);
      expect(result.envelope.data).toMatchObject({ resting: null, fillsScanComplete: false, count: 2, fills: [{ logIndex: 2, takingAmount: "8" }, { logIndex: 1, takingAmount: "2", observedBlockTimestamp: null }] });
      expect(result.envelope.warnings.map(w => w.code)).toContain("native_api_unavailable");
      expect(result.envelope.warnings.map(w => w.code)).not.toContain("order_not_found");
    });
    expect(requests.filter(path => path === "/meta/v1")).toHaveLength(1);
  });

  it("unknown capability makes independently observed fill pagination incomplete, not empty", async () => {
    const requests: string[] = [];
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url => {
      const path = new URL(url).pathname;
      requests.push(path);
      return path === "/meta/v1" ? Response.json({ ...nativeApiMetadataFixture, commit: null }) : Response.json({ items: capture.fillsPages[0]!.body.items, hasMore: false });
    } }, async call => {
      const result = await call("cork_query", { resource: "fills", chainId: 8453, filters: { orderHash: hash } });
      expect(result.envelope.state).toBe("ok");
      expect(result.envelope.data).toMatchObject({ pagination: { complete: false }, items: [{ logIndex: 2, makingAmount: "3", takingAmount: "8" }] });
      expect(result.envelope.warnings.map(w => w.code)).toContain("native_api_unavailable");
    });
    expect(requests).toEqual(["/meta/v1", "/limit-orders/v1/fills"]);
  });

  it("unsupported empty fills are unavailable rather than complete zero history", async () => {
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async () => Response.json({ items: [], hasMore: false }) }, async call => {
      const result = await call("cork_query", { resource: "fills", chainId: 8453, filters: { orderHash: hash } });
      expect(result.failed).toBe(true);
      expect(result.envelope).toMatchObject({ state: "unavailable", data: null });
      expect(result.envelope.warnings.map(w => w.code)).not.toContain("order_not_found");
    });
  });

  it("a long-lived client rereads capability rather than reusing a prior admission", async () => {
    const row = await signedRow(capture.unknown, "capability-client-lifetime");
    let admitted = true;
    const requests: string[] = [];
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url => {
      const path = new URL(url).pathname;
      requests.push(path);
      return path === "/meta/v1" ? Response.json({ ...nativeApiMetadataFixture, commit: admitted ? nativeApiMetadataFixture.commit : null }) : Response.json({ items: [row], hasMore: false });
    } }, async call => {
      const input = { resource: "orderbook", chainId: 8453, filters: { orderHash: row.orderHash } };
      expect((await call("cork_query", input)).envelope.data).toMatchObject({ items: [row] });
      admitted = false;
      expect((await call("cork_query", input)).envelope).toMatchObject({ state: "unavailable", data: null });
    });
    expect(requests).toEqual(["/meta/v1", "/limit-orders/v1/orderbook", "/meta/v1"]);
  });

  it("one operation shares metadata across its fill pages without merging same-tx identities", async () => {
    const requests: string[] = [];
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url => {
      const u = new URL(url);
      requests.push(u.pathname);
      if (u.pathname === "/meta/v1") return Response.json(nativeApiMetadataFixture);
      return Response.json(capture.fillsPages[u.searchParams.has("cursor") ? 1 : 0]!.body);
    } }, async call => {
      const result = await call("cork_query", { resource: "fills", chainId: 8453, filters: { orderHash: hash }, pageSize: 1, maxPages: 2 });
      expect(result.envelope.data).toMatchObject({ pagination: { complete: true, pagesFetched: 2 }, items: [{ logIndex: 2 }, { logIndex: 1 }] });
    });
    expect(requests).toEqual(["/meta/v1", "/limit-orders/v1/fills", "/limit-orders/v1/fills"]);
  });

  it("nested offers/RFQ book reads share one invocation-local metadata admission", async () => {
    const row = await signedRow(capture.unknown, "capability-nested-offers");
    const requests: string[] = [];
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path === "/meta/v1") return Response.json(nativeApiMetadataFixture);
      return Response.json({ items: path.endsWith("/orderbook") ? [row] : [], hasMore: false });
    } }, async call => {
      const result = await call("cork_query", { resource: "offers", chainId: 8453 });
      expect(result.envelope.state).toBe("ok");
      expect(result.envelope.data).toMatchObject({ items: [{ orderHash: row.orderHash }] });
    });
    expect(requests.filter(path => path === "/meta/v1")).toHaveLength(1);
  });

  it("unadmitted history refuses slot-mask, taker and refresh advice before any book or RPC resolution", async () => {
    const traits = buildMakerTraits({ allowPartialFills: false, allowMultipleFills: false, usePermit2: false, expiry: 0n, nonce: (0x1234n << 8n) | 5n });
    const requests: string[] = [];
    let resolutions = 0;
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => { resolutions++; return null; }, venueFetch: async url => {
      requests.push(new URL(url).pathname);
      return Response.json({ items: [], hasMore: false });
    } }, async call => {
      for (const action of [{ type: "cancel", scope: "slot", makerTraits: traits.toString(), orderHash: hash }, { type: "taker-fill", orderHash: hash }, { type: "refresh-order", orderHash: hash }]) {
        const result = await call("cork_prepare_orders", { chainId: 8453, account: maker.address, clientRequestId: "capability-unknown-" + action.type, action });
        expect(result.failed).toBe(true);
        expect(result.envelope).toMatchObject({ state: "unavailable", data: null });
        expect(result.envelope.warnings.map(w => w.code)).toContain("native_api_unavailable");
        expect(result.envelope.warnings.map(w => w.code)).not.toContain("order_not_found");
      }
    });
    expect(requests).toEqual(["/meta/v1", "/meta/v1", "/meta/v1"]);
    expect(resolutions).toBe(0);
  });

  it("management/all-status pagination retires an anchor and expired same-slot sibling with mask512", async () => {
    const slot = 0x1234n;
    const wire = async (bit: bigint, expiry: bigint, status: string) => {
      const built = buildMakerOrder({ chainId: 8453, lop: LOP_ADDRESSES[8453]!, maker: maker.address, makerAsset: getAddress(capture.unknown.makerAsset), takerAsset: getAddress(capture.unknown.takerAsset), makingAmount: 10n, takingAmount: 7n, nonce: (slot << 8n) | bit, expiry, clientRequestId: "capability-slot-" + bit });
      return { chainId: 8453, status, orderHash: built.orderHash, order: Object.fromEntries(Object.entries(built.order).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])), extension: built.extension, signature: await maker.sign({ hash: built.orderHash }), makerAccountType: "EOA" };
    };
    const anchor = await wire(5n, NOW + 3600n, "OPEN");
    const sibling = await wire(9n, NOW - 1n, "EXPIRED");
    const requests: URL[] = [];
    await withSurface(surface, { nowSeconds: NOW, resolveRpc: async () => null, venueFetch: async url => {
      const u = new URL(url);
      requests.push(u);
      if (u.pathname === "/meta/v1") return Response.json(nativeApiMetadataFixture);
      const valid = u.searchParams.get("chainId") === "8453" && u.searchParams.get("maker")?.toLowerCase() === maker.address.toLowerCase() && u.searchParams.get("view") === "management";
      if (!valid) return Response.json({ items: [], hasMore: false });
      return Response.json(u.searchParams.has("cursor") ? { items: u.searchParams.getAll("status").includes("EXPIRED") ? [sibling] : [], hasMore: false } : { items: [anchor], hasMore: true, nextCursor: "expired-sibling" });
    } }, async call => {
      const result = await call("cork_prepare_orders", { chainId: 8453, account: maker.address, clientRequestId: "capability-slot-retirement", action: { type: "cancel", scope: "slot", orderHash: anchor.orderHash, makerTraits: anchor.order.makerTraits } });
      expect(result.failed).toBe(false);
      expect(result.envelope.data).toMatchObject({ retires: { additionalMask: "0x" + 512n.toString(16).padStart(64, "0"), additionalBits: [9], book: { complete: true, pagesFetched: 2 }, orders: [{ orderHash: anchor.orderHash }, { orderHash: sibling.orderHash }] } });
    });
    expect(requests.filter(u => u.pathname === "/meta/v1")).toHaveLength(1);
  });
});

it("a pre-aborted native history request performs no HTTP and preserves request_aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const context: HandlerContext = { signal: controller.signal, venueFetch: async () => { requests++; return Response.json(nativeApiMetadataFixture); } };
  const result = await runTool("cork_query", { resource: "orderbook", chainId: 8453, filters: { orderHash: hash } }, context);
  expect(result).toMatchObject({ state: "unavailable", data: null });
  expect(result.warnings.map(w => w.code)).toContain("request_aborted");
  expect(requests).toBe(0);
});
