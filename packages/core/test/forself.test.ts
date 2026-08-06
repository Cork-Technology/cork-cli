// ForSelf surface: encoders cross-checked against foundry (`cast calldata` / `forge inspect`
// fixtures generated from example/contracts — the Solidity source of truth), plus the
// tool-level forSelf modes on cork_prepare_orders taker-fill and cork_prepare_phoenix.
import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildFillOrderForSelfCall,
  buildPoolForSelfCall,
  forSelfAbi,
  forSelfSelectors,
  FORSELF_ALLOWANCES,
  hashLopOrder,
  LOP_ADDRESSES,
  MAINNET_DEPLOYMENT,
  runTool,
  ToolInputError,
  type LopOrder,
} from "@cork/core";
import { forSelfPairAllowed } from "../src/handlers/forself.ts";
import { stubRpc } from "./helpers.ts";

const POOL = `0x${"11".repeat(32)}` as const;
const NOW = 1_800_000_000n;
const ADAPTER = "0xaaaAAAAAAaAaaaaAAAaaAAAAaAaaaaAaaAaaAA01" as const;
const ACCOUNT = "0xc0ffee0000000000000000000000000000000001" as const;

// ── selector parity with the compiled adapters (forge inspect methodIdentifiers) ────────────
const FORGE_SELECTORS: Record<string, string> = {
  depositForSelf: "0x378c9ac6",
  mintForSelf: "0x74b8faca",
  unwindSwapForSelf: "0xb5b8aa76",
  unwindExerciseForSelf: "0x894b2bc7",
  unwindExerciseOtherForSelf: "0x1dc3f3db",
  swapForSelf: "0x6b5a0f3a",
  exerciseForSelf: "0x1ec95fe9",
  exerciseOtherForSelf: "0xb29152a5",
  unwindDepositForSelf: "0x0ec961b8",
  unwindMintForSelf: "0x409f699d",
  redeemForSelf: "0xcda93c02",
  withdrawForSelf: "0x38fe92e0",
  withdrawOtherForSelf: "0x5fd35a1a",
  fillOrderForSelf: "0xa9aa7877",
};

describe("forself: selector parity with the compiled example adapters", () => {
  it("every entrypoint selector matches forge inspect", () => {
    const ours = forSelfSelectors();
    for (const [name, expected] of Object.entries(FORGE_SELECTORS)) {
      expect(ours[name], name).toBe(expected);
    }
  });
  it("every entrypoint in the ABI is covered by the fixture (no unpinned additions)", () => {
    const names = forSelfAbi.filter((f) => f.type === "function" && !["CORK", "LOP"].includes(f.name)).map((f) => (f as { name: string }).name);
    expect(names.sort()).toEqual(Object.keys(FORGE_SELECTORS).sort());
  });
});

