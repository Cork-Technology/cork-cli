// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICorkPoolManagerMinimal, MarketId} from "../interfaces/ICorkPoolManagerMinimal.sol";
import {IWhitelistManagerMinimal} from "../interfaces/IWhitelistManagerMinimal.sol";

/// @title ForSelfCommon
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Shared plumbing for the ForSelf example adapters: the pinned pool manager,
///         the pinned whitelist manager and its per-caller gate, custody-free helpers,
///         and the errors both surfaces raise. EXAMPLE CODE — Cork authors these
///         adapters as references; the integrator must audit, vet, and deploy them
///         under its own responsibility. See the package README.
abstract contract ForSelfCommon is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error DeadlineExceeded();
    error SlippageExceeded();
    error ZeroAddress();
    error CallerNotWhitelisted(MarketId poolId, address caller);
    error WhitelistManagerMismatch(address servedPoolManager, address cork);

    /// @notice The Cork pool manager this adapter is permanently bound to.
    /// @dev Deliberately immutable rather than a per-call parameter: under a
    ///      parameter-blind policy, a caller-supplied protocol address would let a caged
    ///      agent route pulled funds into a fake "pool manager". The only external
    ///      contracts this adapter ever approves or calls are fixed at deployment. It is
    ///      also the trusted oracle for which token addresses belong to which market.
    ICorkPoolManagerMinimal public immutable CORK;

    /// @notice The Cork whitelist manager this adapter enforces per-caller gating against.
    /// @dev The pool manager checks only its DIRECT caller — this adapter — so on a
    ///      whitelist-gated market, whitelisting a shared adapter would otherwise open
    ///      that market to every address on chain. This adapter closes that hole by
    ///      re-checking the REAL caller (`msg.sender`, the Safe) against the same
    ///      on-chain whitelist the pool manager consults, restoring the two-address
    ///      model the raw Bundler3 path has (adapter whitelisted at the pool manager,
    ///      end user checked per call). Ungated markets are unaffected:
    ///      `isWhitelisted` is always true for them.
    IWhitelistManagerMinimal public immutable WHITELIST;

    constructor(address cork, address whitelistManager) {
        require(cork != address(0) && whitelistManager != address(0), ZeroAddress());
        // The pairing is self-verifying: the whitelist manager records on-chain,
        // set-once, which pool manager it serves. A mispaired (cork, whitelistManager)
        // deployment — the one constructor typo that would silently gate against the
        // wrong list forever — cannot exist. (A whitelistManager address with no code,
        // or one that is not a whitelist manager at all, fails this call and reverts
        // the deployment too.)
        address served = IWhitelistManagerMinimal(whitelistManager).CORK_POOL_MANAGER();
        require(served == cork, WhitelistManagerMismatch(served, cork));
        CORK = ICorkPoolManagerMinimal(cork);
        WHITELIST = IWhitelistManagerMinimal(whitelistManager);
    }

    /// @dev THE one whitelist comparator/emitter — every entrypoint routes through this
    ///      single function (never a duplicated inline check), so a mutation to the
    ///      comparison is caught at its only occurrence. Pool actions apply it as a
    ///      pre-check via the modifier below; the LOP fill path calls it directly AFTER
    ///      the fill, because a just-in-time market's whitelist is activated inside pool
    ///      creation — i.e. inside the fill itself — and is only readable afterwards.
    function _requireCallerWhitelisted(MarketId poolId) internal view {
        require(WHITELIST.isWhitelisted(poolId, msg.sender), CallerNotWhitelisted(poolId, msg.sender));
    }

    /// @dev Pre-check flavor for the pool actions: their market must already exist, and
    ///      an existing market's whitelist can only transition gated -> disabled (never
    ///      the reverse), so the state read before the action is exact.
    modifier onlyWhitelistedCaller(MarketId poolId) {
        _requireCallerWhitelisted(poolId);
        _;
    }

    /// @dev A caller-supplied deadline is the one place a timestamp comparison is the point
    ///      rather than a hazard: the few seconds a proposer could shift `block.timestamp`
    ///      cannot turn a live deadline into an expired one in any way the caller cares
    ///      about, and the alternative (block numbers) is worse on an L2 with variable
    ///      block times.
    modifier checkDeadline(uint256 deadline) {
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp <= deadline, DeadlineExceeded());
        _;
    }

    /// @dev Pull `amount` of `token` from the caller into this contract. Requires the
    ///      caller's ERC-20 allowance to THIS adapter. Fee-on-transfer and rebasing
    ///      tokens are unsupported (amounts are taken at face value, matching the pool
    ///      manager's own accounting assumptions).
    function _pull(address token, uint256 amount) internal {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev Return this contract's ENTIRE balance of `token` to the caller. Called after
    ///      every custody-touching flow: refunds unspent caps, expels donations, and
    ///      enforces the zero-residual-balance invariant in one primitive.
    function _sweep(address token) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != 0) {
            IERC20(token).safeTransfer(msg.sender, balance);
        }
    }
}
