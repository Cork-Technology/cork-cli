// hybrid mode's verification legs, fully offline: stubbed venue + stubbed chain. Covers the
// split rule (definitively-refuted rows DROP; indeterminate rows stay labeled 'unverified'),
// the page budget, the per-resource verifiers (book invalidator, pool existence, fills log
// confirmation, trading-pairs exists annotation, rollover settler status), the no-RPC labeled
// degradation, and the rfqs unverifiable disclosure.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { allowedSenderSuffix, hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import { HYBRID_VERIFY_BUDGET } from "../src/handlers/hybrid-verify.ts";
import { runTool } from "../src/handlers.ts";
import { stubRpc } from "./helpers.ts";
import { FakeLopInvalidators } from "./lop-fakes.ts";

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

  it("reads the bit invalidator with the nonce, so a dead order in a non-zero slot DROPS", async () => {
    // Two orders from one maker in slot 4 (nonces 0x401 and 0x402): one spent, one live. The
    // faithful model shifts inside the view; a read keyed on the slot index would see an empty
    // word for both and confirm the dead row (the 2026-08-20 bug).
    const liveNonce = 0x401n;
    const deadNonce = 0x402n;
    const traitsOf = (n: bigint) => (1n << 255n) | (n << 120n);
    const live = await bookRow(11n, { makerTraits: traitsOf(liveNonce) });
    const dead = await bookRow(12n, { makerTraits: traitsOf(deadNonce) });
    const chain = new FakeLopInvalidators();
    chain.spendNonce(maker.address, deadNonce);
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [live, dead]), resolveRpc: chain.resolveRpc() });
    const d = env.data as VerifiedData;
    expect(d.verification).toMatchObject({ confirmed: 1, dropped: 1 });
    expect(d.items[0]!.orderHash).toBe(live.orderHash);
    // One word serves both rows (same maker, same slot): exactly one read, asked with a nonce.
    expect(chain.calls.filter((c) => c.functionName === "bitInvalidatorForOrder").map((c) => c.args[1])).toEqual([liveNonce]);
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

