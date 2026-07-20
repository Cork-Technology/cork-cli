// Cork rollover order construction: EIP-712 typed data for `OrderData` under the CorkSettler
// domain, plus the zero-digest `RolloverIntent` commitment (`rolloverIntentHash`) [K3: recomputed
// locally, never accepted from the caller].
//
// Structs, typehash preimages, and encoding order are ported from the DEPLOYED pin
// `rollover-private @ 032d3e5a` (src/libraries/{Typehashes,LibSettlerHashing,
// LibAuthenticatedHooks}.sol). The typehash preimages are frozen post-launch on-chain
// (INV-WIRE-ORDER-STABILITY), and the computed domain separator is proven equal to both live
// Arbitrum settlers' DOMAIN_SEPARATOR() (golden vectors in test/rollover.test.ts).
import {
  concatHex,
  encodeAbiParameters,
  hashDomain,
  hashTypedData,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";

type Address = `0x${string}`;
type Hex = `0x${string}`;

// ── Frozen EIP-712 type strings (verbatim from Typehashes.sol @ 032d3e5a) ──────────────────────
const ORDER_DATA_TYPE_STRING =
  "OrderData(address user,address settler,address fillerHint,address exclusiveFiller,address srcCstToken,address dstCstToken,address premiumToken,address rolloverContract,uint64 originChainId,uint64 destinationChainId,uint64 openDeadline,uint64 fillDeadline,uint64 orderSalt,uint256 orderSize,uint256 minPremiumPerShare,bool allowPartialFills,bool allowUnderfill,uint8 premiumPaymentMode,bytes32 rolloverIntentHash,RolloverParams rolloverParams)RolloverParams(address srcCstToken,address dstCstToken,uint256 minCaReceived,uint256 minSharesOut,bytes32 srcPoolId,bytes32 dstPoolId,address settler)";
const ROLLOVER_PARAMS_TYPE_STRING =
  "RolloverParams(address srcCstToken,address dstCstToken,uint256 minCaReceived,uint256 minSharesOut,bytes32 srcPoolId,bytes32 dstPoolId,address settler)";
const ROLLOVER_INTENT_TYPE_STRING =
  "RolloverIntent(address rolloverContract,bytes32 orderDigest,uint64 deadline,uint64 nonce,Call[] preRolloverHooks,Call[] midRolloverHooks,Call[] postRolloverHooks,Call[] premiumHooks)Call(address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)";
const CALL_TYPE_STRING =
  "Call(address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)";

export const ORDER_DATA_TYPEHASH: Hex = keccak256(stringToHex(ORDER_DATA_TYPE_STRING));
export const ROLLOVER_PARAMS_TYPEHASH: Hex = keccak256(stringToHex(ROLLOVER_PARAMS_TYPE_STRING));
export const ROLLOVER_INTENT_TYPEHASH: Hex = keccak256(stringToHex(ROLLOVER_INTENT_TYPE_STRING));
export const CALL_TYPEHASH: Hex = keccak256(stringToHex(CALL_TYPE_STRING));

// viem-shaped types for hashTypedData/signTypedData. EIP-712 appends referenced structs sorted
// by name, so this reproduces ORDER_DATA_TYPE_STRING exactly (asserted in tests).
export const ORDER_DATA_TYPES = {
  OrderData: [
    { name: "user", type: "address" },
    { name: "settler", type: "address" },
    { name: "fillerHint", type: "address" },
    { name: "exclusiveFiller", type: "address" },
    { name: "srcCstToken", type: "address" },
    { name: "dstCstToken", type: "address" },
    { name: "premiumToken", type: "address" },
    { name: "rolloverContract", type: "address" },
    { name: "originChainId", type: "uint64" },
    { name: "destinationChainId", type: "uint64" },
    { name: "openDeadline", type: "uint64" },
    { name: "fillDeadline", type: "uint64" },
    { name: "orderSalt", type: "uint64" },
    { name: "orderSize", type: "uint256" },
    { name: "minPremiumPerShare", type: "uint256" },
    { name: "allowPartialFills", type: "bool" },
    { name: "allowUnderfill", type: "bool" },
    { name: "premiumPaymentMode", type: "uint8" },
    { name: "rolloverIntentHash", type: "bytes32" },
    { name: "rolloverParams", type: "RolloverParams" },
  ],
  RolloverParams: [
    { name: "srcCstToken", type: "address" },
    { name: "dstCstToken", type: "address" },
    { name: "minCaReceived", type: "uint256" },
    { name: "minSharesOut", type: "uint256" },
    { name: "srcPoolId", type: "bytes32" },
    { name: "dstPoolId", type: "bytes32" },
    { name: "settler", type: "address" },
  ],
} as const;

const DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

/** The CorkSettler EIP-712 domain (ERC-5267-verified on both live Arbitrum settlers). */
export function corkSettlerDomain(chainId: number, settler: Address) {
  return { name: "CorkSettler", version: "1.0.0", chainId, verifyingContract: settler } as const;
}

/** Domain separator as the settler computes it (equals on-chain `DOMAIN_SEPARATOR()`). */
export function corkSettlerDomainSeparator(chainId: number, settler: Address): Hex {
  return hashDomain({
    domain: { name: "CorkSettler", version: "1.0.0", chainId: BigInt(chainId), verifyingContract: settler },
    types: DOMAIN_TYPES,
  });
}

export interface RolloverCall {
  target: Address;
  value: bigint;
  callData: Hex;
  allowFailure: boolean;
  isDelegateCall: boolean;
}

export interface RolloverIntentStruct {
  rolloverContract: Address;
  orderDigest: Hex; // zeroHash for the canonical order-independent commitment
  deadline: bigint;
  nonce: bigint;
  preRolloverHooks: RolloverCall[];
  midRolloverHooks: RolloverCall[];
  postRolloverHooks: RolloverCall[];
  premiumHooks: RolloverCall[];
}

// LibAuthenticatedHooks._hashCall
function hashCall(c: RolloverCall): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bool" }, { type: "bool" }],
      [CALL_TYPEHASH, c.target, c.value, keccak256(c.callData), c.allowFailure, c.isDelegateCall],
    ),
  );
}

