// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.30;

// Exact copies of phoenix-private MathHelper bodies (verified against
// contracts/libraries/MathHelper.sol @ 9e4b345) over the REAL OpenZeppelin Math (vendored).
// Used to establish the GROUND-TRUTH Solidity revert domain empirically, to differential-check
// the @cork/core bigint ports (which never revert on the same inputs).
import {Math} from "./vendor/math/Math.sol";

contract MathHelperMirror {
    using Math for uint256;

    function mulDivFloor(uint256 x, uint256 y, uint256 d) external pure returns (uint256) {
        return x.mulDiv(y, d, Math.Rounding.Floor);
    }

    function mulDivCeil(uint256 x, uint256 y, uint256 d) external pure returns (uint256) {
        return x.mulDiv(y, d, Math.Rounding.Ceil);
    }

    function ceilDiv(uint256 a, uint256 b) external pure returns (uint256) {
        return a.ceilDiv(b);
    }

    function computeT(uint256 start, uint256 end, uint256 current) external pure returns (uint256) {
        return _computeT(start, end, current);
    }

    function _computeT(uint256 start, uint256 end, uint256 current) internal pure returns (uint256) {
        uint256 elapsedTime = current - start;
        elapsedTime = elapsedTime == 0 ? 1 : elapsedTime;
        uint256 totalDuration = end - start;
        if (elapsedTime >= totalDuration) return 0;
        return ((totalDuration - elapsedTime) * 1e18) / totalDuration;
    }

    function calculateTimeDecayFee(
        uint256 start,
        uint256 end,
        uint256 current,
        uint256 amount,
        uint256 baseFeePercentage
    ) external pure returns (uint256 fee) {
        if (amount == 0) return 0;
        uint256 t = _computeT(start, end, current);
        uint256 feeFactor = baseFeePercentage.mulDiv(t, 1e18, Math.Rounding.Ceil);
        fee = amount.mulDiv(feeFactor, 100e18, Math.Rounding.Ceil);
    }

    function calculateGrossAmountBeforeFee(uint256 desiredAmount, uint256 feeRate)
        external
        pure
        returns (uint256 grossAmount)
    {
        grossAmount = desiredAmount.mulDiv(100e18, 100e18 - feeRate, Math.Rounding.Ceil);
    }

    function calculateGrossAmountWithTimeDecayFee(
        uint256 start,
        uint256 end,
        uint256 current,
        uint256 amount,
        uint256 baseFeePercentage
    ) external pure returns (uint256 fee, uint256 assetIn) {
        if (amount == 0) return (0, 0);
        uint256 t = _computeT(start, end, current);
        uint256 feeFactor = baseFeePercentage.mulDiv(t, 1e18, Math.Rounding.Ceil);
        uint256 withFee = amount.mulDiv(100e18, (100e18 - feeFactor), Math.Rounding.Ceil);
        assetIn = withFee;
        fee = (assetIn - amount);
    }
}
