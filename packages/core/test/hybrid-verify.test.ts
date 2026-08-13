// hybrid mode's verification legs, fully offline: stubbed venue + stubbed chain. Covers the
// split rule (definitively-refuted rows DROP; indeterminate rows stay labeled 'unverified'),
// the page budget, the per-resource verifiers (book invalidator, pool existence, fills log
// confirmation, trading-pairs exists annotation, rollover settler status), the no-RPC labeled
// degradation, and the rfqs unverifiable disclosure.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import { HYBRID_VERIFY_BUDGET } from "../src/handlers/hybrid-verify.ts";
import { runTool } from "../src/handlers.ts";
import { stubRpc } from "./helpers.ts";

const NOW = 1_790_000_000n;
const LOP = LOP_ADDRESSES[1]!;
const maker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const POOL = `0x${"cc".repeat(32)}` as const;

const venueWith = (path: string, items: unknown[]) => async (url: string) =>
  url.includes(path) ? new Response(JSON.stringify({ items, hasMore: false }), { status: 200 }) : new Response(JSON.stringify({ items: [] }), { status: 200 });

async function bookRow(salt: bigint, over: Partial<LopOrder> = {}) {
  const order: LopOrder = {
    salt,
    maker: maker.address,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: "0x00000000000000000000000000000000000000c5",
    takerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    makingAmount: 10n ** 18n,
    takingAmount: 5n * 10n ** 16n,
    makerTraits: 0n,
    ...over,
  };
  const orderHash = hashLopOrder(1, LOP, order);
  const signature = await maker.sign({ hash: orderHash });
  return {
    orderHash,
    order: { salt: order.salt.toString(), maker: order.maker, receiver: order.receiver, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: order.makingAmount.toString(), takingAmount: order.takingAmount.toString(), makerTraits: order.makerTraits.toString() },
    signature,
    extension: "0x",
    makerAccountType: "EOA",
  };
}

const query = (resource: string, ctxOver: Record<string, unknown>, inputOver: Record<string, unknown> = {}) =>
  runTool("cork_query", { resource, chainId: 1, pageSize: 100, format: "concise", ...inputOver }, { nowSeconds: NOW, ...ctxOver });

type VerifiedData = { count: number; items: Array<Record<string, unknown>>; verification: { confirmed: number; unverified: number; dropped: number; budget: number } };

describe("hybrid verification — orderbook liveness", () => {
  it("live rows confirm; dead rows DROP with status_mismatch (the split rule's definitive half)", async () => {
    const live = await bookRow(1n); // bit slot from nonce 1
    const dead = await bookRow(2n);
    // Slot words: answer per-slot so row 1 reads live and row 2 reads spent. Both rows share
    // maker and (salt-independent) slot 0 under makerTraits 0 — so drive via rawRemaining? No:
    // traits 0 → bit mode, slot 0 for both. Use ONE word that spends dead's mask only.
    // lopInvalidatorPlan(0n) gives slot 0, mask 1 for BOTH rows (nonce bits are in traits, not
    // salt) — so instead make the dead row a DIFFERENT maker whose word is fully spent.
    const strangerKey = privateKeyToAccount(`0x${"05".repeat(32)}`);
    const deadOrder: LopOrder = { salt: 2n, maker: strangerKey.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x00000000000000000000000000000000000000c5", takerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", makingAmount: 10n ** 18n, takingAmount: 5n * 10n ** 16n, makerTraits: 0n };
    const deadHash = hashLopOrder(1, LOP, deadOrder);
    const deadRow = { orderHash: deadHash, order: { ...dead.order, maker: strangerKey.address, salt: "2" }, signature: await strangerKey.sign({ hash: deadHash }), extension: "0x", makerAccountType: "EOA" };
    const chain = stubRpc((c) => {
      if (c.functionName === "bitInvalidatorForOrder") {
        const makerArg = String((c as { args?: readonly unknown[] }).args?.[0] ?? "").toLowerCase();
        return makerArg === maker.address.toLowerCase() ? 0n : ~0n & ((1n << 256n) - 1n); // live vs fully spent
      }
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [live, deadRow]), resolveRpc: chain });
    expect(env.state).toBe("ok");
    const d = env.data as VerifiedData;
    expect(d.count).toBe(1);
    expect(d.items[0]!.verification).toBe("confirmed");
    expect(d.verification).toMatchObject({ confirmed: 1, dropped: 1 });
    expect(env.warnings.some((w) => w.code === "status_mismatch" && w.message.includes("DROPPED"))).toBe(true);
  });

  it("a transport failure keeps the row, labeled 'unverified' (the split rule's indeterminate half)", async () => {
    const row = await bookRow(1n);
    const chain = stubRpc(() => {
      throw new Error("transport");
    });
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [row]), resolveRpc: chain });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(1);
    expect(d.items[0]!.verification).toBe("unverified");
    expect(env.warnings.some((w) => w.code === "chain_read_failed" && w.message.includes("transport"))).toBe(true);
  });

  it("beyond the budget, rows are labeled 'unverified' with a verification_budget warning", async () => {
    const rows = await Promise.all(Array.from({ length: HYBRID_VERIFY_BUDGET + 5 }, (_, i) => bookRow(BigInt(i + 1))));
    const chain = stubRpc((c) => {
      if (c.functionName === "bitInvalidatorForOrder") return 0n;
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [...rows]), resolveRpc: chain }, { pageSize: 100 });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(HYBRID_VERIFY_BUDGET + 5);
    expect(d.verification.confirmed).toBe(HYBRID_VERIFY_BUDGET);
    expect(d.verification.unverified).toBe(5);
    expect(env.warnings.some((w) => w.code === "verification_budget")).toBe(true);
  });

  it("no RPC → every row labeled 'unverified' (the pre-rename behavior, demoted and disclosed)", async () => {
    const row = await bookRow(1n);
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [row]), resolveRpc: async () => null });
    const d = env.data as VerifiedData;
    expect(d.items[0]!.verification).toBe("unverified");
    expect(d.verification).toMatchObject({ confirmed: 0, unverified: 1, dropped: 0 });
    expect(env.warnings.some((w) => w.code === "chain_read_failed" && w.message.includes("venue-claimed"))).toBe(true);
  });
});

