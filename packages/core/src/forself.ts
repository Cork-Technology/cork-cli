// Cork ForSelf adapter surface — unsigned-artifact encoders for parameter-blind session-key
// wallets (the Zyfai integration shape). The adapters are EXAMPLE contracts Cork authors and
// the integrator audits/vets/deploys (example/contracts in this repo): every entrypoint
// structurally forces the destination to msg.sender, so a (contract, selector) whitelist that
// cannot see call parameters stays safe. This module builds calldata FOR those adapters — it
// deploys nothing, signs nothing, and treats the adapter address as caller-supplied
// integrator config, never a Cork deployment [K1].
//
// Byte-critical facts frozen here (verified against the compiled adapters, forge inspect
// methodIdentifiers — the unit suite pins every selector):
//  - each entrypoint takes ONE params struct; FIELD ORDER inside each struct is load-bearing;
//  - fillOrderForSelf embeds the 1inch v4 order as the underlying uint256 8-tuple;
//  - the wrapper sanitizes takerTraits itself (forces the target bit, zeroes interaction
//    bits, clears Permit2), so the traits passed here carry ONLY amount-mode bit 255 +
//    the low-185-bit taking cap (plus preserved bits 254/253 when a caller wants them);
//  - the wrapper pulls the taker asset from the CALLER, so allowances are granted to the
//    ADAPTER, not to the LOP / pool manager.
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import type { PhoenixAction } from "@cork/schemas";
import type { LopOrder } from "./orders.ts";

/** The two pinned-protocol views every ForSelf adapter exposes — the binding check that a
 *  caller-supplied adapter address really wraps the expected pool manager / LOP. */
export const forSelfBindingAbi = parseAbi([
  "function CORK() view returns (address)",
  "function LOP() view returns (address)",
]);

// One human-readable declaration per entrypoint, byte-identical to the Solidity structs.
export const forSelfAbi = parseAbi([
  // pool surface (13) — receiver/owner are structurally the caller and DO NOT appear
  "function depositForSelf((bytes32 poolId, uint256 collateralAssetsIn, uint256 minCptAndCstSharesOut, uint256 deadline) params) returns (uint256 cptAndCstSharesOut)",
  "function mintForSelf((bytes32 poolId, uint256 cptAndCstSharesOut, uint256 maxCollateralAssetsIn, uint256 deadline) params) returns (uint256 collateralAssetsIn)",
  "function unwindSwapForSelf((bytes32 poolId, uint256 collateralAssetsIn, uint256 minCstSharesOut, uint256 minReferenceAssetsOut, uint256 deadline) params) returns (uint256 cstSharesOut, uint256 referenceAssetsOut, uint256 fee)",
  "function unwindExerciseForSelf((bytes32 poolId, uint256 cstSharesOut, uint256 maxCollateralAssetsIn, uint256 minReferenceAssetsOut, uint256 deadline) params) returns (uint256 collateralAssetsIn, uint256 referenceAssetsOut, uint256 fee)",
  "function unwindExerciseOtherForSelf((bytes32 poolId, uint256 referenceAssetsOut, uint256 maxCollateralAssetsIn, uint256 minCstSharesOut, uint256 deadline) params) returns (uint256 collateralAssetsIn, uint256 cstSharesOut, uint256 fee)",
  "function swapForSelf((bytes32 poolId, uint256 collateralAssetsOut, uint256 maxCstSharesIn, uint256 maxReferenceAssetsIn, uint256 deadline) params) returns (uint256 cstSharesIn, uint256 referenceAssetsIn, uint256 fee)",
  "function exerciseForSelf((bytes32 poolId, uint256 cstSharesIn, uint256 maxReferenceAssetsIn, uint256 minCollateralAssetsOut, uint256 deadline) params) returns (uint256 collateralAssetsOut, uint256 referenceAssetsIn, uint256 fee)",
  "function exerciseOtherForSelf((bytes32 poolId, uint256 referenceAssetsIn, uint256 maxCstSharesIn, uint256 minCollateralAssetsOut, uint256 deadline) params) returns (uint256 collateralAssetsOut, uint256 cstSharesIn, uint256 fee)",
  "function unwindDepositForSelf((bytes32 poolId, uint256 collateralAssetsOut, uint256 maxCptAndCstSharesIn, uint256 deadline) params) returns (uint256 cptAndCstSharesIn)",
  "function unwindMintForSelf((bytes32 poolId, uint256 cptAndCstSharesIn, uint256 minCollateralAssetsOut, uint256 deadline) params) returns (uint256 collateralAssetsOut)",
  "function redeemForSelf((bytes32 poolId, uint256 cptSharesIn, uint256 minReferenceAssetsOut, uint256 minCollateralAssetsOut, uint256 deadline) params) returns (uint256 referenceAssetsOut, uint256 collateralAssetsOut)",
  "function withdrawForSelf((bytes32 poolId, uint256 collateralAssetsOut, uint256 maxCptSharesIn, uint256 deadline) params) returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut)",
  "function withdrawOtherForSelf((bytes32 poolId, uint256 referenceAssetsOut, uint256 maxCptSharesIn, uint256 deadline) params) returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut)",
  // LOP fill surface (1)
  "function fillOrderForSelf((bytes32 poolId, (uint256 salt, uint256 maker, uint256 receiver, uint256 makerAsset, uint256 takerAsset, uint256 makingAmount, uint256 takingAmount, uint256 makerTraits) order, bytes signature, uint256 amount, uint256 takerTraits, bytes extension, uint256 deadline) params) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)",
]);

