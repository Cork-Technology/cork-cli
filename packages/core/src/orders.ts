// 1inch Limit Order Protocol v4 order construction (EIP-712 typed data) + cancel calldata.
// Order struct, typehash, and domain verified against limit-order-protocol/contracts
// (OrderLib._LIMIT_ORDER_TYPEHASH, LimitOrderProtocol EIP712("1inch Limit Order Protocol","4")).
// The produced orderHash is proven equal to on-chain LOP.hashOrder(order) in the fork tests.
import { encodeFunctionData, hashTypedData, keccak256, parseAbi, stringToHex, zeroAddress } from "viem";

import bundledDefaults from "../../../cork-defaults.json";

/** Canonical 1inch order-settlement contract (Aggregation Router V6, embeds the LOP order mixin).
 *  Sourced from the bundled cork-defaults.json — no address literals in source. */
export const LOP_ADDRESSES: Record<number, `0x${string}`> = Object.fromEntries(
  Object.entries(bundledDefaults.lopAddresses).map(([k, v]) => [Number(k), v as `0x${string}`]),
);

// EIP-712 domain the deployed contract ACTUALLY uses — read empirically from its eip712Domain()
// (ERC-5267): name "1inch Aggregation Router", version "6" (NOT the reference repo's LOP/"4").
// Proven correct by the on-chain hashOrder parity test.
const DOMAIN_NAME = "1inch Aggregation Router";
const DOMAIN_VERSION = "6";

// MakerTraits bit layout (MakerTraitsLib.sol).
const NO_PARTIAL_FILLS_FLAG = 1n << 255n;
const ALLOW_MULTIPLE_FILLS_FLAG = 1n << 254n;
const USE_PERMIT2_FLAG = 1n << 248n;
const U40 = (1n << 40n) - 1n;

export interface MakerTraitsParts {
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
  usePermit2: boolean;
  expiry: bigint; // unix seconds (0 = none)
  nonce: bigint;
}

export function buildMakerTraits(p: MakerTraitsParts): bigint {
  let t = 0n;
  if (!p.allowPartialFills) t |= NO_PARTIAL_FILLS_FLAG;
  if (p.allowMultipleFills) t |= ALLOW_MULTIPLE_FILLS_FLAG;
  if (p.usePermit2) t |= USE_PERMIT2_FLAG;
  t |= (p.expiry & U40) << 80n;
  t |= (p.nonce & U40) << 120n;
  return t; // low 80 bits (allowed sender) = 0 => any taker
}

export interface LopOrder {
  salt: bigint;
  maker: `0x${string}`;
  receiver: `0x${string}`;
  makerAsset: `0x${string}`;
  takerAsset: `0x${string}`;
  makingAmount: bigint;
  takingAmount: bigint;
  makerTraits: bigint;
}

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "receiver", type: "address" },
    { name: "makerAsset", type: "address" },
    { name: "takerAsset", type: "address" },
    { name: "makingAmount", type: "uint256" },
    { name: "takingAmount", type: "uint256" },
    { name: "makerTraits", type: "uint256" },
  ],
} as const;

export function lopDomain(chainId: number, verifyingContract: `0x${string}`) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract } as const;
}

export interface MakerOrderArgs {
  chainId: number;
  lop: `0x${string}`;
  maker: `0x${string}`;
  makerAsset: `0x${string}`;
  takerAsset: `0x${string}`;
  makingAmount: bigint;
  takingAmount: bigint;
  clientRequestId: string;
  expiry?: bigint;
  allowPartialFills?: boolean;
  usePermit2?: boolean;
}

export interface MakerOrderResult {
  order: LopOrder;
  domain: ReturnType<typeof lopDomain>;
  types: typeof ORDER_TYPES;
  primaryType: "Order";
  orderHash: `0x${string}`;
}

/** Build a signable LOP v4 maker order + its EIP-712 hash (equals on-chain hashOrder). */
export function buildMakerOrder(a: MakerOrderArgs): MakerOrderResult {
  // Deterministic salt from the idempotency key; kept < 2^160 (high bits are reserved for an
  // extension hash, and this order carries no extension).
  const salt = BigInt(keccak256(stringToHex(a.clientRequestId))) & ((1n << 160n) - 1n);
  const makerTraits = buildMakerTraits({
    allowPartialFills: a.allowPartialFills ?? true,
    allowMultipleFills: false,
    usePermit2: a.usePermit2 ?? false,
    expiry: a.expiry ?? 0n,
    nonce: 0n,
  });
  const order: LopOrder = {
    salt,
    maker: a.maker,
    receiver: zeroAddress,
    makerAsset: a.makerAsset,
    takerAsset: a.takerAsset,
    makingAmount: a.makingAmount,
    takingAmount: a.takingAmount,
    makerTraits,
  };
  const domain = lopDomain(a.chainId, a.lop);
  const orderHash = hashTypedData({ domain, types: ORDER_TYPES, primaryType: "Order", message: order });
  return { order, domain, types: ORDER_TYPES, primaryType: "Order", orderHash };
}

const lopAbi = parseAbi(["function cancelOrder(uint256 makerTraits, bytes32 orderHash)"]);

/** Build LOP.cancelOrder(makerTraits, orderHash) calldata (a direct call, not typed data). */
export function buildCancelOrder(makerTraits: bigint, orderHash: `0x${string}`): { to: null; data: `0x${string}` } {
  return { to: null, data: encodeFunctionData({ abi: lopAbi, functionName: "cancelOrder", args: [makerTraits, orderHash] }) };
}
