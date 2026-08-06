// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";
import {ForkBase} from "./ForkBase.sol";
import {ERC1271Maker} from "./mocks/ERC1271Maker.sol";

/// @dev Fill-wrapper tests against the LIVE 1inch LOP v4 on the Arbitrum fork. Orders
///      sell the pool's cST for collateral (the pilot shape: safe = taker buying cover).
contract LopFillTest is ForkBase {
    uint256 internal constant MAKER_PK = 0xA11CE;
    address internal maker;

    uint256 internal constant _MAKER_AMOUNT_FLAG = 1 << 255;
    /// @dev Maker-side trait observed on live Cork venue orders (allow multiple fills).
    uint256 internal constant _ALLOW_MULTIPLE_FILLS_FLAG = 1 << 254;

    function setUp() public override {
        super.setUp();
        maker = vm.addr(MAKER_PK);
        // On a fork an arbitrary key can land on an address that already has code, which
        // would (correctly) route the fill to the ERC-1271 branch. Pin this maker as an EOA.
        vm.etch(maker, "");
        // Real cST from a real deposit, moved to the maker; maker approves the LOP.
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        vm.prank(safe);
        assertTrue(IERC20(cst).transfer(maker, seeded / 2), "seed maker");
        vm.prank(maker);
        IERC20(cst).approve(LOP, type(uint256).max);
    }

    function _makeOrder(uint256 makingAmount, uint256 takingAmount, uint256 salt)
        internal
        view
        returns (IOrderMixinMinimal.Order memory)
    {
        return IOrderMixinMinimal.Order({
            salt: salt,
            maker: uint256(uint160(maker)),
            receiver: 0, // zero => maker receives the taking amount
            makerAsset: uint256(uint160(cst)),
            takerAsset: uint256(uint160(collateralAsset)),
            makingAmount: makingAmount,
            takingAmount: takingAmount,
            makerTraits: 0
        });
    }

    function _signCompact(IOrderMixinMinimal.Order memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, lopAdapter.LOP().hashOrder(order));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        return abi.encodePacked(r, vs);
    }

    function _sign65(IOrderMixinMinimal.Order memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, lopAdapter.LOP().hashOrder(order));
        return abi.encodePacked(r, s, v);
    }

    function test_fill_eoaMaker_takingMode_makerAssetLandsOnCaller() public {
        IOrderMixinMinimal.Order memory order = _makeOrder(10e18, 1e18, 1);
        deal(collateralAsset, safe, 1e18);
        uint256 makerCaBefore = IERC20(collateralAsset).balanceOf(maker);
        uint256 safeCstBefore = IERC20(cst).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        (uint256 making, uint256 taking,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: _signCompact(order),
                amount: 1e18, // taking-amount mode
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(making, 10e18, "full making amount");
        assertEq(taking, 1e18, "full taking amount");
        assertEq(IERC20(cst).balanceOf(safe), safeCstBefore + 10e18, "cST delivered to the CALLER, not the wrapper");
        assertEq(IERC20(collateralAsset).balanceOf(maker), makerCaBefore + 1e18, "maker paid");
        assertEq(IERC20(collateralAsset).balanceOf(safe), 0, "taker asset spent");
        _assertAdapterClean(address(lopAdapter));
    }

    function test_fill_eoaMaker_65ByteSignature() public {
        IOrderMixinMinimal.Order memory order = _makeOrder(10e18, 1e18, 2);
        deal(collateralAsset, safe, 1e18);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        (uint256 making,,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: _sign65(order),
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertEq(making, 10e18);
        _assertAdapterClean(address(lopAdapter));
    }

    function test_fill_makingMode_partialFill_refundsUnspentThreshold() public {
        IOrderMixinMinimal.Order memory order = _makeOrder(10e18, 1e18, 3);
        // Match the live venue shape so the order uses the remaining-amount invalidator,
        // as real Cork orders do, rather than the single-use bit invalidator.
        order.makerTraits = _ALLOW_MULTIPLE_FILLS_FLAG;
        // Fill half the order by making amount; worst-case taking bounded by threshold.
        uint256 makingWanted = 5e18;
        uint256 threshold = 0.6e18; // actual taking will be 0.5e18
        deal(collateralAsset, safe, threshold);
        uint256 safeCstBefore = IERC20(cst).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), threshold);
        (uint256 making, uint256 taking,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: _signCompact(order),
                amount: makingWanted,
                takerTraits: _MAKER_AMOUNT_FLAG | threshold,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(making, makingWanted);
        assertEq(taking, 0.5e18, "pro-rata taking");
        assertEq(IERC20(cst).balanceOf(safe), safeCstBefore + makingWanted, "partial making to caller");
        assertEq(IERC20(collateralAsset).balanceOf(safe), threshold - taking, "unspent threshold refunded");
        _assertAdapterClean(address(lopAdapter));
    }

    /// @dev The live venue lists cPT markets quoted in collateral alongside the cST ones
    ///      (observed on Arbitrum, 2026-08-06). The market binding admits any of the
    ///      pool's share assets against either cash leg — this pins the cPT side.
    function test_fill_cptAgainstCollateral_isBoundToTheMarket() public {
        uint256 seeded = _seedShares(poolAdapter, 10e18);
        vm.prank(safe);
        assertTrue(IERC20(cpt).transfer(maker, seeded), "maker cPT inventory");
        vm.prank(maker);
        IERC20(cpt).approve(LOP, type(uint256).max);

        IOrderMixinMinimal.Order memory order = _makeOrder(5e18, 1e18, 5);
        order.makerAsset = uint256(uint160(cpt));
        deal(collateralAsset, safe, 1e18);
        uint256 safeCptBefore = IERC20(cpt).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        (uint256 making,,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: _signCompact(order),
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(making, 5e18);
        assertEq(IERC20(cpt).balanceOf(safe), safeCptBefore + 5e18, "cPT delivered to the caller");
        _assertAdapterClean(address(lopAdapter));
    }

    /// @dev The reference asset is the market's other cash leg; a cST order quoted in it
    ///      is still genuine market value and passes the binding.
    function test_fill_cstAgainstReference_isBoundToTheMarket() public {
        IOrderMixinMinimal.Order memory order = _makeOrder(10e18, 1e18, 6);
        order.takerAsset = uint256(uint160(referenceAsset));
        deal(referenceAsset, safe, 1e18);
        uint256 safeCstBefore = IERC20(cst).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(referenceAsset).approve(address(lopAdapter), 1e18);
        (uint256 making,,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: _signCompact(order),
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(making, 10e18);
        assertEq(IERC20(cst).balanceOf(safe), safeCstBefore + 10e18, "cST delivered to the caller");
        _assertAdapterClean(address(lopAdapter));
    }

    /// @dev Two real market assets that are BOTH cash legs do not pair: the binding
    ///      requires a share asset on one side, so the wrapper cannot be used as a
    ///      general collateral/reference swapper.
    function test_fill_cashAgainstCash_reverts() public {
        IOrderMixinMinimal.Order memory order = _makeOrder(1e18, 1e18, 7);
        order.makerAsset = uint256(uint160(referenceAsset));
        deal(referenceAsset, maker, 1e18);
        vm.prank(maker);
        IERC20(referenceAsset).approve(LOP, type(uint256).max);
        deal(collateralAsset, safe, 1e18);

        // Sign BEFORE the cheatcode: _signCompact makes an external hashOrder call, which
        // would otherwise consume the expectRevert.
        bytes memory signature = _signCompact(order);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        vm.expectPartialRevert(CorkLopFillForSelfBase.OrderAssetsNotInMarket.selector);
        lopAdapter.fillOrderForSelf(
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
    }

    function test_fill_contractMaker_viaErc1271Branch() public {
        ERC1271Maker contractMaker = new ERC1271Maker();
        vm.prank(maker);
        assertTrue(IERC20(cst).transfer(address(contractMaker), 10e18), "seed contract maker");
        contractMaker.approveToken(cst, LOP);

        IOrderMixinMinimal.Order memory order = IOrderMixinMinimal.Order({
            salt: 4,
            maker: uint256(uint160(address(contractMaker))),
            receiver: 0,
            makerAsset: uint256(uint160(cst)),
            takerAsset: uint256(uint160(collateralAsset)),
            makingAmount: 10e18,
            takingAmount: 1e18,
            makerTraits: 0
        });
        contractMaker.setApprovedHash(lopAdapter.LOP().hashOrder(order));

        deal(collateralAsset, safe, 1e18);
        uint256 safeCstBefore = IERC20(cst).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        (uint256 making,,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: hex"deadbeef", // opaque ERC-1271 payload; the mock ignores it
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(making, 10e18);
        assertEq(IERC20(cst).balanceOf(safe), safeCstBefore + 10e18, "contract-maker fill lands on caller");
        _assertAdapterClean(address(lopAdapter));
    }
}
