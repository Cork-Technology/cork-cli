// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

/// @dev Vendored minimal subset of Cork Phoenix `IPoolManager` / `CorkPoolManager`.
///      Source of truth: phoenix `contracts/interfaces/IPoolManager.sol` and
///      `contracts/core/CorkPoolManager.sol` (signatures verified verbatim against the
///      build deployed on Arbitrum One). Only the members the ForSelf adapters need are
///      reproduced here; field ORDER of `Market` matters (ABI decode of `market()`).

/// @notice The market id of a pool: keccak256(abi.encode(Market)).
type MarketId is bytes32;

/// @notice Full pool parameters, in the exact on-chain field order.
struct Market {
    address collateralAsset;
    address referenceAsset;
    uint256 expiryTimestamp;
    uint256 rateMin;
    uint256 rateMax;
    uint256 rateChangePerDayMax;
    uint256 rateChangeCapacityMax;
    address rateOracle;
}

/// @title ICorkPoolManagerMinimal
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice The 13 receiver-bearing mutating entrypoints of CorkPoolManager plus the two
///         getters the adapters use to resolve token addresses on-chain.
interface ICorkPoolManagerMinimal {
    ///====== VIEWS ======///
    function market(MarketId poolId) external view returns (Market memory parameters);

    function shares(MarketId poolId) external view returns (address principalToken, address swapToken);

    ///====== ENTER (collateral in, shares out) ======///

    function deposit(MarketId poolId, uint256 collateralAssetsIn, address receiver)
        external
        returns (uint256 cptAndCstSharesOut);

    function mint(MarketId poolId, uint256 cptAndCstSharesOut, address receiver)
        external
        returns (uint256 collateralAssetsIn);

    ///====== EXIT PRE-EXPIRY (shares burned from `owner`, collateral out) ======///

    function unwindDeposit(MarketId poolId, uint256 collateralAssetsOut, address owner, address receiver)
        external
        returns (uint256 cptAndCstSharesIn);

    function unwindMint(MarketId poolId, uint256 cptAndCstSharesIn, address owner, address receiver)
        external
        returns (uint256 collateralAssetsOut);

    ///====== SETTLE POST-EXPIRY (cPT burned from `owner`) ======///

    function redeem(MarketId poolId, uint256 cptSharesIn, address owner, address receiver)
        external
        returns (uint256 referenceAssetsOut, uint256 collateralAssetsOut);

    function withdraw(MarketId poolId, uint256 collateralAssetsOut, address owner, address receiver)
        external
        returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut);

    function withdrawOther(MarketId poolId, uint256 referenceAssetsOut, address owner, address receiver)
        external
        returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut);

    ///====== COVERAGE (cST + reference in, collateral out) ======///

    function swap(MarketId poolId, uint256 collateralAssetsOut, address receiver)
        external
        returns (uint256 cstSharesIn, uint256 referenceAssetsIn, uint256 fee);

    function exercise(MarketId poolId, uint256 cstSharesIn, address receiver)
        external
        returns (uint256 collateralAssetsOut, uint256 referenceAssetsIn, uint256 fee);

    function exerciseOther(MarketId poolId, uint256 referenceAssetsIn, address receiver)
        external
        returns (uint256 collateralAssetsOut, uint256 cstSharesIn, uint256 fee);

    ///====== COVERAGE REVERSAL (collateral in, cST + reference out) ======///

    function unwindSwap(MarketId poolId, uint256 collateralAssetsIn, address receiver)
        external
        returns (uint256 cstSharesOut, uint256 referenceAssetsOut, uint256 fee);

    function unwindExercise(MarketId poolId, uint256 cstSharesOut, address receiver)
        external
        returns (uint256 collateralAssetsIn, uint256 referenceAssetsOut, uint256 fee);

    function unwindExerciseOther(MarketId poolId, uint256 referenceAssetsOut, address receiver)
        external
        returns (uint256 collateralAssetsIn, uint256 cstSharesOut, uint256 fee);
}