export type ForSelfPoolActionType = Exclude<PhoenixAction["type"], "authority-onboard" | "authority-revoke">;

/** PhoenixAction.type → ForSelf entrypoint name (the pool surface's 13 twins). */
export const FORSELF_ACTION_MAP: Record<ForSelfPoolActionType, string> = {
  deposit: "depositForSelf",
  mint: "mintForSelf",
  "unwind-swap": "unwindSwapForSelf",
  "unwind-exercise": "unwindExerciseForSelf",
  "unwind-exercise-other": "unwindExerciseOtherForSelf",
  swap: "swapForSelf",
  exercise: "exerciseForSelf",
  "exercise-other": "exerciseOtherForSelf",
  "unwind-deposit": "unwindDepositForSelf",
  "unwind-mint": "unwindMintForSelf",
  redeem: "redeemForSelf",
  withdraw: "withdrawForSelf",
  "withdraw-other": "withdrawOtherForSelf",
};

/** What the account must have approved TO THE ADAPTER for each flow (the README allowance
 *  matrix, machine-readable). `exact` legs consume precisely the stated amount; `cap` legs
 *  pull the cap and the adapter refunds the unspent remainder in the same transaction.
 *  Group C share-burn flows never move the share through the adapter — the pool manager
 *  burns straight from the caller against the allowance granted to the adapter. */
export interface ForSelfAllowance {
  tokenRole: "collateral" | "reference" | "cST" | "cPT" | "order takerAsset";
  amountField: string;
  kind: "exact" | "cap";
  note?: string;
}
const BURN_NOTE = "burned straight from the caller by the pool manager against this allowance (never held by the adapter)";
export const FORSELF_ALLOWANCES: Record<ForSelfPoolActionType, ForSelfAllowance[]> = {
  deposit: [{ tokenRole: "collateral", amountField: "collateralAssetsIn", kind: "exact" }],
  mint: [{ tokenRole: "collateral", amountField: "maxCollateralAssetsIn", kind: "cap" }],
  "unwind-swap": [{ tokenRole: "collateral", amountField: "collateralAssetsIn", kind: "exact" }],
  "unwind-exercise": [{ tokenRole: "collateral", amountField: "maxCollateralAssetsIn", kind: "cap" }],
  "unwind-exercise-other": [{ tokenRole: "collateral", amountField: "maxCollateralAssetsIn", kind: "cap" }],
  swap: [
    { tokenRole: "cST", amountField: "maxCstSharesIn", kind: "cap" },
    { tokenRole: "reference", amountField: "maxReferenceAssetsIn", kind: "cap" },
  ],
  exercise: [
    { tokenRole: "cST", amountField: "cstSharesIn", kind: "exact" },
    { tokenRole: "reference", amountField: "maxReferenceAssetsIn", kind: "cap" },
  ],
  "exercise-other": [
    { tokenRole: "cST", amountField: "maxCstSharesIn", kind: "cap" },
    { tokenRole: "reference", amountField: "referenceAssetsIn", kind: "exact" },
  ],
  "unwind-deposit": [
    { tokenRole: "cPT", amountField: "maxCptAndCstSharesIn", kind: "cap", note: BURN_NOTE },
    { tokenRole: "cST", amountField: "maxCptAndCstSharesIn", kind: "cap", note: BURN_NOTE },
  ],
  "unwind-mint": [
    { tokenRole: "cPT", amountField: "cptAndCstSharesIn", kind: "exact", note: BURN_NOTE },
    { tokenRole: "cST", amountField: "cptAndCstSharesIn", kind: "exact", note: BURN_NOTE },
  ],
  redeem: [{ tokenRole: "cPT", amountField: "cptSharesIn", kind: "exact", note: BURN_NOTE }],
  withdraw: [{ tokenRole: "cPT", amountField: "maxCptSharesIn", kind: "cap", note: BURN_NOTE }],
  "withdraw-other": [{ tokenRole: "cPT", amountField: "maxCptSharesIn", kind: "cap", note: BURN_NOTE }],
};

