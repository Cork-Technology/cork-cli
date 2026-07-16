// Read-only chain layer: assembles the full pool state needed to reproduce on-chain
// swapRate / preview* in pure TS. All reads are pinned to one blockNumber so a mutable
// oracle cannot race the parity comparison.
import type { PublicClient } from "viem";
import type { ConstraintState, Market } from "../types.ts";
import { constraintAdapterAbi, erc20Abi, poolManagerAbi, poolShareAbi, rateOracleAbi } from "./abis.ts";

export interface CorkAddresses {
  poolManager: `0x${string}`;
  constraintAdapter: `0x${string}`;
}

export interface PoolStateRead {
  poolId: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: bigint;
  market: Market;
  constraintState: ConstraintState;
  oracleRate: bigint;
  onChainSwapRate: bigint;
  swapFeePercentage: bigint;
  unwindSwapFeePercentage: bigint;
  collateralDecimals: number;
  referenceDecimals: number;
  cstToken: `0x${string}`;
  cptToken: `0x${string}`;
  issuedAt: bigint;
}

/** Reads every field required for math parity, all at a single pinned block. */
export async function readPoolState(
  client: PublicClient,
  addrs: CorkAddresses,
  poolId: `0x${string}`,
  atBlock?: bigint,
): Promise<PoolStateRead> {
  const blockNumber = atBlock ?? (await client.getBlockNumber());
  const block = await client.getBlock({ blockNumber });
  const pm = { address: addrs.poolManager, abi: poolManagerAbi } as const;

  const [marketTuple, constraintsTuple, onChainSwapRate, swapFeePercentage, unwindSwapFeePercentage, sharesTuple] =
    await Promise.all([
      client.readContract({ ...pm, functionName: "market", args: [poolId], blockNumber }),
      client.readContract({
        address: addrs.constraintAdapter,
        abi: constraintAdapterAbi,
        functionName: "constraints",
        args: [poolId],
        blockNumber,
      }),
      client.readContract({ ...pm, functionName: "swapRate", args: [poolId], blockNumber }),
      client.readContract({ ...pm, functionName: "swapFee", args: [poolId], blockNumber }),
      client.readContract({ ...pm, functionName: "unwindSwapFee", args: [poolId], blockNumber }),
      client.readContract({ ...pm, functionName: "shares", args: [poolId], blockNumber }),
    ]);

  const market: Market = {
    collateralAsset: marketTuple.collateralAsset,
    referenceAsset: marketTuple.referenceAsset,
    expiryTimestamp: marketTuple.expiryTimestamp,
    rateMin: marketTuple.rateMin,
    rateMax: marketTuple.rateMax,
    rateChangePerDayMax: marketTuple.rateChangePerDayMax,
    rateChangeCapacityMax: marketTuple.rateChangeCapacityMax,
    rateOracle: marketTuple.rateOracle,
  };
  const constraintState: ConstraintState = {
    lastAdjustedRate: constraintsTuple[0],
    lastAdjustmentTimestamp: constraintsTuple[1],
    remainingCredits: constraintsTuple[2],
  };
  const [cptToken, cstToken] = sharesTuple;

  const [oracleRate, collateralDecimals, referenceDecimals, issuedAt] = await Promise.all([
    client.readContract({ address: market.rateOracle, abi: rateOracleAbi, functionName: "rate", blockNumber }),
    client.readContract({ address: market.collateralAsset, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address: market.referenceAsset, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.readContract({ address: cstToken, abi: poolShareAbi, functionName: "issuedAt", blockNumber }),
  ]);

  return {
    poolId,
    blockNumber,
    blockTimestamp: block.timestamp,
    market,
    constraintState,
    oracleRate,
    onChainSwapRate,
    swapFeePercentage,
    unwindSwapFeePercentage,
    collateralDecimals,
    referenceDecimals,
    cstToken,
    cptToken,
    issuedAt,
  };
}
