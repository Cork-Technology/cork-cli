// maker-ladder — a fan-out over the maker-order path. Every assertion here runs the REAL handler
// offline (chainId 1, no RPC, no stubs): rung artifacts are built by the same code one maker
// order uses, so what this suite pins is the ladder-shaped layer only — rung ids, the nonce
// policy, capacity accounting, the single notice, and fail-closed on any rung.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ladderRungClientRequestId, LADDER_ID_MAX, ocoGroupNonce, runTool } from "@cork/core";
import { stubRpc } from "./helpers.ts";

const NOW = 1_800_000_000n;
const A = "0xc0ffee0000000000000000000000000000000001" as const;
const TAKER = "0xc0ffee0000000000000000000000000000000002" as const;
const POOL = `0x${"ce".repeat(32)}` as const;
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;

type Rung = { index: number; clientRequestId: string; reach: string; grouped: boolean; label?: string; nonce: string; ocoGroup: string | null; orderHash: `0x${string}`; extension: `0x${string}`; allowedSender: string | null; fusion?: unknown; typedData: { message: { makingAmount: string; takingAmount: string } } };
type LadderData = { kind: string; lop: string; ladder: { clientRequestId: string; ocoGroup: string; noncePolicy: string; rungCount: number }; rungs: Rung[]; capacity: { makerAssetRequired: string; rule: string }; scales: Record<string, string>; execution: { kind: string; then: string[] } };

