// CorkAdapter action ABI — the 13 external onlyBundler3 actions, param structs verbatim from
// ICorkAdapter.sol:39-183 (MarketId is bytes32). Used to encode/decode Bundler3 legs.
import { parseAbi } from "viem";

export const corkAdapterAbi = parseAbi([
  "function safeMint((bytes32 poolId, uint256 cptAndCstSharesOut, address receiver, uint256 maxCollateralAssetsIn, uint256 deadline) params)",
  "function safeDeposit((bytes32 poolId, uint256 collateralAssetsIn, address receiver, uint256 minCptAndCstSharesOut, uint256 deadline) params)",
  "function safeUnwindDeposit((bytes32 poolId, uint256 collateralAssetsOut, address owner, address receiver, uint256 maxCptAndCstSharesIn, uint256 deadline) params)",
  "function safeUnwindMint((bytes32 poolId, uint256 cptAndCstSharesIn, address owner, address receiver, uint256 minCollateralAssetsOut, uint256 deadline) params)",
  "function safeWithdraw((bytes32 poolId, uint256 collateralAssetsOut, address owner, address receiver, uint256 maxCptSharesIn, uint256 deadline) params)",
  "function safeWithdrawOther((bytes32 poolId, uint256 referenceAssetsOut, address owner, address receiver, uint256 maxCptSharesIn, uint256 deadline) params)",
  "function safeRedeem((bytes32 poolId, uint256 cptSharesIn, address owner, address receiver, uint256 minReferenceAssetsOut, uint256 minCollateralAssetsOut, uint256 deadline) params)",
  "function safeUnwindSwap((bytes32 poolId, uint256 collateralAssetsIn, address receiver, uint256 minReferenceAssetsOut, uint256 minCstSharesOut, uint256 deadline) params)",
  "function safeSwap((bytes32 poolId, uint256 collateralAssetsOut, address receiver, uint256 maxCstSharesIn, uint256 maxReferenceAssetsIn, uint256 deadline) params)",
  "function safeExercise((bytes32 poolId, uint256 cstSharesIn, address receiver, uint256 minCollateralAssetsOut, uint256 maxReferenceAssetsIn, uint256 deadline) params)",
  "function safeExerciseOther((bytes32 poolId, uint256 referenceAssetsIn, address receiver, uint256 minCollateralAssetsOut, uint256 maxCstSharesIn, uint256 deadline) params)",
  "function safeUnwindExercise((bytes32 poolId, uint256 cstSharesOut, address receiver, uint256 minReferenceAssetsOut, uint256 maxCollateralAssetsIn, uint256 deadline) params)",
  "function safeUnwindExerciseOther((bytes32 poolId, uint256 referenceAssetsOut, address receiver, uint256 minCstSharesOut, uint256 maxCollateralAssetsIn, uint256 deadline) params)",
]);

export const CORK_ACTION_NAMES = [
  "safeMint",
  "safeDeposit",
  "safeUnwindDeposit",
  "safeUnwindMint",
  "safeWithdraw",
  "safeWithdrawOther",
  "safeRedeem",
  "safeUnwindSwap",
  "safeSwap",
  "safeExercise",
  "safeExerciseOther",
  "safeUnwindExercise",
  "safeUnwindExerciseOther",
] as const;

export type CorkActionName = (typeof CORK_ACTION_NAMES)[number];
