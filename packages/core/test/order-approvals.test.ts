// Token-approval requirements across the 1inch order lifecycle: WHO grants WHAT to WHOM, with
// the unsigned approve payload per grant. Calldata assertions are hand-assembled words (never
// encodeFunctionData) so an argument-order mutant cannot hide; the satisfied comparators are
// pinned at their boundaries (mutation-probed: sdk-approval-* in scripts/mutation-probes.ts).
import { describe, expect, it } from "vitest";
import { toFunctionSelector, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  annotateApprovalStatus,
  type ApprovalRequirement,
  makerApprovalRequirements,
  PERMIT2_ADDRESS,
  PERMIT2_EXPIRATION_NEVER,
  takerApprovalRequirements,
} from "../src/order-approvals.ts";
import { hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import { runTool } from "../src/handlers.ts";
import { stubRpc } from "./helpers.ts";

const LOP = LOP_ADDRESSES[1]!;
const MAKER = "0x00000000000000000000000000000000000000ee" as const;
const TAKER = "0x00000000000000000000000000000000000000aa" as const;
const TOKEN = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const COLLATERAL = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;
const ADAPTER = "0x00000000000000000000000000000000000000ad" as const;
const CST = "0x00000000000000000000000000000000000000c5" as const;
const AMOUNT = 10n ** 18n;
const NOW = 1_790_000_000n;

const word = (v: string | bigint) => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/u, "")).toLowerCase().padStart(64, "0");
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
const PERMIT2_APPROVE_SELECTOR = toFunctionSelector("function approve(address token, address spender, uint160 amount, uint48 expiration)");

describe("makerApprovalRequirements — the underwriter's grants", () => {
  it("plain order: ONE exact allowance, maker asset → the LOP, calldata word-exact", () => {
    const entries = makerApprovalRequirements({ maker: MAKER, makerAsset: TOKEN, makingAmount: AMOUNT, lop: LOP, usePermit2: false });
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e).toMatchObject({ role: "maker", stage: "before-listing", holder: MAKER, token: TOKEN, spender: LOP, spenderRole: "1inch LOP", mechanism: "erc20-approve", amount: AMOUNT.toString(), kind: "exact", wallets: "eoa+contract" });
    expect(e.unsignedTx).toEqual({ to: TOKEN, calldata: `${ERC20_APPROVE_SELECTOR}${word(LOP)}${word(AMOUNT)}`, value: "0" });
  });

  it("usePermit2: BOTH layers — token → Permit2, then the Permit2 internal allowance → the LOP", () => {
    const entries = makerApprovalRequirements({ maker: MAKER, makerAsset: TOKEN, makingAmount: AMOUNT, lop: LOP, usePermit2: true, orderExpiry: 1_800_000_000n });
    expect(entries).toHaveLength(2);
    const [layer1, layer2] = entries as [ApprovalRequirement, ApprovalRequirement];
    expect(layer1).toMatchObject({ spender: PERMIT2_ADDRESS, spenderRole: "Permit2", mechanism: "erc20-approve" });
    expect(layer1.unsignedTx!.to).toBe(TOKEN);
    expect(layer1.unsignedTx!.calldata).toBe(`${ERC20_APPROVE_SELECTOR}${word(PERMIT2_ADDRESS)}${word(AMOUNT)}`);
    // Layer 2: the tx goes to the PERMIT2 contract; the authorized party is the LOP; the
    // expiration is the order's own expiry. Words pinned in ABI order: token, spender,
    // amount(uint160), expiration(uint48).
    expect(layer2).toMatchObject({ spender: LOP, spenderRole: "1inch LOP", mechanism: "permit2-approve" });
    expect(layer2.unsignedTx!.to).toBe(PERMIT2_ADDRESS);
    expect(layer2.unsignedTx!.calldata).toBe(`${PERMIT2_APPROVE_SELECTOR}${word(TOKEN)}${word(LOP)}${word(AMOUNT)}${word(1_800_000_000n)}`);
  });

  it("usePermit2 without an order expiry: expiration = the never-expires sentinel (2^48-1)", () => {
    expect(PERMIT2_EXPIRATION_NEVER).toBe((1n << 48n) - 1n);
    const entries = makerApprovalRequirements({ maker: MAKER, makerAsset: TOKEN, makingAmount: AMOUNT, lop: LOP, usePermit2: true });
    expect(entries[1]!.unsignedTx!.calldata.endsWith(word(PERMIT2_EXPIRATION_NEVER))).toBe(true);
  });

  it("usePermit2 with makingAmount over uint160: warns in the note and clamps the tx amount", () => {
    const over = 1n << 160n;
    const entries = makerApprovalRequirements({ maker: MAKER, makerAsset: TOKEN, makingAmount: over, lop: LOP, usePermit2: true });
    expect(entries[1]!.note).toContain("Permit2TransferAmountTooHigh");
    expect(entries[1]!.unsignedTx!.calldata).toContain(word((1n << 160n) - 1n));
  });

  it("JIT selling the predicted cST: an ERC-2612 permit (EOA-only), never an approve tx", () => {
    const entries = makerApprovalRequirements({
      maker: MAKER, makerAsset: CST, makingAmount: AMOUNT, lop: LOP, usePermit2: false,
      jit: { adapter: ADAPTER, collateralAsset: COLLATERAL, enableJitMint: true, predictedCorkSwapToken: CST },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ stage: "with-order-signature", mechanism: "erc2612-permit", wallets: "eoa-only", spender: LOP, unsignedTx: null });
    expect(entries[0]!.note).toContain("CONTRACT maker");
    // enableJitMint: the collateral pull into the JIT adapter needs its own allowance.
    expect(entries[1]).toMatchObject({ token: COLLATERAL, spender: ADAPTER, spenderRole: "Cork JIT adapter", amount: null, kind: "cap" });
  });

  it("JIT market-creation only (no mint): no collateral entry rides", () => {
    const entries = makerApprovalRequirements({
      maker: MAKER, makerAsset: CST, makingAmount: AMOUNT, lop: LOP, usePermit2: false,
      jit: { adapter: ADAPTER, collateralAsset: COLLATERAL, enableJitMint: false, predictedCorkSwapToken: CST },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.mechanism).toBe("erc2612-permit");
  });
});

