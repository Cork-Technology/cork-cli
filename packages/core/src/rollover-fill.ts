// The FILLER side of a rollover (2026-10-01, cork-cli-private#24 item 4) and the per-account
// rollover clone: pure byte-building against the 0.2.0 / rc.2 contracts (rollover-private
// `origin/main` 38a4a55 = the deployed 0.2.0; the rc.2 layout differs only in JITMarketParams).
//
// A roll order is the cPT HOLDER's intent (rollover-intent, signed under the CorkSettler domain).
// Its counterparty — the filler — brings the SOURCE cST (the cover buyer's own position in the
// expiring pool), pays the premium, and receives the DESTINATION cST minted in the holder's clone:
//   BaseFiller.execute(FillerJob) pulls `fillerSrcCst` src cST and `premiumCap` premium token from
//   the caller (approvals to BaseFiller), opens the order on the settler if needed, approves the
//   settler, calls settler.fill(orderDigest, abi.encode(order), atomicEnvelope), and refunds any
//   src cST and premium surplus to the caller. The dst cST reaches `destination` = the caller.
//   executeWithMarket(job, JITMarketParams) first creates the destination pool the order
//   committed to (`rolloverParams.jitMarketHash` must equal hashJITMarketParams on the settler
//   generation's wire; dstPoolId must be the pool it derives).
// The clone: CorkRolloverContractFactory.deployRolloverContract() — owner = msg.sender, one per
// owner (CREATE2 on keccak("cork.rollover.rolloverContract") ‖ owner), predictable with
// predictRolloverContractOf(owner); the settler refuses an order whose `rolloverContract` is not
// the user's deployed clone (Settler__RolloverContractNotDeployed / UserNotRolloverContractOwner).
//
// Every struct here is the contract's own: ERC7683Types.GaslessCrossChainOrder (uint32 deadlines),
// RolloverTypes.RolloverIntent (4 × Call[]), BaseFiller.FillerJob and JITMarketParams. The
// ERC-7683 envelope the settler re-encodes and compares byte-for-byte (`originData` must equal
// abi.encode(order)) is built from the same OrderData encoder the intent builder signs with —
// one encoder, so the envelope can only disagree where the venue's record does.
import { type Address, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, type Hex, pad } from "viem";
import type { RolloverWire } from "./generations.ts";
import { corkSettlerDomain, encodeOrderData, type JitMarketParamsStruct, type OrderDataStruct, ORDER_DATA_TYPEHASH, type RolloverCall, type RolloverIntentStruct } from "./rollover.ts";

// ── ABIs (the contracts' own signatures) ──────────────────────────────────────────────────────

const CALL_COMPONENTS = [
  { name: "target", type: "address" },
  { name: "value", type: "uint256" },
  { name: "callData", type: "bytes" },
  { name: "allowFailure", type: "bool" },
  { name: "isDelegateCall", type: "bool" },
] as const;

const INTENT_COMPONENTS = [
  { name: "rolloverContract", type: "address" },
  { name: "orderDigest", type: "bytes32" },
  { name: "deadline", type: "uint64" },
  { name: "nonce", type: "uint64" },
  { name: "preRolloverHooks", type: "tuple[]", components: CALL_COMPONENTS },
  { name: "midRolloverHooks", type: "tuple[]", components: CALL_COMPONENTS },
  { name: "postRolloverHooks", type: "tuple[]", components: CALL_COMPONENTS },
  { name: "premiumHooks", type: "tuple[]", components: CALL_COMPONENTS },
] as const;

/** ERC7683Types.GaslessCrossChainOrder — the envelope the settler decodes `orderData` from. */
export const GASLESS_ORDER_COMPONENTS = [
  { name: "originSettler", type: "address" },
  { name: "user", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "originChainId", type: "uint256" },
  { name: "openDeadline", type: "uint32" },
  { name: "fillDeadline", type: "uint32" },
  { name: "orderDataType", type: "bytes32" },
  { name: "orderData", type: "bytes" },
] as const;

const FILLER_JOB_COMPONENTS = [
  { name: "settler", type: "address" },
  { name: "order", type: "tuple", components: GASLESS_ORDER_COMPONENTS },
  { name: "userSig", type: "bytes" },
  { name: "srcCst", type: "address" },
  { name: "premiumToken", type: "address" },
  { name: "fillerSrcCst", type: "uint256" },
  { name: "intent", type: "tuple", components: INTENT_COMPONENTS },
  { name: "premiumCap", type: "uint256" },
  { name: "minDstPerSrc", type: "uint256" },
  { name: "fillerAuthSig", type: "bytes" },
] as const;

