// Smart-account ENVELOPES: the wallet-infrastructure calls that wrap the call a user actually
// means. A contract wallet never sends `fillOrderForSelf` itself — it arrives inside a Safe
// `execTransaction`, an ERC-4337 `handleOps` bundle, an ERC-7579 `execute`, a Rhinestone intent,
// or a MultiSend batch, often several deep. Before 2026-10-01 the decoder stopped at the first
// layer and called the whole transaction an unknown target; a Zyfai fill (Safe 1.4.1 through
// Rhinestone's IntentExecutor, test fixture `zyfai-rhinestone-fill-base.json`) decoded as
// `unknown_target` with nothing inside it read.
//
// This module peels ONE layer: given a call's bytes it answers "what calls does this envelope
// make, from which account, and how" — or nothing, when the bytes are not an envelope. The
// recursive decoder (decode.ts) re-enters itself on each inner call, so an envelope's legs are
// verified against the Cork address book exactly as a bare transaction's would be.
//
// Every layout here is pinned from the deployed contracts' own sources (fetched 2026-10-01):
//   - ERC-4337 EntryPoint v0.6 `UserOperation` (eth-infinitism/account-abstraction v0.6.0) and
//     v0.7 `PackedUserOperation` (v0.7.0; v0.8 keeps the same ABI). The user operation's
//     `callData` is a call ON the account (`sender`): the next layer's target is the account.
//   - Safe4337Module `executeUserOp(to, value, data, operation)` / `…WithErrorString` (safe-modules
//     modules/4337) — called on the Safe through its fallback handler.
//   - Safe `execTransaction(to, value, data, operation, …)` — the Safe is the `to` of the outer call.
//   - Safe `MultiSend.multiSend(bytes)` — packed `operation(1) ‖ to(20) ‖ value(32) ‖ len(32) ‖ data`.
//   - ERC-7579 `execute(bytes32 mode, bytes)` / `executeFromExecutor(…)` (erc7579-implementation
//     ModeLib + ExecutionLib): mode byte 0 is the CALLTYPE — 0x00 single (packed target ‖ value ‖
//     data), 0x01 batch (abi.encode(Execution[])), 0xff delegatecall (packed target ‖ data);
//     mode byte 1 is the EXECTYPE — 0x01 "try" lets a failing call be skipped (skipRevert).
//   - An ERC-7579 EXECUTOR MODULE's batch entry, `executeGuardedBatch(Execution[])` — the shape
//     Zyfai's GuardedExecModuleUpgradeable 2.2.0 (Sourcify-verified on Base) takes: the module
//     runs the batch on the account through executeFromExecutor. Integrator-deployed, so the
//     module address is never a singleton; the batch is the standard Execution[] and decodes.
//   - Rhinestone IntentExecutor `executeSinglechainOps(SingleChainOps)` and the gas-refund and
//     multichain variants (rhinestonewtf/warp-router src/executor/interfaces/IStandaloneIntent.sol):
//     `Operation.data` = `[Type byte][SigMode byte][payload]` (SmartExecutionLib), Type 1 =
//     raw calldata (target ‖ data), Type 2 = ERC-7579 batch, Type 3 = multicall batch — all
//     executed FROM the account through executeFromExecutor.
//
// A DELEGATECALL is never hidden: a Safe operation 1, a MultiSend operation byte 1, or a 7579
// callType 0xff runs foreign code inside the wallet's own storage context, which changes what
// signing means; the inner leg carries `delegatecall: true` and the summary says so.
//
// Which outer addresses the decoder may call trusted: the singletons whose code was read on
// Base, Ethereum and Arbitrum and found byte-identical (2026-10-01 — EntryPoint v0.6 and v0.7,
// the four Safe MultiSend deployments, Safe4337Module 0.3.0, the Rhinestone IntentExecutor
// proxy). EntryPoint v0.8's address holds DIFFERENT code per chain, so it is recognized by
// shape and labeled, never trusted. A wallet's own contract (the Safe, the 7579 account) is
// nobody's to vouch for: labeled as the account, `unverified` by construction, and excluded from
// the `target_unverified` scare — the inner Cork legs are what the signer must check.
import { decodeAbiParameters, decodeFunctionData, getAddress, toFunctionSelector, type AbiFunction } from "viem";