describe("takerApprovalRequirements — the hedger's grants", () => {
  it("raw fill: ONE cap allowance, taker asset → the LOP", () => {
    const entries = takerApprovalRequirements({ taker: TAKER, takerAsset: TOKEN, requiredTakingAmount: AMOUNT, lop: LOP });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role: "taker", stage: "before-fill", holder: TAKER, spender: LOP, kind: "cap", amount: AMOUNT.toString() });
    expect(entries[0]!.unsignedTx!.calldata).toBe(`${ERC20_APPROVE_SELECTOR}${word(LOP)}${word(AMOUNT)}`);
  });

  it("forSelf: the allowance goes to the ADAPTER, never the LOP", () => {
    const entries = takerApprovalRequirements({ taker: TAKER, takerAsset: TOKEN, requiredTakingAmount: AMOUNT, lop: LOP, forSelfAdapter: ADAPTER });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ spender: ADAPTER, spenderRole: "ForSelf adapter" });
    expect(entries[0]!.unsignedTx!.calldata).toBe(`${ERC20_APPROVE_SELECTOR}${word(ADAPTER)}${word(AMOUNT)}`);
  });

  it("auction: the note names the cap as the curve CEILING", () => {
    const entries = takerApprovalRequirements({ taker: TAKER, takerAsset: TOKEN, requiredTakingAmount: AMOUNT, lop: LOP, auction: true });
    expect(entries[0]!.note).toContain("CEILING");
  });

  it("taker JIT delivering the predicted cST: permit entry + the collateral pull to the adapter", () => {
    const entries = takerApprovalRequirements({
      taker: TAKER, takerAsset: CST, requiredTakingAmount: AMOUNT, lop: LOP,
      jit: { adapter: ADAPTER, collateralAsset: COLLATERAL, predictedCorkSwapToken: CST },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ mechanism: "erc2612-permit", wallets: "eoa-only", unsignedTx: null });
    expect(entries[1]).toMatchObject({ token: COLLATERAL, spender: ADAPTER, spenderRole: "Cork JIT adapter" });
  });
});

