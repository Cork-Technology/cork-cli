// Typed CorkAdapter action encoders + a Bundler3 leg builder.
import { encodeFunctionData } from "viem";
import { corkAdapterAbi, type CorkActionName } from "./corkAdapterAbi.ts";
import { call, type Call } from "./bundler3.ts";

// Param shapes (one per external action), field order = ICorkAdapter.sol struct order.
export interface SafeMintParams {
  poolId: `0x${string}`;
  cptAndCstSharesOut: bigint;
  receiver: `0x${string}`;
  maxCollateralAssetsIn: bigint;
  deadline: bigint;
}
export interface SafeDepositParams {
  poolId: `0x${string}`;
  collateralAssetsIn: bigint;
  receiver: `0x${string}`;
  minCptAndCstSharesOut: bigint;
  deadline: bigint;
}
export interface SafeUnwindDepositParams {
  poolId: `0x${string}`;
  collateralAssetsOut: bigint;
  owner: `0x${string}`;
  receiver: `0x${string}`;
  maxCptAndCstSharesIn: bigint;
  deadline: bigint;
}
export interface SafeUnwindMintParams {
  poolId: `0x${string}`;
  cptAndCstSharesIn: bigint;
  owner: `0x${string}`;
  receiver: `0x${string}`;
  minCollateralAssetsOut: bigint;
  deadline: bigint;
}
export interface SafeWithdrawParams {
  poolId: `0x${string}`;
  collateralAssetsOut: bigint;
  owner: `0x${string}`;
  receiver: `0x${string}`;
  maxCptSharesIn: bigint;
  deadline: bigint;
}
export interface SafeWithdrawOtherParams {
  poolId: `0x${string}`;
  referenceAssetsOut: bigint;
  owner: `0x${string}`;
  receiver: `0x${string}`;
  maxCptSharesIn: bigint;
  deadline: bigint;
}
export interface SafeRedeemParams {
  poolId: `0x${string}`;
  cptSharesIn: bigint;
  owner: `0x${string}`;
  receiver: `0x${string}`;
  minReferenceAssetsOut: bigint;
  minCollateralAssetsOut: bigint;
  deadline: bigint;
}
export interface SafeUnwindSwapParams {
  poolId: `0x${string}`;
  collateralAssetsIn: bigint;
  receiver: `0x${string}`;
  minReferenceAssetsOut: bigint;
  minCstSharesOut: bigint;
  deadline: bigint;
}
export interface SafeSwapParams {
  poolId: `0x${string}`;
  collateralAssetsOut: bigint;
  receiver: `0x${string}`;
  maxCstSharesIn: bigint;
  maxReferenceAssetsIn: bigint;
  deadline: bigint;
}
export interface SafeExerciseParams {
  poolId: `0x${string}`;
  cstSharesIn: bigint;
  receiver: `0x${string}`;
  minCollateralAssetsOut: bigint;
  maxReferenceAssetsIn: bigint;
  deadline: bigint;
}
export interface SafeExerciseOtherParams {
  poolId: `0x${string}`;
  referenceAssetsIn: bigint;
  receiver: `0x${string}`;
  minCollateralAssetsOut: bigint;
  maxCstSharesIn: bigint;
  deadline: bigint;
}
export interface SafeUnwindExerciseParams {
  poolId: `0x${string}`;
  cstSharesOut: bigint;
  receiver: `0x${string}`;
  minReferenceAssetsOut: bigint;
  maxCollateralAssetsIn: bigint;
  deadline: bigint;
}
export interface SafeUnwindExerciseOtherParams {
  poolId: `0x${string}`;
  referenceAssetsOut: bigint;
  receiver: `0x${string}`;
  minCstSharesOut: bigint;
  maxCollateralAssetsIn: bigint;
  deadline: bigint;
}

export interface CorkActionParamMap {
  safeMint: SafeMintParams;
  safeDeposit: SafeDepositParams;
  safeUnwindDeposit: SafeUnwindDepositParams;
  safeUnwindMint: SafeUnwindMintParams;
  safeWithdraw: SafeWithdrawParams;
  safeWithdrawOther: SafeWithdrawOtherParams;
  safeRedeem: SafeRedeemParams;
  safeUnwindSwap: SafeUnwindSwapParams;
  safeSwap: SafeSwapParams;
  safeExercise: SafeExerciseParams;
  safeExerciseOther: SafeExerciseOtherParams;
  safeUnwindExercise: SafeUnwindExerciseParams;
  safeUnwindExerciseOther: SafeUnwindExerciseOtherParams;
}

/** Encode CorkAdapter action calldata (selector + abi.encode(params)). */
export function encodeCorkAction<N extends CorkActionName>(name: N, params: CorkActionParamMap[N]): `0x${string}` {
  // abitype infers a per-overload union for (functionName, args) that cannot distribute over a
  // generic N — even `as EncodeFunctionDataParameters<typeof corkAdapterAbi, N>` is rejected in
  // both directions (verified against viem 2.55), so the call-site parameter type is erased.
  // The pairing is enforced where it can be: CorkActionParamMap keys are CorkActionName, and
  // fork-parity tests pin the encoded bytes against on-chain execution.
  return encodeFunctionData({ abi: corkAdapterAbi, functionName: name, args: [params] } as never);
}

/** Build one Bundler3 Call targeting the CorkAdapter with an encoded action. */
export function corkActionCall<N extends CorkActionName>(
  adapter: `0x${string}`,
  name: N,
  params: CorkActionParamMap[N],
  opts: { value?: bigint; skipRevert?: boolean } = {},
): Call {
  return call(adapter, encodeCorkAction(name, params), opts);
}
