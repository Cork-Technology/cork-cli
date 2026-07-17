// Common non-Cork Bundler3 legs so decodeBundle labels them instead of dumping "unknown":
// GeneralAdapter1/CoreAdapter fund actions + plain ERC20 ops that appear inside real bundles.
// Signatures verified against phoenix-private periphery (GeneralAdapter1/CoreAdapter/GeneralAdapter).
import { parseAbi } from "viem";

export const bundlerLegAbi = parseAbi([
  // GeneralAdapter1 / CoreAdapter fund + transfer actions (called on the adapter itself)
  "function erc20TransferFrom(address token, address receiver, uint256 amount)",
  "function permit2TransferFrom(address token, address receiver, uint256 amount)",
  "function erc20Transfer(address token, address receiver, uint256 amount)",
  "function nativeTransfer(address receiver, uint256 amount)",
  "function permit2TransferFromWithPermit(((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, bytes signature, address receiver, uint256 amount)",
  // Plain ERC20 legs (target = the token)
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);
