// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Settable IRateOracle for the shared Tenderly vnet test fixture.
/// @dev Intentionally permissionless setter: shared dev/test environment convenience.
///      rate() = value of 1 Reference Asset quoted in Collateral Asset, WAD.
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

    function setRate(uint256 newRate) external {
        _rate = newRate;
        emit RateSet(msg.sender, newRate);
    }
}
