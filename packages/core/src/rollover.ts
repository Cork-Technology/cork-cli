// Cork rollover order construction: EIP-712 typed data for `OrderData` under the CorkSettler
// domain, plus the zero-digest `RolloverIntent` commitment (`rolloverIntentHash`) [K3: recomputed
// locally, never accepted from the caller].
//
// Structs, typehash preimages, and encoding order are ported from the DEPLOYED pin
// `rollover-private @ 5af1048e` (public tag v0.1.0-rc.2; src/libraries/{Typehashes,
// LibSettlerHashing,LibAuthenticatedHooks}.sol + src/BaseFiller.sol). The typehash preimages are
// frozen post-launch on-chain (INV-WIRE-ORDER-STABILITY), and the computed domain separator is
// proven equal to all four live rc.2 settlers' DOMAIN_SEPARATOR() (Arbitrum + Base, identical
// CREATE2 addresses; golden vectors in test/rollover.test.ts).
//
// rc.2 wire break (2026-08-13): `RolloverParams` gained a trailing `bytes32 jitMarketHash`
// (zero = the order does not authorize just-in-time market creation), changing BOTH typehashes
// and the static OrderData ABI length (832 → 864 bytes). Digests computed under the previous
// generation's types no longer verify on the deployed settlers and are rejected by the venue.
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

// ── Frozen EIP-712 type strings (verbatim from Typehashes.sol @ 5af1048e) ──────────────────────
const ORDER_DATA_TYPE_STRING =
  "OrderData(address user,address settler,address fillerHint,address exclusiveFiller,address srcCstToken,address dstCstToken,address premiumToken,address rolloverContract,uint64 originChainId,uint64 destinationChainId,uint64 openDeadline,uint64 fillDeadline,uint64 orderSalt,uint256 orderSize,uint256 minPremiumPerShare,bool allowPartialFills,bool allowUnderfill,uint8 premiumPaymentMode,bytes32 rolloverIntentHash,RolloverParams rolloverParams)RolloverParams(address srcCstToken,address dstCstToken,uint256 minCaReceived,uint256 minSharesOut,bytes32 srcPoolId,bytes32 dstPoolId,address settler,bytes32 jitMarketHash)";
const ROLLOVER_PARAMS_TYPE_STRING =
  "RolloverParams(address srcCstToken,address dstCstToken,uint256 minCaReceived,uint256 minSharesOut,bytes32 srcPoolId,bytes32 dstPoolId,address settler,bytes32 jitMarketHash)";
const JIT_MARKET_PARAMS_TYPE_STRING =
  "JITMarketParams(address collateralAsset,address referenceAsset,uint256 expiryTimestamp,address recipe,uint256 rateOverride,uint256 rateMin,uint256 rateMax,uint256 rateChangePerDayMax,uint256 rateChangeCapacityMax,bytes additionalData,uint256 swapFeePercentage,uint256 unwindSwapFeePercentage)";
const ROLLOVER_INTENT_TYPE_STRING =
  "RolloverIntent(address rolloverContract,bytes32 orderDigest,uint64 deadline,uint64 nonce,Call[] preRolloverHooks,Call[] midRolloverHooks,Call[] postRolloverHooks,Call[] premiumHooks)Call(address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)";
const CALL_TYPE_STRING =
  "Call(address target,uint256 value,bytes callData,bool allowFailure,bool isDelegateCall)";

export const ORDER_DATA_TYPEHASH: Hex = keccak256(stringToHex(ORDER_DATA_TYPE_STRING));
export const ROLLOVER_PARAMS_TYPEHASH: Hex = keccak256(stringToHex(ROLLOVER_PARAMS_TYPE_STRING));
export const ROLLOVER_INTENT_TYPEHASH: Hex = keccak256(stringToHex(ROLLOVER_INTENT_TYPE_STRING));
export const CALL_TYPEHASH: Hex = keccak256(stringToHex(CALL_TYPE_STRING));
export const JIT_MARKET_PARAMS_TYPEHASH: Hex = keccak256(stringToHex(JIT_MARKET_PARAMS_TYPE_STRING));