// ── calldata parity with cast (field ORDER inside each params struct is load-bearing) ───────
// Fixtures: cast calldata '<fn>((bytes32,...))' '(0x11…11,1,2[,3],1000)' — distinct values per
// slot, so any transposition of same-typed fields changes the bytes and fails here.
const CAST_FIXTURES: Array<{ action: Record<string, unknown>; calldata: string }> = [
  { action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: ACCOUNT, minCptAndCstSharesOut: "2" }, calldata: "0x378c9ac6" },
  { action: { type: "mint", poolId: POOL, cptAndCstSharesOut: "1", receiver: ACCOUNT, maxCollateralAssetsIn: "2" }, calldata: "0x74b8faca" },
  { action: { type: "unwind-swap", poolId: POOL, collateralAssetsIn: "1", receiver: ACCOUNT, minCstSharesOut: "2", minReferenceAssetsOut: "3" }, calldata: "0xb5b8aa76" },
  { action: { type: "unwind-exercise", poolId: POOL, cstSharesOut: "1", receiver: ACCOUNT, maxCollateralAssetsIn: "2", minReferenceAssetsOut: "3" }, calldata: "0x894b2bc7" },
  { action: { type: "unwind-exercise-other", poolId: POOL, referenceAssetsOut: "1", receiver: ACCOUNT, maxCollateralAssetsIn: "2", minCstSharesOut: "3" }, calldata: "0x1dc3f3db" },
  { action: { type: "swap", poolId: POOL, collateralAssetsOut: "1", receiver: ACCOUNT, maxCstSharesIn: "2", maxReferenceAssetsIn: "3" }, calldata: "0x6b5a0f3a" },
  { action: { type: "exercise", poolId: POOL, cstSharesIn: "1", receiver: ACCOUNT, maxReferenceAssetsIn: "2", minCollateralAssetsOut: "3" }, calldata: "0x1ec95fe9" },
  { action: { type: "exercise-other", poolId: POOL, referenceAssetsIn: "1", receiver: ACCOUNT, maxCstSharesIn: "2", minCollateralAssetsOut: "3" }, calldata: "0xb29152a5" },
  { action: { type: "unwind-deposit", poolId: POOL, collateralAssetsOut: "1", owner: ACCOUNT, receiver: ACCOUNT, maxCptAndCstSharesIn: "2" }, calldata: "0x0ec961b8" },
  { action: { type: "unwind-mint", poolId: POOL, cptAndCstSharesIn: "1", owner: ACCOUNT, receiver: ACCOUNT, minCollateralAssetsOut: "2" }, calldata: "0x409f699d" },
  { action: { type: "redeem", poolId: POOL, cptSharesIn: "1", owner: ACCOUNT, receiver: ACCOUNT, minReferenceAssetsOut: "2", minCollateralAssetsOut: "3" }, calldata: "0xcda93c02" },
  { action: { type: "withdraw", poolId: POOL, collateralAssetsOut: "1", owner: ACCOUNT, receiver: ACCOUNT, maxCptSharesIn: "2" }, calldata: "0x38fe92e0" },
  { action: { type: "withdraw-other", poolId: POOL, referenceAssetsOut: "1", owner: ACCOUNT, receiver: ACCOUNT, maxCptSharesIn: "2" }, calldata: "0x5fd35a1a" },
];
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
// cast calldata body for (poolId, 1, 2, [3,] 1000): the exact bytes cast emitted, reconstructed
// from the uniform value pattern (verified byte-identical against the cast output for every fn).
const castBody = (fieldsAfterPool: number) => {
  const vals = fieldsAfterPool === 3 ? [1n, 2n, 1000n] : [1n, 2n, 3n, 1000n];
  return `${"11".repeat(32)}${vals.map((v) => word(v)).join("")}`;
};

describe("forself: pool calldata parity with cast", () => {
  for (const f of CAST_FIXTURES) {
    it(`${f.action.type} encodes field-order-exact calldata`, () => {
      const built = buildPoolForSelfCall(f.action as never, 1000n);
      const nFields = (built.calldata.length - 10) / 64 - 1; // words after poolId
      expect(built.calldata).toBe(`${f.calldata}${castBody(nFields)}`);
    });
  }
  it("every pool action has an allowance-matrix entry", () => {
    for (const f of CAST_FIXTURES) {
      expect(FORSELF_ALLOWANCES[(f.action as { type: string }).type as never], String(f.action.type)).toBeTruthy();
    }
  });
  it("the allowance matrix pins exact-vs-cap semantics (the README matrix, verbatim)", () => {
    // exercise: the cST leg is EXACT (pulled precisely), the reference leg is a CAP (refunded).
    expect(FORSELF_ALLOWANCES.exercise).toEqual([
      { tokenRole: "cST", amountField: "cstSharesIn", kind: "exact" },
      { tokenRole: "reference", amountField: "maxReferenceAssetsIn", kind: "cap" },
    ]);
    // Group C burns straight from the caller — every entry carries the burn note.
    for (const t of ["redeem", "withdraw", "withdraw-other", "unwind-deposit", "unwind-mint"] as const) {
      for (const a of FORSELF_ALLOWANCES[t]) expect(a.note, `${t}/${a.tokenRole}`).toContain("burned straight from the caller");
    }
  });
});

