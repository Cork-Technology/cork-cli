// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {CorkLopFillForSelfAdapter} from "../src/CorkLopFillForSelfAdapter.sol";
import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockJitLop, MockJitPoolManager} from "./mocks/MockJitProtocols.sol";

/// @dev The market binding is checked AFTER the fill so that a just-in-time order — one
///      whose market is created during the fill itself — is not rejected for a market that
///      could not exist yet. These tests pin that ordering.
///
///      They run against mocks rather than a fork, deliberately and by necessity. On
///      2026-07-28 no JIT adapter exists for the live Arbitrum deployment: the only one
///      deployed reports `poolManager() == 0xc2De…54AE`, the pre-launch pool manager, and
///      every order in the live book carries an empty extension. So there is nothing to
///      fill against. What is verified here is this wrapper's ordering, which is the part
///      Cork owns; the JIT adapter's own behaviour is Cork protocol territory and is
///      covered upstream.
contract JitOrderingTest is Test {
    MockERC20 internal collateral;
    MockERC20 internal cst;
    address internal safe = address(0x5AFE);
    MarketId internal constant POOL_ID = MarketId.wrap(bytes32(uint256(1)));

    function setUp() public {
        collateral = new MockERC20();
        cst = new MockERC20();
    }

    function _deploy(bool createsMarketDuringFill)
        internal
        returns (CorkLopFillForSelfAdapter adapter, MockJitLop lop)
    {
        MockJitPoolManager pm = new MockJitPoolManager(address(collateral), address(cst));
        lop = new MockJitLop(pm, createsMarketDuringFill);
        adapter = new CorkLopFillForSelfAdapter(address(pm), address(lop));

        cst.mint(address(lop), 10e18); // the maker's inventory, held by the protocol mock
        collateral.mint(safe, 1e18);
        vm.prank(safe);
        collateral.approve(address(adapter), 1e18);
    }

    function _order() internal view returns (IOrderMixinMinimal.Order memory) {
        return IOrderMixinMinimal.Order({
            salt: 1,
            maker: uint256(uint160(address(0xBEEF))), // no code: takes the EOA branch
            receiver: 0,
            makerAsset: uint256(uint160(address(cst))),
            takerAsset: uint256(uint160(address(collateral))),
            makingAmount: 10e18,
            takingAmount: 1e18,
            makerTraits: 0
        });
    }

    function _params() internal view returns (CorkLopFillForSelfBase.FillOrderForSelfParams memory) {
        return CorkLopFillForSelfBase.FillOrderForSelfParams({
            poolId: POOL_ID,
            order: _order(),
            signature: new bytes(64),
            amount: 1e18,
            takerTraits: 0,
            extension: "",
            deadline: block.timestamp
        });
    }

    /// @dev The market does not exist when the call begins — `shares()` and `market()` both
    ///      return zeroes — and is created during the fill. A check placed before the fill
    ///      would reject this outright; checking after lets it through.
    function test_marketCreatedDuringFillIsAccepted() public {
        (CorkLopFillForSelfAdapter adapter, MockJitLop lop) = _deploy(true);
        assertEq(cst.balanceOf(safe), 0, "caller starts with no cover");

        vm.prank(safe);
        (uint256 making,,) = adapter.fillOrderForSelf(_params());

        assertEq(making, 10e18, "fill went through");
        assertEq(cst.balanceOf(safe), 10e18, "cover delivered to the caller");
        assertEq(collateral.balanceOf(address(lop)), 1e18, "maker paid");
        assertEq(collateral.balanceOf(address(adapter)), 0, "adapter holds nothing");
        assertEq(cst.balanceOf(address(adapter)), 0, "adapter holds nothing");
    }

    /// @dev The other half of the same property: deferring the check must not weaken it. If
    ///      the fill never brings the market into existence, the binding still rejects — and
    ///      the revert unwinds the payment that had already been made.
    function test_marketNeverCreatedStillReverts() public {
        (CorkLopFillForSelfAdapter adapter,) = _deploy(false);

        vm.prank(safe);
        vm.expectPartialRevert(CorkLopFillForSelfBase.OrderAssetsNotInMarket.selector);
        adapter.fillOrderForSelf(_params());

        assertEq(collateral.balanceOf(safe), 1e18, "payment unwound with the revert");
        assertEq(cst.balanceOf(safe), 0, "no cover delivered");
    }
}
