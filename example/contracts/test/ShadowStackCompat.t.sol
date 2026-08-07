// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {CorkForSelfAdapter} from "../src/CorkForSelfAdapter.sol";
import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {CorkPoolForSelfBase} from "../src/base/CorkPoolForSelfBase.sol";
import {ForSelfCommon} from "../src/base/ForSelfCommon.sol";
import {ICorkPoolManagerMinimal, Market, MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";

interface IShadowControllerMinimal {
    struct PoolCreationParams {
        Market pool;
        uint256 unwindSwapFeePercentage;
        uint256 swapFeePercentage;
        bool isWhitelistEnabled;
    }

    function createNewPool(PoolCreationParams calldata params) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface ISharesFactoryMinimal {
    /// @dev NEW on the shadow generation: native deterministic clone-address prediction.
    function predictPoolShares(MarketId poolId) external view returns (address principalToken, address swapToken);
}

interface IWhitelistManagerViews {
    function isMarketWhitelistEnabled(MarketId poolId) external view returns (bool);
    function addToMarketWhitelist(MarketId poolId, address[] calldata accounts) external;
    function CORK_POOL_MANAGER() external view returns (address);
}

/// @dev THE re-test the Distribution thread asked for: the ForSelf adapter against the
///      NEW phoenix stack (the live-shadow deployment, phoenix commit c8172892 — the
///      "market-extension changes": PoolShare becomes an EIP-1167 clone behind a shared
///      implementation, SharesFactory gains deterministic domain-salted clone addresses,
///      the controller splits fees into FEE_MANAGER_ROLE). Everything here is the REAL
///      shadow deployment on an Arbitrum One fork: real pool manager proxy, real
///      controller, real SharesFactory clones, real WhitelistManager, real 1inch LOP,
///      and the market's rate oracle is the LIVE production oracle reused verbatim
///      (the oracle interface is unchanged between generations).
///
///      Two pieces of state are forged, both self-validating: POOL_CREATOR_ROLE for the
///      test's creator address (no grants exist on the shadow controller yet — slot
///      write, validated through the real hasRole), and the whitelist gate flip (same
///      technique as WhitelistGate.t.sol, validated through the real getter).
contract ShadowStackCompatTest is Test {
    // The live-shadow stack (campaign phoenix-forself-extension-20260808-r1), addresses
    // chain-verified 2026-08-07 against Filip's shadow-release bundle.
    address internal constant SHADOW_PM = 0x02803Bb52D2184f906F45B50C66AA969C2E37263;
    address internal constant SHADOW_CONTROLLER = 0x6b65D663e0B445BAf1870D5af806d57Ebb2C82A1;
    address internal constant SHADOW_WLM = 0xEEd30E98abDC4da6d9Ac15c1184C9d046cA0Ccd6;
    address internal constant SHADOW_SHARES_FACTORY = 0x9996FCFa7b62fb7C5e7870dae06FFB2a7cE63b22;
    address internal constant LOP = 0x111111125421cA6dc452d289314280a0f8842A65;

    // The OLD (live production) pool manager + pool, used ONLY as the source of real
    // market parameters — assets and rate oracle are shared between generations.
    address internal constant OLD_PM = 0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2;
    MarketId internal constant OLD_POOL_ID =
        MarketId.wrap(0xd68978649ebc410d7f1825cae666483d300ca4e6905531df029687d2c19fe259);

    bytes32 internal constant POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE");
    /// @dev ERC-7201 base of WhitelistManagerStorage (same source as WhitelistGate.t.sol).
    bytes32 internal constant WLM_STORAGE_BASE = 0x0da519c821e1a8f2910e4e535b0245b25f0e3189410accd869caacafbf3ff700;

    ICorkPoolManagerMinimal internal cork = ICorkPoolManagerMinimal(SHADOW_PM);
    CorkForSelfAdapter internal adapter;

    address internal safe;
    address internal creator;
    Market internal marketParams;
    MarketId internal poolId;
    address internal collateralAsset;
    address internal referenceAsset;
    address internal cpt;
    address internal cst;

    uint256 internal constant MAKER_PK = 0xCAFE;
    address internal maker;

    function setUp() public {
        require(block.chainid == 42_161, "run with --fork-url <Arbitrum One RPC>");
        safe = makeAddr("safe");
        creator = makeAddr("pool-creator");
        maker = vm.addr(MAKER_PK);
        vm.etch(maker, "");

        // The constructor's pairing self-check runs against the REAL shadow reverse
        // pointer here — this deploy succeeding is itself part of the compatibility
        // verdict.
        adapter = new CorkForSelfAdapter(SHADOW_PM, SHADOW_WLM, LOP);

        // Real market parameters: the live production pool's assets, rate band, and
        // rate oracle, verbatim — only the expiry differs (fresh id, live window).
        Market memory live = ICorkPoolManagerMinimal(OLD_PM).market(OLD_POOL_ID);
        marketParams = live;
        marketParams.expiryTimestamp = block.timestamp + 30 days;
        poolId = MarketId.wrap(keccak256(abi.encode(marketParams)));
        collateralAsset = marketParams.collateralAsset;
        referenceAsset = marketParams.referenceAsset;

        // Grant POOL_CREATOR_ROLE by slot write (OZ AccessControl: _roles at slot 0;
        // member flag at keccak(account, keccak(role, 0))), validated through the real
        // hasRole so an AccessControl layout drift can never fake the grant.
        bytes32 memberSlot = keccak256(abi.encode(creator, keccak256(abi.encode(POOL_CREATOR_ROLE, uint256(0)))));
        vm.store(SHADOW_CONTROLLER, memberSlot, bytes32(uint256(1)));
        assertTrue(
            IShadowControllerMinimal(SHADOW_CONTROLLER).hasRole(POOL_CREATOR_ROLE, creator),
            "role slot math no longer matches the deployed controller"
        );

        // The new factory's native prediction, BEFORE creation — then create and compare.
        (address predictedCpt, address predictedCst) =
            ISharesFactoryMinimal(SHADOW_SHARES_FACTORY).predictPoolShares(poolId);
        vm.prank(creator);
        IShadowControllerMinimal(SHADOW_CONTROLLER)
            .createNewPool(
                IShadowControllerMinimal.PoolCreationParams({
                pool: marketParams, unwindSwapFeePercentage: 0, swapFeePercentage: 0, isWhitelistEnabled: false
            })
            );
        (cpt, cst) = cork.shares(poolId);
        assertTrue(cst != address(0), "pool creation on the shadow stack produced no cST");
        assertEq(cpt, predictedCpt, "predictPoolShares cPT diverges from the deployed clone");
        assertEq(cst, predictedCst, "predictPoolShares cST diverges from the deployed clone");
    }

    function _deposit(uint256 amount) internal returns (uint256 sharesOut) {
        deal(collateralAsset, safe, IERC20(collateralAsset).balanceOf(safe) + amount);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(adapter), amount);
        sharesOut = adapter.depositForSelf(
            CorkPoolForSelfBase.DepositForSelfParams({
                poolId: poolId, collateralAssetsIn: amount, minCptAndCstSharesOut: 0, deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    function _assertAdapterClean() internal view {
        assertEq(IERC20(collateralAsset).balanceOf(address(adapter)), 0, "residual collateral");
        assertEq(IERC20(referenceAsset).balanceOf(address(adapter)), 0, "residual reference");
        assertEq(IERC20(cst).balanceOf(address(adapter)), 0, "residual cST");
        assertEq(IERC20(cpt).balanceOf(address(adapter)), 0, "residual cPT");
        assertEq(IERC20(collateralAsset).allowance(address(adapter), SHADOW_PM), 0, "live CA allowance");
        assertEq(IERC20(collateralAsset).allowance(address(adapter), LOP), 0, "live CA allowance to LOP");
    }

    /// @dev Group A against the new stack: deposit mints CLONE shares straight to the
    ///      caller through the adapter.
    function test_depositMintsCloneSharesToCaller() public {
        uint256 sharesOut = _deposit(100e18);
        assertGt(sharesOut, 0, "no shares minted");
        assertEq(IERC20(cst).balanceOf(safe), sharesOut, "cST clone balance");
        assertEq(IERC20(cpt).balanceOf(safe), sharesOut, "cPT clone balance");
        // The shares really are EIP-1167 clones — the runtime is the 45-byte proxy.
        assertEq(cst.code.length, 45, "cST is not a minimal proxy clone");
        _assertAdapterClean();
    }

    /// @dev Group B against the new stack: exercise moves clone cST through the pool
    ///      manager's gated no-allowance path and pulls the reference leg.
    function test_exerciseAgainstCloneShares() public {
        uint256 sharesOut = _deposit(100e18);
        uint256 slice = sharesOut / 4;
        uint256 refCap = 10 ** 30; // generous cap; the unspent remainder sweeps back
        deal(referenceAsset, safe, refCap);
        uint256 caBefore = IERC20(collateralAsset).balanceOf(safe);
        vm.startPrank(safe);
        IERC20(cst).approve(address(adapter), slice);
        IERC20(referenceAsset).approve(address(adapter), refCap);
        (uint256 caOut,,) = adapter.exerciseForSelf(
            CorkPoolForSelfBase.ExerciseForSelfParams({
                poolId: poolId,
                cstSharesIn: slice,
                maxReferenceAssetsIn: refCap,
                minCollateralAssetsOut: 1,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(caOut, 0, "exercise returned no collateral");
        assertEq(IERC20(collateralAsset).balanceOf(safe), caBefore + caOut, "collateral to caller");
        _assertAdapterClean();
    }

    /// @dev Group C against the new stack: zero-custody share burn straight from the
    ///      caller (the clone's burnFrom path under the caller's allowance to the adapter).
    function test_unwindMintBurnsClonesFromCaller() public {
        uint256 sharesOut = _deposit(100e18);
        uint256 slice = sharesOut / 4;
        vm.startPrank(safe);
        IERC20(cpt).approve(address(adapter), slice);
        IERC20(cst).approve(address(adapter), slice);
        uint256 caOut = adapter.unwindMintForSelf(
            CorkPoolForSelfBase.UnwindMintForSelfParams({
                poolId: poolId, cptAndCstSharesIn: slice, minCollateralAssetsOut: 1, deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(caOut, 0, "unwind returned no collateral");
        _assertAdapterClean();
    }

    /// @dev The fill surface against the new stack: a real 1inch LOP fill of clone cST
    ///      against collateral, market-bound to the shadow pool, target-forced to the
    ///      caller.
    function test_lopFillOfCloneSharesThroughRealOneInch() public {
        uint256 sharesOut = _deposit(100e18);
        vm.prank(safe);
        assertTrue(IERC20(cst).transfer(maker, sharesOut / 2), "seed maker");
        vm.prank(maker);
        IERC20(cst).approve(LOP, type(uint256).max);

        IOrderMixinMinimal.Order memory order = IOrderMixinMinimal.Order({
            salt: 42,
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(cst)),
            takerAsset: uint256(uint160(collateralAsset)),
            makingAmount: 1e18,
            takingAmount: 0.1e18,
            makerTraits: 0
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, adapter.LOP().hashOrder(order));
        bytes memory signature = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));

        address taker = makeAddr("taker");
        deal(collateralAsset, taker, 0.1e18);
        vm.startPrank(taker);
        IERC20(collateralAsset).approve(address(adapter), 0.1e18);
        (uint256 making,,) = adapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: poolId,
                order: order,
                signature: signature,
                amount: 0.1e18,
                takerTraits: 0,
                extension: "",
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertEq(making, 1e18, "fill did not go through");
        assertEq(IERC20(cst).balanceOf(taker), 1e18, "bought clone cST landed on the taker");
        _assertAdapterClean();
    }

    /// @dev The caller-whitelist gate against the SHADOW WhitelistManager: gate the new
    ///      pool (slot write, getter-validated), list via the shadow WLM's real
    ///      controller-role holder, reject the unlisted and admit the listed.
    function test_callerGateAgainstShadowWhitelistManager() public {
        IWhitelistManagerViews wlm = IWhitelistManagerViews(SHADOW_WLM);
        assertEq(wlm.CORK_POOL_MANAGER(), SHADOW_PM, "shadow WLM reverse pointer moved");

        bytes32 slot = keccak256(abi.encode(poolId, uint256(WLM_STORAGE_BASE) + 3));
        vm.store(SHADOW_WLM, slot, bytes32(uint256(1)));
        assertTrue(wlm.isMarketWhitelistEnabled(poolId), "slot math no longer matches the shadow WLM");

        deal(collateralAsset, safe, 1e18);
        vm.startPrank(safe);
        IERC20(collateralAsset).approve(address(adapter), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ForSelfCommon.CallerNotWhitelisted.selector, poolId, safe));
        adapter.depositForSelf(
            CorkPoolForSelfBase.DepositForSelfParams({
                poolId: poolId, collateralAssetsIn: 1e18, minCptAndCstSharesOut: 0, deadline: block.timestamp
            })
        );
        vm.stopPrank();

        // Admit both layers through the shadow WLM's real role holder (the shadow
        // controller — CORK_CONTROLLER_ROLE verified held, 2026-08-07).
        address[] memory accounts = new address[](2);
        accounts[0] = safe;
        accounts[1] = address(adapter);
        vm.prank(SHADOW_CONTROLLER);
        wlm.addToMarketWhitelist(poolId, accounts);

        uint256 sharesOut = _deposit(1e18);
        assertGt(sharesOut, 0, "listed Safe blocked on the gated shadow pool");
    }
}
