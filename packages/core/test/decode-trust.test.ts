// cork_decode target verification (audit ARTIFACT-DECODE-002, 2026-08-24). A selector proves a
// shape; the `to` proves the contract. Three verdicts, three consequences:
//   trusted    — the leg targets the configured contract for its role: silent.
//   mismatch   — a configured contract exists and the leg targets something else: the label is
//                kept (the bytes claim it) but the result is a CONFLICT (`target_mismatch`).
//   unverified — nothing to compare against (a token approve, an integrator's ForSelf adapter,
//                raw calldata with no `to`): the result stays OK with one info warning
//                (`target_unverified`) — an honest "could not check", not a contradiction.
// Real bytes throughout: signed transactions, real multicall encodings, real JIT extensions.
import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BUNDLED_DEFAULTS, buildJitExtension, buildTakerFill, corkActionCall, encodeJitExtraData, encodeMulticall, generalAdapterAbi, LOP_ADDRESSES, runTool, type HandlerContext } from "@cork/core";

const ctx: HandlerContext = { nowSeconds: 1n };
const ZERO_CALLBACK = `0x${"0".repeat(64)}` as const;
const ADAPTER_1 = BUNDLED_DEFAULTS.deployments["1"]!.corkAdapter! as `0x${string}`;
const BUNDLER3_1 = BUNDLED_DEFAULTS.deployments["1"]!.bundler3! as `0x${string}`;
const JIT_ADAPTER_42161 = BUNDLED_DEFAULTS.marketRegistry!["42161"]!.adapter as `0x${string}`;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const FAKE = "0x00000000000000000000000000000000000000ee" as const;
const POOL = `0x${"11".repeat(32)}` as const;
const USER = "0x00000000000000000000000000000000000000aa" as const;
// The public Anvil #0 key — a well-known test vector, never a secret.
const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const call = (to: `0x${string}`, data: Hex, callbackHash: `0x${string}` = ZERO_CALLBACK) => ({ to, data, value: 0n, skipRevert: false, callbackHash });
const depositLeg = (to: `0x${string}`) => corkActionCall(to, "safeDeposit", { poolId: POOL, collateralAssetsIn: 1n, receiver: USER, minCptAndCstSharesOut: 1n, deadline: 2n });
const pullLeg = (to: `0x${string}`) => call(to, encodeFunctionData({ abi: generalAdapterAbi, functionName: "erc20TransferFrom", args: [USDC, to, 1n] }));
const approveData = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [ADAPTER_1, 1_000_000n] });

type Leg = { kind: string; to: string; verification: string; expectedTarget?: string; callbackHash?: string; role?: string; legs?: Leg[] };
const codes = (env: { warnings: Array<{ code: string }> }) => env.warnings.map((w) => w.code);

