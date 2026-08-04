// 1inch Limit Order Protocol v4 order construction (EIP-712 typed data) + cancel calldata.
// Order struct, typehash, and domain verified against limit-order-protocol/contracts
// (OrderLib._LIMIT_ORDER_TYPEHASH, LimitOrderProtocol EIP712("1inch Limit Order Protocol","4")).
// The produced orderHash is proven equal to on-chain LOP.hashOrder(order) in the fork tests.
import {
  concatHex,
  encodeFunctionData,
  hashTypedData,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  parseSignature,
  recoverAddress,
  signatureToCompactSignature,
  size,
  sliceHex,
  stringToHex,
  zeroAddress,
} from "viem";

import bundledDefaults from "../../../cork-defaults.json" with { type: "json" };

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
const NEED_CHECK_EPOCH_MANAGER_FLAG = 1n << 250n;
const HAS_EXTENSION_FLAG = 1n << 249n;
const USE_PERMIT2_FLAG = 1n << 248n;
const UNWRAP_WETH_FLAG = 1n << 247n;

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

/** Structural sanity of caller-supplied extension bytes: a malformed extension signs fine and
 *  only fails (or silently misparses) at fill, so refuse to bind a salt to one here. */
function validateExtensionShape(extension: `0x${string}`): void {
  const bytes = size(extension);
  if (bytes < 32) {
    throw new Error(`extension is ${bytes} byte(s) — a 1inch v4 extension starts with a 32-byte offsets header; a malformed extension would sign fine and then revert or misparse at fill`);
  }
  const offsets = BigInt(sliceHex(extension, 0, 32));
  let prev = 0n;
  for (let i = 0n; i < 8n; i += 1n) {
    const o = (offsets >> (32n * i)) & 0xffffffffn;
    if (o < prev) throw new Error(`extension offsets header is not monotonically non-decreasing at field ${i} — malformed 1inch v4 extension`);
    prev = o;
  }
  if (prev > BigInt(bytes - 32)) {
    throw new Error(`extension offsets header claims ${prev} bytes of fields but only ${bytes - 32} follow the header — truncated 1inch v4 extension`);
  }
}

/** The eight ExtensionLib dynamic fields + customData tail, each as raw bytes ("0x" = empty). */
export interface LopExtensionFields {
  makerAssetSuffix: `0x${string}`;
  takerAssetSuffix: `0x${string}`;
  makingAmountData: `0x${string}`;
  takingAmountData: `0x${string}`;
  predicate: `0x${string}`;
  makerPermit: `0x${string}`;
  preInteractionData: `0x${string}`;
  postInteractionData: `0x${string}`;
  customData: `0x${string}`;
}

/**
 * Decode a LOP v4 extension blob into its eight fields (ExtensionLib/OffsetsLib layout: a 32-byte
 * word of eight uint32 cumulative END offsets — index 0 in the lowest bits — followed by the
 * concatenated fields; anything after end[7] is customData). Validates the same structural rules
 * the builder enforces (validateExtensionShape) so malformed bytes throw instead of misparsing.
 */
export function decodeExtensionFields(extension: `0x${string}`): LopExtensionFields {
  validateExtensionShape(extension);
  const offsets = BigInt(sliceHex(extension, 0, 32));
  const total = size(extension);
  const field = (i: bigint): `0x${string}` => {
    const begin = i === 0n ? 0n : (offsets >> (32n * (i - 1n))) & 0xffffffffn;
    const end = (offsets >> (32n * i)) & 0xffffffffn;
    return begin === end ? "0x" : sliceHex(extension, 32 + Number(begin), 32 + Number(end));
  };
  const lastEnd = Number((offsets >> 224n) & 0xffffffffn);
  return {
    makerAssetSuffix: field(0n),
    takerAssetSuffix: field(1n),
    makingAmountData: field(2n),
    takingAmountData: field(3n),
    predicate: field(4n),
    makerPermit: field(5n),
    preInteractionData: field(6n),
    postInteractionData: field(7n),
    customData: 32 + lastEnd < total ? sliceHex(extension, 32 + lastEnd) : "0x",
  };
}

export interface MakerTraitsParts {
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
  usePermit2: boolean;
  hasExtension?: boolean;
  expiry: bigint; // unix seconds (0 = none)
  nonce: bigint;
}

