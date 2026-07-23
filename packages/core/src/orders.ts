// 1inch Limit Order Protocol v4 order construction (EIP-712 typed data) + cancel calldata.
// Order struct, typehash, and domain verified against limit-order-protocol/contracts
// (OrderLib._LIMIT_ORDER_TYPEHASH, LimitOrderProtocol EIP712("1inch Limit Order Protocol","4")).
// The produced orderHash is proven equal to on-chain LOP.hashOrder(order) in the fork tests.
import { encodeFunctionData, hashTypedData, keccak256, parseAbi, sliceHex, stringToHex, zeroAddress } from "viem";

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
const PRE_INTERACTION_CALL_FLAG = 1n << 252n;
const POST_INTERACTION_CALL_FLAG = 1n << 251n;
const HAS_EXTENSION_FLAG = 1n << 249n;
const USE_PERMIT2_FLAG = 1n << 248n;

// Interaction flags are NOT implied by HAS_EXTENSION: OrderMixin only invokes the pre-/post-
// interaction embedded in the extension when the matching makerTraits bit is set. An extension
// that carries a preInteraction (our JIT adapter hook) but omits PRE_INTERACTION_CALL_FLAG fills
// as a no-op — the hook never runs, so no market is created (caught by the fork round-trip test).
// Detect which interaction fields are non-empty from the ExtensionLib offset header (32 bytes of
// eight uint32 cumulative END offsets; field i spans [offset[i-1], offset[i]); pre = field 6,
// post = field 7) and set exactly the flags the extension needs.
function extensionInteractionFlags(extension: `0x${string}`): bigint {
  const offsets = BigInt(sliceHex(extension, 0, 32));
  const off = (i: bigint) => (offsets >> (32n * i)) & 0xffffffffn;
  let flags = 0n;
  if (off(6n) > off(5n)) flags |= PRE_INTERACTION_CALL_FLAG;
  if (off(7n) > off(6n)) flags |= POST_INTERACTION_CALL_FLAG;
  return flags;
}
const U40 = (1n << 40n) - 1n;
const U96 = (1n << 96n) - 1n;
const U160 = (1n << 160n) - 1n;

export interface MakerTraitsParts {
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
  usePermit2: boolean;
  hasExtension?: boolean;
  expiry: bigint; // unix seconds (0 = none)
  nonce: bigint;
}

export function buildMakerTraits(p: MakerTraitsParts): bigint {
  let t = 0n;
  if (!p.allowPartialFills) t |= NO_PARTIAL_FILLS_FLAG;
  if (p.allowMultipleFills) t |= ALLOW_MULTIPLE_FILLS_FLAG;
  if (p.usePermit2) t |= USE_PERMIT2_FLAG;
  if (p.hasExtension) t |= HAS_EXTENSION_FLAG;
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
  /** Cork hook extension bytes (deploy-on-fill / JIT-mint orders). When present, the salt's low
   *  160 bits are BOUND to keccak256(extension) (OrderLib checks this at fill) and
   *  HAS_EXTENSION_FLAG is set; determinism moves to the top 96 bits. */
  extension?: `0x${string}`;
}

export interface MakerOrderResult {
  order: LopOrder;
  domain: ReturnType<typeof lopDomain>;
  types: typeof ORDER_TYPES;
  primaryType: "Order";
  orderHash: `0x${string}`;
  /** Extension bytes the taker must pass verbatim at fill ("0x" = plain order). */
  extension: `0x${string}`;
}

/** Build a signable LOP v4 maker order + its EIP-712 hash (equals on-chain hashOrder). */
export function buildMakerOrder(a: MakerOrderArgs): MakerOrderResult {
  const hasExtension = a.extension !== undefined && a.extension !== "0x";
  // Deterministic salt from the idempotency key. Plain order: low 160 bits of keccak(id).
  // Extension order: low 160 bits MUST be keccak(extension)'s low 160 (OrderLib fill check);
  // the idempotency-derived entropy moves to the free top 96 bits.
  const salt = hasExtension
    ? ((BigInt(keccak256(stringToHex(a.clientRequestId))) & U96) << 160n) | (BigInt(keccak256(a.extension!)) & U160)
    : BigInt(keccak256(stringToHex(a.clientRequestId))) & U160;
  let makerTraits = buildMakerTraits({
    allowPartialFills: a.allowPartialFills ?? true,
    allowMultipleFills: false,
    usePermit2: a.usePermit2 ?? false,
    hasExtension,
    expiry: a.expiry ?? 0n,
    nonce: 0n,
  });
  // An extension with a pre-/post-interaction only runs if its makerTraits flag is set.
  if (hasExtension) makerTraits |= extensionInteractionFlags(a.extension!);
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
  return { order, domain, types: ORDER_TYPES, primaryType: "Order", orderHash, extension: hasExtension ? a.extension! : "0x" };
}

