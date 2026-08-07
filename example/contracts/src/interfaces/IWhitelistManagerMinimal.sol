// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {MarketId} from "./ICorkPoolManagerMinimal.sol";

/// @dev Vendored minimal subset of Cork Phoenix `IWhitelistManager`. Source of truth:
///      phoenix `contracts/interfaces/IWhitelistManager.sol` / `contracts/core/
///      WhitelistManager.sol` (signatures verified verbatim against the builds deployed
///      on Arbitrum One; both the live and shadow WhitelistManager proxies answer them).
///      Only the two members the ForSelf adapters need are reproduced here.
///
///      Semantics that the adapters rely on (from the deployed implementation):
///      - `isWhitelisted` returns TRUE whenever the market's whitelist is not enabled,
///        so calling it unconditionally is a no-op gate on ungated markets;
///      - a market's whitelist can only be ACTIVATED before/at pool creation
///        (`activateMarketWhitelist` reverts on an initialized market) and only ever
///        transitions gated -> disabled afterwards;
///      - `CORK_POOL_MANAGER()` is the set-once reverse pointer to the pool manager the
///        whitelist serves — the on-chain fact that lets a deployment self-verify its
///        (poolManager, whitelistManager) pairing.
interface IWhitelistManagerMinimal {
    /// @notice The CorkPoolManager this whitelist manager serves (set once at wiring).
    function CORK_POOL_MANAGER() external view returns (address corkPoolManager);

    /// @notice Enforcement view: true if `account` may act on `poolId` — always true
    ///         when the market's whitelist is not enabled, else global-or-market
    ///         membership.
    function isWhitelisted(MarketId poolId, address account) external view returns (bool);
}