export type EnvelopeScheme =
  | "erc4337-entrypoint"
  | "safe-4337-module"
  | "safe-exec-transaction"
  | "safe-multisend"
  | "erc7579-execute"
  | "erc7579-executor-module"
  | "rhinestone-intent-executor";

/** One inner call an envelope makes. `delegatecall` marks code run in the ACCOUNT's context. */
export interface EnvelopeCall {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  delegatecall: boolean;
  /** ERC-7579 "try" exec type: the account continues past a failing call. */
  skipRevert: boolean;
}

/** One peeled layer. `account` is the smart account the inner calls run FROM when the envelope
 *  names it (the user operation's sender, the Rhinestone op's account); a Safe envelope's
 *  account is the call's own target, which the caller knows. */
export interface EnvelopeHop {
  scheme: EnvelopeScheme;
  /** Layout version where the scheme has several (entrypoint v0.6 vs v0.7; 7579 call types). */
  version: string;
  account?: `0x${string}`;
  calls: EnvelopeCall[];
  /** Per-layer facts a signer should see (an ERC-4337 beneficiary, a 7579 executor path). */
  note?: string;
}

// ── pinned ABIs ───────────────────────────────────────────────────────────────────────────────

const USER_OPERATION_V06 = {
  type: "tuple",
  components: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "callGasLimit", type: "uint256" },
    { name: "verificationGasLimit", type: "uint256" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "maxPriorityFeePerGas", type: "uint256" },
    { name: "paymasterAndData", type: "bytes" },
    { name: "signature", type: "bytes" },
  ],
} as const;

const PACKED_USER_OPERATION_V07 = {
  type: "tuple",
  components: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCode", type: "bytes" },
    { name: "callData", type: "bytes" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "paymasterAndData", type: "bytes" },
    { name: "signature", type: "bytes" },
  ],
} as const;

/** EntryPoint v0.6 `handleOps` and v0.7/v0.8 `handleOps` are different functions (different
 *  tuple, different selector); viem picks the overload by selector. */
export const entryPointAbi = [
  { type: "function", name: "handleOps", stateMutability: "nonpayable", inputs: [{ name: "ops", type: "tuple[]", components: USER_OPERATION_V06.components }, { name: "beneficiary", type: "address" }], outputs: [] },
  { type: "function", name: "handleOps", stateMutability: "nonpayable", inputs: [{ name: "ops", type: "tuple[]", components: PACKED_USER_OPERATION_V07.components }, { name: "beneficiary", type: "address" }], outputs: [] },
] as const satisfies readonly AbiFunction[];

export const safe4337ModuleAbi = [
  { type: "function", name: "executeUserOp", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [] },
  { type: "function", name: "executeUserOpWithErrorString", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [] },
] as const satisfies readonly AbiFunction[];

export const safeAbi = [
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const satisfies readonly AbiFunction[];

export const multiSendAbi = [
  { type: "function", name: "multiSend", stateMutability: "payable", inputs: [{ name: "transactions", type: "bytes" }], outputs: [] },
] as const satisfies readonly AbiFunction[];

export const erc7579Abi = [
  { type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "mode", type: "bytes32" }, { name: "executionCalldata", type: "bytes" }], outputs: [] },
  { type: "function", name: "executeFromExecutor", stateMutability: "payable", inputs: [{ name: "mode", type: "bytes32" }, { name: "executionCalldata", type: "bytes" }], outputs: [{ name: "returnData", type: "bytes[]" }] },
] as const satisfies readonly AbiFunction[];

