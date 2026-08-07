// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {CorkPoolForSelfBase} from "../src/base/CorkPoolForSelfBase.sol";
import {ForSelfCommon} from "../src/base/ForSelfCommon.sol";
import {MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";
import {ForkBase} from "./ForkBase.sol";

/// @dev The real WhitelistManager's management surface, as the tests drive it. This is
///      the deployed contract's own ABI (verified against phoenix WhitelistManager.sol),
///      not a double — every call below runs against the live proxy on the fork.
interface IWhitelistManagerExt {
    function isMarketWhitelistEnabled(MarketId poolId) external view returns (bool);
    function isWhitelisted(MarketId poolId, address account) external view returns (bool);
    function addToGlobalWhitelist(address[] calldata accounts) external;
    function addToMarketWhitelist(MarketId poolId, address[] calldata accounts) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// @dev Caller-whitelist gate ("Variant B"), proven against the REAL Arbitrum stack: the
///      live WhitelistManager proxy, the live pool manager, a live market. The pool
///      manager only ever sees this adapter as its caller, so on a gated market the
///      adapter itself must re-check the REAL caller against the same whitelist — these
///      tests pin that both layers hold.
///
///      One piece of state has to be forged: a live market's whitelist can never be
///      ACTIVATED after creation (`activateMarketWhitelist` requires an uninitialized
///      market), so gating the live pool means writing its `marketWhitelistEnabled`
///      slot directly — and the slot math is validated against the real contract's own
///      getter before any test relies on it. Everything else goes through the honest
///      path: membership changes are made by impersonating the CORK_CONTROLLER_ROLE
///      holder (the live DefaultCorkController), exactly as production would.
contract WhitelistGateTest is ForkBase {
    /// @dev ERC-7201 base slot of WhitelistManagerStorage, from phoenix
    ///      WhitelistManager.sol: keccak256(abi.encode(uint256(keccak256(
    ///      "cork.storage.WhitelistManager")) - 1)) & ~bytes32(uint256(0xff)).
    ///      Struct layout: +0 CORK_POOL_MANAGER, +1 globalWhitelist,
    ///      +2 marketWhitelist, +3 marketWhitelistEnabled.
    bytes32 internal constant WLM_STORAGE_BASE = 0x0da519c821e1a8f2910e4e535b0245b25f0e3189410accd869caacafbf3ff700;

    /// @dev Live DefaultCorkController — holds CORK_CONTROLLER_ROLE on the
    ///      WhitelistManager (asserted in setUp, so a role migration fails loud here
    ///      rather than as a confusing AccessControl revert mid-test).
    address internal constant CONTROLLER = 0xdCC0388c68f85e65FA08dCb445B4d0927e9E6172;
    bytes32 internal constant CORK_CONTROLLER_ROLE = keccak256("CORK_CONTROLLER_ROLE");

    IWhitelistManagerExt internal wlm = IWhitelistManagerExt(WHITELIST_MANAGER);

    uint256 internal constant MAKER_PK = 0xCAFE;
    address internal maker;

    function setUp() public override {
        super.setUp();
        maker = vm.addr(MAKER_PK);
        vm.etch(maker, "");
        assertTrue(
            wlm.hasRole(CORK_CONTROLLER_ROLE, CONTROLLER),
            "controller no longer holds CORK_CONTROLLER_ROLE - update CONTROLLER"
        );
        assertFalse(wlm.isMarketWhitelistEnabled(POOL_ID), "live fixture pool unexpectedly gated");
    }

    /// @dev Flip the live market to gated by writing `marketWhitelistEnabled[POOL_ID]`,
    ///      then validate the slot arithmetic against the real getter — the contract
    ///      itself is the oracle for the storage layout, so a layout drift can never
    ///      silently turn these tests into no-ops.
    function _gate() internal {
        bytes32 slot = keccak256(abi.encode(POOL_ID, uint256(WLM_STORAGE_BASE) + 3));
        vm.store(WHITELIST_MANAGER, slot, bytes32(uint256(1)));
        assertTrue(wlm.isMarketWhitelistEnabled(POOL_ID), "slot math no longer matches the deployed layout");
    }

    function _listMarket(address account) internal {
        address[] memory accounts = new address[](1);
        accounts[0] = account;
        vm.prank(CONTROLLER);
        wlm.addToMarketWhitelist(POOL_ID, accounts);
    }

    function _listGlobal(address account) internal {
        address[] memory accounts = new address[](1);
        accounts[0] = account;
        vm.prank(CONTROLLER);
        wlm.addToGlobalWhitelist(accounts);
    }

    function _depositParams(uint256 amount) internal view returns (CorkPoolForSelfBase.DepositForSelfParams memory) {
        return CorkPoolForSelfBase.DepositForSelfParams({
            poolId: POOL_ID,
            collateralAssetsIn: amount,
            minCptAndCstSharesOut: 0,
            deadline: block.timestamp
        });
    }

    ///====== THE GATE, LAYER BY LAYER ======///

    /// @dev Ungated market: the gate must be a strict no-op — the same deposit every
    ///      other suite performs still works for an arbitrary, never-listed Safe.
    function test_ungatedMarketIsUnaffected() public {
        uint256 sharesOut = _seedShares(combinedAdapter, 10e18);
        assertGt(sharesOut, 0, "deposit through the gate on an ungated market");
        _assertAdapterClean(address(combinedAdapter));
    }

    /// @dev Gated market, adapter whitelisted (the pool manager layer passes), caller
    ///      NOT listed: the ADAPTER's own check must be what rejects, with its own
    ///      error naming the real caller. This is the discriminating test for the
    ///      whole feature: with the caller-check dropped (or checking address(this)
    ///      instead of msg.sender), the transaction would sail through the whitelisted
    ///      adapter and the deposit would SUCCEED.
    function test_gatedMarketRejectsUnlistedCaller() public {
        _gate();
        _listMarket(address(combinedAdapter)); // pool-manager layer: adapter admitted
        deal(collateralAsset, safe, 1e18);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(combinedAdapter), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ForSelfCommon.CallerNotWhitelisted.selector, POOL_ID, safe));
        combinedAdapter.depositForSelf(_depositParams(1e18));
        vm.stopPrank();
    }

    /// @dev Gated market, both layers listed: the whole flow works — one whitelist add
    ///      per Safe is exactly the operational contract.
    function test_gatedMarketAdmitsMarketListedCaller() public {
        _gate();
        _listMarket(address(combinedAdapter));
        _listMarket(safe);
        uint256 sharesOut = _seedShares(combinedAdapter, 10e18);
        assertGt(sharesOut, 0, "market-listed Safe deposits through the gated market");
        _assertAdapterClean(address(combinedAdapter));
    }

    /// @dev The real WhitelistManager's OTHER admission branch: global membership.
    function test_gatedMarketAdmitsGloballyListedCaller() public {
        _gate();
        _listMarket(address(combinedAdapter));
        _listGlobal(safe);
        uint256 sharesOut = _seedShares(combinedAdapter, 10e18);
        assertGt(sharesOut, 0, "globally-listed Safe deposits through the gated market");
    }

    /// @dev All 13 pool entrypoints carry the gate. The modifier is a pre-check, so an
    ///      unlisted caller must be rejected with the adapter's own error before any
    ///      balance or allowance is touched — zero amounts are enough to prove each
    ///      entrypoint is wired. Kills any drop-the-modifier mutant per entrypoint.
    function test_all13PoolEntrypointsEnforceTheGate() public {
        _gate();
        _listMarket(address(combinedAdapter));
        bytes memory rejection = abi.encodeWithSelector(ForSelfCommon.CallerNotWhitelisted.selector, POOL_ID, safe);
        uint256 deadline = block.timestamp;

        vm.startPrank(safe);
        vm.expectRevert(rejection);
        combinedAdapter.depositForSelf(CorkPoolForSelfBase.DepositForSelfParams(POOL_ID, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.mintForSelf(CorkPoolForSelfBase.MintForSelfParams(POOL_ID, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.unwindSwapForSelf(CorkPoolForSelfBase.UnwindSwapForSelfParams(POOL_ID, 0, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.unwindExerciseForSelf(
            CorkPoolForSelfBase.UnwindExerciseForSelfParams(POOL_ID, 0, 0, 0, deadline)
        );
        vm.expectRevert(rejection);
        combinedAdapter.unwindExerciseOtherForSelf(
            CorkPoolForSelfBase.UnwindExerciseOtherForSelfParams(POOL_ID, 0, 0, 0, deadline)
        );
        vm.expectRevert(rejection);
        combinedAdapter.swapForSelf(CorkPoolForSelfBase.SwapForSelfParams(POOL_ID, 0, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.exerciseForSelf(CorkPoolForSelfBase.ExerciseForSelfParams(POOL_ID, 0, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.exerciseOtherForSelf(
            CorkPoolForSelfBase.ExerciseOtherForSelfParams(POOL_ID, 0, 0, 0, deadline)
        );
        vm.expectRevert(rejection);
        combinedAdapter.unwindDepositForSelf(CorkPoolForSelfBase.UnwindDepositForSelfParams(POOL_ID, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.unwindMintForSelf(CorkPoolForSelfBase.UnwindMintForSelfParams(POOL_ID, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.redeemForSelf(CorkPoolForSelfBase.RedeemForSelfParams(POOL_ID, 0, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.withdrawForSelf(CorkPoolForSelfBase.WithdrawForSelfParams(POOL_ID, 0, 0, deadline));
        vm.expectRevert(rejection);
        combinedAdapter.withdrawOtherForSelf(CorkPoolForSelfBase.WithdrawOtherForSelfParams(POOL_ID, 0, 0, deadline));
        vm.stopPrank();
    }

    ///====== THE FILL PATH ======///

    function _sellCstOrder() internal returns (IOrderMixinMinimal.Order memory order, bytes memory signature) {
        // Maker inventory: seed shares as a listed participant, hand them to the maker.
        _listMarket(safe); // may be redundant per test; harmless when already listed
        uint256 sharesOut = _seedShares(combinedAdapter, 20e18);
        vm.prank(safe);
        assertTrue(IERC20(cst).transfer(maker, sharesOut / 2), "seed maker");
        vm.prank(maker);
        IERC20(cst).approve(LOP, type(uint256).max);

        order = IOrderMixinMinimal.Order({
            salt: 7,
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(cst)),
            takerAsset: uint256(uint160(collateralAsset)),
            makingAmount: 1e18,
            takingAmount: 0.1e18,
            makerTraits: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, combinedAdapter.LOP().hashOrder(order));
        signature = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));
    }

    function _fillParams(IOrderMixinMinimal.Order memory order, bytes memory signature)
        internal
        view
        returns (CorkLopFillForSelfBase.FillOrderForSelfParams memory)
    {
        return CorkLopFillForSelfBase.FillOrderForSelfParams({
            poolId: POOL_ID,
            order: order,
            signature: signature,
            amount: 0.1e18,
            takerTraits: 0,
            extension: "",
            deadline: block.timestamp
        });
    }

    /// @dev The fill path enforces the same gate (post-fill, JIT-compatible placement):
    ///      a gated market rejects an unlisted taker with the adapter's own error, and
    ///      the revert unwinds the payment the fill had already moved.
    function test_fillPathRejectsUnlistedTakerOnGatedMarket() public {
        (IOrderMixinMinimal.Order memory order, bytes memory signature) = _sellCstOrder();
        _gate(); // gate AFTER seeding so the maker inventory setup stays simple

        address taker = makeAddr("unlisted-taker");
        deal(collateralAsset, taker, 0.1e18);
        vm.startPrank(taker);
        IERC20(collateralAsset).approve(address(combinedAdapter), 0.1e18);
        vm.expectRevert(abi.encodeWithSelector(ForSelfCommon.CallerNotWhitelisted.selector, POOL_ID, taker));
        combinedAdapter.fillOrderForSelf(_fillParams(order, signature));
        vm.stopPrank();

        assertEq(IERC20(collateralAsset).balanceOf(taker), 0.1e18, "payment unwound with the revert");
    }

    /// @dev And the admit half on the same order: a listed taker fills through the
    ///      gated market, the bought cST lands on the taker, and the adapter ends clean.
    function test_fillPathAdmitsListedTakerOnGatedMarket() public {
        (IOrderMixinMinimal.Order memory order, bytes memory signature) = _sellCstOrder();
        _gate();

        address taker = makeAddr("listed-taker");
        _listMarket(taker);
        deal(collateralAsset, taker, 0.1e18);
        uint256 cstBefore = IERC20(cst).balanceOf(taker);
        vm.startPrank(taker);
        IERC20(collateralAsset).approve(address(combinedAdapter), 0.1e18);
        (uint256 making,,) = combinedAdapter.fillOrderForSelf(_fillParams(order, signature));
        vm.stopPrank();

        assertEq(making, 1e18, "fill went through the gated market");
        assertEq(IERC20(cst).balanceOf(taker), cstBefore + 1e18, "bought cST landed on the taker");
        _assertAdapterClean(address(combinedAdapter));
    }
}
