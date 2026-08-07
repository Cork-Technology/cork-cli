// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Market, MarketId} from "../interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../interfaces/IOrderMixinMinimal.sol";
import {ForSelfCommon} from "./ForSelfCommon.sol";

/// @title CorkLopFillForSelfBase
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Target-forcing ("ForSelf") wrapper over the 1inch Limit Order Protocol v4
///         taker fill path, for accounts whose call policy is parameter-blind.
///
///         On a raw `fillOrderArgs`/`fillContractOrderArgs` call, takerTraits bit 251
///         plus the first 20 bytes of `args` let the caller route the bought maker asset
///         to ANY address — a redirection a (contract, selector) whitelist cannot see.
///         This wrapper rebuilds the traits/args pair itself:
///
///         - target is ALWAYS the caller: bit 251 is forced on and `msg.sender` is
///           written as the first 20 bytes of `args` (leaving the bit unset would
///           default the target to this wrapper, not the caller);
///         - the taker-interaction segment is structurally impossible: its length bits
///           (200-223) are zeroed, so no attacker-chosen callee can run mid-fill while
///           this wrapper holds a live LOP allowance;
///         - Permit2 sourcing (bit 252) is cleared — the taker asset is pulled from the
///           caller and approved to the LOP for exactly this fill;
///         - the maker-signed `extension` is forwarded verbatim (the order salt commits
///           to it; the LOP itself rejects mismatches) with its length bits rewritten;
///         - amount-mode (bit 255), WETH-unwrap (bit 254 — unwrapped ETH follows the
///           target, i.e. the caller), maker-permit-skip (bit 253) and the threshold
///           bits (0-183) are preserved from the caller's takerTraits.
///
///         Forcing the target is necessary but NOT sufficient. The bought asset is only
///         one of the two legs: the taker asset — the account's own money — is paid to
///         the ORDER's `receiver`, a field the order's maker chooses. A caged agent that
///         can hand this wrapper an arbitrary order can simply sign its own: sell one wei
///         of a worthless token, name itself as receiver, and set the taking amount to
///         the account's entire balance. Target-forcing does nothing about that, because
///         nothing was misdirected — the account really did "buy" something.
///
///         So this wrapper is a CORK fill wrapper, not a general 1inch one. Every fill is
///         bound to a Cork market: the order must trade one of that market's share tokens
///         (cST or cPT) against one of its cash legs (collateral or reference asset), in
///         one direction or the other, with all four addresses read from the pinned pool
///         manager rather than taken from the caller — the set the live venue actually
///         lists (cST and cPT markets quoted in collateral) plus the reference leg. A
///         caged agent can therefore only ever buy or sell genuine market value in a real
///         market. What remains is price risk — it may still trade badly — which is
///         bounded by the allowance the account grants this adapter, not by anything a
///         wrapper can enforce. See the README's residual-risk section.
///
///         One entrypoint serves both maker kinds: contract makers (ERC-1271) are
///         detected by code size and routed to `fillContractOrderArgs`; EOA makers'
///         64/65-byte signatures are split into the compact r/vs form for
///         `fillOrderArgs`.
///
///         Known limits: ETH-taker fills are unsupported (non-payable; the contract-
///         maker variant is non-payable upstream too). Orders restricted by
///         `allowedSender` are compared against the protocol's `msg.sender`, which is this
///         wrapper — so through a wrapper SHARED by many accounts, naming it as the allowed
///         sender makes the order fillable by anyone. Treat `allowedSender` as unusable for
///         exclusivity unless the wrapper is deployed per account (see the README).
///
///         EXAMPLE CODE — the integrator must audit, vet, and deploy it themselves.
abstract contract CorkLopFillForSelfBase is ForSelfCommon {
    using SafeERC20 for IERC20;

    /// @notice The 1inch Limit Order Protocol this adapter is permanently bound to.
    /// @dev Immutable for the same reason as `CorkPoolForSelfBase.CORK`: a caller-
    ///      supplied protocol address would defeat the custody model.
    IOrderMixinMinimal public immutable LOP;

    error ThresholdRequired();
    error ExtensionTooLong();
    error InvalidSignatureLength();
    /// @dev Named to be distinguishable from Cork's own `OrderNotForPool()`, which its JIT
    ///      adapter raises on rate drift. Identical names would share a selector and leave an
    ///      integrator unable to tell a stale rate from a wrong `poolId` argument.
    error OrderAssetsNotInMarket(address makerAsset, address takerAsset);

    // TakerTraits bit layout, verified against 1inch TakerTraitsLib (v4.3.4).
    uint256 private constant _MAKER_AMOUNT_FLAG = 1 << 255;
    uint256 private constant _UNWRAP_WETH_FLAG = 1 << 254;
    uint256 private constant _SKIP_ORDER_PERMIT_FLAG = 1 << 253;
    uint256 private constant _ARGS_HAS_TARGET = 1 << 251;
    /// @dev Threshold occupies bits 0-183 (the operative `_AMOUNT_MASK` in
    ///      TakerTraitsLib is 46 hex nibbles; its doc comment saying "0-184" is off by
    ///      one — the code mask is authoritative).
    uint256 private constant _AMOUNT_MASK = 0x000000000000000000ffffffffffffffffffffffffffffffffffffffffffffff;
    uint256 private constant _PRESERVE_MASK =
        _MAKER_AMOUNT_FLAG | _UNWRAP_WETH_FLAG | _SKIP_ORDER_PERMIT_FLAG | _AMOUNT_MASK;

    constructor(address lop) {
        require(lop != address(0), ZeroAddress());
        LOP = IOrderMixinMinimal(lop);
    }

    struct FillOrderForSelfParams {
        /// @dev The Cork market this fill must belong to. The order's asset pair is
        ///      checked against the pool manager's own view of this market, so a caller
        ///      cannot substitute tokens of its own choosing.
        MarketId poolId;
        IOrderMixinMinimal.Order order;
        /// @dev 64 bytes (r||vs) or 65 bytes (r||s||v) for EOA makers; opaque ERC-1271
        ///      bytes for contract makers.
        bytes signature;
        /// @dev Making-amount if takerTraits bit 255 is set, else taking-amount.
        uint256 amount;
        /// @dev Sanitized before use — only bits 255/254/253 and the threshold survive.
        uint256 takerTraits;
        /// @dev The maker-signed extension, forwarded verbatim.
        bytes extension;
        uint256 deadline;
    }

    /// @notice Fill a resting LOP v4 order for a Cork market; the bought maker asset is
    ///         delivered by the protocol DIRECTLY to the caller (this wrapper never holds
    ///         it), and the order may only trade `poolId`'s cST against its collateral.
    /// @dev The taker asset is pulled from the caller up to the worst-case amount
    ///      (`amount` in taking-amount mode; the threshold in making-amount mode, which
    ///      is why a zero threshold reverts there) and any unspent remainder is swept
    ///      back after the fill.
    /// @param params The market, order, signature, amount, traits, extension and deadline.
    /// @return makingAmount Maker asset delivered to the caller.
    /// @return takingAmount Taker asset actually paid.
    /// @return orderHash The protocol's hash of the filled order.
    function fillOrderForSelf(FillOrderForSelfParams calldata params)
        external
        nonReentrant
        checkDeadline(params.deadline)
        returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)
    {
        require(params.extension.length <= 0xffffff, ExtensionTooLong());
        uint256 sanitized = (params.takerTraits & _PRESERVE_MASK) | _ARGS_HAS_TARGET | (params.extension.length << 224);
        bytes memory args = abi.encodePacked(msg.sender, params.extension);

        address takerAsset = address(uint160(params.order.takerAsset));
        uint256 pullCap = (sanitized & _MAKER_AMOUNT_FLAG != 0) ? (sanitized & _AMOUNT_MASK) : params.amount;
        require(pullCap != 0, ThresholdRequired());
        _pull(takerAsset, pullCap);
        IERC20(takerAsset).forceApprove(address(LOP), pullCap);

        if (address(uint160(params.order.maker)).code.length > 0) {
            (makingAmount, takingAmount, orderHash) =
                LOP.fillContractOrderArgs(params.order, params.signature, params.amount, sanitized, args);
        } else {
            (bytes32 r, bytes32 vs) = _splitSignature(params.signature);
            (makingAmount, takingAmount, orderHash) =
                LOP.fillOrderArgs(params.order, r, vs, params.amount, sanitized, args);
        }

        // Deliberately AFTER the fill. A Cork order may create its market just in time —
        // the maker's pre-interaction deploys the pool during this very call — so the
        // market is unreadable beforehand and checking early would reject exactly the
        // orders the pilot depends on. Checking after covers both shapes with one rule,
        // and costs nothing in safety: a failure reverts the whole transaction, undoing
        // the payment along with everything else.
        _requireOrderIsForPool(params.poolId, address(uint160(params.order.makerAsset)), takerAsset);
        // Same post-fill placement for the caller-whitelist gate, same reason: pool
        // creation SETS the market's authoritative gate state from its own parameters
        // (the controller's createNewPool calls activateMarketWhitelist or
        // disableMarketWhitelist, overwriting any pre-creation activation) — and for a
        // just-in-time market that happens INSIDE this very fill. A pre-check would read
        // a state creation may rewrite in either direction; checking after reads the
        // state the transaction actually ends in. For already-existing markets the
        // timing is indifferent (their gate can only ever be disabled, never enabled),
        // so one placement serves both shapes.
        _requireCallerWhitelisted(params.poolId);

        IERC20(takerAsset).forceApprove(address(LOP), 0);
        _sweep(takerAsset);
    }

    /// @dev The order must trade one of this market's share tokens (cST or cPT) against
    ///      one of its cash legs (collateral or reference asset), one way or the other.
    ///      All four addresses come from the pinned pool manager, never from the caller,
    ///      so an unknown market (zeroed struct) or a substituted token pair cannot pass.
    ///      This is what stops a caged agent from handing the wrapper a self-signed order
    ///      that pays the account's balance to an address of its choosing in exchange for
    ///      a worthless token. The admitted set mirrors what the venue actually lists
    ///      (cST- and cPT-against-collateral markets, observed live on Arbitrum) plus the
    ///      reference-asset quote leg the protocol equally supports; every admitted asset
    ///      is a real balance-sheet leg of the named market, so the "only genuine value in
    ///      a real market" guarantee is unchanged. Called after the fill so that a
    ///      just-in-time market, which does not exist until the fill creates it, is
    ///      readable by the time it is checked.
    function _requireOrderIsForPool(MarketId poolId, address makerAsset, address takerAsset) internal view {
        (address principalToken, address corkSwapToken) = CORK.shares(poolId);
        Market memory params = CORK.market(poolId);
        bool known = corkSwapToken != address(0) && params.collateralAsset != address(0);
        bool makerIsShare = makerAsset == corkSwapToken || makerAsset == principalToken;
        bool takerIsShare = takerAsset == corkSwapToken || takerAsset == principalToken;
        bool makerIsCash = makerAsset == params.collateralAsset || makerAsset == params.referenceAsset;
        bool takerIsCash = takerAsset == params.collateralAsset || takerAsset == params.referenceAsset;
        bool paired = (makerIsShare && takerIsCash) || (makerIsCash && takerIsShare);
        require(known && paired, OrderAssetsNotInMarket(makerAsset, takerAsset));
    }

    /// @dev 64-byte signatures are already (r, vs); 65-byte (r, s, v) is compacted per
    ///      EIP-2098, accepting both the 27/28 and 0/1 conventions. Anything else reverts.
    function _splitSignature(bytes calldata signature) internal pure returns (bytes32 r, bytes32 vs) {
        if (signature.length == 64) {
            r = bytes32(signature[0:32]);
            vs = bytes32(signature[32:64]);
        } else if (signature.length == 65) {
            r = bytes32(signature[0:32]);
            uint256 s = uint256(bytes32(signature[32:64]));
            uint256 v = uint8(signature[64]);
            if (v < 27) v += 27; // some signers emit v as 0/1
            vs = bytes32(s | ((v - 27) << 255));
        } else {
            revert InvalidSignatureLength();
        }
    }
}
