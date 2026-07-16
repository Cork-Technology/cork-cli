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
  previewSwap,
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
      { rpcUrl: RPC! },
    );
    expect(env.state).toBe("ok");
    const data = env.data as { cstSharesIn: string; referenceAssetsIn: string; fee: string };
    // Handler reads at head (a few blocks ahead of s.blockNumber); swapRate is stable on the
    // fixture (no oracle churn), so preview must still match the pinned on-chain read.
    expect(data.cstSharesIn).toBe(cstSharesIn.toString());
    expect(data.referenceAssetsIn).toBe(referenceAssetsIn.toString());
    expect(data.fee).toBe(fee.toString());
  });
});