// LibAuthenticatedHooks._hashCallArray (empty array → keccak256 of empty bytes)
function hashCallArray(arr: RolloverCall[]): Hex {
  return keccak256(arr.length === 0 ? "0x" : concatHex(arr.map(hashCall)));
}

/** EIP-712 struct hash of a RolloverIntent (LibAuthenticatedHooks.intentStructHash). Pass
 *  `orderDigest: zeroHash` for the canonical commitment bound into `OrderData.rolloverIntentHash`. */
export function intentStructHash(intent: RolloverIntentStruct): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        ROLLOVER_INTENT_TYPEHASH,
        intent.rolloverContract,
        intent.orderDigest,
        intent.deadline,
        intent.nonce,
        hashCallArray(intent.preRolloverHooks),
        hashCallArray(intent.midRolloverHooks),
        hashCallArray(intent.postRolloverHooks),
        hashCallArray(intent.premiumHooks),
      ],
    ),
  );
}

export interface RolloverParamsStruct {
  srcCstToken: Address;
  dstCstToken: Address;
  minCaReceived: bigint;
  minSharesOut: bigint;
  srcPoolId: Hex;
  dstPoolId: Hex;
  settler: Address;
}

export interface OrderDataStruct {
  user: Address;
  settler: Address;
  fillerHint: Address;
  exclusiveFiller: Address;
  srcCstToken: Address;
  dstCstToken: Address;
  premiumToken: Address;
  rolloverContract: Address;
  originChainId: bigint;
  destinationChainId: bigint;
  openDeadline: bigint;
  fillDeadline: bigint;
  orderSalt: bigint;
  orderSize: bigint;
  minPremiumPerShare: bigint;
  allowPartialFills: boolean;
  allowUnderfill: boolean;
  premiumPaymentMode: number;
  rolloverIntentHash: Hex;
  rolloverParams: RolloverParamsStruct;
}