describe("forself: fillOrderForSelf calldata parity with cast", () => {
  const order: LopOrder = {
    salt: 1n,
    maker: `0x${"00".repeat(19)}02`,
    receiver: `0x${"00".repeat(19)}03`,
    makerAsset: `0x${"00".repeat(19)}04`,
    takerAsset: `0x${"00".repeat(19)}05`,
    makingAmount: 6n,
    takingAmount: 7n,
    makerTraits: 8n,
  };
  it("matches the cast-generated bytes exactly (order tuple, sig, traits, extension, deadline)", () => {
    const built = buildFillOrderForSelfCall({
      poolId: POOL,
      order,
      signature: "0xaabb",
      fillMakingAmount: 5n,
      maximumTakingAmount: 7n,
      extension: "0xccdd",
      deadline: 1000n,
    });
    // The EXACT bytes cast emitted for:
    //   cast calldata 'fillOrderForSelf((bytes32,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),bytes,uint256,uint256,bytes,uint256))' \
    //     '(0x11..11,(1,2,3,4,5,6,7,8),0xaabb,5,(1<<255)|7,0xccdd,1000)'
    const expected =
      "0xa9aa787700000000000000000000000000000000000000000000000000000000" +
      "0000002011111111111111111111111111111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000000058000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000002aabb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002ccdd000000000000000000000000000000000000000000000000000000000000";
    expect(built.calldata).toBe(expected);
    expect(built.functionName).toBe("fillOrderForSelf");
  });
  it("rejects a zero pull cap (the wrapper's ThresholdRequired) and an over-wide one", () => {
    expect(() => buildFillOrderForSelfCall({ poolId: POOL, order, signature: "0x", fillMakingAmount: 1n, maximumTakingAmount: 0n, extension: "0x", deadline: 1n })).toThrow(/positive/u);
    expect(() => buildFillOrderForSelfCall({ poolId: POOL, order, signature: "0x", fillMakingAmount: 1n, maximumTakingAmount: 1n << 184n, extension: "0x", deadline: 1n })).toThrow(/184-bit/u);
  });
});

describe("forself: the market-binding comparator (share × cash, both directions)", () => {
  const tokens = { collateral: "0xC0", reference: "0xE0", cst: "0x51", cpt: "0x52" };
  const cases: Array<[string, string, boolean]> = [
    ["0x51", "0xC0", true], // cST → collateral (the pilot shape)
    ["0xC0", "0x51", true], // collateral → cST
    ["0x52", "0xC0", true], // cPT → collateral (live venue shape)
    ["0x51", "0xE0", true], // cST → reference
    ["0xE0", "0x52", true], // reference → cPT
    ["0xC0", "0xE0", false], // cash × cash
    ["0x51", "0x52", false], // share × share
    ["0x99", "0xC0", false], // junk × cash
    ["0x51", "0x99", false], // share × junk
  ];
  for (const [m, t, want] of cases) {
    it(`${m} vs ${t} → ${want}`, () => {
      expect(forSelfPairAllowed(tokens, m, t)).toBe(want);
    });
  }
});

// ── tool-level: taker-fill forSelf (real signed order, stubbed venue + chain) ───────────────
const MAKER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // throwaway
const maker = privateKeyToAccount(MAKER_PK);
const CST = "0x00000000000000000000000000000000000000c5" as const;
const CPT = "0x00000000000000000000000000000000000000c7" as const;
const COLLATERAL = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const REFERENCE = "0x00000000000000000000000000000000000000e0" as const;

