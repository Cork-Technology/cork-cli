// Morpho Bundler3 multicall envelope. Call struct + multicall/reenter signatures verified
// empirically against the deployed Bundler3 (Sourcify, mainnet 0x6566…0245):
//   struct Call { address to; bytes data; uint256 value; bool skipRevert; bytes32 callbackHash; }
//   function multicall(Call[] bundle) payable
import { decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector } from "viem";

export interface Call {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  skipRevert: boolean;
  callbackHash: `0x${string}`;
}

export const ZERO_CALLBACK_HASH = `0x${"0".repeat(64)}` as const;

export const bundler3Abi = parseAbi([
  "function multicall((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle) payable",
  "function reenter((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle)",
]);

export const MULTICALL_SELECTOR = toFunctionSelector(bundler3Abi[0]!);
export const REENTER_SELECTOR = toFunctionSelector(bundler3Abi[1]!);

/** Build a Call targeting `to` with `data`; value/skipRevert/callbackHash default to 0/false/zero. */
export function call(
  to: `0x${string}`,
  data: `0x${string}`,
  opts: { value?: bigint; skipRevert?: boolean; callbackHash?: `0x${string}` } = {},
): Call {
  return {
    to,
    data,
    value: opts.value ?? 0n,
    skipRevert: opts.skipRevert ?? false,
    callbackHash: opts.callbackHash ?? ZERO_CALLBACK_HASH,
  };
}

/** Encode Bundler3.multicall(Call[]) calldata. */
export function encodeMulticall(bundle: Call[]): `0x${string}` {
  return encodeFunctionData({ abi: bundler3Abi, functionName: "multicall", args: [bundle] });
}

/** Decode Bundler3.multicall / reenter calldata back to Call[] (throws on selector mismatch). */
export function decodeMulticall(data: `0x${string}`): Call[] {
  const { args } = decodeFunctionData({ abi: bundler3Abi, data });
  return args[0].map((c) => ({
    to: c.to,
    data: c.data,
    value: c.value,
    skipRevert: c.skipRevert,
    callbackHash: c.callbackHash,
  }));
}

export function isBundlerMulticall(data: `0x${string}`): boolean {
  const sel = data.slice(0, 10).toLowerCase();
  return sel === MULTICALL_SELECTOR.toLowerCase() || sel === REENTER_SELECTOR.toLowerCase();
}