/** `RolloverParams.jitMarketHash` value meaning "this order does not authorize just-in-time
 *  market creation" (rollover v0.1.0-rc.2 Typehashes.sol). Orders built without a JIT market
 *  MUST sign over this zero value — the field is part of the digest either way. */
export const ZERO_JIT_MARKET_HASH: Hex = zeroHash;

/** Canonical ABI byte length of the static-only OrderData tuple
 *  (LibRolloverOrder.ORDER_DATA_ABI_LENGTH @ 5af1048e — 864 since rc.2, was 832). */
export const ORDER_DATA_ABI_LENGTH = 864;

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
    { name: "jitMarketHash", type: "bytes32" },
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

/** The CorkSettler EIP-712 domain — the exact shape signers pass to eth_signTypedData_v4
 *  (ERC-5267-verified on all four live rc.2 settlers, Arbitrum + Base). */
export interface CorkSettlerDomain {
  name: "CorkSettler";
  version: "1.0.0";
  chainId: number;
  verifyingContract: Address;
}

export function corkSettlerDomain(chainId: number, settler: Address): CorkSettlerDomain {
  return { name: "CorkSettler", version: "1.0.0", chainId, verifyingContract: settler };
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
  /** JITMarketParams commitment (hashJitMarketParams), or ZERO_JIT_MARKET_HASH for none. */
  jitMarketHash: Hex;
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
        { type: "bytes32" },
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
        o.rolloverParams.jitMarketHash,
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

/** Static ABI encoding of the OrderData tuple — the ERC-7683 envelope's `orderData` blob the
 *  settlers decode (LibRolloverOrder.decodeOrderData; always ORDER_DATA_ABI_LENGTH bytes). */
export function encodeOrderData(o: OrderDataStruct): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
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
          {
            name: "rolloverParams",
            type: "tuple",
            components: [
              { name: "srcCstToken", type: "address" },
              { name: "dstCstToken", type: "address" },
              { name: "minCaReceived", type: "uint256" },
              { name: "minSharesOut", type: "uint256" },
              { name: "srcPoolId", type: "bytes32" },
              { name: "dstPoolId", type: "bytes32" },
              { name: "settler", type: "address" },
              { name: "jitMarketHash", type: "bytes32" },
            ],
          },
        ],
      },
    ],
    [o],
  );
}

/** Just-in-time market instruction a rollover order commits to when the destination pool may not
 *  exist yet (BaseFiller.JITMarketParams @ 5af1048e). The order separately signs
 *  `rolloverParams.dstPoolId` (the Phoenix Market commitment) and `rolloverParams.jitMarketHash`
 *  (this struct's commitment, negotiated fees included). Scales: the four constraint rates and
 *  rateOverride are ABSOLUTE 1e18 = 1.0; the two fee fields are PERCENTAGES 1e18 = 1%. */
export interface JitMarketParamsStruct {
  collateralAsset: Address;
  referenceAsset: Address;
  expiryTimestamp: bigint;
  recipe: Address;
  rateOverride: bigint;
  rateMin: bigint;
  rateMax: bigint;
  rateChangePerDayMax: bigint;
  rateChangeCapacityMax: bigint;
  additionalData: Hex;
  swapFeePercentage: bigint;
  unwindSwapFeePercentage: bigint;
}

/** Commitment hash embedded in `RolloverParams.jitMarketHash`
 *  (BaseFiller.hashJITMarketParams — `additionalData` rides as its keccak256, EIP-712-style). */
export function hashJitMarketParams(p: JitMarketParamsStruct): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        JIT_MARKET_PARAMS_TYPEHASH,
        p.collateralAsset,
        p.referenceAsset,
        p.expiryTimestamp,
        p.recipe,
        p.rateOverride,
        p.rateMin,
        p.rateMax,
        p.rateChangePerDayMax,
        p.rateChangeCapacityMax,
        keccak256(p.additionalData),
        p.swapFeePercentage,
        p.unwindSwapFeePercentage,
      ],
    ),
  );
}

