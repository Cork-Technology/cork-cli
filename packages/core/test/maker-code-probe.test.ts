// The maker-code probe behind finalize-maker-order and the inline taker-fill (part 2).
// viem's getCode returns `undefined` for an account WITHOUT code — a positive answer, not a
// failed read. The ladder once used `code === undefined` as "unknown", so every EOA maker drew
// a `chain_read_failed` ("no RPC resolved…") even with an RPC configured (2026-08-20). These
// tests drive all three outcomes through the real handlers with a real ECDSA signature.
import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashLopOrder, LOP_ADDRESSES, runTool, type HandlerContext, type LopOrder } from "@cork/core";
import { stubResolved } from "./helpers.ts";

const LOP = LOP_ADDRESSES[1]!;
const maker = privateKeyToAccount(`0x${"03".repeat(32)}`); // throwaway
const NOW = 1_790_000_000n;
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;

const order: LopOrder = { salt: 5n, maker: maker.address, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: 10n ** 18n, takingAmount: 1_000_000n, makerTraits: 0n };
const orderHash = hashLopOrder(1, LOP, order);
const wire = { salt: "5", maker: maker.address, receiver: zeroAddress, makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "0" };
const prepared = { kind: "maker-order", lop: LOP, typedData: { domain: { chainId: 1, verifyingContract: LOP }, message: wire }, orderHash, extension: "0x", clientRequestId: "probe-0001" };
const listing = { side: "SELL", premiumAnnualized: "0.041", expiry: 0, nonce: "0", allowsPartialFills: true };

/** A chain whose only behaviour is how eth_getCode answers for the maker. */
function chainWithGetCode(getCode: () => Promise<string | undefined>): NonNullable<HandlerContext["resolveRpc"]> {
  return async () =>
    stubResolved({
      getCode,
      readContract: async (c: { functionName: string }) => {
        if (c.functionName === "bitInvalidatorForOrder") return 0n; // taker-fill liveness: live
        throw new Error(`no stub for ${c.functionName}`);
      },
    } as Record<string, (...args: never[]) => unknown>);
}

const finalize = (ctx: HandlerContext, signature: `0x${string}`) =>
  runTool("cork_prepare_orders", { chainId: 1, account: maker.address, clientRequestId: "probe-0001", action: { type: "finalize-maker-order", prepared, signature, listing }, format: "concise" }, { nowSeconds: NOW, ...ctx });

const fill = (ctx: HandlerContext, signature: `0x${string}`) =>
  runTool(
    "cork_prepare_orders",
    { chainId: 1, account: "0x00000000000000000000000000000000000000aa", clientRequestId: "probe-fill-0001", action: { type: "taker-fill", orderHash, signedOrder: { order: wire, signature, extension: "0x" } }, format: "concise" },
    { nowSeconds: NOW, venueFetch: async () => { throw new Error("venue must not be contacted"); }, ...ctx },
  );

describe("maker-code probe: no code is an answer, not a failure", () => {
  it("getCode → undefined (an EOA): finalize is clean — EOA, no chain_read_failed", async () => {
    const signature = await maker.sign({ hash: orderHash });
    const env = await finalize({ resolveRpc: chainWithGetCode(async () => undefined) }, signature);
    expect(env.state).toBe("ok");
    expect((env.data as { makerAccountType: string }).makerAccountType).toBe("EOA");
    expect(env.warnings.map((w) => w.code)).not.toContain("chain_read_failed");
    expect(env.warnings[0]?.code).toBe("caller_signed_artifact");
  });

  it('getCode → "0x" (the other spelling of no code): same clean EOA verdict', async () => {
    const signature = await maker.sign({ hash: orderHash });
    const env = await finalize({ resolveRpc: chainWithGetCode(async () => "0x") }, signature);
    expect(env.state).toBe("ok");
    expect(env.warnings.map((w) => w.code)).not.toContain("chain_read_failed");
  });

  it("getCode throws: the read FAILED — EOA by ecrecover, disclosed as a failed read (not 'no RPC')", async () => {
    const signature = await maker.sign({ hash: orderHash });
    const env = await finalize({ resolveRpc: chainWithGetCode(async () => { throw new Error("boom"); }) }, signature);
    expect(env.state).toBe("ok");
    expect((env.data as { makerAccountType: string }).makerAccountType).toBe("EOA");
    const w = env.warnings.find((x) => x.code === "chain_read_failed");
    expect(w?.message).toMatch(/could not be read/);
    expect(w?.message).not.toMatch(/no RPC resolved/);
  });

  it("no RPC at all: disclosed as exactly that", async () => {
    const signature = await maker.sign({ hash: orderHash });
    const env = await finalize({ resolveRpc: async () => null }, signature);
    expect(env.state).toBe("ok");
    const w = env.warnings.find((x) => x.code === "chain_read_failed");
    expect(w?.message).toMatch(/no RPC resolved/);
  });

  it("the inline taker-fill path shares the probe: an EOA maker with an RPC builds bytes with no chain_read_failed", async () => {
    const signature = await maker.sign({ hash: orderHash });
    const env = await fill({ resolveRpc: chainWithGetCode(async () => undefined) }, signature);
    expect(env.state).toBe("ok");
    expect(env.warnings.map((w) => w.code)).not.toContain("chain_read_failed");
    const failed = await fill({ resolveRpc: chainWithGetCode(async () => { throw new Error("boom"); }) }, signature);
    expect(failed.state).toBe("ok");
    expect(failed.warnings.find((x) => x.code === "chain_read_failed")?.message).toMatch(/could not be read/);
  });
});
