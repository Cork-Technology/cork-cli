// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {Market, IPM, ICRA, IOracle} from "./ImpairmentFloor.t.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IPMActions {
    function deposit(bytes32 poolId, uint256 collateralAssetsIn, address receiver) external returns (uint256);
    function swap(bytes32 poolId, uint256 collateralAssetsOut, address receiver)
        external returns (uint256 cstSharesIn, uint256 referenceAssetsIn, uint256 fee);
    function shares(bytes32 poolId) external view returns (address principalToken, address swapToken);
}

interface IWLM {
    function isMarketWhitelistEnabled(bytes32 poolId) external view returns (bool);
}

contract UnwindLifecycleTest is Test {
    address constant PM = 0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC;
    address constant WLM = 0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE;
    bytes32 constant POOL = 0xe855cf62e91b7a8690349d3834a36f07bb2ee2965d9db1d3bf1de2bd55ee6296;
    address alice = makeAddr("alice");

    /// Full lifecycle directly on the PoolManager (bypassing the adapter):
    /// is deposit/swap whitelist-gated at PM level? Then: unwind fee time decay.
    function test_lifecycle_and_unwind_fee_decay() public {
        Market memory m = IPM(PM).market(POOL);
        console2.log("whitelist enabled for POOL:", IWLM(WLM).isMarketWhitelistEnabled(POOL));
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(8e17)));

        // fund alice with collateral (sUSDe) and reference (vbUSDC)
        deal(m.collateralAsset, alice, 1_000e18);
        deal(m.referenceAsset, alice, 1_000_000e6);

        vm.startPrank(alice);
        IERC20(m.collateralAsset).approve(PM, type(uint256).max);
        IERC20(m.referenceAsset).approve(PM, type(uint256).max);

        // 1) deposit 100 sUSDe
        uint256 sharesOut = IPMActions(PM).deposit(POOL, 100e18, alice);
        console2.log("deposit 100e18 CA -> shares", sharesOut);

        // 2) swap: receive 10 sUSDe out, paying cST + vbUSDC
        (uint256 cstIn, uint256 refIn, uint256 fee) = IPMActions(PM).swap(POOL, 10e18, alice);
        console2.log("swap 10e18 CA out: cstIn", cstIn);
        console2.log("  refIn", refIn);
        console2.log("  fee", fee);
        vm.stopPrank();

        // 3) previewUnwindSwap over time: unwind fee decay toward expiry
        uint256 t0 = block.timestamp;
        uint256 tExp = m.expiryTimestamp;
        console2.log("now", t0);
        console2.log("expiry", tExp);
        uint256[6] memory hs = [uint256(0), 1 days, 7 days, 30 days, 60 days, 75 days];
        for (uint256 i; i < hs.length; i++) {
            if (t0 + hs[i] >= tExp) break;
            vm.warp(t0 + hs[i]);
            (uint256 cstOut, uint256 refOut, uint256 f) = IPM(PM).previewUnwindSwap(POOL, 5e18);
            console2.log("unwind preview at +days", hs[i] / 1 days);
            console2.log("  cstOut", cstOut);
            console2.log("  refOut", refOut);
            console2.log("  fee", f);
        }
    }
}
