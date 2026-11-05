import { decodeFunctionResult, encodeFunctionData, hashTypedData, isAddressEqual, parseAbi, verifyTypedData, zeroAddress, type PublicClient } from "viem";
import type { JitPermitWire } from "../generations.ts";
import type { PredictSharesResult } from "../market-registry.ts";
import { permitSignatureOfWire, type PermitWireRow } from "./jit.ts";
import { isEip7702Designator } from "./maker-readiness.ts";

const permitAbi = parseAbi([
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function nonces(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function shares(bytes32 poolId) view returns (address,address)",
  "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)",
]);
const permitTypes = { Permit: [ { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] } as const;
// Exact ECDSA upper bound used by the pinned PoolShare's OpenZeppelin recovery.
const MAX_ECDSA_S = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
export interface CstPermitTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: typeof permitTypes;
  primaryType: "Permit";
  message: { owner: `0x${string}`; spender: `0x${string}`; value: bigint; nonce: bigint; deadline: bigint };
}
export interface CstPermitPreparation {
  status: "awaiting-signature" | "verified" | "supplied" | "satisfied" | "unavailable" | "conflict";
  reason?: string;
  blockNumber?: bigint;
  tokenState?: "existing" | "created-in-simulation";
  typedData?: CstPermitTypedData;
  permit?: PermitWireRow;
}

/** Read the token's actual domain/nonce, never synthesize a name or infer nonce zero from absence. */
export async function prepareCstPermit(args: {
  client: PublicClient; chainId: number; owner: `0x${string}`; spender: `0x${string}`;
  token: `0x${string}`; poolManager: `0x${string}`; poolId: `0x${string}`;
  amount: bigint; deadline: bigint; now: bigint; wire: JitPermitWire;
  permits: readonly PermitWireRow[];
  observeCreated: (blockNumber: bigint, calls: readonly { to: `0x${string}`; data: `0x${string}` }[]) => Promise<PredictSharesResult>;
}): Promise<CstPermitPreparation> {
  const matching = args.permits.filter(p => isAddressEqual(p.token, args.token));
  if (matching.length > 1 && matching.some(p => p.nonce !== undefined || p.typedDataHash !== undefined)) return { status: "conflict", reason: "multiple permits for the maker cST: keep helper-pinned input to one permit row" };
  const supplied = matching[0];
  if (args.permits.some(p => p !== supplied && (p.nonce !== undefined || p.typedDataHash !== undefined))) return { status: "conflict", reason: "permit binding is only supported for the maker cST; its token no longer matches this order" };
  // Preserve existing pre-signed inputs, including legacy signature shapes, without added state reads.
  if (supplied && supplied.nonce === undefined && supplied.typedDataHash === undefined) return { status: "supplied", reason: "pre-signed unpinned input preserved; no additional signature/state qualification performed" };
  if (supplied && (supplied.nonce === undefined || supplied.typedDataHash === undefined)) return { status: "conflict", reason: "keep both nonce and typedDataHash from the permit template" };
  let blockNumber: bigint | undefined;
  try {
    const { client, owner, spender, token } = args;
    blockNumber = await client.getBlockNumber();
    // A failed shares read is NOT absence and must not be replaced by a simulated nonce zero.
    const [, existing] = await client.readContract({ address: args.poolManager, abi: permitAbi, functionName: "shares", args: [args.poolId], blockNumber });
    const exists = existing !== zeroAddress;
    if (exists && !isAddressEqual(existing, token)) return { status: "conflict", blockNumber, reason: "pool shares changed: re-derive the order before signing a permit" };
    if (exists) {
      const allowance = await client.readContract({ address: token, abi: permitAbi, functionName: "allowance", args: [owner, spender], blockNumber });
      if (allowance >= args.amount) return { status: "satisfied", blockNumber, tokenState: "existing" };
    }
    if (!supplied && args.permits.length >= 8) return { status: "unavailable", blockNumber, reason: "the eight-row permit limit leaves no room for the cST permit; remove an unrelated row before re-preparing" };
    const ownerCode = await client.getCode({ address: owner, blockNumber });
    // viem normalizes a successful eth_getCode "0x" to undefined; rejected reads still throw.
    // v/r/s always uses ECDSA. The bytes token's pinned SignatureChecker instead
    // requires ERC-1271 for every coded owner, including an EIP-7702 designator.
    const contractOwner = ownerCode !== undefined && ownerCode !== "0x" && !(args.wire === "vrs" && isEip7702Designator(ownerCode));
    if (contractOwner && args.wire !== "bytes") return { status: "unavailable", blockNumber, reason: "this adapter requires EOA v/r/s: a contract maker must create the pool and approve cST to the LOP before signing the order" };
    let domain: readonly [`0x${string}`, string, string, bigint, `0x${string}`, `0x${string}`, readonly bigint[]];
    let nonce: bigint;
    if (exists) {
      domain = await client.readContract({ address: token, abi: permitAbi, functionName: "eip712Domain", blockNumber });
      nonce = await client.readContract({ address: token, abi: permitAbi, functionName: "nonces", args: [owner], blockNumber });
    } else {
      const observed = await args.observeCreated(blockNumber, [
        { to: token, data: encodeFunctionData({ abi: permitAbi, functionName: "eip712Domain" }) },
        { to: token, data: encodeFunctionData({ abi: permitAbi, functionName: "nonces", args: [owner] }) },
      ]);
      if (observed.status !== "simulated" || !observed.cst || !isAddressEqual(observed.cst, token)) throw new Error(observed.reason ?? "created token did not match the predicted cST");
      const [d, n] = observed.postResults ?? [];
      if (d?.status !== "success" || !d.data || n?.status !== "success" || !n.data) throw new Error("domain/nonce reads failed after simulated pool creation");
      domain = decodeFunctionResult({ abi: permitAbi, functionName: "eip712Domain", data: d.data });
      nonce = decodeFunctionResult({ abi: permitAbi, functionName: "nonces", data: n.data });
    }
    const [fields, name, version, chainId, verifyingContract, , extensions] = domain;
    if (fields !== "0x0f" || extensions.length !== 0 || !name || !version || chainId !== BigInt(args.chainId) || !isAddressEqual(verifyingContract, token)) return { status: "conflict", blockNumber, reason: "unsupported or mismatched token EIP-712 domain; no signable permit returned" };
    const deadline = supplied ? BigInt(supplied.deadline) : args.deadline;
    const value = supplied ? BigInt(supplied.value) : args.amount;
    if (supplied && (value !== args.amount || deadline !== args.deadline)) return { status: "conflict", blockNumber, reason: "a helper-pinned permit must retain this order's exact makingAmount and pinned permitDeadline" };
    if (deadline <= args.now || deadline >= (1n << 256n) - 1n || value < args.amount) return { status: "conflict", blockNumber, reason: "permit deadline must be finite and in the future, and value must cover this order's makingAmount" };
    const typedData: CstPermitTypedData = { domain: { name, version, chainId: args.chainId, verifyingContract: token }, types: permitTypes, primaryType: "Permit", message: { owner, spender, value, nonce, deadline } };
    const digest = hashTypedData(typedData);
    const tokenState = exists ? "existing" : "created-in-simulation";
    if (!supplied) return { status: "awaiting-signature", blockNumber, tokenState, typedData, permit: { token, value: String(value), deadline: String(deadline), nonce: String(nonce), typedDataHash: digest } };
    if (BigInt(supplied.nonce!) !== nonce || supplied.typedDataHash!.toLowerCase() !== digest.toLowerCase()) return { status: "conflict", blockNumber, tokenState, reason: "permit nonce or typed-data binding is stale/mismatched; prepare and sign a fresh permit" };
    const signature = permitSignatureOfWire(supplied, ["action", "jitMarket", "permits"], args.wire);
    if (!contractOwner) {
      if (signature.length !== 132) return { status: "conflict", blockNumber, tokenState, reason: "a pinned EOA permit needs a 65-byte r‖s‖v signature accepted by the token; compact signatures are not supported" };
      const v = Number.parseInt(signature.slice(-2), 16);
      const s = BigInt(`0x${signature.slice(66, 130)}`);
      if ((v !== 27 && v !== 28) || s === 0n || s > MAX_ECDSA_S) return { status: "conflict", blockNumber, tokenState, reason: "a pinned EOA permit requires canonical v=27/28 and low-S on the actual encoded signature; supply a canonical token-accepted signature before re-preparing" };
    }
    const valid = contractOwner
      ? await client.readContract({ address: owner, abi: permitAbi, functionName: "isValidSignature", args: [digest, signature], blockNumber }) === "0x1626ba7e"
      : await verifyTypedData({ ...typedData, address: owner, signature });
    if (!valid) return { status: "conflict", blockNumber, tokenState, reason: "permit signature does not authorize this exact token domain and owner/value/deadline/nonce" };
    return { status: "verified", blockNumber, tokenState };
  } catch (error) {
    return { status: "unavailable", ...(blockNumber !== undefined ? { blockNumber } : {}), reason: `cannot prepare/verify the cST permit from token state: ${error instanceof Error ? error.message.split("\n")[0] : "read failed"}` };
  }
}
