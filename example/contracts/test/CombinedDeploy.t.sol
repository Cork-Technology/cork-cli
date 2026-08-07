// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorkForSelfAdapter} from "../src/CorkForSelfAdapter.sol";
import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {CorkPoolForSelfBase} from "../src/base/CorkPoolForSelfBase.sol";
import {ForSelfCommon} from "../src/base/ForSelfCommon.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";
import {ForkBase} from "./ForkBase.sol";

/// @dev The combined contract is what an integrator would realistically deploy: one
///      address to audit, whitelist, and approve. This exercises one flow from each pool
///      group plus a live LOP fill through that single instance.
contract CombinedDeployTest is ForkBase {
    uint256 internal constant MAKER_PK = 0xCAFE;
    address internal maker;

    function setUp() public override {
        super.setUp();
        maker = vm.addr(MAKER_PK);
        vm.etch(maker, "");
    }

    function test_immutablesPinnedAtDeploy() public view {
        assertEq(address(combinedAdapter.CORK()), POOL_MANAGER);
        assertEq(address(combinedAdapter.WHITELIST()), WHITELIST_MANAGER);
        assertEq(address(combinedAdapter.LOP()), LOP);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(ForSelfCommon.ZeroAddress.selector);
        new CorkForSelfAdapter(address(0), WHITELIST_MANAGER, LOP);
        vm.expectRevert(ForSelfCommon.ZeroAddress.selector);
        new CorkForSelfAdapter(POOL_MANAGER, address(0), LOP);
        vm.expectRevert(ForSelfCommon.ZeroAddress.selector);
        new CorkForSelfAdapter(POOL_MANAGER, WHITELIST_MANAGER, address(0));
    }

    /// @dev The pairing self-check, against REAL contracts: both Cork stacks are live on
    ///      this fork, so a genuinely mispaired (poolManager, whitelistManager) exists to
    ///      test with — the SHADOW stack's WhitelistManager serves the shadow pool
    ///      manager, not this one, and its reverse pointer says so on-chain.
    function test_constructorRejectsMispairedWhitelistManager() public {
        address shadowWlm = 0xEEd30E98abDC4da6d9Ac15c1184C9d046cA0Ccd6;
        address shadowPm = 0x02803Bb52D2184f906F45B50C66AA969C2E37263;
        vm.expectRevert(abi.encodeWithSelector(ForSelfCommon.WhitelistManagerMismatch.selector, shadowPm, POOL_MANAGER));
        new CorkForSelfAdapter(POOL_MANAGER, shadowWlm, LOP);
        // An address that is not a whitelist manager at all fails the same self-check
        // (its CORK_POOL_MANAGER() staticcall cannot answer), just less legibly.
        vm.expectRevert();
        new CorkForSelfAdapter(POOL_MANAGER, LOP, LOP);
    }

    /// @dev Group A -> Group B -> Group C -> LOP fill, all through one deployed address.
    function test_allSurfacesThroughOneInstance() public {
        // Group A: deposit.
        uint256 shares = _seedShares(combinedAdapter, 200e18);
        assertEq(IERC20(cst).balanceOf(safe), shares, "cST to caller");

        // Group B: exercise a slice for collateral.
        uint256 refCap = 1000e6;
        deal(referenceAsset, safe, refCap);
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);
        vm.startPrank(safe);
        IERC20(cst).approve(address(combinedAdapter), shares / 4);
        IERC20(referenceAsset).approve(address(combinedAdapter), refCap);
        (uint256 caOut,,) = combinedAdapter.exerciseForSelf(
            CorkPoolForSelfBase.ExerciseForSelfParams({
                poolId: POOL_ID,
                cstSharesIn: shares / 4,
                maxReferenceAssetsIn: refCap,
                minCollateralAssetsOut: 1,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caOut, "collateral to caller");

        // Group C: zero-custody share burn.
        vm.startPrank(safe);
        IERC20(cpt).approve(address(combinedAdapter), shares / 4);
        IERC20(cst).approve(address(combinedAdapter), shares / 4);
        uint256 unwound = combinedAdapter.unwindMintForSelf(
            CorkPoolForSelfBase.UnwindMintForSelfParams({
                poolId: POOL_ID, cptAndCstSharesIn: shares / 4, minCollateralAssetsOut: 1, deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(unwound, 0, "unwind returned collateral");

        // LOP fill through the same address: maker sells cST for collateral.
        vm.prank(safe);
        assertTrue(IERC20(cst).transfer(maker, 10e18), "seed maker");
        vm.prank(maker);
        IERC20(cst).approve(LOP, type(uint256).max);

        IOrderMixinMinimal.Order memory order = IOrderMixinMinimal.Order({
            salt: 99,
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(cst)),
            takerAsset: uint256(uint160(collateralAsset)),
            makingAmount: 10e18,
            takingAmount: 1e18,
            makerTraits: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, combinedAdapter.LOP().hashOrder(order));
        bytes memory signature = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));

        deal(collateralAsset, safe, 1e18);
        uint256 cstBefore = IERC20(cst).balanceOf(safe);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(combinedAdapter), 1e18);
        combinedAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: signature,
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(IERC20(cst).balanceOf(safe), cstBefore + 10e18, "bought cST landed on the caller");
        _assertAdapterClean(address(combinedAdapter));
    }
}