describe("hybrid verification — pools, pairs, fills, rollover, rfqs", () => {
  const marketAnswer = (exists: boolean) => ({ collateralAsset: exists ? "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" : "0x0000000000000000000000000000000000000000" });

  it("cork-pools: a pool no configured PM knows is a definitive lie → DROPPED", async () => {
    const chain = stubRpc((c) => {
      if (c.functionName === "market") {
        const poolArg = String((c as { args?: readonly unknown[] }).args?.[0] ?? "").toLowerCase();
        return marketAnswer(poolArg === POOL.toLowerCase());
      }
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("cork-pools", { venueFetch: venueWith("pools", [{ poolId: POOL }, { poolId: `0x${"dd".repeat(32)}` }]), resolveRpc: chain });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(1);
    expect(d.items[0]).toMatchObject({ poolId: POOL, verification: "confirmed" });
    expect(d.verification.dropped).toBe(1);
  });

  it("trading-pairs: NEVER dropped — chain existence is an annotation (JIT lists pre-pool pairs)", async () => {
    const chain = stubRpc((c) => {
      if (c.functionName === "market") {
        const poolArg = String((c as { args?: readonly unknown[] }).args?.[0] ?? "").toLowerCase();
        return marketAnswer(poolArg === POOL.toLowerCase());
      }
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("trading-pairs", { venueFetch: venueWith("markets", [{ poolId: POOL }, { poolId: `0x${"dd".repeat(32)}` }]), resolveRpc: chain });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(2);
    expect(d.items[0]).toMatchObject({ verification: "confirmed", exists: true });
    expect(d.items[1]).toMatchObject({ verification: "confirmed", exists: false });
    expect(d.verification.dropped).toBe(0);
  });

  it("fills: a fill log present at the claimed block confirms; an absent one DROPS", async () => {
    const realTx = `0x${"a1".repeat(32)}`;
    const fakeTx = `0x${"b2".repeat(32)}`;
    const oh = `0x${"0d".repeat(32)}`;
    const rows = [
      { blockNumber: "1000", txHash: realTx, orderHash: oh },
      { blockNumber: "1001", txHash: fakeTx, orderHash: oh },
    ];
    const chain = stubRpc(() => {
      throw new Error("no readContract expected");
    });
    // fills verification goes through client.request(eth_getLogs) — extend the stub's client.
    const resolveRpc = async () => {
      const base = await chain(1 as never, undefined as never);
      const client = base!.client as Record<string, unknown>;
      client.request = async () => [{ transactionHash: realTx, data: `${oh}${"0".repeat(64)}` }];
      return base;
    };
    const env = await query("fills", { venueFetch: venueWith("fills", rows), resolveRpc });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(1);
    expect(d.items[0]).toMatchObject({ txHash: realTx, verification: "confirmed" });
    expect(d.verification.dropped).toBe(1);
    expect(env.warnings.some((w) => w.code === "status_mismatch" && w.message.includes("OrderFilled"))).toBe(true);
  });

  it("rollover kind=orders: settler orderStatus contradicting the venue's status DROPS the row", async () => {
    const settler = "0x983270ae48545665cee4d7ef61c65ff3fdc8222d";
    const rows = [
      { orderDigest: `0x${"11".repeat(32)}`, settler, status: "OPENED" },
      { orderDigest: `0x${"22".repeat(32)}`, settler, status: "OPENED" },
      // A status word the consistency table does NOT know is indeterminate, never a refutation.
      { orderDigest: `0x${"33".repeat(32)}`, settler, status: "SOME_NEW_STATE" },
    ];
    const chain = stubRpc((c) => {
      if (c.functionName === "orderStatus") {
        const digest = String((c as { args?: readonly unknown[] }).args?.[0] ?? "");
        return digest.startsWith("0x11") ? 1n : 2n; // Opened vs Settled
      }
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("rollover-orders", { venueFetch: venueWith("rollover", rows), resolveRpc: chain });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(2);
    expect(d.items[0]!.verification).toBe("confirmed");
    expect(d.items[1]!.verification).toBe("unverified"); // unknown vocabulary kept, labeled
    expect(d.verification.dropped).toBe(1);
  });

  it("rfqs: hybrid's one unverifiable family — rows untouched, disclosure in data.note", async () => {
    const env = await query("rfqs", { venueFetch: venueWith("rfqs", [{ rfqId: "rfq_1" }]), resolveRpc: async () => null }, { chainId: 42161 });
    expect(env.state).toBe("ok");
    const d = env.data as { items: Array<Record<string, unknown>>; note?: string };
    expect(d.items[0]!.verification).toBeUndefined();
    expect(d.note).toMatch(/no on-chain footprint|unverifiable/);
  });
});
