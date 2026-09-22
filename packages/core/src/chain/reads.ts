// Read-only chain layer: assembles the full pool state needed to reproduce on-chain
// swapRate / preview* in pure TS. All reads are pinned to one blockNumber so a mutable
// oracle cannot race the parity comparison.
//
// Generation-aware since 0.6 (2026-09-22): every read takes the POOL MANAGER together with its
// declared wire (`8-field` | `10-field`), because the `market()` return widened by two words on
// phoenix v1.4.0-rc.1 and viem decodes the wider return through the narrower ABI SILENTLY. The
// 8-field path is byte-identical to 0.5.x; the 10-field path decodes the widened tuple, takes the
// fees FROM the tuple (they are part of the pool's identity there) and ALSO reads the two fee
// views the manager still exposes — a disagreement between the tuple and the views is a chain
// fact the caller must see (`feeDisagreements`), never something either side resolves silently.
import type { PublicClient } from "viem";
import type { GenerationRef, PhoenixWire } from "../generations.ts";
import type { ConstraintState, Market, Market10, Market8 } from "../types.ts";
import { constraintAdapterAbi, erc20Abi, marketAbiFor, poolManagerAbi, poolShareAbi, rateOracleAbi } from "./abis.ts";

/** A pool manager and the wire it speaks — the minimum every pool read needs. `CorkDeployment`
 *  (config.ts) satisfies it, and so does a generation's phoenix block. */
export interface PoolManagerRef {
  poolManager: `0x${string}`;
  wire: PhoenixWire;
}

export interface CorkAddresses extends PoolManagerRef {
  constraintAdapter: `0x${string}`;
  /** The generation the addresses came from, echoed on the read so a result can carry it. */
  generation?: GenerationRef;
}

/** The pool's share tokens as an EARLIER read in the same call returned them — the generation
 *  resolver's `shares(poolId)` (generations.ts). Passed through so the state read does not ask
 *  the same manager the same question twice (review C1, 2026-09-22). Safe across blocks: a pool's
 *  share contracts are set at creation and never change, so a value read at "latest" by the
 *  resolver is the value at any pinned block at or after creation. */
export interface KnownShares {
  corkPrincipalToken: `0x${string}`;
  corkSwapToken: `0x${string}`;
}

/** One tuple-vs-view fee disagreement on a 10-field manager (both 1e18 = 1%). */
export interface FeeDisagreement {
  field: "swapFeePercentage" | "unwindSwapFeePercentage";
  tuple: bigint;
  view: bigint;
}

export interface PoolStateRead {
  poolId: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: bigint;
  /** Market8 on an 8-field manager, Market10 (fees inside) on a 10-field one — `wire` says which,
   *  and `computeMarketId(market, wire)` is the only correct re-hash. */
  market: Market;
  wire: PhoenixWire;
  generation?: GenerationRef;
  constraintState: ConstraintState;
  oracleRate: bigint;
  onChainSwapRate: bigint;
  /** On 10-field: the TUPLE's values (identity); the views are compared, see feeDisagreements. */
  swapFeePercentage: bigint;
  unwindSwapFeePercentage: bigint;
  /** 10-field only: every fee whose `swapFee`/`unwindSwapFee` view disagrees with the tuple.
   *  Empty on agreement; absent on an 8-field manager (there the views ARE the fees). */
  feeDisagreements?: FeeDisagreement[];
  collateralDecimals: number;
  referenceDecimals: number;
  cstToken: `0x${string}`;
  cptToken: `0x${string}`;
  issuedAt: bigint;
}

export interface PoolTokensRead {
  collateral: `0x${string}`;
  reference: `0x${string}`;
  cst: `0x${string}`;
  cpt: `0x${string}`;
  expiryTimestamp: bigint;
}

/** Read `market(poolId)` through the ABI of the manager's declared wire — `marketAbiFor` is the
 *  ONE place that choice is made (this function branched on the wire itself until 2026-09-22,
 *  review B5). The 8-field decode is the 0.5.x one; the 10-field decode carries the two fee words
 *  a narrower ABI would drop. viem types the return by the ABI, so the Market8/Market10 shape
 *  follows the wire without a widening cast. */
async function readMarketTuple(client: PublicClient, pm: PoolManagerRef, poolId: `0x${string}`, blockArg: { blockNumber?: bigint }): Promise<Market> {
  const t = await client.readContract({ address: pm.poolManager, abi: marketAbiFor(pm.wire), functionName: "market", args: [poolId], ...blockArg });
  const eight: Market8 = {
    collateralAsset: t.collateralAsset,
    referenceAsset: t.referenceAsset,
    expiryTimestamp: t.expiryTimestamp,
    rateMin: t.rateMin,
    rateMax: t.rateMax,
    rateChangePerDayMax: t.rateChangePerDayMax,
    rateChangeCapacityMax: t.rateChangeCapacityMax,
    rateOracle: t.rateOracle,
  };
  if (pm.wire === "10-field") {
    const wide = t as typeof t & { swapFeePercentage: bigint; unwindSwapFeePercentage: bigint };
    const m: Market10 = { ...eight, swapFeePercentage: wide.swapFeePercentage, unwindSwapFeePercentage: wide.unwindSwapFeePercentage };
    return m;
  }
  return eight;
}