const lopAbi = parseAbi(["function cancelOrder(uint256 makerTraits, bytes32 orderHash)"]);

/** Build LOP.cancelOrder(makerTraits, orderHash) calldata (a direct call, not typed data). */
export function buildCancelOrder(makerTraits: bigint, orderHash: `0x${string}`): { to: null; data: `0x${string}` } {
  return { to: null, data: encodeFunctionData({ abi: lopAbi, functionName: "cancelOrder", args: [makerTraits, orderHash] }) };
}

// ── On-chain liveness of a resting order (cancel-flow UX) ────────────────────
// LOP v4 tracks fills/cancels in one of two invalidators, selected by makerTraits
// (MakerTraitsLib.useBitInvalidator = NO_PARTIAL_FILLS(bit 255) set OR ALLOW_MULTIPLE_FILLS
// (bit 254) unset). Note our own buildMakerOrder sets allowMultipleFills:false, so Cork-built
// orders always live in the BIT invalidator (slot = nonceOrEpoch >> 8, mask = 1 << (nonce & 0xff),
// per OrderMixin.cancelOrder/bitsInvalidateForOrder). Foreign multiple-fill orders use the
// remaining invalidator, where raw == 0 means never-touched (remainingInvalidatorForOrder REVERTS
// there — read the RAW view) and otherwise remaining = ~raw (RemainingInvalidatorLib).
export const lopInvalidatorAbi = parseAbi([
  "function rawRemainingInvalidatorForOrder(address maker, bytes32 orderHash) view returns (uint256)",
  "function bitInvalidatorForOrder(address maker, uint256 slot) view returns (uint256)",
]);

const NONCE_OR_EPOCH_OFFSET = 120n;
const U256_MAX_ = (1n << 256n) - 1n;

export type LopInvalidatorPlan =
  | { mode: "bit"; slot: bigint; mask: bigint; nonceOrEpoch: bigint }
  | { mode: "remaining" };

/** Which invalidator view to read for an order, from its makerTraits (MakerTraitsLib layout). */
export function lopInvalidatorPlan(makerTraits: bigint): LopInvalidatorPlan {
  const allowPartial = (makerTraits & NO_PARTIAL_FILLS_FLAG) === 0n;
  const allowMultiple = (makerTraits & ALLOW_MULTIPLE_FILLS_FLAG) !== 0n;
  if (!allowPartial || !allowMultiple) {
    const nonceOrEpoch = (makerTraits >> NONCE_OR_EPOCH_OFFSET) & U40;
    return { mode: "bit", slot: nonceOrEpoch >> 8n, mask: 1n << (nonceOrEpoch & 0xffn), nonceOrEpoch };
  }
  return { mode: "remaining" };
}

export interface LopOnChainStatus {
  status: "live-untouched" | "live-partially-filled" | "filled-or-cancelled";
  /** Remaining making amount, when the invalidator encodes one (remaining mode, touched). */
  remaining?: bigint;
}

/** Classify a rawRemainingInvalidatorForOrder read (remaining-invalidator orders). */
export function classifyRemainingRaw(raw: bigint): LopOnChainStatus {
  if (raw === 0n) return { status: "live-untouched" };
  const remaining = U256_MAX_ ^ raw; // solidity `~value` on uint256
  return remaining === 0n ? { status: "filled-or-cancelled" } : { status: "live-partially-filled", remaining };
}

/** Classify a bitInvalidatorForOrder read (bit-invalidator orders: filled OR cancelled sets the bit). */
export function classifyBitInvalidator(slotValue: bigint, mask: bigint): LopOnChainStatus {
  return (slotValue & mask) === 0n ? { status: "live-untouched" } : { status: "filled-or-cancelled" };
}
