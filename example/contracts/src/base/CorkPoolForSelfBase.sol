// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MarketId} from "../interfaces/ICorkPoolManagerMinimal.sol";
import {ForSelfCommon} from "./ForSelfCommon.sol";

/// @title CorkPoolForSelfBase
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Receiver-forcing ("ForSelf") twins of the 13 receiver-bearing CorkPoolManager
///         entrypoints, for accounts whose call policy is parameter-blind (e.g. a Safe
///         behind Smart Sessions whitelisting only (contract, selector) pairs).
///
///         The raw pool manager sends outputs to a free `receiver` parameter a selector
///         whitelist cannot see. Every function here removes that parameter structurally:
///         outputs always go to `msg.sender` (the calling Safe), owners are always
///         `msg.sender`, and this contract holds nothing between transactions.
///
///         Pull patterns (see README allowance matrix):
///         - Group A (deposit/mint/unwindSwap/unwindExercise*): collateral is pulled from
///           the caller, approved to the pool manager for the call, refunded if unspent.
///         - Group B (swap/exercise*): cST must be HELD by this contract at call time
///           (the pool manager moves it via a gated no-allowance transfer), so it is
///           pulled from the caller first; the reference asset is pulled and approved.
///         - Group C (unwindDeposit/unwindMint/redeem/withdraw*): zero-custody
///           pass-through — the pool manager burns shares straight from the caller by
///           spending the caller's share-token allowance to THIS contract.
///
///         Derived input amounts (the pool rate can move within the call) are handled as
///         pull-a-cap-then-refund, never preview-then-exact-pull.
///
///         When a market's whitelist is enabled, THIS contract's address must be
///         whitelisted (the pool manager checks its direct caller) — which, for a wrapper
///         SHARED by many accounts, opens that market to everyone. See the README's
///         shared-vs-per-account note before relying on a market whitelist.
///
///         Note the share tokens are never approved to the pool manager by anyone: it
///         moves cST out of its own caller with a gated overload that skips that check
///         when sender == owner, and burns shares against what was granted to itself as
///         caller. Callers authorise THIS contract instead (see the README matrix).
///
///         EXAMPLE CODE — the integrator must audit, vet, and deploy it themselves.
abstract contract CorkPoolForSelfBase is ForSelfCommon {
    using SafeERC20 for IERC20;

    ///====== GROUP A: ENTER + COVERAGE REVERSAL (collateral in) ======///

    struct DepositForSelfParams {
        MarketId poolId;
        uint256 collateralAssetsIn;
        uint256 minCptAndCstSharesOut;
        uint256 deadline;
    }

    /// @notice Deposit collateral; cPT + cST are minted directly to the caller.
    /// @param params Market, collateral in, minimum shares out, deadline.
    /// @return cptAndCstSharesOut Share pairs minted to the caller.
    function depositForSelf(DepositForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 cptAndCstSharesOut)
    {
        address collateralAsset = CORK.market(params.poolId).collateralAsset;
        _pull(collateralAsset, params.collateralAssetsIn);
        IERC20(collateralAsset).forceApprove(address(CORK), params.collateralAssetsIn);
        cptAndCstSharesOut = CORK.deposit(params.poolId, params.collateralAssetsIn, msg.sender);
        IERC20(collateralAsset).forceApprove(address(CORK), 0);
        require(cptAndCstSharesOut >= params.minCptAndCstSharesOut, SlippageExceeded());
        _sweep(collateralAsset);
    }

    struct MintForSelfParams {
        MarketId poolId;
        uint256 cptAndCstSharesOut;
        uint256 maxCollateralAssetsIn;
        uint256 deadline;
    }

    /// @notice Mint an exact number of share pairs to the caller; the collateral cost is
    ///         derived in-call, so `maxCollateralAssetsIn` is pulled and the unspent
    ///         remainder refunded.
    /// @param params Market, exact shares out, collateral cap, deadline.
    /// @return collateralAssetsIn Collateral actually spent; the rest is refunded.
    function mintForSelf(MintForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 collateralAssetsIn)
    {
        address collateralAsset = CORK.market(params.poolId).collateralAsset;
        _pull(collateralAsset, params.maxCollateralAssetsIn);
        IERC20(collateralAsset).forceApprove(address(CORK), params.maxCollateralAssetsIn);
        collateralAssetsIn = CORK.mint(params.poolId, params.cptAndCstSharesOut, msg.sender);
        IERC20(collateralAsset).forceApprove(address(CORK), 0);
        require(collateralAssetsIn <= params.maxCollateralAssetsIn, SlippageExceeded());
        _sweep(collateralAsset);
    }

    struct UnwindSwapForSelfParams {
        MarketId poolId;
        uint256 collateralAssetsIn;
        uint256 minCstSharesOut;
        uint256 minReferenceAssetsOut;
        uint256 deadline;
    }

    /// @notice Reverse of swap: pay exact collateral, receive cST + reference directly.
    /// @param params Market, collateral in, minimum outputs, deadline.
    /// @return cstSharesOut cST returned to the caller.
    /// @return referenceAssetsOut Reference assets returned to the caller.
    /// @return fee Protocol fee taken by the pool.
    function unwindSwapForSelf(UnwindSwapForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 cstSharesOut, uint256 referenceAssetsOut, uint256 fee)
    {
        address collateralAsset = CORK.market(params.poolId).collateralAsset;
        _pull(collateralAsset, params.collateralAssetsIn);
        IERC20(collateralAsset).forceApprove(address(CORK), params.collateralAssetsIn);
        (cstSharesOut, referenceAssetsOut, fee) = CORK.unwindSwap(params.poolId, params.collateralAssetsIn, msg.sender);
        IERC20(collateralAsset).forceApprove(address(CORK), 0);
        require(
            cstSharesOut >= params.minCstSharesOut && referenceAssetsOut >= params.minReferenceAssetsOut,
            SlippageExceeded()
        );
        _sweep(collateralAsset);
    }

    struct UnwindExerciseForSelfParams {
        MarketId poolId;
        uint256 cstSharesOut;
        uint256 maxCollateralAssetsIn;
        uint256 minReferenceAssetsOut;
        uint256 deadline;
    }

    /// @notice Reverse of exercise: recover an exact cST amount; the collateral cost is
    ///         derived in-call (cap pulled, remainder refunded).
    /// @param params Market, exact cST out, collateral cap, minimum reference, deadline.
    /// @return collateralAssetsIn Collateral actually spent; the rest is refunded.
    /// @return referenceAssetsOut Reference assets returned to the caller.
    /// @return fee Protocol fee taken by the pool.
    function unwindExerciseForSelf(UnwindExerciseForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 collateralAssetsIn, uint256 referenceAssetsOut, uint256 fee)
    {
        address collateralAsset = CORK.market(params.poolId).collateralAsset;
        _pull(collateralAsset, params.maxCollateralAssetsIn);
        IERC20(collateralAsset).forceApprove(address(CORK), params.maxCollateralAssetsIn);
        (collateralAssetsIn, referenceAssetsOut, fee) =
            CORK.unwindExercise(params.poolId, params.cstSharesOut, msg.sender);
        IERC20(collateralAsset).forceApprove(address(CORK), 0);
        require(
            collateralAssetsIn <= params.maxCollateralAssetsIn && referenceAssetsOut >= params.minReferenceAssetsOut,
            SlippageExceeded()
        );
        _sweep(collateralAsset);
    }

    struct UnwindExerciseOtherForSelfParams {
        MarketId poolId;
        uint256 referenceAssetsOut;
        uint256 maxCollateralAssetsIn;
        uint256 minCstSharesOut;
        uint256 deadline;
    }

    /// @notice Reverse of exerciseOther, pinned on the reference leg; collateral cost is
    ///         derived in-call (cap pulled, remainder refunded).
    /// @param params Market, exact reference out, collateral cap, minimum cST, deadline.
    /// @return collateralAssetsIn Collateral actually spent; the rest is refunded.
    /// @return cstSharesOut cST returned to the caller.
    /// @return fee Protocol fee taken by the pool.
    function unwindExerciseOtherForSelf(UnwindExerciseOtherForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 collateralAssetsIn, uint256 cstSharesOut, uint256 fee)
    {
        address collateralAsset = CORK.market(params.poolId).collateralAsset;
        _pull(collateralAsset, params.maxCollateralAssetsIn);
        IERC20(collateralAsset).forceApprove(address(CORK), params.maxCollateralAssetsIn);
        (collateralAssetsIn, cstSharesOut, fee) =
            CORK.unwindExerciseOther(params.poolId, params.referenceAssetsOut, msg.sender);
        IERC20(collateralAsset).forceApprove(address(CORK), 0);
        require(
            collateralAssetsIn <= params.maxCollateralAssetsIn && cstSharesOut >= params.minCstSharesOut,
            SlippageExceeded()
        );
        _sweep(collateralAsset);
    }

    ///====== GROUP B: COVERAGE (cST + reference in, collateral out) ======///

    struct SwapForSelfParams {
        MarketId poolId;
        uint256 collateralAssetsOut;
        uint256 maxCstSharesIn;
        uint256 maxReferenceAssetsIn;
        uint256 deadline;
    }

    /// @notice Take an exact collateral amount out (paid directly to the caller); both
    ///         input legs are derived in-call, so caps are pulled and refunded.
    /// @param params Market, exact collateral out, input caps, deadline.
    /// @return cstSharesIn cST actually spent; the rest is refunded.
    /// @return referenceAssetsIn Reference assets actually spent; the rest is refunded.
    /// @return fee Protocol fee taken by the pool.
    function swapForSelf(SwapForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 cstSharesIn, uint256 referenceAssetsIn, uint256 fee)
    {
        address referenceAsset = CORK.market(params.poolId).referenceAsset;
        (, address swapToken) = CORK.shares(params.poolId);
        _pull(swapToken, params.maxCstSharesIn);
        _pull(referenceAsset, params.maxReferenceAssetsIn);
        IERC20(referenceAsset).forceApprove(address(CORK), params.maxReferenceAssetsIn);
        (cstSharesIn, referenceAssetsIn, fee) = CORK.swap(params.poolId, params.collateralAssetsOut, msg.sender);
        IERC20(referenceAsset).forceApprove(address(CORK), 0);
        require(
            cstSharesIn <= params.maxCstSharesIn && referenceAssetsIn <= params.maxReferenceAssetsIn, SlippageExceeded()
        );
        _sweep(swapToken);
        _sweep(referenceAsset);
    }

    struct ExerciseForSelfParams {
        MarketId poolId;
        uint256 cstSharesIn;
        uint256 maxReferenceAssetsIn;
        uint256 minCollateralAssetsOut;
        uint256 deadline;
    }

    /// @notice Exercise an exact cST amount for collateral (paid directly to the caller);
    ///         the reference leg is derived in-call (cap pulled, remainder refunded).
    /// @param params Market, exact cST in, reference cap, minimum collateral, deadline.
    /// @return collateralAssetsOut Collateral paid to the caller.
    /// @return referenceAssetsIn Reference assets actually spent; the rest is refunded.
    /// @return fee Protocol fee taken by the pool.
    function exerciseForSelf(ExerciseForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 collateralAssetsOut, uint256 referenceAssetsIn, uint256 fee)
    {
        address referenceAsset = CORK.market(params.poolId).referenceAsset;
        (, address swapToken) = CORK.shares(params.poolId);
        _pull(swapToken, params.cstSharesIn);
        _pull(referenceAsset, params.maxReferenceAssetsIn);
        IERC20(referenceAsset).forceApprove(address(CORK), params.maxReferenceAssetsIn);
        (collateralAssetsOut, referenceAssetsIn, fee) = CORK.exercise(params.poolId, params.cstSharesIn, msg.sender);
        IERC20(referenceAsset).forceApprove(address(CORK), 0);
        require(
            collateralAssetsOut >= params.minCollateralAssetsOut && referenceAssetsIn <= params.maxReferenceAssetsIn,
            SlippageExceeded()
        );
        _sweep(swapToken);
        _sweep(referenceAsset);
    }

    struct ExerciseOtherForSelfParams {
        MarketId poolId;
        uint256 referenceAssetsIn;
        uint256 maxCstSharesIn;
        uint256 minCollateralAssetsOut;
        uint256 deadline;
    }

    /// @notice Exercise pinned on the reference leg; the cST leg is derived in-call
    ///         (cap pulled, remainder refunded).
    /// @param params Market, exact reference in, cST cap, minimum collateral, deadline.
    /// @return collateralAssetsOut Collateral paid to the caller.
    /// @return cstSharesIn cST actually spent; the rest is refunded.
    /// @return fee Protocol fee taken by the pool.
    function exerciseOtherForSelf(ExerciseOtherForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 collateralAssetsOut, uint256 cstSharesIn, uint256 fee)
    {
        address referenceAsset = CORK.market(params.poolId).referenceAsset;
        (, address swapToken) = CORK.shares(params.poolId);
        _pull(swapToken, params.maxCstSharesIn);
        _pull(referenceAsset, params.referenceAssetsIn);
        IERC20(referenceAsset).forceApprove(address(CORK), params.referenceAssetsIn);
        (collateralAssetsOut, cstSharesIn, fee) =
            CORK.exerciseOther(params.poolId, params.referenceAssetsIn, msg.sender);
        IERC20(referenceAsset).forceApprove(address(CORK), 0);
        require(
            collateralAssetsOut >= params.minCollateralAssetsOut && cstSharesIn <= params.maxCstSharesIn,
            SlippageExceeded()
        );
        _sweep(swapToken);
        _sweep(referenceAsset);
    }

    ///====== GROUP C: SHARE-BURNING EXITS (zero-custody pass-through) ======///
    // The pool manager burns shares straight from the caller (`owner = msg.sender`) by
    // spending the caller's share-token allowance to THIS contract; outputs go straight
    // to the caller (`receiver = msg.sender`). No token ever touches this contract.

    struct UnwindDepositForSelfParams {
        MarketId poolId;
        uint256 collateralAssetsOut;
        uint256 maxCptAndCstSharesIn;
        uint256 deadline;
    }

    /// @notice Pre-expiry exit for an exact collateral amount; burns caller's cPT + cST.
    /// @param params Market, exact collateral out, share cap, deadline.
    /// @return cptAndCstSharesIn Share pairs burned from the caller.
    function unwindDepositForSelf(UnwindDepositForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 cptAndCstSharesIn)
    {
        cptAndCstSharesIn = CORK.unwindDeposit(params.poolId, params.collateralAssetsOut, msg.sender, msg.sender);
        require(cptAndCstSharesIn <= params.maxCptAndCstSharesIn, SlippageExceeded());
    }

    struct UnwindMintForSelfParams {
        MarketId poolId;
        uint256 cptAndCstSharesIn;
        uint256 minCollateralAssetsOut;
        uint256 deadline;
    }

    /// @notice Pre-expiry exit burning an exact share amount from the caller.
    /// @dev The pool manager floors the burn to a multiple of the market's minimum
    ///      shares; any dust below that multiple simply stays with the caller.
    /// @param params Market, exact share pairs in, minimum collateral, deadline.
    /// @return collateralAssetsOut Collateral paid to the caller.
    function unwindMintForSelf(UnwindMintForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 collateralAssetsOut)
    {
        collateralAssetsOut = CORK.unwindMint(params.poolId, params.cptAndCstSharesIn, msg.sender, msg.sender);
        require(collateralAssetsOut >= params.minCollateralAssetsOut, SlippageExceeded());
    }

    struct RedeemForSelfParams {
        MarketId poolId;
        uint256 cptSharesIn;
        uint256 minReferenceAssetsOut;
        uint256 minCollateralAssetsOut;
        uint256 deadline;
    }

    /// @notice Post-expiry settlement burning an exact cPT amount from the caller.
    /// @param params Market, exact cPT in, minimum outputs, deadline.
    /// @return referenceAssetsOut Reference assets paid to the caller.
    /// @return collateralAssetsOut Collateral paid to the caller.
    function redeemForSelf(RedeemForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 referenceAssetsOut, uint256 collateralAssetsOut)
    {
        (referenceAssetsOut, collateralAssetsOut) =
            CORK.redeem(params.poolId, params.cptSharesIn, msg.sender, msg.sender);
        require(
            referenceAssetsOut >= params.minReferenceAssetsOut && collateralAssetsOut >= params.minCollateralAssetsOut,
            SlippageExceeded()
        );
    }

    struct WithdrawForSelfParams {
        MarketId poolId;
        uint256 collateralAssetsOut;
        uint256 maxCptSharesIn;
        uint256 deadline;
    }

    /// @notice Post-expiry settlement for an exact collateral amount; burns caller's cPT.
    /// @param params Market, exact collateral out, cPT cap, deadline.
    /// @return cptSharesIn cPT burned from the caller.
    /// @return actualCollateralAssetsOut Collateral paid to the caller.
    /// @return actualReferenceAssetsOut Reference assets paid to the caller.
    function withdrawForSelf(WithdrawForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut)
    {
        (cptSharesIn, actualCollateralAssetsOut, actualReferenceAssetsOut) =
            CORK.withdraw(params.poolId, params.collateralAssetsOut, msg.sender, msg.sender);
        require(cptSharesIn <= params.maxCptSharesIn, SlippageExceeded());
    }

    struct WithdrawOtherForSelfParams {
        MarketId poolId;
        uint256 referenceAssetsOut;
        uint256 maxCptSharesIn;
        uint256 deadline;
    }

    /// @notice Post-expiry settlement for an exact reference amount; burns caller's cPT.
    /// @param params Market, exact reference out, cPT cap, deadline.
    /// @return cptSharesIn cPT burned from the caller.
    /// @return actualCollateralAssetsOut Collateral paid to the caller.
    /// @return actualReferenceAssetsOut Reference assets paid to the caller.
    function withdrawOtherForSelf(WithdrawOtherForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 cptSharesIn, uint256 actualCollateralAssetsOut, uint256 actualReferenceAssetsOut)
    {
        (cptSharesIn, actualCollateralAssetsOut, actualReferenceAssetsOut) =
            CORK.withdrawOther(params.poolId, params.referenceAssetsOut, msg.sender, msg.sender);
        require(cptSharesIn <= params.maxCptSharesIn, SlippageExceeded());
    }
}
