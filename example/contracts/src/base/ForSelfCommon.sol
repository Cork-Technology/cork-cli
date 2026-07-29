// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICorkPoolManagerMinimal} from "../interfaces/ICorkPoolManagerMinimal.sol";

/// @title ForSelfCommon
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Shared plumbing for the ForSelf example adapters: the pinned pool manager,
///         custody-free helpers, and the errors both surfaces raise. EXAMPLE CODE — Cork
///         authors these adapters as references; the integrator must audit, vet, and
///         deploy them under its own responsibility. See the package README.
abstract contract ForSelfCommon is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error DeadlineExceeded();
    error SlippageExceeded();
    error ZeroAddress();

    /// @notice The Cork pool manager this adapter is permanently bound to.
    /// @dev Deliberately immutable rather than a per-call parameter: under a
    ///      parameter-blind policy, a caller-supplied protocol address would let a caged
    ///      agent route pulled funds into a fake "pool manager". The only external
    ///      contracts this adapter ever approves or calls are fixed at deployment. It is
    ///      also the trusted oracle for which token addresses belong to which market.
    ICorkPoolManagerMinimal public immutable CORK;

    constructor(address cork) {
        require(cork != address(0), ZeroAddress());
        CORK = ICorkPoolManagerMinimal(cork);
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
