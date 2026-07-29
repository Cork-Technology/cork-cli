// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {CorkPoolForSelfBase} from "../src/base/CorkPoolForSelfBase.sol";
import {ForkBase} from "./ForkBase.sol";

/// @dev Group B: coverage flows (swap / exercise / exerciseOther) — cST + reference in,
///      collateral out. The pool manager moves cST out of the adapter's own holdings
///      (gated no-allowance transfer), so the caller approves the ADAPTER on cST.
contract PoolGroupBTest is ForkBase {
    function test_exerciseForSelf_collateralLandsOnCaller() public {
        uint256 seeded = _seedShares(poolAdapter, 200e18);
        uint256 cstIn = seeded / 4;
        uint256 refCap = 1000e6;
        deal(referenceAsset, safe, refCap);
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);
        uint256 cstBefore = IERC20(cst).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(cst).approve(address(poolAdapter), cstIn);
        IERC20(referenceAsset).approve(address(poolAdapter), refCap);
        (uint256 caOut, uint256 refIn,) = poolAdapter.exerciseForSelf(
            CorkPoolForSelfBase.ExerciseForSelfParams({
                poolId: POOL_ID,
                cstSharesIn: cstIn,
                maxReferenceAssetsIn: refCap,
                minCollateralAssetsOut: 1,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(caOut, 0);
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caOut, "collateral paid directly to caller");
        assertEq(IERC20(cst).balanceOf(safe), cstBefore - cstIn, "exact cST consumed");
        assertEq(IERC20(referenceAsset).balanceOf(safe), refCap - refIn, "unspent reference cap refunded");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_swapForSelf_bothCapsRefunded() public {
        _seedShares(poolAdapter, 200e18);
        uint256 caWanted = 1e18;
        uint256 cstCap = 10e18;
        uint256 refCap = 100e6;
        deal(referenceAsset, safe, refCap);
        uint256 cstBefore = IERC20(cst).balanceOf(safe);
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(cst).approve(address(poolAdapter), cstCap);
        IERC20(referenceAsset).approve(address(poolAdapter), refCap);
        (uint256 cstIn, uint256 refIn,) = poolAdapter.swapForSelf(
            CorkPoolForSelfBase.SwapForSelfParams({
                poolId: POOL_ID,
                collateralAssetsOut: caWanted,
                maxCstSharesIn: cstCap,
                maxReferenceAssetsIn: refCap,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caWanted, "exact collateral out");
        assertEq(IERC20(cst).balanceOf(safe), cstBefore - cstIn, "cST cap refunded to the derived amount");
        assertEq(IERC20(referenceAsset).balanceOf(safe), refCap - refIn, "reference cap refunded");
        _assertAdapterClean(address(poolAdapter));
    }

    function test_exerciseOtherForSelf_exactReferenceLeg() public {
        uint256 seeded = _seedShares(poolAdapter, 200e18);
        uint256 refIn = 10e6;
        uint256 cstCap = seeded;
        deal(referenceAsset, safe, refIn);
        uint256 cstBefore = IERC20(cst).balanceOf(safe);
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(cst).approve(address(poolAdapter), cstCap);
        IERC20(referenceAsset).approve(address(poolAdapter), refIn);
        (uint256 caOut, uint256 cstIn,) = poolAdapter.exerciseOtherForSelf(
            CorkPoolForSelfBase.ExerciseOtherForSelfParams({
                poolId: POOL_ID,
                referenceAssetsIn: refIn,
                maxCstSharesIn: cstCap,
                minCollateralAssetsOut: 1,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertGt(caOut, 0);
        assertEq(IERC20(referenceAsset).balanceOf(safe), 0, "exact reference consumed");
        assertEq(IERC20(cst).balanceOf(safe), cstBefore - cstIn, "derived cST consumed, remainder refunded");
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caOut, "collateral to caller");
        _assertAdapterClean(address(poolAdapter));
    }

    /// @dev The adapter never holds the exercised collateral, even for an instant. Proven
    ///      from the token's own event log rather than from an end-of-call balance: the
    ///      pool manager pays `receiver = msg.sender` directly, so no collateral Transfer
    ///      in the whole transaction may name the adapter as its recipient. A balance
    ///      check after the fact could not tell that apart from "held it, then swept it".
    function test_exerciseForSelf_adapterNeverHoldsCollateral() public {
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        deal(referenceAsset, safe, 1000e6);

        vm.startPrank(safe);
        IERC20(cst).approve(address(poolAdapter), seeded);
        IERC20(referenceAsset).approve(address(poolAdapter), 1000e6);
        vm.recordLogs();
        poolAdapter.exerciseForSelf(
            CorkPoolForSelfBase.ExerciseForSelfParams({
                poolId: POOL_ID,
                cstSharesIn: seeded / 10,
                maxReferenceAssetsIn: 1000e6,
                minCollateralAssetsOut: 1,
                deadline: block.timestamp
            })
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.stopPrank();

        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 collateralTransfers;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != collateralAsset) continue;
            if (logs[i].topics.length < 3 || logs[i].topics[0] != transferSig) continue;
            collateralTransfers++;
            address to = address(uint160(uint256(logs[i].topics[2])));
            assertTrue(to != address(poolAdapter), "collateral was routed through the adapter");
        }
        assertGt(collateralTransfers, 0, "expected at least one collateral transfer to inspect");
        _assertAdapterClean(address(poolAdapter));
    }
}
