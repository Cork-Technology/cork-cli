// Empirical fork-parity: reproduce on-chain swapRate / preview* in pure TS, wei-for-wei,
// against the live Tenderly vnet fixture pool. Self-skips when CORK_TEST_RPC is unset so
// CI stays deterministic; when set, ANY wei mismatch fails the suite.
//
// Robustness: every read + on-chain preview is pinned to a single blockNumber, so the
// permissionlessly-mutable MockRateOracle cannot race the comparison.
import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import {
  computeMarketId,
  poolManagerAbi,
  previewAdjustedRate,
  previewExercise,
  previewExerciseOther,
  previewSwap,
  previewUnwindExercise,
  previewUnwindExerciseOther,
  previewUnwindSwap,
  readPoolState,
  runTool,
  type PoolStateRead,
} from "@cork/core";

const RPC = process.env.CORK_TEST_RPC;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const ADDR = {
  poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC" as const,
  constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A" as const,
};

describe.skipIf(!RPC)("fork parity vs live vnet fixture pool", () => {
  let client: PublicClient;
  let s: PoolStateRead;

  beforeAll(async () => {
    client = createPublicClient({ chain: mainnet, transport: http(RPC) });
    s = await readPoolState(client, ADDR, POOL);
  });

  it("MarketId re-hashes to the pool id", () => {
    expect(computeMarketId(s.market)).toBe(POOL);
  });

  it("previewAdjustedRate reproduces on-chain swapRate exactly", () => {
    const tsRate = previewAdjustedRate({
      market: s.market,
      state: s.constraintState,
      oracleRate: s.oracleRate,
      nowTs: s.blockTimestamp,
    });
    expect(tsRate).toBe(s.onChainSwapRate);
  });

  it("previewSwap matches on-chain wei-for-wei across amounts", async () => {
    const swapRate = previewAdjustedRate({
      market: s.market,
      state: s.constraintState,
      oracleRate: s.oracleRate,
      nowTs: s.blockTimestamp,
    });
    const amounts = [1n * 10n ** 18n, 100n * 10n ** 18n, 12345n * 10n ** 15n];
    for (const cao of amounts) {
      const [cstSharesIn, referenceAssetsIn, fee] = await client.readContract({
        address: ADDR.poolManager,
        abi: poolManagerAbi,
        functionName: "previewSwap",
        args: [POOL, cao],
        blockNumber: s.blockNumber,
      });
      const ts = previewSwap(cao, {
        swapRate,
        swapFeePercentage: s.swapFeePercentage,
        collateralDecimals: s.collateralDecimals,
        referenceDecimals: s.referenceDecimals,
      });
      expect(ts.cstSharesIn, `cstSharesIn @ ${cao}`).toBe(cstSharesIn);
      expect(ts.referenceAssetsIn, `referenceAssetsIn @ ${cao}`).toBe(referenceAssetsIn);
      expect(ts.fee, `fee @ ${cao}`).toBe(fee);
    }
  });

  it("previewUnwindSwap matches on-chain wei-for-wei (time-decay fee)", async () => {
    const swapRate = previewAdjustedRate({
      market: s.market,
      state: s.constraintState,
      oracleRate: s.oracleRate,
      nowTs: s.blockTimestamp,
    });
    const amounts = [1n * 10n ** 18n, 50n * 10n ** 18n];
    for (const cai of amounts) {
      const [cstSharesOut, referenceAssetsOut, fee] = await client.readContract({
        address: ADDR.poolManager,
        abi: poolManagerAbi,
        functionName: "previewUnwindSwap",
        args: [POOL, cai],
        blockNumber: s.blockNumber,
      });
      const ts = previewUnwindSwap(cai, {
        swapRate,
        unwindSwapFeePercentage: s.unwindSwapFeePercentage,
        collateralDecimals: s.collateralDecimals,
        referenceDecimals: s.referenceDecimals,
        issuedAt: s.issuedAt,
        expiryTimestamp: s.market.expiryTimestamp,
        nowTs: s.blockTimestamp,
      });
      expect(ts.cstSharesOut, `cstSharesOut @ ${cai}`).toBe(cstSharesOut);
      expect(ts.referenceAssetsOut, `referenceAssetsOut @ ${cai}`).toBe(referenceAssetsOut);
      expect(ts.fee, `fee @ ${cai}`).toBe(fee);
    }
  });

  it("previewExercise + previewExerciseOther match on-chain wei-for-wei", async () => {
    const swapRate = previewAdjustedRate({ market: s.market, state: s.constraintState, oracleRate: s.oracleRate, nowTs: s.blockTimestamp });
    const ctx = { swapRate, swapFeePercentage: s.swapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals };

    for (const cstIn of [1n * 10n ** 18n, 250n * 10n ** 18n]) {
      const [collateralAssetsOut, referenceAssetsIn, fee] = await client.readContract({ address: ADDR.poolManager, abi: poolManagerAbi, functionName: "previewExercise", args: [POOL, cstIn], blockNumber: s.blockNumber });
      const ts = previewExercise(cstIn, ctx);
      expect(ts.collateralAssetsOut, `exercise.cao @ ${cstIn}`).toBe(collateralAssetsOut);
      expect(ts.referenceAssetsIn, `exercise.refIn @ ${cstIn}`).toBe(referenceAssetsIn);
      expect(ts.fee, `exercise.fee @ ${cstIn}`).toBe(fee);
    }
    for (const refIn of [1n * 10n ** 6n, 500n * 10n ** 6n]) {
      const [collateralAssetsOut, cstSharesIn, fee] = await client.readContract({ address: ADDR.poolManager, abi: poolManagerAbi, functionName: "previewExerciseOther", args: [POOL, refIn], blockNumber: s.blockNumber });
      const ts = previewExerciseOther(refIn, ctx);
      expect(ts.collateralAssetsOut, `exerciseOther.cao @ ${refIn}`).toBe(collateralAssetsOut);
      expect(ts.cstSharesIn, `exerciseOther.cstIn @ ${refIn}`).toBe(cstSharesIn);
      expect(ts.fee, `exerciseOther.fee @ ${refIn}`).toBe(fee);
    }
  });

  it("previewUnwindExercise + previewUnwindExerciseOther match on-chain wei-for-wei", async () => {
    const swapRate = previewAdjustedRate({ market: s.market, state: s.constraintState, oracleRate: s.oracleRate, nowTs: s.blockTimestamp });
    const ctx = {
      swapRate,
      unwindSwapFeePercentage: s.unwindSwapFeePercentage,
      collateralDecimals: s.collateralDecimals,
      referenceDecimals: s.referenceDecimals,
      issuedAt: s.issuedAt,
      expiryTimestamp: s.market.expiryTimestamp,
      nowTs: s.blockTimestamp,
    };

    for (const cstOut of [1n * 10n ** 18n, 250n * 10n ** 18n]) {
      const [collateralAssetsIn, referenceAssetsOut, fee] = await client.readContract({ address: ADDR.poolManager, abi: poolManagerAbi, functionName: "previewUnwindExercise", args: [POOL, cstOut], blockNumber: s.blockNumber });
      const ts = previewUnwindExercise(cstOut, ctx);
      expect(ts.collateralAssetsIn, `unwindEx.caIn @ ${cstOut}`).toBe(collateralAssetsIn);
      expect(ts.referenceAssetsOut, `unwindEx.refOut @ ${cstOut}`).toBe(referenceAssetsOut);
      expect(ts.fee, `unwindEx.fee @ ${cstOut}`).toBe(fee);
    }
    for (const refOut of [1n * 10n ** 6n, 500n * 10n ** 6n]) {
      const [collateralAssetsIn, cstSharesOut, fee] = await client.readContract({ address: ADDR.poolManager, abi: poolManagerAbi, functionName: "previewUnwindExerciseOther", args: [POOL, refOut], blockNumber: s.blockNumber });
      const ts = previewUnwindExerciseOther(refOut, ctx);
      expect(ts.collateralAssetsIn, `unwindExOther.caIn @ ${refOut}`).toBe(collateralAssetsIn);
      expect(ts.cstSharesOut, `unwindExOther.cstOut @ ${refOut}`).toBe(cstSharesOut);
      expect(ts.fee, `unwindExOther.fee @ ${refOut}`).toBe(fee);
    }
  });

  it("runTool(cork_compute cst-swap-rate) matches on-chain previewSwap (full handler stack)", async () => {
    const cao = 100n * 10n ** 18n;
    const [cstSharesIn, referenceAssetsIn, fee] = await client.readContract({
      address: ADDR.poolManager,
      abi: poolManagerAbi,
      functionName: "previewSwap",
      args: [POOL, cao],
      blockNumber: s.blockNumber,
    });
    const env = await runTool(
      "cork_compute",
      { params: { kind: "cst-swap-rate", poolId: POOL, collateralAssetsOut: cao.toString() }, format: "concise" },
      { rpcUrl: RPC!, atBlock: s.blockNumber }, // pin the SAME block as the on-chain read — no race
    );
    expect(env.state).toBe("ok");
    expect(env.provenance.block).toBe(s.blockNumber.toString());
    const data = env.data as { cstSharesIn: string; referenceAssetsIn: string; fee: string };
    expect(data.cstSharesIn).toBe(cstSharesIn.toString());
    expect(data.referenceAssetsIn).toBe(referenceAssetsIn.toString());
    expect(data.fee).toBe(fee.toString());
  });
});