const RHINESTONE_OPERATION = { type: "tuple", components: [{ name: "data", type: "bytes" }] } as const;
const RHINESTONE_SINGLE_CHAIN_OPS = {
  type: "tuple",
  components: [{ name: "account", type: "address" }, { name: "nonce", type: "uint256" }, { name: "ops", ...RHINESTONE_OPERATION }, { name: "signature", type: "bytes" }],
} as const;
const RHINESTONE_MULTI_CHAIN_OPS = {
  type: "tuple",
  components: [
    { name: "account", type: "address" },
    { name: "chainIndex", type: "uint256" },
    { name: "otherChains", type: "bytes32[]" },
    { name: "nonce", type: "uint256" },
    { name: "ops", ...RHINESTONE_OPERATION },
    { name: "signature", type: "bytes" },
  ],
} as const;
const RHINESTONE_GAS_REFUND = { type: "tuple", components: [{ name: "token", type: "address" }, { name: "exchangeRate", type: "uint256" }, { name: "overhead", type: "uint256" }] } as const;

export const rhinestoneIntentExecutorAbi = [
  { type: "function", name: "executeSinglechainOps", stateMutability: "nonpayable", inputs: [{ name: "signedOps", ...RHINESTONE_SINGLE_CHAIN_OPS }], outputs: [] },
  { type: "function", name: "executeSinglechainOpsWithGasRefund_ERC20", stateMutability: "nonpayable", inputs: [{ name: "signedOps", ...RHINESTONE_SINGLE_CHAIN_OPS }, { name: "gasRefund", ...RHINESTONE_GAS_REFUND }, { name: "gasRefundRecipient", type: "address" }], outputs: [{ name: "account", type: "address" }, { name: "nonce", type: "uint256" }] },
  { type: "function", name: "executeSinglechainOpsWithGasRefund_ETH", stateMutability: "nonpayable", inputs: [{ name: "signedOps", ...RHINESTONE_SINGLE_CHAIN_OPS }, { name: "gasRefund", ...RHINESTONE_GAS_REFUND }, { name: "gasRefundRecipient", type: "address" }], outputs: [{ name: "account", type: "address" }, { name: "nonce", type: "uint256" }] },
  { type: "function", name: "executeMultichainOps", stateMutability: "nonpayable", inputs: [{ name: "signedOps", ...RHINESTONE_MULTI_CHAIN_OPS }], outputs: [] },
  { type: "function", name: "executeMultichainOpsWithGasRefund_ERC20", stateMutability: "nonpayable", inputs: [{ name: "signedOps", ...RHINESTONE_MULTI_CHAIN_OPS }, { name: "gasRefund", ...RHINESTONE_GAS_REFUND }, { name: "gasRefundRecipient", type: "address" }], outputs: [{ name: "account", type: "address" }, { name: "nonce", type: "uint256" }] },
  { type: "function", name: "executeMultichainOpsWithGasRefund_ETH", stateMutability: "nonpayable", inputs: [{ name: "signedOps", ...RHINESTONE_MULTI_CHAIN_OPS }, { name: "gasRefund", ...RHINESTONE_GAS_REFUND }, { name: "gasRefundRecipient", type: "address" }], outputs: [{ name: "account", type: "address" }, { name: "nonce", type: "uint256" }] },
] as const satisfies readonly AbiFunction[];

/** ERC-7579 `Execution` — the batch element of a 7579 batch AND of a Rhinestone ERC7579/MultiCall op. */
const ERC7579_EXECUTION_ARRAY = [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }] as const;

/** An executor module's batch entry (Zyfai's GuardedExecModuleUpgradeable: `executeGuardedBatch(Execution[])`). */
export const erc7579ExecutorModuleAbi = [
  { type: "function", name: "executeGuardedBatch", stateMutability: "nonpayable", inputs: [{ name: "executions", ...ERC7579_EXECUTION_ARRAY[0] }], outputs: [] },
] as const satisfies readonly AbiFunction[];

// ── canonical singletons ──────────────────────────────────────────────────────────────────────

export interface EnvelopeSingleton {
  scheme: EnvelopeScheme;
  label: string;
  address: `0x${string}`;
  /** true = code read byte-identical on Base, Ethereum and Arbitrum (2026-10-01); such an
   *  address may be called `trusted`. false = a known address whose code differs per chain
   *  (EntryPoint v0.8) — labeled, never trusted. */
  byteVerified: boolean;
}