export function buildMakerTraits(p: MakerTraitsParts): bigint {
  // Range-check BEFORE packing: the expiry/nonce slots are 40 bits wide, and `& U40` would
  // silently wrap an oversized value (a max-safe-integer expiry wraps into the PAST — a signed
  // order that is permanently unfillable with no error anywhere).
  if (p.expiry < 0n || p.expiry > U40) {
    throw new Error(`makerTraits expiry ${p.expiry} does not fit the 40-bit trait slot (max ${U40}, year ~36812) — an oversized value would silently wrap, most likely into an already-expired order. Note expiry here is ABSOLUTE unix seconds`);
  }
  if (p.nonce < 0n || p.nonce > U40) {
    throw new Error(`makerTraits nonce ${p.nonce} does not fit the 40-bit trait slot (max ${U40})`);
  }
  let t = 0n;
  if (!p.allowPartialFills) t |= NO_PARTIAL_FILLS_FLAG;
  if (p.allowMultipleFills) t |= ALLOW_MULTIPLE_FILLS_FLAG;
  if (p.usePermit2) t |= USE_PERMIT2_FLAG;
  if (p.hasExtension) t |= HAS_EXTENSION_FLAG;
  t |= p.expiry << 80n;
  t |= p.nonce << 120n;
  return t; // low 80 bits (allowed sender) = 0 => any taker
}

/** Full MakerTraitsLib breakdown — the exact inverse of buildMakerTraits, plus the flags/slots
 *  our builder never sets (epoch manager, unwrap-WETH, series, allowed sender). */
export interface DecodedMakerTraits {
  allowPartialFills: boolean;
  allowMultipleFills: boolean;
  preInteractionCall: boolean;
  postInteractionCall: boolean;
  needCheckEpochManager: boolean;
  hasExtension: boolean;
  usePermit2: boolean;
  unwrapWeth: boolean;
  /** Absolute unix seconds; 0 = no expiry. */
  expiry: bigint;
  nonce: bigint;
  series: bigint;
  /** Low 80 bits — the LAST 10 BYTES of the allowed sender (0 = any taker). The full address is
   *  not recoverable from the traits; only this suffix is enforced on-chain. */
  allowedSenderLow10Bytes: `0x${string}` | null;
}

/** Decode a makerTraits word against the MakerTraitsLib bit layout (bit-exact inverse). */
export function decodeMakerTraits(t: bigint): DecodedMakerTraits {
  const senderLow = t & ((1n << 80n) - 1n);
  return {
    allowPartialFills: (t & NO_PARTIAL_FILLS_FLAG) === 0n,
    allowMultipleFills: (t & ALLOW_MULTIPLE_FILLS_FLAG) !== 0n,
    preInteractionCall: (t & PRE_INTERACTION_CALL_FLAG) !== 0n,
    postInteractionCall: (t & POST_INTERACTION_CALL_FLAG) !== 0n,
    needCheckEpochManager: (t & NEED_CHECK_EPOCH_MANAGER_FLAG) !== 0n,
    hasExtension: (t & HAS_EXTENSION_FLAG) !== 0n,
    usePermit2: (t & USE_PERMIT2_FLAG) !== 0n,
    unwrapWeth: (t & UNWRAP_WETH_FLAG) !== 0n,
    expiry: (t >> 80n) & U40,
    nonce: (t >> 120n) & U40,
    series: (t >> 160n) & U40,
    allowedSenderLow10Bytes: senderLow === 0n ? null : (`0x${senderLow.toString(16).padStart(20, "0")}` as `0x${string}`),
  };
}

/** Decode the ABI-encoded 8-word Order tuple (the canonical uint256 form the v6 router uses).
 *  Address-typed words are range-checked — a value above 2^160-1 is a malformed order, not an
 *  address to silently truncate. */