const U64 = (1n << 64n) - 1n;

// ── Admission pre-flight (venue parity) ────────────────────────────────────────────────────────
// The deterministic subset of the venue's POST /rollover/v1/orders admission battery
// (cork-indexing-api post-order.ts @ 0.3.16), replicated op-for-op so a refusal here lands
// exactly where the venue's 400 would. Chain-dependent admission (hook-target getCode, the
// settler resolveFor preflight) deliberately stays venue-side — this module is pure.

/** One settler generation's addresses (structural subset of the config's rollover record). */
export interface RolloverGenerationAddresses {
  exactSettler: string;
  partialSettler: string;
  retired?: string | undefined;
  label?: string | undefined;
}

export type RolloverSettlerClassification =
  | { status: "active"; kind: "EXACT" | "PARTIAL" }
  | { status: "retired"; kind: "EXACT" | "PARTIAL"; generation: RolloverGenerationAddresses }
  | { status: "unknown" };

/** Classify a settler address against the configured deployment: the active generation's
 *  Exact/Partial settler, a RETIRED generation's (venue-inadmissible: the venue archives old
 *  generations, and a wire-format release means its digests no longer verify there), or unknown. */
export function classifyRolloverSettler(
  dep: { exactSettler: string; partialSettler: string; legacyGenerations?: RolloverGenerationAddresses[] | undefined },
  settler: string,
): RolloverSettlerClassification {
  const lc = settler.toLowerCase();
  if (lc === dep.exactSettler.toLowerCase()) return { status: "active", kind: "EXACT" };
  if (lc === dep.partialSettler.toLowerCase()) return { status: "active", kind: "PARTIAL" };
  for (const g of dep.legacyGenerations ?? []) {
    if (lc === g.exactSettler.toLowerCase()) return { status: "retired", kind: "EXACT", generation: g };
    if (lc === g.partialSettler.toLowerCase()) return { status: "retired", kind: "PARTIAL", generation: g };
  }
  return { status: "unknown" };
}

/** Order-term fields the deterministic admission battery reads. `intentDeadline`/`hooks` are
 *  submit-side extras (the prepare builder pins deadline = fillDeadline and attaches no hooks). */
export interface RolloverOrderTermsInput {
  nowSeconds: bigint;
  openDeadline: bigint;
  fillDeadline: bigint;
  orderSize: bigint;
  minPremiumPerShare: bigint;
  srcCstToken: string;
  dstCstToken: string;
  premiumToken: string;
  srcPoolId: string;
  dstPoolId: string;
  settler: string;
  exclusiveFiller?: string | undefined;
  intentDeadline?: bigint | undefined;
  hooks?: RolloverCall[] | undefined;
}

/** First venue-admission violation among the deterministic checks, or null when they all pass.
 *  First-fail (not a list) to mirror the venue's own 400 semantics. */
