// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {Market, IPM, ICRA, IOracle} from "./ImpairmentFloor.t.sol";

contract DescentToFloorTest is Test {
    address constant PM = 0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC;
    address constant CRA = 0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A;
    bytes32 constant POOL = 0xe855cf62e91b7a8690349d3834a36f07bb2ee2965d9db1d3bf1de2bd55ee6296;

    /// Adversarial descent: commit adjustedRate daily after an oracle crash.
    /// Expect: first commit spends the full bucket, then ~perDayMax per day, clamping at rateMin.
    function test_daily_commit_descent_to_rateMin() public {
        Market memory m = IPM(PM).market(POOL);
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(5e17)));

        (uint256 r0,,) = ICRA(CRA).constraints(POOL);
        console2.log("start lastAdjustedRate", r0);
        console2.log("rateMin", m.rateMin);

        uint256 prev = r0;
        uint256 daysElapsed = 0;
        for (uint256 d = 1; d <= 90; d++) {
            vm.warp(block.timestamp + 1 days);
            vm.prank(PM);
            uint256 r = ICRA(CRA).adjustedRate(POOL);
            if (d <= 3 || d % 10 == 0 || (r == m.rateMin && prev != m.rateMin)) {
                console2.log("day", d);
                console2.log("  rate", r);
                console2.log("  moved", prev - r);
            }
            if (r == m.rateMin && prev == m.rateMin) { daysElapsed = d; break; }
            prev = r;
        }
        console2.log("floor reached and stable by day", daysElapsed);
        assertEq(prev, m.rateMin, "should clamp at rateMin");
    }

    /// Refill cap: with credits at 0, how much movement does a single commit allow
    /// after 3d, and after 14d (capacity/perDay = 7d so 14d should cap at capacityMax)?
    function test_refill_caps_at_capacity() public {
        Market memory m = IPM(PM).market(POOL);
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(5e17)));

        // drain the bucket with one commit
        vm.prank(PM);
        uint256 r1 = ICRA(CRA).adjustedRate(POOL);
        (,, uint256 c1) = ICRA(CRA).constraints(POOL);
        console2.log("after drain: rate", r1);
        console2.log("after drain: credits", c1);

        // 3 days idle -> expect movement = 3 * perDayMax
        vm.warp(block.timestamp + 3 days);
        vm.prank(PM);
        uint256 r2 = ICRA(CRA).adjustedRate(POOL);
        console2.log("after 3d idle commit moved", r1 - r2);
        console2.log("3 x perDayMax =", 3 * m.rateChangePerDayMax);

        // 14 days idle -> expect movement capped at capacityMax (7d worth)
        vm.warp(block.timestamp + 14 days);
        vm.prank(PM);
        uint256 r3 = ICRA(CRA).adjustedRate(POOL);
        console2.log("after 14d idle commit moved", r2 - r3);
        console2.log("capacityMax =", m.rateChangeCapacityMax);
    }

    /// Does a preview far in the future (no commits) also include time-accrued refill
    /// beyond stored credits? (stored credits were full at fork, so drain first)
    function test_preview_includes_time_accrued_refill() public {
        Market memory m = IPM(PM).market(POOL);
        vm.mockCall(m.rateOracle, abi.encodeWithSelector(IOracle.rate.selector), abi.encode(uint256(5e17)));
        vm.prank(PM);
        uint256 r1 = ICRA(CRA).adjustedRate(POOL); // drain
        (,, uint256 c) = ICRA(CRA).constraints(POOL);
        console2.log("drained rate", r1);
        console2.log("stored credits", c);
        uint256[4] memory hs = [uint256(1 days), 3 days, 7 days, 21 days];
        for (uint256 i; i < hs.length; i++) {
            vm.warp(block.timestamp + (i == 0 ? hs[0] : hs[i] - hs[i-1]));
            vm.prank(PM);
            uint256 p = ICRA(CRA).previewAdjustedRate(POOL);
            console2.log("preview at +days", hs[i] / 1 days);
            console2.log("  rate", p);
            console2.log("  below drained by", r1 - p);
        }
    }
}