describe("hybrid verification — read dedup + order stability (the parallel rework's properties)", () => {
  it("book rows sharing a (maker, slot) dedupe onto ONE invalidator read", async () => {
    // Both rows: same maker, makerTraits 0 → same bit slot. The word covers 256 orders.
    const a = await bookRow(1n);
    const b = await bookRow(2n);
    let reads = 0;
    const chain = stubRpc((c) => {
      if (c.functionName === "bitInvalidatorForOrder") {
        reads += 1;
        return 0n;
      }
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [a, b]), resolveRpc: chain });
    expect((env.data as VerifiedData).verification.confirmed).toBe(2);
    expect(reads).toBe(1);
  });

  it("fills come back in the VENUE's row order, not cluster order", async () => {
    // Venue order: newest (high block) first; clustering sorts ascending — output must not.
    const hiTx = `0x${"a1".repeat(32)}`;
    const loTx = `0x${"b2".repeat(32)}`;
    const oh = `0x${"0d".repeat(32)}`;
    const rows = [
      { blockNumber: "900000", txHash: hiTx, orderHash: oh },
      { blockNumber: "1000", txHash: loTx, orderHash: oh },
    ];
    const resolveRpc = async () => {
      const base = await stubRpc(() => {
        throw new Error("no readContract expected");
      })(1 as never, undefined as never);
      const client = base!.client as Record<string, unknown>;
      client.request = async (args: { params: [{ fromBlock: string }] }) =>
        // Both clusters find their log — everything confirms; only ORDER is under test.
        [{ transactionHash: Number.parseInt(args.params[0].fromBlock, 16) > 500_000 ? hiTx : loTx, data: `${oh}${"0".repeat(64)}` }];
      return base;
    };
    const env = await query("fills", { venueFetch: venueWith("fills", rows), resolveRpc });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(2);
    expect(d.items.map((i) => i.txHash)).toEqual([hiTx, loTx]);
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
    // chainId 42161: the settler must be a CONFIGURED generation for its view to arbitrate
    // anything — see the provenance-gate test below. (This case ran on chain 1, which has no
    // rollover deployment at all, so it was reading an arbitrary venue-chosen address.)
    const settler = "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D"; // retired July-2026 ExactSettler
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
    const env = await query("rollover-orders", { venueFetch: venueWith("rollover", rows), resolveRpc: chain }, { chainId: 42161 });
    const d = env.data as VerifiedData;
    expect(d.count).toBe(2);
    expect(d.items[0]!.verification).toBe("confirmed");
    expect(d.items[0]!.settlerGeneration).toBe("retired");
    expect(d.items[1]!.verification).toBe("unverified"); // unknown vocabulary kept, labeled
    expect(d.verification.dropped).toBe(1);
  });

  it("rollover kind=orders: a settler this build does not recognize gets ZERO reads and cannot gain chain provenance", async () => {
    // The settler address comes from the venue row. Querying an arbitrary contract would let it
    // answer a lifecycle question we then present as chain truth (audit STATE-003).
    const attacker = "0x4444444444444444444444444444444444444444";
    const active = "0xF4ffd4b3FAedb784b04d1883119840515f224C2f"; // configured ExactSettler
    const rows = [
      { orderDigest: `0x${"41".repeat(32)}`, settler: active, status: "OPENED" },
      { orderDigest: `0x${"42".repeat(32)}`, settler: attacker, status: "OPENED" },
    ];
    const asked: string[] = [];
    const chain = stubRpc((c) => {
      if (c.functionName === "orderStatus") {
        asked.push(c.address.toLowerCase());
        return 1n; // "Opened" — consistent, so a queried attacker row WOULD have confirmed
      }
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("rollover-orders", { venueFetch: venueWith("rollover", rows), resolveRpc: chain }, { chainId: 42161 });
    const d = env.data as VerifiedData;
    expect(asked).toEqual([active.toLowerCase()]); // the attacker was never called
    const byDigest = new Map(d.items.map((i) => [String(i.orderDigest), i]));
    expect(byDigest.get(rows[0]!.orderDigest)).toMatchObject({ verification: "confirmed", settlerGeneration: "active" });
    expect(byDigest.get(rows[1]!.orderDigest)).toMatchObject({ verification: "unverified", settlerGeneration: "unknown" });
    expect(d.verification.dropped).toBe(0); // unverified is not refuted: the row still serves
    const w = env.warnings.find((x) => x.code === "settler_not_recognized")!;
    expect(w.message).toContain(attacker);
  });

  it("rfqs: hybrid's one unverifiable family — rows untouched, disclosure in data.note", async () => {
    const env = await query("rfqs", { venueFetch: venueWith("rfqs", [{ rfqId: "rfq_1" }]), resolveRpc: async () => null }, { chainId: 42161 });
    expect(env.state).toBe("ok");
    const d = env.data as { items: Array<Record<string, unknown>>; note?: string };
    expect(d.items[0]!.verification).toBeUndefined();
    expect(d.note).toMatch(/no on-chain footprint|unverifiable/);
  });
});

describe("hybrid verification — orderbook exclusivity and self-consistency (chain-free, K3)", () => {
  const TAKER = "0x00000000000000000000000000000000000000dd" as const;
  // Shares TAKER's last 10 bytes with different first 10 bytes: the same filler to the LOP.
  const TAKER_TWIN = "0xffffffffffffffffffff000000000000000000dd" as const;
  const STRANGER = "0x00000000000000000000000000000000000000ee" as const;
  const reservedTraits = BigInt(allowedSenderSuffix(TAKER));
  type BookRow = { allowedSender: string | null; exclusivity: string; verification: string };
  const rowsOf = (env: { data: unknown }) => (env.data as { items: BookRow[]; verification: { dropped: number; unverified: number; confirmed: number }; count: number });

  it("without an RPC, every parsed row still carries allowedSender + exclusivity decoded from its signed makerTraits", async () => {
    const open = await bookRow(1n);
    const reserved = await bookRow(2n, { makerTraits: reservedTraits });
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [open, reserved]), resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    const d = rowsOf(env);
    expect(d.items[0]).toMatchObject({ allowedSender: null, exclusivity: "open", verification: "unverified" });
    expect(d.items[1]).toMatchObject({ allowedSender: allowedSenderSuffix(TAKER), exclusivity: "reserved", verification: "unverified" });
    expect(d.verification).toMatchObject({ confirmed: 0, unverified: 2, dropped: 0 });
  });

  it("filters.account classifies a reserved row against the FILL SENDER by its last 10 bytes: twin = for-account, stranger = for-other", async () => {
    const reserved = await bookRow(2n, { makerTraits: reservedTraits });
    const open = await bookRow(1n);
    const mine = await query("orderbook", { venueFetch: venueWith("orderbook", [reserved, open]), resolveRpc: async () => null }, { filters: { account: TAKER_TWIN } });
    expect(rowsOf(mine).items[0]!.exclusivity).toBe("reserved-for-account");
    expect(rowsOf(mine).items[1]!.exclusivity).toBe("open"); // an open row is open for everyone
    const theirs = await query("orderbook", { venueFetch: venueWith("orderbook", [reserved]), resolveRpc: async () => null }, { filters: { account: STRANGER } });
    expect(rowsOf(theirs).items[0]!.exclusivity).toBe("reserved-for-other");
  });

  it("the annotation survives the liveness leg: a live reserved row is 'confirmed' AND still classified", async () => {
    const reserved = await bookRow(2n, { makerTraits: reservedTraits });
    const chain = stubRpc((c) => {
      if (c.functionName === "bitInvalidatorForOrder") return 0n;
      throw new Error(`no stub for ${c.functionName}`);
    });
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [reserved]), resolveRpc: chain }, { filters: { account: TAKER } });
    expect(rowsOf(env).items[0]).toMatchObject({ verification: "confirmed", allowedSender: allowedSenderSuffix(TAKER), exclusivity: "reserved-for-account" });
    expect(rowsOf(env).verification.confirmed).toBe(1);
  });

  it("the venue's allowedSender echo is replaced by the local decode; a contradicting echo is disclosed, an agreeing one is silent", async () => {
    const reserved = await bookRow(2n, { makerTraits: reservedTraits });
    const lying = { ...reserved, allowedSender: allowedSenderSuffix(STRANGER) }; // the venue mis-decodes
    const env = await query("orderbook", { venueFetch: venueWith("orderbook", [lying]), resolveRpc: async () => null });
    expect(rowsOf(env).items[0]!.allowedSender).toBe(allowedSenderSuffix(TAKER)); // ours, from the signed word
    expect(env.warnings.some((w) => w.code === "listing_traits_mismatch" && w.message.includes("allowedSender"))).toBe(true);
    // The venue says open (null) about a reserved order: also a contradiction.
    const nullLie = await query("orderbook", { venueFetch: venueWith("orderbook", [{ ...reserved, allowedSender: null }]), resolveRpc: async () => null });
    expect(nullLie.warnings.some((w) => w.code === "listing_traits_mismatch")).toBe(true);
    // An agreeing echo (case-flipped) and an open row echoed as null: no warning.
    const honest = await query("orderbook", { venueFetch: venueWith("orderbook", [{ ...reserved, allowedSender: allowedSenderSuffix(TAKER).toUpperCase().replace("0X", "0x") }, { ...(await bookRow(1n)), allowedSender: null }]), resolveRpc: async () => null });
    expect(honest.warnings.some((w) => w.code === "listing_traits_mismatch")).toBe(false);
  });

  it("a row that does not hash to its own claimed orderHash is DROPPED without a chain read (order_hash_mismatch), RPC or not", async () => {
    const honest = await bookRow(1n);
    const liar = { ...(await bookRow(2n)), orderHash: honest.orderHash }; // claims another order's hash
    for (const resolveRpc of [async () => null, stubRpc((c) => (c.functionName === "bitInvalidatorForOrder" ? 0n : (() => { throw new Error("no stub"); })()))]) {
      const env = await query("orderbook", { venueFetch: venueWith("orderbook", [honest, liar]), resolveRpc });
      expect(env.state).toBe("ok");
      expect(rowsOf(env).count).toBe(1);
      expect(rowsOf(env).verification.dropped).toBe(1);
      expect(env.warnings.some((w) => w.code === "order_hash_mismatch" && w.message.includes("DROPPED"))).toBe(true);
    }
  });
});