/** Solidity-faithful struct hash (LibSettlerHashing.hashOrderData) — an independent
 *  implementation used by tests to cross-check viem's hashTypedData encoding. */
export function hashOrderDataManual(o: OrderDataStruct): Hex {
  const rolloverParamsHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
      ],
      [
        ROLLOVER_PARAMS_TYPEHASH,
        o.rolloverParams.srcCstToken,
        o.rolloverParams.dstCstToken,
        o.rolloverParams.minCaReceived,
        o.rolloverParams.minSharesOut,
        o.rolloverParams.srcPoolId,
        o.rolloverParams.dstPoolId,
        o.rolloverParams.settler,
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bool" },
        { type: "bool" },
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        ORDER_DATA_TYPEHASH,
        o.user,
        o.settler,
        o.fillerHint,
        o.exclusiveFiller,
        o.srcCstToken,
        o.dstCstToken,
        o.premiumToken,
        o.rolloverContract,
        o.originChainId,
        o.destinationChainId,
        o.openDeadline,
        o.fillDeadline,
        o.orderSalt,
        o.orderSize,
        o.minPremiumPerShare,
        o.allowPartialFills,
        o.allowUnderfill,
        o.premiumPaymentMode,
        o.rolloverIntentHash,
        rolloverParamsHash,
      ],
    ),
  );
}

/** Full order digest (`0x1901‖domainSeparator‖structHash`) = the ERC-7683 orderId. */
export function computeOrderDigest(chainId: number, o: OrderDataStruct): Hex {
  return hashTypedData({
    domain: corkSettlerDomain(chainId, o.settler),
    types: ORDER_DATA_TYPES,
    primaryType: "OrderData",
    message: o,
  });
}

const U64 = (1n << 64n) - 1n;

export interface RolloverIntentArgs {
  chainId: number;
  user: Address;
  settler: Address;
  rolloverContract: Address;
  srcCstToken: Address;
  dstCstToken: Address;
  premiumToken: Address;
  srcPoolId: Hex;
  dstPoolId: Hex;
  orderSize: bigint;
  minPremiumPerShare: bigint;
  openDeadline: bigint;
  fillDeadline: bigint;
  minCaReceived?: bigint;
  minSharesOut?: bigint;
  allowPartialFills?: boolean;
  allowUnderfill?: boolean;
  premiumPaymentMode?: 0 | 1;
  fillerHint?: Address;
  exclusiveFiller?: Address;
  orderSalt?: bigint;
  nonce?: bigint;
  clientRequestId: string;
}

export interface RolloverIntentResult {
  order: OrderDataStruct;
  intent: RolloverIntentStruct;
  rolloverIntentHash: Hex;
  orderDigest: Hex;
  domain: ReturnType<typeof corkSettlerDomain>;
  types: typeof ORDER_DATA_TYPES;
  primaryType: "OrderData";
  /** ERC-7683 orderDataType for the venue POST envelope. */
  orderDataType: Hex;
  /** Ready-to-POST /v1/rollover/orders body (venue wire conventions: decimal strings,
   *  lowercased addresses); `signature` is left as an instruction for the caller. */
  venuePost: Record<string, unknown>;
}

/** Build a signable rollover order: OrderData typed-data + the locally-recomputed zero-digest
 *  intent commitment [K3]. Deterministic for identical inputs [K2] — orderSalt derives from
 *  clientRequestId unless the caller pins it. */