const CONSTRAINT_COMPONENTS = [
  { name: "rateMin", type: "uint256" },
  { name: "rateMax", type: "uint256" },
  { name: "rateChangePerDayMax", type: "uint256" },
  { name: "rateChangeCapacityMax", type: "uint256" },
] as const;

/** BaseFiller.JITMarketParams on the 0.2 wire (oracleSalt after additionalData) and on rc.2 (no salt). */
const JIT_MARKET_PARAMS_02 = [
  { name: "collateralAsset", type: "address" },
  { name: "referenceAsset", type: "address" },
  { name: "expiryTimestamp", type: "uint256" },
  { name: "recipe", type: "address" },
  { name: "rateOverride", type: "uint256" },
  { name: "constraint", type: "tuple", components: CONSTRAINT_COMPONENTS },
  { name: "additionalData", type: "bytes" },
  { name: "oracleSalt", type: "bytes32" },
  { name: "swapFeePercentage", type: "uint256" },
  { name: "unwindSwapFeePercentage", type: "uint256" },
] as const;
const JIT_MARKET_PARAMS_RC2 = [
  { name: "collateralAsset", type: "address" },
  { name: "referenceAsset", type: "address" },
  { name: "expiryTimestamp", type: "uint256" },
  { name: "recipe", type: "address" },
  { name: "rateOverride", type: "uint256" },
  { name: "constraint", type: "tuple", components: CONSTRAINT_COMPONENTS },
  { name: "additionalData", type: "bytes" },
  { name: "swapFeePercentage", type: "uint256" },
  { name: "unwindSwapFeePercentage", type: "uint256" },
] as const;

export const baseFillerAbi = [
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "job", type: "tuple", components: FILLER_JOB_COMPONENTS }], outputs: [] },
  { type: "function", name: "executeWithMarket", stateMutability: "nonpayable", inputs: [{ name: "job", type: "tuple", components: FILLER_JOB_COMPONENTS }, { name: "jitMarket", type: "tuple", components: JIT_MARKET_PARAMS_02 }], outputs: [] },
  { type: "function", name: "hashJITMarketParams", stateMutability: "pure", inputs: [{ name: "params", type: "tuple", components: JIT_MARKET_PARAMS_02 }], outputs: [{ name: "commitment", type: "bytes32" }] },
  { type: "function", name: "version", stateMutability: "pure", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** The rc.2 BaseFiller's `executeWithMarket` (a different selector: no `oracleSalt` member). */
export const baseFillerRc2Abi = [
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "job", type: "tuple", components: FILLER_JOB_COMPONENTS }], outputs: [] },
  { type: "function", name: "executeWithMarket", stateMutability: "nonpayable", inputs: [{ name: "job", type: "tuple", components: FILLER_JOB_COMPONENTS }, { name: "jitMarket", type: "tuple", components: JIT_MARKET_PARAMS_RC2 }], outputs: [] },
] as const;