const base = { poolId: POOL, side: "SELL" as const, makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", expirySeconds: 600 };
const threeRungs = [
  { takingAmount: "1000000", allowedSender: TAKER, label: "reserved-1" },
  { takingAmount: "950000", allowedSender: TAKER, label: "reserved-2" },
  { takingAmount: "980000", expirySeconds: 3600, auction: { durationSeconds: 1800, initialRateBump: "500000" }, label: "open-decay" },
];
const ladder = (id: string, action: Record<string, unknown>) => runTool("cork_prepare_orders", { chainId: 1, account: A, clientRequestId: id, action: { type: "maker-ladder", ...base, ...action } }, { nowSeconds: NOW });
const single = (id: string, action: Record<string, unknown>) => runTool("cork_prepare_orders", { chainId: 1, account: A, clientRequestId: id, action: { type: "maker-order", ...base, ...action } }, { nowSeconds: NOW });

describe("maker-ladder: rung identity", () => {
  it("each rung is the maker-order artifact the same input would build alone, under the derived id", async () => {
    const env = await ladder("ladder-id-0001", { rungs: threeRungs });
    expect(env.state).toBe("ok");
    const d = env.data as LadderData;
    expect(d.kind).toBe("maker-ladder");
    expect(d.ladder).toEqual({ clientRequestId: "ladder-id-0001", ocoGroup: "ladder-id-0001", noncePolicy: "shared-reserved", rungCount: 3 });
    expect(d.rungs.map((r) => r.clientRequestId)).toEqual([0, 1, 2].map((i) => ladderRungClientRequestId("ladder-id-0001", i)));
    expect(d.rungs.map((r) => r.label)).toEqual(["reserved-1", "reserved-2", "open-decay"]);
    // Rung 1 rebuilt as a stand-alone maker-order with the same derived id and group: byte-identical.
    const alone = await single(ladderRungClientRequestId("ladder-id-0001", 1), { takingAmount: "950000", allowedSender: TAKER, ocoGroup: "ladder-id-0001" });
    expect(alone.state).toBe("ok");
    expect((alone.data as Rung).orderHash).toBe(d.rungs[1]!.orderHash);
    // The open decaying rung carries the Fusion extension the maker-order path builds; reserved rungs are plain.
    expect(d.rungs[2]!.fusion).toBeDefined();
    expect(d.rungs[2]!.extension).not.toBe("0x");
    expect(d.rungs[0]!.extension).toBe("0x");
    expect(d.rungs[0]!.allowedSender).not.toBeNull();
    expect(d.rungs[2]!.allowedSender).toBeNull();
    expect(d.execution.kind).toBe("eip712-typed-data");
    expect(d.execution.then.join(" ")).toMatch(/EACH rung[\s\S]*finalize-maker-order per rung[\s\S]*cork_submit lop-order per rung/);
  });

  it("a retried ladder is byte-identical; a different ladder id is a different ladder", async () => {
    const a = await ladder("ladder-retry-0001", { rungs: threeRungs });
    const b = await ladder("ladder-retry-0001", { rungs: threeRungs });
    const c = await ladder("ladder-retry-0002", { rungs: threeRungs });
    const hashes = (e: typeof a) => (e.data as LadderData).rungs.map((r) => r.orderHash);
    expect(hashes(a)).toEqual(hashes(b));
    expect(hashes(a)).not.toEqual(hashes(c));
    expect(new Set(hashes(a)).size).toBe(3); // rungs never collide with each other
  });

  it("refuses a ladder id too long to carry rung suffixes, before building anything", async () => {
    const env = await ladder("x".repeat(LADDER_ID_MAX + 1), { rungs: threeRungs });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toContain(String(LADDER_ID_MAX));
    expect(() => ladderRungClientRequestId("x".repeat(LADDER_ID_MAX + 1), 0)).toThrow(/at most/);
    expect(() => ladderRungClientRequestId("ok", 32)).toThrow(/out of range/);
    expect(ladderRungClientRequestId("x".repeat(LADDER_ID_MAX), 31).length).toBeLessThanOrEqual(128);
  });
});

describe("maker-ladder: nonce policy", () => {
  it("shared-reserved (default): reserved rungs share the group's bit; the open rung has its own id-derived bit", async () => {
    const d = (await ladder("ladder-policy-0001", { rungs: threeRungs })).data as LadderData;
    const groupNonce = ocoGroupNonce("ladder-policy-0001").toString();
    expect(d.rungs[0]!.nonce).toBe(groupNonce);
    expect(d.rungs[1]!.nonce).toBe(groupNonce);
    expect(d.rungs[0]!.grouped).toBe(true);
    expect(d.rungs[1]!.ocoGroup).toBe("ladder-policy-0001");
    expect(d.rungs[2]!.grouped).toBe(false);
    expect(d.rungs[2]!.ocoGroup).toBeNull();
    expect(d.rungs[2]!.nonce).not.toBe(groupNonce);
    // The open rung's bit is exactly what a stand-alone order under the same derived id gets.
    const alone = await single(ladderRungClientRequestId("ladder-policy-0001", 2), { takingAmount: "980000", expirySeconds: 3600, auction: { durationSeconds: 1800, initialRateBump: "500000" } });
    expect((alone.data as Rung).nonce).toBe(d.rungs[2]!.nonce);
  });

  it("shared: every rung shares the bit, open rungs included", async () => {
    const d = (await ladder("ladder-policy-0002", { noncePolicy: "shared", rungs: threeRungs })).data as LadderData;
    const groupNonce = ocoGroupNonce("ladder-policy-0002").toString();
    for (const r of d.rungs) {
      expect(r.nonce).toBe(groupNonce);
      expect(r.grouped).toBe(true);
    }
  });

  it("distinct: every rung has its own bit, reserved rungs included", async () => {
    const d = (await ladder("ladder-policy-0003", { noncePolicy: "distinct", rungs: threeRungs })).data as LadderData;
    expect(new Set(d.rungs.map((r) => r.nonce)).size).toBe(3);
    for (const r of d.rungs) {
      expect(r.grouped).toBe(false);
      expect(r.ocoGroup).toBeNull();
    }
  });

  it("an explicit ocoGroup names the shared bit instead of the ladder id, so two ladders can join one group", async () => {
    const d1 = (await ladder("ladder-policy-0004", { ocoGroup: "rfq_shared", rungs: threeRungs })).data as LadderData;
    const d2 = (await ladder("ladder-policy-0005", { ocoGroup: "rfq_shared", rungs: threeRungs })).data as LadderData;
    expect(d1.rungs[0]!.nonce).toBe(ocoGroupNonce("rfq_shared").toString());
    expect(d2.rungs[0]!.nonce).toBe(d1.rungs[0]!.nonce);
    expect(d1.ladder.ocoGroup).toBe("rfq_shared");
  });
});

describe("maker-ladder: capacity", () => {
  const sized = [
    { takingAmount: "1000000", makingAmount: "100", allowedSender: TAKER },
    { takingAmount: "950000", makingAmount: "100", allowedSender: TAKER },
    { takingAmount: "980000", makingAmount: "50" },
  ];
  it("shared-reserved: the group counts once at its largest rung, the open rung adds", async () => {
    const d = (await ladder("ladder-cap-0001", { rungs: sized })).data as LadderData;
    expect(d.capacity.makerAssetRequired).toBe("150");
    expect(d.capacity.rule).toContain("rungs 0,1 share one bit");
    expect(d.capacity.rule).toContain("rungs 2 each fill independently");
    expect(d.scales.makerAssetRequired).toContain("base units of makerAsset");
  });
  it("shared: the largest rung is the whole exposure", async () => {
    const d = (await ladder("ladder-cap-0002", { noncePolicy: "shared", rungs: sized })).data as LadderData;
    expect(d.capacity.makerAssetRequired).toBe("100");
    expect(d.capacity.rule).toContain("at most one fills");
  });
  it("distinct: the rungs add up", async () => {
    const d = (await ladder("ladder-cap-0003", { noncePolicy: "distinct", rungs: sized })).data as LadderData;
    expect(d.capacity.makerAssetRequired).toBe("250");
    expect(d.capacity.rule).toContain("all can fill");
  });
  it("a rung's makingAmount override is what its artifact signs and what capacity counts", async () => {
    const d = (await ladder("ladder-cap-0004", { noncePolicy: "distinct", rungs: [{ takingAmount: "1", makingAmount: "7" }, { takingAmount: "1" }] })).data as LadderData;
    expect(d.rungs[0]!.typedData.message.makingAmount).toBe("7");
    expect(d.rungs[1]!.typedData.message.makingAmount).toBe("1000000000000000000");
    expect(d.capacity.makerAssetRequired).toBe((7n + 1000000000000000000n).toString());
  });
});

describe("maker-ladder: warnings and failure", () => {
  it("ONE ladder-level oco_group_notice replaces the per-rung notices, and names the grouped and open rungs", async () => {
    const env = await ladder("ladder-warn-0001", { rungs: threeRungs });
    const notices = env.warnings.filter((w) => w.code === "oco_group_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("rungs 0,1 share invalidator nonce");
    expect(notices[0]!.message).toContain("rungs 2 are on their own bits and can fill in addition");
    expect(notices[0]!.message).toContain('topic:"orders"');
    // No per-rung "rung N: ..." copy of the notice survives the collapse.
    expect(env.warnings.some((w) => w.code === "oco_group_notice" && /^rungs? \d/.test(w.message) && w.message.includes("shares invalidator nonce"))).toBe(false);
  });

  it("distinct ladders carry no group notice at all", async () => {
    const env = await ladder("ladder-warn-0002", { noncePolicy: "distinct", rungs: threeRungs });
    expect(env.warnings.some((w) => w.code === "oco_group_notice")).toBe(false);
  });

  it("a rung the maker-order path refuses fails the WHOLE ladder with that rung's code, named", async () => {
    // An allowedSender whose low 80 bits are zero would silently read as open — maker-order
    // refuses it (invalid_order_terms); the ladder must not hand back the other two rungs.
    const env = await ladder("ladder-fail-0001", { rungs: [threeRungs[0]!, { takingAmount: "1", allowedSender: "0x0123456789abcdef012300000000000000000000", label: "bad-reach" }, threeRungs[2]!] });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.code).toBe("invalid_order_terms");
    expect(env.warnings[0]!.message).toMatch(/^rung 1 \(bad-reach\): /);
    expect(env.warnings[0]!.message).toContain("no ladder artifact was built");
    const d = env.data as { kind: string; failedRung: { index: number; clientRequestId: string; label?: string }; rungs?: unknown };
    expect(d.kind).toBe("maker-ladder");
    expect(d.failedRung).toEqual({ index: 1, clientRequestId: ladderRungClientRequestId("ladder-fail-0001", 1), label: "bad-reach" });
    expect(d.rungs).toBeUndefined();
  });

  it("identical rung warnings collapse into ONE line naming every rung; differing ones stay per rung", async () => {
    // Every decaying rung raises decaying_price_notice; with identical terms the message is
    // identical, so the ladder reports it once for both rungs.
    const decay = { auction: { durationSeconds: 1800, initialRateBump: "500000" } };
    const same = await ladder("ladder-warn-0003", { noncePolicy: "distinct", rungs: [{ takingAmount: "1000000", ...decay }, { takingAmount: "1000000", ...decay }] });
    expect(same.state).toBe("ok");
    const sameNotices = same.warnings.filter((w) => w.code === "decaying_price_notice");
    expect(sameNotices).toHaveLength(1);
    expect(sameNotices[0]!.message).toMatch(/^rungs 0,1: /);
    // Only one decaying rung → the line names that rung alone, in the singular.
    const one = await ladder("ladder-warn-0004", { noncePolicy: "distinct", rungs: [{ takingAmount: "1000000" }, { takingAmount: "900000", ...decay }] });
    const oneNotices = one.warnings.filter((w) => w.code === "decaying_price_notice").map((w) => w.message);
    expect(oneNotices).toHaveLength(1);
    expect(oneNotices[0]).toMatch(/^rung 1: /);
  });
});

describe("maker-ladder: a rung is a real maker-order artifact — sign it, finalize it verbatim", () => {
  // Anvil #1 throwaway key; the ladder is built FOR this maker so the signature recovers to it.
  const makerAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  // finalize probes the maker's code (a contract maker is verified through ERC-1271, the way the
  // fill does); the stub answers the chain's EOA truth — no code, no allowance, a clear bit —
  // instead of letting the suite reach a live endpoint.
  const eoaChain = stubRpc((c) => {
    if (c.functionName === "allowance" || c.functionName === "bitInvalidatorForOrder") return 0n;
    throw new Error(`no stub for ${c.functionName}`);
  });

  it("each rung, passed verbatim as `prepared` under its own derived clientRequestId, finalizes into a submit artifact carrying that rung's nonce", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: makerAccount.address, clientRequestId: "ladder-sign-0001", action: { type: "maker-ladder", ...base, rungs: threeRungs } }, { nowSeconds: NOW, resolveRpc: eoaChain });
    expect(env.state).toBe("ok");
    const d = env.data as LadderData & { rungs: Array<Rung & { lop: `0x${string}`; typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, string> } }> };
    const digests = new Set<string>();
    for (const rung of d.rungs) {
      const m = rung.typedData.message;
      const signature = await makerAccount.signTypedData({
        domain: rung.typedData.domain,
        types: rung.typedData.types,
        primaryType: rung.typedData.primaryType,
        message: { salt: BigInt(m.salt!), maker: m.maker, receiver: m.receiver, makerAsset: m.makerAsset, takerAsset: m.takerAsset, makingAmount: BigInt(m.makingAmount!), takingAmount: BigInt(m.takingAmount!), makerTraits: BigInt(m.makerTraits!) },
      } as unknown as Parameters<typeof makerAccount.signTypedData>[0]);
      const expiry = Number(NOW) + (rung.index === 2 ? 3600 : 600);
      const fin = await runTool("cork_prepare_orders", {
        chainId: 1, account: makerAccount.address, clientRequestId: rung.clientRequestId,
        action: { type: "finalize-maker-order", prepared: rung as never, signature, listing: { side: "SELL", expiry, nonce: rung.nonce, allowsPartialFills: true, premiumAnnualized: "0.05" } },
      }, { nowSeconds: NOW, resolveRpc: eoaChain });
      expect(fin.state, `rung ${rung.index}: ${fin.warnings[0]?.message}`).toBe("ok");
      const f = fin.data as { signedArtifactDigest: string; submitInput: { clientRequestId: string; action: { nonce: string; order: { makerTraits: string } } }; allowedSender: string | null };
      // The relay artifact carries the RUNG's id and nonce — cork_submit's listing cross-check
      // (listing_traits_mismatch) reads the nonce back out of the signed traits.
      expect(f.submitInput.clientRequestId).toBe(rung.clientRequestId);
      expect(f.submitInput.action.nonce).toBe(rung.nonce);
      expect(f.submitInput.action.order.makerTraits).toBe(m.makerTraits);
      expect(f.allowedSender).toBe(rung.allowedSender);
      digests.add(f.signedArtifactDigest);
    }
    expect(digests.size).toBe(3);
  });

  it("a rung finalized under the LADDER's id (not its own) is refused as a context mismatch — the rung id is load-bearing", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: makerAccount.address, clientRequestId: "ladder-sign-0002", action: { type: "maker-ladder", ...base, rungs: threeRungs } }, { nowSeconds: NOW, resolveRpc: eoaChain });
    const rung = (env.data as LadderData).rungs[0]! as Rung & { typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, string> } };
    const m = rung.typedData.message;
    const signature = await makerAccount.signTypedData({ domain: rung.typedData.domain, types: rung.typedData.types, primaryType: rung.typedData.primaryType, message: { salt: BigInt(m.salt!), maker: m.maker, receiver: m.receiver, makerAsset: m.makerAsset, takerAsset: m.takerAsset, makingAmount: BigInt(m.makingAmount!), takingAmount: BigInt(m.takingAmount!), makerTraits: BigInt(m.makerTraits!) } } as unknown as Parameters<typeof makerAccount.signTypedData>[0]);
    const fin = await runTool("cork_prepare_orders", { chainId: 1, account: makerAccount.address, clientRequestId: "ladder-sign-0002", action: { type: "finalize-maker-order", prepared: rung as never, signature, listing: { side: "SELL", expiry: Number(NOW) + 600, nonce: rung.nonce, allowsPartialFills: true, premiumAnnualized: "0.05" } } }, { nowSeconds: NOW, resolveRpc: eoaChain });
    expect(fin.state).toBe("conflict");
    expect(fin.warnings[0]!.code).toBe("prepared_context_mismatch");
  });
});