async function signedVenueRow(over: Partial<LopOrder> = {}) {
  const order: LopOrder = {
    salt: 42n,
    maker: maker.address,
    receiver: "0x0000000000000000000000000000000000000000",
    makerAsset: CST,
    takerAsset: COLLATERAL,
    makingAmount: 10n ** 18n,
    takingAmount: 5n * 10n ** 16n,
    makerTraits: 0n,
    ...over,
  };
  const orderHash = hashLopOrder(1, LOP_ADDRESSES[1]!, order);
  const signature = await maker.sign({ hash: orderHash });
  return {
    orderHash,
    row: {
      orderHash,
      order: {
        salt: order.salt.toString(),
        maker: order.maker,
        receiver: order.receiver,
        makerAsset: order.makerAsset,
        takerAsset: order.takerAsset,
        makingAmount: order.makingAmount.toString(),
        takingAmount: order.takingAmount.toString(),
        makerTraits: order.makerTraits.toString(),
      },
      signature,
      extension: "0x",
      makerAccountType: "EOA",
    },
  };
}

/** A chain stub that answers the ForSelf bindings and the pool token reads. */
const chainStub = (over: { cork?: string; lop?: string; market?: Record<string, unknown> } = {}) =>
  stubRpc((c) => chainStubAnswer(c, over), { code: { [ADAPTER.toLowerCase()]: "0x60806040" } });
const chainStubAnswer = (c: { functionName: string }, over: { cork?: string; lop?: string; market?: Record<string, unknown> }) => {
  {
    switch (c.functionName) {
      case "CORK":
        return over.cork ?? MAINNET_DEPLOYMENT.poolManager;
      case "LOP":
        return over.lop ?? LOP_ADDRESSES[1]!;
      case "market":
        return over.market ?? { collateralAsset: COLLATERAL, referenceAsset: REFERENCE, expiryTimestamp: NOW + 10_000n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 1n, rateChangeCapacityMax: 1n, rateOracle: "0x00000000000000000000000000000000000000f0" };
      case "shares":
        return [CPT, CST];
      case "paused":
        return false;
      case "getPausedBitMap":
        return 0n;
      case "isWhitelisted":
        return true;
      case "bitInvalidatorForOrder":
        return 0n; // live-untouched
      default:
        throw new Error(`no stub for ${c.functionName}`);
    }
  }
};

const venueWith = (row: Record<string, unknown>) => async (url: string) => {
  if (url.includes("orderbook")) return new Response(JSON.stringify({ items: [row], hasMore: false }), { status: 200 });
  return new Response(JSON.stringify({ items: [] }), { status: 200 });
};

