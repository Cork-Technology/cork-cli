// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MathHelperMirror} from "../src/MathHelperMirror.sol";

/// Empirically establishes the Solidity (ground-truth) revert boundary for the MathHelper
/// functions that the cork-core bigint ports mirror. Each `expectRevert` here is a place where
/// the TS port instead returns a value (the C3 "domain-extension" footgun class). The concrete
/// vectors mirror the exact inputs used in the TS property harness so the two are differential.
contract RevertDomainParity is Test {
    MathHelperMirror m;

    function setUp() public {
        m = new MathHelperMirror();
    }

    // ---- computeT: Solidity reverts when current < start (underflow) --------------------------
    function test_computeT_currentBeforeStart_reverts() public {
        vm.expectRevert(); // arithmetic underflow on `current - start`
        m.computeT(1000, 2000, 900);
    }

    // TS port for the SAME inputs returns t = 1_000_000_000_000_000_000 * (1.1) style > WAD.
    function testFuzz_computeT_valid_in_range(uint40 start, uint40 dCur, uint40 dEnd) public view {
        uint256 end = uint256(start) + dEnd + 1; // end > start
        uint256 current = uint256(start) + dCur; // current >= start
        uint256 t = m.computeT(start, end, current);
        assertLe(t, 1e18); // on the valid domain t in [0, WAD]
    }

    // ---- computeT: end < start reverts (Solidity) where TS silently returns 0 ------------------
    function test_computeT_endBeforeStart_reverts() public {
        vm.expectRevert(); // `end - start` underflow
        m.computeT(100, 50, 100);
    }

    // ---- calculateGrossAmountBeforeFee: fee == 100% reverts (div by zero) ----------------------
    function test_gross_fee100pct_reverts() public {
        vm.expectRevert(); // 100e18 - 100e18 == 0 => OZ mulDiv div-by-zero
        m.calculateGrossAmountBeforeFee(1000e18, 100e18);
    }

    // ---- calculateGrossAmountBeforeFee: fee > 100% reverts (underflow) -------------------------
    // TS port returns a NEGATIVE number silently for the same input.
    function test_gross_fee101pct_reverts() public {
        vm.expectRevert(); // 100e18 - 101e18 underflow
        m.calculateGrossAmountBeforeFee(1000e18, 101e18);
    }

    // On the valid fee domain (< 100%) it never reverts and gross >= desired.
    function testFuzz_gross_valid(uint128 desired, uint64 feeRate) public view {
        vm.assume(feeRate < 100e18);
        uint256 gross = m.calculateGrossAmountBeforeFee(desired, feeRate);
        assertGe(gross, desired);
    }

    // ---- calculateGrossAmountWithTimeDecayFee: feeFactor > 100% reverts ------------------------
    // TS port returns negative fee/assetIn silently for base=200%.
    function test_grossTimeDecay_bigBase_reverts() public {
        vm.expectRevert(); // feeFactor ~ 200e18 -> 100e18 - feeFactor underflow
        m.calculateGrossAmountWithTimeDecayFee(1000, 2000, 1001, 1000e18, 200e18);
    }

    // ---- calculateTimeDecayFee: current < start reverts -> port inflates fee above base --------
    function test_timeDecayFee_currentBeforeStart_reverts() public {
        vm.expectRevert();
        m.calculateTimeDecayFee(1000, 2000, 900, 1e18, 5e18);
    }

    // On the valid domain, the time-decay fee is <= the full-base fee (t normalizes to <= 1).
    function testFuzz_timeDecayFee_le_baseFee(uint40 start, uint40 dCur, uint40 dEnd, uint96 amount, uint64 base)
        public
        view
    {
        vm.assume(base <= 5e18); // realistic <= MAX_ALLOWED_FEES
        uint256 end = uint256(start) + dEnd + 1;
        uint256 current = uint256(start) + dCur;
        uint256 fee = m.calculateTimeDecayFee(start, end, current, amount, base);
        // full-base fee = ceil(amount*base/100e18)
        uint256 full = _ceilMulDiv(amount, base, 100e18);
        assertLe(fee, full);
    }

    // ---- mulDiv overflow: Solidity reverts when true quotient > uint256.max --------------------
    function test_mulDiv_overflow_reverts() public {
        // x*y/d where quotient exceeds uint256 — sample from the TS harness's P1 finding.
        vm.expectRevert();
        m.mulDivFloor(type(uint256).max, type(uint256).max, 1);
    }

    // ---- ceilDiv: b == 0 reverts (Solidity) — matches TS throw ---------------------------------
    function test_ceilDiv_divByZero_reverts() public {
        vm.expectRevert();
        m.ceilDiv(5, 0);
    }

    function _ceilMulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        uint256 p = x * y;
        return p == 0 ? 0 : (p - 1) / d + 1;
    }
}