describe("kind:tx — the documented validate-before-broadcast step", () => {
  it("a signed ERC-20 approve to the Cork adapter (authority-onboard) is OK and labeled unverified — never a conflict", async () => {
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 1, nonce: 0, to: USDC, data: approveData, gas: 60_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("ok");
    const d = env.data as { legs: Leg[]; summary: string[]; to: string };
    expect(d.legs[0]).toMatchObject({ kind: "leg", role: "erc20", verification: "unverified" });
    expect(d.summary[0]).toMatch(/^1\. UNVERIFIED target: approve the adapter/);
    // `unknown_target` (the tx's own `to` is a token, not a Cork contract) was already the
    // contract; `target_unverified` says the same about the leg, once, as information.
    expect(codes(env).sort()).toEqual(["target_unverified", "unknown_target"]);
    expect(env.warnings.find((w) => w.code === "target_unverified")!.message).toContain("ERC-20 'approve'");
  });

  it("a signed Bundler3 multicall whose Cork leg targets a look-alike adapter is a conflict; the same leg at the real adapter is trusted and silent", async () => {
    const at = async (adapter: `0x${string}`) => {
      const multicall = encodeMulticall([pullLeg(adapter), depositLeg(adapter)]);
      const raw = await signer.signTransaction({ type: "eip1559", chainId: 1, nonce: 1, to: BUNDLER3_1, data: multicall, gas: 600_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
      return runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    };
    const bad = await at(FAKE);
    expect(bad.state).toBe("conflict");
    const badLegs = (bad.data as { legs: Leg[]; summary: string[] }).legs;
    expect(badLegs.map((l) => [l.kind, l.verification, l.expectedTarget?.toLowerCase()])).toEqual([
      ["leg", "mismatch", ADAPTER_1.toLowerCase()],
      ["cork", "mismatch", ADAPTER_1.toLowerCase()],
    ]);
    const mismatches = bad.warnings.filter((w) => w.code === "target_mismatch");
    expect(mismatches).toHaveLength(2);
    expect(mismatches[1]!.message).toContain("Cork 'safeDeposit'");
    expect(mismatches[1]!.message.toLowerCase()).toContain(FAKE);
    expect((bad.data as { summary: string[] }).summary[1]).toMatch(/^2\. TARGET MISMATCH/);

    const good = await at(ADAPTER_1);
    expect(good.state).toBe("ok");
    expect((good.data as { legs: Leg[] }).legs.map((l) => l.verification)).toEqual(["trusted", "trusted"]);
    expect(codes(good)).toEqual([]);
  });

  it("an ERC-20 leg INSIDE a bundle is unverified (the decoder has no token authority), which does not make the bundle a conflict", async () => {
    const multicall = encodeMulticall([call(USDC, approveData), depositLeg(ADAPTER_1)]);
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 1, nonce: 2, to: BUNDLER3_1, data: multicall, gas: 600_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("ok");
    expect((env.data as { legs: Leg[] }).legs.map((l) => l.verification)).toEqual(["unverified", "trusted"]);
    expect(codes(env)).toEqual(["target_unverified"]);
  });

  it("a non-zero Bundler3 callbackHash is preserved on the leg and called out in the summary", async () => {
    const hash = keccak256("0xabcd");
    const multicall = encodeMulticall([call(ADAPTER_1, depositLeg(ADAPTER_1).data, hash)]);
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 1, nonce: 3, to: BUNDLER3_1, data: multicall, gas: 600_000n, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("ok");
    const d = env.data as { legs: Leg[]; summary: string[] };
    expect(d.legs[0]!.callbackHash).toBe(hash);
    expect(d.summary[0]).toContain("CALLBACK ENABLED");
    expect(d.summary[0]).toContain(hash);
  });
});

describe("kind:calldata — raw bytes with no target of their own", () => {
  it("a single call cannot be verified: OK, labeled, and the warning says to decode the signed tx to check the target", async () => {
    const env = await runTool("cork_decode", { kind: "calldata", chainId: 1, data: approveData }, ctx);
    expect(env.state).toBe("ok");
    expect((env.data as { legs: Leg[] }).legs[0]!.verification).toBe("unverified");
    expect(codes(env)).toEqual(["target_unverified"]);
    expect(env.warnings[0]!.message).toContain('kind "tx"');
  });

  it("a multicall's INNER legs do name their targets, so they verify like a signed tx's", async () => {
    const good = await runTool("cork_decode", { kind: "calldata", chainId: 1, data: encodeMulticall([pullLeg(ADAPTER_1), depositLeg(ADAPTER_1)]) }, ctx);
    expect(good.state).toBe("ok");
    expect(codes(good)).toEqual([]);
    const bad = await runTool("cork_decode", { kind: "calldata", chainId: 1, data: encodeMulticall([depositLeg(FAKE)]) }, ctx);
    expect(bad.state).toBe("conflict");
    expect(codes(bad)).toEqual(["target_mismatch"]);
  });
});

describe("kind:order — the JIT hook's adapter is verified against the configured one", () => {
  const extensionAt = (adapter: `0x${string}`) =>
    buildJitExtension(
      adapter,
      encodeJitExtraData({
        collateralAsset: USDC,
        referenceAsset: USER,
        expiryTimestamp: 1_790_000_000n,
        recipe: FAKE,
        rateOverride: 0n,
        constraint: { rateMin: 1n, rateMax: 2n * 10n ** 18n, rateChangePerDayMax: 10n ** 18n, rateChangeCapacityMax: 3n * 10n ** 18n },
        additionalData: "0x",
        swapFeePercentage: 0n,
        unwindSwapFeePercentage: 0n,
        enableJitMint: true,
      }),
    );
  const orderWith = (extension: `0x${string}`) => {
    // OrderLib: salt.low160 must equal keccak256(extension).low160 for the extension to be valid.
    const salt = (BigInt(keccak256(extension)) & ((1n << 160n) - 1n)) | (7n << 160n);
    return { salt: salt.toString(), maker: USER, receiver: USER, makerAsset: USDC, takerAsset: USER, makingAmount: "1", takingAmount: "1", makerTraits: "0", extension };
  };

  it("a JIT-shaped preInteraction at a maker-chosen adapter is a conflict: the label says what the bytes claim, the verdict says it is not Cork's", async () => {
    const env = await runTool("cork_decode", { kind: "order", chainId: 42161, data: orderWith(extensionAt(FAKE)) }, ctx);
    expect(env.state).toBe("conflict");
    const jit = (env.data as { jit: { verification: string; expectedAdapter: string; adapter: string } }).jit;
    expect(jit.verification).toBe("mismatch");
    expect(jit.adapter.toLowerCase()).toBe(FAKE);
    expect(jit.expectedAdapter.toLowerCase()).toBe(JIT_ADAPTER_42161.toLowerCase());
    expect(codes(env)).toEqual(["target_mismatch"]);
    expect(env.warnings[0]!.message).toContain("Do not fill");
  });

  it("the configured adapter is trusted and silent; a chain with no JIT generation configured is unverified, not a conflict", async () => {
    const good = await runTool("cork_decode", { kind: "order", chainId: 42161, data: orderWith(extensionAt(JIT_ADAPTER_42161)) }, ctx);
    expect(good.state).toBe("ok");
    expect((good.data as { jit: { verification: string } }).jit.verification).toBe("trusted");
    expect(codes(good)).toEqual([]);
    // Mainnet has no MarketRegistry stack, so there is nothing to compare the adapter against.
    const elsewhere = await runTool("cork_decode", { kind: "order", chainId: 1, data: orderWith(extensionAt(FAKE)) }, ctx);
    expect(elsewhere.state).toBe("ok");
    expect((elsewhere.data as { jit: { verification: string } }).jit.verification).toBe("unverified");
    expect(codes(elsewhere)).toEqual(["target_unverified"]);
  });

  it("a signed fill of that order reads exactly like the order: the hook mismatch surfaces on the fill leg too", async () => {
    const lop = LOP_ADDRESSES[42161]!;
    const order = orderWith(extensionAt(FAKE));
    // The tool's own fill encoder (the bytes cork_prepare_orders taker-fill emits), with a
    // placeholder maker signature: the decode reads the order and its extension, not the sig.
    const fill = buildTakerFill({
      order: { salt: BigInt(order.salt), maker: order.maker, receiver: order.receiver, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: 1n, takingAmount: 1n, makerTraits: 0n },
      signature: `0x${"11".repeat(32)}${"22".repeat(32)}1b`,
      taker: USER,
      extension: order.extension,
    });
    const data = fill.calldata;
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 42161, nonce: 4, to: lop, data, gas: 600_000n, maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 1_000_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("conflict");
    const leg = (env.data as { legs: Array<{ kind: string; verification: string; label: { jit: { verification: string } } }> }).legs[0]!;
    expect(leg.kind).toBe("lop");
    expect(leg.verification).toBe("trusted"); // the LOP itself is the right contract…
    expect(leg.label.jit.verification).toBe("mismatch"); // …the hook it would run is not
    expect(codes(env)).toEqual(["target_mismatch"]);
  });
});
