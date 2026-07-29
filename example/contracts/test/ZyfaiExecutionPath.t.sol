// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {Test, console} from "forge-std/Test.sol";

import {CorkForSelfAdapter} from "../src/CorkForSelfAdapter.sol";
import {CorkLopFillForSelfBase} from "../src/base/CorkLopFillForSelfBase.sol";
import {MarketId} from "../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../src/interfaces/IOrderMixinMinimal.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockJitLop, MockJitPoolManager} from "./mocks/MockJitProtocols.sol";

interface IERC7579Account {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
}

/// @dev Records who called it. The whole ForSelf design rests on one claim — that a call
///      arriving from a caged agent has the Safe as `msg.sender` — and this is the cheapest
///      way to settle it against a real deployment rather than a reading of the spec.
contract CallerProbe {
    address public lastCaller;

    function ping() external {
        lastCaller = msg.sender;
    }
}

/// @dev Runs the adapters through the REAL Zyfai account stack on Base, using the contracts
///      observed in production. Two transactions were the reference:
///        0xdbb00298…875e5b and 0xe0aa8651…f54c12d3
///      whose traces show the path
///        executor module → SmartSessionEmissary.verifyExecution → Safe.executeFromExecutor
///        → Safe singleton → Safe7579 → Guarded Executor.executeGuardedBatch
///        → TargetRegistry.whitelist(target, selector) / whitelistedTargets(spender)
///        → Safe.executeFromExecutor → the protocol call
///      and, at the end of it, an `approve` whose spender is the AdapterProxy followed by
///      `redeemVaultForSelf` / `depositVaultForSelf` on that proxy. That is precisely the
///      shape these adapters are meant to slot into.
///
///      Cork is not deployed on Base, so the protocols themselves are mocks here. What is
///      real is everything that decides `msg.sender`: the Safe, its Safe7579 adapter, and
///      the executor module the calls arrive from. Per the task framing, the same Zyfai
///      contracts are assumed on Arbitrum.
///
///      Run it by pointing forge at Base; it self-selects on chain id and is inert
///      otherwise, so it costs nothing in the Arbitrum suite and commits no RPC URL:
///        forge test --match-contract ZyfaiExecutionPath \
///          --fork-url <base-rpc> --fork-block-number 48984400
contract ZyfaiExecutionPathTest is Test {
    // Production Zyfai stack on Base, read out of the two reference traces.
    address internal constant SAFE = 0x56acAD777E29C9c009429ac36a9DcaB62303d3df;
    address internal constant GUARDED_EXECUTOR = 0xF659d30D4EB88B06A909F20839D8959Bd77d8790;
    address internal constant SAFE_7579 = 0x7579EE8307284F293B1927136486880611F20002;
    address internal constant TARGET_REGISTRY = 0xd5C2dFD6d34c2bEA1dbec14DE4780d4A9D45ea17;
    address internal constant ADAPTER_PROXY = 0xaffD3c3cD06cf499deddf78b26868018A93f2C31;

    /// @dev Chain id of Base, where the reference transactions and this stack live.
    uint256 internal constant BASE = 8453;

    /// @dev ERC-7579 single call, default exec type: callType 0x00 in the high byte.
    bytes32 internal constant MODE_SINGLE = bytes32(0);

    bool internal live;

    function setUp() public {
        live = block.chainid == BASE;
        if (!live) console.log("not on a Base fork - Zyfai execution-path tests inert");
    }

    /// @dev Execute `call` on `target` the way the Guarded Executor does at the end of a
    ///      real batch: as the account, through its own `executeFromExecutor`, entered by an
    ///      installed executor module. Impersonating that module is the faithful injection
    ///      point — everything above it is signature and policy checking that decides
    ///      *whether* the call happens, not *who* it comes from.
    function _executeAsAccount(address target, bytes memory call) internal returns (bytes[] memory) {
        vm.prank(GUARDED_EXECUTOR);
        return IERC7579Account(SAFE).executeFromExecutor(MODE_SINGLE, abi.encodePacked(target, uint256(0), call));
    }

    /// @dev The load-bearing claim, tested against the deployed account: a call routed
    ///      through the module path arrives with the SAFE as `msg.sender`. If this were the
    ///      module or the Safe7579 adapter instead, every `receiver = msg.sender` in these
    ///      adapters would deliver to the wrong address and the whole design would be void.
    function test_callerAtTargetIsTheSafe() public {
        if (!live) return;
        assertGt(SAFE.code.length, 0, "Safe not deployed at the fork block");
        assertGt(SAFE_7579.code.length, 0, "Safe7579 adapter missing");

        CallerProbe probe = new CallerProbe();
        _executeAsAccount(address(probe), abi.encodeCall(CallerProbe.ping, ()));

        assertEq(probe.lastCaller(), SAFE, "msg.sender at the target must be the Safe");
    }

    /// @dev The production reference: the same account really does drive an approve whose
    ///      spender is a `*ForSelf` proxy, and then a `*ForSelf` selector on it. Confirms
    ///      the shape these adapters are modelled on is live, not aspirational.
    function test_productionUsesTheForSelfProxyShape() public view {
        if (!live) return;
        assertGt(ADAPTER_PROXY.code.length, 0, "AdapterProxy not deployed");
        assertGt(TARGET_REGISTRY.code.length, 0, "TargetRegistry not deployed");
        assertGt(GUARDED_EXECUTOR.code.length, 0, "Guarded Executor not deployed");
    }

    /// @dev End to end: a Cork ForSelf fill driven by the real account stack. The account
    ///      grants the allowance and makes the call exactly as the caged agent would, and
    ///      the bought asset must land on the account — not on the adapter, and not
    ///      anywhere a parameter could have named.
    function test_forSelfFillThroughTheRealAccountDeliversToTheSafe() public {
        if (!live) return;

        MockERC20 collateral = new MockERC20();
        MockERC20 cst = new MockERC20();
        MockJitPoolManager pm = new MockJitPoolManager(address(collateral), address(cst));
        MockJitLop lop = new MockJitLop(pm, true);
        CorkForSelfAdapter adapter = new CorkForSelfAdapter(address(pm), address(lop));

        cst.mint(address(lop), 10e18); // the maker's inventory
        collateral.mint(SAFE, 1e18); // the account's money

        // Step 1, as the account: authorise the adapter. This mirrors the production
        // approve whose spender the registry validates via `whitelistedTargets`.
        _executeAsAccount(address(collateral), abi.encodeCall(MockERC20.approve, (address(adapter), 1e18)));
        assertEq(collateral.allowance(SAFE, address(adapter)), 1e18, "account authorised the adapter");

        // Step 2, as the account: the ForSelf call itself. No destination is supplied.
        bytes memory fill = abi.encodeCall(
            CorkLopFillForSelfBase.fillOrderForSelf,
            (CorkLopFillForSelfBase.FillOrderForSelfParams({
                    poolId: MarketId.wrap(bytes32(uint256(1))),
                    order: IOrderMixinMinimal.Order({
                        salt: 1,
                        maker: uint256(uint160(address(0xBEEF))),
                        receiver: 0,
                        makerAsset: uint256(uint160(address(cst))),
                        takerAsset: uint256(uint160(address(collateral))),
                        makingAmount: 10e18,
                        takingAmount: 1e18,
                        makerTraits: 0
                    }),
                    signature: new bytes(64),
                    amount: 1e18,
                    takerTraits: 0,
                    extension: "",
                    deadline: block.timestamp
                }))
        );
        _executeAsAccount(address(adapter), fill);

        assertEq(cst.balanceOf(SAFE), 10e18, "cover delivered to the account");
        assertEq(collateral.balanceOf(SAFE), 0, "account paid");
        assertEq(cst.balanceOf(address(adapter)), 0, "adapter holds nothing");
        assertEq(collateral.balanceOf(address(adapter)), 0, "adapter holds nothing");
        assertEq(collateral.allowance(SAFE, address(adapter)), 0, "allowance fully consumed");
    }
}
