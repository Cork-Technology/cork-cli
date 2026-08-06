// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {Market, MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";
import {ForkBase} from "./ForkBase.sol";

/// @dev Test-only view of the MarketRegistry 2.1.0 stack. These contracts are not part of
///      the adapter's own dependency surface — the wrapper never calls them — but a
///      just-in-time order's extension names them, and this suite builds such an order
///      from scratch, so it needs the same minimal views the maker's tooling uses.
interface IMarketRegistryMinimal {
    function lookupWrapper(address ca, address ref, uint8 mode) external view returns (address wrapper);
    function deploy(address ca, address ref, uint8 mode) external returns (address wrapper);
}

interface IMarketRecipeMinimal {
    function resolve(address ca, address ref, address rateOracle, bytes calldata additionalData)
        external
        view
        returns (RateConstraint memory constraint);
}

struct RateConstraint {
    uint256 rateMin;
    uint256 rateMax;
    uint256 rateChangePerDayMax;
    uint256 rateChangeCapacityMax;
}

interface ICorkControllerMinimal {
    struct PoolCreationParams {
        Market pool;
        uint256 unwindSwapFeePercentage;
        uint256 swapFeePercentage;
        bool isWhitelistEnabled;
    }

    function createNewPool(PoolCreationParams calldata params) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface IERC2612Minimal {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
}

/// @dev The wrapper against a REAL MarketRegistry 2.1.0 just-in-time order, end to end on
///      the live Arbitrum One deployment: the pool this order belongs to does not exist
///      when the fill begins — the maker's pre-interaction (the Cork JIT adapter carried
///      in the order extension) deploys nothing less than the whole market during the
///      fill, mints the cST being sold from the maker's collateral, and executes the
///      maker's ERC-2612 permit so the protocol can pull a token that was born seconds
///      earlier. The wrapper's part — the part this package owns — is that its market
///      binding, checked deliberately AFTER the fill, accepts exactly this order while
///      its target-forcing still lands the bought cover on the caller.
///
///      Everything is built in-test from live chain state (constraint via recipe.resolve,
///      the cST prediction via a create-then-unwind state snapshot, both signatures from
///      throwaway vm keys): no pinned artifacts, no mocks, valid at any fork block on
///      which the 2.1.0 stack is live and the adapter holds its controller roles
///      (granted on-chain 2026-08-04, block 491025419 — fork later than that).
///
///      Fixture addresses are the 2.1.0 registry stack on Arbitrum One (Cork publishes
///      the current set; these were verified on-chain 2026-08-03). The traded pair must
///      be registry-REGISTERED (the JIT flow refuses unregistered assets); sUSDe/sUSDS
///      is, and its price wrapper already exists — the test deploys it permissionlessly
///      if a fresh chain state ever lacks it, exactly as a fill would.
contract JitFill210Test is ForkBase {
    address internal constant MARKET_REGISTRY = 0x47C3AF38435Db64D9400c30575E4c10482c0752D;
    address internal constant JIT_ADAPTER = 0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B;
    address internal constant CONTROLLER = 0xdCC0388c68f85e65FA08dCb445B4d0927e9E6172;
    address internal constant LIQUIDITY_RECIPE = 0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D;
    /// @dev keccak256("POOL_CREATOR_ROLE") / keccak256("CONFIGURATOR_ROLE") on the controller.
    bytes32 internal constant POOL_CREATOR_ROLE = 0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52;
    bytes32 internal constant CONFIGURATOR_ROLE = 0x3b49a237fe2d18fa4d9642b8a0e065923cceb71b797783b619a030a61d848bf0;

    /// @dev The registered pair the just-in-time market is created over. sUSDe (also the
    ///      fixture pool's collateral) against sUSDS.
    address internal constant JIT_COLLATERAL = 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2;
    address internal constant JIT_REFERENCE = 0xdDb46999F8891663a8F2828d25298f70416d7610;

    // 1inch MakerTraitsLib flags (v4.3.4) — the two an extension-carrying order must set.
    uint256 internal constant _HAS_EXTENSION_FLAG = 1 << 249;
    uint256 internal constant _PRE_INTERACTION_CALL_FLAG = 1 << 252;

    bytes32 internal constant _PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 internal constant MAKER_PK = 0xC0FFEE01;
    address internal maker;

    uint256 internal constant MAKING = 0.05e18; // cST sold by the underwriter-maker
    uint256 internal constant TAKING = 0.01e18; // collateral premium paid by the safe-taker

    /// @dev Mirrors the JIT adapter's hook payload: abi.encode(JITMarketParams, Permit[]).
    ///      Field order is load-bearing — it must match the deployed adapter's decoder.
    struct JitMarketParams {
        address collateralAsset;
        address referenceAsset;
        uint256 expiryTimestamp;
        address recipe;
        uint256 rateOverride;
        RateConstraint constraint;
        bytes additionalData;
        uint256 swapFeePercentage;
        uint256 unwindSwapFeePercentage;
        bool enableJitMint;
    }

    struct Permit {
        address token;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function setUp() public override {
        super.setUp();
        maker = vm.addr(MAKER_PK);
        vm.etch(maker, ""); // pin the EOA fill branch even if the fork has code here
        // The whole flow rides on the governance grant that made the 2.1.0 fill path live.
        assertTrue(
            ICorkControllerMinimal(CONTROLLER).hasRole(POOL_CREATOR_ROLE, JIT_ADAPTER)
                && ICorkControllerMinimal(CONTROLLER).hasRole(CONFIGURATOR_ROLE, JIT_ADAPTER),
            "JIT adapter is missing its controller roles - fork a block past 491025419"
        );
    }

    /// @dev Everything one JIT order build needs to carry between its steps; a struct so
    ///      the builder stays within stack limits without losing named fields.
    struct JitBuild {
        address oracle;
        RateConstraint constraint;
        uint256 expiry;
        Market jitMarket;
        MarketId poolId;
        address predictedCst;
        bytes32 domainSeparator;
        uint256 permitNonce;
    }

    /// @dev Build a complete, signed 2.1.0 JIT sell-cover order against a market that does
    ///      not exist yet, from live chain state only. Returns everything a taker needs.
    function _buildJitOrder()
        internal
        returns (MarketId poolId, address predictedCst, IOrderMixinMinimal.Order memory order, bytes memory extension)
    {
        JitBuild memory b;

        // 1) The pair's mode-keyed price wrapper — deploy permissionlessly if absent (the
        //    fill would do the same; deploy is idempotent).
        b.oracle = IMarketRegistryMinimal(MARKET_REGISTRY).lookupWrapper(JIT_COLLATERAL, JIT_REFERENCE, 0);
        if (b.oracle == address(0) || b.oracle.code.length == 0) {
            b.oracle = IMarketRegistryMinimal(MARKET_REGISTRY).deploy(JIT_COLLATERAL, JIT_REFERENCE, 0);
        }

        // 2) The constraint, resolved the same way the maker's tooling resolves it off-chain
        //    at signing time. With a deployed oracle the liquidity recipe takes no payload.
        b.constraint = IMarketRecipeMinimal(LIQUIDITY_RECIPE).resolve(JIT_COLLATERAL, JIT_REFERENCE, b.oracle, "");

        // 3) The derived market identity — pinned the moment the order is signed. A fresh
        //    expiry guarantees a pool id nothing on-chain has used.
        b.expiry = block.timestamp + 30 days;
        b.jitMarket = Market({
            collateralAsset: JIT_COLLATERAL,
            referenceAsset: JIT_REFERENCE,
            expiryTimestamp: b.expiry,
            rateMin: b.constraint.rateMin,
            rateMax: b.constraint.rateMax,
            rateChangePerDayMax: b.constraint.rateChangePerDayMax,
            rateChangeCapacityMax: b.constraint.rateChangeCapacityMax,
            rateOracle: b.oracle
        });
        b.poolId = MarketId.wrap(keccak256(abi.encode(b.jitMarket)));
        (, address preexisting) = cork.shares(b.poolId);
        assertEq(preexisting, address(0), "derived pool unexpectedly exists already");

        _predictCst(b);
        extension = _buildExtension(b, _signPermit(b));

        // The order. OrderLib requires the salt's low 160 bits to commit to the
        // extension, and the pre-interaction only runs if its makerTraits flag is set.
        order = IOrderMixinMinimal.Order({
            salt: (1 << 160) | uint160(uint256(keccak256(extension))),
            maker: uint256(uint160(maker)),
            receiver: 0,
            makerAsset: uint256(uint160(b.predictedCst)),
            takerAsset: uint256(uint160(JIT_COLLATERAL)),
            makingAmount: MAKING,
            takingAmount: TAKING,
            makerTraits: _HAS_EXTENSION_FLAG | _PRE_INTERACTION_CALL_FLAG
        });
        poolId = b.poolId;
        predictedCst = b.predictedCst;
    }

    /// @dev Predict the cST and read its ERC-2612 domain by actually creating the pool in
    ///      a state snapshot and unwinding it — the same in-memory creation the maker's
    ///      tooling simulates. Addresses are nonce-derived, so the real creation during
    ///      the fill (same chain state, same order of operations) reproduces them.
    function _predictCst(JitBuild memory b) internal {
        uint256 snapshot = vm.snapshotState();
        vm.prank(JIT_ADAPTER);
        ICorkControllerMinimal(CONTROLLER).createNewPool(
            ICorkControllerMinimal.PoolCreationParams({
                pool: b.jitMarket,
                unwindSwapFeePercentage: 0,
                swapFeePercentage: 0,
                isWhitelistEnabled: false
            })
        );
        (, b.predictedCst) = cork.shares(b.poolId);
        assertTrue(b.predictedCst != address(0), "snapshot creation produced no cST");
        b.domainSeparator = IERC2612Minimal(b.predictedCst).DOMAIN_SEPARATOR();
        b.permitNonce = IERC2612Minimal(b.predictedCst).nonces(maker);
        vm.revertToState(snapshot);
    }

    /// @dev The maker's ERC-2612 permit over the not-yet-existing cST (spender = the LOP,
    ///      which pulls the freshly minted maker asset during the fill).
    function _signPermit(JitBuild memory b) internal view returns (Permit[] memory permits) {
        bytes32 permitDigest = keccak256(
            abi.encodePacked(
                hex"1901",
                b.domainSeparator,
                keccak256(abi.encode(_PERMIT_TYPEHASH, maker, LOP, MAKING, b.permitNonce, b.expiry))
            )
        );
        (uint8 pv, bytes32 pr, bytes32 ps) = vm.sign(MAKER_PK, permitDigest);
        permits = new Permit[](1);
        permits[0] = Permit({token: b.predictedCst, value: MAKING, deadline: b.expiry, v: pv, r: pr, s: ps});
    }

    /// @dev The order extension: ExtensionLib layout — one 32-byte word of eight
    ///      cumulative uint32 END offsets, then the concatenated fields. The only field
    ///      here is PreInteractionData (index 6) = JIT adapter address ++ its payload, so
    ///      slots 6 and 7 both carry that field's end.
    function _buildExtension(JitBuild memory b, Permit[] memory permits) internal pure returns (bytes memory) {
        bytes memory preInteraction = abi.encodePacked(
            JIT_ADAPTER,
            abi.encode(
                JitMarketParams({
                    collateralAsset: JIT_COLLATERAL,
                    referenceAsset: JIT_REFERENCE,
                    expiryTimestamp: b.expiry,
                    recipe: LIQUIDITY_RECIPE,
                    rateOverride: 0,
                    constraint: b.constraint,
                    additionalData: "",
                    swapFeePercentage: 0,
                    unwindSwapFeePercentage: 0,
                    enableJitMint: true // the maker sells cST it does not hold yet
                }),
                permits
            )
        );
        uint256 offsets = (preInteraction.length << (32 * 6)) | (preInteraction.length << (32 * 7));
        return abi.encodePacked(bytes32(offsets), preInteraction);
    }

    function _sign65(IOrderMixinMinimal.Order memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_PK, lopAdapter.LOP().hashOrder(order));
        return abi.encodePacked(r, s, v);
    }

    /// @dev The headline: a caged Safe buys just-in-time cover through the wrapper. The
    ///      market is created inside the fill; the wrapper's post-fill binding admits it;
    ///      the cover lands on the caller and the wrapper ends holding nothing.
    function test_jitOrder_fillThroughWrapper_createsMarketAndDeliversCoverToCaller() public {
        (MarketId poolId, address predictedCst, IOrderMixinMinimal.Order memory order, bytes memory extension) =
            _buildJitOrder();

        // The maker's collateral funds the just-in-time mint (the JIT adapter pulls it
        // during the pre-interaction); the safe pays the premium through the wrapper.
        deal(JIT_COLLATERAL, maker, 1e18);
        vm.prank(maker);
        IERC20(JIT_COLLATERAL).approve(JIT_ADAPTER, type(uint256).max);
        deal(JIT_COLLATERAL, safe, TAKING);

        vm.startPrank(safe);
        IERC20(JIT_COLLATERAL).approve(address(lopAdapter), TAKING);
        (uint256 making, uint256 taking,) = lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: poolId,
                order: order,
                signature: _sign65(order),
                amount: TAKING, // taking-amount mode: pay exactly the premium
                takerTraits: 0,
                extension: extension,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(making, MAKING, "full making amount");
        assertEq(taking, TAKING, "full taking amount");

        // The market now exists at the identity the order pinned, with the predicted cST.
        (, address createdCst) = cork.shares(poolId);
        assertEq(createdCst, predictedCst, "created cST differs from the snapshot prediction");
        assertEq(cork.market(poolId).collateralAsset, JIT_COLLATERAL, "created market readable at the derived id");

        // Target-forcing held through the JIT path: the cover is the CALLER's, every
        // freshly minted share was delivered (none stuck on the maker or the wrapper),
        // and the safe's premium left in full. With the wrapper and the protocol holding
        // no user funds, conservation puts that premium with the maker.
        assertEq(IERC20(predictedCst).balanceOf(safe), MAKING, "cover delivered to the caller");
        assertEq(IERC20(predictedCst).balanceOf(maker), 0, "maker sold everything it minted");
        assertEq(IERC20(predictedCst).balanceOf(address(lopAdapter)), 0, "wrapper holds no cST");
        assertEq(IERC20(JIT_COLLATERAL).balanceOf(address(lopAdapter)), 0, "wrapper holds no collateral");
        assertEq(IERC20(JIT_COLLATERAL).balanceOf(safe), 0, "premium spent exactly");
        assertEq(IERC20(JIT_COLLATERAL).allowance(address(lopAdapter), LOP), 0, "no live LOP allowance");
    }

    /// @dev Deferring the market binding until after the fill must not weaken it: the same
    ///      genuine JIT fill presented under the WRONG pool id still reverts, unwinding
    ///      the created market, the mint, and the payment together.
    function test_jitOrder_wrongPoolIdStillReverts() public {
        (, , IOrderMixinMinimal.Order memory order, bytes memory extension) = _buildJitOrder();

        deal(JIT_COLLATERAL, maker, 1e18);
        vm.prank(maker);
        IERC20(JIT_COLLATERAL).approve(JIT_ADAPTER, type(uint256).max);
        deal(JIT_COLLATERAL, safe, TAKING);

        // Sign BEFORE the cheatcode: _sign65 makes an external hashOrder call, which
        // would otherwise consume the expectRevert.
        bytes memory signature = _sign65(order);

        vm.startPrank(safe);
        IERC20(JIT_COLLATERAL).approve(address(lopAdapter), TAKING);
        vm.expectPartialRevert(CorkLopFillForSelfBase.OrderAssetsNotInMarket.selector);
        lopAdapter.fillOrderForSelf(
            CorkLopFillForSelfBase.FillOrderForSelfParams({
                poolId: POOL_ID, // a real pool — but not the one this order creates
                order: order,
                signature: signature,
                amount: TAKING,
                takerTraits: 0,
                extension: extension,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();

        assertEq(IERC20(JIT_COLLATERAL).balanceOf(safe), TAKING, "payment unwound with the revert");
    }
}