describe("runTool: cork_prepare_orders taker-fill forSelf", () => {
  it("emits an unsigned fillOrderForSelf call to the adapter, capped and deadline-bound", async () => {
    const { orderHash, row } = await signedVenueRow();
    const env = await runTool(
      "cork_prepare_orders",
      {
        chainId: 1,
        account: ACCOUNT,
        clientRequestId: "forself-fill-0001",
        action: { type: "taker-fill", orderHash, forSelf: { adapter: ADAPTER, poolId: POOL, deadlineAt: String(NOW + 600n) } },
        format: "concise",
      },
      { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: chainStub() },
    );
    expect(env.state).toBe("ok");
    const d = env.data as Record<string, never> & { to: string; calldata: `0x${string}`; fillFunction: string; forSelf: Record<string, unknown> };
    expect(d.to).toBe(ADAPTER);
    expect(d.fillFunction).toBe("fillOrderForSelf");
    // The calldata decodes back to the exact fill: full making, cap = signed taking, our deadline.
    const dec = decodeFunctionData({ abi: forSelfAbi, data: d.calldata });
    expect(dec.functionName).toBe("fillOrderForSelf");
    const p = (dec.args as unknown as [Record<string, unknown>])[0];
    expect(p.poolId).toBe(POOL);
    expect(p.amount).toBe(10n ** 18n);
    expect(p.takerTraits).toBe((1n << 255n) | (5n * 10n ** 16n));
    expect(p.deadline).toBe(NOW + 600n);
    expect((p.order as { maker: bigint }).maker).toBe(BigInt(maker.address));
    // Disclosure: allowance goes to the ADAPTER; artifact is unsigned.
    const codes = env.warnings.map((w) => w.code);
    expect(codes).toContain("for_self_artifact");
    expect(codes).toContain("unsigned_artifact");
    expect(codes).not.toContain("would_revert"); // pair matches the pool
    expect((d.forSelf as { pullCap: string }).pullCap).toBe(String(5n * 10n ** 16n));
  });

  it("binding mismatch is a CONFLICT: the adapter wraps a different pool manager", async () => {
    const { orderHash, row } = await signedVenueRow();
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-fill-0002", action: { type: "taker-fill", orderHash, forSelf: { adapter: ADAPTER, poolId: POOL } }, format: "concise" },
      { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: chainStub({ cork: "0x000000000000000000000000000000000000dEaD" }) },
    );
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("adapter_binding_mismatch");
  });

  it("attribution: NO CONTRACT at the adapter address is a definitive conflict", async () => {
    const { orderHash, row } = await signedVenueRow();
    // stubRpc's default: addresses not in opts.code answer getCode "0x".
    const noCode = stubRpc((c) => chainStubAnswer(c, {}));
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-fill-0006", action: { type: "taker-fill", orderHash, forSelf: { adapter: ADAPTER, poolId: POOL } }, format: "concise" },
      { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: noCode },
    );
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("adapter_binding_mismatch");
    expect(env.warnings[0]?.message).toContain("NO CONTRACT");
  });

  it("attribution: a TRANSPORT failure on the binding reads discloses instead of accusing", async () => {
    const { orderHash, row } = await signedVenueRow();
    const transportDown = stubRpc(
      (c) => {
        if (c.functionName === "CORK" || c.functionName === "LOP") throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
        return chainStubAnswer(c, {});
      },
      { code: { [ADAPTER.toLowerCase()]: "0x60806040" } },
    );
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-fill-0007", action: { type: "taker-fill", orderHash, forSelf: { adapter: ADAPTER, poolId: POOL } }, format: "concise" },
      { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: transportDown },
    );
    expect(env.state).toBe("ok"); // artifact still built — the gap is disclosed, not misattributed
    expect(env.warnings.some((w) => w.code === "chain_read_failed" && w.message.includes("could NOT be verified"))).toBe(true);
  });

  it("attribution: a contract that REFUSES the binding views is a definitive conflict", async () => {
    const { orderHash, row } = await signedVenueRow();
    const refuses = stubRpc(
      (c) => {
        if (c.functionName === "CORK" || c.functionName === "LOP") throw new Error("execution reverted");
        return chainStubAnswer(c, {});
      },
      { code: { [ADAPTER.toLowerCase()]: "0x60806040" } },
    );
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-fill-0008", action: { type: "taker-fill", orderHash, forSelf: { adapter: ADAPTER, poolId: POOL } }, format: "concise" },
      { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: refuses },
    );
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("adapter_binding_mismatch");
    expect(env.warnings[0]?.message).toContain("not a Cork ForSelf adapter");
  });

  it("a pair outside the pool's share×cash set warns would_revert (build-and-warn)", async () => {
    const { orderHash, row } = await signedVenueRow({ makerAsset: "0x00000000000000000000000000000000000000AA" });
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-fill-0003", action: { type: "taker-fill", orderHash, forSelf: { adapter: ADAPTER, poolId: POOL } }, format: "concise" },
      { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: chainStub() },
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "would_revert" && w.message.includes("OrderAssetsNotInMarket"))).toBe(true);
  });

  it("receiver conflicts with forSelf (teaching error — the wrapper IS the receiver policy)", async () => {
    const { orderHash, row } = await signedVenueRow();
    await expect(
      runTool(
        "cork_prepare_orders",
        { chainId: 1, account: ACCOUNT, clientRequestId: "forself-fill-0004", action: { type: "taker-fill", orderHash, receiver: ACCOUNT, forSelf: { adapter: ADAPTER, poolId: POOL } }, format: "concise" },
        { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: chainStub() },
      ),
    ).rejects.toThrow(ToolInputError);
  });

  it("jitMarket conflicts with forSelf (taker interactions are structurally impossible)", async () => {
    const { orderHash, row } = await signedVenueRow();
    await expect(
      runTool(
        "cork_prepare_orders",
        {
          chainId: 1,
          account: ACCOUNT,
          clientRequestId: "forself-fill-0005",
          action: {
            type: "taker-fill",
            orderHash,
            forSelf: { adapter: ADAPTER, poolId: POOL },
            jitMarket: { collateralAsset: COLLATERAL, referenceAsset: REFERENCE, expiryTimestamp: String(NOW + 10_000n) },
          },
          format: "concise",
        },
        { nowSeconds: NOW, venueFetch: venueWith(row), resolveRpc: chainStub() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ToolInputError && JSON.stringify((e as ToolInputError).issues).includes("taker interaction"));
  });
});