describe("annotateApprovalStatus — boundary-exact against a stub client", () => {
  const client = (answers: { erc20?: bigint; permit2?: readonly [bigint, number, number]; fail?: boolean }) => ({
    readContract: async (c: { address: string; functionName: string }) => {
      if (answers.fail) throw new Error("read failed");
      if (c.address.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) return answers.permit2 ?? [0n, 0, 0];
      return answers.erc20 ?? 0n;
    },
  });
  const plain = () => makerApprovalRequirements({ maker: MAKER, makerAsset: TOKEN, makingAmount: AMOUNT, lop: LOP, usePermit2: false });
  const p2 = () => makerApprovalRequirements({ maker: MAKER, makerAsset: TOKEN, makingAmount: AMOUNT, lop: LOP, usePermit2: true });

  it("erc20: current == required is satisfied (>= at the boundary); one wei under is not", async () => {
    const [eq] = await annotateApprovalStatus(client({ erc20: AMOUNT }) as never, { entries: plain(), nowSeconds: NOW });
    expect(eq).toMatchObject({ satisfied: true, currentAllowance: AMOUNT.toString() });
    const [under] = await annotateApprovalStatus(client({ erc20: AMOUNT - 1n }) as never, { entries: plain(), nowSeconds: NOW });
    expect(under!.satisfied).toBe(false);
  });

  it("permit2 layer: spending is allowed AT the expiration second; one second past is expired; 0 is always expired", async () => {
    const at = await annotateApprovalStatus(client({ erc20: AMOUNT, permit2: [AMOUNT, Number(NOW), 0] }) as never, { entries: p2(), nowSeconds: NOW });
    expect(at[1]).toMatchObject({ satisfied: true, currentExpiration: Number(NOW) });
    const past = await annotateApprovalStatus(client({ erc20: AMOUNT, permit2: [AMOUNT, Number(NOW) - 1, 0] }) as never, { entries: p2(), nowSeconds: NOW });
    expect(past[1]!.satisfied).toBe(false);
    const zero = await annotateApprovalStatus(client({ erc20: AMOUNT, permit2: [AMOUNT, 0, 0] }) as never, { entries: p2(), nowSeconds: NOW });
    expect(zero[1]!.satisfied).toBe(false);
    const lowAmt = await annotateApprovalStatus(client({ erc20: AMOUNT, permit2: [AMOUNT - 1n, Number(NOW) + 100, 0] }) as never, { entries: p2(), nowSeconds: NOW });
    expect(lowAmt[1]!.satisfied).toBe(false);
  });

  it("a failed read degrades to silence — the entry rides unannotated", async () => {
    const [e] = await annotateApprovalStatus(client({ fail: true }) as never, { entries: plain(), nowSeconds: NOW });
    expect(e!.satisfied).toBeUndefined();
    expect(e!.currentAllowance).toBeUndefined();
  });

  it("erc2612-permit entries are never annotated (the token may not exist yet)", async () => {
    const entries = makerApprovalRequirements({ maker: MAKER, makerAsset: CST, makingAmount: AMOUNT, lop: LOP, usePermit2: false, jit: { adapter: ADAPTER, collateralAsset: COLLATERAL, enableJitMint: false, predictedCorkSwapToken: CST } });
    const [e] = await annotateApprovalStatus(client({ erc20: AMOUNT }) as never, { entries, nowSeconds: NOW });
    expect(e!.satisfied).toBeUndefined();
  });
});

// ── the handler wiring: every LOP-order prepare result carries data.approvals ────────────────