export interface ForSelfCallResult {
  functionName: string;
  selector: `0x${string}`;
  calldata: `0x${string}`;
  allowances: ForSelfAllowance[];
}

/** Encode one pool-surface ForSelf call from its PhoenixAction. Field order inside each
 *  params tuple mirrors the Solidity struct exactly — the ABI declarations above are the
 *  single source of that order, so an encode and a decode can never disagree. */
export function buildPoolForSelfCall(action: PhoenixAction, deadline: bigint): ForSelfCallResult {
  const b = (v: string) => BigInt(v);
  const p = action;
  let functionName: string;
  let args: readonly unknown[];
  switch (p.type) {
    case "deposit":
      functionName = "depositForSelf";
      args = [{ poolId: p.poolId, collateralAssetsIn: b(p.collateralAssetsIn), minCptAndCstSharesOut: b(p.minCptAndCstSharesOut), deadline }];
      break;
    case "mint":
      functionName = "mintForSelf";
      args = [{ poolId: p.poolId, cptAndCstSharesOut: b(p.cptAndCstSharesOut), maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), deadline }];
      break;
    case "unwind-swap":
      functionName = "unwindSwapForSelf";
      args = [{ poolId: p.poolId, collateralAssetsIn: b(p.collateralAssetsIn), minCstSharesOut: b(p.minCstSharesOut), minReferenceAssetsOut: b(p.minReferenceAssetsOut), deadline }];
      break;
    case "unwind-exercise":
      functionName = "unwindExerciseForSelf";
      args = [{ poolId: p.poolId, cstSharesOut: b(p.cstSharesOut), maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), minReferenceAssetsOut: b(p.minReferenceAssetsOut), deadline }];
      break;
    case "unwind-exercise-other":
      functionName = "unwindExerciseOtherForSelf";
      args = [{ poolId: p.poolId, referenceAssetsOut: b(p.referenceAssetsOut), maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), minCstSharesOut: b(p.minCstSharesOut), deadline }];
      break;
    case "swap":
      functionName = "swapForSelf";
      args = [{ poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), maxCstSharesIn: b(p.maxCstSharesIn), maxReferenceAssetsIn: b(p.maxReferenceAssetsIn), deadline }];
      break;
    case "exercise":
      functionName = "exerciseForSelf";
      args = [{ poolId: p.poolId, cstSharesIn: b(p.cstSharesIn), maxReferenceAssetsIn: b(p.maxReferenceAssetsIn), minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline }];
      break;
    case "exercise-other":
      functionName = "exerciseOtherForSelf";
      args = [{ poolId: p.poolId, referenceAssetsIn: b(p.referenceAssetsIn), maxCstSharesIn: b(p.maxCstSharesIn), minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline }];
      break;
    case "unwind-deposit":
      functionName = "unwindDepositForSelf";
      args = [{ poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), maxCptAndCstSharesIn: b(p.maxCptAndCstSharesIn), deadline }];
      break;
    case "unwind-mint":
      functionName = "unwindMintForSelf";
      args = [{ poolId: p.poolId, cptAndCstSharesIn: b(p.cptAndCstSharesIn), minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline }];
      break;
    case "redeem":
      functionName = "redeemForSelf";
      args = [{ poolId: p.poolId, cptSharesIn: b(p.cptSharesIn), minReferenceAssetsOut: b(p.minReferenceAssetsOut), minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline }];
      break;
    case "withdraw":
      functionName = "withdrawForSelf";
      args = [{ poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), maxCptSharesIn: b(p.maxCptSharesIn), deadline }];
      break;
    case "withdraw-other":
      functionName = "withdrawOtherForSelf";
      args = [{ poolId: p.poolId, referenceAssetsOut: b(p.referenceAssetsOut), maxCptSharesIn: b(p.maxCptSharesIn), deadline }];
      break;
    default:
      throw new Error(`no ForSelf twin for phoenix action type: ${(p as { type: string }).type}`);
  }
  const calldata = encodeFunctionData({ abi: forSelfAbi, functionName: functionName as never, args: args as never });
  return { functionName, selector: forSelfSelector(functionName), calldata, allowances: FORSELF_ALLOWANCES[p.type as ForSelfPoolActionType] };
}