export function buildRolloverIntent(a: RolloverIntentArgs): RolloverIntentResult {
  const orderSalt = a.orderSalt ?? BigInt(keccak256(stringToHex(`rollover-salt:${a.clientRequestId}`))) & U64;
  const nonce = a.nonce ?? 1n;
  const intent: RolloverIntentStruct = {
    rolloverContract: a.rolloverContract,
    orderDigest: zeroHash,
    deadline: a.fillDeadline,
    nonce,
    preRolloverHooks: [],
    midRolloverHooks: [],
    postRolloverHooks: [],
    premiumHooks: [],
  };
  const rolloverIntentHash = intentStructHash(intent);
  const order: OrderDataStruct = {
    user: a.user,
    settler: a.settler,
    fillerHint: a.fillerHint ?? zeroAddress,
    exclusiveFiller: a.exclusiveFiller ?? zeroAddress,
    srcCstToken: a.srcCstToken,
    dstCstToken: a.dstCstToken,
    premiumToken: a.premiumToken,
    rolloverContract: a.rolloverContract,
    originChainId: BigInt(a.chainId),
    destinationChainId: BigInt(a.chainId),
    openDeadline: a.openDeadline,
    fillDeadline: a.fillDeadline,
    orderSalt,
    orderSize: a.orderSize,
    minPremiumPerShare: a.minPremiumPerShare,
    allowPartialFills: a.allowPartialFills ?? false,
    allowUnderfill: a.allowUnderfill ?? false,
    premiumPaymentMode: a.premiumPaymentMode ?? 0,
    rolloverIntentHash,
    rolloverParams: {
      srcCstToken: a.srcCstToken,
      dstCstToken: a.dstCstToken,
      minCaReceived: a.minCaReceived ?? 0n,
      minSharesOut: a.minSharesOut ?? 0n,
      srcPoolId: a.srcPoolId,
      dstPoolId: a.dstPoolId,
      settler: a.settler,
    },
  };
  const orderDigest = computeOrderDigest(a.chainId, order);

  const lc = (addr: Address) => addr.toLowerCase();
  const venuePost = {
    chainId: a.chainId,
    order: {
      user: lc(order.user),
      settler: lc(order.settler),
      fillerHint: lc(order.fillerHint),
      exclusiveFiller: lc(order.exclusiveFiller),
      srcCstToken: lc(order.srcCstToken),
      dstCstToken: lc(order.dstCstToken),
      premiumToken: lc(order.premiumToken),
      rolloverContract: lc(order.rolloverContract),
      originChainId: order.originChainId.toString(),
      destinationChainId: order.destinationChainId.toString(),
      openDeadline: order.openDeadline.toString(),
      fillDeadline: order.fillDeadline.toString(),
      orderSalt: order.orderSalt.toString(),
      orderSize: order.orderSize.toString(),
      minPremiumPerShare: order.minPremiumPerShare.toString(),
      allowPartialFills: order.allowPartialFills,
      allowUnderfill: order.allowUnderfill,
      premiumPaymentMode: order.premiumPaymentMode,
      rolloverIntentHash,
      rolloverParams: {
        srcCstToken: lc(order.rolloverParams.srcCstToken),
        dstCstToken: lc(order.rolloverParams.dstCstToken),
        minCaReceived: order.rolloverParams.minCaReceived.toString(),
        minSharesOut: order.rolloverParams.minSharesOut.toString(),
        srcPoolId: order.rolloverParams.srcPoolId,
        dstPoolId: order.rolloverParams.dstPoolId,
        settler: lc(order.rolloverParams.settler),
      },
    },
    intent: {
      rolloverContract: lc(intent.rolloverContract),
      deadline: intent.deadline.toString(),
      nonce: intent.nonce.toString(),
      preRolloverHooks: [],
      midRolloverHooks: [],
      postRolloverHooks: [],
      premiumHooks: [],
    },
    signature: "<sign the typedData with the user wallet and paste the signature here>",
    envelope: { orderDataType: ORDER_DATA_TYPEHASH },
  };

  return {
    order,
    intent,
    rolloverIntentHash,
    orderDigest,
    domain: corkSettlerDomain(a.chainId, a.settler),
    types: ORDER_DATA_TYPES,
    primaryType: "OrderData",
    orderDataType: ORDER_DATA_TYPEHASH,
    venuePost,
  };
}