export const rolloverFactoryAbi = [
  { type: "function", name: "deployRolloverContract", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "rolloverContract", type: "address" }] },
  { type: "function", name: "predictRolloverContractOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "rolloverContractOf", stateMutability: "view", inputs: [{ name: "owner_", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isDeployedRolloverContract", stateMutability: "view", inputs: [{ name: "rolloverContract", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "version", stateMutability: "pure", inputs: [], outputs: [{ type: "string" }] },
] as const;

// ── the ERC-7683 envelope ─────────────────────────────────────────────────────────────────────

export interface GaslessCrossChainOrder {
  originSettler: Address;
  user: Address;
  nonce: bigint;
  originChainId: bigint;
  openDeadline: number;
  fillDeadline: number;
  orderDataType: Hex;
  orderData: Hex;
}

/** The envelope the settler admits (LibSettlerAdmission): originSettler = the order's settler,
 *  nonce = orderSalt, the deadlines mirror OrderData, orderDataType = ORDER_DATA_TYPEHASH,
 *  orderData = the 864-byte static encoding. Deadlines are uint32 on the wire. */
export function gaslessOrderOf(o: OrderDataStruct): GaslessCrossChainOrder {
  const u32 = (v: bigint, name: string): number => {
    if (v < 0n || v > 0xffff_ffffn) throw new Error(`${name} ${v} does not fit the ERC-7683 envelope's uint32`);
    return Number(v);
  };
  return {
    originSettler: o.settler,
    user: o.user,
    nonce: o.orderSalt,
    originChainId: o.originChainId,
    openDeadline: u32(o.openDeadline, "openDeadline"),
    fillDeadline: u32(o.fillDeadline, "fillDeadline"),
    orderDataType: ORDER_DATA_TYPEHASH,
    orderData: encodeOrderData(o),
  };
}

/** `abi.encode(GaslessCrossChainOrder)` — the settler's `originData`, re-encoded and compared
 *  byte-for-byte against what the filler passes (Settler__OrderIdMismatch otherwise). */
export function encodeOriginData(order: GaslessCrossChainOrder): Hex {
  return encodeAbiParameters([{ type: "tuple", components: GASLESS_ORDER_COMPONENTS }], [order]);
}

// ── the venue's payload → structs ─────────────────────────────────────────────────────────────

/** What `/rollover/v1/orders/{digest}` serves under `payload` (and what cork_submit rollover-order
 *  posted): the OrderData fields as decimal strings, the intent with its hook arrays, the cPT
 *  holder's signature, and the envelope the venue derived. */
export interface VenueRolloverPayload {
  chainId?: unknown;
  order: Record<string, unknown>;
  intent: Record<string, unknown>;
  signature: unknown;
  envelope?: { orderData?: unknown; orderDataType?: unknown; originData?: unknown } | undefined;
}

export interface ParsedRolloverPayload {
  order: OrderDataStruct;
  /** `orderDigest` is the REAL digest when the record carried one (the venue's rows do), or the
   *  zero hash when it did not (the intent builder's own post omits it — the venue fills it in);
   *  `intentDigestGiven` says which, so the handler can bind or verify. */
  intent: RolloverIntentStruct;
  intentDigestGiven: boolean;
  signature: Hex;
  /** The venue's own envelope bytes when it served them — cross-checked, never trusted. */
  venueOriginData?: Hex | undefined;
  venueOrderDataType?: Hex | undefined;
}

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/u.test(v);
const isAddr = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/u.test(v);
const isB32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/u.test(v);

function uint(rec: Record<string, unknown>, key: string, where: string): bigint {
  const v = rec[key];
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/u.test(v)) return BigInt(v);
  throw new Error(`${where}.${key} is not an unsigned integer (${JSON.stringify(v)})`);
}
function addr(rec: Record<string, unknown>, key: string, where: string): Address {
  const v = rec[key];
  if (!isAddr(v)) throw new Error(`${where}.${key} is not an address (${JSON.stringify(v)})`);
  return getAddress(v);
}
function b32(rec: Record<string, unknown>, key: string, where: string): Hex {
  const v = rec[key];
  if (!isB32(v)) throw new Error(`${where}.${key} is not a bytes32 (${JSON.stringify(v)})`);
  return v;
}
function bool(rec: Record<string, unknown>, key: string, where: string): boolean {
  const v = rec[key];
  if (typeof v !== "boolean") throw new Error(`${where}.${key} is not a boolean (${JSON.stringify(v)})`);
  return v;
}
function calls(rec: Record<string, unknown>, key: string, where: string): RolloverCall[] {
  const v = rec[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${where}.${key} is not an array`);
  return v.map((c, i) => {
    if (!c || typeof c !== "object") throw new Error(`${where}.${key}[${i}] is not a call`);
    const r = c as Record<string, unknown>;
    const data = r["callData"];
    if (!isHex(data)) throw new Error(`${where}.${key}[${i}].callData is not hex`);
    return { target: addr(r, "target", `${where}.${key}[${i}]`), value: uint(r, "value", `${where}.${key}[${i}]`), callData: data, allowFailure: bool(r, "allowFailure", `${where}.${key}[${i}]`), isDelegateCall: bool(r, "isDelegateCall", `${where}.${key}[${i}]`) };
  });
}

/** Parse the venue's (or a caller's inline) rollover payload into the structs the fill encodes.
 *  THROWS a plain Error naming the field on any shape defect — the handler turns it into an
 *  `invalid_service_response` (venue) or invalid input (inline). */
export function parseRolloverPayload(p: VenueRolloverPayload): ParsedRolloverPayload {
  const o = p.order;
  const rp = o["rolloverParams"];
  if (!rp || typeof rp !== "object") throw new Error("order.rolloverParams is missing");
  const r = rp as Record<string, unknown>;
  const mode = uint(o, "premiumPaymentMode", "order");
  if (mode !== 0n && mode !== 1n) throw new Error(`order.premiumPaymentMode ${mode} is neither 0 nor 1`);
  const order: OrderDataStruct = {
    user: addr(o, "user", "order"),
    settler: addr(o, "settler", "order"),
    fillerHint: addr(o, "fillerHint", "order"),
    exclusiveFiller: addr(o, "exclusiveFiller", "order"),
    srcCstToken: addr(o, "srcCstToken", "order"),
    dstCstToken: addr(o, "dstCstToken", "order"),
    premiumToken: addr(o, "premiumToken", "order"),
    rolloverContract: addr(o, "rolloverContract", "order"),
    originChainId: uint(o, "originChainId", "order"),
    destinationChainId: uint(o, "destinationChainId", "order"),
    openDeadline: uint(o, "openDeadline", "order"),
    fillDeadline: uint(o, "fillDeadline", "order"),
    orderSalt: uint(o, "orderSalt", "order"),
    orderSize: uint(o, "orderSize", "order"),
    minPremiumPerShare: uint(o, "minPremiumPerShare", "order"),
    allowPartialFills: bool(o, "allowPartialFills", "order"),
    allowUnderfill: bool(o, "allowUnderfill", "order"),
    premiumPaymentMode: Number(mode),
    rolloverIntentHash: b32(o, "rolloverIntentHash", "order"),
    rolloverParams: {
      srcCstToken: addr(r, "srcCstToken", "order.rolloverParams"),
      dstCstToken: addr(r, "dstCstToken", "order.rolloverParams"),
      minCaReceived: uint(r, "minCaReceived", "order.rolloverParams"),
      minSharesOut: uint(r, "minSharesOut", "order.rolloverParams"),
      srcPoolId: b32(r, "srcPoolId", "order.rolloverParams"),
      dstPoolId: b32(r, "dstPoolId", "order.rolloverParams"),
      settler: addr(r, "settler", "order.rolloverParams"),
      jitMarketHash: r["jitMarketHash"] === undefined || r["jitMarketHash"] === null ? `0x${"0".repeat(64)}` : b32(r, "jitMarketHash", "order.rolloverParams"),
    },
  };
  const it = p.intent;
  const intentDigestGiven = it["orderDigest"] !== undefined && it["orderDigest"] !== null;
  const intent: RolloverIntentStruct = {
    rolloverContract: addr(it, "rolloverContract", "intent"),
    orderDigest: intentDigestGiven ? b32(it, "orderDigest", "intent") : `0x${"0".repeat(64)}`,
    deadline: uint(it, "deadline", "intent"),
    nonce: uint(it, "nonce", "intent"),
    preRolloverHooks: calls(it, "preRolloverHooks", "intent"),
    midRolloverHooks: calls(it, "midRolloverHooks", "intent"),
    postRolloverHooks: calls(it, "postRolloverHooks", "intent"),
    premiumHooks: calls(it, "premiumHooks", "intent"),
  };
  if (!isHex(p.signature) || p.signature.length < 4) throw new Error("signature is not hex bytes");
  const env = p.envelope;
  return {
    order,
    intent,
    intentDigestGiven,
    signature: p.signature,
    ...(env && isHex(env.originData) ? { venueOriginData: env.originData } : {}),
    ...(env && isB32(env.orderDataType) ? { venueOrderDataType: env.orderDataType } : {}),
  };
}

// ── the FillerJob ─────────────────────────────────────────────────────────────────────────────

export interface FillerJobArgs {
  order: OrderDataStruct;
  intent: RolloverIntentStruct;
  /** The cPT holder's signature over the order digest (EIP-712 or ERC-1271 bytes), verbatim. */
  userSig: Hex;
  fillerSrcCst: bigint;
  premiumCap: bigint;
  minDstPerSrc: bigint;
  fillerAuthSig: Hex;
}

/** The job struct exactly as BaseFiller decodes it; `settler` and the tokens come from the
 *  signed order (the contract re-reads them from `orderData` and refuses a disagreement). */
export function fillerJobOf(a: FillerJobArgs) {
  return {
    settler: a.order.settler,
    order: gaslessOrderOf(a.order),
    userSig: a.userSig,
    srcCst: a.order.srcCstToken,
    premiumToken: a.order.premiumToken,
    fillerSrcCst: a.fillerSrcCst,
    intent: a.intent,
    premiumCap: a.premiumCap,
    minDstPerSrc: a.minDstPerSrc,
    fillerAuthSig: a.fillerAuthSig,
  };
}

/** `BaseFiller.execute(job)` calldata. */
export function encodeBaseFillerExecute(a: FillerJobArgs): Hex {
  return encodeFunctionData({ abi: baseFillerAbi, functionName: "execute", args: [fillerJobOf(a)] });
}

/** `BaseFiller.executeWithMarket(job, jitMarket)` calldata on the settler generation's wire:
 *  0.2 carries `oracleSalt` (zero when unset), rc.2 has no member for it and refuses a non-zero
 *  one (dropping it silently would commit to a market the holder never signed). */
export function encodeBaseFillerExecuteWithMarket(a: FillerJobArgs, jit: JitMarketParamsStruct, wire: Exclude<RolloverWire, "rc.1">): Hex {
  const base = {
    collateralAsset: jit.collateralAsset,
    referenceAsset: jit.referenceAsset,
    expiryTimestamp: jit.expiryTimestamp,
    recipe: jit.recipe,
    rateOverride: jit.rateOverride,
    constraint: { rateMin: jit.rateMin, rateMax: jit.rateMax, rateChangePerDayMax: jit.rateChangePerDayMax, rateChangeCapacityMax: jit.rateChangeCapacityMax },
    additionalData: jit.additionalData,
    swapFeePercentage: jit.swapFeePercentage,
    unwindSwapFeePercentage: jit.unwindSwapFeePercentage,
  };
  if (wire === "0.2") {
    return encodeFunctionData({ abi: baseFillerAbi, functionName: "executeWithMarket", args: [fillerJobOf(a), { ...base, oracleSalt: jit.oracleSalt ?? `0x${"0".repeat(64)}` }] });
  }
  if (jit.oracleSalt !== undefined && !/^0x0{64}$/u.test(jit.oracleSalt)) throw new Error("an rc.2 BaseFiller has no oracleSalt member — a non-zero salt cannot be committed on this wire");
  return encodeFunctionData({ abi: baseFillerRc2Abi, functionName: "executeWithMarket", args: [fillerJobOf(a), base] });
}

/** Decode `execute`/`executeWithMarket` calldata back to its job (tests, and the decoder). */
export function decodeBaseFillerCall(data: Hex) {
  try {
    return decodeFunctionData({ abi: baseFillerAbi, data });
  } catch {
    return decodeFunctionData({ abi: baseFillerRc2Abi, data });
  }
}

/** `CorkRolloverContractFactory.deployRolloverContract()` calldata (owner = msg.sender). */
export function encodeDeployRolloverContract(): Hex {
  return encodeFunctionData({ abi: rolloverFactoryAbi, functionName: "deployRolloverContract" });
}

/** The premium the settler charges for `dstCstProduced` dst shares (LibAtomicFill): ceil(dst ×
 *  minPremiumPerShare / 1e18). A fill reverts Settler__PremiumExceedsCap above the job's cap, so
 *  the cap must cover the dst shares the holder's clone will actually mint. */
export function requiredPremium(dstCstProduced: bigint, minPremiumPerShare: bigint): bigint {
  const n = dstCstProduced * minPremiumPerShare;
  return (n + 10n ** 18n - 1n) / 10n ** 18n;
}

// ── FillerAuth: the delegated authorization a RESERVED order needs when filled through BaseFiller ──
// LibFillerAuth.isAuthorised passes (a) no gate, (b) `msg.sender == exclusiveFiller` at
// settler.fill — and through BaseFiller that sender is BaseFiller itself, never the account — or
// (c) a signature by exclusiveFiller over FillerAuth(orderDigest, destination, subFiller) under
// the settler's own CorkSettler/1.0.0 domain. BaseFiller passes destination = its msg.sender (the
// account that calls it) and subFiller = bytes32(uint160(msg.sender)) (INV-SUBFILLER-PROVENANCE),
// so the exclusive filler signs over the ACCOUNT that will call BaseFiller, itself included.

/** The EIP-712 type the exclusive filler signs (Typehashes.FILLER_AUTH_TYPEHASH). */
export const FILLER_AUTH_TYPES = {
  FillerAuth: [
    { name: "orderDigest", type: "bytes32" },
    { name: "destination", type: "address" },
    { name: "subFiller", type: "bytes32" },
  ],
} as const;

/** The sub-filler identity BaseFiller derives for the account that calls it. */
export function subFillerOf(account: Address): Hex {
  return pad(getAddress(account), { size: 32 });
}

/** The FillerAuth typed data for a fill THROUGH BaseFiller by `account` — what the exclusive
 *  filler signs (eth_signTypedData_v4) to delegate its reservation to that account. */
export function fillerAuthTypedData(a: { chainId: number; settler: Address; orderDigest: Hex; account: Address }) {
  return {
    domain: corkSettlerDomain(a.chainId, a.settler),
    types: FILLER_AUTH_TYPES,
    primaryType: "FillerAuth" as const,
    message: { orderDigest: a.orderDigest, destination: getAddress(a.account), subFiller: subFillerOf(a.account) },
  };
}

/** LibFillerAuth.hashFillerAuth: the digest `fillerAuthSig` must verify against. */
export function hashFillerAuth(a: { chainId: number; settler: Address; orderDigest: Hex; account: Address }): Hex {
  return hashTypedData(fillerAuthTypedData(a));
}
