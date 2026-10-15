import { concatHex, encodeFunctionData, keccak256, padHex, parseAbi, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import type { ResolvedRpc } from "../chain/rpc.ts";
import { multiSendAbi, safeAbi } from "../bundle/envelopes.ts";

// Runtime identities from the pinned @safe-global/safe-contracts 1.4.1 published artifacts.
// Only this proxy/singleton and threshold-one, unguarded EOA-owner execution are supported.
const PROXY_CODE_HASH = "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c";
const SINGLETON_CODE_HASH = "0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4";
const MULTISEND_CODE_HASH = "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939";
const MULTISEND = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as const;
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as const;
const profileAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getStorageAt(uint256 offset, uint256 length) view returns (bytes)",
]);
const hasCode = (code: Hex | undefined): code is Hex => code !== undefined && code !== "0x";
const delegated = (code: Hex) => /^0xef0100[0-9a-f]{40}$/i.test(code);
type Profile = { supported: true; owner: Address; multiSend: Address } | { supported: false; accountType: "no-code" | "eip7702" | "contract"; reason: string };

export async function safeOwnerProfile(client: Pick<ResolvedRpc["client"], "getCode" | "readContract">, account: Address, atBlock?: bigint): Promise<Profile> {
  const block = atBlock !== undefined ? { blockNumber: atBlock } : {};
  const code = await client.getCode({ address: account, ...block });
  if (!hasCode(code)) return { supported: false, accountType: "no-code", reason: "the account has no code; an eth_call success would be an empty-account no-op, not an atomic fill" };
  if (delegated(code)) return { supported: false, accountType: "eip7702", reason: "EIP-7702 delegation is not the supported Safe contract-account profile; no verified delegated self-call preparation path is configured" };
  const unsupported = (reason: string): Profile => ({ supported: false, accountType: "contract", reason });
  if (keccak256(code) !== PROXY_CODE_HASH) return unsupported("account runtime is not the pinned Safe 1.4.1 proxy; code existence does not establish executor permission");
  const singletonWord = await client.readContract({ address: account, abi: profileAbi, functionName: "getStorageAt", args: [0n, 1n], ...block });
  if (!/^0x[0-9a-f]{64}$/i.test(singletonWord)) return unsupported("Safe singleton storage did not return one word");
  const singleton = ("0x" + singletonWord.slice(-40)) as Address;
  const singletonCode = await client.getCode({ address: singleton, ...block });
  if (!hasCode(singletonCode) || keccak256(singletonCode) !== SINGLETON_CODE_HASH) return unsupported("proxy singleton is not the pinned Safe 1.4.1 implementation");
  const [owners, threshold, guardWord, multiSendCode] = await Promise.all([
    client.readContract({ address: account, abi: profileAbi, functionName: "getOwners", ...block }),
    client.readContract({ address: account, abi: profileAbi, functionName: "getThreshold", ...block }),
    client.readContract({ address: account, abi: profileAbi, functionName: "getStorageAt", args: [BigInt(GUARD_SLOT), 1n], ...block }),
    client.getCode({ address: MULTISEND, ...block }),
  ]);
  if (threshold !== 1n || owners.length !== 1) return unsupported("only a threshold-one Safe with exactly one owner has an existing single-signer eth-transaction completion path");
  if (guardWord.toLowerCase() !== zeroHash) return unsupported("guarded Safe execution requires a separately verified guard-compatible profile");
  if (!hasCode(multiSendCode) || keccak256(multiSendCode) !== MULTISEND_CODE_HASH) return unsupported("canonical MultiSendCallOnly 1.4.1 runtime is absent or differs from the pinned artifact");
  const owner = owners[0]!;
  const ownerCode = await client.getCode({ address: owner, ...block });
  if (hasCode(ownerCode)) return unsupported(delegated(ownerCode) ? "the Safe owner is EIP-7702 delegated, not this profile's EOA signer" : "a contract owner needs its own verified signature/execution path; it cannot sign the root eth-transaction");
  return { supported: true, owner, multiSend: MULTISEND };
}

export function encodeSafeOwnerBatch(profile: Extract<Profile, { supported: true }>, calls: readonly { target: Address; value: bigint; callData: Hex }[]): Hex {
  const packed = concatHex(calls.map((call) => concatHex(["0x00", call.target, toHex(call.value, { size: 32 }), toHex((call.callData.length - 2) / 2, { size: 32 }), call.callData])));
  const data = encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
  // Safe's v=1 prevalidated signature is valid only when msg.sender is this owner.
  // safeTxGas=gasPrice=0 makes inner failure revert (GS013), rather than return false.
  const signature = concatHex([padHex(profile.owner, { size: 32 }), zeroHash, "0x01"]);
  return encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [profile.multiSend, 0n, data, 1, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] });
}