/** The wallet-infrastructure singletons the decoder names. Addresses are chain-independent
 *  CREATE2 deployments; the live test `envelopes-live.test.ts` re-reads their code hashes. */
export const ENVELOPE_SINGLETONS: readonly EnvelopeSingleton[] = [
  { scheme: "erc4337-entrypoint", label: "ERC-4337 EntryPoint v0.6", address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", byteVerified: true },
  { scheme: "erc4337-entrypoint", label: "ERC-4337 EntryPoint v0.7", address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", byteVerified: true },
  { scheme: "erc4337-entrypoint", label: "ERC-4337 EntryPoint v0.8", address: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", byteVerified: false },
  { scheme: "safe-multisend", label: "Safe MultiSend 1.4.1", address: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526", byteVerified: true },
  { scheme: "safe-multisend", label: "Safe MultiSendCallOnly 1.4.1", address: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2", byteVerified: true },
  { scheme: "safe-multisend", label: "Safe MultiSend 1.3.0", address: "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761", byteVerified: true },
  { scheme: "safe-multisend", label: "Safe MultiSend 1.3.0 (L2)", address: "0x998739BFdAAdde7C933B942a68053933098f9EDa", byteVerified: true },
  { scheme: "safe-multisend", label: "Safe MultiSendCallOnly 1.3.0", address: "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D", byteVerified: true },
  { scheme: "safe-multisend", label: "Safe MultiSendCallOnly 1.3.0 (L2)", address: "0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B", byteVerified: true },
  { scheme: "safe-4337-module", label: "Safe4337Module 0.3.0", address: "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226", byteVerified: true },
  { scheme: "rhinestone-intent-executor", label: "Rhinestone IntentExecutor", address: "0x00000000005ad9ce1f5035fd62ca96cef16adaaf", byteVerified: true },
];

/** The singleton an envelope's target is, if any. */
export function envelopeSingletonAt(to: `0x${string}`): EnvelopeSingleton | undefined {
  const lc = to.toLowerCase();
  return ENVELOPE_SINGLETONS.find((s) => s.address.toLowerCase() === lc);
}

// ── selector dispatch ─────────────────────────────────────────────────────────────────────────

const sel = (f: AbiFunction) => toFunctionSelector(f).toLowerCase();
const ENTRYPOINT_V06_SELECTOR = sel(entryPointAbi[0]);
const ENTRYPOINT_V07_SELECTOR = sel(entryPointAbi[1]);
const SAFE_4337_SELECTORS = new Set(safe4337ModuleAbi.map(sel));
const SAFE_EXEC_SELECTOR = sel(safeAbi[0]);
const MULTISEND_SELECTOR = sel(multiSendAbi[0]);
const ERC7579_SELECTORS = new Set(erc7579Abi.map(sel));
const EXECUTOR_MODULE_SELECTORS = new Set(erc7579ExecutorModuleAbi.map(sel));
const RHINESTONE_SELECTORS = new Set(rhinestoneIntentExecutorAbi.map(sel));

/** Every selector this module unwraps — the decoder asks this before trying the Cork ABIs. */
export function isEnvelopeSelector(selector: string): boolean {
  const s = selector.toLowerCase();
  return s === ENTRYPOINT_V06_SELECTOR || s === ENTRYPOINT_V07_SELECTOR || SAFE_4337_SELECTORS.has(s) || s === SAFE_EXEC_SELECTOR || s === MULTISEND_SELECTOR || ERC7579_SELECTORS.has(s) || EXECUTOR_MODULE_SELECTORS.has(s) || RHINESTONE_SELECTORS.has(s);
}

/** Name of the envelope function a selector is, for a degraded (malformed-body) leg's note. */
export function envelopeFunctionName(selector: string): string | undefined {
  const s = selector.toLowerCase();
  if (s === ENTRYPOINT_V06_SELECTOR) return "EntryPoint.handleOps (v0.6)";
  if (s === ENTRYPOINT_V07_SELECTOR) return "EntryPoint.handleOps (v0.7/v0.8)";
  if (SAFE_4337_SELECTORS.has(s)) return "Safe4337Module.executeUserOp";
  if (s === SAFE_EXEC_SELECTOR) return "Safe.execTransaction";
  if (s === MULTISEND_SELECTOR) return "MultiSend.multiSend";
  if (ERC7579_SELECTORS.has(s)) return "ERC-7579 execute";
  if (EXECUTOR_MODULE_SELECTORS.has(s)) return "ERC-7579 executor module executeGuardedBatch";
  if (RHINESTONE_SELECTORS.has(s)) return "Rhinestone IntentExecutor";
  return undefined;
}

/** Every address this module emits is EIP-55 checksummed, as viem's ABI decoding emits them, so a
 *  packed-bytes target and a tuple target compare equal downstream. */
const call = (to: `0x${string}`, value: bigint, data: `0x${string}`, delegatecall = false, skipRevert = false): EnvelopeCall => ({ to: getAddress(to), value, data, delegatecall, skipRevert });

/** Safe `operation`: 0 = CALL, 1 = DELEGATECALL (Enum.Operation). Any other value is not a Safe op. */
function safeOperation(op: number, where: string): boolean {
  if (op === 0) return false;
  if (op === 1) return true;
  throw new Error(`${where}: operation ${op} is neither CALL (0) nor DELEGATECALL (1)`);
}

/** Safe MultiSend packed transactions: `operation(1) ‖ to(20) ‖ value(32) ‖ dataLength(32) ‖ data`,
 *  repeated; the contract reads them with assembly and reverts on a short trailer, so a trailer
 *  that does not fit is a decode failure here too (never silently truncated). */
export function decodeMultiSendTransactions(packed: `0x${string}`): EnvelopeCall[] {
  const hex = packed.slice(2);
  if (hex.length % 2 !== 0) throw new Error("multiSend: odd-length bytes");
  const out: EnvelopeCall[] = [];
  let i = 0;
  while (i < hex.length) {
    if (hex.length - i < (1 + 20 + 32 + 32) * 2) throw new Error("multiSend: truncated transaction header");
    const operation = Number.parseInt(hex.slice(i, i + 2), 16);
    const to = `0x${hex.slice(i + 2, i + 42)}` as `0x${string}`;
    const value = BigInt(`0x${hex.slice(i + 42, i + 106)}`);
    const dataLength = Number(BigInt(`0x${hex.slice(i + 106, i + 170)}`));
    const dataStart = i + 170;
    const dataEnd = dataStart + dataLength * 2;
    if (dataEnd > hex.length) throw new Error("multiSend: transaction data runs past the end of the payload");
    out.push(call(to, value, `0x${hex.slice(dataStart, dataEnd)}`, safeOperation(operation, "multiSend")));
    i = dataEnd;
  }
  return out;
}

/** ERC-7579 mode → (callType, execType). ModeLib: byte 0 callType, byte 1 execType; the mode
 *  selector and payload (bytes 6..31) do not change what runs and are ignored here. */
function erc7579Mode(mode: `0x${string}`): { callType: number; execType: number } {
  return { callType: Number.parseInt(mode.slice(2, 4), 16), execType: Number.parseInt(mode.slice(4, 6), 16) };
}

/** ERC-7579 execution calldata by call type (ExecutionLib): single = `target(20) ‖ value(32) ‖
 *  data`; batch = `abi.encode(Execution[])`; delegatecall = `target(20) ‖ data`. */
export function decodeErc7579Executions(callType: number, executionCalldata: `0x${string}`, skipRevert: boolean): { calls: EnvelopeCall[]; version: string } {
  const hex = executionCalldata.slice(2);
  switch (callType) {
    case 0x00: {
      if (hex.length < (20 + 32) * 2) throw new Error("ERC-7579 single execution: shorter than target ‖ value");
      return { version: "single", calls: [call(`0x${hex.slice(0, 40)}`, BigInt(`0x${hex.slice(40, 104)}`), `0x${hex.slice(104)}`, false, skipRevert)] };
    }
    case 0x01: {
      const [batch] = decodeAbiParameters(ERC7579_EXECUTION_ARRAY, executionCalldata);
      return { version: "batch", calls: batch.map((e) => call(e.target, e.value, e.callData, false, skipRevert)) };
    }
    case 0xff: {
      if (hex.length < 20 * 2) throw new Error("ERC-7579 delegatecall execution: shorter than a target");
      return { version: "delegatecall", calls: [call(`0x${hex.slice(0, 40)}`, 0n, `0x${hex.slice(40)}`, true, skipRevert)] };
    }
    default:
      throw new Error(`ERC-7579 callType 0x${callType.toString(16).padStart(2, "0")} is not single (0x00), batch (0x01) or delegatecall (0xff)`);
  }
}

/** Rhinestone `Operation.data`: `[Type][SigMode][payload]` (SmartExecutionLib). Type 1 =
 *  Calldata (`target ‖ data`), 2 = ERC7579 and 3 = MultiCall (both `abi.encode(Execution[])`);
 *  0 = an EIP-712 hash commitment with nothing to execute. */
export function decodeRhinestoneOperation(data: `0x${string}`): { calls: EnvelopeCall[]; version: string } {
  const hex = data.slice(2);
  if (hex.length === 0) return { calls: [], version: "empty" };
  if (hex.length < 4) throw new Error("Rhinestone operation: shorter than its two header bytes");
  const type = Number.parseInt(hex.slice(0, 2), 16);
  const payload = `0x${hex.slice(4)}` as `0x${string}`;
  switch (type) {
    case 0:
      return { calls: [], version: "eip712-hash" };
    case 1: {
      if (payload.length < 42) throw new Error("Rhinestone Calldata operation: shorter than a target");
      return { calls: [call(payload.slice(0, 42) as `0x${string}`, 0n, `0x${payload.slice(42)}`)], version: "calldata" };
    }
    case 2:
    case 3: {
      const [batch] = decodeAbiParameters(ERC7579_EXECUTION_ARRAY, payload);
      return { calls: batch.map((e) => call(e.target, e.value, e.callData)), version: type === 2 ? "erc7579" : "multicall" };
    }
    default:
      throw new Error(`Rhinestone operation type ${type} is not Eip712Hash (0), Calldata (1), ERC7579 (2) or MultiCall (3)`);
  }
}

/**
 * Peel one envelope layer off a call. Returns undefined when the selector is not an envelope's;
 * THROWS when the selector matches but the body does not decode (the caller degrades that to an
 * unreadable leg, like any malformed Cork leg). `to` is the call's own target — the account
 * itself for a Safe `execTransaction` or a 7579 `execute`.
 */
export function unwrapEnvelope(to: `0x${string}`, data: `0x${string}`): EnvelopeHop | undefined {
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === ENTRYPOINT_V06_SELECTOR || selector === ENTRYPOINT_V07_SELECTOR) {
    const { args } = decodeFunctionData({ abi: entryPointAbi, data });
    const [ops, beneficiary] = args;
    const version = selector === ENTRYPOINT_V06_SELECTOR ? "v0.6" : "v0.7+";
    // One user operation per hop would lose the bundle shape; the hop lists every op's call on
    // its own sender, in bundle order. The account is per call (ops may name different senders),
    // so it rides on the call as the target, not on the hop.
    const calls = ops.map((op) => call(op.sender, 0n, op.callData));
    const senders = [...new Set(ops.map((op) => op.sender.toLowerCase()))];
    return {
      scheme: "erc4337-entrypoint",
      version,
      ...(senders.length === 1 ? { account: ops[0]!.sender } : {}),
      calls,
      note: `${ops.length} user operation${ops.length === 1 ? "" : "s"} (${version}); gas is compensated to beneficiary ${beneficiary}${ops.some((op) => op.initCode.length > 2) ? "; an op carries initCode (account deployment)" : ""}`,
    };
  }
  if (SAFE_4337_SELECTORS.has(selector)) {
    const { args } = decodeFunctionData({ abi: safe4337ModuleAbi, data });
    const [target, value, inner, operation] = args;
    return { scheme: "safe-4337-module", version: "executeUserOp", account: getAddress(to), calls: [call(target, value, inner, safeOperation(Number(operation), "executeUserOp"))] };
  }
  if (selector === SAFE_EXEC_SELECTOR) {
    const { args } = decodeFunctionData({ abi: safeAbi, data });
    const [target, value, inner, operation, , , gasPrice, gasToken, refundReceiver] = args;
    const refund = gasPrice > 0n ? `; gas refund ${gasPrice} per gas in ${gasToken === "0x0000000000000000000000000000000000000000" ? "native currency" : `token ${gasToken}`} to ${refundReceiver}` : "";
    return { scheme: "safe-exec-transaction", version: "execTransaction", account: getAddress(to), calls: [call(target, value, inner, safeOperation(Number(operation), "execTransaction"))], ...(refund ? { note: refund.slice(2) } : {}) };
  }
  if (selector === MULTISEND_SELECTOR) {
    const { args } = decodeFunctionData({ abi: multiSendAbi, data });
    return { scheme: "safe-multisend", version: "multiSend", calls: decodeMultiSendTransactions(args[0]) };
  }
  if (ERC7579_SELECTORS.has(selector)) {
    const { functionName, args } = decodeFunctionData({ abi: erc7579Abi, data });
    const [mode, executionCalldata] = args;
    const { callType, execType } = erc7579Mode(mode);
    if (execType !== 0x00 && execType !== 0x01) throw new Error(`ERC-7579 execType 0x${execType.toString(16).padStart(2, "0")} is neither default (0x00) nor try (0x01)`);
    const { calls, version } = decodeErc7579Executions(callType, executionCalldata, execType === 0x01);
    return {
      scheme: "erc7579-execute",
      version: `${functionName}:${version}${execType === 0x01 ? ":try" : ""}`,
      account: getAddress(to),
      calls,
      ...(functionName === "executeFromExecutor" ? { note: "executed by an installed EXECUTOR module on the account's behalf" } : {}),
    };
  }
  if (EXECUTOR_MODULE_SELECTORS.has(selector)) {
    const { args } = decodeFunctionData({ abi: erc7579ExecutorModuleAbi, data });
    return {
      scheme: "erc7579-executor-module",
      version: "executeGuardedBatch",
      calls: args[0].map((e) => call(e.target, e.value, e.callData)),
      note: "an ERC-7579 executor module installed on the account runs this batch through executeFromExecutor (integrator-deployed module — the GuardedExecModule shape)",
    };
  }
  if (RHINESTONE_SELECTORS.has(selector)) {
    const { functionName, args } = decodeFunctionData({ abi: rhinestoneIntentExecutorAbi, data });
    const signedOps = args[0] as { account: `0x${string}`; nonce: bigint; ops: { data: `0x${string}` }; chainIndex?: bigint; otherChains?: readonly `0x${string}`[] };
    const { calls, version } = decodeRhinestoneOperation(signedOps.ops.data);
    const multichain = signedOps.otherChains !== undefined ? `; part of a multichain intent (${signedOps.otherChains.length} other chain${signedOps.otherChains.length === 1 ? "" : "s"})` : "";
    const refund = functionName.includes("WithGasRefund") ? `; relayer gas refund in ${functionName.endsWith("_ETH") ? "native currency" : "an ERC-20"} from the account` : "";
    return {
      scheme: "rhinestone-intent-executor",
      version: `${functionName}:${version}`,
      account: signedOps.account,
      calls,
      note: `account-signed intent (nonce 0x${signedOps.nonce.toString(16)}), executed from the account by the IntentExecutor module${multichain}${refund}`,
    };
  }
  return undefined;
}
