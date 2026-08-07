// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";

import {CorkForSelfAdapter} from "../src/CorkForSelfAdapter.sol";
import {ICorkPoolManagerMinimal, MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IWhitelistManagerMinimal} from "../src/interfaces/IWhitelistManagerMinimal.sol";

/// @title DeployForSelfAdapter
/// @author Cork Team
/// @custom:security-contact security@cork.tech
/// @notice Deploys ONE shared `CorkForSelfAdapter` — a single instance serving every
///         account, matching the integrator's existing adapter-proxy shape.
///
///         Read this before running it. A shared instance is the identity every upstream
///         access check sees. Since the caller-whitelist gate was added, the sharper of
///         the two historical consequences is closed, but one remains:
///
///         - Whitelist-gated markets now stay gated through a shared adapter: the pool
///           manager admits the (whitelisted) adapter, and the adapter itself requires
///           `isWhitelisted(poolId, msg.sender)` for the REAL caller — one whitelist
///           add per calling Safe, enforced on-chain.
///         - Naming a shared adapter in an order's `allowedSender` still makes that
///           order fillable by anyone (every caller reaches the protocol as the same
///           address), so `allowedSender` remains unusable for exclusivity unless the
///           adapter is deployed per account.
///
///         Usage (Arbitrum One defaults are built in):
///           forge script script/DeployForSelfAdapter.s.sol \
///             --rpc-url "$ARBITRUM_RPC_URL" --broadcast --verify
///
///         Env overrides:
///           CORK_POOL_MANAGER       pool manager address
///           CORK_WHITELIST_MANAGER  whitelist manager address (must serve the pool
///                                   manager — the pairing is checked on-chain here AND
///                                   again in the adapter constructor)
///           CORK_LOP                1inch LOP v4 address
///           CORK_CREATE2_SALT       deploy deterministically for the same address across
///                                   chains; omit for a plain CREATE deploy
///
///         EXAMPLE CODE — the integrator audits, vets, and deploys under its own name.
contract DeployForSelfAdapter is Script {
    /// @dev Arbitrum One, verified live 2026-07-28: this pool manager holds the 22 markets
    ///      the venue lists. An earlier deployment (`0xc2De…54AE`) survives upstream for
    ///      pre-launch calibration pools and must NOT be used here — it knows none of the
    ///      live markets.
    address internal constant DEFAULT_POOL_MANAGER = 0x4d0ab6735deF9FBAdDBf0F2FfB92353Afae623d2;

    /// @dev Arbitrum One WhitelistManager proxy paired with the default pool manager
    ///      (reverse pointer `CORK_POOL_MANAGER()` verified live 2026-08-07).
    address internal constant DEFAULT_WHITELIST_MANAGER = 0xeC187bA7BBd4016d8db326ea1DFb3DD48d17Bd3A;

    /// @dev 1inch Limit Order Protocol v4 — the same address on every supported chain.
    address internal constant DEFAULT_LOP = 0x111111125421cA6dc452d289314280a0f8842A65;

    error PoolManagerHasNoCode(address poolManager);
    error WhitelistManagerHasNoCode(address whitelistManager);
    error LopHasNoCode(address lop);
    error PoolManagerNotResponding(address poolManager);
    error WhitelistManagerNotForPoolManager(address whitelistManager, address served, address poolManager);

    function run() external returns (CorkForSelfAdapter adapter) {
        address poolManager = vm.envOr("CORK_POOL_MANAGER", DEFAULT_POOL_MANAGER);
        address whitelistManager = vm.envOr("CORK_WHITELIST_MANAGER", DEFAULT_WHITELIST_MANAGER);
        address lop = vm.envOr("CORK_LOP", DEFAULT_LOP);
        bytes32 salt = vm.envOr("CORK_CREATE2_SALT", bytes32(0));

        _checkTargets(poolManager, whitelistManager, lop);

        vm.startBroadcast();
        adapter = salt == bytes32(0)
            ? new CorkForSelfAdapter(poolManager, whitelistManager, lop)
            : new CorkForSelfAdapter{salt: salt}(poolManager, whitelistManager, lop);
        vm.stopBroadcast();

        console.log("CorkForSelfAdapter :", address(adapter));
        console.log("  pool manager     :", poolManager);
        console.log("  whitelist manager:", whitelistManager);
        console.log("  limit-order proto:", lop);
        console.log("  deterministic    :", salt != bytes32(0));
        console.log("");
        console.log("Next: grant this adapter the allowances in the README matrix, whitelist");
        console.log("its selectors, and do NOT whitelist the raw pool manager or raw LOP.");
        console.log("On gated markets, whitelist BOTH this adapter and each calling Safe.");
    }

    /// @dev All three constructor arguments are immutable for the life of the deployment,
    ///      so a typo is permanent. Fail before broadcasting rather than after.
    function _checkTargets(address poolManager, address whitelistManager, address lop) internal view {
        require(poolManager.code.length > 0, PoolManagerHasNoCode(poolManager));
        require(whitelistManager.code.length > 0, WhitelistManagerHasNoCode(whitelistManager));
        require(lop.code.length > 0, LopHasNoCode(lop));

        // A liveness probe, not a correctness proof: `shares()` on an unknown market
        // returns zeros rather than reverting, so what we are checking is that the address
        // actually exposes the pool-manager interface this adapter is about to be bound to
        // forever — not merely that it is some contract.
        try ICorkPoolManagerMinimal(poolManager).shares(MarketId.wrap(bytes32(0))) returns (address, address) {}
        catch {
            revert PoolManagerNotResponding(poolManager);
        }

        // The whitelist manager records which pool manager it serves; a mispaired
        // (poolManager, whitelistManager) argument set would gate against the wrong list
        // forever. The adapter constructor enforces this too — checking here as well
        // turns an on-chain revert into a readable pre-broadcast error.
        address served = IWhitelistManagerMinimal(whitelistManager).CORK_POOL_MANAGER();
        require(
            served == poolManager, WhitelistManagerNotForPoolManager(whitelistManager, served, poolManager)
        );
    }
}