// TakerTraits bits the WRAPPER preserves from its caller (everything else it rewrites).
const FORSELF_MAKER_AMOUNT_FLAG = 1n << 255n; // `amount` denominated in the maker asset
const FORSELF_THRESHOLD_MAX = (1n << 184n) - 1n; // wrapper preserves bits 0-183 as the cap

export interface FillOrderForSelfArgs {
  /** The Cork market this fill must belong to (the wrapper reverts otherwise). */
  poolId: `0x${string}`;
  order: LopOrder;
  /** EOA: 64-byte r||vs or 65-byte r||s||v, passed VERBATIM (the wrapper splits it);
   *  ERC-1271 contract maker: opaque signature bytes (the wrapper routes by code size). */
  signature: `0x${string}`;
  /** Making amount to receive (the wrapper is always driven in maker-amount mode, so the
   *  cap can bound the worst-case pull). */
  fillMakingAmount: bigint;
  /** Hard cap on the taking amount paid — pulled from the caller up front, unspent
   *  remainder swept back. Must be positive (the wrapper enforces ThresholdRequired). */
  maximumTakingAmount: bigint;
  /** The maker-signed extension, verbatim ("0x" for plain orders). */
  extension: `0x${string}`;
  deadline: bigint;
}

/** Encode fillOrderForSelf calldata. The wrapper re-derives every dangerous takerTraits
 *  bit itself (target forced to the caller, interaction bits zeroed, Permit2 cleared,
 *  extension length rewritten) — what we pass is only the amount mode + the pull cap. */
export function buildFillOrderForSelfCall(a: FillOrderForSelfArgs): ForSelfCallResult {
  if (a.maximumTakingAmount <= 0n) {
    throw new Error("buildFillOrderForSelfCall: maximumTakingAmount must be positive — it is the wrapper's pull cap (ThresholdRequired)");
  }
  if (a.maximumTakingAmount > FORSELF_THRESHOLD_MAX) {
    throw new Error("buildFillOrderForSelfCall: maximumTakingAmount exceeds the 184-bit threshold field the wrapper preserves");
  }
  const takerTraits = FORSELF_MAKER_AMOUNT_FLAG | a.maximumTakingAmount;
  const calldata = encodeFunctionData({
    abi: forSelfAbi,
    functionName: "fillOrderForSelf",
    args: [
      {
        poolId: a.poolId,
        order: {
          salt: a.order.salt,
          maker: BigInt(a.order.maker),
          receiver: BigInt(a.order.receiver),
          makerAsset: BigInt(a.order.makerAsset),
          takerAsset: BigInt(a.order.takerAsset),
          makingAmount: a.order.makingAmount,
          takingAmount: a.order.takingAmount,
          makerTraits: a.order.makerTraits,
        },
        signature: a.signature,
        amount: a.fillMakingAmount,
        takerTraits,
        extension: a.extension,
        deadline: a.deadline,
      },
    ],
  });
  return {
    functionName: "fillOrderForSelf",
    selector: forSelfSelector("fillOrderForSelf"),
    calldata,
    allowances: [{ tokenRole: "order takerAsset", amountField: "maximumTakingAmount", kind: "cap" }],
  };
}

/** Selector of a ForSelf entrypoint, derived from the pinned ABI declarations. */
export function forSelfSelector(functionName: string): `0x${string}` {
  const item = forSelfAbi.find((f) => f.type === "function" && f.name === functionName);
  if (!item) throw new Error(`unknown ForSelf entrypoint: ${functionName}`);
  return toFunctionSelector(item);
}

/** name → selector for every entrypoint (decode labeling + registry-whitelisting docs). */
export function forSelfSelectors(): Record<string, `0x${string}`> {
  const out: Record<string, `0x${string}`> = {};
  for (const item of forSelfAbi) {
    if (item.type === "function") out[item.name] = toFunctionSelector(item);
  }
  return out;
}
