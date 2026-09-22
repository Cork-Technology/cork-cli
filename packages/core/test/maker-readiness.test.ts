// Maker-side readiness — the 2026-09-11 incident class decoded and classified. The classifier
// is graded one rule at a time (a comparator or branch mutation fails the rule it breaks); the
// fact gatherer is graded on WHICH legs it issues (conditioned only on chain-free facts — the
// one-batch discipline), on containing a sync-throwing client, and on never turning a transport
// failure into a verdict. The tail runs the whole surface end-to-end through the venue-free
// taker-fill path: warning mapping (structural → maker_not_ready, fund gap → would_revert) and
// data.makerReadiness.
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { buildJitExtension, encodeExtensionFields, encodeJitExtraData } from "@cork/core";
import { hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import { runTool } from "../src/handlers.ts";
import {
  assessMakerReadiness,
  decodeMakerExtensionContext,
  gatherMakerReadinessFacts,
  isEip7702Designator,
  type MakerJitContext,
  type MakerReadinessFacts,
  type MakerReadinessInput,
  makerReadinessTargetOf,
  type MakerReadinessTarget,
  type ReadinessClient,
} from "../src/handlers/maker-readiness.ts";
import { PERMIT2_ADDRESS } from "../src/order-approvals.ts";
import { stubRpc, TOKEN_CODE } from "./helpers.ts";

const NOW = 1_790_000_000n;
const LOP = LOP_ADDRESSES[1]!;
const ASSET = "0x00000000000000000000000000000000000000c5" as const;
const MAKER = "0x00000000000000000000000000000000000000fa" as const;
const ADAPTER = "0x8902a88912a334263fe3d731d03c267715b9374f" as const;
const COLLATERAL = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const OTHER_TOKEN = "0x00000000000000000000000000000000000000d6" as const;

const jitCtx = (over: Partial<MakerJitContext> = {}): MakerJitContext => ({
  adapter: ADAPTER,
  collateralAsset: COLLATERAL,
  enableJitMint: false,
  predictedCorkSwapToken: ASSET,
  permitTokens: [ASSET],
  ...over,
});

const baseFacts = (over: Partial<MakerReadinessFacts> = {}): MakerReadinessFacts => ({
  makerAssetCode: "has-code",
  makerCanSignEcdsa: true,
  allowanceToLop: 10n ** 24n,
  balance: 10n ** 24n,
  ...over,
});

const assess = (factsOver: Partial<MakerReadinessFacts> = {}, over: Partial<MakerReadinessInput> = {}) =>
  assessMakerReadiness({
    makerAsset: ASSET,
    makingAmount: 10n ** 18n,
    allowPartialFills: false,
    usePermit2: false,
    jit: null,
    extensionPermitToken: null,
    nowSeconds: NOW,
    facts: baseFacts(factsOver),
    ...over,
  });

const codes = (r: ReturnType<typeof assess>) => r.reasons.map((x) => x.code);

describe("assessMakerReadiness — the transport rule (indeterminate is never a verdict)", () => {
  it("a healthy has-code maker is ready with no reasons", () => {
    expect(assess()).toEqual({ status: "ready", reasons: [] });
  });

  it("read-failed and no-rpc are UNKNOWN, never a verdict — while genuine no-code IS the silent-noop verdict (the divergence a conflating mutant hides)", () => {
    // The facts otherwise scream "ready" (ample allowance + balance): only the code read failed.
    expect(assess({ makerAssetCode: "read-failed" })).toEqual({ status: "unknown", reasons: [] });
    expect(assess({ makerAssetCode: "no-rpc" })).toEqual({ status: "unknown", reasons: [] });
    const noop = assess({ makerAssetCode: "no-code" });
    expect(noop.status).toBe("not-ready");
    expect(codes(noop)).toEqual(["silent-noop"]);
  });

  it("not-ready beats indeterminate: a proven fatal reason decides even when another leg is unknown", () => {
    const r = assess({ balance: "error", allowanceToLop: 0n });
    expect(r.status).toBe("not-ready");
    expect(codes(r)).toEqual(["allowance-missing"]);
  });
});

describe("assessMakerReadiness — the code-less makerAsset ladder", () => {
  it("no code and NO JIT hook: silent-noop, structural (the class simulation shows green)", () => {
    const r = assess({ makerAssetCode: "no-code" });
    expect(r.reasons[0]).toMatchObject({ code: "silent-noop", structural: true });
    expect(r.reasons[0]!.message).toContain("silently delivers nothing");
    expect(r.reasons[0]!.message).toContain("Simulation shows this class green");
  });

  it("a JIT hook creating a DIFFERENT token does not cover the makerAsset: still silent-noop", () => {
    const r = assess({ makerAssetCode: "no-code" }, { jit: jitCtx({ predictedCorkSwapToken: OTHER_TOKEN, permitTokens: [OTHER_TOKEN] }) });
    expect(codes(r)).toEqual(["silent-noop"]);
  });

  it("JIT covers but NO embedded permit covers the makerAsset: unborn-cst-no-permit, structural", () => {
    // No permit to infer the created token from — 'covers' errs toward the JIT story, and the
    // no-permit rule fires assumption-free.
    const r = assess({ makerAssetCode: "no-code" }, { jit: jitCtx({ predictedCorkSwapToken: null, permitTokens: [] }) });
    expect(r.reasons[0]).toMatchObject({ code: "unborn-cst-no-permit", structural: true });
    expect(r.reasons[0]!.message).toContain("TransferFromMakerToTakerFailed");
    expect(r.reasons[0]!.message).toContain("create-pool");
  });

  it("the incident class: permit present but the maker is a CONTRACT — ERC-2612 is ECDSA-only", () => {
    const r = assess({ makerAssetCode: "no-code", makerCanSignEcdsa: false }, { jit: jitCtx() });
    expect(r.reasons[0]).toMatchObject({ code: "contract-maker-unborn-cst", structural: true });
    expect(r.reasons[0]!.message).toContain("CONTRACT account");
  });

  it("permit present, ECDSA capability unknown: no verdict — unknown", () => {
    expect(assess({ makerAssetCode: "no-code", makerCanSignEcdsa: null }, { jit: jitCtx() })).toEqual({ status: "unknown", reasons: [] });
  });

  it("created-but-not-minted: enableJitMint off births the cST with a provably zero maker balance — structural balance-empty", () => {
    const r = assess({ makerAssetCode: "no-code" }, { jit: jitCtx({ enableJitMint: false }) });
    expect(r.reasons[0]).toMatchObject({ code: "balance-empty", structural: true });
    expect(r.reasons[0]!.message).toContain("WITHOUT minting");
  });

  it("the healthy JIT order: no code + permit + ECDSA maker + mint on + mint funded ⇒ READY", () => {
    const r = assess(
      { makerAssetCode: "no-code", mintCollateralAllowance: 10n ** 24n, mintCollateralBalance: 10n ** 24n },
      { jit: jitCtx({ enableJitMint: true }) },
    );
    expect(r).toEqual({ status: "ready", reasons: [] });
  });
});

describe("assessMakerReadiness — has-code: allowance, balance, and the permit escape hatches", () => {
  it("zero allowance, no hatch: allowance-missing (recoverable, not structural)", () => {
    const r = assess({ allowanceToLop: 0n });
    expect(r.reasons[0]).toMatchObject({ code: "allowance-missing", structural: false });
  });

  it("the LOP-level extension makerPermit is the hatch for a zero allowance (case-insensitive token match)", () => {
    expect(assess({ allowanceToLop: 0n }, { extensionPermitToken: ASSET.toUpperCase() as `0x${string}` })).toEqual({ status: "ready", reasons: [] });
  });

  it("a JIT-embedded permit covering the makerAsset is the other hatch", () => {
    // has-code + JIT (the pool exists, the cST is live): the permit still grants in-fill.
    const r = assess(
      { allowanceToLop: 0n, mintCollateralAllowance: 10n ** 24n, mintCollateralBalance: 10n ** 24n },
      { jit: jitCtx({ enableJitMint: true }) },
    );
    expect(r).toEqual({ status: "ready", reasons: [] });
  });

  it("both hatches are ERC-2612: a CONTRACT maker's permit does not count, and the message says so", () => {
    const r = assess({ allowanceToLop: 0n, makerCanSignEcdsa: false }, { extensionPermitToken: ASSET });
    expect(codes(r)).toEqual(["allowance-missing"]);
    expect(r.reasons[0]!.message).toContain("ERC-2612 is ECDSA-only");
  });

  it("hatch present but ECDSA capability unknown: unknown, not a verdict either way", () => {
    expect(assess({ allowanceToLop: 0n, makerCanSignEcdsa: null }, { extensionPermitToken: ASSET }).status).toBe("unknown");
  });

  it("allowance boundary is strict `<`: exactly the making amount is enough; one wei less is not — unless partial fills are allowed", () => {
    const making = 10n ** 18n;
    expect(assess({ allowanceToLop: making }).status).toBe("ready");
    expect(codes(assess({ allowanceToLop: making - 1n }))).toEqual(["allowance-insufficient"]);
    expect(assess({ allowanceToLop: making - 1n }, { allowPartialFills: true }).status).toBe("ready");
  });

  it("balance: zero is balance-empty (a partial fill would move nothing); short of the all-or-nothing amount is balance-insufficient", () => {
    expect(codes(assess({ balance: 0n }))).toEqual(["balance-empty"]);
    expect(assess({ balance: 0n }).reasons[0]!.structural).toBe(false);
    expect(codes(assess({ balance: 10n ** 18n - 1n }))).toEqual(["balance-insufficient"]);
    expect(assess({ balance: 10n ** 18n - 1n }, { allowPartialFills: true }).status).toBe("ready");
  });

  it("enableJitMint skips the makerAsset balance leg entirely — the fill mints it", () => {
    const r = assess(
      { balance: undefined as never, mintCollateralAllowance: 10n ** 24n, mintCollateralBalance: 10n ** 24n },
      { jit: jitCtx({ enableJitMint: true }) },
    );
    // balance absent would otherwise be indeterminate; with the mint it is simply not needed.
    expect(r).toEqual({ status: "ready", reasons: [] });
  });

  it("an absent or errored allowance leg is indeterminate", () => {
    expect(assess({ allowanceToLop: "error" }).status).toBe("unknown");
    expect(assess({ allowanceToLop: undefined as never }).status).toBe("unknown");
  });
});

describe("assessMakerReadiness — Permit2 sourcing (two layers, expiry strict `>`)", () => {
  const p2 = (over: Partial<MakerReadinessFacts> = {}) =>
    assess({ allowanceToLop: undefined as never, permit2Erc20Allowance: 10n ** 24n, permit2Internal: { amount: 10n ** 24n, expiration: Number(NOW) + 3600 }, ...over }, { usePermit2: true });

  it("both layers in place: ready", () => {
    expect(p2()).toEqual({ status: "ready", reasons: [] });
  });

  it("layer 1 absent (no ERC-20 grant to Permit2): permit2-missing", () => {
    expect(codes(p2({ permit2Erc20Allowance: 0n }))).toEqual(["permit2-missing"]);
  });

  it("layer 2 zero: permit2-missing; expired: permit2-expired — expiring exactly now is still live", () => {
    expect(codes(p2({ permit2Internal: { amount: 0n, expiration: Number(NOW) + 3600 } }))).toEqual(["permit2-missing"]);
    expect(codes(p2({ permit2Internal: { amount: 10n ** 24n, expiration: Number(NOW) - 1 } }))).toEqual(["permit2-expired"]);
    expect(p2({ permit2Internal: { amount: 10n ** 24n, expiration: Number(NOW) } }).status).toBe("ready");
  });

  it("layer 2 short of the all-or-nothing amount: allowance-insufficient; partial fills tolerate it", () => {
    expect(codes(p2({ permit2Internal: { amount: 10n ** 18n - 1n, expiration: Number(NOW) + 3600 } }))).toEqual(["allowance-insufficient"]);
    expect(assess({ allowanceToLop: undefined as never, permit2Erc20Allowance: 10n ** 24n, permit2Internal: { amount: 10n ** 18n - 1n, expiration: Number(NOW) + 3600 } }, { usePermit2: true, allowPartialFills: true }).status).toBe("ready");
  });

  it("either layer unreadable: unknown", () => {
    expect(p2({ permit2Erc20Allowance: "error" }).status).toBe("unknown");
    expect(p2({ permit2Internal: "error" }).status).toBe("unknown");
  });
});

describe("assessMakerReadiness — the mint's collateral funding (only ZERO is provable)", () => {
  const mint = (allowance: bigint | "error", balance: bigint | "error") =>
    assess({ mintCollateralAllowance: allowance, mintCollateralBalance: balance }, { jit: jitCtx({ enableJitMint: true }) });

  it("zero allowance / zero balance / both — one reason naming exactly what is zero", () => {
    expect(mint(0n, 10n ** 24n).reasons[0]!.message).toContain("allowance to the JIT adapter is");
    expect(mint(10n ** 24n, 0n).reasons[0]!.message).toContain("balance is");
    expect(mint(0n, 0n).reasons[0]!.message).toContain("allowance to the JIT adapter AND balance are");
    expect(codes(mint(0n, 0n))).toEqual(["mint-funding-missing"]);
  });

  it("a small-but-nonzero funding is NOT a verdict (the mint's cost depends on the fill-time rate)", () => {
    expect(mint(1n, 1n).status).toBe("ready");
  });

  it("an unreadable funding leg is indeterminate", () => {
    expect(mint("error", 10n ** 24n).status).toBe("unknown");
  });
});

describe("isEip7702Designator — a delegated EOA keeps its key", () => {
  it("exactly 0xef0100 ++ 20-byte address, case-insensitive; everything else is not", () => {
    expect(isEip7702Designator(`0xef0100${"11".repeat(20)}`)).toBe(true);
    expect(isEip7702Designator(`0xEF0100${"11".repeat(20)}`)).toBe(true);
    expect(isEip7702Designator(`0xef0100${"11".repeat(19)}`)).toBe(false); // short
    expect(isEip7702Designator(`0xef0100${"11".repeat(21)}`)).toBe(false); // long
    expect(isEip7702Designator(TOKEN_CODE as `0x${string}`)).toBe(false);
    expect(isEip7702Designator("0x")).toBe(false);
    expect(isEip7702Designator(undefined)).toBe(false);
  });
});

describe("decodeMakerExtensionContext — from the signed bytes, never throwing", () => {
  const jitParams = {
    collateralAsset: COLLATERAL,
    referenceAsset: OTHER_TOKEN,
    expiryTimestamp: 1_795_000_000n,
    recipe: "0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55",
    rateOverride: 0n,
    constraint: { rateMin: 1n, rateMax: 2n * 10n ** 18n, rateChangePerDayMax: 10n ** 18n, rateChangeCapacityMax: 3n * 10n ** 18n },
    extraData: "0x",
    swapFeePercentage: 0n,
    unwindSwapFeePercentage: 0n,
    enableJitMint: true,
  } as const;
  const permit = { token: ASSET, value: 10n ** 18n, deadline: 1_795_000_000n, v: 27, r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}` } as const;

  it("no extension: nulls", () => {
    expect(decodeMakerExtensionContext(undefined)).toEqual({ jit: null, extensionPermitToken: null });
    expect(decodeMakerExtensionContext("0x")).toEqual({ jit: null, extensionPermitToken: null });
  });

  it("a JIT extension with a permit: adapter, collateral, mint flag, and the permit-derived cST prediction", () => {
    const ext = buildJitExtension(ADAPTER, encodeJitExtraData("flat", jitParams, [permit]));
    const ctx = decodeMakerExtensionContext(ext);
    expect(ctx.jit).toMatchObject({ adapter: ADAPTER, collateralAsset: COLLATERAL, enableJitMint: true, predictedCorkSwapToken: ASSET, permitTokens: [ASSET] });
  });

  it("a JIT extension WITHOUT permits: the created token is unknowable from the bytes (null prediction)", () => {
    const ctx = decodeMakerExtensionContext(buildJitExtension(ADAPTER, encodeJitExtraData("flat", jitParams, [])));
    expect(ctx.jit).toMatchObject({ predictedCorkSwapToken: null, permitTokens: [] });
  });

  it("a LOP-level makerPermit field: the token is the first 20 bytes; the field alone is not a JIT hook", () => {
    const ext = encodeExtensionFields({ makerPermit: `0x${ASSET.slice(2)}${"00".repeat(32)}` as `0x${string}` });
    const ctx = decodeMakerExtensionContext(ext);
    expect(ctx.jit).toBeNull();
    expect(ctx.extensionPermitToken?.toLowerCase()).toBe(ASSET.toLowerCase());
  });

  it("foreign or garbage bytes never throw: null legs", () => {
    expect(decodeMakerExtensionContext("0xdeadbeef")).toEqual({ jit: null, extensionPermitToken: null });
  });
});

describe("gatherMakerReadinessFacts — the one-batch discipline", () => {
  type Rec = { functionName: string; address: string; args: readonly unknown[]; blockNumber?: bigint };
  function recordingClient(answers: { code?: Record<string, string | Error>; read?: (c: Rec) => unknown } = {}) {
    const reads: Rec[] = [];
    const getCodes: Array<{ address: string; blockNumber?: bigint }> = [];
    const client: ReadinessClient = {
      readContract: (async (c: Rec) => {
        reads.push(c);
        if (answers.read) return answers.read(c);
        return 10n ** 24n;
      }) as never,
      getCode: async (a) => {
        getCodes.push(a);
        const ans = answers.code?.[a.address.toLowerCase()];
        if (ans instanceof Error) throw ans;
        return (ans ?? TOKEN_CODE) as `0x${string}`;
      },
    };
    return { client, reads, getCodes };
  }
  const target = (over: Partial<MakerReadinessTarget> = {}): MakerReadinessTarget => ({
    maker: MAKER,
    makerAsset: ASSET,
    lop: LOP,
    usePermit2: false,
    makerSignedEcdsa: false,
    jit: null,
    ...over,
  });

  it("legs are conditioned only on chain-free facts: plain sourcing reads allowance→LOP and balance, never Permit2", async () => {
    const { client, reads, getCodes } = recordingClient();
    await gatherMakerReadinessFacts(client, target());
    expect(reads.map((r) => r.functionName).sort()).toEqual(["allowance", "balanceOf"]);
    expect(reads.every((r) => r.address.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase())).toBe(true);
    expect(reads.find((r) => r.functionName === "allowance")!.args).toEqual([MAKER, LOP]);
    expect(getCodes.map((g) => g.address.toLowerCase())).toEqual([ASSET.toLowerCase(), MAKER.toLowerCase()]);
  });

  it("Permit2 sourcing reads BOTH layers and never the plain allowance", async () => {
    const { client, reads } = recordingClient({ read: (c) => (c.address.toLowerCase() === PERMIT2_ADDRESS.toLowerCase() ? [10n ** 24n, Number(NOW) + 60, 0] : 10n ** 24n) });
    const facts = await gatherMakerReadinessFacts(client, target({ usePermit2: true }));
    const p2 = reads.filter((r) => r.functionName === "allowance");
    expect(p2.map((r) => r.args)).toEqual([
      [MAKER, PERMIT2_ADDRESS], // layer 1: ERC-20 grant to Permit2
      [MAKER, ASSET, LOP], // layer 2: the internal allowance
    ]);
    expect(facts.allowanceToLop).toBeUndefined();
    expect(facts.permit2Internal).toEqual({ amount: 10n ** 24n, expiration: Number(NOW) + 60 });
  });

  it("a chain-free ECDSA proof skips the maker's own getCode; enableJitMint skips the makerAsset balance and adds the collateral legs", async () => {
    const { client, reads, getCodes } = recordingClient();
    const facts = await gatherMakerReadinessFacts(client, target({ makerSignedEcdsa: true, jit: jitCtx({ enableJitMint: true }) }));
    expect(getCodes.map((g) => g.address.toLowerCase())).toEqual([ASSET.toLowerCase()]); // no maker read
    expect(facts.makerCanSignEcdsa).toBe(true);
    expect(reads.map((r) => [r.functionName, r.address.toLowerCase()])).toEqual(
      expect.arrayContaining([
        ["allowance", ASSET.toLowerCase()],
        ["allowance", COLLATERAL.toLowerCase()],
        ["balanceOf", COLLATERAL.toLowerCase()],
      ]),
    );
    expect(reads.some((r) => r.functionName === "balanceOf" && r.address.toLowerCase() === ASSET.toLowerCase())).toBe(false);
    expect(facts.balance).toBeUndefined();
  });

  it("every leg is ISSUED before any answers — no read waits on another read's result", async () => {
    // Barrier client: readContract promises resolve only once ALL expected legs are in flight.
    // A gather that conditioned one leg on another's ANSWER would deadlock here (vitest timeout).
    const expected = 3; // allowance→LOP + the two mint-collateral legs (balance skipped by the mint)
    const pending: Array<() => void> = [];
    let issued = 0;
    const client: ReadinessClient = {
      readContract: (() =>
        new Promise((res) => {
          issued += 1;
          pending.push(() => res(10n ** 24n));
          if (issued === expected) for (const release of pending) release();
        })) as never,
      getCode: async () => TOKEN_CODE as `0x${string}`,
    };
    const facts = await gatherMakerReadinessFacts(client, target({ makerSignedEcdsa: true, jit: jitCtx({ enableJitMint: true }) }));
    expect(issued).toBe(expected);
    expect(facts.mintCollateralAllowance).toBe(10n ** 24n);
  });

  it("a client whose getCode THROWS SYNCHRONOUSLY (a structural slice missing the method) still lands as read-failed, never an escaped throw", async () => {
    const client = { readContract: async () => 10n ** 24n } as unknown as ReadinessClient; // no getCode at all
    const facts = await gatherMakerReadinessFacts(client, target());
    expect(facts.makerAssetCode).toBe("read-failed");
    expect(facts.makerCanSignEcdsa).toBeNull();
  });

  it("makerCanSignEcdsa from the maker's code: no code and an EIP-7702 designator sign ECDSA; real code does not; a failed read is null", async () => {
    const at = async (code: string | Error) => {
      const { client } = recordingClient({ code: { [ASSET.toLowerCase()]: TOKEN_CODE, [MAKER.toLowerCase()]: code } });
      return (await gatherMakerReadinessFacts(client, target())).makerCanSignEcdsa;
    };
    expect(await at("0x")).toBe(true);
    expect(await at(`0xef0100${"11".repeat(20)}`)).toBe(true);
    expect(await at(TOKEN_CODE)).toBe(false);
    expect(await at(new Error("transport"))).toBeNull();
  });

  it("a rejected token read lands as 'error' on its own leg; atBlock rides every leg", async () => {
    const { client, reads, getCodes } = recordingClient({
      read: (c) => {
        if (c.functionName === "balanceOf") throw new Error("revert");
        return 10n ** 24n;
      },
    });
    const facts = await gatherMakerReadinessFacts(client, target(), { atBlock: 123n });
    expect(facts.balance).toBe("error");
    expect(facts.allowanceToLop).toBe(10n ** 24n);
    expect(reads.every((r) => r.blockNumber === 123n)).toBe(true);
    expect(getCodes.every((g) => g.blockNumber === 123n)).toBe(true);
  });
});

describe("makerReadinessTargetOf — the classifier's chain-free inputs from the signed bytes", () => {
  const order = (traits: bigint): LopOrder => ({
    salt: 1n,
    maker: MAKER,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: ASSET,
    takerAsset: COLLATERAL,
    makingAmount: 10n ** 18n,
    takingAmount: 1n,
    makerTraits: traits,
  });

  it("decodes usePermit2 (bit 248), partial fills (bit 255 inverted), and the 40-bit expiry from the traits", () => {
    const plain = makerReadinessTargetOf({ order: order(0n), extension: "0x", lop: LOP, makerSignedEcdsa: true });
    expect(plain.target).toMatchObject({ maker: MAKER, makerAsset: ASSET, lop: LOP, usePermit2: false, makerSignedEcdsa: true, jit: null });
    expect(plain.allowPartialFills).toBe(true);
    expect(plain.orderExpiry).toBe(0n);
    const traits = (1n << 248n) | (1n << 255n) | (12345n << 80n);
    const rich = makerReadinessTargetOf({ order: order(traits), extension: "0x", lop: LOP, makerSignedEcdsa: false });
    expect(rich.target.usePermit2).toBe(true);
    expect(rich.allowPartialFills).toBe(false);
    expect(rich.orderExpiry).toBe(12345n);
  });
});

describe("taker-fill — the maker-readiness surface end-to-end (venue-free path)", () => {
  const maker = privateKeyToAccount(`0x${"3a".repeat(32)}`);
  const ACCOUNT = "0x00000000000000000000000000000000000000aa" as const;
  const venueMustNotBeCalled = async (): Promise<Response> => {
    throw new Error("venue contacted on the signedOrder path");
  };
  async function signedInline() {
    const order: LopOrder = { salt: 7n, maker: maker.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: ASSET, takerAsset: COLLATERAL, makingAmount: 10n ** 18n, takingAmount: 5n * 10n ** 16n, makerTraits: 0n };
    const orderHash = hashLopOrder(1, LOP, order);
    return { orderHash, signedOrder: { order: { salt: "7", maker: order.maker, receiver: order.receiver, makerAsset: order.makerAsset, takerAsset: order.takerAsset, makingAmount: order.makingAmount.toString(), takingAmount: order.takingAmount.toString(), makerTraits: "0" }, signature: await maker.sign({ hash: orderHash }) } };
  }
  const chain = (opts: { code?: Record<string, string>; allowance?: bigint; balance?: bigint }) =>
    stubRpc(
      (c) => {
        switch (c.functionName) {
          case "bitInvalidatorForOrder":
            return 0n;
          case "allowance":
            return opts.allowance ?? 10n ** 24n;
          case "balanceOf":
            return opts.balance ?? 10n ** 24n;
          default:
            throw new Error(`no stub for ${c.functionName}`);
        }
      },
      { code: opts.code },
    );
  const fill = async (resolveRpc: unknown) => {
    const { orderHash, signedOrder } = await signedInline();
    return runTool(
      "cork_prepare_orders",
      { chainId: 1, account: ACCOUNT, clientRequestId: "readiness-fill-0001", action: { type: "taker-fill", orderHash, signedOrder }, format: "concise" },
      { nowSeconds: NOW, venueFetch: venueMustNotBeCalled, resolveRpc: resolveRpc as never },
    );
  };
  type FillData = { makerReadiness: { status: string; reasons: Array<{ code: string; structural: boolean }> }; approvals: Array<{ role: string; holder: string }>; calldata: string };

  it("a structural gap warns maker_not_ready but still builds (the fix is the maker's): a code-less makerAsset with no hook", async () => {
    const env = await fill(chain({})); // no code fixture: the makerAsset reads no-code
    expect(env.state).toBe("ok");
    const d = env.data as FillData;
    expect(d.calldata.startsWith("0x")).toBe(true);
    expect(d.makerReadiness.status).toBe("not-ready");
    expect(d.makerReadiness.reasons.map((r) => r.code)).toEqual(["silent-noop"]);
    const warn = env.warnings.find((w) => w.code === "maker_not_ready");
    expect(warn?.message).toContain("data.makerReadiness");
    expect(env.warnings.some((w) => w.code === "would_revert")).toBe(false);
  });

  it("a fund gap (zero maker balance) warns would_revert, not maker_not_ready", async () => {
    const env = await fill(chain({ code: { [ASSET.toLowerCase()]: TOKEN_CODE }, balance: 0n }));
    expect(env.state).toBe("ok");
    const d = env.data as FillData;
    expect(d.makerReadiness.reasons.map((r) => r.code)).toEqual(["balance-empty"]);
    expect(env.warnings.some((w) => w.code === "maker_not_ready")).toBe(false);
    expect(env.warnings.find((w) => w.code === "would_revert")?.message).toContain("not funded");
  });

  it("a ready maker side: no readiness warnings, verdict on data, and the maker's grant entries still ride approvals", async () => {
    const env = await fill(chain({ code: { [ASSET.toLowerCase()]: TOKEN_CODE } }));
    expect(env.state).toBe("ok");
    const d = env.data as FillData;
    expect(d.makerReadiness).toEqual({ status: "ready", reasons: [] });
    expect(env.warnings.some((w) => w.code === "maker_not_ready" || w.code === "would_revert")).toBe(false);
    expect(d.approvals.some((a) => a.role === "maker" && a.holder.toLowerCase() === maker.address.toLowerCase())).toBe(true);
  });

  it("offline: the verdict is 'unknown' with no reasons — never invented — and no readiness warning fires", async () => {
    const env = await fill(async () => null);
    expect(env.state).toBe("ok");
    expect((env.data as FillData).makerReadiness).toEqual({ status: "unknown", reasons: [] });
    expect(env.warnings.some((w) => w.code === "maker_not_ready" || w.code === "would_revert")).toBe(false);
  });
});
