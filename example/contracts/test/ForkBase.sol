// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {CorkForSelfAdapter} from "../src/CorkForSelfAdapter.sol";
import {CorkLopFillForSelfAdapter} from "../src/CorkLopFillForSelfAdapter.sol";
import {CorkPoolForSelfAdapter} from "../src/CorkPoolForSelfAdapter.sol";
import {CorkPoolForSelfBase} from "../src/base/CorkPoolForSelfBase.sol";
import {ICorkPoolManagerMinimal, Market, MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";

/// @dev Shared harness for the Arbitrum One fork tests. Run with:
///        forge test --fork-url "$ARBITRUM_RPC_URL"
///      No RPC endpoint is committed; every test asserts it is on chain id 42161.
///
///      Live fixtures (captured 2026-07-28; refresh procedure in the README):
///      - CorkPoolManager and the 1inch LOP v4 are the production Arbitrum deployments.
///      - POOL_ID is a live, unexpired sUSDe pool listed by api-phoenix.cork.tech.
abstract contract ForkBase is Test {
    address internal constant POOL_MANAGER = 0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2;
    /// @dev The WhitelistManager proxy PAIRED with POOL_MANAGER — its set-once
    ///      `CORK_POOL_MANAGER()` reverse pointer reads POOL_MANAGER on-chain (verified
    ///      live 2026-08-07), which is what the adapter constructor enforces.
    address internal constant WHITELIST_MANAGER = 0xeC187bA7BBd4016d8db326ea1DFb3DD48d17Bd3A;
    address internal constant LOP = 0x111111125421cA6dc452d289314280a0f8842A65;
    MarketId internal constant POOL_ID =
        MarketId.wrap(0xd68978649ebc410d7f1825cae666483d300ca4e6905531df029687d2c19fe259);

    ICorkPoolManagerMinimal internal cork = ICorkPoolManagerMinimal(POOL_MANAGER);

    CorkPoolForSelfAdapter internal poolAdapter;
    CorkLopFillForSelfAdapter internal lopAdapter;
    CorkForSelfAdapter internal combinedAdapter;

    address internal safe;
    address internal collateralAsset;
    address internal referenceAsset;
    address internal cpt;
    address internal cst;
    Market internal marketParams;

    function setUp() public virtual {
        require(block.chainid == 42_161, "run with --fork-url <Arbitrum One RPC>");
        poolAdapter = new CorkPoolForSelfAdapter(POOL_MANAGER, WHITELIST_MANAGER);
        lopAdapter = new CorkLopFillForSelfAdapter(POOL_MANAGER, WHITELIST_MANAGER, LOP);
        combinedAdapter = new CorkForSelfAdapter(POOL_MANAGER, WHITELIST_MANAGER, LOP);

        safe = makeAddr("safe");
        marketParams = cork.market(POOL_ID);
        collateralAsset = marketParams.collateralAsset;
        referenceAsset = marketParams.referenceAsset;
        (cpt, cst) = cork.shares(POOL_ID);
    }

    /// @dev Seed the safe with share pairs (and the pool with locked collateral) by
    ///      depositing through the pool adapter — the same path a real Safe would use.
    function _seedShares(CorkPoolForSelfBase adapter, uint256 collateralAmount) internal returns (uint256 sharesOut) {
        deal(collateralAsset, safe, IERC20(collateralAsset).balanceOf(safe) + collateralAmount);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(adapter), collateralAmount);
        sharesOut = adapter.depositForSelf(
            CorkPoolForSelfBase.DepositForSelfParams({
                poolId: POOL_ID,
                collateralAssetsIn: collateralAmount,
                minCptAndCstSharesOut: 0,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    /// @dev Seed the pool's reference-asset reserves (needed by unwind flows) by
    ///      exercising some of the safe's cST through the adapter.
    function _seedPoolReference(CorkPoolForSelfBase adapter, uint256 cstSharesIn, uint256 maxReferenceAssetsIn)
        internal
    {
        deal(referenceAsset, safe, IERC20(referenceAsset).balanceOf(safe) + maxReferenceAssetsIn);
        vm.startPrank(safe);
        IERC20(cst).approve(address(adapter), cstSharesIn);
        IERC20(referenceAsset).approve(address(adapter), maxReferenceAssetsIn);
        adapter.exerciseForSelf(
            CorkPoolForSelfBase.ExerciseForSelfParams({
                poolId: POOL_ID,
                cstSharesIn: cstSharesIn,
                maxReferenceAssetsIn: maxReferenceAssetsIn,
                minCollateralAssetsOut: 0,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    /// @dev The custody-free invariant: after any flow the adapter holds nothing and has
    ///      no live allowance to either protocol.
    function _assertAdapterClean(address adapter) internal view {
        assertEq(IERC20(collateralAsset).balanceOf(adapter), 0, "residual collateral");
        assertEq(IERC20(referenceAsset).balanceOf(adapter), 0, "residual reference");
        assertEq(IERC20(cpt).balanceOf(adapter), 0, "residual cPT");
        assertEq(IERC20(cst).balanceOf(adapter), 0, "residual cST");
        assertEq(IERC20(collateralAsset).allowance(adapter, POOL_MANAGER), 0, "live CA allowance to pool manager");
        assertEq(IERC20(referenceAsset).allowance(adapter, POOL_MANAGER), 0, "live REF allowance to pool manager");
        // The share tokens are never approved to the pool manager, by anyone, ever: it
        // moves cST out of its own caller with a gated overload that skips the allowance
        // check (sender == owner), and burns shares against the allowance granted to
        // ITSELF as caller. A cST/cPT approval to the pool manager would be dead weight.
        assertEq(IERC20(cst).allowance(adapter, POOL_MANAGER), 0, "cST never needs a pool-manager allowance");
        assertEq(IERC20(cpt).allowance(adapter, POOL_MANAGER), 0, "cPT never needs a pool-manager allowance");
        assertEq(IERC20(collateralAsset).allowance(adapter, LOP), 0, "live CA allowance to LOP");
        assertEq(IERC20(cst).allowance(adapter, LOP), 0, "live cST allowance to LOP");
    }
}
