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

  it("cork_query market/account-state/pool-whitelist read the live pool", async () => {
    const DEV = "0xc0ffee0000000000000000000000000000000001";
    const mkt = await runTool("cork_query", { resource: "market", pageSize: 25, format: "concise", filters: { poolId: POOL } }, { rpcUrl: RPC!, atBlock: s.blockNumber });
    expect(mkt.state).toBe("ok");
    expect((mkt.data as { swapRate: string }).swapRate).toBe(s.onChainSwapRate.toString());
    expect((mkt.data as { market: { collateralAsset: string } }).market.collateralAsset.toLowerCase()).toBe(s.market.collateralAsset.toLowerCase());

    const acct = await runTool("cork_query", { resource: "account-state", pageSize: 25, format: "concise", filters: { poolId: POOL, account: DEV } }, { rpcUrl: RPC!, atBlock: s.blockNumber });
    expect(acct.state).toBe("ok");
    const bals = (acct.data as { balances: { cst: string; cpt: string } }).balances;
    expect(BigInt(bals.cst) >= 0n && BigInt(bals.cpt) >= 0n).toBe(true); // DEV holds shares from setup

    const wl = await runTool("cork_query", { resource: "pool-whitelist", pageSize: 25, format: "concise", filters: { poolId: POOL, account: DEV } }, { rpcUrl: RPC!, atBlock: s.blockNumber });
    expect(wl.state).toBe("ok");
    expect(typeof (wl.data as { isWhitelisted: boolean }).isWhitelisted).toBe("boolean");
  });

  it("LOP maker-order hash equals on-chain LOP.hashOrder (EIP-712 parity)", async () => {
    const built = await runTool(
      "cork_prepare_orders",
      {
        chainId: 1,
        account: "0x00000000000000000000000000000000000000ab",
        clientRequestId: "lop-parity-0001",
        action: { type: "maker-order", poolId: POOL, side: "SELL", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000", expirySeconds: 3600 },
        format: "concise",
      },
      { rpcUrl: RPC!, nowSeconds: 4_000_000_000n },
    );
    expect(built.state).toBe("ok");
    const d = built.data as { lop: `0x${string}`; orderHash: `0x${string}`; typedData: { message: Record<string, string> } };
    const o = d.typedData.message;
    // hashOrder's canonical signature uses all-uint256 fields (LOP Address/MakerTraits are uint256).
    const hashOrderAbi = [
      {
        type: "function",
        name: "hashOrder",
        stateMutability: "view",
        inputs: [{
          name: "order",
          type: "tuple",
          components: [
            { name: "salt", type: "uint256" },
            { name: "maker", type: "uint256" },
            { name: "receiver", type: "uint256" },
            { name: "makerAsset", type: "uint256" },
            { name: "takerAsset", type: "uint256" },
            { name: "makingAmount", type: "uint256" },
            { name: "takingAmount", type: "uint256" },
            { name: "makerTraits", type: "uint256" },
          ],
        }],
        outputs: [{ type: "bytes32" }],
      },
    ] as const;
    const onChain = await client.readContract({
      address: d.lop,
      abi: hashOrderAbi,
      functionName: "hashOrder",
      args: [{
        salt: BigInt(o.salt!),
        maker: BigInt(o.maker!),
        receiver: BigInt(o.receiver!),
        makerAsset: BigInt(o.makerAsset!),
        takerAsset: BigInt(o.takerAsset!),
        makingAmount: BigInt(o.makingAmount!),
        takingAmount: BigInt(o.takingAmount!),
        makerTraits: BigInt(o.makerTraits!),
      }],
      blockNumber: s.blockNumber,
    });
    expect(d.orderHash).toBe(onChain);
  });

  it("cork_track marketRef verifies the pool against chain (MarketId re-hash)", async () => {
    const env = await runTool("cork_track", { mode: "verify", subject: { kind: "marketRef", poolId: POOL }, format: "concise" }, { rpcUrl: RPC!, atBlock: s.blockNumber });
    expect(env.state).toBe("ok");
    const d = env.data as { verified: boolean; marketIdRecomputed: string };
    expect(d.verified).toBe(true);
    expect(d.marketIdRecomputed.toLowerCase()).toBe(POOL);
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