/** Light read of the four token addresses for a pool (market + shares), for funding-leg building. */
export async function resolvePoolTokens(
  client: PublicClient,
  pm: PoolManagerRef,
  poolId: `0x${string}`,
  atBlock?: bigint,
  knownShares?: KnownShares,
): Promise<PoolTokensRead> {
  const blockArg = atBlock !== undefined ? { blockNumber: atBlock } : {};
  const [market, shares] = await Promise.all([
    readMarketTuple(client, pm, poolId, blockArg),
    knownShares !== undefined
      ? ([knownShares.corkPrincipalToken, knownShares.corkSwapToken] as const)
      : client.readContract({ address: pm.poolManager, abi: poolManagerAbi, functionName: "shares", args: [poolId], ...blockArg }),
  ]);
  return { collateral: market.collateralAsset, reference: market.referenceAsset, cpt: shares[0], cst: shares[1], expiryTimestamp: market.expiryTimestamp };
}

/** Reads every field required for math parity, all at a single pinned block. */
export async function readPoolState(
  client: PublicClient,
  addrs: CorkAddresses,
  poolId: `0x${string}`,
  atBlock?: bigint,
  knownShares?: KnownShares,
): Promise<PoolStateRead> {
  const blockNumber = atBlock ?? (await client.getBlockNumber());
  const block = await client.getBlock({ blockNumber });
  const pm = { address: addrs.poolManager, abi: poolManagerAbi } as const;

  const [market, constraintsTuple, onChainSwapRate, swapFeeView, unwindSwapFeeView, sharesTuple] =
    await Promise.all([
      readMarketTuple(client, addrs, poolId, { blockNumber }),
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
      knownShares !== undefined ? ([knownShares.corkPrincipalToken, knownShares.corkSwapToken] as const) : client.readContract({ ...pm, functionName: "shares", args: [poolId], blockNumber }),
    ]);

  // 8-field: the views are the fees (the struct has none). 10-field: the TUPLE is the identity
  // the id was hashed over, so it is what the result carries; the views are read as a chain-truth
  // check and every disagreement is recorded — the caller surfaces it, this layer never picks.
  let swapFeePercentage = swapFeeView;
  let unwindSwapFeePercentage = unwindSwapFeeView;
  let feeDisagreements: FeeDisagreement[] | undefined;
  if (addrs.wire === "10-field") {
    const m = market as Market10;
    swapFeePercentage = m.swapFeePercentage;
    unwindSwapFeePercentage = m.unwindSwapFeePercentage;
    feeDisagreements = [];
    if (m.swapFeePercentage !== swapFeeView) feeDisagreements.push({ field: "swapFeePercentage", tuple: m.swapFeePercentage, view: swapFeeView });
    if (m.unwindSwapFeePercentage !== unwindSwapFeeView) feeDisagreements.push({ field: "unwindSwapFeePercentage", tuple: m.unwindSwapFeePercentage, view: unwindSwapFeeView });
  }
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
    wire: addrs.wire,
    ...(addrs.generation ? { generation: addrs.generation } : {}),
    constraintState,
    oracleRate,
    onChainSwapRate,
    swapFeePercentage,
    unwindSwapFeePercentage,
    ...(feeDisagreements !== undefined ? { feeDisagreements } : {}),
    collateralDecimals,
    referenceDecimals,
    cstToken,
    cptToken,
    issuedAt,
  };
}

/** The `fee_view_mismatch` warning a 10-field fee disagreement surfaces as — ONE spelling for
 *  every handler that reads pool state (cork-pool, the three compute kinds, track marketRef). Its
 *  own code since 2026-09-22 (review B7): a tuple ≠ views split on the pool's IDENTITY is a chain
 *  fact a reader must be able to branch on, not the local-computation class `invalid_state` names. */
export function feeDisagreementWarnings(s: Pick<PoolStateRead, "feeDisagreements" | "poolId">): Array<{ code: string; message: string }> {
  if (!s.feeDisagreements || s.feeDisagreements.length === 0) return [];
  return [
    {
      code: "fee_view_mismatch",
      message: `the pool manager's market(${s.poolId}) tuple and its fee views DISAGREE on a 10-field manager — ${s.feeDisagreements.map((d) => `${d.field}: tuple ${d.tuple.toString()} vs ${d.field === "swapFeePercentage" ? "swapFee" : "unwindSwapFee"}() ${d.view.toString()}`).join("; ")} (both 1e18 = 1%). The tuple is the pool's identity (the id was hashed over it) and is what this result carries; the view is what the swap math charges. Treat the pool as suspect until the chain explains the split`,
    },
  ];
}
