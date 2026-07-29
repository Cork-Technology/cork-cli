// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only contract maker: accepts a single pre-approved order hash via ERC-1271.
contract ERC1271Maker {
    bytes32 public approvedHash;

    function setApprovedHash(bytes32 hash) external {
        approvedHash = hash;
    }

    function approveToken(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        return hash == approvedHash ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
