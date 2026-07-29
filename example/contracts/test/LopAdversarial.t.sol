// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {ForSelfCommon} from "../src/base/ForSelfCommon.sol";
import {MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";
import {ForkBase} from "./ForkBase.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Adversarial tests: a caged agent supplies hostile takerTraits; the wrapper's
///      sanitization must make every redirection attempt inert.
contract LopAdversarialTest is ForkBase {
    uint256 internal constant MAKER_PK = 0xB0B;
    address internal maker;
    address internal attacker;
    uint256 internal attackerPk;

    uint256 internal constant _MAKER_AMOUNT_FLAG = 1 << 255;
    uint256 internal constant _USE_PERMIT2_FLAG = 1 << 252;
    uint256 internal constant _ARGS_HAS_TARGET = 1 << 251;

    function setUp() public override {
        super.setUp();
        maker = vm.addr(MAKER_PK);
        // On a fork an arbitrary key can land on an address that already has code, which
        // would (correctly) route the fill to the ERC-1271 branch. Pin this maker as an EOA.
        vm.etch(maker, "");
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        vm.etch(attacker, "");
        uint256 seeded = _seedShares(poolAdapter, 100e18);
        vm.prank(safe);
        assertTrue(IERC20(cst).transfer(maker, seeded / 2), "seed maker");
        vm.prank(maker);
        IERC20(cst).approve(LOP, type(uint256).max);
    }

    function _order(uint256 salt) internal view returns (IOrderMixinMinimal.Order memory) {
        return IOrderMixinMinimal.Order({
            salt: salt,
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(cst)),
            takerAsset: uint256(uint160(collateralAsset)),
            makingAmount: 10e18,
            takingAmount: 1e18,
            makerTraits: 0
        });
    }

    function _signCompact(IOrderMixinMinimal.Order memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, lopAdapter.LOP().hashOrder(order));
        return abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));
    }

    /// @dev Hostile bits everywhere the layout allows: target flag, permit2 flag, fake
    ///      extension/interaction lengths. The fill must still succeed AND deliver to
    ///      the caller — proving the wrapper rebuilt traits/args from scratch.
    function test_hostileTraitsBitsAreInert() public {
        IOrderMixinMinimal.Order memory order = _order(10);
        deal(collateralAsset, safe, 1e18);
        uint256 safeCstBefore = IERC20(cst).balanceOf(safe);

        uint256 hostile = _ARGS_HAS_TARGET | _USE_PERMIT2_FLAG // redirect + permit2 sourcing
            | (uint256(0xbeef) << 224) // fake extension length
            | (uint256(0xdead) << 200); // fake interaction length (mid-fill callback attempt)

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        (uint256 making,,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: _signCompact(order),
                amount: 1e18,
                takerTraits: hostile,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(making, 10e18);
        assertEq(IERC20(cst).balanceOf(safe), safeCstBefore + 10e18, "delivery forced to caller despite hostile bits");
        assertEq(IERC20(cst).balanceOf(attacker), 0, "attacker got nothing");
        _assertAdapterClean(address(lopAdapter));
    }

    /// @dev The attack the fill wrapper exists to stop, in its sharpest form. A caged
    ///      agent signs its OWN order: one wei of a worthless token for the account's
    ///      entire balance, with itself as the order's receiver. Target-forcing alone
    ///      does not help — nothing is misdirected, the account genuinely "buys" the junk
    ///      — so the wrapper additionally binds every fill to a real Cork market's asset
    ///      pair, read from the pinned pool manager. The attacker's token is not that
    ///      pair, so the fill never happens.
    function test_selfSignedJunkOrderCannotDrainCaller() public {
        MockERC20 junk = new MockERC20(); // worthless: not any market's token
        junk.mint(attacker, 1);
        vm.prank(attacker);
        junk.approve(LOP, type(uint256).max);

        uint256 safeBalance = 1000e18;
        deal(collateralAsset, safe, safeBalance);

        IOrderMixinMinimal.Order memory order = IOrderMixinMinimal.Order({
            salt: 20,
            maker: uint256(uint160(attacker)),
            receiver: uint256(uint160(attacker)), // pay ME
            makerAsset: uint256(uint160(address(junk))), // worthless
            takerAsset: uint256(uint160(collateralAsset)), // the account's real money
            makingAmount: 1,
            takingAmount: safeBalance,
            makerTraits: 0
        });
        // Signed properly by the attacker, so the protocol itself is perfectly happy to
        // execute this fill. Only the market binding stands in the way.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, lopAdapter.LOP().hashOrder(order));
        bytes memory signature = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), safeBalance);
        vm.expectPartialRevert(CorkLopFillForSelfBase.OrderAssetsNotInMarket.selector);
        lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: signature,
                amount: safeBalance,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(IERC20(collateralAsset).balanceOf(attacker), 0, "attacker drained nothing");
        assertEq(IERC20(collateralAsset).balanceOf(safe), safeBalance, "account balance intact");
        assertEq(junk.balanceOf(safe), 0, "no junk delivered");
    }

    /// @dev An unknown market cannot be used to bypass the pair binding: the pool manager
    ///      returns a zeroed struct, which the wrapper rejects rather than dereferences.
    function test_unknownPoolIdRejected() public {
        IOrderMixinMinimal.Order memory order = _order(21);
        // Sign BEFORE the cheatcode: _signCompact makes an external hashOrder call, which
        // would otherwise consume the expectRevert.
        bytes memory signature = _signCompact(order);
        deal(collateralAsset, safe, 1e18);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        vm.expectPartialRevert(CorkLopFillForSelfBase.OrderAssetsNotInMarket.selector);
        lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: MarketId.wrap(bytes32(uint256(0xdead))),
                order: order,
                signature: signature,
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertEq(IERC20(collateralAsset).balanceOf(safe), 1e18, "nothing spent");
    }

    /// @dev Signers that emit v as 0/1 rather than 27/28 must still be fillable.
    function test_signatureWithLegacyVEncoding() public {
        IOrderMixinMinimal.Order memory order = _order(22);
        deal(collateralAsset, safe, 1e18);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, lopAdapter.LOP().hashOrder(order));

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        (uint256 making,,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: abi.encodePacked(r, s, uint8(v - 27)), // 0/1 convention
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertEq(making, 10e18, "legacy v encoding accepted");
    }

    function test_thresholdRequired_inMakingMode() public {
        IOrderMixinMinimal.Order memory order = _order(11);
        vm.prank(safe);
        vm.expectRevert(CorkLopFillForSelfBase.ThresholdRequired.selector);
        lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: "",
                amount: 5e18,
                takerTraits: _MAKER_AMOUNT_FLAG, // making mode with ZERO threshold
                extension: "",
                deadline: block.timestamp
            })
        );
    }

    function test_invalidSignatureLengthReverts() public {
        IOrderMixinMinimal.Order memory order = _order(12);
        deal(collateralAsset, safe, 1e18);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        vm.expectRevert(CorkLopFillForSelfBase.InvalidSignatureLength.selector);
        lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: new bytes(63),
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    function test_deadlineReverts() public {
        IOrderMixinMinimal.Order memory order = _order(13);
        vm.prank(safe);
        vm.expectRevert(ForSelfCommon.DeadlineExceeded.selector);
        lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID,
                order: order,
                signature: "",
                amount: 1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp - 1
            })
        );
    }

    /// @dev The `extension` blob is the only caller-supplied bytes that reach `args`. It
    ///      cannot smuggle a target: the wrapper always writes its own 20-byte target
    ///      FIRST, so bytes a caller shapes like an address are parsed as the extension,
    ///      never as the destination. Whether the protocol then accepts or rejects that
    ///      extension is its business — either way the maker asset can only reach the
    ///      caller, and the attacker can only ever receive nothing.
    function test_forgedExtensionCannotRedirect() public {
        IOrderMixinMinimal.Order memory order = _order(14);
        deal(collateralAsset, safe, 1e18);
        uint256 safeCstBefore = IERC20(cst).balanceOf(safe);

        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(lopAdapter), 1e18);
        (bool ok,) = address(lopAdapter)
            .call(
                abi.encodeCall(
                    lopAdapter.fillOrderForSelf,
                    (CorkLopFillForSelfBase.FillOrderForSelfParams({
                        poolId: POOL_ID,
                        order: order,
                        signature: _signCompact(order),
                        amount: 1e18,
                        takerTraits: 0,
                        extension: abi.encodePacked(attacker), // 20 bytes shaped like a target
                        deadline: block.timestamp
                    }))
                )
            );
        vm.stopPrank();

        assertEq(IERC20(cst).balanceOf(attacker), 0, "attacker never receives the maker asset");
        assertEq(IERC20(collateralAsset).balanceOf(attacker), 0, "attacker never receives the taker asset");
        if (ok) {
            assertGt(IERC20(cst).balanceOf(safe), safeCstBefore, "on success the maker asset went to the caller");
        } else {
            assertEq(IERC20(collateralAsset).balanceOf(safe), 1e18, "on failure the caller's funds are untouched");
        }
        _assertAdapterClean(address(lopAdapter));
    }
}

