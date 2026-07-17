// Typed param table for all 13 CorkAdapter actions. Every field within an action gets a DISTINCT
// value so a field transposition changes the calldata (and is caught by byte-parity). This one
// table drives both the golden generator (scripts/gen-action-golden.ts -> cast) and the parity
// test (encodeCorkAction), so params and expected bytes can never drift out of sync.
import type { CorkActionName, CorkActionParamMap } from "@cork/core";

const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const RCV = "0xc0ffee0000000000000000000000000000000001" as const;
const OWN = "0xc0ffee0000000000000000000000000000000002" as const;
const DL = 1893456000n;

export type ActionVector = { [N in CorkActionName]: { name: N; params: CorkActionParamMap[N] } }[CorkActionName];

export const ACTION_VECTORS: ActionVector[] = [
  { name: "safeMint", params: { poolId: POOL, cptAndCstSharesOut: 111000000000000000000n, receiver: RCV, maxCollateralAssetsIn: 112000000000000000000n, deadline: DL } },
  { name: "safeDeposit", params: { poolId: POOL, collateralAssetsIn: 221000000n, receiver: RCV, minCptAndCstSharesOut: 222000000000000000000n, deadline: DL } },
  { name: "safeUnwindDeposit", params: { poolId: POOL, collateralAssetsOut: 331000000000000000000n, owner: OWN, receiver: RCV, maxCptAndCstSharesIn: 332000000000000000000n, deadline: DL } },
  { name: "safeUnwindMint", params: { poolId: POOL, cptAndCstSharesIn: 441000000000000000000n, owner: OWN, receiver: RCV, minCollateralAssetsOut: 442000000000000000000n, deadline: DL } },
  { name: "safeWithdraw", params: { poolId: POOL, collateralAssetsOut: 551000000000000000000n, owner: OWN, receiver: RCV, maxCptSharesIn: 552000000000000000000n, deadline: DL } },
  { name: "safeWithdrawOther", params: { poolId: POOL, referenceAssetsOut: 661000000n, owner: OWN, receiver: RCV, maxCptSharesIn: 662000000000000000000n, deadline: DL } },
  { name: "safeRedeem", params: { poolId: POOL, cptSharesIn: 771000000000000000000n, owner: OWN, receiver: RCV, minReferenceAssetsOut: 772000000n, minCollateralAssetsOut: 773000000000000000000n, deadline: DL } },
  { name: "safeUnwindSwap", params: { poolId: POOL, collateralAssetsIn: 881000000000000000000n, receiver: RCV, minReferenceAssetsOut: 882000000n, minCstSharesOut: 883000000000000000000n, deadline: DL } },
  { name: "safeSwap", params: { poolId: POOL, collateralAssetsOut: 991000000000000000000n, receiver: RCV, maxCstSharesIn: 992000000000000000000n, maxReferenceAssetsIn: 993000000n, deadline: DL } },
  { name: "safeExercise", params: { poolId: POOL, cstSharesIn: 1011000000000000000000n, receiver: RCV, minCollateralAssetsOut: 1012000000000000000000n, maxReferenceAssetsIn: 1013000000n, deadline: DL } },
  { name: "safeExerciseOther", params: { poolId: POOL, referenceAssetsIn: 1121000000n, receiver: RCV, minCollateralAssetsOut: 1122000000000000000000n, maxCstSharesIn: 1123000000000000000000n, deadline: DL } },
  { name: "safeUnwindExercise", params: { poolId: POOL, cstSharesOut: 1231000000000000000000n, receiver: RCV, minReferenceAssetsOut: 1232000000n, maxCollateralAssetsIn: 1233000000000000000000n, deadline: DL } },
  { name: "safeUnwindExerciseOther", params: { poolId: POOL, referenceAssetsOut: 1341000000n, receiver: RCV, minCstSharesOut: 1342000000000000000000n, maxCollateralAssetsIn: 1343000000000000000000n, deadline: DL } },
];

/** Serialize a param value for `cast` (bigint -> decimal string; address/bytes32 as-is). */
export function castValue(v: unknown): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}
