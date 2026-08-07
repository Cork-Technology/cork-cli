// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {Market, MarketId} from "../../src/interfaces/ICorkPoolManagerMinimal.sol";
import {IOrderMixinMinimal} from "../../src/interfaces/IOrderMixinMinimal.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev A pool manager whose market does not exist until `create()` is called — the shape a
///      just-in-time market has, where the pool is deployed during the fill that buys into
///      it. Before creation both getters return zeroes, exactly as the real pool manager
///      does for an unknown market id (it reads an unset struct rather than reverting).
contract MockJitPoolManager {
    address public immutable COLLATERAL;
    address public immutable CST;
    bool public created;

    constructor(address collateral, address cst) {
        COLLATERAL = collateral;
        CST = cst;
    }

    function create() external {
        created = true;
    }

    function shares(MarketId) external view returns (address principalToken, address swapToken) {
        return created ? (address(uint160(0xCF7)), CST) : (address(0), address(0));
    }

    function market(MarketId) external view returns (Market memory parameters) {
        if (!created) return parameters;
        parameters.collateralAsset = COLLATERAL;
        parameters.referenceAsset = address(uint160(0xEF));
    }
}

/// @dev A whitelist manager double for the ordering tests: serves one pool manager
///      (satisfying the adapter constructor's reverse-pointer self-check) and gates all
///      markets with one switch — these tests only ever use a single market id. The
///      enforcement rule mirrors the real one: ungated => always true, gated =>
///      membership. Only the ORDERING property is proven against this double; the real
///      WhitelistManager behavior is proven on fork in `WhitelistGate.t.sol`.
contract MockWhitelistManager {
    address public immutable CORK_POOL_MANAGER;
    bool public gated;
    mapping(address => bool) public listed;

    constructor(address poolManager) {
        CORK_POOL_MANAGER = poolManager;
    }

    function setGated(bool value) external {
        gated = value;
    }

    function setListed(address account, bool value) external {
        listed[account] = value;
    }

    function isWhitelisted(MarketId, address account) external view returns (bool) {
        return !gated || listed[account];
    }
}

/// @dev A limit-order protocol that mimics the parts of a fill this wrapper depends on:
///      it reads the target out of the first 20 bytes of `args`, optionally creates the
///      market mid-fill (standing in for the maker pre-interaction that a Cork JIT order
///      commits to), delivers the maker asset to that target, and pulls the taker asset
///      from its caller. Not a model of 1inch — only of the ordering this wrapper claims
///      to tolerate.
contract MockJitLop {
    MockJitPoolManager public immutable POOL_MANAGER;
    bool public immutable CREATES_MARKET;

    /// @dev When set, market creation also ACTIVATES the market's whitelist — the exact
    ///      order of operations the real controller's `createNewPool` performs
    ///      (activateMarketWhitelist inside pool creation), which is what makes a
    ///      pre-fill whitelist check unsound for just-in-time markets.
    MockWhitelistManager public gateOnCreate;

    constructor(MockJitPoolManager poolManager, bool createsMarket) {
        POOL_MANAGER = poolManager;
        CREATES_MARKET = createsMarket;
    }

    function setGateOnCreate(MockWhitelistManager whitelistManager) external {
        gateOnCreate = whitelistManager;
    }

    function hashOrder(IOrderMixinMinimal.Order calldata order) external pure returns (bytes32) {
        return keccak256(abi.encode(order));
    }

    function fillOrderArgs(
        IOrderMixinMinimal.Order calldata order,
        bytes32,
        bytes32,
        uint256 amount,
        uint256,
        bytes calldata args
    ) external payable returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash) {
        // The maker's pre-interaction runs here in a real fill; for a JIT order that is
        // what brings the market into existence — and, when the creation parameters say
        // so, what activates its whitelist (the controller does both in createNewPool).
        if (CREATES_MARKET) {
            POOL_MANAGER.create();
            if (address(gateOnCreate) != address(0)) gateOnCreate.setGated(true);
        }

        address target = address(bytes20(args[0:20]));
        makingAmount = order.makingAmount;
        takingAmount = amount;

        require(MockERC20(address(uint160(order.makerAsset))).transfer(target, makingAmount), "maker leg");
        require(
            MockERC20(address(uint160(order.takerAsset))).transferFrom(msg.sender, address(this), takingAmount),
            "taker leg"
        );
        orderHash = keccak256(abi.encode(order));
    }

    function fillContractOrderArgs(IOrderMixinMinimal.Order calldata, bytes calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (uint256, uint256, bytes32)
    {
        revert("contract-maker path not exercised by these tests");
    }
}
