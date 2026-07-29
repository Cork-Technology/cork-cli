// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorkPoolForSelfBase} from "../src/base/CorkPoolForSelfBase.sol";
import {ForSelfCommon} from "../src/base/ForSelfCommon.sol";
import {ForkBase} from "./ForkBase.sol";

/// @dev Group A: collateral-in flows (deposit / mint / unwindSwap / unwindExercise*).
contract PoolGroupATest is ForkBase {
    function test_depositForSelf_sharesLandOnCaller() public {
        uint256 amount = 100e18;
        deal(collateralAsset, safe, amount);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(poolAdapter), amount);
        uint256 sharesOut = poolAdapter.depositForSelf(
            CorkPoolForSelfBase.DepositForSelfParams({
                poolId: POOL_ID, collateralAssetsIn: amount, minCptAndCstSharesOut: 1, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(sharesOut, 0);
        assertEq(IERC20(cpt).balanceOf(safe), sharesOut, "cPT to caller");
        assertEq(IERC20(cst).balanceOf(safe), sharesOut, "cST to caller");
        assertEq(IERC20(collateralAsset).balanceOf(safe), 0, "collateral spent");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_depositForSelf_revertsOnSlippage() public {
        uint256 amount = 100e18;
        deal(collateralAsset, safe, amount);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(poolAdapter), amount);
        vm.expectRevert(ForSelfCommon.SlippageExceeded.selector);
        poolAdapter.depositForSelf(
            CorkPoolForSelfBase.DepositForSelfParams({
                poolId: POOL_ID,
                collateralAssetsIn: amount,
                minCptAndCstSharesOut: type(uint256).max,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    function test_depositForSelf_revertsPastDeadline() public {
        vm.prank(safe);
        vm.expectRevert(ForSelfCommon.DeadlineExceeded.selector);
        poolAdapter.depositForSelf(
            CorkPoolForSelfBase.DepositForSelfParams({
                poolId: POOL_ID, collateralAssetsIn: 1e18, minCptAndCstSharesOut: 0, deadline: block.timestamp - 1
            })
        );
    }

    function test_mintForSelf_refundsUnspentCap() public {
        uint256 sharesWanted = 50e18;
        uint256 cap = 200e18; // far above the derived cost
        deal(collateralAsset, safe, cap);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(poolAdapter), cap);
        uint256 spent = poolAdapter.mintForSelf(
            CorkPoolForSelfBase.MintForSelfParams({
                poolId: POOL_ID, cptAndCstSharesOut: sharesWanted, maxCollateralAssetsIn: cap, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertLt(spent, cap, "mint should cost less than the cap");
        assertEq(IERC20(collateralAsset).balanceOf(safe), cap - spent, "unspent cap refunded");
        assertEq(IERC20(cpt).balanceOf(safe), sharesWanted, "exact shares minted");
        assertEq(IERC20(cst).balanceOf(safe), sharesWanted, "exact shares minted");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_unwindSwapForSelf_outputsLandOnCaller() public {
        uint256 seeded = _seedShares(poolAdapter, 500e18);
        // Exercise part of the seeded cST so the pool holds reference to pay back out.
        _seedPoolReference(poolAdapter, seeded / 2, type(uint128).max);

        uint256 caIn = 10e18;
        deal(collateralAsset, safe, caIn);
        uint256 cstBefore = IERC20(cst).balanceOf(safe);
        uint256 refBefore = IERC20(referenceAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(poolAdapter), caIn);
        (uint256 cstOut, uint256 refOut,) = poolAdapter.unwindSwapForSelf(
            CorkPoolForSelfBase.UnwindSwapForSelfParams({
                poolId: POOL_ID,
                collateralAssetsIn: caIn,
                minCstSharesOut: 1,
                minReferenceAssetsOut: 1,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(IERC20(cst).balanceOf(safe), cstBefore + cstOut, "cST to caller");
        assertEq(IERC20(referenceAsset).balanceOf(safe), refBefore + refOut, "reference to caller");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_unwindExerciseForSelf_capRefunded() public {
        uint256 seeded = _seedShares(poolAdapter, 500e18);
        _seedPoolReference(poolAdapter, seeded / 2, type(uint128).max);

        uint256 cstWanted = 5e18;
        uint256 cap = 50e18;
        deal(collateralAsset, safe, cap);
        uint256 cstBefore = IERC20(cst).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(poolAdapter), cap);
        (uint256 caSpent,,) = poolAdapter.unwindExerciseForSelf(
            CorkPoolForSelfBase.UnwindExerciseForSelfParams({
                poolId: POOL_ID,
                cstSharesOut: cstWanted,
                maxCollateralAssetsIn: cap,
                minReferenceAssetsOut: 0,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertLt(caSpent, cap, "derived cost below cap");
        assertEq(IERC20(collateralAsset).balanceOf(safe), cap - caSpent, "unspent cap refunded");
        assertEq(IERC20(cst).balanceOf(safe), cstBefore + cstWanted, "exact cST recovered");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_unwindExerciseOtherForSelf_capRefunded() public {
        uint256 seeded = _seedShares(poolAdapter, 500e18);
        _seedPoolReference(poolAdapter, seeded / 2, type(uint128).max);

        uint256 refWanted = 1e6; // reference asset has 6 decimals on this pool
        uint256 cap = 50e18;
        deal(collateralAsset, safe, cap);
        uint256 refBefore = IERC20(referenceAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(poolAdapter), cap);
        (uint256 caSpent,,) = poolAdapter.unwindExerciseOtherForSelf(
            CorkPoolForSelfBase.UnwindExerciseOtherForSelfParams({
                poolId: POOL_ID,
                referenceAssetsOut: refWanted,
                maxCollateralAssetsIn: cap,
                minCstSharesOut: 0,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertLt(caSpent, cap, "derived cost below cap");
        assertEq(IERC20(collateralAsset).balanceOf(safe), cap - caSpent, "unspent cap refunded");
        assertEq(IERC20(referenceAsset).balanceOf(safe), refBefore + refWanted, "exact reference recovered");
        _assertAdapterClean(address(poolAdapter));
    }
}
