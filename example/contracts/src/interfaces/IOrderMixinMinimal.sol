// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.30;

/// @dev Vendored minimal subset of the 1inch Limit Order Protocol v4 taker surface
///      (npm `1inch/limit-order-protocol-contract` 4.3.4, `contracts/interfaces/IOrderMixin.sol`).
///      1inch declares `maker/receiver/makerAsset/takerAsset` as the user-defined value
///      type `Address` and `makerTraits`/`takerTraits` as `MakerTraits`/`TakerTraits` —
///      all `uint256` wraps. User-defined value types canonicalize to their underlying
///      type in the ABI, so declaring them as plain `uint256` here yields byte-identical
///      selectors and encoding against the deployed protocol
///      (0x111111125421cA6dc452d289314280a0f8842A65 on all supported chains).
interface IOrderMixinMinimal {
    /// @notice A signed LOP v4 order. `receiver` is the MAKER's receiving leg (where the
    ///         taking amount goes); the TAKER's receiving leg is the fill-time `target`
    ///         carried in `args`, gated by takerTraits bit 251.
    struct Order {
        uint256 salt;
        uint256 maker;
        uint256 receiver;
        uint256 makerAsset;
        uint256 takerAsset;
        uint256 makingAmount;
        uint256 takingAmount;
        uint256 makerTraits;
    }

    /// @notice Fill an EOA-signed order (compact r/vs signature).
    function fillOrderArgs(
        Order calldata order,
        bytes32 r,
        bytes32 vs,
        uint256 amount,
        uint256 takerTraits,
        bytes calldata args
    ) external payable returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash);

    /// @notice Fill a contract-maker (ERC-1271) order. NOT payable upstream.
    function fillContractOrderArgs(
        Order calldata order,
        bytes calldata signature,
        uint256 amount,
        uint256 takerTraits,
        bytes calldata args
    ) external returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash);

    /// @notice EIP-712 hash of an order under the protocol's domain (used by tests to sign).
    function hashOrder(Order calldata order) external view returns (bytes32 orderHash);
}