describe("cork_decode kind:'tx' labels ForSelf calldata (validate-before-broadcast)", () => {
  it("an exerciseForSelf tx to an unknown adapter labels the leg and explains the unknown target", async () => {
    const call = buildPoolForSelfCall(
      { type: "exercise", poolId: POOL, cstSharesIn: "1000", receiver: ACCOUNT, minCollateralAssetsOut: "900", maxReferenceAssetsIn: "50" } as never,
      NOW + 900n,
    );
    const signed = await privateKeyToAccount(`0x${"07".repeat(32)}`).signTransaction({
      type: "eip1559",
      chainId: 1,
      nonce: 1,
      to: ADAPTER,
      value: 0n,
      data: call.calldata,
      gas: 300_000n,
      maxFeePerGas: 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 8n,
    });
    const env = await runTool("cork_decode", { kind: "tx", data: signed, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const d = env.data as { legs: Array<{ kind: string; action?: string }>; summary: string[] };
    expect(d.legs[0]?.kind).toBe("forself");
    expect(d.legs[0]?.action).toBe("exerciseForSelf");
    expect(d.summary.join("\n")).toContain("every output goes back to the CALLER");
    const unk = env.warnings.find((w) => w.code === "unknown_target");
    expect(unk?.message).toContain("ForSelf adapters are deployed by the INTEGRATOR");
  });
});

describe("runTool: cork_prepare_phoenix forSelf", () => {
  const exercise = { type: "exercise", poolId: POOL, cstSharesIn: "1000", receiver: ACCOUNT, minCollateralAssetsOut: "900", maxReferenceAssetsIn: "50" } as const;

  it("emits the exerciseForSelf twin as a direct adapter call with the allowance matrix", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-ex-0001", deadlineAt: String(NOW + 900n), forSelf: { adapter: ADAPTER }, action: exercise, format: "concise" },
      { nowSeconds: NOW, resolveRpc: chainStub() },
    );
    expect(env.state).toBe("ok");
    const d = env.data as { to: string; calldata: `0x${string}`; forSelf: { functionName: string; allowances: Array<{ tokenRole: string; token?: string }> } };
    expect(d.to).toBe(ADAPTER);
    expect(d.forSelf.functionName).toBe("exerciseForSelf");
    const dec = decodeFunctionData({ abi: forSelfAbi, data: d.calldata });
    expect(dec.functionName).toBe("exerciseForSelf");
    const p = (dec.args as unknown as [Record<string, bigint>])[0];
    expect(p.cstSharesIn).toBe(1000n);
    expect(p.maxReferenceAssetsIn).toBe(50n);
    expect(p.minCollateralAssetsOut).toBe(900n);
    expect(p.deadline).toBe(NOW + 900n);
    // The allowance matrix names the pool's actual token addresses (read from the stub).
    expect(d.forSelf.allowances.map((a) => a.tokenRole).sort()).toEqual(["cST", "reference"]);
    expect(d.forSelf.allowances.find((a) => a.tokenRole === "cST")?.token).toBe(CST);
    expect(env.warnings.some((w) => w.code === "for_self_artifact")).toBe(true);
    // The summary is DERIVED from the built bytes (decoded with the same decoder every
    // consumer sees), not narrated — so it must carry the decoded action, pool, deadline.
    const summary = (env.data as { summary: string[] }).summary;
    expect(summary[0]).toContain("run 'exerciseForSelf' on the ForSelf adapter");
    expect(summary[0]).toContain(`deadline ${NOW + 900n}`);
    expect(summary[1]).toContain("approve the adapter to spend");
  });

  it("a receiver other than the account is a teaching error, not a silent redirect", async () => {
    await expect(
      runTool(
        "cork_prepare_phoenix",
        { chainId: 1, account: ACCOUNT, clientRequestId: "forself-ex-0002", forSelf: { adapter: ADAPTER }, action: { ...exercise, receiver: "0x000000000000000000000000000000000000dEaD" }, format: "concise" },
        { nowSeconds: NOW, resolveRpc: chainStub() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ToolInputError && JSON.stringify((e as ToolInputError).issues).includes("structurally deliver"));
  });

  it("authority ops have no ForSelf twin (teaching error)", async () => {
    await expect(
      runTool(
        "cork_prepare_phoenix",
        { chainId: 1, account: ACCOUNT, clientRequestId: "forself-ex-0003", forSelf: { adapter: ADAPTER }, action: { type: "authority-onboard", token: COLLATERAL, spender: ADAPTER }, format: "concise" },
        { nowSeconds: NOW, resolveRpc: chainStub() },
      ),
    ).rejects.toThrow(ToolInputError);
  });

  it("offline (no RPC): the artifact still builds, with the bindings-unverified warning", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-ex-0004", forSelf: { adapter: ADAPTER }, action: exercise, format: "concise" },
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(env.state).toBe("ok");
    expect((env.data as { to: string }).to).toBe(ADAPTER);
    expect(env.warnings.some((w) => w.code === "chain_read_failed" && w.message.includes("could NOT be verified"))).toBe(true);
  });

  it("a whitelist-gated pool names the ForSelf adapter as the whitelist subject", async () => {
    const gated = stubRpc((c) => {
      switch (c.functionName) {
        case "CORK":
          return MAINNET_DEPLOYMENT.poolManager;
        case "market":
          return { collateralAsset: COLLATERAL, referenceAsset: REFERENCE, expiryTimestamp: NOW + 10_000n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 1n, rateChangeCapacityMax: 1n, rateOracle: "0x00000000000000000000000000000000000000f0" };
        case "shares":
          return [CPT, CST];
        case "paused":
          return false;
        case "getPausedBitMap":
          return 0n;
        case "isWhitelisted":
          return false; // the adapter fails the gate
        default:
          throw new Error(`no stub for ${c.functionName}`);
      }
    }, { code: { [ADAPTER.toLowerCase()]: "0x60806040" } });
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: ACCOUNT, clientRequestId: "forself-ex-0005", forSelf: { adapter: ADAPTER }, action: exercise, format: "concise" },
      { nowSeconds: NOW, resolveRpc: gated },
    );
    expect(env.state).toBe("ok");
    const wl = env.warnings.find((w) => w.code === "not_whitelisted");
    expect(wl?.message).toContain("ForSelf adapter");
    expect(wl?.message).toContain(ADAPTER);
  });
});
