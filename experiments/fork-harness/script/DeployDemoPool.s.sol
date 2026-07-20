// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title DeployDemoPool — create a demo Cork pool on the Tenderly virtual mainnet
/// @notice Reusable form of the canonical vnet-fixture recipe (notes/experiments/03-vnet-fixture.md).
///         The vnet auto-impersonates any sender for unsigned transactions, so this runs with
///         `--unlocked` and NO private keys — strictly a test-environment script.
///
/// Usage (never commit the RPC URL; it comes from the environment):
///   forge script scripts/DeployDemoPool.s.sol:DeployDemoPool \
///     --rpc-url "$CORK_TEST_RPC" --broadcast --unlocked \
///     --sender 0x7CcCcCCcCccCC1d856F2994A66fAa7011F1A89D9
///
/// Sender = the operational timelock (holds POOL_CREATOR_ROLE on DefaultCorkController), so the
/// pool is created THROUGH the controller — fees + whitelist are configured atomically (the clean
/// path; impersonating the controller straight into the PoolManager skips fee/whitelist config).
///
/// After deployment, fund a dev EOA to make preview/unwind paths live (plain JSON-RPC against the
/// vnet, outside forge):
///   tenderly_setBalance / tenderly_setErc20Balance for ETH + collateral/reference tokens,
///   then approve + deposit + swap from that EOA (see the recipe doc, step 3).
///
/// The resulting poolId = keccak256(abi.encode(Market)) — printed by this script — and is the id
/// the worked examples in @cork/schemas TOOL_EXAMPLES reference.
import {Script, console} from "forge-std/Script.sol";

contract MockRateOracle {
    uint256 private _rate;

    event RateSet(address indexed setter, uint256 rate);

    constructor(uint256 initialRate) {
        _rate = initialRate;
    }

    function rate() external view returns (uint256) {
        require(_rate != 0, "InvalidRate");
        return _rate;
    }

    /// @dev Intentionally permissionless: shared dev/test convenience (simulate depeg/recovery).
    function setRate(uint256 newRate) external {
        _rate = newRate;
        emit RateSet(msg.sender, newRate);
    }
}

interface IDefaultCorkController {
    struct Market {
        address collateralAsset;
        address referenceAsset;
        uint256 expiryTimestamp;
        uint256 rateMin;
        uint256 rateMax;
        uint256 rateChangePerDayMax;
        uint256 rateChangeCapacityMax;
        address rateOracle;
    }

    struct NewPoolParams {
        Market market;
        uint256 unwindSwapFeePercentage;
        uint256 swapFeePercentage;
        bool isWhitelistEnabled;
    }

    function createNewPool(NewPoolParams calldata params) external returns (bytes32 poolId);
}

contract DeployDemoPool is Script {
    // Mainnet-fork constants (the vnet forks chainId 1; addresses match cork-defaults.json).
    address constant CONTROLLER = 0x2225AFECccC0F52177369d309fCe4187B96bd5d6;
    address constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497; // collateral, 18 dec
    address constant VBUSDC = 0x53E82ABbb12638F09d9e624578ccB666217a765e; // reference, 6 dec

    // Fixture parameters (round numbers on purpose — same as the canonical demo pool).
    uint256 constant INITIAL_RATE = 0.8e18; // 1 REF = 0.8 CA
    uint256 constant RATE_MIN = 0.5e18;
    uint256 constant RATE_MAX = 1.0e18;
    uint256 constant RATE_PER_DAY_MAX = 1e15; // 0.1%/day refill
    uint256 constant RATE_CAPACITY_MAX = 7e15; // 0.7% bucket = 7 days of refill
    uint256 constant FEE = 5e16; // 0.05% (on-chain unit: 1e18 = 1%)

    function run() external {
        // Expiry ~6 months out from the vnet clock (which lags wall time; read it live).
        uint256 expiry = block.timestamp + 180 days;

        vm.startBroadcast(); // --unlocked --sender <timelock>: vnet auto-impersonates, no keys

        MockRateOracle oracle = new MockRateOracle(INITIAL_RATE);

        bytes32 poolId = IDefaultCorkController(CONTROLLER).createNewPool(
            IDefaultCorkController.NewPoolParams({
                market: IDefaultCorkController.Market({
                    collateralAsset: SUSDE,
                    referenceAsset: VBUSDC,
                    expiryTimestamp: expiry,
                    rateMin: RATE_MIN,
                    rateMax: RATE_MAX,
                    rateChangePerDayMax: RATE_PER_DAY_MAX,
                    rateChangeCapacityMax: RATE_CAPACITY_MAX,
                    rateOracle: address(oracle)
                }),
                unwindSwapFeePercentage: FEE,
                swapFeePercentage: FEE,
                isWhitelistEnabled: false
            })
        );

        vm.stopBroadcast();

        console.log("MockRateOracle:", address(oracle));
        console.log("demo poolId:");
        console.logBytes32(poolId);
        console.log("Verify with: ch track --json '{\"mode\":\"verify\",\"subject\":{\"kind\":\"marketRef\",\"poolId\":\"<poolId>\"}}' --rpc-url $CORK_TEST_RPC");
    }
}
