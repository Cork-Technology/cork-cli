// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorkPoolForSelfBase} from "../src/base/CorkPoolForSelfBase.sol";
import {ForkBase} from "./ForkBase.sol";

/// @dev Group C: share-burning exits — zero-custody pass-throughs. The pool manager
///      burns shares straight from the caller by spending the caller's share-token
///      allowance to the ADAPTER; no token ever touches the adapter.
contract PoolGroupCTest is ForkBase {
    function test_unwindDepositForSelf_burnsFromCaller() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        uint256 caWanted = 10e18;
        uint256 cptBefore = IERC20(cpt).balanceOf(safe);
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(cpt).approve(address(poolAdapter), seeded);
        IERC20(cst).approve(address(poolAdapter), seeded);
        uint256 sharesBurned = poolAdapter.unwindDepositForSelf(
            CorkPoolForSelfBase.UnwindDepositForSelfParams({
                poolId: POOL_ID, collateralAssetsOut: caWanted, maxCptAndCstSharesIn: seeded, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(sharesBurned, 0);
        assertEq(IERC20(cpt).balanceOf(safe), cptBefore - sharesBurned, "cPT burned from caller");
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caWanted, "collateral to caller");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_unwindMintForSelf_exactSharesIn() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        uint256 sharesIn = seeded / 2;
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(cpt).approve(address(poolAdapter), sharesIn);
        IERC20(cst).approve(address(poolAdapter), sharesIn);
        uint256 caOut = poolAdapter.unwindMintForSelf(
            CorkPoolForSelfBase.UnwindMintForSelfParams({
                poolId: POOL_ID, cptAndCstSharesIn: sharesIn, minCollateralAssetsOut: 1, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(caOut, 0);
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caOut, "collateral to caller");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_redeemForSelf_postExpiry() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        vm.warp(marketParams.expiryTimestamp + 1);

        uint256 cptBefore = IERC20(cpt).balanceOf(safe);
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);
        uint256 cptIn = seeded / 2;

        vm.startPrank(safe);
        IERC20(cpt).approve(address(poolAdapter), cptIn);
        (uint256 refOut, uint256 caOut) = poolAdapter.redeemForSelf(
            CorkPoolForSelfBase.RedeemForSelfParams({
                poolId: POOL_ID,
                cptSharesIn: cptIn,
                minReferenceAssetsOut: 0,
                minCollateralAssetsOut: 0,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(caOut + refOut, 0, "some settlement value");
        assertEq(IERC20(cpt).balanceOf(safe), cptBefore - cptIn, "exact cPT burned from caller");
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caOut, "collateral to caller");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_withdrawForSelf_postExpiry() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        vm.warp(marketParams.expiryTimestamp + 1);

        uint256 caWanted = 1e18;
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(cpt).approve(address(poolAdapter), seeded);
        (uint256 cptIn, uint256 caOut,) = poolAdapter.withdrawForSelf(
            CorkPoolForSelfBase.WithdrawForSelfParams({
                poolId: POOL_ID, collateralAssetsOut: caWanted, maxCptSharesIn: seeded, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(cptIn, 0);
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caOut, "collateral to caller");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_withdrawOtherForSelf_postExpiry() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        _seedPoolReference(poolAdapter, seeded / 2, type(uint128).max);
        vm.warp(marketParams.expiryTimestamp + 1);

        uint256 refWanted = 1e6;
        uint256 refBefore = IERC20(referenceAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(cpt).approve(address(poolAdapter), seeded);
        (uint256 cptIn,, uint256 refOut) = poolAdapter.withdrawOtherForSelf(
            CorkPoolForSelfBase.WithdrawOtherForSelfParams({
                poolId: POOL_ID, referenceAssetsOut: refWanted, maxCptSharesIn: seeded, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(cptIn, 0);
        assertEq(IERC20(referenceAsset).balanceOf(safe), refBefore + refOut, "reference to caller");
        _assertAdapterClean(address(poolAdapter));
    }

    /// @dev The share allowance consumed is caller -> ADAPTER (not caller -> pool
    ///      manager): the pool manager's burnFrom spends the allowance granted to its
    ///      msg.sender, which is the adapter.
    function test_groupC_spendsAllowanceToAdapter() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        uint256 sharesIn = seeded / 2;

        vm.startPrank(safe);
        IERC20(cpt).approve(address(poolAdapter), sharesIn);
        IERC20(cst).approve(address(poolAdapter), sharesIn);
        poolAdapter.unwindMintForSelf(
            CorkPoolForSelfBase.UnwindMintForSelfParams({
                poolId: POOL_ID, cptAndCstSharesIn: sharesIn, minCollateralAssetsOut: 0, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(IERC20(cpt).allowance(safe, address(poolAdapter)), 0, "cPT allowance to adapter spent");
        assertEq(IERC20(cst).allowance(safe, address(poolAdapter)), 0, "cST allowance to adapter spent");
        _assertAdapterClean(address(poolAdapter));
    }

    /// @dev Without the caller's share allowance to the adapter, Group C reverts — the
    ///      adapter cannot burn anyone's shares on its own authority. Pinned to the share
    ///      token's own allowance error so the test cannot pass because of some unrelated
    ///      revert (a pause, an expiry, a bad pool id).
    function test_groupC_revertsWithoutAllowance() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);

        vm.prank(safe);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientAllowance.selector);
        poolAdapter.unwindMintForSelf(
            CorkPoolForSelfBase.UnwindMintForSelfParams({
                poolId: POOL_ID, cptAndCstSharesIn: seeded / 2, minCollateralAssetsOut: 0, deadline: block.timestamp
            })
        );
    }
}