export function checkRolloverOrderTerms(t: RolloverOrderTermsInput): string | null {
  const lc = (s: string) => s.toLowerCase();
  if (t.orderSize <= 0n) return "orderSize must be positive — the venue rejects non-positive sizes";
  if (t.openDeadline > t.fillDeadline) return `openDeadline (${t.openDeadline}) must not exceed fillDeadline (${t.fillDeadline})`;
  if (t.fillDeadline <= t.nowSeconds) return `fillDeadline (${t.fillDeadline}) is not in the future (now ${t.nowSeconds}) — the venue rejects past deadlines`;
  if (t.openDeadline < t.nowSeconds) return `openDeadline (${t.openDeadline}) is in the past (now ${t.nowSeconds}) — the venue rejects it, and the order could never be opened`;
  if (t.minPremiumPerShare <= 0n) return "minPremiumPerShare must be positive — the venue rejects zero-premium orders";
  if (lc(t.srcCstToken) === zeroAddress || lc(t.dstCstToken) === zeroAddress || lc(t.premiumToken) === zeroAddress) {
    return "srcCstToken, dstCstToken, and premiumToken must be non-zero addresses";
  }
  if (lc(t.premiumToken) === lc(t.srcCstToken) || lc(t.premiumToken) === lc(t.dstCstToken)) {
    return "premiumToken must differ from srcCstToken and dstCstToken — the venue rejects premium paid in either cST";
  }
  if (lc(t.srcPoolId) === lc(t.dstPoolId)) return "srcPoolId and dstPoolId must differ — a rollover migrates between two pools";
  if (t.exclusiveFiller !== undefined && lc(t.exclusiveFiller) === lc(t.settler)) {
    return "exclusiveFiller cannot be the settler itself";
  }
  if (t.intentDeadline !== undefined) {
    if (t.intentDeadline < t.fillDeadline) return `intent.deadline (${t.intentDeadline}) must be at least fillDeadline (${t.fillDeadline}) — the intent must outlive the fill window`;
    if (t.intentDeadline < t.nowSeconds) return `intent.deadline (${t.intentDeadline}) is in the past (now ${t.nowSeconds})`;
  }
  for (const hook of t.hooks ?? []) {
    if (!hook.isDelegateCall || hook.allowFailure || hook.value !== 0n) {
      return "intent hooks must be delegatecall-only, zero-value, and non-optional (isDelegateCall:true, value:'0', allowFailure:false) — the venue rejects any other shape";
    }
  }
  return null;
}

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
  /** JITMarketParams commitment (hashJitMarketParams). Omitted = ZERO_JIT_MARKET_HASH — the
   *  order does not authorize just-in-time market creation, and the signature still covers the
   *  zeroed field (rc.2 digests include it either way). */
  jitMarketHash?: Hex;
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
  domain: CorkSettlerDomain;
  types: typeof ORDER_DATA_TYPES;
  primaryType: "OrderData";
  /** ERC-7683 orderDataType for the venue POST envelope. */
  orderDataType: Hex;
  /** Ready-to-POST /v1/rollover/orders body (venue wire conventions: decimal strings,
   *  lowercased addresses); `signature` is left as an instruction for the caller. */
  venuePost: RolloverVenuePost;
}

/** The /v1/rollover/orders POST body this builder emits. Numeric struct fields become decimal
 *  strings and addresses are lowercased (venue wire conventions); the hook arrays are typed
 *  empty because this builder never attaches hooks — a caller composing hooks builds its own
 *  payload and relays it through cork_submit, which re-verifies the commitments. */
export interface RolloverVenuePost {
  chainId: number;
  order: {
    user: string;
    settler: string;
    fillerHint: string;
    exclusiveFiller: string;
    srcCstToken: string;
    dstCstToken: string;
    premiumToken: string;
    rolloverContract: string;
    originChainId: string;
    destinationChainId: string;
    openDeadline: string;
    fillDeadline: string;
    orderSalt: string;
    orderSize: string;
    minPremiumPerShare: string;
    allowPartialFills: boolean;
    allowUnderfill: boolean;
    premiumPaymentMode: number;
    rolloverIntentHash: Hex;
    rolloverParams: {
      srcCstToken: string;
      dstCstToken: string;
      minCaReceived: string;
      minSharesOut: string;
      srcPoolId: Hex;
      dstPoolId: Hex;
      settler: string;
      jitMarketHash: Hex;
    };
  };
  intent: {
    rolloverContract: string;
    deadline: string;
    nonce: string;
    preRolloverHooks: never[];
    midRolloverHooks: never[];
    postRolloverHooks: never[];
    premiumHooks: never[];
  };
  /** Placeholder instruction — the caller replaces it with the EIP-712 signature. */
  signature: string;
  envelope: { orderDataType: Hex };
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
      jitMarketHash: a.jitMarketHash ?? ZERO_JIT_MARKET_HASH,
    },
  };
  const orderDigest = computeOrderDigest(a.chainId, order);

  const lc = (addr: Address) => addr.toLowerCase();
  const venuePost: RolloverVenuePost = {
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
        jitMarketHash: order.rolloverParams.jitMarketHash,
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