const MAKER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // throwaway
const makerAccount = privateKeyToAccount(MAKER_PK);

const allowanceStub = (allowance: bigint) =>
  stubRpc((c) => {
    switch (c.functionName) {
      case "allowance":
        return allowance;
      case "bitInvalidatorForOrder":
        return 0n; // live
      default:
        throw new Error(`no stub for ${c.functionName}`);
    }
  });

function makerOrderInput(over: Record<string, unknown> = {}) {
  return {
    chainId: 1,
    account: makerAccount.address,
    clientRequestId: "approvals-mk-0001",
    action: { type: "maker-order", poolId: `0x${"11".repeat(32)}`, side: "SELL", makerAsset: TOKEN, takerAsset: COLLATERAL, makingAmount: AMOUNT.toString(), takingAmount: "1000000", ...over },
    format: "concise",
  };
}

describe("handler wiring: data.approvals across the order lifecycle", () => {
  it("maker-order (offline): entries ride UNANNOTATED — requirement indication needs no RPC", async () => {
    const env = await runTool("cork_prepare_orders", makerOrderInput(), { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const approvals = (env.data as { approvals: ApprovalRequirement[] }).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ role: "maker", token: TOKEN, spender: LOP, mechanism: "erc20-approve" });
    expect(approvals[0]!.satisfied).toBeUndefined();
    expect(env.warnings.some((w) => w.code === "approval_missing")).toBe(false);
  });

  it("maker-order usePermit2: both Permit2 layers ride, expiration bound to the order expiry", async () => {
    const env = await runTool("cork_prepare_orders", makerOrderInput({ usePermit2: true, expirySeconds: 3600 }), { nowSeconds: NOW });
    const approvals = (env.data as { approvals: ApprovalRequirement[] }).approvals;
    expect(approvals.map((e) => e.mechanism)).toEqual(["erc20-approve", "permit2-approve"]);
    expect(approvals[1]!.unsignedTx!.calldata.endsWith(word(NOW + 3600n))).toBe(true);
  });

  it("maker-order with an explicit-RPC stub: a zero allowance is CONFIRMED missing → approval_missing", async () => {
    const env = await runTool("cork_prepare_orders", makerOrderInput(), { nowSeconds: NOW, resolveRpc: allowanceStub(0n) });
    const approvals = (env.data as { approvals: ApprovalRequirement[] }).approvals;
    expect(approvals[0]).toMatchObject({ satisfied: false, currentAllowance: "0" });
    const warn = env.warnings.find((w) => w.code === "approval_missing");
    expect(warn?.message).toContain(TOKEN);
    expect(warn?.message).toContain("data.approvals");
  });

  it("maker-order with the allowance in place: satisfied true, no warning", async () => {
    const env = await runTool("cork_prepare_orders", makerOrderInput(), { nowSeconds: NOW, resolveRpc: allowanceStub(AMOUNT) });
    expect((env.data as { approvals: ApprovalRequirement[] }).approvals[0]!.satisfied).toBe(true);
    expect(env.warnings.some((w) => w.code === "approval_missing")).toBe(false);
  });

  it("taker-fill (inline signedOrder): the taker's cap allowance to the LOP, annotated off the liveness client", async () => {
    const order: LopOrder = { salt: 42n, maker: makerAccount.address, receiver: zeroAddress, makerAsset: CST, takerAsset: COLLATERAL, makingAmount: AMOUNT, takingAmount: 5n * 10n ** 16n, makerTraits: 0n };
    const orderHash = hashLopOrder(1, LOP, order);
    const signature = await makerAccount.sign({ hash: orderHash });
    const env = await runTool(
      "cork_prepare_orders",
      {
        chainId: 1, account: TAKER, clientRequestId: "approvals-tk-0001", format: "concise",
        action: { type: "taker-fill", orderHash, signedOrder: { order: { salt: "42", maker: makerAccount.address, receiver: zeroAddress, makerAsset: CST, takerAsset: COLLATERAL, makingAmount: AMOUNT.toString(), takingAmount: (5n * 10n ** 16n).toString(), makerTraits: "0" }, signature } },
      },
      { nowSeconds: NOW, resolveRpc: allowanceStub(0n) },
    );
    expect(env.state).toBe("ok");
    const approvals = (env.data as { approvals: ApprovalRequirement[] }).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ role: "taker", token: COLLATERAL, spender: LOP, kind: "cap", satisfied: false });
    expect(approvals[0]!.holder.toLowerCase()).toBe(TAKER.toLowerCase());
    // The cap must come from the fill's TAKING amount, never the making amount.
    expect(approvals[0]!.amount).toBe((5n * 10n ** 16n).toString());
    expect(env.warnings.some((w) => w.code === "approval_missing")).toBe(true);
  });

  it("finalize-maker-order: approvals re-derived from the SIGNED makerTraits, outside the digest", async () => {
    const prep = await runTool("cork_prepare_orders", makerOrderInput({ usePermit2: true }), { nowSeconds: NOW });
    const d = prep.data as { typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, string> }; nonce: string; orderHash: `0x${string}`; extension: `0x${string}`; lop: `0x${string}`; clientRequestId: string; kind: string };
    const m = d.typedData.message;
    const signature = await makerAccount.signTypedData({
      domain: d.typedData.domain,
      types: d.typedData.types,
      primaryType: d.typedData.primaryType,
      message: { salt: BigInt(m.salt!), maker: m.maker, receiver: m.receiver, makerAsset: m.makerAsset, takerAsset: m.takerAsset, makingAmount: BigInt(m.makingAmount!), takingAmount: BigInt(m.takingAmount!), makerTraits: BigInt(m.makerTraits!) },
    } as unknown as Parameters<typeof makerAccount.signTypedData>[0]);
    const env = await runTool(
      "cork_prepare_orders",
      {
        chainId: 1, account: makerAccount.address, clientRequestId: "approvals-mk-0001", format: "concise",
        action: {
          type: "finalize-maker-order",
          prepared: { kind: "maker-order", lop: d.lop, typedData: { domain: d.typedData.domain, message: m }, orderHash: d.orderHash, clientRequestId: d.clientRequestId, extension: d.extension },
          signature,
          listing: { side: "SELL", expiry: 0, nonce: d.nonce, allowsPartialFills: true, premiumAnnualized: "0.05" },
        },
      },
      { nowSeconds: NOW, resolveRpc: allowanceStub(0n) },
    );
    expect(env.state).toBe("ok");
    const data = env.data as { approvals: ApprovalRequirement[]; signedArtifactDigest: string };
    // The signed traits carry the Permit2 bit → both layers ride, re-derived from bytes [K3].
    expect(data.approvals.map((e) => e.mechanism)).toEqual(["erc20-approve", "permit2-approve"]);
    expect(env.warnings.some((w) => w.code === "approval_missing")).toBe(true);
    // Advisory only: the digest must pin signed content alone. Recompute the same finalize
    // with a DIFFERENT allowance answer — the digest may not move.
    const env2 = await runTool(
      "cork_prepare_orders",
      {
        chainId: 1, account: makerAccount.address, clientRequestId: "approvals-mk-0001", format: "concise",
        action: {
          type: "finalize-maker-order",
          prepared: { kind: "maker-order", lop: d.lop, typedData: { domain: d.typedData.domain, message: m }, orderHash: d.orderHash, clientRequestId: d.clientRequestId, extension: d.extension },
          signature,
          listing: { side: "SELL", expiry: 0, nonce: d.nonce, allowsPartialFills: true, premiumAnnualized: "0.05" },
        },
      },
      { nowSeconds: NOW, resolveRpc: allowanceStub(AMOUNT) },
    );
    expect((env2.data as { signedArtifactDigest: string }).signedArtifactDigest).toBe(data.signedArtifactDigest);
    expect((env2.data as { approvals: ApprovalRequirement[] }).approvals[0]!.satisfied).toBe(true);
  });
});