export function decodeOrderTuple(data: `0x${string}`): LopOrder {
  if (size(data) !== 256) {
    throw new Error(`a LOP v4 order tuple is exactly 8×32 = 256 ABI-encoded bytes, got ${size(data)} — pass the bare encoded Order struct (no selector, no offset header)`);
  }
  const words: bigint[] = [];
  for (let i = 0; i < 8; i += 1) words.push(BigInt(sliceHex(data, i * 32, (i + 1) * 32)));
  const addr = (w: bigint, field: string): `0x${string}` => {
    if (w > U160) throw new Error(`order field '${field}' does not fit an address (value ${w} exceeds 2^160-1) — malformed order tuple`);
    return `0x${w.toString(16).padStart(40, "0")}` as `0x${string}`;
  };
  return {
    salt: words[0]!,
    maker: addr(words[1]!, "maker"),
    receiver: addr(words[2]!, "receiver"),
    makerAsset: addr(words[3]!, "makerAsset"),
    takerAsset: addr(words[4]!, "takerAsset"),
    makingAmount: words[5]!,
    takingAmount: words[6]!,
    makerTraits: words[7]!,
  };
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

/** EIP-712 hash of a LOP order against the router domain (equals the on-chain order hash). */
export function hashLopOrder(chainId: number, verifyingContract: `0x${string}`, order: LopOrder): `0x${string}` {
  return hashTypedData({ domain: lopDomain(chainId, verifyingContract), types: ORDER_TYPES, primaryType: "Order", message: order });
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
  /**
   * The bit-invalidator nonce packed into makerTraits. Surfaced because `cork_submit lop-order`
   * cross-checks the venue listing against the SIGNED traits — the listing must carry this value.
   */
  nonce: bigint;
}

/** Build a signable LOP v4 maker order + its EIP-712 hash (equals on-chain hashOrder). */
export function buildMakerOrder(a: MakerOrderArgs): MakerOrderResult {
  const hasExtension = a.extension !== undefined && a.extension !== "0x";
  if (hasExtension) validateExtensionShape(a.extension!);
  // Deterministic salt from the idempotency key. Plain order: low 160 bits of keccak(id).
  // Extension order: low 160 bits MUST be keccak(extension)'s low 160 (OrderLib fill check);
  // the idempotency-derived entropy moves to the free top 96 bits.
  const salt = hasExtension
    ? ((BigInt(keccak256(stringToHex(a.clientRequestId))) & U96) << 160n) | (BigInt(keccak256(a.extension!)) & U160)
    : BigInt(keccak256(stringToHex(a.clientRequestId))) & U160;
  // The nonce must be DISTINCT per order, not 0. allowMultipleFills is off, so every order we
  // build lives in the bit invalidator, and BitInvalidatorLib.checkAndInvalidate keys on
  // (maker, nonce) — NOT on orderHash. A fixed nonce would therefore put every order a maker ever
  // signs on the same bit: the first fill or cancel of any one of them would invalidate all the
  // rest with BitInvalidatedOrder. That would also defeat the documented remedy for the
  // one-fill-consumes-everything behaviour ("post several smaller orders"), since those orders
  // would collide with each other.
  //
  // Derived from the idempotency key so retries stay byte-identical [K2] while genuinely
  // different requests land on different bits. 40 bits of space, from a range of the hash the
  // plain-order salt does not use.
  const nonce = (BigInt(keccak256(stringToHex(a.clientRequestId))) >> 160n) & U40;
  let makerTraits = buildMakerTraits({
    allowPartialFills: a.allowPartialFills ?? true,
    allowMultipleFills: false,
    usePermit2: a.usePermit2 ?? false,
    hasExtension,
    expiry: a.expiry ?? 0n,
    nonce,
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
  const orderHash = hashLopOrder(a.chainId, a.lop, order);
  return { order, domain, types: ORDER_TYPES, primaryType: "Order", orderHash, extension: hasExtension ? a.extension! : "0x", nonce };
}

// ── Finalize a caller-signed maker order ─────────────────────────────────────
// Signing happens out-of-process (an external signer). Finalize reconstructs the exact order,
// re-derives its hash, checks the salt↔extension binding OrderLib enforces at fill, and recovers
// the signer — proving the signature is the maker's over THIS order — WITHOUT ever signing [K1].
export interface FinalizeMakerOrderArgs {
  chainId: number;
  lop: `0x${string}`;
  order: LopOrder;
  claimedOrderHash: `0x${string}`;
  signature: `0x${string}`;
  extension: `0x${string}`;
}

export interface FinalizedMakerOrder {
  order: LopOrder;
  orderHash: `0x${string}`;
  signature: `0x${string}`;
  extension: `0x${string}`;
  recoveredSigner: `0x${string}`;
}

export async function finalizeMakerOrder(a: FinalizeMakerOrderArgs): Promise<FinalizedMakerOrder> {
  const orderHash = hashLopOrder(a.chainId, a.lop, a.order);
  if (orderHash.toLowerCase() !== a.claimedOrderHash.toLowerCase()) {
    throw new Error(`reconstructed order hash ${orderHash} does not match the prepared orderHash ${a.claimedOrderHash}`);
  }
  if (a.extension !== "0x") {
    // OrderLib requires the salt's low 160 bits == keccak256(extension)'s low 160 bits at fill.
    const saltLow = a.order.salt & U160;
    const extLow = BigInt(keccak256(a.extension)) & U160;
    if (saltLow !== extLow) throw new Error("salt's low 160 bits are not bound to keccak256(extension) — this order would revert InvalidExtension at fill");
  }
  const recoveredSigner = await recoverAddress({ hash: orderHash, signature: a.signature });
  if (!isAddressEqual(recoveredSigner, a.order.maker)) {
    throw new Error(`signature recovers to ${recoveredSigner}, not the order maker ${a.order.maker}`);
  }
  return { order: a.order, orderHash, signature: a.signature, extension: a.extension, recoveredSigner };
}

const lopAbi = parseAbi(["function cancelOrder(uint256 makerTraits, bytes32 orderHash)"]);

/** Build LOP.cancelOrder(makerTraits, orderHash) calldata (a direct call, not typed data). */
export function buildCancelOrder(makerTraits: bigint, orderHash: `0x${string}`): { to: null; data: `0x${string}` } {
  return { to: null, data: encodeFunctionData({ abi: lopAbi, functionName: "cancelOrder", args: [makerTraits, orderHash] }) };
}

// ── Taker fill ───────────────────────────────────────────────────────────────
// 1inch v6 declares Order with `type Address is uint256`, so the router derives the fill selector
// from the underlying uint256 tuple: fillOrderArgs = 0xf497df75 (NOT 0x5d9dbf53, the address-tuple
// selector, which hits the fallback and reverts). The ABI-encoded bytes are identical to the
// address form (addresses left-pad to 32 bytes) — ONLY the 4-byte selector differs. Proven by the
// Arbitrum fork round-trip (experiments/fork-harness/test/JitOrderRoundTrip.t.sol).
const ORDER_TUPLE_UINT = "(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)";
const fillAbi = parseAbi([
  `function fillOrderArgs(${ORDER_TUPLE_UINT} order, bytes32 r, bytes32 vs, uint256 amount, uint256 takerTraits, bytes args) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)`,
  `function fillOrder(${ORDER_TUPLE_UINT} order, bytes32 r, bytes32 vs, uint256 amount, uint256 takerTraits) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)`,
  `function fillContractOrderArgs(${ORDER_TUPLE_UINT} order, bytes signature, uint256 amount, uint256 takerTraits, bytes args) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)`,
  `function fillContractOrder(${ORDER_TUPLE_UINT} order, bytes signature, uint256 amount, uint256 takerTraits) returns (uint256 makingAmount, uint256 takingAmount, bytes32 orderHash)`,
]);

// TakerTraitsLib bit layout (1inch v6).
const TAKER_MAKER_AMOUNT_FLAG = 1n << 255n; // `amount` is denominated in the maker asset
const TAKER_ARGS_HAS_RECEIVER_FLAG = 1n << 251n; // args is prefixed with a 20-byte receiver
const TAKER_ARGS_EXTENSION_LENGTH_OFFSET = 224n; // extension byte length packed at bits [224,248)
const TAKER_ARGS_INTERACTION_LENGTH_OFFSET = 200n; // taker-interaction byte length at bits [200,224)
const TAKER_THRESHOLD_MAX = (1n << 185n) - 1n; // low 185 bits carry the taking-amount cap

type OrderUintTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
const orderToUintTuple = (o: LopOrder): OrderUintTuple =>
  [o.salt, BigInt(o.maker), BigInt(o.receiver), BigInt(o.makerAsset), BigInt(o.takerAsset), o.makingAmount, o.takingAmount, o.makerTraits];

export interface TakerFillArgs {
  order: LopOrder;
  /** Maker's EIP-712 signature (EOA) or ERC-1271 contract signature bytes. */
  signature: `0x${string}`;
  makerAccountType?: "EOA" | "ERC1271";
  taker: `0x${string}`;
  /** Recipient of the maker asset; defaults to the taker. */
  receiver?: `0x${string}`;
  /** Making amount to receive; defaults to the full remaining order. */
  fillMakingAmount?: bigint;
  /** Hard cap on taking amount paid; defaults to the exact rounded-up signed ratio. */
  maximumTakingAmount?: bigint;
  /** Extension bytes the maker order was signed with (verbatim; required for JIT/hook orders). */
  extension?: `0x${string}`;
  /** TAKER interaction calldata: `adapter address ++ extraData`, invoked via takerInteraction
   *  DURING the fill (after the maker asset moves, before the taker asset is pulled). This is
   *  how a taker delivers a not-yet-minted asset — e.g. lifting a BUY-cover order by packing the
   *  Cork JIT adapter here, whose takerInteraction mints the cST into exactly that gap
   *  (unconditionally — enableJitMint gates only the maker-side hook). Rides in args AFTER the
   *  extension, length packed at takerTraits bits [200,224) (OrderMixin._parseArgs order:
   *  target?, extension, interaction). */
  interaction?: `0x${string}`;
}

export interface TakerFillResult {
  to: null;
  calldata: `0x${string}`;
  functionName: "fillOrder" | "fillOrderArgs" | "fillContractOrder" | "fillContractOrderArgs";
  takerTraits: string;
  requiredMakingAmount: string;
  requiredTakingAmount: string;
}

/** Build unsigned 1inch v6 taker-fill calldata for a resting maker order. Executes nothing.
 *  Amounts are DERIVED-AND-CLAMPED against the signed order itself: an over-ask does not
 *  inflate the reported amounts (10x-wrong slippage caps), and a partial fill of a signed
 *  all-or-nothing order is refused here instead of reverting on-chain. */
export function buildTakerFill(a: TakerFillArgs): TakerFillResult {
  if (a.order.makingAmount === 0n) {
    throw new Error("buildTakerFill: the resting order's makingAmount is 0 — a malformed order row; nothing can be filled");
  }
  const making = a.fillMakingAmount ?? a.order.makingAmount;
  if (making === 0n) throw new Error("buildTakerFill: fillMakingAmount must be positive");
  if (making > a.order.makingAmount) {
    throw new Error(`buildTakerFill: fillMakingAmount ${making} exceeds the order's signed makingAmount ${a.order.makingAmount} — 1inch would clamp the fill on-chain, so the reported amounts and the taking-amount slippage cap would both be wrong; pass at most the order's makingAmount (or omit for a full fill)`);
  }
  if (making < a.order.makingAmount && (a.order.makerTraits & NO_PARTIAL_FILLS_FLAG) !== 0n) {
    throw new Error(`buildTakerFill: this order's makerTraits set NO_PARTIAL_FILLS — a partial fill of ${making}/${a.order.makingAmount} would revert on-chain; fill the full makingAmount or skip the order`);
  }
  // Exact taking for a full fill; ceil(making * takingAmount / makingAmount) for a partial.
  const requiredTaking =
    making === a.order.makingAmount
      ? a.order.takingAmount
      : (making * a.order.takingAmount + a.order.makingAmount - 1n) / a.order.makingAmount;
  const cap = a.maximumTakingAmount ?? requiredTaking;
  if (cap > TAKER_THRESHOLD_MAX) throw new Error("buildTakerFill: taking-amount cap exceeds the 185-bit threshold field");

  const extension = a.extension && a.extension !== "0x" ? a.extension : undefined;
  const receiver = a.receiver;
  const explicitReceiver = receiver !== undefined && !isAddressEqual(receiver, a.taker);

  let takerTraits = TAKER_MAKER_AMOUNT_FLAG | (cap & TAKER_THRESHOLD_MAX);
  const argParts: `0x${string}`[] = [];
  if (explicitReceiver) {
    takerTraits |= TAKER_ARGS_HAS_RECEIVER_FLAG;
    argParts.push(pad(receiver, { size: 20 }));
  }
  if (extension) {
    takerTraits |= BigInt(size(extension)) << TAKER_ARGS_EXTENSION_LENGTH_OFFSET;
    argParts.push(extension);
  }
  const interaction = a.interaction && a.interaction !== "0x" ? a.interaction : undefined;
  if (interaction) {
    const len = BigInt(size(interaction));
    if (len >= 1n << 24n) throw new Error("buildTakerFill: interaction exceeds the 24-bit args-length field");
    takerTraits |= len << TAKER_ARGS_INTERACTION_LENGTH_OFFSET;
    argParts.push(interaction);
  }
  const args = argParts.length > 0 ? concatHex(argParts) : undefined;

  const contract = a.makerAccountType === "ERC1271";
  const functionName = contract
    ? args
      ? "fillContractOrderArgs"
      : "fillContractOrder"
    : args
      ? "fillOrderArgs"
      : "fillOrder";

  const order = orderToUintTuple(a.order);
  let calldata: `0x${string}`;
  if (contract) {
    calldata =
      functionName === "fillContractOrderArgs"
        ? encodeFunctionData({ abi: fillAbi, functionName, args: [order, a.signature, making, takerTraits, args!] })
        : encodeFunctionData({ abi: fillAbi, functionName, args: [order, a.signature, making, takerTraits] });
  } else {
    const { r, yParityAndS: vs } = signatureToCompactSignature(parseSignature(a.signature));
    calldata =
      functionName === "fillOrderArgs"
        ? encodeFunctionData({ abi: fillAbi, functionName, args: [order, r, vs, making, takerTraits, args!] })
        : encodeFunctionData({ abi: fillAbi, functionName, args: [order, r, vs, making, takerTraits] });
  }

  return { to: null, calldata, functionName, takerTraits: takerTraits.toString(), requiredMakingAmount: making.toString(), requiredTakingAmount: requiredTaking.toString() };
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
