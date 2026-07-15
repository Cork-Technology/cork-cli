// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";

// Minimal interfaces mirrored from phoenix-private (read-only research use)
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

interface IPM {
    function swapRate(bytes32 poolId) external view returns (uint256);
    function market(bytes32 poolId) external view returns (Market memory);
    function assets(bytes32 poolId) external view returns (uint256, uint256);
    function previewSwap(bytes32 poolId, uint256 collateralAssetsOut)
        external view returns (uint256 cstSharesIn, uint256 referenceAssetsIn, uint256 fee);
    function previewUnwindSwap(bytes32 poolId, uint256 collateralAssetsIn)
        external view returns (uint256 cstSharesOut, uint256 referenceAssetsOut, uint256 fee);
    function previewDeposit(bytes32 poolId, uint256 collateralAssetsIn) external view returns (uint256);
}

interface ICRA {
    function previewAdjustedRate(bytes32 poolId) external view returns (uint256 rate);
    function adjustedRate(bytes32 poolId) external returns (uint256 rate);
    function constraints(bytes32 poolId) external view returns (uint256 lastAdjustedRate, uint256 lastAdjustmentTimestamp, uint256 remainingCredits);
    function CORK_POOL_MANAGER() external view returns (address);
}

interface IOracle {
    function rate() external view returns (uint256);
}

contract ImpairmentFloorTest is Test {
    address constant PM = 0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC;
    address constant CRA = 0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A;
    // Live (unexpired) vnet-only market, sUSDe/vbUSDC, expiry 2026-09-28 (vnet time)
    bytes32 constant POOL = 0xe855cf62e91b7a8690349d3834a36f07bb2ee2965d9db1d3bf1de2bd55ee6296;

    function _rateAt(uint256 warpTo) internal returns (uint256 r) {
        vm.warp(warpTo);
        vm.prank(PM);
        r = ICRA(CRA).previewAdjustedRate(POOL);
    }

    /// Crash the oracle far below rateMin; watch the adjusted-rate floor descend over time.
    function test_floor_trajectory_after_oracle_crash() public {
        Market memory m = IPM(PM).market(POOL);
        (uint256 lastRate, uint256 lastTs, uint256 credits) = ICRA(CRA).constraints(POOL);
        console2.log("t0 block.timestamp", block.timestamp);
        console2.log("market.rateMin", m.rateMin);
        console2.log("market.rateMax", m.rateMax);
        console2.log("market.rateChangePerDayMax", m.rateChangePerDayMax);
        console2.log("market.rateChangeCapacityMax", m.rateChangeCapacityMax);
        console2.log("constraints.lastAdjustedRate", lastRate);
        console2.log("constraints.lastAdjustmentTimestamp", lastTs);
        console2.log("constraints.remainingCredits", credits);

        // mock a catastrophic oracle: 0.5e18, far below rateMin
        // (live oracle at vnet head panics 0x11 — see test_live_oracle_probe)
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(5e17)));
        console2.log("PM.swapRate() mocked-crash", IPM(PM).swapRate(POOL));

        uint256 t0 = block.timestamp;
        uint256[9] memory horizons = [uint256(0), 1 hours, 12 hours, 1 days, 2 days, 4 days, 7 days, 14 days, 30 days];
        for (uint256 i = 0; i < horizons.length; i++) {
            uint256 r = _rateAt(t0 + horizons[i]);
            console2.log("horizon_s", horizons[i]);
            console2.log("  previewAdjustedRate", r);
        }
    }

    /// Does swapRate (the public path) equal the CRA preview under the same conditions?
    function test_swapRate_equals_preview_under_crash() public {
        Market memory m = IPM(PM).market(POOL);
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(5e17)));
        vm.warp(block.timestamp + 3 days);
        vm.prank(PM);
        uint256 pre = ICRA(CRA).previewAdjustedRate(POOL);
        uint256 pub = IPM(PM).swapRate(POOL);
        console2.log("previewAdjustedRate", pre);
        console2.log("swapRate", pub);
        assertEq(pre, pub, "swapRate != previewAdjustedRate");
    }

    /// Credit accounting: consume credits via adjustedRate (state-changing), then observe refill over time.
    function test_credit_consumption_and_refill() public {
        Market memory m = IPM(PM).market(POOL);
        (uint256 lastRate,, uint256 credits0) = ICRA(CRA).constraints(POOL);
        console2.log("credits before", credits0);

        // Crash oracle, let 2 days pass, commit an adjustment
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(5e17)));
        vm.warp(block.timestamp + 2 days);
        vm.prank(PM);
        uint256 r1 = ICRA(CRA).adjustedRate(POOL);
        (uint256 lastRate1,, uint256 credits1) = ICRA(CRA).constraints(POOL);
        console2.log("rate after 2d crash commit", r1);
        console2.log("credits after commit", credits1);
        console2.log("rate moved by", lastRate - lastRate1);

        // Now oracle recovers to previous rate; observe ascent + credit behavior after 1 day
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(lastRate));
        vm.warp(block.timestamp + 1 days);
        vm.prank(PM);
        uint256 r2 = ICRA(CRA).adjustedRate(POOL);
        (,, uint256 credits2) = ICRA(CRA).constraints(POOL);
        console2.log("rate after 1d recovery commit", r2);
        console2.log("credits after recovery", credits2);
    }

    /// The live oracle at vnet head: does rate() itself panic?
    function test_live_oracle_probe() public {
        Market memory m = IPM(PM).market(POOL);
        try IOracle(m.rateOracle).rate() returns (uint256 r) {
            console2.log("live oracle rate()", r);
        } catch Panic(uint256 code) {
            console2.log("live oracle PANIC code", code);
        } catch (bytes memory data) {
            console2.log("live oracle revert, data:");
            console2.logBytes(data);
        }
    }

    /// Preview functions on the live pool with zero liquidity: zeros or revert? (oracle mocked)
    function test_previews_on_empty_pool() public {
        Market memory m = IPM(PM).market(POOL);
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(8e17)));
        (uint256 ca, uint256 ra) = IPM(PM).assets(POOL);
        console2.log("assets collateral", ca);
        console2.log("assets reference", ra);
        (uint256 cst, uint256 refIn, uint256 fee) = IPM(PM).previewSwap(POOL, 1e18);
        console2.log("previewSwap(1e18 CA out): cstIn", cst);
        console2.log("  refIn", refIn);
        console2.log("  fee", fee);
        (uint256 cstOut, uint256 refOut, uint256 fee2) = IPM(PM).previewUnwindSwap(POOL, 1e18);
        console2.log("previewUnwindSwap(1e18 CA in): cstOut", cstOut);
        console2.log("  refOut", refOut);
        console2.log("  fee2", fee2);
    }
}
