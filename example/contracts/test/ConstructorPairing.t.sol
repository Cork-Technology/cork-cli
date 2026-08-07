// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {CorkPoolForSelfAdapter} from "../src/CorkPoolForSelfAdapter.sol";
import {ForSelfCommon} from "../src/base/ForSelfCommon.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockJitPoolManager, MockWhitelistManager} from "./mocks/MockJitProtocols.sol";

/// @dev The constructor's (poolManager, whitelistManager) pairing self-check, at zero RPC
///      cost: a whitelist manager serving a DIFFERENT pool manager is rejected with the
///      exact mismatch it found, and a matching pair deploys. The same property is proven
///      against the two real Arbitrum stacks (live + shadow, genuinely mispaired) in
///      `CombinedDeploy.t.sol`; keep both for the same reason `JitOrdering.t.sol` keeps
///      its offline twin of `JitFill210.t.sol`.
contract ConstructorPairingTest is Test {
    MockJitPoolManager internal pm;
    MockJitPoolManager internal otherPm;

    function setUp() public {
        MockERC20 collateral = new MockERC20();
        MockERC20 cst = new MockERC20();
        pm = new MockJitPoolManager(address(collateral), address(cst));
        otherPm = new MockJitPoolManager(address(collateral), address(cst));
    }

    function test_matchingPairDeploysAndPinsBothImmutables() public {
        MockWhitelistManager wlm = new MockWhitelistManager(address(pm));
        CorkPoolForSelfAdapter adapter = new CorkPoolForSelfAdapter(address(pm), address(wlm));
        assertEq(address(adapter.CORK()), address(pm));
        assertEq(address(adapter.WHITELIST()), address(wlm));
    }

    function test_mispairedWhitelistManagerIsRejectedWithTheMismatchItFound() public {
        MockWhitelistManager wlmForOther = new MockWhitelistManager(address(otherPm));
        vm.expectRevert(
            abi.encodeWithSelector(ForSelfCommon.WhitelistManagerMismatch.selector, address(otherPm), address(pm))
        );
        new CorkPoolForSelfAdapter(address(pm), address(wlmForOther));
    }

    function test_nonWhitelistManagerAddressCannotBecomeTheGate() public {
        // An address with no code cannot answer CORK_POOL_MANAGER() — the deployment
        // must fail rather than mint an adapter whose gate calls into nothing.
        vm.expectRevert();
        new CorkPoolForSelfAdapter(address(pm), makeAddr("no-code"));
    }
}
